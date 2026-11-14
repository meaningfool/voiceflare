import { Data, Effect } from "effect";
import type { NodeDispatchInput } from "../../runtime/implementationContracts.ts";
import { untilDeadline } from "../../shared/deadline.ts";
import { ReceiptWait } from "./sideConnectionEvents.ts";
import type { PreparedConversationNode } from "../../runtime/nodeContentContracts.ts";
import { RealtimeNativeCommands } from "./nativeCommands.ts";
import {
  buildInitialInterviewResponseCommand,
  sendProviderCommand,
  type InitialInterviewResponseCommand,
  type ProviderCommandSocket,
  type TurnDetection,
} from "./providerCommands.ts";
import { decodeRealtimeSessionSettings } from "./preparedModelSession.ts";
import type { RealtimeReceipt } from "./receipts.ts";

class ConversingFailure extends Data.TaggedError("ConversingFailure")<{ reason: string }> {}
type Wait = ReceiptWait<void, ConversingFailure>;
/**
 * The node dispatch a conversing phase carries out, whichever Conversation state it serves: its
 * deadline and clock, its failure report, whether it is still current, the reply that moved here
 * and the tool call that caused it. Its failure report is an Effect that awaits Runtime's receipt;
 * a receipt observed synchronously starts it with `failNow`, without awaiting it.
 */
export type RealtimeConversingDispatch = Omit<
  NodeDispatchInput,
  "state" | "input" | "reporter" | "onComplete" | "onFailure"
> &
  Readonly<{
    reporter: Readonly<{ isCurrent(): boolean }>;
    onFailure(reason: string, responseId?: string): Effect.Effect<void>;
    failNow(reason: string): void;
  }>;
/**
 * A conversing phase entered as a node: its dispatch, its content in the Conversation modules'
 * shape and Realtime's settings as Runtime stored them for the Run, among them its turn
 * detection. The content's instructions are literal: they reach the model by session update
 * with its tools.
 */
export type RealtimeConversingEntry = Readonly<{
  dispatch: RealtimeConversingDispatch;
  content: PreparedConversationNode;
  settings: unknown;
}>;
type Update = Readonly<{
  instructions: string;
  turns: TurnDetection;
  deferred: Wait;
}>;

/**
 * The Realtime kit's conversing phase: the interviewer and the participant take turns under the
 * phase's settings, and the interviewer speaks first. Every opening uses it, and so does each
 * node of the conversing kind, such as a later question.
 *
 * - The opening's reply is created once Runtime's durable opening claim succeeds; its settings
 *   come from call creation, so it sends no session update and answers no tool call
 *   (`openingReply`).
 * - Entering a node (`enter`): input stays open; once the reply that moved here settled, the move
 *   wins: its speech still playing is cut at once by clearing the output, and OpenAI truncates
 *   the cut item to what was heard, so its unheard text leaves the conversation. Automatic turns
 *   are then suspended while the node's instructions and tools reach the model by session
 *   update; replies still in flight settle; the tool call that caused the node is answered; the
 *   node's reply is created and attributed to it; automatic turns are restored with the stored
 *   turn-detection settings. The node is done once its reply started and automatic turns are
 *   back on.
 *
 * A session holds one conversing phase: it observes every receipt, and the connection retains
 * the history. An entry owns only its correlated update and output; replies of an earlier node,
 * or automatic replies created while a node is entered, are cancelled. Containment fences node
 * work until the phase resumes (`contain`, `resume`); an entry acts only within the fence it
 * started in, so one that containment interrupted never acts again. Its failure reasons
 * (`question_*`) and command ids (`evt_question_`) keep the names Runtime reads today; renaming
 * them belongs to Runtime's neutral vocabulary.
 */
export class RealtimeConversing {
  /** Records the cut of a reply that moved to a node, by its response id. */
  readonly #reportCut: (responseId: string) => void;
  readonly #settled = new Set<string>();
  readonly #inflight = new Set<string>();
  readonly #cancelled = new Set<string>();
  readonly #audioStarted = new Set<string>();
  /** Replies that moved to a node: their speech is cut wherever it plays. */
  readonly #moved = new Set<string>();
  /** The Gate's supplied tool calls, which OpenAI never saw: no output answers them. */
  readonly #suppliedCalls = new Set<string>();
  readonly #responses = new Map<string, RealtimeConversingDispatch | null>();
  readonly #issued = new Map<string, RealtimeConversingDispatch>();
  readonly #updates: Update[] = [];
  readonly #updateReceipts = new Set<string>();
  #active: RealtimeConversingDispatch | null = null;
  #entering: RealtimeConversingDispatch | null = null;
  #outputId: string | null = null;
  #trigger: Readonly<{ responseId: string; deferred: Wait }> | null = null;
  #settling: Wait | null = null;
  #created: Readonly<{ input: RealtimeConversingDispatch; deferred: Wait }> | null = null;
  #fenced = false;
  /** Counts containments: an entry acts only while no containment happened since it started. */
  #fence = 0;

  /** A conversing phase that records each cut of a reply that moved to a node it entered. */
  constructor(reportCut: (responseId: string) => void = () => undefined) {
    this.#reportCut = reportCut;
  }

  /** The opening's reply, with the settings of the call's creation. */
  openingReply(): InitialInterviewResponseCommand {
    return buildInitialInterviewResponseCommand();
  }

  /**
   * Notes a tool call the session supplied in place of the model's reply: a node it causes
   * sends no output for it, since OpenAI's conversation holds no such call.
   */
  supply(callId: string): void {
    this.#suppliedCalls.add(callId);
  }

  /** Whether this phase cancelled the reply itself. */
  cancelled(responseId: string): boolean {
    return this.#cancelled.has(responseId);
  }

  /**
   * One receipt, in arrival order. A provider error that names one of a current node's commands
   * fails that node at once.
   */
  observe(event: RealtimeReceipt, socket: ProviderCommandSocket): void {
    if (event.type === "session.updated" && event.event_id !== undefined) {
      if (this.#updateReceipts.has(event.event_id)) return;
      this.#updateReceipts.add(event.event_id);
      const update = this.#updates[0];
      const turns = event.session?.audio?.input.turn_detection;
      // All our updates are acknowledged in wire order. Effective configuration and
      // event identity prevent an earlier visit's replay from releasing a fresh wait.
      if (
        update !== undefined &&
        event.session?.instructions === update.instructions &&
        turns != null &&
        turns.type === update.turns.type &&
        turns.eagerness === update.turns.eagerness &&
        turns.threshold === update.turns.threshold &&
        turns.create_response === update.turns.create_response &&
        turns.interrupt_response === update.turns.interrupt_response
      ) {
        this.#updates.shift();
        update.deferred.succeed(undefined);
      }
    }
    if (event.type === "error" && event.error?.event_id !== undefined) {
      const requestId = event.error.event_id;
      const issued = [...this.#issued.values()].find((input) =>
        ["update", "tool", "response", "restore"].some(
          (command) => requestId === `evt_question_${input.identity.operationId}_${command}`,
        ),
      );
      if (!this.#fenced && issued?.reporter.isCurrent()) {
        issued.failNow("question_command_rejected");
        return;
      }
    }
    const id = event.response?.id ?? event.response_id;
    if (
      event.type === "output_audio_buffer.started" &&
      id !== undefined &&
      !this.#audioStarted.has(id)
    ) {
      this.#audioStarted.add(id);
      this.#outputId = id;
      if (this.#moved.has(id)) this.#cut(socket, id);
      else if (this.#cancelled.has(id)) this.#clear(socket, id);
    }
    if (
      ["output_audio_buffer.stopped", "output_audio_buffer.cleared"].includes(event.type) &&
      this.#outputId === id
    )
      this.#outputId = null;
    if (event.type === "response.done" && id !== undefined) {
      this.#settled.add(id);
      this.#inflight.delete(id);
      if (this.#trigger?.responseId === id) this.#trigger.deferred.succeed(undefined);
      if (this.#inflight.size === 0 && this.#settling !== null) this.#settling.succeed(undefined);
    }
    if (event.type !== "response.created" || id === undefined || this.#responses.has(id)) return;
    const operationId = event.response?.metadata?.runtime_operation_id;
    const issued = operationId === undefined ? this.#active : this.#issued.get(operationId);
    this.#responses.set(id, issued ?? null);
    if (!this.#settled.has(id)) this.#inflight.add(id);
    // The opening predates dispatch. The reply that moved to a node retains the original
    // attribution of automatic output observed during that node's handoff.
    if (
      issued == null &&
      operationId === undefined &&
      this.#entering?.triggeringReplyId !== undefined
    )
      this.#entering.observeOutputIdentity?.(id, this.#entering.triggeringReplyId);
    if (operationId !== undefined && !this.#fenced && issued?.reporter.isCurrent()) {
      this.#active = issued;
      if (this.#created?.input === issued) this.#created.deferred.succeed(undefined);
    }
    if (issued != null) {
      issued.observeOutputIdentity?.(id);
    }
    const oldAutomatic =
      operationId === undefined && this.#entering !== null && this.#active !== this.#entering;
    // Containment fences node work: a reply of an entered node, or one created while a node is
    // entered. The opening phase's replies are the conversation's, whoever contained the phase.
    const fencedNodeWork = this.#fenced && (issued != null || this.#entering !== null);
    if (
      !this.#settled.has(id) &&
      (fencedNodeWork || oldAutomatic || (issued != null && !issued.reporter.isCurrent()))
    ) {
      this.#cancel(socket, id);
    }
  }

  #clear(socket: ProviderCommandSocket, id: string): void {
    sendProviderCommand(socket, {
      type: "output_audio_buffer.clear",
      event_id: `evt_question_late_output_${id}`,
    });
    if (this.#outputId === id) this.#outputId = null;
  }
  /**
   * Cuts the speech of a reply that moved to a node: its output is cleared and the cut recorded.
   * On a WebRTC call OpenAI truncates the cleared item to the audio played, as when a participant
   * interrupts, so the unheard text leaves the conversation the next reply reads.
   */
  #cut(socket: ProviderCommandSocket, id: string): void {
    this.#clear(socket, id);
    this.#reportCut(id);
  }
  #cancel(socket: ProviderCommandSocket, id: string): void {
    if (this.#cancelled.has(id)) return;
    this.#cancelled.add(id);
    sendProviderCommand(socket, {
      type: "response.cancel",
      event_id: `evt_question_late_${id}`,
      response_id: id,
    });
    // clear affects the current output buffer, so never clear unrelated new audio.
    if (this.#outputId === id) this.#clear(socket, id);
  }

  /**
   * Fences node work: every wait of an entry fails at once, no later entry acts, and a later
   * reply of an entered node is cancelled, until the phase resumes. Given the connection, it also
   * cancels the replies in flight and clears their output; the session gives it only while a node
   * is being entered.
   */
  contain(socket: ProviderCommandSocket | null): void {
    this.#fenced = true;
    this.#fence += 1;
    for (const wait of [
      this.#trigger?.deferred,
      this.#settling,
      this.#created?.deferred,
      ...this.#updates.map((entry) => entry.deferred),
    ])
      if (wait != null) wait.fail(new ConversingFailure({ reason: "question_interrupted" }));
    if (socket !== null) {
      for (const id of this.#inflight) this.#cancel(socket, id);
      if (this.#outputId !== null) this.#clear(socket, this.#outputId);
    }
  }

  /**
   * Lifts the fence on a new connection: later entries act and the entered node's replies carry
   * on. An entry the fence interrupted does not resume, and what the connection that ended left
   * pending is forgotten, since its receipts may have been lost with it: that entry's session
   * updates, the replies in flight and their output.
   */
  resume(): void {
    this.#fenced = false;
    this.#entering = null;
    this.#updates.splice(0);
    this.#inflight.clear();
    this.#outputId = null;
  }

  /** Enters a node of the conversing kind on the connection. */
  enter(entry: RealtimeConversingEntry, socket: ProviderCommandSocket) {
    const { dispatch: input, content } = entry;
    if (input.deadlineAt === null)
      return Effect.suspend(() => input.onFailure("question_deadline_missing"));
    const owner = this;
    const fence = owner.#fence;
    const unfenced = () => !owner.#fenced && owner.#fence === fence;
    const current = () =>
      unfenced() && input.reporter.isCurrent() && input.clock() < (input.deadlineAt ?? 0);
    return Effect.gen(function* () {
      if (!current()) return;
      if (content.instructions.kind !== "literal")
        return yield* Effect.die(new Error("realtime_conversing_literal_instructions_required"));
      const instructions = content.instructions.text;
      const settings = yield* Effect.try({
        try: () => decodeRealtimeSessionSettings(entry.settings),
        catch: () => new ConversingFailure({ reason: "question_settings_invalid" }),
      });
      const configured = settings.inputAudio.turnDetection;
      let turns: TurnDetection = {
        type: configured.type,
        create_response: configured.createResponse,
        interrupt_response: configured.interruptResponse,
      };
      if (configured.eagerness !== undefined) turns = { ...turns, eagerness: configured.eagerness };
      if (configured.threshold !== undefined) turns = { ...turns, threshold: configured.threshold };
      owner.#entering = input;
      owner.#issued.set(input.identity.operationId, input);
      if (
        input.triggeringReplySettled !== true &&
        input.triggeringReplyId !== undefined &&
        !owner.#settled.has(input.triggeringReplyId)
      ) {
        const deferred: Wait = new ReceiptWait();
        owner.#trigger = { responseId: input.triggeringReplyId, deferred };
        yield* deferred.await;
        owner.#trigger = null;
      }
      if (!current()) return;
      // The move wins: the speech of the reply that moved here stops now, and audio of it that
      // only starts later is cut as it starts.
      if (input.triggeringReplyId !== undefined) owner.#moved.add(input.triggeringReplyId);
      if (owner.#outputId !== null) owner.#cut(socket, owner.#outputId);
      const nativeCommands = yield* RealtimeNativeCommands;
      const prefix = `evt_question_${input.identity.operationId}`;
      const send = (command: Parameters<typeof sendProviderCommand>[1], update?: Update) =>
        Effect.try({
          try: () => {
            if (!current()) throw new ConversingFailure({ reason: "question_authority_revoked" });
            if (update !== undefined) owner.#updates.push(update);
            const sent = nativeCommands.send(command);
            if (!sent.ok) throw new ConversingFailure({ reason: sent.failure.code });
          },
          catch: (error) =>
            error instanceof ConversingFailure
              ? error
              : new ConversingFailure({ reason: "question_command_failed" }),
        });
      const suppressed = { ...turns, create_response: false, interrupt_response: false };
      const suppressedAck: Wait = new ReceiptWait();
      yield* send(
        {
          type: "session.update",
          event_id: `${prefix}_update`,
          session: {
            type: "realtime",
            instructions,
            tools: content.tools,
            audio: { input: { turn_detection: suppressed } },
          },
        },
        { instructions, turns: suppressed, deferred: suppressedAck },
      );
      yield* suppressedAck.await;
      // A response created with the previous configuration may still be settling.
      // Keep admission synchronous while waiting for every response's terminal receipt.
      while (owner.#inflight.size > 0) {
        const settling: Wait = new ReceiptWait();
        owner.#settling = settling;
        for (const id of owner.#inflight) owner.#cancel(socket, id);
        yield* settling.await;
      }
      owner.#settling = null;
      if (!current()) return;
      // Cancelled replies' audio is already cleared, and the reply that moved here was cut.
      if (
        input.triggeringToolCallId !== undefined &&
        !owner.#suppliedCalls.has(input.triggeringToolCallId)
      )
        yield* send({
          type: "conversation.item.create",
          event_id: `${prefix}_tool`,
          item: { type: "function_call_output", call_id: input.triggeringToolCallId, output: "{}" },
        });
      const created: Wait = new ReceiptWait();
      owner.#created = { input, deferred: created };
      yield* send({
        type: "response.create",
        event_id: `${prefix}_response`,
        response: { metadata: { runtime_operation_id: input.identity.operationId } },
      });
      yield* created.await;
      if (!current()) return;
      const restoredAck: Wait = new ReceiptWait();
      yield* send(
        {
          type: "session.update",
          event_id: `${prefix}_restore`,
          session: { type: "realtime", audio: { input: { turn_detection: turns } } },
        },
        { instructions, turns, deferred: restoredAck },
      );
      yield* restoredAck.await;
      if (owner.#entering === input) owner.#entering = null;
    }).pipe(
      // At the interview deadline the entry stops its own work and reports nothing:
      // Runtime's own expiry decides what follows.
      untilDeadline(input.deadlineAt, () => Effect.void),
      Effect.catch((failure) =>
        !unfenced() || !input.reporter.isCurrent()
          ? Effect.void
          : Effect.suspend(() => input.onFailure(failure.reason)),
      ),
      Effect.provideService(RealtimeNativeCommands, {
        send: (command) => sendProviderCommand(socket, command),
      }),
    );
  }
}
