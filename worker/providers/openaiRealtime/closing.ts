import { Clock, Data, Effect, Exit } from "effect";
import type { NodeDispatchInput } from "../../runtime/implementationContracts.ts";
import { remainingUntil, untilDeadline } from "../../shared/deadline.ts";
import type { SemanticReport } from "../../runtime/executionContracts.ts";
import type { PreparedClosing } from "../../runtime/nodeContentContracts.ts";
import { sendProviderCommand, type ProviderCommandSocket } from "./providerCommands.ts";
import { RealtimeNativeCommands } from "./nativeCommands.ts";
import type { RealtimeReceipt } from "./receipts.ts";
import type { RealtimeInputClosure } from "./inputClosure.ts";
import { ReceiptWait } from "./sideConnectionEvents.ts";
import { expectedTranscriptionUsage } from "./usage.ts";

class ClosingFailure extends Data.TaggedError("ClosingFailure")<{ reason: string }> {}
/**
 * The node dispatch a closing carries out, whichever Conversation state it serves: its deadline
 * and clock, its completion and failure reports, its input-closure callbacks and the tool call
 * that caused it. Each report is an Effect that awaits Runtime's receipt.
 */
export type RealtimeClosingDispatch = Omit<
  NodeDispatchInput,
  "state" | "input" | "reporter" | "onComplete" | "onFailure"
> &
  Readonly<{
    onComplete(report: SemanticReport<unknown>): Effect.Effect<void>;
    onFailure(reason: string, responseId?: string): Effect.Effect<void>;
  }>;
/**
 * The instruction the closing reply is given before its sentence, a blank line between them,
 * approved by the user on 2026-11-05 (#1025): Lab's former Goodbye wording, verbatim. Realtime
 * cannot speak a given text without its model, so the model repeats the sentence.
 */
const closingInstruction =
  "Speak only the following closing message, verbatim. Do not add, omit, or rephrase any words. Do not ask a question, request confirmation, or call a tool.";

export type RealtimeClosingEntry = Readonly<{
  dispatch: RealtimeClosingDispatch;
  content: PreparedClosing;
  /** The pair's completion report: the Conversation event of the delivered closing reply. */
  report(responseId: string): SemanticReport<unknown> | null;
}>;
/**
 * The Realtime kit's closing: participant input closes and the final answer is committed, the
 * session update that stops automatic turns also removes the tools, the call that caused the
 * node is answered, and one reply says the closing sentence. That reply carries its own
 * instructions, the approved instruction around the sentence, and an empty `input`, so it starts
 * from a fresh context with no conversation history; it calls no tool and reasons at the lowest
 * effort, `minimal`. It still lands in the default conversation (`conversation: "auto"`), which
 * the session reads for transcripts and item identities. The node is done once that reply is
 * delivered. A session holds one closing: it observes every receipt, and closes and commits the
 * session's participant input closure (`inputClosure.ts`), whose final-answer commit Ending
 * reuses. Connection-local receipts remain independent of the durable Runtime handoff queue.
 * Its failure reasons (`goodbye_*`) and command ids keep the names Runtime reads today;
 * renaming them belongs to Runtime's neutral vocabulary.
 */
export class RealtimeClosing {
  readonly #inflight = new Set<string>();
  readonly #settled = new Set<string>();
  readonly #input: RealtimeInputClosure;
  #operation: ClosingOperation | null = null;
  #fenced = false;
  /** The closing closes, and commits through, its session's one participant input closure. */
  constructor(input: RealtimeInputClosure) {
    this.#input = input;
  }
  observe(event: RealtimeReceipt, socket: ProviderCommandSocket): void {
    const responseId = event.response?.id ?? event.response_id;
    if (event.type === "response.created" && responseId !== undefined)
      this.#inflight.add(responseId);
    if (event.type === "response.done" && responseId !== undefined) {
      this.#inflight.delete(responseId);
      this.#settled.add(responseId);
    }
    const operation = this.#operation;
    if (operation === null) return;
    if (operation.contained) {
      // A native response can acquire its server identity after its owner was revoked.
      // Release only this operation's output immediately, before any durable callback.
      if (
        event.type === "response.created" &&
        responseId !== undefined &&
        event.response?.metadata?.runtime_operation_id === operation.input.identity.operationId
      ) {
        operation.native.send({
          type: "response.cancel",
          event_id: `${operation.prefix}_late_cancel_${responseId}`,
          response_id: responseId,
        });
        operation.native.send({
          type: "output_audio_buffer.clear",
          event_id: `${operation.prefix}_late_output_${responseId}`,
        });
      }
      return;
    }
    if (operation.input.clock() >= operation.input.deadlineAt) {
      const failure = new ClosingFailure({ reason: "goodbye_deadline_exceeded" });
      failDeferred(operation.completed, failure);
      failDeferred(operation.settlement, failure);
      failDeferred(operation.inputDisabled, failure);
      failDeferred(operation.inputSettlement, failure);
      this.contain(socket);
      return;
    }
    if (event.type === "session.updated" && event.session?.audio?.input.turn_detection === null)
      succeedDeferred(operation.inputDisabled, undefined);
    const tagged =
      event.response?.metadata?.runtime_operation_id === operation.input.identity.operationId;
    if (tagged && responseId !== undefined) {
      if (operation.responseId !== null && operation.responseId !== responseId) {
        const failure = new ClosingFailure({ reason: "goodbye_response_identity_conflict" });
        failDeferred(operation.completed, failure);
        failDeferred(operation.settlement, failure);
        failDeferred(operation.inputDisabled, failure);
        failDeferred(operation.inputSettlement, failure);
        this.contain(socket);
        return;
      }
      operation.responseId = responseId;
      operation.input.observeOutputIdentity?.(responseId);
    }
    if (event.type === "response.done" && responseId !== undefined) {
      operation.settling.delete(responseId);
      if (operation.settling.size === 0) succeedDeferred(operation.settlement, undefined);
      if (responseId === operation.responseId) {
        const audio =
          event.response?.output?.some((item) =>
            item.content?.some(
              (content) => content.type === "audio" || content.type === "output_audio",
            ),
          ) === true;
        if (event.response?.status !== "completed" || !audio) {
          failDeferred(
            operation.completed,
            new ClosingFailure({
              reason:
                event.response?.status !== "completed"
                  ? "goodbye_response_failed"
                  : "goodbye_audio_not_completed",
            }),
          );
          return;
        }
        operation.successful = true;
      }
    }
    if (event.type === "output_audio_buffer.stopped" && responseId !== undefined)
      operation.stopped.add(responseId);
    if (event.type === "output_audio_buffer.cleared") {
      if (responseId !== undefined) operation.cleared.add(responseId);
      if (
        operation.phase !== "settling" &&
        (responseId === undefined || responseId === operation.responseId)
      ) {
        failDeferred(operation.completed, new ClosingFailure({ reason: "goodbye_audio_cleared" }));
      }
    }
    if (
      event.type === "error" &&
      (event.error?.event_id?.startsWith(operation.prefix) ||
        event.error?.event_id === operation.commitCommandId ||
        event.error?.event_id === operation.suppressionCommandId)
    ) {
      // Cancellation can race the terminal receipt of the ordinary response.
      // This exact command's no-active reply confirms containment, not settlement;
      // keep waiting for its response.done within the original closing deadline.
      if (
        event.error?.code === "response_cancel_not_active" &&
        event.error.event_id !== undefined &&
        operation.cancellationCommandIds.has(event.error.event_id)
      )
        return;
      // An automatic commit may win after the explicit send; an empty-buffer
      // rejection cannot invalidate that item. Keep waiting for its receipt
      // within the original cutoff if it has not arrived yet.
      if (
        event.error?.event_id === operation.commitCommandId &&
        event.error?.code === "input_audio_buffer_commit_empty"
      )
        return;
      if (event.error?.event_id === operation.commitCommandId)
        this.#input.rejectCommit("goodbye_command_rejected");
      const failure = new ClosingFailure({ reason: "goodbye_command_rejected" });
      failDeferred(operation.completed, failure);
      failDeferred(operation.settlement, failure);
      failDeferred(operation.inputDisabled, failure);
      failDeferred(operation.inputSettlement, failure);
      this.contain(socket);
      return;
    }
    if (event.type === "response.created" && responseId !== undefined && !tagged) {
      if (operation.phase === "settling") {
        operation.settling.add(responseId);
        if (operation.settlement.settled) operation.settlement = new ReceiptWait();
      }
      // Automatic output after the node fence cannot become closing evidence.
      const commandId = `${operation.prefix}_cancel_${responseId}`;
      operation.cancellationCommandIds.add(commandId);
      const result = operation.native.send({
        type: "response.cancel",
        event_id: commandId,
        response_id: responseId,
      });
      if (!result.ok) {
        const failure = new ClosingFailure({ reason: result.failure.code });
        failDeferred(operation.completed, failure);
        failDeferred(operation.settlement, failure);
        failDeferred(operation.inputDisabled, failure);
        failDeferred(operation.inputSettlement, failure);
        this.contain(socket);
      }
    }
    const identified = operation.responseId;
    if (identified !== null && operation.cleared.has(identified)) {
      failDeferred(operation.completed, new ClosingFailure({ reason: "goodbye_audio_cleared" }));
    } else if (identified !== null && operation.successful && operation.stopped.has(identified)) {
      succeedDeferred(operation.completed, identified);
    }
  }
  /**
   * Fences the closing: one in progress fails its waits with `goodbye_interrupted`, cancels its
   * reply on the connection while that reply still generates and clears its output, and a later
   * one reports `goodbye_interrupted` at once, until the closing resumes.
   */
  contain(socket: ProviderCommandSocket | null): void {
    this.#fenced = true;
    const operation = this.#operation;
    if (operation === null || operation.contained) return;
    operation.contained = true;
    if (socket !== null) {
      // The closing took over Runtime's input-closure step: an answer still buffered, which the
      // closing had not committed yet, is committed under the step's id, as Ending would have.
      const step = operation.inputClosureStep;
      if (
        step !== null &&
        operation.commitCommandId === undefined &&
        this.#input.state.buffered !== null &&
        this.#input.commitOutcome === null
      ) {
        this.#input.requestCommit();
        operation.commitCommandId = step;
        operation.native.send({ type: "input_audio_buffer.commit", event_id: step });
      }
      // OpenAI cancels only a reply that still generates: once the closing reply's end arrived,
      // only its audio is left, which clearing output stops.
      if (operation.responseId !== null && !this.#settled.has(operation.responseId))
        operation.native.send({
          type: "response.cancel",
          event_id: `${operation.prefix}_contain_cancel`,
          response_id: operation.responseId,
        });
      operation.native.send({
        type: "output_audio_buffer.clear",
        event_id: `${operation.prefix}_contain_output`,
      });
    }
    failDeferred(operation.completed, new ClosingFailure({ reason: "goodbye_interrupted" }));
    failDeferred(operation.settlement, new ClosingFailure({ reason: "goodbye_interrupted" }));
    failDeferred(operation.inputSettlement, new ClosingFailure({ reason: "goodbye_interrupted" }));
    failDeferred(operation.inputDisabled, new ClosingFailure({ reason: "goodbye_interrupted" }));
  }
  /**
   * Lifts the fence on a new connection, unless a closing was entered: a session holds one
   * closing, and one that was contained stays so. The replies in flight on the connection that
   * ended are forgotten, since their terminal receipts may have been lost with it.
   */
  resume(): void {
    if (this.#operation !== null) return;
    this.#fenced = false;
    this.#inflight.clear();
  }
  enter(entry: RealtimeClosingEntry, socket: ProviderCommandSocket) {
    const { dispatch: request, content } = entry;
    if (request.deadlineAt === null)
      return Effect.suspend(() => request.onFailure("goodbye_deadline_missing"));
    const input = { ...request, deadlineAt: request.deadlineAt };
    const protocol = this;
    const reportFailure = (reason: string, responseId?: string) =>
      Effect.suspend(() => input.onFailure(reason, responseId));
    return Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const nativeCommands = yield* RealtimeNativeCommands;
        if (protocol.#fenced) {
          yield* reportFailure("goodbye_interrupted");
          return;
        }
        if (protocol.#operation !== null)
          return yield* Effect.die(new Error("native_node_already_dispatched"));
        if ((yield* remainingUntil(input.deadlineAt)) === 0) {
          yield* reportFailure("goodbye_deadline_exceeded");
          return;
        }
        const settling = new Set(protocol.#inflight);
        if (
          input.triggeringReplyId !== undefined &&
          !protocol.#settled.has(input.triggeringReplyId)
        )
          settling.add(input.triggeringReplyId);
        const operation: ClosingOperation = {
          input,
          native: nativeCommands,
          prefix: `evt_goodbye_${input.identity.operationId}`,
          settling,
          cancellationCommandIds: new Set(),
          settlement: new ReceiptWait(),
          completed: new ReceiptWait(),
          inputSettlement: new ReceiptWait(),
          inputDisabled: new ReceiptWait(),
          responseId: null,
          phase: "settling",
          successful: false,
          stopped: new Set(),
          cleared: new Set(),
          contained: false,
          inputClosureStep: null,
        };
        // The settled item's transcription will report its usage: it is expected with the
        // settlement, which Runtime records even when the item's commit is not yet observed.
        const settleInputClosure = (itemId: string | null) =>
          input.settleInputClosure?.(
            itemId,
            itemId === null ? [] : expectedTranscriptionUsage(itemId),
          );
        const retainedInput = input.inputClosure;
        const participantInput = protocol.#input;
        // Speech kept across a Runtime restart was read back when the side connection opened.
        participantInput.retain({
          committedItemId: retainedInput?.admittedItemId ?? null,
          activityObserved: false,
        });
        // Entry freezes the input admitted by Interviewing. Later speech is evidence-only.
        participantInput.close();
        participantInput.attribute({
          identity: input.identity,
          committed: (itemId) => {
            if (!operation.contained) settleInputClosure(itemId);
          },
          settled: () => {
            if (!operation.contained) succeedDeferred(operation.inputSettlement, undefined);
          },
        });
        protocol.#operation = operation;
        if (settling.size === 0) succeedDeferred(operation.settlement, undefined);
        if (participantInput.state.buffered === null) {
          settleInputClosure(participantInput.state.committedItemId);
          succeedDeferred(operation.inputSettlement, undefined);
        }
        yield* Effect.addFinalizer((exit) =>
          Effect.sync(() => {
            // Revoked reporting ownership cannot leave media running behind its interrupted wait.
            if (Exit.isFailure(exit)) protocol.contain(socket);
            else operation.contained = true;
          }),
        );
        const send = (command: Parameters<typeof sendProviderCommand>[1]) =>
          Effect.gen(function* () {
            if (operation.contained || (yield* clock.currentTimeMillis) >= input.deadlineAt)
              return yield* Effect.fail(
                new ClosingFailure({ reason: "goodbye_deadline_exceeded" }),
              );
            const sent = nativeCommands.send(command);
            if (!sent.ok)
              return yield* Effect.fail(new ClosingFailure({ reason: sent.failure.code }));
          });
        const native = Effect.gen(function* () {
          const needsInputSettlement = protocol.#input.state.buffered !== null;
          // The closing takes over Runtime's input-closure step: it stops automatic turns and
          // removes the tools, and commits a buffered answer under the step's id.
          const step =
            input.claimInputClosure?.() ??
            (input.claimInputClosure === undefined ? `${operation.prefix}_commit` : null);
          if (step === null)
            return yield* Effect.fail(new ClosingFailure({ reason: "goodbye_interrupted" }));
          operation.inputClosureStep = step;
          const disableId = `${operation.prefix}_disable`;
          operation.suppressionCommandId = disableId;
          yield* send({
            event_id: disableId,
            type: "session.update",
            session: {
              type: "realtime",
              tools: [],
              tool_choice: "none",
              audio: {
                input: {
                  turn_detection: null,
                },
              },
            },
          });
          // The closing answers the step itself: it settles buffered speech with its commit.
          input.reportInputClosure?.(step, {
            status: "dispatched",
            settlement: {
              supersedesHeld: false,
              answerFollows: needsInputSettlement,
              inputToSettle: needsInputSettlement,
            },
          });
          // Contain ordinary output before any acknowledgement or input settlement wait.
          for (const responseId of settling) {
            const commandId = `${operation.prefix}_cancel_${responseId}`;
            operation.cancellationCommandIds.add(commandId);
            yield* send({
              type: "response.cancel",
              event_id: commandId,
              response_id: responseId,
            });
          }
          yield* send({
            type: "output_audio_buffer.clear",
            event_id: `${operation.prefix}_entry_output`,
          });
          if (needsInputSettlement) {
            yield* operation.inputDisabled.await;
            // The automatic receipt may already be in the accepted native prefix.
            // Claim this buffer before I/O so End can reuse this exact commit.
            if (protocol.#input.state.buffered !== null) {
              protocol.#input.requestCommit();
              operation.commitCommandId = step;
              yield* send({ type: "input_audio_buffer.commit", event_id: step });
            }
          }
          while (operation.settling.size > 0 || protocol.#input.state.buffered !== null) {
            if (operation.settling.size > 0) yield* operation.settlement.await;
            if (protocol.#input.state.buffered !== null) yield* operation.inputSettlement.await;
          }
          // The call that started the closing gets its answer before the closing reply.
          if (input.triggeringToolCallId !== undefined)
            yield* send({
              type: "conversation.item.create",
              event_id: `${operation.prefix}_tool`,
              item: {
                type: "function_call_output",
                call_id: input.triggeringToolCallId,
                output: "{}",
              },
            });
          operation.phase = "creating";
          yield* send({
            event_id: `${operation.prefix}_response`,
            type: "response.create",
            response: {
              output_modalities: ["audio"],
              instructions: `${closingInstruction}\n\n${content.sentence}`,
              input: [],
              conversation: "auto",
              reasoning: { effort: "minimal" },
              tools: [],
              tool_choice: "none",
              metadata: { runtime_operation_id: input.identity.operationId },
            },
          });
          return yield* operation.completed.await;
        }).pipe(
          untilDeadline(input.deadlineAt, () =>
            Effect.fail(new ClosingFailure({ reason: "goodbye_deadline_exceeded" })),
          ),
        );
        const responseId = yield* native.pipe(
          Effect.catchTag("ClosingFailure", (failure) =>
            Effect.gen(function* () {
              protocol.contain(socket);
              // Containment is immediate; let the captured native receipt prefix
              // retain its visit attribution before durable failure admission.
              yield* reportFailure(failure.reason, operation.responseId ?? undefined);
              return null;
            }),
          ),
        );
        if (responseId !== null) {
          yield* Effect.suspend(() => {
            const report = entry.report(responseId);
            return report === null ? Effect.void : input.onComplete(report);
          });
        }
      }),
    ).pipe(
      // The closing is bounded by its own deadline only: saving its report is Runtime's,
      // whose closing alarm decides a report still held at the cutoff.
      Effect.provideService(RealtimeNativeCommands, {
        send: (command) => sendProviderCommand(socket, command),
      }),
    );
  }
}
type ClosingOperation = {
  input: RealtimeClosingDispatch & Readonly<{ deadlineAt: number }>;
  native: typeof RealtimeNativeCommands.Service;
  prefix: string;
  settling: Set<string>;
  cancellationCommandIds: Set<string>;
  settlement: ReceiptWait<void, ClosingFailure>;
  completed: ReceiptWait<string, ClosingFailure>;
  inputSettlement: ReceiptWait<void, ClosingFailure>;
  inputDisabled: ReceiptWait<void, ClosingFailure>;
  responseId: string | null;
  /** Runtime's input-closure step, once the closing took it over. */
  inputClosureStep: string | null;
  commitCommandId?: string;
  suppressionCommandId?: string;
  phase: "settling" | "creating";
  successful: boolean;
  stopped: Set<string>;
  cleared: Set<string>;
  contained: boolean;
};

function failDeferred<A>(target: ReceiptWait<A, ClosingFailure>, error: ClosingFailure): void {
  target.fail(error);
}
function succeedDeferred<A>(target: ReceiptWait<A, ClosingFailure>, value: A): void {
  target.succeed(value);
}
