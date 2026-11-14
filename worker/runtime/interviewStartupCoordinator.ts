import { z } from "zod";
import { applicationCallbackUrl } from "./applicationCallbacks.ts";
import type { ExecutionBridge } from "./runtimeHostAssembly.ts";
import { validateConversationDefinition } from "./conversationContracts.ts";
import { AcceptedConversations } from "./implementationContracts.ts";
import { createConversationSnapshot, decodeConversationSnapshot } from "./conversationExecution.ts";
import type { ConversationSelection } from "../shared/contracts/conversationSelection.ts";
import { decodeConversationAgentSelection } from "./conversationAgent.ts";
import type { RuntimeImplementation } from "./implementationContracts.ts";
import type { ConversationCallbackJson as PreparedExecutionSettings } from "./conversationContracts.ts";
import { prepareExecutionSettings } from "./conversationStartup.ts";
import type { ConnectionPayload } from "../shared/contracts/runtimeConnection.ts";
import { Cause, Clock, Data, Effect, Exit, Fiber, Result } from "effect";
import { callUntilDeadline } from "../shared/deadline.ts";
import type {
  ConnectionCheckpoint,
  SelectedConnectionSetup,
  StartupConnectionImplementation,
} from "./conversationConnection.ts";
import {
  ConversationStartup,
  StartupRejected,
  refuseAdmission,
  type InterviewStartupProvider,
} from "./conversationStartup.ts";
import type { RuntimeConnectionResult } from "../shared/contracts/runtimeConnection.ts";
export type { InterviewStartupProvider } from "./conversationStartup.ts";
/** Startup operations fail with this refusal; any other failure is a defect. */
export { StartupRejected };
/** The selected execution's settings for a Run's start choices, refusing what it cannot prepare. */
export { prepareExecutionSettings };
import type { StartupStage } from "../shared/contracts/startupDiagnostics.ts";
import type {
  RuntimeDiagnosticsContext,
  RuntimeStartRequest,
} from "../shared/contracts/runtimeStart.ts";
import {
  conversationNodeDeadline,
  type InterviewFinalizationAggregate,
  type SerializedTranscriptCapture,
} from "./interviewFinalizationModel.ts";
import type { RuntimeControllerRow } from "./interviewFinalizationRepository.ts";
import {
  createTranscriptCapture,
  restoreTranscriptCapture,
  serializeTranscriptCapture,
} from "./transcriptCapture.ts";
import type { RuntimeUsageAccountingState } from "./runtimeUsage.ts";
import { parseRuntimeUsageAccountingState } from "./runtimeUsage.ts";
import { recordStartupDiagnostic, type RuntimeEventPayload } from "./runtimeEvents.ts";
import {
  decodeApplicationStartupDisposition,
  type ApplicationStartupDisposition,
} from "../shared/contracts/applicationStartup.ts";

export const browserPresenceGraceMs = 15_000;
class ReadinessDeliveryError extends Data.TaggedError("ReadinessDeliveryError") {}
class ReadinessDeliveryTimeout extends Data.TaggedError("ReadinessDeliveryTimeout") {}

export type RuntimeSetupInput = Readonly<{
  deliveryTarget?: import("../shared/contracts/runtimeDelivery.ts").RuntimeDeliveryTarget;
  /** The start request's settings for the selected execution, opaque to Runtime. */
  executionSettings?: import("./conversationContracts.ts").ConversationCallbackJson;
  runId: string;
  reasoningEffort?: import("../shared/contracts/runtimeStart.ts").RuntimeReasoningEffort | null;
  createdAt: number;
  startedAt: number;
  fakeSessionId: string | null;
  startupExpiresAt?: number | null;
  diagnosticsContext: RuntimeDiagnosticsContext;
}>;

/** Every Run starts with an accepted Conversation selection and its execution input. */
export type RuntimeStartInput = RuntimeSetupInput &
  Readonly<{
    selection: ConversationSelection;
    execution: import("../shared/contracts/runtimeStart.ts").InterviewExecution;
  }>;

export type InterviewStartupRepository = Readonly<{
  readState(): RuntimeControllerRow | null;
  requireState(runId?: string | null): RuntimeControllerRow;
  createSetup(input: {
    agentSelectionJson?: string;
    conversationSelectionJson?: string | undefined;
    deliveryTarget?: import("../shared/contracts/runtimeDelivery.ts").RuntimeDeliveryTarget;
    runId: string;
    runtimeId: string;
    createdAt: number;
    startedAt: number;
    fakeSessionId: string | null;
    startupExpiresAt?: number | null;
    diagnosticsContext: Readonly<Record<string, unknown>>;
    transcriptCapture: unknown;
    publication: unknown;
  }): void;
  markProviderCreationStarted(runId: string): void;
  retainConversationStart?(
    runId: string,
    input: { profile: string; startJson: string; exchangeId: string; fingerprint: string },
  ): void;
  recordConnectionReply?(runId: string, reply: ConnectionPayload): void;
  recordConnectionCheckpoint?(runId: string, checkpoint: ConnectionCheckpoint): void;
  /** Whether this attempt claimed the Run's one readiness delivery. */
  claimReadinessDelivery(runId: string, attemptedAt: number): boolean;
  recordReadinessDisposition(
    runId: string,
    input: Readonly<{
      deliveredAt: number | null;
      disposition: string;
    }>,
  ): void;
}>;

export type InterviewStartupEvents = Readonly<{
  recordEvent(eventName: string, payload?: RuntimeEventPayload): void;
  recordUniqueDiagnostic(
    type: string,
    predicate: (payload: Record<string, unknown>) => boolean,
    payload?: RuntimeEventPayload,
  ): void;
}>;

export type InterviewStartupFinalization = Readonly<{
  initialize(input: {
    runId: string;
    liveAt: number;
    runtimeUsage: RuntimeUsageAccountingState;
    transcriptCapture: SerializedTranscriptCapture;
  }): InterviewFinalizationAggregate;
}>;

export type InterviewStartupAlarmRequests = Readonly<{
  request(): Effect.Effect<void>;
}>;

/** The Run's attempt lifecycle that startup composes. Each durable commit is one synchronous step. */
export type InterviewStartupAttempt = Readonly<{
  hasFailedStart(): boolean;
  failSetup(runId: string): Effect.Effect<void>;
  mayGoLive(at: number): Effect.Effect<boolean>;
  /** Commits Live when called; the returned Effect carries the outcome and its follow-up. */
  commitLive(input: {
    runId: string;
    liveEvidenceAt: number;
    deadlineAt: number | null;
    presenceGraceUntil: number;
    aggregate: InterviewFinalizationAggregate;
  }): Effect.Effect<"live" | "failed" | "unchanged">;
}>;

/** Readiness delivery runs in the Live owner, so interrupting that owner aborts its transport. */
export type InterviewStartupReadiness = Readonly<{
  notify(
    input: Readonly<{ runId: string; liveAt: number; expiresAt: number | null }>,
  ): Effect.Effect<ApplicationStartupDisposition | null>;
}>;

/** A repeated start's retained setup, or the Run whose new setup was just claimed. */
type SetupAcceptance =
  | Readonly<{ created: false; state: RuntimeControllerRow }>
  | Readonly<{ created: true; runId: string }>;

export class InterviewStartupCoordinator {
  readonly #execution: Pick<ExecutionBridge, "enter"> | undefined;
  readonly #attempt: InterviewStartupAttempt;
  readonly #conversation: ConversationStartup;
  readonly #resolveImplementation: (selection: ConversationSelection) => RuntimeImplementation;
  readonly #conversations: AcceptedConversations;
  readonly #repository: InterviewStartupRepository;
  readonly #events: InterviewStartupEvents;
  readonly #finalization: InterviewStartupFinalization;
  readonly #now: () => number;
  readonly #alarmRequests: InterviewStartupAlarmRequests;
  readonly #readiness: InterviewStartupReadiness;
  readonly #background: (task: Promise<void>) => void;

  constructor(
    input: Readonly<{
      execution?: Pick<ExecutionBridge, "enter">;
      attempt: InterviewStartupAttempt;
      /** Resolves a Run's accepted selection; the selected pair owns its models and preparation. */
      resolveImplementation: (selection: ConversationSelection) => RuntimeImplementation;
      /** The Runtime instance's owner of the accepted input; one decode per Runtime entry. */
      conversations?: AcceptedConversations;
      provider: InterviewStartupProvider;
      connectionImplementation?: StartupConnectionImplementation | undefined;
      /** The selected entry's setup of a connection profile; an undeclared profile is unavailable. */
      connectionSetup(selection: ConversationSelection, profile: string): SelectedConnectionSetup;
      /**
       * The credentials the selected combination needs and Runtime lacks, none when it can
       * start: with the Run's prepared settings when given, whose providers may need their own.
       */
      missingCredentials(
        selection: ConversationSelection,
        settings?: PreparedExecutionSettings,
      ): readonly string[];
      repository: InterviewStartupRepository;
      events: InterviewStartupEvents;
      finalization: InterviewStartupFinalization;
      /** The Run clock's synchronous read, for steps that write storage synchronously. */
      now: () => number;
      alarmRequests: InterviewStartupAlarmRequests;
      readiness?: InterviewStartupReadiness;
      background(task: Promise<void>): void;
    }>,
  ) {
    this.#execution = input.execution;
    this.#resolveImplementation = input.resolveImplementation;
    this.#conversations =
      input.conversations ?? new AcceptedConversations(input.resolveImplementation);
    this.#attempt = input.attempt;
    this.#repository = input.repository;
    this.#events = input.events;
    this.#finalization = input.finalization;
    this.#now = input.now;
    this.#alarmRequests = input.alarmRequests;
    this.#readiness = input.readiness ?? { notify: () => Effect.succeed(null) };
    this.#background = input.background;
    this.#conversation = new ConversationStartup({
      ...input,
      startRuntime: (runId, readInput, target) => this.#acceptRuntime(runId, readInput, target),
      recordStage: (stage) => this.recordStage(stage),
      failSetup: (runId, reason, stage, cleanup) =>
        this.#setupFailure(runId, reason, stage, cleanup),
      detach: (operation) => this.#detach(operation),
    });
  }

  /**
   * Validates a repeated start or claims a new setup. The claim and the start of the observed
   * owner that completes a new acceptance are one step.
   */
  startRuntime(
    runId: string,
    readInput: () => RuntimeStartInput,
    target?: import("../shared/contracts/runtimeDelivery.ts").RuntimeDeliveryTarget,
  ): Effect.Effect<Readonly<{ created: boolean; state: RuntimeControllerRow }>, StartupRejected> {
    return Effect.uninterruptible(
      Effect.suspend(
        (): Effect.Effect<
          Effect.Effect<Readonly<{ created: boolean; state: RuntimeControllerRow }>>,
          StartupRejected
        > => {
          let accepted: SetupAcceptance;
          try {
            accepted = this.#acceptSetup(runId, readInput, target);
          } catch (refusal) {
            return refuseAdmission(refusal);
          }
          return accepted.created
            ? this.#detach(this.#completeAcceptance(accepted.runId))
            : Effect.succeed(Effect.succeed(accepted));
        },
      ),
    ).pipe(Effect.flatten);
  }

  /**
   * Acceptance inside a startup owner. The setup claim runs synchronously at call time, before any
   * suspension, and a refused claim throws there; the returned Effect completes its wake-up
   * request in the caller's fiber.
   */
  #acceptRuntime(
    runId: string,
    readInput: () => RuntimeStartInput,
    target?: import("../shared/contracts/runtimeDelivery.ts").RuntimeDeliveryTarget,
  ): Effect.Effect<Readonly<{ created: boolean; state: RuntimeControllerRow }>> {
    const accepted = this.#acceptSetup(runId, readInput, target);
    return accepted.created ? this.#completeAcceptance(accepted.runId) : Effect.succeed(accepted);
  }

  #completeAcceptance(
    runId: string,
  ): Effect.Effect<Readonly<{ created: true; state: RuntimeControllerRow }>> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.#alarmRequests.request();
      return { created: true as const, state: self.#repository.requireState(runId) };
    });
  }

  /** Validates a repeated start or claims a new setup. Synchronous: it has no suspension point. */
  #acceptSetup(
    runId: string,
    readInput: () => RuntimeStartInput,
    target?: import("../shared/contracts/runtimeDelivery.ts").RuntimeDeliveryTarget,
  ): SetupAcceptance {
    const existing = this.#repository.readState();
    if (existing !== null) {
      if (existing.run_id !== runId) throw new Error("runtime_controller_run_mismatch");
      if (
        target !== undefined &&
        JSON.stringify(target) !== (existing.delivery_target_json ?? "null")
      )
        throw new Error("runtime_delivery_target_conflict");
      if (existing.conversation_selection_json == null)
        throw new Error("conversation_selection_missing");
      const retained = decodeConversationSnapshot(JSON.parse(existing.conversation_selection_json));
      const attempted = readInput();
      if (JSON.stringify(attempted.selection) !== JSON.stringify(retained.selection))
        throw new Error("conversation_selection_conflict");
      if (JSON.stringify(attempted.execution) !== JSON.stringify(retained.execution))
        throw new Error("conversation_input_conflict");
      const selection = decodeConversationAgentSelection(
        parseJsonObject(existing.agent_selection_json ?? null),
      );
      if (selection.id !== this.#resolveImplementation(retained.selection).id)
        throw new Error("conversation_agent_unavailable");
      return { created: false, state: existing };
    }

    const input = readInput();
    const { agent: selected, accepted } = this.#conversations.select(input.runId, input);
    validateConversationDefinition(selected.conversation);
    const initialContext = accepted.initialContext;
    const nodeInput = accepted.selectInput(selected.conversation.initial, {
      runId,
      context: initialContext,
    });
    // The opening's content and the execution's settings are prepared here, before setup is
    // claimed: a state or start choices that cannot be prepared refuse the start.
    selected.prepareContent({
      runId: input.runId,
      state: selected.conversation.initial,
      nodeInput,
    });
    const choices = {
      reasoningEffort: input.reasoningEffort ?? null,
      requested: input.executionSettings,
    };
    const snapshot = createConversationSnapshot(
      input.selection,
      input.execution,
      { ...choices, prepared: prepareExecutionSettings(selected, choices) },
      selected.conversation.initial,
      nodeInput,
      initialContext,
    );
    const setup = {
      ...input,
      conversationSelectionJson: JSON.stringify(snapshot),
      agentSelectionJson: JSON.stringify({
        id: selected.id,
        execution: input.execution,
      }),
      runtimeId: `runtime_${crypto.randomUUID()}`,
      transcriptCapture: serializeTranscriptCapture(createTranscriptCapture()),
      publication: {
        status: "pending",
        publicationCutoffAt: null,
        transcriptDelivered: false,
        completionDelivered: false,
        retryAt: null,
        attemptCount: 0,
        deliveredAt: null,
        lastError: null,
      },
    };
    this.#repository.createSetup(setup);
    this.recordStage("runtimeAccepted");
    return { created: true, runId: input.runId };
  }

  startConnection(
    request: RuntimeStartRequest,
    readSetup: () => RuntimeSetupInput,
  ): Effect.Effect<RuntimeConnectionResult, StartupRejected> {
    return this.#conversation.startConnection(request, readSetup);
  }

  requireConnectionAvailable(): void {
    this.#conversation.requireAvailable();
  }

  requireStartable(selection: ConversationSelection, settings?: PreparedExecutionSettings): void {
    this.#conversation.requireStartable(selection, settings);
  }

  /**
   * Commits setup to Live and delivers readiness once. Preparing the Live commit and making it are
   * one synchronous step, as the eager readiness handoff requires; the observed owner that delivers
   * readiness starts in the same uninterruptible step and continues after a caller stops waiting.
   */
  markLive(
    runId: string,
    liveAt?: number,
  ): Effect.Effect<ApplicationStartupDisposition["disposition"] | null> {
    return Effect.uninterruptible(
      Effect.suspend(
        (): Effect.Effect<Effect.Effect<ApplicationStartupDisposition["disposition"] | null>> => {
          const commit = this.#prepareLive(runId, liveAt ?? this.#now());
          if (commit === null) return Effect.succeed(Effect.succeed(null));
          const committed = this.#attempt.commitLive({
            runId,
            liveEvidenceAt: commit.liveAt,
            deadlineAt: commit.deadlineAt,
            presenceGraceUntil: commit.presenceGraceUntil,
            aggregate: commit.aggregate,
          });
          return this.#detach(this.#completeLive(committed, commit));
        },
      ),
    ).pipe(Effect.flatten);
  }

  /** The Live commit of a Run still in setup, or null when it has already left setup. */
  #prepareLive(runId: string, liveAt: number): LiveCommit | null {
    const state = this.#repository.requireState(runId);
    if (state.phase !== "setup") return null;
    let deadlineAt: number | null = null;
    const presenceGraceUntil = liveAt + browserPresenceGraceMs;
    let aggregate: InterviewFinalizationAggregate = {
      ...this.#finalization.initialize({
        runId: state.run_id,
        liveAt,
        runtimeUsage:
          parseRuntimeUsageAccountingState(state.runtime_usage_json) ??
          (() => {
            throw new Error("invalid_runtime_usage_state");
          })(),
        transcriptCapture: serializeTranscriptCapture(
          restoreTranscriptCapture(
            parseJsonObject(state.transcript_capture_json) ?? { sequence: 0, items: [] },
          ),
        ),
      }),
      providerGeneration: state.session_generation,
    };

    const selectedConversation =
      state.conversation_selection_json == null
        ? null
        : decodeConversationSnapshot(JSON.parse(state.conversation_selection_json));
    if (selectedConversation === null) throw new Error("conversation_selection_missing");
    const { agent: implementation, accepted } = this.#conversations.select(
      state.run_id,
      selectedConversation,
    );
    const timerPlan = accepted.timers?.({
      liveAt,
      enteredAt: liveAt,
      state: selectedConversation.initialState,
    });
    if (timerPlan !== undefined) {
      const timers = timerPlan.timers.map((timer) => ({
        ...structuredClone(timer),
        event: z.json().parse(implementation.conversation.runtimeEvent?.parse(timer.event)),
        deadlineAt: liveAt + requireSchedulableRuntimeDuration(timer.deadlineAt - liveAt, liveAt),
      }));
      deadlineAt = conversationNodeDeadline({ timers });
      const retained: NonNullable<InterviewFinalizationAggregate["conversationNodeExecution"]> = {
        kind: "ordinary",
        mediaCutoffAt: deadlineAt ?? liveAt,
        timers,
      };
      aggregate = {
        ...aggregate,
        conversationNodeExecution:
          timerPlan.associatedTimerId === undefined
            ? retained
            : { ...retained, associatedTimerId: timerPlan.associatedTimerId },
      };
    }
    if (selectedConversation !== null) {
      let visit: NonNullable<InterviewFinalizationAggregate["conversationVisit"]> = {
        state: selectedConversation.initialState,
        visitId: selectedConversation.visitId,
        operationId: selectedConversation.operationId,
      };
      if (selectedConversation.initialContext !== undefined)
        visit = { ...visit, context: selectedConversation.initialContext };
      aggregate = { ...aggregate, conversationVisit: visit };
    }
    return {
      runId,
      liveAt,
      deadlineAt,
      presenceGraceUntil,
      aggregate,
      startupExpiresAt: state.startup_expires_at,
    };
  }

  /** The observed Live owner: it completes the committed transition, then delivers readiness once. */
  #completeLive(
    committed: Effect.Effect<"live" | "failed" | "unchanged">,
    { runId, liveAt, presenceGraceUntil, aggregate, startupExpiresAt }: LiveCommit,
  ): Effect.Effect<ApplicationStartupDisposition["disposition"] | null> {
    const self = this;
    return Effect.gen(function* () {
      const transition = yield* committed;
      if (transition !== "live") return null;
      const liveDiagnosticExit = yield* Effect.exit(
        Effect.sync(() => {
          self.recordStage("liveAt", liveAt);
          self.#conversation.recordLiveDiagnostic();
          if (aggregate.conversationVisit !== undefined)
            self.#events.recordEvent("runtime.conversation_state", {
              state: aggregate.conversationVisit.state,
              deadlineAt:
                aggregate.conversationNodeExecution?.timers.find(
                  (timer) => timer.id === aggregate.conversationNodeExecution?.associatedTimerId,
                )?.deadlineAt ?? null,
            });
          self.#events.recordEvent("runtime.presence_grace_started", {
            graceUntil: presenceGraceUntil,
          });
        }),
      );
      // A rejected physical alarm cannot strand the already-admitted readiness responsibility.
      // Preserve its failure for the native caller after completing this operation's claim.
      const alarmExit = yield* Effect.exit(self.#alarmRequests.request());
      const attemptedAt = self.#now();
      if (!self.#repository.claimReadinessDelivery(runId, attemptedAt)) {
        if (Exit.isFailure(liveDiagnosticExit))
          return yield* Effect.failCause(liveDiagnosticExit.cause);
        if (Exit.isFailure(alarmExit)) return yield* Effect.failCause(alarmExit.cause);
        return null;
      }
      const readinessDiagnosticExit = yield* Effect.exit(
        Effect.sync(() => {
          self.#events.recordUniqueDiagnostic("runtime.readiness_delivery_started", () => true, {
            source: "runtime_controller",
            liveAt,
            startupExpiresAt: startupExpiresAt ?? undefined,
          });
        }),
      );
      const disposition = yield* self.#readiness.notify({
        runId,
        liveAt,
        expiresAt: startupExpiresAt,
      });
      self.#repository.recordReadinessDisposition(runId, {
        deliveredAt: disposition === null ? null : self.#now(),
        disposition: disposition?.disposition ?? "unknown",
      });
      const receiptDiagnosticExit = yield* Effect.exit(
        Effect.sync(() => {
          self.#events.recordUniqueDiagnostic("runtime.readiness_delivery_finished", () => true, {
            source: "runtime_controller",
            delivered: disposition !== null,
            disposition: disposition?.disposition ?? "unknown",
          });
        }),
      );
      // Diagnostic defects cannot abandon admitted readiness. Surface the first failure
      // after its once-only dispatch and receipt have completed, without replaying either.
      if (Exit.isFailure(liveDiagnosticExit))
        return yield* Effect.failCause(liveDiagnosticExit.cause);
      if (Exit.isFailure(alarmExit)) return yield* Effect.failCause(alarmExit.cause);
      if (Exit.isFailure(readinessDiagnosticExit))
        return yield* Effect.failCause(readinessDiagnosticExit.cause);
      if (Exit.isFailure(receiptDiagnosticExit))
        return yield* Effect.failCause(receiptDiagnosticExit.cause);
      return disposition?.disposition ?? null;
    });
  }

  recordStage(stage: StartupStage, at = this.#now()): void {
    recordStartupDiagnostic(this.#events, { stage, at });
  }

  /** Fails setup in an observed owner that continues after a caller stops waiting. */
  failSetup(
    runId: string,
    reason: string,
    failureStage: StartupStage = "sessionConnected",
    cleanup: "unknown" | "not_needed" | "not_attempted" = "not_attempted",
  ): Effect.Effect<void> {
    return this.#observe(this.#setupFailure(runId, reason, failureStage, cleanup));
  }

  /** Records the failure, commits the durable setup failure and requests its wake-up. */
  #setupFailure(
    runId: string,
    reason: string,
    failureStage: StartupStage = "sessionConnected",
    cleanup: "unknown" | "not_needed" | "not_attempted" = "not_attempted",
  ): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      recordStartupDiagnostic(self.#events, {
        stage: failureStage,
        at: self.#now(),
        failure: true,
        cleanup,
      });
      yield* self.#attempt.failSetup(runId);
      self.#conversation.recordSetupFailureDiagnostic(reason);
      yield* self.#alarmRequests.request();
    });
  }

  applyProviderFailure(
    fact: Readonly<{
      failure: "session" | "message";
      errorText: string;
      applyRuntimeFailure: boolean;
    }>,
  ): Effect.Effect<void> {
    return this.#conversation.applyProviderFailure(fact);
  }

  /** Hands an operation to its own detached owner and waits for its outcome. */
  #observe<Value, Failure extends StartupRejected = never>(
    operation: Effect.Effect<Value, Failure>,
  ): Effect.Effect<Value, Failure> {
    return Effect.flatten(Effect.uninterruptible(this.#detach(operation)));
  }

  /**
   * Starts an operation in its own owner and returns the wait for its outcome. The owner starts
   * immediately, inside the native execution's entry, and the host retains it: a caller that
   * stops waiting cannot interrupt it.
   */
  #detach<Value, Failure extends StartupRejected = never>(
    operation: Effect.Effect<Value, Failure>,
  ): Effect.Effect<Effect.Effect<Value, Failure>> {
    // A refusal is returned as a value; only defects and interruption fail the owner.
    const crossing = Effect.result(operation);
    return Effect.forkDetach(
      this.#execution === undefined ? crossing : this.#execution.enter(crossing),
      { startImmediately: true },
    ).pipe(
      Effect.map((owner) => {
        // Known refusals map to the caller; defects and interruption remain visible even when
        // that caller no longer observes its reply.
        this.#background(retainOwner(owner));
        return Fiber.await(owner).pipe(
          Effect.flatMap((exit) => {
            if (Exit.isFailure(exit)) return Effect.die(Cause.squash(exit.cause));
            return Result.isFailure(exit.value)
              ? Effect.fail(exit.value.failure)
              : Effect.succeed(exit.value.success);
          }),
        );
      }),
    );
  }
}

/** A Live commit prepared from a Run still in setup. */
type LiveCommit = Readonly<{
  runId: string;
  liveAt: number;
  deadlineAt: number | null;
  presenceGraceUntil: number;
  aggregate: InterviewFinalizationAggregate;
  startupExpiresAt: number | null;
}>;

/** The host's retention of a detached owner. It rejects only when the owner fails. */
function retainOwner<Value>(owner: Fiber.Fiber<Value>): Promise<void> {
  return new Promise((resolve, reject) => {
    owner.addObserver((exit) =>
      Exit.isFailure(exit) ? reject(Cause.squash(exit.cause)) : resolve(),
    );
  });
}

/**
 * Bounds the complete readiness receipt by one original cutoff, including native body reads.
 * It runs in the caller's owner: interrupting that owner aborts the native delivery.
 */
export function deliverInterviewReadiness(
  input: Readonly<{
    runId: string;
    liveAt: number;
    expiresAt: number | null;
    deliver(request: Request, signal: AbortSignal): Promise<Response>;
  }>,
): Effect.Effect<ApplicationStartupDisposition | null, never> {
  return Effect.flatMap(Clock.currentTimeMillis, (requestedAt) =>
    callUntilDeadline({
      deadlineAt: Math.min(input.expiresAt ?? Infinity, requestedAt + 4_000),
      operation: async (signal) => {
        const response = await input.deliver(
          new Request(applicationCallbackUrl("readiness"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ runId: input.runId, liveAt: input.liveAt }),
            signal,
          }),
          signal,
        );
        // RPC clears the request signal. Own body cancellation locally as well, including
        // a response arriving after the deadline or an unread unsuccessful response.
        if (!response.ok) {
          await response.body?.cancel();
          return null;
        }
        const receipt = new Response(response.body?.pipeThrough(new TransformStream(), { signal }));
        const disposition = decodeApplicationStartupDisposition(await receipt.json());
        return disposition.runId === input.runId ? disposition : null;
      },
      onTransportFailure: () => new ReadinessDeliveryError(),
      onTimeout: () => new ReadinessDeliveryTimeout(),
    }).pipe(
      Effect.catchTags({
        ReadinessDeliveryError: () => Effect.succeed(null),
        ReadinessDeliveryTimeout: () => Effect.succeed(null),
      }),
    ),
  );
}

function requireSchedulableRuntimeDuration(value: number, now: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(now + value) ||
    !Number.isSafeInteger(now + browserPresenceGraceMs)
  ) {
    throw new Error("invalid_runtime_duration");
  }
  return value;
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord<Value>(value: Value): value is Value & Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
