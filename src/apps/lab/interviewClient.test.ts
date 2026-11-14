import { describe, expect, it } from "vitest";
import { createLabInterviewStatusChannel, type LabInterviewStatus } from "./interviewClient";

describe("Lab interview client contract", () => {
  it("publishes status updates until the consumer unsubscribes", () => {
    const channel = createLabInterviewStatusChannel({ phase: "setup", label: "", detail: "" });
    const phases: LabInterviewStatus["phase"][] = [];
    const unsubscribe = channel.subscribe((status) => phases.push(status.phase));
    channel.notify({ phase: "live", label: "", detail: "" });
    unsubscribe();
    channel.notify({ phase: "ending", label: "", detail: "" });
    expect(phases).toEqual(["live"]);
    expect(channel.getStatus().phase).toBe("ending");
  });
});
