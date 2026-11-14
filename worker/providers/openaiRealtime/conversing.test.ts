import { WebSocketPair } from "miniflare";
import { prepareRealtimeSettings } from "./preparedModelSession.ts";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RealtimeConversing, type RealtimeConversingDispatch } from "./conversing.ts";
import { decodeRealtimeReceipt } from "./receipts.ts";
import type { ParsedProviderEvent } from "./providerEvents.ts";
import { createFakeRealtimeSideConnection } from "./testing/fakeSideConnection.ts";
import type { PreparedConversationNode } from "../../runtime/nodeContentContracts.ts";

// The fake side connection is built on workerd's WebSocketPair; miniflare provides the same
// pair in Node, delivering each provider message to Runtime's end as it is sent.
beforeAll(() => {
  vi.stubGlobal("WebSocketPair", WebSocketPair);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

// The conversing phase serves any Conversation state: a sample phase with its own content stands
// for the pair that configures it.
const phaseInstructions = "Ask the participant the next sample question.";
const phaseContent: PreparedConversationNode = {
  instructions: { kind: "literal", text: phaseInstructions },
  operationalInstructions: "",
  tools: [
    {
      type: "function",
      name: "move_on",
      description: "Sample tool description.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
};
// Realtime's settings as Runtime stored them for the Run, with non-default turn detection.
const settings = prepareRealtimeSettings({
  reasoningEffort: null,
  requested: {
    model: "gpt-realtime-2.1",
    voice: "marin",
    speed: 1,
    inputNoiseReduction: "far_field",
    semanticVadEagerness: "high",
    maxOutputTokens: 700,
    truncation: "auto",
  },
});
const turns = (automatic: boolean) => ({
  type: "semantic_vad",
  eagerness: "high",
  create_response: automatic,
  interrupt_response: false,
});

function createPhase() {
  const cuts: string[] = [];
  const conversing = new RealtimeConversing((responseId) => void cuts.push(responseId));
  const side = createFakeRealtimeSideConnection();
  side.provider.accept();
  const failures: string[] = [];
  const attributed: string[] = [];
  let current = true;
  const dispatch: RealtimeConversingDispatch = {
    identity: { runId: "run", visitId: "visit", operationId: "operation", generation: 1 },
    deadlineAt: Date.now() + 5000,
    clock: Date.now,
    reporter: { isCurrent: () => current },
    onFailure: (reason: string) =>
      Effect.sync(() => {
        failures.push(reason);
      }),
    failNow: (reason: string) => {
      failures.push(reason);
    },
    triggeringReplyId: "moved-here",
    triggeringToolCallId: "move-on-call",
    observeOutputIdentity: (responseId) => {
      attributed.push(responseId);
    },
  };
  // Runtime's end of the side connection, as a Realtime session reads it.
  side.connection.addEventListener("message", (message) => {
    if (typeof message.data !== "string") return;
    const receipt = decodeRealtimeReceipt(message.data);
    if (receipt.ok) conversing.observe(receipt.value, side.connection);
  });
  const commandsOf = (type: string) =>
    side.commands.filter(
      (command) =>
        typeof command === "object" &&
        command !== null &&
        "type" in command &&
        command.type === type,
    );
  return {
    conversing,
    commands: side.commands,
    commandsOf,
    cuts,
    failures,
    attributed,
    socket: side.connection,
    revoke: () => {
      current = false;
    },
    enter: (overrides: Partial<RealtimeConversingDispatch> = {}) =>
      conversing.enter(
        { dispatch: { ...dispatch, ...overrides }, content: phaseContent, settings },
        side.connection,
      ),
    observe: (event: ParsedProviderEvent) => side.provider.send(JSON.stringify(event)),
    acknowledge: (automatic: boolean, eventId: string) =>
      side.provider.send(
        JSON.stringify({
          type: "session.updated",
          event_id: eventId,
          session: {
            instructions: phaseInstructions,
            audio: { input: { turn_detection: turns(automatic) } },
          },
        }),
      ),
  };
}

describe("Realtime conversing phase", () => {
  it("opens with a reply of the call's own settings: no session update and no tool answer", () => {
    const reply = new RealtimeConversing().openingReply();
    expect(Object.keys(reply).sort()).toEqual(["event_id", "type"]);
    expect(reply.type).toBe("response.create");
    expect(reply.event_id.startsWith("evt_initial_interview_response_")).toBe(true);
  });

  it("enters a node: the moving reply's speech cut at once, its settings, its answer and its reply", async () => {
    const phase = createPhase();
    phase.observe({ type: "response.created", response: { id: "moved-here" } });
    phase.observe({ type: "output_audio_buffer.started", response_id: "moved-here" });
    const task = Effect.runPromise(phase.enter());
    try {
      // The reply that moved here settles before anything is sent.
      await Promise.resolve();
      expect(phase.commands).toEqual([]);
      phase.observe({ type: "response.done", response: { id: "moved-here", status: "completed" } });
      // Its speech still playing is cut at once, before the node's settings are sent; the cut is
      // recorded.
      await vi.waitFor(() => expect(phase.commands).toHaveLength(2));
      expect(phase.commands[0]).toEqual({
        type: "output_audio_buffer.clear",
        event_id: "evt_question_late_output_moved-here",
      });
      expect(phase.cuts).toEqual(["moved-here"]);
      // Automatic turns are suspended while the node's instructions and tools reach the model.
      expect(phase.commands[1]).toEqual({
        type: "session.update",
        event_id: "evt_question_operation_update",
        session: {
          type: "realtime",
          instructions: phaseInstructions,
          tools: phaseContent.tools,
          audio: { input: { turn_detection: turns(false) } },
        },
      });
      phase.acknowledge(false, "ack_update");
      // The node's reply follows the tool answer without waiting for the cut speech to stop.
      await vi.waitFor(() => expect(phase.commands).toHaveLength(4));
      expect(phase.commands.slice(2)).toEqual([
        {
          type: "conversation.item.create",
          event_id: "evt_question_operation_tool",
          item: { type: "function_call_output", call_id: "move-on-call", output: "{}" },
        },
        {
          type: "response.create",
          event_id: "evt_question_operation_response",
          response: { metadata: { runtime_operation_id: "operation" } },
        },
      ]);
      phase.observe({ type: "output_audio_buffer.cleared", response_id: "moved-here" });
      phase.observe({
        type: "response.created",
        response: { id: "node-reply", metadata: { runtime_operation_id: "operation" } },
      });
      // Automatic turns come back with the retained turn-detection settings.
      await vi.waitFor(() => expect(phase.commands).toHaveLength(5));
      expect(phase.commands[4]).toEqual({
        type: "session.update",
        event_id: "evt_question_operation_restore",
        session: { type: "realtime", audio: { input: { turn_detection: turns(true) } } },
      });
      phase.acknowledge(true, "ack_restore");
      await task;
      expect(phase.attributed).toEqual(["node-reply"]);
      // The node's own speech is never cut: only the reply that moved here was.
      phase.observe({ type: "output_audio_buffer.started", response_id: "node-reply" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(phase.commandsOf("output_audio_buffer.clear")).toHaveLength(1);
      expect(phase.cuts).toEqual(["moved-here"]);
      // Input stays open: the phase never closes or commits it.
      expect(phase.commandsOf("input_audio_buffer.commit")).toEqual([]);
      expect(phase.failures).toEqual([]);
    } finally {
      phase.conversing.contain(null);
      await task;
    }
  });

  it("cuts the moving reply's speech that starts only after it settled, and cuts nothing when it has none", async () => {
    const late = createPhase();
    late.observe({ type: "response.created", response: { id: "moved-here" } });
    late.observe({ type: "response.done", response: { id: "moved-here", status: "completed" } });
    const task = Effect.runPromise(late.enter());
    try {
      await vi.waitFor(() => expect(late.commandsOf("session.update")).toHaveLength(1));
      // Nothing was playing when the reply settled, so nothing was cut yet.
      expect(late.commandsOf("output_audio_buffer.clear")).toEqual([]);
      late.observe({ type: "output_audio_buffer.started", response_id: "moved-here" });
      await vi.waitFor(() => expect(late.commandsOf("output_audio_buffer.clear")).toHaveLength(1));
      expect(late.cuts).toEqual(["moved-here"]);
    } finally {
      late.conversing.contain(null);
      await task;
    }

    // A reply that moved here without speech: the node is entered with no clear and no cut.
    const silent = createPhase();
    silent.observe({ type: "response.created", response: { id: "moved-here" } });
    silent.observe({ type: "response.done", response: { id: "moved-here", status: "completed" } });
    const entered = Effect.runPromise(silent.enter());
    try {
      await vi.waitFor(() => expect(silent.commands).toHaveLength(1));
      silent.acknowledge(false, "ack_update");
      await vi.waitFor(() => expect(silent.commandsOf("response.create")).toHaveLength(1));
      expect(silent.commandsOf("output_audio_buffer.clear")).toEqual([]);
      expect(silent.cuts).toEqual([]);
    } finally {
      silent.conversing.contain(null);
      await entered;
    }
  });

  it("cancels automatic replies created while a node is entered, and those only", async () => {
    const phase = createPhase();
    phase.observe({ type: "response.created", response: { id: "opening-reply" } });
    phase.observe({
      type: "response.done",
      response: { id: "opening-reply", status: "completed" },
    });
    const task = Effect.runPromise(phase.enter({ triggeringReplyId: undefined }));
    try {
      await vi.waitFor(() => expect(phase.commands).toHaveLength(1));
      phase.observe({ type: "response.created", response: { id: "automatic" } });
      expect(phase.commandsOf("response.cancel")).toEqual([
        {
          type: "response.cancel",
          event_id: "evt_question_late_automatic",
          response_id: "automatic",
        },
      ]);
      expect(phase.conversing.cancelled("automatic")).toBe(true);
      expect(phase.conversing.cancelled("opening-reply")).toBe(false);
      // The node's reply waits for the cancelled reply to settle.
      phase.acknowledge(false, "ack_update");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(phase.commandsOf("response.create")).toEqual([]);
      phase.observe({ type: "response.done", response: { id: "automatic", status: "cancelled" } });
      await vi.waitFor(() => expect(phase.commandsOf("response.create")).toHaveLength(1));
    } finally {
      phase.conversing.contain(null);
      await task;
    }
  });

  it("fails the node when OpenAI rejects one of its commands", async () => {
    const phase = createPhase();
    const task = Effect.runPromise(phase.enter({ triggeringReplyId: undefined }));
    try {
      await vi.waitFor(() => expect(phase.commands).toHaveLength(1));
      phase.observe({
        type: "error",
        error: { event_id: "evt_question_operation_update", code: "invalid_value" },
      });
      expect(phase.failures).toEqual(["question_command_rejected"]);
    } finally {
      phase.conversing.contain(null);
      await task;
    }
  });

  it("contained while entering, cancels the replies in flight, clears output and reports nothing", async () => {
    const phase = createPhase();
    phase.observe({ type: "response.created", response: { id: "moved-here" } });
    phase.observe({ type: "output_audio_buffer.started", response_id: "moved-here" });
    const task = Effect.runPromise(phase.enter());
    await Promise.resolve();
    phase.conversing.contain(phase.socket);
    await task;
    expect(phase.commands).toEqual([
      {
        type: "response.cancel",
        event_id: "evt_question_late_moved-here",
        response_id: "moved-here",
      },
      { type: "output_audio_buffer.clear", event_id: "evt_question_late_output_moved-here" },
    ]);
    expect(phase.failures).toEqual([]);
    // No later entry acts.
    await Effect.runPromise(phase.enter({ triggeringReplyId: undefined }));
    expect(phase.commandsOf("session.update")).toEqual([]);
  });

  it("contained without the connection, sends nothing and leaves the conversation's replies", async () => {
    const phase = createPhase();
    phase.conversing.contain(null);
    phase.observe({ type: "response.created", response: { id: "conversation-reply" } });
    expect(phase.commands).toEqual([]);
    expect(phase.conversing.cancelled("conversation-reply")).toBe(false);
  });

  it("stops its own work at the interview deadline and reports nothing", async () => {
    vi.useFakeTimers();
    try {
      const phase = createPhase();
      const task = Effect.runPromise(
        phase.enter({ triggeringReplyId: undefined, deadlineAt: Date.now() + 100 }),
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(phase.commandsOf("session.update")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(200);
      await task;
      expect(phase.commandsOf("response.create")).toEqual([]);
      expect(phase.failures).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enters nothing and reports nothing once the interview deadline has passed", async () => {
    const phase = createPhase();
    await Effect.runPromise(phase.enter({ deadlineAt: Date.now() }));
    expect(phase.commands).toEqual([]);
    expect(phase.failures).toEqual([]);
  });

  it("reports a missing deadline and enters nothing", async () => {
    const phase = createPhase();
    await Effect.runPromise(phase.enter({ deadlineAt: null }));
    expect(phase.failures).toEqual(["question_deadline_missing"]);
    expect(phase.commands).toEqual([]);
  });
});
