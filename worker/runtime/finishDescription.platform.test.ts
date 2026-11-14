import { originalRealtimeSelection } from "../shared/contracts/conversationSelection.ts";
import {
  createInterviewConversationInput,
  defaultFinishInterviewDescription as testFinishDescription,
} from "./testing/interviewConversationPreset.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { platformBuildOptions } from "../shared/testing/platformBuild.ts";
import { Miniflare, Response as NativeResponse, type Request as NativeRequest } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { D1DatabaseCapability } from "../shared/persistence/runDiagnosticsD1.ts";
import { createTestLabD1Database } from "../shared/testing/d1.ts";

const labOrigin = "https://lab.example";
const replacement = "  Speak a short closing, then finish.  ";
const providerSessionSchema = z.looseObject({
  instructions: z.string(),
  tools: z.array(z.object({ description: z.string() }).passthrough()),
});
type ObservedSession = z.output<typeof providerSessionSchema>;
const providerSessions: ObservedSession[] = [];
let platform: Miniflare;
let reopen: () => Miniflare;
let persistence: string;
let labDb: D1DatabaseCapability;

// Keep production preparation, call creation, native fetch and multipart serialization.
// Only the external sideband connection is replaced by the Realtime kit's fake.
const runtimeFixture = `
import runtime from "./worker/runtime.ts";
import { InterviewRuntimeController } from "./worker/runtimeHostController.ts";
import { Effect } from "effect";
import { openAiDriverOver, realtimeTestDriver } from "./worker/providers/openaiRealtime/testing/testDriver.ts";
import { originalRealtimeImplementation } from "./worker/implementations/originalRealtime/implementation.ts";
import { composeRealtimeSession, prepareRealtimeSettings } from "./worker/providers/openaiRealtime/preparedModelSession.ts";
import { providerSuccess } from "./worker/runtime/providerOutcomes.ts";
import { createFakeRealtimeSideConnection } from "./worker/providers/openaiRealtime/testing/fakeSideConnection.ts";
export class Controller extends InterviewRuntimeController {
  constructor(ctx, env) {
    super(ctx, env, { realtimeDriver: realtimeTestDriver({
      connectSideband: async () => {
        const side = createFakeRealtimeSideConnection();
        side.provider.accept();
        return providerSuccess(side.connection);
      },
    }) });
  }
}
export default { async fetch(request, env, ctx) {
  if (new URL(request.url).pathname === "/prepared-prompt") {
    const content = originalRealtimeImplementation.prepare({
      runId: "provider-prompt", state: "interviewing",
      nodeInput: {
        instructions: { kind: "provider_prompt", reference: { id: "prompt_native", version: "2", variables: { locale: "en", count: 2, enabled: true } }, supplementalText: "" },
        toolDescriptions: { finish_interview: "  Speak a short closing, then finish.  " },
      },
    });
    const session = composeRealtimeSession("provider-prompt", content, prepareRealtimeSettings({ reasoningEffort: null }));
    return Response.json(await Effect.runPromise(openAiDriverOver().createCall({ apiKey: env.OPENAI_API_KEY, sdp: "v=0\\r\\nprompt", session })));
  }
  return runtime.fetch(request, env, ctx);
}};`;

beforeAll(async () => {
  const [lab, runtime] = await Promise.all([
    build({ ...platformBuildOptions, entryPoints: ["worker/lab.ts"] }),
    build({
      ...platformBuildOptions,
      stdin: { contents: runtimeFixture, resolveDir: process.cwd() },
    }),
  ]);
  const nativeOptions = {
    modules: true,
    compatibilityDate: "2026-06-05",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
  };
  persistence = await mkdtemp(join(tmpdir(), "finish-description-"));
  reopen = () =>
    new Miniflare({
      d1Persist: join(persistence, "d1"),
      durableObjectsPersist: join(persistence, "objects"),
      workers: [
        {
          ...nativeOptions,
          name: "gateway",
          script: `export default { fetch(request, env) {
          const hostname = new URL(request.url).hostname;
          return (hostname === "lab.example" ? env.LAB : env.RUNTIME).fetch(request);
        }};`,
          serviceBindings: { LAB: "lab", RUNTIME: "runtime" },
        },
        {
          ...nativeOptions,
          name: "lab",
          script: lab.outputFiles[0]?.text ?? "",
          d1Databases: { LAB_DB: "finish-lab" },
          durableObjects: {
            LAB_STARTUP_DEADLINE: { className: "LabStartupDeadline", useSQLite: true },
          },
          serviceBindings: { RUNTIME_WORKER: "runtime" },
        },
        {
          ...nativeOptions,
          name: "runtime",
          script: runtime.outputFiles[0]?.text ?? "",
          bindings: { OPENAI_API_KEY: "synthetic-test" },
          durableObjects: {
            INTERVIEW_RUNTIME_CONTROLLER: { className: "Controller", useSQLite: true },
          },
          serviceBindings: {
            LAB_CALLBACK_WORKER: { name: "lab", entrypoint: "LabRuntimeCallbacks" },
          },
          outboundService: async (request: NativeRequest) => {
            const url = new URL(request.url);
            if (url.pathname.endsWith("/hangup")) return new NativeResponse(null, { status: 200 });
            if (url.origin !== "https://api.openai.com" || url.pathname !== "/v1/realtime/calls")
              throw new Error(`unexpected_provider_request:${url.pathname}`);
            expect(request.method).toBe("POST");
            expect(request.headers.get("Authorization")).toBe("Bearer synthetic-test");
            const form = await request.formData();
            expect(form.get("sdp")).toEqual(expect.stringContaining("v=0"));
            const serialized = form.get("session");
            if (typeof serialized !== "string") throw new Error("missing_native_provider_session");
            providerSessions.push(providerSessionSchema.parse(JSON.parse(serialized)));
            return new NativeResponse("v=0\r\nanswer", {
              status: 201,
              headers: {
                "Content-Type": "application/sdp",
                Location: `https://api.openai.com/v1/realtime/calls/rtc_finish_${providerSessions.length}`,
              },
            });
          },
        },
      ],
    });
  await openPlatform();
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

async function openPlatform() {
  platform = reopen();
  labDb = (await platform.getBindings<{ LAB_DB: D1DatabaseCapability }>("lab")).LAB_DB;
}

type LabStartFixture = {
  selection: typeof originalRealtimeSelection;
  profile: "realtime-v1";
  connection: { exchangeId: string; input: { sdp: string } };
  agentInput: {
    contract: "original-interview-input/v1";
    interviewing: {
      instructions: { kind: "literal"; text: string };
      toolDescriptions: { finish_interview: string | number | null };
    };
  };
};
function labStart(description: string | number | null = testFinishDescription): LabStartFixture {
  const preset = createInterviewConversationInput("Ask why.");
  return {
    selection: originalRealtimeSelection,
    profile: "realtime-v1",
    connection: { exchangeId: "finish-description", input: { sdp: "v=0\r\noffer" } },
    agentInput: {
      ...preset,
      interviewing: { ...preset.interviewing, toolDescriptions: { finish_interview: description } },
    },
  };
}
function post(url: string, body: LabStartFixture) {
  return platform.dispatchFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function observed(index: number) {
  const session = providerSessions[index];
  if (session === undefined) throw new Error("missing_provider_session_evidence");
  return session;
}
function expectRegistration(session: ObservedSession, description: string, model: string) {
  expect(session.tools).toEqual([
    {
      type: "function",
      name: "finish_interview",
      description,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  ]);
  expect(session).toMatchObject({
    type: "realtime",
    model,
    tool_choice: "auto",
    output_modalities: ["audio"],
    max_output_tokens: 700,
    truncation: "auto",
    audio: { output: { voice: "marin", speed: 1 } },
  });
}
function expectDefault(session: ObservedSession, model: string) {
  expectRegistration(session, testFinishDescription, model);
}

const labUrl = `${labOrigin}/_api/runtime/runs`;

describe("finish descriptions at actual native provider requests", () => {
  it("sends explicit Lab input and exact descriptions through native preparation and multipart serialization", async () => {
    for (const override of [undefined, replacement]) {
      const before = providerSessions.length;
      const response = await post(labUrl, labStart(override));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        acceptance: "accepted",
        reply: { sdp: "v=0\r\nanswer" },
      });
      if (override === undefined) expectDefault(observed(before), "gpt-realtime-2.1");
      else
        expectRegistration(
          observed(before),
          "  Speak a short closing, then finish.  ",
          "gpt-realtime-2.1",
        );
      const runId = response.headers.get("X-Lab-Run-Id");
      expect(runId).not.toBeNull();
      expect(observed(before).instructions).toBe("Ask why.");
    }
  });

  it.each(["   ", 42, null])(
    "rejects invalid descriptions (%j) before any native provider creation",
    async (invalid) => {
      const before = providerSessions.length;
      const lab = await post(labUrl, labStart(invalid));
      expect(lab.status).toBe(400);
      expect(providerSessions).toHaveLength(before);
    },
  );

  it("preserves the supported provider prompt reference through the real preparer and native driver", async () => {
    const before = providerSessions.length;
    const response = await platform.dispatchFetch("https://runtime.example/prepared-prompt");
    expect(await response.json()).toMatchObject({
      ok: true,
      value: { answerSdp: "v=0\r\nanswer" },
    });
    const session = observed(before);
    expectRegistration(session, "  Speak a short closing, then finish.  ", "gpt-realtime-2.1");
    expect(session.prompt).toEqual({
      id: "prompt_native",
      version: "2",
      variables: { locale: "en", count: 2, enabled: true },
    });
    expect(session.instructions).toBe("");
  });
});
