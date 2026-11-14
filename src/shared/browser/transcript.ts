export type TranscriptRole = "participant" | "conversationAgent";

export type TranscriptTurn = {
  role: TranscriptRole;
  text: string;
};

export type Transcript = {
  turns: TranscriptTurn[];
};

export type RealtimeSessionSummary = {
  model?: string;
  voice?: string;
  reasoningEffort?: string;
  inputNoiseReduction?: {
    type?: string;
  };
  turnDetection?: {
    type?: string;
    createResponse?: boolean;
    interruptResponse?: boolean;
    eagerness?: string;
    threshold?: number;
  };
};

export type TranscriptCompletionReviewStatus = "clean" | "warning";

export type OrderedTranscriptTurn = TranscriptTurn & {
  turnNumber: number;
  roleLabel: string;
};

export type InterviewTiming = {
  startedLabel: string;
  endedLabel: string;
  durationLabel: string;
  statusLabel: string;
};

export type InterviewTimingSource = {
  startedAt: number;
  endedAt?: number;
  completedAt?: number;
  outcome?: "ended" | "failed";
  endReason?: string;
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** The words an app shows for each Transcript role. */
export type TranscriptRoleLabels = Readonly<Record<TranscriptRole, string>>;

export function getOrderedTranscriptTurns(
  transcript: Transcript,
  roleLabels: TranscriptRoleLabels,
): OrderedTranscriptTurn[] {
  return transcript.turns.map((turn, index) => ({
    ...turn,
    turnNumber: index + 1,
    roleLabel: roleLabels[turn.role],
  }));
}

export function formatDuration(startedAt: number, completedAt: number): string {
  const durationMs = Math.max(0, completedAt - startedAt);
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  if (seconds === 0) {
    return `${minutes}m`;
  }

  return `${minutes}m ${seconds}s`;
}

export function getInterviewTiming(interview: InterviewTimingSource): InterviewTiming {
  const endedAt = interview.endedAt ?? interview.completedAt;
  const statusLabel = getInterviewStatusLabel(interview);

  if (endedAt === undefined) {
    return {
      startedLabel: dateTimeFormatter.format(new Date(interview.startedAt)),
      endedLabel: statusLabel === "Failed" ? "Failed" : "In progress",
      durationLabel: statusLabel === "Failed" ? "Failed" : "In progress",
      statusLabel,
    };
  }

  return {
    startedLabel: dateTimeFormatter.format(new Date(interview.startedAt)),
    endedLabel: dateTimeFormatter.format(new Date(endedAt)),
    durationLabel: formatDuration(interview.startedAt, endedAt),
    statusLabel,
  };
}

function getInterviewStatusLabel(interview: InterviewTimingSource): string {
  if (interview.outcome === "failed") {
    return "Failed";
  }

  if (interview.endReason === "participant_disconnected") {
    return "Disconnected";
  }

  if (interview.endedAt !== undefined || interview.completedAt !== undefined) {
    return "Ended";
  }

  return "In Progress";
}
