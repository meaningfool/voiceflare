import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { readFile } from "node:fs/promises";
import { parse } from "jsonc-parser";
import { z } from "zod";

import { sampleGoodbyeInput } from "./runtime/testing/sampleInterviews.ts";
import type { D1DatabaseCapability } from "./shared/persistence/runDiagnosticsD1.ts";
import { createTestLabD1Database } from "./shared/testing/d1.ts";
import { platformBuildOptions } from "./shared/testing/platformBuild.ts";

// The real Lab and Runtime Workers on workerd, with real D1 and Durable Objects. Only
// the provider driver and the service binding in front of Runtime are controlled. The SDP offer
// names each Start's provider behavior (`a=mode:`) and binding fault (`a=binding:`).
const runtimeEntry = `
import runtime from "./worker/runtime.ts";
import { InterviewRuntimeController } from "./worker/runtimeHostController.ts";
import { realtimeTestDriver } from "./worker/providers/openaiRealtime/testing/testDriver.ts";
import { providerFailure, providerSuccess } from "./worker/runtime/providerOutcomes.ts";
export class Controller extends InterviewRuntimeController {
  constructor(ctx, env) {
    super(ctx, env, { realtimeDriver: realtimeTestDriver({
      createCall: async (input) => {
        const mode = /a=mode:(\\w+)/.exec(input.sdp)?.[1];
        if (mode === "throw") throw new Error("provider_transport_lost");
        if (mode === "fail")
          return providerFailure({ stage: "call_creation", code: "provider_call_http_503", providerStatus: 503, retryable: false });
        throw new Error("unexpected_provider_mode");
      },
      hangUp: async () => providerSuccess({ status: 204, upstreamRequestId: null }),
    }) });
  }
}
export default runtime;`;

// Every Lab call to Runtime passes this front. Per Run, from its Start:
//   before      the Start fails at the binding before Runtime receives it;
//   outageNNN   every call fails at the binding for NNN ms;
//   refuse      the Run goes to a Runtime whose application callbacks refuse delivery.
// It keeps Runtime's answer to each Start, which a test reads at /starts/<runId>.
const bindingEntry = `
const faults = new Map();
const answers = new Map();
export default { async fetch(request, env) {
  const url = new URL(request.url);
  const answered = /^\\/starts\\/([^/]+)$/.exec(url.pathname)?.[1];
  if (answered !== undefined) return Response.json(answers.get(answered) ?? null);
  const runId = /^\\/_runtime\\/controllers\\/([^/]+)/.exec(url.pathname)?.[1];
  const body = request.method === "POST" ? await request.text() : null;
  const start = runId !== undefined && /\\/connection$/.test(url.pathname);
  if (start && !faults.has(runId))
    faults.set(runId, { mode: /a=binding:(\\w+)/.exec(body ?? "")?.[1] ?? "none", at: Date.now() });
  const fault = runId === undefined ? undefined : faults.get(runId);
  if (fault?.mode.startsWith("outage") && Date.now() - fault.at < Number(fault.mode.slice(6)))
    throw new Error("runtime_unreachable");
  if (fault?.mode === "before" && start) throw new Error("binding_failed_before_delivery");
  const runtime = fault?.mode === "refuse" ? env.REFUSING_RUNTIME : env.RUNTIME;
  const response = await runtime.fetch(new Request(request.url, { method: request.method, headers: request.headers, body, signal: request.signal }));
  if (start)
    answers.set(runId, { status: response.status, body: await response.clone().json().catch(() => null) });
  return response;
} };`;

const refusingCallbacksEntry = `
import { WorkerEntrypoint } from "cloudflare:workers";
const refuse = () => new Response(null, { status: 403 });
export class RefusingCallbacks extends WorkerEntrypoint {
  authorizeDelivery() { return refuse(); }
  readiness() { return refuse(); }
  transcript() { return refuse(); }
  completion() { return refuse(); }
  startupDiagnostic() { return refuse(); }
}
export default { fetch() { return new Response(null, { status: 404 }); } };`;

// Test requests reach the Lab Worker.
const routerEntry = `export default { fetch(request, env) {
  return env.LAB.fetch(request);
} };`;

async function bundle(contents: string): Promise<string> {
  const result = await build({
    ...platformBuildOptions,
    stdin: { contents, resolveDir: process.cwd() },
  });
  return result.outputFiles[0]?.text ?? "";
}

const compatibilitySchema = z.object({
  compatibility_date: z.string(),
  compatibility_flags: z.array(z.string()),
});
async function compatibility(file: string) {
  const config = compatibilitySchema.parse(parse(await readFile(file, "utf8")));
  return {
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
  };
}

async function applySchema(db: D1DatabaseCapability, schema: { d1: D1DatabaseCapability }) {
  const rows = await schema.d1
    .prepare(
      "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
    )
    .all();
  for (const row of z.array(z.object({ sql: z.string() })).parse(rows.results))
    await db.prepare(row.sql).run();
}

let platform: Miniflare;

beforeAll(async () => {
  const [runtimeScript, labScript, bindingScript, refusingScript] = await Promise.all([
    bundle(runtimeEntry),
    bundle(`export * from "./worker/lab.ts"; export { default } from "./worker/lab.ts";`),
    bundle(bindingEntry),
    bundle(refusingCallbacksEntry),
  ]);
  const [lab, runtime] = await Promise.all([
    compatibility("wrangler.lab.jsonc"),
    compatibility("wrangler.runtime.jsonc"),
  ]);
  const runtimeWorker = (name: string, refusing: boolean) => ({
    name,
    modules: true,
    script: runtimeScript,
    ...runtime,
    bindings: { OPENAI_API_KEY: "synthetic-test-key" },
    durableObjects: { INTERVIEW_RUNTIME_CONTROLLER: { className: "Controller", useSQLite: true } },
    serviceBindings: {
      LAB_CALLBACK_WORKER: refusing
        ? { name: "refusing-callbacks", entrypoint: "RefusingCallbacks" }
        : { name: "lab", entrypoint: "LabRuntimeCallbacks" },
    },
  });
  platform = new Miniflare({
    workers: [
      {
        name: "router",
        modules: true,
        script: routerEntry,
        ...lab,
        serviceBindings: { LAB: "lab" },
      },
      {
        name: "lab",
        modules: true,
        script: labScript,
        ...lab,
        d1Databases: { LAB_DB: "start-failure-lab" },
        durableObjects: {
          LAB_STARTUP_DEADLINE: { className: "LabStartupDeadline", useSQLite: true },
        },
        serviceBindings: { RUNTIME_WORKER: "runtime-binding" },
      },
      {
        name: "runtime-binding",
        modules: true,
        script: bindingScript,
        ...runtime,
        serviceBindings: { RUNTIME: "runtime", REFUSING_RUNTIME: "refusing-runtime" },
      },
      runtimeWorker("runtime", false),
      runtimeWorker("refusing-runtime", true),
      {
        name: "refusing-callbacks",
        modules: true,
        script: refusingScript,
        ...runtime,
      },
    ],
  });
  const labDb = (await platform.getBindings<{ LAB_DB: D1DatabaseCapability }>("lab")).LAB_DB;
  const labSchema = createTestLabD1Database();
  try {
    await applySchema(labDb, labSchema);
  } finally {
    labSchema.close();
  }
}, 60_000);

afterAll(async () => {
  await platform?.dispose();
});

const offer = (mode: string, binding: string) =>
  `v=0\r\na=mode:${mode}\r\na=binding:${binding}\r\n`;

async function startLab(sdp: string): Promise<string> {
  const response = await platform.dispatchFetch("https://lab.test/_api/runtime/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attemptId: crypto.randomUUID(),
      profile: "realtime-v1",
      connection: { exchangeId: crypto.randomUUID(), input: { sdp } },
      selection: {
        conversation: { id: "goodbye-interview", version: 1 },
        execution: { id: "realtime", version: 1 },
      },
      agentInput: sampleGoodbyeInput({ interviewingDurationMs: 60_000 }),
      reasoningEffort: "low",
      executionSettings: {
        model: "gpt-realtime-2",
        voice: "marin",
        speed: 1,
        inputNoiseReduction: "far_field",
        semanticVadEagerness: "medium",
        maxOutputTokens: 700,
        truncation: "auto",
      },
    }),
  });
  await response.body?.cancel();
  expect(response.ok).toBe(false);
  const runId = response.headers.get("X-Lab-Run-Id");
  if (runId === null) throw new Error("lab_run_not_allocated");
  return runId;
}

const labRunSchema = z.object({
  terminalResult: z.object({ outcome: z.string() }).optional(),
});

/** What the Lab page reads: the run detail's terminal result. */
async function labOutcome(runId: string): Promise<string | null> {
  const response = await platform.dispatchFetch(
    `https://lab.test/_api/runs/${encodeURIComponent(runId)}`,
  );
  return labRunSchema.parse(await response.json()).terminalResult?.outcome ?? null;
}

/** Polls until the surface records a terminal result or the bound passes. */
async function outcomeWithin(
  read: () => Promise<string | null>,
  startedAt: number,
  boundMs: number,
) {
  for (;;) {
    const outcome = await read();
    const elapsedMs = Date.now() - startedAt;
    if (outcome !== null || elapsedMs > boundMs)
      return { outcome, withinBound: elapsedMs <= boundMs };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// Times run from the Start request. Lab gives a Start 30 s.
const promptMs = 10_000;
const outageMs = 35_000;
// Lab sends its stop as soon as the Start fails, then retries 10, 20 and 40 s later: only the
// fourth attempt, about 70 s in, comes after the outage.
const outageResolutionMs = 85_000;

const cases = [
  {
    name: "Runtime refuses the Start before the claim",
    mode: "none",
    binding: "refuse",
    boundMs: promptMs,
  },
  {
    name: "the binding fails before Runtime receives the Start",
    mode: "none",
    binding: "before",
    boundMs: promptMs,
  },
  {
    name: "Runtime is unreachable past the startup budget",
    mode: "none",
    binding: `outage${outageMs}`,
    boundMs: outageResolutionMs,
  },
  {
    name: "provider call creation throws after the claim",
    mode: "throw",
    binding: "none",
    boundMs: promptMs,
  },
  {
    name: "the provider reports a typed failure (control)",
    mode: "fail",
    binding: "none",
    boundMs: promptMs,
  },
] as const;

describe.concurrent("a Start that fails records failed_to_start through the real Workers", () => {
  it.each(cases)(
    "Lab: $name",
    async ({ mode, binding, boundMs }) => {
      const startedAt = Date.now();
      const runId = await startLab(offer(mode, binding));
      expect(await outcomeWithin(() => labOutcome(runId), startedAt, boundMs)).toEqual({
        outcome: "failed_to_start",
        withinBound: true,
      });
    },
    120_000,
  );
});
