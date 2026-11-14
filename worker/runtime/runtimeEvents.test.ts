import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RuntimeEvents,
  recordStartupDiagnostic,
  type RuntimeEventContext,
  type RuntimeEventPayload,
  type RuntimeEventRow,
  type RuntimeEventStorage,
} from "./runtimeEvents.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Runtime Events", () => {
  it("keeps startup progress independent of diagnostic storage and callback failures", () => {
    const failing = {
      recordUniqueDiagnostic: () => {
        throw new Error("storage failed");
      },
    };
    expect(() =>
      recordStartupDiagnostic(failing, { stage: "runtimeAccepted", at: 100 }),
    ).not.toThrow();
    const storage = new MemoryRuntimeEventStorage();
    const events = new RuntimeEvents(
      storage,
      () => activeContext(),
      () => {
        throw new Error("callback failed");
      },
    );
    expect(() =>
      recordStartupDiagnostic(events, { stage: "runtimeAccepted", at: 100 }),
    ).not.toThrow();
    expect(storage.rows).toHaveLength(1);
  });
  it("redacts open event payloads without restricting event names", () => {
    const storage = new MemoryRuntimeEventStorage();
    const events = new RuntimeEvents(storage, () => activeContext());

    events.recordEvent("feature.new_event", { token: "ek_sensitive", value: 7 });

    expect(storage.rows).toEqual([
      {
        id: 1,
        event_name: "feature.new_event",
        payload_json: JSON.stringify({ token: "ek_redacted", value: 7 }),
      },
    ]);
  });

  it("adds diagnostic context, redacts secrets, and preserves elapsed time and sequence", () => {
    const storage = new MemoryRuntimeEventStorage();
    const events = new RuntimeEvents(storage, () => ({
      runId: "run_events",
      sessionId: "call_events",
      startedAt: 1_000,
      diagnosticsContextJson: JSON.stringify({ surface: "test", responseId: "response_1" }),
      live: true,
      terminal: false,
    }));
    vi.spyOn(Date, "now").mockReturnValue(1_250);

    const first = events.recordDiagnostic("runtime.first", {
      apiKey: "sk-sensitive",
      omitted: undefined,
    });
    const second = events.recordDiagnostic("runtime.second", {}, { observedAt: 1_500 });

    expect(first).toEqual({
      recordId: "run_events:1",
      runId: "run_events",
      source: "runtime",
      selection: null,
      visitId: null,
      operationId: null,
      observedAt: 1_250,
      sequence: 1,
      elapsedMs: 250,
      type: "runtime.first",
      payloadJson: JSON.stringify({
        surface: "test",
        responseId: "response_1",
        apiKey: "sk-redacted",
      }),
    });
    expect(second?.sequence).toBe(2);
    expect(second?.elapsedMs).toBe(500);
  });

  it("records a matching unique diagnostic once", () => {
    const storage = new MemoryRuntimeEventStorage();
    const events = new RuntimeEvents(storage, () => activeContext());

    expect(
      events.recordUniqueDiagnostic(
        "runtime.live_degraded",
        (payload) => payload.degradationKind === "provider_error",
        { degradationKind: "provider_error" },
      ),
    ).not.toBeNull();
    expect(
      events.recordUniqueDiagnostic(
        "runtime.live_degraded",
        (payload) => payload.degradationKind === "provider_error",
        { degradationKind: "provider_error" },
      ),
    ).toBeNull();
    expect(storage.readEventsAfter(0)).toHaveLength(1);
  });

  it("validates declared execution payloads and preserves valid omission evidence under redaction and size limits", () => {
    const storage = new MemoryRuntimeEventStorage();
    const events = new RuntimeEvents(storage, () => activeContext());
    const contribute = events.executionDiagnostics({
      "execution.observation": z.strictObject({
        value: z.union([z.string(), z.array(z.string())]),
      }),
      "execution.sensitive_payload": z.strictObject({ text: z.string() }),
      "execution.secret_literal": z.strictObject({ value: z.literal("sk-sensitive") }),
    });
    contribute("execution.observation", {
      value: Array.from({ length: 8 }, () => "x".repeat(500)),
    });
    contribute("execution.secret_literal", { value: "sk-sensitive" });
    contribute("execution.sensitive_payload", { text: "participant content" });
    // Raw extension authors get actionable rejection evidence without a Run failure.
    expect(() =>
      events.recordConversationDiagnostics(
        { "execution.observation": z.strictObject({ value: z.string() }) },
        [
          { type: "execution.observation", payload: { value: 42 } },
          { type: "undeclared.name", payload: {} },
        ],
      ),
    ).not.toThrow();
    const page = events.readDiagnostics("run_events", 0);
    expect(page.records.map((record) => ({ source: record.source, type: record.type }))).toEqual([
      { source: "execution", type: "execution.observation" },
      { source: "execution", type: "execution.secret_literal" },
      { source: "execution", type: "execution.sensitive_payload" },
      { source: "runtime", type: "runtime.diagnostic_rejected" },
      { source: "runtime", type: "runtime.diagnostic_rejected" },
    ]);
    expect(
      page.records.slice(0, 3).map((record) => z.json().parse(JSON.parse(record.payloadJson))),
    ).toEqual([
      { diagnosticOmitted: true, reason: "payload_size" },
      { diagnosticOmitted: true, reason: "redaction_invalid" },
      { diagnosticOmitted: true, reason: "redaction_invalid" },
    ]);
    expect(page.records[3]?.payloadJson).toContain("invalid_diagnostic execution.observation");
    expect(page.records[4]?.payloadJson).toContain("undeclared_diagnostic");
    expect(() => events.notifyControl("runtime.event_recorded", {})).toThrow(
      "diagnostic_construction_reserved",
    );
  });

  it("leaves native attribution unavailable when Runtime cannot correlate the response", () => {
    const storage = new MemoryRuntimeEventStorage();
    const events = new RuntimeEvents(storage, () => ({
      ...activeContext(),
      visitId: "current-visit",
      operationId: "current-operation",
    }));
    const contribute = events.executionDiagnostics({ "execution.observation": z.object({}) });
    contribute("execution.observation", {}, { responseId: "unknown-response" });
    contribute("execution.observation", {}, { responseId: null });
    expect(events.readDiagnostics("run_events", 0).records).toEqual([
      expect.objectContaining({ visitId: null, operationId: null }),
      expect.objectContaining({ visitId: null, operationId: null }),
    ]);
  });

  it("reads persisted events after the requested cursor", () => {
    const storage = new MemoryRuntimeEventStorage();
    storage.recordControllerEvent("runtime.first", { value: 1 });
    storage.recordControllerEvent("runtime.second", { value: 2 });
    const events = new RuntimeEvents(storage, () => activeContext());

    expect(events.readAfterCursor(1)).toEqual([
      expect.objectContaining({ id: 2, event_name: "runtime.second" }),
    ]);
  });

  it("streams persisted event names and payloads in cursor order", async () => {
    vi.useFakeTimers();
    const storage = new MemoryRuntimeEventStorage();
    storage.recordControllerEvent("runtime.first", { value: 1 });
    storage.recordControllerEvent("runtime.second", { value: 2 });
    let terminal = false;
    const events = new RuntimeEvents(storage, () => ({ ...activeContext(), terminal }));
    const body = events.createStreamResponse("run_events", 1_000).text();
    terminal = true;
    await vi.advanceTimersByTimeAsync(250);

    await expect(body).resolves.toBe(
      'event: runtime.first\ndata: {"value":1}\n\nevent: runtime.second\ndata: {"value":2}\n\n',
    );
  });

  it("continues replay into newly accepted rows before draining a terminal stream", async () => {
    vi.useFakeTimers();
    const storage = new MemoryRuntimeEventStorage();
    storage.recordControllerEvent("runtime.replay", { value: 1 });
    let terminal = false;
    const events = new RuntimeEvents(storage, () => ({ ...activeContext(), terminal }));
    const body = events.createStreamResponse("run_events", 1_000).text();
    events.recordEvent("runtime.live", { token: "ek_sensitive", value: 2 });
    terminal = true;
    await vi.advanceTimersByTimeAsync(500);

    await expect(body).resolves.toBe(
      'event: runtime.replay\ndata: {"value":1}\n\nevent: runtime.live\ndata: {"token":"ek_redacted","value":2}\n\n',
    );
  });

  it("expires from construction even when body consumption starts later", async () => {
    vi.useFakeTimers();
    const storage = new MemoryRuntimeEventStorage();
    const events = new RuntimeEvents(storage, () => activeContext());
    const response = events.createStreamResponse("run_events", 300);
    await vi.advanceTimersByTimeAsync(500);
    events.recordEvent("runtime.too_late", { value: 1 });

    await expect(response.text()).resolves.toBe("");
  });

  it.each(["body", "request"])("releases polling on %s cancellation", async (kind) => {
    vi.useFakeTimers();
    const storage = new MemoryRuntimeEventStorage();
    const observation = new AbortController();
    const events = new RuntimeEvents(storage, () => activeContext());
    const response = events.createStreamResponse("run_events", 10_000, observation.signal);
    if (kind === "body") await response.body?.cancel();
    else observation.abort();
    const polls = storage.polls;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(storage.polls).toBe(polls);
    expect(vi.getTimerCount()).toBe(0);
    if (kind === "request") await expect(response.text()).resolves.toBe("");
  });

  it("does not begin observation for an already aborted request", async () => {
    const storage = new MemoryRuntimeEventStorage();
    const observation = new AbortController();
    observation.abort();
    const events = new RuntimeEvents(storage, () => activeContext());

    await expect(
      events.createStreamResponse("run_events", 1_000, observation.signal).text(),
    ).resolves.toBe("");
    expect(storage.polls).toBe(0);
  });

  it("returns the established SSE headers and closes an empty terminal stream", async () => {
    const storage = new MemoryRuntimeEventStorage();
    const events = new RuntimeEvents(storage, () => ({ ...activeContext(), terminal: true }));

    const response = events.createStreamResponse("run_events", 1_000);

    expect(response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Connection")).toBe("keep-alive");
    await expect(response.text()).resolves.toBe("");
  });

  it("represents stream storage failures as session.failed", async () => {
    const storage = new MemoryRuntimeEventStorage();
    storage.readFailure = new Error("storage sk-sensitive unavailable");
    const events = new RuntimeEvents(storage, () => activeContext());

    await expect(events.createStreamResponse("run_events", 1_000).text()).resolves.toBe(
      'event: session.failed\ndata: {"event":"session.failed","runId":"run_events","message":"storage sk-redacted unavailable"}\n\n',
    );
  });
});

class MemoryRuntimeEventStorage implements RuntimeEventStorage {
  readonly rows: RuntimeEventRow[] = [];
  readFailure: Error | null = null;
  polls = 0;

  recordControllerEvent(eventName: string, payload: RuntimeEventPayload = {}): void {
    this.rows.push({
      id: this.rows.length + 1,
      event_name: eventName,
      payload_json: JSON.stringify(payload),
    });
  }

  readEventsAfter(cursor: number, limit = 100): RuntimeEventRow[] {
    this.polls += 1;
    if (this.readFailure !== null) throw this.readFailure;
    return this.rows.filter((row) => row.id > cursor).slice(0, limit);
  }

  readEventsByName(eventName: string): RuntimeEventRow[] {
    return this.rows.filter((row) => row.event_name === eventName);
  }
}

function activeContext(): RuntimeEventContext {
  return {
    runId: "run_events",
    sessionId: "call_events",
    startedAt: 1_000,
    diagnosticsContextJson: "{}",
    live: true,
    terminal: false,
  };
}
