import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeWorkerTestHarness as runtimeWorker } from "./runtime.ts";
const runtimeUrl = "https://runtime.example.test";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Runtime Worker routes", () => {
  it("reports Runtime health without Lab D1", async () => {
    const response = await runtimeWorker.fetch(new Request(`${runtimeUrl}/health`), {
      OPENAI_API_KEY: "sk-test-secret",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "runtime",
    });
  });

  it.each(["/_runtime/realtime-calls", "/_runtime/realtime-calls/rtc_123/hangup"])(
    "retires %s without native I/O",
    async (path) => {
      const nativeFetch = vi.fn();
      vi.stubGlobal("fetch", nativeFetch);
      for (const env of [{}, { OPENAI_API_KEY: "sk-test-secret" }]) {
        const response = await runtimeWorker.fetch(
          new Request(`${runtimeUrl}${path}`, { method: "POST", body: "v=0" }),
          env,
        );
        expect(response.status).toBe(404);
        expect(nativeFetch).not.toHaveBeenCalled();
      }
    },
  );
  it("does not serve a direct sideband stream", async () => {
    const nativeFetch = vi.fn();
    vi.stubGlobal("fetch", nativeFetch);
    const response = await runtimeWorker.fetch(
      new Request(
        `${runtimeUrl}/_runtime/sideband-events?runId=run_123&callId=rtc_123&durationMs=1200`,
      ),
      { OPENAI_API_KEY: "sk-test-secret" },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
    expect(nativeFetch).not.toHaveBeenCalled();
  });
});
