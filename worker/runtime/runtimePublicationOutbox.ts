import { Clock, Context, Data, Effect } from "effect";
import { z } from "zod";
import type {
  FailedToStartResult,
  InterruptedResult,
  CompletedResult,
} from "../shared/contracts/runtimeTerminalResult.ts";

import {
  isRuntimeTranscriptSnapshotRef,
  runtimeCompletedCallbackType,
  runtimeTranscriptUpdatedCallbackType,
  type RuntimeTranscriptSnapshotRef,
  type RuntimeTranscriptTurn,
} from "../shared/runtimeControllerCallback.ts";
import { callUntilDeadline } from "../shared/deadline.ts";
import { applicationCallbackUrl } from "./applicationCallbacks.ts";
import type { RuntimeFinalizationCompletion } from "./interviewFinalizationModel.ts";
import { microtaskBoundary, responseJson } from "./webPlatform.ts";

export const callbackAttemptTimeoutMs = 4_000;
const callbackRetryDelayMs = 10_000;
const maxCallbackRetryDelayMs = 10 * 60_000;
const boundedCallbackRetryDelayMs = 2_000;
const maxBoundedCallbackRetryDelayMs = 8_000;
const controllerIdentity = "interview-runtime-controller";

export type CallbackFailureDisposition =
  | "retryable"
  | "blocked_snapshot_conflict"
  | "blocked_nonretryable_callback";

export type RuntimePublicationTarget =
  | Readonly<{ kind: "completed"; result: CompletedResult }>
  | Readonly<{ kind: "interrupted"; result: InterruptedResult }>
  | Readonly<{ kind: "failed_to_start"; result: FailedToStartResult }>
  | Readonly<{
      kind: "transcript";
      runId: string;
      snapshot: Readonly<{
        revision: number;
        digest: string;
        turnCount: number;
        transcript: Readonly<{ turns: readonly RuntimeTranscriptTurn[] }>;
      }>;
    }>
  | Readonly<{
      kind: "completion";
      completion: RuntimeFinalizationCompletion;
    }>;

export type RuntimePublicationAttempt =
  | Readonly<{ delivered: true }>
  | Readonly<{
      delivered: false;
      error: string;
      disposition: CallbackFailureDisposition;
    }>;

export type RuntimePublicationCrashPoint = "before_request" | "after_response_before_receipt";

/** Native transport failures are expected; programmer defects and interruption are not receipts. */
class PublicationTransportError extends Data.TaggedError("PublicationTransportError")<{
  readonly cause: unknown;
}> {}
class PublicationTimeout extends Data.TaggedError("PublicationTimeout") {}

const PublicationTransport = Context.Service<{
  fetch(request: Request, signal: AbortSignal): Promise<Response>;
}>("runtime/PublicationTransport");

type PublicationInput = Readonly<{
  target: RuntimePublicationTarget;
  fetch(request: Request, signal: AbortSignal): Promise<Response>;
  crashInjector?: (point: RuntimePublicationCrashPoint) => void;
  timeoutMs?: number;
}>;

/**
 * One bounded publication attempt for an Effect owner. Interrupting the owner aborts the native
 * transport; transport failures and the attempt bound become retryable receipts.
 */
export function attemptRuntimePublication(
  input: PublicationInput,
): Effect.Effect<RuntimePublicationAttempt, never> {
  return Effect.gen(function* () {
    // Capture once before construction: extensions inside this operation share the same budget.
    const deadlineAt =
      (yield* Clock.currentTimeMillis) + (input.timeoutMs ?? callbackAttemptTimeoutMs);
    return yield* publicationOperation(input.target, deadlineAt, input.crashInjector);
  }).pipe(
    Effect.provideService(PublicationTransport, { fetch: input.fetch }),
    Effect.catchTags({
      PublicationTimeout: () =>
        Effect.succeed({
          delivered: false as const,
          error: "callback_timed_out",
          disposition: "retryable" as const,
        }),
      PublicationTransportError: ({ cause }) =>
        Effect.succeed({
          delivered: false as const,
          error:
            cause instanceof Error && cause.message.length > 0 ? cause.message : "callback_failed",
          disposition: "retryable" as const,
        }),
    }),
  );
}

function publicationOperation(
  target: RuntimePublicationTarget,
  deadlineAt: number,
  crashInjector?: (point: RuntimePublicationCrashPoint) => void,
) {
  return Effect.gen(function* () {
    const transport = yield* PublicationTransport;
    const request = buildPublicationRequest(target);
    crashInjector?.("before_request");
    // Request construction or an added step cannot grant a fresh dispatch window: the bounded
    // call checks the original deadline immediately before dispatch.
    const response = yield* callUntilDeadline({
      deadlineAt,
      operation: async (signal) => {
        const reply = await transport.fetch(new Request(request, { signal }), signal);
        const body = await reply.arrayBuffer();
        return new Response(body.byteLength === 0 ? null : body, {
          status: reply.status,
          statusText: reply.statusText,
          headers: reply.headers,
        });
      },
      // HTTP observes abort. An application's named RPC does not promise remote cancellation or
      // rollback.
      onTransportFailure: (cause) => new PublicationTransportError({ cause }),
      onTimeout: () => new PublicationTimeout(),
    });
    crashInjector?.("after_response_before_receipt");
    const acknowledgement = yield* readCallbackAcknowledgement(response);
    if ((yield* Clock.currentTimeMillis) >= deadlineAt) return yield* new PublicationTimeout();
    return classifyPublicationReceipt(target, response, acknowledgement);
  });
}

function classifyPublicationReceipt(
  target: RuntimePublicationTarget,
  response: Response,
  acknowledgement: CallbackAcknowledgement,
): RuntimePublicationAttempt {
  return !response.ok
    ? {
        delivered: false,
        error: `callback_http_${response.status}`,
        disposition: classifyCallbackFailure(target.kind, response.status, acknowledgement),
      }
    : !acknowledgement.ok
      ? {
          delivered: false,
          error: acknowledgement.error,
          disposition: "blocked_nonretryable_callback",
        }
      : (() => {
          const disposition = classifyAcknowledgement(target, acknowledgement);
          return disposition === null
            ? { delivered: true as const }
            : {
                delivered: false as const,
                error: `callback_${acknowledgement.status ?? "invalid_status"}`,
                disposition,
              };
        })();
}

export function nextPublicationRetryAt(
  now: number,
  attemptCount: number,
  disposition: CallbackFailureDisposition,
  cutoffAt?: number,
): number | null {
  if (disposition !== "retryable") return null;
  const exponent = Math.min(Math.max(0, Math.floor(attemptCount)), 6);
  const retryAt =
    cutoffAt === undefined
      ? now + Math.min(maxCallbackRetryDelayMs, callbackRetryDelayMs * 2 ** exponent)
      : now + Math.min(maxBoundedCallbackRetryDelayMs, boundedCallbackRetryDelayMs * 2 ** exponent);
  return cutoffAt === undefined || retryAt < cutoffAt ? retryAt : null;
}

function buildPublicationRequest(target: RuntimePublicationTarget): Request {
  const body =
    target.kind === "failed_to_start" ||
    target.kind === "interrupted" ||
    target.kind === "completed"
      ? target.result
      : target.kind === "transcript"
        ? {
            version: 2,
            type: runtimeTranscriptUpdatedCallbackType,
            runId: target.runId,
            snapshot: target.snapshot,
          }
        : {
            version: 2,
            type: runtimeCompletedCallbackType,
            completion: target.completion,
          };
  return new Request(
    applicationCallbackUrl(target.kind === "transcript" ? "transcript" : "completion"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Runtime-Callback": controllerIdentity,
      },
      body: JSON.stringify(body),
    },
  );
}

type CallbackAcknowledgement =
  | Readonly<{
      ok: true;
      status?: string;
      requestedMatches?: boolean;
      storedSnapshot?: RuntimeTranscriptSnapshotRef | null;
    }>
  | Readonly<{ ok: false; error: string }>;

const callbackAcknowledgementSchema = z.union([
  z
    .object({ ok: z.literal(true) })
    .transform(() => ({ ok: true }) satisfies CallbackAcknowledgement),
  z
    .object({
      version: z.literal(2),
      status: z.string(),
      requestedMatches: z.boolean(),
      storedSnapshot: z.union([
        z.null(),
        z.custom<RuntimeTranscriptSnapshotRef>(isRuntimeTranscriptSnapshotRef),
      ]),
    })
    .transform(
      (payload) =>
        ({
          ok: true,
          status: payload.status,
          requestedMatches: payload.requestedMatches,
          storedSnapshot: payload.storedSnapshot,
        }) satisfies CallbackAcknowledgement,
    ),
]);

/**
 * The callback's acknowledgement. It arrives a microtask after the body was read, or after the
 * call when the body is not JSON, as it did when this step was an awaited async function.
 */
function readCallbackAcknowledgement(response: Response): Effect.Effect<CallbackAcknowledgement> {
  const invalid: CallbackAcknowledgement = { ok: false, error: "callback_invalid_ack" };
  const read = !(response.headers.get("Content-Type") ?? "")
    .toLowerCase()
    .includes("application/json")
    ? Effect.succeed(invalid)
    : responseJson(response).pipe(
        Effect.map((payload) => {
          const acknowledgement = callbackAcknowledgementSchema.safeParse(payload);
          return acknowledgement.success ? acknowledgement.data : invalid;
        }),
        Effect.orElseSucceed(() => invalid),
      );
  return Effect.tap(read, () => microtaskBoundary);
}

function classifyCallbackFailure(
  kind: RuntimePublicationTarget["kind"],
  status: number,
  acknowledgement: CallbackAcknowledgement,
): CallbackFailureDisposition {
  if (isRetryableStatus(status)) return "retryable";
  if (
    acknowledgement.ok &&
    ((kind === "transcript" &&
      (acknowledgement.status === "conflict" ||
        acknowledgement.status === "sealed" ||
        acknowledgement.status === "stale")) ||
      ((kind === "completion" || kind === "interrupted" || kind === "completed") &&
        acknowledgement.status === "snapshot_mismatch"))
  ) {
    return "blocked_snapshot_conflict";
  }
  return "blocked_nonretryable_callback";
}

function classifyAcknowledgement(
  target: RuntimePublicationTarget,
  acknowledgement: Extract<CallbackAcknowledgement, { ok: true }>,
): CallbackFailureDisposition | null {
  if (target.kind === "failed_to_start") {
    return acknowledgement.status === undefined ? null : "blocked_nonretryable_callback";
  }
  const requested =
    target.kind === "transcript"
      ? target.snapshot
      : target.kind === "interrupted" || target.kind === "completed"
        ? target.result.transcriptSnapshot
        : target.completion.transcriptSnapshot;
  if (
    (target.kind === "transcript" &&
      (acknowledgement.status === "stored" || acknowledgement.status === "idempotent")) ||
    ((target.kind === "completion" ||
      target.kind === "interrupted" ||
      target.kind === "completed") &&
      (acknowledgement.status === "completed" || acknowledgement.status === "idempotent"))
  ) {
    return acknowledgement.requestedMatches === true &&
      matchesSnapshot(acknowledgement.storedSnapshot, requested)
      ? null
      : "blocked_snapshot_conflict";
  }
  if (
    (target.kind === "transcript" &&
      (acknowledgement.status === "conflict" ||
        acknowledgement.status === "sealed" ||
        acknowledgement.status === "stale")) ||
    ((target.kind === "completion" ||
      target.kind === "interrupted" ||
      target.kind === "completed") &&
      acknowledgement.status === "snapshot_mismatch")
  ) {
    return "blocked_snapshot_conflict";
  }
  return "blocked_nonretryable_callback";
}

function matchesSnapshot(
  stored: RuntimeTranscriptSnapshotRef | null | undefined,
  requested: RuntimeTranscriptSnapshotRef,
): boolean {
  return (
    stored !== null &&
    stored !== undefined &&
    stored.revision === requested.revision &&
    stored.digest === requested.digest &&
    stored.turnCount === requested.turnCount
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
