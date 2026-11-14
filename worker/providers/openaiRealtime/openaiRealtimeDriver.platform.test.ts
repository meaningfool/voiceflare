import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { platformBuildOptions } from "../../shared/testing/platformBuild.ts";
import { Miniflare, Response as NativeResponse, type Request as NativeRequest } from "miniflare";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

let platform: Miniflare;
let defaultTransportPlatform: Miniflare;
let injectedTransportPlatform: Miniflare;
let sidebandProvider: Miniflare;
let sidebandOrigin: URL;
let server: Server;
let origin: string;
const received: string[] = [];
const closed: string[] = [];
const providerRequests: Array<{ url: string; method: string; authorization: string | null }> = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? "";
    received.push(path);
    response.on("close", () => closed.push(path));
    if (path === "/hangup-typed-failure-stalled") {
      response.writeHead(503, { "x-request-id": "req_hangup_failure" });
      response.write("partial failure");
    }
    if (path === "/body" || path === "/hangup-body") {
      response.writeHead(path === "/body" ? 201 : 200, {
        "Content-Type": "application/sdp",
        Location: "https://api.openai.com/v1/realtime/calls/rtc_native",
        "x-request-id": "req_native",
      });
      response.write("v=0\r\n");
    }
    if (path === "/read-failed") {
      response.writeHead(201, { Location: "https://api.openai.com/v1/realtime/calls/rtc_native" });
      response.write("partial");
      setTimeout(() => response.destroy(), 10);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing_probe_address");
  origin = `http://127.0.0.1:${address.port}`;
  const bundle = await build({
    ...platformBuildOptions,
    stdin: {
      contents: `import { Effect } from "effect";
        import { openAiDriverOver } from "./worker/providers/openaiRealtime/testing/testDriver.ts";
        import { composeRealtimeSession, prepareRealtimeSettings } from "./worker/providers/openaiRealtime/preparedModelSession.ts";
        // OpenAI's driver through its service, on the given transport (the platform's fetch without one).
        const driverOn = (transport) => openAiDriverOver(transport);
        const run = (operation) => Effect.runPromise(operation);
        const session = composeRealtimeSession(
          "probe",
          { instructions: { kind: "literal", text: "probe" }, operationalInstructions: "", tools: [] },
          prepareRealtimeSettings({ reasoningEffort: null }),
        );
        export default { async fetch(request, env, ctx) {
          const params = new URL(request.url).searchParams;
          if (params.has("upgrade")) {
            let acquisitionSignal;
            const result = await run(driverOn((url, init) => { acquisitionSignal = init.signal; return fetch(params.get("upgrade"), init); }).connectSideband({
              apiKey: "probe", callId: "rtc_upgrade", emit: () => {}, retryDeadlineAt: Date.now() + 1000,
            }));
            if (!result.ok) return Response.json({ result });
            const socket = result.value;
            const reply = await new Promise((resolve) => {
              const timer = setTimeout(() => resolve({ kind: "timeout" }), 1000);
              const finish = (value) => { clearTimeout(timer); resolve(value); };
              socket.addEventListener("message", (event) => finish({ kind: "message", data: event.data }));
              socket.addEventListener("close", (event) => finish({ kind: "close", code: event.code }));
              socket.addEventListener("error", () => finish({ kind: "error" }));
              try { socket.send("post-acquisition-probe"); }
              catch (error) { finish({ kind: "send_failed", message: error.message }); }
            });
            const readyState = socket.readyState;
            socket.close(1000, "probe_completed");
            return Response.json({ reply, readyState, acquisitionAborted: acquisitionSignal.aborted });
          }
          if (params.has("default")) {
            try {
              const operation = params.get("default");
              const fetchImpl = params.get("transport") === "injected" ? fetch : undefined;
              const identities = [];
              const driver = driverOn(fetchImpl);
              const result = await run(operation === "hangup"
                ? driver.hangUp({ apiKey: "probe", callId: "rtc_default", timeoutMs: 1000 })
                : operation === "sideband"
                  ? driver.connectSideband({ apiKey: "probe", callId: "rtc_" + params.get("transport"), emit: () => {}, retryDeadlineAt: Date.now() + 1000 })
                  : driver.createCall({
                      apiKey: "probe", sdp: "offer", session,
                      deadlineAt: Date.now() + 1000,
                      onCallIdentified: (identity) => { identities.push(identity.sessionId); },
                      retainCallIdentity: (task) => ctx.waitUntil(task),
                    }));
              return Response.json({ result, identities });
            } catch (error) {
              return Response.json({ errorName: error.name, errorMessage: error.message });
            }
          }
          const target = params.get("target");
          const budget = Number(params.get("budget"));
          let dispatched = 0;
          let signal;
          const identities = [];
          const transport = (url, init) => { dispatched++; signal = init.signal; return fetch(target, init); };
          const result = await run(params.get("hangup") === "yes"
            ? driverOn(transport).hangUp({ apiKey: "probe", callId: "rtc_native", timeoutMs: budget })
            : driverOn(transport).createCall({
                apiKey: "probe", sdp: "offer", session,
                deadlineAt: Date.now() + budget,
                onCallIdentified: (identity) => { identities.push(identity.sessionId); },
                retainCallIdentity: (task) => ctx.waitUntil(task),
              }));
          return Response.json({ result, dispatched, identities, aborted: signal?.aborted ?? false });
        }};`,
      resolveDir: process.cwd(),
    },
  });
  platform = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]?.text ?? "",
    compatibilityDate: "2026-06-05",
    compatibilityFlags: ["nodejs_compat"],
  });
  const nativeTransportOptions = {
    modules: true,
    script: bundle.outputFiles[0]?.text ?? "",
    compatibilityDate: "2026-06-05",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    outboundService: async (request: NativeRequest) => {
      providerRequests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("Authorization"),
      });
      const url = new URL(request.url);
      if (url.pathname === "/v1/realtime/calls") {
        return new NativeResponse("answer-sdp", {
          status: 201,
          headers: {
            "Content-Type": "application/sdp",
            Location: "https://api.openai.com/v1/realtime/calls/rtc_default",
            "x-request-id": "req_default_create",
          },
        });
      }
      if (url.pathname === "/v1/realtime/calls/rtc_default/hangup") {
        return new NativeResponse(null, {
          status: 200,
          headers: { "x-request-id": "req_default_hangup" },
        });
      }
      if (url.pathname === "/v1/realtime") {
        return new NativeResponse("sideband rejected", {
          status: 403,
          headers: { "x-request-id": "req_default_sideband" },
        });
      }
      throw new Error("unexpected_provider_request");
    },
  };
  defaultTransportPlatform = new Miniflare(nativeTransportOptions);
  injectedTransportPlatform = new Miniflare(nativeTransportOptions);
  const sidebandBundle = await build({
    ...platformBuildOptions,
    stdin: {
      contents: `import { serveFakeRealtimeSideConnection } from "./worker/providers/openaiRealtime/testing/fakeSideConnection.ts";
        export default { fetch() {
          const { response, provider } = serveFakeRealtimeSideConnection();
          provider.addEventListener("message", () => provider.send("sideband-after-acquisition"));
          provider.addEventListener("close", () => provider.close());
          return response;
        }};`,
      resolveDir: process.cwd(),
    },
  });
  sidebandProvider = new Miniflare({
    modules: true,
    compatibilityDate: "2026-06-05",
    script: sidebandBundle.outputFiles[0]?.text ?? "",
  });
  sidebandOrigin = await sidebandProvider.ready;
}, 30_000);

afterAll(async () => {
  await platform?.dispose();
  await defaultTransportPlatform?.dispose();
  await injectedTransportPlatform?.dispose();
  await sidebandProvider?.dispose();
  server?.closeAllConnections();
  server?.close();
});

async function attempt(path: string, budget: number, hangup = false) {
  return (
    await platform.dispatchFetch(
      `https://probe.test/?target=${encodeURIComponent(origin + path)}&budget=${budget}&hangup=${hangup ? "yes" : "no"}`,
    )
  ).json();
}

describe("finite provider native HTTP on workerd", () => {
  it("keeps a fetched native sideband open after successful acquisition returns", async () => {
    const response = await platform.dispatchFetch(
      `https://probe.test/?upgrade=${encodeURIComponent(sidebandOrigin.href)}`,
    );
    expect(await response.json()).toMatchObject({
      reply: { kind: "message", data: "sideband-after-acquisition" },
      readyState: 1,
    });
  });

  it.each(
    [
      {
        operation: "create",
        url: "https://api.openai.com/v1/realtime/calls",
        method: "POST",
        expected: {
          result: {
            ok: true,
            value: {
              status: 201,
              answerSdp: "answer-sdp",
              responseContentType: "application/sdp",
              sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_default",
              sessionId: "rtc_default",
              upstreamRequestId: "req_default_create",
            },
          },
          identities: ["rtc_default"],
        },
      },
      {
        operation: "hangup",
        url: "https://api.openai.com/v1/realtime/calls/rtc_default/hangup",
        method: "POST",
        expected: {
          result: { ok: true, value: { status: 200, upstreamRequestId: "req_default_hangup" } },
          identities: [],
        },
      },
      {
        operation: "sideband",
        url: "https://api.openai.com/v1/realtime?call_id=rtc_default",
        method: "GET",
        expected: {
          result: {
            ok: false,
            failure: {
              kind: "provider_failure",
              stage: "session_setup",
              code: "sideband_connect_rejected",
              providerStatus: 403,
              requestId: "req_default_sideband",
              retryable: false,
            },
          },
          identities: [],
        },
      },
    ].flatMap((scenario) =>
      ["default", "injected"].map((transport) => ({
        ...scenario,
        transport,
        url:
          scenario.operation === "sideband"
            ? `https://api.openai.com/v1/realtime?call_id=rtc_${transport}`
            : scenario.url,
      })),
    ),
  )(
    "dispatches native $transport fetch for $operation",
    async ({ operation, transport, url, method, expected }) => {
      const previousRequests = providerRequests.length;
      const nativePlatform =
        transport === "default" ? defaultTransportPlatform : injectedTransportPlatform;
      expect(
        await (
          await nativePlatform.dispatchFetch(
            `https://probe.test/?default=${operation}&transport=${transport}`,
          )
        ).json(),
      ).toEqual(expected);
      expect(providerRequests.slice(previousRequests)).toEqual([
        { url, method, authorization: "Bearer probe" },
      ]);
    },
  );

  it.each(["/headers", "/body"])("aborts native create waiting for %s", async (path) => {
    expect(await attempt(path, 100)).toMatchObject({
      result: {
        ok: false,
        failure: {
          code:
            path === "/headers"
              ? "provider_call_request_failed"
              : "provider_call_response_read_failed",
        },
      },
      dispatched: 1,
      identities: path === "/headers" ? [] : ["rtc_native"],
      aborted: true,
    });
    expect(received.filter((item) => item === path)).toHaveLength(1);
    await expect.poll(() => closed.includes(path)).toBe(true);
  });

  it("retains known identity when the native body read fails", async () => {
    expect(await attempt("/read-failed", 1000)).toMatchObject({
      result: { ok: false, failure: { code: "provider_call_response_read_failed" } },
      dispatched: 1,
      identities: ["rtc_native"],
      aborted: true,
    });
  });

  it("times out native hangup headers without retrying the mutation", async () => {
    expect(await attempt("/hangup-headers", 100, true)).toMatchObject({
      result: { ok: false, failure: { code: "session_release_timed_out", timeoutMs: 100 } },
      dispatched: 1,
      aborted: true,
    });
    expect(received.filter((path) => path === "/hangup-headers")).toHaveLength(1);
    await expect.poll(() => closed.includes("/hangup-headers")).toBe(true);
  });

  it("keeps typed hangup failure outcomes header-based despite an unused stalled body", async () => {
    expect(await attempt("/hangup-typed-failure-stalled", 1000, true)).toMatchObject({
      result: {
        ok: false,
        failure: {
          code: "session_release_failed",
          providerStatus: 503,
          requestId: "req_hangup_failure",
        },
      },
      dispatched: 1,
      aborted: true,
    });
    expect(received.filter((path) => path === "/hangup-typed-failure-stalled")).toHaveLength(1);
    await expect.poll(() => closed.includes("/hangup-typed-failure-stalled")).toBe(true);
  });

  it("uses hangup headers despite a stalled native body", async () => {
    expect(await attempt("/hangup-body", 1000, true)).toMatchObject({
      result: { ok: true, value: { status: 200, upstreamRequestId: "req_native" } },
      dispatched: 1,
      aborted: true,
    });
    expect(received.filter((path) => path === "/hangup-body")).toHaveLength(1);
    await expect.poll(() => closed.includes("/hangup-body")).toBe(true);
  });
});
