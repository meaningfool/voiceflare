import type { ConversationSelection } from "../../../worker/shared/contracts/conversationSelection.ts";
import type { InterviewPromptProvenance } from "./data/interviewPrompt";
import type { LabRunEndReason } from "./data/labRunStore";
import type { Transcript, TranscriptCompletionReviewStatus } from "../../shared/browser/transcript";

/**
 * What both Lab clients offer, the Realtime client and the Cascade client: the Lab page starts,
 * follows and ends an interview through this contract alone. Each client adds its own execution
 * settings to `LabInterviewConfig`.
 */
export type LabReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** The interview a Lab client starts: the selected Conversation's fields and the run's limits. */
export type LabInterviewConfig = {
  instructions: string;
  finishInterviewDescription?: string | undefined;
  questionPrompts?: readonly string[] | undefined;
  nextQuestionDescription?: string | undefined;
  closingSentence?: string | undefined;
  maximumClosingDurationMs?: number | undefined;
  selection?: ConversationSelection | undefined;
  maxDurationMs: number;
  reasoningEffort: LabReasoningEffort;
};

export type LabInterviewRunIdentity = {
  runId: string;
  startedAt: number;
};

export type LabInterviewStartRequest<Config extends LabInterviewConfig = LabInterviewConfig> = {
  signal?: AbortSignal;
  runtimeConfig: Config;
  promptProvenance?: InterviewPromptProvenance;
  onRunAllocated?: (runIdentity: LabInterviewRunIdentity) => void;
  onStatus?: LabInterviewStatusListener;
};

export type LabInterviewTranscriptWarning = {
  reviewStatus: TranscriptCompletionReviewStatus;
  summary: string;
};

export type LabInterviewTranscriptEvidence = {
  transcript: Transcript;
  turnCount: number;
  capturedAt?: number;
  warning?: LabInterviewTranscriptWarning;
};

export type LabInterviewEndStatus = "ended" | "endedWithWarning" | "cancelled";

export type LabInterviewDebugFact = {
  label: string;
  value: string;
};

export type LabInterviewNotice = {
  severity: "warning";
  text: string;
};

type LabInterviewStatusBase = {
  conversation?: Readonly<{ state: string; deadlineAt: number | null }>;
  label: string;
  detail: string;
  debugFacts?: LabInterviewDebugFact[];
  notice?: LabInterviewNotice;
};

export type LabInterviewStatus =
  | (LabInterviewStatusBase & {
      phase: "setup";
    })
  | (LabInterviewStatusBase & {
      phase: "live";
    })
  | (LabInterviewStatusBase & {
      phase: "ending";
    })
  | (LabInterviewStatusBase & {
      phase: "ended";
      endStatus: LabInterviewEndStatus;
      transcriptWarning?: LabInterviewTranscriptWarning;
    })
  | (LabInterviewStatusBase & {
      phase: "failed";
      failureKind: "setup" | "ending" | "runtime";
      errorText?: string;
      /** The code Lab or Runtime refused the Start with, such as `missing_credentials:<NAME>`. */
      startRefusal?: string;
    });

export type LabInterviewEndResult = {
  runId: string;
  endedAt: number;
  endStatus: LabInterviewEndStatus;
  transcriptEvidence: LabInterviewTranscriptEvidence;
  debugText?: string;
  terminalResult?: import("../../browser/runtimeTerminalResult").RuntimeTerminalResult;
};

export type LabInterviewStatusListener = (status: LabInterviewStatus) => void;

export type LabInterviewSession = {
  handle: LabInterviewRunIdentity;
  getStatus: () => LabInterviewStatus;
  subscribe: (listener: LabInterviewStatusListener) => () => void;
  complete: (endReason: LabRunEndReason) => Promise<LabInterviewEndResult>;
  cancel: (reason?: string) => Promise<LabInterviewEndResult | void>;
  getTranscriptEvidence: () => LabInterviewTranscriptEvidence;
};

/** A Lab client: the Realtime client and the Cascade client each start with their own config. */
export type LabInterviewClient<Config extends LabInterviewConfig = LabInterviewConfig> = {
  start: (request: LabInterviewStartRequest<Config>) => Promise<LabInterviewSession>;
};

export type LabInterviewStatusChannel = {
  getStatus: () => LabInterviewStatus;
  subscribe: (listener: LabInterviewStatusListener) => () => void;
  notify: (status: LabInterviewStatus) => void;
};

export function createLabInterviewStatusChannel(
  initialStatus: LabInterviewStatus,
): LabInterviewStatusChannel {
  let currentStatus = initialStatus;
  const listeners = new Set<LabInterviewStatusListener>();

  return {
    getStatus() {
      return currentStatus;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    notify(status) {
      currentStatus = status;

      for (const listener of listeners) {
        listener(status);
      }
    },
  };
}
