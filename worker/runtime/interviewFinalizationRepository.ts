import { decodeConversationSnapshot, type ConversationSnapshot } from "./conversationExecution.ts";
import type { ConnectionPayload } from "../shared/contracts/runtimeConnection.ts";
import type { ConnectionCheckpoint } from "./conversationConnection.ts";
import { redactSecrets, withoutUndefined } from "../shared/http.ts";
import type { RuntimeEndReason } from "../shared/runtimeControllerCallback.ts";
import {
  interviewResultPublicationPeriodMs,
  isSameJson,
  type InterviewFinalizationAggregate,
  type RuntimePublicEvent,
} from "./interviewFinalizationModel.ts";
import {
  decodeInterviewFinalizationAggregate,
  isInterviewFinalizationAggregate,
  parseJsonObject,
} from "./interviewFinalizationPersistenceDecoder.ts";
import {
  projectInterviewFinalizationPersistence,
  type InterviewFinalizationPersistence,
} from "./interviewFinalizationPersistenceProjection.ts";
import { RuntimeEvents, type RuntimeEventContext } from "./runtimeEvents.ts";
import {
  applyRuntimeUsageEvidence,
  type ConversationUsageEvidence,
  createRuntimeUsageAccounting,
  parseRuntimeUsageAccountingState,
  markRuntimeUsageIncomplete,
  sealRuntimeUsage,
} from "./runtimeUsage.ts";
import { decideRuntimeSetupTransition } from "./interviewAttemptPolicy.ts";

const controllerIdentity = "interview-runtime-controller";

export type RuntimeControllerPhase = "setup" | "live" | "ending" | "ended" | "failed";

export type FailedStartPublicationStatus =
  | "inactive"
  | "pending"
  | "retrying"
  | "delivered"
  | "blocked_nonretryable_callback"
  | "expired";

export type RuntimeControllerRow = Readonly<{
  run_id: string;
  controller_identity: string;
  runtime_id: string;
  phase: RuntimeControllerPhase;
  created_at: number;
  started_at: number;
  live_at: number | null;
  deadline_at: number | null;
  startup_expires_at: number | null;
  fake_session_id: string | null;
  session_id: string | null;
  session_location: string | null;
  upstream_request_id: string | null;
  /** The connection reply the execution's session recorded as JSON, as a replayed Start reads it. */
  session_reply_json: string | null;
  conversation_profile: string | null;
  conversation_start_json: string | null;
  agent_selection_json?: string | null;
  conversation_selection_json?: string | null;
  delivery_target_json?: string | null;
  connection_exchange_id: string | null;
  connection_fingerprint: string | null;
  connection_reply_json: string | null;
  connection_checkpoint_json: string | null;
  settings_summary_json: string | null;
  session_connected_at: number | null;
  session_disconnected_at: number | null;
  session_event_count: number;
  session_generation: number;
  execution_wake_at: number | null;
  /** The execution's own durable state, which Runtime keeps for it and never reads. */
  execution_state_json?: string | null;
  transcript_json: string | null;
  transcript_turn_count: number;
  readiness_attempted_at: number | null;
  readiness_delivered_at: number | null;
  readiness_disposition: string | null;
  pending_close_reason: RuntimeEndReason | null;
  pending_close_source: string | null;
  pending_close_requested_at: number | null;
  completion_json: string | null;
  diagnostics_context_json: string | null;
  callback_pending: number;
  callback_delivered_at: number | null;
  callback_retry_at: number | null;
  callback_attempt_count: number;
  callback_last_error: string | null;
  failed_start_publication_cutoff_at: number | null;
  failed_start_publication_status: FailedStartPublicationStatus;
  browser_media_ready_at: number | null;
  browser_media_ready_deadline_at: number | null;
  opening_state: "pending" | "claimed" | "sent" | null;
  presence_last_seen_at: number | null;
  presence_grace_until: number | null;
  presence_media_present: number | null;
  presence_signal_count: number;
  finalization_state_json: string | null;
  transcript_capture_json: string | null;
  transcript_revision: number | null;
  transcript_digest: string | null;
  next_provider_sequence: number;
  next_effect_sequence: number;
  next_event_sequence: number;
  frozen_transcript_json: string | null;
  frozen_transcript_revision: number | null;
  frozen_transcript_digest: string | null;
  frozen_transcript_turn_count: number | null;
  publication_json: string | null;
  setup_cleanup_pending: number;
  provider_creation_started: number;
  runtime_usage_json: string | null;
}>;

export type ProviderObservationPersistence = Readonly<{
  sessionId: string;
  sequence: number;
  diagnosticSummary: Readonly<Record<string, unknown>>;
  providerEventId?: string;
}>;

export type AggregatePersistenceOptions = Readonly<{
  diagnostic?: Readonly<{
    type: string;
    observedAt: number;
    payload: Readonly<Record<string, unknown>>;
  }>;
}>;

type RuntimeControllerEventData = Readonly<Record<string, unknown>>;

type RuntimeControllerEventRow = Readonly<{
  id: number;
  event_name: string;
  payload_json: string;
}>;

export type AggregatePersistenceCrashPoint = "before_aggregate_write" | "after_aggregate_write";

export type AggregatePersistenceCrashInjector = (point: AggregatePersistenceCrashPoint) => void;

export class InterviewFinalizationRepository {
  readonly #storage: DurableObjectStorage;
  readonly #crashInjector: AggregatePersistenceCrashInjector | undefined;
  // Storage reads are decoded once per stored value. A read reuses the decode, or the
  // verified row, until a write stores a different value; the stored text is the cache key.
  #decodedAggregate: Readonly<{
    json: string;
    aggregate: InterviewFinalizationAggregate | null;
  }> | null = null;
  #decodedSnapshot: Readonly<{ json: string; snapshot: ConversationSnapshot }> | null = null;
  #verifiedRow: RuntimeControllerRow | null = null;

  constructor(storage: DurableObjectStorage, crashInjector?: AggregatePersistenceCrashInjector) {
    this.#storage = storage;
    this.#crashInjector = crashInjector;
  }

  initialize(): void {
    this.#createSchema();

    const row = this.#readRawState();
    if (row === null) return;
    if (
      row.finalization_state_json === null &&
      (row.phase === "setup" || (row.phase === "failed" && row.live_at === null))
    ) {
      return;
    }
    const aggregate = decodeInterviewFinalizationAggregate(row.finalization_state_json);
    if (aggregate === null || aggregate.runId !== row.run_id) {
      const reason =
        row.finalization_state_json === null
          ? "missing_finalization_aggregate"
          : "malformed_or_unrecognized_finalization_aggregate";
      const stateFingerprint = fingerprintFinalizationState(row.finalization_state_json);
      if (
        !this.#hasControllerEvent(
          "runtime.invalid_finalization_state",
          (payload) =>
            payload.reason === reason &&
            payload.phase === row.phase &&
            payload.stateFingerprint === stateFingerprint,
        )
      ) {
        this.#runtimeEvents().recordEvent("runtime.invalid_finalization_state", {
          reason,
          phase: row.phase,
          stateFingerprint,
        });
      }
      return;
    }
    const mismatches = this.#projectionMismatches(row, aggregate);
    if (mismatches.length === 0) return;
    this.#writeAggregateTransaction(() => {
      this.#persistAggregateInTransaction(aggregate, [], undefined);
      if (mismatches.length > 0) {
        this.#runtimeEvents().recordEvent("runtime.finalization_projection_repaired", {
          fields: mismatches,
        });
      }
    });
  }

  readState(): RuntimeControllerRow | null {
    const row = this.#readRawState();
    if (row === null) return null;
    if (row.finalization_state_json === null) {
      if (row.phase === "setup" || (row.phase === "failed" && row.live_at === null)) return row;
      throw new Error("invalid_finalization_state");
    }
    // An unchanged stored row was already decoded and checked against its projection.
    if (this.#verifiedRow !== null && isSameJson(row, this.#verifiedRow)) return row;
    const aggregate = this.#decodeAggregate(row.finalization_state_json);
    if (aggregate === null || aggregate.runId !== row.run_id) {
      throw new Error("invalid_finalization_state");
    }
    const mismatches = this.#projectionMismatches(row, aggregate);
    if (mismatches.length > 0) {
      throw new Error(`finalization_projection_mismatch:${mismatches.join(",")}`);
    }
    this.#verifiedRow = row;
    return row;
  }

  requireState(runId: string | null = null): RuntimeControllerRow {
    const state = this.readState();
    if (state === null) throw new Error("runtime_controller_not_started");
    if (runId !== null && state.run_id !== runId) {
      throw new Error("runtime_controller_run_mismatch");
    }
    return state;
  }

  /**
   * The decoded aggregate is shared by every read of the same stored value. Its schema-derived
   * type is readonly, so readers derive new aggregates instead of changing it.
   */
  readAggregate(state = this.requireState()): InterviewFinalizationAggregate {
    const aggregate = this.#decodeAggregate(state.finalization_state_json);
    if (aggregate === null || aggregate.runId !== state.run_id) {
      throw new Error("invalid_finalization_state");
    }
    return aggregate;
  }

  /** The accepted Conversation snapshot of a row, decoded once per stored value. */
  readConversationSnapshot(row: RuntimeControllerRow): ConversationSnapshot | null {
    const json = row.conversation_selection_json;
    if (json == null) return null;
    if (this.#decodedSnapshot?.json !== json)
      this.#decodedSnapshot = { json, snapshot: decodeConversationSnapshot(JSON.parse(json)) };
    return this.#decodedSnapshot.snapshot;
  }

  /**
   * Uncorrelated diagnostics name the current visit. The aggregate owns it once Live begins;
   * before that, the accepted snapshot's initial visit is the only one.
   */
  eventContext(row: RuntimeControllerRow | null): RuntimeEventContext {
    const snapshot = row === null ? null : this.readConversationSnapshot(row);
    const visit =
      row?.finalization_state_json == null
        ? snapshot
        : this.#decodeAggregate(row.finalization_state_json)?.conversationVisit;
    return {
      selection: snapshot?.selection ?? null,
      visitId: visit?.visitId ?? null,
      operationId: visit?.operationId ?? null,
      runId: row?.run_id ?? null,
      sessionId: row?.session_id ?? null,
      startedAt: row?.started_at ?? null,
      diagnosticsContextJson: row?.diagnostics_context_json ?? null,
      live: row?.phase === "live" || row?.phase === "ending",
      terminal: row?.phase === "ended" || row?.phase === "failed",
    };
  }

  #decodeAggregate(json: string | null): InterviewFinalizationAggregate | null {
    if (json === null) return null;
    if (this.#decodedAggregate?.json !== json)
      this.#decodedAggregate = { json, aggregate: decodeInterviewFinalizationAggregate(json) };
    return this.#decodedAggregate.aggregate;
  }

  resolveApplicationAcceptance(runId: string): "accepted" | "not_accepted" {
    const state = this.#readRawState();
    if (state !== null) {
      if (state.run_id !== runId) throw new Error("runtime_controller_run_mismatch");
      return "accepted";
    }
    // Synchronous SQL and no await: setup and this fence cannot interleave.
    this.#storage.sql.exec(
      "INSERT OR IGNORE INTO runtime_acceptance_fence (run_id) VALUES (?)",
      runId,
    );
    return "not_accepted";
  }

  createSetup(
    input: Readonly<{
      runId: string;
      runtimeId: string;
      agentSelectionJson?: string;
      conversationSelectionJson?: string | undefined;
      deliveryTarget?: import("../shared/contracts/runtimeDelivery.ts").RuntimeDeliveryTarget;
      createdAt: number;
      startedAt: number;
      fakeSessionId: string | null;
      startupExpiresAt?: number | null;
      diagnosticsContext: Readonly<Record<string, unknown>>;
      transcriptCapture: unknown;
      publication: unknown;
    }>,
  ): void {
    if (
      this.#storage.sql.exec("SELECT run_id FROM runtime_acceptance_fence LIMIT 1").toArray()
        .length > 0
    ) {
      throw new Error("runtime_start_not_accepted");
    }
    const runtimeUsage = createRuntimeUsageAccounting();
    this.#storage.sql.exec(
      `INSERT INTO runtime_controller_state (
        run_id, controller_identity, runtime_id, phase, created_at, started_at,
        fake_session_id, diagnostics_context_json, transcript_json,
        transcript_turn_count, finalization_state_json, transcript_capture_json,
        transcript_revision, next_provider_sequence, next_effect_sequence,
        next_event_sequence, publication_json, deadline_at, startup_expires_at, runtime_usage_json, opening_state, agent_selection_json, delivery_target_json, conversation_selection_json
      ) VALUES (?, ?, ?, 'setup', ?, ?, ?, ?, ?, 0, NULL, ?, 0, 1, 1, 1, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      input.runId,
      controllerIdentity,
      input.runtimeId,
      input.createdAt,
      input.startedAt,
      input.fakeSessionId,
      JSON.stringify(input.diagnosticsContext),
      JSON.stringify({ turns: [] }),
      JSON.stringify(input.transcriptCapture),
      JSON.stringify(input.publication),
      input.startupExpiresAt ?? null,
      input.startupExpiresAt ?? null,
      JSON.stringify(runtimeUsage),
      input.agentSelectionJson ?? null,
      input.deliveryTarget === undefined ? null : JSON.stringify(input.deliveryTarget),
      input.conversationSelectionJson ?? null,
    );
  }

  claimReadinessDelivery(runId: string, attemptedAt: number): boolean {
    const state = this.requireState(runId);
    if (state.readiness_attempted_at !== null) return false;
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state SET readiness_attempted_at = ?
       WHERE run_id = ? AND phase IN ('live', 'ending', 'ended') AND readiness_attempted_at IS NULL`,
      attemptedAt,
      runId,
    );
    // A Run without a delivery target has no application to tell.
    return (
      this.requireState(runId).readiness_attempted_at === attemptedAt &&
      state.delivery_target_json != null
    );
  }

  recordReadinessDisposition(
    runId: string,
    input: Readonly<{ deliveredAt: number | null; disposition: string }>,
  ): void {
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state SET readiness_delivered_at = ?, readiness_disposition = ?
       WHERE run_id = ?`,
      input.deliveredAt,
      input.disposition,
      runId,
    );
  }

  retainConversationStart(
    runId: string,
    input: { profile: string; startJson: string; exchangeId: string; fingerprint: string },
  ): void {
    const state = this.requireState(runId);
    if (
      state.conversation_profile !== null &&
      (state.conversation_profile !== input.profile ||
        state.connection_exchange_id !== input.exchangeId ||
        state.connection_fingerprint !== input.fingerprint)
    )
      throw new Error("connection_exchange_conflict");
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state SET conversation_profile = ?, conversation_start_json = ?, connection_exchange_id = ?, connection_fingerprint = ? WHERE run_id = ? AND conversation_profile IS NULL`,
      input.profile,
      input.startJson,
      input.exchangeId,
      input.fingerprint,
      runId,
    );
  }

  recordConnectionCheckpoint(runId: string, checkpoint: ConnectionCheckpoint): void {
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state SET connection_checkpoint_json = ? WHERE run_id = ?`,
      JSON.stringify(checkpoint),
      runId,
    );
  }

  recordConnectionReply(runId: string, reply: ConnectionPayload): void {
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state SET connection_reply_json = ? WHERE run_id = ?`,
      JSON.stringify(reply),
      runId,
    );
  }

  markProviderCreationStarted(runId: string): void {
    if (this.requireState(runId).provider_creation_started === 1)
      throw new Error("runtime_controller_start_in_progress");
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state SET provider_creation_started = 1 WHERE run_id = ? AND phase = 'setup'`,
      runId,
    );
  }

  recordSessionIdentity(
    input: Readonly<{
      runId: string;
      sessionId: string;
      sessionLocation: string | null;
      upstreamRequestId: string | null;
      settingsSummary: Readonly<Record<string, unknown>>;
    }>,
  ): void {
    const state = this.requireState(input.runId);
    if (state.session_id !== null && state.session_id !== input.sessionId) {
      throw new Error("session_identity_conflict");
    }
    const cleanupPending =
      state.setup_cleanup_pending === 1 ||
      (state.phase === "failed" && state.live_at === null && state.session_id === null);
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state
       SET session_id = ?,
           session_location = COALESCE(session_location, ?),
           upstream_request_id = COALESCE(upstream_request_id, ?),
           settings_summary_json = COALESCE(settings_summary_json, ?),
           setup_cleanup_pending = ?
       WHERE run_id = ?`,
      input.sessionId,
      input.sessionLocation,
      input.upstreamRequestId,
      JSON.stringify(input.settingsSummary),
      cleanupPending ? 1 : 0,
      input.runId,
    );
  }

  recordSessionReply(
    input: Readonly<{
      runId: string;
      sessionId: string;
      reply: ConnectionPayload;
    }>,
  ): void {
    const state = this.requireState(input.runId);
    if (state.session_id !== input.sessionId) {
      throw new Error("session_identity_conflict");
    }
    const replyJson = JSON.stringify(input.reply);
    if (state.session_reply_json !== null && state.session_reply_json !== replyJson) {
      throw new Error("session_reply_conflict");
    }
    if (state.session_reply_json === null) {
      this.#storage.sql.exec(
        `UPDATE runtime_controller_state SET session_reply_json = ? WHERE run_id = ?`,
        replyJson,
        input.runId,
      );
    }
  }

  recordBrowserMediaReady(runId: string, at: number): void {
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state SET browser_media_ready_at = COALESCE(browser_media_ready_at, ?)
       WHERE run_id = ? AND phase IN ('setup', 'live')`,
      at,
      runId,
    );
  }

  claimOpening(runId: string): boolean {
    const state = this.requireState(runId);
    if (
      state.phase !== "live" ||
      state.opening_state !== "pending" ||
      state.browser_media_ready_at === null
    )
      return false;
    // Synchronous claim precedes the external command; uncertainty must never replay.
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state SET opening_state = 'claimed' WHERE run_id = ?`,
      runId,
    );
    return true;
  }

  markOpeningSent(runId: string): void {
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state SET opening_state = 'sent' WHERE run_id = ? AND opening_state = 'claimed'`,
      runId,
    );
  }

  recordPresence(
    input: Readonly<{
      runId: string;
      now: number;
      graceUntil: number;
      mediaPresent: boolean;
    }>,
  ): void {
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state
       SET presence_last_seen_at = ?, presence_grace_until = ?, presence_media_present = ?,
           presence_signal_count = presence_signal_count + 1
       WHERE run_id = ?`,
      input.now,
      input.graceUntil,
      input.mediaPresent ? 1 : 0,
      input.runId,
    );
  }

  commitSetupToLive(
    input: Readonly<{
      runId: string;
      liveEvidenceAt: number;
      transitionAt: number;
      deadlineAt: number | null;
      presenceGraceUntil: number;
      aggregate: InterviewFinalizationAggregate;
    }>,
  ): "live" | "failed" | "unchanged" {
    const aggregate = input.aggregate;
    let outcome: "live" | "failed" | "unchanged" = "unchanged";
    this.#writeAggregateTransaction(() => {
      const state = this.requireState(input.runId);
      const decision = decideRuntimeSetupTransition(toSetupTransitionState(state), {
        kind: "execution_ready",
        liveEvidenceAt: input.liveEvidenceAt,
        transitionAt: input.transitionAt,
      });
      if (decision.kind === "unchanged") return;
      if (decision.kind === "commit_failed_start") {
        this.#persistFailedStartInTransaction(state, decision.endedAt, input.transitionAt);
        outcome = "failed";
        return;
      }
      if (decision.kind !== "commit_live") {
        throw new Error("invalid_setup_live_transition");
      }
      this.#storage.sql.exec(
        `UPDATE runtime_controller_state
         SET live_at = ?, presence_grace_until = ?, runtime_usage_json = NULL,
             browser_media_ready_deadline_at = CASE WHEN opening_state = 'pending' AND provider_creation_started = 1 THEN ? ELSE NULL END
         WHERE run_id = ?`,
        input.liveEvidenceAt,
        input.presenceGraceUntil,
        input.liveEvidenceAt + 15_000,
        input.runId,
      );
      this.#persistAggregateInTransaction(aggregate, [], undefined, {
        liveDeadlineAt: input.deadlineAt,
      });
      outcome = "live";
    });
    return outcome;
  }

  commitSetupFailure(
    runId: string,
    observedAt: number,
    materializedAt: number,
  ): "failed" | "unchanged" {
    let outcome: "failed" | "unchanged" = "unchanged";
    this.#writeAggregateTransaction(() => {
      const state = this.requireState(runId);
      const decision = decideRuntimeSetupTransition(toSetupTransitionState(state), {
        kind: "setup_failed",
        observedAt,
      });
      if (decision.kind === "unchanged") return;
      if (decision.kind !== "commit_failed_start") {
        throw new Error("invalid_setup_failure_transition");
      }
      this.#persistFailedStartInTransaction(state, decision.endedAt, materializedAt);
      outcome = "failed";
    });
    return outcome;
  }

  finishSetupCleanup(runId: string): void {
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state SET setup_cleanup_pending = 0 WHERE run_id = ?`,
      runId,
    );
  }

  recordFailedStartPublication(
    input: Readonly<{
      runId: string;
      pending: boolean;
      retryAt: number | null;
      deliveredAt: number | null;
      error: string | null;
      attemptCount: number;
      status: Exclude<FailedStartPublicationStatus, "inactive">;
    }>,
  ): void {
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state SET callback_pending = ?, callback_retry_at = ?,
       callback_delivered_at = ?, callback_last_error = ?, callback_attempt_count = ?,
       failed_start_publication_status = ?
       WHERE run_id = ? AND phase = 'failed' AND live_at IS NULL`,
      input.pending ? 1 : 0,
      input.retryAt,
      input.deliveredAt,
      input.error,
      input.attemptCount,
      input.status,
      input.runId,
    );
  }

  /** Keeps the execution's own state for the Run, replacing what it kept before. */
  recordExecutionState(runId: string, stateJson: string): void {
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state SET execution_state_json = ? WHERE run_id = ?`,
      stateJson,
      runId,
    );
  }

  setSessionGeneration(runId: string, generation: number): void {
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state
       SET session_generation = ?, execution_wake_at = NULL WHERE run_id = ?`,
      generation,
      runId,
    );
  }

  markSessionConnected(runId: string, startedAt: number): void {
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state SET session_connected_at = ?
       WHERE run_id = ? AND session_connected_at IS NULL`,
      startedAt,
      runId,
    );
  }

  markSessionDisconnected(runId: string, closedAt: number): void {
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state SET session_disconnected_at = ?
       WHERE run_id = ? AND session_disconnected_at IS NULL`,
      closedAt,
      runId,
    );
  }

  scheduleExecutionWake(runId: string, reconnectAt: number): void {
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state SET execution_wake_at = ?
       WHERE run_id = ? AND phase IN ('live', 'ending')`,
      reconnectAt,
      runId,
    );
  }

  clearExecutionWake(runId: string): void {
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state SET execution_wake_at = NULL WHERE run_id = ?`,
      runId,
    );
  }

  persistAggregate(
    aggregate: InterviewFinalizationAggregate,
    events: readonly RuntimePublicEvent[] | null,
    providerPersistence?: ProviderObservationPersistence,
    options: AggregatePersistenceOptions = {},
  ): void {
    this.#writeAggregateTransaction(() => {
      this.#persistAggregateInTransaction(
        aggregate,
        events ?? [],
        providerPersistence,
        undefined,
        options,
      );
    });
  }

  #writeAggregateTransaction(write: () => void): void {
    this.#crashInjector?.("before_aggregate_write");
    this.#storage.transactionSync(write);
    this.#crashInjector?.("after_aggregate_write");
  }

  #persistFailedStartInTransaction(
    state: RuntimeControllerRow,
    endedAt: number,
    materializedAt: number,
  ): void {
    const runtimeUsage = parseRuntimeUsageAccountingState(state.runtime_usage_json);
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state
       SET phase = 'failed', deadline_at = NULL, completion_json = ?,
           callback_pending = 1, callback_retry_at = ?, setup_cleanup_pending = 1,
           failed_start_publication_cutoff_at = ?, failed_start_publication_status = 'pending'
       WHERE run_id = ? AND phase = 'setup' AND live_at IS NULL`,
      JSON.stringify({
        runId: state.run_id,
        outcome: "failed_to_start",
        endedAt,
        runtimeUsage:
          runtimeUsage === null
            ? { completeness: "incomplete", observations: [] }
            : sealRuntimeUsage(runtimeUsage),
      }),
      materializedAt,
      materializedAt + interviewResultPublicationPeriodMs,
      state.run_id,
    );
  }

  markEffectSending(effectId: string): void {
    const aggregate = this.readAggregate();
    const state = {
      ...aggregate.state,
      effects: aggregate.state.effects.map((effect) =>
        effect.id === effectId ? { ...effect, status: "sending" as const } : effect,
      ),
    };
    this.persistAggregate({ ...aggregate, state }, null);
  }

  hasProviderEventIdentity(providerEventId: string): boolean {
    return (
      this.#storage.sql
        .exec<{ provider_event_id: string }>(
          `SELECT provider_event_id FROM runtime_provider_event_ids
           WHERE provider_event_id = ? LIMIT 1`,
          providerEventId,
        )
        .toArray().length > 0
    );
  }

  persistProviderObservation(input: ProviderObservationPersistence): void {
    this.#storage.transactionSync(() => this.#persistProviderObservation(input));
  }

  persistSetupProviderObservation(
    input: ProviderObservationPersistence,
    evidence: readonly ConversationUsageEvidence[],
  ): void {
    this.#storage.transactionSync(() => {
      const state = this.requireState();
      const runtimeUsage = parseRuntimeUsageAccountingState(state.runtime_usage_json);
      if (runtimeUsage !== null) {
        const next = applyRuntimeUsageEvidence(runtimeUsage, evidence);
        this.#storage.sql.exec(
          "UPDATE runtime_controller_state SET runtime_usage_json = ? WHERE run_id = ?",
          JSON.stringify(next),
          state.run_id,
        );
      }
      this.#persistProviderObservation(input);
    });
  }

  markSetupRuntimeUsageIncomplete(runId: string): void {
    const state = this.requireState(runId);
    const runtimeUsage = parseRuntimeUsageAccountingState(state.runtime_usage_json);
    if (runtimeUsage === null) return;
    this.#storage.sql.exec(
      "UPDATE runtime_controller_state SET runtime_usage_json = ? WHERE run_id = ?",
      JSON.stringify(markRuntimeUsageIncomplete(runtimeUsage)),
      runId,
    );
  }

  recordControllerEvent(eventName: string, data: RuntimeControllerEventData = {}): void {
    this.#recordControllerEventRaw(eventName, data);
  }

  readEventsAfter(cursor: number, limit = 100): RuntimeControllerEventRow[] {
    return this.#storage.sql
      .exec<RuntimeControllerEventRow>(
        `SELECT id, event_name, payload_json FROM runtime_controller_events
         WHERE id > ? ORDER BY id ASC LIMIT ?`,
        cursor,
        limit,
      )
      .toArray();
  }

  readEventsByName(eventName: string): RuntimeControllerEventRow[] {
    return this.#storage.sql
      .exec<RuntimeControllerEventRow>(
        `SELECT id, event_name, payload_json FROM runtime_controller_events
         WHERE event_name = ? ORDER BY id ASC`,
        eventName,
      )
      .toArray();
  }

  #createSchema(): void {
    this.#storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS runtime_acceptance_fence (run_id TEXT PRIMARY KEY)",
    );
    this.#storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS runtime_controller_state (
        run_id TEXT PRIMARY KEY,
        controller_identity TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('setup', 'live', 'ending', 'ended', 'failed')),
        created_at INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        live_at INTEGER,
        deadline_at INTEGER,
        startup_expires_at INTEGER,
        fake_session_id TEXT,
        session_id TEXT,
        session_location TEXT,
        upstream_request_id TEXT,
        session_reply_json TEXT,
        settings_summary_json TEXT,
        session_connected_at INTEGER,
        session_disconnected_at INTEGER,
        session_event_count INTEGER NOT NULL DEFAULT 0,
        session_generation INTEGER NOT NULL DEFAULT 0,
        execution_wake_at INTEGER,
        execution_state_json TEXT,
        transcript_json TEXT,
        transcript_turn_count INTEGER NOT NULL DEFAULT 0,
        readiness_attempted_at INTEGER,
        readiness_delivered_at INTEGER,
        readiness_disposition TEXT,
        pending_close_reason TEXT,
        pending_close_source TEXT,
        pending_close_requested_at INTEGER,
        completion_json TEXT,
        diagnostics_context_json TEXT,
        callback_pending INTEGER NOT NULL DEFAULT 0,
        callback_delivered_at INTEGER,
        callback_retry_at INTEGER,
        callback_attempt_count INTEGER NOT NULL DEFAULT 0,
        callback_last_error TEXT,
        failed_start_publication_cutoff_at INTEGER,
        failed_start_publication_status TEXT NOT NULL DEFAULT 'inactive',
        browser_media_ready_at INTEGER,
        browser_media_ready_deadline_at INTEGER,
        opening_state TEXT,
        presence_last_seen_at INTEGER,
        presence_grace_until INTEGER,
        presence_media_present INTEGER,
        presence_signal_count INTEGER NOT NULL DEFAULT 0,
        finalization_state_json TEXT,
        transcript_capture_json TEXT,
        transcript_revision INTEGER,
        transcript_digest TEXT,
        next_provider_sequence INTEGER NOT NULL DEFAULT 1,
        next_effect_sequence INTEGER NOT NULL DEFAULT 1,
        next_event_sequence INTEGER NOT NULL DEFAULT 1,
        frozen_transcript_json TEXT,
        frozen_transcript_revision INTEGER,
        frozen_transcript_digest TEXT,
        frozen_transcript_turn_count INTEGER,
        publication_json TEXT,
        runtime_usage_json TEXT
      )`,
    );
    const columns: readonly (readonly [string, string])[] = [
      ["controller_identity", "TEXT"],
      ["session_id", "TEXT"],
      ["session_location", "TEXT"],
      ["upstream_request_id", "TEXT"],
      ["session_reply_json", "TEXT"],
      ["conversation_profile", "TEXT"],
      ["conversation_start_json", "TEXT"],
      ["agent_selection_json", "TEXT"],
      ["conversation_selection_json", "TEXT"],
      ["connection_exchange_id", "TEXT"],
      ["connection_fingerprint", "TEXT"],
      ["connection_reply_json", "TEXT"],
      ["connection_checkpoint_json", "TEXT"],
      ["settings_summary_json", "TEXT"],
      ["session_connected_at", "INTEGER"],
      ["session_disconnected_at", "INTEGER"],
      ["session_event_count", "INTEGER NOT NULL DEFAULT 0"],
      ["session_generation", "INTEGER NOT NULL DEFAULT 0"],
      ["execution_wake_at", "INTEGER"],
      ["execution_state_json", "TEXT"],
      ["transcript_json", "TEXT"],
      ["transcript_turn_count", "INTEGER NOT NULL DEFAULT 0"],
      ["delivery_target_json", "TEXT"],
      ["readiness_attempted_at", "INTEGER"],
      ["readiness_delivered_at", "INTEGER"],
      ["readiness_disposition", "TEXT"],
      ["startup_expires_at", "INTEGER"],
      ["pending_close_reason", "TEXT"],
      ["pending_close_source", "TEXT"],
      ["pending_close_requested_at", "INTEGER"],
      ["diagnostics_context_json", "TEXT"],
      ["browser_media_ready_at", "INTEGER"],
      ["browser_media_ready_deadline_at", "INTEGER"],
      ["opening_state", "TEXT"],
      ["presence_last_seen_at", "INTEGER"],
      ["presence_grace_until", "INTEGER"],
      ["presence_media_present", "INTEGER"],
      ["presence_signal_count", "INTEGER NOT NULL DEFAULT 0"],
      ["finalization_state_json", "TEXT"],
      ["transcript_capture_json", "TEXT"],
      ["transcript_revision", "INTEGER"],
      ["transcript_digest", "TEXT"],
      ["next_provider_sequence", "INTEGER NOT NULL DEFAULT 1"],
      ["next_effect_sequence", "INTEGER NOT NULL DEFAULT 1"],
      ["next_event_sequence", "INTEGER NOT NULL DEFAULT 1"],
      ["frozen_transcript_json", "TEXT"],
      ["frozen_transcript_revision", "INTEGER"],
      ["frozen_transcript_digest", "TEXT"],
      ["frozen_transcript_turn_count", "INTEGER"],
      ["publication_json", "TEXT"],
      ["setup_cleanup_pending", "INTEGER NOT NULL DEFAULT 0"],
      ["provider_creation_started", "INTEGER NOT NULL DEFAULT 0"],
      ["runtime_usage_json", "TEXT"],
      ["failed_start_publication_cutoff_at", "INTEGER"],
      ["failed_start_publication_status", "TEXT NOT NULL DEFAULT 'inactive'"],
    ];
    for (const [name, definition] of columns) this.#ensureColumn(name, definition);
    // Retired NOT NULL duplicate of the Conversation-owned interviewing duration.
    if (this.#hasColumn("max_duration_ms"))
      this.#storage.sql.exec("ALTER TABLE runtime_controller_state DROP COLUMN max_duration_ms");
    this.#backfillControllerIdentity();
    this.#boundLegacyFailedStartPublication(Date.now());
    this.#storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS runtime_controller_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_name TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      )`,
    );
    this.#storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS runtime_provider_event_ids (
        provider_event_id TEXT PRIMARY KEY
      )`,
    );
  }

  #persistAggregateInTransaction(
    aggregate: InterviewFinalizationAggregate,
    events: readonly RuntimePublicEvent[],
    providerPersistence?: ProviderObservationPersistence,
    operationalFacts?: Readonly<{ liveDeadlineAt: number | null }>,
    options: AggregatePersistenceOptions = {},
  ): void {
    const persisted = this.#readRawState();
    if (persisted === null) throw new Error("runtime_controller_not_started");
    // The write side of the storage boundary: the owned aggregate is checked once against the
    // schema's cross-field facts, which its type cannot express, before it is stored.
    if (aggregate.runId !== persisted.run_id || !isInterviewFinalizationAggregate(aggregate)) {
      throw new Error("invalid_finalization_state");
    }
    if (providerPersistence !== undefined) this.#persistProviderObservation(providerPersistence);
    const projection = projectInterviewFinalizationPersistence(
      aggregate,
      persistenceFacts(persisted, operationalFacts?.liveDeadlineAt),
    );
    const storedProjection = serializePersistenceProjection(projection);
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state
       SET phase = ?, deadline_at = ?, session_generation = ?, transcript_json = ?,
           transcript_turn_count = ?, pending_close_reason = ?, pending_close_source = ?,
           pending_close_requested_at = ?, completion_json = ?, finalization_state_json = ?,
           transcript_capture_json = ?, transcript_revision = ?, transcript_digest = ?,
           next_provider_sequence = ?, next_effect_sequence = ?, next_event_sequence = ?,
           frozen_transcript_json = ?, frozen_transcript_revision = ?,
           frozen_transcript_digest = ?, frozen_transcript_turn_count = ?, publication_json = ?,
           callback_pending = ?, callback_delivered_at = ?,
           callback_retry_at = ?, callback_attempt_count = ?, callback_last_error = ?
       WHERE run_id = ?`,
      storedProjection.phase,
      storedProjection.deadlineAt,
      aggregate.providerGeneration,
      storedProjection.transcriptJson,
      storedProjection.transcriptTurnCount,
      storedProjection.pendingCloseReason,
      storedProjection.pendingCloseSource,
      storedProjection.pendingCloseRequestedAt,
      storedProjection.completionJson,
      JSON.stringify(aggregate),
      JSON.stringify(aggregate.transcriptCapture),
      aggregate.transcriptRevision,
      aggregate.transcriptDigest,
      aggregate.nextProviderSequence,
      aggregate.nextEffectSequence,
      aggregate.nextEventSequence,
      storedProjection.frozenTranscriptJson,
      storedProjection.frozenRevision,
      storedProjection.frozenDigest,
      storedProjection.frozenTurnCount,
      storedProjection.publicationJson,
      storedProjection.callbackPending ? 1 : 0,
      storedProjection.callbackDeliveredAt,
      storedProjection.callbackRetryAt,
      storedProjection.callbackAttemptCount,
      storedProjection.callbackLastError,
      persisted.run_id,
    );
    for (const event of events) {
      this.#runtimeEvents().recordEvent(event.type, { eventId: event.id, ...event.payload });
    }
    if (options.diagnostic !== undefined) {
      this.#recordRuntimeDiagnosticInTransaction(persisted, options.diagnostic);
    }
  }

  #recordRuntimeDiagnosticInTransaction(
    row: RuntimeControllerRow,
    diagnostic: NonNullable<AggregatePersistenceOptions["diagnostic"]>,
  ): void {
    this.#runtimeEvents(row).recordUniqueDiagnostic(
      diagnostic.type,
      () => true,
      diagnostic.payload,
      {
        observedAt: diagnostic.observedAt,
      },
    );
  }

  #projectionMismatches(
    row: RuntimeControllerRow,
    aggregate: InterviewFinalizationAggregate,
  ): string[] {
    const projection = projectInterviewFinalizationPersistence(aggregate, persistenceFacts(row));
    const storedProjection = serializePersistenceProjection(projection);
    const checks: readonly (readonly [string, unknown, unknown])[] = [
      ["phase", row.phase, storedProjection.phase],
      ["deadline_at", row.deadline_at, storedProjection.deadlineAt],
      ["session_generation", row.session_generation, aggregate.providerGeneration],
      ["transcript_json", row.transcript_json, storedProjection.transcriptJson],
      ["transcript_turn_count", row.transcript_turn_count, storedProjection.transcriptTurnCount],
      ["pending_close_reason", row.pending_close_reason, storedProjection.pendingCloseReason],
      ["pending_close_source", row.pending_close_source, storedProjection.pendingCloseSource],
      [
        "pending_close_requested_at",
        row.pending_close_requested_at,
        storedProjection.pendingCloseRequestedAt,
      ],
      ["completion_json", row.completion_json, storedProjection.completionJson],
      [
        "transcript_capture_json",
        row.transcript_capture_json,
        JSON.stringify(aggregate.transcriptCapture),
      ],
      ["transcript_revision", row.transcript_revision, aggregate.transcriptRevision],
      ["transcript_digest", row.transcript_digest, aggregate.transcriptDigest],
      ["next_provider_sequence", row.next_provider_sequence, aggregate.nextProviderSequence],
      ["next_effect_sequence", row.next_effect_sequence, aggregate.nextEffectSequence],
      ["next_event_sequence", row.next_event_sequence, aggregate.nextEventSequence],
      ["frozen_transcript_json", row.frozen_transcript_json, storedProjection.frozenTranscriptJson],
      [
        "frozen_transcript_revision",
        row.frozen_transcript_revision,
        storedProjection.frozenRevision,
      ],
      ["frozen_transcript_digest", row.frozen_transcript_digest, storedProjection.frozenDigest],
      [
        "frozen_transcript_turn_count",
        row.frozen_transcript_turn_count,
        storedProjection.frozenTurnCount,
      ],
      ["publication_json", row.publication_json, storedProjection.publicationJson],
      ["callback_pending", row.callback_pending, storedProjection.callbackPending ? 1 : 0],
      ["callback_delivered_at", row.callback_delivered_at, storedProjection.callbackDeliveredAt],
      ["callback_retry_at", row.callback_retry_at, storedProjection.callbackRetryAt],
      ["callback_attempt_count", row.callback_attempt_count, storedProjection.callbackAttemptCount],
      ["callback_last_error", row.callback_last_error, storedProjection.callbackLastError],
    ];
    return checks.flatMap(([name, actual, expected]) => (actual !== expected ? [name] : []));
  }

  #persistProviderObservation(input: ProviderObservationPersistence): void {
    if (input.providerEventId !== undefined) {
      this.#persistProviderEventIdentity(input.providerEventId);
    }
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state SET session_event_count = ? WHERE session_id = ?`,
      input.sequence,
      input.sessionId,
    );
    this.#runtimeEvents().recordEvent("session.provider_event", input.diagnosticSummary);
  }

  #persistProviderEventIdentity(providerEventId: string): void {
    this.#storage.sql.exec(
      `INSERT OR IGNORE INTO runtime_provider_event_ids (provider_event_id) VALUES (?)`,
      providerEventId,
    );
  }

  #recordControllerEventRaw(eventName: string, data: RuntimeControllerEventData = {}): void {
    const state = this.#readRawState();
    const now = Date.now();
    const redacted = redactSecrets(data);
    const eventData = {
      event: eventName,
      observedAt: new Date(now).toISOString(),
      runId: state?.run_id,
      sessionId: state?.session_id ?? state?.fake_session_id ?? undefined,
    };
    if (isRecord(redacted)) {
      Object.defineProperties(eventData, Object.getOwnPropertyDescriptors(redacted));
    }
    const payload = withoutUndefined(eventData);
    this.#storage.sql.exec(
      `INSERT INTO runtime_controller_events (event_name, observed_at, payload_json)
       VALUES (?, ?, ?)`,
      eventName,
      now,
      JSON.stringify(payload),
    );
  }

  #runtimeEvents(row = this.#readRawState()): RuntimeEvents {
    return new RuntimeEvents(this, () => this.eventContext(row));
  }

  #hasControllerEvent(
    eventName: string,
    predicate: (payload: Record<string, unknown>) => boolean,
  ): boolean {
    return this.#storage.sql
      .exec<{ payload_json: string }>(
        `SELECT payload_json FROM runtime_controller_events
         WHERE event_name = ? ORDER BY id ASC`,
        eventName,
      )
      .toArray()
      .some((row) => predicate(parseJsonObject(row.payload_json) ?? {}));
  }

  #readRawState(): RuntimeControllerRow | null {
    const rows = this.#storage.sql
      .exec<RuntimeControllerRow>(`SELECT * FROM runtime_controller_state LIMIT 1`)
      .toArray();
    return rows[0] ?? null;
  }

  #ensureColumn(name: string, definition: string): void {
    try {
      this.#storage.sql.exec(
        `ALTER TABLE runtime_controller_state ADD COLUMN ${name} ${definition}`,
      );
    } catch (error) {
      if (!describeError(error).toLowerCase().includes("duplicate")) throw error;
    }
  }

  #hasColumn(name: string): boolean {
    return this.#storage.sql
      .exec<{ name: string }>("PRAGMA table_info(runtime_controller_state)")
      .toArray()
      .some((row) => row.name === name);
  }

  #backfillControllerIdentity(): void {
    if (this.#hasColumn("controller_version")) {
      this.#storage.sql.exec(
        `UPDATE runtime_controller_state
         SET controller_identity = COALESCE(controller_identity, controller_version, ?)
         WHERE controller_identity IS NULL`,
        controllerIdentity,
      );
      return;
    }
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state SET controller_identity = ? WHERE controller_identity IS NULL`,
      controllerIdentity,
    );
  }

  #boundLegacyFailedStartPublication(cutoffAt: number): void {
    this.#storage.sql.exec(
      `UPDATE runtime_controller_state
       SET failed_start_publication_cutoff_at = ?, callback_retry_at = ?,
           failed_start_publication_status =
             CASE WHEN callback_attempt_count = 0 THEN 'pending' ELSE 'retrying' END
       WHERE phase = 'failed' AND live_at IS NULL AND callback_pending = 1
         AND failed_start_publication_cutoff_at IS NULL`,
      cutoffAt,
      cutoffAt,
    );
  }
}

function toSetupTransitionState(row: RuntimeControllerRow) {
  return {
    phase: row.phase,
    startupExpiresAt: row.startup_expires_at,
  } as const;
}

function persistenceFacts(row: RuntimeControllerRow, liveDeadlineAt?: number | null) {
  const establishedLiveDeadline = liveDeadlineAt !== undefined ? liveDeadlineAt : row.deadline_at;
  return {
    liveDeadlineAt: establishedLiveDeadline,
    deliveryConfigured: row.delivery_target_json != null,
  };
}

function serializePersistenceProjection(projection: InterviewFinalizationPersistence) {
  return {
    phase: projection.phase,
    deadlineAt: projection.deadlineAt,
    transcriptJson: JSON.stringify({ turns: projection.transcriptTurns }),
    transcriptTurnCount: projection.transcriptTurns.length,
    pendingCloseReason: projection.pendingClose?.endReason ?? null,
    pendingCloseSource: projection.pendingClose?.source ?? null,
    pendingCloseRequestedAt: projection.pendingClose?.requestedAt ?? null,
    completionJson: projection.completion === null ? null : JSON.stringify(projection.completion),
    frozenTranscriptJson:
      projection.frozenTranscript === null
        ? null
        : JSON.stringify({ turns: projection.frozenTranscript.turns }),
    frozenRevision: projection.frozenTranscript?.revision ?? null,
    frozenDigest: projection.frozenTranscript?.digest ?? null,
    frozenTurnCount: projection.frozenTranscript?.turnCount ?? null,
    publicationJson:
      projection.publication === null ? null : JSON.stringify(projection.publication),
    callbackPending: projection.publicationDelivery.pending,
    callbackDeliveredAt: projection.publicationDelivery.deliveredAt,
    callbackRetryAt: projection.publicationDelivery.retryAt,
    callbackAttemptCount: projection.publication?.attemptCount ?? 0,
    callbackLastError: projection.publicationDelivery.lastError,
  };
}

function fingerprintFinalizationState(value: string | null): string {
  if (value === null) return "missing";
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${value.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function describeError<ErrorValue>(error: ErrorValue): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord<Value>(value: Value): value is Value & Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
