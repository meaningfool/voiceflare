import { Data, Effect } from "effect";
import {
  computeRuntimeTranscriptDigest,
  createRuntimeTranscriptSnapshot,
  type RuntimeTranscript,
  type RuntimeTranscriptSnapshot,
} from "../shared/runtimeTranscriptSnapshot.ts";

/**
 * The Web platform's promise APIs that Runtime's Effect code awaits, as Effects. This module is
 * one of the listed places where a promise becomes Effect (`effectEdges` in
 * `scripts/check-effect-diagnostics.ts`).
 */

/**
 * The transcript's digest, which Web Crypto computes. Ending awaits it as an async step that
 * returns the digest's promise, as it always has, so it settles a microtask after the digest.
 */
export function runtimeTranscriptDigest(transcript: RuntimeTranscript): Effect.Effect<string> {
  return Effect.promise(async () => computeRuntimeTranscriptDigest(transcript));
}

/** The transcript's snapshot at a revision, with its Web Crypto digest. */
export function runtimeTranscriptSnapshot(
  revision: number,
  transcript: RuntimeTranscript,
): Effect.Effect<RuntimeTranscriptSnapshot> {
  return Effect.promise(() => createRuntimeTranscriptSnapshot(revision, transcript));
}

/** A response body that could not be read or parsed as JSON. */
export class ResponseBodyUnreadable extends Data.TaggedError("ResponseBodyUnreadable")<{
  cause: unknown;
}> {}

/** A response body read as JSON. */
export function responseJson(response: Response): Effect.Effect<unknown, ResponseBodyUnreadable> {
  return Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => new ResponseBodyUnreadable({ cause }),
  });
}

/**
 * The microtask boundary that follows an awaited promise step: work queued meanwhile, such as a
 * native receipt or an interruption, is observed after it. Unlike a scheduler yield, it does not
 * wait on a timer.
 */
export const microtaskBoundary: Effect.Effect<void> = Effect.promise(() => Promise.resolve());
