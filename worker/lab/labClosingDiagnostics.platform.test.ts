import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { platformBuildOptions } from "../shared/testing/platformBuild.ts";
import { Miniflare } from "miniflare";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { parse } from "jsonc-parser";
import type { D1DatabaseCapability } from "../shared/persistence/runDiagnosticsD1.ts";
import { createTestLabD1Database } from "../shared/testing/d1.ts";
import { createLabRun } from "./persistence/labD1.ts";
import { persistLabTerminalResult } from "./persistence/labTerminalResults.ts";
import { createRuntimeTranscriptSnapshot } from "../shared/runtimeTranscriptSnapshot.ts";

let platform: Miniflare;
beforeAll(async () => {
  const lab = await build({
    ...platformBuildOptions,
    stdin: {
      resolveDir: process.cwd(),
      contents: `
      import {handleLabStorageRoute} from "./worker/lab/routes/labStorage.ts";
      export default {async fetch(request,env) {
        if (new URL(request.url).pathname === "/seed") return env.RUNTIME_WORKER.fetch(request);
        let observed; let calls = 0;
        const runtime = {fetch(input) {observed = input; calls++; return env.RUNTIME_WORKER.fetch(input);}};
        const cancel = new AbortController();
        if (new URL(request.url).searchParams.has("cancel")) setTimeout(() => cancel.abort(), 20);
        const response = await handleLabStorageRoute(new Request(request, {signal:cancel.signal}), {...env, RUNTIME_WORKER: runtime});
        const run = await response.json();
        return Response.json({run, calls, aborted: observed?.signal.aborted ?? null});
      }};`,
    },
  });
  const compatibility = z.object({
    compatibility_date: z.string(),
    compatibility_flags: z.array(z.string()),
  });
  const labCompatibility = compatibility.parse(parse(await readFile("wrangler.lab.jsonc", "utf8")));
  const runtimeCompatibility = compatibility.parse(
    parse(await readFile("wrangler.runtime.jsonc", "utf8")),
  );
  const runtime = await build({
    ...platformBuildOptions,
    stdin: {
      resolveDir: process.cwd(),
      contents: `
      import { InterviewRuntimeController } from "./worker/runtimeHostController.ts";
      import { handleRuntimeControllerRoute } from "./worker/runtime/routes/runtimeController.ts";
      import { executionDiagnostics } from "./worker/providers/openaiRealtime/diagnostics.ts";
      import { questionsRealtimeImplementation } from "./worker/implementations/questionsRealtime/implementation.ts";
      import { describeDiagnostic } from "./worker/runtime/diagnosticContracts.ts";
      import { goodbyeRealtimeImplementation } from "./worker/implementations/goodbyeRealtime/implementation.ts";
      import { originalRealtimeSelection } from "./worker/shared/contracts/conversationSelection.ts";
      import { createInterviewConversationInput, testInterviewInstructions } from "./worker/runtime/testing/interviewConversationPreset.ts";
      export class DiagnosticController extends InterviewRuntimeController {
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/seed") {
            const runId = url.searchParams.get("runId");
            const response = await super.fetch(new Request("https://controller/start", {method:"POST",body:JSON.stringify({runId,selection:originalRealtimeSelection,execution:{agentInput:createInterviewConversationInput(testInterviewInstructions,undefined,60000)}})}));
            if (!response.ok) return response;
            this.ctx.storage.sql.exec("DELETE FROM runtime_controller_events");
            const selection = {conversation:{id:runId.endsWith("questions") ? "questions-interview" : runId.endsWith("original") ? "original-interview" : "goodbye-interview",version:1},execution:{id:"realtime",version:1}};
            this.ctx.storage.sql.exec("UPDATE runtime_controller_state SET conversation_selection_json = ?", JSON.stringify({version:1,selection,initialState:"interviewing",execution:{agentInput:null},executionSettings:{reasoningEffort:null,prepared:null},visitId:"visit",operationId:"operation"}));
            this.runtimeEvents.executionDiagnostics(executionDiagnostics)("realtime.provider_event_observed", {providerEventType:"response.done",source:"provider",provider:"openai_realtime",responseId:"native-response",response:{outputTokens:21,output:[{type:"message",role:"assistant"}]}});
            if (runId.endsWith("questions")) {
              this.runtimeEvents.recordConversationDiagnostics(questionsRealtimeImplementation.conversation.diagnostics, [describeDiagnostic(questionsRealtimeImplementation.conversation.diagnostics)("conversation.transition",{from:"question",to:"question",questionIndex:1})]);
              this.runtimeEvents.recordConversationDiagnostics(questionsRealtimeImplementation.conversation.diagnostics,questionsRealtimeImplementation.finalizedDiagnostics({finalizedAt:2100,endReason:"agent_requested_end",warnings:[]}));
            }
            else if (!runId.endsWith("original")) this.runtimeEvents.recordConversationDiagnostics(goodbyeRealtimeImplementation.conversation.diagnostics, goodbyeRealtimeImplementation.finalizedDiagnostics({finalizedAt:2100,endReason:"timebox_reached",warnings:runId === "lab_clean" ? [] : ["closing_cutoff_exhausted"]}));
            this.ctx.storage.sql.exec("UPDATE runtime_controller_state SET phase='failed'");
            return new Response("seeded");
          }
          return super.fetch(request);
        }
      }
      const attempts = new Map();
      export default { async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === "/seed") return env.INTERVIEW_RUNTIME_CONTROLLER.getByName(url.searchParams.get("runId")).fetch(request);
        const runId = url.pathname.split("/").at(-2);
        const count = (attempts.get(runId) ?? 0) + 1; attempts.set(runId, count);
        if (count === 1 && (runId === "lab_fetch" || runId === "lab_cancel")) return await new Promise(resolve => setTimeout(() => resolve(new Response("late")), 10000));
        if (count === 1 && runId === "lab_body") return new Response(new ReadableStream({start(controller) {this.timer=setTimeout(() => controller.close(),10000);},cancel(){clearTimeout(this.timer);}}));
        if (runId === "lab_oversize") return new Response("x".repeat(65537));
        if (runId === "lab_malformed") return Response.json({runId, records:[{recordId:"bad"}],cursor:1,hasMore:false});
        if (runId === "lab_missing") return new Response("expired",{status:404});
        if (count > 2 && (runId === "lab_fetch" || runId === "lab_body")) return new Response("offline",{status:503});
        return await handleRuntimeControllerRoute(request, env) ?? new Response("missing",{status:404});
      }};`,
    },
  });
  platform = new Miniflare({
    workers: [
      {
        name: "lab",
        modules: true,
        script: lab.outputFiles[0]?.text ?? "",
        compatibilityDate: labCompatibility.compatibility_date,
        compatibilityFlags: labCompatibility.compatibility_flags,
        d1Databases: { LAB_DB: "lab-closing-native" },
        serviceBindings: { RUNTIME_WORKER: "runtime" },
      },
      {
        name: "runtime",
        modules: true,
        compatibilityDate: runtimeCompatibility.compatibility_date,
        compatibilityFlags: runtimeCompatibility.compatibility_flags,
        script: runtime.outputFiles[0]?.text ?? "",
        durableObjects: {
          INTERVIEW_RUNTIME_CONTROLLER: { className: "DiagnosticController", useSQLite: true },
        },
      },
    ],
  });
  const { LAB_DB: db } = await platform.getBindings<{ LAB_DB: D1DatabaseCapability }>("lab");
  const schema = createTestLabD1Database();
  try {
    const rows = await schema.d1
      .prepare(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
      )
      .all();
    for (const row of z.array(z.object({ sql: z.string() })).parse(rows.results))
      await db.prepare(row.sql).run();
  } finally {
    schema.close();
  }
  for (const stage of [
    "questions",
    "fetch",
    "body",
    "write",
    "clean",
    "original",
    "cancel",
    "oversize",
    "malformed",
    "missing",
  ]) {
    const run = await createLabRun(db, {
      now: () => 1000,
      startAttempt: {
        attemptId: stage,
        requestJson: JSON.stringify({
          selection: {
            conversation: {
              id: stage === "questions" ? "questions-interview" : "goodbye-interview",
              version: 1,
            },
          },
        }),
      },
    });
    const snapshot = await createRuntimeTranscriptSnapshot(0, { turns: [] });
    await persistLabTerminalResult(db, {
      runId: run.runId,
      outcome: "completed",
      reason: "timebox_reached",
      liveAt: 1100,
      endedAt: 2000,
      transcriptSnapshot: { revision: 0, digest: snapshot.digest, turnCount: 0 },
      transcriptCompleteness: "complete",
      transcriptIncompleteReasons: [],
      runtimeUsage: { completeness: "complete", observations: [] },
    });
    const seeded = await platform.dispatchFetch(`https://lab.test/seed?runId=${run.runId}`);
    if (!seeded.ok) throw new Error(await seeded.text());
  }
}, 30_000);
afterAll(async () => {
  await platform?.dispose();
});
describe("native Lab diagnostic private binding read", () => {
  it("recovers retained Question and execution diagnostics once after failed delivery without blocking the canonical result", async () => {
    const { LAB_DB: db } = await platform.getBindings<{ LAB_DB: D1DatabaseCapability }>("lab");
    await db
      .prepare(
        "CREATE TRIGGER fail_question_diagnostic BEFORE INSERT ON runtime_events WHEN NEW.run_id='lab_questions' BEGIN SELECT RAISE(ABORT,'injected'); END",
      )
      .run();
    const unavailable = await platform.dispatchFetch("https://lab.test/_api/runs/lab_questions");
    expect(await unavailable.json()).toMatchObject({
      run: { terminalResult: { outcome: "completed" }, closingDiagnostic: { status: "unknown" } },
    });
    await db.prepare("DROP TRIGGER fail_question_diagnostic").run();
    const responses = await Promise.all([
      platform.dispatchFetch("https://lab.test/_api/runs/lab_questions"),
      platform.dispatchFetch("https://lab.test/_api/runs/lab_questions"),
    ]);
    for (const response of responses)
      expect(await response.json()).toMatchObject({
        run: {
          terminalResult: { outcome: "completed" },
          closingDiagnostic: { status: "checked", warnings: [] },
          responseUsage: [{ responseId: "native-response", outputTokens: 21 }],
        },
      });
    const rows = await db
      .prepare(
        "SELECT record_id,type FROM runtime_events WHERE run_id='lab_questions' ORDER BY sequence",
      )
      .all();
    expect(rows.results).toEqual([
      { record_id: "lab_questions:1", type: "realtime.provider_event_observed" },
      { record_id: "lab_questions:2", type: "conversation.transition" },
      { record_id: "lab_questions:3", type: "conversation.closing_assessment" },
    ]);
  });
  it("recovers actual retained Original and Goodbye records once under overlap and survives a failed D1 write", async () => {
    const { LAB_DB: db } = await platform.getBindings<{ LAB_DB: D1DatabaseCapability }>("lab");
    await db
      .prepare(
        "CREATE TRIGGER fail_diagnostic_insert BEFORE INSERT ON runtime_events WHEN NEW.run_id='lab_write' BEGIN SELECT RAISE(ABORT, 'injected_diagnostic_write_failure'); END",
      )
      .run();
    const first = await platform.dispatchFetch("https://lab.test/_api/runs/lab_write");
    expect(await first.json()).toMatchObject({
      run: { closingDiagnostic: { status: "unknown" }, terminalResult: { outcome: "completed" } },
    });
    expect(
      await db
        .prepare("SELECT cursor FROM runtime_diagnostic_recovery WHERE run_id='lab_write'")
        .first(),
    ).toBeNull();
    await db.prepare("DROP TRIGGER fail_diagnostic_insert").run();
    const responses = await Promise.all([
      platform.dispatchFetch("https://lab.test/_api/runs/lab_write"),
      platform.dispatchFetch("https://lab.test/_api/runs/lab_write"),
    ]);
    for (const response of responses)
      expect(await response.json()).toMatchObject({
        run: { closingDiagnostic: { status: "limited" } },
      });
    const rows = await db
      .prepare("SELECT record_id FROM runtime_events WHERE run_id='lab_write' ORDER BY sequence")
      .all();
    expect(rows.results).toEqual([{ record_id: "lab_write:1" }, { record_id: "lab_write:2" }]);
    const clean = await platform.dispatchFetch("https://lab.test/_api/runs/lab_clean");
    expect(await clean.json()).toMatchObject({
      run: { closingDiagnostic: { status: "checked", warnings: [] } },
    });
    const original = await platform.dispatchFetch("https://lab.test/_api/runs/lab_original");
    expect(await original.json()).toMatchObject({
      run: { responseUsage: [{ responseId: "native-response", outputTokens: 21 }] },
    });
  });

  it.each(["cancel", "oversize", "malformed", "missing"])(
    "contains %s recovery without blocking saved results",
    async (mode) => {
      const started = Date.now();
      const response = await platform.dispatchFetch(
        `https://lab.test/_api/runs/lab_${mode}${mode === "cancel" ? "?cancel" : ""}`,
      );
      expect(await response.json()).toMatchObject({
        run: { closingDiagnostic: { status: "unknown" }, terminalResult: { outcome: "completed" } },
      });
      expect(Date.now() - started).toBeLessThan(1500);
    },
  );
  it.each(["fetch", "body"])(
    "bounds stalled %s through the real Lab handler and retries only on a new read",
    async (stage) => {
      const url = `https://lab.test/_api/runs/lab_${stage}`;
      const startedAt = Date.now();
      const first = await platform.dispatchFetch(url);
      expect(await first.json()).toMatchObject({
        calls: 1,
        aborted: true,
        run: {
          closingDiagnostic: { status: "unknown", warnings: [] },
          terminalResult: { transcriptCompleteness: "complete" },
        },
      });
      expect(Date.now() - startedAt).toBeLessThan(4000);
      const second = await platform.dispatchFetch(url);
      expect(await second.json()).toMatchObject({
        calls: 1,
        aborted: true,
        run: { closingDiagnostic: { status: "limited", warnings: ["closing_cutoff_exhausted"] } },
      });
      const third = await platform.dispatchFetch(url);
      expect(await third.json()).toMatchObject({
        calls: 1,
        aborted: true,
        run: { closingDiagnostic: { status: "limited", warnings: ["closing_cutoff_exhausted"] } },
      });
    },
    10_000,
  );
});
