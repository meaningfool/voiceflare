import type { LiveInterviewSetupStatus } from "./liveInterview";
import type { LabRealtimeSettings } from "./labRealtimeSettings";
import type { LabRunEndReason } from "../data/labRunStore";
import { getLiveInterviewStatusContent } from "./liveInterview";
import type {
  LabInterviewClient,
  LabInterviewConfig,
  LabInterviewStartRequest,
  LabInterviewStatus,
} from "../interviewClient";

/** The Realtime client's interview: the shared config and the Realtime run settings. */
export type LabRealtimeClientConfig = LabInterviewConfig & {
  realtimeSettings?: LabRealtimeSettings;
};

export type LabRealtimeClientStartRequest = LabInterviewStartRequest<LabRealtimeClientConfig>;

export type LabRealtimeClient = LabInterviewClient<LabRealtimeClientConfig>;

export type LabRealtimeClientTranscriptCompletionRequest = {
  completionStatus: "sidebandClosed" | "timedOut" | "sidebandUnavailable";
  completionReviewStatus: "clean" | "warning";
  completionDebugText: string;
  endReason: LabRunEndReason;
};

export type LabRealtimeClientTranscriptCompletionResult = {
  endedAt: number;
  transcriptTurnCount: number;
};

export type LabRealtimeClientTranscriptOutput = {
  complete: (
    request: LabRealtimeClientTranscriptCompletionRequest,
  ) => Promise<LabRealtimeClientTranscriptCompletionResult>;
};

export type LabRealtimeClientSetupFailureKind =
  | "browser_media"
  | "browser_peer"
  | "provider_signaling"
  | "runtime_worker_unavailable"
  | "session_setup"
  | "browser_runtime_event_stream";

export type LabRealtimeClientDiagnosticSource =
  | "browser"
  | "lab_worker"
  | "runtime_controller"
  | "provider";

export type LabRealtimeClientSetupFailure = {
  failureKind: LabRealtimeClientSetupFailureKind;
  source: LabRealtimeClientDiagnosticSource;
  errorText: string;
  code?: string;
};

export type LabRealtimeClientDiagnosticsOutput = {
  recordSetupFailure?: (request: LabRealtimeClientSetupFailure) => Promise<void>;
  recordLiveDegradation?: (request: {
    degradationKind:
      | "browser_runtime_event_stream"
      | "sideband_websocket"
      | "provider_error"
      | "session_failed";
    source: LabRealtimeClientDiagnosticSource;
    errorText?: string;
    code?: string;
  }) => Promise<void>;
  recordEndingStarted?: (request: {
    endReason?: LabRunEndReason;
    trigger?:
      | "browser_intent"
      | "controller_alarm"
      | "provider_tool_call"
      | "presence_grace_expired";
    source: LabRealtimeClientDiagnosticSource;
  }) => Promise<void>;
  recordFinalTurnFlushFinished?: (request: {
    status: "sidebandClosed" | "timedOut" | "sidebandUnavailable";
    inputCommitSent?: boolean;
    completionReviewStatus?: "clean" | "warning";
    debugText?: string;
  }) => Promise<void>;
};

export type LabRealtimeClientOutputs = {
  transcript: LabRealtimeClientTranscriptOutput;
  runtimeDiagnostics?: LabRealtimeClientDiagnosticsOutput;
};

export function mapLiveInterviewStatusToRuntimeStatus(
  status: LiveInterviewSetupStatus,
): LabInterviewStatus {
  const content = getLiveInterviewStatusContent(status);

  switch (status) {
    case "idle":
    case "creatingInterview":
    case "requestingMicrophone":
    case "microphoneReady":
    case "openingRealtimeCall":
    case "openingSideband":
      return {
        phase: "setup",
        label: content.label,
        detail: content.detail,
      };
    case "live":
      return {
        phase: "live",
        label: content.label,
        detail: content.detail,
      };
    case "finalizing":
      return {
        phase: "ending",
        label: content.label,
        detail: content.detail,
      };
    case "completed":
      return {
        phase: "ended",
        label: content.label,
        detail: content.detail,
        endStatus: "ended",
      };
    case "completedWithWarning":
      return {
        phase: "ended",
        label: content.label,
        detail: content.detail,
        endStatus: "endedWithWarning",
        transcriptWarning: {
          reviewStatus: "warning",
          summary: content.detail,
        },
      };
    case "completionFailed":
      return {
        phase: "failed",
        label: content.label,
        detail: content.detail,
        failureKind: "ending",
      };
    case "setupFailed":
      return {
        phase: "failed",
        label: content.label,
        detail: content.detail,
        failureKind: "setup",
      };
  }
}
