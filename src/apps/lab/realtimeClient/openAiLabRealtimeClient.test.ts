// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenAiLabRealtimeClient,
  decodeLabStartupDisposition,
  decodeLabConversationState,
  decodeLabEndingEvent,
  decodeLabPlaybackEvent,
  type OpenAiLabRealtimeClientOptions,
} from "./openAiLabRealtimeClient";
import type { LabRunDetail } from "../data/labRunStore";
import type { LabRealtimeClientConfig } from "./labRealtimeClient";
import { RealtimeCallError, signalRealtimeCall } from "./realtimeSignaling";
import {
  goodbyeInterviewInstructions,
  goodbyeFinishDescription,
  defaultClosingSentence,
  defaultFinishInterviewDescription,
  nextQuestionDescription,
  questionPromptPresets,
} from "../content/presets";

const defaultRuntimeConfig: LabRealtimeClientConfig = {
  instructions: "Selected Lab prompt",
  maxDurationMs: 5 * 60 * 1000,
  reasoningEffort: "low",
};
const identity = { runId: "interview-1", startedAt: 1_700_000_000_000 };
class Track {
  enabled = true;
  readyState = "live";
  stop(): void {
    this.readyState = "ended";
  }
}
class Stream {
  readonly track = new Track();
  getAudioTracks(): Track[] {
    return [this.track];
  }
  getTracks(): Track[] {
    return [this.track];
  }
}
class Channel extends EventTarget {
  readyState = "connecting";
}
class Peer extends EventTarget {
  readonly channel = new Channel();
  readonly addTrack = vi.fn();
  readonly close = vi.fn();
  readonly createOffer = vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" }));
  readonly setLocalDescription = vi.fn(async () => undefined);
  readonly setRemoteDescription = vi.fn(async () => undefined);
  createDataChannel(): Channel {
    return this.channel;
  }
  ready(): void {
    const event = new Event("track");
    Object.defineProperty(event, "streams", { value: [new MediaStream()] });
    this.dispatchEvent(event);
    this.channel.readyState = "open";
    this.channel.dispatchEvent(new Event("open"));
  }
}
class Source extends EventTarget {
  readonly close = vi.fn();
  emit<Payload>(type: string, data?: Payload): void {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data ?? {}) }));
  }
}
function detail(
  outcome: "completed" | "failed_to_start" | "interrupted" = "completed",
): LabRunDetail {
  const base = {
    ...identity,
    transcriptTurnCount: 0,
    transcript: { turns: [] },
    responseUsage: [],
  };
  const usage = { completeness: "complete", observations: [] } as const;
  if (outcome === "failed_to_start")
    return {
      ...base,
      terminalResult: {
        runId: identity.runId,
        outcome,
        endedAt: identity.startedAt + 30_000,
        runtimeUsage: usage,
      },
    };
  const live = {
    runId: identity.runId,
    liveAt: identity.startedAt + 1000,
    endedAt: identity.startedAt + 30_000,
    transcriptSnapshot: { revision: 0, digest: `sha256:${"0".repeat(64)}`, turnCount: 0 },
    transcriptCompleteness: "complete",
    transcriptIncompleteReasons: [],
    runtimeUsage: usage,
  } as const;
  return {
    ...base,
    terminalResult:
      outcome === "completed"
        ? { ...live, outcome, reason: "participant_stopped" }
        : { ...live, outcome },
  };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred Promise was not initialized.");
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function harness() {
  vi.useFakeTimers();
  const stream = new Stream();
  const peer = new Peer();
  const source = new Source();
  const getUserMedia = vi.fn(async () => stream);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  vi.stubGlobal(
    "RTCPeerConnection",
    vi.fn(function () {
      return peer;
    }),
  );
  const signal = vi
    .fn<NonNullable<OpenAiLabRealtimeClientOptions["signalRealtimeCall"]>>()
    .mockResolvedValue({
      runIdentity: identity,
      answerSdp: "answer-sdp",
      sessionId: "rtc_provider_call",
      sessionLocation: null,
      upstreamRequestId: null,
    });
  const startup = vi
    .fn<NonNullable<OpenAiLabRealtimeClientOptions["readLabStartup"]>>()
    .mockResolvedValue({
      runId: identity.runId,
      disposition: "succeeded",
      decidedAt: identity.startedAt + 1,
      reason: "readiness_confirmed",
      stopRequired: false,
    });
  const outcome = vi
    .fn<NonNullable<OpenAiLabRealtimeClientOptions["readLabOutcome"]>>()
    .mockResolvedValue(null);
  const close = vi
    .fn<NonNullable<OpenAiLabRealtimeClientOptions["requestRuntimeClose"]>>()
    .mockResolvedValue({ ok: true, status: 200, debugText: "" });
  const presence = vi
    .fn<NonNullable<OpenAiLabRealtimeClientOptions["sendRuntimePresence"]>>()
    .mockResolvedValue({ ok: true, status: 200 });
  const mediaReady = vi
    .fn<NonNullable<OpenAiLabRealtimeClientOptions["sendRuntimeMediaReady"]>>()
    .mockResolvedValue(true);
  const options: OpenAiLabRealtimeClientOptions = {
    labWorkerUrl: "https://lab.test",
    signalRealtimeCall: signal,
    readLabStartup: startup,
    readLabOutcome: outcome,
    requestRuntimeClose: close,
    sendRuntimePresence: presence,
    sendRuntimeMediaReady: mediaReady,
    sidebandEventsFactory: () => source,
  };
  return {
    stream,
    peer,
    source,
    getUserMedia,
    signal,
    startup,
    outcome,
    close,
    presence,
    mediaReady,
    options,
    client: createOpenAiLabRealtimeClient(options),
  };
}
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("Lab application conversation adapter", () => {
  it("keeps Goodbye connected past interview expiry and immediately contains participant End", async () => {
    const h = harness();
    const session = await h.client.start({
      runtimeConfig: {
        ...defaultRuntimeConfig,
        instructions: goodbyeInterviewInstructions,
        finishInterviewDescription: goodbyeFinishDescription,
        closingSentence: defaultClosingSentence,
        selection: {
          conversation: { id: "goodbye-interview", version: 1 },
          execution: { id: "realtime", version: 1 },
        },
        maxDurationMs: 1000,
      },
    });
    h.peer.ready();
    await vi.advanceTimersByTimeAsync(2000);
    expect(session.getStatus().phase).toBe("live");
    expect(h.stream.track.readyState).toBe("live");
    expect(h.peer.close).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    h.source.emit("runtime.conversation_state", {
      state: "goodbye",
      deadlineAt: Date.now() + 45_000,
    });
    expect(h.stream.track.readyState).toBe("ended");
    expect(session.getStatus().phase).toBe("live");
    expect(h.peer.close).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    h.source.emit("session.provider_event", { type: "output_audio_buffer.stopped" });
    expect(h.stream.track.enabled).toBe(false);
    expect(h.stream.track.readyState).toBe("ended");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.presence.mock.lastCall?.[0].mediaPresent).toBe(true);
    h.peer.channel.readyState = "closed";
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.presence.mock.lastCall?.[0].mediaPresent).toBe(false);
    const ending = session.complete("participant_stopped");
    expect(h.stream.track.readyState).toBe("ended");
    expect(h.close.mock.calls[0]?.[0]).toMatchObject({
      runId: identity.runId,
      endReason: "participant_stopped",
    });
    h.outcome.mockResolvedValue(detail());
    await vi.advanceTimersByTimeAsync(500);
    await ending;
  });
  it("rejects missing Goodbye input before requesting microphone or signaling", async () => {
    const h = harness();
    await expect(
      h.client.start({
        runtimeConfig: {
          ...defaultRuntimeConfig,
          selection: {
            conversation: { id: "goodbye-interview", version: 1 },
            execution: { id: "realtime", version: 1 },
          },
        },
      }),
    ).rejects.toThrow("missing_goodbye_input");
    expect(h.getUserMedia).not.toHaveBeenCalled();
    expect(h.signal).not.toHaveBeenCalled();
  });
  it.each([
    ["Original with blank instructions", { instructions: " " }, "blank_raw_instructions"],
    [
      "Original with a blank finish_interview description",
      { finishInterviewDescription: " " },
      "blank_finish_interview_description",
    ],
    [
      "Questions without question prompts",
      {
        selection: {
          conversation: { id: "questions-interview", version: 1 },
          execution: { id: "realtime", version: 1 },
        },
        nextQuestionDescription: "Request the next question.",
        finishInterviewDescription: "Finish the interview.",
        closingSentence: "Thank you. Goodbye.",
      },
      "missing_questions_input",
    ],
  ])("rejects %s before requesting microphone or signaling", async (_case, change, code) => {
    const h = harness();
    await expect(
      h.client.start({ runtimeConfig: { ...defaultRuntimeConfig, ...change } }),
    ).rejects.toThrow(code);
    expect(h.getUserMedia).not.toHaveBeenCalled();
    expect(h.signal).not.toHaveBeenCalled();
  });
  const goodbyeConfig: LabRealtimeClientConfig = {
    ...defaultRuntimeConfig,
    instructions: `  ${goodbyeInterviewInstructions}  `,
    finishInterviewDescription: `  ${goodbyeFinishDescription}  `,
    closingSentence: `  ${defaultClosingSentence}  `,
    selection: {
      conversation: { id: "goodbye-interview", version: 1 },
      execution: { id: "realtime", version: 1 },
    },
  };
  const questionsConfig: LabRealtimeClientConfig = {
    ...defaultRuntimeConfig,
    instructions: questionPromptPresets[0] ?? "",
    questionPrompts: questionPromptPresets,
    nextQuestionDescription,
    finishInterviewDescription: goodbyeFinishDescription,
    closingSentence: defaultClosingSentence,
    maximumClosingDurationMs: 30_000,
    selection: {
      conversation: { id: "questions-interview", version: 1 },
      execution: { id: "realtime", version: 1 },
    },
  };
  it.each([
    [
      "Original",
      defaultRuntimeConfig,
      {
        contract: "original-interview-input/v1",
        interviewingDurationMs: 300_000,
        interviewing: {
          instructions: { kind: "literal", text: "Selected Lab prompt" },
          toolDescriptions: { finish_interview: defaultFinishInterviewDescription },
        },
      },
    ],
    [
      "Goodbye",
      goodbyeConfig,
      {
        contract: "goodbye-interview-input/v1",
        interviewingDurationMs: 300_000,
        maximumClosingDurationMs: 45_000,
        interviewing: {
          instructions: { kind: "literal", text: `  ${goodbyeInterviewInstructions}  ` },
          toolDescriptions: { finish_interview: `  ${goodbyeFinishDescription}  ` },
        },
        goodbye: { closingSentence: `  ${defaultClosingSentence}  ` },
      },
    ],
    [
      "Questions",
      questionsConfig,
      {
        contract: "questions-interview-input/v1",
        interviewingDurationMs: 300_000,
        maximumClosingDurationMs: 30_000,
        questions: questionPromptPresets.map((text) => ({
          instructions: { kind: "literal", text },
          toolDescriptions: {
            next_question: nextQuestionDescription,
            finish_interview: goodbyeFinishDescription,
          },
        })),
        goodbye: { closingSentence: defaultClosingSentence },
      },
    ],
  ])("starts %s with its Conversation's interview input", async (_, config, agentInput) => {
    const h = harness();
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : ""));
      return Response.json({ error: "invalid_run_start_request" }, { status: 400 });
    });
    const client = createOpenAiLabRealtimeClient({
      ...h.options,
      signalRealtimeCall: (input) => signalRealtimeCall({ ...input, fetchImpl }),
    });
    await expect(client.start({ runtimeConfig: config })).rejects.toThrow(RealtimeCallError);
    expect(bodies).toEqual([
      expect.objectContaining({
        selection: config.selection ?? {
          conversation: { id: "original-interview", version: 1 },
          execution: { id: "realtime", version: 1 },
        },
        agentInput,
      }),
    ]);
  });
  // Runtime's event stream outlasts interviewing, then the Conversation's closing or finishing.
  it.each([
    ["Original", defaultRuntimeConfig, 300_000 + 25_000 + 10_000],
    ["Goodbye", goodbyeConfig, 300_000 + 25_000 + 45_000],
    ["Questions", questionsConfig, 300_000 + 25_000 + 30_000],
  ])(
    "waits for %s's Runtime events as long as its closing allows",
    async (_, config, durationMs) => {
      const h = harness();
      const urls: string[] = [];
      const client = createOpenAiLabRealtimeClient({
        ...h.options,
        sidebandEventsFactory: (url) => {
          urls.push(url);
          return h.source;
        },
      });
      const session = await client.start({ runtimeConfig: config });
      expect(urls.map((url) => new URL(url).searchParams.get("durationMs"))).toEqual([
        String(durationMs),
      ]);
      await session.cancel();
    },
  );
  it("does not apply a Goodbye microphone fence to an Original session", async () => {
    const h = harness();
    const session = await h.client.start({ runtimeConfig: defaultRuntimeConfig });
    h.peer.ready();
    h.source.emit("sideband.goodbye_started");
    expect(h.stream.track.readyState).toBe("live");
    expect(h.peer.close).not.toHaveBeenCalled();
    await session.cancel();
  });
  it("owns ending strategy and provider event names while rejecting malformed or inherited facts", () => {
    expect(
      decodeLabEndingEvent({
        endReason: "agent_requested_end",
        strategy: "graceful_agent_completion",
        extra: true,
      }),
    ).toEqual({ endReason: "agent_requested_end", strategy: "graceful_agent_completion" });
    for (const value of [
      {},
      { endReason: 42 },
      { endReason: "agent_requested_end", strategy: "play_forever" },
      Object.create({ endReason: "agent_requested_end" }),
    ])
      expect(() => decodeLabEndingEvent(value)).toThrow();
    expect(decodeLabPlaybackEvent({ type: "response.done", extra: { provider: true } })).toEqual({
      ok: true,
      value: "response.done",
    });
    for (const value of [{ type: 42 }, {}, Object.create({ type: "response.done" })])
      expect(decodeLabPlaybackEvent(value)).toEqual({
        ok: false,
        error: { code: "unrecognized_playback_event" },
      });
  });
  it("owns only the app verdict fields and rejects invalid consumer facts", () => {
    const verdict = {
      runId: "lab_run",
      disposition: "pending",
      decidedAt: null,
      reason: null,
      stopRequired: false,
    } as const;
    expect(decodeLabStartupDisposition(verdict)).toEqual(verdict);
    for (const invalid of [
      { ...verdict, runId: 42 },
      { ...verdict, disposition: "live" },
      { ...verdict, decidedAt: "later" },
      { ...verdict, reason: 42 },
      { ...verdict, stopRequired: "yes" },
      { ...verdict, extra: true },
    ])
      expect(() => decodeLabStartupDisposition(invalid)).toThrow();
    for (const key of Object.keys(verdict)) {
      const own = Object.fromEntries(Object.entries(verdict).filter(([field]) => field !== key));
      expect(() => decodeLabStartupDisposition(own)).toThrow();
      expect(() =>
        decodeLabStartupDisposition(Object.assign(Object.create(verdict), own)),
      ).toThrow();
    }
  });
  it("keeps setup through native readiness and control-sent until the authoritative same-run verdict", async () => {
    const h = harness();
    const verdict = deferred<ReturnType<typeof decodeLabStartupDisposition>>();
    h.startup.mockReturnValue(verdict.promise);
    const session = await h.client.start({ runtimeConfig: defaultRuntimeConfig });
    h.peer.ready();
    h.source.emit("session.control_sent");
    expect(session.getStatus().phase).toBe("setup");
    expect(h.stream.track.enabled).toBe(false);
    verdict.resolve({
      runId: identity.runId,
      disposition: "succeeded",
      decidedAt: identity.startedAt + 1,
      reason: "readiness_confirmed",
      stopRequired: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getStatus().phase).toBe("live");
    expect(h.stream.track.enabled).toBe(false);
    h.source.emit("session.provider_event", { type: "output_audio_buffer.stopped" });
    expect(h.stream.track.enabled).toBe(true);
    expect(h.mediaReady.mock.calls[0]?.[0]).toMatchObject({
      endpointBaseUrl: "https://lab.test",
      runId: identity.runId,
    });
    expect(h.presence.mock.calls[0]?.[0]).toMatchObject({
      endpointBaseUrl: "https://lab.test",
      runId: identity.runId,
      mediaPresent: true,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.presence).toHaveBeenCalledTimes(2);
    await session.cancel();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.presence).toHaveBeenCalledTimes(2);
  });
  it("rejects an invalid duration before microphone acquisition or Start transport", async () => {
    const h = harness();
    await expect(
      h.client.start({ runtimeConfig: { ...defaultRuntimeConfig, maxDurationMs: 0 } }),
    ).rejects.toThrow("invalid_lab_duration");
    expect(h.getUserMedia).not.toHaveBeenCalled();
    expect(h.signal).not.toHaveBeenCalled();
    expect(h.outcome).not.toHaveBeenCalled();
  });

  it("projects incomplete canonical evidence as a transcript warning while retaining terminal identity", async () => {
    const h = harness();
    const session = await h.client.start({ runtimeConfig: defaultRuntimeConfig });
    const terminalDetail = detail();
    if (terminalDetail.terminalResult?.outcome !== "completed")
      throw new Error("Expected completed fixture");
    h.outcome.mockResolvedValue({
      ...terminalDetail,
      terminalResult: {
        ...terminalDetail.terminalResult,
        transcriptCompleteness: "incomplete",
        transcriptIncompleteReasons: [{ kind: "conversation_evidence_gap" }],
      },
    });
    await vi.advanceTimersByTimeAsync(500);
    const result = await session.complete("participant_stopped");
    expect(result).toMatchObject({
      runId: identity.runId,
      endedAt: identity.startedAt + 30_000,
      endStatus: "endedWithWarning",
      terminalResult: { transcriptCompleteness: "incomplete" },
      transcriptEvidence: { warning: { reviewStatus: "warning" } },
    });
    expect(session.getStatus()).toMatchObject({ phase: "ended", endStatus: "endedWithWarning" });
  });

  it("retains the original startup deadline when application success precedes native readiness", async () => {
    const h = harness();
    const session = await h.client.start({ runtimeConfig: defaultRuntimeConfig });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(h.peer.close).toHaveBeenCalledOnce();
    expect(session.getStatus().phase).toBe("ending");
    expect(h.outcome.mock.calls.at(-1)?.[0].runId).toBe(identity.runId);
    h.peer.ready();
    expect(h.stream.track.readyState).toBe("ended");
    expect(session.getStatus().phase).toBe("ending");
  });
  it("preserves input, offer, exchange and deadline through an eligible retry", async () => {
    const h = harness();
    h.signal.mockRejectedValueOnce(new TypeError("network interrupted"));
    const start = h.client.start({
      runtimeConfig: {
        instructions: "Selected Lab prompt",
        maxDurationMs: 480_000,
        reasoningEffort: "high",
        realtimeSettings: {
          model: "gpt-realtime-2.1",
          voice: "alloy",
          speed: 1.1,
          inputNoiseReduction: "off",
          semanticVadEagerness: "low",
          maxOutputTokens: "inf",
          truncation: "disabled",
        },
      },
    });
    await vi.advanceTimersByTimeAsync(500);
    const session = await start;
    expect(h.signal.mock.calls[0]?.[0]).toEqual(h.signal.mock.calls[1]?.[0]);
    expect(h.signal.mock.calls[1]?.[0]).toMatchObject({
      offerSdp: "offer-sdp",
      agentInput: {
        contract: "original-interview-input/v1",
        interviewingDurationMs: 480_000,
        interviewing: { instructions: { kind: "literal", text: "Selected Lab prompt" } },
      },
      reasoningEffort: "high",
      promptProvenance: null,
      executionSettings: {
        model: "gpt-realtime-2.1",
        voice: "alloy",
        speed: 1.1,
        inputNoiseReduction: "off",
        semanticVadEagerness: "low",
        maxOutputTokens: "inf",
        truncation: "disabled",
      },
    });
    expect(h.peer.createOffer).toHaveBeenCalledOnce();
    expect(session.handle).toEqual(identity);
  });
  it("releases pending microphone setup immediately and rejects a late allocation-free setup", async () => {
    const h = harness();
    const microphone = deferred<Stream>();
    h.getUserMedia.mockReturnValue(microphone.promise);
    const controller = new AbortController();
    const start = h.client.start({
      runtimeConfig: defaultRuntimeConfig,
      signal: controller.signal,
    });
    const rejection = expect(start).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    microphone.resolve(h.stream);
    await rejection;
    expect(h.stream.track.readyState).toBe("ended");
    expect(h.signal).not.toHaveBeenCalled();
    expect(document.querySelector("audio")).toBeNull();
  });
  it("does not apply a late answer after disposal and recovers the same experiment independently", async () => {
    const h = harness();
    const reply =
      deferred<
        Awaited<ReturnType<NonNullable<OpenAiLabRealtimeClientOptions["signalRealtimeCall"]>>>
      >();
    h.signal.mockImplementation((options) => {
      options.onRunAllocated?.(identity);
      return reply.promise;
    });
    const controller = new AbortController();
    const start = h.client.start({
      runtimeConfig: defaultRuntimeConfig,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    reply.resolve({
      runIdentity: identity,
      answerSdp: "answer-sdp",
      sessionId: "rtc_provider_call",
      sessionLocation: null,
      upstreamRequestId: null,
    });
    const session = await start;
    expect(h.peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(h.stream.track.readyState).toBe("ended");
    h.outcome.mockResolvedValue(detail("failed_to_start"));
    await vi.advanceTimersByTimeAsync(500);
    expect(session.getStatus()).toMatchObject({ phase: "failed", failureKind: "setup" });
    expect((await session.complete("participant_stopped")).terminalResult).toMatchObject({
      runId: identity.runId,
      outcome: "failed_to_start",
      endedAt: identity.startedAt + 30_000,
    });
    expect(h.signal).toHaveBeenCalledOnce();
  });
  it.each(["failed_to_start", "interrupted"] as const)(
    "exposes %s from stored facts after application startup fails",
    async (outcome) => {
      const h = harness();
      h.startup.mockResolvedValue({
        runId: identity.runId,
        disposition: "failed",
        decidedAt: identity.startedAt + 1,
        reason: "runtime_failed",
        stopRequired: true,
      });
      const session = await h.client.start({ runtimeConfig: defaultRuntimeConfig });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.stream.track.readyState).toBe("ended");
      expect(session.getStatus().phase).toBe("ending");
      h.outcome.mockResolvedValue(detail(outcome));
      await vi.advanceTimersByTimeAsync(500);
      const result = await session.complete("participant_stopped");
      expect(result.terminalResult).toMatchObject({
        outcome,
        runId: identity.runId,
        endedAt: identity.startedAt + 30_000,
      });
      if (outcome === "interrupted")
        expect(result.terminalResult).toHaveProperty("liveAt", identity.startedAt + 1000);
    },
  );
  it("contains participant media during graceful ending without claiming local cleanup is a result", async () => {
    const h = harness();
    const session = await h.client.start({ runtimeConfig: defaultRuntimeConfig });
    h.peer.ready();
    await vi.advanceTimersByTimeAsync(0);
    h.source.emit("runtime.ending", {
      endReason: "agent_requested_end",
      strategy: "graceful_agent_completion",
    });
    expect(h.stream.track.readyState).toBe("ended");
    expect(document.querySelector("audio")).toBeNull();
    const end = session.complete("participant_stopped");
    const repeated = session.complete("participant_stopped");
    expect(document.querySelector("audio")).toBeNull();
    expect(h.close).not.toHaveBeenCalled();
    let settled = false;
    void end.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(settled).toBe(false);
    expect(session.getStatus().phase).toBe("ending");
    expect(h.peer.close).toHaveBeenCalledOnce();
    h.outcome.mockResolvedValue(detail());
    await vi.advanceTimersByTimeAsync(500);
    expect(await repeated).toEqual(await end);
    expect((await end).endedAt).toBe(identity.startedAt + 30_000);
    expect(session.getStatus().phase).toBe("ended");
  });
  it("cancel releases participation while same-attempt terminal recovery survives", async () => {
    const h = harness();
    const session = await h.client.start({ runtimeConfig: defaultRuntimeConfig });
    h.peer.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(await session.cancel()).toBeUndefined();
    expect(h.source.close).toHaveBeenCalledOnce();
    expect(h.stream.track.readyState).toBe("ended");
    expect(session.getStatus().phase).toBe("ending");
    h.outcome.mockResolvedValue(detail("interrupted"));
    await vi.advanceTimersByTimeAsync(500);
    expect((await session.complete("participant_stopped")).terminalResult?.outcome).toBe(
      "interrupted",
    );
  });
  it("keeps wrong-run verdicts and outcomes from authorizing live or completion, and bounds recovery", async () => {
    const h = harness();
    h.startup.mockResolvedValue({
      runId: "another-run",
      disposition: "succeeded",
      decidedAt: identity.startedAt + 1,
      reason: "readiness_confirmed",
      stopRequired: false,
    });
    h.outcome.mockResolvedValue({ ...detail(), runId: "another-run" });
    const session = await h.client.start({
      runtimeConfig: { ...defaultRuntimeConfig, maxDurationMs: 1000 },
    });
    h.peer.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getStatus().phase).toBe("setup");
    const end = session.complete("participant_stopped");
    const rejection = expect(end).rejects.toThrow("lab_outcome_unresolved");
    await vi.advanceTimersByTimeAsync(71_000);
    await rejection;
    expect(session.getStatus()).toMatchObject({ phase: "failed", failureKind: "runtime" });
  });
  it("retains allocation on signaling errors and reads the durable failed start", async () => {
    const h = harness();
    h.signal.mockRejectedValue(
      new RealtimeCallError("Realtime call creation failed.", { runIdentity: identity }),
    );
    const session = await h.client.start({ runtimeConfig: defaultRuntimeConfig });
    expect(session.handle).toEqual(identity);
    expect(h.stream.track.readyState).toBe("ended");
    h.outcome.mockResolvedValue(detail("failed_to_start"));
    await vi.advanceTimersByTimeAsync(500);
    expect(session.getStatus()).toMatchObject({ phase: "failed", failureKind: "setup" });
  });
  it("does not invent a pending experiment after a definitive pre-allocation refusal", async () => {
    const h = harness();
    h.signal.mockRejectedValue(
      new RealtimeCallError("invalid request", { code: "invalid_run_start_request" }),
    );
    await expect(h.client.start({ runtimeConfig: defaultRuntimeConfig })).rejects.toThrow(
      "invalid request",
    );
    expect(h.outcome).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    expect(h.stream.track.readyState).toBe("ended");
  });
  it("keeps participation finished while terminal evidence settles independently", async () => {
    const h = harness();
    const session = await h.client.start({ runtimeConfig: defaultRuntimeConfig });
    h.peer.ready();
    await vi.advanceTimersByTimeAsync(0);
    h.source.emit("runtime.ending", {
      endReason: "agent_requested_end",
      strategy: "graceful_agent_completion",
    });
    h.outcome.mockResolvedValue(detail());
    await vi.advanceTimersByTimeAsync(500);
    expect(session.getStatus().phase).toBe("ended");
    expect(document.querySelector("audio")).toBeNull();
    h.source.emit("session.provider_event", { type: "response.done" });
    expect(session.getStatus().phase).toBe("ended");
    expect(document.querySelector("audio")).toBeNull();
    expect((await session.complete("participant_stopped")).endedAt).toBe(
      identity.startedAt + 30_000,
    );
    expect(h.close).not.toHaveBeenCalled();
  });
  // Starting the next Run aborts the previous participation and cancels it.
  it.each([
    { seen: "live", stops: ["participant_disconnected"] },
    { seen: "ended", stops: [] },
  ])(
    "sends Stop only for a Run it has not seen end when the page leaves it ($seen)",
    async ({ seen, stops }) => {
      const h = harness();
      const page = new AbortController();
      const session = await h.client.start({
        runtimeConfig: defaultRuntimeConfig,
        signal: page.signal,
      });
      h.peer.ready();
      await vi.advanceTimersByTimeAsync(0);
      if (seen === "ended") h.outcome.mockResolvedValue(detail());
      await vi.advanceTimersByTimeAsync(500);
      expect(session.getStatus().phase).toBe(seen);
      page.abort();
      await session.cancel("Lab view replaced.");
      await vi.advanceTimersByTimeAsync(0);
      expect(h.close.mock.calls.map(([request]) => request.endReason)).toEqual(stops);
    },
  );
  it.each(["participant Stop", "Runtime Ending"] as const)(
    "keeps the provider call and Runtime events open through Ending after %s until the terminal result",
    async (entry) => {
      const h = harness();
      const session = await h.client.start({ runtimeConfig: defaultRuntimeConfig });
      h.peer.ready();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.getStatus().phase).toBe("live");
      if (entry === "participant Stop") void session.complete("participant_stopped");
      else h.source.emit("runtime.ending", { endReason: "agent_requested_end" });
      expect(session.getStatus().phase).toBe("ending");
      expect(h.stream.track.readyState).toBe("ended");
      expect(document.querySelector("audio")).toBeNull();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.peer.close).not.toHaveBeenCalled();
      expect(h.source.close).not.toHaveBeenCalled();
      h.source.emit("runtime.controller_completed");
      h.outcome.mockResolvedValue(detail());
      await vi.advanceTimersByTimeAsync(500);
      expect(session.getStatus().phase).toBe("ended");
      expect(h.peer.close).toHaveBeenCalledOnce();
      expect(h.source.close).toHaveBeenCalledOnce();
    },
  );
  it.each(["delivers the Run's completion event", "ends", "stays silent for 2 s"] as const)(
    "keeps queued Runtime events flowing after a polled terminal result until the stream %s",
    async (release) => {
      const h = harness();
      const session = await h.client.start({
        runtimeConfig: {
          ...defaultRuntimeConfig,
          instructions: goodbyeInterviewInstructions,
          finishInterviewDescription: goodbyeFinishDescription,
          closingSentence: defaultClosingSentence,
          selection: {
            conversation: { id: "goodbye-interview", version: 1 },
            execution: { id: "realtime", version: 1 },
          },
        },
      });
      h.peer.ready();
      await vi.advanceTimersByTimeAsync(0);
      h.source.emit("runtime.conversation_state", { state: "goodbye", deadlineAt: null });
      h.source.emit("session.provider_event", { type: "output_audio_buffer.started" });
      // Runtime has finished, but the stream still holds Goodbye's stop and Ending behind a backlog.
      h.outcome.mockResolvedValue(detail());
      await vi.advanceTimersByTimeAsync(500);
      expect(session.getStatus()).toMatchObject({ phase: "ended", label: "Thank you" });
      const finishedStatus = session.getStatus();
      expect(h.peer.close).toHaveBeenCalledOnce();
      expect(h.stream.track.readyState).toBe("ended");
      expect(document.querySelector("audio")).toBeNull();
      expect(h.source.close).not.toHaveBeenCalled();
      h.source.emit("session.provider_event", { type: "output_audio_buffer.stopped" });
      h.source.emit("runtime.ending", { endReason: "timebox_reached" });
      h.source.emit("runtime.conversation_state", { state: "complete", deadlineAt: null });
      expect(session.getStatus()).toBe(finishedStatus);
      expect(document.querySelector("audio")).toBeNull();
      expect(h.source.close).not.toHaveBeenCalled();
      if (release === "delivers the Run's completion event")
        h.source.emit("runtime.controller_completed");
      else if (release === "ends") h.source.dispatchEvent(new Event("error"));
      else await vi.advanceTimersByTimeAsync(2_000);
      expect(h.source.close).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.source.close).toHaveBeenCalledOnce();
      expect(session.getStatus()).toBe(finishedStatus);
    },
  );
});

it("owns concrete accepted Conversation state and optional countdown at the Runtime ingress", async () => {
  const accepted = { state: "interviewing", deadlineAt: 42 };
  expect(decodeLabConversationState({ ...accepted, providerExtra: true })).toEqual(accepted);
  expect(
    decodeLabConversationState(Object.assign(Object.create({ inheritedExtra: true }), accepted)),
  ).toEqual(accepted);
  expect(decodeLabConversationState({ state: "untimed", deadlineAt: null })).toEqual({
    state: "untimed",
    deadlineAt: null,
  });
  for (const malformed of [
    null,
    {},
    { state: "interviewing" },
    { deadlineAt: 42 },
    { ...accepted, state: 42 },
    { ...accepted, state: "" },
    { ...accepted, deadlineAt: "42" },
    { ...accepted, deadlineAt: -1 },
    { ...accepted, deadlineAt: 1.5 },
    { ...accepted, deadlineAt: Number.MAX_SAFE_INTEGER + 1 },
  ])
    expect(() => decodeLabConversationState(malformed)).toThrow();
  for (const field of ["state", "deadlineAt"] as const) {
    const own = { ...accepted };
    Reflect.deleteProperty(own, field);
    expect(() =>
      decodeLabConversationState(Object.assign(Object.create({ [field]: accepted[field] }), own)),
    ).toThrow();
  }
});
