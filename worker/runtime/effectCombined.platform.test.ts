import { originalRealtimeSelection } from "../shared/contracts/conversationSelection.ts";
import { createInterviewConversationInput } from "./testing/interviewConversationPreset.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { platformBuildOptions } from "../shared/testing/platformBuild.ts";
import { Miniflare } from "miniflare";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestLabD1Database } from "../shared/testing/d1.ts";
import type { D1DatabaseCapability } from "../shared/persistence/runDiagnosticsD1.ts";
import { getLabTerminalResult } from "../lab/persistence/labTerminalResults.ts";
import { getLabStartupState } from "../lab/persistence/labStartup.ts";
import { getLabRun } from "../lab/persistence/labD1.ts";

let platform: Miniflare;
let reopen: () => Miniflare;
let persistence: string;
let labDb: D1DatabaseCapability;
const providerCommands: string[] = [];
/** A Run that began Ending, which may already have finished it when nothing remained to settle. */
const endingOrEnded: unknown = expect.stringMatching(/^(ending|ended)$/);
const labCompletionDeliveries: string[] = [];
const fixtureRuntime = `
import runtime from "./worker/runtime.ts";
import { InterviewRuntimeController } from "./worker/runtimeHostController.ts";
import { realtimeTestDriver } from "./worker/providers/openaiRealtime/testing/testDriver.ts";
import { prepareRealtimeSettings } from "./worker/providers/openaiRealtime/preparedModelSession.ts";
import { createRuntimeHostAssembly } from "./worker/runtimeHostComposition.ts";
import { providerSuccess, providerFailure } from "./worker/runtime/providerOutcomes.ts";
import { createFakeRealtimeSideConnection } from "./worker/providers/openaiRealtime/testing/fakeSideConnection.ts";
export class Controller extends InterviewRuntimeController {
  constructor(ctx, env) {
    let peer;
    const assembly = createRuntimeHostAssembly({ realtimeDriver: realtimeTestDriver({
      createCall: async (input) => {
        await env.PROVIDER.fetch("https://provider.test/create");
        if(input.sdp.includes("fail-start")) return providerFailure({stage:"call_creation",code:"provider_call_http_503",providerStatus:503,retryable:false});
        return providerSuccess({status:201,answerSdp:"v=0\\r\\ncombined-answer",responseContentType:"application/sdp",sessionLocation:"https://provider.test/rtc_combined",sessionId:"rtc_combined",upstreamRequestId:"req_combined"});
      },
      connectSideband: async () => {
        const side = createFakeRealtimeSideConnection(); peer = side.provider;
        return providerSuccess(side.connection);
      },
      hangUp: async () => {
        await env.PROVIDER.fetch("https://provider.test/hangup");
        return providerSuccess({status:204,upstreamRequestId:"req_hangup"});
      }
    }) });
    super(ctx, env, { assembly: {
      ...assembly,
      resolve: (selection) => ({
        ...assembly.resolve(selection),
        prepareSettings: (choices) => prepareRealtimeSettings(choices, { speechToSpeech: "selected-realtime-platform", speechToText: "selected-transcription-platform" }),
      }),
    } });
    this.peer = () => peer;
  }
  fetch(request) {
    if (new URL(request.url).pathname === "/start-facts") {
      return Response.json(JSON.parse(this.ctx.storage.sql.exec("SELECT conversation_start_json FROM runtime_controller_state").one().conversation_start_json));
    }
    if (new URL(request.url).pathname === "/delivery-facts") {
      const row = this.ctx.storage.sql.exec("SELECT delivery_target_json, diagnostics_context_json, finalization_state_json FROM runtime_controller_state").one();
      return Response.json({ target: JSON.parse(row.delivery_target_json), cutoffAt: JSON.parse(row.finalization_state_json).state.publication.publicationCutoffAt });
    }
    if (new URL(request.url).pathname === "/provider") return new Response(null,{status:101,webSocket:this.peer()});
    return super.fetch(request);
  }
}
export default { fetch(request,env,ctx) {
  const url = new URL(request.url);
  if(url.pathname.startsWith("/provider/")) return env.INTERVIEW_RUNTIME_CONTROLLER.getByName(url.pathname.slice(10)).fetch(new Request(url.searchParams.get("probe") === "start" ? "https://controller.test/start-facts" : url.searchParams.has("probe") ? "https://controller.test/delivery-facts" : "https://controller.test/provider",request));
  return runtime.fetch(request,env,ctx);
}};`;

beforeAll(async () => {
  const runtime = await build({
    ...platformBuildOptions,
    stdin: { contents: fixtureRuntime, resolveDir: process.cwd() },
  });
  const lab = await build({
    ...platformBuildOptions,
    stdin: {
      resolveDir: process.cwd(),
      contents: `
import lab from "./worker/lab.ts";
import { LabRuntimeCallbacks as NativeCallbacks } from "./worker/lab/labRuntimeCallbacks.ts";
export { LabStartupDeadline } from "./worker/lab/labStartupDeadline.ts";
export default lab;
export class LabRuntimeCallbacks extends NativeCallbacks {
  async completion(request) {
    const payload = await request.clone().text();
    const response = await super.completion(request);
    if(JSON.parse(payload).outcome === "completed") {
      const receipt = await this.env.RECEIPTS.fetch(new Request("https://receipts.test/lab-completion", {method: "POST", body: JSON.stringify({payload, receipt: await response.clone().json()})}));
      if(receipt.status === 503) throw new Error("lost_lab_completion_reply_after_commit");
    }
    return response;
  }
}`,
    },
  });
  persistence = await mkdtemp(join(tmpdir(), "lab-combined-"));
  reopen = () =>
    new Miniflare({
      d1Persist: join(persistence, "d1"),
      durableObjectsPersist: join(persistence, "objects"),
      workers: [
        {
          name: "combined",
          modules: true,
          script: `export default {fetch(request,env){const url=new URL(request.url);const target=url.hostname.startsWith("runtime.")?env.RUNTIME:env.LAB;return target.fetch(request);}};`,
          compatibilityDate: "2026-06-05",
          serviceBindings: { LAB: "lab", RUNTIME: "runtime" },
        },
        {
          name: "runtime",
          modules: true,
          script: runtime.outputFiles[0]?.text ?? "",
          compatibilityDate: "2026-06-05",
          compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
          bindings: { OPENAI_API_KEY: "synthetic-test" },
          durableObjects: {
            INTERVIEW_RUNTIME_CONTROLLER: { className: "Controller", useSQLite: true },
          },
          serviceBindings: {
            LAB_CALLBACK_WORKER: { name: "lab", entrypoint: "LabRuntimeCallbacks" },
            PROVIDER: async (request: Request) => {
              providerCommands.push(new URL(request.url).pathname);
              return new Response(null, { status: 204 });
            },
          },
        },
        {
          name: "lab",
          modules: true,
          script: lab.outputFiles[0]?.text ?? "",
          compatibilityDate: "2026-06-05",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { LAB_DB: "combined-lab" },
          durableObjects: {
            LAB_STARTUP_DEADLINE: { className: "LabStartupDeadline", useSQLite: true },
          },
          serviceBindings: {
            RUNTIME_WORKER: "runtime",
            RECEIPTS: async (request: Request) => {
              labCompletionDeliveries.push(await request.text());
              return new Response(null, {
                status: labCompletionDeliveries.length === 1 ? 503 : 204,
              });
            },
          },
        },
      ],
    });
  platform = reopen();
  labDb = (await platform.getBindings<{ LAB_DB: D1DatabaseCapability }>("lab")).LAB_DB;
  const schema = createTestLabD1Database();
  try {
    const rows = await schema.d1
      .prepare(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
      )
      .all();
    for (const row of z.array(z.object({ sql: z.string() })).parse(rows.results))
      await labDb.prepare(row.sql).run();
  } finally {
    schema.close();
  }
}, 30_000);

afterAll(async () => {
  await platform?.dispose();
  if (persistence !== undefined) await rm(persistence, { recursive: true, force: true });
});

async function provider(runId: string) {
  const response = await platform.dispatchFetch(`https://runtime.test/provider/${runId}`, {
    headers: { Upgrade: "websocket" },
  });
  const socket = response.webSocket;
  if (socket === null)
    throw new Error(`missing_combined_provider_socket:${response.status}:${await response.text()}`);
  socket.accept();
  return socket;
}
async function runtimeState(runId: string) {
  return (
    await platform.dispatchFetch(`https://runtime.test/_runtime/controllers/${runId}`)
  ).json();
}
function transcript(id: string, text: string) {
  return JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    event_id: id,
    item_id: id,
    transcript: text,
    content_index: 0,
    usage: {
      type: "tokens",
      total_tokens: 7,
      input_tokens: 5,
      output_tokens: 2,
      input_token_details: { audio_tokens: 5, text_tokens: 0 },
    },
  });
}

describe("combined native Lab Runtime journeys", () => {
  it.each(["participant_stopped", "agent_requested_end"] as const)(
    "starts Lab and delivers %s through the common native path into Lab D1",
    async (reason) => {
      labCompletionDeliveries.length = 0;
      const commandsBefore = providerCommands.length;
      const start = await platform.dispatchFetch("https://lab.test/_api/runtime/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: "realtime-v1",
          connection: { exchangeId: "lab-platform-first", input: { sdp: "v=0\r\n" } },
          executionSettings: {
            model: "gpt-realtime-2.1",
            voice: "marin",
            speed: 1,
            inputNoiseReduction: "off",
            semanticVadEagerness: "medium",
            maxOutputTokens: 700,
            truncation: "auto",
          },
          selection: originalRealtimeSelection,
          agentInput: createInterviewConversationInput("Interview the participant."),
        }),
      });
      const runId = start.headers.get("X-Lab-Run-Id");
      expect(start.status, await start.clone().text()).toBe(200);
      if (runId === null) throw new Error("missing_combined_lab_run_id");
      const startReply: unknown = await start.json();
      expect(startReply).toMatchObject({
        runId,
        exchangeId: "lab-platform-first",
        acceptance: "accepted",
        reply: { sdp: "v=0\r\ncombined-answer" },
        diagnostics: { sessionId: "rtc_combined" },
      });
      const replay = await platform.dispatchFetch(
        `https://lab.test/_api/runtime/runs/${runId}/connection`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ exchangeId: "lab-platform-first", input: { sdp: "v=0\r\n" } }),
        },
      );
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(startReply);
      const conflict = await platform.dispatchFetch(
        `https://lab.test/_api/runtime/runs/${runId}/connection`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ exchangeId: "lab-platform-next", input: { sdp: "v=0\r\n" } }),
        },
      );
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({
        runId,
        acceptance: "accepted",
        error: "connection_exchange_conflict",
      });
      expect(providerCommands.slice(commandsBefore)).toEqual(["/create"]);
      await expect.poll(() => runtimeState(runId)).toMatchObject({ phase: "live" });
      await expect
        .poll(() => getLabStartupState(labDb, runId))
        .toMatchObject({ status: "succeeded", reason: "readiness_confirmed" });
      const socket = await provider(runId);
      socket.send(transcript("lab-transcript", "Clear examples."));
      await expect
        .poll(() => getLabRun(labDb, runId))
        .toMatchObject({
          transcript: { turns: [{ role: "participant", text: "Clear examples." }] },
        });
      if (reason === "participant_stopped") {
        const end = await platform.dispatchFetch(
          `https://lab.test/_api/runtime/runs/${runId}/complete`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endReason: reason }),
          },
        );
        expect(end.status).toBe(202);
        await end.text();
      } else {
        socket.send(
          JSON.stringify({
            type: "response.output_audio_transcript.done",
            event_id: "lab-closing-text",
            item_id: "lab-closing",
            response_id: "lab-agent-finish",
            output_index: 0,
            content_index: 0,
            transcript: "Closing output.",
          }),
        );
        socket.send(
          JSON.stringify({
            type: "response.done",
            event_id: "lab-agent-finish",
            response: {
              id: "lab-agent-finish",
              status: "completed",
              output: [
                {
                  type: "message",
                  id: "lab-closing",
                  role: "assistant",
                  content: [{ type: "audio" }],
                },
                {
                  type: "function_call",
                  id: "lab-finish-item",
                  name: "finish_interview",
                  call_id: "lab-finish-call",
                  arguments: "{}",
                },
              ],
            },
          }),
        );
        socket.send(
          JSON.stringify({ type: "output_audio_buffer.stopped", response_id: "lab-agent-finish" }),
        );
        // Ending follows once the finishing reply has had time to play; the final input settled
        // meanwhile, so it can also have finished.
        await expect
          .poll(() => runtimeState(runId), { timeout: 5_000 })
          .toMatchObject({ phase: endingOrEnded });
      }
      socket.close(1000, "provider_end");
      await expect
        .poll(() => getLabRun(labDb, runId), { timeout: 15_000 })
        .toMatchObject({
          endReason: reason,
          transcript: {
            turns:
              reason === "participant_stopped"
                ? [{ role: "participant", text: "Clear examples." }]
                : [
                    { role: "participant", text: "Clear examples." },
                    { role: "conversationAgent", text: "Closing output." },
                  ],
          },
        });
      await expect
        .poll(
          async () =>
            z
              .object({
                callback: z.object({
                  pending: z.literal(false),
                  deliveredAt: z.number().int().nonnegative(),
                }),
              })
              .safeParse(await runtimeState(runId)).success,
          { timeout: 10_000 },
        )
        .toBe(true);
      const terminal = await getLabTerminalResult(labDb, runId);
      expect(terminal).toMatchObject({
        outcome: "completed",
        reason,
        transcriptSnapshot: { turnCount: reason === "participant_stopped" ? 1 : 2 },
        runtimeUsage: {
          completeness: reason === "participant_stopped" ? "complete" : "incomplete",
          observations: [
            {
              componentRole: "speech_to_text",
              measure: "input_audio",
              model: "selected-transcription-platform",
              provider: "openai",
              quantity: 5,
              unit: "token",
            },
            {
              componentRole: "speech_to_text",
              measure: "output_text",
              model: "selected-transcription-platform",
              provider: "openai",
              quantity: 2,
              unit: "token",
            },
          ],
        },
      });
      expect(labCompletionDeliveries).toHaveLength(2);
      const deliveries = z.array(z.object({ payload: z.string(), receipt: z.json() })).parse(
        labCompletionDeliveries.map((delivery) => {
          const value: unknown = JSON.parse(delivery);
          return value;
        }),
      );
      expect(deliveries[1]?.payload).toBe(deliveries[0]?.payload);
      expect(deliveries[0]?.receipt).toMatchObject({
        version: 2,
        status: "completed",
        requestedMatches: true,
      });
      expect(deliveries[1]?.receipt).toMatchObject({
        version: 2,
        status: "idempotent",
        requestedMatches: true,
      });
      expect(terminal).toHaveProperty("liveAt");
      expect(providerCommands.slice(commandsBefore)).toEqual(["/create", "/hangup"]);
    },
    25_000,
  );
  it("failed native Lab Start receives the common failure result without invented transcript or live timing", async () => {
    const commandsBefore = providerCommands.length;
    const start = await platform.dispatchFetch("https://lab.test/_api/runtime/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: "realtime-v1",
        connection: { exchangeId: "lab-failed-first", input: { sdp: "v=0\\r\\nfail-start" } },
        selection: originalRealtimeSelection,
        agentInput: createInterviewConversationInput("Interview the participant."),
      }),
    });
    const runId = start.headers.get("X-Lab-Run-Id");
    expect(start.status).toBe(502);
    if (runId === null) throw new Error("missing_combined_lab_run_id");
    await start.text();
    await expect
      .poll(() => getLabTerminalResult(labDb, runId))
      .toMatchObject({
        runId,
        outcome: "failed_to_start",
        runtimeUsage: { completeness: "complete", observations: [] },
      });
    await expect
      .poll(
        async () =>
          z
            .object({
              callback: z.object({
                pending: z.literal(false),
                deliveredAt: z.number().int().nonnegative(),
              }),
            })
            .safeParse(await runtimeState(runId)).success,
        { timeout: 10_000 },
      )
      .toBe(true);
    const terminal = await getLabTerminalResult(labDb, runId);
    expect(terminal).not.toHaveProperty("liveAt");
    expect(terminal).not.toHaveProperty("transcriptSnapshot");
    expect(providerCommands.slice(commandsBefore)).toEqual(["/create"]);
  }, 25_000);
});
