import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { platformBuildOptions } from "../shared/testing/platformBuild.ts";
import { Miniflare } from "miniflare";
import { originalRealtimeSelection } from "../shared/contracts/conversationSelection.ts";
import {
  createInterviewConversationInput,
  testInterviewInstructions,
} from "./testing/interviewConversationPreset.ts";

let platform: Miniflare;

beforeAll(async () => {
  const bundle = await build({
    ...platformBuildOptions,
    stdin: {
      contents: `import { WorkerEntrypoint } from "cloudflare:workers";
        import { InterviewRuntimeController } from "./worker/runtimeHostController.ts";
        export class NativeController extends InterviewRuntimeController {
          constructor(ctx, env) { super(ctx, env); this.nativeStorage = ctx.storage; }
          async fetch(request) {
            if (new URL(request.url).pathname === "/facts") return Response.json(this.nativeStorage.sql.exec("SELECT startup_expires_at, readiness_attempted_at, readiness_disposition, readiness_delivered_at FROM runtime_controller_state").one());
            return super.fetch(request);
          }
        }
        const receipts = [];
        export class Callbacks extends WorkerEntrypoint {
          authorizeDelivery(request) { return Response.json({ runId: new URL(request.url).searchParams.get("runId"), authorized: true }); }
          async readiness(request) {
            const input = await request.json();
            receipts.push({ kind: "readiness", ...input });
            if (input.runId === "native_readiness") {
              return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"runId":')); } }), { headers: { "Content-Type": "application/json" } });
            }
            return Response.json({ runId: input.runId, disposition: "succeeded", decidedAt: Date.now(), reason: "readiness_confirmed", stopRequired: false });
          }
          async completion(request) {
            const input = await request.json();
            receipts.push({ kind: "completion", ...input });
            await new Promise(resolve => setTimeout(resolve, 30));
            return Response.json({ ok: true });
          }
          async startupDiagnostic() { return Response.json({ ok: true }); }
        }
        export default { async fetch(request, env) {
          const url = new URL(request.url);
          if (url.pathname === "/receipts") return Response.json(receipts.filter(receipt => receipt.runId === url.searchParams.get("runId")));
          return env.CONTROLLERS.getByName(url.searchParams.get("runId")).fetch(request);
        }};`,
      resolveDir: process.cwd(),
    },
  });
  platform = new Miniflare({
    name: "startup-native",
    modules: true,
    script: bundle.outputFiles[0]?.text ?? "",
    compatibilityDate: "2026-06-05",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { CONTROLLERS: { className: "NativeController", useSQLite: true } },
    serviceBindings: {
      TEST_CALLBACK_WORKER: { name: "startup-native", entrypoint: "Callbacks" },
    },
  });
}, 30_000);

afterAll(async () => {
  await platform?.dispose();
});

type NativeStartupRequest = Readonly<{
  selection?: typeof originalStart.selection;
  execution?: typeof originalStart.execution;
  runId: string;
  startupExpiresAt?: number;
  diagnosticsContext?: Readonly<{ surface: "test" }>;
  reason?: "application_startup_failed";
}>;

function post(runId: string, path: string, body: NativeStartupRequest) {
  return platform.dispatchFetch(`https://native.test${path}?runId=${runId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      path === "/start"
        ? {
            ...body,
            deliveryTarget: { integration: "test", context: { runId } },
          }
        : body,
    ),
  });
}

const originalStart = {
  selection: originalRealtimeSelection,
  execution: {
    agentInput: createInterviewConversationInput(testInterviewInstructions, undefined, 60_000),
  },
};

async function state(runId: string) {
  return (await platform.dispatchFetch(`https://native.test/state?runId=${runId}`)).json();
}

async function receipts(runId: string) {
  return (await platform.dispatchFetch(`https://native.test/receipts?runId=${runId}`)).json();
}

describe("startup ownership on native SQLite Durable Objects", () => {
  it("retains failed-start publication after the accepting Stop invocation returns", async () => {
    const runId = "native_failed_start";
    const acceptedAt = Date.now();
    expect(
      (
        await post(runId, "/start", {
          ...originalStart,
          runId,
          startupExpiresAt: acceptedAt + 10_000,
          diagnosticsContext: { surface: "test" },
        })
      ).status,
    ).toBe(200);
    expect(
      await (
        await post(runId, "/required-stop", { runId, reason: "application_startup_failed" })
      ).json(),
    ).toEqual({ runId, accepted: true, acceptance: "accepted" });
    await expect
      .poll(() => state(runId))
      .toMatchObject({
        state: {
          phase: "failed",
          callback: { status: "delivered", pending: false, attemptCount: 1 },
        },
      });
    await post(runId, "/required-stop", { runId, reason: "application_startup_failed" });
    expect(await receipts(runId)).toEqual([
      expect.objectContaining({
        kind: "completion",
        runId,
        outcome: "failed_to_start",
        runtimeUsage: { completeness: "complete", observations: [] },
      }),
    ]);
  });

  it("bounds native RPC response body consumption by the original readiness cutoff and claims once", async () => {
    const runId = "native_readiness";
    // Initialize the actual DO before the unchanged deadline tests readiness/body lifetime.
    expect(await state(runId)).toMatchObject({ state: null });
    const expiresAt = Date.now() + 750;
    expect(
      (
        await post(runId, "/start", {
          ...originalStart,
          runId,
          startupExpiresAt: expiresAt,
          diagnosticsContext: { surface: "test" },
        })
      ).status,
    ).toBe(200);
    expect((await post(runId, "/fake-control-ready", { runId })).status).toBe(200);
    expect(await state(runId)).toMatchObject({ state: { phase: "live" } });
    await post(runId, "/fake-control-ready", { runId });
    // Observe persisted admission facts through the fixture's real SQL store.
    const row = await (
      await platform.dispatchFetch(`https://native.test/facts?runId=${runId}`)
    ).json();
    expect(row).toMatchObject({
      startup_expires_at: expiresAt,
      readiness_disposition: "unknown",
      readiness_delivered_at: null,
    });
    expect(await receipts(runId)).toEqual([expect.objectContaining({ kind: "readiness", runId })]);
  });
});
