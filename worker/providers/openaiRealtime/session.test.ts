import { Cause, Effect } from "effect";
import { NativeWorkOwner } from "../../runtime/nativeWorkOwner.ts";
import { describe, expect, it, vi } from "vitest";

import { openAiRealtimeDriver } from "./openaiRealtimeDriver.ts";
import {
  openAiDriverOver,
  realtimeTestDriver,
  type RealtimeDriverScript,
  type ScriptedRealtimeDriver,
} from "./testing/testDriver.ts";
import { prepareRealtimeSettings } from "./preparedModelSession.ts";
import { createRealtimeRuntimeSession } from "./runtimeSession.ts";
import type { RealtimeSessionConfiguration } from "./session.ts";
import type { ParsedProviderEvent } from "./providerEvents.ts";
import { createFakeRealtimeSideConnection } from "./testing/fakeSideConnection.ts";
import { WebSocketPair } from "miniflare";
import { providerFailure, providerSuccess } from "../../runtime/providerOutcomes.ts";
import { z } from "zod";
import type { ConversationNodeDispatch } from "../../runtime/implementationContracts.ts";
import type { ConversationCallbackJson } from "../../runtime/conversationContracts.ts";
import type {
  ProviderReceiptPrefix,
  ProviderSessionApplicationFact,
  ProviderSessionEvents,
  ProviderSessionRecord,
  ProviderSessionStorage,
} from "../../runtime/nativeContracts.ts";

// The Realtime kit's session, through Runtime's session contract as each Realtime pair offers
// it. These cases were pinned against the three pair copies before they merged; where the
// copies differed, the shared session keeps one behavior (see the cases on the final-answer
// commit, the close code and the participant speech that counts once input closed).
describe("Realtime session", () => {
  const createProviderSession = (input: ProviderSessionHarnessInput = {}) =>
    createSessionHarness(input).session;
  const createProviderSessionHarness = (input: ProviderSessionHarnessInput = {}) =>
    createSessionHarness(input);

  it("serves Runtime and the configured nodes over the side connection", async () => {
    // The kit's fake side connection runs on workerd's WebSocketPair, which miniflare
    // provides in Node: each provider message reaches the session as it is sent.
    vi.stubGlobal("WebSocketPair", WebSocketPair);
    try {
      const side = createFakeRealtimeSideConnection();
      side.provider.accept();
      const facts: ProviderSessionApplicationFact[] = [];
      const failures: string[] = [];
      const session = createProviderSession({
        driver: createDriver({
          connectSideband: async () => providerSuccess(side.connection),
          sendFinalizationOperation: openAiDriverOver().sendFinalizationOperation,
        }),
        sink: async (fact) => {
          facts.push(fact);
        },
      });
      session.ensureConnected("rtc_serialized");
      await vi.waitFor(() => expect(session.connected).toBe(true));
      // A state the configuration gives no node is not the session's to enter.
      expect(() => session.enterNode(sampleDispatch("interviewing", failures))).toThrow(
        "native_node_unavailable",
      );

      for (const event of [
        { type: "response.created", event_id: "evt_1", response: { id: "reply" } },
        { type: "input_audio_buffer.speech_started", event_id: "evt_2", item_id: "answer" },
      ])
        side.provider.send(JSON.stringify(event));
      expect(session.closeBarrier(null)).toEqual({ generation: 1, sequence: 2 });
      await session.drain();
      expect(
        facts.flatMap((fact) =>
          fact.kind === "provider_observation" ? [fact.persistence.sequence] : [],
        ),
      ).toEqual([1, 2]);

      // Ending's commit is sent once: a second ask returns its outcome and sends nothing.
      const commit = { kind: "close_input", commandId: "run:commit", heldItemId: null } as const;
      // The participant is speaking: the step answers once OpenAI answers the commit.
      const answered = {
        status: "dispatched",
        settlement: { supersedesHeld: false, answerFollows: true, inputToSettle: true },
      };
      expect(session.sendFinalizationOperation(commit)).toEqual(answered);
      expect(session.sendFinalizationOperation(commit)).toEqual(answered);
      expect(
        side.commands.filter(
          (command) =>
            typeof command === "object" &&
            command !== null &&
            "type" in command &&
            command.type === "input_audio_buffer.commit",
        ),
      ).toHaveLength(1);

      // The configured closing enters over the side connection: its update removes the tools.
      session.enterNode(sampleDispatch("goodbye", failures));
      await vi.waitFor(() =>
        expect(
          side.commands.some(
            (command) =>
              typeof command === "object" &&
              command !== null &&
              "session" in command &&
              typeof command.session === "object" &&
              command.session !== null &&
              "tool_choice" in command.session &&
              command.session.tool_choice === "none",
          ),
        ).toBe(true),
      );

      side.provider.close(1011, "provider_closed");
      await vi.waitFor(() => expect(session.connecting).toBe(false));
      // During Live, Runtime cannot go on without the side connection: the kit reports the
      // session lost, and schedules its own reconnection for as long as Runtime needs one.
      expect(facts.find((fact) => fact.kind === "session_lost")).toEqual({
        kind: "session_lost",
        source: "session_disconnected",
      });
      expect(facts.at(-1)).toEqual({ kind: "wake_scheduled" });
      // The generation's end contained the closing, and a later node finds no connection.
      session.enterNode(sampleDispatch("goodbye", failures));
      await vi.waitFor(() =>
        expect([...failures].sort()).toEqual([
          "goodbye_interrupted",
          "goodbye_sideband_unavailable",
        ]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("starts no new reply after Ending stopped output", async () => {
    // Written first for #977: before it, stopping output only cleared OpenAI's output audio, so
    // a reply that OpenAI started afterwards, as from a turn end already in flight, was left to
    // play. Stopping output now also cancels such a reply and clears its audio.
    vi.stubGlobal("WebSocketPair", WebSocketPair);
    try {
      const side = createFakeRealtimeSideConnection();
      side.provider.accept();
      const session = createProviderSession({
        driver: createDriver({
          connectSideband: async () => providerSuccess(side.connection),
          sendFinalizationOperation: openAiDriverOver().sendFinalizationOperation,
        }),
      });
      session.ensureConnected("rtc_serialized");
      await vi.waitFor(() => expect(session.connected).toBe(true));

      expect(
        session.sendFinalizationOperation({ kind: "stop_output", commandId: "run:stop" }),
      ).toEqual({ status: "dispatched" });
      side.provider.send(
        JSON.stringify({ type: "response.created", event_id: "evt_1", response: { id: "late" } }),
      );
      await session.drain();

      // Ending's own cancel of that reply, once Runtime saw it start, is not sent again.
      expect(
        session.sendFinalizationOperation({
          kind: "cancel_reply",
          commandId: "run:cancel",
          responseId: "late",
        }),
      ).toEqual({ status: "dispatched" });
      expect(side.commands).toEqual([
        { event_id: "run:stop", type: "output_audio_buffer.clear" },
        { event_id: "run:stop_cancel_late", type: "response.cancel", response_id: "late" },
        { event_id: "run:stop_clear_late", type: "output_audio_buffer.clear" },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cancels a reply for Ending only while OpenAI has not reported its end", async () => {
    // #1060: OpenAI's `response.cancel` acts only while a reply generates. Ending cancels a reply
    // whose audio Runtime still records as playing, but once its `response.done` arrived there is
    // nothing left to cancel, and a cancel would only draw `response_cancel_not_active`.
    vi.stubGlobal("WebSocketPair", WebSocketPair);
    try {
      const side = createFakeRealtimeSideConnection();
      side.provider.accept();
      const session = createProviderSession({
        driver: createDriver({
          connectSideband: async () => providerSuccess(side.connection),
          sendFinalizationOperation: openAiDriverOver().sendFinalizationOperation,
        }),
      });
      session.ensureConnected("rtc_serialized");
      await vi.waitFor(() => expect(session.connected).toBe(true));

      for (const event of [
        { type: "response.created", event_id: "evt_1", response: { id: "played" } },
        { type: "output_audio_buffer.started", event_id: "evt_2", response_id: "played" },
        {
          type: "response.done",
          event_id: "evt_3",
          response: { id: "played", status: "completed", output: [] },
        },
        { type: "response.created", event_id: "evt_4", response: { id: "generating" } },
      ])
        side.provider.send(JSON.stringify(event));
      await session.drain();

      for (const responseId of ["played", "generating"])
        expect(
          session.sendFinalizationOperation({
            kind: "cancel_reply",
            commandId: `run:cancel_${responseId}`,
            responseId,
          }),
        ).toEqual({ status: "dispatched" });
      expect(side.commands).toEqual([
        { event_id: "run:cancel_generating", type: "response.cancel", response_id: "generating" },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports an interviewer reply OpenAI ended unfinished until a closing is entered", async () => {
    vi.stubGlobal("WebSocketPair", WebSocketPair);
    try {
      const live = await connectLiveSampleSession();
      // A reply OpenAI ends as failed ends the interview, once its end was handed to Runtime.
      live.send({ type: "response.created", event_id: "evt_1", response: { id: "failed" } });
      live.send({
        type: "response.done",
        event_id: "evt_2",
        response: { id: "failed", status: "failed" },
      });
      await live.session.drain();
      expect(live.reported()).toEqual([
        {
          kind: "failure",
          failure: "message",
          errorText: "interviewer_response_failed",
          applyRuntimeFailure: true,
        },
      ]);

      // Once a closing is entered, it decides its replies' outcomes: a reply it cancels is none.
      const failures: string[] = [];
      live.session.enterNode(sampleDispatch("goodbye", failures));
      await vi.waitFor(() => expect(live.sent("response.create")).toHaveLength(1));
      live.send({ type: "response.created", event_id: "evt_3", response: { id: "late" } });
      expect(live.sent("response.cancel")).toEqual([
        expect.objectContaining({ type: "response.cancel", response_id: "late" }),
      ]);
      live.send({
        type: "response.done",
        event_id: "evt_4",
        response: { id: "late", status: "cancelled" },
      });
      await live.session.drain();
      expect(live.reported()).toHaveLength(1);
      expect(failures).toEqual([]);
      await live.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not report a reply the conversing phase cancelled while it entered a node", async () => {
    vi.stubGlobal("WebSocketPair", WebSocketPair);
    try {
      const live = await connectLiveSampleSession();
      live.send({ type: "response.created", event_id: "evt_1", response: { id: "failed" } });
      live.send({
        type: "response.done",
        event_id: "evt_2",
        response: { id: "failed", status: "failed" },
      });
      await live.session.drain();
      expect(live.reported()).toHaveLength(1);

      // Entering a conversing node cancels an automatic reply created meanwhile.
      live.session.enterNode(sampleDispatch("question", []));
      await vi.waitFor(() => expect(live.sent("session.update")).toHaveLength(1));
      live.send({ type: "response.created", event_id: "evt_3", response: { id: "automatic" } });
      expect(live.sent("response.cancel")).toEqual([
        {
          type: "response.cancel",
          event_id: "evt_question_late_automatic",
          response_id: "automatic",
        },
      ]);
      live.send({
        type: "response.done",
        event_id: "evt_4",
        response: { id: "automatic", status: "cancelled" },
      });
      await live.session.drain();
      expect(live.reported()).toHaveLength(1);
      await live.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resumes the conversation on the next generation after a generation ends", async () => {
    vi.stubGlobal("WebSocketPair", WebSocketPair);
    try {
      const live = await connectLiveSampleSession();
      const failures: string[] = [];
      await enterSampleQuestion(live, failures);
      // A reply is playing when the side connection closes; its end is lost with it.
      live.send({ type: "response.created", event_id: "evt_5", response: { id: "lost" } });
      live.send({ type: "output_audio_buffer.started", event_id: "evt_5b", response_id: "lost" });

      // The side connection closes and the next generation connects.
      await live.reconnect();

      // A reply in the Question entered before carries on.
      live.send({ type: "response.created", event_id: "evt_6", response: { id: "follow-up" } });
      live.send({
        type: "response.done",
        event_id: "evt_7",
        response: { id: "follow-up", status: "completed" },
      });
      expect(live.sent("response.cancel")).toEqual([]);
      // A later Question is entered, without waiting for the lost reply.
      live.session.enterNode(laterSampleQuestion(failures));
      await vi.waitFor(() => expect(live.sent("session.update")).toHaveLength(1));
      live.send(sampleQuestionUpdated("evt_8", false));
      await vi.waitFor(() =>
        expect(live.sent("response.create")).toEqual([
          expect.objectContaining({
            response: { metadata: { runtime_operation_id: "question-2" } },
          }),
        ]),
      );
      // A later Goodbye is entered, without waiting for the lost reply either.
      live.session.enterNode(sampleDispatch("goodbye", failures));
      await vi.waitFor(() =>
        expect(live.sent("response.create")).toContainEqual(
          expect.objectContaining({ event_id: "evt_goodbye_goodbye_response" }),
        ),
      );
      expect(failures).toEqual([]);
      await live.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps Runtime's containment for the rest of the Run, across later generations", async () => {
    vi.stubGlobal("WebSocketPair", WebSocketPair);
    try {
      const live = await connectLiveSampleSession();
      const failures: string[] = [];
      await enterSampleQuestion(live, failures);
      // Runtime contains node work, as Ending does, and the next generation connects.
      live.session.containNode();
      await live.reconnect();

      // A reply in the Question entered before is cancelled.
      live.send({ type: "response.created", event_id: "evt_5", response: { id: "follow-up" } });
      expect(live.sent("response.cancel")).toEqual([
        {
          type: "response.cancel",
          event_id: "evt_question_late_follow-up",
          response_id: "follow-up",
        },
      ]);
      // A later Question is not entered and reports nothing; a later Goodbye reports its
      // interruption at once.
      live.session.enterNode(laterSampleQuestion(failures));
      live.session.enterNode(sampleDispatch("goodbye", failures));
      await vi.waitFor(() => expect(failures).toEqual(["goodbye_interrupted"]));
      expect(live.sent("session.update")).toEqual([]);
      expect(live.sent("response.create")).toEqual([]);
      await live.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("contains a retired generation's nodes, and its late end leaves its replacement's", async () => {
    vi.stubGlobal("WebSocketPair", WebSocketPair);
    try {
      const live = await connectLiveSampleSession();
      const failures: string[] = [];
      // The retired generation's events task is still handing a reply to Runtime, and a Question
      // is being entered, when its replacement connects.
      live.holdNextObservation();
      live.send({ type: "response.created", event_id: "evt_1", response: { id: "reply" } });
      live.session.enterNode(sampleDispatch("question", failures));
      await vi.waitFor(() => expect(live.sent("session.update")).toHaveLength(1));
      await live.replace();
      // Retirement contained the Question's entry: its reply in flight was cancelled there.
      expect(live.sent("response.cancel", 0)).toEqual([
        { type: "response.cancel", event_id: "evt_question_late_reply", response_id: "reply" },
      ]);
      live.releaseObservation();
      await vi.waitFor(() => expect(live.released(0)).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 10));

      // On the replacement, the conversation goes on outside the interrupted entry, and a later
      // Question is entered.
      live.send({ type: "response.created", event_id: "evt_2", response: { id: "carries-on" } });
      live.send({
        type: "response.done",
        event_id: "evt_3",
        response: { id: "carries-on", status: "completed" },
      });
      expect(live.sent("response.cancel")).toEqual([]);
      live.session.enterNode(laterSampleQuestion(failures));
      await vi.waitFor(() => expect(live.sent("session.update")).toHaveLength(1));
      live.send(sampleQuestionUpdated("evt_4", false));
      await vi.waitFor(() =>
        expect(live.sent("response.create")).toEqual([
          expect.objectContaining({
            response: { metadata: { runtime_operation_id: "question-2" } },
          }),
        ]),
      );
      expect(failures).toEqual([]);
      await live.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([false, true])(
    "gates opening on browser readiness (browser first: %s), claims once and does not replay",
    async (browserFirst) => {
      const listeners = createSocketListeners();
      const socket = createSocket(listeners);
      const commands: unknown[] = [];
      const harness = createProviderSessionHarness({
        record: {
          ...defaultProviderSessionRecord,
          initialConnection: true,
          browserMediaReady: browserFirst,
          openingState: "pending",
          canStartConversation: false,
        },
        driver: createDriver({
          connectSideband: async () => providerSuccess(socket),
          sendCommand: (input) => {
            commands.push(input.command);
            return providerSuccess(undefined);
          },
        }),
        sink: async (fact) => {
          if (fact.kind === "execution_ready")
            harness.setRecord({ ...harness.getRecord(), canStartConversation: true });
        },
      });
      harness.session.ensureConnected("rtc_serialized");
      await vi.waitFor(() => expect(harness.session.connected).toBe(true));
      expect(commands).toHaveLength(browserFirst ? 1 : 0);
      harness.setRecord({ ...harness.getRecord(), browserMediaReady: true });
      await harness.session.trySendOpening();
      await harness.session.trySendOpening();
      expect(commands).toEqual([
        expect.objectContaining({
          type: "response.create",
        }),
      ]);
      listeners.close[0]?.({ code: 1000 });
      await vi.waitFor(() => expect(harness.session.connecting).toBe(false));
      harness.setRecord({
        ...harness.getRecord(),
        initialConnection: false,
        openingState: "claimed",
      });
      harness.session.ensureConnected("rtc_serialized");
      await vi.waitFor(() => expect(harness.session.connected).toBe(true));
      expect(commands).toHaveLength(1);
      listeners.close[0]?.({ code: 1000 });
      await vi.waitFor(() => expect(harness.session.connecting).toBe(false));
    },
  );

  it("creates and records a provider call with the prepared session result", async () => {
    const recordedIdentities: unknown[] = [];
    const recordedAnswers: unknown[] = [];
    const driver = createDriver({
      createCall: vi.fn(async () =>
        providerSuccess({
          status: 201,
          answerSdp: "answer-sdp",
          responseContentType: "application/sdp",
          sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_created",
          sessionId: "rtc_created",
          upstreamRequestId: "req_created",
        }),
      ),
    });
    const session = createProviderSession({
      driver,
      onRecordCallIdentity: (input) => recordedIdentities.push(input),
      onRecordCallAnswer: (input) => recordedAnswers.push(input),
    });
    const prepared = prepareSampleSession();

    await expect(
      Effect.runPromise(
        session.start({
          runId: "run_provider_session",
          connection: sampleOffer,
          content: prepared.content,
          settings: prepared.settings,
          settingsSummary: { model: prepared.settings.model },
          deadlineAt: 1_700_000_030_000,
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      reply: { sdp: "answer-sdp" },
      sessionId: "rtc_created",
      upstreamRequestId: "req_created",
    });
    expect(recordedIdentities).toEqual([
      expect.objectContaining({
        runId: "run_provider_session",
        sessionId: "rtc_created",
      }),
    ]);
    expect(recordedAnswers).toEqual([
      {
        runId: "run_provider_session",
        sessionId: "rtc_created",
        reply: { sdp: "answer-sdp" },
      },
    ]);
    expect(driver.createCall).toHaveBeenCalledWith(
      expect.objectContaining({ deadlineAt: 1_700_000_030_000 }),
    );
  });

  it("persists an identified call even when reading the answer later fails", async () => {
    const recordedIdentities: unknown[] = [];
    const recordedAnswers: unknown[] = [];
    const driver = createDriver({
      createCall: vi.fn(async (input: Parameters<ScriptedRealtimeDriver["createCall"]>[0]) => {
        await input.onCallIdentified?.({
          status: 201,
          responseContentType: "application/sdp",
          sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_identified",
          sessionId: "rtc_identified",
          upstreamRequestId: "req_identified",
        });
        return providerFailure({
          stage: "call_creation",
          code: "provider_call_response_read_failed",
          providerStatus: 201,
          requestId: "req_identified",
          retryable: false,
        });
      }),
    });
    const session = createProviderSession({
      driver,
      onRecordCallIdentity: (input) => recordedIdentities.push(input),
      onRecordCallAnswer: (input) => recordedAnswers.push(input),
    });
    const prepared = prepareSampleSession();

    await expect(
      Effect.runPromise(
        session.start({
          runId: "run_provider_session",
          connection: sampleOffer,
          content: prepared.content,
          settings: prepared.settings,
          settingsSummary: { model: prepared.settings.model },
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "provider_call_failed" });
    expect(recordedIdentities).toEqual([expect.objectContaining({ sessionId: "rtc_identified" })]);
    expect(recordedAnswers).toEqual([]);
  });

  it("retains one bounded cleanup attempt when identity persistence rejects", async () => {
    const hangUp = vi.fn(async () =>
      providerFailure({ stage: "hangup", code: "session_release_uncertain", retryable: true }),
    );
    const driver = createDriver({
      hangUp,
      createCall: vi.fn(async (input: Parameters<ScriptedRealtimeDriver["createCall"]>[0]) => {
        const identity = {
          status: 201,
          responseContentType: "application/sdp",
          sessionLocation: null,
          sessionId: "rtc_unpersisted",
          upstreamRequestId: null,
        };
        await expect(input.onCallIdentified?.(identity)).rejects.toThrow("storage_rejected");
        await expect(input.onCallIdentified?.(identity)).rejects.toThrow("storage_rejected");
        return providerFailure({
          stage: "call_creation",
          code: "provider_call_request_failed",
          retryable: true,
        });
      }),
    });
    const session = createProviderSession({
      driver,
      onRecordCallIdentity: () => {
        throw new Error("storage_rejected");
      },
    });
    const prepared = prepareSampleSession();
    expect(
      await Effect.runPromise(
        session.start({
          runId: "run_provider_session",
          connection: sampleOffer,
          content: prepared.content,
          settings: prepared.settings,
          settingsSummary: {},
        }),
      ),
    ).toMatchObject({ ok: false, error: "provider_call_failed" });
    expect(hangUp.mock.calls).toEqual([
      [{ apiKey: "test-key", callId: "rtc_unpersisted", timeoutMs: 8_000 }],
    ]);
    expect(driver.createCall).toHaveBeenCalledTimes(1);
  });

  it("answers a failed hang-up's release with its failure, without leaking response content", async () => {
    const driver = createDriver({
      hangUp: vi.fn(async () =>
        providerFailure({
          stage: "hangup",
          code: "session_release_failed",
          providerStatus: 503,
          requestId: "req_hangup_failure",
          retryable: true,
        }),
      ),
    });
    const session = createProviderSession({ driver });

    await expect(session.release("rtc_provider_call")).resolves.toEqual({
      status: "close_unconfirmed",
      failure: { status: "failed", timedOut: false, code: "session_release_failed" },
    });
  });

  it("answers closed only from documented terminal evidence, and records the closure's confidence", async () => {
    const answerTo = async (hangUp: ScriptedRealtimeDriver["hangUp"]) => {
      const harness = createProviderSessionHarness({ driver: createDriver({ hangUp }) });
      const answer = await harness.session.release("rtc_provider_call");
      return {
        answer,
        diagnostics: harness.events.diagnostic.mock.calls.map(([type, payload]) => [type, payload]),
      };
    };
    // A 404 that is not OpenAI's documented exact-call evidence proves nothing.
    await expect(
      answerTo(async () =>
        providerFailure({
          stage: "hangup",
          code: "session_release_failed",
          providerStatus: 404,
          requestId: "request_closed",
          retryable: false,
        }),
      ),
    ).resolves.toEqual({
      answer: {
        status: "close_unconfirmed",
        failure: { status: "failed", timedOut: false, code: "session_release_failed" },
      },
      diagnostics: [
        [
          "realtime.close_finished",
          expect.objectContaining({
            result: "failed",
            status: 404,
            code: "session_release_failed",
          }),
        ],
        [
          "realtime.closure_confidence",
          expect.objectContaining({ confidence: "unconfirmed", basis: "hangup_not_confirmed" }),
        ],
      ],
    });
    // An acknowledged hang-up starts the teardown; `session.closed` confirms it later.
    await expect(
      answerTo(async () => providerSuccess({ status: 200, upstreamRequestId: "req_ack" })),
    ).resolves.toEqual({
      answer: { status: "close_unconfirmed" },
      diagnostics: [
        ["realtime.close_finished", expect.objectContaining({ result: "succeeded", status: 200 })],
        [
          "realtime.closure_confidence",
          expect.objectContaining({
            confidence: "teardown_initiated_unconfirmed",
            basis: "hangup_acknowledged",
          }),
        ],
      ],
    });
    await expect(
      answerTo(async () =>
        providerFailure({
          stage: "hangup",
          code: "provider_session_already_closed",
          providerStatus: 404,
          retryable: false,
        }),
      ),
    ).resolves.toEqual({
      answer: { status: "closed" },
      diagnostics: [
        ["realtime.close_finished", expect.objectContaining({ result: "succeeded" })],
        [
          "realtime.closure_confidence",
          expect.objectContaining({
            confidence: "confirmed",
            basis: "documented_terminal_hangup_evidence",
          }),
        ],
      ],
    });
  });

  it("owns initial connection state and reports initial response readiness", async () => {
    const listeners = createSocketListeners();
    const socket = createSocket(listeners);
    const sentCommands: Parameters<ScriptedRealtimeDriver["sendCommand"]>[0][] = [];
    const sendCommand = vi.fn((input: Parameters<ScriptedRealtimeDriver["sendCommand"]>[0]) => {
      sentCommands.push(input);
      return providerSuccess(undefined);
    });
    const facts: ProviderSessionApplicationFact[] = [];
    const { session, storage } = createProviderSessionHarness({
      record: {
        ...defaultProviderSessionRecord,
        initialConnection: true,
        generation: 2,
      },
      driver: createDriver({
        connectSideband: vi.fn(async () => providerSuccess(socket)),
        sendCommand,
      }),
      sink: async (fact) => {
        facts.push(fact);
      },
    });

    session.ensureConnected("rtc_serialized");

    await vi.waitFor(() => expect(session.connected).toBe(true));
    expect(session.connecting).toBe(true);
    expect(storage.setGeneration).toHaveBeenCalledWith("run_provider_session", 3);
    expect(storage.markStarted).toHaveBeenCalledWith("run_provider_session", expect.any(Number));
    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]?.socket).toBe(socket);
    expect(sentCommands[0]?.command.type).toBe("response.create");
    // The side connection's state is the kit's own: Runtime hears readiness only.
    expect(facts.map((fact) => fact.kind)).toEqual(["execution_ready"]);
    expect(facts[0]).toMatchObject({
      kind: "execution_ready",
      runId: "run_provider_session",
    });
    expect(storage.recordExecutionState).toHaveBeenLastCalledWith("run_provider_session", {
      inputBuffered: false,
      sideConnectionOpen: true,
    });

    listeners.close[0]?.({ code: 1000 });
    await vi.waitFor(() => expect(session.connecting).toBe(false));
  });

  // Applications' browser clients, such as Lab's, read these names on Runtime's stream (plan
  // decision 14, #983).
  it("reports its side connection on Runtime's stream under the session event names", async () => {
    const listeners = createSocketListeners();
    const socket = createSocket(listeners);
    const opened = createProviderSessionHarness({
      record: { ...defaultProviderSessionRecord, initialConnection: true },
      driver: createDriver({ connectSideband: vi.fn(async () => providerSuccess(socket)) }),
    });
    opened.session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(opened.session.connected).toBe(true));
    listeners.close[0]?.({ code: 1011 });
    await vi.waitFor(() => expect(opened.session.connecting).toBe(false));
    const refused = createProviderSessionHarness({
      driver: createDriver({
        connectSideband: vi.fn(async () =>
          providerFailure({
            stage: "session_setup",
            code: "sideband_connect_rejected",
            retryable: false,
          }),
        ),
      }),
    });
    refused.session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(refused.session.connecting).toBe(false));

    const sessionEvents = (harness: typeof opened): unknown[][] =>
      harness.events.notifyControl.mock.calls
        .filter((call: unknown[]) => typeof call[0] === "string" && call[0].startsWith("session."))
        .map((call: unknown[]) => [call[0], call[1]]);
    expect(sessionEvents(opened)).toEqual([
      [
        "session.connected",
        expect.objectContaining({ sessionId: "rtc_serialized", readyState: 1 }),
      ],
      ["session.control_sent", expect.objectContaining({ controlType: "response.create" })],
      ["session.closed", expect.objectContaining({ sessionId: "rtc_serialized" })],
    ]);
    expect(sessionEvents(refused)).toEqual([
      [
        "session.failed",
        expect.objectContaining({
          sessionId: "rtc_serialized",
          message: "session_setup:sideband_connect_rejected",
        }),
      ],
      [
        "session.closed",
        expect.objectContaining({ sessionId: "rtc_serialized", reason: "failed" }),
      ],
    ]);
  });

  it("reports command dispatch, failure, and unavailable outcomes", async () => {
    const listeners = createSocketListeners();
    const socket = createSocket(listeners);
    const sendFinalizationOperation = vi.fn(
      (input: Parameters<ScriptedRealtimeDriver["sendFinalizationOperation"]>[0]) =>
        input.operation.kind === "clear_output"
          ? providerFailure({
              stage: "provider_command",
              code: "provider_command_send_failed",
              retryable: true,
            })
          : providerSuccess(undefined),
    );
    const session = createProviderSession({
      driver: createDriver({
        connectSideband: vi.fn(async () => providerSuccess(socket)),
        sendFinalizationOperation,
      }),
    });
    const operation = { kind: "close_input", commandId: "run:1", heldItemId: null } as const;

    expect(session.sendFinalizationOperation(operation)).toEqual({
      status: "uncertain",
      code: "sideband_unavailable",
      settlement: { supersedesHeld: false, answerFollows: false, inputToSettle: false },
    });
    // No one speaks: Runtime's quiet second settles the step if OpenAI does not answer first.
    const answered = {
      status: "dispatched",
      settlement: { supersedesHeld: false, answerFollows: false, inputToSettle: false },
    };
    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(session.connected).toBe(true));
    // Closing input stops automatic turns, then commits the answer Runtime does not hold under
    // the step's own id.
    expect(session.sendFinalizationOperation(operation)).toEqual(answered);
    expect(sendFinalizationOperation.mock.calls).toEqual([
      [{ socket, operation: { kind: "disable_automatic_turns", commandId: "run:1_turns" } }],
      [{ socket, operation: { kind: "commit_input", commandId: "run:1" } }],
    ]);
    // A repeated input closure gets the first commit's outcome and commits nothing more.
    // Before the shared session, Original sent it again.
    expect(session.sendFinalizationOperation(operation)).toEqual(answered);
    expect(
      sendFinalizationOperation.mock.calls.filter(
        ([input]) => input.operation.kind === "commit_input",
      ),
    ).toHaveLength(1);
    expect(session.sendFinalizationOperation({ kind: "stop_output", commandId: "run:2" })).toEqual({
      status: "failed",
      code: "provider_command_send_failed",
    });

    listeners.close[0]?.({ code: 1000 });
    await vi.waitFor(() => expect(session.connecting).toBe(false));
  });

  it("closes input without a commit when Runtime already holds the answer", async () => {
    const listeners = createSocketListeners();
    const socket = createSocket(listeners);
    const sendFinalizationOperation = vi.fn(() => providerSuccess(undefined));
    const session = createProviderSession({
      driver: createDriver({
        connectSideband: vi.fn(async () => providerSuccess(socket)),
        sendFinalizationOperation,
      }),
    });
    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(session.connected).toBe(true));

    expect(
      session.sendFinalizationOperation({
        kind: "close_input",
        commandId: "run:1",
        heldItemId: "item_answer",
      }),
    ).toEqual({
      status: "dispatched",
      settlement: { supersedesHeld: false, answerFollows: false, inputToSettle: false },
    });
    expect(sendFinalizationOperation.mock.calls).toEqual([
      [{ socket, operation: { kind: "disable_automatic_turns", commandId: "run:1_turns" } }],
    ]);

    listeners.close[0]?.({ code: 1000 });
    await vi.waitFor(() => expect(session.connecting).toBe(false));
  });

  // Speech activity is the kit's own (#978): Runtime holds the participant's last item, and the
  // kit knows whether the participant spoke again since.
  it("commits speech that started after the answer Runtime holds, which it settles instead", async () => {
    const listeners = createSocketListeners();
    const socket = createSocket(listeners);
    const sendFinalizationOperation = vi.fn(() => providerSuccess(undefined));
    const { session, storage } = createProviderSessionHarness({
      driver: createDriver({
        connectSideband: vi.fn(async () => providerSuccess(socket)),
        sendFinalizationOperation,
      }),
    });
    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(listeners.message).toHaveLength(1));
    for (const event of [
      { type: "input_audio_buffer.speech_started", item_id: "item_answer" },
      { type: "input_audio_buffer.committed", item_id: "item_answer" },
      { type: "input_audio_buffer.speech_started", item_id: "item_later" },
    ])
      listeners.message[0]?.({ data: JSON.stringify(event) });
    await session.drain();
    // The kit keeps the later speech for a restart.
    expect(storage.recordExecutionState).toHaveBeenLastCalledWith(expect.any(String), {
      inputBuffered: true,
      sideConnectionOpen: true,
    });

    expect(
      session.sendFinalizationOperation({
        kind: "close_input",
        commandId: "run:1",
        heldItemId: "item_answer",
      }),
    ).toEqual({
      status: "dispatched",
      settlement: { supersedesHeld: true, answerFollows: true, inputToSettle: true },
    });
    expect(sendFinalizationOperation.mock.calls).toEqual([
      [{ socket, operation: { kind: "disable_automatic_turns", commandId: "run:1_turns" } }],
      [{ socket, operation: { kind: "commit_input", commandId: "run:1" } }],
    ]);

    listeners.close[0]?.({ code: 1000 });
    await vi.waitFor(() => expect(session.connecting).toBe(false));
  });

  it("warns of incomplete final input when speech starts after Ending closed input", async () => {
    const listeners = createSocketListeners();
    const socket = createSocket(listeners);
    const facts: ProviderSessionApplicationFact[] = [];
    const session = createProviderSession({
      driver: createDriver({
        connectSideband: vi.fn(async () => providerSuccess(socket)),
        sendFinalizationOperation: vi.fn(() => providerSuccess(undefined)),
      }),
      sink: async (fact) => {
        facts.push(fact);
      },
    });
    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(listeners.message).toHaveLength(1));
    session.sendFinalizationOperation({
      kind: "close_input",
      commandId: "run:1",
      heldItemId: null,
    });
    const late = {
      type: "input_audio_buffer.speech_started",
      item_id: "late",
      event_id: "evt_late",
    };
    listeners.message[0]?.({ data: JSON.stringify(late) });
    // The same start again, as after a reconnection, makes the final input ambiguous.
    listeners.message[0]?.({ data: JSON.stringify(late) });
    await session.drain();
    expect(facts.flatMap((fact) => (fact.kind === "result_warning" ? [fact.warning] : []))).toEqual(
      ["final_input_may_be_incomplete", "ambiguous_final_activity"],
    );
    // Runtime reads the speech only as provider activity.
    expect(
      facts.flatMap((fact) =>
        fact.kind === "provider_observation" && fact.observation !== null
          ? [fact.observation.kind]
          : [],
      ),
    ).toEqual(["session_activity_observed", "session_activity_observed"]);

    listeners.close[0]?.({ code: 1000 });
    await vi.waitFor(() => expect(session.connecting).toBe(false));
  });

  // Missed events are the kit's own (#978): Runtime holds no replay state.
  it.each([false, true])(
    "warns that events may be missing when its side connection closed unexpectedly (session.closed first: %s)",
    async (closedFirst) => {
      const listeners = createSocketListeners();
      const socket = createSocket(listeners);
      const facts: ProviderSessionApplicationFact[] = [];
      const { session, getRecord, setRecord } = createProviderSessionHarness({
        driver: createDriver({
          connectSideband: vi.fn(async () => providerSuccess(socket)),
          hangUp: vi.fn(async () => providerSuccess({ status: 200, upstreamRequestId: "req" })),
        }),
        sink: async (fact) => {
          facts.push(fact);
        },
      });
      session.ensureConnected("rtc_serialized");
      await vi.waitFor(() => expect(listeners.message).toHaveLength(1));
      // Ending: Runtime no longer needs the side connection.
      setRecord({ ...getRecord(), connectionRequired: false });
      if (closedFirst) listeners.message[0]?.({ data: JSON.stringify({ type: "session.closed" }) });
      listeners.close[0]?.({ code: 1011 });
      await vi.waitFor(() => expect(session.connecting).toBe(false));
      await expect(session.release("rtc_serialized")).resolves.toEqual(
        closedFirst ? { status: "closed" } : { status: "close_unconfirmed" },
      );
      expect(facts.filter((fact) => fact.kind === "result_warning")).toEqual(
        closedFirst ? [] : [{ kind: "result_warning", warning: "provider_observation_gap" }],
      );
      // The loss wakes Runtime, which reconsiders its result at once during Ending; the kit does
      // not reconnect a connection Runtime no longer needs.
      expect(
        facts.filter((fact) => fact.kind === "session_lost" || fact.kind === "wake_scheduled"),
      ).toEqual([{ kind: "session_lost", source: "session_disconnected" }]);
    },
  );

  it("warns that events may be missing when its side connection was open at a Runtime restart", async () => {
    const facts: ProviderSessionApplicationFact[] = [];
    const session = createProviderSession({
      record: {
        ...defaultProviderSessionRecord,
        connectionRequired: false,
        executionState: { inputBuffered: false, sideConnectionOpen: true },
      },
      driver: createDriver({
        hangUp: vi.fn(async () => providerSuccess({ status: 200, upstreamRequestId: "req" })),
      }),
      sink: async (fact) => {
        facts.push(fact);
      },
    });
    await expect(session.release("rtc_serialized")).resolves.toEqual({
      status: "close_unconfirmed",
    });
    expect(facts).toEqual([{ kind: "result_warning", warning: "provider_observation_gap" }]);
  });

  it("reads speech kept before a Runtime restart back into its input closure", async () => {
    const listeners = createSocketListeners();
    const socket = createSocket(listeners);
    const sendFinalizationOperation = vi.fn(() => providerSuccess(undefined));
    const session = createProviderSession({
      record: {
        ...defaultProviderSessionRecord,
        executionState: { inputBuffered: true, sideConnectionOpen: false },
      },
      driver: createDriver({
        connectSideband: vi.fn(async () => providerSuccess(socket)),
        sendFinalizationOperation,
      }),
    });
    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(session.connected).toBe(true));
    expect(
      session.sendFinalizationOperation({
        kind: "close_input",
        commandId: "run:1",
        heldItemId: "item_answer",
      }),
    ).toMatchObject({ settlement: { supersedesHeld: true, inputToSettle: true } });

    listeners.close[0]?.({ code: 1000 });
    await vi.waitFor(() => expect(session.connecting).toBe(false));
  });

  // The kit's kept state is its own current persistence: a record it cannot read keeps neither
  // speech nor a suspected gap, so the restarted session settles and warns only from what it sees.
  it.each([
    ["the kept state as written", { inputBuffered: true, sideConnectionOpen: true }, true],
    ["a field of the wrong type", { inputBuffered: "true", sideConnectionOpen: true }, false],
    ["a missing field", { inputBuffered: true }, false],
    ["an unknown field", { inputBuffered: true, sideConnectionOpen: true, generation: 2 }, false],
    ["no object", ["inputBuffered"], false],
  ] as const)(
    "after a Runtime restart, keeps speech and the suspected gap only from %s",
    async (_case, executionState, kept) => {
      const facts: ProviderSessionApplicationFact[] = [];
      const session = createProviderSession({
        record: { ...defaultProviderSessionRecord, connectionRequired: false, executionState },
        driver: createDriver({
          hangUp: vi.fn(async () => providerSuccess({ status: 200, upstreamRequestId: "req" })),
        }),
        sink: async (fact) => {
          facts.push(fact);
        },
      });
      expect(
        session.describeInputClosure?.({
          kind: "close_input",
          commandId: "run:1",
          heldItemId: "item_answer",
        }),
      ).toEqual({ supersedesHeld: kept, answerFollows: false, inputToSettle: kept });
      await session.release("rtc_serialized");
      expect(facts).toEqual(
        kept ? [{ kind: "result_warning", warning: "provider_observation_gap" }] : [],
      );
    },
  );

  it("restores a connection without replaying initial control and schedules reconnect on close", async () => {
    const listeners = createSocketListeners();
    const socket = createSocket(listeners);
    const connectionInputs: Parameters<ScriptedRealtimeDriver["connectSideband"]>[0][] = [];
    const connectSideband = vi.fn(
      async (input: Parameters<ScriptedRealtimeDriver["connectSideband"]>[0]) => {
        connectionInputs.push(input);
        return providerSuccess(socket);
      },
    );
    const sendCommand = vi.fn(() => providerSuccess(undefined));
    const facts: ProviderSessionApplicationFact[] = [];
    const { session, storage } = createProviderSessionHarness({
      driver: createDriver({ connectSideband, sendCommand }),
      sink: async (fact) => {
        facts.push(fact);
      },
    });

    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(session.connected).toBe(true));
    expect(connectionInputs).toHaveLength(1);
    expect(connectionInputs[0]?.callId).toBe("rtc_serialized");
    // A reconnection retries without a deadline of its own.
    expect(connectionInputs[0]?.retryDeadlineAt).toBeUndefined();
    expect(sendCommand).not.toHaveBeenCalled();
    expect(facts).toEqual([{ kind: "execution_resumed", generation: 1 }]);

    listeners.close[0]?.({ code: 1006 });
    await vi.waitFor(() => expect(session.connecting).toBe(false));
    expect(session.connected).toBe(false);
    expect(storage.markClosed).toHaveBeenCalledWith("run_provider_session", expect.any(Number));
    expect(storage.scheduleWake).toHaveBeenCalledWith("run_provider_session", expect.any(Number));
    expect(facts).toEqual([
      { kind: "execution_resumed", generation: 1 },
      { kind: "session_lost", source: "session_disconnected" },
      { kind: "wake_scheduled" },
    ]);
  });

  it.each([false, true])(
    "uses the injected driver's receipt mapping before queued work (all events: %s)",
    async (observeAllProviderEvents) => {
      const listeners = createSocketListeners();
      const socket = createSocket(listeners);
      const facts: ProviderSessionApplicationFact[] = [];
      const receivedAt = 1_700_000_004_000;
      const raw = "custom-provider-transcript";
      const normalizeRuntimeObservation = vi.fn<
        ScriptedRealtimeDriver["normalizeRuntimeObservation"]
      >((_data, input) => ({
        kind: "agent_transcript_finalized",
        generation: 99,
        sequence: input.sequence,
        observedAt: input.observedAt,
        providerEventId: "mapped-event",
        responseId: "mapped-response",
        itemId: "mapped-item",
        text: "  Provider-specific final text.  ",
      }));
      const driver = createDriver({
        connectSideband: vi.fn(async () => providerSuccess(socket)),
        normalizeRuntimeObservation,
      });
      const session = createProviderSession({
        driver,
        record: {
          ...defaultProviderSessionRecord,
          generation: 2,
          eventCount: 7,
          observeAllProviderEvents,
        },
        sink: async (fact) => {
          facts.push(fact);
        },
      });
      session.ensureConnected("rtc_serialized");
      await vi.waitFor(() => expect(listeners.message).toHaveLength(1));
      const clock = vi.spyOn(Date, "now").mockReturnValue(receivedAt);
      try {
        listeners.message[0]?.({ data: raw });
        expect(normalizeRuntimeObservation).toHaveBeenCalledWith(raw, {
          sequence: 8,
          observedAt: receivedAt,
          observeAllProviderEvents,
        });
        expect(session.closeBarrier({ generation: 3, sequence: 7 })).toEqual({
          generation: 3,
          sequence: 8,
        });
        clock.mockReturnValue(receivedAt + 1_000);
        await session.drain();
        expect(facts.find((fact) => fact.kind === "provider_observation")).toEqual({
          kind: "provider_observation",
          observation: {
            kind: "agent_transcript_finalized",
            generation: 3,
            sequence: 8,
            observedAt: receivedAt,
            at: receivedAt,
            providerEventId: "mapped-event",
            responseId: "mapped-response",
            itemId: "mapped-item",
            text: "  Provider-specific final text.  ",
          },
          persistence: {
            sessionId: "rtc_serialized",
            sequence: 8,
            providerEventId: "mapped-event",
            diagnosticSummary: { sequence: 8, type: "unparseable_text" },
          },
        });
        listeners.close[0]?.({ code: 1000 });
        await vi.waitFor(() => expect(session.connecting).toBe(false));
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("advances the receipt barrier immediately and drains the awaited message queue", async () => {
    const listeners = createSocketListeners();
    const socket = createSocket(listeners);
    let releaseObservation: () => void = () => {};
    const observationBlocked = new Promise<void>((resolve) => {
      releaseObservation = resolve;
    });
    let observationAccepted = false;
    const session = createProviderSession({
      driver: createDriver({
        connectSideband: vi.fn(async () => providerSuccess(socket)),
      }),
      sink: async (fact) => {
        if (fact.kind !== "provider_observation") return;
        await observationBlocked;
        observationAccepted = true;
      },
    });

    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(listeners.message).toHaveLength(1));
    listeners.message[0]?.({
      data: JSON.stringify({
        type: "response.created",
        event_id: "unique",
        response: { id: "response_unique" },
      }),
    });

    expect(session.closeBarrier({ generation: 1, sequence: 0 })).toEqual({
      generation: 1,
      sequence: 1,
    });
    expect(session.sampleReceiptPrefix()).toEqual({
      receivedOrder: { generation: 1, sequence: 1 },
      processedThroughOrder: null,
    });
    const drained = session.drain();
    await Promise.resolve();
    expect(observationAccepted).toBe(false);
    releaseObservation();
    await drained;
    expect(observationAccepted).toBe(true);
    expect(session.sampleReceiptPrefix()).toEqual({
      receivedOrder: { generation: 1, sequence: 1 },
      processedThroughOrder: { generation: 1, sequence: 1 },
    });

    listeners.close[0]?.({ code: 1000 });
    await vi.waitFor(() => expect(session.connecting).toBe(false));
  });

  it("samples completed handoffs inside the FIFO without waiting on the queue", async () => {
    const listeners = createSocketListeners();
    const socket = createSocket(listeners);
    const samples: ProviderReceiptPrefix[] = [];
    const facts: ProviderSessionApplicationFact[] = [];
    const session = createProviderSession({
      driver: createDriver({ connectSideband: async () => providerSuccess(socket) }),
      sink: async (fact) => {
        facts.push(fact);
        if (fact.kind === "message_queue_drained") samples.push(session.sampleReceiptPrefix());
      },
    });
    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(listeners.message).toHaveLength(1));
    const message = listeners.message[0];
    message?.({ data: JSON.stringify({ type: "response.created", response: { id: "first" } }) });
    message?.({ data: JSON.stringify({ type: "response.created", response: { id: "second" } }) });
    await session.drain();
    expect(samples).toEqual([
      {
        receivedOrder: { generation: 1, sequence: 2 },
        processedThroughOrder: { generation: 1, sequence: 2 },
      },
    ]);
    expect(
      facts.flatMap((fact) =>
        fact.kind !== "provider_observation"
          ? []
          : [
              fact.observation !== null && "responseId" in fact.observation
                ? fact.observation.responseId
                : null,
            ],
      ),
    ).toEqual(["first", "second"]);
    listeners.close[0]?.({ code: 1000 });
    await vi.waitFor(() => expect(session.connecting).toBe(false));
  });

  it("keeps failed receipts pending until failure evidence completes", async () => {
    const listeners = createSocketListeners();
    const socket = createSocket(listeners);
    let releaseFailure: () => void = () => {};
    const blockedFailure = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    let failureReceived = false;
    const session = createProviderSession({
      driver: createDriver({ connectSideband: async () => providerSuccess(socket) }),
      sink: async (fact) => {
        if (fact.kind === "provider_observation") throw new Error("handoff_failed");
        if (fact.kind === "failure") {
          failureReceived = true;
          await blockedFailure;
        }
      },
    });
    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(listeners.message).toHaveLength(1));
    listeners.message[0]?.({
      data: JSON.stringify({ type: "response.created", response: { id: "failed" } }),
    });
    await vi.waitFor(() => expect(failureReceived).toBe(true));
    expect(session.sampleReceiptPrefix()).toEqual({
      receivedOrder: { generation: 1, sequence: 1 },
      processedThroughOrder: null,
    });
    releaseFailure();
    await session.drain();
    expect(session.sampleReceiptPrefix()).toEqual({
      receivedOrder: { generation: 1, sequence: 1 },
      processedThroughOrder: { generation: 1, sequence: 1 },
    });
    listeners.close[0]?.({ code: 1000 });
    await vi.waitFor(() => expect(session.connecting).toBe(false));
  });

  it("counts a discarded queued receipt as processed without admitting evidence", async () => {
    const listeners = createSocketListeners();
    const socket = createSocket(listeners);
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observations: ProviderSessionApplicationFact[] = [];
    const harness = createProviderSessionHarness({
      driver: createDriver({ connectSideband: async () => providerSuccess(socket) }),
      sink: async (fact) => {
        if (fact.kind === "provider_observation") {
          observations.push(fact);
          await blocked;
        }
      },
    });
    const { session } = harness;
    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(listeners.message).toHaveLength(1));
    listeners.message[0]?.({
      data: JSON.stringify({ type: "response.created", response: { id: "first" } }),
    });
    await vi.waitFor(() => expect(observations).toHaveLength(1));
    listeners.message[0]?.({
      data: JSON.stringify({ type: "response.created", response: { id: "rejected" } }),
    });
    harness.setRecord({ ...harness.getRecord(), sessionId: "rtc_replaced" });
    release();
    await session.drain();
    expect(observations).toHaveLength(1);
    expect(session.sampleReceiptPrefix()).toEqual({
      receivedOrder: { generation: 1, sequence: 2 },
      processedThroughOrder: { generation: 1, sequence: 2 },
    });
    listeners.close[0]?.({ code: 1000 });
    await vi.waitFor(() => expect(session.connecting).toBe(false));
  });

  it("shares duplicate acquisition and releases an uncancellable stale socket before admission", async () => {
    const listeners = createSocketListeners();
    const lateSocket = createSocket(listeners);
    let resolveAcquisition: (
      result: ReturnType<typeof providerSuccess<typeof lateSocket>>,
    ) => void = () => {};
    const acquisition = new Promise<ReturnType<typeof providerSuccess<typeof lateSocket>>>(
      (resolve) => {
        resolveAcquisition = resolve;
      },
    );
    const inputs: Parameters<ScriptedRealtimeDriver["connectSideband"]>[0][] = [];
    const { session, execution, executionFailures, setRecord, getRecord, storage } =
      createProviderSessionHarness({
        driver: createDriver({
          connectSideband: async (input) => {
            inputs.push(input);
            return acquisition;
          },
        }),
      });
    session.ensureConnected("rtc_serialized");
    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(inputs).toHaveLength(1));
    setRecord({ ...getRecord(), connectionRequired: false });
    session.ensureConnected("rtc_serialized");
    expect(inputs[0]?.signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(session.connecting).toBe(false));
    await vi.waitFor(() => expect(execution.dispose()).resolves.toBeUndefined());
    // Retirement ends the generation normally: its interrupted acquisition is not a failure.
    expect(executionFailures).toEqual([]);
    resolveAcquisition(providerSuccess(lateSocket));
    await vi.waitFor(() =>
      expect(lateSocket.close).toHaveBeenCalledWith(1000, "sideband_restore_no_longer_allowed"),
    );
    expect(listeners.message).toEqual([]);
    expect(storage.markClosed).not.toHaveBeenCalled();
    expect(
      session.sendFinalizationOperation({
        kind: "close_input",
        commandId: "retired:1",
        heldItemId: null,
      }),
    ).toEqual({
      status: "uncertain",
      code: "sideband_unavailable",
      settlement: { supersedesHeld: false, answerFollows: false, inputToSettle: false },
    });
  });

  it("drains an empty receipt prefix without waiting for pending acquisition", async () => {
    let finish: (
      result: ReturnType<typeof providerSuccess<ReturnType<typeof createSocket>>>,
    ) => void = () => {};
    const pending = new Promise<
      ReturnType<typeof providerSuccess<ReturnType<typeof createSocket>>>
    >((resolve) => {
      finish = resolve;
    });
    const { session, getRecord, setRecord } = createProviderSessionHarness({
      driver: createDriver({ connectSideband: () => pending }),
    });
    session.ensureConnected("rtc_serialized");
    let drained = false;
    const drain = session.drain().then(() => {
      drained = true;
    });
    try {
      await vi.waitFor(() => expect(drained).toBe(true));
    } finally {
      setRecord({ ...getRecord(), retired: true });
      session.reconcileLifetime();
      finish(providerSuccess(createSocket(createSocketListeners())));
      await drain;
    }
  });

  it("retains native acquisition until an ignored-abort late socket is released", async () => {
    const socket = createSocket(createSocketListeners());
    const tasks = new Set<Promise<unknown>>();
    let finish: (response: Response) => void = () => {};
    const nativeReply = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetchImpl = vi.fn(() => nativeReply);
    const { session, execution, executionFailures, getRecord, setRecord } =
      createProviderSessionHarness({
        driver: createDriver({
          connectSideband: (input) => openAiDriverOver(fetchImpl).connectSideband(input),
        }),
        onBackground: (task) => {
          const tracked = task.finally(() => tasks.delete(tracked));
          tasks.add(tracked);
        },
      });
    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    setRecord({ ...getRecord(), retired: true });
    session.reconcileLifetime();
    await vi.waitFor(() => expect(session.connecting).toBe(false));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      expect(tasks.size).toBeGreaterThan(0);
      await expect(execution.dispose()).resolves.toBeUndefined();
      expect(executionFailures).toEqual([]);
    } finally {
      const response = new Response(null);
      Object.defineProperty(response, "webSocket", { value: socket });
      finish(response);
      await vi.waitFor(() => expect(socket.close).toHaveBeenCalledOnce());
      await Promise.all([...tasks]);
    }
  });

  it("does not let late generation completion clear or admit into its replacement", async () => {
    const oldListeners = createSocketListeners();
    const oldSocket = createSocket(oldListeners);
    const newListeners = createSocketListeners();
    const newSocket = createSocket(newListeners);
    let finishOld: (
      result: ReturnType<typeof providerSuccess<typeof oldSocket>>,
    ) => void = () => {};
    const oldAcquisition = new Promise<ReturnType<typeof providerSuccess<typeof oldSocket>>>(
      (resolve) => {
        finishOld = resolve;
      },
    );
    const sends: unknown[] = [];
    const { session, setRecord, getRecord, storage } = createProviderSessionHarness({
      driver: createDriver({
        connectSideband: async ({ callId }) =>
          callId === "rtc_serialized" ? oldAcquisition : providerSuccess(newSocket),
        sendFinalizationOperation: (input) => {
          sends.push(input);
          return providerSuccess(undefined);
        },
      }),
    });
    session.ensureConnected("rtc_serialized");
    setRecord({
      ...getRecord(),
      runId: "replacement-run",
      sessionId: "rtc_replacement",
      generation: 7,
    });
    session.ensureConnected("rtc_replacement");
    await vi.waitFor(() => expect(session.connected).toBe(true));
    finishOld(providerSuccess(oldSocket));
    await vi.waitFor(() => expect(oldSocket.close).toHaveBeenCalledOnce());
    expect(oldListeners.message).toEqual([]);
    expect(storage.markClosed).not.toHaveBeenCalled();
    expect(
      session.sendFinalizationOperation({
        kind: "discard_later_input",
        commandId: "replacement:1",
      }),
    ).toEqual({ status: "dispatched" });
    expect(sends).toEqual([
      { socket: newSocket, operation: { kind: "clear_input", commandId: "replacement:1" } },
    ]);
    newListeners.close[0]?.({ code: 1000 });
    await vi.waitFor(() => expect(session.connecting).toBe(false));
    expect(newListeners).toEqual({ message: [], close: [], error: [] });
  });

  it("drains the accepted FIFO prefix through a handled message failure and native close", async () => {
    const listeners = createSocketListeners();
    const socket = createSocket(listeners);
    const facts: ProviderSessionApplicationFact[] = [];
    let releaseFirst: () => void = () => {};
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { session } = createProviderSessionHarness({
      driver: createDriver({ connectSideband: async () => providerSuccess(socket) }),
      sink: async (fact) => {
        facts.push(fact);
        if (fact.kind === "provider_observation" && fact.persistence.sequence === 1) {
          await first;
          throw new Error("handled_first_message_failure");
        }
      },
    });
    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(session.connected).toBe(true));
    for (let sequence = 1; sequence <= 4; sequence += 1)
      listeners.message[0]?.({
        data: JSON.stringify({
          type: "response.created",
          event_id: `fifo_${sequence}`,
          response: { id: `response_${sequence}` },
        }),
      });
    listeners.close[0]?.({ code: 1000 });
    listeners.message[0]?.({
      data: JSON.stringify({
        type: "response.created",
        event_id: "after_close",
        response: { id: "after_close" },
      }),
    });
    expect(session.closeBarrier(null)).toEqual({ generation: 1, sequence: 4 });
    const drained = session.drain();
    releaseFirst();
    await drained;
    expect(
      facts.flatMap((fact) =>
        fact.kind === "provider_observation" ? [fact.persistence.sequence] : [],
      ),
    ).toEqual([1, 2, 3, 4]);
    expect(facts.filter((fact) => fact.kind === "failure")).toEqual([
      {
        kind: "failure",
        failure: "message",
        errorText: "handled_first_message_failure",
        applyRuntimeFailure: true,
      },
    ]);
    // The native close is the side connection's own loss, reported after the message's failure.
    expect(facts.at(-2)).toEqual({ kind: "session_lost", source: "session_disconnected" });
    expect(facts.at(-1)).toEqual({ kind: "wake_scheduled" });
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalledOnce());
  });

  it.each(["current_read", "normalization", "event_identity"] as const)(
    "fails the retained generation after its accepted prefix when native ingress throws at %s",
    async (failurePoint) => {
      const listeners = createSocketListeners();
      const socket = createSocket(listeners);
      const facts: ProviderSessionApplicationFact[] = [];
      const defect = new Error(`native_ingress_defect:${failurePoint}`);
      let failNormalization = false;
      let releaseFirst: () => void = () => {};
      const first = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const driver = createDriver({
        connectSideband: async () => providerSuccess(socket),
        normalizeRuntimeObservation: (data, context) => {
          if (failNormalization) throw defect;
          return openAiDriverOver().normalizeRuntimeObservation(data, context);
        },
      });
      const { session, storage, executionFailures } = createProviderSessionHarness({
        driver,
        sink: async (fact) => {
          facts.push(fact);
          if (fact.kind === "provider_observation" && fact.persistence.sequence === 1) await first;
        },
      });
      session.ensureConnected("rtc_serialized");
      await vi.waitFor(() => expect(listeners.message).toHaveLength(1));
      const receive = (eventId: string) =>
        listeners.message[0]?.({
          data: JSON.stringify({
            type: "response.created",
            event_id: eventId,
            response: { id: eventId },
          }),
        });
      receive("accepted_1");
      receive("accepted_2");
      receive("accepted_3");
      await vi.waitFor(() =>
        expect(facts.some((fact) => fact.kind === "provider_observation")).toBe(true),
      );
      if (failurePoint === "current_read")
        vi.spyOn(storage, "read").mockImplementationOnce(() => {
          throw defect;
        });
      else if (failurePoint === "event_identity")
        vi.spyOn(storage, "hasEventIdentity").mockImplementationOnce(() => {
          throw defect;
        });
      else failNormalization = true;

      expect(() => receive("faulting_input")).not.toThrow();
      failNormalization = false;
      receive("after_defect");
      listeners.close[0]?.({ code: 1000 });
      expect(session.closeBarrier(null)).toEqual({ generation: 1, sequence: 3 });
      expect(socket.close).not.toHaveBeenCalled();
      const drained = session.drain();
      releaseFirst();
      await drained;
      await vi.waitFor(() => expect(socket.close).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(executionFailures).toHaveLength(1));
      expect(executionFailures.map((cause) => Cause.squash(cause))).toEqual([defect]);
      expect(
        facts.flatMap((fact) =>
          fact.kind === "provider_observation" ? [fact.persistence.providerEventId] : [],
        ),
      ).toEqual(["accepted_1", "accepted_2", "accepted_3"]);
      expect(facts.filter((fact) => fact.kind === "failure")).toEqual([]);
      expect(storage.markClosed).not.toHaveBeenCalled();
      expect(storage.scheduleWake).not.toHaveBeenCalled();
      expect(driver.hangUp).not.toHaveBeenCalled();
      expect(socket.removeEventListener.mock.calls.map(([event]) => event).sort()).toEqual([
        "close",
        "error",
        "message",
      ]);
      expect(listeners).toEqual({ message: [], close: [], error: [] });
      expect(session.connected).toBe(false);
      expect(session.connecting).toBe(false);
    },
  );

  it.each(["exit", "late_message"] as const)(
    "retires a terminal connection at %s only after its accepted prefix, without adding provider closure evidence",
    async (trigger) => {
      const listeners = createSocketListeners();
      const socket = createSocket(listeners);
      const facts: ProviderSessionApplicationFact[] = [];
      let release: () => void = () => {};
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { session, storage, getRecord, setRecord } = createProviderSessionHarness({
        driver: createDriver({ connectSideband: async () => providerSuccess(socket) }),
        sink: async (fact) => {
          facts.push(fact);
          if (fact.kind === "provider_observation" && fact.persistence.sequence === 1)
            await blocked;
        },
      });
      session.ensureConnected("rtc_serialized");
      await vi.waitFor(() => expect(session.connected).toBe(true));
      listeners.message[0]?.({
        data: JSON.stringify({
          type: "response.created",
          event_id: "accepted",
          response: { id: "accepted" },
        }),
      });
      await vi.waitFor(() =>
        expect(facts.some((fact) => fact.kind === "provider_observation")).toBe(true),
      );
      const failedProjection = vi.spyOn(storage, "read").mockImplementationOnce(() => {
        throw new Error("projection_unavailable");
      });
      expect(() => session.reconcileLifetime()).not.toThrow();
      expect(session.connected).toBe(true);
      failedProjection.mockRestore();
      const remove = socket.removeEventListener;
      socket.removeEventListener = vi.fn((event, listener) => {
        remove(event, listener);
        if (event === "message") throw new Error("native_listener_release_failed");
      });
      setRecord({ ...getRecord(), retired: true, connectionRequired: false });
      if (trigger === "exit") session.reconcileLifetime();
      listeners.message[0]?.({
        data: JSON.stringify({
          type: "response.created",
          event_id: "retired",
          response: { id: "retired" },
        }),
      });
      expect(session.closeBarrier(null)).toEqual({ generation: 1, sequence: 1 });
      expect(socket.close).not.toHaveBeenCalled();
      const drained = session.drain();
      release();
      await drained;
      expect(
        facts.flatMap((fact) =>
          fact.kind === "provider_observation" ? [fact.persistence.sequence] : [],
        ),
      ).toEqual([1]);
      expect(facts.find((fact) => fact.kind === "wake_scheduled")).toBeUndefined();
      expect(socket.close).toHaveBeenCalledOnce();
      expect(listeners).toEqual({ message: [], close: [], error: [] });
    },
  );

  it("releases partially registered listeners when socket admission fails", async () => {
    const listeners = createSocketListeners();
    const socket = createSocket(listeners);
    const add = socket.addEventListener;
    socket.addEventListener = vi.fn((event, listener) => {
      add(event, listener);
      if (event === "close") throw new Error("native_listener_registration_failed");
    });
    const facts: ProviderSessionApplicationFact[] = [];
    const { session, executionFailures } = createProviderSessionHarness({
      driver: createDriver({ connectSideband: async () => providerSuccess(socket) }),
      sink: async (fact) => {
        facts.push(fact);
      },
    });
    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(executionFailures).toHaveLength(1));
    expect(executionFailures.map((cause) => Cause.hasDies(cause))).toEqual([true]);
    expect(listeners).toEqual({ message: [], close: [], error: [] });
    expect(facts).toEqual([]);
    expect(session.connecting).toBe(false);
  });

  it("answers skipped, unavailable and acknowledged hang-ups with an unconfirmed closure", async () => {
    const hangUp = vi.fn(async () =>
      providerSuccess({ status: 204, upstreamRequestId: "req_hangup_success" }),
    );
    const session = createProviderSession({ driver: createDriver({ hangUp }) });

    // Without a call nothing is hung up, and nothing confirms a closure.
    await expect(session.release(null)).resolves.toEqual({ status: "close_unconfirmed" });
    await expect(session.release("rtc_provider_call")).resolves.toEqual({
      status: "close_unconfirmed",
    });
    await expect(
      createProviderSession({ apiKey: "", openAiDriver: true }).release("rtc_provider_call"),
    ).resolves.toEqual({
      status: "close_unconfirmed",
      failure: { status: "failed", timedOut: false, code: "missing_credentials:OPENAI_API_KEY" },
    });
    expect(hangUp).toHaveBeenCalledTimes(1);
  });

  it("answers a timed-out hang-up as uncertain and preserves driver defects", async () => {
    const timeoutSession = createProviderSession({
      driver: createDriver({
        hangUp: vi.fn(async () =>
          providerFailure({
            stage: "hangup",
            code: "session_release_timed_out",
            timeoutMs: 321,
            retryable: true,
          }),
        ),
      }),
    });
    const uncertainSession = createProviderSession({
      driver: createDriver({
        hangUp: vi.fn(async () => {
          throw new Error("response_lost");
        }),
      }),
    });

    await expect(timeoutSession.release("rtc_provider_call")).resolves.toEqual({
      status: "close_unconfirmed",
      failure: { status: "uncertain", timedOut: true, code: "session_release_timed_out" },
    });
    await expect(uncertainSession.release("rtc_provider_call")).rejects.toThrow("response_lost");
  });

  it("caps provider hangup transport time to the remaining finalization budget", async () => {
    const hangUp = vi.fn(async () =>
      providerSuccess({ status: 204, upstreamRequestId: "req_budgeted_hangup" }),
    );
    const session = createProviderSession({
      hangupTimeoutSetting: "5000",
      driver: createDriver({ hangUp }),
    });

    await session.release("rtc_budgeted_hangup", 321);

    expect(hangUp).toHaveBeenCalledWith({
      apiKey: "test-key",
      callId: "rtc_budgeted_hangup",
      timeoutMs: 321,
    });
  });

  it("does not send the opening response when a failure wins during readiness", async () => {
    const listeners = createSocketListeners();
    const socket = createSocket(listeners);
    const sendCommand = vi.fn(() => providerSuccess(undefined));
    let harness: ReturnType<typeof createProviderSessionHarness>;
    harness = createProviderSessionHarness({
      record: {
        ...defaultProviderSessionRecord,
        initialConnection: true,
        canStartConversation: true,
      },
      driver: createDriver({
        connectSideband: vi.fn(async () => providerSuccess(socket)),
        sendCommand,
      }),
      sink: async (fact) => {
        if (fact.kind === "execution_ready") {
          harness.setRecord({ ...harness.getRecord(), canStartConversation: false });
        }
      },
    });

    harness.session.ensureConnected("rtc_serialized");

    await vi.waitFor(() => expect(socket.close).toHaveBeenCalledOnce());
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("awaits the application sink before accepting the next provider message", async () => {
    const listeners = createSocketListeners();
    const socket = {
      readyState: 1,
      accept: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(
        (type: keyof typeof listeners, listener: (event: Record<string, unknown>) => void) => {
          listeners[type].push(listener);
        },
      ),
    };
    const driver = createDriver({
      connectSideband: vi.fn(async () => providerSuccess(socket)),
    });
    let releaseFirst: () => void = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const facts: ProviderSessionApplicationFact[] = [];
    let providerObservationCount = 0;
    const session = createProviderSession({
      driver,
      sink: async (fact) => {
        facts.push(fact);
        if (fact.kind !== "provider_observation") return;
        providerObservationCount += 1;
        if (providerObservationCount === 1) await firstBlocked;
      },
    });

    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(listeners.message).toHaveLength(1));
    listeners.message[0]?.({ data: JSON.stringify({ type: "response.created", event_id: "one" }) });
    listeners.message[0]?.({ data: JSON.stringify({ type: "response.created", event_id: "two" }) });
    await vi.waitFor(() => expect(providerObservationCount).toBe(1));
    expect(
      facts.flatMap((fact) =>
        fact.kind === "provider_observation" ? [fact.persistence.sequence] : [],
      ),
    ).toEqual([1]);

    releaseFirst();
    await vi.waitFor(() => expect(providerObservationCount).toBe(2));
    expect(
      facts.flatMap((fact) =>
        fact.kind === "provider_observation" ? [fact.persistence.sequence] : [],
      ),
    ).toEqual([1, 2]);
    listeners.close[0]?.({ code: 1000 });
    await vi.waitFor(() => expect(facts.some((fact) => fact.kind === "wake_scheduled")).toBe(true));
  });

  it("ends the Run and answers its release closed when OpenAI no longer knows the reconnected call", async () => {
    const facts: ProviderSessionApplicationFact[] = [];
    const session = createProviderSession({
      driver: createDriver({
        connectSideband: vi.fn(async () =>
          providerFailure({
            stage: "session_setup",
            code: "sideband_call_id_not_found",
            providerStatus: 404,
            retryable: false,
          }),
        ),
      }),
      sink: async (fact) => {
        facts.push(fact);
      },
    });

    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(facts.some((fact) => fact.kind === "failure")).toBe(true));
    expect(facts).toEqual([
      {
        kind: "failure",
        failure: "session",
        errorText: "session_setup:sideband_call_id_not_found status=404",
        applyRuntimeFailure: false,
      },
      { kind: "session_lost", source: "session_closed_observed" },
    ]);
    // The session is known to be closed, whatever its hang-up answers.
    await expect(session.release("rtc_serialized")).resolves.toEqual({ status: "closed" });
  });

  it("does not promote an untyped sideband 404 to terminal provider evidence", async () => {
    const facts: ProviderSessionApplicationFact[] = [];
    const session = createProviderSession({
      driver: createDriver({
        connectSideband: vi.fn(async () =>
          providerFailure({
            stage: "session_setup",
            code: "sideband_connect_rejected",
            providerStatus: 404,
            retryable: false,
          }),
        ),
      }),
      sink: async (fact) => {
        facts.push(fact);
      },
    });

    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(facts.some((fact) => fact.kind === "failure")).toBe(true));
    expect(facts[0]).toMatchObject({
      kind: "failure",
      applyRuntimeFailure: true,
      errorText: "session_setup:sideband_connect_rejected status=404",
    });
    expect(facts.filter((fact) => fact.kind === "failure")).toHaveLength(1);
    expect(facts.some((fact) => fact.kind === "session_lost")).toBe(false);
  });

  it("decides which participant speech counts once input closed", async () => {
    const listeners = createSocketListeners();
    const socket = createSocket(listeners);
    const facts: ProviderSessionApplicationFact[] = [];
    const session = createProviderSession({
      // After a restart: Runtime closed input and retained the participant item it holds.
      record: {
        ...defaultProviderSessionRecord,
        participantInputClosed: true,
        eligibleParticipantInputIds: ["retained"],
      },
      driver: createDriver({ connectSideband: async () => providerSuccess(socket) }),
      sink: async (fact) => {
        facts.push(fact);
      },
    });
    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(listeners.message).toHaveLength(1));
    for (const event of [
      { type: "conversation.item.input_audio_transcription.completed", item_id: "retained" },
      { type: "input_audio_buffer.speech_started", item_id: "late" },
      { type: "input_audio_buffer.speech_stopped", item_id: "late" },
    ])
      listeners.message[0]?.({ data: JSON.stringify({ ...event, event_id: event.type }) });
    await session.drain();
    const excluded = facts.flatMap((fact) =>
      fact.kind === "provider_observation" && fact.persistence.excludedParticipantInput === true
        ? [fact.persistence.providerEventId]
        : [],
    );
    // The retained item still counts, and speech that started after input closed does not,
    // nor does its end. Before the shared session, Original counted that end and Goodbye and
    // Questions did not count the retained item.
    expect(excluded).toEqual([
      "input_audio_buffer.speech_started",
      "input_audio_buffer.speech_stopped",
    ]);
    listeners.close[0]?.({ code: 1000 });
    await vi.waitFor(() => expect(session.connecting).toBe(false));
  });

  it("leaves participant input unchanged when a provider event arrives again", async () => {
    const listeners = createSocketListeners();
    const socket = createSocket(listeners);
    const { session, storage } = createProviderSessionHarness({
      driver: createDriver({ connectSideband: async () => providerSuccess(socket) }),
    });
    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(listeners.message).toHaveLength(1));
    // The answer's speech is committed; its start then arrives again under the same event id
    // before an unrelated item is committed.
    for (const event of [
      { type: "input_audio_buffer.speech_started", item_id: "answer", event_id: "evt_speech" },
      { type: "input_audio_buffer.committed", item_id: "answer", event_id: "evt_answer" },
      { type: "input_audio_buffer.speech_started", item_id: "answer", event_id: "evt_speech" },
      { type: "input_audio_buffer.committed", item_id: "other", event_id: "evt_other" },
    ])
      listeners.message[0]?.({ data: JSON.stringify(event) });
    await session.drain();
    // The kit keeps whether uncommitted speech remains: the answer's speech, then its commit.
    // The repeated start buffers nothing again, so the unrelated item settles nothing. Before the
    // shared session, Original's input closure observed the duplicate and settled the speech it
    // restarted with the unrelated item.
    expect(storage.recordExecutionState).toHaveBeenNthCalledWith(2, expect.any(String), {
      inputBuffered: true,
      sideConnectionOpen: true,
    });
    expect(storage.recordExecutionState).toHaveBeenLastCalledWith(expect.any(String), {
      inputBuffered: false,
      sideConnectionOpen: true,
    });
    expect(storage.recordExecutionState).toHaveBeenCalledTimes(3);
    listeners.close[0]?.({ code: 1000 });
    await vi.waitFor(() => expect(session.connecting).toBe(false));
  });

  it("fails only the provider event the driver cannot decode", async () => {
    const listeners = createSocketListeners();
    const socket = createSocket(listeners);
    const facts: ProviderSessionApplicationFact[] = [];
    const harness = createProviderSessionHarness({
      driver: createDriver({
        connectSideband: async () => providerSuccess(socket),
        normalizeEvent: (data) => {
          if (typeof data === "string" && data.includes("undecodable"))
            throw new Error("undecodable_provider_event");
          return openAiDriverOver().normalizeEvent(data);
        },
      }),
      sink: async (fact) => {
        facts.push(fact);
      },
    });
    const session = harness.session;
    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(listeners.message).toHaveLength(1));
    for (const event of [
      { type: "input_audio_buffer.speech_started", item_id: "undecodable", event_id: "evt_bad" },
      { type: "response.created", event_id: "evt_after", response: { id: "after" } },
    ])
      listeners.message[0]?.({ data: JSON.stringify(event) });
    await session.drain();
    // Runtime applies that message's failure and still receives the next message. Before the
    // shared session, Goodbye and Questions failed the connection instead.
    expect(
      facts.flatMap((fact) =>
        fact.kind === "failure"
          ? [`failure:${fact.failure}:${fact.errorText}`]
          : fact.kind === "provider_observation"
            ? [`observation:${fact.persistence.providerEventId}`]
            : [],
      ),
    ).toEqual(["failure:message:undecodable_provider_event", "observation:evt_after"]);
    expect(session.connected).toBe(true);
    listeners.close[0]?.({ code: 1000 });
    await vi.waitFor(() => expect(session.connecting).toBe(false));
    expect(harness.executionFailures).toEqual([]);
  });

  it("keeps duplicate provider identities outside the receipt barrier", async () => {
    const persisted = new Set(["duplicate"]);
    const listeners = createSocketListeners();
    const socket = {
      readyState: 1,
      accept: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(
        (type: keyof typeof listeners, listener: (event: Record<string, unknown>) => void) => {
          listeners[type].push(listener);
        },
      ),
    };
    const session = createProviderSession({
      persisted,
      driver: createDriver({
        connectSideband: vi.fn(async () => providerSuccess(socket)),
      }),
    });

    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => expect(listeners.message).toHaveLength(1));
    listeners.message[0]?.({
      data: JSON.stringify({
        type: "response.created",
        event_id: "duplicate",
        response: { id: "response_duplicate" },
      }),
    });

    expect(session.closeBarrier({ generation: 1, sequence: 0 })).toEqual({
      generation: 1,
      sequence: 0,
    });
    listeners.close[0]?.({ code: 1000 });
  });
});

type ProviderSessionHarnessInput = Readonly<{
  apiKey?: string;
  hangupTimeoutSetting?: string;
  /** The test driver's script; its unscripted operations are `createDriver`'s. */
  driver?: RealtimeDriverScript;
  /** OpenAI's own driver in place of the test driver, with feasibility read from the key. */
  openAiDriver?: true;
  sink?: (fact: ProviderSessionApplicationFact) => Promise<void>;
  record?: ProviderSessionRecord;
  persisted?: Set<string>;
  onBackground?: (task: Promise<unknown>) => void;
  onRecordCallIdentity?: (
    input: Parameters<ProviderSessionStorage["recordSessionIdentity"]>[0],
  ) => void;
  onRecordCallAnswer?: (input: Parameters<ProviderSessionStorage["recordSessionReply"]>[0]) => void;
  /**
   * The pair's configuration; by default the sample's, whose `question` is a conversing phase
   * and whose `goodbye` is a closing.
   */
  configuration?: RealtimeSessionConfiguration<typeof sampleStates>;
}>;

/**
 * A sample Conversation's states: Interviewing, a later Question, then a Goodbye that reports its
 * completion.
 */
const sampleStates = {
  interviewing: {
    id: "sample/interviewing",
    input: z.null(),
    event: z.strictObject({ kind: z.literal("finish_intent") }),
  },
  question: {
    id: "sample/question",
    input: z.null(),
    event: z.strictObject({ kind: z.literal("finish_intent") }),
  },
  goodbye: {
    id: "sample/goodbye",
    input: z.null(),
    event: z.strictObject({ kind: z.literal("goodbye_completed"), responseId: z.string() }),
  },
};

const sampleQuestionText = "Ask the participant the next sample question.";
/**
 * A sample pair's configuration: it opens with `interviewing`, converses in a later `question`
 * and closes with `goodbye`.
 */
const sampleConfiguration: RealtimeSessionConfiguration<typeof sampleStates> = {
  opening: {
    state: "interviewing",
    content: () => ({
      instructions: { kind: "literal", text: "Interview the participant." },
      operationalInstructions: "",
      tools: [],
    }),
  },
  nodes: {
    question: {
      operation: "conversing",
      content: () => ({
        instructions: { kind: "literal", text: sampleQuestionText },
        operationalInstructions: "",
        tools: [],
      }),
    },
    goodbye: {
      operation: "closing",
      content: () => ({ sentence: "Thank you. Goodbye." }),
      completed: (responseId) => ({ kind: "goodbye_completed", responseId }),
    },
  },
};

/** Realtime's settings as Runtime stored them for the sample Run, among them its turn detection. */
const sampleSettings = prepareRealtimeSettings({
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

/**
 * A Live session of the sample pair over the kit's fake side connection, with the sample's
 * stored settings: what it reports to Runtime, the commands it sends, and the provider's end.
 * The caller stubs `WebSocketPair` with miniflare's.
 */
async function connectLiveSampleSession() {
  // Each connection generation gets its own side connection; `send` and `sent` use the latest.
  const sides: ReturnType<typeof createFakeRealtimeSideConnection>[] = [];
  const releasedSides = new Set<number>();
  const side = () => {
    const latest = sides.at(-1);
    if (latest === undefined) throw new Error("side_connection_missing");
    return latest;
  };
  const facts: ProviderSessionApplicationFact[] = [];
  let holding = false;
  let releaseHeld = () => {};
  const harness = createSessionHarness({
    record: {
      ...defaultProviderSessionRecord,
      canStartConversation: true,
      preparedSettings: sampleSettings,
    },
    driver: createDriver({
      connectSideband: async () => {
        const next = createFakeRealtimeSideConnection();
        next.provider.accept();
        const index = sides.length;
        next.provider.addEventListener("close", () => releasedSides.add(index));
        sides.push(next);
        return providerSuccess(next.connection);
      },
    }),
    sink: async (fact) => {
      facts.push(fact);
      if (holding && fact.kind === "provider_observation") {
        holding = false;
        await new Promise<void>((resolve) => {
          releaseHeld = resolve;
        });
      }
    },
  });
  const { session } = harness;
  session.ensureConnected("rtc_serialized");
  await vi.waitFor(() => expect(session.connected).toBe(true));
  /** Connects the next generation once the record allows it, and waits until it is admitted. */
  const connectNext = async () => {
    const before = sides.length;
    session.ensureConnected("rtc_serialized");
    await vi.waitFor(() => {
      expect(sides.length).toBe(before + 1);
      expect(session.connected).toBe(true);
    });
  };
  return {
    session,
    send: (event: ParsedProviderEvent) => side().provider.send(JSON.stringify(event)),
    reported: () => facts.filter((fact) => fact.kind === "failure"),
    /** The commands of that type sent on the latest side connection, or on the one given. */
    sent: (type: string, index?: number) =>
      (index === undefined ? side() : sides[index])?.commands.filter(
        (command) =>
          typeof command === "object" &&
          command !== null &&
          "type" in command &&
          command.type === type,
      ),
    /**
     * The side connection closes and, once Runtime recorded that generation, the next one
     * connects on a new side connection.
     */
    reconnect: async () => {
      side().provider.close(1011, "provider_closed");
      await vi.waitFor(() => expect(session.connecting).toBe(false));
      harness.setRecord({ ...harness.getRecord(), generation: sides.length });
      await connectNext();
    },
    /**
     * The record moves past the running generation: it is retired and the next generation
     * connects on a new side connection.
     */
    replace: async () => {
      harness.setRecord({ ...harness.getRecord(), generation: sides.length + 1 });
      await connectNext();
    },
    /** Holds Runtime's handoff of the next provider observation until it is released. */
    holdNextObservation: () => {
      holding = true;
    },
    releaseObservation: () => releaseHeld(),
    /** Whether the session released the side connection of that generation, counted from 0. */
    released: (index: number) => releasedSides.has(index),
    close: async () => {
      side().provider.close(1000);
      await vi.waitFor(() => expect(session.connecting).toBe(false));
    },
  };
}

/** A later Question of the sample, after the one `enterSampleQuestion` enters. */
function laterSampleQuestion(failures: string[]): ConversationNodeDispatch<typeof sampleStates> {
  return {
    ...sampleDispatch("question", failures),
    identity: {
      runId: "run_provider_session",
      visitId: "question-2",
      operationId: "question-2",
      generation: 2,
    },
  };
}

/** The provider's acknowledgement of a sample Question's session update. */
function sampleQuestionUpdated(eventId: string, automatic: boolean): ParsedProviderEvent {
  return {
    type: "session.updated",
    event_id: eventId,
    session: {
      instructions: sampleQuestionText,
      audio: {
        input: {
          turn_detection: {
            type: "semantic_vad",
            eagerness: "high",
            create_response: automatic,
            interrupt_response: false,
          },
        },
      },
    },
  };
}

/** Enters the sample's `question` on a Live session and completes its entry. */
async function enterSampleQuestion(
  live: Awaited<ReturnType<typeof connectLiveSampleSession>>,
  failures: string[],
) {
  live.session.enterNode(sampleDispatch("question", failures));
  await vi.waitFor(() => expect(live.sent("session.update")).toHaveLength(1));
  live.send(sampleQuestionUpdated("evt_question_suppressed", false));
  await vi.waitFor(() => expect(live.sent("response.create")).toHaveLength(1));
  live.send({
    type: "response.created",
    event_id: "evt_question_created",
    response: { id: "question-reply", metadata: { runtime_operation_id: "question" } },
  });
  await vi.waitFor(() => expect(live.sent("session.update")).toHaveLength(2));
  live.send(sampleQuestionUpdated("evt_question_restored", true));
  live.send({
    type: "response.done",
    event_id: "evt_question_done",
    response: { id: "question-reply", status: "completed" },
  });
  await live.session.drain();
}

/** A dispatch of the sample's `state`, whose failures are collected in `failures`. */
function sampleDispatch(
  state: "interviewing" | "question" | "goodbye",
  failures: string[],
): ConversationNodeDispatch<typeof sampleStates> {
  return {
    state,
    input: null,
    identity: { runId: "run_provider_session", visitId: state, operationId: state, generation: 1 },
    deadlineAt: Date.now() + 60_000,
    clock: Date.now,
    reporter: { report: () => null, isCurrent: () => true },
    onComplete: async () => {},
    onFailure: async (reason) => {
      failures.push(reason);
    },
  };
}

const sampleOffer = { sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n" };

/** A prepared model session from the kit's own preparation, with one literal prompt. */
/** The sample opening content, and Realtime's settings as Runtime hands them to the start. */
function prepareSampleSession() {
  return {
    content: {
      instructions: { kind: "literal", text: "Interview the participant." },
      operationalInstructions: "",
      tools: [],
    },
    settings: prepareRealtimeSettings({ reasoningEffort: null }),
  } as const;
}

const defaultProviderSessionRecord: ProviderSessionRecord = {
  runId: "run_provider_session",
  sessionId: "rtc_serialized",
  generation: 0,
  eventCount: 0,
  initialConnection: false,
  connectionRequired: true,
};

function createSessionHarness(input: ProviderSessionHarnessInput) {
  let record = input.record ?? defaultProviderSessionRecord;
  const storage: ProviderSessionStorage = {
    read: () => record,
    claimOpening: () => {
      if (record.openingState !== undefined && record.openingState !== "pending") return false;
      record = { ...record, openingState: "claimed" };
      return true;
    },
    markOpeningSent: () => {
      record = { ...record, openingState: "sent" };
    },
    recordSessionIdentity: vi.fn(
      (call: Parameters<ProviderSessionStorage["recordSessionIdentity"]>[0]) =>
        input.onRecordCallIdentity?.(call),
    ),
    recordSessionReply: vi.fn((call: Parameters<ProviderSessionStorage["recordSessionReply"]>[0]) =>
      input.onRecordCallAnswer?.(call),
    ),
    setGeneration: vi.fn(),
    markStarted: vi.fn(),
    markClosed: vi.fn(),
    scheduleWake: vi.fn(),
    hasEventIdentity: (eventId) => input.persisted?.has(eventId) ?? false,
    recordExecutionState: vi.fn((_runId: string, state: ConversationCallbackJson) => {
      record = { ...record, executionState: state };
    }),
  };
  const events = createEvents();
  const apiKey = input.apiKey ?? "test-key";
  const executionFailures: Cause.Cause<unknown>[] = [];
  const execution = new NativeWorkOwner((cause) => executionFailures.push(cause));
  const sessionInput = {
    execution,
    apiKey,
    // OpenAI's driver is feasible only with a key; the test driver always is.
    providerFeasible: input.openAiDriver === true ? apiKey.length > 0 : true,
    hangupTimeoutSetting: input.hangupTimeoutSetting,
    driver:
      input.openAiDriver === true
        ? openAiRealtimeDriver()
        : realtimeTestDriver(input.driver ?? createDriver()),
    storage,
    events,
    backgroundWork: { waitUntil: (task: Promise<unknown>) => input.onBackground?.(task) },
    sink: input.sink ?? (async () => {}),
  };
  const session = createRealtimeRuntimeSession<typeof sampleStates>(
    sessionInput,
    input.configuration ?? sampleConfiguration,
  );
  return {
    session,
    storage,
    events,
    execution,
    executionFailures,
    getRecord: () => record,
    setRecord: (next: ProviderSessionRecord) => {
      record = next;
    },
  };
}

/** A script of every driver operation: the overrides, and otherwise failing provider work. */
function createDriver(overrides: RealtimeDriverScript = {}): ScriptedRealtimeDriver {
  const openAi = openAiDriverOver();
  return {
    normalizeEvent: overrides.normalizeEvent ?? openAi.normalizeEvent,
    normalizeRuntimeObservation:
      overrides.normalizeRuntimeObservation ?? openAi.normalizeRuntimeObservation,
    createCall:
      overrides.createCall ??
      vi.fn(async () =>
        providerFailure({
          stage: "call_creation",
          code: "provider_call_request_failed",
          retryable: false,
        }),
      ),
    connectSideband:
      overrides.connectSideband ??
      vi.fn(async () =>
        providerFailure({
          stage: "session_setup",
          code: "sideband_connect_failed",
          retryable: false,
        }),
      ),
    sendFinalizationOperation:
      overrides.sendFinalizationOperation ?? vi.fn(() => providerSuccess(undefined)),
    sendCommand: overrides.sendCommand ?? vi.fn(() => providerSuccess(undefined)),
    hangUp:
      overrides.hangUp ??
      vi.fn(async () => providerSuccess({ status: 200, upstreamRequestId: null })),
  };
}

function createEvents() {
  // Every diagnostic the kit records, whichever of its declarations it uses.
  const diagnostic = vi.fn<(type: string, payload: unknown) => void>();
  return {
    notifyControl: vi.fn(),
    recordStartup: vi.fn(),
    recordLiveDegradation: vi.fn(() => null),
    executionDiagnostics: () => diagnostic,
    diagnostic,
  } satisfies ProviderSessionEvents & Readonly<{ diagnostic: unknown }>;
}

function createSocketListeners() {
  const message: Array<(event: Record<string, unknown>) => void> = [];
  const close: Array<(event: Record<string, unknown>) => void> = [];
  const error: Array<(event: Record<string, unknown>) => void> = [];
  return {
    message,
    close,
    error,
  };
}

function createSocket(listeners: ReturnType<typeof createSocketListeners>) {
  return {
    readyState: 1,
    accept: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    removeEventListener: vi.fn(
      (type: keyof typeof listeners, listener: (event: Record<string, unknown>) => void) => {
        const index = listeners[type].indexOf(listener);
        if (index >= 0) listeners[type].splice(index, 1);
      },
    ),
    addEventListener: vi.fn(
      (type: keyof typeof listeners, listener: (event: Record<string, unknown>) => void) => {
        listeners[type].push(listener);
      },
    ),
  };
}
