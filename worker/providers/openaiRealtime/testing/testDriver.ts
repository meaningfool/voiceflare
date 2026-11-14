import { Data, Effect, Layer } from "effect";
import {
  openAiRealtimeDriver,
  RealtimeDriver,
  type ProviderCall,
  type ProviderHangup,
  type ProviderWebSocket,
  type RealtimeCallRequest,
  type RealtimeDriverLayer,
  type RealtimeHangupRequest,
  type RealtimeProviderDriver,
  type RealtimeSidebandRequest,
} from "../openaiRealtimeDriver.ts";
import type { ProviderOutcome } from "../../../runtime/providerOutcomes.ts";

/** A scripted provider operation's outcome: a promise, as a test writes it, or an Effect. */
type Scripted<A> = Promise<A> | Effect.Effect<A>;

/**
 * What a test scripts of the Realtime driver. Each scripted operation replaces OpenAI's; an
 * unscripted one is OpenAI's own. A scripted side connection receives the attempt's abort
 * signal, which is aborted when the session stops waiting for it.
 */
export type RealtimeDriverScript = Partial<
  Readonly<{
    normalizeEvent: RealtimeProviderDriver["normalizeEvent"];
    normalizeRuntimeObservation: RealtimeProviderDriver["normalizeRuntimeObservation"];
    createCall(input: RealtimeCallRequest): Scripted<ProviderOutcome<ProviderCall>>;
    connectSideband(
      input: RealtimeSidebandRequest & Readonly<{ signal: AbortSignal }>,
    ): Scripted<ProviderOutcome<ProviderWebSocket>>;
    sendCommand: RealtimeProviderDriver["sendCommand"];
    sendFinalizationOperation: RealtimeProviderDriver["sendFinalizationOperation"];
    hangUp(input: RealtimeHangupRequest): Scripted<ProviderOutcome<ProviderHangup>>;
  }>
>;

/** A scripted side connection that rejected: a defect of the test, not provider evidence. */
class ScriptedConnectionRejected extends Data.TaggedError("ScriptedConnectionRejected")<{
  cause: unknown;
}> {}

/**
 * The Realtime kit's test version of its driver, provided as the driver's service in place of
 * OpenAI's (`RuntimeHostConfiguration.realtimeDriver`, the host controller's `realtimeDriver`
 * option, or a session's `driver`), as Cascade's stand-ins replace its providers. A scripted
 * promise that rejects is a defect. A scripted side connection that resolves with a socket
 * once its signal was aborted closes that socket, so a script that ignores abort leaks none.
 */
export function realtimeTestDriver(script: RealtimeDriverScript = {}): RealtimeDriverLayer {
  return Layer.effect(
    RealtimeDriver,
    Effect.gen(function* () {
      const openAi = yield* RealtimeDriver;
      const { createCall, connectSideband, hangUp } = script;
      return RealtimeDriver.of({
        normalizeEvent: script.normalizeEvent ?? openAi.normalizeEvent,
        normalizeRuntimeObservation:
          script.normalizeRuntimeObservation ?? openAi.normalizeRuntimeObservation,
        createCall:
          createCall === undefined
            ? openAi.createCall
            : (input) => scripted(() => createCall(input)),
        connectSideband:
          connectSideband === undefined
            ? openAi.connectSideband
            : (input) => scriptedConnection(connectSideband, input),
        sendCommand: script.sendCommand ?? openAi.sendCommand,
        sendFinalizationOperation:
          script.sendFinalizationOperation ?? openAi.sendFinalizationOperation,
        hangUp: hangUp === undefined ? openAi.hangUp : (input) => scripted(() => hangUp(input)),
      });
    }),
  ).pipe(Layer.provide(openAiRealtimeDriver()));
}

function scripted<A>(operation: () => Scripted<A>): Effect.Effect<A> {
  return Effect.suspend(() => {
    const outcome = operation();
    return Effect.isEffect(outcome) ? outcome : Effect.promise(() => outcome);
  });
}

function scriptedConnection(
  connect: NonNullable<RealtimeDriverScript["connectSideband"]>,
  input: RealtimeSidebandRequest,
): Effect.Effect<ProviderOutcome<ProviderWebSocket>> {
  return Effect.suspend(() => {
    const controller = new AbortController();
    const outcome = connect({ ...input, signal: controller.signal });
    if (Effect.isEffect(outcome)) return outcome;
    const native = outcome.then((result) => {
      if (result.ok && controller.signal.aborted) releaseSocket(result.value);
      return result;
    });
    // The promise may outlive the wait. Retain only its release continuation.
    input.retainAcquisition?.(
      native.then(
        () => undefined,
        () => undefined,
      ),
    );
    return Effect.tryPromise({
      try: () => native,
      catch: (cause) => new ScriptedConnectionRejected({ cause }),
    }).pipe(
      Effect.catchTag("ScriptedConnectionRejected", ({ cause }) => Effect.die(cause)),
      Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
    );
  });
}

function releaseSocket(socket: ProviderWebSocket): void {
  try {
    socket.close(1000, "sideband_restore_no_longer_allowed");
  } catch {
    /* Native release must not manufacture provider evidence. */
  }
}

/**
 * OpenAI's driver over `transport`, as a value, for a test that scripts one operation with
 * OpenAI's own on a controlled transport, or calls an operation directly.
 */
export function openAiDriverOver(transport?: typeof fetch): RealtimeProviderDriver {
  return Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        return yield* RealtimeDriver;
      }),
      openAiRealtimeDriver(transport),
    ),
  );
}

/** The scripted operations, each required, by name. */
export type ScriptedRealtimeDriver = Required<RealtimeDriverScript>;
