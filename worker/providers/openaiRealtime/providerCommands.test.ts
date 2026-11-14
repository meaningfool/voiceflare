import { describe, expect, it } from "vitest";

import {
  buildCancelResponseCommand,
  buildClearInputCommand,
  buildClearOutputCommand,
  buildDisableAutomaticTurnsCommand,
  buildFinalInputCommitCommand,
  buildInitialInterviewResponseCommand,
} from "./providerCommands.ts";

describe("provider finalization commands", () => {
  it("disables automatic turns through the current Realtime session shape", () => {
    expect(buildDisableAutomaticTurnsCommand("run-1:2")).toEqual({
      event_id: "run-1:2",
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            turn_detection: null,
          },
        },
      },
    });
  });

  it("builds the final input commit with the persisted effect ID", () => {
    expect(buildFinalInputCommitCommand("run-1:3")).toEqual({
      event_id: "run-1:3",
      type: "input_audio_buffer.commit",
    });
  });

  it("builds each remaining provider command with its exact wire fields", () => {
    expect(buildInitialInterviewResponseCommand(1_234)).toEqual({
      event_id: "evt_initial_interview_response_1234",
      type: "response.create",
    });
    expect(buildClearInputCommand("run-1:4")).toEqual({
      event_id: "run-1:4",
      type: "input_audio_buffer.clear",
    });
    expect(buildCancelResponseCommand("run-1:5", "resp-1")).toEqual({
      event_id: "run-1:5",
      type: "response.cancel",
      response_id: "resp-1",
    });
    expect(buildClearOutputCommand("run-1:6")).toEqual({
      event_id: "run-1:6",
      type: "output_audio_buffer.clear",
    });
  });
});
