export type LiveInterviewSetupStatus =
  | "idle"
  | "creatingInterview"
  | "requestingMicrophone"
  | "microphoneReady"
  | "openingRealtimeCall"
  | "openingSideband"
  | "live"
  | "finalizing"
  | "completed"
  | "completedWithWarning"
  | "completionFailed"
  | "setupFailed";

export type UnfinishedInterviewDraft = {
  startedAt: number;
  transcript: {
    turns: [];
  };
};

export type LiveInterviewStatusContent = {
  label: string;
  detail: string;
};

export type FinalTurnFlushStatus = "sidebandClosed" | "timedOut" | "sidebandUnavailable";

export type CompletionReviewStatus = "clean" | "warning";

export type CompletionSaveResult = {
  id: string;
  endedAt: number;
  transcriptTurnCount: number;
} | null;

export type RealtimeControlChannel = {
  readyState: string;
  send: (data: string) => void;
};

export type LiveInterviewStartFailureKind = "browserSetup" | "providerSignaling" | "internal";

type StoppableTrack = {
  stop: () => void;
};

type MicrophonePreview = {
  getTracks: () => StoppableTrack[];
};

const LIVE_INTERVIEW_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export function buildLiveInterviewMediaConstraints(): MediaStreamConstraints {
  return {
    audio: LIVE_INTERVIEW_AUDIO_CONSTRAINTS,
  };
}

export function createUnfinishedInterviewDraft(startedAt: number): UnfinishedInterviewDraft {
  return {
    startedAt,
    transcript: {
      turns: [],
    },
  };
}

export function getLiveInterviewStatusContent(
  status: LiveInterviewSetupStatus,
): LiveInterviewStatusContent {
  switch (status) {
    case "creatingInterview":
      return {
        label: "Creating Interview",
        detail: "Lab is creating an unfinished interview record.",
      };
    case "requestingMicrophone":
      return {
        label: "Microphone Permission",
        detail: "The browser is asking for microphone access for this Interview setup.",
      };
    case "microphoneReady":
      return {
        label: "Microphone Ready",
        detail: "The browser microphone is ready for a Cloudflare-owned Realtime call.",
      };
    case "openingRealtimeCall":
      return {
        label: "Opening Realtime Call",
        detail: "Cloudflare is creating the OpenAI Realtime call with server-side credentials.",
      };
    case "openingSideband":
      return {
        label: "Opening Sideband",
        detail: "Cloudflare is attaching sideband control to the same live Interview.",
      };
    case "live":
      return {
        label: "Live",
        detail: "The browser is sending microphone media directly to OpenAI over WebRTC.",
      };
    case "finalizing":
      return {
        label: "Finalizing",
        detail: "Lab is waiting briefly for final transcript turns before completion.",
      };
    case "completed":
      return {
        label: "Completed",
        detail: "The Interview is completed and ready for Transcript review.",
      };
    case "completedWithWarning":
      return {
        label: "Completed With Transcript Warning",
        detail: "The Interview ended, but the Transcript may be incomplete or degraded.",
      };
    case "completionFailed":
      return {
        label: "Could Not Save Completion",
        detail: "Lab could not persist completion state for this interview.",
      };
    case "setupFailed":
      return {
        label: "Could Not Start Interview",
        detail: "The Interview did not reach a usable live state.",
      };
    case "idle":
      return {
        label: "Ready",
        detail:
          "Start Interview will create an unfinished Interview and request microphone access.",
      };
  }
}

export function describeMicrophoneSetupError(error: Error | string | undefined): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Microphone permission was denied.";
    }

    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return "No microphone was found for this browser.";
    }
  }

  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return "Microphone setup failed.";
}

export function describeLiveInterviewStartFailure(
  error: Error | string | undefined,
  kind: LiveInterviewStartFailureKind,
): string {
  const detail =
    kind === "browserSetup" ? describeMicrophoneSetupError(error) : describeUnknownError(error);

  switch (kind) {
    case "browserSetup":
      return `Browser setup failed: ${detail}`;
    case "providerSignaling":
      return `Provider/signaling failed: ${detail}`;
    case "internal":
      return `Internal setup failed: ${detail}`;
  }
}

export function stopMicrophonePreview(stream: MicrophonePreview): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

export function isLiveInterviewStarting(status: LiveInterviewSetupStatus): boolean {
  return (
    status === "creatingInterview" ||
    status === "requestingMicrophone" ||
    status === "openingRealtimeCall" ||
    status === "openingSideband"
  );
}

export function requireCompletionSaveResult(
  result: CompletionSaveResult,
): Exclude<CompletionSaveResult, null> {
  if (result === null) {
    throw new Error("Could not save completion for this Interview.");
  }

  return result;
}

function describeUnknownError(error: Error | string | undefined): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  return "Interview setup failed.";
}
