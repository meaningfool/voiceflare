import { describe, expect, it } from "vitest";

import {
  formatDuration,
  getInterviewTiming,
  getOrderedTranscriptTurns,
  type Transcript,
} from "./transcript";

describe("Transcript review helpers", () => {
  it("orders Transcript turns with the turn number and the caller's role labels", () => {
    const transcript: Transcript = {
      turns: [
        {
          role: "conversationAgent",
          text: "What stood out to you most about the event?",
        },
        {
          role: "participant",
          text: "The practical examples.",
        },
        {
          role: "conversationAgent",
          text: "What made those examples useful?",
        },
      ],
    };

    const turns = getOrderedTranscriptTurns(transcript, {
      participant: "Speaker",
      conversationAgent: "Agent",
    });

    expect(turns).toEqual([
      {
        role: "conversationAgent",
        text: "What stood out to you most about the event?",
        turnNumber: 1,
        roleLabel: "Agent",
      },
      {
        role: "participant",
        text: "The practical examples.",
        turnNumber: 2,
        roleLabel: "Speaker",
      },
      {
        role: "conversationAgent",
        text: "What made those examples useful?",
        turnNumber: 3,
        roleLabel: "Agent",
      },
    ]);
  });

  it("formats timing context for comparing ended Interviews", () => {
    expect(formatDuration(1_700_000_000_000, 1_700_000_273_000)).toBe("4m 33s");
  });

  it("labels in-progress Transcripts without requiring an end timestamp", () => {
    const interview = {
      startedAt: 1_700_000_000_000,
    };

    const timing = getInterviewTiming(interview);

    expect(timing.endedLabel).toBe("In progress");
    expect(timing.durationLabel).toBe("In progress");
    expect(timing.statusLabel).toBe("In Progress");
  });
});
