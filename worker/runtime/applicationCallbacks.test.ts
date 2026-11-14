import { describe, expect, it, vi } from "vitest";
import { deliverBoundedCallback } from "./applicationCallbacks.ts";

function request(signal: AbortSignal) {
  return new Request("https://application-delivery.internal/readiness", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Runtime-Callback": "interview-runtime-controller",
    },
    body: '{"runId":"stored-run","liveAt":42}',
    signal,
  });
}

describe("bounded application callback transport", () => {
  it("preserves the stored request and detaches the caller signal", async () => {
    const controller = new AbortController();
    const original = request(controller.signal);
    const invoke = vi.fn(async (forwarded: Request) => {
      expect(forwarded.url).toBe(original.url);
      expect(forwarded.method).toBe("POST");
      expect([...forwarded.headers]).toEqual([...original.headers]);
      expect(await forwarded.text()).toBe('{"runId":"stored-run","liveAt":42}');
      controller.abort(new Error("after_delivery"));
      expect(forwarded.signal.aborted).toBe(false);
      return Response.json({ ok: true });
    });
    await expect(deliverBoundedCallback(invoke, original)).rejects.toThrow("after_delivery");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("never dispatches an already aborted request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already_cancelled"));
    const invoke = vi.fn(async () => Response.json({ ok: true }));
    await expect(deliverBoundedCallback(invoke, request(controller.signal))).rejects.toThrow(
      "already_cancelled",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cancels local receipt reading and disposes the RPC result once on abort", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const dispose = vi.fn();
    let started: (() => void) | undefined;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          if (started === undefined) throw new Error("receipt_reader_not_initialized");
          started();
        },
        cancel,
      }),
    );
    const call = Object.assign(Promise.resolve(response), { [Symbol.dispose]: dispose });
    const delivery = deliverBoundedCallback(() => call, request(controller.signal));
    await reading;
    controller.abort(new Error("receipt_cancelled"));
    await expect(delivery).rejects.toThrow("receipt_cancelled");
    expect(cancel).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("buffers the acknowledgement before disposing its RPC result", async () => {
    const dispose = vi.fn();
    const call = Object.assign(Promise.resolve(Response.json({ ok: true })), {
      [Symbol.dispose]: dispose,
    });
    const response = await deliverBoundedCallback(
      () => call,
      request(new AbortController().signal),
    );
    expect(dispose).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ ok: true });
  });
});
