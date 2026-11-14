import { describe, expect, it, vi } from "vitest";

import {
  buildLiveInterviewMediaConstraints,
  describeLiveInterviewStartFailure,
  isLiveInterviewStarting,
  requireCompletionSaveResult,
  stopMicrophonePreview,
} from "./liveInterview";

describe("Live Interview setup helpers", () => {
  it("requests browser speech cleanup for live Interview microphone capture", () => {
    expect(buildLiveInterviewMediaConstraints()).toEqual({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  });

  it("distinguishes browser setup and provider signaling start failures", () => {
    expect(
      describeLiveInterviewStartFailure(new DOMException("", "NotAllowedError"), "browserSetup"),
    ).toBe("Browser setup failed: Microphone permission was denied.");
    expect(
      describeLiveInterviewStartFailure(
        new Error("Realtime call creation failed."),
        "providerSignaling",
      ),
    ).toBe("Provider/signaling failed: Realtime call creation failed.");
  });

  it("identifies setup states that are still starting", () => {
    expect(isLiveInterviewStarting("creatingInterview")).toBe(true);
    expect(isLiveInterviewStarting("requestingMicrophone")).toBe(true);
    expect(isLiveInterviewStarting("openingRealtimeCall")).toBe(true);
    expect(isLiveInterviewStarting("openingSideband")).toBe(true);
    expect(isLiveInterviewStarting("live")).toBe(false);
  });

  it("releases microphone tracks after the setup check", () => {
    const stop = vi.fn();

    stopMicrophonePreview({
      getTracks: () => [
        {
          stop,
        },
      ],
    });

    expect(stop).toHaveBeenCalledOnce();
  });

  it("fails explicitly when completion state cannot be saved", () => {
    expect(() => requireCompletionSaveResult(null)).toThrow(
      "Could not save completion for this Interview.",
    );
    expect(
      requireCompletionSaveResult({
        id: "interview-1",
        endedAt: 1_700_000_030_000,
        transcriptTurnCount: 2,
      }),
    ).toEqual({
      id: "interview-1",
      endedAt: 1_700_000_030_000,
      transcriptTurnCount: 2,
    });
  });
});
