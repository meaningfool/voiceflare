import { Clock, Context, Data, Effect, Exit, Layer } from "effect";
import { z } from "zod";
import { callUntilDeadline, remainingUntil, untilDeadline } from "../../shared/deadline.ts";

import { boundary, failure } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import {
  toProviderRealtimeSession,
  type PreparedModelSession,
  type ProviderRealtimeSession,
} from "./preparedModelSession.ts";
import {
  buildCancelResponseCommand,
  buildClearInputCommand,
  buildClearOutputCommand,
  buildDisableAutomaticTurnsCommand,
  buildFinalInputCommitCommand,
  sendProviderCommand,
  type ProviderCommand,
  type ProviderCommandSocket,
} from "./providerCommands.ts";
import {
  providerFailure,
  providerSuccess,
  type ProviderOutcome,
  type ProviderFailureOutcome,
} from "../../runtime/providerOutcomes.ts";
import {
  normalizeProviderRealtimeEvent,
  normalizeProviderRuntimeObservation,
  type NormalizedProviderEvent,
} from "./providerEvents.ts";
import type { RealtimeEndingCommand } from "./providerOperations.ts";
import type { RealtimeUsageModels } from "./usage.ts";
export { summarizeProviderMessageReceipt } from "./providerEvents.ts";
import type { RealtimeObservation } from "./speech.ts";

export const OPENAI_BASE = "https://api.openai.com/v1";
export const DEFAULT_PROVIDER_HANGUP_TIMEOUT_MS = 8_000;
const SIDEBAND_MAX_ATTEMPTS = 38;
const sidebandDeadlineFailure = { code: "sideband_connect_failed", retryable: false } as const;
/** A call creation without a deadline: only its caller's interruption ends its native waits. */
const noDeadline = Number.POSITIVE_INFINITY;

class ProviderRequestFailure extends Data.TaggedError("ProviderRequestFailure")<{
  readonly outcome: ProviderOutcome<never>;
}> {}
class ProviderRequestDeadline extends Data.TaggedError("ProviderRequestDeadline") {}
class ProviderHeaderObservationDefect extends Data.TaggedError("ProviderHeaderObservationDefect")<{
  cause: unknown;
}> {}

/** Only rejected persistence at the identity facade is an expected handoff failure. */
export class ProviderIdentityPersistenceError extends Data.TaggedError(
  "ProviderIdentityPersistenceError",
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export type ProviderSocketEvent = Readonly<{ data?: unknown; code?: number }>;

export type ProviderWebSocket = ProviderCommandSocket &
  Readonly<{
    readyState: number;
    accept(): void;
    addEventListener(
      type: "message" | "close" | "error",
      listener: (event: ProviderSocketEvent) => void,
    ): void;
    removeEventListener?(
      type: "message" | "close" | "error",
      listener: (event: ProviderSocketEvent) => void,
    ): void;
    close(code?: number, reason?: string): void;
  }>;

export type ProviderCall = Readonly<{
  status: number;
  answerSdp: string;
  responseContentType: string | null;
  sessionLocation: string | null;
  sessionId: string | null;
  upstreamRequestId: string | null;
}>;

export type ProviderCallIdentity = Readonly<{
  status: number;
  responseContentType: string | null;
  sessionLocation: string | null;
  sessionId: string;
  upstreamRequestId: string | null;
}>;

export type ProviderHangup = Readonly<{
  status: number;
  upstreamRequestId: string | null;
}>;

type ProviderCallHttpFailure = {
  stage: "call_creation";
  code: `provider_call_http_${number}`;
  providerStatus: number;
  requestId?: string;
  retryable: boolean;
};

type ProviderCallReadFailure = {
  stage: "call_creation";
  code: "provider_call_response_read_failed";
  providerStatus: number;
  requestId?: string;
  retryable: boolean;
};

type ProviderHangupHttpFailure = {
  stage: "hangup";
  code: "session_release_failed";
  providerStatus: number;
  requestId?: string;
  retryable: boolean;
};

type ProviderSidebandAttempt = {
  url: string;
  attemptNumber: number;
  apiKey: string;
  emit: (event: string, data?: Record<string, unknown>) => void;
  deadlineAt: number;
  retainAcquisition?: (task: Promise<void>) => void;
};

/**
 * The OpenAI call the session creates for the browser's SDP offer. The call's identity is
 * reported to `onCallIdentified` as soon as its headers arrive, from the native continuation,
 * so it is persisted even when the caller stops waiting at `deadlineAt`; `retainCallIdentity`
 * receives that continuation, for the platform to keep until it settles.
 */
export type RealtimeCallRequest = Readonly<{
  apiKey: string;
  sdp: string;
  session: PreparedModelSession;
  deadlineAt?: number;
  onCallIdentified?: (identity: ProviderCallIdentity) => void | Promise<void>;
  retainCallIdentity?: (task: Promise<void>) => void;
}>;

export type ProviderSidebandAttemptObservation =
  | Readonly<{ kind: "started"; deadlineFailure: ProviderFailureOutcome }>
  | Readonly<{ kind: "failed"; failure: ProviderFailureOutcome }>;

/**
 * The side connection of a created call, retried until `retryDeadlineAt` (75 s from the first
 * attempt without it). `emit` reports each attempt's diagnostics as it happens and
 * `observeAttempt` its start and failure. A late upgrade that no attempt takes any more is
 * released in its native continuation, which `retainAcquisition` receives.
 */
export type RealtimeSidebandRequest = Readonly<{
  callId: string;
  apiKey: string;
  emit: (event: string, data?: Record<string, unknown>) => void;
  retryDeadlineAt?: number;
  observeAttempt?: (observation: ProviderSidebandAttemptObservation) => void;
  retainAcquisition?: (task: Promise<void>) => void;
}>;

/** The hang-up of one exact call, bounded by `timeoutMs` (8 s without it). */
export type RealtimeHangupRequest = Readonly<{
  apiKey: string;
  callId: string;
  timeoutMs?: number;
}>;

/**
 * The Realtime kit's access to OpenAI: provider events read into Runtime's vocabulary, the
 * call's creation, its side connection, commands on that connection and the call's hang-up.
 * The operations that wait on the provider are Effects that run on their caller's runtime, the
 * Run's, and end when it interrupts them; their outcomes, failures included, are values.
 */
export type RealtimeProviderDriver = Readonly<{
  normalizeEvent(data: unknown): NormalizedProviderEvent;
  normalizeRuntimeObservation(
    data: Parameters<typeof normalizeProviderRuntimeObservation>[0],
    input: Readonly<{
      sequence: number;
      observedAt: number;
      observeAllProviderEvents: boolean;
      /** The models the session's settings name, which its usage entries carry. */
      usageModels?: RealtimeUsageModels | undefined;
    }>,
  ): RealtimeObservation | null;
  createCall(input: RealtimeCallRequest): Effect.Effect<ProviderOutcome<ProviderCall>>;
  connectSideband(
    input: RealtimeSidebandRequest,
  ): Effect.Effect<ProviderOutcome<ProviderWebSocket>>;
  sendCommand(
    input: Readonly<{
      socket: ProviderCommandSocket;
      command: ProviderCommand;
    }>,
  ): ProviderOutcome<void>;
  sendFinalizationOperation(
    input: Readonly<{
      socket: ProviderCommandSocket;
      operation: RealtimeEndingCommand;
    }>,
  ): ProviderOutcome<void>;
  hangUp(input: RealtimeHangupRequest): Effect.Effect<ProviderOutcome<ProviderHangup>>;
}>;

/**
 * The Realtime driver as a service. A Realtime session reaches OpenAI only through it, so a
 * test substitutes the driver by providing another Layer, the kit's test version
 * (`testing/testDriver.ts`), as Cascade's stand-ins replace its providers.
 */
export class RealtimeDriver extends Context.Service<RealtimeDriver, RealtimeProviderDriver>()(
  "providers/openaiRealtime/RealtimeDriver",
) {}

/** A Realtime driver as its Layer: OpenAI's (`openAiRealtimeDriver`) or a test's. */
export type RealtimeDriverLayer = Layer.Layer<RealtimeDriver>;

/**
 * OpenAI's Realtime driver over `transport`, the platform's `fetch` unless a caller injects
 * one. The transport is called as a plain function, never as a method.
 */
export function openAiRealtimeDriver(transport: typeof fetch = fetch): RealtimeDriverLayer {
  return Layer.succeed(
    RealtimeDriver,
    RealtimeDriver.of({
      normalizeEvent: normalizeProviderRealtimeEvent,
      normalizeRuntimeObservation: (data, input) =>
        normalizeProviderRuntimeObservation(
          data,
          input.sequence,
          input.observeAllProviderEvents,
          input.observedAt,
          input.usageModels,
        ),
      createCall: (input) => createCall(transport, input),
      connectSideband: (input) => connectSideband(transport, input),
      sendCommand: ({ socket, command }) => sendProviderCommand(socket, command),
      sendFinalizationOperation: ({ socket, operation }) =>
        sendProviderCommand(socket, encodeFinalizationOperation(operation)),
      hangUp: (input) => hangUp(transport, input),
    }),
  );
}

/** Fails with the deadline once `deadlineAt` has passed; no deadline never fails. */
function failAtDeadline(
  deadlineAt: number | undefined,
): Effect.Effect<void, ProviderRequestDeadline> {
  if (deadlineAt === undefined) return Effect.void;
  return Effect.flatMap(remainingUntil(deadlineAt), (remainingMs) =>
    remainingMs === 0 ? Effect.fail(new ProviderRequestDeadline()) : Effect.void,
  );
}

function createCall(
  transport: typeof fetch,
  input: RealtimeCallRequest,
): Effect.Effect<ProviderOutcome<ProviderCall>> {
  const sessionConfig = toProviderRealtimeSession(input.session);
  const deadlineAt = input.deadlineAt ?? noDeadline;
  let observedResponse: Response | null = null;
  const operation = providerRequestUntil(input.deadlineAt, (controller) =>
    Effect.gen(function* () {
      // The native continuation owns header observation even if Effect stops waiting.
      // No SDP is read on this retained path. The session retains the handoff task.
      const response = yield* callUntilDeadline({
        deadlineAt,
        operation: () => {
          const headers = transport(
            `${OPENAI_BASE}/realtime/calls`,
            buildProviderCallRequest(input, sessionConfig, controller.signal),
          ).then(
            async (response) => {
              observedResponse = response;
              const sessionLocation = response.headers.get("Location");
              const sessionId = getProviderCallId(sessionLocation);
              if (response.ok && sessionId !== null) {
                await input.onCallIdentified?.({
                  status: response.status,
                  responseContentType: response.headers.get("content-type"),
                  sessionLocation,
                  sessionId,
                  upstreamRequestId: response.headers.get("x-request-id"),
                });
              }
              return response;
            },
            () => {
              throw new ProviderRequestFailure({
                outcome: providerFailure({
                  stage: "call_creation",
                  code: "provider_call_request_failed",
                  retryable: true,
                }),
              });
            },
          );
          // The native headers continuation already owns late identity persistence.
          input.retainCallIdentity?.(
            headers.then(
              () => undefined,
              (cause) => {
                if (
                  cause instanceof ProviderRequestFailure ||
                  cause instanceof ProviderIdentityPersistenceError
                )
                  return;
                throw cause;
              },
            ),
          );
          return headers;
        },
        onTransportFailure: (cause) =>
          cause instanceof ProviderRequestFailure ||
          cause instanceof ProviderIdentityPersistenceError
            ? cause
            : new ProviderHeaderObservationDefect({ cause }),
        onTimeout: () => new ProviderRequestDeadline(),
      }).pipe(Effect.catchTag("ProviderHeaderObservationDefect", ({ cause }) => Effect.die(cause)));
      const upstreamRequestId = response.headers.get("x-request-id");
      if (!response.ok) return callHttpFailure(response);
      yield* failAtDeadline(input.deadlineAt);
      const answerSdp = yield* callUntilDeadline({
        deadlineAt,
        operation: () => response.text(),
        onTransportFailure: () =>
          new ProviderRequestFailure({ outcome: callReadFailure(response) }),
        onTimeout: () => new ProviderRequestDeadline(),
      });
      yield* failAtDeadline(input.deadlineAt);
      return providerSuccess({
        status: response.status,
        answerSdp,
        responseContentType: response.headers.get("content-type"),
        sessionLocation: response.headers.get("Location"),
        sessionId: getProviderCallId(response.headers.get("Location")),
        upstreamRequestId,
      });
    }),
  );
  return operation.pipe(
    Effect.catchTags({
      ProviderRequestFailure: ({ outcome }) => Effect.succeed(outcome),
      ProviderRequestDeadline: () =>
        Effect.succeed(
          observedResponse === null
            ? providerFailure({
                stage: "call_creation",
                code: "provider_call_request_failed",
                retryable: true,
              })
            : callReadFailure(observedResponse),
        ),
      ProviderIdentityPersistenceError: () =>
        Effect.succeed(
          providerFailure({
            stage: "call_creation",
            code: "provider_call_request_failed",
            retryable: true,
          }),
        ),
    }),
  );
}

function callReadFailure(response: Response): ProviderOutcome<never> {
  const requestId = response.headers.get("x-request-id");
  const details: Omit<ProviderCallReadFailure, "retryable"> = {
    stage: "call_creation",
    code: "provider_call_response_read_failed",
    providerStatus: response.status,
  };
  if (requestId !== null) details.requestId = requestId;
  return providerFailure({ ...details, retryable: isRetryableProviderStatus(response.status) });
}

function callHttpFailure(response: Response): ProviderOutcome<never> {
  const requestId = response.headers.get("x-request-id");
  const details: Omit<ProviderCallHttpFailure, "retryable"> = {
    stage: "call_creation",
    code: `provider_call_http_${response.status}`,
    providerStatus: response.status,
  };
  if (requestId !== null) details.requestId = requestId;
  return providerFailure({ ...details, retryable: isRetryableProviderStatus(response.status) });
}

/**
 * One provider request with its own abort controller, aborted when the request ends unless an
 * accepted native upgrade keeps it, and bounded by the original absolute deadline when given.
 */
function providerRequestUntil<A, E, R>(
  deadlineAt: number | undefined,
  use: (controller: AbortController) => Effect.Effect<A, E, R>,
  retainOnSuccess?: (result: A) => boolean,
): Effect.Effect<A, E | ProviderRequestDeadline, R> {
  const request = Effect.acquireUseRelease(
    Effect.sync(() => new AbortController()),
    use,
    (controller, exit) =>
      Effect.sync(() => {
        // Accepted native upgrades transfer request lifetime to the socket owner.
        if (Exit.isSuccess(exit) && retainOnSuccess?.(exit.value) === true) return;
        controller.abort();
      }),
  );
  return deadlineAt === undefined
    ? request
    : request.pipe(untilDeadline(deadlineAt, () => Effect.fail(new ProviderRequestDeadline())));
}

function buildProviderCallRequest(
  input: Readonly<{ apiKey: string; sdp: string }>,
  sessionConfig: ProviderRealtimeSession,
  signal: AbortSignal,
): RequestInit {
  const formData = new FormData();
  formData.set("sdp", input.sdp);
  formData.set("session", JSON.stringify(sessionConfig));
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "OpenAI-Safety-Identifier": "runtime-server-call",
    },
    body: formData,
    signal,
  };
}

class ProviderHangupTransportError extends Data.TaggedError("ProviderHangupTransportError")<{
  readonly cause: unknown;
}> {}

/**
 * The hang-up, decided by the reply's headers: its body is never read, and the request is
 * aborted once the outcome is known. It is bounded from its start by its timeout, and a reply
 * at or after that cutoff is its timeout.
 */
function hangUp(
  transport: typeof fetch,
  input: RealtimeHangupRequest,
): Effect.Effect<ProviderOutcome<ProviderHangup>> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_PROVIDER_HANGUP_TIMEOUT_MS;
  return Effect.gen(function* () {
    const deadlineAt = (yield* Clock.currentTimeMillis) + timeoutMs;
    return yield* providerRequestUntil(deadlineAt, (controller) =>
      Effect.gen(function* () {
        const response = yield* callUntilDeadline({
          deadlineAt,
          operation: () =>
            transport(`${OPENAI_BASE}/realtime/calls/${encodeURIComponent(input.callId)}/hangup`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${input.apiKey}`,
                "OpenAI-Safety-Identifier": "runtime-close",
              },
              signal: controller.signal,
            }),
          onTransportFailure: (cause) => new ProviderHangupTransportError({ cause }),
          onTimeout: () => new ProviderRequestDeadline(),
        });
        yield* failAtDeadline(deadlineAt);
        return response;
      }),
    );
  }).pipe(
    Effect.map(classifyHangupResponse),
    Effect.catchTags({
      ProviderRequestDeadline: () =>
        Effect.succeed(
          providerFailure({
            stage: "hangup",
            code: "session_release_timed_out",
            retryable: true,
            timeoutMs,
          }),
        ),
      ProviderHangupTransportError: () =>
        Effect.succeed(
          providerFailure({
            stage: "hangup",
            code: "session_release_uncertain",
            retryable: true,
          }),
        ),
    }),
  );
}

function classifyHangupResponse(response: Response): ProviderOutcome<ProviderHangup> {
  const upstreamRequestId = response.headers.get("x-request-id");

  if (!response.ok) {
    const failure: ProviderHangupHttpFailure =
      upstreamRequestId === null
        ? {
            stage: "hangup",
            code: "session_release_failed",
            providerStatus: response.status,
            retryable: isRetryableProviderStatus(response.status),
          }
        : {
            stage: "hangup",
            code: "session_release_failed",
            providerStatus: response.status,
            requestId: upstreamRequestId,
            retryable: isRetryableProviderStatus(response.status),
          };
    return providerFailure(failure);
  }

  return providerSuccess({
    status: response.status,
    upstreamRequestId,
  });
}

/**
 * Attempts the side connection until one is accepted, an attempt is refused for good, the
 * attempts run out or the deadline passes, pausing up to 2 s between attempts. Its outcome is
 * the accepted socket or the last attempt's failure.
 */
function connectSideband(
  transport: typeof fetch,
  input: RealtimeSidebandRequest,
): Effect.Effect<ProviderOutcome<ProviderWebSocket>> {
  return Effect.gen(function* () {
    const deadline = input.retryDeadlineAt ?? (yield* Clock.currentTimeMillis) + 75_000;
    let attemptNumber = 0;
    let lastFailure: SidebandAttemptFailure | null = null;
    while (attemptNumber < SIDEBAND_MAX_ATTEMPTS && (yield* remainingUntil(deadline)) > 0) {
      attemptNumber += 1;
      const attempt: ProviderSidebandAttempt = {
        url: `${OPENAI_BASE}/realtime?call_id=${encodeURIComponent(input.callId)}`,
        attemptNumber,
        apiKey: input.apiKey,
        emit: input.emit,
        deadlineAt: deadline,
      };
      if (input.retainAcquisition !== undefined)
        attempt.retainAcquisition = input.retainAcquisition;
      input.observeAttempt?.({
        kind: "started",
        deadlineFailure: {
          kind: "provider_failure",
          stage: "session_setup",
          ...sidebandDeadlineFailure,
        },
      });
      const result = yield* sidebandAttempt(transport, attempt);
      if (result.ok) return providerSuccess(result.socket);
      lastFailure = result.failure;
      input.observeAttempt?.({
        kind: "failed",
        failure: { kind: "provider_failure", stage: "session_setup", ...result.failure },
      });
      if (!result.failure.retryable) break;
      const remainingMs = yield* remainingUntil(deadline);
      if (remainingMs === 0) break;
      yield* Effect.sleep(Math.min(2_000, remainingMs));
    }
    if (lastFailure?.providerStatus === undefined)
      return providerFailure({
        stage: "session_setup",
        code: lastFailure?.code ?? "sideband_connect_failed",
        retryable: lastFailure?.retryable ?? true,
      });
    return providerFailure(
      lastFailure.requestId === undefined
        ? {
            stage: "session_setup",
            code: lastFailure.code,
            providerStatus: lastFailure.providerStatus,
            retryable: lastFailure.retryable,
          }
        : {
            stage: "session_setup",
            code: lastFailure.code,
            providerStatus: lastFailure.providerStatus,
            requestId: lastFailure.requestId,
            retryable: lastFailure.retryable,
          },
    );
  });
}

function encodeFinalizationOperation(operation: RealtimeEndingCommand): ProviderCommand {
  switch (operation.kind) {
    case "disable_automatic_turns":
      return buildDisableAutomaticTurnsCommand(operation.commandId);
    case "commit_input":
      return buildFinalInputCommitCommand(operation.commandId);
    case "clear_input":
      return buildClearInputCommand(operation.commandId);
    case "cancel_response":
      return buildCancelResponseCommand(operation.commandId, operation.responseId);
    case "clear_output":
      return buildClearOutputCommand(operation.commandId);
  }
}

export function getProviderCallId(sessionLocation: string | null): string | null {
  if (sessionLocation === null) {
    return null;
  }

  const locationPath = sessionLocation.split("?")[0] ?? "";
  const candidate = locationPath.split("/").filter(Boolean).at(-1) ?? "";
  return /^rtc_[A-Za-z0-9_-]+$/.test(candidate) ? candidate : null;
}

const providerHangupTimeoutSettingSchema = z
  .union([
    z
      .number()
      .refine((setting) => Number.isFinite(setting) && setting > 0)
      .transform(Math.floor),
    z
      .string()
      .refine((setting) => setting.trim().length > 0)
      .transform(Number)
      .refine((setting) => Number.isFinite(setting) && setting > 0)
      .transform(Math.floor),
  ])
  .catch(DEFAULT_PROVIDER_HANGUP_TIMEOUT_MS);

export const readProviderHangupTimeoutMs = boundary({
  schema: providerHangupTimeoutSettingSchema,
  convert: (timeoutMs) => timeoutMs,
});

type SidebandAttemptFailure = Readonly<{
  code: "sideband_connect_failed" | "sideband_call_id_not_found" | "sideband_connect_rejected";
  providerStatus?: number;
  requestId?: string;
  retryable: boolean;
}>;

type ProviderSidebandRejection = {
  code: "sideband_call_id_not_found" | "sideband_connect_rejected";
  providerStatus: number;
  requestId?: string;
  retryable: boolean;
};

class ProviderSidebandTransportError extends Data.TaggedError("ProviderSidebandTransportError")<{
  readonly cause: unknown;
}> {}

/**
 * One attempt at the side connection. Its upgrade reply belongs to the attempt until the
 * attempt takes its socket: a reply that arrives once the attempt has ended is released in its
 * native continuation, and one that arrived but was not taken, because the attempt failed or
 * was interrupted first, is released when the attempt ends. Either way an accepted upgrade is
 * closed, never leaked.
 */
function sidebandAttempt(transport: typeof fetch, input: Readonly<ProviderSidebandAttempt>) {
  let arrived: Response | null = null;
  const operation = providerRequestUntil(
    input.deadlineAt,
    (controller) =>
      Effect.gen(function* () {
        input.emit("sideband.connect_attempt", {
          url: redactSidebandUrl(input.url),
          attemptNumber: input.attemptNumber,
        });
        const response = yield* callUntilDeadline({
          deadlineAt: input.deadlineAt,
          operation: () => {
            const nativeHeaders = transport(input.url, {
              headers: { Authorization: `Bearer ${input.apiKey}`, Upgrade: "websocket" },
              signal: controller.signal,
            }).then((reply) => {
              // Fetch implementations can ignore abort. Their late upgraded socket still needs release.
              if (controller.signal.aborted) releaseUpgrade(reply);
              else arrived = reply;
              return reply;
            });
            // The bounded waiter can end before ignored-abort native I/O. Retain its
            // resource-only completion; the waiting operation owns transport failure mapping.
            input.retainAcquisition?.(
              nativeHeaders.then(
                () => undefined,
                () => undefined,
              ),
            );
            return nativeHeaders;
          },
          onTransportFailure: (cause) => new ProviderSidebandTransportError({ cause }),
          onTimeout: () => new ProviderRequestDeadline(),
        });
        yield* failAtDeadline(input.deadlineAt);
        const webSocket = readWebSocket(response);
        if (webSocket !== null) {
          return yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              // Taken: from here the attempt's own release decides the socket's fate.
              arrived = null;
              return webSocket;
            }),
            (socket) =>
              Effect.sync(() => {
                socket.accept();
                input.emit("sideband.connect_attempt_accepted", {
                  url: redactSidebandUrl(input.url),
                  attemptNumber: input.attemptNumber,
                  status: response.status,
                  upstreamRequestId: response.headers.get("x-request-id"),
                });
                return { ok: true, socket } as const;
              }),
            (socket, exit) =>
              Effect.sync(() => {
                if (Exit.isSuccess(exit)) return;
                try {
                  socket.close(1000, "sideband_acquisition_failed");
                } catch {
                  /* Independent native release must preserve the acquisition failure. */
                }
              }),
          );
        }
        const body = yield* callUntilDeadline({
          deadlineAt: input.deadlineAt,
          operation: () => response.text(),
          onTransportFailure: (cause) => new ProviderSidebandTransportError({ cause }),
          onTimeout: () => new ProviderRequestDeadline(),
        });
        yield* failAtDeadline(input.deadlineAt);
        const isRetryableCallIdMiss = response.status === 404 && body.includes("call_id_not_found");
        const upstreamRequestId = response.headers.get("x-request-id");
        const failure: ProviderSidebandRejection = {
          code: isRetryableCallIdMiss ? "sideband_call_id_not_found" : "sideband_connect_rejected",
          providerStatus: response.status,
          retryable: isRetryableCallIdMiss,
        };
        input.emit("sideband.connect_attempt_rejected", {
          url: redactSidebandUrl(input.url),
          attemptNumber: input.attemptNumber,
          status: response.status,
          upstreamRequestId,
        });
        return {
          ok: false,
          failure:
            upstreamRequestId === null ? failure : { ...failure, requestId: upstreamRequestId },
        } as const;
      }),
    (result) => result.ok,
  );
  return operation.pipe(
    // The request was aborted first, so a reply still arriving releases itself.
    Effect.ensuring(
      Effect.sync(() => {
        const reply = arrived;
        arrived = null;
        if (reply !== null) releaseUpgrade(reply);
      }),
    ),
    Effect.catchTags({
      ProviderRequestDeadline: () =>
        Effect.succeed({
          ok: false,
          failure: sidebandDeadlineFailure,
        } as const),
      ProviderSidebandTransportError: ({ cause }) =>
        Effect.sync(() => {
          input.emit("sideband.connect_attempt_error", {
            url: redactSidebandUrl(input.url),
            attemptNumber: input.attemptNumber,
            stackName: cause instanceof Error ? cause.name : undefined,
          });
          return {
            ok: false,
            failure: sidebandDeadlineFailure,
          } as const;
        }),
    }),
  );
}

/** Accepts and closes the upgraded socket of a reply no attempt takes; other replies hold none. */
function releaseUpgrade(reply: Response): void {
  const lateSocket = readWebSocket(reply);
  if (lateSocket === null) return;
  try {
    lateSocket.accept();
  } catch {
    /* Native accept failure must not skip the independent release. */
  }
  try {
    lateSocket.close(1000, "sideband_acquisition_cancelled");
  } catch {
    /* best-effort native release */
  }
}

// Native sockets retain prototype methods; supported injected drivers may omit listener removal.
const providerWebSocketBoundary = boundary.tolerant({
  source: "Cloudflare provider sideband upgrade response",
  variants: [
    {
      schema: z.custom<ProviderWebSocket>(
        (value) =>
          value !== null &&
          typeof value === "object" &&
          "readyState" in value &&
          typeof value.readyState === "number" &&
          "accept" in value &&
          typeof value.accept === "function" &&
          "send" in value &&
          typeof value.send === "function" &&
          "addEventListener" in value &&
          typeof value.addEventListener === "function" &&
          (!("removeEventListener" in value) ||
            value.removeEventListener === undefined ||
            typeof value.removeEventListener === "function") &&
          "close" in value &&
          typeof value.close === "function",
      ),
      convert: (socket) => socket,
    },
  ],
  otherwise: failure("invalid_provider_sideband_websocket"),
});

function readWebSocket(response: Response): ProviderWebSocket | null {
  const parsed = providerWebSocketBoundary(response.webSocket);
  return parsed.ok ? parsed.value : null;
}

function isRetryableProviderStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function redactSidebandUrl(url: string): string {
  return url.replace(/call_id=rtc_[A-Za-z0-9_-]+/, "call_id=rtc_redacted");
}
