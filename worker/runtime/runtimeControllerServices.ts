/**
 * The services of one Runtime Durable Object instance.
 *
 * Each controller builds one Layer from its `ctx`, `env` and explicit host options
 * (`runtimeControllerLayer`), and one `ManagedRuntime` from that Layer, at
 * construction. No runtime is shared across Durable Objects. A service that
 * depends on other services is built with `Layer.effect`; a resource the runtime
 * owns is acquired with its release, so disposing the runtime releases it.
 *
 * Production supplies the platform, the registry assembly and the host delivery.
 * Only a test supplies `RuntimeTestHooks` with crash injectors or a controlled
 * provider driver. Omitting a Layer leaves its service required, and the
 * controller composition fails to compile.
 *
 * Synchronous SQL stays synchronous: `RunStorage` exposes the repository as it is,
 * so a claim-then-dispatch section remains one synchronous step. Alarm scheduling
 * is the storage service's Effect operation.
 */
import { Cause, Clock, Context, Effect, Layer } from "effect";
import { decodeRetainedDeliveryTarget } from "../shared/contracts/runtimeDelivery.ts";
import { applicationCallbackUrl } from "./applicationCallbacks.ts";
import type { ConversationSelection } from "../shared/contracts/conversationSelection.ts";
import type { FinalizationEffectCrashPoint } from "./interviewFinalizationEffectRunner.ts";
import {
  InterviewFinalizationRepository,
  type AggregatePersistenceCrashPoint,
  type RuntimeControllerRow,
} from "./interviewFinalizationRepository.ts";
import type { InterviewFinalizationAggregate } from "./interviewFinalizationModel.ts";
import type { RuntimePublicationCrashPoint } from "./runtimePublication.ts";
import { unavailableRuntimeDelivery, type RuntimeDelivery } from "./runtimeDelivery.ts";
import { RuntimeEvents } from "./runtimeEvents.ts";
import type { ExecutionBridge, RuntimeHostAssembly } from "./runtimeHostAssembly.ts";

/** The Durable Object instance the runtime belongs to. */
export class RuntimeHost extends Context.Service<
  RuntimeHost,
  Readonly<{ ctx: DurableObjectState }>
>()("runtime/RuntimeHost") {}

export type RuntimeControllerCrashInjectors = Readonly<{
  aggregatePersistence?: (point: AggregatePersistenceCrashPoint) => void;
  effect?: (
    point: FinalizationEffectCrashPoint,
    effect: InterviewFinalizationAggregate["state"]["effects"][number],
  ) => void;
  publication?: (point: RuntimePublicationCrashPoint) => void;
  providerIdentity?: (point: "after_identity_persisted") => void;
}>;

/**
 * Test controls. Production provides `RuntimeTestHooks.none`: no crash injection. A test's
 * controlled providers belong to the assembly's configuration, as each execution's own.
 */
export class RuntimeTestHooks extends Context.Service<
  RuntimeTestHooks,
  Readonly<{
    crashInjectors?: RuntimeControllerCrashInjectors;
  }>
>()("runtime/RuntimeTestHooks") {
  static readonly none: Layer.Layer<RuntimeTestHooks> = Layer.succeed(RuntimeTestHooks, {});
}

/** The registry-provided assembly: it resolves each pair and creates its sessions and executions. */
export class RuntimeAssembly extends Context.Service<RuntimeAssembly, RuntimeHostAssembly>()(
  "runtime/RuntimeAssembly",
) {}

/** The host's delivery authorization and transport. */
export class RunDelivery extends Context.Service<RunDelivery, RuntimeDelivery>()(
  "runtime/RunDelivery",
) {}

/** A persisted aggregate exists once the Run has gone live. */
export function hasAuthoritativeFinalization(state: RuntimeControllerRow): boolean {
  return state.finalization_state_json !== null;
}

/**
 * The Run's durable storage. The repository stays synchronous; the physical alarm is
 * reached only through `requestAlarm`. Coordinators supply durable demand, and the
 * controller turns it into alarm requests.
 */
export class RunStorage extends Context.Service<
  RunStorage,
  Readonly<{
    repository: InterviewFinalizationRepository;
    /** Creates or verifies the schema. Selection and retirement read nothing before it. */
    initialize(): void;
    /** The accepted selection, or null before initialization or for unreadable state. */
    acceptedSelection(): ConversationSelection | null;
    retired(): boolean;
    /**
     * Sets the physical alarm to `at`, or clears it for null. With `preserveEarlier`,
     * a future alarm earlier than `at` is kept.
     */
    requestAlarm(at: number | null, preserveEarlier?: boolean): Effect.Effect<void>;
  }>
>()("runtime/RunStorage") {
  static readonly layer = Layer.effect(
    RunStorage,
    Effect.gen(function* () {
      const { ctx } = yield* RuntimeHost;
      const { crashInjectors } = yield* RuntimeTestHooks;
      const clock = yield* Clock.Clock;
      const repository = new InterviewFinalizationRepository(
        ctx.storage,
        crashInjectors?.aggregatePersistence,
      );
      let initialized = false;
      return RunStorage.of({
        repository,
        initialize() {
          repository.initialize();
          initialized = true;
        },
        acceptedSelection() {
          if (!initialized) return null;
          let row: RuntimeControllerRow | null;
          try {
            row = repository.readState();
          } catch (error) {
            if (error instanceof Error && error.message === "invalid_finalization_state")
              return null;
            throw error;
          }
          return row === null
            ? null
            : (repository.readConversationSnapshot(row)?.selection ?? null);
        },
        retired() {
          if (!initialized) return false;
          const row = repository.readState();
          return row?.phase === "ended" || row?.phase === "failed";
        },
        requestAlarm: (at, preserveEarlier = false) =>
          Effect.gen(function* () {
            const current = yield* Effect.promise(() => ctx.storage.getAlarm());
            if (at === null) {
              if (current !== null) yield* Effect.promise(() => ctx.storage.deleteAlarm());
              return;
            }
            if (
              preserveEarlier &&
              current !== null &&
              current > (yield* clock.currentTimeMillis) &&
              current < at
            )
              return;
            if (current !== at) yield* Effect.promise(() => ctx.storage.setAlarm(at));
          }),
      });
    }),
  );
}

/** Runtime events and diagnostics, recorded in the Run's storage. */
export class RuntimeEventLog extends Context.Service<RuntimeEventLog, RuntimeEvents>()(
  "runtime/RuntimeEventLog",
) {
  static readonly layer = Layer.effect(
    RuntimeEventLog,
    Effect.gen(function* () {
      const { ctx } = yield* RuntimeHost;
      const { repository } = yield* RunStorage;
      const delivery = yield* RunDelivery;
      return new RuntimeEvents(
        repository,
        () => repository.eventContext(repository.readState()),
        (observation) => {
          const state = repository.readState();
          if (state?.delivery_target_json == null || delivery.diagnostic === undefined) return;
          const target = decodeRetainedDeliveryTarget(state.delivery_target_json);
          const task = delivery
            .diagnostic(
              target,
              new Request(applicationCallbackUrl("startupDiagnostic"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ runId: state.run_id, observation }),
              }),
            )
            .then(() => undefined)
            .catch(() => undefined);
          ctx.waitUntil(task);
        },
        ({ responseId }) => {
          const state = repository.readState();
          if (responseId === null || state === null || !hasAuthoritativeFinalization(state))
            return null;
          const scope = repository
            .readAggregate(state)
            .providerResponses.find(
              (response) => response.responseId === responseId,
            )?.conversationScope;
          return scope?.runId === state.run_id ? scope : null;
        },
      );
    }),
  );
}

/**
 * The selected pair's native execution bridge. It runs on this runtime's services, and
 * its native owner's Scope is acquired in this runtime's Scope: disposing the runtime
 * releases it.
 */
export class NativeExecution extends Context.Service<NativeExecution, ExecutionBridge>()(
  "runtime/NativeExecution",
) {
  static readonly layer = Layer.effect(
    NativeExecution,
    Effect.gen(function* () {
      const { ctx } = yield* RuntimeHost;
      const assembly = yield* RuntimeAssembly;
      const storage = yield* RunStorage;
      const events = yield* RuntimeEventLog;
      return yield* assembly.createExecution({
        failure: (cause) =>
          events.recordDiagnostic("runtime.execution_exit", {
            source: "runtime_controller",
            errorText: Cause.pretty(cause),
          }),
        selection: () => storage.acceptedSelection(),
        retired: () => storage.retired(),
        retainRelease: (task) => ctx.waitUntil(task),
      });
    }),
  );
}

/** Explicit host options: the registry assembly, the host delivery and, in tests only, hooks. */
export type RuntimeControllerLayerOptions = Readonly<{
  assembly: RuntimeHostAssembly;
  delivery?: RuntimeDelivery | undefined;
  testLayer?: Layer.Layer<RuntimeTestHooks> | undefined;
}>;

/** One controller's Layer: every service it declares, built once for its runtime. */
export function runtimeControllerLayer(
  ctx: DurableObjectState,
  { assembly, delivery = unavailableRuntimeDelivery, testLayer }: RuntimeControllerLayerOptions,
) {
  return NativeExecution.layer.pipe(
    Layer.provideMerge(RuntimeEventLog.layer),
    Layer.provideMerge(RunStorage.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(RuntimeHost, { ctx }),
        Layer.succeed(RuntimeAssembly, assembly),
        Layer.succeed(RunDelivery, delivery),
        testLayer ?? RuntimeTestHooks.none,
      ),
    ),
  );
}
