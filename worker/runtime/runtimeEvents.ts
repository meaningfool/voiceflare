import { sanitizeDiagnosticPayload } from "../shared/diagnosticPayload.ts";
import { Clock, Data, Effect, type Exit } from "effect";
import { z } from "zod";
import {
  describeDiagnostic,
  type DiagnosticDeclarations,
  type DiagnosticDescription,
  type DiagnosticContributor,
  type DiagnosticCorrelation,
} from "./diagnosticContracts.ts";
import {
  decodeRuntimeDiagnosticRecord,
  runtimeDiagnosticRetentionMs,
  type RuntimeDiagnosticRecord,
} from "../shared/contracts/runtimeDiagnostics.ts";
import type { ConversationSelection } from "../shared/contracts/conversationSelection.ts";
export type { RuntimeDiagnosticRecord } from "../shared/contracts/runtimeDiagnostics.ts";

import type { StartupObservation } from "../shared/contracts/startupDiagnostics.ts";
import { redactSecrets, withoutUndefined } from "../shared/http.ts";

const ssePollIntervalMs = 250;

export type RuntimeEventPayload = Readonly<Record<string, unknown>>;
export type RuntimeDiagnosticOptions = Readonly<{ observedAt?: number }>;

export type RuntimeEventRow = Readonly<{
  id: number;
  event_name: string;
  payload_json: string;
}>;

export type RuntimeEventContext = Readonly<{
  runId: string | null;
  sessionId: string | null;
  startedAt: number | null;
  diagnosticsContextJson: string | null;
  selection?: ConversationSelection | null;
  visitId?: string | null;
  operationId?: string | null;
  live: boolean;
  terminal: boolean;
}>;

export type RuntimeEventStorage = Readonly<{
  recordControllerEvent(eventName: string, payload?: RuntimeEventPayload): void;
  readEventsAfter(cursor: number, limit?: number): RuntimeEventRow[];
  readEventsByName(eventName: string): RuntimeEventRow[];
}>;

export type RuntimeEventRecorder = Readonly<{
  recordEvent(eventName: string, payload?: RuntimeEventPayload): void;
  recordDiagnostic(
    type: string,
    payload?: RuntimeEventPayload,
    options?: RuntimeDiagnosticOptions,
  ): RuntimeDiagnosticRecord | null;
  recordUniqueDiagnostic(
    type: string,
    predicate: (payload: Record<string, unknown>) => boolean,
    payload?: RuntimeEventPayload,
    options?: RuntimeDiagnosticOptions,
  ): RuntimeDiagnosticRecord | null;
  recordLiveDegradation(
    degradationKind: string,
    payload?: RuntimeEventPayload,
  ): RuntimeDiagnosticRecord | null;
  executionDiagnostics<D extends DiagnosticDeclarations>(declarations: D): DiagnosticContributor<D>;
  recordConversationDiagnostics(
    declarations: DiagnosticDeclarations,
    descriptions: readonly DiagnosticDescription[],
  ): void;
  recordStartup(observation: StartupObservation): void;
  notifyControl(eventName: string, payload?: RuntimeEventPayload): void;
}>;

export function recordStartupDiagnostic(
  events: Readonly<{
    recordUniqueDiagnostic(
      type: string,
      predicate: (payload: Record<string, unknown>) => boolean,
      payload?: RuntimeEventPayload,
    ): void;
  }>,
  observation: StartupObservation,
): void {
  try {
    events.recordUniqueDiagnostic(
      "runtime.startup",
      (payload) =>
        payload.stage === observation.stage &&
        (payload.failure === true) === (observation.failure === true),
      observation,
    );
  } catch {
    // Startup evidence must not change lifecycle or provider behavior.
  }
}

export class RuntimeEvents implements RuntimeEventRecorder {
  readonly #storage: RuntimeEventStorage;
  readonly #readContext: () => RuntimeEventContext;

  readonly #readExecutionAttribution:
    | ((
        correlation: DiagnosticCorrelation,
      ) => Readonly<{ visitId: string; operationId: string }> | null)
    | undefined;

  readonly #onStartup: ((observation: RuntimeEventPayload) => void) | undefined;

  constructor(
    storage: RuntimeEventStorage,
    readContext: () => RuntimeEventContext,
    onStartup?: (observation: RuntimeEventPayload) => void,
    readExecutionAttribution?: (
      correlation: DiagnosticCorrelation,
    ) => Readonly<{ visitId: string; operationId: string }> | null,
  ) {
    this.#readExecutionAttribution = readExecutionAttribution;
    this.#onStartup = onStartup;
    this.#storage = storage;
    this.#readContext = readContext;
  }

  recordEvent(eventName: string, data: RuntimeEventPayload = {}): void {
    if (eventName === "runtime.event_recorded") throw new Error("diagnostic_construction_reserved");
    this.#storage.recordControllerEvent(eventName, requireRecord(redactSecrets(data)));
  }

  recordDiagnostic(
    type: string,
    payload: RuntimeEventPayload = {},
    { observedAt = Date.now() }: RuntimeDiagnosticOptions = {},
  ): RuntimeDiagnosticRecord | null {
    const record = this.#record("runtime", type, payload, observedAt);
    if (record === null) return null;
    if (type === "runtime.startup") {
      try {
        this.#onStartup?.({
          stage: payload.stage,
          at: payload.at,
          failure: payload.failure,
          cleanup: payload.cleanup,
        });
      } catch {
        // Diagnostic delivery cannot affect controller behavior.
      }
    }
    return record;
  }

  recordUniqueDiagnostic(
    type: string,
    predicate: (payload: Record<string, unknown>) => boolean,
    payload: RuntimeEventPayload = {},
    options: RuntimeDiagnosticOptions = {},
  ): RuntimeDiagnosticRecord | null {
    try {
      if (this.#hasDiagnostic(type, predicate)) return null;
      return this.recordDiagnostic(type, payload, options);
    } catch {
      return null;
    }
  }

  recordLiveDegradation(
    degradationKind: string,
    payload: RuntimeEventPayload = {},
  ): RuntimeDiagnosticRecord | null {
    const context = this.#readContext();
    if (!context.live) return null;
    return this.recordUniqueDiagnostic(
      "runtime.live_degraded",
      (recordedPayload) => recordedPayload.degradationKind === degradationKind,
      {
        ...payload,
        degradationKind,
        sessionId: context.sessionId ?? undefined,
      },
    );
  }

  recordStartup(observation: StartupObservation): void {
    recordStartupDiagnostic(this, observation);
  }

  notifyControl(eventName: string, payload: RuntimeEventPayload = {}): void {
    this.recordEvent(eventName, payload);
  }

  executionDiagnostics<D extends DiagnosticDeclarations>(
    declarations: D,
  ): DiagnosticContributor<D> {
    return (type, payload, correlation) => {
      try {
        const schema = declarations[type];
        if (schema === undefined) throw new Error(`undeclared_diagnostic: ${type}`);
        const accepted = schema.safeParse(payload);
        if (!accepted.success)
          throw new Error(`invalid_diagnostic ${type}: ${accepted.error.message}`);
        const description = { type, payload: accepted.data };
        this.#record(
          "execution",
          description.type,
          description.payload,
          Date.now(),
          declarations[type],
          correlation,
        );
      } catch (error) {
        // Actionable author feedback stays diagnostic; native work remains independent.
        this.#validationFailure(type, error);
      }
    };
  }

  recordConversationDiagnostics(
    declarations: DiagnosticDeclarations,
    descriptions: readonly DiagnosticDescription[],
  ): void {
    for (const description of descriptions) {
      try {
        const schema = declarations[description.type];
        if (schema === undefined) throw new Error(`undeclared_diagnostic: ${description.type}`);
        const parsed = schema.safeParse(description.payload);
        if (!parsed.success)
          throw new Error(`invalid_diagnostic ${description.type}: ${parsed.error.message}`);
        const accepted = describeDiagnostic(declarations)(description.type, parsed.data);
        if (
          !this.#hasDiagnostic(
            accepted.type,
            (payload) => JSON.stringify(payload) === JSON.stringify(accepted.payload),
          )
        )
          this.#record(
            "conversation",
            accepted.type,
            accepted.payload,
            Date.now(),
            declarations[accepted.type],
          );
      } catch (error) {
        this.#validationFailure(description.type, error);
      }
    }
  }

  #validationFailure<ErrorValue>(type: string, error: ErrorValue): void {
    try {
      this.#record(
        "runtime",
        "runtime.diagnostic_rejected",
        { diagnosticType: type, error: describeError(error) },
        Date.now(),
      );
    } catch {
      /* Best effort. */
    }
  }

  #record<Payload>(
    source: RuntimeDiagnosticRecord["source"],
    type: string,
    payload: Payload,
    observedAt: number,
    schema?: z.ZodType,
    correlation?: DiagnosticCorrelation,
  ): RuntimeDiagnosticRecord | null {
    try {
      const context = this.#readContext();
      if (context.runId === null || context.startedAt === null) return null;
      let accepted = z.json().parse(
        withoutUndefined(
          requireRecord(
            sanitizeDiagnosticPayload(
              source !== "conversation"
                ? {
                    ...(parseJsonObject(context.diagnosticsContextJson) ?? {}),
                    ...requireRecord(payload),
                  }
                : payload,
            ),
          ),
        ),
      );
      if (schema !== undefined && !schema.safeParse(accepted).success)
        accepted = { diagnosticOmitted: true, reason: "redaction_invalid" };
      let payloadJson = JSON.stringify(accepted);
      if (new TextEncoder().encode(payloadJson).byteLength > 4_000)
        payloadJson = JSON.stringify({ diagnosticOmitted: true, reason: "payload_size" });
      const sequence = this.#nextDiagnosticSequence();
      const elapsedMs = Math.max(0, observedAt - context.startedAt);
      if (
        !Number.isSafeInteger(observedAt) ||
        observedAt < 0 ||
        !Number.isSafeInteger(elapsedMs) ||
        type.length === 0
      )
        return null;
      const attribution =
        correlation === undefined ? context : this.#readExecutionAttribution?.(correlation);
      const record = {
        recordId: `${context.runId}:${sequence}`,
        runId: context.runId,
        source,
        selection: context.selection ?? null,
        visitId: attribution?.visitId ?? null,
        operationId: attribution?.operationId ?? null,
        observedAt,
        sequence,
        elapsedMs,
        type,
        payloadJson,
      } satisfies RuntimeDiagnosticRecord;
      this.#storage.recordControllerEvent("runtime.event_recorded", { record });
      return Object.freeze(record);
    } catch {
      return null;
    }
  }

  readDiagnostics(runId: string, cursor: number, limit = 100, maxBytes = 60_000) {
    const records: RuntimeDiagnosticRecord[] = [];
    let next = cursor;
    let bytes = 0;
    let hasMore = false;
    for (const row of this.#storage.readEventsAfter(cursor, Math.min(limit, 100))) {
      if (row.event_name === "runtime.event_recorded") {
        const envelope = parseJsonObject(row.payload_json);
        const record = decodeRuntimeDiagnosticRecord(envelope?.record);
        if (record.observedAt + runtimeDiagnosticRetentionMs <= Date.now()) {
          next = row.id;
          continue;
        }
        const size = new TextEncoder().encode(JSON.stringify(record)).byteLength;
        if (bytes + size > maxBytes) {
          hasMore = true;
          break;
        }
        records.push(record);
        bytes += size;
      }
      next = row.id;
    }
    hasMore ||= this.#storage.readEventsAfter(next, 1).length > 0;
    return { runId, records, cursor: next, hasMore };
  }

  #nextDiagnosticSequence(): number {
    return this.#storage.readEventsByName("runtime.event_recorded").length + 1;
  }

  readAfterCursor(cursor: number, limit = 100): RuntimeEventRow[] {
    return this.#storage.readEventsAfter(cursor, limit);
  }

  createStreamResponse(runId: string, durationMs: number, signal?: AbortSignal): Response {
    return new Response(this.#createStream(runId, durationMs, signal), {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      },
    });
  }

  #hasDiagnostic(type: string, predicate: (payload: Record<string, unknown>) => boolean): boolean {
    return this.#storage.readEventsByName("runtime.event_recorded").some((row) => {
      const envelope = parseJsonObject(row.payload_json);
      const record = envelope?.record;
      return (
        isRecord(record) &&
        record.type === type &&
        typeof record.payloadJson === "string" &&
        predicate(parseJsonObject(record.payloadJson) ?? {})
      );
    });
  }

  #createStream(
    runId: string,
    durationMs: number,
    signal?: AbortSignal,
  ): ReadableStream<Uint8Array> {
    const self = this;
    const encoder = new TextEncoder();
    const observation = new AbortController();
    let cancelled = false;
    let completion: Promise<Exit.Exit<void, never>> | undefined;

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (signal?.aborted) {
          controller.close();
          return;
        }
        const abort = () => observation.abort();
        const operation = Effect.acquireUseRelease(
          Effect.sync(() => signal?.addEventListener("abort", abort, { once: true })),
          () =>
            Effect.gen(function* () {
              const startedAt = yield* Clock.currentTimeMillis;
              let cursor = 0;
              while ((yield* Clock.currentTimeMillis) - startedAt <= durationMs) {
                const terminal = yield* Effect.try({
                  try: () => {
                    const rows = self.readAfterCursor(cursor);
                    for (const row of rows) {
                      cursor = row.id;
                      controller.enqueue(encoder.encode(`event: ${row.event_name}\n`));
                      controller.enqueue(encoder.encode(`data: ${row.payload_json}\n\n`));
                    }
                    const context = self.#readContext();
                    return rows.length === 0 && context.runId === runId && context.terminal;
                  },
                  catch: (cause) => new EventStreamReadFailure({ cause }),
                });
                if (terminal) return;
                yield* Effect.sleep(ssePollIntervalMs);
              }
            }).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  controller.enqueue(encoder.encode("event: session.failed\n"));
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({
                        event: "session.failed",
                        runId,
                        message: describeError(error.cause),
                      })}\n\n`,
                    ),
                  );
                }),
              ),
            ),
          () =>
            Effect.sync(() => {
              signal?.removeEventListener("abort", abort);
              if (!cancelled) controller.close();
            }),
        );
        // Return the Response immediately; this operation belongs to its body, not fetch().
        // runPromiseExit observes defects too, so a failed native sink cannot strand cleanup.
        completion = Effect.runPromiseExit(operation, { signal: observation.signal });
      },
      cancel: () => {
        cancelled = true;
        observation.abort();
        return completion?.then(() => undefined);
      },
    });
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord<Value>(value: Value): value is Value & Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord<Value>(value: Value): Value & Record<string, unknown> {
  if (!isRecord(value)) throw new Error("invalid_runtime_event_payload");
  return value;
}

/** A failed read of the stored event stream; the stream reports its cause and closes. */
class EventStreamReadFailure extends Data.TaggedError("EventStreamReadFailure")<{
  cause: unknown;
}> {}

function describeError<ErrorValue>(error: ErrorValue): string {
  if (error instanceof Error && error.message.length > 0) return redactSecrets(error.message);
  if (typeof error === "string" && error.length > 0) return redactSecrets(error);
  return "request failed";
}
