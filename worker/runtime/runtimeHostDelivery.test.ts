import { describe, expect, it, vi } from "vitest";
import { createRuntimeHostDelivery, decodeDeliveryIdentity } from "../runtimeHostDelivery.ts";
import {
  decodeRetainedDeliveryTarget,
  decodeRuntimeDeliveryTarget,
} from "../shared/contracts/runtimeDelivery.ts";
import type { RuntimeDeliveryTarget } from "../shared/contracts/runtimeDelivery.ts";
import type { ApplicationCallbacks } from "./applicationCallbacks.ts";
import type { TestApplicationEnvironment } from "./testing/applicationCallbacks.ts";

const target: RuntimeDeliveryTarget = { integration: "test", context: { runId: "run_a" } };

function application() {
  const authorizeDelivery = vi.fn(async (request: Request) =>
    Response.json({ runId: new URL(request.url).searchParams.get("runId"), authorized: true }),
  );
  const receive = () => vi.fn(async (_request: Request) => Response.json({ ok: true }));
  const callbacks = {
    authorizeDelivery,
    readiness: receive(),
    transcript: receive(),
    completion: receive(),
    startupDiagnostic: receive(),
  } satisfies ApplicationCallbacks;
  const calls = () =>
    (["readiness", "transcript", "completion", "startupDiagnostic"] as const).flatMap((name) =>
      callbacks[name].mock.calls.map(([request]) => ({ name, url: request.url })),
    );
  return { callbacks, authorizeDelivery, calls };
}

function fixture() {
  const testApp = application();
  const lab = application();
  const env: TestApplicationEnvironment = {
    TEST_CALLBACK_WORKER: testApp.callbacks,
    LAB_CALLBACK_WORKER: lab.callbacks,
  };
  return { testApp, lab, delivery: createRuntimeHostDelivery(env) };
}

function post(body: Readonly<{ runId: string }> | Readonly<{ completion: { runId: string } }>) {
  // An address the caller chose reaches no application.
  return new Request("https://stored.test/elsewhere?token=forged", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("host-owned Runtime delivery targets", () => {
  it.each(["test", "lab"] as const)(
    "admits and calls each named callback of the configured %s application",
    async (integration) => {
      const f = fixture();
      const selection = decodeRetainedDeliveryTarget(
        JSON.stringify({ integration, context: { runId: "run_a" } }),
      );
      await f.delivery.authorize(selection, "run_a", Date.now() + 30_000);
      for (const callback of ["readiness", "transcript", "completion"] as const)
        await f.delivery.deliver(selection, callback, post({ runId: "run_a" }));
      await f.delivery.diagnostic?.(selection, post({ runId: "run_a" }));
      const [called, other] = integration === "test" ? [f.testApp, f.lab] : [f.lab, f.testApp];
      expect(called.authorizeDelivery.mock.calls.map(([request]) => request.url)).toEqual([
        "https://application-delivery.internal/authorize?runId=run_a",
      ]);
      // The stored URL is an envelope only: each request names the callback Runtime called.
      expect(called.calls()).toEqual([
        { name: "readiness", url: "https://application-delivery.internal/readiness" },
        { name: "transcript", url: "https://application-delivery.internal/transcript" },
        { name: "completion", url: "https://application-delivery.internal/completion" },
        {
          name: "startupDiagnostic",
          url: "https://application-delivery.internal/startupDiagnostic",
        },
      ]);
      expect(other.authorizeDelivery).not.toHaveBeenCalled();
      expect(other.calls()).toEqual([]);
    },
  );

  it.each([
    { integration: "unknown", context: { runId: "run_a" } },
    { integration: "test", context: {} },
    { integration: "test", context: { runId: 42 } },
    { integration: "test", context: { runId: "run_b" } },
    { integration: "test", context: { runId: "run_a", extra: true } },
    { integration: "lab", context: { runId: { id: "run_a" } } },
  ])("refuses invalid or mismatched context before calling a receiver: %j", async (candidate) => {
    const f = fixture();
    await expect(f.delivery.authorize(candidate, "run_a", Date.now() + 30_000)).rejects.toThrow();
    for (const called of [f.testApp, f.lab]) {
      expect(called.authorizeDelivery).not.toHaveBeenCalled();
      expect(called.calls()).toEqual([]);
    }
  });

  it("refuses an inherited context runId at the actual host decoder", async () => {
    const f = fixture();
    const context = {};
    Object.setPrototypeOf(context, { runId: "run_a" });
    await expect(
      f.delivery.authorize({ integration: "test", context }, "run_a", Date.now() + 30_000),
    ).rejects.toThrow();
    expect(f.testApp.authorizeDelivery).not.toHaveBeenCalled();
  });

  it("rejects missing, mistyped, extra and inherited target properties at the real target decoder", () => {
    const inherited = { context: target.context };
    Object.setPrototypeOf(inherited, { integration: "test" });
    for (const value of [
      { context: {} },
      { integration: 42, context: {} },
      { integration: "test", context: {}, extra: true },
      inherited,
    ]) {
      expect(() => decodeRuntimeDeliveryTarget(value)).toThrow();
    }
    expect(() =>
      decodeRetainedDeliveryTarget('{"integration":"test","context":null,"extra":true}'),
    ).toThrow();
  });

  it("refuses a delivery for another Run without calling either application", async () => {
    const f = fixture();
    await expect(
      f.delivery.deliver(target, "completion", post({ completion: { runId: "run_b" } })),
    ).rejects.toThrow("runtime_delivery_run_mismatch");
    expect(f.testApp.calls()).toEqual([]);
    expect(f.lab.calls()).toEqual([]);
  });

  it("keeps a contradictory admission reply and original expiry from accepting a Run", async () => {
    const f = fixture();
    f.testApp.authorizeDelivery.mockResolvedValueOnce(
      Response.json({ runId: "run_b", authorized: true }),
    );
    await expect(f.delivery.authorize(target, "run_a", Date.now() + 30_000)).rejects.toThrow(
      "runtime_delivery_run_mismatch",
    );
    f.testApp.authorizeDelivery.mockClear();
    await expect(f.delivery.authorize(target, "run_a", Date.now())).rejects.toThrow(
      "runtime_delivery_admission_expired",
    );
    expect(f.testApp.authorizeDelivery).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { runId: "run_a", authorized: false },
    { runId: "run_a", authorized: { yes: true } },
    { runId: 42, authorized: true },
    { runId: "run_a", authorized: true, extra: true },
  ])("refuses an invalid admission receipt before accepting setup: %j", async (receipt) => {
    const f = fixture();
    f.testApp.authorizeDelivery.mockResolvedValueOnce(Response.json(receipt));
    await expect(f.delivery.authorize(target, "run_a", Date.now() + 30_000)).rejects.toThrow();
    expect(f.testApp.calls()).toEqual([]);
  });

  it.each([
    { configured: "lab", refused: "test" },
    { configured: "test", refused: "lab" },
  ] as const)(
    "refuses $refused delivery as unconfigured on a Runtime that binds $configured alone",
    async ({ configured, refused }) => {
      const only = application();
      const env: TestApplicationEnvironment =
        configured === "lab"
          ? { LAB_CALLBACK_WORKER: only.callbacks }
          : { TEST_CALLBACK_WORKER: only.callbacks };
      const delivery = createRuntimeHostDelivery(env);
      const selection = { integration: refused, context: { runId: "run_a" } };
      await expect(delivery.authorize(selection, "run_a", Date.now() + 30_000)).rejects.toThrow(
        "runtime_delivery_unconfigured",
      );
      await expect(
        delivery.deliver(selection, "completion", post({ completion: { runId: "run_a" } })),
      ).rejects.toThrow("runtime_delivery_unconfigured");
      expect(only.authorizeDelivery).not.toHaveBeenCalled();
      expect(only.calls()).toEqual([]);
    },
  );

  it("decodes the current owned delivery identity and rejects malformed or inherited identity fields", () => {
    expect(decodeDeliveryIdentity({ runId: "run_a", other: true })).toBe("run_a");
    expect(decodeDeliveryIdentity({ completion: { runId: "run_a", other: true } })).toBe("run_a");
    const inheritedTop = {};
    Object.setPrototypeOf(inheritedTop, { runId: "run_a" });
    const inheritedNested = {};
    Object.setPrototypeOf(inheritedNested, { runId: "run_a" });
    for (const value of [
      {},
      { runId: 42 },
      { completion: { runId: 42 } },
      { completion: {} },
      inheritedTop,
      { completion: inheritedNested },
    ])
      expect(() => decodeDeliveryIdentity(value)).toThrow();
  });
});
