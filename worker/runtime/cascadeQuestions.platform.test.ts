import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { z } from "zod";
import { questionsCascadeSelection } from "../runtimeHostComposition.ts";
import { cascadeMediaInputFormat } from "../shared/contracts/cascadeMedia.ts";
import { platformBuildOptions } from "../shared/testing/platformBuild.ts";
import { cascadeRunClient, type CascadeReceived } from "./testing/cascadeRunClient.ts";
import {
  sampleFinishDescription,
  sampleNextQuestionDescription,
  sampleQuestionPrompts,
  sampleQuestionsInput,
} from "./testing/sampleInterviews.ts";
import type { StandInResponse } from "../providers/cascade/testing/standIns.ts";

/**
 * Cascade Questions through the real Runtime host on workerd: the Run's Durable Object, its
 * Conversation, node dispatch, Ending and media attachment are real; only the providers are the
 * controlled stand-ins, which follow the local Runtime's interview script on Runtime's sample
 * Questions, or the scripted replies of the Run's name below. They record each model request, each audio frame
 * they synthesize and each model response or synthesis their caller cancelled.
 */
let platform: Miniflare;
let script = "";
/** Durable Object storage outlives a platform, so a new platform is a Runtime restart. */
let persistence = "";

/** The answers the speech-input stand-in knows: a short one, and a long one expiry cuts short. */
const shortAnswer = { text: "The talks were clear.", durationSeconds: 1 };
const longAnswer = {
  text: "The talks were clear and the venue was great.",
  durationSeconds: 30,
  segments: [
    { text: "The talks were clear", startSeconds: 0, endSeconds: 0.5 },
    { text: "and the venue was great.", startSeconds: 0.5, endSeconds: 30 },
  ],
};

const nextQuestionCall = { name: "next_question", arguments: "{}" };
const askFirst: StandInResponse = { text: ["What worked well at the event?"] };
const movedOn: StandInResponse = {
  text: ["Thank you, that helps."],
  toolCalls: [nextQuestionCall],
};

/**
 * Speech whose synthesis runs for over ten seconds after its model response completed: twenty
 * pieces of about three and a half seconds of audio each, each synthesized in about 0.7 s.
 */
const longReply = Array<string>(20).fill(
  "Thank you, that helps, and it is good to hear what made the talks clear to you. ",
);
/** Speech beside next_question that is still being synthesized when Runtime admits the move. */
const longMove: StandInResponse = { text: longReply, toolCalls: [nextQuestionCall] };
/** The scripted Run's model replies, one per request in order. */
const scriptedResponses: readonly StandInResponse[] = [
  askFirst,
  longMove,
  { text: ["What could improve at the event?"] },
  { text: ["Could you say more?"], toolCalls: [nextQuestionCall] },
];
const longQuestion = Array<string>(20).fill(
  "What could improve at the event, from the talks and the venue to the schedule? ",
);
/** The first text of the next question's request, which the request then holds open. */
const heldQuestionText = "What could improve ";

/**
 * The step of the move to the next question that a move scenario holds: the next question's
 * model request held open after its first text, or the next question's synthesis still running
 * after its response completed. The reply that called next_question is cut once Runtime admits
 * the move, so the move holds no step of its own before the next question.
 */
type MoveStep = "request" | "synthesis";
const moveReplies = {
  request: [askFirst, movedOn, { text: [heldQuestionText], hold: true }],
  synthesis: [askFirst, movedOn, { text: longQuestion }],
} satisfies Record<MoveStep, readonly StandInResponse[]>;
/** The next question's request fails after its first text instead of holding. */
const failingRequest: readonly StandInResponse[] = [
  askFirst,
  movedOn,
  { text: [heldQuestionText], failure: "stand_in_model_failed" },
];

/**
 * The next question's first reply calls next_question itself, so the third question is entered
 * while that reply plays; the third question's synthesis then runs for over ten seconds.
 */
const chainedReplies: readonly StandInResponse[] = [
  askFirst,
  movedOn,
  { text: ["Let us move on."], toolCalls: [nextQuestionCall] },
  { text: longQuestion },
];

const moveSteps: readonly MoveStep[] = ["request", "synthesis"];
const moveEvents = ["stop", "expiry", "failure", "restart"] as const;
/**
 * Each scripted Run's model replies, by its name; the last reply repeats. A move scenario is
 * named `move-<step>-<event>`. Goodbye's closing asks the model nothing.
 */
const scripts = Object.fromEntries<readonly StandInResponse[]>([
  ["scripted-next", scriptedResponses],
  ["move-chained-expiry", chainedReplies],
  ...moveSteps.flatMap((step) =>
    moveEvents.map((event): [string, readonly StandInResponse[]] => [
      `move-${step}-${event}`,
      event === "failure" && step === "request" ? failingRequest : moveReplies[step],
    ]),
  ),
]);
/** The Runs whose platform alarms are held, so only the session's own bound acts at deadlines. */
const alarmsHeld = [...moveSteps.map((step) => `move-${step}-expiry`), "move-chained-expiry"];

beforeAll(async () => {
  const bundle = await build({
    ...platformBuildOptions,
    stdin: {
      contents: `import { InterviewRuntimeController } from "./worker/runtime/interviewRuntimeController.ts";
        import { createRuntimeHostDelivery } from "./worker/runtimeHostDelivery.ts";
        import { createRuntimeHostAssembly } from "./worker/runtimeHostComposition.ts";
        import { readFinalizationTranscriptTurns } from "./worker/runtime/interviewFinalizationModel.ts";
        import { cascadeStandIns } from "./worker/providers/cascade/testing/standIns.ts";
        import { standInInterviewResponse } from "./worker/runtimeLocalInterviewScript.ts";
        const scripts = ${JSON.stringify(scripts)};
        const alarmsHeld = ${JSON.stringify(alarmsHeld)};
        export class Controller extends InterviewRuntimeController {
          constructor(ctx, env) {
            const name = ctx.id.name ?? "";
            const requests = [];
            const audio = [];
            const cancelled = [];
            const providers = cascadeStandIns({
              frameIntervalMs: 20,
              utterances: [${JSON.stringify(shortAnswer)}, ${JSON.stringify(longAnswer)}],
              onRequest: (request) => requests.push(request),
              onAudio: () => audio.push(Date.now()),
              onCancel: (work) => cancelled.push({ work, at: Date.now() }),
              responses: scripts[name] ?? standInInterviewResponse,
            });
            // A Run named gate-* runs under the voice Gate's test options, as a local build sets them.
            const assembly = createRuntimeHostAssembly({
              cascadeProviders: providers,
              gateTestOptions: name.startsWith("gate-")
                ? { noTools: true, suppliedNextQuestion: true }
                : undefined,
            });
            // The session's inputs, whose sink a test reports through as the session does.
            const sessions = [];
            super(ctx, env, {
              assembly: {
                ...assembly,
                createSession: (input, selection) => {
                  sessions.push(input);
                  return assembly.createSession(input, selection);
                },
              },
              delivery: createRuntimeHostDelivery(env),
            });
            this.cascadeEvidence = () => ({ requests, audio, cancelled });
            this.cascadeSessions = sessions;
            // These Runs hold the platform's alarms, so only the session's own bound can act at
            // the interviewing deadline; the test runs them afterwards.
            this.alarmsHeld = alarmsHeld.includes(name);
          }
          alarm() {
            return this.alarmsHeld ? Promise.resolve() : super.alarm();
          }
          async fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/cascade") return Response.json(this.cascadeEvidence());
            if (path === "/run-alarm") {
              await this.ready;
              await super.alarm();
              return Response.json({ ok: true });
            }
            if (path === "/report") {
              // One provider observation, numbered next in the session's receipt order.
              await this.ready;
              const { runId, observation, sessionId } = await request.json();
              const aggregate = this.repository.readAggregate(this.repository.requireState());
              const generation = aggregate.providerGeneration;
              const sequence = aggregate.nextProviderSequence;
              const input = this.cascadeSessions.at(-1);
              const sink = input?.issueSink?.(runId, generation) ?? input?.sink;
              if (sink === undefined) return new Response("no session", { status: 409 });
              const at = Date.now();
              await sink({
                kind: "provider_observation",
                observation: { ...observation, generation, sequence, observedAt: at, at },
                persistence: {
                  sessionId,
                  sequence,
                  diagnosticSummary: { sequence, type: observation.kind, response_id: observation.responseId },
                },
              });
              return Response.json({ reported: true });
            }
            if (path !== "/result") return super.fetch(request);
            await this.ready;
            const aggregate = this.repository.readAggregate(this.repository.requireState());
            return Response.json({
              turns: readFinalizationTranscriptTurns(aggregate),
              result: aggregate.applicationTranscriptProof.result ?? null,
              visitId: aggregate.conversationVisit?.visitId ?? null,
              // Each interviewer item's text with the visit of the reply that produced it.
              items: aggregate.transcriptCapture.items
                .filter((item) => item.role === "conversationAgent")
                .map((item) => ({
                  text: item.text ?? null,
                  visitId:
                    aggregate.providerResponses.find((response) => response.responseId === item.responseId)
                      ?.conversationScope?.visitId ?? null,
                })),
            });
          }
        }
        export default { fetch(request, env) {
          return env.CONTROLLER.getByName(new URL(request.url).searchParams.get("controller")).fetch(request);
        }};`,
      resolveDir: process.cwd(),
    },
  });
  script = bundle.outputFiles[0]?.text ?? "";
  persistence = await mkdtemp(join(tmpdir(), "cascade-questions-"));
  platform = createPlatform();
}, 30_000);

function createPlatform() {
  return new Miniflare({
    modules: true,
    script,
    durableObjectsPersist: persistence,
    compatibilityDate: "2026-06-05",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    durableObjects: { CONTROLLER: { className: "Controller", useSQLite: true } },
    bindings: { OPENAI_API_KEY: "sk-controlled-not-used" },
  });
}

afterAll(async () => {
  await platform?.dispose();
  if (persistence !== "") await rm(persistence, { recursive: true, force: true });
});

const client = cascadeRunClient(() => platform);
const { request, post, state: readState } = client;

const evidenceSchema = z.object({
  requests: z.array(
    z.object({
      history: z.array(z.json()),
      instructions: z.json(),
      operationalInstructions: z.string(),
      tools: z.array(z.object({ name: z.string(), description: z.string() })),
      toolChoice: z.json(),
    }),
  ),
  audio: z.array(z.number()),
  cancelled: z.array(z.object({ work: z.string(), at: z.number() })),
});
/** What the Run's stand-ins received and did: model requests, audio frames and cancellations. */
async function cascadeEvidence(runId: string) {
  return evidenceSchema.parse(await (await request(runId, "/cascade")).json());
}
async function modelRequests(runId: string) {
  return (await cascadeEvidence(runId)).requests;
}

const resultSchema = z.object({
  turns: z.array(z.object({ role: z.string(), text: z.string() })),
  result: z.object({ outcome: z.string(), reason: z.string().optional() }).passthrough(),
  items: z.array(z.object({ text: z.string().nullable(), visitId: z.string().nullable() })),
});
async function readResult(runId: string) {
  return resultSchema.parse(await (await request(runId, "/result")).json());
}
/** The Run's current Conversation visit, readable while it is live. */
async function readVisitId(runId: string) {
  return z.object({ visitId: z.string() }).parse(await (await request(runId, "/result")).json())
    .visitId;
}

const diagnosticsSchema = z.object({
  records: z.array(z.object({ type: z.string(), payloadJson: z.string() })),
});
/** The Run's retained Runtime records of one type, with their payloads. */
async function records(runId: string, type: string) {
  const { records } = diagnosticsSchema.parse(
    await (await request(runId, `/diagnostics?runId=${runId}`)).json(),
  );
  return records
    .filter((record) => record.type === type)
    .map((record) => z.record(z.string(), z.json()).parse(JSON.parse(record.payloadJson)));
}

type Received = CascadeReceived;

/** Starts a Cascade Questions Run, attaches its media as the Lab page does, and reports readiness. */
function goLive(runId: string, questions: readonly string[], interviewingMs = 60_000) {
  return client.goLive(runId, {
    selection: questionsCascadeSelection,
    agentInput: sampleQuestionsInput(questions, {
      interviewingDurationMs: interviewingMs,
      maximumClosingDurationMs: 45_000,
    }),
  });
}

/** 100 ms of input-format audio: a speech-level tone, or silence. */
function inputChunk(speech: boolean) {
  const samples = cascadeMediaInputFormat.sampleRate / 10;
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  if (speech)
    for (let sample = 0; sample < samples; sample += 1)
      view.setInt16(
        sample * 2,
        Math.round(
          Math.sin((2 * Math.PI * 440 * sample) / cascadeMediaInputFormat.sampleRate) * 6_000,
        ),
        true,
      );
  return btoa(String.fromCharCode(...pcm));
}

/**
 * Waits for listening opportunity number `ordinal` and speaks into it, as the Lab page sends
 * microphone audio: `speechChunks` of speech, then `silenceChunks` of silence.
 */
async function answer(
  received: readonly Received[],
  socket: Readonly<{ send(data: string): void }>,
  speechChunks: number,
  silenceChunks: number,
  ordinal = 1,
) {
  const opportunities = () => received.filter(({ message }) => message.type === "input.listening");
  await expect.poll(() => opportunities().length, { timeout: 15_000 }).toBe(ordinal);
  const listening = opportunities().at(ordinal - 1)?.message;
  if (listening?.type !== "input.listening") throw new Error("Missing the listening opportunity");
  const send = (audio: string) =>
    socket.send(
      JSON.stringify({ type: "input.audio", opportunityId: listening.opportunityId, audio }),
    );
  for (let chunk = 0; chunk < speechChunks; chunk += 1) send(inputChunk(true));
  for (let chunk = 0; chunk < silenceChunks; chunk += 1) send(inputChunk(false));
}

/** The identities of the outputs the browser was offered, in order. */
function outputIds(received: readonly Received[]) {
  return received.flatMap(({ message }) =>
    message.type === "output.started" ? [message.outputId] : [],
  );
}

/** One output's messages in order, without its numbered audio, which timing decides. */
function lifecycle(received: readonly Received[], outputId: string | undefined) {
  return received.flatMap(({ message }) =>
    "outputId" in message && message.outputId === outputId && message.type !== "output.audio"
      ? [message.type]
      : [],
  );
}

/** How many audio chunks the browser received for one output. */
function audioChunks(received: readonly Received[], outputId: string | undefined) {
  return received.filter(
    ({ message }) => message.type === "output.audio" && message.outputId === outputId,
  ).length;
}

/** Where one output's message of this type falls in the order the browser received them. */
function receivedIndex(received: readonly Received[], type: string, outputId: string | undefined) {
  return received.findIndex(
    ({ message }) =>
      message.type === type && "outputId" in message && message.outputId === outputId,
  );
}

/** When the browser received one output's message of this type. */
function arrivedAt(received: readonly Received[], type: string, outputId: string | undefined) {
  return received[receivedIndex(received, type, outputId)]?.at;
}

/** When synthesis was last cancelled, once it was cancelled more often than `before` times. */
async function synthesisCancelledAfter(runId: string, before: number) {
  const cancelled = (await cascadeEvidence(runId)).cancelled.filter(
    ({ work }) => work === "synthesis",
  );
  return cancelled.length > before ? cancelled.at(-1)?.at : undefined;
}
/** How often the Run's synthesis was cancelled so far, the cut of a reply that moved on included. */
async function synthesisCancellations(runId: string) {
  return (await cascadeEvidence(runId)).cancelled.filter(({ work }) => work === "synthesis").length;
}

/** Waits until the Run ended with the given reason, running its alarm as the platform would. */
async function endedWith(runId: string, endReason: string) {
  await expect
    .poll(
      async () => {
        await request(runId, "/run-alarm");
        return readState(runId);
      },
      { timeout: 30_000, interval: 500 },
    )
    .toMatchObject({ phase: "ended", completion: { endReason } });
}

/** What a Question's request sends besides its history: its prompt and both tools. */
function questionRequest(prompt: string) {
  return {
    instructions: { kind: "literal", text: prompt },
    operationalInstructions: "",
    tools: [
      { name: "next_question", description: sampleNextQuestionDescription },
      { name: "finish_interview", description: sampleFinishDescription },
    ],
    toolChoice: "auto",
  };
}

const [firstPrompt, lastPrompt] = sampleQuestionPrompts;

/** The text a scripted reply submitted for synthesis, as its interviewer turn. */
const spoken = (pieces: readonly string[]) => pieces.join("").trim();

/**
 * Answers the first question and waits until the move to the next question reaches the held
 * step, then returns the output in flight. At the request step, the next question's output
 * started and its request holds open after its first text. At the synthesis step, the next
 * question's response completed and its synthesis is still running.
 */
async function holdMove(
  runId: string,
  step: MoveStep,
  received: readonly Received[],
  socket: Readonly<{ send(data: string): void }>,
) {
  await answer(received, socket, 10, 10);
  await expect.poll(() => outputIds(received).length, { timeout: 15_000 }).toBe(3);
  const question = outputIds(received)[2];
  await expect.poll(() => audioChunks(received, question), { timeout: 5_000 }).toBeGreaterThan(0);
  if (step === "synthesis")
    await expect
      .poll(async () => (await records(runId, "cascade.model_usage")).length, { timeout: 5_000 })
      .toBe(3);
  expect(lifecycle(received, question)).toEqual(["output.started"]);
  return question;
}

/** The transcript before the move's held step, and the turn the held output keeps. */
const firstTurns = [
  { role: "conversationAgent", text: "What worked well at the event?" },
  { role: "participant", text: shortAnswer.text },
];
/** The reply that moved on was cut at the move, and the transcript keeps its text. */
const movedOnTurn = { role: "conversationAgent", text: spoken(movedOn.text) };
const heldTurns = {
  request: [
    ...firstTurns,
    movedOnTurn,
    { role: "conversationAgent", text: heldQuestionText.trim() },
  ],
  synthesis: [
    ...firstTurns,
    movedOnTurn,
    { role: "conversationAgent", text: spoken(longQuestion) },
  ],
} satisfies Record<MoveStep, readonly { role: string; text: string }[]>;
/** The model requests sent up to the held step: the next question's is sent after the reply. */
const requestsBeforeHold = { request: 3, synthesis: 3 } satisfies Record<MoveStep, number>;

describe("Cascade Questions on the real Runtime host", () => {
  it("opens with the question, keeps the answer and speaks the closing once the model finishes", async () => {
    // A one-question interview: the sample's last question, which the stand-in finishes.
    const runId = "questions-finish";
    const { received, socket } = await goLive(runId, [lastPrompt]);
    await answer(received, socket, 10, 10);
    await expect
      .poll(async () => readState(runId), { timeout: 25_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "agent_requested_end" } });

    // The question request sends the prompt, both tools and the conversation as text turns;
    // Goodbye's closing sentence asks the model nothing.
    expect(await modelRequests(runId)).toEqual([
      { history: [], ...questionRequest(lastPrompt) },
      {
        history: [
          { role: "interviewer", text: "What could improve at the event?" },
          { role: "participant", text: shortAnswer.text },
        ],
        ...questionRequest(lastPrompt),
      },
    ]);

    // The answer is kept once and the closing is the last interviewer turn, delivered to its
    // end; no listening follows the answer.
    const saved = await readResult(runId);
    expect(saved.turns).toEqual([
      { role: "conversationAgent", text: "What could improve at the event?" },
      { role: "participant", text: shortAnswer.text },
      { role: "conversationAgent", text: "Thank you. Goodbye." },
    ]);
    expect(saved.result).toMatchObject({ outcome: "completed", reason: "agent_requested_end" });
    // The closing is the third output, after the question and the finishing reply. Runtime sends
    // its end before the Run ends, but the browser receives it on its media attachment, which
    // reading the Run's state does not wait for.
    await expect
      .poll(() => lifecycle(received, outputIds(received)[2]), { timeout: 5_000 })
      .toEqual(["output.started", "output.ended"]);
    expect(received.at(-1)?.message).toMatchObject({ type: "output.ended" });
    expect(received.filter(({ message }) => message.type === "input.listening")).toHaveLength(1);
    expect((await readState(runId)).completion?.warnings).toEqual([]);
    expect(await records(runId, "conversation.transition")).toEqual([
      { from: "question", to: "goodbye", questionIndex: 0 },
      { from: "goodbye", to: "complete", questionIndex: 0 },
    ]);
  }, 40_000);

  // What the closing does with the answer in progress is the kit's closing contract
  // (`worker/providers/cascade/turnTaking.test.ts`); Cascade Goodbye's tests keep the answer
  // through Runtime. This scenario keeps what Questions adds: the step that follows a question.
  it("enters Goodbye from the current question when interviewing time expires during an answer", async () => {
    const runId = "questions-expiry";
    const { received, socket } = await goLive(runId, [firstPrompt, lastPrompt], 5_000);
    // Two seconds of the long answer and no silence after it: only the expiry ends it.
    await answer(received, socket, 20, 0);
    await expect
      .poll(async () => readState(runId), { timeout: 25_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "timebox_reached" } });
    expect((await readResult(runId)).result).toMatchObject({
      outcome: "completed",
      reason: "timebox_reached",
    });
    expect(await modelRequests(runId)).toEqual([{ history: [], ...questionRequest(firstPrompt) }]);
    expect(await records(runId, "conversation.transition")).toEqual([
      { from: "question", to: "goodbye", questionIndex: 0 },
      { from: "goodbye", to: "complete", questionIndex: 0 },
    ]);
  }, 40_000);

  it("under the Gate's options sends no tools and answers question 1's answer with the supplied next_question", async () => {
    const runId = "gate-next";
    const { received, socket } = await goLive(runId, [firstPrompt, lastPrompt]);
    await answer(received, socket, 10, 10, 1);
    // Question 2 is the third output: after the opening question and the supplied reply.
    await expect.poll(() => outputIds(received).length, { timeout: 15_000 }).toBe(3);
    const [, supplied, question] = outputIds(received);
    await expect
      .poll(() => lifecycle(received, question), { timeout: 15_000 })
      .toEqual(["output.started", "output.ended"]);
    expect((await post(runId, "/complete", { endReason: "participant_stopped" })).ok).toBe(true);
    await expect
      .poll(async () => readState(runId), { timeout: 25_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "participant_stopped" } });

    // No model request answers question 1's answer, and every request offers no tool and no
    // tool choice; the prompts are unchanged.
    const noTools = { tools: [], toolChoice: null };
    expect(await modelRequests(runId)).toEqual([
      { history: [], ...questionRequest(firstPrompt), ...noTools },
      {
        history: [
          { role: "interviewer", text: "Welcome. What worked well at the event?" },
          { role: "participant", text: shortAnswer.text },
        ],
        ...questionRequest(lastPrompt),
        ...noTools,
      },
    ]);
    // The supplied reply spoke nothing and moved the Conversation to question 2.
    expect(audioChunks(received, supplied)).toBe(0);
    const started = await records(runId, "cascade.output_started");
    expect(started.map((record) => record.says)).toEqual(["reply", "supplied", "reply"]);
    expect(await records(runId, "conversation.transition")).toEqual([
      { from: "question", to: "question", questionIndex: 1 },
      { from: "question", to: "complete", questionIndex: 1 },
    ]);
    expect(await records(runId, "gate.test_options")).toEqual([
      { noTools: true, suppliedReply: "next_question" },
    ]);
    expect((await readResult(runId)).turns).toEqual([
      { role: "conversationAgent", text: "Welcome. What worked well at the event?" },
      { role: "participant", text: shortAnswer.text },
      { role: "conversationAgent", text: "What could improve at the event?" },
    ]);
  }, 40_000);

  it("cuts the reply that moved on as soon as Runtime admits the move, then asks the next question without listening between", async () => {
    // Scripted replies: Q1; long speech beside next_question; Q2; speech beside next_question on
    // the last question.
    const runId = "scripted-next";
    const { received, socket } = await goLive(runId, [firstPrompt, lastPrompt]);
    const firstQuestion = await readVisitId(runId);
    await answer(received, socket, 10, 10, 1);
    // Question 2 is asked on entry: the next opportunity opens only after its speech.
    await answer(received, socket, 10, 10, 2);
    // A next_question on the last question keeps the Conversation there: listening follows.
    const opportunities = () =>
      received.filter(({ message }) => message.type === "input.listening");
    await expect.poll(() => opportunities().length, { timeout: 15_000 }).toBe(3);

    // A late report from Question 1: its reply's next_question call again, now that Question 2
    // is current. Runtime refuses it, so the interview does not advance.
    const [q1, reply, q2, more] = outputIds(received);
    const { sessionId } = await readState(runId);
    if (reply === undefined || sessionId === undefined)
      throw new Error("Missing the reply that moved on");
    const late = await request(runId, "/report", {
      method: "POST",
      body: JSON.stringify({
        runId,
        observation: {
          kind: "reply_generated",
          responseId: reply,
          status: "completed",
          toolInvocations: [
            {
              type: "function_call",
              toolName: "next_question",
              callId: "call_late",
              responseId: reply,
              arguments: "{}",
            },
          ],
        },
        sessionId,
      }),
    });
    expect(late.status).toBe(200);
    expect((await post(runId, "/complete", { endReason: "participant_stopped" })).ok).toBe(true);
    await expect
      .poll(async () => readState(runId), { timeout: 25_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "participant_stopped" } });

    // The reply that moved on is cancelled while its speech is still being synthesized, and
    // Question 2 starts next, with no listening between them.
    const sequence = received.flatMap(({ message }) =>
      message.type === "output.audio" || message.type === "input.closed"
        ? []
        : [
            message.type === "input.listening"
              ? "listening"
              : `${message.type} ${message.outputId}`,
          ],
    );
    expect(sequence).toEqual([
      `output.started ${String(q1)}`,
      `output.ended ${String(q1)}`,
      "listening",
      `output.started ${String(reply)}`,
      `output.cancelled ${String(reply)}`,
      `output.started ${String(q2)}`,
      `output.ended ${String(q2)}`,
      "listening",
      `output.started ${String(more)}`,
      `output.ended ${String(more)}`,
      "listening",
    ]);
    // None of its audio reaches the browser after the cut, and its synthesis stopped there.
    expect(
      received
        .slice(receivedIndex(received, "output.cancelled", reply))
        .filter(({ message }) => message.type === "output.audio" && message.outputId === reply),
    ).toEqual([]);
    expect((await cascadeEvidence(runId)).cancelled.map(({ work }) => work)).toEqual(["synthesis"]);
    // The Run's diagnostics show the cut.
    expect(await records(runId, "cascade.output_cut")).toEqual([
      { source: "cascade_execution", provider: "cascade", outputId: reply, delivered: false },
    ]);

    // Question 2's request is sent on entry with its prompt and the conversation as text turns.
    // It leaves out the speech that was cut, so it ends on the participant's answer.
    const q1Turns = [
      { role: "interviewer", text: "What worked well at the event?" },
      { role: "participant", text: shortAnswer.text },
    ];
    expect(await modelRequests(runId)).toEqual([
      { history: [], ...questionRequest(firstPrompt) },
      { history: q1Turns, ...questionRequest(firstPrompt) },
      { history: q1Turns, ...questionRequest(lastPrompt) },
      {
        history: [
          ...q1Turns,
          { role: "interviewer", text: "What could improve at the event?" },
          { role: "participant", text: shortAnswer.text },
        ],
        ...questionRequest(lastPrompt),
      },
    ]);

    // Question 2's speech belongs to Question 2, whose replies' calls are evaluated there. The
    // late call from Question 1 is out of scope, and next_question on the last question keeps
    // the Conversation on it until the Stop.
    expect(await records(runId, "conversation.transition")).toEqual([
      { from: "question", to: "question", questionIndex: 1 },
      { from: "question", to: "complete", questionIndex: 1 },
    ]);
    expect(await records(runId, "runtime.tool_call_handled")).toMatchObject([
      { responseId: reply, context: { questionIndex: 0 }, outcome: "transitioned" },
      {
        responseId: more,
        context: { questionIndex: 1 },
        outcome: "ignored",
        reason: "no_transition",
      },
      {
        responseId: reply,
        context: { questionIndex: 1 },
        outcome: "ignored",
        reason: "out_of_scope",
      },
    ]);
    // The saved transcript keeps the cut speech's text under Question 1.
    const saved = await readResult(runId);
    expect(saved.turns).toEqual([
      { role: "conversationAgent", text: "What worked well at the event?" },
      { role: "participant", text: shortAnswer.text },
      { role: "conversationAgent", text: spoken(longReply) },
      { role: "conversationAgent", text: "What could improve at the event?" },
      { role: "participant", text: shortAnswer.text },
      { role: "conversationAgent", text: "Could you say more?" },
    ]);
    expect(saved.items[1]).toEqual({ text: spoken(longReply), visitId: firstQuestion });
  }, 60_000);
});

describe("Cascade Questions' Stop, expiry and failures while it moves to the next question", () => {
  it.each(moveSteps)(
    "clears the output in flight at once on Stop and ends as the participant stopped (%s)",
    async (step) => {
      const runId = `move-${step}-stop`;
      const { received, socket } = await goLive(runId, [firstPrompt, lastPrompt]);
      const inFlight = await holdMove(runId, step, received, socket);
      expect((await post(runId, "/complete", { endReason: "participant_stopped" })).ok).toBe(true);
      const stoppedAt = Date.now();
      await expect
        .poll(async () => readState(runId), { timeout: 20_000 })
        .toMatchObject({ phase: "ended", completion: { endReason: "participant_stopped" } });

      // The browser clears the output in flight at once, and nothing follows it: no listening
      // and no next question. Runtime clears it when Ending starts, before the Run ends, but the
      // browser receives the cancellation on its media attachment, which reading the Run's state
      // does not wait for.
      await expect
        .poll(() => lifecycle(received, inFlight), { timeout: 5_000 })
        .toEqual(["output.started", "output.cancelled"]);
      expect(
        (arrivedAt(received, "output.cancelled", inFlight) ?? Infinity) - stoppedAt,
      ).toBeLessThan(1_000);
      const cancelled = receivedIndex(received, "output.cancelled", inFlight);
      expect(received.slice(cancelled + 1)).toEqual([]);

      // Synthesis stops at once, and so does a request still generating; no request follows.
      const evidence = await cascadeEvidence(runId);
      const synthesisCancelledAt =
        evidence.cancelled.findLast(({ work }) => work === "synthesis")?.at ?? Infinity;
      expect(synthesisCancelledAt - stoppedAt).toBeLessThan(1_000);
      expect(evidence.audio.filter((at) => at > synthesisCancelledAt)).toEqual([]);
      expect(evidence.cancelled.some(({ work }) => work === "model")).toBe(step === "request");
      expect(evidence.requests).toHaveLength(requestsBeforeHold[step]);

      // The output cut short keeps the text it had submitted.
      const saved = await readResult(runId);
      expect(saved.result).toMatchObject({ outcome: "completed", reason: "participant_stopped" });
      expect(saved.turns).toEqual(heldTurns[step]);
      expect((await readState(runId)).completion?.warnings).toEqual([]);
    },
    60_000,
  );

  it.each(moveSteps)(
    "stops the interviewer's speech at the interviewing deadline, then speaks the closing (%s)",
    async (step) => {
      const runId = `move-${step}-expiry`;
      const { received, socket } = await goLive(runId, [firstPrompt, lastPrompt], 8_000);
      const inFlight = await holdMove(runId, step, received, socket);
      const secondQuestion = await readVisitId(runId);
      const deadlineAt = (await readState(runId)).conversation?.deadlineAt ?? 0;
      expect(Date.now()).toBeLessThan(deadlineAt);
      const before = await synthesisCancellations(runId);

      // The platform's alarms are held: the session's own bound stops the held step at the
      // interviewing deadline.
      const synthesisCancelledAt = () => synthesisCancelledAfter(runId, before);
      await expect.poll(synthesisCancelledAt, { timeout: 15_000 }).toBeDefined();
      const cancelledAt = (await synthesisCancelledAt()) ?? 0;
      expect(cancelledAt).toBeGreaterThanOrEqual(deadlineAt - 100);
      expect(cancelledAt - deadlineAt).toBeLessThan(1_000);
      expect(lifecycle(received, inFlight)).toEqual(["output.started", "output.cancelled"]);
      const { cancelled } = await cascadeEvidence(runId);
      expect(cancelled.some(({ work }) => work === "model")).toBe(step === "request");

      // Runtime's expiry then enters Goodbye: the closing follows and is delivered to its end.
      // Runtime sends the closing's end before the Run ends, but the browser receives it on its
      // media attachment, which reading the Run's state does not wait for.
      await endedWith(runId, "timebox_reached");
      await expect
        .poll(() => lifecycle(received, outputIds(received).at(-1)), { timeout: 5_000 })
        .toEqual(["output.started", "output.ended"]);
      const closing = outputIds(received).at(-1);
      expect(closing).not.toBe(inFlight);
      // The closing starts only after the output in flight was cleared. Both messages can reach
      // the browser within one millisecond, so their order is the order it received them in.
      expect(receivedIndex(received, "output.started", closing)).toBeGreaterThan(
        receivedIndex(received, "output.cancelled", inFlight),
      );
      expect(received.filter(({ message }) => message.type === "input.listening")).toHaveLength(1);
      expect(await modelRequests(runId)).toHaveLength(requestsBeforeHold[step]);

      // The output cut short keeps the text it had submitted, as on Stop, even when its
      // cancellation reaches Runtime after Goodbye was entered.
      const saved = await readResult(runId);
      expect(saved.result).toMatchObject({ outcome: "completed", reason: "timebox_reached" });
      expect(saved.turns).toEqual([
        ...heldTurns[step],
        { role: "conversationAgent", text: "Thank you. Goodbye." },
      ]);
      // A question whose response had not completed keeps its text under its own question.
      if (step === "request")
        expect(saved.items.at(-2)).toEqual({
          text: heldQuestionText.trim(),
          visitId: secondQuestion,
        });
      expect((await readState(runId)).completion?.warnings).toEqual([]);
      expect(await records(runId, "conversation.transition")).toEqual([
        { from: "question", to: "question", questionIndex: 1 },
        { from: "question", to: "goodbye", questionIndex: 1 },
        { from: "goodbye", to: "complete", questionIndex: 1 },
      ]);
    },
    60_000,
  );

  it("bounds a question entered while the previous question's first output plays by the same deadline", async () => {
    const runId = "move-chained-expiry";
    const { received, socket } = await goLive(runId, [firstPrompt, firstPrompt, lastPrompt], 8_000);
    await answer(received, socket, 10, 10);
    // The second question's first reply moved on to the third question, which now speaks.
    await expect.poll(() => outputIds(received).length, { timeout: 15_000 }).toBe(4);
    const third = outputIds(received)[3];
    await expect.poll(() => audioChunks(received, third), { timeout: 5_000 }).toBeGreaterThan(0);
    expect(await records(runId, "conversation.transition")).toEqual([
      { from: "question", to: "question", questionIndex: 1 },
      { from: "question", to: "question", questionIndex: 2 },
    ]);
    const deadlineAt = (await readState(runId)).conversation?.deadlineAt ?? 0;
    expect(Date.now()).toBeLessThan(deadlineAt);
    const before = await synthesisCancellations(runId);

    // The platform's alarms are held: the session's own bound stops its synthesis at the
    // interviewing deadline, and Runtime's expiry then ends the interview.
    const synthesisCancelledAt = () => synthesisCancelledAfter(runId, before);
    await expect.poll(synthesisCancelledAt, { timeout: 15_000 }).toBeDefined();
    const cancelledAt = (await synthesisCancelledAt()) ?? 0;
    expect(cancelledAt).toBeGreaterThanOrEqual(deadlineAt - 100);
    expect(cancelledAt - deadlineAt).toBeLessThan(1_000);
    expect(lifecycle(received, third)).toEqual(["output.started", "output.cancelled"]);
    await endedWith(runId, "timebox_reached");
  }, 60_000);

  it.each(["synthesis"] as const)(
    "ends the Run interrupted at once when its media is lost during the move (%s)",
    async (step) => {
      const runId = `move-${step}-failure`;
      const { received, socket } = await goLive(runId, [firstPrompt, lastPrompt]);
      await holdMove(runId, step, received, socket);
      socket.close(4000, "network_lost");
      const detachedAt = Date.now();
      await expect
        .poll(async () => readState(runId), { timeout: 20_000 })
        .toMatchObject({ phase: "ended", completion: { endReason: "runtime_failed" } });
      // The loss is a failure at once: no Stop is awaited.
      expect((await readState(runId)).completion?.endingStartedAt ?? Infinity).toBeLessThan(
        detachedAt + 2_000,
      );

      // Synthesis stopped when the media was lost, and nothing was requested after it.
      const evidence = await cascadeEvidence(runId);
      const synthesisCancelledAt =
        evidence.cancelled.findLast(({ work }) => work === "synthesis")?.at ?? Infinity;
      expect(synthesisCancelledAt - detachedAt).toBeLessThan(1_000);
      expect(evidence.audio.filter((at) => at > synthesisCancelledAt)).toEqual([]);
      expect(evidence.requests).toHaveLength(requestsBeforeHold[step]);

      const saved = await readResult(runId);
      expect(saved.result.outcome).toBe("interrupted");
      expect(saved.turns).toEqual(heldTurns[step]);
      expect(await records(runId, "cascade.media_detached")).toHaveLength(1);
    },
    60_000,
  );

  it("ends the Run interrupted when the next question's model request fails", async () => {
    const runId = "move-request-failure";
    const { received, socket } = await goLive(runId, [firstPrompt, lastPrompt]);
    await answer(received, socket, 10, 10);
    await expect
      .poll(async () => readState(runId), { timeout: 20_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "runtime_failed" } });

    // The browser stops the failed question, its synthesis stops, and nothing follows it.
    // Runtime stops the question before it reports the failure that ends the Run, but the browser
    // receives the failure on its media attachment, which reading the Run's state does not wait
    // for.
    await expect
      .poll(() => lifecycle(received, outputIds(received)[2]), { timeout: 5_000 })
      .toEqual(["output.started", "output.failed"]);
    const question = outputIds(received)[2];
    expect(outputIds(received)).toHaveLength(3);
    expect(received.filter(({ message }) => message.type === "input.listening")).toHaveLength(1);
    const evidence = await cascadeEvidence(runId);
    expect(evidence.requests).toHaveLength(3);
    expect(await records(runId, "cascade.output_failed")).toEqual([
      expect.objectContaining({ outputId: question, code: "stand_in_model_failed" }),
    ]);

    // The failed response keeps the text it had submitted.
    const saved = await readResult(runId);
    expect(saved.result.outcome).toBe("interrupted");
    expect(saved.turns).toEqual(heldTurns.request);
  }, 60_000);

  it.each(["request"] as const)(
    "replays no question and renews no deadline after a Runtime restart during the move (%s)",
    async (step) => {
      const runId = `move-${step}-restart`;
      const { received, socket } = await goLive(runId, [firstPrompt, lastPrompt]);
      await holdMove(runId, step, received, socket);
      const deadlineAt = (await readState(runId)).conversation?.deadlineAt ?? 0;
      // A new platform is a new Runtime instance over the same Durable Object storage.
      await platform.dispose();
      platform = createPlatform();
      await endedWith(runId, "runtime_failed");

      // The failure ended the Run before the persisted deadline, which nothing renewed.
      expect((await readState(runId)).completion?.endingStartedAt ?? Infinity).toBeLessThan(
        deadlineAt,
      );
      // The restarted instance's stand-ins received no request and synthesized nothing.
      expect(await cascadeEvidence(runId)).toEqual({ requests: [], audio: [], cancelled: [] });
      const saved = await readResult(runId);
      expect(saved.result.outcome).toBe("interrupted");
      // Text whose response completed before the restart stays eligible evidence.
      expect(saved.turns).toEqual([...firstTurns, movedOnTurn]);
    },
    90_000,
  );
});
