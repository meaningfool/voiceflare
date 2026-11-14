import { Clock, Data, Deferred, Effect, Exit, Layer, Queue } from "effect";
import type { z } from "zod";
import { acceptMediaAttachment, CascadeMedia, CascadeMediaSession } from "./mediaSession.ts";
import { cascadeDiagnostics } from "./diagnostics.ts";
import type { CascadeProviders } from "./adapters.ts";
import {
  type CascadePhaseSettings,
  type ClosingFailure,
  makeTurnTaking,
  type TurnTaking,
  type TurnTakingEvent,
} from "./turnTaking.ts";
import { superviseRetained } from "../../runtime/nativeWorkOwner.ts";
import {
  cascadeMediaInputFormat,
  cascadeMediaOutputFormat,
} from "../../shared/contracts/cascadeMedia.ts";
import type { ConversationStates, DetachedReadonly } from "../../runtime/conversationContracts.ts";
import type { DiagnosticContributor } from "../../runtime/diagnosticContracts.ts";
import type {
  ConversationNodeDispatch,
  NodeDispatchInput,
} from "../../runtime/implementationContracts.ts";
import type {
  ConversationToolInvocation,
  PreparedClosing,
  PreparedConversationNode,
} from "../../runtime/nodeContentContracts.ts";
import type { SemanticReport } from "../../runtime/executionContracts.ts";
import type {
  OrderedProviderFinalizationObservation,
  ProviderObservationOrder,
  ProviderTranscriptItemObservation,
} from "../../runtime/interviewFinalizationModel.ts";
import type {
  EndingOperation,
  SessionReleaseAnswer,
  ProviderReceiptPrefix,
  ProviderSessionApplicationFact,
  ProviderSessionApplicationSink,
  ProviderSessionBackgroundWork,
  ProviderSessionEvents,
  ProviderSessionStorage,
  SessionStartInput,
  SessionStartResult,
} from "../../runtime/nativeContracts.ts";
import type { ExecutionBridge } from "../../runtime/runtimeHostAssembly.ts";
import type { ConversationUsageEvidence } from "../../runtime/runtimeUsage.ts";
import { decodeCascadeSessionSettings, type CascadeSessionSettings } from "./preparedSession.ts";
import { CascadeProviderSettings } from "./settings.ts";
import { gateTestOptionsRecord, type GateSessionOptions } from "../../runtime/gateTestOptions.ts";

/** An observation the session reports, before it numbers and times it. */
type SessionObservation = Readonly<{ toolInvocations?: readonly ConversationToolInvocation[] }> &
  (
    | Readonly<{ kind: "reply_started"; responseId: string }>
    | Readonly<{
        kind: "reply_generated";
        responseId: string;
        status: "completed" | "failed";
        transcriptItems?: readonly ProviderTranscriptItemObservation[];
        transcriptInventoryComplete?: boolean;
      }>
    | Readonly<{
        kind: "reply_cancelled";
        responseId: string;
        transcriptItems?: readonly ProviderTranscriptItemObservation[];
        transcriptInventoryComplete?: boolean;
      }>
    | Readonly<{ kind: "reply_delivery_started"; responseId: string }>
    | Readonly<{ kind: "reply_delivery_stopped"; responseId: string; playbackEndsAt?: number }>
    | Readonly<{ kind: "participant_answer_created"; itemId: string }>
    | Readonly<{
        kind: "transcript_item_observed";
        itemId: string;
        role: "participant";
        previousItemId?: string;
      }>
    | Readonly<{ kind: "participant_answer_transcribed"; itemId: string; text: string }>
    | Readonly<{ kind: "nothing_to_settle"; commandId: string }>
    | Readonly<{
        kind: "session_activity_observed";
        usage: readonly ConversationUsageEvidence[];
      }>
  );

class IdentityPersistenceFailed extends Data.TaggedError("IdentityPersistenceFailed")<{
  message: string;
}> {}

type StateName<S extends ConversationStates> = Extract<keyof S, string>;
type StateInput<S extends ConversationStates, State extends StateName<S>> = DetachedReadonly<
  z.output<S[State]["input"]>
>;

/**
 * The kit operation that carries one Conversation state the session enters, and its settings:
 * the state's content from its Conversation module.
 *
 * - `conversing`: a conversing phase, such as a later question. Its requests send the content,
 *   what the model receives there, with the conversation so far, and the model may call its
 *   tools (`auto`).
 * - `closing`: the closing, such as Goodbye. Its content is the closing sentence, which speech
 *   output says with no language-model request. `completed` turns the delivered closing's output
 *   identity into the state's completion event, such as `goodbye_completed`.
 */
export type CascadeNode<Input, Event> =
  | Readonly<{ operation: "conversing"; content(input: Input): PreparedConversationNode }>
  | Readonly<{
      operation: "closing";
      content(input: Input): PreparedClosing;
      completed(responseId: string): Event;
    }>;

/**
 * A Cascade pair's configuration of the kit's session, a value: the state the session opens
 * with and its content, and, for each Conversation state the session enters, the kit operation
 * that carries it. The opening is a conversing phase whose requests send the opening content's
 * instructions and tools, with the settings' tool choice and the conversation so far. A state
 * the session never enters, such as the opening state or one that keeps the output that entered
 * it, has no node; finishing, when input closes and nothing else is entered, is the kit's
 * default. `gate` holds the voice Gate's test options when a local Runtime applies them
 * (`GateSessionOptions`): every request then sends no tools and no tool choice, and a supplied
 * reply answers the opening phase's first participant turn with no model request.
 */
export type CascadeSessionConfiguration<S extends ConversationStates> = Readonly<{
  gate?: GateSessionOptions;
  opening: {
    [State in StateName<S>]: Readonly<{
      state: State;
      content(input: StateInput<S, State>): PreparedConversationNode;
    }>;
  }[StateName<S>];
  nodes: {
    readonly [State in StateName<S>]?: CascadeNode<
      StateInput<S, State>,
      z.output<S[State]["event"]>
    >;
  };
}>;

/** The dispatch fields a closing reads: its deadline, input-closure claims and outcome. */
type ClosingDispatch = Pick<
  NodeDispatchInput,
  | "deadlineAt"
  | "onComplete"
  | "onFailure"
  | "inputClosure"
  | "claimInputClosure"
  | "observeOutputIdentity"
  | "settleInputClosure"
  | "reportInputClosure"
>;

/** The dispatch fields a conversing phase reads: its deadline, failure and output attribution. */
type PhaseDispatch = Pick<NodeDispatchInput, "deadlineAt" | "onFailure" | "observeOutputIdentity">;

/** A phase the session cannot enter, and one whose dispatch carries no deadline. */
const phaseUnavailable = "cascade_visit_unavailable";
const phaseDeadlineMissing = "cascade_visit_deadline_missing";

/**
 * The node failures Runtime's finalization reads as an interrupted closing and as a closing
 * that missed its deadline. The names are Runtime's, from Realtime Goodbye. Any other reason,
 * such as a provider's or the media session's failure code, is a failed closing.
 */
const closingInterrupted = "goodbye_interrupted";
const closingDeadlineExceeded = "goodbye_deadline_exceeded";
const closingDeadlineMissing = "goodbye_deadline_missing";
const mediaUnavailable = "cascade_media_unavailable";

export type CascadeSessionInput = Readonly<{
  /**
   * The Cascade providers: those the Run's settings choose, by default Soniox STT, Cerebras and
   * Soniox TTS, built from Runtime's credentials, or a test's or local Runtime's stand-ins; none
   * without either.
   */
  providers: CascadeProviders | undefined;
  storage: ProviderSessionStorage;
  events: ProviderSessionEvents;
  backgroundWork: ProviderSessionBackgroundWork;
  sink: ProviderSessionApplicationSink;
  execution: Pick<ExecutionBridge, "run" | "supervise">;
  issueSink?: ((runId: string, generation: number) => ProviderSessionApplicationSink) | undefined;
}>;

/**
 * The session's lifecycle: not started; started, with its identity and prepared settings; its
 * media attached, which is the execution's readiness, with its Run, its issued sink and whether the opening was dispatched; released; or lost, when this Runtime instance
 * found the Run's recorded session gone, as after a restart, and said so.
 */
type SessionState =
  | Readonly<{ _tag: "unstarted" }>
  | Readonly<{
      _tag: "started";
      sessionId: string;
      settings: CascadeSessionSettings;
      phase: CascadePhaseSettings;
    }>
  | {
      readonly _tag: "attached";
      readonly sessionId: string;
      readonly settings: CascadeSessionSettings;
      readonly phase: CascadePhaseSettings;
      readonly runId: string;
      readonly sink: ProviderSessionApplicationSink;
      opened: boolean;
    }
  | Readonly<{ _tag: "released"; sessionId: string | null }>
  | Readonly<{ _tag: "lost" }>;

/** The adapter's state: the session's lifecycle and whether it reported a failure. */
type AdapterState = {
  session: SessionState;
  /** A failure was reported to Runtime; a media close after it reports none of its own. */
  failureReported: boolean;
};

/** The receipt order of the observations, and the ordered delivery that carries them. */
type Receipts = {
  /** The Run's generation from the media attachment on, which numbers every observation. */
  generation: number;
  sequence: number;
  received: ProviderObservationOrder | null;
  processed: ProviderObservationOrder | null;
  /** The transcript item reported last, which the next participant item follows. */
  previousItemId: string | null;
  deliveries: Queue.Queue<Delivery> | null;
  /** The delivery of the observation numbered last; Runtime's drain waits for it. */
  last: Deferred.Deferred<void> | null;
};

/** One observation waiting for its ordered delivery. */
type Delivery = Readonly<{
  fact: ProviderSessionApplicationFact;
  order: ProviderObservationOrder;
  delivered: Deferred.Deferred<void>;
}>;

/**
 * The Cascade kit's Runtime adapter: the only Cascade module that speaks Runtime's session
 * contract. It maps that contract onto the kit's turn-taking loop.
 *
 * - Start records the session identity and replies with the media formats. The browser then
 *   attaches its media, and that attachment is the execution's readiness: the session becomes
 *   one resource in the Run's native work owner's Scope, holding the media attachment, the
 *   loop and the ordered delivery of its reports. When the owner closes, every task the session
 *   started stops and the media attachment is released.
 * - The opening is dispatched after its durable claim, within the Run's lifetime.
 * - Each loop event becomes a Runtime observation of the provider kinds Runtime reads, numbered
 *   in the Run's generation and timed on receipt, and delivered in order by one task; a
 *   participant item follows the interviewer text it answered. The loop's usage reports become
 *   activity observations that carry them.
 * - Runtime's node dispatch enters the kit operation the pair's configuration names for the
 *   dispatched state: a conversing phase or the closing, with the closing failure names Runtime
 *   reads. Containment revokes whichever was entered.
 * - A provider or media failure is reported to the Run, which ends interrupted during Live and
 *   records a warning after Stop or expiry, or as the entered closing's failure.
 *
 * Ending's steps map to loop operations:
 * - `cancel_reply` cancels that output: generation and synthesis stop and the browser
 *   clears its playback. An output whose end was already delivered is not cancelled, and a
 *   model response that already completed keeps that outcome: only its delivery stops.
 * - `stop_output` stops output: any output in flight is cancelled and no further one
 *   starts; participant input is left to the input steps.
 * - `close_input` is one input closure: no further turn ends automatically, and an open
 *   opportunity closes and settles the audio it received with one speech-input finalization,
 *   whose text is the final input. There is no separate buffer commit: the participant's item
 *   exists once speech input recognized text, so the answer Runtime already holds needs nothing
 *   more. When no opportunity was open, or the finalization recognized nothing, the step
 *   reports `nothing_to_settle`.
 * - `discard_later_input` closes an open opportunity without settling it.
 * - Release ends the media session.
 * The browser closing its attachment, as the Lab page does once Runtime announced the end,
 * cancels any output and closes input the same way. An attachment that closes while the Run is
 * Live is a media failure at once, and so is a Runtime instance that finds the Run's session
 * gone after a restart. Nothing reconnects, resumes or replays.
 */
export class CascadeRuntimeSession<S extends ConversationStates> {
  readonly #configuration: CascadeSessionConfiguration<S>;
  readonly #providers: CascadeProviders | undefined;
  readonly #storage: ProviderSessionStorage;
  readonly #events: ProviderSessionEvents;
  readonly #diagnostic: DiagnosticContributor<typeof cascadeDiagnostics>;
  readonly #backgroundWork: ProviderSessionBackgroundWork;
  readonly #sink: ProviderSessionApplicationSink;
  readonly #issueSink: CascadeSessionInput["issueSink"];
  readonly #execution: Pick<ExecutionBridge, "run" | "supervise">;
  readonly #media = new CascadeMediaSession();
  /** The session's one state value. */
  readonly #state: AdapterState = { session: { _tag: "unstarted" }, failureReported: false };
  /** The receipt order of the observations, and the ordered delivery that carries them. */
  readonly #receipts: Receipts = {
    generation: 0,
    sequence: 0,
    received: null,
    processed: null,
    previousItemId: null,
    deliveries: null,
    last: null,
  };
  /** The turn-taking loop, from the media attachment on. */
  #loop: TurnTaking | null = null;
  /** Completed when the session is released, which ends its resource. */
  #releaseSignal: Deferred.Deferred<void> | null = null;

  /** A pair's session: the kit's, configured by the pair. */
  constructor(input: CascadeSessionInput, configuration: CascadeSessionConfiguration<S>) {
    this.#configuration = configuration;
    this.#providers = input.providers;
    this.#storage = input.storage;
    this.#events = input.events;
    this.#diagnostic = input.events.executionDiagnostics(cascadeDiagnostics);
    this.#backgroundWork = input.backgroundWork;
    this.#sink = input.sink;
    this.#issueSink = input.issueSink;
    this.#execution = input.execution;
  }

  /**
   * The browser's media attachment is the execution's readiness, and the session stays
   * connected until its release: its providers still serve Ending's operations, such as the
   * final settlement, after the browser closed the attachment.
   */
  get connected(): boolean {
    return this.#state.session._tag === "attached";
  }

  get connecting(): boolean {
    return this.#state.session._tag === "started";
  }

  get feasible(): boolean {
    return this.#providers !== undefined;
  }

  start(input: SessionStartInput): Effect.Effect<SessionStartResult> {
    if (this.#providers === undefined)
      return Effect.succeed({
        ok: false,
        error: "cascade_providers_unavailable",
        reason: "cascade_providers_unavailable",
      });
    const sessionId = `cascade_${crypto.randomUUID()}`;
    // The session lives with this Runtime instance: there is no reconnection to restore.
    const settings = decodeCascadeSessionSettings(input.settings);
    const content = structuredClone(input.content);
    this.#state.session = {
      _tag: "started",
      sessionId,
      settings,
      phase: {
        instructions: content.instructions,
        operationalInstructions: content.operationalInstructions,
        ...this.#offered(content.tools, settings.toolChoice),
        history: "conversation",
      },
    };
    const gate = this.#configuration.gate;
    if (gate !== undefined) this.#diagnostic("gate.test_options", gateTestOptionsRecord(gate));
    const storage = this.#storage;
    return Effect.tryPromise({
      try: async () => {
        await storage.recordSessionIdentity({
          runId: input.runId,
          sessionId: sessionId,
          sessionLocation: null,
          upstreamRequestId: null,
          settingsSummary: input.settingsSummary,
        });
      },
      catch: (cause) =>
        new IdentityPersistenceFailed({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(
      Effect.as<SessionStartResult>({
        ok: true,
        reply: { output: { ...cascadeMediaOutputFormat }, input: { ...cascadeMediaInputFormat } },
        sessionId: sessionId,
        sessionLocation: null,
        upstreamRequestId: null,
        settingsSummary: input.settingsSummary,
      }),
      Effect.catchTag("IdentityPersistenceFailed", (error) =>
        Effect.succeed<SessionStartResult>({
          ok: false,
          error: "cascade_session_start_failed",
          reason: `cascade_session_identity_failed:${error.message}`,
        }),
      ),
    );
  }

  /**
   * Accepts the Run's one media attachment. Attaching is the execution's readiness; the
   * opening still waits for the browser's media-ready receipt.
   */
  attachBrowser(request: Request): Promise<Response> {
    const record = this.#storage.read();
    const session = this.#state.session;
    if (
      record === null ||
      record.retired === true ||
      (session._tag !== "started" && session._tag !== "attached") ||
      record.sessionId !== session.sessionId
    )
      return Promise.resolve(
        Response.json({ error: "cascade_media_unavailable" }, { status: 409 }),
      );
    if (session._tag === "attached" || this.#media.attached)
      return Promise.resolve(
        Response.json({ error: "cascade_media_already_attached" }, { status: 409 }),
      );
    const accepted = acceptMediaAttachment(request);
    if (accepted === null)
      return Promise.resolve(
        Response.json({ error: "cascade_media_upgrade_required" }, { status: 426 }),
      );
    this.#media.attach(accepted.socket, () => this.#detached());
    const generation = record.generation + 1;
    this.#storage.setGeneration(record.runId, generation);
    this.#receipts.generation = generation;
    const attached = {
      ...session,
      _tag: "attached" as const,
      runId: record.runId,
      sink: this.#issueSink?.(record.runId, generation) ?? this.#sink,
      opened: false,
    };
    this.#state.session = attached;
    superviseRetained(this.#execution, this.#backgroundWork, this.#serve(attached));
    return Promise.resolve(accepted.response);
  }

  /**
   * The browser attaches through its own route; the session holds no other connection and
   * there is no reconnection. A Runtime instance that does not hold the Run's recorded session,
   * as after a restart, has lost its media and its providers' work: it reports that failure
   * once and resumes nothing, so the Run ends under the default failure policy.
   */
  ensureConnected(sessionId: string): void {
    if (this.#state.session._tag !== "unstarted") return;
    const record = this.#storage.read();
    if (record === null || record.retired === true || record.sessionId !== sessionId) return;
    this.#state.session = { _tag: "lost" };
    this.#state.failureReported = true;
    this.#diagnostic("cascade.session_lost", {
      source: "cascade_execution",
      provider: "cascade",
      sessionId,
    });
    const sink = this.#sink;
    this.#backgroundWork.waitUntil(
      Promise.resolve().then(() =>
        sink({
          kind: "failure",
          failure: "session",
          errorText: "cascade_session_lost",
          applyRuntimeFailure: true,
        }),
      ),
    );
  }

  /**
   * Dispatches the opening once the Run is Live, the browser reported media readiness and its
   * durable claim succeeds. The claim and the dispatch are one synchronous step; a refused or
   * failed claim dispatches nothing. The opening starts the conversation.
   */
  trySendOpening(): Promise<void> {
    const record = this.#storage.read();
    const session = this.#state.session;
    const loop = this.#loop;
    if (
      session._tag !== "attached" ||
      session.opened ||
      loop === null ||
      !this.#media.open ||
      record === null ||
      record.sessionId !== session.sessionId ||
      record.canStartConversation === false ||
      record.canSendOpening === false ||
      record.browserMediaReady === false ||
      (record.openingState !== undefined && record.openingState !== "pending")
    )
      return Promise.resolve();
    if (!this.#storage.claimOpening(record.runId)) return Promise.resolve();
    session.opened = true;
    this.#operate(
      loop.converse({
        settings: session.phase,
        attributeReply: (outputId) =>
          this.#events.notifyControl("cascade.opening_dispatched", { outputId }),
        node: null,
        suppliedReply: this.#configuration.gate?.suppliedReply ?? null,
      }),
    );
    this.#storage.markOpeningSent(record.runId);
    return Promise.resolve();
  }

  reconcileLifetime(): void {
    const session = this.#state.session;
    if (session._tag !== "started" && session._tag !== "attached") return;
    let record;
    try {
      record = this.#storage.read();
    } catch {
      // Resource-only reconciliation never replaces a primary failure; a later one retries.
      return;
    }
    if (record?.sessionId === session.sessionId && record.retired !== true) return;
    this.#releaseNative("retired");
  }

  sendFinalizationOperation(
    operation: EndingOperation,
  ):
    | Readonly<{ status: "dispatched" }>
    | Readonly<{ status: "failed" | "uncertain"; code: string }> {
    const session = this.#state.session;
    // Without the Run's session, as after a restart, no operation reaches a provider.
    if (session._tag !== "started" && session._tag !== "attached")
      return { status: "uncertain", code: "cascade_session_unavailable" };
    const loop = this.#loop;
    if (loop !== null)
      switch (operation.kind) {
        case "cancel_reply":
          this.#operate(loop.cancelOutput(operation.responseId));
          break;
        case "stop_output":
          this.#operate(loop.stopOutput);
          break;
        case "close_input": {
          const { commandId } = operation;
          this.#operate(
            loop.closeInput.pipe(
              Effect.flatMap((settlement) =>
                settlement?.kind === "nothing_to_settle"
                  ? this.#observe({ kind: "nothing_to_settle", commandId })
                  : Effect.void,
              ),
            ),
          );
          break;
        }
        case "discard_later_input":
          this.#operate(loop.discardInput);
          break;
      }
    return { status: "dispatched" };
  }

  /**
   * Releases the session's media and providers. Its conversation runs in this process, so once
   * released nothing of it remains open: the release answers closed.
   */
  release(_providerCallId: string | null, _timeoutCapMs?: number): Promise<SessionReleaseAnswer> {
    this.#releaseNative("released");
    return Promise.resolve({ status: "closed" });
  }

  closeBarrier(accepted: ProviderObservationOrder | null): ProviderObservationOrder | null {
    const received = this.#receipts.received;
    if (received === null) return accepted;
    if (accepted === null) return received;
    return received.generation > accepted.generation ||
      (received.generation === accepted.generation && received.sequence > accepted.sequence)
      ? received
      : accepted;
  }

  sampleReceiptPrefix(): ProviderReceiptPrefix {
    return {
      receivedOrder: this.#receipts.received,
      processedThroughOrder: this.#receipts.processed,
    };
  }

  /**
   * Settles once every observation numbered so far was delivered, or failed to be. A released
   * session delivers nothing more, so its drain settles at once.
   */
  drain(): Promise<void> {
    const last = this.#receipts.last;
    if (last === null || this.#state.session._tag === "released") return Promise.resolve();
    return this.#execution.run(Effect.asVoid(Effect.exit(Deferred.await(last))));
  }

  /**
   * Enters a dispatched Conversation state with the kit operation the pair's configuration names
   * for it. A state with no node is not the session's to enter.
   */
  enterNode<State extends StateName<S>>(input: ConversationNodeDispatch<S, State>): void {
    const node: CascadeNode<StateInput<S, State>, z.output<S[State]["event"]>> | undefined =
      this.#configuration.nodes[input.state];
    if (node === undefined) throw new Error("native_node_unavailable");
    if (node.operation === "conversing") {
      const content = node.content(input.input);
      return this.#enterPhase(input, () => input.reporter.isCurrent(), {
        instructions: content.instructions,
        operationalInstructions: content.operationalInstructions,
        ...this.#offered(content.tools, "auto"),
        history: "conversation",
      });
    }
    this.#enterClosing(input, node.content(input.input).sentence, (responseId) =>
      input.reporter.report(node.completed(responseId)),
    );
  }

  /**
   * The tools a phase's requests offer the model, with their tool choice; under the Gate's
   * `noTools`, no tools and no tool choice.
   */
  #offered(
    tools: CascadePhaseSettings["tools"],
    toolChoice: NonNullable<CascadePhaseSettings["toolChoice"]>,
  ): Pick<CascadePhaseSettings, "tools" | "toolChoice"> {
    return this.#configuration.gate?.noTools === true
      ? { tools: [], toolChoice: null }
      : { tools, toolChoice };
  }

  /**
   * Revokes the entered node: a closing's work is cancelled, the browser clears its output and
   * nothing more is reported for it; a phase whose first reply has not started is dropped; and
   * no closing or phase is entered after this.
   */
  containNode(): void {
    if (this.#loop !== null) this.#operate(this.#loop.contain);
  }

  /**
   * Enters a closing: participant input closes, the ordinary conversation stops, and speech
   * output says the closing sentence, with no language-model request, within the node's
   * deadline. A contained or released session
   * starts no closing and reports the node interrupted, and a missing or exhausted deadline
   * reports that. A closed media attachment or cleared output starts no closing either: the node
   * fails at once.
   */
  #enterClosing(
    dispatch: ClosingDispatch,
    sentence: string,
    completed: (responseId: string) => SemanticReport<unknown> | null,
  ): void {
    const loop = this.#loop;
    if (this.#state.session._tag !== "attached" || loop === null)
      return this.#backgroundWork.waitUntil(dispatch.onFailure(closingInterrupted));
    /** A claim Runtime refuses is held elsewhere, as by Ending; without a claim there is none. */
    const claim = (take: (() => string | null) | undefined) => {
      const claimed = take === undefined ? "cascade_input_closure" : take();
      // The claim needs no further provider request once taken: it is settled as dispatched.
      if (claimed !== null) dispatch.reportInputClosure?.(claimed, { status: "dispatched" });
      return claimed !== null;
    };
    this.#operate(
      loop.enterClosing({
        deadlineAt: dispatch.deadlineAt,
        sentence,
        claimInputClosure: () => claim(dispatch.claimInputClosure),
        inputSettled: (settlement) =>
          dispatch.settleInputClosure?.(
            settlement.kind === "settled"
              ? settlement.itemId
              : (dispatch.inputClosure?.admittedItemId ?? null),
          ),
        attributeReply: (outputId) => dispatch.observeOutputIdentity?.(outputId),
        done: (outputId) =>
          Effect.sync(() => {
            const report = completed(outputId);
            if (report !== null) this.#backgroundWork.waitUntil(dispatch.onComplete(report));
          }),
        failed: (failure, outputId) =>
          Effect.suspend(() => {
            if (failure.kind === "failure" && !this.#reportsFailures()) return Effect.void;
            const reported = dispatch.onFailure(closingFailureReason(failure), outputId);
            this.#backgroundWork.waitUntil(reported);
            return Effect.promise(() => reported);
          }),
      }),
    );
  }

  /**
   * Enters a conversing phase during the conversation: the move wins, so the output that moved
   * here is cut, then the phase's first reply is spoken with its settings, attributed to the
   * node, with no listening between them. An opportunity already open belongs to the earlier phase:
   * it closes and settles what it heard instead of admitting a turn. A session that is no longer
   * conversing, whose node was contained or whose input or output closed enters nothing and
   * reports the node failed, as it does for a dispatch without a deadline.
   */
  #enterPhase(
    dispatch: PhaseDispatch,
    current: () => boolean,
    settings: CascadePhaseSettings,
  ): void {
    const refuse = (reason: string) => this.#backgroundWork.waitUntil(dispatch.onFailure(reason));
    const deadlineAt = dispatch.deadlineAt;
    if (deadlineAt === null) return refuse(phaseDeadlineMissing);
    const loop = this.#loop;
    if (loop === null) return refuse(phaseUnavailable);
    this.#operate(
      loop.converse({
        settings,
        attributeReply: (outputId) => dispatch.observeOutputIdentity?.(outputId),
        node: {
          deadlineAt,
          current,
          refused: () => Effect.sync(() => refuse(phaseUnavailable)),
        },
      }),
    );
  }

  /** Runs one loop operation now, under the Run's native work owner. */
  #operate(operation: Effect.Effect<void>): void {
    superviseRetained(this.#execution, this.#backgroundWork, operation);
  }

  /**
   * The session as one resource in the Run's native work owner's Scope, from the media
   * attachment until its release: the media attachment, the ordered delivery of observations
   * and the turn-taking loop. Its readiness is reported, then the opening is tried. Closing the
   * Scope stops the loop's work, then the delivery, then releases the media attachment.
   */
  #serve(attached: Extract<SessionState, { _tag: "attached" }>): Effect.Effect<void> {
    const self = this;
    const providers = this.#providers;
    if (providers === undefined) return Effect.void;
    return Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      self.#releaseSignal = released;
      yield* Effect.addFinalizer(() => Effect.sync(() => self.#releaseNative("released")));
      const startedAt = yield* Clock.currentTimeMillis;
      self.#storage.markStarted(attached.runId, startedAt);
      self.#diagnostic("cascade.media_attached", {
        source: "cascade_execution",
        provider: "cascade",
      });
      self.#events.notifyControl("cascade.media_attached", { sessionId: attached.sessionId });
      // Each provider uses the settings the Run was prepared with.
      const settings = Layer.succeed(CascadeProviderSettings, attached.settings.providers);
      const services = yield* Layer.build(
        Layer.mergeAll(
          providers.pipe(Layer.provide(settings)),
          Layer.succeed(CascadeMedia, self.#media.media),
        ),
      );
      yield* self.#deliver(attached.sink);
      self.#loop = yield* makeTurnTaking({
        model: {
          maxOutputTokens: attached.settings.maxOutputTokens,
          reasoning: attached.settings.reasoning,
        },
        inputEligible: () => self.#inputEligible(),
        emit: (event) => self.#report(event),
        diagnostic: self.#diagnostic,
      }).pipe(Effect.provideContext(services));
      const readyAt = yield* Clock.currentTimeMillis;
      const ready = yield* Effect.exit(
        Effect.tryPromise(() =>
          attached.sink({ kind: "execution_ready", runId: attached.runId, at: readyAt }),
        ),
      );
      if (Exit.isSuccess(ready)) yield* Effect.promise(() => self.trySendOpening());
      const loop = self.#loop;
      yield* Effect.raceFirst(loop.join, Deferred.await(released));
    }).pipe(Effect.scoped);
  }

  /**
   * The ordered delivery of observations: one task delivers each to the issued sink in order,
   * then reports the drained prefix. When it stops, observations still waiting are dropped.
   */
  #deliver(sink: ProviderSessionApplicationSink) {
    const receipts = this.#receipts;
    return Effect.gen(function* () {
      const deliveries = yield* Queue.unbounded<Delivery>();
      receipts.deliveries = deliveries;
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          receipts.deliveries = null;
          const waiting = yield* Queue.clear(deliveries);
          for (const delivery of waiting) yield* Deferred.succeed(delivery.delivered, undefined);
          // An observation whose delivery was cut short no longer holds Runtime's drain.
          if (receipts.last !== null) yield* Deferred.succeed(receipts.last, undefined);
        }),
      );
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const delivery = yield* Queue.take(deliveries);
            const delivered = yield* Effect.exit(
              Effect.promise(() => sink(delivery.fact)).pipe(
                Effect.andThen(Effect.sync(() => (receipts.processed = delivery.order))),
                Effect.andThen(Effect.promise(() => sink({ kind: "message_queue_drained" }))),
              ),
            );
            yield* Deferred.done(delivery.delivered, delivered);
          }),
        ),
      );
    });
  }

  /** Delivers one loop event: as Runtime observations in order, or as a failure. */
  #report(event: TurnTakingEvent): Effect.Effect<void> {
    const self = this;
    const receipts = this.#receipts;
    /** The text submitted for synthesis, as the output's interviewer transcript item. */
    const transcriptItems = (
      outputId: string,
      text: string,
    ): ProviderTranscriptItemObservation[] => {
      if (text.length === 0) return [];
      const itemId = `cascade_text_${crypto.randomUUID()}`;
      receipts.previousItemId = itemId;
      return [{ itemId, role: "conversationAgent", text, responseId: outputId, outputIndex: 0 }];
    };
    switch (event.kind) {
      case "output_started":
        return this.#observe({ kind: "reply_started", responseId: event.outputId });
      case "reply_generated":
        return this.#observe(
          event.outcome === "completed"
            ? {
                kind: "reply_generated",
                responseId: event.outputId,
                status: "completed",
                toolInvocations: event.toolCalls.map((call) => ({
                  type: "function_call" as const,
                  toolName: call.name,
                  callId: call.callId,
                  responseId: event.outputId,
                  arguments: call.arguments,
                })),
                transcriptItems: transcriptItems(event.outputId, event.text),
                transcriptInventoryComplete: true,
              }
            : {
                kind: "reply_generated",
                responseId: event.outputId,
                status: "failed",
                transcriptItems: transcriptItems(event.outputId, event.text),
                transcriptInventoryComplete: true,
              },
        );
      case "output_cancelled":
        return this.#observe({
          kind: "reply_cancelled",
          responseId: event.outputId,
          transcriptItems: transcriptItems(event.outputId, event.text),
          transcriptInventoryComplete: true,
        });
      case "delivery_started":
        return this.#observe({ kind: "reply_delivery_started", responseId: event.outputId });
      case "delivery_stopped":
        return this.#observe(
          event.playbackEndsAt === undefined
            ? { kind: "reply_delivery_stopped", responseId: event.outputId }
            : {
                kind: "reply_delivery_stopped",
                responseId: event.outputId,
                playbackEndsAt: event.playbackEndsAt,
              },
        );
      case "participant_item_started":
        return this.#observe({ kind: "participant_answer_created", itemId: event.itemId });
      case "participant_text_final":
        return Effect.gen(function* () {
          // The participant item gets its text, after the transcript item it answered.
          const observed = {
            kind: "transcript_item_observed",
            itemId: event.itemId,
            role: "participant",
          } as const;
          const previousItemId = receipts.previousItemId;
          yield* self.#observe(
            previousItemId === null ? observed : { ...observed, previousItemId },
          );
          yield* self.#observe({
            kind: "participant_answer_transcribed",
            itemId: event.itemId,
            text: event.text,
          });
          receipts.previousItemId = event.itemId;
        });
      case "usage":
        return this.#observe({ kind: "session_activity_observed", usage: event.usage });
      case "failed":
        return this.#reportFailure(event.code);
    }
  }

  /** Numbers and times one observation, then waits for its ordered delivery. */
  #observe(observation: SessionObservation): Effect.Effect<void> {
    const self = this;
    const receipts = this.#receipts;
    return Effect.gen(function* () {
      const session = self.#state.session;
      const at = yield* Clock.currentTimeMillis;
      const order = {
        generation: receipts.generation,
        sequence: ++receipts.sequence,
      };
      receipts.received = order;
      // Like a native receipt, each observation carries its Runtime receipt time.
      const ordered: OrderedProviderFinalizationObservation = {
        ...observation,
        ...order,
        observedAt: at,
        ...{ at },
      };
      const fact: ProviderSessionApplicationFact = {
        kind: "provider_observation",
        observation: ordered,
        persistence: {
          sessionId: "sessionId" in session && session.sessionId !== null ? session.sessionId : "",
          sequence: order.sequence,
          diagnosticSummary: {
            sequence: order.sequence,
            type: observation.kind,
            ...("responseId" in observation
              ? { response_id: observation.responseId }
              : "itemId" in observation
                ? { item_id: observation.itemId }
                : "commandId" in observation
                  ? { event_id: observation.commandId }
                  : {}),
          },
        },
      };
      const deliveries = receipts.deliveries;
      if (deliveries === null) return;
      const delivered = yield* Deferred.make<void>();
      receipts.last = delivered;
      yield* Queue.offer(deliveries, { fact, order, delivered });
      yield* Deferred.await(delivered);
    });
  }

  /** Whether this session still reports failures: it is the Run's recorded, unreleased one. */
  #reportsFailures(): boolean {
    const session = this.#state.session;
    if (session._tag !== "started" && session._tag !== "attached") return false;
    if (this.#storage.read()?.sessionId !== session.sessionId) return false;
    this.#state.failureReported = true;
    return true;
  }

  /**
   * Reports a provider or media failure to the Run. During Live the Run cannot continue
   * reliably and ends interrupted; after Stop or expiry was admitted, Runtime keeps that reason
   * and records the failure as a warning. The failure belongs to the Run's session, not to one
   * Conversation visit, so it goes to the Run's own sink: a failure of the closing spoken with
   * `finish_interview` is reported although Conversation has moved on to finishing.
   */
  #reportFailure(code: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (!this.#reportsFailures()) return Effect.void;
      const sink = this.#sink;
      return Effect.promise(() =>
        sink({ kind: "failure", failure: "session", errorText: code, applyRuntimeFailure: true }),
      );
    });
  }

  #detached(): void {
    const released = this.#state.session._tag === "released";
    this.#diagnostic("cascade.media_detached", {
      source: "cascade_execution",
      provider: "cascade",
      reason: released ? "released" : "browser_closed",
    });
    const loop = this.#loop;
    if (loop === null) return;
    // The Lab page closes its attachment only once Runtime announced the end. A Run still Live
    // has lost its media: nothing more is heard or spoken, and that failure ends it at once.
    if (released || !this.#live()) return this.#operate(loop.mediaClosed);
    this.#operate(loop.end);
    if (!this.#state.failureReported) this.#operate(loop.fail("cascade_media_detached"));
  }

  /** Whether the Run is still Live: Ending has not been admitted. */
  #live(): boolean {
    const session = this.#state.session;
    if (session._tag !== "attached") return false;
    try {
      const record = this.#storage.read();
      return (
        record !== null &&
        record.sessionId === session.sessionId &&
        record.retired !== true &&
        record.canStartConversation === true
      );
    } catch {
      return false;
    }
  }

  /** Participant input is eligible only while the Run is Live and Conversation accepts it. */
  #inputEligible(): boolean {
    const session = this.#state.session;
    if (session._tag !== "attached") return false;
    const record = this.#storage.read();
    return (
      record !== null &&
      record.sessionId === session.sessionId &&
      record.retired !== true &&
      record.canStartConversation !== false &&
      record.participantInputClosed !== true
    );
  }

  /**
   * Releases the session: no further output or turn, the media attachment closes and the
   * session's resource ends.
   */
  #releaseNative(reason: string): void {
    const session = this.#state.session;
    if (session._tag === "released") return;
    this.#state.session = {
      _tag: "released",
      sessionId: "sessionId" in session ? session.sessionId : null,
    };
    if (this.#loop !== null) this.#operate(this.#loop.end);
    this.#media.close(reason);
    if (this.#releaseSignal !== null)
      this.#operate(Deferred.succeed(this.#releaseSignal, undefined));
  }
}

/**
 * Releases a Cascade call by its identity alone, after a failed start whose Run admitted no
 * Conversation. A Cascade call is its session, which lives with the Runtime instance that
 * started it, and holds no provider call of its own: nothing outlives the session to release.
 */
export function releaseCascadeCall(_providerCallId: string | null): SessionReleaseAnswer {
  return { status: "closed" };
}

/** The node failure Runtime reads for each way a closing fails. */
function closingFailureReason(failure: ClosingFailure): string {
  switch (failure.kind) {
    case "interrupted":
      return closingInterrupted;
    case "deadline_missing":
      return closingDeadlineMissing;
    case "deadline_exceeded":
      return closingDeadlineExceeded;
    case "media_unavailable":
      return mediaUnavailable;
    case "failure":
      return failure.code;
  }
}
