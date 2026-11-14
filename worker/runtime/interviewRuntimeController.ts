type MutableObservationOptions = {
  -readonly [K in keyof import("./interviewFinalizationCoordinator.ts").InterviewFinalizationObservationOptions]: import("./interviewFinalizationCoordinator.ts").InterviewFinalizationObservationOptions[K];
};
import type {
  ExecutionBridge,
  RuntimeHostAssembly,
  SelectedProviderSession,
} from "./runtimeHostAssembly.ts";
import {
  requireConversationState,
  validateConversationDefinition,
} from "./conversationContracts.ts";
import { AcceptedConversations } from "./implementationContracts.ts";
import { decodeConversationSnapshot } from "./conversationExecution.ts";
import { admitDeclaredUsage, observeConversationUsage } from "./conversationUsage.ts";
import { parseRuntimeUsageAccountingState } from "./runtimeUsage.ts";
import type { ExecutionObservation } from "./interviewFinalizationModel.ts";
import { ConversationSetupCleanup } from "./conversationSetupCleanup.ts";
import {
  conversationConnectionResponse,
  type ConversationConnectionImplementation,
  type StartupConnectionImplementation,
} from "./conversationConnection.ts";
import {
  decodeRuntimeConnectionExchange,
  realtimeConnectionProfile,
  type RuntimeConnectionExchange,
  type RuntimeConnectionResult,
} from "../shared/contracts/runtimeConnection.ts";
import { Cause, Clock, Data, Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import type { RuntimeDelivery } from "./runtimeDelivery.ts";
import {
  decodeRetainedDeliveryTarget,
  decodeRuntimeDeliveryTarget,
} from "../shared/contracts/runtimeDelivery.ts";
import { decodeRuntimeAcceptanceRequest } from "../shared/contracts/runtimeAcceptance.ts";
import { InterviewAttemptCoordinator } from "./interviewAttemptCoordinator.ts";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { decodeRuntimeRequiredStopRequest } from "../shared/contracts/applicationStartup.ts";

import { withoutUndefined } from "../shared/http.ts";
import { isRuntimeEndReason, type RuntimeEndReason } from "../shared/runtimeControllerCallback.ts";
import {
  interviewExecutionSchema,
  parseRuntimeStartRequest,
  type RuntimeDiagnosticsContext,
  type RuntimeStartError,
} from "../shared/contracts/runtimeStart.ts";
import {
  conversationSelectionSchema,
  isMissingCredentialsRefusal,
} from "../shared/contracts/conversationSelection.ts";
import type {
  InterviewFinalizationRepository,
  RuntimeControllerRow,
} from "./interviewFinalizationRepository.ts";
import { RuntimePublication } from "./runtimePublication.ts";
import {
  NativeExecution,
  RunDelivery,
  RunStorage,
  RuntimeAssembly,
  RuntimeEventLog,
  RuntimeTestHooks,
  hasAuthoritativeFinalization,
  runtimeControllerLayer,
  type RuntimeControllerLayerOptions,
} from "./runtimeControllerServices.ts";
import {
  createLiveInterviewFinalizationAggregate,
  isFinishingNode,
  isSameJson,
  updateNodeDispatch,
  type InterviewFinalizationAggregate,
  type RuntimeFinalizationCompletion,
} from "./interviewFinalizationModel.ts";
import {
  projectInterviewFinalizationPublicState,
  type InterviewFinalizationPublicState,
} from "./interviewFinalizationPublicProjection.ts";
import {
  dieOnNodeDispatchClaimFailure,
  InterviewFinalizationCoordinator,
  type NodeDispatchClaimFailed,
} from "./interviewFinalizationCoordinator.ts";
import {
  readRuntimeCredentials,
  readRuntimeSetting,
  type RuntimeEnvironmentCapabilities,
} from "./types.ts";
import type { RuntimeEvents } from "./runtimeEvents.ts";
import {
  type ProviderSessionApplicationFact,
  type ProviderSessionRecord,
} from "./nativeContracts.ts";
import {
  browserPresenceGraceMs,
  deliverInterviewReadiness,
  StartupRejected,
  InterviewStartupCoordinator,
  prepareExecutionSettings,
  type RuntimeSetupInput,
  type RuntimeStartInput,
} from "./interviewStartupCoordinator.ts";

const runtimeJsonValueSchema = z.json();

type RuntimeJsonValue = z.output<typeof runtimeJsonValueSchema>;
type ControllerRequestValue =
  | RuntimeJsonValue
  | RuntimeDiagnosticsContext
  | FinalTurnFlush
  | undefined;
type ControllerRequest = Readonly<Record<string, ControllerRequestValue>>;

const invalidRequestCodes = [
  "missing_run_id",
  "invalid_runtime_duration",
  "invalid_runtime_presence_request",
  "invalid_duration_ms",
  "invalid_end_reason",
  "invalid_runtime_controller_request",
  "invalid_sdp_offer",
  "invalid_conversation_input",
  "invalid_execution_settings",
  "invalid_diagnostic_cursor",
] as const;
const conflictCodes = [
  "connection_exchange_conflict",
  "connection_profile_unavailable",
  "conversation_selection_unavailable",
  "retained_connection_start_missing",
  "runtime_start_not_accepted",
  "session_mismatch",
  "runtime_controller_run_mismatch",
  "runtime_controller_start_in_progress",
  "runtime_controller_start_failed",
  "runtime_delivery_target_conflict",
] as const;
const providerFailureCodes = ["provider_call_failed", "provider_call_missing_call_id"] as const;
const deliveryRefusalCodes = [
  "runtime_delivery_unconfigured",
  "runtime_delivery_run_mismatch",
  "runtime_delivery_unauthorized",
  "runtime_delivery_admission_expired",
] as const;
/** A malformed start request keeps its parser code. */
type InvalidRequestCode = (typeof invalidRequestCodes)[number] | RuntimeStartError;
type ConflictCode = (typeof conflictCodes)[number];
type DeliveryRefusalCode = (typeof deliveryRefusalCodes)[number];
/** The selected combination lacks credentials: a `missingCredentialsRefusal`. */
type UnavailableCode = string;
type ProviderFailureCode = (typeof providerFailureCodes)[number];

/** The request is malformed. */
class RuntimeRequestInvalid extends Data.TaggedError("RuntimeRequestInvalid")<{
  code: InvalidRequestCode;
  message: string;
}> {
  constructor(code: InvalidRequestCode) {
    super({ code, message: code });
  }
}
/** No Run has started on this controller. */
class RuntimeRunNotStarted extends Data.TaggedError("RuntimeRunNotStarted")<{
  code: "runtime_controller_not_started";
  message: string;
}> {
  constructor() {
    super({ code: "runtime_controller_not_started", message: "runtime_controller_not_started" });
  }
}
/** The request conflicts with this controller's Run, its start or its connection exchange. */
class RuntimeRequestConflict extends Data.TaggedError("RuntimeRequestConflict")<{
  code: ConflictCode;
  message: string;
}> {
  constructor(code: ConflictCode) {
    super({ code, message: code });
  }
}
/** The host refused the Run's delivery target. */
class RuntimeDeliveryRefused extends Data.TaggedError("RuntimeDeliveryRefused")<{
  code: DeliveryRefusalCode;
  message: string;
}> {
  constructor(code: DeliveryRefusalCode) {
    super({ code, message: code });
  }
}
/** This Runtime cannot serve the request as it is configured. */
class RuntimeUnavailable extends Data.TaggedError("RuntimeUnavailable")<{
  code: UnavailableCode;
  message: string;
}> {
  constructor(code: UnavailableCode) {
    super({ code, message: code });
  }
}
/** The provider did not create the native call. */
class RuntimeProviderFailed extends Data.TaggedError("RuntimeProviderFailed")<{
  code: ProviderFailureCode;
  message: string;
}> {
  constructor(code: ProviderFailureCode) {
    super({ code, message: code });
  }
}
/**
 * Any other coded failure, such as the error of a failed preparation step. Runtime cannot tell
 * it apart from its own fault, so it keeps HTTP 500 with the defects.
 */
class RuntimeRequestRefused extends Data.TaggedError("RuntimeRequestRefused")<{
  code: string;
  message: string;
}> {
  constructor(code: string) {
    super({ code, message: code });
  }
}

/** Expected request failures. Each carries the public error code of its response. */
type RuntimeRequestFailure =
  | RuntimeRequestInvalid
  | RuntimeRunNotStarted
  | RuntimeRequestConflict
  | RuntimeDeliveryRefused
  | RuntimeUnavailable
  | RuntimeProviderFailed
  | RuntimeRequestRefused;

const deliveryRefusalStatus = {
  runtime_delivery_unconfigured: 503,
  runtime_delivery_run_mismatch: 409,
  runtime_delivery_unauthorized: 403,
  runtime_delivery_admission_expired: 409,
} as const satisfies Record<DeliveryRefusalCode, number>;

/** An expected failure answers with its own status; HTTP 500 stays with defects. */
function requestFailureStatus(failure: RuntimeRequestFailure): number {
  switch (failure._tag) {
    case "RuntimeRequestInvalid":
      return 400;
    case "RuntimeRunNotStarted":
      return 404;
    case "RuntimeRequestConflict":
      return 409;
    case "RuntimeDeliveryRefused":
      return deliveryRefusalStatus[failure.code];
    case "RuntimeUnavailable":
      return 503;
    case "RuntimeProviderFailed":
      return 502;
    case "RuntimeRequestRefused":
      return 500;
  }
}

function isCode<Code extends string>(codes: ReadonlyArray<Code>, value: string): value is Code {
  return codes.some((code) => code === value);
}

/** The typed failure for a public code reported by a non-Effect collaborator. */
function toRuntimeRequestFailure(code: string): RuntimeRequestFailure {
  if (isCode(invalidRequestCodes, code)) return new RuntimeRequestInvalid(code);
  if (code === "runtime_controller_not_started") return new RuntimeRunNotStarted();
  if (isCode(conflictCodes, code)) return new RuntimeRequestConflict(code);
  if (isCode(deliveryRefusalCodes, code)) return new RuntimeDeliveryRefused(code);
  if (isMissingCredentialsRefusal(code)) return new RuntimeUnavailable(code);
  if (isCode(providerFailureCodes, code)) return new RuntimeProviderFailed(code);
  return new RuntimeRequestRefused(code);
}

/** A collaborator failure that is not a request refusal. It continues as a defect. */
class CollaboratorDefect extends Data.TaggedError("CollaboratorDefect")<{ defect: unknown }> {}

/**
 * The repository, the delivery host, the connection validators and the Run admission
 * steps that startup runs are plain code that report refusals by throwing coded errors.
 * This is the one place where those reach Effect: a startup refusal, or an error whose
 * code the request contract names, becomes a typed failure; anything else stays a defect.
 */
function classifyCollaboratorFailure<Failure>(
  error: Failure,
): RuntimeRequestFailure | CollaboratorDefect {
  if (error instanceof StartupRejected) return toRuntimeRequestFailure(error.code);
  if (
    error instanceof Error &&
    (isCode(invalidRequestCodes, error.message) ||
      error.message === "runtime_controller_not_started" ||
      isCode(conflictCodes, error.message) ||
      isCode(deliveryRefusalCodes, error.message) ||
      isMissingCredentialsRefusal(error.message))
  )
    return toRuntimeRequestFailure(error.message);
  return new CollaboratorDefect({ defect: error });
}

/** Runs a synchronous collaborator step at the request ingress. */
function collaborate<A>(step: () => A): Effect.Effect<A, RuntimeRequestFailure> {
  return Effect.try({ try: step, catch: classifyCollaboratorFailure }).pipe(
    Effect.catchTag("CollaboratorDefect", ({ defect }) => Effect.die(defect)),
  );
}

/** Awaits an asynchronous collaborator step at the request ingress. */
function collaborateAsync<A>(task: () => Promise<A>): Effect.Effect<A, RuntimeRequestFailure> {
  return Effect.tryPromise({ try: task, catch: classifyCollaboratorFailure }).pipe(
    Effect.catchTag("CollaboratorDefect", ({ defect }) => Effect.die(defect)),
  );
}

/** A coded error the request contract names is a typed failure; anything else stays a defect. */
function classifyDefect<Defect>(defect: Defect): Effect.Effect<never, RuntimeRequestFailure> {
  const failure = classifyCollaboratorFailure(defect);
  return failure._tag === "CollaboratorDefect" ? Effect.die(defect) : Effect.fail(failure);
}

/**
 * Composes a coordinator operation at the request ingress. A startup refusal is typed. A
 * coded error from the plain code it runs, or the cause of a node dispatch claim that did not
 * complete, is classified as `collaborate` classifies it, and anything else stays a defect.
 */
function collaborateEffect<A>(
  operation: Effect.Effect<A, StartupRejected | NodeDispatchClaimFailed>,
): Effect.Effect<A, RuntimeRequestFailure> {
  return operation.pipe(
    Effect.catchDefect(classifyDefect),
    Effect.catchTags({
      StartupRejected: (refusal) => Effect.fail(toRuntimeRequestFailure(refusal.code)),
      NodeDispatchClaimFailed: ({ cause }) => classifyDefect(cause),
    }),
  );
}

/** Connection refusals that prove this Run was not accepted. */
function refusesConnectionAcceptance(failure: RuntimeRequestFailure): boolean {
  switch (failure._tag) {
    case "RuntimeRequestInvalid":
      return (
        failure.code === "invalid_sdp_offer" ||
        failure.code === "invalid_conversation_input" ||
        failure.code === "invalid_execution_settings"
      );
    case "RuntimeRequestConflict":
      return (
        failure.code === "connection_profile_unavailable" ||
        failure.code === "conversation_selection_unavailable" ||
        failure.code === "runtime_start_not_accepted"
      );
    case "RuntimeDeliveryRefused":
    case "RuntimeUnavailable":
      return true;
    case "RuntimeRunNotStarted":
    case "RuntimeProviderFailed":
    case "RuntimeRequestRefused":
      return false;
  }
}

/**
 * Explicit host options. The assembly resolves every pair from a Run's accepted
 * selection. Crash injectors and a controlled provider driver come only from a test
 * Layer of `RuntimeTestHooks`.
 */
export type InterviewRuntimeControllerHost = RuntimeControllerLayerOptions &
  Readonly<{
    connectionImplementation?: ConversationConnectionImplementation | undefined;
  }>;

/**
 * A test's connection implementation as the start awaits it: its promise validation and exchange
 * become Effects here, and the exchange is dispatched when called.
 */
function startupConnectionImplementation(
  implementation: ConversationConnectionImplementation,
): StartupConnectionImplementation {
  return {
    profile: implementation.profile,
    available: implementation.available,
    validateExecution: (execution) => implementation.validateExecution(execution),
    validate: (input) => Effect.promise(() => implementation.validate(input)),
    exchange: (input) => {
      const exchanged = implementation.exchange(input);
      return Effect.promise(() => exchanged);
    },
  };
}

/** Every service the controller composition requires from its Layer. */
const controllerServices = Effect.gen(function* () {
  return {
    assembly: yield* RuntimeAssembly,
    delivery: yield* RunDelivery,
    storage: yield* RunStorage,
    events: yield* RuntimeEventLog,
    execution: yield* NativeExecution,
    testHooks: yield* RuntimeTestHooks,
    clock: yield* Clock.Clock,
  };
});
type ControllerRuntime = ManagedRuntime.ManagedRuntime<
  Layer.Success<ReturnType<typeof runtimeControllerLayer>>,
  never
>;

type FinalTurnFlush = Readonly<{
  status: string;
  inputCommitSent?: boolean;
  completionReviewStatus?: string;
  debugText?: string;
}>;

type FinalTurnFlushDraft = {
  status: string;
  inputCommitSent?: boolean;
  completionReviewStatus?: string;
  debugText?: string;
};

type CompleteRuntimeResult = Readonly<{
  accepted: boolean;
  ending: boolean;
  idempotent: boolean;
  conflict: boolean;
  completion?: RuntimeFinalizationCompletion;
  state: Record<string, unknown>;
}>;

export class InterviewRuntimeController extends DurableObject<RuntimeEnvironmentCapabilities> {
  // This instance's own runtime, built once from its Layer. Every entry runs on it.
  readonly #runtime: ControllerRuntime;
  readonly #now: () => number;
  private readonly delivery: RuntimeDelivery;
  private readonly execution: ExecutionBridge;
  private readonly assembly: RuntimeHostAssembly;
  private readonly storage: RunStorage["Service"];
  private readonly repository: InterviewFinalizationRepository;
  private readonly runtimeEvents: RuntimeEvents;
  private readonly runtimePublication: RuntimePublication;
  private readonly providerSession: SelectedProviderSession;
  private readonly finalizationCoordinator: InterviewFinalizationCoordinator;
  private readonly attemptCoordinator: InterviewAttemptCoordinator;
  private readonly startupCoordinator: InterviewStartupCoordinator;
  // Construction owns restoration; this promise is only the native input-gate adapter.
  private readonly ready: Promise<void>;

  constructor(
    ctx: DurableObjectState,
    env: RuntimeEnvironmentCapabilities,
    host: InterviewRuntimeControllerHost,
  ) {
    super(ctx, env);
    const self = this;
    const { connectionImplementation } = host;
    this.#runtime = ManagedRuntime.make(runtimeControllerLayer(ctx, host));
    // The Layer is synchronous: its services are built here, once, before any entry.
    const services = this.#runtime.runSync(controllerServices);
    const { assembly, delivery, storage, clock } = services;
    const crashInjectors = services.testHooks.crashInjectors ?? {};
    const now = () => clock.currentTimeMillisUnsafe();
    this.#now = now;
    this.delivery = delivery;
    this.assembly = assembly;
    this.storage = storage;
    this.repository = storage.repository;
    this.runtimeEvents = services.events;
    this.execution = services.execution;
    // This Runtime instance holds its Run's accepted input, decoded once per entry.
    const conversations = new AcceptedConversations((selection) => assembly.resolve(selection));
    const readSelection = () => storage.acceptedSelection();
    const providerHangupTimeoutSetting = readRuntimeSetting(env, "PROVIDER_HANGUP_TIMEOUT_MS");
    const credentials = readRuntimeCredentials(env, assembly.credentialNames);
    this.runtimePublication = new RuntimePublication({
      execution: {
        run: (operation) => this.execution.run(operation),
        runExit: (operation) => this.execution.runExit(operation),
      },
      storage: {
        read: () => {
          const state = this.repository.readState();
          if (state === null || !hasAuthoritativeFinalization(state)) return null;
          return {
            runId: state.run_id,
            deliveryTargetJson: state.delivery_target_json ?? null,
            diagnosticsContextJson: state.diagnostics_context_json,
            aggregate: this.repository.readAggregate(state),
          };
        },
        persist: (aggregate) => this.repository.persistAggregate(aggregate, null),
      },
      events: this.runtimeEvents,
      transports: delivery,
      backgroundWork: {
        waitUntil: (task) => {
          if (typeof ctx.waitUntil === "function") ctx.waitUntil(task);
          else void task;
        },
      },
      requestAlarmRecomputation: () => this.attemptCoordinator.requestWakeUp(),
      crashInjector: crashInjectors.publication,
      now,
    });
    this.providerSession = assembly.createSession(
      {
        execution: this.execution,
        issueSink: (runId, generation) => {
          const accepted = readSelection();
          if (accepted === null) throw new Error("conversation_selection_missing");
          const selected = assembly.resolve(accepted);
          let binding:
            | Readonly<{
                key: string;
                agent: import("./implementationContracts.ts").RuntimeImplementation | undefined;
                admission: import("./implementationContracts.ts").ConversationAdmission;
                acceptsFailure(): boolean;
              }>
            | undefined;
          const readBinding = (
            observation?:
              | import("./interviewFinalizationModel.ts").ProviderFinalizationObservation
              | null,
          ) => {
            const row = this.repository.requireState(runId);
            const snapshot = this.repository.readConversationSnapshot(row);
            const visit = hasAuthoritativeFinalization(row)
              ? this.repository.readAggregate(row).conversationVisit
              : snapshot === null
                ? undefined
                : {
                    state: snapshot.initialState,
                    context: snapshot.initialContext,
                    revision: 0,
                    visitId: snapshot.visitId,
                    operationId: snapshot.operationId,
                  };
            if (visit === undefined) return undefined;
            const key = `${visit.state}:${visit.visitId}:${visit.operationId}`;
            if (binding?.key === key) return binding;
            if (binding !== undefined && observation !== undefined && (visit.revision ?? 0) > 0) {
              const responseId =
                observation !== null && "responseId" in observation
                  ? observation.responseId
                  : undefined;
              const response =
                responseId === undefined || !hasAuthoritativeFinalization(row)
                  ? undefined
                  : this.repository
                      .readAggregate(row)
                      .providerResponses.find((candidate) => candidate.responseId === responseId);
              const scope = response?.conversationScope;
              if (
                !(observation?.kind === "reply_started" && response === undefined) &&
                !(
                  scope != null &&
                  scope.visitId === visit.visitId &&
                  scope.operationId === visit.operationId &&
                  scope.generation === generation
                )
              )
                return undefined;
            }
            const identity = {
              runId,
              generation,
              visitId: visit.visitId,
              operationId: visit.operationId,
            };
            const current = (
              issued: import("./executionContracts.ts").ExecutionIdentity,
              failure = false,
            ) => {
              const currentRow = this.repository.readState();
              if (
                currentRow?.run_id !== issued.runId ||
                currentRow.session_generation !== issued.generation ||
                (currentRow.phase !== "setup" &&
                  currentRow.phase !== "live" &&
                  !(failure && currentRow.phase === "ending"))
              )
                return false;
              const currentSnapshot = this.repository.readConversationSnapshot(currentRow);
              const currentVisit = hasAuthoritativeFinalization(currentRow)
                ? this.repository.readAggregate(currentRow).conversationVisit
                : currentSnapshot === null
                  ? undefined
                  : {
                      state: currentSnapshot.initialState,
                      visitId: currentSnapshot.visitId,
                      operationId: currentSnapshot.operationId,
                    };
              return (
                currentVisit !== undefined &&
                (failure || currentVisit.state === visit.state) &&
                currentVisit.visitId === issued.visitId &&
                currentVisit.operationId === issued.operationId
              );
            };
            const admission = selected.bindVisit(visit.state, identity, current, visit.context);
            binding = {
              key,
              admission,
              agent: admission.implementation,
              acceptsFailure: () => current(identity, true),
            };
            return binding;
          };
          // Capture the operation before acquisition, including failures that occur
          // before any native receipt. Later teardown never refreshes this fence.
          readBinding();
          return (fact) => {
            const issued =
              fact.kind === "provider_observation" ? readBinding(fact.observation) : binding;
            if (fact.kind === "failure" && issued !== undefined && !issued.acceptsFailure())
              return Promise.resolve();
            // A report Runtime cannot save is fenced like a failure fact: by the visit bound
            // last, which a report from outside the current visit leaves in place.
            return this.#applyProviderSessionFact(
              fact,
              issued?.agent,
              issued?.admission,
              () => binding?.acceptsFailure() ?? true,
            );
          };
        },
        credentials,
        connectionProfile: () => this.#startProfile(),
        hangupTimeoutSetting:
          typeof providerHangupTimeoutSetting === "string"
            ? providerHangupTimeoutSetting
            : undefined,
        storage: {
          read: () => this.#readProviderSessionRecord(),
          claimOpening: (runId) => this.repository.claimOpening(runId),
          markOpeningSent: (runId) => this.repository.markOpeningSent(runId),
          recordSessionIdentity: (input) =>
            this.execution.run(
              Effect.gen(function* () {
                const state = self.repository.requireState(input.runId);
                const requiresCleanupWake =
                  state.phase === "failed" &&
                  state.live_at === null &&
                  state.session_id !== input.sessionId;
                const preliminaryWake = requiresCleanupWake
                  ? yield* Effect.exit(storage.requestAlarm(now()))
                  : Exit.succeed(undefined);
                // Re-read after the alarm handoff. The admitted native create operation
                // may attach an identity only to its still-current attempt.
                const current = self.repository.requireState(input.runId);
                if (
                  current.provider_creation_started !== 1 ||
                  (current.session_id !== null && current.session_id !== input.sessionId)
                ) {
                  throw new Error("session_identity_conflict");
                }
                // Preserve the known identity even when the preliminary alarm write failed.
                self.repository.recordSessionIdentity(input);
                crashInjectors.providerIdentity?.("after_identity_persisted");
                yield* self.attemptCoordinator.scheduleFailedStartWork();
                yield* self.attemptCoordinator.requestWakeUp();
                if (Exit.isFailure(preliminaryWake))
                  return yield* Effect.failCause(preliminaryWake.cause);
              }),
            ),
          recordSessionReply: (input) => this.repository.recordSessionReply(input),
          setGeneration: (runId, generation) =>
            this.repository.setSessionGeneration(runId, generation),
          markStarted: (runId, startedAt) => this.repository.markSessionConnected(runId, startedAt),
          markClosed: (runId, closedAt) => this.repository.markSessionDisconnected(runId, closedAt),
          scheduleWake: (runId, wakeAt) => this.repository.scheduleExecutionWake(runId, wakeAt),
          hasEventIdentity: (providerEventId) =>
            this.repository.hasProviderEventIdentity(providerEventId),
          recordExecutionState: (runId, executionState) =>
            this.repository.recordExecutionState(runId, JSON.stringify(executionState)),
        },
        events: this.runtimeEvents,
        backgroundWork: {
          waitUntil: (task) => {
            if (typeof ctx.waitUntil === "function") ctx.waitUntil(task);
            else void task;
          },
        },
        sink: (fact) => this.#applyProviderSessionFact(fact),
      },
      readSelection,
    );
    this.finalizationCoordinator = new InterviewFinalizationCoordinator({
      execution: this.execution,
      background: (task) => ctx.waitUntil(task),
      storage: {
        repository: this.repository,
        requestAlarm: (wakeAt) => storage.requestAlarm(wakeAt, true),
      },
      provider: this.providerSession,
      publication: this.runtimePublication,
      events: this.runtimeEvents,
      now,
      effectCrashInjector: crashInjectors.effect,
      selectedAgent: () => {
        const state = this.repository.requireState();
        const snapshot = this.repository.readConversationSnapshot(state);
        return snapshot === null ? undefined : conversations.select(state.run_id, snapshot);
      },
      nodeNative: {
        enterNode: (input, admission) => {
          if (this.providerSession.enterNode === undefined)
            throw new Error("conversation_node_execution_unavailable");
          this.providerSession.enterNode(input, admission);
        },
        containNode: () => this.providerSession.containNode?.(),
      },
    });
    this.attemptCoordinator = new InterviewAttemptCoordinator({
      execution: this.execution,
      storage,
      finalization: this.finalizationCoordinator,
      conversationCleanup: new ConversationSetupCleanup(
        this.repository,
        this.providerSession,
        this.runtimeEvents,
      ),
      publication: this.runtimePublication,
      events: this.runtimeEvents,
      background: (task) => ctx.waitUntil(task),
      now,
    });
    this.startupCoordinator = new InterviewStartupCoordinator({
      execution: this.execution,
      attempt: this.attemptCoordinator,
      resolveImplementation: (selection) => assembly.resolve(selection),
      connectionSetup: (selection, profile) => assembly.connectionSetup(selection, profile),
      missingCredentials: (selection, settings) =>
        assembly.missingCredentials(selection, credentials, settings),
      conversations,
      connectionImplementation:
        connectionImplementation === undefined
          ? undefined
          : startupConnectionImplementation(connectionImplementation),
      provider: this.providerSession,
      repository: this.repository,
      events: this.runtimeEvents,
      finalization: {
        initialize: createLiveInterviewFinalizationAggregate,
      },
      now,
      background: (task) => ctx.waitUntil(task),
      alarmRequests: {
        request: () => this.attemptCoordinator.requestWakeUp(),
      },
      readiness: {
        notify: (input) =>
          Effect.suspend(() => {
            const state = this.repository.requireState(input.runId);
            const target = decodeRetainedDeliveryTarget(state.delivery_target_json ?? null);
            return deliverInterviewReadiness({
              ...input,
              deliver: (request, signal) => delivery.deliver(target, "readiness", request, signal),
            });
          }),
      },
    });
    this.ready = ctx.blockConcurrencyWhile(() =>
      this.#runtime.runPromise(
        Effect.gen(function* () {
          self.storage.initialize();
          let restored: ReturnType<InterviewFinalizationRepository["readState"]>;
          try {
            restored = self.repository.readState();
          } catch (error) {
            // Initialization already records invalid persisted evidence. Keep it
            // untouched and let each public operation fail closed on the same read.
            if (error instanceof Error && error.message === "invalid_finalization_state") return;
            throw error;
          }
          const restoredDispatch =
            restored?.phase === "live"
              ? self.repository.readAggregate(restored).conversationNodeExecution?.dispatch
              : undefined;
          if (
            restored !== null &&
            (restored.provider_creation_started === 1 || restored.session_id !== null) &&
            restored.conversation_selection_json == null
          )
            throw new Error("conversation_selection_missing");
          if (restored?.conversation_selection_json != null) {
            const snapshot = decodeConversationSnapshot(
              JSON.parse(restored.conversation_selection_json),
            );
            // Reconstruction is a Runtime entry: the retained input is decoded once here.
            const { agent: selected, accepted } = conversations.select(restored.run_id, snapshot);
            validateConversationDefinition(selected.conversation);
            if (
              selected.conversation.context !== undefined &&
              !isSameJson(accepted.initialContext, snapshot.initialContext)
            )
              throw new Error("conversation_initial_context_invalid");
            const expectedInput = accepted.selectInput(snapshot.initialState, {
              runId: restored.run_id,
              context: snapshot.initialContext,
            });
            if (
              snapshot.initialNodeInput === undefined ||
              !isSameJson(snapshot.initialNodeInput, expectedInput)
            )
              throw new Error("conversation_node_input_invalid");
            if (requireConversationState(selected.conversation, snapshot.initialState) === null)
              throw new Error("conversation_definition_invalid");
            if (
              (restored.phase === "live" ||
                restored.phase === "ending" ||
                restored.phase === "ended") &&
              hasAuthoritativeFinalization(restored)
            ) {
              // The aggregate owns the current visit; the snapshot keeps only the initial one.
              const visit = self.repository.readAggregate(restored).conversationVisit;
              if (visit === undefined) throw new Error("conversation_visit_unavailable");
              selected.conversation.context?.schema.parse(visit.context);
              if (
                selected.conversation.context !== undefined &&
                requireConversationState(selected.conversation, visit.state) !== null
              )
                accepted.selectInput(visit.state, {
                  runId: restored.run_id,
                  context: visit.context,
                });

              assembly.validateState(snapshot.selection, visit.state);
              requireConversationState(selected.conversation, visit.state);
              if (restored.phase === "live") {
                const aggregate = self.repository.readAggregate(restored);
                const timing = aggregate.conversationNodeExecution;
                const dispatch = timing?.dispatch;
                if (timing === undefined || timing.kind === "ordinary") {
                  if (dispatch === undefined || dispatch.status === "pending") {
                    // Renewing the visit's operation renews the pending dispatch's identity too.
                    self.repository.persistAggregate(
                      {
                        ...aggregate,
                        conversationVisit: {
                          ...visit,
                          operationId: crypto.randomUUID(),
                          revision: (visit.revision ?? 0) + 1,
                        },
                      },
                      null,
                    );
                  } else if (
                    timing !== undefined &&
                    (dispatch.status === "claimed" || dispatch.status === "dispatched")
                  ) {
                    // Revoke old control synchronously; the uncertain native attempt is never replayed.
                    self.repository.persistAggregate(
                      {
                        ...aggregate,
                        conversationNodeExecution: {
                          ...timing,
                          dispatch: updateNodeDispatch(dispatch, {
                            status: "uncertain",
                            limitation: "conversation_recovery_uncertain",
                          }),
                        },
                      },
                      null,
                    );
                  }
                }
              }
            }
          }
          if (
            restored?.phase === "live" &&
            self.repository.readAggregate(restored).conversationNodeExecution !== undefined
          ) {
            self.finalizationCoordinator.retainReconstructedNodeEvidence();
            const node = self.repository.readAggregate().conversationNodeExecution;
            if (isFinishingNode(node) && node.participantEnd !== undefined)
              yield* dieOnNodeDispatchClaimFailure(
                self.finalizationCoordinator.recoverNodeExecution(),
              );
            yield* dieOnNodeDispatchClaimFailure(
              self.finalizationCoordinator.applyOverdueWorkBeforeIncoming(
                "runtime_failure",
                { id: "incoming:reconstruction", kind: "runtime_failure" },
                now(),
                { deferNodeDispatch: true },
              ),
            );
          }
          if (restoredDispatch !== undefined && restoredDispatch.status !== "pending")
            yield* dieOnNodeDispatchClaimFailure(
              self.finalizationCoordinator.recoverNodeExecution(),
            );
          self.finalizationCoordinator.initializeRestoredState();
          yield* dieOnNodeDispatchClaimFailure(self.finalizationCoordinator.recoverNodeExecution());
          yield* self.attemptCoordinator.requestWakeUp();
        }).pipe(this.execution.enter),
      ),
    );
  }

  /** Releases what this instance's runtime owns, including its native execution. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.#runtime.dispose();
  }

  #startRuntime(request: ControllerRequest = {}) {
    const self = this;
    return Effect.gen(function* () {
      yield* Effect.promise(() => self.ready);
      const runId = yield* readRunId(request.runId);
      // Every Run starts with an accepted Conversation selection, before any side effect.
      const conversation = yield* readStartConversation(request);
      yield* collaborate(() =>
        self.assembly.validateInput(conversation.selection, conversation.execution.agentInput),
      );
      const target =
        request.deliveryTarget === undefined
          ? undefined
          : decodeRuntimeDeliveryTarget(request.deliveryTarget);
      if (self.repository.readState() === null && target !== undefined) {
        const expiresAt =
          typeof request.startupExpiresAt === "number"
            ? request.startupExpiresAt
            : self.#now() + 4_000;
        yield* collaborateAsync(() => self.delivery.authorize(target, runId, expiresAt));
      }
      const result = yield* collaborateEffect(
        self.startupCoordinator.startRuntime(
          runId,
          (): RuntimeStartInput => ({
            ...readRuntimeSetupInput(runId, request, self.#now()),
            ...conversation,
          }),
          target,
        ),
      );
      return {
        created: result.created,
        state: self.#toControllerState(result.state),
      };
    });
  }

  /**
   * The connection profile of the Run's start. A Run started without a connection exchange
   * (the controller's `/start`) retains none: it is the Realtime profile's. So is a start whose
   * state is unreadable, whose cleanup then stays the Realtime hangup it always was.
   */
  #startProfile(): string {
    try {
      return this.repository.readState()?.conversation_profile ?? realtimeConnectionProfile;
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_finalization_state")
        return realtimeConnectionProfile;
      throw error;
    }
  }

  #startSession(
    request: ControllerRequest,
  ): Effect.Effect<RuntimeConnectionResult, RuntimeRequestFailure> {
    const self = this;
    return Effect.gen(function* () {
      yield* Effect.promise(() => self.ready);

      const parsedRequest = parseRuntimeStartRequest(request);

      if (!parsedRequest.ok) {
        return yield* Effect.fail(new RuntimeRequestInvalid(parsedRequest.error));
      }

      // The HTTP/RPC decoder returns an owned value; it is used without another copy.
      const runtimeStartRequest = parsedRequest.value;
      yield* collaborate(() =>
        self.assembly.validateInput(
          runtimeStartRequest.selection,
          runtimeStartRequest.execution.agentInput,
        ),
      );
      // The selected execution refuses settings it cannot prepare, before any provider work.
      const prepared = yield* collaborate(() =>
        prepareExecutionSettings(self.assembly.resolve(runtimeStartRequest.selection), {
          reasoningEffort: runtimeStartRequest.reasoningEffort ?? null,
          requested: runtimeStartRequest.executionSettings,
        }),
      );
      // The selected combination refuses to start without the credentials of the providers
      // its prepared settings choose.
      yield* collaborate(() =>
        self.startupCoordinator.requireStartable(runtimeStartRequest.selection, prepared),
      );
      const deliveryTarget = runtimeStartRequest.deliveryTarget;
      const existing = self.repository.readState();
      if (
        existing !== null &&
        JSON.stringify(deliveryTarget ?? null) !== (existing.delivery_target_json ?? "null")
      )
        return yield* Effect.fail(new RuntimeRequestRefused("runtime_delivery_target_conflict"));
      if (existing === null && deliveryTarget !== undefined) {
        yield* collaborateAsync(() =>
          self.delivery.authorize(
            deliveryTarget,
            runtimeStartRequest.runId,
            runtimeStartRequest.startupExpiresAt ?? self.#now() + 4_000,
          ),
        );
      }
      // Keep the persisted diagnostic origin stable; the application's creation is not liveAt.
      const startedAt = readTimestamp(runtimeStartRequest.createdAt, self.#now());
      const readSetup = () => {
        const setup = {
          runId: runtimeStartRequest.runId,
          createdAt: self.#now(),
          startedAt,
          fakeSessionId: null,
          startupExpiresAt: runtimeStartRequest.startupExpiresAt,
          diagnosticsContext: readDiagnosticsContext(runtimeStartRequest.diagnosticsContext),
        };
        return runtimeStartRequest.deliveryTarget === undefined
          ? setup
          : { ...setup, deliveryTarget: runtimeStartRequest.deliveryTarget };
      };
      return yield* collaborateEffect(
        self.startupCoordinator.startConnection(runtimeStartRequest, readSetup),
      );
    });
  }

  fetch(request: Request): Promise<Response> {
    const self = this;
    const url = new URL(request.url);
    let requestedRunId: string | null = null;

    const operation = Effect.gen(function* () {
      if (request.method === "POST" && url.pathname === "/resolve-application-acceptance") {
        const input = decodeRuntimeAcceptanceRequest(yield* Effect.promise(() => request.json()));
        yield* Effect.promise(() => self.ready);
        return Response.json({
          runId: input.runId,
          acceptance: yield* collaborate(() =>
            self.repository.resolveApplicationAcceptance(input.runId),
          ),
        });
      }

      if (request.method === "POST" && url.pathname === "/start") {
        return Response.json(yield* self.#startRuntime(yield* readOptionalJsonObject(request)));
      }

      if (request.method === "POST" && url.pathname === "/connection") {
        yield* collaborate(() => self.startupCoordinator.requireConnectionAvailable());
        const input = yield* readJsonObject(request);
        const runId = yield* readRunId(input.runId);
        requestedRunId = runId;
        const connection = yield* Effect.try({
          try: () => decodeRuntimeConnectionExchange(input.connection),
          catch: () => new RuntimeRequestInvalid("invalid_runtime_controller_request"),
        });
        yield* Effect.promise(() => self.ready);
        // Every later failure, defects included, answers this exchange.
        const startInput = yield* Effect.exit(self.#readConnectionStart(input, runId, connection));
        if (Exit.isFailure(startInput))
          return self.#connectionFailure(runId, connection.exchangeId, startInput.cause, false);
        const outcome = yield* Effect.exit(self.#startSession(startInput.value));
        if (Exit.isFailure(outcome))
          return self.#connectionFailure(runId, connection.exchangeId, outcome.cause, true);
        return conversationConnectionResponse(outcome.value);
      }
      if (request.method === "GET" && url.pathname === "/diagnostics") {
        yield* Effect.promise(() => self.ready);
        const runId = yield* readRunId(url.searchParams.get("runId"));
        yield* collaborate(() => self.repository.requireState(runId));
        const cursor = Number(url.searchParams.get("cursor") ?? "0");
        if (!Number.isSafeInteger(cursor) || cursor < 0)
          return yield* Effect.fail(new RuntimeRequestInvalid("invalid_diagnostic_cursor"));
        return Response.json(self.runtimeEvents.readDiagnostics(runId, cursor));
      }

      if (request.method === "GET" && url.pathname === "/events") {
        yield* Effect.promise(() => self.ready);
        const runId = yield* readRunId(url.searchParams.get("runId"));
        const state = yield* collaborate(() => self.repository.requireState(runId));
        const sessionId = url.searchParams.get("sessionId")?.trim() || null;
        const durationMs = parseObserveDurationMs(url.searchParams.get("durationMs"));
        if (durationMs === null)
          return yield* Effect.fail(new RuntimeRequestInvalid("invalid_duration_ms"));
        if (sessionId !== null && state.session_id !== null && sessionId !== state.session_id) {
          return yield* Effect.fail(new RuntimeRequestConflict("session_mismatch"));
        }
        if (
          state.session_id !== null &&
          (state.phase === "setup" || self.finalizationCoordinator.requiresProviderConnection())
        ) {
          self.providerSession.ensureConnected(state.session_id);
        }
        return self.runtimeEvents.createStreamResponse(runId, durationMs, request.signal);
      }

      if (request.method === "POST" && url.pathname === "/fake-control-ready") {
        return Response.json(
          yield* self.#markFakeControlReady(yield* readOptionalJsonObject(request)),
        );
      }

      if (request.method === "POST" && url.pathname === "/complete") {
        const result = yield* self.#completeRuntime(yield* readJsonObject(request));
        return Response.json(result, {
          status:
            result.accepted || (result.completion === undefined && result.ending === true)
              ? 202
              : 200,
        });
      }

      if (request.method === "POST" && url.pathname === "/media-ready") {
        const payload = yield* readJsonObject(request);
        const runId = yield* readRunId(payload.runId);
        const state = yield* collaborate(() => self.repository.requireState(runId));
        if (state.phase === "setup" || state.phase === "live") {
          const expired = yield* collaborateEffect(
            self.finalizationCoordinator.applyOverdueWorkBeforeIncoming(
              "inbound_request",
              { id: "incoming:media_ready", kind: "inbound_request" },
              self.#now(),
            ),
          );
          if (!expired) {
            yield* collaborate(() => self.repository.recordBrowserMediaReady(runId, self.#now()));
            if (
              state.session_id !== null &&
              self.finalizationCoordinator.requiresProviderConnection()
            )
              self.providerSession.ensureConnected(state.session_id);
            yield* collaborateAsync(() => self.providerSession.trySendOpening());
          } else
            yield* collaborateEffect(self.finalizationCoordinator.executeSelectedRuntimeWork());
          yield* collaborateEffect(self.attemptCoordinator.requestWakeUp());
        }
        return Response.json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/attachment") {
        // The Run's selected execution session owns its browser media attachment.
        yield* Effect.promise(() => self.ready);
        const runId = yield* readRunId(url.searchParams.get("runId"));
        yield* collaborate(() => self.repository.requireState(runId));
        return yield* collaborateAsync(() => self.providerSession.attachBrowser(request));
      }

      if (request.method === "POST" && url.pathname === "/presence") {
        return Response.json(yield* self.#recordPresence(yield* readJsonObject(request)));
      }

      if (request.method === "POST" && url.pathname === "/required-stop") {
        const input = decodeRuntimeRequiredStopRequest(yield* Effect.promise(() => request.json()));
        return Response.json(yield* self.#acceptRequiredStop(input.runId));
      }

      if (request.method === "GET" && url.pathname === "/state") {
        const runId = url.searchParams.get("runId");
        return Response.json(
          yield* self.#getRuntimeState(
            runId === null
              ? {}
              : {
                  runId,
                },
          ),
        );
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    });
    const respond = (error: string, status: number, defect: boolean) =>
      Effect.sync(() => {
        if (url.pathname === "/connection")
          this.#recordStartFailure({
            runId: requestedRunId,
            operation: "connection",
            error,
            status,
            defect,
            acceptance: undefined,
          });
        return Response.json({ error }, { status });
      });
    const answer = (failure: RuntimeRequestFailure) =>
      respond(failure.code, requestFailureStatus(failure), false);
    // Every expected failure is mapped here. An unmapped one fails this assignment.
    const answered: Effect.Effect<Response, never> = operation.pipe(
      Effect.tapCause((cause) =>
        Effect.sync(() => {
          try {
            this.runtimeEvents.recordEvent("runtime.execution_failed", {
              source: "runtime_controller",
              operation: "fetch",
              failure: Cause.hasFails(cause),
              defect: Cause.hasDies(cause),
              interruption: Cause.hasInterrupts(cause),
            });
          } catch {
            // Diagnostics cannot replace the original Cause or its boundary mapping.
          }
        }),
      ),
      Effect.catchTags({
        RuntimeRequestInvalid: answer,
        RuntimeRunNotStarted: answer,
        RuntimeRequestConflict: answer,
        RuntimeDeliveryRefused: answer,
        RuntimeUnavailable: answer,
        RuntimeProviderFailed: answer,
        RuntimeRequestRefused: answer,
      }),
    );
    return this.#runtime.runPromise(
      answered.pipe(
        // Defects and interruption remain distinct from expected failures.
        Effect.catchCause((cause) => respond(toDefectCode(Cause.squash(cause)), 500, true)),
        Effect.ensuring(Effect.sync(() => this.providerSession.reconcileLifetime())),
        Effect.scoped,
        this.execution.enter,
      ),
    );
  }

  /** Reads the start input of a connection exchange, from the request or the retained start. */
  #readConnectionStart(
    input: ControllerRequest,
    runId: string,
    connection: RuntimeConnectionExchange,
  ): Effect.Effect<ControllerRequest, RuntimeRequestFailure> {
    const self = this;
    return Effect.gen(function* () {
      if (input.execution !== undefined) return input;
      const state = yield* collaborate(() => self.repository.requireState(runId));
      if (state.conversation_start_json === null)
        return yield* Effect.fail(new RuntimeRequestConflict("retained_connection_start_missing"));
      const retained = parseRuntimeStartRequest(JSON.parse(state.conversation_start_json));
      if (!retained.ok)
        return yield* Effect.fail(new RuntimeRequestRefused("retained_connection_start_invalid"));
      const reconstructed: unknown = JSON.parse(JSON.stringify({ ...retained.value, connection }));
      return z.record(z.string(), runtimeJsonValueSchema).parse(reconstructed);
    });
  }

  /**
   * Answers a failed connection exchange. Once its start was attempted, only a refusal
   * proves that the Run was not accepted; otherwise acceptance is unresolved.
   */
  #connectionFailure(
    runId: string,
    exchangeId: string,
    cause: Cause.Cause<RuntimeRequestFailure>,
    startAttempted: boolean,
  ): Response {
    const failure = Cause.findErrorOption(cause);
    const state = this.repository.readState();
    const refused = Option.isSome(failure) && refusesConnectionAcceptance(failure.value);
    const output: RuntimeConnectionResult = {
      runId,
      exchangeId,
      acceptance:
        state?.run_id === runId
          ? "accepted"
          : !startAttempted || refused
            ? "not_accepted"
            : "unresolved",
      error: Option.isSome(failure) ? failure.value.code : toConnectionDefectCode(cause),
    };
    const status = Option.isSome(failure) ? requestFailureStatus(failure.value) : 500;
    this.#recordStartFailure({
      runId,
      operation: "connection",
      exchangeId,
      error: output.error ?? "runtime_failed",
      status,
      defect: Option.isNone(failure),
      acceptance: output.acceptance,
    });
    return conversationConnectionResponse(output, status);
  }

  /**
   * Records why a start or connection exchange failed and the startup stage it failed at.
   * The controller event exists even when no Run was accepted; an accepted Run also gets the
   * diagnostic record that applications recover.
   */
  #recordStartFailure(
    input: Readonly<{
      runId: string | null;
      operation: string;
      exchangeId?: string;
      error: string;
      status: number;
      defect: boolean;
      acceptance: RuntimeConnectionResult["acceptance"] | undefined;
    }>,
  ): void {
    try {
      const payload = withoutUndefined({
        source: "runtime_controller",
        runId: input.runId ?? undefined,
        operation: input.operation,
        exchangeId: input.exchangeId,
        error: input.error,
        status: input.status,
        failure: input.defect ? "defect" : "refusal",
        acceptance: input.acceptance,
        stage: startFailureStage(this.repository.readState(), input.runId),
      });
      this.runtimeEvents.recordEvent("runtime.start_failed", payload);
      this.runtimeEvents.recordDiagnostic("runtime.start_failed", payload);
    } catch {
      // Diagnostics cannot replace the answer to the failed request.
    }
  }

  #markFakeControlReady(request: ControllerRequest = {}) {
    const self = this;
    return Effect.gen(function* () {
      yield* Effect.promise(() => self.ready);

      const runId = yield* readRunId(request.runId);
      const state = yield* collaborate(() => self.repository.requireState(runId));

      if (state.phase === "setup") {
        self.runtimeEvents.recordEvent("session.control_sent", {
          controlType: "fake_control_ready",
        });
        yield* collaborateEffect(
          self.startupCoordinator.markLive(runId, readTimestamp(request.now, self.#now())),
        );
      }

      yield* collaborateEffect(self.attemptCoordinator.requestWakeUp());

      return {
        state: self.#toControllerState(
          yield* collaborate(() => self.repository.requireState(runId)),
        ),
      };
    });
  }

  #completeRuntime(
    request: ControllerRequest = {},
  ): Effect.Effect<CompleteRuntimeResult, RuntimeRequestFailure> {
    const self = this;
    return Effect.gen(function* () {
      yield* Effect.promise(() => self.ready);
      const finalTurnFlush = readFinalTurnFlush(request.finalTurnFlush);
      const microphoneStoppedAt = readMicrophoneStoppedAt(request.microphoneStoppedAt);
      const runId = yield* readRunId(request.runId);
      const endReason = yield* readEndReason(request.endReason);
      const source =
        typeof request.source === "string" && request.source.length > 0
          ? request.source
          : "browser_request";
      const state = yield* collaborate(() => self.repository.requireState(runId));
      const now = self.#now();

      if (microphoneStoppedAt !== undefined) {
        self.runtimeEvents.recordUniqueDiagnostic(
          "runtime.microphone_stopped",
          () => true,
          { source: "browser", microphoneStoppedAt },
          { observedAt: microphoneStoppedAt },
        );
      }
      if (!hasAuthoritativeFinalization(state)) {
        return {
          accepted: false,
          ending: false,
          idempotent: false,
          conflict: false,
          state: toControllerState(state, null),
        };
      }

      const decision = yield* collaborateEffect(
        self.finalizationCoordinator.acceptObservation({
          kind: "end_requested",
          reason: endReason,
          source,
          at: now,
        }),
      );
      if (finalTurnFlush !== undefined) {
        self.runtimeEvents.recordDiagnostic(
          "runtime.final_turn_flush_finished",
          { source: "runtime_controller", ...finalTurnFlush },
          { observedAt: now },
        );
      }
      const currentState = yield* collaborate(() => self.repository.requireState(runId));
      const currentAggregate = self.repository.readAggregate(currentState);
      const publicFinalization = projectInterviewFinalizationPublicState(currentAggregate);
      const currentReason =
        publicFinalization.stage === "live"
          ? null
          : readFinalizationEndReason(currentAggregate.state);
      // A Stop for a Run that has already ended, as from a page that leaves it, changes nothing
      // and is no ending conflict.
      if (currentReason !== null && currentReason !== endReason && !publicFinalization.terminal) {
        self.runtimeEvents.recordUniqueDiagnostic(
          "runtime.ending_conflict",
          (payload) =>
            payload.authoritativeEndReason === currentReason &&
            payload.requestedEndReason === endReason,
          {
            source: "runtime_controller",
            authoritativeEndReason: currentReason,
            requestedEndReason: endReason,
            requestedTrigger: toEndingTrigger(source) ?? "runtime_request",
          },
          { observedAt: now },
        );
      }
      const result = {
        accepted: decision.accepted,
        ending: publicFinalization.phase === "ending",
        idempotent: !decision.accepted && currentReason === endReason,
        conflict: currentReason !== null && currentReason !== endReason,
        state: toControllerState(currentState, publicFinalization),
      };
      if (publicFinalization.completion === null) return result;
      return { ...result, completion: publicFinalization.completion };
    });
  }

  #recordPresence(request: ControllerRequest = {}) {
    const self = this;
    return Effect.gen(function* () {
      yield* Effect.promise(() => self.ready);

      const runId = yield* readRunId(request.runId);
      const now = readTimestamp(request.now, self.#now());
      const mediaPresent = yield* requireBoolean(
        request.mediaPresent,
        "invalid_runtime_presence_request",
      );
      let state = yield* collaborate(() => self.repository.requireState(runId));

      if (state.phase !== "live") {
        return {
          accepted: false,
          state: self.#toControllerState(state),
        };
      }

      const expired = yield* collaborateEffect(
        self.finalizationCoordinator.applyOverdueWorkBeforeIncoming(
          "presence_observation",
          { id: "incoming:presence_heartbeat", kind: "presence_renewal" },
          now,
        ),
      );
      if (expired) {
        yield* collaborateEffect(self.finalizationCoordinator.executeSelectedRuntimeWork());
        yield* collaborateEffect(self.attemptCoordinator.requestWakeUp());
        return {
          accepted: false,
          expired: true,
          state: self.#toControllerState(
            yield* collaborate(() => self.repository.requireState(runId)),
          ),
        };
      }
      state = yield* collaborate(() => self.repository.requireState(runId));

      const previousMediaPresent =
        state.presence_media_present === null ? null : state.presence_media_present === 1;
      const graceUntil = mediaPresent
        ? now + browserPresenceGraceMs
        : previousMediaPresent === false && state.presence_grace_until !== null
          ? state.presence_grace_until
          : now + browserPresenceGraceMs;

      yield* collaborate(() =>
        self.repository.recordPresence({
          runId,
          now,
          graceUntil,
          mediaPresent,
        }),
      );
      self.startupCoordinator.recordStage("firstPresence", now);

      if (!mediaPresent && previousMediaPresent !== false) {
        self.runtimeEvents.recordEvent("runtime.presence_lost", {
          source: "browser_presence",
          graceUntil,
        });
      }

      if (mediaPresent && previousMediaPresent === false) {
        self.runtimeEvents.recordEvent("runtime.presence_restored", {
          source: "browser_presence",
          graceUntil,
        });
      }

      self.runtimeEvents.recordEvent("runtime.presence_heartbeat", {
        mediaPresent,
        graceUntil,
      });
      yield* collaborateEffect(self.attemptCoordinator.requestWakeUp());

      return {
        accepted: true,
        state: self.#toControllerState(
          yield* collaborate(() => self.repository.requireState(runId)),
        ),
      };
    });
  }

  #getRuntimeState(request: ControllerRequest = {}) {
    const self = this;
    return Effect.gen(function* () {
      yield* Effect.promise(() => self.ready);

      const runId =
        typeof request.runId === "string" && request.runId.trim().length > 0
          ? request.runId.trim()
          : null;
      const state = self.repository.readState();

      if (state === null) {
        return {
          state: null,
        };
      }

      if (runId !== null && state.run_id !== runId) {
        return yield* Effect.fail(new RuntimeRequestConflict("runtime_controller_run_mismatch"));
      }

      return {
        state: self.#toControllerState(state),
      };
    });
  }

  alarm(): Promise<void> {
    const self = this;
    return this.#runtime.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() => self.ready);
        yield* self.attemptCoordinator.handleAlarm();
      }).pipe(
        Effect.ensuring(Effect.sync(() => this.providerSession.reconcileLifetime())),
        this.execution.enter,
      ),
    );
  }

  #applyProviderSessionFact(
    fact: ProviderSessionApplicationFact,
    scopedAgent?: import("./implementationContracts.ts").RuntimeImplementation,
    reportingAdmission?: import("./implementationContracts.ts").ConversationAdmission,
    acceptsFailure?: () => boolean,
  ): Promise<void> {
    // Readiness is an eager native handoff to the startup owner. Preserve its
    // completion prefix before the retained generation decides whether to open.
    const self = this;
    if (fact.kind === "execution_ready") return this.#acceptExecutionReady(fact.runId, fact.at);
    return this.execution.run(
      Effect.gen(function* () {
        switch (fact.kind) {
          case "provider_observation": {
            // A report Runtime cannot save is a Runtime failure of its message, whichever
            // execution sent it: during Live the Run ends interrupted. The report is then
            // handled, so the execution goes on to its next report.
            yield* self.#saveProviderObservation(fact, scopedAgent, reportingAdmission).pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
                // A failure that outlived its Conversation visit stays unapplied.
                if (acceptsFailure?.() === false) return Effect.void;
                const error = Cause.squash(cause);
                return self.#applyProviderFailure({
                  kind: "failure",
                  failure: "message",
                  errorText: error instanceof Error ? error.message : String(error),
                  applyRuntimeFailure: true,
                });
              }),
            );
            return;
          }
          case "failure":
            yield* self.#applyProviderFailure(fact);
            return;
          case "execution_resumed": {
            const state = self.repository.readState();
            if (state === null || !hasAuthoritativeFinalization(state)) return;
            yield* dieOnNodeDispatchClaimFailure(
              self.finalizationCoordinator.resumeExecution(fact.generation),
            );
            yield* self.finalizationCoordinator.executeSelectedRuntimeWork();
            yield* self.attemptCoordinator.requestWakeUp();
            return;
          }
          case "session_lost": {
            const reconsidered = yield* dieOnNodeDispatchClaimFailure(
              self.finalizationCoordinator.acceptSessionLost(fact.source),
            );
            if (!reconsidered) return;
            // During Ending, the reconsidered result may start the release at once.
            yield* self.finalizationCoordinator.executeSelectedRuntimeWork();
            yield* self.attemptCoordinator.requestWakeUp();
            return;
          }
          case "session_released":
            yield* dieOnNodeDispatchClaimFailure(
              self.finalizationCoordinator.acceptSessionReleased(),
            );
            yield* self.attemptCoordinator.requestWakeUp();
            return;
          case "wake_scheduled":
            yield* self.attemptCoordinator.requestWakeUp();
            return;
          case "result_warning": {
            const state = self.repository.readState();
            if (state === null || !hasAuthoritativeFinalization(state)) return;
            // Runtime publishes only the warnings the Run's combination declares.
            const selection = self.storage.acceptedSelection();
            if (
              selection === null ||
              !self.assembly.declaredWarnings(selection).includes(fact.warning)
            ) {
              self.runtimeEvents.recordDiagnostic("runtime.undeclared_warning_dropped", {
                source: "runtime_controller",
                warning: fact.warning,
              });
              return;
            }
            yield* dieOnNodeDispatchClaimFailure(
              self.finalizationCoordinator.acceptObservation(
                { kind: "execution_warning_attached", warning: fact.warning, at: self.#now() },
                undefined,
                { deferEffectExecution: true },
              ),
            );
            return;
          }
          case "message_queue_drained":
            yield* dieOnNodeDispatchClaimFailure(
              self.finalizationCoordinator.reconsiderEvidence(self.#now()),
            );
            yield* self.finalizationCoordinator.executeSelectedRuntimeWork({
              withinProviderMessageQueue: true,
            });
            yield* self.attemptCoordinator.requestWakeUp();
        }
      }).pipe(Effect.ensuring(Effect.sync(() => this.providerSession.reconcileLifetime()))),
    );
  }

  /** Saves one report from the execution and accepts its observation. */
  #saveProviderObservation(
    fact: Extract<ProviderSessionApplicationFact, { kind: "provider_observation" }>,
    scopedAgent?: import("./implementationContracts.ts").RuntimeImplementation,
    reportingAdmission?: import("./implementationContracts.ts").ConversationAdmission,
  ) {
    const self = this;
    return Effect.gen(function* () {
      const state = self.repository.requireState();
      const reported =
        fact.observation === null ? null : self.#admitDeclaredUsage(fact.observation);
      if (hasAuthoritativeFinalization(state) && reported !== null) {
        const observation = reported;
        const options: MutableObservationOptions = { deferEffectExecution: true };
        if (scopedAgent !== undefined) options.scopedAgent = scopedAgent;
        if (reportingAdmission !== undefined) options.reportingAdmission = reportingAdmission;
        const decision = yield* dieOnNodeDispatchClaimFailure(
          self.finalizationCoordinator.acceptObservation(observation, fact.persistence, options),
        );
        if (decision.transcriptChanged) void self.runtimePublication.scheduleCurrentTranscript();
      } else {
        const execution = parseRuntimeUsageAccountingState(state.runtime_usage_json);
        const evidence =
          reported === null || execution === null
            ? []
            : observeConversationUsage(reported, "setup", execution);
        self.repository.persistSetupProviderObservation(fact.persistence, evidence);
      }
    });
  }

  /**
   * Runtime's one check of an execution's usage, before anything is accounted or published: an
   * entry the Run's combination does not declare is dropped, and the usage becomes incomplete.
   */
  #admitDeclaredUsage(observation: ExecutionObservation): ExecutionObservation {
    if (!("usage" in observation) || observation.usage === undefined) return observation;
    const selection = this.storage.acceptedSelection();
    const usage = admitDeclaredUsage(
      observation.usage,
      selection === null ? [] : this.assembly.declaredUsage(selection),
    );
    return usage === observation.usage ? observation : { ...observation, usage };
  }

  /** A provider or message failure: during Live or Ending it is a Runtime failure when asked. */
  #applyProviderFailure(fact: Extract<ProviderSessionApplicationFact, { kind: "failure" }>) {
    const self = this;
    return Effect.gen(function* () {
      const state = self.repository.readState();
      if (state === null) return;
      if (state.phase === "setup") {
        self.repository.markSetupRuntimeUsageIncomplete(state.run_id);
        yield* self.startupCoordinator.applyProviderFailure(fact);
        return;
      }
      if (state.phase === "live" || state.phase === "ending") {
        self.runtimeEvents.recordLiveDegradation(
          fact.failure === "message" ? "session_message" : "session_failed",
          { source: "runtime_controller", errorText: fact.errorText },
        );
      } else {
        self.runtimeEvents.recordUniqueDiagnostic(
          "runtime.setup_failed",
          (payload) => payload.failureKind === "session_setup",
          {
            failureKind: "session_setup",
            source: "runtime_controller",
            errorText: fact.errorText,
          },
        );
      }
      if (!fact.applyRuntimeFailure) return;
      if (
        (state.phase === "live" || state.phase === "ending") &&
        hasAuthoritativeFinalization(state)
      ) {
        yield* dieOnNodeDispatchClaimFailure(
          self.finalizationCoordinator.acceptObservation(
            {
              kind: "runtime_failure_observed",
              source: fact.failure === "message" ? "session_message_failure" : "session_failure",
              at: self.#now(),
            },
            undefined,
            { deferEffectExecution: fact.failure === "message" },
          ),
        );
      }
    });
  }

  #acceptExecutionReady(runId: string, at: number): Promise<void> {
    const self = this;
    return this.execution.run(
      Effect.gen(function* () {
        const disposition = yield* self.startupCoordinator.markLive(runId, at);
        // Outside a request, a refusal of this internal stop is a defect.
        if (disposition === "failed") yield* self.#acceptRequiredStop(runId).pipe(Effect.orDie);
      }).pipe(Effect.ensuring(Effect.sync(() => this.providerSession.reconcileLifetime()))),
    );
  }

  #readProviderSessionRecord(): ProviderSessionRecord | null {
    const state = this.repository.readState();
    if (state === null) return null;
    const initialConnection = !hasAuthoritativeFinalization(state);
    const execution = initialConnection ? null : this.finalizationCoordinator.projectExecution();
    const nodeExecution =
      state.phase === "live"
        ? this.repository.readAggregate(state).conversationNodeExecution
        : undefined;
    const record: ProviderSessionRecord = {
      runId: state.run_id,
      sessionId: state.session_id,
      generation: state.session_generation,
      eventCount: state.session_event_count,
      initialConnection,
      observeAllProviderEvents: true,
      retired: state.phase === "ended" || state.phase === "failed",
      connectionRequired:
        state.phase !== "ended" &&
        state.phase !== "failed" &&
        (initialConnection || execution?.providerConnection.required === true),
      startupExpiresAt: state.startup_expires_at,
      canStartConversation: state.phase === "live",
      canSendOpening:
        state.phase === "live" &&
        !isFinishingNode(this.repository.readAggregate(state).conversationNodeExecution),
      eligibleParticipantInputIds: initialConnection
        ? []
        : (this.repository
            .readAggregate(state)
            .applicationTranscriptProof.obligations.filter((item) => item.role === "participant")
            .map((item) => item.itemId) ?? []),
      participantInputClosed:
        state.phase === "ending" ||
        state.phase === "ended" ||
        state.phase === "failed" ||
        (state.phase === "live" &&
          nodeExecution !== undefined &&
          (isFinishingNode(nodeExecution) ||
            execution?.deadlines.some(({ deadline, due }) => deadline === "timebox" && due) ===
              true)),
      browserMediaReady: state.opening_state === null || state.browser_media_ready_at !== null,
      openingState: state.opening_state === null ? "sent" : state.opening_state,
      executionState: readExecutionState(state.execution_state_json),
    };
    const snapshot = this.repository.readConversationSnapshot(state);
    if (snapshot === null) return record;
    // The provider session receives its own copy of the settings its execution prepared.
    return { ...record, preparedSettings: structuredClone(snapshot.executionSettings.prepared) };
  }

  #acceptRequiredStop(runId: string) {
    const self = this;
    return Effect.gen(function* () {
      yield* Effect.promise(() => self.ready);
      const state = self.repository.readState();
      if (state === null) {
        // The fence makes "not accepted" final: no later Start can create this Run.
        const acceptance = yield* collaborate(() =>
          self.repository.resolveApplicationAcceptance(runId),
        );
        return { runId, accepted: true, acceptance };
      }
      yield* collaborate(() => self.repository.requireState(runId));
      if (state.phase === "setup") {
        yield* collaborateEffect(self.attemptCoordinator.failSetup(runId));
      } else if (state.phase === "live" || state.phase === "ending") {
        yield* collaborateEffect(
          self.finalizationCoordinator.acceptObservation(
            {
              kind: "end_requested",
              reason: "runtime_failed",
              source: "application_startup_failed",
              at: self.#now(),
            },
            undefined,
            { deferEffectExecution: true },
          ),
        );
      }
      self.runtimeEvents.recordUniqueDiagnostic(
        "runtime.application_required_stop_accepted",
        () => true,
        {
          source: "runtime_controller",
          phase: state.phase,
        },
      );
      return { runId, accepted: true, acceptance: "accepted" as const };
    });
  }

  #toControllerState(
    row: RuntimeControllerRow,
    publicFinalization: InterviewFinalizationPublicState | null = hasAuthoritativeFinalization(row)
      ? projectInterviewFinalizationPublicState(this.repository.readAggregate(row))
      : null,
  ): Record<string, unknown> {
    return toControllerState(row, publicFinalization);
  }
}

function readFinalizationEndReason(
  state: InterviewFinalizationAggregate["state"],
): RuntimeEndReason {
  if (state.stage === "ended") return state.completion.endReason;
  if (state.stage === "live") return "runtime_failed";
  return state.endReason;
}

function toControllerState(
  row: RuntimeControllerRow,
  publicFinalization: InterviewFinalizationPublicState | null,
): Record<string, unknown> {
  return withoutUndefined({
    runId: row.run_id,
    controllerIdentity: row.controller_identity,
    runtimeId: row.runtime_id,
    phase: publicFinalization?.phase ?? row.phase,
    createdAt: row.created_at,
    startedAt: row.started_at,
    liveAt: row.live_at ?? undefined,
    deadlineAt: row.deadline_at ?? undefined,
    conversation: publicFinalization?.conversation ?? undefined,
    fakeSessionId: row.fake_session_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    sessionLocation: row.session_location ?? undefined,
    upstreamRequestId: row.upstream_request_id ?? undefined,
    settingsSummary: parseJsonObject(row.settings_summary_json) ?? undefined,
    session: {
      connectedAt: row.session_connected_at ?? undefined,
      disconnectedAt: row.session_disconnected_at ?? undefined,
      eventCount: row.session_event_count ?? 0,
      generation: row.session_generation ?? 0,
      wakeAt: row.execution_wake_at ?? undefined,
    },
    transcript: {
      turnCount: row.transcript_turn_count ?? 0,
    },
    presence: withoutUndefined({
      lastSeenAt: row.presence_last_seen_at ?? undefined,
      graceUntil: row.presence_grace_until ?? undefined,
      mediaPresent:
        row.presence_media_present === null ? undefined : row.presence_media_present === 1,
      signalCount: row.presence_signal_count ?? 0,
    }),
    pendingClose: publicFinalization?.pendingClose ?? undefined,
    completion: publicFinalization?.completion ?? undefined,
    callback: withoutUndefined({
      pending: row.callback_pending === 1,
      deliveredAt: row.callback_delivered_at ?? undefined,
      retryAt: row.callback_retry_at ?? undefined,
      attemptCount: row.callback_attempt_count,
      lastError: row.callback_last_error ?? undefined,
      publicationCutoffAt: row.failed_start_publication_cutoff_at ?? undefined,
      status:
        row.failed_start_publication_cutoff_at === null
          ? undefined
          : row.failed_start_publication_status,
    }),
    finalization:
      publicFinalization === null
        ? undefined
        : {
            stage: publicFinalization.stage,
            ending: publicFinalization.ending,
            terminal: publicFinalization.terminal,
          },
  });
}

function readRunId(value: ControllerRequestValue): Effect.Effect<string, RuntimeRequestInvalid> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return Effect.fail(new RuntimeRequestInvalid("missing_run_id"));
  }

  return Effect.succeed(value.trim());
}

const startConversationSchema = z.object({
  selection: conversationSelectionSchema,
  execution: interviewExecutionSchema,
});

/** The Start contract requires a Conversation selection and its execution input. */
function readStartConversation(
  request: ControllerRequest,
): Effect.Effect<Pick<RuntimeStartInput, "selection" | "execution">, RuntimeRequestInvalid> {
  const parsed = startConversationSchema.safeParse({
    selection: request.selection,
    execution: request.execution,
  });
  if (!parsed.success)
    return Effect.fail(new RuntimeRequestInvalid("invalid_runtime_controller_request"));
  return Effect.succeed(parsed.data);
}

/** Runs inside the startup coordinator, which reports its thrown codes to the request. */
function readRuntimeSetupInput(
  runId: string,
  request: ControllerRequest,
  now: number,
): RuntimeSetupInput {
  const createdAt = readTimestamp(request.createdAt, now);
  const setup = {
    runId,
    createdAt,
    startedAt: readTimestamp(request.startedAt, createdAt),
    fakeSessionId:
      typeof request.fakeSessionId === "string" && request.fakeSessionId.length > 0
        ? request.fakeSessionId
        : null,
    startupExpiresAt:
      typeof request.startupExpiresAt === "number" && Number.isSafeInteger(request.startupExpiresAt)
        ? request.startupExpiresAt
        : null,
    diagnosticsContext: readDiagnosticsContext(request.diagnosticsContext),
  };
  return request.deliveryTarget === undefined
    ? setup
    : {
        ...setup,
        deliveryTarget: decodeRuntimeDeliveryTarget(request.deliveryTarget),
      };
}

function readEndReason(
  value: ControllerRequestValue,
): Effect.Effect<RuntimeEndReason, RuntimeRequestInvalid> {
  if (isRuntimeEndReason(value)) {
    return Effect.succeed(value);
  }

  return Effect.fail(new RuntimeRequestInvalid("invalid_end_reason"));
}

function requireBoolean(
  value: ControllerRequestValue,
  errorCode: InvalidRequestCode,
): Effect.Effect<boolean, RuntimeRequestInvalid> {
  if (typeof value === "boolean") return Effect.succeed(value);
  return Effect.fail(new RuntimeRequestInvalid(errorCode));
}

function readTimestamp(value: ControllerRequestValue, fallback: number | (() => number)): number {
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    return value;
  }

  return typeof fallback === "function" ? fallback() : fallback;
}

function readDiagnosticsContext(value: ControllerRequestValue): RuntimeDiagnosticsContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const input = requireRecord(value);

  return withoutUndefined({
    surface: readOptionalString(input.surface),
    environment: readOptionalString(input.environment),
    appResourceKind: readOptionalString(input.appResourceKind),
    appResourceId: readOptionalString(input.appResourceId),
    runtimeControllerVersion: readOptionalString(input.runtimeControllerVersion),
  });
}

function readFinalTurnFlush(value: ControllerRequestValue): FinalTurnFlush | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = requireRecord(value);
  if (typeof input.status !== "string" || input.status.length === 0) return undefined;

  const finalTurnFlush: FinalTurnFlushDraft = { status: input.status };
  if (typeof input.inputCommitSent === "boolean") {
    finalTurnFlush.inputCommitSent = input.inputCommitSent;
  }
  const completionReviewStatus = readOptionalString(input.completionReviewStatus);
  if (completionReviewStatus !== undefined) {
    finalTurnFlush.completionReviewStatus = completionReviewStatus;
  }
  const debugText = readOptionalString(input.debugText);
  if (debugText !== undefined) finalTurnFlush.debugText = debugText;
  return finalTurnFlush;
}

function readMicrophoneStoppedAt(value: ControllerRequestValue): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readOptionalJsonObject(
  request: Request,
): Effect.Effect<ControllerRequest, RuntimeRequestInvalid> {
  if (request.body === null) {
    return Effect.succeed({});
  }

  return readJsonObject(request);
}

/** Malformed JSON remains a defect; JSON that is not an object is an invalid request. */
function readJsonObject(request: Request): Effect.Effect<ControllerRequest, RuntimeRequestInvalid> {
  return Effect.flatMap(
    Effect.promise(() => request.json<RuntimeJsonValue>()),
    (value): Effect.Effect<ControllerRequest, RuntimeRequestInvalid> =>
      value === null || typeof value !== "object" || Array.isArray(value)
        ? Effect.fail(new RuntimeRequestInvalid("invalid_runtime_controller_request"))
        : Effect.succeed(value),
  );
}

function parseJsonValue(value: string | null): RuntimeJsonValue {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = runtimeJsonValueSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseJsonObject(value: string | null): ControllerRequest | null {
  const parsed = parseJsonValue(value);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

function readOptionalString<Value>(value: Value): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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

function isRecord<Value>(value: Value): value is Value & Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord<Value>(value: Value): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parseObserveDurationMs(value: ControllerRequestValue): number | null {
  if (typeof value !== "string" || value.trim().length === 0 || !/^\d+$/.test(value.trim())) {
    return null;
  }

  const durationMs = Number(value.trim());
  return Number.isSafeInteger(durationMs) && durationMs > 0 ? durationMs : null;
}

/** The public code of a defect or interruption, as the request edge has always reported it. */
function toDefectCode<ErrorValue>(error: ErrorValue): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "runtime_failed";
}

/** The first startup stage that the durable Run does not show as reached. */
function startFailureStage(
  state: RuntimeControllerRow | null,
  runId: string | null,
): "runtimeAccepted" | "modelPrepared" | "providerCreated" | "liveAt" | "connectionReplyReceived" {
  if (state === null || state.run_id !== runId) return "runtimeAccepted";
  if (state.provider_creation_started !== 1) return "modelPrepared";
  if (state.session_id === null && state.fake_session_id === null) return "providerCreated";
  if (state.live_at === null) return "liveAt";
  return "connectionReplyReceived";
}

function toConnectionDefectCode<ErrorValue>(cause: Cause.Cause<ErrorValue>): string {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : "runtime_failed";
}

/**
 * The execution's own durable state, as Runtime stored it. Runtime keeps it for the execution:
 * it is never read here, and only the execution decodes it.
 */
function readExecutionState(
  stored: string | null | undefined,
): import("./conversationContracts.ts").ConversationCallbackJson {
  return parseJsonValue(stored ?? null);
}
