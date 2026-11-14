import { SETTINGS_SUMMARY_HEADER } from "../shared/runtimeHeaders.ts";
import type { Effect } from "effect";
import { z } from "zod";
import { boundary } from "../../tools/boundary-contracts/boundary-contracts.mjs";
import type {
  ConnectionPayload,
  ConnectionSetup,
  RuntimeConnectionExchange,
} from "../shared/contracts/runtimeConnection.ts";

export type ConversationConnectionImplementation = Readonly<{
  profile: string;
  available: boolean;
  validateExecution(
    execution: import("../shared/contracts/runtimeStart.ts").InterviewExecution,
  ): void;
  validate(input: ConnectionPayload | undefined): Promise<{ fingerprint: string }>;
  exchange(
    input: Readonly<{
      runId: string;
      execution: import("../shared/contracts/runtimeStart.ts").InterviewExecution;
      connection: RuntimeConnectionExchange;
      originalDeadline: number | null;
      initial: boolean;
    }>,
  ): Promise<Readonly<{ reply?: ConnectionPayload; diagnostics?: ConnectionPayload }>>;
}>;

/**
 * A connection implementation as Runtime's start awaits it: its validation and its exchange are
 * Effects, and `exchange` dispatches the exchange when called.
 */
export type StartupConnectionImplementation = Omit<
  ConversationConnectionImplementation,
  "validate" | "exchange"
> &
  Readonly<{
    validate(
      input: Parameters<ConversationConnectionImplementation["validate"]>[0],
    ): Effect.Effect<Awaited<ReturnType<ConversationConnectionImplementation["validate"]>>>;
    exchange(
      input: Parameters<ConversationConnectionImplementation["exchange"]>[0],
    ): Effect.Effect<Awaited<ReturnType<ConversationConnectionImplementation["exchange"]>>>;
  }>;

/** A selected entry's connection setup as Runtime's start awaits it: its validation is an Effect. */
export type SelectedConnectionSetup = Omit<ConnectionSetup, "validate"> &
  Readonly<{
    validate(
      input: Parameters<ConnectionSetup["validate"]>[0],
    ): Effect.Effect<Awaited<ReturnType<ConnectionSetup["validate"]>>>;
  }>;

export const checkpointSchema = z.strictObject({
  exchangeId: z.string().min(1),
  fingerprint: z.string().min(1),
  status: z.enum(["started", "complete"]),
  reply: z.json().optional(),
  diagnostics: z.json().optional(),
});
export const decodeConnectionCheckpoint = boundary({
  schema: z.preprocess((value) => {
    const parsed: unknown = JSON.parse(JSON.stringify(value));
    return parsed;
  }, checkpointSchema),
  convert: (value) => value,
});

export function conversationConnectionResponse(
  result: import("../shared/contracts/runtimeConnection.ts").RuntimeConnectionResult,
  status = 200,
): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  const diagnostics = result.diagnostics;
  // Legacy Lab provenance remains deliberately supplied browser diagnostics.
  if (
    diagnostics !== null &&
    typeof diagnostics === "object" &&
    !Array.isArray(diagnostics) &&
    Object.hasOwn(diagnostics, "settingsSummary")
  )
    headers.set(
      SETTINGS_SUMMARY_HEADER,
      encodeURIComponent(JSON.stringify(diagnostics.settingsSummary)),
    );
  return Response.json(result, { status, headers });
}

export type ConnectionCheckpoint = z.output<typeof checkpointSchema>;
