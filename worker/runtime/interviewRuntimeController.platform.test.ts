import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { platformBuildOptions } from "../shared/testing/platformBuild.ts";
import { Miniflare } from "miniflare";
import { z } from "zod";
import { originalRealtimeSelection } from "../shared/contracts/conversationSelection.ts";
import {
  createInterviewConversationInput,
  testInterviewInstructions,
} from "./testing/interviewConversationPreset.ts";

let platform: Miniflare;
let acknowledge = false;
const callbacks: unknown[] = [];

beforeAll(async () => {
  const bundle = await build({
    ...platformBuildOptions,
    stdin: {
      contents: `import { WorkerEntrypoint } from "cloudflare:workers";
        import { InterviewRuntimeController } from "./worker/runtimeHostController.ts";
        export class Controller extends InterviewRuntimeController {
          constructor(ctx, env) {
            const failures = { remaining: 0 };
            const setAlarm = ctx.storage.setAlarm.bind(ctx.storage);
            ctx.storage.setAlarm = (at) => {
              if (failures.remaining > 0) {
                failures.remaining--;
                return Promise.reject(new Error("native_alarm_write_failed"));
              }
              return setAlarm(at);
            };
            super(ctx, env);
            this.failures = failures;
            this.instance = crypto.randomUUID();
            this.alarmFailures = [];
          }
          async alarm() {
            try { await super.alarm(); }
            catch (error) { this.alarmFailures.push(error.message); throw error; }
          }
          async fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/fail-next-alarm") this.failures.remaining = 1;
            if (path === "/inspect" || path === "/fail-next-alarm") {
              const rows = this.ctx.storage.sql.exec("SELECT startup_expires_at, completion_json, callback_pending, callback_retry_at, failed_start_publication_cutoff_at, setup_cleanup_pending FROM runtime_controller_state").toArray();
              return Response.json({ instance: this.instance, alarmFailures: this.alarmFailures,
                alarmAt: await this.ctx.storage.getAlarm(), row: rows[0] ?? null });
            }
            return super.fetch(request);
          }
        }
        export class Callbacks extends WorkerEntrypoint {
          authorizeDelivery(request) { return Response.json({ runId: new URL(request.url).searchParams.get("runId"), authorized: true }); }
          completion(request) { return this.env.RECEIVER.fetch(new Request(request, { signal: null })); }
          startupDiagnostic() { return Response.json({ ok: true }); }
        }
        export default { fetch(request, env) {
          return env.CONTROLLERS.getByName("native-alarm").fetch(request);
        }};`,
      resolveDir: process.cwd(),
    },
  });
  platform = new Miniflare({
    name: "runtime-controller-alarm",
    modules: true,
    script: bundle.outputFiles[0]?.text ?? "",
    compatibilityDate: "2026-06-05",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    durableObjects: { CONTROLLERS: { className: "Controller", useSQLite: true } },
    serviceBindings: {
      TEST_CALLBACK_WORKER: { name: "runtime-controller-alarm", entrypoint: "Callbacks" },
      RECEIVER: async (request: Request) => {
        callbacks.push(await request.json());
        return acknowledge ? Response.json({ ok: true }) : new Response(null, { status: 503 });
      },
    },
  });
}, 30_000);

afterAll(async () => {
  await platform?.dispose();
});

async function inspect(path = "/inspect") {
  return z
    .object({
      instance: z.string(),
      alarmFailures: z.array(z.string()),
      alarmAt: z.number().nullable(),
      row: z.object({
        startup_expires_at: z.number(),
        completion_json: z.string().nullable(),
        callback_pending: z.number(),
        callback_retry_at: z.number().nullable(),
        failed_start_publication_cutoff_at: z.number().nullable(),
        setup_cleanup_pending: z.number(),
      }),
    })
    .parse(await (await platform.dispatchFetch(`https://native.test${path}`)).json());
}

describe("composed Runtime controller on the native alarm scheduler", () => {
  it("surfaces a physical alarm write rejection and resumes the same failed attempt at its original deadline", async () => {
    const runId = "native-alarm";
    // Initialize before choosing a short native scheduler window.
    expect(await (await platform.dispatchFetch("https://native.test/state")).json()).toEqual({
      state: null,
    });
    const startupExpiresAt = Date.now() + 750;
    const response = await platform.dispatchFetch("https://native.test/start", {
      method: "POST",
      body: JSON.stringify({
        selection: originalRealtimeSelection,
        execution: {
          agentInput: createInterviewConversationInput(
            testInterviewInstructions,
            undefined,
            60_000,
          ),
        },
        runId,
        startupExpiresAt,
        deliveryTarget: {
          integration: "test",
          context: { runId },
        },
        diagnosticsContext: { surface: "test" },
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    const armed = await inspect("/fail-next-alarm");
    expect(armed).toMatchObject({ alarmAt: startupExpiresAt });
    // The actual workerd alarm invokes the production controller; no manual alarm call.
    await expect
      .poll(inspect, { timeout: 10_000 })
      .toMatchObject({ alarmFailures: ["native_alarm_write_failed"] });
    await expect.poll(() => callbacks.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const pending = await inspect();
    expect(pending.instance).toBe(armed.instance);
    expect(pending.row).toMatchObject({
      startup_expires_at: startupExpiresAt,
      callback_pending: 1,
      setup_cleanup_pending: 0,
    });
    const sealedResult = z.json().parse(JSON.parse(pending.row.completion_json ?? "null"));
    expect(sealedResult).toMatchObject({
      runId,
      outcome: "failed_to_start",
      endedAt: startupExpiresAt,
    });
    expect(pending.row.failed_start_publication_cutoff_at).toBeGreaterThan(startupExpiresAt);
    acknowledge = true;
    await expect.poll(inspect, { timeout: 10_000 }).toMatchObject({ row: { callback_pending: 0 } });
    const delivered = await inspect();
    expect(delivered.row.completion_json).toBe(pending.row.completion_json);
    expect(delivered.row.failed_start_publication_cutoff_at).toBe(
      pending.row.failed_start_publication_cutoff_at,
    );
    expect(
      callbacks.every((callback) => JSON.stringify(callback) === JSON.stringify(sealedResult)),
    ).toBe(true);
  }, 15_000);
});
