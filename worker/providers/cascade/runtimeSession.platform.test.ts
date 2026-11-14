import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { z } from "zod";
import { platformBuildOptions } from "../../shared/testing/platformBuild.ts";
import { cascadeMediaInputFormat } from "../../shared/contracts/cascadeMedia.ts";

/**
 * The Cascade kit's Runtime adapter through Runtime's session contract on workerd: a Worker
 * holds one adapter per Run name, with an in-memory session record, a recording report sink
 * and the Run's native work owner; the providers are the kit's scripted stand-ins. The session
 * is configured by a test Conversation of its own: it opens with `talk`, enters `next` as a
 * conversing phase and `close` as the closing, whose text is its closing sentence. The browser attaches its media over a real
 * WebSocket.
 */
let platform: Miniflare;

beforeAll(async () => {
  const bundle = await build({
    ...platformBuildOptions,
    stdin: {
      contents: `import { Cause, Effect } from "effect";
        import { CascadeRuntimeSession } from "./worker/providers/cascade/runtimeSession.ts";
        import { prepareCascadeSettings } from "./worker/providers/cascade/preparedSession.ts";
        import { cascadeStandIns } from "./worker/providers/cascade/testing/standIns.ts";
        import { NativeWorkOwner } from "./worker/runtime/nativeWorkOwner.ts";
        const runs = new Map();
        /** A test Conversation's content: its literal instructions, with no tool. */
        const content = (input) => ({
          instructions: { kind: "literal", text: input.text }, operationalInstructions: "", tools: [],
        });
        const configuration = {
          opening: { state: "talk", content },
          nodes: {
            next: { operation: "conversing", content },
            close: {
              operation: "closing",
              content: (input) => ({ sentence: input.text }),
              completed: (responseId) => ({ kind: "closed", responseId }),
            },
          },
        };
        /** The model's responses by the Run's name. */
        function responses(name) {
          // The held opening is still being spoken when the owner closes.
          if (name.startsWith("held")) return [{ text: ["Welcome. ", "Tell me "], hold: true }];
          if (name.startsWith("nodes"))
            return [{ text: ["Welcome."] }, { text: ["Thank you."] }, { text: ["Question two?"] }];
          return [{ text: ["Welcome."] }];
        }
        function create(name) {
          const evidence = {
            facts: [], cancelled: [], failures: [], requests: [], synthesized: [], attributed: [], completed: [], nodeFailures: [],
          };
          const record = {
            runId: name, sessionId: null, generation: 0, eventCount: 0,
            initialConnection: true, connectionRequired: true,
            canStartConversation: true, canSendOpening: true, browserMediaReady: true,
            openingState: "pending",
          };
          const storage = {
            read: () => record,
            claimOpening: () => { record.openingState = "claimed"; return true; },
            markOpeningSent: () => { record.openingState = "sent"; },
            recordSessionIdentity: (input) => { record.sessionId = input.sessionId; },
            recordSessionReply() {},
            setGeneration: (_runId, generation) => { record.generation = generation; },
            markStarted() {}, markClosed() {}, scheduleWake() {},
            hasEventIdentity: () => false,
          };
          const owner = new NativeWorkOwner((cause) => {
            if (!Cause.hasInterruptsOnly(cause)) evidence.failures.push(Cause.pretty(cause));
          });
          const session = new CascadeRuntimeSession({
            providers: cascadeStandIns({
              responses: responses(name),
              frameIntervalMs: 20,
              utterances: [{ text: "It was fine.", durationSeconds: 1 }],
              onRequest: (request) => evidence.requests.push(request),
              onSynthesis: (text) => evidence.synthesized.push(text),
              onCancel: (work) => evidence.cancelled.push(work),
            }),
            storage,
            events: {
              notifyControl() {}, recordStartup() {}, recordLiveDegradation() {},
              executionDiagnostics: () => () => undefined,
            },
            backgroundWork: { waitUntil() {} },
            sink: async (fact) => { evidence.facts.push(fact); },
            execution: { run: (operation) => owner.run(operation), supervise: (operation) => owner.supervise(operation) },
          }, configuration);
          const run = { evidence, owner, session };
          runs.set(name, run);
          return run;
        }
        // The Runs live in one Durable Object, as a Run's session does, so the media attachment
        // accepted in one request is usable from the next.
        export class Runs {
          async fetch(request) {
          const url = new URL(request.url);
          const name = url.searchParams.get("run") ?? "";
          const run = runs.get(name) ?? create(name);
          switch (url.pathname) {
            case "/start": {
              return Response.json(await Effect.runPromise(run.session.start({
                runId: name, connection: {}, content: content({ text: "Say Welcome." }),
                settings: prepareCascadeSettings("cascade-v1/test", { reasoningEffort: null }),
                settingsSummary: {},
              })));
            }
            case "/attachment": return run.session.attachBrowser(request);
            case "/enter": {
              // Runtime's dispatch of one state, recording what the session reports through it.
              const state = url.searchParams.get("state") ?? "";
              run.session.enterNode({
                state, input: { text: url.searchParams.get("text") ?? "" },
                identity: {}, deadlineAt: Date.now() + 5_000, clock: () => Date.now(),
                reporter: { report: (event) => ({ state, event }), isCurrent: () => true },
                onComplete: async (report) => { run.evidence.completed.push(report); },
                onFailure: async (reason) => { run.evidence.nodeFailures.push(reason); },
                observeOutputIdentity: (outputId) => { run.evidence.attributed.push(outputId); },
              });
              return Response.json({ ok: true });
            }
            case "/operate": {
              // One of Ending's steps, as Runtime dispatches it; an input closure holds no answer.
              const kind = url.searchParams.get("kind") ?? "";
              return Response.json(run.session.sendFinalizationOperation({ kind, commandId: name + ":" + kind, heldItemId: null }));
            }
            case "/release": return Response.json(await run.session.release(null));
            case "/close-owner": await run.owner.dispose(); return Response.json({ ok: true });
            case "/drain": await run.session.drain(); return Response.json({ ok: true });
            default: return Response.json({
              ...run.evidence,
              connected: run.session.connected,
              prefix: run.session.sampleReceiptPrefix(),
            });
          }
          }
        }
        export default { fetch: (request, env) => env.RUNS.getByName("runs").fetch(request) };`,
      resolveDir: process.cwd(),
    },
  });
  platform = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]?.text ?? "",
    compatibilityDate: "2026-06-05",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    durableObjects: { RUNS: { className: "Runs" } },
  });
}, 30_000);

afterAll(async () => {
  await platform?.dispose();
});

const order = z.object({ generation: z.number(), sequence: z.number() });
const evidenceSchema = z.object({
  facts: z.array(
    z.object({
      kind: z.string(),
      observation: z
        .object({
          kind: z.string(),
          generation: z.number(),
          sequence: z.number(),
          commandId: z.string().optional(),
          transcriptItems: z.array(z.object({ text: z.string() })).optional(),
        })
        .optional(),
    }),
  ),
  cancelled: z.array(z.string()),
  failures: z.array(z.string()),
  requests: z.array(
    z.object({ instructions: z.json(), history: z.array(z.json()), toolChoice: z.json() }),
  ),
  synthesized: z.array(z.string()),
  attributed: z.array(z.string()),
  completed: z.array(z.json()),
  nodeFailures: z.array(z.string()),
  connected: z.boolean(),
  prefix: z.object({ receivedOrder: order.nullable(), processedThroughOrder: order.nullable() }),
});

async function evidence(run: string) {
  return evidenceSchema.parse(
    await (await platform.dispatchFetch(`https://adapter.test/?run=${run}`)).json(),
  );
}

/** Starts the session and attaches the browser's media, keeping each message it receives. */
async function attach(run: string) {
  const started = await platform.dispatchFetch(`https://adapter.test/start?run=${run}`);
  expect(await started.json()).toMatchObject({ ok: true });
  const response = await platform.dispatchFetch(`https://adapter.test/attachment?run=${run}`, {
    headers: { Upgrade: "websocket" },
  });
  const socket = response.webSocket;
  if (socket === null) throw new Error(`attachment refused: ${String(response.status)}`);
  const received: string[] = [];
  const opportunities: string[] = [];
  let closed = false;
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = z
      .object({ type: z.string(), opportunityId: z.string().optional() })
      .parse(JSON.parse(event.data));
    received.push(message.type);
    if (message.type === "input.listening" && message.opportunityId !== undefined)
      opportunities.push(message.opportunityId);
  });
  socket.addEventListener("close", () => {
    closed = true;
  });
  socket.accept();
  /** The participant answers in the last opportunity: one second of speech, then silence. */
  const answer = () => {
    const opportunityId = opportunities.at(-1);
    if (opportunityId === undefined) throw new Error("no listening opportunity is open");
    for (const speech of [...Array<boolean>(10).fill(true), ...Array<boolean>(10).fill(false)])
      socket.send(
        JSON.stringify({ type: "input.audio", opportunityId, audio: inputChunk(speech) }),
      );
  };
  return { received, answer, closed: () => closed };
}

/** 100 ms of the profile's input audio: a speech-level tone, or silence. */
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

describe("Cascade Runtime adapter", () => {
  it("stops the session's work and releases the media attachment when the Run's native work owner closes", async () => {
    const media = await attach("held-owner-close");
    await expect.poll(() => media.received).toContain("output.audio");
    expect((await evidence("held-owner-close")).connected).toBe(true);

    await platform.dispatchFetch("https://adapter.test/close-owner?run=held-owner-close");
    await expect.poll(media.closed).toBe(true);
    // The output in flight was cancelled before the attachment closed.
    expect(media.received.at(-1)).toBe("output.cancelled");
    const after = await evidence("held-owner-close");
    expect(after.cancelled).toEqual(expect.arrayContaining(["model", "synthesis"]));
    expect(after.connected).toBe(false);
    expect(after.failures).toEqual([]);
  });

  it("cancels the output in flight at release and reports its cancellation in the Run's generation", async () => {
    const media = await attach("held-release");
    await expect.poll(() => media.received).toContain("output.audio");

    await platform.dispatchFetch("https://adapter.test/release?run=held-release");
    await expect.poll(media.closed).toBe(true);
    expect(media.received.at(-1)).toBe("output.cancelled");
    const cancellations = async () =>
      (await evidence("held-release")).facts.flatMap((fact) =>
        fact.observation?.kind === "reply_cancelled" ? [fact.observation] : [],
      );
    await expect.poll(async () => (await cancellations()).length).toBe(1);
    const [cancellation] = await cancellations();
    expect(cancellation?.generation).toBe(1);
    // The text the output had submitted for synthesis is kept.
    expect(cancellation?.transcriptItems?.[0]?.text).toMatch(/^Welcome\./);
    expect((await evidence("held-release")).connected).toBe(false);
  });

  it("enters each configured state with its kit operation: a conversing phase with the history, a closing that says its sentence with no request", async () => {
    const media = await attach("nodes");
    await expect.poll(() => media.received).toContain("input.listening");
    media.answer();
    const listening = () => media.received.filter((type) => type === "input.listening");
    await expect.poll(listening, { timeout: 10_000 }).toHaveLength(2);
    const enter = (state: string, text: string) =>
      platform.dispatchFetch(
        `https://adapter.test/enter?run=nodes&state=${state}&text=${encodeURIComponent(text)}`,
      );
    await enter("next", "Ask question two.");
    await expect.poll(listening).toHaveLength(3);
    await enter("close", "Thank you. Goodbye.");
    await expect.poll(async () => (await evidence("nodes")).completed).toHaveLength(1);

    const { requests, synthesized, attributed, completed, nodeFailures } = await evidence("nodes");
    // The opening sends the prepared session's tool choice; a later phase sends `auto` with the
    // conversation so far, without the reply it cut at its entry; the closing sends no request,
    // and speech output says its sentence.
    const conversation = [
      { role: "interviewer", text: "Welcome." },
      { role: "participant", text: "It was fine." },
    ];
    expect(requests).toEqual([
      { instructions: { kind: "literal", text: "Say Welcome." }, history: [], toolChoice: "auto" },
      {
        instructions: { kind: "literal", text: "Say Welcome." },
        history: conversation,
        toolChoice: "auto",
      },
      {
        instructions: { kind: "literal", text: "Ask question two." },
        history: conversation,
        toolChoice: "auto",
      },
    ]);
    expect(synthesized.at(-1)).toBe("Thank you. Goodbye.");
    // Each node's reply is attributed to it, and the closing reports the configured event.
    expect(attributed).toHaveLength(2);
    expect(completed).toEqual([
      { state: "close", event: { kind: "closed", responseId: attributed[1] } },
    ]);
    expect(nodeFailures).toEqual([]);
    expect(media.received.filter((type) => type !== "output.audio")).toEqual([
      "output.started",
      "output.ended",
      "input.listening",
      "input.closed",
      "output.started",
      "output.ended",
      "input.listening",
      "input.closed",
      // The phase stops the reply delivered before its entry, which the browser may still play.
      "output.cancelled",
      "output.started",
      "output.ended",
      "input.listening",
      "input.closed",
      "output.started",
      "output.ended",
    ]);
  });

  it("reports nothing to settle when Ending's input closure finds no answer", async () => {
    // Written first for #977: before it, a closure that settled no answer reported nothing to
    // Runtime, and only the kit's own diagnostic recorded it. It now answers "nothing to
    // settle" under the step's command id, which Runtime reads in place of a quiet period.
    const media = await attach("silent-closure");
    await expect.poll(() => media.received).toContain("input.listening");
    await platform.dispatchFetch("https://adapter.test/drain?run=silent-closure");
    const before = (await evidence("silent-closure")).facts.length;

    const closed = await platform.dispatchFetch(
      "https://adapter.test/operate?run=silent-closure&kind=close_input",
    );
    expect(await closed.json()).toEqual({ status: "dispatched" });
    await expect.poll(() => media.received).toContain("input.closed");
    const answered = async () =>
      (await evidence("silent-closure")).facts
        .slice(before)
        .flatMap(({ observation }) => (observation === undefined ? [] : [observation]));
    await expect
      .poll(async () => (await answered()).map(({ kind }) => kind))
      .toContain("nothing_to_settle");
    await platform.dispatchFetch("https://adapter.test/drain?run=silent-closure");

    // The closed opportunity reports its speech-input usage, then the step answers.
    const reported = await answered();
    expect(reported.map(({ kind }) => kind)).toEqual([
      "session_activity_observed",
      "nothing_to_settle",
    ]);
    expect(reported.at(-1)).toMatchObject({
      kind: "nothing_to_settle",
      commandId: "silent-closure:close_input",
      generation: 1,
    });
    expect((await evidence("silent-closure")).failures).toEqual([]);
  });

  it("reports readiness, then numbers each observation in the Run's generation and delivers it in order", async () => {
    const media = await attach("receipts");
    await expect.poll(() => media.received).toContain("input.listening");
    await platform.dispatchFetch("https://adapter.test/drain?run=receipts");
    const { facts, prefix } = await evidence("receipts");

    expect(facts[0]?.kind).toBe("execution_ready");
    const observations = facts.flatMap((fact) =>
      fact.observation === undefined ? [] : [fact.observation],
    );
    expect(observations.map((observation) => observation.kind)).toEqual(
      expect.arrayContaining([
        "reply_started",
        "reply_delivery_started",
        "reply_generated",
        "reply_delivery_stopped",
      ]),
    );
    expect(observations.map(({ generation, sequence }) => ({ generation, sequence }))).toEqual(
      observations.map((_, index) => ({ generation: 1, sequence: index + 1 })),
    );
    // Each observation is followed by the drained prefix before the next one is delivered.
    expect(facts.slice(1).map((fact) => fact.kind)).toEqual(
      observations.flatMap(() => ["provider_observation", "message_queue_drained"]),
    );
    expect(prefix.processedThroughOrder).toEqual(prefix.receivedOrder);
    expect(prefix.receivedOrder).toEqual({ generation: 1, sequence: observations.length });
  });
});
