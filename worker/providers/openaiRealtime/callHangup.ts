import { Effect } from "effect";
import type { SessionReleaseAnswer } from "../../runtime/nativeContracts.ts";
import { providerFailureText } from "../../runtime/providerOutcomes.ts";
import { missingCredentialsRefusal } from "../../shared/contracts/conversationSelection.ts";
import { realtimeCredentials } from "./credentials.ts";
import {
  readProviderHangupTimeoutMs,
  RealtimeDriver,
  type RealtimeDriverLayer,
} from "./openaiRealtimeDriver.ts";

/** OpenAI's outcome of one exact-call hang-up, before the kit reads it as the release's answer. */
export type CallHangupOutcome = Readonly<{
  ok: boolean;
  status: number | null;
  upstreamRequestId: string | null;
  code?: string;
  debugText: string;
}>;

type ExactCallHangup = Readonly<{
  sessionId: string | null;
  feasible: boolean;
  apiKey: string;
  hangupTimeoutSetting: string | undefined;
  timeoutCapMs: number | undefined;
  /** The Realtime driver that hangs the call up. */
  driver: RealtimeDriverLayer;
  /** Hears the hang-up's outcome before it is read as the answer, such as for diagnostics. */
  onOutcome?: ((outcome: CallHangupOutcome) => void) | undefined;
}>;

/**
 * Releases one exact OpenAI Realtime call by hanging it up, and answers from the hang-up's
 * outcome. A skipped or infeasible hang-up answers without entering `run`; only the provider
 * request runs through it.
 */
export function hangUpExactProviderCall(
  input: ExactCallHangup & {
    run: (operation: Effect.Effect<SessionReleaseAnswer>) => Promise<SessionReleaseAnswer>;
  },
): Promise<SessionReleaseAnswer> {
  if (input.sessionId === null || !input.feasible)
    return Promise.resolve(answerRelease(heard(input, unattempted(input))));
  return input.run(exactProviderCallHangup(input));
}

/** The exact-call release as an Effect, for an owner that composes it with other native work. */
export function exactProviderCallHangup(
  input: ExactCallHangup,
): Effect.Effect<SessionReleaseAnswer> {
  if (input.sessionId === null || !input.feasible)
    return Effect.sync(() => answerRelease(heard(input, unattempted(input))));
  return Effect.map(callHangup(input, input.sessionId), (outcome) =>
    answerRelease(heard(input, outcome)),
  );
}

/**
 * The release's answer from the hang-up's outcome. Only OpenAI's documented exact-call terminal
 * evidence proves the session closed. An accepted hang-up leaves the closure to be confirmed by
 * the side connection's `session.closed`, which the session reports; a skipped one confirms
 * nothing.
 */
export function answerRelease(outcome: CallHangupOutcome): SessionReleaseAnswer {
  if (outcome.code === "provider_session_already_closed") return { status: "closed" };
  if (outcome.ok && outcome.status !== 404) return { status: "close_unconfirmed" };
  const code = outcome.code ?? "session_release_failed";
  return {
    status: "close_unconfirmed",
    failure: {
      status: code.includes("timed_out") || code.includes("uncertain") ? "uncertain" : "failed",
      timedOut: code.includes("timed_out"),
      code,
    },
  };
}

function heard(input: ExactCallHangup, outcome: CallHangupOutcome): CallHangupOutcome {
  input.onOutcome?.(outcome);
  return outcome;
}

function unattempted(input: ExactCallHangup): CallHangupOutcome {
  return input.sessionId === null ? skippedWithoutCall() : infeasible();
}

function callHangup(input: ExactCallHangup, sessionId: string): Effect.Effect<CallHangupOutcome> {
  const { timeoutCapMs } = input;
  return Effect.gen(function* () {
    const configuredTimeoutMs = readProviderHangupTimeoutMs(input.hangupTimeoutSetting);
    const timeoutMs =
      timeoutCapMs === undefined
        ? configuredTimeoutMs
        : Math.max(1, Math.min(configuredTimeoutMs, Math.trunc(timeoutCapMs)));
    const driver = yield* RealtimeDriver;
    const result = yield* driver.hangUp({
      apiKey: input.apiKey,
      callId: sessionId,
      timeoutMs,
    });
    if (result.ok)
      return {
        ok: true,
        status: result.value.status,
        upstreamRequestId: result.value.upstreamRequestId,
        debugText: `Controller requested provider hangup for ${sessionId}.`,
      };
    const failure = result.failure;
    if (failure.code === "session_release_timed_out")
      return {
        ok: false,
        status: null,
        upstreamRequestId: failure.requestId ?? null,
        code: failure.code,
        debugText: `Provider hangup timed out after ${failure.timeoutMs ?? timeoutMs}ms.`,
      };
    return {
      ok: false,
      status: failure.providerStatus ?? null,
      upstreamRequestId: failure.requestId ?? null,
      code: failure.code,
      debugText: failure.providerStatus
        ? `Provider hangup returned ${failure.providerStatus}.`
        : `Provider hangup request failed (${providerFailureText(failure)}).`,
    } satisfies CallHangupOutcome;
  }).pipe(Effect.provide(input.driver));
}

const skippedWithoutCall = (): CallHangupOutcome => ({
  ok: true,
  status: null,
  upstreamRequestId: null,
  debugText: "Provider hangup was skipped because no provider call ID was available.",
});
const infeasible = (): CallHangupOutcome => ({
  ok: false,
  status: null,
  upstreamRequestId: null,
  code: missingCredentialsRefusal(realtimeCredentials),
  debugText: `Provider hangup could not run because ${realtimeCredentials.join(", ")} is missing.`,
});
