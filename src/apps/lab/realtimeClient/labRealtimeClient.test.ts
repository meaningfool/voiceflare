import { describe, expect, it } from "vitest";
import { mapLiveInterviewStatusToRuntimeStatus } from "./labRealtimeClient";

describe("Lab Realtime Client contract", () => {
  it("maps current Live Interview statuses into the provider-neutral status model", () => {
    expect(mapLiveInterviewStatusToRuntimeStatus("openingRealtimeCall").phase).toBe("setup");
    expect(mapLiveInterviewStatusToRuntimeStatus("live").phase).toBe("live");
    expect(mapLiveInterviewStatusToRuntimeStatus("finalizing").phase).toBe("ending");
    expect(mapLiveInterviewStatusToRuntimeStatus("completed")).toMatchObject({
      phase: "ended",
      endStatus: "ended",
    });
    expect(mapLiveInterviewStatusToRuntimeStatus("completedWithWarning")).toMatchObject({
      phase: "ended",
      endStatus: "endedWithWarning",
      transcriptWarning: {
        reviewStatus: "warning",
      },
    });
    expect(mapLiveInterviewStatusToRuntimeStatus("setupFailed")).toMatchObject({
      phase: "failed",
      failureKind: "setup",
    });
    expect(mapLiveInterviewStatusToRuntimeStatus("completionFailed")).toMatchObject({
      phase: "failed",
      failureKind: "ending",
    });
  });
});
