import { decodeConversationSnapshot } from "./conversationExecution.ts";
import type { RuntimeImplementation } from "./implementationContracts.ts";
import type {
  ExecutionSettingsPreparation,
  ExecutionSettingsSummary,
  PreparedExecutionSettings,
  SessionStartInput,
  SessionStartResult,
} from "./nativeContracts.ts";
import { isSameJson } from "./interviewFinalizationModel.ts";
import {
  connectionPayloadSchema,
  realtimeConnectionProfile,
  type RuntimeConnectionResult,
} from "../shared/contracts/runtimeConnection.ts";
import { parseJsonObject } from "./interviewFinalizationPersistenceDecoder.ts";
import { Data, Effect } from "effect";
import {
  decodeConnectionCheckpoint,
  type SelectedConnectionSetup,
  type StartupConnectionImplementation,
} from "./conversationConnection.ts";
import type {
  InterviewStartupRepository,
  RuntimeSetupInput,
  RuntimeStartInput,
  InterviewStartupEvents,
} from "./interviewStartupCoordinator.ts";
import {
  parseRuntimeStartRequest,
  type RuntimeStartRequest,
} from "../shared/contracts/runtimeStart.ts";
import type { StartupStage } from "../shared/contracts/startupDiagnostics.ts";
import {
  missingCredentialsRefusal,
  type ConversationSelection,
} from "../shared/contracts/conversationSelection.ts";
import type { RuntimeControllerRow } from "./interviewFinalizationRepository.ts";
import { redactSecrets } from "../shared/http.ts";

/** The selected execution's session, as startup starts it. */
export type InterviewStartupProvider = Readonly<{
  connected: boolean;
  start(input: SessionStartInput): Effect.Effect<SessionStartResult>;
  ensureConnected(sessionId: string): void;
  summarizeSettings?(settings: PreparedExecutionSettings): ExecutionSettingsSummary;
}>;

type SessionStartupResult = Readonly<{
  /** The profile's connection reply to the browser, such as Realtime's SDP answer. */
  reply: import("../shared/contracts/runtimeConnection.ts").ConnectionPayload;
  sessionId: string;
  sessionLocation: string | null;
  upstreamRequestId: string | null;
  settingsSummary: Readonly<Record<string, unknown>>;
}>;

/**
 * An expected startup refusal. Its code is the public error code that the Runtime
 * request edge reports; a refusal caused by a failed native step retains that cause.
 */
export class StartupRejected extends Data.TaggedError("StartupRejected")<{
  code: string;
  message: string;
  cause?: unknown;
}> {
  static refuse(code: string): StartupRejected {
    return new StartupRejected({ code, message: code });
  }
  /** A failed step's own message is its public code, as the request edge has always reported. */
  static fromError<Failure>(error: Failure): StartupRejected {
    const code =
      error instanceof Error && error.message.length > 0 ? error.message : "runtime_failed";
    return new StartupRejected({ code, message: code, cause: error });
  }
}

/** Run admission refusals that startup reports as refusals rather than native defects. */
const admissionRefusalCodes: ReadonlyArray<string> = [
  "runtime_controller_run_mismatch",
  "runtime_start_not_accepted",
];

/** The startup refusal a thrown Run admission failure stands for; null keeps it a defect. */
function classifyAdmissionRefusal<Failure>(failure: Failure): StartupRejected | null {
  if (failure instanceof StartupRejected) return failure;
  // Run admission is plain synchronous code that reports its refusals by code.
  if (failure instanceof Error && admissionRefusalCodes.includes(failure.message))
    return StartupRejected.fromError(failure);
  return null;
}

/** A thrown Run admission failure as an Effect: a refusal is typed, anything else is a defect. */
export function refuseAdmission<Failure>(failure: Failure): Effect.Effect<never, StartupRejected> {
  const refusal = classifyAdmissionRefusal(failure);
  return refusal === null ? Effect.die(failure) : Effect.fail(refusal);
}

/**
 * Starts an operation in its own detached owner, which the host retains, and returns the wait
 * for its outcome. The start is synchronous: a caller can claim and start in one step. A caller
 * that stops waiting cannot interrupt the owner.
 */
export type StartupOwnerDetach = <Value, Failure extends StartupRejected = never>(
  operation: Effect.Effect<Value, Failure>,
) => Effect.Effect<Effect.Effect<Value, Failure>>;

type ConversationStartupDependencies = Readonly<{
  connectionImplementation?: StartupConnectionImplementation | undefined;
  /** The selected entry's setup of a connection profile; an undeclared profile is unavailable. */
  connectionSetup(selection: ConversationSelection, profile: string): SelectedConnectionSetup;
  /**
   * The credentials the selected combination needs and Runtime lacks, none when it can start:
   * with the Run's prepared settings when given, whose providers may need their own.
   */
  missingCredentials(
    selection: ConversationSelection,
    settings?: PreparedExecutionSettings,
  ): readonly string[];
  /** Resolves a Run's accepted selection; the selected pair prepares its content and settings. */
  resolveImplementation(selection: ConversationSelection): RuntimeImplementation;
  provider: InterviewStartupProvider;
  events: InterviewStartupEvents;
  repository: InterviewStartupRepository;
  /** The Run clock's synchronous read. */
  now: () => number;
  attempt: Readonly<{ mayGoLive(at: number): Effect.Effect<boolean>; hasFailedStart(): boolean }>;
  /**
   * Claims or matches the Run's setup synchronously at call time, before any suspension, and
   * throws there when the claim is refused. The returned Effect completes acceptance in the
   * caller's fiber.
   */
  startRuntime(
    runId: string,
    readInput: () => RuntimeStartInput,
    target?: RuntimeSetupInput["deliveryTarget"],
  ): Effect.Effect<Readonly<{ created: boolean; state: RuntimeControllerRow }>>;
  recordStage(stage: StartupStage): void;
  failSetup(
    runId: string,
    reason: string,
    stage: StartupStage,
    cleanup: "unknown" | "not_needed" | "not_attempted",
  ): Effect.Effect<void>;
  detach: StartupOwnerDetach;
}>;

/** Owns native preparation, connection progress and replay; Run lifecycle supplies permission. */
export class ConversationStartup {
  readonly #provider: InterviewStartupProvider;
  readonly #events: InterviewStartupEvents;
  readonly #resolveImplementation: ConversationStartupDependencies["resolveImplementation"];
  readonly #repository: InterviewStartupRepository;
  readonly #now: () => number;
  readonly #attempt: ConversationStartupDependencies["attempt"];
  readonly #connectionImplementation: StartupConnectionImplementation | undefined;
  readonly #connectionSetup: ConversationStartupDependencies["connectionSetup"];
  readonly #missingCredentials: ConversationStartupDependencies["missingCredentials"];
  readonly #detach: StartupOwnerDetach;
  readonly startRuntime: ConversationStartupDependencies["startRuntime"];
  readonly recordStage: ConversationStartupDependencies["recordStage"];
  readonly failSetup: ConversationStartupDependencies["failSetup"];
  constructor(input: ConversationStartupDependencies) {
    this.#provider = input.provider;
    this.#events = input.events;
    this.#resolveImplementation = input.resolveImplementation;
    this.#repository = input.repository;
    this.#now = input.now;
    this.#attempt = input.attempt;
    this.#connectionImplementation = input.connectionImplementation;
    this.#connectionSetup = input.connectionSetup;
    this.#missingCredentials = input.missingCredentials;
    this.#detach = input.detach;
    this.startRuntime = input.startRuntime;
    this.recordStage = input.recordStage;
    this.failSetup = input.failSetup;
  }
  recordLiveDiagnostic(): void {
    const state = this.#repository.requireState();
    this.#events.recordUniqueDiagnostic("runtime.live_reached", () => true, {
      source: "runtime_controller",
      sessionId: state.session_id ?? undefined,
    });
  }
  recordSetupFailureDiagnostic(reason: string): void {
    this.#events.recordEvent("session.failed", { message: reason });
    this.#events.recordUniqueDiagnostic(
      "runtime.setup_failed",
      (payload) => payload.failureKind === "session_setup",
      {
        failureKind: "session_setup",
        source: "runtime_controller",
        errorText: reason,
      },
    );
  }

  /**
   * Refuses a selected combination that lacks its providers' credentials, naming them, before
   * any provider work: those of the providers its prepared settings choose, when given. A test's
   * connection implementation stands in for the providers.
   */
  requireStartable(selection: ConversationSelection, settings?: PreparedExecutionSettings): void {
    if (this.#connectionImplementation !== undefined) return;
    const missing = this.#missingCredentials(selection, settings);
    if (missing.length > 0) throw new Error(missingCredentialsRefusal(missing));
  }
  requireAvailable(): void {
    if (this.#connectionImplementation?.available === false)
      throw new Error("connection_profile_unavailable");
  }
  /**
   * Claims the Run's setup now, before the caller retains its Conversation start. A refused
   * claim is returned so the caller surfaces it after that retention, where it awaits acceptance.
   */
  #claimRuntime(
    request: RuntimeStartRequest,
    readSetup: () => RuntimeSetupInput,
  ):
    | Readonly<{
        claimed: true;
        acceptance: Effect.Effect<Readonly<{ created: boolean; state: RuntimeControllerRow }>>;
      }>
    | Readonly<{ claimed: false; refusal: unknown }> {
    try {
      return {
        claimed: true,
        acceptance: this.startRuntime(
          request.runId,
          () => {
            const setup = {
              ...readSetup(),
              execution: structuredClone(request.execution),
              selection: request.selection,
              reasoningEffort: request.reasoningEffort ?? null,
            };
            if (request.executionSettings !== undefined)
              setup.executionSettings = request.executionSettings;
            return setup;
          },
          request.deliveryTarget,
        ),
      };
    } catch (refusal) {
      return { claimed: false, refusal };
    }
  }
  #permitted(): Effect.Effect<boolean> {
    return Effect.suspend(() => {
      const state = this.#repository.requireState();
      if (state.phase === "live") return Effect.succeed(true);
      if (state.phase !== "setup") return Effect.succeed(false);
      return this.#attempt.mayGoLive(this.#now());
    });
  }
  /** Hands an operation to its own detached owner and waits for its outcome. */
  #observe<Value, Failure extends StartupRejected = never>(
    operation: Effect.Effect<Value, Failure>,
  ): Effect.Effect<Value, Failure> {
    return Effect.flatten(Effect.uninterruptible(this.#detach(operation)));
  }
  startConnection(
    request: RuntimeStartRequest,
    readSetup: () => RuntimeSetupInput,
  ): Effect.Effect<RuntimeConnectionResult, StartupRejected> {
    const implementation = this.#connectionImplementation;
    // The native call path starts and observes its own owner after its claim.
    if (implementation === undefined) return this.#exchangeSessionConnection(request, readSetup);
    // One owner composes every startup step, with no inner run that its interruption cannot reach.
    // Run admission refusals become startup refusals; any other failure remains a defect.
    return this.#observe(
      this.#exchangeConnection(implementation, request, readSetup).pipe(
        Effect.catchDefect(refuseAdmission),
      ),
    );
  }
  #exchangeSessionConnection(
    request: RuntimeStartRequest,
    readSetup: () => RuntimeSetupInput,
  ): Effect.Effect<RuntimeConnectionResult, StartupRejected> {
    const self = this;
    return Effect.gen(function* () {
      const connection = request.connection;
      const native = yield* self.#startSession(request, readSetup);
      const result: RuntimeConnectionResult = {
        runId: request.runId,
        exchangeId: connection.exchangeId,
        acceptance: "accepted",
        reply: native.reply,
        diagnostics: connectionPayloadSchema.parse({
          sessionId: native.sessionId,
          sessionLocation: native.sessionLocation,
          upstreamRequestId: native.upstreamRequestId,
          settingsSummary: native.settingsSummary,
        }),
      };
      return result;
    });
  }
  #exchangeConnection(
    implementation: StartupConnectionImplementation,
    request: RuntimeStartRequest,
    readSetup: () => RuntimeSetupInput,
  ): Effect.Effect<
    import("../shared/contracts/runtimeConnection.ts").RuntimeConnectionResult,
    StartupRejected
  > {
    const self = this;
    return Effect.gen(function* () {
      const connection = request.connection;
      if (!implementation.available || implementation.profile !== request.profile)
        return yield* Effect.fail(StartupRejected.refuse("connection_profile_unavailable"));
      const validation = yield* implementation.validate(connection.input);
      const prior = self.#repository.readState();
      if (
        prior?.conversation_profile != null &&
        prior.conversation_profile !== implementation.profile
      )
        return yield* Effect.fail(StartupRejected.refuse("connection_profile_unavailable"));
      if (
        prior?.connection_exchange_id === connection.exchangeId &&
        prior.connection_fingerprint !== validation.fingerprint
      )
        return yield* Effect.fail(StartupRejected.refuse("connection_exchange_conflict"));
      // The setup claim runs here; the Conversation start is retained before acceptance completes.
      const claim = self.#claimRuntime(request, readSetup);
      if (prior === null && self.#repository.readState()?.run_id === request.runId)
        self.#repository.retainConversationStart?.(request.runId, {
          profile: implementation.profile,
          startJson: JSON.stringify(request),
          exchangeId: connection.exchangeId,
          fingerprint: validation.fingerprint,
        });
      if (!claim.claimed) return yield* Effect.die(claim.refusal);
      const accepted = yield* claim.acceptance;
      const state = self.#repository.requireState(request.runId);
      if (!(yield* self.#permitted()) || self.#attempt.hasFailedStart())
        return yield* Effect.fail(StartupRejected.refuse("runtime_controller_start_failed"));
      const retainedRequest =
        state.conversation_start_json === null
          ? { ok: true as const, value: request }
          : parseRuntimeStartRequest(JSON.parse(state.conversation_start_json));
      if (!retainedRequest.ok)
        return yield* Effect.fail(StartupRejected.refuse("retained_connection_start_invalid"));
      const retained = retainedRequest.value;
      try {
        implementation.validateExecution(retained.execution);
      } catch (error) {
        yield* self.failSetup(request.runId, describeError(error), "modelPrepared", "not_needed");
        return yield* Effect.fail(StartupRejected.fromError(error));
      }
      const checkpoint =
        state.connection_checkpoint_json == null
          ? null
          : decodeConnectionCheckpoint(JSON.parse(state.connection_checkpoint_json));
      if (checkpoint?.exchangeId === connection.exchangeId) {
        if (checkpoint.fingerprint !== validation.fingerprint)
          return yield* Effect.fail(StartupRejected.refuse("connection_exchange_conflict"));
        if (checkpoint.status !== "complete")
          return yield* Effect.fail(StartupRejected.refuse("runtime_controller_start_in_progress"));
        const replay: RuntimeConnectionResult = {
          runId: request.runId,
          exchangeId: connection.exchangeId,
          acceptance: "accepted",
        };
        if (checkpoint.reply !== undefined) replay.reply = checkpoint.reply;
        if (checkpoint.diagnostics !== undefined) replay.diagnostics = checkpoint.diagnostics;
        return replay;
      }
      if (
        connection.exchangeId === state.connection_exchange_id &&
        checkpoint !== null &&
        checkpoint.exchangeId !== connection.exchangeId
      )
        return yield* Effect.fail(StartupRejected.refuse("connection_exchange_conflict"));
      if (!accepted.created && (checkpoint === null || checkpoint.status !== "complete"))
        return yield* Effect.fail(StartupRejected.refuse("runtime_controller_start_in_progress"));
      // The exchange claim and its native dispatch are one synchronous step: no fiber yield can
      // separate them. A single current exchange checkpoint is sufficient; no generic journal.
      const output = yield* Effect.suspend(() => {
        self.#repository.recordConnectionCheckpoint?.(request.runId, {
          exchangeId: connection.exchangeId,
          fingerprint: validation.fingerprint,
          status: "started",
        });
        if (accepted.created) self.#repository.markProviderCreationStarted(request.runId);
        return implementation.exchange({
          runId: request.runId,
          execution: retained.execution,
          connection,
          originalDeadline: state.startup_expires_at,
          initial: accepted.created,
        });
      });
      self.#repository.recordConnectionCheckpoint?.(request.runId, {
        exchangeId: connection.exchangeId,
        fingerprint: validation.fingerprint,
        status: "complete",
        ...output,
      });
      if (!(yield* self.#permitted()) || self.#attempt.hasFailedStart())
        return yield* Effect.fail(StartupRejected.refuse("runtime_controller_start_failed"));
      if (output.reply !== undefined)
        self.#repository.recordConnectionReply?.(request.runId, output.reply);
      const result: RuntimeConnectionResult = {
        runId: request.runId,
        exchangeId: connection.exchangeId,
        acceptance: "accepted",
        ...output,
      };
      return result;
    });
  }

  applyProviderFailure(
    fact: Readonly<{
      failure: "session" | "message";
      errorText: string;
      applyRuntimeFailure: boolean;
    }>,
  ): Effect.Effect<void> {
    return Effect.suspend(() => {
      const state = this.#repository.readState();
      if (state === null || state.phase !== "setup") return Effect.void;
      this.#events.recordUniqueDiagnostic(
        "runtime.setup_failed",
        (payload) => payload.failureKind === "session_setup",
        {
          failureKind: "session_setup",
          source: "runtime_controller",
          errorText: fact.errorText,
        },
      );
      if (!fact.applyRuntimeFailure) return Effect.void;
      return this.#observe(
        this.failSetup(
          state.run_id,
          fact.failure === "message" ? "session_message_failed_before_live" : fact.errorText,
          this.#provider.connected ? "liveAt" : "sessionConnected",
          "not_attempted",
        ),
      );
    });
  }

  #startSession(
    request: RuntimeStartRequest,
    readSetup: () => RuntimeSetupInput,
  ): Effect.Effect<SessionStartupResult, StartupRejected> {
    const self = this;
    return Effect.gen(function* () {
      const { connection, profile } = request;
      // The selected entry chooses connection setup by profile, before any provider work. A
      // profile it does not declare is unavailable.
      const setup = self.#connectionSetup(request.selection, profile);
      const validated = { profile, ...(yield* setup.validate(connection.input)) };
      const prior = self.#repository.readState();
      if (
        prior !== null &&
        prior.conversation_profile != null &&
        (prior.conversation_profile !== profile ||
          prior.connection_exchange_id !== connection.exchangeId ||
          prior.connection_fingerprint !== validated.fingerprint)
      )
        return yield* Effect.fail(StartupRejected.refuse("connection_exchange_conflict"));

      const retainedStart = {
        profile,
        startJson: JSON.stringify(request),
        exchangeId: connection.exchangeId,
        fingerprint: validated.fingerprint,
      };

      // Acceptance stays eager: the claim, the retained start and the start of the observed owner
      // that completes acceptance are one step, and the owner continues after a caller stops
      // waiting.
      const outcome = yield* Effect.uninterruptible(
        Effect.suspend(() => {
          const claim = self.#claimRuntime(request, readSetup);
          if (prior === null && self.#repository.readState()?.run_id === request.runId)
            self.#repository.retainConversationStart?.(request.runId, retainedStart);
          // A refused claim rejects this start directly; it started no owner to observe.
          if (!claim.claimed) return refuseAdmission(claim.refusal);
          return self.#detach(
            self.#completeSessionStart(request, claim.acceptance, connection.input, retainedStart),
          );
        }),
      );
      return yield* outcome;
    });
  }

  /** The observed owner of an accepted native call start. */
  #completeSessionStart(
    request: RuntimeStartRequest,
    accepted: Effect.Effect<Readonly<{ created: boolean; state: RuntimeControllerRow }>>,
    offer: SessionStartInput["connection"],
    retainedStart: Parameters<
      NonNullable<InterviewStartupRepository["retainConversationStart"]>
    >[1],
  ): Effect.Effect<SessionStartupResult, StartupRejected> {
    const self = this;
    return Effect.gen(function* () {
      const start = yield* accepted;
      self.#repository.retainConversationStart?.(request.runId, retainedStart);
      const existing = self.#repository.requireState(request.runId);
      if (existing.phase === "setup" && !(yield* self.#attempt.mayGoLive(self.#now())))
        return yield* Effect.fail(StartupRejected.refuse("runtime_controller_start_failed"));
      if (
        (existing.phase !== "setup" && existing.phase !== "live") ||
        self.#attempt.hasFailedStart()
      )
        return yield* Effect.fail(StartupRejected.refuse("runtime_controller_start_failed"));
      if (existing.session_id !== null && existing.session_reply_json !== null) {
        self.#provider.ensureConnected(existing.session_id);
        return {
          reply: connectionPayloadSchema.parse(JSON.parse(existing.session_reply_json)),
          sessionId: existing.session_id,
          sessionLocation: existing.session_location,
          upstreamRequestId: existing.upstream_request_id,
          settingsSummary: parseJsonObject(existing.settings_summary_json) ?? {},
        };
      }
      if (!start.created || existing.session_id !== null) {
        return yield* Effect.fail(StartupRejected.refuse("runtime_controller_start_in_progress"));
      }

      let opening: Pick<SessionStartInput, "content" | "settings">;
      try {
        if (existing.conversation_selection_json == null)
          throw new Error("conversation_selection_missing");
        const retained = decodeConversationSnapshot(
          JSON.parse(existing.conversation_selection_json),
        );
        const implementation = self.#resolveImplementation(retained.selection);
        const { prepared, ...choices } = retained.executionSettings;
        // The Run continues only with the settings it was set up with: settings that its
        // execution prepares differently now are refused before any provider work.
        if (!isSameJson(prepareExecutionSettings(implementation, choices), prepared))
          throw new Error("prepared_settings_mismatch");
        opening = {
          content: implementation.prepareContent({
            runId: request.runId,
            state: retained.initialState,
            nodeInput: retained.initialNodeInput,
          }),
          settings: prepared,
        };
      } catch (error) {
        yield* self.failSetup(request.runId, describeError(error), "modelPrepared", "not_needed");
        return yield* Effect.fail(StartupRejected.fromError(error));
      }

      self.recordStage("modelPrepared");
      const settingsSummary = self.#provider.summarizeSettings?.(opening.settings) ?? {};
      const undeadlinedStart: SessionStartInput = {
        runId: request.runId,
        connection: offer,
        ...structuredClone(opening),
        settingsSummary,
      };
      const sessionStart: SessionStartInput =
        existing.startup_expires_at === null
          ? undeadlinedStart
          : { ...undeadlinedStart, deadlineAt: existing.startup_expires_at };
      // The provider-creation claim and its native dispatch are one synchronous step: no fiber
      // yield can separate them. `start` dispatches the native start when called.
      const providerCall = yield* Effect.suspend(() => {
        self.#repository.markProviderCreationStarted(request.runId);
        self.recordStage("providerRequested");
        return self.#provider.start(sessionStart);
      });
      if (!providerCall.ok) {
        yield* self.failSetup(request.runId, providerCall.reason, "providerCreated", "unknown");
        return yield* Effect.fail(StartupRejected.refuse(providerCall.error));
      }
      yield* self.#attempt.mayGoLive(self.#now());
      if (self.#attempt.hasFailedStart()) {
        return yield* Effect.fail(StartupRejected.refuse("runtime_controller_start_failed"));
      }
      self.#repository.recordConnectionReply?.(request.runId, providerCall.reply);
      self.recordStage("providerCreated");
      self.#provider.ensureConnected(providerCall.sessionId);
      // A session that records its reply durably answers with it, as a replay reads it: Realtime
      // records its answer. Cascade records none, so its reply is its session's own.
      const recordedReply = self.#repository.requireState(request.runId).session_reply_json;
      if (recordedReply === null && request.profile === realtimeConnectionProfile)
        return yield* Effect.die(new Error("session_reply_missing"));
      return {
        reply:
          recordedReply === null
            ? providerCall.reply
            : connectionPayloadSchema.parse(JSON.parse(recordedReply)),
        sessionId: providerCall.sessionId,
        sessionLocation: providerCall.sessionLocation,
        upstreamRequestId: providerCall.upstreamRequestId,
        settingsSummary: providerCall.settingsSummary,
      };
    });
  }
}

function describeError<ErrorValue>(error: ErrorValue): string {
  if (error instanceof Error && error.message.length > 0) return redactSecrets(error.message);
  if (typeof error === "string" && error.length > 0) return redactSecrets(error);
  return "request failed";
}

/** The selected execution's settings for these start choices, as JSON Runtime can store. */
export function prepareExecutionSettings(
  implementation: RuntimeImplementation,
  choices: ExecutionSettingsPreparation,
): PreparedExecutionSettings {
  if (implementation.prepareSettings === undefined)
    throw new Error("conversation_native_preparation_unavailable");
  return implementation.prepareSettings(choices);
}
