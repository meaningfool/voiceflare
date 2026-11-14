import {
  type Cause,
  Clock,
  Deferred,
  Effect,
  Fiber,
  FiberSet,
  Option,
  Queue,
  type Scope,
  Stream,
} from "effect";
import {
  CascadeLanguageModel,
  CascadeSpeechInput,
  CascadeSpeechOutput,
  type ConversationHistoryTurn,
  type LanguageModelEvent,
  type LanguageModelRequest,
  type PreparedToolChoice,
} from "./adapters.ts";
import { CascadeMedia, type MediaOutput } from "./mediaSession.ts";
import { remainingUntil, sleepUntil, untilDeadline } from "../../shared/deadline.ts";
import type { cascadeDiagnostics } from "./diagnostics.ts";
import {
  cascadeMediaInputFormat,
  cascadeMediaOutputFormat,
} from "../../shared/contracts/cascadeMedia.ts";
import type { DiagnosticContributor } from "../../runtime/diagnosticContracts.ts";
import type { ConversationUsageEvidence } from "../../runtime/runtimeUsage.ts";
import { expectedUsage, settledUsage } from "./usage.ts";
import type { PreparedInstructions, PreparedTool } from "../../runtime/nodeContentContracts.ts";

/**
 * What one conversing phase sends the model: its instructions, operational instructions and
 * tools, each the caller's own and passed verbatim, whether the model may call those tools, and
 * which history its requests carry: the conversation so far, or none. The model limits given to
 * the loop apply to every phase.
 */
export type CascadePhaseSettings = Readonly<{
  instructions: PreparedInstructions;
  operationalInstructions: string;
  tools: readonly PreparedTool[];
  /** Null sends no tool choice, as a phase without tools under the Gate's options does. */
  toolChoice: PreparedToolChoice | null;
  history: "conversation" | "none";
}>;

/** One tool call the model completed in a reply. */
export type CascadeToolCall = Readonly<{ callId: string; name: string; arguments: string }>;

/**
 * What the loop reports, in the order it happened. Each event is delivered before the loop
 * goes on.
 *
 * - `output_started`: an interviewer output opened to the browser.
 * - `reply_generated`: the output's model reply ended, completed or failed; its text (the text
 *   submitted for synthesis, trimmed, empty when there was none) and its tool calls are final.
 *   A failed reply carries no tool call.
 * - `output_cancelled`: the output was cut short before its reply ended; its text is what it
 *   had submitted for synthesis.
 * - `delivery_started` and `delivery_stopped`: its first audio chunk and its explicit end
 *   reached the browser. An output a phase cut after its first audio chunk reports its delivery
 *   stopped once the browser was told to stop it.
 * - `participant_item_started`: speech input recognized the participant's first text.
 * - `participant_text_final`: that item's final text, once its turn ended or settled.
 * - `usage`: the providers' usage. Each output expects its model response and its synthesis
 *   once it started, and settles both before it reports its end: with the model's account, or
 *   unknown when the model gave none, and with the text synthesis was given and the audio
 *   delivered for it. A closing's output makes no model request: it expects and settles its
 *   synthesis only. Each listening opportunity expects its speech input before any audio
 *   reaches the provider, and settles it with the audio it forwarded once it closed.
 * - `failed`: a provider or media failure, outside an entered closing.
 */
export type TurnTakingEvent =
  | Readonly<{ kind: "output_started"; outputId: string }>
  | Readonly<{
      kind: "reply_generated";
      outputId: string;
      outcome: "completed" | "failed";
      text: string;
      toolCalls: readonly CascadeToolCall[];
    }>
  | Readonly<{ kind: "output_cancelled"; outputId: string; text: string }>
  | Readonly<{ kind: "delivery_started"; outputId: string }>
  | Readonly<{
      kind: "delivery_stopped";
      outputId: string;
      /**
       * An output delivered to its end: when its audio finishes playing in the browser, which
       * plays each chunk as it arrives, after the chunks before it.
       */
      playbackEndsAt?: number;
    }>
  | Readonly<{ kind: "participant_item_started"; itemId: string }>
  | Readonly<{ kind: "participant_text_final"; itemId: string; text: string }>
  | Readonly<{ kind: "usage"; usage: readonly ConversationUsageEvidence[] }>
  | Readonly<{ kind: "failed"; code: string }>;

/**
 * How the input closure settled the last answer: an open opportunity settled, with the
 * participant item it settled or none when nothing new was recognized, or there was no open
 * opportunity and nothing to settle.
 */
export type InputSettlement =
  | Readonly<{ kind: "settled"; itemId: string | null }>
  | Readonly<{ kind: "nothing_to_settle" }>;

/**
 * Why a closing failed: it was refused or revoked (`interrupted`), its deadline was missing or
 * passed, the media could not carry it, or a provider or media failure during it (`failure`).
 */
export type ClosingFailure =
  | Readonly<{ kind: "interrupted" | "deadline_missing" | "deadline_exceeded" }>
  | Readonly<{ kind: "media_unavailable" }>
  | Readonly<{ kind: "failure"; code: string }>;

/**
 * A closing the caller enters: its absolute deadline, the sentence its one output says, and the
 * callbacks through which its caller owns the closing's input claims and outcome.
 *
 * - `claimInputClosure` claims closing participant input and settling the last answer, as one
 *   step; false when the claim is held elsewhere, which interrupts the closing.
 * - `inputSettled` reports how the input closure settled the last answer.
 * - `attributeReply` names the closing's output before it starts.
 * - `done` reports the closing delivered; `failed` reports it failed, once either way.
 */
export type TurnTakingClosing = Readonly<{
  deadlineAt: number | null;
  sentence: string;
  claimInputClosure(): boolean;
  inputSettled(settlement: InputSettlement): void;
  attributeReply(outputId: string): void;
  done(outputId: string): Effect.Effect<void>;
  failed(failure: ClosingFailure, outputId?: string): Effect.Effect<void>;
}>;

/**
 * A conversing phase the caller enters: the settings its requests send, the attribution of its
 * first reply before that reply starts, and the node it carries, if any. The phase the
 * conversation opens with carries none; a phase entered for a Conversation node, such as a later
 * question, carries that node.
 */
export type TurnTakingPhase = Readonly<{
  settings: CascadePhaseSettings;
  attributeReply(outputId: string): void;
  node: TurnTakingNode | null;
  /**
   * The voice Gate's supplied reply: the reply to the phase's first admitted participant turn is
   * this tool call, without speech and with no model request. An ordinary phase has none.
   */
  suppliedReply?: Readonly<{ toolName: string }> | null;
}>;

/**
 * The node a conversing phase carries: its absolute deadline, which bounds the phase's entry
 * until its first reply ended, whether it is still the caller's current node, and its refusal.
 * The node's first reply, attributed to it, is reported cancelled even when it is cut short
 * before it started, so its caller does not keep waiting for its start.
 */
export type TurnTakingNode = Readonly<{
  deadlineAt: number;
  current(): boolean;
  refused(): Effect.Effect<void>;
}>;

/** The providers and the media session the loop's work calls. */
export type TurnTakingServices =
  | CascadeSpeechInput
  | CascadeLanguageModel
  | CascadeSpeechOutput
  | CascadeMedia;

export type TurnTakingInput = Readonly<{
  /** The output limit and reasoning effort every request carries. */
  model: Pick<LanguageModelRequest, "maxOutputTokens" | "reasoning">;
  /** Whether the caller still accepts participant input, besides the loop's own input state. */
  inputEligible(): boolean;
  /** Delivers one event; the loop goes on once it was delivered. */
  emit(event: TurnTakingEvent): Effect.Effect<void>;
  diagnostic: DiagnosticContributor<typeof cascadeDiagnostics>;
}>;

/**
 * The Cascade kit's turn-taking loop: it listens, transcribes, asks the model and speaks. Every
 * operation is an Effect; its work runs as tasks in the Scope it was made in, and closing that
 * Scope stops them.
 *
 * - `converse` enters a conversing phase: the interviewer and the participant take turns under
 *   its settings, and the interviewer speaks first. The first phase opens the conversation; a
 *   later one is entered as `makeTurnTaking` describes. A phase carrying a node is refused when
 *   the conversation is not running, has closed its input or output, or entered a closing or
 *   containment.
 * - `enterClosing`: see its type.
 * - `contain` revokes the entered node: a closing in progress is cancelled and reports nothing
 *   more, a phase whose first reply has not started is dropped, and no closing or phase that
 *   carries a node is entered after it.
 * - `closeInput` closes participant input: no further turn ends automatically, and an open
 *   opportunity settles the audio it received with one speech-input finalization, whose text is
 *   the final answer. An output in flight still completes. It answers how the last answer
 *   settled, once its text was reported: `settled` with its item, `nothing_to_settle` when no
 *   opportunity was open or it recognized nothing, or null when speech input failed.
 * - `discardInput` closes input and drops an open opportunity without settling it.
 * - `cancelOutput` cancels the named output while it is in flight: no further output or turn
 *   follows. An output whose end was already delivered is not cancelled.
 * - `stopOutput` drops the output in flight and starts no new one; participant input is left to
 *   the input operations.
 * - `mediaClosed` reports that the browser closed its media after the end was announced: no
 *   output continues or starts, and an open opportunity keeps settling the audio it received;
 *   otherwise the conversation ends.
 * - `end` ends the conversation: input and output close and all its work stops.
 * - `fail` reports a provider or media failure the caller observed, as the loop reports its own.
 */
export type TurnTaking = Readonly<{
  converse(phase: TurnTakingPhase): Effect.Effect<void>;
  enterClosing(entry: TurnTakingClosing): Effect.Effect<void>;
  contain: Effect.Effect<void>;
  closeInput: Effect.Effect<InputSettlement | null>;
  discardInput: Effect.Effect<void>;
  cancelOutput(outputId: string): Effect.Effect<void>;
  stopOutput: Effect.Effect<void>;
  mediaClosed: Effect.Effect<void>;
  end: Effect.Effect<void>;
  fail(code: string): Effect.Effect<void>;
  /** Fails with the first defect of the loop's work; otherwise ends once its Scope closes. */
  join: Effect.Effect<void>;
}>;

/**
 * What an output says: the model's reply to a phase's request, a given sentence, which goes
 * to synthesis with no model request, or the Gate's supplied reply, a tool call without speech
 * and with no model request.
 */
type OutputSource =
  | Readonly<{ kind: "reply"; settings: CascadePhaseSettings }>
  | Readonly<{ kind: "sentence"; text: string }>
  | Readonly<{ kind: "supplied"; toolName: string }>;

/**
 * A phase's first reply: its identity, its phase's settings, whether a node owns it, and the
 * phase's supplied reply, if any.
 */
type FirstReply = Readonly<{
  outputId: string;
  settings: CascadePhaseSettings;
  attributed: boolean;
  suppliedReply: Readonly<{ toolName: string }> | null;
}>;

/**
 * How one interviewer output ended: its end was delivered, it failed, or a phase entered during
 * it cut it short.
 */
type OutputEnd = "delivered" | "failed" | "cut";

/** The turn: nobody's, an interviewer output in flight, or one open listening opportunity. */
type Turn =
  | Readonly<{ _tag: "idle" }>
  | Readonly<{
      _tag: "speaking";
      outputId: string;
      /** Cuts the output short for a phase entered during it; an output no phase cuts ignores it. */
      cut: Effect.Effect<void>;
    }>
  | Readonly<{
      _tag: "listening";
      afterOutputId: string;
      /** Requests the opportunity's final settlement; requesting it again does nothing. */
      settle: Effect.Effect<void>;
      /**
       * How the opportunity ended for the last answer, once its text was reported: settled with
       * the item it settled, nothing to settle when it recognized nothing, or null when it
       * failed or ended without either.
       */
      answered: Deferred.Deferred<InputSettlement | null>;
    }>;

/**
 * Where the conversation is: conversing under the current phase; a phase entered whose first
 * reply has not started; a closing entered, with its output once that started and whether its
 * outcome was reported; or contained, after which no closing and no phase carrying a node is
 * entered.
 */
type Node =
  | Readonly<{ _tag: "conversing" }>
  | Readonly<{ _tag: "entering"; phase: TurnTakingPhase }>
  | {
      readonly _tag: "closing";
      readonly entry: TurnTakingClosing;
      outputId: string | undefined;
      reported: boolean;
    }
  | Readonly<{ _tag: "contained" }>;

/** The loop's one state value. */
type State = {
  turn: Turn;
  input: "open" | "closed";
  output: "open" | "closed";
  node: Node;
  /** The first phase opened the conversation. */
  opened: boolean;
  /** The supervised tasks: the conversation, the closing, and the entered node's bound. */
  conversation: Fiber.Fiber<void> | null;
  closing: Fiber.Fiber<void> | null;
  entryBound: Fiber.Fiber<void> | null;
  /** The conversation so far: each interviewer output's text and each participant turn. */
  history: ConversationHistoryTurn[];
  /** The interviewer turn the last output with text added to the history, and that output. */
  spoken: Readonly<{ outputId: string; turn: ConversationHistoryTurn }> | null;
  /** The participant item reported last. */
  participantItemId: string | null;
};

const describe = { source: "cascade_execution", provider: "cascade" } as const;

/**
 * Makes the turn-taking loop in the current Scope.
 *
 * The conversation alternates (half-duplex): once an output has been delivered, the loop opens
 * one listening opportunity and forwards its audio to speech input. The speech-input provider's
 * end of turn with recognized text admits one participant turn; an end without text admits
 * none, and silence of any length waits. An admitted turn closes listening and the next model
 * response streams with the conversation's history, which the loop holds: each interviewer
 * output's generated text and each participant transcript. Each request sends what the current
 * phase sends the model.
 *
 * An output's text is the model's text items in order, joined with a single space; an item
 * without text adds nothing. That text is spoken and is the interviewer's turn.
 *
 * Every phase is a conversing phase: the interviewer speaks its first reply at once, then the
 * interviewer and the participant take turns under its settings. The first phase opens the
 * conversation. A phase entered during the conversation cuts the output that moved to it, such
 * as the reply whose tool call moved on: the move wins. An output in flight stops at once, its
 * synthesis and delivery cancelled and the browser clearing it; an output whose end was already
 * delivered, which the browser may still be playing, is stopped in the browser, unless a
 * participant turn already followed it. A cut output's text stays reported under its own
 * identity, but leaves the history the model reads. An opportunity open at entry closes and
 * settles what it heard instead of admitting a turn. The loop then switches to the phase's
 * settings and sends its first request at once, without waiting for the participant: no
 * listening opens between the cut and the phase's first reply, and the new output is attributed
 * before it starts. A phase whose node is no longer current, or whose deadline passed, once the
 * earlier output ended starts nothing. A node's deadline bounds its phase's entry until the
 * phase's first reply ended: at the deadline the output in flight is cancelled and the
 * conversation starts nothing more.
 *
 * Once participant input has closed, the output in flight still completes its delivery unless it
 * is cancelled, and no listening follows it.
 *
 * A closing closes input through its caller's claims: an open opportunity settles the audio it
 * received with one speech-input finalization, and otherwise the output in flight, such as speech
 * in the reply that finished the interview, is cancelled. The closing is then one output that
 * says its sentence, with no model request, and it is done once its end was delivered to the
 * browser, without waiting for playback. Every closing step is bounded by its absolute deadline,
 * and a provider or media failure during it fails the closing instead of being reported as a
 * failure event.
 */
export function makeTurnTaking(
  input: TurnTakingInput,
): Effect.Effect<TurnTaking, never, Scope.Scope | TurnTakingServices> {
  return Effect.gen(function* () {
    const services = yield* Effect.context<TurnTakingServices>();
    const tasks = yield* FiberSet.make<void, never>();
    const state: State = {
      turn: { _tag: "idle" },
      input: "open",
      output: "open",
      node: { _tag: "conversing" },
      opened: false,
      conversation: null,
      closing: null,
      entryBound: null,
      history: [],
      spoken: null,
      participantItemId: null,
    };
    const { diagnostic, emit } = input;
    /** Runs one task in the loop's Scope with its services. */
    const run = (task: Effect.Effect<void, never, TurnTakingServices>) =>
      FiberSet.run(tasks, Effect.provideContext(task, services));
    const interrupt = (fiber: Fiber.Fiber<void> | null) =>
      fiber === null ? Effect.void : Fiber.interrupt(fiber);
    const settleOpen = Effect.suspend(() =>
      state.turn._tag === "listening" ? state.turn.settle : Effect.void,
    );

    /** Participant input is eligible while input is open and the caller still accepts it. */
    const inputEligible = () => state.input === "open" && input.inputEligible();
    /** Whether a phase was entered whose first reply has not started. */
    const entering = () => state.node._tag === "entering";

    /** No further output or turn: the output in flight, the closing's included, is cancelled. */
    const end = Effect.suspend(() => {
      state.input = "closed";
      state.output = "closed";
      return Fiber.interruptAll(
        [state.conversation, state.closing].filter((fiber) => fiber !== null),
      );
    });

    /** Closes participant input; an open opportunity settles what it received. */
    const closeListening = Effect.suspend(() => {
      state.input = "closed";
      return settleOpen;
    });

    /** Closes participant input and answers how the last answer settled, once it did. */
    const closeInput = Effect.suspend(() => {
      const turn = state.turn;
      if (turn._tag !== "listening")
        return closeListening.pipe(
          Effect.as<InputSettlement | null>({ kind: "nothing_to_settle" }),
        );
      return closeListening.pipe(Effect.andThen(Deferred.await(turn.answered)));
    });

    const endEntryBound = Effect.suspend(() => {
      const bound = state.entryBound;
      state.entryBound = null;
      return interrupt(bound);
    });

    /** Reports a closing's failure once; a settled or revoked closing reports nothing more. */
    const failClosing = (failure: ClosingFailure) =>
      Effect.suspend(() => {
        const node = state.node;
        if (node._tag !== "closing" || node.reported) return Effect.void;
        node.reported = true;
        return node.entry.failed(failure, node.outputId);
      });

    /**
     * A provider or media failure: an unsettled closing fails with it; otherwise it is reported
     * as a failure event, for the caller to apply to the whole conversation.
     */
    const fail = (code: string) =>
      Effect.suspend(() =>
        state.node._tag === "closing" && !state.node.reported
          ? failClosing({ kind: "failure", code })
          : emit({ kind: "failed", code }),
      );

    /**
     * One interviewer output: the model's text streams into synthesis as it arrives, and the
     * audio streams to the browser as it is synthesized. Generation and synthesis run together:
     * a failure of either stops the other at once, and only a completed response ends synthesis
     * normally, so a failed response is never finished as speech. When cancellation, a failure
     * or a deadline cuts the output short before its response completed, the text already
     * submitted is its text. Interrupting it cancels the model response, synthesis and the
     * output in the browser. A node's first reply (`attributed`) is reported cancelled even when
     * it is cut short before it started, so its caller does not keep waiting for its start.
     *
     * An output that says a given sentence makes no model request: the sentence is submitted to
     * synthesis whole as the output starts, and is its reply's completed text, with no tool call.
     * It expects and settles no model usage. A supplied reply makes no model request either: its
     * reply completes at once with no text and its one tool call.
     */
    const speakOutput = (
      outputId: string,
      source: OutputSource,
      attributed: boolean,
      cut: Deferred.Deferred<void> | null,
    ): Effect.Effect<OutputEnd, never, TurnTakingServices> => {
      /** Whether the output asks the model for its reply. */
      const replies = source.kind === "reply";
      const output = { ...describe, outputId } as const;
      const correlation = { responseId: outputId };
      let chunkCount = 0;
      let submitted = "";
      /** The model completed an output item since the last text: the next text starts a new one. */
      let itemEnded = false;
      let audioBytes = 0;
      /** When the audio delivered so far finishes playing: each chunk plays once it arrived. */
      let playbackEndsAt = 0;
      let started = false;
      /** The response's outcome was reported: completed, failed or cancelled. */
      let responded = false;
      let delivered = false;
      /** The model's account of the response, once it gave one. */
      let account: Readonly<{ model: string; inputTokens: number; outputTokens: number }> | null =
        null;
      let usageSettled = false;
      /** The output's usage, settled once before its end is reported: see `TurnTakingEvent`. */
      const settleUsage = Effect.gen(function* () {
        if (!started || usageSettled) return;
        usageSettled = true;
        const model = yield* CascadeLanguageModel;
        const speech = yield* CascadeSpeechOutput;
        yield* emit({
          kind: "usage",
          usage: [
            ...(replies
              ? [
                  settledUsage(
                    "language_model",
                    outputId,
                    account === null
                      ? null
                      : {
                          provider: model.usage.provider,
                          model: account.model,
                          quantities: {
                            input_text: account.inputTokens,
                            output_text: account.outputTokens,
                          },
                        },
                  ),
                ]
              : []),
            settledUsage("text_to_speech", outputId, {
              ...speech.usage,
              quantities: {
                input_text: submitted.length,
                output_audio: audioMilliseconds(audioBytes, cascadeMediaOutputFormat.sampleRate),
              },
            }),
          ],
        });
      });
      /** A response cut short before it completed keeps the text it had submitted. */
      const cutShort = Effect.suspend(() => {
        if (responded || (!started && !attributed)) return Effect.void;
        responded = true;
        return emit({ kind: "output_cancelled", outputId, text: submitted.trim() });
      });
      /** The model reported its response failed: an observed outcome, with the submitted text. */
      const failedResponse = Effect.suspend(() => {
        if (responded) return Effect.void;
        responded = true;
        return emit({
          kind: "reply_generated",
          outputId,
          outcome: "failed",
          text: submitted.trim(),
          toolCalls: [],
        });
      });
      const failed = (
        code: string,
        media: MediaOutput | null,
        settle: Effect.Effect<void>,
        refusal?: Readonly<{ reason: string; attempts: number }>,
      ) =>
        Effect.gen(function* () {
          // The browser clears the output first; the failure is reported apart from its outcome.
          if (media !== null) yield* media.fail(code);
          diagnostic(
            "cascade.output_failed",
            refusal === undefined
              ? { ...output, code }
              : { ...output, code, refusal: refusal.reason, attempts: refusal.attempts },
            correlation,
          );
          yield* settleUsage;
          yield* settle;
          yield* fail(code);
          return "failed" as const;
        });
      const speak = Effect.gen(function* () {
        const model = yield* CascadeLanguageModel;
        const speech = yield* CascadeSpeechOutput;
        const media = yield* CascadeMedia;
        const delivery = yield* media.open(outputId);
        diagnostic("cascade.output_started", { ...output, says: source.kind }, correlation);
        started = true;
        yield* emit({ kind: "output_started", outputId });
        yield* emit({
          kind: "usage",
          usage: [
            ...(replies ? [expectedUsage("language_model", outputId)] : []),
            expectedUsage("text_to_speech", outputId),
          ],
        });
        const text = yield* Queue.unbounded<string, Cause.Done>();
        const toolCalls: CascadeToolCall[] = [];
        // A given sentence is the reply's one text, complete at once, and a supplied reply is its
        // one tool call: no model is asked.
        const reply =
          source.kind === "sentence"
            ? Stream.make<LanguageModelEvent[]>({ kind: "text", text: source.text })
            : source.kind === "supplied"
              ? Stream.make<LanguageModelEvent[]>({
                  kind: "tool_call",
                  callId: `cascade_supplied_${crypto.randomUUID()}`,
                  name: source.toolName,
                  arguments: "{}",
                })
              : model.respond({
                  history: source.settings.history === "none" ? [] : structuredClone(state.history),
                  instructions: source.settings.instructions,
                  operationalInstructions: source.settings.operationalInstructions,
                  tools: source.settings.tools,
                  toolChoice: source.settings.toolChoice,
                  maxOutputTokens: input.model.maxOutputTokens,
                  reasoning: input.model.reasoning,
                });
        const respond = reply.pipe(
          Stream.runForEach((event) => {
            switch (event.kind) {
              case "text":
                return Effect.suspend(() => {
                  // A single space joins two text items; an item without text adds nothing.
                  const piece =
                    itemEnded && submitted.trim().length > 0 ? ` ${event.text}` : event.text;
                  itemEnded = false;
                  submitted += piece;
                  return Queue.offer(text, piece);
                });
              case "tool_call":
                return Effect.sync(() => {
                  toolCalls.push({
                    callId: event.callId,
                    name: event.name,
                    arguments: event.arguments,
                  });
                });
              case "output_item":
                return Effect.sync(() => {
                  itemEnded = true;
                  diagnostic(
                    "cascade.model_output_item",
                    { ...output, itemType: event.itemType, characters: event.characters },
                    correlation,
                  );
                });
              case "retry":
                return Effect.sync(() => {
                  diagnostic(
                    "cascade.model_retry",
                    {
                      ...output,
                      refusal: event.refusal,
                      attempt: event.attempt,
                      waitMs: event.waitMs,
                    },
                    correlation,
                  );
                });
              case "usage":
                return Effect.sync(() => {
                  account = {
                    model: event.model,
                    inputTokens: event.inputTokens,
                    outputTokens: event.outputTokens,
                  };
                  diagnostic(
                    "cascade.model_usage",
                    {
                      ...output,
                      model: event.model,
                      inputTokens: event.inputTokens,
                      outputTokens: event.outputTokens,
                    },
                    correlation,
                  );
                });
            }
          }),
          // Only a completed response ends the text; a failed one leaves synthesis unfinished.
          Effect.andThen(Queue.end(text)),
          Effect.andThen(() => {
            responded = true;
            const spoken = submitted.trim();
            if (spoken.length > 0) {
              const turn: ConversationHistoryTurn = { role: "interviewer", text: spoken };
              state.history.push(turn);
              state.spoken = { outputId, turn };
            }
            // The text submitted for synthesis, not an observation of heard speech.
            return emit({
              kind: "reply_generated",
              outputId,
              outcome: "completed",
              text: spoken,
              toolCalls,
            });
          }),
        );
        const synthesize = speech.synthesize(Stream.fromQueue(text)).pipe(
          Stream.runForEach((audio) =>
            Effect.gen(function* () {
              yield* delivery.write(audio);
              const writtenAt = yield* Clock.currentTimeMillis;
              playbackEndsAt =
                Math.max(playbackEndsAt, writtenAt) +
                (audio.length / 2 / cascadeMediaOutputFormat.sampleRate) * 1_000;
              chunkCount += 1;
              audioBytes += audio.length;
              if (chunkCount === 1) yield* emit({ kind: "delivery_started", outputId });
            }),
          ),
          Effect.andThen(
            Effect.sync(() =>
              diagnostic("cascade.output_synthesized", { ...output, chunkCount }, correlation),
            ),
          ),
        );
        return yield* Effect.all([respond, synthesize], {
          concurrency: "unbounded",
          discard: true,
        }).pipe(
          Effect.andThen(delivery.end),
          Effect.andThen(() => {
            // Its end delivered, the output is no longer in flight: a cancellation that follows,
            // such as the one after a natural finish, finds nothing of it to cancel.
            delivered = true;
            if (state.turn._tag === "speaking" && state.turn.outputId === outputId)
              state.turn = { _tag: "idle" };
            diagnostic("cascade.output_delivered", { ...output, chunkCount }, correlation);
            return Effect.andThen(
              settleUsage,
              emit(
                chunkCount === 0
                  ? { kind: "delivery_stopped", outputId }
                  : {
                      kind: "delivery_stopped",
                      outputId,
                      playbackEndsAt: Math.ceil(playbackEndsAt),
                    },
              ),
            );
          }),
          Effect.as("delivered" as const),
          Effect.catchTags({
            LanguageModelFailed: ({ code, refusal }) =>
              failed(code, delivery, failedResponse, refusal),
            SpeechOutputFailed: ({ code }) => failed(code, delivery, cutShort),
            MediaDeliveryFailed: ({ code }) => failed(code, delivery, cutShort),
          }),
        );
      });
      const spoken = speak.pipe(
        Effect.scoped,
        Effect.catchTag("MediaDeliveryFailed", ({ code }) => failed(code, null, cutShort)),
        // What synthesis was given and delivered, however the output ended; an output cut
        // short settles its usage here, before it reports its cancellation.
        Effect.ensuring(
          Effect.sync(() =>
            diagnostic(
              "cascade.speech_output_usage",
              {
                ...output,
                characters: submitted.length,
                audioMs: audioMilliseconds(audioBytes, cascadeMediaOutputFormat.sampleRate),
              },
              correlation,
            ),
          ).pipe(Effect.andThen(settleUsage)),
        ),
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            if (delivered) return;
            if (!started) return yield* cutShort;
            diagnostic("cascade.output_cancelled", { ...output, chunkCount }, correlation);
            // A response whose outcome was already reported keeps it: only its delivery stopped.
            // Reporting a completed closing as cancelled would fail the finish while Live,
            // before the Stop that follows the page's close is admitted.
            yield* cutShort;
          }),
        ),
      );
      if (cut === null) return spoken;
      // A phase entered during the output cuts it short: its delivery stops and the browser
      // clears it. An output whose end reached the browser first counts as delivered, and one
      // whose response completed without speech has nothing to cut: it ends as it would.
      const silent = () => responded && submitted.trim().length === 0;
      const cutRequested = Deferred.await(cut).pipe(
        Effect.andThen(
          Effect.suspend(() => (silent() ? Effect.never : Effect.succeed("cut" as const))),
        ),
      );
      return Effect.raceFirst(spoken, cutRequested).pipe(
        Effect.flatMap((end) => {
          if (end !== "cut") return Effect.succeed(end);
          if (delivered) return Effect.succeed("delivered" as const);
          return (chunkCount > 0 ? emit({ kind: "delivery_stopped", outputId }) : Effect.void).pipe(
            Effect.as(end),
          );
        }),
      );
    };

    /**
     * One listening opportunity after `afterOutputId`: its audio streams to speech input.
     *
     * The participant's item is reported as soon as speech input recognizes text, while the
     * opportunity is eligible, so input closure finds it in progress. The provider's end of turn
     * with recognized text then admits the turn: listening closes, the item gets its text and
     * the next response may follow. Once input closes, turn ends no longer end the speech: the
     * opportunity closes to the browser, the audio already accepted is forwarded, and speech
     * input settles it with one finalization; any text it settles is the final answer, reported
     * whether or not its item was reported before closure. When speech input fails, an item
     * already in progress keeps the final text it had recognized, and nothing more. Returns
     * `"turn"` for an admitted turn, `"closed"` once input closed, and null when it failed or
     * ended without either.
     */
    const listenForTurn = (afterOutputId: string) => {
      /** Final text recognized so far, and the participant item once it was reported. */
      let pending = "";
      let itemId: string | null = null;
      /** The opportunity's answer to an input closure, once the opportunity opened. */
      let answered: Deferred.Deferred<InputSettlement | null> | null = null;
      const answer = (settlement: InputSettlement | null) =>
        answered === null ? Effect.void : Deferred.succeed(answered, settlement);
      /** The participant item gets its text, and joins the history. */
      const keep = (item: string, text: string) =>
        emit({ kind: "participant_text_final", itemId: item, text }).pipe(
          Effect.andThen(
            Effect.sync(() => {
              state.participantItemId = item;
              state.history.push({ role: "participant", text });
            }),
          ),
        );
      const failed = (code: string) =>
        Effect.gen(function* () {
          diagnostic("cascade.input_failed", { ...describe, code });
          // A failed final settlement after Stop or expiry keeps that ending; the failure is
          // reported before the kept text, which can complete the wait for the final answer.
          yield* fail(code);
          const text = pending.trim();
          if (itemId !== null && text.length > 0) yield* keep(itemId, text);
          return null;
        });
      const heard = Effect.gen(function* () {
        const media = yield* CascadeMedia;
        const speech = yield* CascadeSpeechInput;
        const opening = yield* media.listen(afterOutputId);
        const opportunity = { ...describe, opportunityId: opening.opportunityId };
        const settlement = yield* Deferred.make<void>();
        const opportunityAnswer = yield* Deferred.make<InputSettlement | null>();
        answered = opportunityAnswer;
        let settling = false;
        let audioBytes = 0;
        state.turn = {
          _tag: "listening",
          afterOutputId,
          settle: Effect.suspend(() => {
            settling = true;
            return Deferred.succeed(settlement, undefined);
          }),
          answered: opportunityAnswer,
        };
        diagnostic("cascade.listening_opened", { ...opportunity, afterOutputId });
        yield* Effect.addFinalizer(() =>
          Effect.suspend(() => {
            state.turn = { _tag: "idle" };
            const counts = opening.counts();
            diagnostic("cascade.listening_closed", {
              ...opportunity,
              acceptedChunks: counts.accepted,
              discardedChunks: counts.discarded,
            });
            const audioMs = audioMilliseconds(audioBytes, cascadeMediaInputFormat.sampleRate);
            diagnostic("cascade.speech_input_usage", { ...opportunity, audioMs });
            return emit({
              kind: "usage",
              usage: [
                settledUsage("speech_to_text", opening.opportunityId, {
                  ...speech.usage,
                  quantities: { input_audio: audioMs },
                }),
              ],
            });
          }),
        );
        yield* emit({
          kind: "usage",
          usage: [expectedUsage("speech_to_text", opening.opportunityId)],
        });
        // Input closed, or a phase was entered, while the opportunity was opening: settle what
        // it hears at once.
        if (state.input === "closed" || entering()) yield* settleOpen;
        const recognition = yield* speech.open;
        // The audio streams until the opportunity closes; a requested settlement closes it and
        // then asks speech input to settle what it was sent.
        const feed = Effect.all(
          [
            opening.audio.pipe(
              Stream.runForEach((audio) => {
                audioBytes += audio.length;
                return recognition.ingest(audio);
              }),
            ),
            Deferred.await(settlement).pipe(Effect.andThen(opening.close)),
          ],
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.andThen(recognition.finalize));
        const ended = yield* Stream.merge(
          Stream.drain(Stream.fromEffect(feed)),
          recognition.events,
        ).pipe(
          Stream.mapEffect((event) =>
            Effect.gen(function* () {
              if (event.kind === "finalized") return settling ? ("closed" as const) : null;
              if (event.kind === "transcript") {
                if (event.final) pending += event.text;
                if (itemId === null && pending.trim().length > 0 && (settling || inputEligible())) {
                  itemId = `cascade_input_${crypto.randomUUID()}`;
                  yield* emit({ kind: "participant_item_started", itemId });
                }
                return null;
              }
              // Once input closes, the settlement, not a turn end, ends the participant's speech.
              if (settling) return null;
              if (pending.trim().length === 0) {
                // An end of turn without recognized text admits nothing; listening continues.
                pending = "";
                diagnostic("cascade.turn_ignored", { ...opportunity, reason: "empty" });
                return null;
              }
              // Text that ends after input closed waits for the closure's settlement.
              return inputEligible() ? ("turn" as const) : null;
            }),
          ),
          Stream.filter((end) => end !== null),
          Stream.runHead,
        );
        return { opportunity, ended, text: pending.trim(), itemId };
      }).pipe(Effect.scoped);
      return Effect.gen(function* () {
        const { opportunity, ended, text, itemId: reported } = yield* heard;
        if (Option.isNone(ended)) return null;
        const settled = ended.value === "closed";
        if (text.length === 0) {
          diagnostic("cascade.input_settled", { ...opportunity, itemId: null, characters: 0 });
          yield* answer({ kind: "nothing_to_settle" });
          return "closed" as const;
        }
        const item = reported ?? `cascade_input_${crypto.randomUUID()}`;
        if (reported === null) yield* emit({ kind: "participant_item_started", itemId: item });
        if (settled)
          diagnostic("cascade.input_settled", {
            ...opportunity,
            itemId: item,
            characters: text.length,
          });
        else
          diagnostic("cascade.turn_admitted", {
            ...opportunity,
            itemId: item,
            characters: text.length,
          });
        yield* keep(item, text);
        yield* answer({ kind: "settled", itemId: item });
        return settled ? ("closed" as const) : ("turn" as const);
      }).pipe(
        Effect.catchTags({
          SpeechInputFailed: ({ code }) => failed(code),
          MediaDeliveryFailed: ({ code }) => failed(code),
        }),
        // Failed, interrupted or ended without either: no answer to report.
        Effect.ensuring(Effect.suspend(() => answer(null))),
      );
    };

    /**
     * Bounds the entry of a node's phase by the node's deadline, which nothing renews: at the
     * deadline the output in flight, the phase's first reply, is cancelled and the conversation
     * starts nothing more. An opportunity still settling at entry keeps settling; the
     * conversation then finds the deadline passed. A phase entered during the first reply of
     * another takes the bound over.
     */
    const boundEntry = (deadlineAt: number) =>
      Effect.gen(function* () {
        const conversation = state.conversation;
        yield* endEntryBound;
        state.entryBound = yield* run(
          sleepUntil(deadlineAt).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                state.entryBound = null;
                return state.turn._tag === "listening" ? Effect.void : interrupt(conversation);
              }),
            ),
          ),
        );
      });

    /**
     * Switches to a phase entered during the conversation, once the earlier output ended: its
     * settings and its first reply's identity, attributed before it starts. Null when the phase
     * starts nothing: input is no longer eligible, or its node is no longer current or its
     * deadline passed.
     */
    const startPhase = (phase: TurnTakingPhase) =>
      Effect.gen(function* () {
        if (!inputEligible()) return null;
        if (phase.node !== null) {
          const remainingMs = yield* remainingUntil(phase.node.deadlineAt);
          if (!phase.node.current() || remainingMs === 0) return null;
        }
        const outputId = `cascade_output_${crypto.randomUUID()}`;
        phase.attributeReply(outputId);
        return {
          outputId,
          settings: phase.settings,
          attributed: phase.node !== null,
          suppliedReply: phase.suppliedReply ?? null,
        };
      });

    /**
     * The move wins: the output that moved to a phase is cut and recorded so. One cut short in
     * flight already stopped. One delivered to its end, which the browser may still be playing, is
     * stopped in the browser, unless it had no speech or a participant turn already followed it,
     * which shows it was heard. A cut output's interviewer turn leaves the history the model
     * reads, so the phase's first request does not end on speech the conversation dropped.
     */
    const cutMovedOutput = (outputId: string, ended: "delivered" | "cut") =>
      Effect.gen(function* () {
        const spoken = state.spoken?.outputId === outputId ? state.spoken : null;
        const last = spoken !== null && state.history.at(-1) === spoken.turn;
        if (ended === "delivered") {
          if (!last) return;
          const media = yield* CascadeMedia;
          yield* media.stop(outputId);
        }
        diagnostic(
          "cascade.output_cut",
          { ...describe, outputId, delivered: ended === "delivered" },
          { responseId: outputId },
        );
        if (last) state.history.pop();
      });

    /**
     * The conversation from the first phase's first reply on: each delivered output is followed
     * by a listening opportunity, and each admitted participant turn by the next output under the
     * current phase. A phase entered during an output cuts it, and one entered during the
     * opportunity after it closes the opportunity; that phase's first reply follows either way,
     * with no listening between. It stops when an output does not complete, when participant
     * input closes, or when it is interrupted.
     */
    const converse = (first: FirstReply) =>
      Effect.gen(function* () {
        let { outputId, settings, attributed, suppliedReply } = first;
        /** The output is its phase's first reply. */
        let entry = true;
        /** The output answers a participant turn admitted under its phase. */
        let answers = false;
        for (;;) {
          const cut = yield* Deferred.make<void>();
          state.turn = {
            _tag: "speaking",
            outputId,
            cut: Effect.asVoid(Deferred.succeed(cut, undefined)),
          };
          // The phase's supplied reply answers its first admitted turn, once.
          const source: OutputSource =
            answers && suppliedReply !== null
              ? { kind: "supplied", toolName: suppliedReply.toolName }
              : { kind: "reply", settings };
          if (source.kind === "supplied") suppliedReply = null;
          const ended = yield* speakOutput(outputId, source, attributed, cut);
          if (state.turn._tag === "speaking" && state.turn.outputId === outputId)
            state.turn = { _tag: "idle" };
          // A phase entered during this first reply now holds the bound, for its own.
          if (entry && !entering()) yield* endEntryBound;
          entry = false;
          attributed = false;
          if (ended === "failed") return;
          answers = false;
          if (ended === "delivered" && !entering()) {
            if (!inputEligible()) return;
            const turn = yield* listenForTurn(outputId);
            if (turn === null) return;
            // The next response starts only while input and output remain open.
            if (!entering() && (turn !== "turn" || !inputEligible())) return;
            answers = turn === "turn";
          }
          if (state.output === "closed") return;
          const node = state.node;
          if (node._tag !== "entering") {
            // A cut output whose phase was revoked before it started, as by containment, is
            // followed by nothing.
            if (ended === "cut") return;
            outputId = `cascade_output_${crypto.randomUUID()}`;
            continue;
          }
          state.node = { _tag: "conversing" };
          yield* cutMovedOutput(outputId, ended);
          const next = yield* startPhase(node.phase);
          if (next === null) return;
          ({ outputId, settings, attributed, suppliedReply } = next);
          answers = false;
          entry = true;
        }
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            state.conversation = null;
            if (state.node._tag === "entering") state.node = { _tag: "conversing" };
            return endEntryBound;
          }),
        ),
      );

    /**
     * A closing from its entry to its outcome. Entry closes participant input and settles the
     * last answer as one input closure, under the input-closure claim: an open opportunity
     * settles the audio it received with one speech-input finalization. Without an open
     * opportunity there is nothing to settle, and the output in flight is cancelled instead.
     *
     * The closing is then one output that says its sentence, attributed before it starts, with no
     * model request. It is done once its end was delivered; a provider or media failure fails
     * it. Every step, the input's settlement included, is bounded by the closing's absolute
     * deadline: at the deadline the closing's synthesis is cancelled, the browser clears the
     * closing, and it fails with its deadline exceeded. An answer still settling keeps settling
     * under the input-closure claim already taken.
     */
    const close = (entry: TurnTakingClosing, deadlineAt: number) =>
      Effect.gen(function* () {
        state.input = "closed";
        if (!entry.claimInputClosure()) return yield* failClosing({ kind: "interrupted" });
        const conversation = state.conversation;
        if (state.turn._tag === "listening") {
          const before = state.participantItemId;
          yield* state.turn.settle;
          if (conversation !== null) yield* Fiber.await(conversation);
          const settled = state.participantItemId;
          entry.inputSettled({ kind: "settled", itemId: settled === before ? null : settled });
        } else {
          yield* interrupt(conversation);
          entry.inputSettled({ kind: "nothing_to_settle" });
        }
        const node = state.node;
        // Without media no closing starts: the media failure, reported at the close, decides it.
        if (node._tag !== "closing" || node.reported || state.output === "closed") return;
        const outputId = `cascade_output_${crypto.randomUUID()}`;
        entry.attributeReply(outputId);
        node.outputId = outputId;
        // No phase is entered during a closing, so nothing cuts it.
        state.turn = { _tag: "speaking", outputId, cut: Effect.void };
        const ended = yield* speakOutput(
          outputId,
          { kind: "sentence", text: entry.sentence },
          false,
          null,
        );
        if (state.turn._tag === "speaking" && state.turn.outputId === outputId)
          state.turn = { _tag: "idle" };
        if (ended !== "delivered" || state.node !== node || node.reported) return;
        // The closing's work is done: a cancellation that follows finds nothing to stop.
        node.reported = true;
        yield* entry.done(outputId);
      }).pipe(untilDeadline(deadlineAt, () => failClosing({ kind: "deadline_exceeded" })));

    /**
     * Opens the conversation with its first phase: the phase's first reply is named and becomes
     * the output in flight before the conversation's task runs.
     */
    const open = (phase: TurnTakingPhase) =>
      Effect.gen(function* () {
        state.opened = true;
        const outputId = `cascade_output_${crypto.randomUUID()}`;
        phase.attributeReply(outputId);
        // The conversation's task names its own cut once it speaks this output.
        state.turn = { _tag: "speaking", outputId, cut: Effect.void };
        // The conversation runs at once; one that already ended holds no fiber.
        let ended = false;
        const conversation = yield* run(
          converse({
            outputId,
            settings: phase.settings,
            attributed: false,
            suppliedReply: phase.suppliedReply ?? null,
          }).pipe(Effect.ensuring(Effect.sync(() => (ended = true)))),
        );
        if (!ended) state.conversation = conversation;
      });

    const loop: TurnTaking = {
      converse: (phase) =>
        Effect.gen(function* () {
          if (!state.opened && phase.node === null) return yield* open(phase);
          const node = state.node;
          if (
            (node._tag !== "conversing" && node._tag !== "entering") ||
            state.conversation === null ||
            state.input === "closed" ||
            state.output === "closed"
          ) {
            if (phase.node !== null) yield* phase.node.refused();
            return;
          }
          state.node = { _tag: "entering", phase };
          if (phase.node !== null) yield* boundEntry(phase.node.deadlineAt);
          yield* settleOpen;
          // The move wins: the output in flight, such as the reply that moved here, stops now.
          if (state.turn._tag === "speaking") yield* state.turn.cut;
        }),
      enterClosing: (entry) =>
        Effect.gen(function* () {
          if (state.node._tag === "closing" || state.node._tag === "contained")
            return yield* entry.failed({ kind: "interrupted" });
          if (entry.deadlineAt === null) return yield* entry.failed({ kind: "deadline_missing" });
          if ((yield* remainingUntil(entry.deadlineAt)) === 0)
            return yield* entry.failed({ kind: "deadline_exceeded" });
          // A closed media attachment closes output, so the closing could not be heard.
          if (state.output === "closed") return yield* entry.failed({ kind: "media_unavailable" });
          state.node = { _tag: "closing", entry, outputId: undefined, reported: false };
          state.closing = yield* run(close(entry, entry.deadlineAt));
        }),
      contain: Effect.suspend(() => {
        state.node = { _tag: "contained" };
        return interrupt(state.closing);
      }),
      closeInput,
      discardInput: Effect.suspend(() => {
        state.input = "closed";
        return state.turn._tag === "listening" ? interrupt(state.conversation) : Effect.void;
      }),
      cancelOutput: (outputId) =>
        Effect.suspend(() =>
          state.turn._tag === "speaking" && state.turn.outputId === outputId ? end : Effect.void,
        ),
      stopOutput: Effect.suspend(() => {
        state.output = "closed";
        return state.turn._tag === "speaking" ? end : Effect.void;
      }),
      mediaClosed: Effect.suspend(() => {
        if (state.turn._tag !== "listening") return end;
        state.output = "closed";
        return closeListening;
      }),
      end,
      fail,
      join: FiberSet.join(tasks),
    };
    return loop;
  });
}

/** The length of 16-bit mono PCM audio at the given sample rate, in whole milliseconds. */
function audioMilliseconds(bytes: number, sampleRate: number): number {
  return Math.round((bytes / 2 / sampleRate) * 1000);
}
