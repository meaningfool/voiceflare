import type { RuntimeReasoningEffort } from "../shared/contracts/runtimeStart.ts";
import type { RuntimeEventRecorder } from "./runtimeEvents.ts";
import type {
  ExecutionObservation,
  InputClosureSettlement,
  ProviderObservationOrder,
} from "./interviewFinalizationModel.ts";
import type { ConversationCallbackJson } from "./conversationContracts.ts";
import type { ResultWarning } from "../shared/runtimeControllerCallback.ts";
import type { PreparedConversationNode } from "./nodeContentContracts.ts";
export type ReasoningEffort = RuntimeReasoningEffort;
/**
 * An execution's prepared session settings, in that execution's own format. Runtime stores them
 * as they are, hands them back to the execution after a restart and never reads them.
 */
export type PreparedExecutionSettings = ConversationCallbackJson;
/** What the selected execution prepares its settings from: the Run's start choices. */
export type ExecutionSettingsPreparation = Readonly<{
  reasoningEffort: ReasoningEffort | null;
  /** The start request's execution settings, in the selected execution's format; opaque here. */
  requested?: ConversationCallbackJson | undefined;
}>;
/**
 * Runtime's credentials as one set, by name, such as `OPENAI_API_KEY`: each provider declares the
 * credentials it needs and takes its own from the set. A credential is present when it is set and
 * not empty.
 */
export type ExecutionCredentials = Readonly<Record<string, string>>;
/** The declared credentials the set lacks, in their declared order. */
export function missingCredentials(
  declared: readonly string[],
  credentials: ExecutionCredentials,
): readonly string[] {
  return declared.filter((name) => (credentials[name] ?? "").length === 0);
}
/** The execution's summary of its prepared settings, which Runtime keeps for diagnostics. */
export type ExecutionSettingsSummary = Readonly<Record<string, unknown>>;
/**
 * One of Ending's steps that an execution carries out on its session, under the step's
 * `commandId` (`finalizationEffectKinds` names what each achieves). Release goes through the
 * session's `release`.
 * - `cancel_reply` names the reply to cancel. A reply that already finished answers "nothing to
 *   cancel" with `nothing_to_cancel`;
 * - `close_input` carries the participant item Runtime already holds, if any: that answer needs
 *   no settling, and only an answer Runtime does not hold may be settled. The step answers
 *   "settled" through the answer's reports, or "nothing to settle" with `nothing_to_settle`.
 */
export type EndingOperation =
  | Readonly<{ kind: "cancel_reply"; commandId: string; responseId: string }>
  | Readonly<{ kind: "stop_output" | "discard_later_input"; commandId: string }>
  | Readonly<{ kind: "close_input"; commandId: string; heldItemId: string | null }>;
/**
 * What an execution answers when Runtime dispatches an Ending operation: whether it went out, and
 * for `close_input`, how the execution carries out the step's settlement.
 */
export type EndingOperationDispatch =
  | Readonly<{ status: "dispatched"; settlement?: InputClosureSettlement }>
  | Readonly<{ status: "failed" | "uncertain"; code: string; settlement?: InputClosureSettlement }>;
export type ProviderTranscriptRole = "participant" | "conversationAgent";
export type ProviderSessionRecord = Readonly<{
  runId: string;
  sessionId: string | null;
  generation: number;
  eventCount: number;
  initialConnection: boolean;
  /** The execution's prepared settings as Runtime stored them at setup. */
  preparedSettings?: PreparedExecutionSettings;
  observeAllProviderEvents?: boolean;
  connectionRequired: boolean;
  retired?: boolean;
  startupExpiresAt?: number | null;
  canStartConversation?: boolean;
  canSendOpening?: boolean;
  participantInputClosed?: boolean;
  eligibleParticipantInputIds?: readonly string[];
  browserMediaReady?: boolean;
  openingState?: "pending" | "claimed" | "sent" | null;
  /** The execution's own durable state, as it last recorded it. Runtime never reads it. */
  executionState?: ConversationCallbackJson | null;
}>;
export type ProviderObservationPersistence = Readonly<{
  sessionId: string;
  sequence: number;
  providerEventId?: string;
  diagnosticSummary: Readonly<Record<string, unknown>>;
  excludedParticipantInput?: true;
}>;
export type ProviderReceiptPrefix = Readonly<{
  receivedOrder: ProviderObservationOrder | null;
  processedThroughOrder: ProviderObservationOrder | null;
}>;
export type ProviderSessionStorage = Readonly<{
  read(): ProviderSessionRecord | null;
  claimOpening(runId: string): boolean;
  markOpeningSent(runId: string): void;
  recordSessionIdentity(
    input: Readonly<{
      runId: string;
      sessionId: string;
      sessionLocation: string | null;
      upstreamRequestId: string | null;
      settingsSummary: Readonly<Record<string, unknown>>;
    }>,
  ): void | Promise<void>;
  recordSessionReply(
    input: Readonly<{
      runId: string;
      sessionId: string;
      /** The profile's connection reply, which a replayed Start answers again. */
      reply: import("../shared/contracts/runtimeConnection.ts").ConnectionPayload;
    }>,
  ): void | Promise<void>;
  setGeneration(runId: string, generation: number): void;
  markStarted(runId: string, startedAt: number): void;
  markClosed(runId: string, closedAt: number): void;
  /** Wakes the execution at `wakeAt`, through Runtime's alarm, which calls `ensureConnected`. */
  scheduleWake(runId: string, wakeAt: number): void;
  hasEventIdentity(providerEventId: string): boolean;
  /** Keeps the execution's own state across a Runtime restart, replacing what it kept before. */
  recordExecutionState?(runId: string, state: ConversationCallbackJson): void;
}>;
export type ProviderSessionBackgroundWork = Readonly<{
  waitUntil(task: Promise<unknown>): void;
}>;
export type ProviderSessionEvents = Pick<
  RuntimeEventRecorder,
  "notifyControl" | "recordStartup" | "recordLiveDegradation" | "executionDiagnostics"
>;
export type ProviderSessionApplicationFact =
  | Readonly<{
      kind: "execution_ready";
      runId: string;
      at: number;
    }>
  | Readonly<{
      // Runtime saves the report. One it cannot save is a Runtime failure that Runtime applies
      // itself, as a `failure` of the message: the sink still resolves.
      kind: "provider_observation";
      observation: ExecutionObservation | null;
      persistence: ProviderObservationPersistence;
    }>
  | Readonly<{
      kind: "failure";
      failure: "session" | "message";
      errorText: string;
      applyRuntimeFailure: boolean;
    }>
  /**
   * The execution's session carries Runtime's work again, after it reconnected, and orders its
   * reports from `generation` on: Runtime applies overdue work and dispatches node work it held.
   */
  | Readonly<{ kind: "execution_resumed"; generation: number }>
  /**
   * The execution lost its session before Runtime's release: during Live the Run ends
   * interrupted, its failure named `source`; during Ending the session reports nothing more, so
   * Runtime reconsiders the result at once. Unlike a node's or a message's failure, the loss
   * belongs to no Conversation visit.
   */
  | Readonly<{ kind: "session_lost"; source: string }>
  /** The execution's session ended normally after Runtime's release. */
  | Readonly<{ kind: "session_released" }>
  /** The execution scheduled a wake-up with `scheduleWake`. */
  | Readonly<{ kind: "wake_scheduled" }>
  /** A warning the execution attaches to the Run's result. */
  | Readonly<{ kind: "result_warning"; warning: ResultWarning }>
  | Readonly<{ kind: "message_queue_drained" }>;
export type ProviderSessionApplicationSink = (
  fact: ProviderSessionApplicationFact,
) => Promise<void>;
/**
 * The release step's answer, which the execution gives from its own evidence:
 * - `closed`: the session is closed;
 * - `close_unconfirmed`: the session's closure is not confirmed. A release that went through
 *   still lets the session confirm its closure later with an ordered `session_closed_observed`
 *   report; one that failed carries how.
 */
export type SessionReleaseAnswer =
  | Readonly<{ status: "closed" }>
  | Readonly<{
      status: "close_unconfirmed";
      failure?: Readonly<{ status: "failed" | "uncertain"; timedOut: boolean; code: string }>;
    }>;
/** The selected execution's start of its native session for an accepted connection exchange. */
export type SessionStartInput = Readonly<{
  runId: string;
  /** The browser's connection input for the Run's profile, such as Realtime's SDP offer. */
  connection: import("../shared/contracts/runtimeConnection.ts").ConnectionPayload | undefined;
  /** What the model receives in the Run's opening state. */
  content: PreparedConversationNode;
  /** The execution's prepared settings, as stored at setup. */
  settings: PreparedExecutionSettings;
  /** The execution's summary of those settings. */
  settingsSummary: ExecutionSettingsSummary;
  deadlineAt?: number;
}>;
export type SessionStartResult =
  | Readonly<{
      ok: true;
      /** The profile's connection reply to the browser, such as Realtime's SDP answer. */
      reply: import("../shared/contracts/runtimeConnection.ts").ConnectionPayload;
      sessionId: string;
      sessionLocation: string | null;
      upstreamRequestId: string | null;
      settingsSummary: ExecutionSettingsSummary;
    }>
  | Readonly<{ ok: false; error: string; reason: string }>;

export type { ProviderObservationOrder } from "./interviewFinalizationModel.ts";
export type ProviderSession = import("./runtimeHostAssembly.ts").SelectedProviderSession;
