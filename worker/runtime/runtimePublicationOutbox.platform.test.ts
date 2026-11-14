import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { platformBuildOptions } from "../shared/testing/platformBuild.ts";
import { Miniflare } from "miniflare";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

let platform: Miniflare;
let server: Server;
let origin: string;
const received: string[] = [];
const closed: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? "";
    received.push(path);
    response.on("close", () => closed.push(path));
    if (path === "/body") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"ok":');
    }
    // Leave native headers/body pending until the caller aborts; teardown closes sockets.
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
        import { attemptRuntimePublication } from "./worker/runtime/runtimePublicationOutbox.ts";
        export default { async fetch(request) {
          const params = new URL(request.url).searchParams;
          let dispatched = 0;
          let signal;
          const result = await Effect.runPromise(attemptRuntimePublication({
            target: { kind: "failed_to_start", result: { outcome: "failed_to_start", runId: "native_http_probe", endedAt: 1000, runtimeUsage: { completeness: "complete", observations: [] } } },
            timeoutMs: Number(params.get("budget")),
            // The probe sends the attempt to the native HTTP server instead of an application.
            fetch: (input) => { dispatched++; signal = input.signal; return fetch(new Request(params.get("target"), input)); },
          }));
          return Response.json({ result, dispatched, aborted: signal?.aborted ?? false });
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
}, 30_000);

afterAll(async () => {
  await platform?.dispose();
  server?.closeAllConnections();
  server?.close();
});

async function attempt(path: string, budget: number) {
  return (
    await platform.dispatchFetch(
      `https://probe.test/?target=${encodeURIComponent(origin + path)}&budget=${budget}`,
    )
  ).json();
}

describe("bounded publication native HTTP on workerd", () => {
  it.each(["/headers", "/body"])(
    "aborts native HTTP waiting for %s within the original budget",
    async (path) => {
      expect(await attempt(path, 100)).toEqual({
        result: { delivered: false, error: "callback_timed_out", disposition: "retryable" },
        dispatched: 1,
        aborted: true,
      });
      expect(received).toContain(path);
      await expect.poll(() => closed.includes(path)).toBe(true);
    },
  );
});
