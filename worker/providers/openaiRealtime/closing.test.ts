import { WebSocketPair } from "miniflare";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RealtimeClosing, type RealtimeClosingDispatch } from "./closing.ts";
import { RealtimeInputClosure } from "./inputClosure.ts";
import { decodeRealtimeReceipt } from "./receipts.ts";
import {
  normalizeProviderRealtimeEvent,
  normalizeProviderRuntimeObservation,
  type ParsedProviderEvent,
} from "./providerEvents.ts";
import type { ProviderCommandSocket } from "./providerCommands.ts";
import { createFakeRealtimeSideConnection } from "./testing/fakeSideConnection.ts";
import {
  createReportingAuthority,
  issueStateReporter,
  consumeStateReport,
  type SemanticReport,
} from "../../runtime/admission/private/reporting.ts";

// The fake side connection is built on workerd's WebSocketPair; miniflare provides the same
// pair in Node, delivering each provider message to Runtime's end as it is sent.
beforeAll(() => {
  vi.stubGlobal("WebSocketPair", WebSocketPair);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

// The closing serves any Conversation state: a sample closing state with its own content and
// completion event stands for the pair that configures it.
const closingSentence = "Thank you. Goodbye.";
/** The closing reply's instructions: the user's approved wording (#1025), then the sentence. */
const closingReplyInstructions =
  "Speak only the following closing message, verbatim. Do not add, omit, or rephrase any words. Do not ask a question, request confirmation, or call a tool.\n\nThank you. Goodbye.";
const closingState = {
  event: z.strictObject({ kind: z.literal("closing_completed"), responseId: z.string() }),
};

function createNativeVisit() {
  const input = new RealtimeInputClosure();
  const closing = new RealtimeClosing(input);
  const side = createFakeRealtimeSideConnection();
  side.provider.accept();
  const failures: string[] = [];
  const reports: SemanticReport<unknown>[] = [];
  const authority = createReportingAuthority();
  const identity = { runId: "run", visitId: "visit", operationId: "operation", generation: 1 };
  const reporter = issueStateReporter(closingState, identity, () => true, authority);
  const dispatch: RealtimeClosingDispatch = {
    identity,
    deadlineAt: Date.now() + 5000,
    clock: Date.now,
    onComplete: (report: SemanticReport<unknown>) =>
      Effect.sync(() => {
        reports.push(report);
      }),
    onFailure: (reason: string) =>
      Effect.sync(() => {
        failures.push(reason);
      }),
  };
  // Runtime's end of the side connection, as a Realtime session reads it: each input
  // observation first, then the receipt.
  let sequence = 0;
  const observations: Array<ReturnType<RealtimeInputClosure["observe"]> | undefined> = [];
  side.connection.addEventListener("message", (message) => {
    if (typeof message.data !== "string") return;
    const normalized = normalizeProviderRuntimeObservation(message.data, ++sequence);
    observations.push(
      normalized === null
        ? undefined
        : input.observe(
            normalized,
            normalizeProviderRealtimeEvent(message.data).diagnosticSummary.item_id,
            true,
          ),
    );
    const receipt = decodeRealtimeReceipt(message.data);
    if (receipt.ok) closing.observe(receipt.value, side.connection);
  });
  const observe = (event: ParsedProviderEvent) => {
    const delivered = observations.length;
    side.provider.send(JSON.stringify(event));
    expect(observations).toHaveLength(delivered + 1);
    return observations[delivered]?.consumedActiveInput;
  };
  const finished = (status = "completed", audio = true, id = "closing") => ({
    type: "response.done",
    response: {
      id,
      status,
      metadata: { runtime_operation_id: "operation" },
      output: audio ? [{ type: "message", content: [{ type: "audio" }] }] : [],
    },
  });
  const commands = side.commands;
  return {
    closing,
    input,
    commands,
    handoffCommands: () =>
      commands.filter(
        (command) =>
          typeof command === "object" &&
          command !== null &&
          "type" in command &&
          command.type !== "output_audio_buffer.clear" &&
          command.type !== "response.cancel",
      ),
    failures,
    reports,
    dispatch,
    socket: side.connection,
    enter: (
      overrides: Partial<RealtimeClosingDispatch> = {},
      socket: ProviderCommandSocket = side.connection,
    ) =>
      closing.enter(
        {
          dispatch: { ...dispatch, ...overrides },
          content: { sentence: closingSentence },
          report: (responseId) => reporter.report({ kind: "closing_completed", responseId }),
        },
        socket,
      ),
    observe,
    finished,
    read: () =>
      reports[0] === undefined ? null : consumeStateReport(reports[0], closingState, authority),
  };
}

describe("Realtime closing", () => {
  const nativeVisit = () => createNativeVisit();

  it("interrupts existing output before input acknowledgement and ignores its delayed clear receipt", async () => {
    const visit = nativeVisit();
    visit.observe({ type: "response.created", response: { id: "ordinary" } });
    visit.observe({ type: "output_audio_buffer.started", response_id: "ordinary" });
    visit.observe({ type: "input_audio_buffer.speech_started", item_id: "answer" });
    const task = Effect.runPromise(visit.enter());
    try {
      await vi.waitFor(() =>
        expect(visit.commands).toContainEqual(
          expect.objectContaining({ type: "response.cancel", response_id: "ordinary" }),
        ),
      );
      expect(visit.commands).toContainEqual(
        expect.objectContaining({ type: "output_audio_buffer.clear" }),
      );
      expect(visit.commands).not.toContainEqual(
        expect.objectContaining({ type: "input_audio_buffer.clear" }),
      );
      expect(visit.commands).not.toContainEqual(
        expect.objectContaining({ type: "response.create" }),
      );
      visit.observe({
        type: "session.updated",
        session: { audio: { input: { turn_detection: null } } },
      });
      await vi.waitFor(() =>
        expect(visit.commands).toContainEqual(
          expect.objectContaining({ type: "input_audio_buffer.commit" }),
        ),
      );
      visit.observe({ type: "input_audio_buffer.committed", item_id: "answer" });
      visit.observe({ type: "response.done", response: { id: "ordinary", status: "cancelled" } });
      await vi.waitFor(() =>
        expect(visit.commands).toContainEqual(expect.objectContaining({ type: "response.create" })),
      );
      visit.observe({
        type: "response.created",
        response: { id: "closing", metadata: { runtime_operation_id: "operation" } },
      });
      visit.observe({ type: "output_audio_buffer.cleared", response_id: "ordinary" });
      visit.observe(visit.finished());
      visit.observe({ type: "output_audio_buffer.stopped", response_id: "closing" });
      await task;
      expect(visit.read()).toEqual({ kind: "closing_completed", responseId: "closing" });
      expect(visit.failures).toEqual([]);
    } finally {
      visit.closing.contain(visit.socket);
      await task;
    }
  });
  it.each([null, "committed-answer"])(
    "restores the durable input closure before pending dispatch (admitted item: %s)",
    async (itemId) => {
      const visit = nativeVisit();
      // The session read the kit's kept speech back after the restart (`executionState.ts`).
      if (itemId === null) visit.input.retain({ committedItemId: null, activityObserved: true });
      const settled: Array<string | null> = [];
      const task = Effect.runPromise(
        visit.enter({
          inputClosure: {
            admittedItemId: itemId,
            obligation: itemId === null ? "awaiting_item" : "awaiting_transcription",
          },
          settleInputClosure: (value) => {
            settled.push(value);
          },
        }),
      );
      try {
        await vi.waitFor(() =>
          expect(visit.commands).toContainEqual(
            expect.objectContaining({ type: "session.update" }),
          ),
        );
        if (itemId === null) {
          expect(visit.commands).not.toContainEqual(
            expect.objectContaining({ type: "response.create" }),
          );
          visit.observe({
            type: "session.updated",
            session: { audio: { input: { turn_detection: null } } },
          });
          await vi.waitFor(() =>
            expect(visit.commands).toContainEqual(
              expect.objectContaining({ type: "input_audio_buffer.commit" }),
            ),
          );
          visit.observe({ type: "input_audio_buffer.committed", item_id: "manual-answer" });
        }
        await vi.waitFor(() =>
          expect(visit.commands).toContainEqual(
            expect.objectContaining({ type: "response.create" }),
          ),
        );
        expect(settled).toEqual([itemId ?? "manual-answer"]);
        expect(
          visit.commands.filter(
            (entry) =>
              typeof entry === "object" &&
              entry !== null &&
              "type" in entry &&
              entry.type === "input_audio_buffer.commit",
          ),
        ).toHaveLength(itemId === null ? 1 : 0);
        visit.observe(visit.finished());
        visit.observe({ type: "output_audio_buffer.stopped", response_id: "closing" });
        await task;
        expect(visit.read()).toEqual({ kind: "closing_completed", responseId: "closing" });
      } finally {
        visit.closing.contain(visit.socket);
        await task;
      }
    },
  );
  it.each(["answer", "manual-answer"])(
    "commits admitted speech before closing when native commit uses %s",
    async (itemId) => {
      const visit = nativeVisit();
      visit.observe({ type: "input_audio_buffer.speech_started", item_id: "older" });
      visit.observe({ type: "input_audio_buffer.speech_started", item_id: "answer" });
      const task = Effect.runPromise(visit.enter());
      await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(1));
      for (const session of [
        {},
        { audio: { input: {} } },
        { audio: { input: { turn_detection: {} } } },
      ])
        visit.observe({ type: "session.updated", session });
      await Promise.resolve();
      expect(visit.handoffCommands()).toHaveLength(1);
      visit.observe({
        type: "session.updated",
        session: { audio: { input: { turn_detection: null } } },
      });
      await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(2));
      expect(visit.handoffCommands()[1]).toEqual({
        type: "input_audio_buffer.commit",
        event_id: "evt_goodbye_operation_commit",
      });
      expect(visit.input.commitOutcome).toEqual({ status: "dispatched" });
      expect(
        visit.observe({ type: "input_audio_buffer.committed", item_id: "older" }),
      ).toBeUndefined();
      visit.observe({ type: "input_audio_buffer.speech_started", item_id: "late-answer" });
      expect(
        visit.observe({ type: "input_audio_buffer.committed", item_id: "late-answer" }),
      ).toBeUndefined();
      expect(visit.input.commitOutcome).toEqual({ status: "dispatched" });
      expect(visit.observe({ type: "input_audio_buffer.committed", item_id: itemId })).toEqual({
        itemId,
        identity: visit.dispatch.identity,
      });
      await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(3));
      expect(visit.handoffCommands()[2]).toMatchObject({ type: "response.create" });
      expect(visit.input.commitOutcome).toBeNull();
      visit.observe(visit.finished());
      visit.observe({ type: "output_audio_buffer.stopped", response_id: "closing" });
      await task;
      expect(visit.read()).toEqual({ kind: "closing_completed", responseId: "closing" });
    },
  );
  it("commits the buffered answer of the input closure it took over when contained before its commit", async () => {
    // Ending no longer sends the commit of a step the closing took over, so containment between
    // the closing's stop of automatic turns and its commit sends it under the step's id.
    const visit = nativeVisit();
    visit.observe({ type: "input_audio_buffer.speech_started", item_id: "answer" });
    const reported: string[] = [];
    const task = Effect.runPromise(
      visit.enter({
        claimInputClosure: () => "run:7",
        reportInputClosure: (commandId) => void reported.push(commandId),
      }),
    );
    await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(1));
    expect(reported).toEqual(["run:7"]);

    visit.closing.contain(visit.socket);
    await task;
    expect(visit.handoffCommands()).toContainEqual({
      type: "input_audio_buffer.commit",
      event_id: "run:7",
    });
    expect(visit.input.commitOutcome).toEqual({ status: "dispatched" });
    // A second containment commits nothing more.
    visit.closing.contain(visit.socket);
    expect(
      visit.commands.filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "type" in entry &&
          entry.type === "input_audio_buffer.commit",
      ),
    ).toHaveLength(1);
  });
  it("uses an automatic committed receipt already in flight without another commit", async () => {
    const visit = nativeVisit();
    visit.observe({ type: "response.created", response: { id: "interviewing" } });
    visit.observe({ type: "input_audio_buffer.speech_started", item_id: "answer" });
    const task = Effect.runPromise(visit.enter());
    await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(1));
    visit.observe({ type: "input_audio_buffer.committed", item_id: "answer" });
    visit.observe({
      type: "session.updated",
      session: { audio: { input: { turn_detection: null } } },
    });
    await Promise.resolve();
    expect(visit.handoffCommands()).toHaveLength(1);
    visit.observe({ type: "response.done", response: { id: "interviewing", status: "completed" } });
    await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(2));
    expect(visit.handoffCommands()[1]).toMatchObject({ type: "response.create" });
    visit.observe(visit.finished());
    visit.observe({ type: "output_audio_buffer.stopped", response_id: "closing" });
    await task;
    expect(visit.failures).toEqual([]);
  });
  it.each([
    { cause: "participant_end", acknowledged: false },
    { cause: "participant_end", acknowledged: true },
    { cause: "deadline", acknowledged: false },
    { cause: "deadline", acknowledged: true },
  ] as const)(
    "contains input settlement on $cause (disable acknowledged: $acknowledged)",
    async ({ cause, acknowledged }) => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      try {
        const visit = nativeVisit();
        visit.observe({ type: "input_audio_buffer.speech_started", item_id: "answer" });
        const task = Effect.runPromise(visit.enter());
        await vi.advanceTimersByTimeAsync(0);
        if (acknowledged)
          visit.observe({
            type: "session.updated",
            session: { audio: { input: { turn_detection: null } } },
          });
        await vi.advanceTimersByTimeAsync(0);
        expect(visit.input.commitOutcome).toEqual(acknowledged ? { status: "dispatched" } : null);
        if (cause === "participant_end") visit.closing.contain(visit.socket);
        else await vi.advanceTimersByTimeAsync(5000);
        await task;
        expect(visit.commands).toContainEqual(
          expect.objectContaining({ type: "output_audio_buffer.clear" }),
        );
        expect(visit.commands).not.toContainEqual(
          expect.objectContaining({ type: "input_audio_buffer.clear" }),
        );
        visit.observe({ type: "input_audio_buffer.committed", item_id: "answer" });
        await vi.advanceTimersByTimeAsync(0);
        expect(visit.commands).not.toContainEqual(
          expect.objectContaining({ type: "response.create" }),
        );
        expect(visit.failures).toEqual([
          cause === "participant_end" ? "goodbye_interrupted" : "goodbye_deadline_exceeded",
        ]);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it.each(["receipt-first", "error-first"])(
    "accepts an automatic commit racing the explicit empty-buffer error (%s)",
    async (order) => {
      const visit = nativeVisit();
      visit.observe({ type: "input_audio_buffer.speech_started", item_id: "answer" });
      const task = Effect.runPromise(visit.enter());
      await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(1));
      visit.observe({
        type: "session.updated",
        session: { audio: { input: { turn_detection: null } } },
      });
      await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(2));
      const receipt = { type: "input_audio_buffer.committed", item_id: "answer" };
      const error = {
        type: "error",
        error: {
          event_id: "evt_goodbye_operation_commit",
          code: "input_audio_buffer_commit_empty",
        },
      };
      visit.observe(order === "receipt-first" ? receipt : error);
      visit.observe(order === "receipt-first" ? error : receipt);
      await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(3));
      visit.observe(visit.finished());
      visit.observe({ type: "output_audio_buffer.stopped", response_id: "closing" });
      await task;
      expect(visit.failures).toEqual([]);
      expect(visit.read()).toEqual({ kind: "closing_completed", responseId: "closing" });
    },
  );
  it.each([
    { command: "disable", code: "controlled_rejection" },
    { command: "disable", code: null },
    { command: "commit", code: "controlled_rejection" },
    { command: "commit", code: null },
  ])(
    "reports rejected $command with code $code while admitted input waits",
    async ({ command, code }) => {
      const visit = nativeVisit();
      visit.observe({ type: "input_audio_buffer.speech_started", item_id: "answer" });
      const task = Effect.runPromise(visit.enter());
      await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(1));
      if (command === "commit") {
        visit.observe({
          type: "session.updated",
          session: { audio: { input: { turn_detection: null } } },
        });
        await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(2));
      }
      visit.observe({
        type: "error",
        error: { event_id: `evt_goodbye_operation_${command}`, code },
      });
      await task;
      expect(visit.failures).toEqual(["goodbye_command_rejected"]);
      expect(visit.commands).not.toContainEqual(
        expect.objectContaining({ type: "response.create" }),
      );
    },
  );
  it("ignores later speech after dispatch without containing the closing", async () => {
    const visit = nativeVisit();
    const task = Effect.runPromise(visit.enter());
    await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(2));
    visit.observe({ type: "input_audio_buffer.speech_started", item_id: "late-answer" });
    visit.observe(visit.finished());
    visit.observe({ type: "output_audio_buffer.stopped", response_id: "closing" });
    await task;
    expect(visit.read()).toEqual({ kind: "closing_completed", responseId: "closing" });
    expect(visit.failures).toEqual([]);
    expect(
      visit.commands.filter(
        (command) =>
          typeof command === "object" &&
          command !== null &&
          "type" in command &&
          command.type === "output_audio_buffer.clear",
      ),
    ).toEqual([
      { type: "output_audio_buffer.clear", event_id: "evt_goodbye_operation_entry_output" },
    ]);
  });
  it.each(["generation-first", "stopped-first"])(
    "requires identified audio generation and stopped evidence (%s)",
    async (order) => {
      const visit = nativeVisit();
      const task = Effect.runPromise(visit.enter());
      await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(2));
      expect(visit.handoffCommands()).toEqual([
        {
          type: "session.update",
          event_id: "evt_goodbye_operation_disable",
          session: {
            type: "realtime",
            tools: [],
            tool_choice: "none",
            audio: { input: { turn_detection: null } },
          },
        },
        {
          type: "response.create",
          event_id: "evt_goodbye_operation_response",
          response: {
            output_modalities: ["audio"],
            instructions: closingReplyInstructions,
            input: [],
            conversation: "auto",
            reasoning: { effort: "minimal" },
            tools: [],
            tool_choice: "none",
            metadata: { runtime_operation_id: "operation" },
          },
        },
      ]);
      const stopped = { type: "output_audio_buffer.stopped", response_id: "closing" };
      visit.observe(order === "generation-first" ? visit.finished() : stopped);
      await Promise.resolve();
      expect(visit.reports).toEqual([]);
      visit.observe(order === "generation-first" ? stopped : visit.finished());
      await task;
      expect(visit.read()).toEqual({ kind: "closing_completed", responseId: "closing" });
      expect(visit.failures).toEqual([]);
    },
  );
  // A closing starts either from the model's finish_interview call, which
  // Runtime passes as the dispatch's tool call, or from the interview deadline.
  it.each(["finish_interview", "deadline"] as const)(
    "stops turns and tools by session update, answers only a starting call, then asks for the sentence alone (%s)",
    async (cause) => {
      const visit = nativeVisit();
      visit.observe({ type: "response.created", response: { id: "interviewing" } });
      const task = Effect.runPromise(
        visit.enter(
          cause === "finish_interview"
            ? { triggeringReplyId: "interviewing", triggeringToolCallId: "finish" }
            : {},
        ),
      );
      await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(1));
      visit.observe({
        type: "response.done",
        response: { id: "interviewing", status: "cancelled", output: [] },
      });
      await vi.waitFor(() =>
        expect(visit.handoffCommands().at(-1)).toMatchObject({ type: "response.create" }),
      );
      const answer =
        cause === "finish_interview"
          ? [
              {
                type: "conversation.item.create",
                event_id: "evt_goodbye_operation_tool",
                item: { type: "function_call_output", call_id: "finish", output: "{}" },
              },
            ]
          : [];
      expect(visit.handoffCommands()).toEqual([
        {
          type: "session.update",
          event_id: "evt_goodbye_operation_disable",
          session: {
            type: "realtime",
            tools: [],
            tool_choice: "none",
            audio: { input: { turn_detection: null } },
          },
        },
        ...answer,
        {
          type: "response.create",
          event_id: "evt_goodbye_operation_response",
          response: {
            output_modalities: ["audio"],
            instructions: closingReplyInstructions,
            input: [],
            conversation: "auto",
            reasoning: { effort: "minimal" },
            tools: [],
            tool_choice: "none",
            metadata: { runtime_operation_id: "operation" },
          },
        },
      ]);
      visit.observe(visit.finished());
      visit.observe({ type: "output_audio_buffer.stopped", response_id: "closing" });
      await task;
      expect(visit.read()).toEqual({ kind: "closing_completed", responseId: "closing" });
    },
  );
  it.each(["no-audio", "cancelled", "cleared"])(
    "rejects insufficient closing evidence (%s)",
    async (mode) => {
      const visit = nativeVisit();
      const task = Effect.runPromise(visit.enter());
      await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(2));
      visit.observe({
        type: mode === "cleared" ? "output_audio_buffer.cleared" : "output_audio_buffer.stopped",
        response_id: "closing",
      });
      visit.observe(
        visit.finished(mode === "cancelled" ? "cancelled" : "completed", mode !== "no-audio"),
      );
      await task;
      expect(visit.reports).toEqual([]);
      expect(visit.failures).toEqual([
        mode === "cleared"
          ? "goodbye_audio_cleared"
          : mode === "cancelled"
            ? "goodbye_response_failed"
            : "goodbye_audio_not_completed",
      ]);
    },
  );
  it("ignores another response's stopped event and contains unrelated automatic responses", async () => {
    const visit = nativeVisit();
    const task = Effect.runPromise(visit.enter());
    await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(2));
    visit.observe({ type: "response.created", response: { id: "unrelated" } });
    expect(visit.commands.at(-1)).toEqual({
      type: "response.cancel",
      event_id: "evt_goodbye_operation_cancel_unrelated",
      response_id: "unrelated",
    });
    visit.observe({ type: "output_audio_buffer.stopped", response_id: "unrelated" });
    visit.observe(visit.finished());
    await Promise.resolve();
    expect(visit.reports).toEqual([]);
    visit.closing.contain(visit.socket);
    await task;
    expect(visit.failures).toEqual(["goodbye_interrupted"]);
  });
  it("settles actual in-flight work without inventing a timer tool identity, and End cuts the wait", async () => {
    const visit = nativeVisit();
    visit.observe({ type: "response.created", response: { id: "interviewing" } });
    const task = Effect.runPromise(visit.enter());
    await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(1));
    visit.closing.contain(visit.socket);
    await task;
    visit.observe({
      type: "response.done",
      response: { id: "interviewing", status: "completed", output: [] },
    });
    expect(
      visit.commands.filter(
        (command) =>
          typeof command === "object" &&
          command !== null &&
          "type" in command &&
          command.type === "response.create",
      ),
    ).toEqual([]);
    expect(visit.failures).toEqual(["goodbye_interrupted"]);
  });
  it.each(["disable", "cancel"] as const)(
    "contains a failed %s while settlement is pending and never creates the closing reply afterward",
    async (mode) => {
      const visit = nativeVisit();
      // The closing's own sends fail for a cancellation; the session's containment does not.
      const socket: ProviderCommandSocket = {
        send(data: string) {
          visit.socket.send(data);
          const command: unknown = JSON.parse(data);
          if (
            mode === "cancel" &&
            typeof command === "object" &&
            command !== null &&
            "type" in command &&
            command.type === "response.cancel"
          )
            throw new Error("controlled send failure");
        },
      };
      visit.observe({ type: "response.created", response: { id: "interviewing" } });
      const task = Effect.runPromise(visit.enter({ triggeringReplyId: "interviewing" }, socket));
      await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(1));
      if (mode === "disable")
        visit.observe({ type: "error", error: { event_id: "evt_goodbye_operation_disable" } });
      else visit.observe({ type: "response.created", response: { id: "unrelated" } });
      expect(visit.commands).toContainEqual({
        type: "output_audio_buffer.clear",
        event_id: "evt_goodbye_operation_contain_output",
      });
      await task;
      visit.observe({
        type: "response.done",
        response: { id: "interviewing", status: "completed", output: [] },
      });
      expect(visit.failures).toEqual([
        mode === "disable" ? "goodbye_command_rejected" : "provider_command_send_failed",
      ]);
      expect(visit.reports).toEqual([]);
      expect(visit.commands).not.toContainEqual(
        expect.objectContaining({ type: "response.create" }),
      );
    },
  );
  // #1060: OpenAI's `response.cancel` acts only while a reply generates. Containment that comes
  // once the closing reply's `response.done` arrived, while only its audio plays, sends no cancel
  // OpenAI would refuse; it still clears the reply's audio.
  it.each(["generating", "finished"] as const)(
    "contains its closing reply: cancels it only while it generates, and clears its output (%s)",
    async (closingReply) => {
      const visit = nativeVisit();
      const task = Effect.runPromise(visit.enter());
      await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(2));
      visit.observe({
        type: "response.created",
        response: { id: "closing", metadata: { runtime_operation_id: "operation" } },
      });
      visit.observe({ type: "output_audio_buffer.started", response_id: "closing" });
      if (closingReply === "finished") visit.observe(visit.finished());
      const sent = visit.commands.length;
      visit.closing.contain(visit.socket);
      await task;
      expect(visit.commands.slice(sent)).toEqual([
        ...(closingReply === "generating"
          ? [
              {
                type: "response.cancel",
                event_id: "evt_goodbye_operation_contain_cancel",
                response_id: "closing",
              },
            ]
          : []),
        { type: "output_audio_buffer.clear", event_id: "evt_goodbye_operation_contain_output" },
      ]);
      expect(visit.failures).toEqual(["goodbye_interrupted"]);
    },
  );
  it("cancels the reply that called for the closing while it still generates", async () => {
    const visit = nativeVisit();
    visit.observe({ type: "response.created", response: { id: "interviewing" } });
    const task = Effect.runPromise(visit.enter({ triggeringReplyId: "interviewing" }));
    try {
      await vi.waitFor(() =>
        expect(visit.commands).toContainEqual({
          type: "response.cancel",
          event_id: "evt_goodbye_operation_cancel_interviewing",
          response_id: "interviewing",
        }),
      );
      // A tool-only reply's end crosses the cancel in transit: OpenAI refuses it as not active,
      // and the closing goes on once the reply's end arrives.
      visit.observe({
        type: "error",
        error: {
          event_id: "evt_goodbye_operation_cancel_interviewing",
          code: "response_cancel_not_active",
        },
      });
      visit.observe({
        type: "response.done",
        response: { id: "interviewing", status: "completed", output: [] },
      });
      await vi.waitFor(() =>
        expect(visit.handoffCommands().at(-1)).toMatchObject({ type: "response.create" }),
      );
      visit.observe(visit.finished());
      visit.observe({ type: "output_audio_buffer.stopped", response_id: "closing" });
      await task;
      expect(visit.read()).toEqual({ kind: "closing_completed", responseId: "closing" });
      expect(visit.failures).toEqual([]);
    } finally {
      visit.closing.contain(visit.socket);
      await task;
    }
  });
  it("does not dispatch after containment wins before execution starts or after an expired cutoff", async () => {
    const visit = nativeVisit();
    visit.closing.contain(visit.socket);
    await Effect.runPromise(visit.enter());
    expect(visit.handoffCommands()).toEqual([]);
    expect(visit.failures).toEqual(["goodbye_interrupted"]);
    const expired = nativeVisit();
    await Effect.runPromise(expired.enter({ deadlineAt: Date.now() - 1 }));
    expect(expired.commands).toEqual([]);
    expect(expired.failures).toEqual(["goodbye_deadline_exceeded"]);
  });
  it("contains a matching native response identity acquired after End without reporting completion", async () => {
    const visit = nativeVisit();
    const task = Effect.runPromise(visit.enter());
    await vi.waitFor(() => expect(visit.handoffCommands()).toHaveLength(2));
    visit.closing.contain(visit.socket);
    await task;
    visit.observe({
      type: "response.created",
      response: { id: "late", metadata: { runtime_operation_id: "operation" } },
    });
    expect(visit.commands.slice(-2)).toEqual([
      {
        type: "response.cancel",
        event_id: "evt_goodbye_operation_late_cancel_late",
        response_id: "late",
      },
      { type: "output_audio_buffer.clear", event_id: "evt_goodbye_operation_late_output_late" },
    ]);
    visit.observe(visit.finished("completed", true, "late"));
    visit.observe({ type: "output_audio_buffer.stopped", response_id: "late" });
    expect(visit.reports).toEqual([]);
    expect(visit.failures).toEqual(["goodbye_interrupted"]);
  });
});
