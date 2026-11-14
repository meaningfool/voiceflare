import { projectInterviewFinalizationPublicState } from "./interviewFinalizationPublicProjection.ts";
import { enterConversationNode, type ConversationNodeExecution } from "./conversationNode.ts";
import { requireConversationState } from "./conversationContracts.ts";
import type { ExecutionBridge } from "./runtimeHostAssembly.ts";
import type { RuntimeImplementation, SelectedConversation } from "./implementationContracts.ts";
import { isConversationNativeReceipt, prepareConversationReceipt } from "./conversationObserve.ts";
import { runtimeToolCallRecordType } from "./toolCallRecord.ts";
import type {
  ConversationReceiptPrefix,
  InputClosureSettlement,
} from "./interviewFinalizationModel.ts";
import { Cause, Data, Effect, Exit, Fiber, Scheduler } from "effect";
import { microtaskBoundary, runtimeTranscriptDigest } from "./webPlatform.ts";
import { retainOwner } from "./runtimeHostAssembly.ts";

import type { RuntimeEndReason } from "../shared/runtimeControllerCallback.ts";
import { millisecondsUntil } from "../shared/deadline.ts";
import {
  advanceInterviewFinalization,
  describeInputClosure,
  type FinalizationConversationFacts,
} from "./interviewFinalizationFSM.ts";
import {
  completionFromAggregate,
  conversationNodeDeadline,
  readFinalizationTranscriptTurns,
  isFinishingNode,
  nodeLimitation,
  updateNodeDispatch,
  type FinalizationEffectOutcome,
  effectRevision,
  isSameJson,
  type FinalizationInput,
  type InterviewFinalizationAggregate,
  type ProviderObservationOrder,
  type RuntimeFinalizationCompletion,
  type RuntimePublicEvent,
} from "./interviewFinalizationModel.ts";
import {
  arbitrateInterviewRuntimeControllerWork,
  arbitrationWorkForObservation,
  finalizationObservationAt,
  type InterviewRuntimeControllerEntry,
  type InterviewRuntimeControllerWork,
} from "./interviewFinalizationArbitration.ts";
import {
  runInterviewFinalizationEffect,
  type FinalizationEffectCrashPoint,
  type FinalizationEffectRunnerResult,
} from "./interviewFinalizationEffectRunner.ts";
import {
  projectInterviewFinalizationExecution,
  type InterviewFinalizationExecutableEffect,
  type InterviewFinalizationExecution,
} from "./interviewFinalizationWorkProjection.ts";
import type {
  AggregatePersistenceOptions,
  RuntimeControllerRow,
} from "./interviewFinalizationRepository.ts";
import type {
  EndingOperation,
  ProviderObservationPersistence,
  SessionReleaseAnswer,
} from "./nativeContracts.ts";
import type { RuntimeDiagnosticOptions, RuntimeEventPayload } from "./runtimeEvents.ts";

const providerRecoveryDelayMs = 1_000;

export type InterviewFinalizationCoordinatorRepository = Readonly<{
  readState(): RuntimeControllerRow | null;
  requireState(runId?: string | null): RuntimeControllerRow;
  readAggregate(state?: RuntimeControllerRow): InterviewFinalizationAggregate;
  persistAggregate(
    aggregate: InterviewFinalizationAggregate,
    events: readonly RuntimePublicEvent[] | null,
    providerPersistence?: ProviderObservationPersistence,
    options?: AggregatePersistenceOptions,
  ): void;
  persistProviderObservation(input: ProviderObservationPersistence): void;
  clearExecutionWake(runId: string): void;
  markEffectSending(effectId: string): void;
  hasProviderEventIdentity(providerEventId: string): boolean;
}>;

/**
 * The selected execution's session, through which Ending dispatches its operations. `release`
 * dispatches the release when called; the returned Effect awaits its answer.
 */
export type InterviewFinalizationCoordinatorProvider = Readonly<{
  connected: boolean;
  connecting: boolean;
  feasible: boolean;
  ensureConnected(sessionId: string): void;
  sendFinalizationOperation(operation: EndingOperation): FinalizationEffectOutcome;
  /**
   * How the execution would settle an input closure it cannot carry out now, as when its
   * session is not connected: Runtime keeps it with the step's failure.
   */
  describeInputClosure?(
    operation: Extract<EndingOperation, { kind: "close_input" }>,
  ): InputClosureSettlement | undefined;
  release(sessionId: string | null, timeoutCapMs?: number): Effect.Effect<SessionReleaseAnswer>;
  drain(): Effect.Effect<void>;
  closeBarrier(accepted: ProviderObservationOrder | null): ProviderObservationOrder | null;
  sampleReceiptPrefix?(): ConversationReceiptPrefix;
}>;

export type InterviewFinalizationCoordinatorPublication = Readonly<{
  scheduleTerminal(
    work: Readonly<{
      completion: RuntimeFinalizationCompletion;
      observedAt: number;
    }>,
  ): void;
}>;

export type InterviewFinalizationCoordinatorEvents = Readonly<{
  recordEvent(eventName: string, payload?: RuntimeEventPayload): void;
  recordConversationDiagnostics?(
    declarations: import("./diagnosticContracts.ts").DiagnosticDeclarations,
    descriptions: readonly import("./diagnosticContracts.ts").DiagnosticDescription[],
  ): void;
  recordDiagnostic(
    type: string,
    payload?: RuntimeEventPayload,
    options?: RuntimeDiagnosticOptions,
  ): void;
  recordUniqueDiagnostic?(
    type: string,
    predicate: (payload: Record<string, unknown>) => boolean,
    payload?: RuntimeEventPayload,
  ): void;
}>;

/** The Run's declared storage: the synchronous repository and its physical alarm request. */
export type InterviewFinalizationStorage = Readonly<{
  repository: InterviewFinalizationCoordinatorRepository;
  /** Requests the alarm for the Run's next durable demand; an earlier future alarm is kept. */
  requestAlarm(at: number | null): Effect.Effect<void>;
}>;

/**
 * The node's durable dispatch claim did not complete, so native dispatch was not attempted. The
 * write may still have committed; recovery then treats the retained claim as uncertain.
 */
export class NodeDispatchClaimFailed extends Data.TaggedError("NodeDispatchClaimFailed")<{
  cause: unknown;
}> {}

/** Outside a request, a node claim that did not complete stays the defect its cause is. */
export function dieOnNodeDispatchClaimFailure<A, R>(
  operation: Effect.Effect<A, NodeDispatchClaimFailed, R>,
): Effect.Effect<A, never, R> {
  return operation.pipe(
    Effect.catchTag("NodeDispatchClaimFailed", ({ cause }) => Effect.die(cause)),
  );
}

/** Native node execution failed, or its entry refused the dispatch: the node's failure is admitted. */
class NodeExecutionFailed extends Data.TaggedError("NodeExecutionFailed")<{
  reason: string;
  responseId?: string | undefined;
}> {}

/**
 * Runs a coordinator step the way the Promise code it replaces ran. Once begun, it runs to
 * completion: a caller that is interrupted cannot stop it between a durable write and the work
 * that write commits to. It suspends only at real asynchronous steps; the run loop never yields
 * between its synchronous steps, so a read and the commit derived from it cannot be separated by
 * another fiber.
 */
function coordinatorStep<A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.uninterruptible(
    Effect.provideService(operation, Scheduler.PreventSchedulerYield, true),
  );
}

export type InterviewFinalizationObservationOptions = Readonly<{
  scopedAgent?: RuntimeImplementation;
  reportingAdmission?: import("./implementationContracts.ts").ConversationAdmission;
  deferEffectExecution?: boolean;
  deferNodeDispatch?: boolean;
  skipDeadlinePreflight?: boolean;
}>;

type FinalizationOperation = {
  exitCause: Cause.Cause<never> | null | undefined;
  claim: Readonly<{
    effect: InterviewFinalizationAggregate["state"]["effects"][number];
    runId: string;
    generation: number;
    claimed: boolean;
  }> | null;
};

/** A coordinator operation's outcome for its observation. */
export type InterviewFinalizationDecision = Readonly<{
  accepted: boolean;
  transcriptChanged: boolean;
}>;

const notAccepted: InterviewFinalizationDecision = { accepted: false, transcriptChanged: false };

export class InterviewFinalizationCoordinator {
  readonly #execution: Pick<ExecutionBridge, "enter"> | undefined;
  readonly #selectedAgent: (() => SelectedConversation | undefined) | undefined;
  readonly #storage: InterviewFinalizationStorage;
  readonly #repository: InterviewFinalizationCoordinatorRepository;
  readonly #provider: InterviewFinalizationCoordinatorProvider;
  readonly #publication: InterviewFinalizationCoordinatorPublication;
  readonly #events: InterviewFinalizationCoordinatorEvents;
  readonly #now: () => number;
  readonly #effectCrashInjector:
    | ((
        point: FinalizationEffectCrashPoint,
        effect: InterviewFinalizationAggregate["state"]["effects"][number],
      ) => void)
    | undefined;
  readonly #background: (task: Promise<void>) => void;
  readonly #nodeNative:
    | Readonly<{
        enterNode(
          input: Omit<import("./implementationContracts.ts").NodeDispatchInput, "reporter">,
          admission: import("./implementationContracts.ts").ConversationAdmission,
        ): void;
        containNode(): void;
      }>
    | undefined;
  #operation: FinalizationOperation | null = null;

  constructor(
    input: Readonly<{
      execution?: Pick<ExecutionBridge, "enter">;
      /** Resolves from the Run's accepted selection; undefined when the Run has none. */
      selectedAgent?: () => SelectedConversation | undefined;
      storage: InterviewFinalizationStorage;
      provider: InterviewFinalizationCoordinatorProvider;
      publication: InterviewFinalizationCoordinatorPublication;
      events: InterviewFinalizationCoordinatorEvents;
      /** The Run clock's synchronous read, for steps that write storage synchronously. */
      now: () => number;
      background: (task: Promise<void>) => void;
      nodeNative?: Readonly<{
        enterNode(
          input: Omit<import("./implementationContracts.ts").NodeDispatchInput, "reporter">,
          admission: import("./implementationContracts.ts").ConversationAdmission,
        ): void;
        containNode(): void;
      }>;
      effectCrashInjector?:
        | ((
            point: FinalizationEffectCrashPoint,
            effect: InterviewFinalizationAggregate["state"]["effects"][number],
          ) => void)
        | undefined;
    }>,
  ) {
    this.#execution = input.execution;
    this.#nodeNative = input.nodeNative;
    this.#selectedAgent = input.selectedAgent;
    this.#storage = input.storage;
    this.#repository = input.storage.repository;
    this.#provider = input.provider;
    this.#publication = input.publication;
    this.#events = input.events;
    this.#now = input.now;
    this.#effectCrashInjector = input.effectCrashInjector;
    this.#background = input.background;
  }

  reconsiderEvidence(
    at: number,
  ): Effect.Effect<InterviewFinalizationDecision, NodeDispatchClaimFailed> {
    return coordinatorStep(
      Effect.suspend(() => {
        const state = this.#repository.readState();
        if (state === null || !hasAuthoritativeFinalization(state))
          return Effect.succeed(notAccepted);
        const aggregate = this.#repository.readAggregate(state);
        if (!this.#projectExecution(state, aggregate, at).evidenceReconsiderationRequested)
          return Effect.succeed(notAccepted);
        return this.#acceptObservation({ kind: "evidence_prefix_processed", at }, undefined, {
          deferEffectExecution: true,
          skipDeadlinePreflight: true,
        });
      }),
    );
  }

  retainReconstructedNodeEvidence(): void {
    const state = this.#repository.readState();
    if (state?.phase !== "live" || !hasAuthoritativeFinalization(state)) return;
    const aggregate = this.#repository.readAggregate(state);
    if (
      aggregate.conversationNodeExecution === undefined ||
      !this.#projectExecution(state, aggregate, this.#now()).reconstructionRequiresDisconnect
    )
      return;
    const timing = aggregate.conversationNodeExecution;
    if (timing.kind === "ordinary") {
      const timer = timing.timers.find((timer) => timer.deadlineAt <= this.#now());
      const selected = this.#selectedAgent?.();
      const visit = aggregate.conversationVisit;
      if (
        timer === undefined ||
        selected === undefined ||
        visit === undefined ||
        selected.agent.runtimeTransition(visit.state, timer.event, visit.context).terminal
      )
        return;
    }
    const proof = aggregate.applicationTranscriptProof;
    const decision = this.#advance(aggregate, {
      kind: "conversation_evidence_observed",
      snapshot:
        proof === undefined
          ? aggregate
          : { ...aggregate, applicationTranscriptProof: { ...proof, evidenceGap: true } },
      usageEvidence: [{ status: "uncertain" }],
      effects: [],
      notification: "none",
      at: this.#now(),
    });
    // Persist loss before overdue recovery can enter Ending or freeze a result.
    this.#persistAggregate(decision.aggregate, decision.events);
  }

  initializeRestoredState(): void {
    const state = this.#repository.readState();
    if (state === null || !hasAuthoritativeFinalization(state)) return;
    const aggregate = this.#repository.readAggregate(state);
    this.#recordFinalizedDiagnostics(aggregate);
    const interruptedProviderEffects = aggregate.state.effects.filter(
      ({ kind, status }) => status === "sending" && isProviderCommandEffect(kind),
    );
    const recovery = this.#advance(aggregate, {
      kind: "interrupted_effects_recovered",
    });
    if (recovery.aggregate !== aggregate) {
      this.#persistAggregate(recovery.aggregate, recovery.events);
    }
    for (const effect of interruptedProviderEffects) {
      this.#events.recordDiagnostic("runtime.provider_command_interrupted", {
        source: "runtime_controller",
        effectId: effect.id,
        effectKind: effect.kind,
        status: "uncertain",
        interruptionPoint: "after_dispatch_claim_before_outcome",
        sessionId: state.session_id ?? undefined,
      });
    }
    this.#reconcileReconstructedProvider(recovery.aggregate);
  }

  recoverNodeExecution(): Effect.Effect<void, NodeDispatchClaimFailed> {
    const self = this;
    return coordinatorStep(
      Effect.gen(function* () {
        const state = self.#repository.readState();
        if (state === null || !hasAuthoritativeFinalization(state)) return;
        const aggregate = self.#repository.readAggregate(state);
        const node = aggregate.conversationNodeExecution;
        const dispatch = node?.dispatch;
        const participantEnd = isFinishingNode(node) ? node.participantEnd : undefined;
        if (state.phase === "live" && participantEnd !== undefined) {
          yield* self.#acceptObservation(
            {
              kind: "end_requested",
              reason: "participant_stopped",
              source: participantEnd.source,
              at: participantEnd.at,
            },
            undefined,
            { skipDeadlinePreflight: true },
          );
          return;
        }
        if (
          !self.#projectExecution(state, aggregate, self.#now()).nodeExecution.active ||
          dispatch === undefined ||
          node === undefined
        )
          return;
        if (node.kind === "retained_output") {
          const deadlineAt = conversationNodeDeadline(node);
          if (deadlineAt === null) throw new Error("conversation_finishing_deadline_missing");
          if (self.#now() >= deadlineAt) yield* self.#finishNode(undefined, self.#now());
          else yield* self.#dispatchNode();
          yield* self.#requestWakeUp();
          return;
        }
        if (dispatch.status === "pending") {
          const deadlineAt = conversationNodeDeadline(node);
          if (deadlineAt !== null && self.#now() >= deadlineAt)
            yield* self.#expireNode(node, self.#now());
          else yield* self.#dispatchNode();
        } else if (
          dispatch.status === "claimed" ||
          dispatch.status === "dispatched" ||
          dispatch.status === "uncertain"
        ) {
          yield* self.#finishNode("closing_recovery_uncertain", self.#now());
        }
      }),
    );
  }

  /**
   * Dispatches the current node now. Validation, the durable claim and the native entry run in
   * this synchronous call, before it returns; they are never deferred to the returned Effect. The
   * Effect starts the dispatch's follow-up, if any, in its own detached owner, or fails when the
   * claim did not complete.
   */
  #dispatchNode(): Effect.Effect<void, NodeDispatchClaimFailed> {
    const self = this;
    const state = this.#repository.readState();
    if (state === null || !hasAuthoritativeFinalization(state)) return Effect.void;
    const aggregate = this.#repository.readAggregate(state);
    const timing = aggregate.conversationNodeExecution;
    const dispatch = timing?.dispatch;
    const visit = aggregate.conversationVisit;
    if (
      !this.#projectExecution(state, aggregate, this.#now()).nodeExecution.active ||
      timing === undefined ||
      dispatch === undefined ||
      (dispatch.status !== "pending" &&
        !(timing.kind === "retained_output" && dispatch.status === "dispatched"))
    )
      return Effect.void;
    // The current visit owns the dispatched state and its visit/operation identity.
    if (visit === undefined) throw new Error("conversation_node_execution_invalid");
    const deadlineAt = conversationNodeDeadline(timing);
    if (deadlineAt !== null && this.#now() >= deadlineAt)
      return this.#detach(Effect.suspend(() => this.#expireNode(timing, this.#now())));
    const selected = this.#selectedAgent?.();
    if (
      selected === undefined ||
      (timing.kind !== "retained_output" && this.#nodeNative === undefined)
    )
      throw new Error("conversation_node_execution_unavailable");
    if (requireConversationState(selected.agent.conversation, visit.state) === null)
      throw new Error("conversation_node_execution_invalid");
    let input: import("./conversationContracts.ts").ConversationCallbackJson;
    try {
      // The stored input must equal the Conversation's own selection for the current visit, so
      // the typed selection is dispatched; the handoff detaches one copy for execution.
      const expected = selected.accepted.selectInput(visit.state, {
        runId: state.run_id,
        context: visit.context,
      });
      if (!isSameJson(dispatch.input, expected))
        throw new Error("conversation_node_input_mismatch");
      input = structuredClone(expected);
    } catch {
      return this.#detach(
        Effect.suspend(() => this.#finishNode("conversation_node_input_invalid", this.#now())),
      );
    }
    if (timing.kind !== "retained_output" && !this.#provider.connected) {
      if (state.session_id !== null && !this.#provider.connecting)
        this.#provider.ensureConnected(state.session_id);
      return Effect.void;
    }
    const identity = {
      runId: aggregate.runId,
      visitId: visit.visitId,
      operationId: visit.operationId,
      generation: state.session_generation,
    };
    const current = () => {
      const row = this.#repository.readState();
      if (row?.phase !== "live" || row.session_generation !== identity.generation) return false;
      const currentAggregate = this.#repository.readAggregate(row);
      const currentVisit = currentAggregate.conversationVisit;
      const status = currentAggregate.conversationNodeExecution?.dispatch?.status;
      return (
        (status === "claimed" || status === "dispatched") &&
        currentVisit?.visitId === identity.visitId &&
        currentVisit.operationId === identity.operationId
      );
    };
    const admission = selected.agent.bindVisit(visit.state, identity, current, visit.context);
    // Durable claim is committed before the selected native owner observes the command.
    if (timing.kind !== "retained_output") {
      try {
        this.#persistAggregate(
          {
            ...aggregate,
            conversationNodeExecution: {
              ...timing,
              dispatch: updateNodeDispatch(dispatch, { status: "claimed" }),
            },
          },
          [],
        );
      } catch (cause) {
        return Effect.fail(new NodeDispatchClaimFailed({ cause }));
      }
    }
    const admitFailure = ({ reason, responseId }: NodeExecutionFailed) =>
      Effect.suspend(() =>
        current()
          ? deadlineAt !== null && this.#now() >= deadlineAt
            ? this.#expireNode(timing, this.#now())
            : this.#finishNode(
                reason === "goodbye_interrupted"
                  ? "closing_interrupted"
                  : reason === "goodbye_deadline_exceeded"
                    ? "closing_cutoff_exhausted"
                    : reason,
                this.#now(),
                responseId,
                !["goodbye_interrupted", "goodbye_deadline_exceeded"].includes(reason),
              )
          : Effect.void,
      );
    // The dispatch's follow-up: a node failure it reports is admitted as that node's failure.
    const followUp = (
      outcome: Effect.Effect<void, NodeExecutionFailed | NodeDispatchClaimFailed>,
    ) => this.#detach(outcome.pipe(Effect.catchTag("NodeExecutionFailed", admitFailure)));
    // No asynchronous step separates the snapshot read from the latest state and its acceptance,
    // so no other write can land between that read and the commit that replaces it.
    const admitCompletion = (report: import("./executionContracts.ts").SemanticReport<unknown>) =>
      Effect.gen(function* () {
        if (!current()) return;
        const receivedAt = self.#now();
        if (deadlineAt !== null && receivedAt >= deadlineAt) {
          yield* self.#expireNode(timing, receivedAt);
          return;
        }
        const admitted = admission.admit(report);
        if (admitted === null) return;
        const { transition } = admitted;
        if (transition.target === null) return;
        const row = self.#repository.requireState();
        const latest = self.#repository.readAggregate(row);
        if (
          !current() ||
          latest.conversationVisit === undefined ||
          latest.conversationNodeExecution === undefined
        )
          return;
        let snapshot: InterviewFinalizationAggregate;
        if (!transition.terminal) {
          snapshot = enterConversationNode(
            latest,
            selected.agent,
            selected.accepted,
            transition.target,
            { reason: "agent_requested_end", at: receivedAt, context: transition.context },
          );
        } else {
          snapshot = {
            ...latest,
            conversationVisit: { ...latest.conversationVisit, state: transition.target },
            conversationNodeExecution: {
              ...latest.conversationNodeExecution,
              dispatch: updateNodeDispatch(dispatch, { status: "complete" }),
            },
          };
          if (timing.kind === "finishing") {
            const response = admitted.responseId;
            if (typeof response !== "string")
              throw new Error("conversation_completion_evidence_missing");
            snapshot = {
              ...snapshot,
              providerResponses: latest.providerResponses.map((entry) =>
                entry.responseId === response ? { ...entry, conversationScope: identity } : entry,
              ),
              gracefulCompletion: {
                callId: null,
                responseId: response,
                itemId: null,
                responseSettlement: "completed",
                outputAudioSettlement: "stopped",
                participantMediaSafetyOverride: false,
                executionIdentity: identity,
              },
            };
          }
        }
        yield* self.#acceptObservation(
          {
            kind: "conversation_evidence_observed",
            snapshot,
            usageEvidence: [],
            effects: [],
            at: self.#now(),
            notification: transition.terminal ? "completion" : "none",
          },
          undefined,
          { skipDeadlinePreflight: true },
        );
        self.#events.recordConversationDiagnostics?.(
          selected.agent.conversation.diagnostics ?? {},
          transition.diagnostics,
        );
      });
    const reservation = isFinishingNode(timing) ? timing.reservation : undefined;
    try {
      let nodeInput: Omit<import("./implementationContracts.ts").NodeDispatchInput, "reporter"> = {
        state: visit.state,
        input,
        identity,
        deadlineAt,
        clock: () => this.#now(),
        triggeringReplyId: reservation?.triggeringResponseId ?? dispatch.triggeringResponseId,
        triggeringReplySettled: aggregate.providerResponses.some(
          (response) =>
            response.responseId ===
              (reservation?.triggeringResponseId ?? dispatch.triggeringResponseId) &&
            response.status !== "active" &&
            response.status !== "unobserved",
        ),
        triggeringToolCallId: reservation?.toolCallId ?? dispatch.toolCallId,
        observeOutputIdentity: (responseId, originatingResponseId) => {
          const row = this.#repository.readState();
          if (row === null || !hasAuthoritativeFinalization(row)) return;
          const latest = this.#repository.readAggregate(row);
          const execution = this.#projectExecution(row, latest, this.#now());
          if (!execution.nodeExecution.active && !execution.evidenceReconsiderationRequested)
            return;
          const existing = latest.providerResponses.find(
            (response) => response.responseId === responseId,
          );
          // Issued output keeps its original evidence attribution after control is revoked.
          // A prior receipt's attribution, including an explicitly unknown scope, is immutable.
          if (existing?.conversationScope !== undefined) return;
          const outputIdentity =
            originatingResponseId === undefined
              ? identity
              : (latest.providerResponses.find(
                  (response) => response.responseId === originatingResponseId,
                )?.conversationScope ?? null);
          let observed: InterviewFinalizationAggregate = {
            ...latest,
            providerResponses:
              existing === undefined
                ? [
                    ...latest.providerResponses,
                    {
                      responseId,
                      status: "unobserved",
                      outputAudio: "pending",
                      conversationScope: outputIdentity,
                    },
                  ]
                : latest.providerResponses.map((response) =>
                    response.responseId === responseId
                      ? { ...response, conversationScope: outputIdentity }
                      : response,
                  ),
          };
          if (originatingResponseId === undefined && reservation !== undefined && current())
            observed = { ...observed, retainedInterviewerResponseId: responseId };
          this.#persistAggregate(observed, []);
        },
        settleInputClosure: (itemId, expectedUsage = []) => {
          if (!current()) return;
          const row = this.#repository.requireState();
          const latest = this.#repository.readAggregate(row);
          const finalInput = latest.finalInput;
          if (finalInput === null) return;
          const captured =
            itemId !== null &&
            latest.applicationTranscriptProof.obligations.some(
              (item) => item.itemId === itemId && item.status !== "pending",
            );
          let closed = latest;
          if (
            itemId !== null &&
            !latest.applicationTranscriptProof.obligations.some((item) => item.itemId === itemId)
          )
            closed = {
              ...latest,
              applicationTranscriptProof: {
                ...latest.applicationTranscriptProof,
                obligations: [
                  ...latest.applicationTranscriptProof.obligations,
                  { itemId, role: "participant", status: "pending" },
                ],
              },
            };
          const decision = this.#advance(latest, {
            kind: "conversation_evidence_observed",
            snapshot: {
              ...closed,
              finalInput:
                itemId === null || captured
                  ? {
                      ...finalInput,
                      admittedItemId: itemId,
                      obligation: "settled",
                      inputToSettle: false,
                    }
                  : {
                      ...finalInput,
                      admittedItemId: itemId,
                      obligation: "awaiting_transcription",
                      inputToSettle: false,
                    },
            },
            usageEvidence: expectedUsage,
            effects: [],
            notification: "none",
            at: this.#now(),
          });
          this.#persistAggregate(decision.aggregate, decision.events);
        },
        claimInputClosure: () => {
          if (!current()) return null;
          const row = this.#repository.requireState();
          const latest = this.#repository.readAggregate(row);
          const commandId = latest.finalInput?.effectId;
          const effect = latest.state.effects.find((effect) => effect.id === commandId);
          if (effect?.status !== "pending") return null;
          this.#repository.markEffectSending(effect.id);
          return effect.id;
        },
        reportInputClosure: (commandId, outcome) => {
          this.#background(
            this.#runNativeCallback(
              this.#acceptObservation(
                { kind: "effect_outcome", effectId: commandId, outcome, at: this.#now() },
                undefined,
                { skipDeadlinePreflight: true },
              ).pipe(Effect.asVoid),
            ),
          );
        },
        onFailure: (reason, responseId) =>
          this.#runNativeCallback(admitFailure(new NodeExecutionFailed({ reason, responseId }))),
        onComplete: (report) => this.#runNativeCallback(admitCompletion(report)),
      };
      if (aggregate.finalInput !== null)
        nodeInput = {
          ...nodeInput,
          inputClosure: {
            admittedItemId: aggregate.finalInput.admittedItemId,
            obligation: aggregate.finalInput.obligation,
          },
        };
      if (timing.kind === "retained_output") {
        const bound = admission;
        if (bound.reporting.kind !== "retained_output")
          throw new Error("conversation_retained_output_owner_unavailable");
        const proof = aggregate.gracefulCompletion;
        if (proof === null) return Effect.void;
        const outcome = bound.reporting.observe(
          Object.freeze({
            responseSettlement: proof.responseSettlement,
            outputAudioSettlement: proof.outputAudioSettlement,
            cleanupClaimed: timing.cleanup.status === "claimed",
          }),
        );
        if (outcome.kind === "report") return followUp(admitCompletion(outcome.report));
        if (outcome.kind === "failed")
          return followUp(Effect.fail(new NodeExecutionFailed({ reason: outcome.reason })));
      } else {
        if (this.#nodeNative === undefined)
          throw new Error("conversation_node_execution_unavailable");
        this.#nodeNative.enterNode(nodeInput, admission);
      }
    } catch (error) {
      return followUp(
        Effect.fail(
          new NodeExecutionFailed({
            reason: error instanceof Error ? error.message : "node_dispatch_failed",
          }),
        ),
      );
    }
    return Effect.void;
  }

  #expireNode(
    timing: ConversationNodeExecution,
    at: number,
  ): Effect.Effect<void, NodeDispatchClaimFailed> {
    if (isFinishingNode(timing)) return this.#finishNode("closing_cutoff_exhausted", at);
    return this.#acceptObservation(
      { kind: "deadline_reached", deadline: "timebox", at },
      undefined,
      { skipDeadlinePreflight: true },
    ).pipe(Effect.asVoid);
  }

  #finishNode(
    limitation: string | undefined,
    at: number,
    responseId?: string,
    operationalFailure = false,
  ): Effect.Effect<void, NodeDispatchClaimFailed> {
    const self = this;
    return Effect.gen(function* () {
      const state = self.#repository.readState();
      if (state?.phase !== "live" || !hasAuthoritativeFinalization(state)) return;
      const aggregate = self.#repository.readAggregate(state);
      const timing = aggregate.conversationNodeExecution;
      if (timing === undefined || timing.dispatch === undefined) return;
      if (timing.kind === "ordinary") {
        self.#persistAggregate(
          {
            ...aggregate,
            conversationNodeExecution: {
              ...timing,
              dispatch: updateNodeDispatch(timing.dispatch, {
                status: "failed",
                limitation: limitation ?? "conversation_node_failed",
              }),
            },
          },
          [],
        );
        self.#nodeNative?.containNode();
        yield* self.#acceptObservation(
          { kind: "runtime_failure_observed", source: "conversation_native_failure", at },
          undefined,
          { skipDeadlinePreflight: true },
        );
        return;
      }
      let next = aggregate;
      const completion = self.#selectedAgent?.()?.agent.conversation.terminalRoles.completion;
      if (
        aggregate.conversationVisit !== undefined &&
        !operationalFailure &&
        completion !== undefined
      )
        next = {
          ...next,
          conversationVisit: { ...aggregate.conversationVisit, state: completion },
        };
      if (timing.kind === "retained_output")
        next = {
          ...next,
          conversationNodeExecution: {
            ...timing,
            dispatch: updateNodeDispatch(timing.dispatch, { status: "complete" }),
          },
        };
      if (limitation !== undefined) {
        next = {
          ...next,
          conversationNodeExecution: {
            ...timing,
            dispatch: updateNodeDispatch(timing.dispatch, { status: "failed", limitation }),
          },
        };
        // Lost native continuity is an evidence gap. A known closing failure is
        // recorded separately and does not make fully captured text incomplete.
        if (limitation === "closing_recovery_uncertain")
          next = {
            ...next,
            applicationTranscriptProof: {
              ...aggregate.applicationTranscriptProof,
              evidenceGap: true,
            },
          };
      }
      const visit = aggregate.conversationVisit;
      if (responseId !== undefined && visit !== undefined) {
        const identity = {
          runId: aggregate.runId,
          visitId: visit.visitId,
          operationId: visit.operationId,
          generation: aggregate.providerGeneration,
        };
        next = {
          ...next,
          retainedInterviewerResponseId: responseId,
          providerResponses: next.providerResponses.some(
            (response) => response.responseId === responseId,
          )
            ? next.providerResponses.map((response) =>
                response.responseId === responseId
                  ? { ...response, conversationScope: identity }
                  : response,
              )
            : [
                ...next.providerResponses,
                {
                  responseId,
                  status: "unobserved",
                  outputAudio: "pending",
                  conversationScope: identity,
                },
              ],
        };
      }
      self.#persistAggregate(next, []);
      if (limitation !== undefined) self.#nodeNative?.containNode();
      yield* self.#acceptObservation(
        operationalFailure
          ? { kind: "runtime_failure_observed", source: "conversation_native_failure", at }
          : {
              kind: "end_requested",
              reason: timing.reservation.reason,
              source: timing.reservation.source,
              at,
            },
        undefined,
        { skipDeadlinePreflight: true },
      );
    });
  }

  projectExecution(now = this.#now()): InterviewFinalizationExecution | null {
    const state = this.#repository.readState();
    if (state === null || !hasAuthoritativeFinalization(state)) return null;
    return this.#projectExecution(state, this.#repository.readAggregate(state), now);
  }

  requiresProviderConnection(now = this.#now()): boolean {
    return this.projectExecution(now)?.providerConnection.required ?? false;
  }

  acceptObservation(
    observation: FinalizationInput,
    providerPersistence?: ProviderObservationPersistence,
    options: InterviewFinalizationObservationOptions = {},
  ): Effect.Effect<InterviewFinalizationDecision, NodeDispatchClaimFailed> {
    return coordinatorStep(this.#acceptObservation(observation, providerPersistence, options));
  }

  #acceptObservation(
    observation: FinalizationInput,
    providerPersistence?: ProviderObservationPersistence,
    options: InterviewFinalizationObservationOptions = {},
  ): Effect.Effect<InterviewFinalizationDecision, NodeDispatchClaimFailed> {
    const self = this;
    return Effect.gen(function* () {
      if (observation.kind === "end_requested" && observation.reason === "participant_stopped")
        self.#nodeNative?.containNode();
      let acceptedObservation = observation;
      const observationAt = finalizationObservationAt(acceptedObservation, self.#now());
      let appliedDeadline = false;
      if (
        acceptedObservation.kind !== "deadline_reached" &&
        options.skipDeadlinePreflight !== true
      ) {
        const state = self.#repository.readState();
        const aggregate =
          state !== null && hasAuthoritativeFinalization(state)
            ? self.#repository.readAggregate(state)
            : null;
        const hangupEffectId = aggregate?.state.effects.find(
          ({ kind }) => kind === "release_session",
        )?.id;
        const incoming =
          hangupEffectId === undefined
            ? arbitrationWorkForObservation(acceptedObservation)
            : arbitrationWorkForObservation(acceptedObservation, {
                hangupEffectId,
              });
        appliedDeadline = yield* self.#applyOverdueWorkBeforeIncoming(
          incoming.entry,
          incoming.work,
          aggregate?.conversationNodeExecution === undefined
            ? observationAt
            : Math.max(observationAt, self.#now()),
        );
        // The decision follows the preflight across a microtask boundary, as it did when the
        // preflight was awaited: native receipts that arrive meanwhile are in its fresh sample.
        yield* microtaskBoundary;
      }

      const state = self.#repository.requireState();
      if (!hasAuthoritativeFinalization(state)) return notAccepted;
      let aggregate = self.#repository.readAggregate(state);
      // Original's bounded Live cleanup can close the native session before its finishing
      // receipts arrive. Only an actually attempted cleanup command can explain that normal
      // closure: the session reporting its closure after that release began ends the Run with
      // the reserved reason (`acceptSessionReleased` for a session that ended without one); the
      // execution reports any other loss of its session as a failure.
      const retainedOutput =
        aggregate.conversationNodeExecution?.kind === "retained_output"
          ? aggregate.conversationNodeExecution
          : undefined;
      const claimedCleanup =
        retainedOutput?.cleanup.status === "claimed" ? retainedOutput.cleanup : undefined;
      const cleanup = aggregate.state.effects.find(
        (effect) => effect.id === claimedCleanup?.effectId,
      );
      const expectedCleanupClose =
        state.phase === "live" &&
        retainedOutput !== undefined &&
        claimedCleanup !== undefined &&
        cleanup?.kind === "release_session" &&
        (cleanup.status === "sending" || cleanup.status === "dispatched") &&
        acceptedObservation.kind === "session_closed_observed" &&
        acceptedObservation.generation === aggregate.providerGeneration;
      if (expectedCleanupClose) {
        const reservation = retainedOutput.reservation;
        yield* self.#acceptObservation(
          {
            kind: "end_requested",
            reason: reservation.reason,
            source: reservation.source,
            at: self.#now(),
          },
          undefined,
          { skipDeadlinePreflight: true, deferEffectExecution: true },
        );
        return yield* self.#acceptObservation(acceptedObservation, providerPersistence, {
          ...options,
          skipDeadlinePreflight: true,
        });
      }
      if (
        state.phase === "live" &&
        (acceptedObservation.kind === "end_requested" ||
          acceptedObservation.kind === "runtime_failure_observed")
      )
        acceptedObservation = { ...acceptedObservation, at: self.#now() };
      // A node that completed and waits for its last reply to play has already reached the
      // Conversation's completion: a Stop then only cuts that reply and begins Ending.
      const waitingNode = aggregate.conversationNodeExecution;
      if (
        state.phase === "live" &&
        acceptedObservation.kind === "end_requested" &&
        acceptedObservation.reason === "participant_stopped" &&
        aggregate.conversationVisit !== undefined &&
        !(isFinishingNode(waitingNode) && waitingNode.endingAt !== undefined)
      ) {
        const selected = self.#selectedAgent?.();
        if (selected?.agent.conversation.runtimeEvent !== undefined) {
          const transition = selected.agent.runtimeTransition(
            aggregate.conversationVisit.state,
            {
              kind: "participant_stopped",
            },
            aggregate.conversationVisit.context,
          );
          if (transition.target !== null && transition.terminal)
            self.#events.recordConversationDiagnostics?.(
              selected.agent.conversation.diagnostics ?? {},
              transition.diagnostics,
            );
        }
      }
      if (
        state.phase === "live" &&
        aggregate.conversationNodeExecution?.dispatch !== undefined &&
        aggregate.conversationNodeExecution.dispatch.status !== "complete" &&
        (acceptedObservation.kind === "end_requested" ||
          acceptedObservation.kind === "runtime_failure_observed" ||
          (acceptedObservation.kind === "deadline_reached" &&
            acceptedObservation.deadline === "presence_grace"))
      ) {
        self.#nodeNative?.containNode();
        const timing = aggregate.conversationNodeExecution;
        const limitation = nodeLimitation(timing);
        const dispatch = timing.dispatch;
        if (dispatch !== undefined) {
          aggregate = {
            ...aggregate,
            conversationNodeExecution: {
              ...timing,
              dispatch:
                timing.kind === "retained_output" && limitation === undefined
                  ? updateNodeDispatch(dispatch, { status: "complete" })
                  : updateNodeDispatch(dispatch, {
                      status: "failed",
                      limitation:
                        timing.kind === "finishing"
                          ? (limitation ?? "closing_interrupted")
                          : limitation,
                    }),
            },
          };
        }
        self.#persistAggregate(aggregate, []);
      }
      if (
        providerPersistence?.providerEventId !== undefined &&
        self.#repository.hasProviderEventIdentity(providerPersistence.providerEventId)
      ) {
        self.#repository.persistProviderObservation(providerPersistence);
        yield* self.#finishAppliedDeadline(appliedDeadline, options);
        return notAccepted;
      }

      if (
        state.phase === "live" &&
        acceptedObservation.kind === "deadline_reached" &&
        acceptedObservation.deadline === "provider_close" &&
        aggregate.conversationNodeExecution?.kind === "retained_output" &&
        aggregate.conversationNodeExecution.cleanup.status === "scheduled"
      ) {
        const commandId = `${aggregate.runId}:${aggregate.nextEffectSequence}`;
        const node = aggregate.conversationNodeExecution;
        self.#persistAggregate(
          {
            ...aggregate,
            nextEffectSequence: aggregate.nextEffectSequence + 1,
            conversationNodeExecution: {
              ...node,
              cleanup: { status: "claimed", at: node.cleanup.at, effectId: commandId },
            },
            state: {
              ...aggregate.state,
              effects: [
                ...aggregate.state.effects,
                {
                  id: commandId,
                  kind: "release_session",
                  status: "pending",
                  acceptance: "unobserved",
                  attemptCount: 0,
                },
              ],
            },
          },
          [],
        );
        if (options.deferEffectExecution !== true && self.#operation === null)
          yield* self.executeSelectedRuntimeWork();
        yield* self.#requestWakeUp();
        return { accepted: true, transcriptChanged: false };
      }
      if (
        state.phase === "live" &&
        acceptedObservation.kind === "deadline_reached" &&
        acceptedObservation.deadline === "browser_media_ready"
      )
        self.#events.recordEvent("runtime.browser_media_ready_timeout", {
          source: "browser_media_ready_timeout",
          deadlineAt: acceptedObservation.at,
        });
      if (
        state.phase === "live" &&
        acceptedObservation.kind === "deadline_reached" &&
        acceptedObservation.deadline === "timebox" &&
        aggregate.conversationNodeExecution !== undefined
      ) {
        const timing = aggregate.conversationNodeExecution;
        // A node that completed normally has waited for its last reply to play: the end it
        // reserved now begins. No business timer applies once the reply was delivered.
        if (isFinishingNode(timing) && timing.endingAt !== undefined)
          return yield* self.#acceptObservation(
            {
              kind: "end_requested",
              reason: timing.reservation.reason,
              source: timing.reservation.source,
              at: acceptedObservation.at,
            },
            undefined,
            { ...options, skipDeadlinePreflight: true },
          );
        const selected = self.#selectedAgent?.();
        const visit = aggregate.conversationVisit;
        if (selected === undefined || visit === undefined)
          throw new Error("conversation_timer_unavailable");
        const timer = timing.timers
          .filter((timer) => timer.deadlineAt <= acceptedObservation.at)
          .sort((a, b) => a.deadlineAt - b.deadlineAt)[0];
        if (timer === undefined) return notAccepted;
        const transition = selected.agent.runtimeTransition(
          visit.state,
          timer.event,
          visit.context,
        );
        if (transition.target === null) return notAccepted;
        if (transition.terminal) {
          if (timing.kind !== "ordinary") {
            yield* self.#finishNode(
              timing.kind === "retained_output" ? undefined : "closing_cutoff_exhausted",
              acceptedObservation.at,
            );
          } else {
            const snapshot = {
              ...aggregate,
              conversationVisit: { ...visit, state: transition.target },
              conversationNodeExecution:
                timing.dispatch === undefined
                  ? timing
                  : {
                      ...timing,
                      dispatch: updateNodeDispatch(timing.dispatch, {
                        status: "failed",
                        limitation: nodeLimitation(timing),
                      }),
                    },
            };
            self.#persistAggregate(snapshot, []);
            yield* self.#acceptObservation(
              {
                kind: "end_requested",
                reason: "timebox_reached",
                source: "timebox_alarm",
                at: acceptedObservation.at,
              },
              undefined,
              { skipDeadlinePreflight: true },
            );
          }
        } else {
          const next = enterConversationNode(
            aggregate,
            selected.agent,
            selected.accepted,
            transition.target,
            { reason: "timebox_reached", at: acceptedObservation.at, context: transition.context },
          );
          self.#persistAggregate(next, []);
          if (options.deferNodeDispatch !== true) yield* self.#dispatchNode();
        }
        self.#events.recordConversationDiagnostics?.(
          selected.agent.conversation.diagnostics ?? {},
          transition.diagnostics,
        );
        yield* self.#requestWakeUp();
        return { accepted: true, transcriptChanged: false };
      }
      const selected = isConversationNativeReceipt(acceptedObservation)
        ? self.#selectedAgent?.()
        : undefined;
      const participantInput =
        acceptedObservation.kind === "participant_answer_created" ||
        acceptedObservation.kind === "participant_answer_transcribed" ||
        acceptedObservation.kind === "participant_answer_transcription_failed" ||
        (acceptedObservation.kind === "transcript_item_observed" &&
          acceptedObservation.role === "participant");
      const knownParticipantItem =
        "itemId" in acceptedObservation &&
        (aggregate.applicationTranscriptProof.obligations.some(
          (item) => item.itemId === acceptedObservation.itemId && item.role === "participant",
        ) ||
          aggregate.transcriptCapture.items.some(
            (item) => item.itemId === acceptedObservation.itemId && item.role === "participant",
          ));
      const excludedParticipantInput =
        participantInput &&
        providerPersistence?.excludedParticipantInput === true &&
        "generation" in acceptedObservation &&
        acceptedObservation.generation === state.session_generation &&
        (isFinishingNode(aggregate.conversationNodeExecution) ||
          (knownParticipantItem && acceptedObservation.kind === "participant_answer_created")) &&
        (!knownParticipantItem || acceptedObservation.kind === "participant_answer_created");
      const handoff =
        isConversationNativeReceipt(acceptedObservation) && !excludedParticipantInput
          ? prepareConversationReceipt(
              aggregate,
              acceptedObservation,
              options.scopedAgent ?? selected?.agent,
              selected,
              options.reportingAdmission,
              self.#now(),
            )
          : acceptedObservation;
      const decision = self.#advance(aggregate, handoff, {
        receiptPrefix: self.#provider.sampleReceiptPrefix?.(),
        usageEvidenceSupplied: handoff.kind === "conversation_evidence_observed",
        excludedParticipantInput,
      });
      const changed =
        !isSameJson(decision.aggregate, aggregate) ||
        decision.effects.length > 0 ||
        decision.events.length > 0;
      if (!changed) {
        if (providerPersistence !== undefined) {
          self.#repository.persistProviderObservation(providerPersistence);
        }
        if (handoff.kind === "conversation_evidence_observed")
          self.#recordToolCalls(handoff.toolCalls);
        yield* self.#finishAppliedDeadline(appliedDeadline, options);
        return notAccepted;
      }

      self.#persistAggregate(decision.aggregate, decision.events, providerPersistence);
      if (handoff.kind === "conversation_evidence_observed")
        self.#recordToolCalls(handoff.toolCalls);
      if (handoff.kind === "conversation_evidence_observed" && selected !== undefined)
        self.#events.recordConversationDiagnostics?.(
          selected.agent.conversation.diagnostics ?? {},
          handoff.diagnostics ?? [],
        );
      if (options.deferNodeDispatch !== true) yield* self.#dispatchNode();
      self.#recordProviderCommandIntents(decision.effects, state.session_id, observationAt);
      const nextExecution = self.#projectExecution(
        self.#repository.requireState(state.run_id),
        decision.aggregate,
        observationAt,
      );
      if (!nextExecution.providerConnection.required) {
        self.#repository.clearExecutionWake(state.run_id);
      }
      yield* self.#requestWakeUp();
      if (options.deferEffectExecution !== true && self.#operation === null) {
        yield* self.executeSelectedRuntimeWork();
      }
      yield* self.#requestWakeUp();
      return {
        accepted: decision.events.some((event) => event.type === "runtime.ending"),
        transcriptChanged: decision.aggregate.transcriptRevision !== aggregate.transcriptRevision,
      };
    });
  }

  /**
   * The execution lost its session before Runtime's release. Overdue work applies first. A Run
   * still Live then ends interrupted, its failure named `source`; during Ending the session
   * reports nothing more, so the result is reconsidered at once instead of at the next alarm.
   * Answers whether the result was reconsidered during Ending.
   */
  acceptSessionLost(source: string): Effect.Effect<boolean, NodeDispatchClaimFailed> {
    const self = this;
    return coordinatorStep(
      Effect.gen(function* () {
        const state = self.#repository.readState();
        if (state === null || !hasAuthoritativeFinalization(state)) return false;
        const at = self.#now();
        const loss = { kind: "runtime_failure_observed", source, at } as const;
        const incoming = arbitrationWorkForObservation(loss);
        yield* self.#applyOverdueWorkBeforeIncoming(incoming.entry, incoming.work, at);
        yield* microtaskBoundary;
        if (self.#repository.readState()?.phase === "live") {
          yield* self.#acceptObservation(loss, undefined, { skipDeadlinePreflight: true });
          return false;
        }
        yield* self.#acceptObservation({ kind: "evidence_prefix_processed", at }, undefined, {
          skipDeadlinePreflight: true,
          deferEffectExecution: true,
        });
        return true;
      }),
    );
  }

  /**
   * The execution's session ended normally after Runtime's release. During Original's Live
   * cleanup, whose release began, that ends the Run with the reserved reason; any other end of
   * the session during Live is its loss, and the Run ends interrupted.
   */
  acceptSessionReleased(): Effect.Effect<void, NodeDispatchClaimFailed> {
    const self = this;
    return coordinatorStep(
      Effect.gen(function* () {
        const state = self.#repository.readState();
        if (state?.phase !== "live" || !hasAuthoritativeFinalization(state)) return;
        const aggregate = self.#repository.readAggregate(state);
        const node = aggregate.conversationNodeExecution;
        const claimed =
          node?.kind === "retained_output" && node.cleanup.status === "claimed"
            ? node.cleanup
            : undefined;
        const cleanup = aggregate.state.effects.find(({ id }) => id === claimed?.effectId);
        if (
          node?.kind !== "retained_output" ||
          cleanup?.kind !== "release_session" ||
          (cleanup.status !== "sending" && cleanup.status !== "dispatched")
        ) {
          yield* self.#acceptObservation({
            kind: "runtime_failure_observed",
            source: "session_disconnected",
            at: self.#now(),
          });
          return;
        }
        yield* self.#acceptObservation(
          {
            kind: "end_requested",
            reason: node.reservation.reason,
            source: node.reservation.source,
            at: self.#now(),
          },
          undefined,
          { skipDeadlinePreflight: true, deferEffectExecution: true },
        );
      }),
    );
  }

  /**
   * The execution's session carries Runtime's work again after it reconnected, with its reports
   * ordered from `generation` on: overdue work applies first, then a node still pending is
   * dispatched under that generation.
   */
  resumeExecution(generation: number): Effect.Effect<void, NodeDispatchClaimFailed> {
    const self = this;
    return coordinatorStep(
      Effect.gen(function* () {
        const state = self.#repository.readState();
        if (state === null || !hasAuthoritativeFinalization(state)) return;
        const aggregate = self.#repository.readAggregate(state);
        if (generation > aggregate.providerGeneration)
          self.#persistAggregate({ ...aggregate, providerGeneration: generation }, []);
        const applied = yield* self.#applyOverdueWorkBeforeIncoming(
          "execution_wake",
          { id: "incoming:execution_resumed", kind: "execution_wake" },
          self.#now(),
        );
        if (!applied) yield* self.#dispatchNode();
      }),
    );
  }

  applyOverdueWorkBeforeIncoming(
    entry: InterviewRuntimeControllerEntry,
    incomingWork: InterviewRuntimeControllerWork,
    at: number,
    options: Readonly<{ deferNodeDispatch?: boolean }> = {},
  ): Effect.Effect<boolean, NodeDispatchClaimFailed> {
    return coordinatorStep(this.#applyOverdueWorkBeforeIncoming(entry, incomingWork, at, options));
  }

  #applyOverdueWorkBeforeIncoming(
    entry: InterviewRuntimeControllerEntry,
    incomingWork: InterviewRuntimeControllerWork,
    at: number,
    options: Readonly<{ deferNodeDispatch?: boolean }> = {},
  ): Effect.Effect<boolean, NodeDispatchClaimFailed> {
    return Effect.suspend(() => {
      const state = this.#repository.readState();
      if (state === null || !hasAuthoritativeFinalization(state)) return Effect.succeed(false);
      const aggregate = this.#repository.readAggregate(state);
      const execution = this.#projectExecution(state, aggregate, at);
      const dueDeadlines = execution.deadlines.filter(({ due }) => due);
      const deadlineWorks = execution.arbitrationCandidates.filter(({ id }) =>
        id.startsWith("deadline:"),
      );
      if (deadlineWorks.length === 0) return Effect.succeed(false);
      const arbitration = arbitrateInterviewRuntimeControllerWork({
        entry,
        eligibleWork: [...deadlineWorks, incomingWork],
      });
      const selectedIndex = deadlineWorks.findIndex(({ id }) => id === arbitration.selected);
      if (selectedIndex < 0) return Effect.succeed(false);
      const selected = dueDeadlines[selectedIndex];
      if (selected === undefined) return Effect.succeed(false);
      return this.#acceptObservation(
        { kind: "deadline_reached", deadline: selected.deadline, at: selected.observationAt },
        undefined,
        { deferEffectExecution: true, ...options },
      ).pipe(Effect.as(true));
    });
  }

  /**
   * Runs the selected Runtime work in its own detached owner and waits for it. The owner starts
   * now, and the host retains it: a caller that stops waiting cannot interrupt it. Expected
   * provider failures remain domain values; a defect or interruption of the owner reaches both
   * the caller and the host with its original cause.
   */
  executeSelectedRuntimeWork(
    options: Readonly<{ withinProviderMessageQueue?: boolean }> = {},
  ): Effect.Effect<void> {
    return Effect.uninterruptible(
      Effect.suspend(() => {
        const operation = this.executeSelectedRuntimeWorkEffect(options);
        return Effect.forkDetach(
          this.#execution === undefined ? operation : this.#execution.enter(operation),
          { startImmediately: true },
        ).pipe(Effect.tap((owner) => Effect.sync(() => this.#background(retainOwner(owner)))));
      }),
    ).pipe(Effect.flatMap(Fiber.join));
  }

  executeSelectedRuntimeWorkEffect(
    options: Readonly<{ withinProviderMessageQueue?: boolean }> = {},
  ): Effect.Effect<void> {
    const coordinator = this;
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        // Check/set are indivisible. Acquisition installs release responsibility
        // even if the scheduler yields immediately after reservation.
        if (this.#operation !== null) {
          if (this.#operation.exitCause === undefined) return null;
          // A failed durable reconciliation remains owned; retry that local write
          // before admitting more work, without replaying the provider operation.
          this.#reconcileOperationExit(this.#operation, this.#operation.exitCause);
          this.#operation = null;
        }
        const operation: FinalizationOperation = { claim: null, exitCause: undefined };
        this.#operation = operation;
        return operation;
      }),
      (operation) =>
        operation === null
          ? Effect.void
          : Effect.gen(function* () {
              for (;;) {
                const execution = coordinator.projectExecution();
                if (execution === null) return;
                const appliedDeadline = yield* dieOnNodeDispatchClaimFailure(
                  coordinator.applyOverdueWorkBeforeIncoming(
                    "effect_dispatch",
                    execution.effects[0]?.work ?? {
                      id: "pending-provider-effect",
                      kind: "provider_effect",
                    },
                    coordinator.#now(),
                  ),
                );
                // Selection follows the preflight across a microtask boundary, as it did when
                // the preflight was awaited: an interruption requested by then is observed
                // before a new claim.
                yield* microtaskBoundary;
                if (appliedDeadline) continue;
                // Reload after preflight. Selection, claim and initial native dispatch
                // are indivisible, even with frequent scheduler yields.
                const selected = yield* Effect.sync(() =>
                  coordinator.#beginSelectedEffect(operation),
                );
                if (selected === null) return;
                const { state, preservesHardStopEntryAttempt } = selected;
                const result = yield* selected.execution;
                if (!coordinator.#claimIsCurrent(operation, true)) return;
                coordinator.#recordFailedProviderCommand(result);
                // A closed session's reports bound the result only while it is still open: the
                // reports already received are handed over before the barrier is taken.
                if (
                  result.outcome.code === "session_closed" &&
                  options.withinProviderMessageQueue !== true &&
                  coordinator.#isResultOpen()
                ) {
                  yield* coordinator.#provider.drain();
                }
                if (!coordinator.#claimIsCurrent(operation, true)) return;
                if (!preservesHardStopEntryAttempt) {
                  yield* dieOnNodeDispatchClaimFailure(
                    coordinator.applyOverdueWorkBeforeIncoming(
                      "effect_outcome",
                      arbitrationWorkForObservation({
                        kind: "effect_outcome",
                        effectId: result.effectId,
                        outcome: result.outcome,
                        at: coordinator.#now(),
                      }).work,
                      coordinator.#now(),
                    ),
                  );
                }
                // Barrier capture and feedback begin in the same synchronous section.
                yield* dieOnNodeDispatchClaimFailure(
                  coordinatorStep(
                    Effect.suspend(() => {
                      if (!coordinator.#claimIsCurrent(operation, true)) return Effect.void;
                      const current = coordinator.#repository.readAggregate();
                      const barrier =
                        result.outcome.code === "session_closed"
                          ? coordinator.#provider.closeBarrier(current.acceptedProviderOrder)
                          : null;
                      let observation: FinalizationInput = {
                        kind: "effect_outcome",
                        effectId: result.effectId,
                        outcome: result.outcome,
                        at: coordinator.#now(),
                      };
                      if (barrier !== null)
                        observation = { ...observation, providerCloseBarrier: barrier };
                      return coordinator.#acceptObservation(observation, undefined, {
                        skipDeadlinePreflight: true,
                      });
                    }),
                  ),
                );
                coordinator.#recordProviderCommandOutcome(result, state.session_id);
                if (
                  result.effectKind === "compute_transcript_digest" &&
                  result.outcome.status !== "uncertain"
                ) {
                  // Digest continuation belongs to this coordinator. Snapshot its exact
                  // revision with its turns; a later replacement cannot seal that input.
                  const snapshot = yield* Effect.sync(() =>
                    coordinator.#repository.readAggregate(),
                  );
                  const revision = result.digestRevision ?? snapshot.transcriptRevision;
                  if (revision !== snapshot.transcriptRevision) {
                    operation.claim = null;
                    continue;
                  }
                  const digest = yield* runtimeTranscriptDigest({
                    turns: readFinalizationTranscriptTurns(snapshot),
                  });
                  yield* dieOnNodeDispatchClaimFailure(
                    coordinatorStep(
                      Effect.suspend(() => {
                        if (!coordinator.#claimIsCurrent(operation, false)) return Effect.void;
                        return coordinator.#acceptObservation({
                          kind: "transcript_digest_computed",
                          revision,
                          digest,
                          at: coordinator.#now(),
                        });
                      }),
                    ),
                  );
                }
                operation.claim = null;
              }
            }),
      (operation, exit) =>
        operation === null
          ? Effect.void
          : Effect.gen(function* () {
              // Only this owner's unfinished claim is reconciled, never restart-restored
              // or swept across other live owners. Persist before releasing single-flight.
              yield* Effect.sync(() => {
                operation.exitCause = Exit.isFailure(exit) ? exit.cause : null;
                coordinator.#reconcileOperationExit(operation, operation.exitCause);
                if (coordinator.#operation === operation) coordinator.#operation = null;
              });
              if (Exit.isFailure(exit) || operation.claim !== null)
                yield* coordinator.requestWakeUp();
            }),
    );
  }

  #beginSelectedEffect(operation: FinalizationOperation): Readonly<{
    state: RuntimeControllerRow;
    preservesHardStopEntryAttempt: boolean;
    execution: Effect.Effect<FinalizationEffectRunnerResult>;
  }> | null {
    const state = this.#repository.readState();
    if (state === null || !hasAuthoritativeFinalization(state)) return null;
    const aggregate = this.#repository.readAggregate(state);
    const execution = this.#projectExecution(state, aggregate, this.#now());
    const canRestoreProvider =
      state.session_id !== null && execution.providerConnection.required && this.#provider.feasible;
    if (
      canRestoreProvider &&
      !this.#provider.connected &&
      execution.effects.some(({ requirement }) => requirement === "connected_session")
    ) {
      this.#provider.ensureConnected(state.session_id ?? "");
    }
    const selected = selectExecutableEffect(
      execution.effects,
      this.#provider.connected,
      canRestoreProvider,
    );
    if (selected === undefined) return null;
    operation.claim = {
      effect: selected.effect,
      runId: state.run_id,
      generation: aggregate.providerGeneration,
      claimed: false,
    };
    let runnerInput: Parameters<typeof runInterviewFinalizationEffect>[0] = {
      effect: selected.effect,
      capabilities: {
        repository: {
          recordAttempt: (effectId) => {
            // Retain identity before the write: a repository defect may occur
            // after commit, and that durable claim still needs exit ownership.
            operation.claim = {
              effect: selected.effect,
              runId: state.run_id,
              generation: aggregate.providerGeneration,
              claimed: true,
            };
            this.#repository.markEffectSending(effectId);
            if (isProviderCommandEffect(selected.effect.kind)) {
              this.#events.recordDiagnostic("runtime.provider_command_dispatch_claimed", {
                source: "runtime_controller",
                effectId,
                effectKind: selected.effect.kind,
                dispatchStartedAt: this.#now(),
                sessionId: state.session_id ?? undefined,
              });
            }
          },
        },
        connection: { ready: this.#provider.connected },
        provider: {
          sendFinalizationOperation: (command) => this.#provider.sendFinalizationOperation(command),
          describeInputClosure: (command) => this.#provider.describeInputClosure?.(command),
          release: () => this.#releaseSession(),
        },
      },
    };
    if (this.#effectCrashInjector !== undefined)
      runnerInput = { ...runnerInput, crashInjector: this.#effectCrashInjector };
    const runner = runInterviewFinalizationEffect(runnerInput);
    return {
      state,
      execution: runner,
      preservesHardStopEntryAttempt:
        execution.deadlines.some(({ due }) => due) &&
        !execution.arbitrationCandidates.some(({ id }) => id.startsWith("deadline:")),
    };
  }

  #claimIsCurrent(operation: FinalizationOperation, requireSending: boolean): boolean {
    if (
      this.#operation !== operation ||
      operation.exitCause !== undefined ||
      operation.claim === null
    )
      return false;
    const state = this.#repository.readState();
    if (state === null || state.run_id !== operation.claim.runId) return false;
    const aggregate = this.#repository.readAggregate(state);
    const claim = operation.claim;
    const effect = aggregate.state.effects.find(({ id }) => id === claim.effect.id);
    return (
      effect !== undefined &&
      effect.kind === claim.effect.kind &&
      effectRevision(effect) === effectRevision(claim.effect) &&
      (effect.kind === "compute_transcript_digest" && !requireSending
        ? effect.attemptCount >= claim.effect.attemptCount + 1
        : effect.attemptCount === claim.effect.attemptCount + (requireSending ? 0 : 1)) &&
      (requireSending
        ? effect.status === (claim.claimed ? "sending" : "pending")
        : effect.status === "pending") &&
      (!isProviderCommandEffect(effect.kind) || aggregate.providerGeneration === claim.generation)
    );
  }

  #reconcileOperationExit(
    operation: FinalizationOperation,
    cause: Cause.Cause<never> | null,
  ): void {
    const claim = operation.claim;
    if (claim === null || !claim.claimed) return;
    const state = this.#repository.readState();
    if (state === null || state.run_id !== claim.runId) return;
    const aggregate = this.#repository.readAggregate(state);
    const effect = aggregate.state.effects.find(({ id }) => id === claim.effect.id);
    if (
      effect === undefined ||
      effect.kind !== claim.effect.kind ||
      effectRevision(effect) !== effectRevision(claim.effect) ||
      effect.attemptCount !== claim.effect.attemptCount
    )
      return;
    const safeLocal = effect.kind === "compute_transcript_digest" || effect.kind === "arm_alarm";
    if (effect.status !== "sending") return;
    // Apply the existing recovery policy to this claim alone, retaining all
    // competing evidence and every other effect exactly as currently persisted.
    const recovery = this.#advance(
      {
        ...aggregate,
        state: { ...aggregate.state, effects: [{ ...effect, status: "sending" }] },
      },
      { kind: "interrupted_effects_recovered" },
    );
    const recovered = recovery.aggregate.state.effects[0];
    if (recovered === undefined) return;
    this.#persistAggregate(
      {
        ...recovery.aggregate,
        state: {
          ...recovery.aggregate.state,
          effects: aggregate.state.effects.map((current) =>
            current.id === effect.id ? recovered : current,
          ),
        },
      },
      recovery.events,
    );
    if (!safeLocal)
      this.#events.recordDiagnostic("runtime.provider_command_interrupted", {
        source: "runtime_controller",
        effectId: effect.id,
        effectKind: effect.kind,
        status: "uncertain",
        interruptionPoint: "after_dispatch_claim_before_outcome",
        exitKind:
          cause === null ? "stale_outcome" : Cause.hasInterrupts(cause) ? "interruption" : "defect",
        sessionId: state.session_id ?? undefined,
      });
  }

  handleAlarmInvocation(): Effect.Effect<void, NodeDispatchClaimFailed> {
    const self = this;
    return coordinatorStep(
      Effect.gen(function* () {
        const state = self.#repository.readState();
        if (state === null || !hasAuthoritativeFinalization(state)) {
          yield* self.#requestWakeUp();
          return;
        }
        const now = self.#now();
        const aggregate = self.#repository.readAggregate(state);
        const execution = self.#projectExecution(state, aggregate, now);
        const recoveryReconnectDue =
          !self.#provider.connected &&
          !self.#provider.connecting &&
          state.session_id !== null &&
          self.#provider.feasible &&
          execution.providerConnection.required;
        const reconnectDue =
          (state.execution_wake_at !== null && state.execution_wake_at <= now) ||
          recoveryReconnectDue;
        const appliedDeadline = yield* self.#applyOverdueWorkBeforeIncoming(
          "alarm",
          reconnectDue
            ? { id: "alarm:execution_wake", kind: "execution_wake" }
            : { id: "alarm:provider_effect", kind: "provider_effect" },
          now,
        );
        const refreshedState = self.#repository.requireState(state.run_id);
        const refreshedExecution = self.#projectExecution(
          refreshedState,
          self.#repository.readAggregate(refreshedState),
          now,
        );
        if (
          !appliedDeadline &&
          reconnectDue &&
          refreshedState.session_id !== null &&
          refreshedExecution.providerConnection.required
        ) {
          self.#provider.ensureConnected(refreshedState.session_id);
        } else if (reconnectDue && !refreshedExecution.providerConnection.required) {
          self.#repository.clearExecutionWake(refreshedState.run_id);
          self.#events.recordDiagnostic("runtime.execution_wake_suppressed", {
            source: "runtime_controller",
            observedAt: now,
            generation: refreshedState.session_generation,
          });
        }

        yield* self.executeSelectedRuntimeWork();
        const publicationState = self.#repository.readState();
        if (publicationState !== null && hasAuthoritativeFinalization(publicationState)) {
          const publicationAggregate = self.#repository.readAggregate(publicationState);
          const publication = self.#projectExecution(
            publicationState,
            publicationAggregate,
            now,
          ).publication;
          const completion = completionFromAggregate(publicationAggregate);
          if (
            publicationState.callback_pending === 1 &&
            publication.ready &&
            completion !== undefined
          ) {
            self.#publication.scheduleTerminal({ completion, observedAt: now });
            return;
          }
        }
        yield* self.#requestWakeUp();
      }),
    );
  }

  /** Requests the physical alarm that the Run's durable demand needs. */
  requestWakeUp(): Effect.Effect<void> {
    return coordinatorStep(this.#requestWakeUp());
  }

  #requestWakeUp(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const state = this.#repository.readState();
      const now = this.#now();
      const execution =
        state !== null && hasAuthoritativeFinalization(state)
          ? this.#projectExecution(state, this.#repository.readAggregate(state), now)
          : null;
      const hasPendingEffect = execution !== null && execution.effects.length > 0;
      const hasRecoveryEffect =
        execution !== null &&
        !this.#provider.connected &&
        !this.#provider.connecting &&
        state?.session_id !== null &&
        this.#provider.feasible &&
        execution.providerConnection.required;
      return this.#storage.requestAlarm(
        nextWakeAt(state, execution, hasPendingEffect, hasRecoveryEffect, now),
      );
    });
  }

  #finishAppliedDeadline(
    appliedDeadline: boolean,
    options: InterviewFinalizationObservationOptions,
  ): Effect.Effect<void> {
    return Effect.suspend(() =>
      appliedDeadline && options.deferEffectExecution !== true && this.#operation === null
        ? this.executeSelectedRuntimeWork().pipe(Effect.andThen(this.#requestWakeUp()))
        : Effect.void,
    );
  }

  /**
   * Starts a node dispatch's follow-up in its own detached owner now. Its synchronous prefix runs
   * before this returns to its caller, as the follow-up's Promise did. The host retains it, and a
   * caller that stops waiting cannot interrupt it.
   */
  #detach(operation: Effect.Effect<void, NodeDispatchClaimFailed>): Effect.Effect<void> {
    return Effect.forkDetach(coordinatorStep(dieOnNodeDispatchClaimFailure(operation)), {
      startImmediately: true,
    }).pipe(Effect.map((owner) => this.#background(retainOwner(owner))));
  }

  /**
   * Runs a coordinator step for a native callback, whose contract is a Promise. This is the
   * native edge: the native caller awaits it, and a defect rejects it with its original cause.
   */
  #runNativeCallback(operation: Effect.Effect<void, NodeDispatchClaimFailed>): Promise<void> {
    return Effect.runPromise(coordinatorStep(dieOnNodeDispatchClaimFailure(operation)));
  }

  #projectExecution(
    state: RuntimeControllerRow,
    aggregate: InterviewFinalizationAggregate,
    now: number,
  ): InterviewFinalizationExecution {
    return projectInterviewFinalizationExecution(aggregate, {
      now,
      liveDeadlineAt: state.deadline_at,
      participantPresenceDeadlineAt: state.presence_grace_until,
      browserMediaReadyDeadlineAt:
        state.browser_media_ready_at === null ? state.browser_media_ready_deadline_at : null,
      openingPending:
        state.opening_state === "pending" && state.browser_media_ready_deadline_at !== null,
    });
  }

  /** A live visit ends in the terminal its selected Conversation declares for that role. */
  #advance(
    aggregate: InterviewFinalizationAggregate,
    observation: FinalizationInput,
    facts: FinalizationConversationFacts = {},
  ) {
    return advanceInterviewFinalization(aggregate, observation, {
      ...facts,
      conversationTerminals:
        aggregate.conversationVisit === undefined
          ? undefined
          : this.#selectedAgent?.()?.agent.conversation.terminalRoles,
    });
  }

  /**
   * At Ending's entry, the execution's account of the input it closes: uncommitted input, such
   * as speech the execution kept across a Runtime restart, is input the step settles even when
   * the step is never carried out.
   */
  #describedInputClosure(
    aggregate: InterviewFinalizationAggregate,
  ): InterviewFinalizationAggregate {
    const finalInput = aggregate.finalInput;
    const step = aggregate.state.effects.find(({ id }) => id === finalInput?.effectId);
    if (finalInput === null || step?.kind !== "close_input" || step.status !== "pending")
      return aggregate;
    const settlement = this.#provider.describeInputClosure?.({
      kind: "close_input",
      commandId: step.id,
      heldItemId: step.heldItemId,
    });
    return settlement === undefined || !settlement.inputToSettle
      ? aggregate
      : describeInputClosure(aggregate, settlement);
  }

  /** Whether Ending still decides the result: it has a cutoff, and the result is not frozen. */
  #isResultOpen(): boolean {
    const execution = this.projectExecution();
    return (
      execution !== null &&
      execution.finalizationCutoffAt !== null &&
      execution.providerConnection.untilAt !== null
    );
  }

  #persistAggregate(
    aggregate: InterviewFinalizationAggregate,
    events: readonly RuntimePublicEvent[] | null,
    providerPersistence?: ProviderObservationPersistence,
  ): void {
    const recordsEnding = events?.some((event) => event.type === "runtime.ending") === true;
    const source = recordsEnding ? readFinalizationSource(aggregate.state) : null;
    const options: AggregatePersistenceOptions =
      recordsEnding && source !== null
        ? {
            diagnostic: {
              type: "runtime.ending_started",
              observedAt: readFinalizationEndingStartedAt(aggregate.state),
              payload: {
                source: "runtime_controller",
                endReason: readFinalizationEndReason(aggregate.state),
                trigger: toEndingTrigger(source),
              },
            },
          }
        : {};
    const prior = this.#repository.readState();
    const previousConversation =
      prior !== null && hasAuthoritativeFinalization(prior)
        ? projectInterviewFinalizationPublicState(this.#repository.readAggregate(prior))
            .conversation
        : null;
    const described = recordsEnding ? this.#describedInputClosure(aggregate) : aggregate;
    this.#repository.persistAggregate(described, events, providerPersistence, options);
    const conversation = projectInterviewFinalizationPublicState(described).conversation;
    if (conversation !== null && !isSameJson(conversation, previousConversation))
      this.#events.recordEvent("runtime.conversation_state", conversation);
    if (recordsEnding) {
      this.#nodeNative?.containNode();
      // Urgent synchronous commands have their own durable claims. They never
      // wait behind the provider receipt FIFO or an in-flight cleanup operation.
      for (const intent of aggregate.state.effects) {
        if (
          intent.status !== "pending" ||
          (intent.kind !== "cancel_reply" && intent.kind !== "stop_output")
        )
          continue;
        this.#repository.markEffectSending(intent.id);
        let outcome: FinalizationEffectOutcome;
        try {
          outcome = this.#provider.sendFinalizationOperation(
            intent.kind === "cancel_reply" && intent.responseId !== undefined
              ? { kind: "cancel_reply", commandId: intent.id, responseId: intent.responseId }
              : { kind: "stop_output", commandId: intent.id },
          );
        } catch {
          outcome = { status: "uncertain", code: "urgent_containment_failed" };
        }
        const current = this.#repository.readAggregate(this.#repository.requireState());
        const contained = this.#advance(current, {
          kind: "effect_outcome",
          effectId: intent.id,
          outcome,
          at: this.#now(),
        });
        this.#repository.persistAggregate(contained.aggregate, contained.events);
      }
    }
    this.#recordFinalizedDiagnostics(aggregate);
  }

  #recordFinalizedDiagnostics(aggregate: InterviewFinalizationAggregate): void {
    const publicFinalization = projectInterviewFinalizationPublicState(aggregate);
    if (publicFinalization.completion === null) return;
    try {
      const selected = this.#selectedAgent?.();
      if (selected === undefined) return;
      const descriptions =
        selected.agent.finalizedDiagnostics?.(publicFinalization.completion) ?? [];
      this.#events.recordConversationDiagnostics?.(
        selected.agent.conversation.diagnostics ?? {},
        descriptions,
      );
    } catch {
      /* Optional diagnostics never change canonical finalization. */
    }
  }

  /**
   * A Runtime restart in Live loses what the execution's session observed meanwhile. A Run
   * whose conversation had begun ends interrupted, and a pending node may still run with a gap
   * in its evidence. How the execution reconnects, and which events it may have missed, are its
   * own.
   */
  #reconcileReconstructedProvider(aggregate: InterviewFinalizationAggregate): void {
    const state = this.#repository.readState();
    if (state === null) return;
    const now = this.#now();
    const execution = this.#projectExecution(state, aggregate, now);
    if (!execution.reconstructionRequiresDisconnect) return;
    const decision =
      aggregate.conversationNodeExecution?.dispatch?.status === "pending"
        ? {
            aggregate: {
              ...aggregate,
              applicationTranscriptProof: {
                ...aggregate.applicationTranscriptProof,
                evidenceGap: true,
              },
            },
            events: [],
          }
        : this.#advance(
            aggregate,
            { kind: "runtime_failure_observed", source: "session_disconnected", at: now },
            { receiptPrefix: this.#provider.sampleReceiptPrefix?.() },
          );
    if (decision.aggregate === aggregate) return;
    this.#persistAggregate(decision.aggregate, decision.events);
    this.#events.recordEvent("runtime.session_reconstruction_disconnected", {
      generation: aggregate.providerGeneration,
    });
  }

  /**
   * Dispatches the session's release when called; the returned Effect awaits its answer. A step
   * that throws before the dispatch is a defect of that Effect, not of its caller. The answer,
   * or the defect, reaches the caller one microtask later, as it did when this step was an
   * awaited Promise. A closed session is the outcome's `session_closed`; a release that failed
   * keeps its status, its code and whether it timed out.
   */
  #releaseSession(): Effect.Effect<FinalizationEffectOutcome> {
    let released: Effect.Effect<SessionReleaseAnswer>;
    try {
      const state = this.#repository.requireState();
      const aggregate = this.#repository.readAggregate(state);
      const now = this.#now();
      const cutoffAt = this.#projectExecution(state, aggregate, now).finalizationCutoffAt;
      const remainingMs = cutoffAt === null ? null : millisecondsUntil(cutoffAt, now);
      // No cutoff, or one that has passed, leaves the release its own configured bound.
      const timeoutCapMs = remainingMs === null || remainingMs === 0 ? undefined : remainingMs;
      released = this.#provider.release(state.session_id, timeoutCapMs);
    } catch (defect) {
      return Effect.ensuring(Effect.die(defect), microtaskBoundary);
    }
    return Effect.map(released, (answer): FinalizationEffectOutcome => {
      if (answer.status === "closed") return { status: "dispatched", code: "session_closed" };
      if (answer.failure === undefined) return { status: "dispatched" };
      const failed: FinalizationEffectOutcome = {
        status: answer.failure.status,
        code: answer.failure.code,
      };
      return answer.failure.timedOut ? { ...failed, timedOut: true } : failed;
    }).pipe(Effect.ensuring(microtaskBoundary));
  }

  #recordProviderCommandIntents(
    effects: readonly InterviewFinalizationAggregate["state"]["effects"][number][],
    sessionId: string | null,
    intentAt: number,
  ): void {
    for (const effect of effects) {
      if (!isProviderCommandEffect(effect.kind)) continue;
      this.#events.recordDiagnostic("runtime.provider_command_intent_persisted", {
        source: "runtime_controller",
        effectId: effect.id,
        effectKind: effect.kind,
        intentAt,
        status: effect.status,
        sessionId: sessionId ?? undefined,
      });
    }
  }

  #recordProviderCommandOutcome(
    result: FinalizationEffectRunnerResult,
    sessionId: string | null,
  ): void {
    if (!isProviderCommandEffect(result.effectKind)) {
      return;
    }
    this.#events.recordDiagnostic("runtime.provider_command_outcome", {
      source: "runtime_controller",
      effectId: result.effectId,
      effectKind: result.effectKind,
      observedAt: this.#now(),
      status: result.outcome.status,
      code: result.outcome.code,
      sessionId: sessionId ?? undefined,
    });
  }

  /**
   * One record per provider call: a call arrives with its arguments and again in its
   * response's output, and the first receipt decides what Runtime did with it.
   */
  #recordToolCalls(
    toolCalls: readonly import("./toolCallRecord.ts").RuntimeToolCallDescription[] | undefined,
  ): void {
    for (const call of toolCalls ?? []) {
      if (call.toolCallId === null) {
        this.#events.recordDiagnostic(runtimeToolCallRecordType, call);
        continue;
      }
      this.#events.recordUniqueDiagnostic?.(
        runtimeToolCallRecordType,
        (recorded) => recorded.toolCallId === call.toolCallId,
        call,
      );
    }
  }

  #recordFailedProviderCommand(result: FinalizationEffectRunnerResult): void {
    if (
      result.effectKind === "release_session" ||
      result.effectKind === "compute_transcript_digest" ||
      result.effectKind === "arm_alarm" ||
      result.outcome.status === "dispatched" ||
      result.outcome.status === "benign_rejection"
    ) {
      return;
    }
    let failureData: RuntimeEventPayload = {
      effectId: result.effectId,
      effectKind: result.effectKind,
      status: result.outcome.status,
    };
    if (result.outcome.code !== undefined) {
      failureData = { ...failureData, code: result.outcome.code };
    }
    this.#events.recordEvent("runtime.provider_command_failed", failureData);
  }
}

function hasAuthoritativeFinalization(state: RuntimeControllerRow): boolean {
  return state.finalization_state_json !== null;
}

function nextWakeAt(
  state: RuntimeControllerRow | null,
  execution: InterviewFinalizationExecution | null,
  hasPendingEffect: boolean,
  hasRecoveryEffect: boolean,
  now: number,
): number | null {
  if (state === null) return null;
  const timestamps: number[] = [];
  if (execution?.nextDomainWakeAt !== null && execution?.nextDomainWakeAt !== undefined) {
    timestamps.push(execution.nextDomainWakeAt);
  }
  if (
    state.callback_pending === 1 &&
    execution?.publication.readyAt !== null &&
    execution?.publication.readyAt !== undefined
  ) {
    timestamps.push(execution.publication.readyAt);
  }
  if ((state.phase === "live" || state.phase === "ending") && state.execution_wake_at !== null) {
    timestamps.push(state.execution_wake_at);
  }
  if (hasPendingEffect || hasRecoveryEffect) timestamps.push(now + providerRecoveryDelayMs);
  return timestamps.length === 0 ? null : Math.min(...timestamps);
}

function selectExecutableEffect(
  effects: readonly InterviewFinalizationExecutableEffect[],
  providerReady: boolean,
  canRestoreProvider: boolean,
): InterviewFinalizationExecutableEffect | undefined {
  return effects.find(({ requirement }) => {
    if (requirement === "provider_free" || requirement === "session_identity") return true;
    if (providerReady) return true;
    return !canRestoreProvider;
  });
}

function readFinalizationEndReason(
  state: InterviewFinalizationAggregate["state"],
): RuntimeEndReason {
  if (state.stage === "ended") return state.completion.endReason;
  if (state.stage === "live") return "runtime_failed";
  return state.endReason;
}

function readFinalizationSource(state: InterviewFinalizationAggregate["state"]): string {
  if (state.stage === "ended") return state.completion.source;
  if (state.stage === "live") return "runtime";
  return state.source;
}

function readFinalizationEndingStartedAt(state: InterviewFinalizationAggregate["state"]): number {
  if (state.stage === "ended") return state.completion.endingStartedAt;
  if (state.stage === "live") return 0;
  return state.endingStartedAt;
}

function toEndingTrigger(source: string): string | undefined {
  switch (source) {
    case "browser_request":
    case "browser_close":
      return "browser_intent";
    case "timebox_alarm":
    case "controller_close_fallback":
      return "controller_alarm";
    case "agent_completion":
      return "provider_tool_call";
    case "presence_expired":
    case "presence_timeout":
      return "presence_grace_expired";
    default:
      return undefined;
  }
}

function isProviderCommandEffect(
  kind: InterviewFinalizationAggregate["state"]["effects"][number]["kind"],
): boolean {
  return kind !== "compute_transcript_digest" && kind !== "arm_alarm";
}
