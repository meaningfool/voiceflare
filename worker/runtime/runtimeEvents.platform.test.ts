import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { build } from "esbuild";
import { platformBuildOptions } from "../shared/testing/platformBuild.ts";
import { Miniflare } from "miniflare";
import { createConnection } from "node:net";
import { once } from "node:events";

let platform: Miniflare;
let origin: string;

beforeAll(async () => {
  const bundle = await build({
    ...platformBuildOptions,
    stdin: {
      contents: `
        import { InterviewRuntimeController } from "./worker/runtimeHostController.ts";
        import { handleRuntimeControllerRoute } from "./worker/runtime/routes/runtimeController.ts";
        import { originalRealtimeSelection } from "./worker/shared/contracts/conversationSelection.ts";
        import { createInterviewConversationInput, testInterviewInstructions } from "./worker/runtime/testing/interviewConversationPreset.ts";
        export class ProbeController extends InterviewRuntimeController {
          constructor(ctx, env) {
            const counters = { polls: 0, listeners: 0, stops: 0 };
            const sql = ctx.storage.sql;
            const exec = sql.exec.bind(sql);
            sql.exec = (query, ...bindings) => {
              if (query.includes("WHERE id > ? ORDER BY id ASC LIMIT ?")) counters.polls++;
              return exec(query, ...bindings);
            };
            super(ctx, env);
            this.sql = sql;
            this.counters = counters;
          }
          async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === "/probe") {
              const runId = url.searchParams.get("runId");
              const action = url.searchParams.get("action");
              if (action === "initialize") {
                const response = await super.fetch(new Request("https://controller/start", {
                  method: "POST", body: JSON.stringify({
                    runId, selection: originalRealtimeSelection,
                    execution: { agentInput: createInterviewConversationInput(testInterviewInstructions, undefined, 60000) },
                  })
                }));
                if (!response.ok) return response;
                this.sql.exec("DELETE FROM runtime_controller_events");
              }
              if (action === "append") {
                this.runtimeEvents.recordEvent(url.searchParams.get("event"), {
                  token: "ek_sensitive", value: Number(url.searchParams.get("value"))
                });
              }
              if (action === "terminal") this.sql.exec("UPDATE runtime_controller_state SET phase = 'failed'");
              if (action === "failure") this.sql.exec("DROP TABLE runtime_controller_events");
              const state = this.sql.exec("SELECT phase FROM runtime_controller_state").one();
              return Response.json({ ...this.counters, phase: state.phase });
            }
            if (url.pathname === "/required-stop" || url.pathname === "/complete") this.counters.stops++;
            if (url.pathname === "/events") {
              const signal = request.signal;
              const add = signal.addEventListener.bind(signal);
              const remove = signal.removeEventListener.bind(signal);
              signal.addEventListener = (type, ...args) => {
                if (type === "abort") this.counters.listeners++;
                return add(type, ...args);
              };
              signal.removeEventListener = (type, ...args) => {
                if (type === "abort") this.counters.listeners--;
                return remove(type, ...args);
              };
            }
            return super.fetch(request);
          }
        }
        export default { async fetch(request, env) {
          const url = new URL(request.url);
          if (url.pathname === "/probe") {
            return env.INTERVIEW_RUNTIME_CONTROLLER.getByName(url.searchParams.get("runId")).fetch(request);
          }
          const response = await handleRuntimeControllerRoute(request, env);
          return response ?? new Response("missing", { status: 404 });
        }};`,
      resolveDir: process.cwd(),
    },
  });
  platform = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]?.text ?? "",
    compatibilityDate: "2026-06-05",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    durableObjects: {
      INTERVIEW_RUNTIME_CONTROLLER: { className: "ProbeController", useSQLite: true },
    },
  });
  origin = (await platform.ready).origin;
}, 30_000);

afterAll(async () => {
  await platform?.dispose();
});

async function probe(runId: string, action = "status", event = "runtime.live", value = 1) {
  const response = await fetch(
    `${origin}/probe?runId=${runId}&action=${action}&event=${event}&value=${value}`,
  );
  expect(response.ok).toBe(true);
  return z
    .object({ polls: z.number(), listeners: z.number(), stops: z.number(), phase: z.string() })
    .parse(await response.json());
}

function streamUrl(runId: string, durationMs = 10_000) {
  return `${origin}/_runtime/controllers/${runId}/events?durationMs=${durationMs}`;
}

async function readThrough(reader: ReadableStreamDefaultReader<unknown>, expected: string) {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(expected)) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`stream ended before ${expected}: ${text}`);
    if (!(chunk.value instanceof Uint8Array)) throw new Error("invalid_native_stream_chunk");
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

function expectFrame(frame: string, event: string, runId: string, value: number) {
  const lines = frame.split("\n");
  expect(lines).toEqual([`event: ${event}`, expect.stringMatching(/^data: /), "", ""]);
  const payload = z
    .strictObject({
      event: z.string(),
      observedAt: z.iso.datetime(),
      runId: z.string(),
      token: z.string(),
      value: z.number(),
    })
    .parse(JSON.parse(lines[1]?.slice(6) ?? ""));
  expect(payload).toMatchObject({ event, runId, token: "ek_redacted", value });
}

async function assertReleased(runId: string) {
  await expect.poll(async () => (await probe(runId)).listeners).toBe(0);
  const released = await probe(runId);
  await new Promise((resolve) => setTimeout(resolve, 550));
  expect(await probe(runId)).toEqual(released);
  expect(released.stops).toBe(0);
  return released;
}

describe("escaped Runtime HTTP and Durable Object event response on workerd", () => {
  it("replays persisted rows and receives newly appended rows after fetch has returned", async () => {
    const runId = "native_replay";
    await probe(runId, "initialize");
    await probe(runId, "append", "runtime.replay", 1);
    const response = await fetch(streamUrl(runId));
    expect(response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
    if (response.body === null) throw new Error("missing_native_stream_body");
    const reader: ReadableStreamDefaultReader<unknown> = response.body.getReader();
    const replay = await readThrough(reader, "\n\n");
    expectFrame(replay, "runtime.replay", runId, 1);
    await probe(runId, "append", "runtime.live", 2);
    await probe(runId, "terminal");
    let remaining = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new Error("invalid_native_stream_chunk");
      remaining += new TextDecoder().decode(chunk.value);
    }
    expectFrame(remaining, "runtime.live", runId, 2);
    expect((await assertReleased(runId)).phase).toBe("failed");
  });

  it("closes an empty terminal response", async () => {
    const runId = "native_terminal";
    await probe(runId, "initialize");
    await probe(runId, "terminal");
    const response = await fetch(streamUrl(runId));
    expect(await response.text()).toBe("");
    expect((await assertReleased(runId)).phase).toBe("failed");
  });

  it("expires observation without stopping the Interview", async () => {
    const runId = "native_expiry";
    await probe(runId, "initialize");
    const response = await fetch(streamUrl(runId, 100));
    expect(await response.text()).toBe("");
    expect((await assertReleased(runId)).phase).toBe("setup");
  });

  it("emits the supported failure frame and releases polling when native SQL fails", async () => {
    const runId = "native_failure";
    await probe(runId, "initialize");
    await probe(runId, "append", "runtime.replay", 1);
    const response = await fetch(streamUrl(runId));
    if (response.body === null) throw new Error("missing_native_stream_body");
    const reader: ReadableStreamDefaultReader<unknown> = response.body.getReader();
    await readThrough(reader, "\n\n");
    await probe(runId, "failure");
    const failure = await readThrough(reader, "\n\n");
    expect(failure).toContain(
      'event: session.failed\ndata: {"event":"session.failed","runId":"native_failure","message":',
    );
    expect(failure).toContain("no such table: runtime_controller_events");
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect((await assertReleased(runId)).phase).toBe("setup");
  });

  it("releases polling on an actual client socket reset through Runtime HTTP → DO", async () => {
    const runId = "native_cancel";
    await probe(runId, "initialize");
    await probe(runId, "append", "runtime.replay", 1);
    const url = new URL(streamUrl(runId));
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`);
    let received = "";
    await new Promise<void>((resolve, reject) => {
      socket.on("data", (chunk) => {
        received += chunk.toString();
        if (received.includes('"value":1}')) resolve();
      });
      socket.once("error", reject);
    });
    expect((await probe(runId)).listeners).toBe(1);
    const closed = once(socket, "close");
    socket.resetAndDestroy();
    await closed;
    expect((await assertReleased(runId)).phase).toBe("setup");
  });
});
