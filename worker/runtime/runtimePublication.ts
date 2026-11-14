import type { ExecutionBridge } from "./runtimeHostAssembly.ts";
import { Cause, Effect } from "effect";
import type { RuntimeDelivery } from "./runtimeDelivery.ts";
import { decodeRetainedDeliveryTarget } from "../shared/contracts/runtimeDelivery.ts";
import type { FailedToStartResult } from "../shared/contracts/runtimeTerminalResult.ts";
import { redactSecrets } from "../shared/http.ts";
import { millisecondsUntil } from "../shared/deadline.ts";
import type { RuntimeTranscriptSnapshot } from "../shared/runtimeTranscriptSnapshot.ts";
import { runtimeTranscriptSnapshot } from "./webPlatform.ts";
import {
  readFinalizationTranscriptTurns,
  type FinalizationEndedState,
  type InterviewFinalizationAggregate,
  type RuntimeFinalizationCompletion,
  type RuntimePublicationState,
} from "./interviewFinalizationModel.ts";
import {
  attemptRuntimePublication,
  callbackAttemptTimeoutMs,
  nextPublicationRetryAt,
  type CallbackFailureDisposition,
  type RuntimePublicationAttempt,
  type RuntimePublicationCrashPoint as OutboxPublicationCrashPoint,
  type RuntimePublicationTarget,
} from "./runtimePublicationOutbox.ts";
import type { RuntimeEventRecorder } from "./runtimeEvents.ts";

export type RuntimePublicationCrashPoint = OutboxPublicationCrashPoint;

export type RuntimePublicationRecord = Readonly<{
  runId: string;
  /** The Run's application; a Run without one publishes nothing. */
  deliveryTargetJson: string | null;
  diagnosticsContextJson: string | null;
  aggregate: InterviewFinalizationAggregate;
}>;

/** A record whose result froze; only it carries publication state. */
type FrozenPublicationRecord = RuntimePublicationRecord &
  Readonly<{
    aggregate: InterviewFinalizationAggregate & Readonly<{ state: FinalizationEndedState }>;
  }>;

export type RuntimePublicationStorage = Readonly<{
  read(): RuntimePublicationRecord | null;
  persist(aggregate: InterviewFinalizationAggregate): void;
}>;

export type RuntimePublicationBackgroundWork = Readonly<{
  waitUntil(task: Promise<unknown>): void;
}>;

export type RuntimePublicationEvents = Pick<
  RuntimeEventRecorder,
  "recordEvent" | "recordUniqueDiagnostic"
>;

export type RuntimePublicationTransports = RuntimeDelivery;

export type RuntimeTranscriptDeliveryResult =
  | Readonly<{
      status: "delivered";
      stored: true;
      snapshot: RuntimeTranscriptSnapshot;
    }>
  | Readonly<{
      status: "skipped";
      stored: false;
      reason: "no_callback" | "no_publication_record";
    }>
  | Readonly<{
      status: "expired";
      stored: false;
      cutoffAt: number;
    }>
  | Readonly<{
      status: "failed";
      stored: false;
      error: string;
      disposition: CallbackFailureDisposition;
    }>;

/** A failed-start callback attempt, or no attempt because its publication cutoff has passed. */
type RuntimeFailedStartAttempt =
  | RuntimePublicationAttempt
  | Readonly<{ expired: true; cutoffAt: number }>;

export type RuntimeTerminalPublicationWork = Readonly<{
  completion: RuntimeFinalizationCompletion;
  observedAt: number;
}>;

export type RuntimeTerminalDeliveryResult =
  | Readonly<{ status: "delivered"; deliveredAt: number }>
  | Readonly<{ status: "expired"; cutoffAt: number }>
  | Readonly<{
      status: "skipped";
      reason: "no_publication_record" | "no_completion_callback";
    }>
  | Readonly<{
      status: "failed";
      error: string;
      disposition: CallbackFailureDisposition;
    }>;

export type RuntimeTerminalPublicationSchedule =
  | Readonly<{ scheduled: false; reason: "in_flight" }>
  | Readonly<{ scheduled: true; task: Promise<RuntimeTerminalDeliveryResult> }>;

export class RuntimePublication {
  readonly #execution: Pick<ExecutionBridge, "run" | "runExit">;
  readonly #storage: RuntimePublicationStorage;
  readonly #events: RuntimePublicationEvents;
  readonly #transports: RuntimePublicationTransports;
  readonly #backgroundWork: RuntimePublicationBackgroundWork;
  readonly #requestAlarmRecomputation: () => Effect.Effect<void>;
  readonly #crashInjector: ((point: RuntimePublicationCrashPoint) => void) | undefined;
  readonly #now: () => number;
  #terminalOwner: symbol | null = null;

  constructor(
    input: Readonly<{
      /** The bridge that runs each publication owner for its native caller. */
      execution: Pick<ExecutionBridge, "run" | "runExit">;
      storage: RuntimePublicationStorage;
      events: RuntimePublicationEvents;
      transports: RuntimePublicationTransports;
      backgroundWork: RuntimePublicationBackgroundWork;
      /** The Run's alarm request, composed into each publication owner that changes demand. */
      requestAlarmRecomputation: () => Effect.Effect<void>;
      crashInjector?: ((point: RuntimePublicationCrashPoint) => void) | undefined;
      /** The current time from the Run's Clock. */
      now: () => number;
    }>,
  ) {
    this.#execution = input.execution;
    this.#storage = input.storage;
    this.#events = input.events;
    this.#transports = input.transports;
    this.#backgroundWork = input.backgroundWork;
    this.#requestAlarmRecomputation = input.requestAlarmRecomputation;
    this.#crashInjector = input.crashInjector;
    this.#now = input.now;
  }

  /** One failed-start attempt, composed into its caller's owner so interruption aborts transport. */
  deliverFailedStart(
    input: Readonly<{
      result: FailedToStartResult;
      deliveryTargetJson: string | null;
      diagnosticsContextJson: string | null;
      publicationCutoffAt: number;
    }>,
  ): Effect.Effect<RuntimeFailedStartAttempt> {
    return Effect.suspend((): Effect.Effect<RuntimeFailedStartAttempt> => {
      const timeoutMs = this.#attemptBound(input.publicationCutoffAt);
      if (timeoutMs === 0)
        return Effect.succeed({ expired: true as const, cutoffAt: input.publicationCutoffAt });
      return this.#attempt({
        target: { kind: "failed_to_start", result: input.result },
        fetch: (request: Request, signal: AbortSignal) =>
          this.#fetchCallbackTransport("completion", request, input, signal),
        timeoutMs,
      });
    });
  }

  #attempt(
    input: Omit<Parameters<typeof attemptRuntimePublication>[0], "crashInjector">,
  ): Effect.Effect<RuntimePublicationAttempt> {
    return attemptRuntimePublication(
      this.#crashInjector === undefined ? input : { ...input, crashInjector: this.#crashInjector },
    );
  }

  scheduleCurrentTranscript(observedAt = this.#now()): Promise<RuntimeTranscriptDeliveryResult> {
    // Each accepted revision starts its own owner; terminal single-flight never suppresses live work.
    return this.#observeOwner(
      this.#currentTranscript(observedAt).pipe(
        Effect.ensuring(Effect.suspend(() => this.#requestAlarmRecomputation())),
      ),
    );
  }

  deliverCurrentTranscript(
    observedAt = this.#now(),
    timeoutMs: number = callbackAttemptTimeoutMs,
    cutoffAt?: number,
  ): Promise<RuntimeTranscriptDeliveryResult> {
    const operation = this.#currentTranscript(observedAt, timeoutMs, cutoffAt);
    return this.#execution.run(operation);
  }

  #currentTranscript(
    observedAt: number,
    timeoutMs: number = callbackAttemptTimeoutMs,
    cutoffAt?: number,
  ): Effect.Effect<RuntimeTranscriptDeliveryResult> {
    const self = this;
    return Effect.gen(function* (): Generator<
      Effect.Effect<unknown>,
      RuntimeTranscriptDeliveryResult,
      never
    > {
      // Owner runners start synchronously: capture before suspension, with exit handling installed.
      const record = self.#storage.read();
      if (record === null) {
        return { status: "skipped", stored: false, reason: "no_publication_record" };
      }
      const snapshot = yield* runtimeTranscriptSnapshot(record.aggregate.transcriptRevision, {
        turns: readFinalizationTranscriptTurns(record.aggregate),
      });
      if (record.deliveryTargetJson === null) {
        self.#events.recordEvent("runtime.transcript_persisted", {
          runId: record.runId,
          turnCount: snapshot.turnCount,
          revision: snapshot.revision,
          observedAt,
          stored: false,
          reason: "no_callback",
        });
        return { status: "skipped", stored: false, reason: "no_callback" };
      }
      const transportTimeoutMs =
        cutoffAt === undefined ? timeoutMs : self.#attemptBound(cutoffAt, timeoutMs);
      if (cutoffAt !== undefined && transportTimeoutMs === 0) {
        return { status: "expired", stored: false, cutoffAt };
      }

      const input = {
        target: {
          kind: "transcript",
          runId: record.runId,
          snapshot,
        },
        fetch: (request: Request, signal: AbortSignal) =>
          self.#fetchCallbackTransport("transcript", request, record, signal),
        timeoutMs: transportTimeoutMs,
      } as const;
      const attempt = yield* self.#attempt(input);
      self.#events.recordEvent(
        attempt.delivered ? "runtime.transcript_persisted" : "runtime.transcript_persist_failed",
        {
          runId: record.runId,
          turnCount: snapshot.turnCount,
          ...(attempt.delivered
            ? { revision: snapshot.revision, observedAt, stored: true }
            : { message: attempt.error }),
        },
      );
      return attempt.delivered
        ? { status: "delivered", stored: true, snapshot }
        : {
            status: "failed",
            stored: false,
            error: attempt.error,
            disposition: attempt.disposition,
          };
    });
  }

  scheduleTerminal(work: RuntimeTerminalPublicationWork): RuntimeTerminalPublicationSchedule {
    const self = this;
    if (this.#terminalOwner !== null) return { scheduled: false, reason: "in_flight" };
    const owner = Symbol("terminal_publication");
    this.#terminalOwner = owner;
    const operation = this.#deliverTerminal(work).pipe(
      Effect.tapCause((cause) =>
        Effect.sync(() => {
          try {
            this.#events.recordEvent("runtime.execution_failed", {
              source: "runtime_controller",
              operation: "terminal_publication",
              failure: Cause.hasFails(cause),
              defect: Cause.hasDies(cause),
              interruption: Cause.hasInterrupts(cause),
            });
          } catch {
            // Diagnostics cannot replace the original Cause or its boundary mapping.
          }
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const errorText = describeError(Cause.squash(cause));
          const delivered = this.#readCommittedDelivery(work);
          if (delivered !== null) return delivered;
          if (this.#admittedRecord(work) !== null) this.#recordFailure(this.#now(), errorText);
          return { status: "failed" as const, error: errorText, disposition: "retryable" as const };
        }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          if (self.#terminalOwner === owner) self.#terminalOwner = null;
          // Request the existing durable alarm owner. A finalizer is not a persisted alarm.
          yield* self.#requestAlarmRecomputation();
        }),
      ),
    );
    return { scheduled: true, task: this.#observeOwner(operation) };
  }

  #observeOwner<Result>(operation: Effect.Effect<Result>): Promise<Result> {
    // The observer may stop waiting; its cancellation cannot interrupt durable responsibility.
    const task = this.#execution.run(operation);
    this.#backgroundWork.waitUntil(task);
    return task;
  }

  #deliverTerminal(
    work: RuntimeTerminalPublicationWork,
  ): Effect.Effect<RuntimeTerminalDeliveryResult> {
    const self = this;
    return Effect.gen(function* (): Generator<
      Effect.Effect<unknown>,
      RuntimeTerminalDeliveryResult,
      never
    > {
      const initialRecord = self.#storage.read();
      if (initialRecord === null || !matchesTerminalWork(initialRecord, work)) {
        return { status: "skipped", reason: "no_publication_record" };
      }
      const initialPublication = initialRecord.aggregate.state.publication;
      if (initialPublication.status === "delivered" && initialPublication.deliveredAt !== null) {
        return { status: "delivered", deliveredAt: initialPublication.deliveredAt };
      }
      if (initialPublication.status === "expired") {
        return { status: "expired", cutoffAt: self.#publicationCutoffAt(initialRecord) };
      }
      if (
        initialPublication.status === "blocked_snapshot_conflict" ||
        initialPublication.status === "blocked_nonretryable_callback"
      ) {
        return {
          status: "failed",
          error: initialPublication.lastError ?? "publication_blocked",
          disposition: initialPublication.status,
        };
      }
      if (initialRecord.deliveryTargetJson === null) {
        return { status: "skipped", reason: "no_completion_callback" };
      }
      const initialCutoffAt = self.#publicationCutoffAt(initialRecord);
      if (self.#expirePublicationIfDue(initialCutoffAt)) {
        return { status: "expired", cutoffAt: initialCutoffAt };
      }
      let attemptedCallback = false;

      if (!initialPublication.transcriptDelivered) {
        attemptedCallback = true;
        const transcriptDelivery = yield* self.#currentTranscript(
          work.observedAt,
          callbackAttemptTimeoutMs,
          initialCutoffAt,
        );
        if (self.#admittedRecord(work) === null) {
          return { status: "skipped", reason: "no_publication_record" };
        }
        if (transcriptDelivery.status === "expired") {
          self.#expirePublicationIfDue(initialCutoffAt);
          return { status: "expired", cutoffAt: initialCutoffAt };
        }
        if (transcriptDelivery.status !== "delivered") {
          const disposition =
            transcriptDelivery.status === "failed" ? transcriptDelivery.disposition : "retryable";
          self.#recordFailure(self.#now(), "transcript_callback_not_acknowledged", disposition);
          return {
            status: "failed",
            error: "transcript_callback_not_acknowledged",
            disposition,
          };
        }
        const transcriptDeliveredRecord = self.#readFrozenRecord();
        self.#persistPublication(transcriptDeliveredRecord, {
          ...transcriptDeliveredRecord.aggregate.state.publication,
          transcriptDelivered: true,
        });
      }

      const completionRecord = self.#readFrozenRecord();
      if (completionRecord.deliveryTargetJson === null) {
        return { status: "skipped", reason: "no_completion_callback" };
      }
      const completionCutoffAt = self.#publicationCutoffAt(completionRecord);
      if (
        self.#expirePublicationIfDue(completionCutoffAt, {
          incrementAttempt: attemptedCallback,
        })
      ) {
        return { status: "expired", cutoffAt: completionCutoffAt };
      }
      const completionTimeoutMs = self.#attemptBound(completionCutoffAt);
      if (completionTimeoutMs === 0) {
        self.#expirePublicationIfDue(completionCutoffAt, {
          incrementAttempt: attemptedCallback,
        });
        return { status: "expired", cutoffAt: completionCutoffAt };
      }
      const result = completionRecord.aggregate.applicationTranscriptProof.result;
      const input = {
        target:
          result?.outcome === "completed"
            ? { kind: "completed" as const, result }
            : result?.outcome === "interrupted"
              ? { kind: "interrupted" as const, result }
              : { kind: "completion" as const, completion: work.completion },
        fetch: (request: Request, signal: AbortSignal) =>
          self.#fetchCallbackTransport("completion", request, completionRecord, signal),
        timeoutMs: completionTimeoutMs,
      } satisfies {
        target: RuntimePublicationTarget;
        fetch(request: Request, signal: AbortSignal): Promise<Response>;
        timeoutMs: number;
      };
      const attempt = yield* self.#attempt(input);
      if (self.#admittedRecord(work) === null) {
        return { status: "skipped", reason: "no_publication_record" };
      }
      if (!attempt.delivered) {
        self.#recordFailure(self.#now(), attempt.error, attempt.disposition);
        return { status: "failed", error: attempt.error, disposition: attempt.disposition };
      }

      const deliveredRecord = self.#readFrozenRecord();
      const deliveredAt = self.#now();
      self.#persistPublication(deliveredRecord, {
        ...deliveredRecord.aggregate.state.publication,
        status: "delivered",
        transcriptDelivered: true,
        completionDelivered: true,
        retryAt: null,
        attemptCount: deliveredRecord.aggregate.state.publication.attemptCount + 1,
        deliveredAt,
        lastError: null,
      });
      return { status: "delivered", deliveredAt };
    });
  }

  #admittedRecord(work: RuntimeTerminalPublicationWork): FrozenPublicationRecord | null {
    const record = this.#storage.read();
    if (record === null || !matchesTerminalWork(record, work)) return null;
    const status = record.aggregate.state.publication.status;
    if (status !== "pending" && status !== "retrying") return null;
    return record;
  }

  #readCommittedDelivery(
    work: RuntimeTerminalPublicationWork,
  ): Extract<RuntimeTerminalDeliveryResult, { status: "delivered" }> | null {
    const record = this.#storage.read();
    if (record === null || !matchesTerminalWork(record, work)) return null;
    const publication = record.aggregate.state.publication;
    return publication.status === "delivered"
      ? { status: "delivered", deliveredAt: publication.deliveredAt }
      : null;
  }

  async #fetchCallbackTransport(
    callback: "transcript" | "completion",
    request: Request,
    record: Readonly<{ diagnosticsContextJson: string | null; deliveryTargetJson: string | null }>,
    signal: AbortSignal,
  ): Promise<Response> {
    return this.#transports.deliver(
      decodeRetainedDeliveryTarget(record.deliveryTargetJson),
      callback,
      request,
      signal,
    );
  }

  #recordFailure(
    observedAt: number,
    errorText: string,
    disposition: CallbackFailureDisposition = "retryable",
  ): void {
    const record = this.#storage.read();
    if (record === null) return;
    const frozen = requireFrozenRecord(record);
    const publication = frozen.aggregate.state.publication;
    const cutoffAt = publication.publicationCutoffAt;
    if (
      disposition === "retryable" &&
      this.#expirePublicationIfDue(cutoffAt, { incrementAttempt: true, errorText })
    )
      return;
    const retryAt = nextPublicationRetryAt(
      observedAt,
      publication.attemptCount,
      disposition,
      cutoffAt,
    );
    this.#persistPublication(frozen, {
      ...publication,
      status: disposition === "retryable" ? "retrying" : disposition,
      retryAt,
      attemptCount: publication.attemptCount + 1,
      deliveredAt: null,
      lastError: errorText,
    });
    if (disposition !== "retryable") {
      this.#events.recordUniqueDiagnostic(
        "runtime.publication_blocked",
        (payload) => payload.disposition === disposition && payload.error === errorText,
        { disposition, error: errorText, source: "runtime_controller" },
        { observedAt },
      );
    }
  }

  #publicationCutoffAt(record: FrozenPublicationRecord): number {
    return record.aggregate.state.publication.publicationCutoffAt;
  }

  #readFrozenRecord(): FrozenPublicationRecord {
    const record = this.#storage.read();
    if (record === null) throw new Error("runtime_controller_not_started");
    return requireFrozenRecord(record);
  }

  #persistPublication(record: FrozenPublicationRecord, publication: RuntimePublicationState): void {
    this.#storage.persist({
      ...record.aggregate,
      state: { ...record.aggregate.state, publication },
    });
  }

  /** One attempt's bound within the publication cutoff; zero once the cutoff has passed. */
  #attemptBound(cutoffAt: number, timeoutMs: number = callbackAttemptTimeoutMs): number {
    return Math.min(timeoutMs, millisecondsUntil(cutoffAt, this.#now()));
  }

  #expirePublicationIfDue(
    cutoffAt: number,
    attempt: Readonly<{ incrementAttempt?: boolean; errorText?: string }> = {},
  ): boolean {
    if (millisecondsUntil(cutoffAt, this.#now()) > 0) return false;
    const record = this.#storage.read();
    if (record === null) return true;
    const frozen = requireFrozenRecord(record);
    const publication = frozen.aggregate.state.publication;
    if (
      publication.status === "delivered" ||
      publication.status === "blocked_snapshot_conflict" ||
      publication.status === "blocked_nonretryable_callback"
    ) {
      return false;
    }
    if (publication.status !== "expired") {
      const attemptCount = publication.attemptCount + (attempt.incrementAttempt === true ? 1 : 0);
      const lastError = attempt.errorText ?? publication.lastError;
      this.#persistPublication(frozen, {
        ...publication,
        status: "expired",
        retryAt: null,
        attemptCount,
        deliveredAt: null,
        lastError,
      });
      this.#events.recordUniqueDiagnostic(
        "runtime.publication_expired",
        (payload) => payload.cutoffAt === cutoffAt,
        {
          cutoffAt,
          attemptCount,
          lastError,
          source: "runtime_controller",
        },
        { observedAt: cutoffAt },
      );
    }
    return true;
  }
}

function describeError<ErrorValue>(error: ErrorValue): string {
  if (error instanceof Error && error.message.length > 0) return redactSecrets(error.message);
  if (typeof error === "string" && error.length > 0) return redactSecrets(error);
  return "request failed";
}

function requireFrozenRecord(record: RuntimePublicationRecord): FrozenPublicationRecord {
  if (!isFrozenRecord(record)) throw new Error("runtime_publication_result_not_frozen");
  return record;
}

function isFrozenRecord(record: RuntimePublicationRecord): record is FrozenPublicationRecord {
  return record.aggregate.state.stage === "ended";
}

function matchesTerminalWork(
  record: RuntimePublicationRecord,
  work: RuntimeTerminalPublicationWork,
): record is FrozenPublicationRecord {
  if (!isFrozenRecord(record)) return false;
  const state = record.aggregate.state;
  return (
    record.runId === work.completion.runId &&
    state.completion.finalizedAt === work.completion.finalizedAt &&
    state.completion.transcriptSnapshot.revision === work.completion.transcriptSnapshot.revision &&
    state.completion.transcriptSnapshot.digest === work.completion.transcriptSnapshot.digest
  );
}
