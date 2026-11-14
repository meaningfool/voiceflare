import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { z } from "zod";
import { originalCascadeSelection } from "../runtimeHostComposition.ts";
import { createInterviewConversationInput } from "./testing/interviewConversationPreset.ts";
import { platformBuildOptions } from "../shared/testing/platformBuild.ts";
import { cascadeRunClient } from "./testing/cascadeRunClient.ts";

/**
 * Cascade Original's opening through the real Runtime host on workerd: the Run's Durable
 * Object, its startup, Ending and media attachment are real; only the language-model and
 * speech-output providers are the controlled stand-ins.
 */
let platform: Miniflare;

beforeAll(async () => {
  const bundle = await build({
    ...platformBuildOptions,
    stdin: {
      contents: `import { InterviewRuntimeController } from "./worker/runtime/interviewRuntimeController.ts";
        import { createRuntimeHostDelivery } from "./worker/runtimeHostDelivery.ts";
        import { createRuntimeHostAssembly } from "./worker/runtimeHostComposition.ts";
        import { cascadeStandIns } from "./worker/providers/cascade/testing/standIns.ts";
        import { standInInterviewResponse } from "./worker/runtimeLocalInterviewScript.ts";
        import { openAiDriverOver, realtimeTestDriver } from "./worker/providers/openaiRealtime/testing/testDriver.ts";
        export class Controller extends InterviewRuntimeController {
          constructor(ctx, env) {
            const name = ctx.id.name ?? "";
            const requests = [];
            const realtime = [];
            let failClaim = name.startsWith("claim-failure");
            if (failClaim) {
              const exec = ctx.storage.sql.exec.bind(ctx.storage.sql);
              ctx.storage.sql.exec = (query, ...params) => {
                if (failClaim && query.includes("opening_state = 'claimed'"))
                  throw new Error("opening_claim_write_failed");
                return exec(query, ...params);
              };
            }
            // Once armed, the next save of a report from the execution fails.
            let failNextReportSave = false;
            if (name.startsWith("save-failure")) {
              const exec = ctx.storage.sql.exec.bind(ctx.storage.sql);
              ctx.storage.sql.exec = (query, ...params) => {
                if (failNextReportSave && query.includes("SET session_event_count")) {
                  failNextReportSave = false;
                  throw new Error("report_save_failed");
                }
                return exec(query, ...params);
              };
            }
            const providers = cascadeStandIns({
              responses: standInInterviewResponse,
              onRequest: (request) => requests.push(request),
              // A slow output lets End land while its audio is still streaming.
              frameIntervalMs: name.startsWith("stop-") ? 200 : 50,
            });
            const unexpected = (operation) => (...args) => {
              realtime.push(operation);
              return openAiDriverOver()[operation](...args);
            };
            super(ctx, env, {
              assembly: createRuntimeHostAssembly({
                cascadeProviders: providers,
                realtimeDriver: realtimeTestDriver({
                  createCall: unexpected("createCall"),
                  connectSideband: unexpected("connectSideband"),
                  hangUp: unexpected("hangUp"),
                }),
              }),
              delivery: createRuntimeHostDelivery(env),
            });
            this.cascadeEvidence = () => ({ requests, realtime, unsavedReportPending: failNextReportSave });
            this.failNextReportSave = () => { failNextReportSave = true; };
          }
          async fetch(request) {
            if (new URL(request.url).pathname === "/cascade")
              return Response.json(this.cascadeEvidence());
            if (new URL(request.url).pathname === "/fail-next-report-save") {
              this.failNextReportSave();
              return Response.json({ armed: true });
            }
            return super.fetch(request);
          }
        }
        export default { fetch(request, env) {
          return env.CONTROLLER.getByName(new URL(request.url).searchParams.get("controller")).fetch(request);
        }};`,
      resolveDir: process.cwd(),
    },
  });
  platform = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]?.text ?? "",
    compatibilityDate: "2026-06-05",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    durableObjects: { CONTROLLER: { className: "Controller", useSQLite: true } },
    bindings: { OPENAI_API_KEY: "sk-controlled-not-used" },
  });
}, 30_000);

afterAll(async () => {
  await platform?.dispose();
});

const prompt = "Say Welcome. Then ask what worked well at the event.";
const finishDescription = "Call this tool once the participant answered the question.";

const { request, post, start, state, attachLive, goLive } = cascadeRunClient(() => platform);
const run = {
  selection: originalCascadeSelection,
  agentInput: createInterviewConversationInput(prompt, finishDescription),
};

const evidenceSchema = z.object({
  requests: z.array(
    z.object({
      instructions: z.json(),
      operationalInstructions: z.string(),
      tools: z.array(z.object({ name: z.string(), description: z.string() })),
    }),
  ),
  realtime: z.array(z.string()),
  unsavedReportPending: z.boolean(),
});
async function cascadeEvidence(runId: string) {
  return evidenceSchema.parse(await (await request(runId, "/cascade")).json());
}

const diagnosticsSchema = z.object({
  records: z.array(z.object({ source: z.string(), type: z.string(), payloadJson: z.string() })),
});
/** The Run's retained Runtime records, each with its payload. */
async function allRecords(runId: string) {
  const { records } = diagnosticsSchema.parse(
    await (await request(runId, `/diagnostics?runId=${runId}`)).json(),
  );
  return records.map(({ source, type, payloadJson }) => ({
    source,
    type,
    payload: z.record(z.string(), z.json()).parse(JSON.parse(payloadJson)),
  }));
}
/** The payloads of the Run's retained Runtime records of one type. */
async function records(runId: string, type: string) {
  return (await allRecords(runId))
    .filter((record) => record.type === type)
    .map(({ payload }) => payload);
}

describe("Cascade Original opening on the real Runtime host", () => {
  it("streams the identified opening in order with an explicit end and ends at Stop", async () => {
    const [first, second] = await Promise.all([goLive("cascade-a", run), goLive("cascade-b", run)]);
    await expect
      .poll(() => first.received.some(({ message }) => message.type === "output.ended"), {
        timeout: 15_000,
      })
      .toBe(true);
    const messages = first.received.flatMap(({ message }) =>
      message.type.startsWith("output.") && "outputId" in message ? [message] : [],
    );
    const outputId = messages[0]?.type === "output.started" ? messages[0].outputId : null;
    expect(outputId).not.toBeNull();
    const audio = messages.filter((message) => message.type === "output.audio");
    expect(audio.length).toBeGreaterThan(10);
    expect(audio.map(({ sequence }) => sequence)).toEqual(audio.map((_, index) => index));
    expect(messages.at(-1)).toEqual({
      type: "output.ended",
      outputId,
      chunkCount: audio.length,
    });
    expect(messages.every((message) => message.outputId === outputId)).toBe(true);
    // Audio arrives as it is synthesized, not as one finished file.
    const audioTimes = first.received
      .filter(({ message }) => message.type === "output.audio")
      .map(({ at }) => at);
    expect((audioTimes.at(-1) ?? 0) - (audioTimes[0] ?? 0)).toBeGreaterThan(500);
    // Each Run's media session carries only its own outputs.
    await expect
      .poll(() => second.received.some(({ message }) => message.type === "output.ended"), {
        timeout: 15_000,
      })
      .toBe(true);
    expect(
      second.received.every(
        ({ message }) => !("outputId" in message) || message.outputId !== outputId,
      ),
    ).toBe(true);

    const evidence = await cascadeEvidence("cascade-a");
    expect(evidence.requests).toEqual([
      {
        instructions: { kind: "literal", text: prompt },
        operationalInstructions: "",
        tools: [
          expect.objectContaining({ name: "finish_interview", description: finishDescription }),
        ],
      },
    ]);
    expect(evidence.realtime).toEqual([]);

    expect((await post("cascade-a", "/complete", { endReason: "participant_stopped" })).ok).toBe(
      true,
    );
    await expect
      .poll(async () => state("cascade-a"), { timeout: 20_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "participant_stopped" } });
    expect((await cascadeEvidence("cascade-a")).requests).toHaveLength(1);
    // Each record names what produced it: Cascade's own name Cascade, Runtime's no provider.
    const produced = await allRecords("cascade-a");
    expect(produced.filter(({ source }) => source === "execution")).not.toEqual([]);
    for (const { source, type, payload } of produced) {
      expect(JSON.stringify(payload)).not.toContain("openai_realtime");
      if (source === "execution")
        expect({ type, source: payload.source, provider: payload.provider }).toEqual({
          type,
          source: "cascade_execution",
          provider: "cascade",
        });
      if (source === "runtime") expect(payload).not.toHaveProperty("provider");
    }
    await post("cascade-b", "/complete", { endReason: "participant_stopped" });
  }, 40_000);

  it("cancels the streaming output at Stop and starts no work after it", async () => {
    const media = await goLive("stop-during-opening", run);
    await expect
      .poll(() => media.received.filter(({ message }) => message.type === "output.audio").length)
      .toBeGreaterThan(2);
    expect(
      (await post("stop-during-opening", "/complete", { endReason: "participant_stopped" })).ok,
    ).toBe(true);
    await expect
      .poll(() => media.received.some(({ message }) => message.type === "output.cancelled"))
      .toBe(true);
    const cancelled = media.received.findIndex(
      ({ message }) => message.type === "output.cancelled",
    );
    await expect
      .poll(async () => state("stop-during-opening"), { timeout: 20_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "participant_stopped" } });
    // Nothing follows the cancellation: no audio and no end of the cancelled output.
    expect(media.received.slice(cancelled + 1)).toEqual([]);
    expect(media.received.some(({ message }) => message.type === "output.ended")).toBe(false);
    expect((await cascadeEvidence("stop-during-opening")).requests).toHaveLength(1);
  }, 40_000);

  it("ends the Run as interrupted when Runtime cannot save a report during Live", async () => {
    await attachLive("save-failure", run);
    expect((await request("save-failure", "/fail-next-report-save")).ok).toBe(true);
    expect((await post("save-failure", "/media-ready", {})).status).toBe(200);
    await expect
      .poll(async () => (await request("save-failure", "/state")).json(), { timeout: 20_000 })
      .toMatchObject({
        state: {
          phase: "ended",
          completion: {
            endReason: "runtime_failed",
            source: "session_message_failure",
            outcome: "failed",
            warnings: [],
          },
        },
      });
    expect((await cascadeEvidence("save-failure")).unsavedReportPending).toBe(false);
    // Runtime's report path records the failed save as the Run's degradation.
    expect(await records("save-failure", "runtime.live_degraded")).toEqual([
      expect.objectContaining({
        degradationKind: "session_message",
        errorText: "report_save_failed",
      }),
    ]);
  }, 40_000);

  it("refuses a second media attachment for the Run", async () => {
    await goLive("single-attachment", run);
    const again = await request("single-attachment", "/attachment?runId=single-attachment", {
      headers: { Upgrade: "websocket" },
    });
    expect({ status: again.status, body: await again.json() }).toEqual({
      status: 409,
      body: { error: "cascade_media_already_attached" },
    });
    await post("single-attachment", "/complete", { endReason: "participant_stopped" });
  }, 30_000);

  it("fails the Run under the startup rules when the browser never attaches", async () => {
    const started = await start("never-attached", { ...run, startupExpiresAt: Date.now() + 2_000 });
    expect(started.status).toBe(200);
    await expect
      .poll(async () => (await state("never-attached")).phase, { timeout: 15_000 })
      .toBe("failed");
    expect((await cascadeEvidence("never-attached")).requests).toEqual([]);
  }, 30_000);

  it("sends nothing to the providers when the opening's durable claim fails", async () => {
    const media = await attachLive("claim-failure", run);
    // The browser's readiness receipt reaches the claim, which fails before any dispatch.
    expect((await post("claim-failure", "/media-ready", {})).status).toBe(500);
    expect((await cascadeEvidence("claim-failure")).requests).toEqual([]);
    expect(media.received).toEqual([]);
    await post("claim-failure", "/complete", { endReason: "participant_stopped" });
  }, 30_000);
});
