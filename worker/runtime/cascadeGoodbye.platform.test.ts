import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { z } from "zod";
import { goodbyeCascadeSelection } from "../runtimeHostComposition.ts";
import {
  cascadeMediaInputFormat,
  cascadeMediaOutputFormat,
} from "../shared/contracts/cascadeMedia.ts";
import { playbackMarginMs } from "./interviewFinalizationModel.ts";
import { platformBuildOptions } from "../shared/testing/platformBuild.ts";
import { cascadeRunClient, type CascadeReceived } from "./testing/cascadeRunClient.ts";
import {
  sampleFinishDescription,
  sampleClosingSentence,
  sampleGoodbyeInput,
  sampleGoodbyeInterviewInstructions,
} from "./testing/sampleInterviews.ts";

/**
 * Cascade Goodbye's node entry, containment, deadline and failures through the real Runtime
 * host on workerd: the Run's Durable Object, its Conversation, node dispatch, Ending and media
 * attachment are real; only the providers are the controlled stand-ins, scripted by the Run's
 * name, which record each model request, each text piece and audio frame they synthesize and
 * each model response or synthesis their caller cancelled.
 */
let platform: Miniflare;
let script = "";
/** Durable Object storage outlives a platform, so a new platform is a Runtime restart. */
let persistence = "";

/** The answer the speech-input stand-in knows: the expiry scenarios cut it short. */
const longAnswer = {
  text: "The talks were clear and the venue was great.",
  durationSeconds: 30,
  segments: [
    { text: "The talks were clear", startSeconds: 0, endSeconds: 0.5 },
    { text: "and the venue was great.", startSeconds: 0.5, endSeconds: 30 },
  ],
};

beforeAll(async () => {
  const bundle = await build({
    ...platformBuildOptions,
    stdin: {
      contents: `import { InterviewRuntimeController } from "./worker/runtime/interviewRuntimeController.ts";
        import { createRuntimeHostDelivery } from "./worker/runtimeHostDelivery.ts";
        import { createRuntimeHostAssembly } from "./worker/runtimeHostComposition.ts";
        import { readFinalizationTranscriptTurns } from "./worker/runtime/interviewFinalizationModel.ts";
        import { cascadeStandIns } from "./worker/providers/cascade/testing/standIns.ts";
        import { standInInterviewResponse, standInOpening } from "./worker/runtimeLocalInterviewScript.ts";
        const finishing = { ...standInOpening, toolCalls: [{ name: "finish_interview", arguments: "{}" }] };
        /** Each scenario's stand-ins, by the prefix of the Run's name. */
        function script(name) {
          if (name.startsWith("expiry-speech"))
            return { frameIntervalMs: 200, responses: standInInterviewResponse };
          if (name.startsWith("expiry-answer"))
            return {
              frameIntervalMs: 20,
              responses: standInInterviewResponse,
              utterances: [${JSON.stringify(longAnswer)}],
              finalizeDelayMs: name.startsWith("expiry-answer-stop") ? 400 : 0,
            };
          // The opening's model response holds open after its first text, so the interviewing
          // deadline or Stop cuts it while it is spoken.
          if (name.startsWith("cut-"))
            return { frameIntervalMs: 200, responses: [{ text: ["Welcome. ", "What did you think of the "], hold: true }] };
          // The closing's nine frames take 5.4 s to synthesize, past its 3 s deadline.
          if (name.startsWith("deadline-synthesis"))
            return { frameIntervalMs: 600, responses: [finishing] };
          if (name.startsWith("failure-synthesis"))
            return {
              frameIntervalMs: 200,
              responses: [finishing],
              synthesisFailure: { text: ${JSON.stringify("Thank you. Goodbye.")}, code: "stand_in_synthesis_failed" },
            };
          // Synthesis runs ahead of playback, as a real provider's does: the closing is delivered
          // well before it has played, so waiting from its delivery would end too soon.
          if (name.startsWith("goodbye-played"))
            return { frameIntervalMs: 20, responses: [finishing] };
          // Speech streams slowly enough that the finish lands while the reply that made it is
          // still being synthesized, and Stop, a failure or a restart while the closing is.
          return { frameIntervalMs: 200, responses: [finishing] };
        }
        export class Controller extends InterviewRuntimeController {
          constructor(ctx, env) {
            const name = ctx.id.name ?? "";
            const requests = [];
            const synthesized = [];
            const audio = [];
            const cancelled = [];
            const providers = cascadeStandIns({
              ...script(name),
              onRequest: (request) => requests.push(request),
              onSynthesis: (text) => synthesized.push(text),
              onAudio: () => audio.push(Date.now()),
              onCancel: (work) => cancelled.push({ work, at: Date.now() }),
            });
            super(ctx, env, {
              assembly: createRuntimeHostAssembly({ cascadeProviders: providers }),
              delivery: createRuntimeHostDelivery(env),
            });
            this.cascadeEvidence = () => ({ requests, synthesized, audio, cancelled });
            // The deadline scenarios hold the platform's alarms, so only the session's own
            // bound can end the closing at its deadline; the test runs them afterwards.
            this.alarmsHeld = name.startsWith("deadline-");
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
            if (path !== "/result") return super.fetch(request);
            await this.ready;
            const aggregate = this.repository.readAggregate(this.repository.requireState());
            return Response.json({
              turns: readFinalizationTranscriptTurns(aggregate),
              result: aggregate.applicationTranscriptProof.result ?? null,
              node: aggregate.conversationNodeExecution ?? null,
              // When each reply's delivered audio finishes playing, as its execution reported it.
              playback: aggregate.providerResponses.map(({ responseId, playbackEndsAt }) => ({
                responseId,
                playbackEndsAt: playbackEndsAt ?? null,
              })),
              effects: aggregate.state.effects,
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
  persistence = await mkdtemp(join(tmpdir(), "cascade-goodbye-"));
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
  synthesized: z.array(z.string()),
  audio: z.array(z.number()),
  cancelled: z.array(z.object({ work: z.string(), at: z.number() })),
});
async function cascadeEvidence(runId: string) {
  return evidenceSchema.parse(await (await request(runId, "/cascade")).json());
}

/** The Run's Conversation node execution: its closing deadline and its dispatch's outcome. */
const nodeSchema = z
  .object({
    closingCutoffAt: z.number().optional(),
    // An interviewing node may hold no dispatch.
    dispatch: z
      .object({ status: z.string(), limitation: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const resultSchema = z.object({
  turns: z.array(z.object({ role: z.string(), text: z.string() })),
  result: z.object({ outcome: z.string(), reason: z.string().optional() }).passthrough(),
  node: nodeSchema,
  effects: z.array(z.object({ kind: z.string(), status: z.string() }).passthrough()),
  items: z.array(z.object({ text: z.string().nullable(), visitId: z.string().nullable() })),
});
/** The Run's current Conversation visit, readable while it is live. */
async function readVisitId(runId: string) {
  return z.object({ visitId: z.string() }).parse(await (await request(runId, "/result")).json())
    .visitId;
}
async function readResult(runId: string) {
  return resultSchema.parse(await (await request(runId, "/result")).json());
}
/** The Run's Conversation node execution, readable before the Run published a result. */
async function readNode(runId: string) {
  return nodeSchema.parse(
    z.object({ node: z.json() }).parse(await (await request(runId, "/result")).json()).node,
  );
}

/** When Goodbye was entered and when Runtime holds the reply's delivered audio played out. */
async function readPlayback(runId: string, responseId: string | undefined) {
  const saved = z
    .object({
      node: z.object({ reservation: z.object({ at: z.number() }) }),
      playback: z.array(
        z.object({ responseId: z.string(), playbackEndsAt: z.number().nullable() }),
      ),
    })
    .parse(await (await request(runId, "/result")).json());
  return {
    enteredAt: saved.node.reservation.at,
    playbackEndsAt: saved.playback.find((response) => response.responseId === responseId)
      ?.playbackEndsAt,
  };
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

/** Starts a Cascade Goodbye Run, attaches its media as the Lab page does, and reports readiness. */
function goLive(
  runId: string,
  durations: Readonly<{ interviewingMs?: number; closingMs?: number }> = {},
) {
  return client.goLive(runId, {
    selection: goodbyeCascadeSelection,
    agentInput: sampleGoodbyeInput({
      interviewingDurationMs: durations.interviewingMs ?? 60_000,
      maximumClosingDurationMs: durations.closingMs ?? 45_000,
    }),
  });
}

/** Each output's messages in order, by output. */
function outputs(received: readonly Received[]) {
  const byOutput = new Map<string, string[]>();
  for (const { message } of received)
    if ("outputId" in message)
      byOutput.set(message.outputId, [...(byOutput.get(message.outputId) ?? []), message.type]);
  return [...byOutput.values()];
}

/** The identities of the outputs the browser was offered, in order. */
function outputIds(received: readonly Received[]) {
  return received.flatMap(({ message }) =>
    message.type === "output.started" ? [message.outputId] : [],
  );
}

/** When the browser received a message of this type for this output. */
function receivedAt(received: readonly Received[], type: string, outputId: string | undefined) {
  return received.find(
    ({ message }) =>
      message.type === type && "outputId" in message && message.outputId === outputId,
  )?.at;
}

/** An output's messages without its numbered audio, which the stand-in's timing decides. */
const lifecycle = (messages: readonly string[] | undefined) =>
  messages?.filter((type) => type !== "output.audio");

/** Waits until the closing, the Run's second output, streams audio, and returns its identity. */
async function closingPlays(received: readonly Received[]) {
  await expect
    .poll(() => outputs(received)[1]?.filter((type) => type === "output.audio").length ?? 0, {
      timeout: 15_000,
    })
    .toBeGreaterThan(1);
  return outputIds(received)[1];
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

/** 100 ms of speech-level tone in the profile's input format. */
function speechChunk() {
  const samples = cascadeMediaInputFormat.sampleRate / 10;
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
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
 * Speaks two seconds of the long answer into the first listening opportunity, as the Lab page
 * sends microphone audio, and no silence after it: only a finalization ends it.
 */
async function answerInProgress(
  received: readonly Received[],
  socket: Readonly<{ send(data: string): void }>,
) {
  await expect
    .poll(() => received.filter(({ message }) => message.type === "input.listening").length, {
      timeout: 15_000,
    })
    .toBe(1);
  const listening = received.find(({ message }) => message.type === "input.listening")?.message;
  if (listening?.type !== "input.listening") throw new Error("Missing the listening opportunity");
  const audio = speechChunk();
  for (let chunk = 0; chunk < 20; chunk += 1)
    socket.send(
      JSON.stringify({ type: "input.audio", opportunityId: listening.opportunityId, audio }),
    );
}

const goodbyeTransitions = [
  { from: "interviewing", to: "goodbye" },
  { from: "goodbye", to: "complete" },
];

describe("Cascade Goodbye on the real Runtime host", () => {
  it("enters Goodbye on finish_interview and ends as the agent requested once the closing is delivered", async () => {
    const { received } = await goLive("goodbye-entry");
    await expect
      .poll(async () => readState("goodbye-entry"), { timeout: 25_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "agent_requested_end" } });

    // Speech in the reply that called finish_interview is cancelled at Goodbye entry; the
    // closing follows it and is delivered to its end. No listening is offered. Runtime sends the
    // closing's end before the Run ends, but the browser receives it on its media attachment,
    // which reading the Run's state does not wait for.
    await expect
      .poll(() => lifecycle(outputs(received)[1]), { timeout: 5_000 })
      .toEqual(["output.started", "output.ended"]);
    const [finishing, closing] = outputs(received);
    expect(lifecycle(finishing)).toEqual(["output.started", "output.cancelled"]);
    expect(closing?.filter((type) => type === "output.audio").length).toBeGreaterThan(0);
    expect(received.some(({ message }) => message.type === "input.listening")).toBe(false);

    // Interviewing's is the only model request: the closing's sentence goes to speech output.
    const evidence = await cascadeEvidence("goodbye-entry");
    expect(evidence.synthesized.at(-1)).toBe(sampleClosingSentence);
    expect(evidence.requests).toEqual([
      {
        history: [],
        instructions: { kind: "literal", text: sampleGoodbyeInterviewInstructions },
        operationalInstructions: "",
        tools: [
          expect.objectContaining({
            name: "finish_interview",
            description: sampleFinishDescription,
          }),
        ],
        toolChoice: "auto",
      },
    ]);

    // The closing is the last interviewer turn, and the Goodbye completed without a warning.
    const saved = await readResult("goodbye-entry");
    expect(saved.turns.at(-1)).toEqual({ role: "conversationAgent", text: "Thank you. Goodbye." });
    expect(saved.result).toMatchObject({ outcome: "completed", reason: "agent_requested_end" });
    expect((await readState("goodbye-entry")).completion?.warnings).toEqual([]);
    expect(await records("goodbye-entry", "conversation.transition")).toEqual(goodbyeTransitions);
    expect(await records("goodbye-entry", "conversation.closing_assessment")).toEqual([
      expect.objectContaining({ warnings: [], endReason: "agent_requested_end" }),
    ]);
    // Each step change interrupts the work of the step it leaves: no execution failed.
    expect(await records("goodbye-entry", "runtime.execution_exit")).toEqual([]);
  }, 40_000);

  it("contains the closing at Stop: its playback clears and no provider work follows", async () => {
    const { received } = await goLive("goodbye-contained");
    const closing = await closingPlays(received);
    expect(
      (await post("goodbye-contained", "/complete", { endReason: "participant_stopped" })).ok,
    ).toBe(true);
    const stoppedAt = Date.now();
    await expect
      .poll(() => lifecycle(outputs(received)[1]), { timeout: 5_000 })
      .toEqual(["output.started", "output.cancelled"]);
    expect(
      (receivedAt(received, "output.cancelled", closing) ?? Infinity) - stoppedAt,
    ).toBeLessThan(1_000);
    // The reason the finish reserved stays; the cut closing is the recorded limitation.
    await expect
      .poll(async () => readState("goodbye-contained"), { timeout: 20_000 })
      .toMatchObject({
        phase: "ended",
        completion: { endReason: "agent_requested_end", warnings: ["closing_interrupted"] },
      });
    // Nothing follows the closing's cancellation, and the stand-ins synthesized nothing after
    // Stop was admitted and received no further request.
    const cancelled = received.findIndex(
      ({ message }) => message.type === "output.cancelled" && message.outputId === closing,
    );
    expect(received.slice(cancelled + 1)).toEqual([]);
    const evidence = await cascadeEvidence("goodbye-contained");
    expect(evidence.audio.filter((at) => at > stoppedAt)).toEqual([]);
    expect(evidence.requests).toHaveLength(1);
    // The sentence was submitted for synthesis whole, so it stays the closing's turn.
    expect((await readResult("goodbye-contained")).turns.at(-1)).toEqual({
      role: "conversationAgent",
      text: sampleClosingSentence,
    });
  }, 40_000);

  // Cascade delivers a closing as it is synthesized, so it ends on the media attachment before
  // the browser has played it. Runtime announces the end only once it had time to play: when
  // its last chunk finishes, each chunk playing once it arrived, plus the margin. Runtime can
  // only tell when it sent each chunk, and the margin covers the way to the browser. That way's
  // length depends on the machine, so no bound below depends on it, short of the margin itself.
  it("announces the end only once the delivered closing had time to play, plus the margin, and keeps its attachment until then", async () => {
    const { received, socket } = await goLive("goodbye-played");
    let attachmentClosedAt: number | null = null;
    socket.addEventListener("close", () => (attachmentClosedAt ??= Date.now()));
    await expect
      .poll(async () => readState("goodbye-played"), { timeout: 25_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "agent_requested_end" } });
    const closing = outputIds(received)[1];
    let audioMs = 0;
    let playedAt = 0;
    for (const { at, message } of received)
      if (message.type === "output.audio" && message.outputId === closing) {
        const chunkMs =
          (Buffer.from(message.audio, "base64").length / 2 / cascadeMediaOutputFormat.sampleRate) *
          1_000;
        audioMs += chunkMs;
        playedAt = Math.max(playedAt, at) + chunkMs;
      }
    const endingStartedAt = (await readState("goodbye-played")).completion?.endingStartedAt ?? 0;
    const { enteredAt, playbackEndsAt } = await readPlayback("goodbye-played", closing);
    // Runtime's playback end accounts for the whole closing: it began no sooner than Goodbye's
    // entry, and Runtime sent each chunk no later than the browser received it.
    expect(playbackEndsAt).toBeGreaterThanOrEqual(enteredAt + audioMs);
    expect(playbackEndsAt).toBeLessThanOrEqual(Math.ceil(playedAt));
    // The end follows that playback end by the margin, and the browser had played the closing
    // through before it.
    expect(endingStartedAt).toBeGreaterThanOrEqual((playbackEndsAt ?? Infinity) + playbackMarginMs);
    expect(endingStartedAt).toBeGreaterThanOrEqual(playedAt);
    expect(lifecycle(outputs(received)[1])).toEqual(["output.started", "output.ended"]);
    expect(attachmentClosedAt ?? Infinity).toBeGreaterThanOrEqual(endingStartedAt);
    expect((await readState("goodbye-played")).completion?.warnings).toEqual([]);
  }, 40_000);

  it("cuts the delivered closing at once when Stop lands during its margin, keeping the reserved reason", async () => {
    const { received } = await goLive("goodbye-margin-stop");
    const closing = await closingPlays(received);
    await expect
      .poll(() => receivedAt(received, "output.ended", closing), { timeout: 10_000 })
      .toBeDefined();
    expect((await readState("goodbye-margin-stop")).phase).toBe("live");
    expect(
      (await post("goodbye-margin-stop", "/complete", { endReason: "participant_stopped" })).ok,
    ).toBe(true);
    const stoppedAt = Date.now();
    await expect
      .poll(async () => readState("goodbye-margin-stop"), { timeout: 20_000 })
      .toMatchObject({
        phase: "ended",
        completion: { endReason: "agent_requested_end", warnings: [] },
      });
    const endingStartedAt =
      (await readState("goodbye-margin-stop")).completion?.endingStartedAt ?? Infinity;
    expect(endingStartedAt - stoppedAt).toBeLessThan(1_000);
  }, 40_000);

  // What the closing does at entry, during speech or an answer, is the kit's closing contract
  // (`worker/providers/cascade/turnTaking.test.ts`). These expiry scenarios keep what Goodbye
  // adds: interviewing time expiring enters Goodbye, whose closing ends the interview.
  it("enters Goodbye when interviewing time expires during interviewer speech, and ends once its closing is delivered", async () => {
    await goLive("expiry-speech", { interviewingMs: 3_000 });
    await expect
      .poll(async () => readState("expiry-speech"), { timeout: 25_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "timebox_reached" } });
    // The opening was still playing at expiry; the closing follows it. What the browser receives
    // is the kit's contract, whose test waits for the closing's delivered end.
    const saved = await readResult("expiry-speech");
    expect(saved.turns.map(({ role }) => role)).toEqual(["conversationAgent", "conversationAgent"]);
    expect(saved.turns.at(-1)).toEqual({ role: "conversationAgent", text: "Thank you. Goodbye." });
    expect(saved.result).toMatchObject({ outcome: "completed", reason: "timebox_reached" });
    expect((await readState("expiry-speech")).completion?.warnings).toEqual([]);
    expect(await records("expiry-speech", "conversation.transition")).toEqual(goodbyeTransitions);
  }, 40_000);

  // A reply cut by the deadline's closing keeps its text, as Stop keeps it.
  it.each(["expiry", "stop"] as const)(
    "keeps the text of a reply cut by the closing under its own step (%s)",
    async (cut) => {
      const runId = `cut-${cut}`;
      const { received } = await goLive(runId, {
        interviewingMs: cut === "expiry" ? 4_000 : 60_000,
      });
      // The opening is spoken while its model response is still open.
      await expect
        .poll(() => outputs(received)[0]?.filter((type) => type === "output.audio").length ?? 0, {
          timeout: 15_000,
        })
        .toBeGreaterThan(0);
      const interviewing = await readVisitId(runId);
      if (cut === "stop")
        expect((await post(runId, "/complete", { endReason: "participant_stopped" })).ok).toBe(
          true,
        );
      await endedWith(runId, cut === "expiry" ? "timebox_reached" : "participant_stopped");
      expect(lifecycle(outputs(received)[0])).toEqual(["output.started", "output.cancelled"]);
      const saved = await readResult(runId);
      // The text submitted before the cut is kept under the interviewing step.
      const kept = { text: "Welcome. What did you think of the", visitId: interviewing };
      expect(saved.items[0]).toEqual(kept);
      if (cut === "expiry") {
        expect(saved.items.map(({ text }) => text)).toEqual([kept.text, "Thank you. Goodbye."]);
        expect(saved.items[1]?.visitId).not.toBe(interviewing);
        expect(saved.result).toMatchObject({ outcome: "completed", reason: "timebox_reached" });
      } else {
        expect(saved.items).toEqual([kept]);
        expect(saved.turns).toEqual([{ role: "conversationAgent", text: kept.text }]);
      }
    },
    40_000,
  );

  it("enters Goodbye when interviewing time expires during an answer, keeping the answer before its closing", async () => {
    const { received, socket } = await goLive("expiry-answer", { interviewingMs: 5_000 });
    await answerInProgress(received, socket);
    await expect
      .poll(async () => readState("expiry-answer"), { timeout: 25_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "timebox_reached" } });
    const saved = await readResult("expiry-answer");
    // The two seconds spoken settle once, as the answer's spoken prefix, before the closing.
    expect(saved.turns.slice(1)).toEqual([
      { role: "participant", text: "The talks were clear" },
      { role: "conversationAgent", text: "Thank you. Goodbye." },
    ]);
    expect(saved.result).toMatchObject({ outcome: "completed", reason: "timebox_reached" });
    expect((await readState("expiry-answer")).completion?.warnings).toEqual([]);
    expect(await records("expiry-answer", "conversation.transition")).toEqual(goodbyeTransitions);
    // Every provider operation reported its usage, the answer's speech input with the audio its
    // listening opportunity forwarded: the usage is complete (#1061).
    const { runtimeUsage } = z
      .object({
        runtimeUsage: z.object({
          completeness: z.string(),
          observations: z.array(z.object({ componentRole: z.string() }).passthrough()),
        }),
      })
      .parse(saved.result);
    expect(runtimeUsage.completeness).toBe("complete");
    expect(runtimeUsage.observations).toContainEqual(
      expect.objectContaining({ componentRole: "speech_to_text", measure: "input_audio" }),
    );
  }, 40_000);

  it("keeps the expiry's reason and the answer when Stop lands while the answer settles", async () => {
    const { received, socket } = await goLive("expiry-answer-stop", { interviewingMs: 5_000 });
    await answerInProgress(received, socket);
    // Goodbye is entered and its finalization of the answer is held: Stop lands meanwhile.
    await expect
      .poll(async () => (await records("expiry-answer-stop", "conversation.transition")).length, {
        timeout: 15_000,
      })
      .toBe(1);
    expect(
      (await post("expiry-answer-stop", "/complete", { endReason: "participant_stopped" })).ok,
    ).toBe(true);
    await endedWith("expiry-answer-stop", "timebox_reached");
    const saved = await readResult("expiry-answer-stop");
    // The answer still settles once for Ending; no closing is requested or spoken.
    expect(saved.turns.slice(1)).toEqual([{ role: "participant", text: "The talks were clear" }]);
    expect(saved.result).toMatchObject({ outcome: "completed", reason: "timebox_reached" });
    expect((await readState("expiry-answer-stop")).completion?.warnings).toEqual([
      "closing_interrupted",
    ]);
    // The closing's claim of the final input was settled as dispatched, not left in flight.
    expect(saved.effects.filter(({ kind }) => kind === "close_input")).toEqual([
      expect.objectContaining({ status: "dispatched" }),
    ]);
    expect((await cascadeEvidence("expiry-answer-stop")).requests).toHaveLength(1);
    expect(outputIds(received)).toHaveLength(1);
  }, 60_000);

  it("cancels the closing's synthesis at its own deadline and keeps the reserved reason", async () => {
    const runId = "deadline-synthesis";
    const { received } = await goLive(runId, { closingMs: 3_000 });
    await expect.poll(() => outputIds(received).length, { timeout: 15_000 }).toBe(2);
    const closing = outputIds(received)[1];
    const startedAt = receivedAt(received, "output.started", closing) ?? 0;
    // The platform's alarms are held: the session's own bound cancels the held step at the
    // node's deadline, and its report starts Ending.
    const closingCancelledAt = async () =>
      (await cascadeEvidence(runId)).cancelled.find(
        (entry) => entry.work === "synthesis" && entry.at >= startedAt,
      )?.at;
    await expect.poll(closingCancelledAt, { timeout: 10_000 }).toBeDefined();
    await expect
      .poll(async () => (await readState(runId)).phase, { timeout: 5_000 })
      .not.toBe("live");
    const cancelledAt = (await closingCancelledAt()) ?? 0;
    expect(cancelledAt - startedAt).toBeGreaterThanOrEqual(2_500);
    expect(cancelledAt - startedAt).toBeLessThan(4_000);
    expect(lifecycle(outputs(received)[1])).toEqual(["output.started", "output.cancelled"]);

    await endedWith(runId, "agent_requested_end");
    expect((await readState(runId)).completion?.warnings).toEqual(["closing_cutoff_exhausted"]);
    const saved = await readResult(runId);
    expect(saved.node.dispatch).toMatchObject({
      status: "failed",
      limitation: "closing_cutoff_exhausted",
    });
    expect(await records(runId, "conversation.closing_assessment")).toEqual([
      expect.objectContaining({
        warnings: ["closing_cutoff_exhausted"],
        endReason: "agent_requested_end",
      }),
    ]);
    // No audio follows the cancellation, and the closing made no model request.
    const evidence = await cascadeEvidence(runId);
    expect(evidence.audio.filter((at) => at > cancelledAt)).toEqual([]);
    expect(evidence.requests).toHaveLength(1);
  }, 60_000);

  it("records a failed closing as a closing warning when its synthesis fails", async () => {
    const { received } = await goLive("failure-synthesis");
    await expect
      .poll(async () => readState("failure-synthesis"), { timeout: 20_000 })
      .toMatchObject({
        phase: "ended",
        completion: { endReason: "agent_requested_end", warnings: ["closing_response_failed"] },
      });
    expect(lifecycle(outputs(received)[1])).toEqual(["output.started", "output.failed"]);
    const saved = await readResult("failure-synthesis");
    // The failure keeps the finish's reason; the outcome says the Conversation was cut short.
    expect(saved.result.outcome).toBe("interrupted");
    expect(saved.node.dispatch).toMatchObject({
      status: "failed",
      limitation: "stand_in_synthesis_failed",
    });
    expect(await records("failure-synthesis", "conversation.closing_assessment")).toEqual([
      expect.objectContaining({
        warnings: ["closing_response_failed"],
        endReason: "agent_requested_end",
      }),
    ]);
    expect((await cascadeEvidence("failure-synthesis")).requests).toHaveLength(1);
  }, 40_000);

  it("records a failed closing at once when the media is lost during it", async () => {
    const { received, socket } = await goLive("failure-media");
    const closing = await closingPlays(received);
    const detachedAt = Date.now();
    socket.close(4000, "network_lost");
    await endedWith("failure-media", "agent_requested_end");
    // The loss is the closing's failure at once: no Stop is awaited.
    const ended = await readState("failure-media");
    expect(ended.completion?.endingStartedAt ?? Infinity).toBeLessThan(detachedAt + 2_000);
    expect(ended.completion?.warnings).toEqual(["closing_response_failed"]);
    const saved = await readResult("failure-media");
    expect(saved.result.outcome).toBe("interrupted");
    expect(saved.node.dispatch).toMatchObject({
      status: "failed",
      limitation: "cascade_media_detached",
    });
    // The closing's synthesis stopped when the media was lost.
    const evidence = await cascadeEvidence("failure-media");
    expect(evidence.cancelled).toContainEqual(expect.objectContaining({ work: "synthesis" }));
    expect(evidence.audio.filter((at) => at > detachedAt + 500)).toEqual([]);
    expect(closing).toBeDefined();
  }, 60_000);

  it("replays no closing and renews no deadline after a Runtime restart during the closing", async () => {
    const { received } = await goLive("restart-closing");
    await closingPlays(received);
    const cutoff = (await readNode("restart-closing")).closingCutoffAt ?? 0;
    // A new platform is a new Runtime instance over the same Durable Object storage.
    await platform.dispose();
    platform = createPlatform();
    await endedWith("restart-closing", "agent_requested_end");
    const ended = await readState("restart-closing");
    expect(ended.completion?.endingStartedAt ?? Infinity).toBeLessThan(cutoff);
    expect(ended.completion?.warnings).toEqual(["closing_recovery_uncertain"]);
    // The restarted instance's stand-ins received no request and synthesized nothing.
    expect(await cascadeEvidence("restart-closing")).toEqual({
      requests: [],
      synthesized: [],
      audio: [],
      cancelled: [],
    });
  }, 90_000);
});
