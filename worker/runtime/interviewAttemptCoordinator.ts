import type { ExecutionBridge } from "./runtimeHostAssembly.ts";
import { Deferred, Effect } from "effect";
import { retainOwner } from "./runtimeHostAssembly.ts";
import { parseFailedToStartResult } from "../shared/contracts/runtimeTerminalResult.ts";
import type {
  InterviewFinalizationRepository,
  RuntimeControllerRow,
} from "./interviewFinalizationRepository.ts";
import {
  dieOnNodeDispatchClaimFailure,
  type InterviewFinalizationCoordinator,
} from "./interviewFinalizationCoordinator.ts";
import type { ConversationSetupCleanup } from "./conversationSetupCleanup.ts";
import type { RuntimePublication } from "./runtimePublication.ts";
import type { RuntimeEvents } from "./runtimeEvents.ts";
import { nextPublicationRetryAt } from "./runtimePublicationOutbox.ts";

/** The claimed failed-start owner. `done` completes with its exit, after the claim is released. */
type FailedStartWork = Readonly<{ done: Deferred.Deferred<void> }>;

/** The Run's declared storage: the synchronous repository and its physical alarm request. */
export type InterviewAttemptStorage = Readonly<{
  repository: InterviewFinalizationRepository;
  requestAlarm(at: number | null): Effect.Effect<void>;
}>;

/** Owns terminalization from acceptance; live work stays in the live finalization coordinator. */
export class InterviewAttemptCoordinator {
  readonly #execution: Pick<ExecutionBridge, "enter"> | undefined;
  readonly #storage: InterviewAttemptStorage;
  readonly #repository: InterviewFinalizationRepository;
  readonly #finalization: InterviewFinalizationCoordinator;
  readonly #conversationCleanup: Pick<ConversationSetupCleanup, "handlePending">;
  readonly #publication: RuntimePublication;
  readonly #events: RuntimeEvents;
  readonly #background: (task: Promise<void>) => void;
  readonly #now: () => number;
  #work: FailedStartWork | null = null;

  constructor(
    input: Readonly<{
      execution?: Pick<ExecutionBridge, "enter">;
      storage: InterviewAttemptStorage;
      finalization: InterviewFinalizationCoordinator;
      conversationCleanup: Pick<ConversationSetupCleanup, "handlePending">;
      publication: RuntimePublication;
      events: RuntimeEvents;
      background(task: Promise<void>): void;
      /** The Run clock's synchronous read. */
      now: () => number;
    }>,
  ) {
    this.#execution = input.execution;
    this.#storage = input.storage;
    this.#repository = input.storage.repository;
    this.#finalization = input.finalization;
    this.#conversationCleanup = input.conversationCleanup;
    this.#publication = input.publication;
    this.#events = input.events;
    this.#background = input.background;
    this.#now = input.now;
  }

  hasFailedStart(): boolean {
    const state = this.#repository.readState();
    return state !== null && state.phase === "failed" && state.live_at === null;
  }

  /** Whether setup may still go Live at `now`. An expired startup fails its setup first. */
  mayGoLive(now: number): Effect.Effect<boolean> {
    return Effect.suspend(() => {
      const state = this.#repository.requireState();
      if (state.phase !== "setup") return Effect.succeed(false);
      if (state.startup_expires_at !== null && now >= state.startup_expires_at)
        return this.failSetup(state.run_id, state.startup_expires_at).pipe(Effect.as(false));
      return Effect.succeed(true);
    });
  }

  /**
   * Commits setup to Live when called, in one synchronous step, so the caller prepares and commits
   * with no scheduler boundary between them. The returned Effect carries the outcome, or the
   * commit's defect; for a failed start it also starts the failed-start work and requests its
   * wake-up.
   */
  commitLive(input: {
    runId: string;
    liveEvidenceAt: number;
    deadlineAt: number | null;
    presenceGraceUntil: number;
    aggregate: Parameters<InterviewFinalizationRepository["commitSetupToLive"]>[0]["aggregate"];
  }): Effect.Effect<"live" | "failed" | "unchanged"> {
    let outcome: "live" | "failed" | "unchanged";
    try {
      outcome = this.#repository.commitSetupToLive({ ...input, transitionAt: this.#now() });
    } catch (defect) {
      return Effect.die(defect);
    }
    if (outcome !== "failed") return Effect.succeed(outcome);
    return this.scheduleFailedStartWork().pipe(
      Effect.andThen(this.requestWakeUp()),
      Effect.as(outcome),
    );
  }

  /** Commits the setup failure in one synchronous step, then requests its wake-up. */
  failSetup(runId: string, observedAt?: number): Effect.Effect<void> {
    return Effect.suspend(() => {
      const observed = observedAt ?? this.#now();
      const outcome = this.#repository.commitSetupFailure(runId, observed, this.#now());
      if (outcome === "unchanged") return Effect.void;
      const work = this.hasFailedStart() ? this.scheduleFailedStartWork() : Effect.void;
      return work.pipe(Effect.andThen(this.requestWakeUp()));
    });
  }

  /** Requests the physical alarm that the Run's durable demand needs. */
  requestWakeUp(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const state = this.#repository.readState();
      if (state !== null && state.live_at === null) {
        const publicationWakeAt =
          state.callback_pending === 1 && state.failed_start_publication_cutoff_at !== null
            ? Math.min(
                state.callback_retry_at ?? state.failed_start_publication_cutoff_at,
                state.failed_start_publication_cutoff_at,
              )
            : null;
        const wakeAt =
          state.phase === "setup"
            ? state.startup_expires_at
            : state.setup_cleanup_pending === 1
              ? this.#now()
              : publicationWakeAt;
        return this.#storage.requestAlarm(wakeAt);
      }
      return this.#finalization.requestWakeUp();
    });
  }

  handleAlarm(): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      const state = self.#repository.readState();
      if (state !== null && state.live_at === null) {
        if (
          state.phase === "setup" &&
          state.startup_expires_at !== null &&
          self.#now() >= state.startup_expires_at
        ) {
          yield* self.failSetup(state.run_id, state.startup_expires_at);
        }
        yield* self.scheduleFailedStartWork();
        const work = self.#work;
        if (work !== null) yield* Deferred.await(work.done);
        yield* self.requestWakeUp();
        return;
      }
      yield* dieOnNodeDispatchClaimFailure(self.#finalization.handleAlarmInvocation());
    });
  }

  /**
   * Starts the failed start's cleanup and publication once, in its own detached owner. The claim
   * and the owner's start are one uninterruptible step: once claimed, the owner starts even when
   * the caller is interrupted. A caller that stops waiting cannot interrupt the owner, and the host
   * retains it.
   */
  scheduleFailedStartWork(): Effect.Effect<void> {
    return Effect.uninterruptible(
      Effect.flatMap(Deferred.make<void>(), (done) => {
        if (this.#work !== null) return Effect.void;
        const state = this.#repository.readState();
        if (state === null || state.phase !== "failed" || state.live_at !== null)
          return Effect.void;
        // Claim before any native dispatch or Effect evaluation. This check/set has no async gap.
        const work: FailedStartWork = { done };
        this.#work = work;
        const operation = this.#runFailedStartWork().pipe(
          Effect.ensuring(
            this.requestWakeUp().pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  // Release only this operation's claim, even when physical alarm persistence rejects.
                  if (this.#work === work) this.#work = null;
                }),
              ),
            ),
          ),
          Effect.onExit((exit) => Deferred.done(work.done, exit)),
        );
        return Effect.forkDetach(
          this.#execution === undefined ? operation : this.#execution.enter(operation),
          { startImmediately: true },
        ).pipe(Effect.map((owner) => this.#background(retainOwner(owner))));
      }),
    );
  }

  #runFailedStartWork(): Effect.Effect<void, never> {
    const self = this;
    return Effect.gen(function* () {
      let state = self.#repository.requireState();
      if (state.setup_cleanup_pending === 1) yield* self.#conversationCleanup.handlePending();
      state = self.#repository.requireState();
      if (self.#expireFailedStartIfDue(state, self.#now())) return;
      if (
        state.callback_pending !== 1 ||
        (state.callback_retry_at !== null && state.callback_retry_at > self.#now())
      )
        return;
      const deliveryTargetJson = state.delivery_target_json ?? null;
      if (deliveryTargetJson === null) {
        self.#repository.recordFailedStartPublication({
          runId: state.run_id,
          pending: false,
          retryAt: null,
          deliveredAt: null,
          error: "missing_completion_callback",
          attemptCount: state.callback_attempt_count,
          status: "blocked_nonretryable_callback",
        });
        return;
      }
      const result = parseFailedToStartResult(JSON.parse(state.completion_json ?? "null"));
      if (result === null || result.runId !== state.run_id)
        throw new Error("invalid_failed_start_result");
      const attemptCount = state.callback_attempt_count + 1;
      const cutoffAt = state.failed_start_publication_cutoff_at;
      if (cutoffAt === null) throw new Error("missing_failed_start_publication_cutoff");
      const retryAt = nextPublicationRetryAt(
        self.#now(),
        state.callback_attempt_count,
        "retryable",
        cutoffAt,
      );
      // Persist the next wake before I/O so callback loss/reconstruction retries this same decision.
      self.#repository.recordFailedStartPublication({
        runId: state.run_id,
        pending: true,
        retryAt,
        deliveredAt: null,
        error: state.callback_last_error,
        attemptCount,
        status: "retrying",
      });
      yield* self.requestWakeUp();
      const diagnosticsContextJson = state.diagnostics_context_json;
      // The finite publication capability already classifies transport failures. A defect is not
      // a receipt; retain the persisted retry and surface the owner exit. Interrupting this owner
      // aborts the in-flight transport.
      const attempt = yield* self.#publication.deliverFailedStart({
        result,
        diagnosticsContextJson,
        deliveryTargetJson,
        publicationCutoffAt: cutoffAt,
      });
      if ("expired" in attempt) {
        self.#expireFailedStartIfDue(
          self.#repository.requireState(),
          self.#now(),
          state.callback_last_error,
          state.callback_attempt_count,
        );
        return;
      }
      const pending = !attempt.delivered && attempt.disposition === "retryable";
      if (!attempt.delivered && pending && self.#now() >= cutoffAt) {
        self.#expireFailedStartIfDue(self.#repository.requireState(), self.#now(), attempt.error);
        return;
      }
      const nextRetryAt = pending
        ? nextPublicationRetryAt(self.#now(), state.callback_attempt_count, "retryable", cutoffAt)
        : null;
      self.#repository.recordFailedStartPublication({
        runId: state.run_id,
        pending,
        retryAt: nextRetryAt,
        deliveredAt: attempt.delivered ? self.#now() : null,
        error: attempt.delivered ? null : attempt.error,
        attemptCount,
        status: attempt.delivered
          ? "delivered"
          : pending
            ? "retrying"
            : "blocked_nonretryable_callback",
      });
      if (!attempt.delivered && pending) {
        self.#events.recordEvent("runtime.publication_retry", {
          reason: "terminal_result_delivery_unconfirmed",
          error: attempt.error,
        });
      }
      if (!attempt.delivered && !pending)
        self.#events.recordUniqueDiagnostic("runtime.publication_blocked", () => true, {
          disposition: attempt.disposition,
          error: attempt.error,
          reason: "terminal_result_conflict_or_rejection",
          source: "runtime_controller",
        });
    });
  }

  #expireFailedStartIfDue(
    state: RuntimeControllerRow,
    now: number,
    error: string | null = state.callback_last_error,
    attemptCount = state.callback_attempt_count,
  ): boolean {
    const cutoffAt = state.failed_start_publication_cutoff_at;
    if (
      state.callback_pending !== 1 ||
      cutoffAt === null ||
      now < cutoffAt ||
      state.failed_start_publication_status === "delivered" ||
      state.failed_start_publication_status === "blocked_nonretryable_callback"
    ) {
      return false;
    }
    this.#repository.recordFailedStartPublication({
      runId: state.run_id,
      pending: false,
      retryAt: null,
      deliveredAt: null,
      error,
      attemptCount,
      status: "expired",
    });
    this.#events.recordUniqueDiagnostic(
      "runtime.publication_expired",
      (payload) => payload.cutoffAt === cutoffAt,
      {
        cutoffAt,
        attemptCount,
        lastError: error,
        source: "runtime_controller",
      },
      { observedAt: cutoffAt },
    );
    return true;
  }
}
