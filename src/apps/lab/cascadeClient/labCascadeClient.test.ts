// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CascadeMediaServerMessage } from "../../../../worker/shared/contracts/cascadeMedia.ts";
import { questionPromptPresets } from "../content/presets";
import type { LabRunDetail } from "../data/labRunStore";
import type { LabInterviewConfig } from "../interviewClient";
import { createLabCascadeClient } from "./labCascadeClient";

class Track {
  enabled = true;
  readyState = "live";
  stop(): void {
    this.readyState = "ended";
  }
}

const runtimeConfig = {
  instructions: "Say Welcome.",
  finishInterviewDescription: "Call this tool when done.",
  selection: {
    conversation: { id: "original-interview", version: 1 },
    execution: { id: "cascade", version: 1 },
  },
  maxDurationMs: 60_000,
  reasoningEffort: "low",
} as const;

function microphone() {
  const track = new Track();
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });
  return track;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("releases its disabled microphone when Lab refuses the Start before a Run exists", async () => {
  const track = microphone();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ error: "conversation_selection_unavailable" }, { status: 409 }),
    ),
  );
  const client = createLabCascadeClient({ labWorkerUrl: "https://lab.test" });
  await expect(client.start({ runtimeConfig })).rejects.toThrow("cascade_start_failed:409");
  expect(track).toMatchObject({ enabled: false, readyState: "ended" });
});

it.each([
  ["Original with blank instructions", { instructions: "  " }, "blank_raw_instructions"],
  [
    "Original with a blank finish_interview description",
    { finishInterviewDescription: " " },
    "blank_finish_interview_description",
  ],
  [
    "Goodbye without its closing sentence",
    {
      selection: {
        ...runtimeConfig.selection,
        conversation: { id: "goodbye-interview", version: 1 },
      },
    },
    "missing_goodbye_input",
  ],
  [
    "Questions without question prompts",
    {
      selection: {
        ...runtimeConfig.selection,
        conversation: { id: "questions-interview", version: 1 },
      },
      nextQuestionDescription: "Request the next question.",
      closingSentence: "Thank you. Goodbye.",
    },
    "missing_questions_input",
  ],
])(
  "refuses %s before requesting the microphone or sending a Start",
  async (_case, change, code) => {
    microphone();
    const fetchImpl = vi.fn(async () => Response.json({}, { status: 500 }));
    const client = createLabCascadeClient({ labWorkerUrl: "https://lab.test", fetchImpl });
    await expect(client.start({ runtimeConfig: { ...runtimeConfig, ...change } })).rejects.toThrow(
      code,
    );
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  },
);

const goodbyeConfig = {
  ...runtimeConfig,
  selection: { ...runtimeConfig.selection, conversation: { id: "goodbye-interview", version: 1 } },
  closingSentence: "Thank you. Goodbye.",
} as const;
const questionsConfig = {
  ...runtimeConfig,
  selection: {
    ...runtimeConfig.selection,
    conversation: { id: "questions-interview", version: 1 },
  },
  questionPrompts: questionPromptPresets,
  nextQuestionDescription: "Request the next question.",
  closingSentence: "Thank you. Goodbye.",
  maximumClosingDurationMs: 30_000,
} as const;

it.each([
  [
    "Original",
    runtimeConfig,
    {
      contract: "original-interview-input/v1",
      interviewingDurationMs: 60_000,
      interviewing: {
        instructions: { kind: "literal", text: "Say Welcome." },
        toolDescriptions: { finish_interview: "Call this tool when done." },
      },
    },
  ],
  [
    "Goodbye",
    goodbyeConfig,
    {
      contract: "goodbye-interview-input/v1",
      interviewingDurationMs: 60_000,
      maximumClosingDurationMs: 45_000,
      interviewing: {
        instructions: { kind: "literal", text: "Say Welcome." },
        toolDescriptions: { finish_interview: "Call this tool when done." },
      },
      goodbye: { closingSentence: "Thank you. Goodbye." },
    },
  ],
  [
    "Questions",
    questionsConfig,
    {
      contract: "questions-interview-input/v1",
      interviewingDurationMs: 60_000,
      maximumClosingDurationMs: 30_000,
      questions: questionPromptPresets.map((text) => ({
        instructions: { kind: "literal", text },
        toolDescriptions: {
          next_question: "Request the next question.",
          finish_interview: "Call this tool when done.",
        },
      })),
      goodbye: { closingSentence: "Thank you. Goodbye." },
    },
  ],
])("starts %s with its Conversation's interview input", async (_, config, agentInput) => {
  microphone();
  const bodies: unknown[] = [];
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ error: "invalid_run_start_request" }, { status: 400 });
  });
  const client = createLabCascadeClient({ labWorkerUrl: "https://lab.test", fetchImpl });
  await expect(client.start({ runtimeConfig: config })).rejects.toThrow("cascade_start_failed:400");
  expect(bodies).toEqual([expect.objectContaining({ selection: config.selection, agentInput })]);
});

it.each([
  ["the chosen settings", { speechOutput: { provider: "soniox", voice: "Nina" } }],
  ["no settings with today's providers", undefined],
])("sends %s as the Start's execution settings", async (_, cascadeSettings) => {
  microphone();
  const bodies: unknown[] = [];
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ error: "invalid_run_start_request" }, { status: 400 });
  });
  const client = createLabCascadeClient({ labWorkerUrl: "https://lab.test", fetchImpl });
  await expect(
    client.start({ runtimeConfig: { ...runtimeConfig, cascadeSettings } }),
  ).rejects.toThrow("cascade_start_failed:400");
  const [body] = z.array(z.record(z.string(), z.unknown())).parse(bodies);
  expect(body?.executionSettings).toEqual(cascadeSettings);
  expect(body !== undefined && "executionSettings" in body).toBe(cascadeSettings !== undefined);
});

it("rejects with the missing credential when Lab refuses the Start before a Run exists", async () => {
  microphone();
  const fetchImpl = vi.fn(async () =>
    Response.json({ error: "missing_credentials:GRADIUM_API_KEY" }, { status: 503 }),
  );
  const client = createLabCascadeClient({ labWorkerUrl: "https://lab.test", fetchImpl });
  await expect(client.start({ runtimeConfig })).rejects.toThrow(
    "missing_credentials:GRADIUM_API_KEY",
  );
});

it("names the missing credential in the failed outcome of a Run whose Start Runtime refused", async () => {
  microphone();
  let runId = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === "/_api/runtime/runs") {
        const { attemptId } = z
          .object({ attemptId: z.string() })
          .parse(JSON.parse(String(init?.body)));
        runId = `lab_${attemptId}`;
        return Response.json(
          { error: "missing_credentials:CEREBRAS_API_KEY" },
          {
            status: 503,
            headers: {
              "X-Lab-Run-Id": runId,
              "X-Lab-Run-Started-At": "1700000000000",
            },
          },
        );
      }
      if (path.endsWith("/complete")) return Response.json({ accepted: true }, { status: 202 });
      if (path === `/_api/runs/${runId}`)
        return Response.json({
          runId,
          startedAt: 1_700_000_000_000,
          transcriptTurnCount: 0,
          transcript: { turns: [] },
          terminalResult: {
            runId,
            outcome: "failed_to_start",
            endedAt: 1_700_000_000_500,
            runtimeUsage: { completeness: "complete", observations: [] },
          },
        });
      return Response.json({ error: "lab_run_not_found" }, { status: 404 });
    }),
  );
  const client = createLabCascadeClient({ labWorkerUrl: "https://lab.test" });
  const session = await client.start({ runtimeConfig });
  await vi.waitFor(() => expect(session.getStatus().phase).toBe("failed"));
  expect(session.getStatus()).toMatchObject({
    failureKind: "setup",
    startRefusal: "missing_credentials:CEREBRAS_API_KEY",
  });
});

// Runtime's event stream outlasts interviewing, then the Conversation's closing or finishing.
it.each([
  ["Original", runtimeConfig, 60_000 + 25_000 + 10_000],
  ["Goodbye", goodbyeConfig, 60_000 + 25_000 + 45_000],
  ["Questions", questionsConfig, 60_000 + 25_000 + 30_000],
])("waits for %s's Runtime events as long as its closing allows", async (_, config, durationMs) => {
  const { eventUrls } = await liveCascade({ config });
  expect(eventUrls.map((url) => new URL(url).searchParams.get("durationMs"))).toEqual([
    String(durationMs),
  ]);
});

it("ends an allocated Run whose Start reply it cannot play, and releases its microphone", async () => {
  vi.useFakeTimers();
  const track = microphone();
  const closes: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === "/_api/runtime/runs") {
        const attemptId = z
          .object({ attemptId: z.string() })
          .parse(JSON.parse(String(init?.body))).attemptId;
        return Response.json(
          { runId: `lab_${attemptId}`, exchangeId: "other", acceptance: "accepted", reply: {} },
          {
            headers: {
              "X-Lab-Run-Id": `lab_${attemptId}`,
              "X-Lab-Run-Started-At": "1700000000000",
            },
          },
        );
      }
      if (path.endsWith("/complete")) {
        closes.push(JSON.parse(String(init?.body)));
        return Response.json({ accepted: true }, { status: 202 });
      }
      return Response.json({ error: "lab_run_not_found" }, { status: 404 });
    }),
  );
  const statuses: string[] = [];
  const client = createLabCascadeClient({ labWorkerUrl: "https://lab.test" });
  const session = await client.start({
    runtimeConfig,
    onStatus: (status) => statuses.push(status.label),
  });
  expect(session.handle.runId).toMatch(/^lab_/);
  expect(track.readyState).toBe("ended");
  expect(statuses.at(-1)).toBe("Resolving Interview");
  await vi.waitFor(() => expect(closes).toEqual([{ endReason: "runtime_failed" }]));
});

/** One scheduled chunk of interviewer audio; `stop` and the end of its playback both end it. */
class Chunk extends EventTarget {
  stopped = false;
  connect(): void {}
  start(): void {}
  stop(): void {
    this.stopped = true;
    this.dispatchEvent(new Event("ended"));
  }
  playToEnd(): void {
    this.dispatchEvent(new Event("ended"));
  }
}

/** The Run's media attachment, as the page sees it. */
class MediaSocket extends EventTarget {
  closed = false;
  send(): void {}
  close(): void {
    this.closed = true;
  }
}

/** The Runtime events Lab forwards: an accepted Conversation state, or Ending. */
type RuntimeEventPayload =
  | Readonly<{ state: string; deadlineAt: number | null }>
  | Readonly<{ endReason: string; strategy: "hard_stop" }>;

/**
 * A live Cascade participation whose media, Runtime events and audio output the test drives.
 * Runtime answers its Stop with `stopStatus`.
 */
async function liveCascade({
  stopStatus = 202,
  config = runtimeConfig,
  signal,
}: { stopStatus?: number; config?: LabInterviewConfig; signal?: AbortSignal } = {}) {
  const track = microphone();
  const chunks: Chunk[] = [];
  const node = { connect() {}, disconnect() {}, addEventListener() {} };
  vi.stubGlobal(
    "AudioContext",
    class {
      readonly currentTime = 0;
      readonly sampleRate: number;
      readonly destination = {};
      constructor({ sampleRate }: { sampleRate: number }) {
        this.sampleRate = sampleRate;
      }
      createMediaStreamDestination = () => ({ stream: new MediaStream() });
      createBuffer = (_channels: number, length: number, rate: number) => ({
        duration: length / rate,
        getChannelData: () => new Float32Array(length),
      });
      createBufferSource = () => {
        const chunk = new Chunk();
        chunks.push(chunk);
        return chunk;
      };
      createMediaStreamSource = () => node;
      createScriptProcessor = () => node;
      createGain = () => ({ ...node, gain: { value: 1 } });
      resume = async () => undefined;
      close = async () => undefined;
    },
  );
  const events: EventTarget[] = [];
  const eventUrls: string[] = [];
  /** Runtime's terminal result, once the test lets Lab's outcome read return it. */
  let terminal: LabRunDetail["terminalResult"] | null = null;
  /** Each Stop Lab sent, and whether the media attachment was still open when it was sent. */
  const stops: { endReason: unknown; attachmentOpen: boolean }[] = [];
  const sockets: MediaSocket[] = [];
  vi.stubGlobal(
    "EventSource",
    class extends EventTarget {
      constructor(url: string) {
        super();
        events.push(this);
        eventUrls.push(url);
      }
      close(): void {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === "/_api/runtime/runs") {
        const body = z
          .object({ attemptId: z.string(), connection: z.object({ exchangeId: z.string() }) })
          .parse(JSON.parse(String(init?.body)));
        const runId = `lab_${body.attemptId}`;
        return Response.json(
          {
            runId,
            exchangeId: body.connection.exchangeId,
            acceptance: "accepted",
            reply: {
              output: { encoding: "pcm_s16le", sampleRate: 24_000, channels: 1 },
              input: { encoding: "pcm_s16le", sampleRate: 16_000, channels: 1 },
            },
          },
          {
            headers: {
              "X-Lab-Run-Id": runId,
              "X-Lab-Run-Started-At": "1700000000000",
            },
          },
        );
      }
      if (path.endsWith("/startup")) {
        const runId = decodeURIComponent(path.split("/")[4] ?? "");
        return Response.json({
          runId,
          disposition: "succeeded",
          decidedAt: 1,
          reason: null,
          stopRequired: false,
        });
      }
      if (path.endsWith("/complete")) {
        stops.push({
          endReason: z.object({ endReason: z.string() }).parse(JSON.parse(String(init?.body)))
            .endReason,
          attachmentOpen: sockets[0]?.closed === false,
        });
        return Response.json({ accepted: stopStatus < 300 }, { status: stopStatus });
      }
      if (path.startsWith("/_api/runs/")) {
        const runId = decodeURIComponent(path.split("/")[3] ?? "");
        if (terminal?.runId === runId)
          return Response.json({
            runId,
            startedAt: 1_700_000_000_000,
            transcriptTurnCount: 0,
            transcript: { turns: [] },
            terminalResult: terminal,
          });
      }
      return Response.json({ error: "lab_run_not_found" }, { status: 404 });
    }),
  );
  vi.stubGlobal(
    "WebSocket",
    class extends MediaSocket {
      constructor() {
        super();
        sockets.push(this);
      }
    },
  );
  const client = createLabCascadeClient({ labWorkerUrl: "https://lab.test" });
  const session = await client.start(
    signal === undefined ? { runtimeConfig: config } : { runtimeConfig: config, signal },
  );
  await vi.waitFor(() => expect(session.getStatus().phase).toBe("live"));
  const socket = sockets[0];
  if (socket === undefined) throw new Error("The media attachment did not open");
  const media = (message: CascadeMediaServerMessage) =>
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  const runtime = (type: string, payload: RuntimeEventPayload) =>
    events[0]?.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(payload) }));
  /**
   * The closing, in Runtime's `state` (`finishing` unless given): 900 ms of audio, started and,
   * when `delivered`, ended.
   */
  const closing = ({ delivered, state = "finishing" }: { delivered: boolean; state?: string }) => {
    media({ type: "output.started", outputId: "closing" });
    media({
      type: "output.audio",
      outputId: "closing",
      sequence: 0,
      audio: btoa("\0".repeat(43_200)),
    });
    runtime("runtime.conversation_state", { state, deadlineAt: null });
    if (delivered) media({ type: "output.ended", outputId: "closing", chunkCount: 1 });
  };
  /** Lab's outcome read returns Runtime's terminal result from now on. */
  const settle = (result: NonNullable<LabRunDetail["terminalResult"]>) => {
    terminal = result;
  };
  /** An interviewer output that started playing and is still playing. */
  const question = () => {
    media({ type: "output.started", outputId: "question" });
    media({
      type: "output.audio",
      outputId: "question",
      sequence: 0,
      audio: btoa("\0".repeat(43_200)),
    });
  };
  return {
    session,
    track,
    socket,
    chunks,
    closing,
    question,
    media,
    runtime,
    settle,
    stops,
    eventUrls,
  };
}

// Runtime announces a normal end only once the closing has had time to play, plus its margin:
// the page plays the closing to its end and leaves Live on that announcement, not before.
it.each([
  { state: "finishing", endReason: "agent_requested_end" },
  // A Goodbye entered by expiry keeps its reserved reason.
  { state: "goodbye", endReason: "timebox_reached" },
])(
  "plays a $state closing to its end and leaves Live only when Runtime announces $endReason",
  async ({ state, endReason }) => {
    const { session, track, socket, chunks, closing, runtime } = await liveCascade();
    closing({ delivered: true, state });
    expect(track.readyState).toBe("ended");
    chunks[0]?.playToEnd();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(session.getStatus().phase).toBe("live");
    expect(socket.closed).toBe(false);
    runtime("runtime.ending", { endReason, strategy: "hard_stop" });
    expect(session.getStatus().phase).toBe("ending");
    expect(socket.closed).toBe(true);
    expect(chunks.map((chunk) => chunk.stopped)).toEqual([false]);
  },
);

// Runtime keeps the reason the finish reserved when Stop lands during the closing or its margin,
// so the announcement of a Stop during the closing names `agent_requested_end`: the page clears
// whatever of the closing still plays at once.
it("clears the closing still playing at once when Runtime announces the end", async () => {
  const { session, chunks, closing, runtime } = await liveCascade();
  closing({ delivered: true });
  runtime("runtime.ending", { endReason: "agent_requested_end", strategy: "hard_stop" });
  expect(session.getStatus().phase).toBe("ending");
  expect(chunks.map((chunk) => chunk.stopped)).toEqual([true]);
});

it("clears a question at once when the interview expires outside a closing", async () => {
  const { session, chunks, question, media, runtime } = await liveCascade();
  question();
  media({ type: "output.ended", outputId: "question", chunkCount: 1 });
  runtime("runtime.ending", { endReason: "timebox_reached", strategy: "hard_stop" });
  expect(session.getStatus().phase).toBe("ending");
  expect(chunks.map((chunk) => chunk.stopped)).toEqual([true]);
});

it("clears a closing its deadline cancels at once", async () => {
  const { chunks, closing, media } = await liveCascade();
  closing({ delivered: false });
  media({ type: "output.cancelled", outputId: "closing" });
  expect(chunks.map((chunk) => chunk.stopped)).toEqual([true]);
});

it("leaves Live a bound after the closing played when Runtime's announcement is lost", async () => {
  const { session, socket, chunks, closing } = await liveCascade();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  closing({ delivered: true });
  chunks[0]?.playToEnd();
  await vi.advanceTimersByTimeAsync(4_900);
  expect(session.getStatus().phase).toBe("live");
  await vi.advanceTimersByTimeAsync(200);
  expect(session.getStatus().phase).toBe("ending");
  // Runtime has not announced the end: the attachment stays open for it.
  expect(socket.closed).toBe(false);
});

it("leaves Live at once when the media connection drops during the closing", async () => {
  const { session, socket, chunks, closing } = await liveCascade();
  closing({ delivered: false });
  socket.dispatchEvent(new Event("close"));
  expect(session.getStatus().phase).toBe("ending");
  expect(chunks.map((chunk) => chunk.stopped)).toEqual([true]);
});

it("ends the closing at once when the participant presses End while it plays, and keeps its attachment for Runtime's announcement", async () => {
  const { session, socket, chunks, closing, runtime, stops } = await liveCascade();
  closing({ delivered: true });
  void session.complete("participant_stopped");
  expect(session.getStatus().phase).toBe("ending");
  expect(chunks.map((chunk) => chunk.stopped)).toEqual([true]);
  await vi.waitFor(() =>
    expect(stops).toEqual([{ endReason: "participant_stopped", attachmentOpen: true }]),
  );
  runtime("runtime.ending", { endReason: "agent_requested_end", strategy: "hard_stop" });
  expect(socket.closed).toBe(true);
});

it("stops playback and the microphone at End, sends Stop with its attachment open, and closes it once Runtime announces the end", async () => {
  const { session, socket, chunks, track, question, runtime, stops } = await liveCascade();
  question();
  void session.complete("participant_stopped");
  expect(chunks.map((chunk) => chunk.stopped)).toEqual([true]);
  expect(track.readyState).toBe("ended");
  expect(session.getStatus().phase).toBe("ending");
  await vi.waitFor(() =>
    expect(stops).toEqual([{ endReason: "participant_stopped", attachmentOpen: true }]),
  );
  // The accepted Stop closes nothing: the attachment waits for Runtime's announcement.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(socket.closed).toBe(false);
  runtime("runtime.ending", { endReason: "participant_stopped", strategy: "hard_stop" });
  expect(socket.closed).toBe(true);
});

it("closes its attachment at once when Runtime refuses its Stop", async () => {
  const { session, socket, stops } = await liveCascade({ stopStatus: 500 });
  void session.complete("participant_stopped");
  await vi.waitFor(() => expect(stops).toHaveLength(1));
  await vi.waitFor(() => expect(socket.closed).toBe(true));
});

// Starting the next Run aborts the previous participation and cancels it.
it.each([
  { seen: "live", stops: ["participant_disconnected"] },
  { seen: "ended", stops: [] },
])(
  "sends Stop only for a Run it has not seen end when the page leaves it ($seen)",
  async ({ seen, stops }) => {
    const page = new AbortController();
    const { session, runtime, settle, stops: sent } = await liveCascade({ signal: page.signal });
    if (seen === "ended") {
      runtime("runtime.ending", { endReason: "timebox_reached", strategy: "hard_stop" });
      settle({
        runId: session.handle.runId,
        outcome: "completed",
        reason: "timebox_reached",
        liveAt: 1_700_000_001_000,
        endedAt: 1_700_000_030_000,
        transcriptSnapshot: { revision: 0, digest: `sha256:${"0".repeat(64)}`, turnCount: 0 },
        transcriptCompleteness: "complete",
        transcriptIncompleteReasons: [],
        runtimeUsage: { completeness: "complete", observations: [] },
      });
      await vi.waitFor(() => expect(session.getStatus().phase).toBe("ended"), { timeout: 2_000 });
    }
    page.abort();
    await session.cancel("Lab view replaced.");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent.map((stop) => stop.endReason)).toEqual(stops);
  },
);
