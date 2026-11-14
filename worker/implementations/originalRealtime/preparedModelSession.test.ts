import { describe, expect, it } from "vitest";
import { originalRealtimeImplementation } from "./implementation.ts";
import { createInterviewConversationInput } from "../../runtime/testing/interviewConversationPreset.ts";
import type { OriginalInterviewInput } from "../../conversations/originalInterview.ts";
import {
  composeRealtimeSession,
  prepareRealtimeSettings,
  toProviderRealtimeSession,
} from "../../providers/openaiRealtime/preparedModelSession.ts";

// How Original's sessions are created: its Interviewing content under the kit's settings, as
// Runtime's start hands them to the Realtime session.
function prepareOriginalSession(interviewing: OriginalInterviewInput["interviewing"]) {
  return composeRealtimeSession(
    "original_1",
    originalRealtimeImplementation.prepare({
      runId: "original_1",
      state: "interviewing",
      nodeInput: interviewing,
    }),
    prepareRealtimeSettings({ reasoningEffort: null }),
  );
}

describe("Original Realtime model session preparation", () => {
  it("preserves configured application provider defaults", () => {
    const session = prepareOriginalSession(
      createInterviewConversationInput("Welcome. What surprised you? Thanks.").interviewing,
    );
    expect(toProviderRealtimeSession(session)).toEqual({
      type: "realtime",
      model: "gpt-realtime-2.1",
      output_modalities: ["audio"],
      instructions: "Welcome. What surprised you? Thanks.",
      tools: [
        {
          type: "function",
          name: "finish_interview",
          description: session.tools[0]?.description,
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      tool_choice: "auto",
      max_output_tokens: 700,
      truncation: "auto",
      audio: {
        input: {
          noise_reduction: { type: "far_field" },
          transcription: { model: "gpt-4o-mini-transcribe", language: "en" },
          turn_detection: {
            type: "semantic_vad",
            eagerness: "medium",
            create_response: true,
            interrupt_response: false,
          },
        },
        output: { voice: "marin", speed: 1 },
      },
      tracing: null,
    });
    expect(toProviderRealtimeSession(session)).not.toHaveProperty("reasoning");
  });

  it("keeps the finish description unchanged for literal instructions and provider prompts", () => {
    const replacement = "  Speak a short closing, then finish.  ";
    const literal = prepareOriginalSession(
      createInterviewConversationInput("Saved flow", replacement).interviewing,
    );
    const prompt = prepareOriginalSession({
      instructions: {
        kind: "provider_prompt",
        reference: { id: "prompt_123", version: "2" },
        supplementalText: "",
      },
      toolDescriptions: { finish_interview: replacement },
    });
    for (const session of [literal, prompt]) {
      expect(toProviderRealtimeSession(session)).toMatchObject({
        tools: [
          {
            type: "function",
            name: "finish_interview",
            description: replacement,
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
        tool_choice: "auto",
      });
      expect(session.tools).toHaveLength(1);
      expect(session.operationalInstructions).toBe("");
    }
    expect(toProviderRealtimeSession(literal).instructions).toBe("Saved flow");
    expect(toProviderRealtimeSession(prompt).prompt).toEqual({ id: "prompt_123", version: "2" });
  });
});
