import { Cause, Deferred, Effect, Layer, Queue, Stream } from "effect";
import { z } from "zod";
import { boundary, failure } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import { CascadeSpeechInput, SpeechInputFailed, type SpeechInputEvent } from "./adapters.ts";
import type { CascadeAdapterOptions, CascadeProviderDeclaration } from "./providerDeclaration.ts";
import { jsonText } from "./providerJson.ts";
import { providerConnectionTimeLimit } from "./providerTimeLimits.ts";

/**
 * The Gradium STT adapter of the Cascade speech-input contract. Each recognition stream is one
 * Gradium connection: `setup` names the profile's 16 kHz PCM, English and the delay, and audio
 * is sent once Gradium answers `ready`. Gradium sends final text and, every 80 ms, the
 * probability that the speaker has stopped at several horizons; it has no end-of-turn token, so
 * the adapter applies Gradium's turn rule itself: once the chosen horizon's probability has
 * exceeded the threshold on enough consecutive steps with recognized text pending, it sends
 * `flush`, and the turn ends at the matching `flushed`, after any text the flush settled. No
 * keepalive is sent: Gradium kept a connection without audio open for 60 s (spike,
 * 2026-11-05), and silence ends no turn on its own. The global host serves it (user,
 * 2026-11-05).
 */
export const gradiumSpeechInputUrl = "https://api.gradium.ai/api/speech/asr";

/** Gradium's STT model; `default` is the only one its documentation names. */
export const gradiumSpeechInputModels = Object.freeze(["default"] as const);

/**
 * How many 80 ms frames Gradium waits before it commits text, as its documentation lists them.
 * The spike found that the delay moved text by about 0.25 s each way and did not change when
 * the turn rule fired.
 */
export const gradiumSpeechInputDelays = Object.freeze([
  7, 8, 10, 12, 14, 16, 20, 24, 36, 48,
] as const);

/** The horizons, in seconds, at which Gradium reports the probability that the speaker stopped. */
export const gradiumSpeechInputTurnHorizons = Object.freeze([0.5, 1, 2, 3] as const);

/** Gradium's name of the profile's input format: 16-bit mono PCM at 16 kHz. */
const inputFormat = "pcm_16000";

/**
 * Gradium's turn rule, as its documentation describes it:
 * - `turnHorizon`: the horizon whose inactivity probability the rule reads;
 * - `turnThreshold`, 0 to 1: the probability a step must exceed;
 * - `turnSteps`, 1 to 10: how many consecutive steps must exceed it. A step at or below the
 *   threshold starts the count again.
 */
const settingFields = {
  model: z.enum(gradiumSpeechInputModels),
  delayInFrames: z.literal(gradiumSpeechInputDelays),
  turnHorizon: z.literal(gradiumSpeechInputTurnHorizons),
  turnThreshold: z.number().min(0).max(1),
  turnSteps: z.number().int().min(1).max(10),
};
const provider = z.literal("gradium");

/** The Gradium speech-input settings a Start may give, beside `provider`; each may be left out. */
export const gradiumSpeechInputGivenSettings = z
  .strictObject(settingFields)
  .partial()
  .extend({ provider });

/** The Gradium speech-input settings a session uses, every one decided. */
export const gradiumSpeechInputSettings = z.strictObject({ provider, ...settingFields });
export type GradiumSpeechInputSettings = z.output<typeof gradiumSpeechInputSettings>;

/**
 * Gradium STT as Cascade's speech input. Its turn rule starts from the 2 s horizon above 0.5 on
 * 3 steps, which ended the spike's hesitant answer once, about 1.6 s after its end, where the
 * shorter horizons ended it in its pauses (plan decision 7; tuned later by ear), and from
 * Gradium's default delay of 10 frames. It needs the Gradium API key; Gradium reports no usage,
 * so Cascade measures the participant audio it was sent, naming the model of the session's
 * settings.
 */
export const gradiumSpeechInputProvider = Object.freeze({
  provider: "gradium",
  defaults: Object.freeze({
    provider: "gradium",
    model: "default",
    delayInFrames: 10,
    turnHorizon: 2,
    turnThreshold: 0.5,
    turnSteps: 3,
  }),
  credentials: ["GRADIUM_API_KEY"],
  usage: Object.freeze({ provider: "gradium" }),
  adapter: (options, settings) => gradiumSpeechInput(options, settings),
} satisfies CascadeProviderDeclaration<GradiumSpeechInputSettings, CascadeSpeechInput>);

/** One message the adapter sends on a recognition connection. */
type RecognitionRequest =
  | Readonly<{
      type: "setup";
      model_name: string;
      input_format: string;
      json_config: Readonly<{ language: string; delay_in_frames: number }>;
    }>
  | Readonly<{ type: "audio"; audio: string }>
  | Readonly<{ type: "flush"; flush_id: number }>
  | Readonly<{ type: "end_of_stream" }>;

/** One message of a recognition connection, as the adapter uses it. */
type RecognitionMessage =
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{
      kind: "step";
      inactivity: readonly Readonly<{ horizonS: number; probability: number }>[];
    }>
  | Readonly<{ kind: "flushed"; flushId: number }>
  | Readonly<{ kind: "end" }>
  | Readonly<{ kind: "error"; code: number | null }>
  | Readonly<{ kind: "ignored" }>;

/** The message types the adapter reads; one of these in a shape it cannot use is undecodable. */
const readTypes: readonly string[] = [
  "ready",
  "text",
  "step",
  "vad",
  "flushed",
  "end_of_stream",
  "error",
];

const inactivitySchema = z.array(
  z.object({ horizon_s: z.number(), inactivity_prob: z.number().min(0).max(1) }),
);

/**
 * Gradium's STT WebSocket messages, which evolve independently of Runtime. The adapter reads
 * `ready`, each `text`, the inactivity probabilities of each `step` (or of `vad`, which older
 * servers send instead), `flushed` with its `flush_id`, the server's `end_of_stream` and
 * `error` with its numeric code. Every other type, such as `end_text`, is ignored.
 */
export const decodeGradiumRecognitionMessage = boundary.tolerant({
  source: "Gradium STT WebSocket message",
  variants: [
    {
      schema: jsonText(
        z.union([
          z
            .object({ type: z.literal("ready") })
            .transform((): RecognitionMessage => ({ kind: "ready" })),
          z
            .object({ type: z.literal("text"), text: z.string() })
            .transform(({ text }): RecognitionMessage => ({ kind: "text", text })),
          z.object({ type: z.enum(["step", "vad"]), vad: inactivitySchema }).transform(
            ({ vad }): RecognitionMessage => ({
              kind: "step",
              inactivity: vad.map((entry) => ({
                horizonS: entry.horizon_s,
                probability: entry.inactivity_prob,
              })),
            }),
          ),
          z.object({ type: z.literal("flushed"), flush_id: z.number().int() }).transform(
            ({ flush_id }): RecognitionMessage => ({
              kind: "flushed",
              flushId: flush_id,
            }),
          ),
          z
            .object({ type: z.literal("end_of_stream") })
            .transform((): RecognitionMessage => ({ kind: "end" })),
          z
            .object({ type: z.literal("error"), code: z.number().int().nullish() })
            .transform(({ code }): RecognitionMessage => ({ kind: "error", code: code ?? null })),
          z
            .object({ type: z.string() })
            .refine(({ type }) => !readTypes.includes(type))
            .transform((): RecognitionMessage => ({ kind: "ignored" })),
        ]),
      ),
      convert: (message) => message,
    },
  ],
  otherwise: failure("gradium_message_undecodable"),
});

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function gradiumSpeechInput(
  options: CascadeAdapterOptions,
  settings: GradiumSpeechInputSettings,
): Layer.Layer<CascadeSpeechInput> {
  const upgrade = Effect.tryPromise({
    try: (signal) =>
      options.transport(gradiumSpeechInputUrl, {
        headers: { "x-api-key": options.apiKey, Upgrade: "websocket" },
        signal,
      }),
    catch: () => new SpeechInputFailed({ code: "gradium_transport_failed" }),
  }).pipe(
    Effect.flatMap((response) => {
      const socket = response.webSocket;
      if (socket !== null) return Effect.succeed(socket);
      // A refused upgrade answers over HTTP; its body is not read.
      return Effect.promise(
        () => response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
      ).pipe(
        Effect.andThen(
          Effect.fail(new SpeechInputFailed({ code: `gradium_http_${String(response.status)}` })),
        ),
      );
    }),
    Effect.tap((socket) =>
      Effect.try({
        try: () => socket.accept(),
        catch: () => new SpeechInputFailed({ code: "gradium_upgrade_failed" }),
      }),
    ),
  );
  return Layer.effect(
    CascadeSpeechInput,
    Effect.sync(() =>
      CascadeSpeechInput.of({
        usage: { ...gradiumSpeechInputProvider.usage, model: settings.model },
        open: Effect.gen(function* () {
          const events = yield* Queue.unbounded<SpeechInputEvent, SpeechInputFailed | Cause.Done>();
          const ready = yield* Deferred.make<void, SpeechInputFailed>();
          const finalized = yield* Deferred.make<void, SpeechInputFailed>();
          let released = false;
          let settled = false;
          // Whether the stream has delivered text, which the next text follows with a space.
          let spoken = false;
          // Recognized text that no turn end has closed yet.
          let textPending = false;
          // Consecutive steps whose probability at the chosen horizon exceeded the threshold.
          let inactiveSteps = 0;
          let nextFlushId = 1;
          // The flush the turn rule sent, until its `flushed`.
          let turnFlushId: number | null = null;
          // The flush finalization sent, until its `flushed`; no turn rule fires once it is sent.
          let finalizeFlushId: number | null = null;
          const fail = (code: string) => {
            if (settled || released) return;
            settled = true;
            const error = new SpeechInputFailed({ code });
            Queue.failCauseUnsafe(events, Cause.fail(error));
            Deferred.doneUnsafe(ready, Effect.fail(error));
            Deferred.doneUnsafe(finalized, Effect.fail(error));
          };
          const sendNow = (socket: WebSocket, message: RecognitionRequest) => {
            try {
              socket.send(JSON.stringify(message));
              return true;
            } catch {
              fail("gradium_send_failed");
              return false;
            }
          };
          const onMessage = (socket: WebSocket) => (event: MessageEvent) => {
            if (settled || released) return;
            const decoded = decodeGradiumRecognitionMessage(event.data);
            if (!decoded.ok) return fail(decoded.error.code);
            const message = decoded.value;
            switch (message.kind) {
              case "ignored":
                return;
              case "error":
                return fail(
                  message.code === null ? "gradium_error" : `gradium_error_${String(message.code)}`,
                );
              case "end":
                // Gradium ends its stream only after the adapter's own end, sent at release.
                return fail("gradium_stream_ended");
              case "ready":
                Deferred.doneUnsafe(ready, Effect.void);
                return;
              case "text": {
                if (message.text.length === 0) return;
                // Gradium's words carry no leading space, and Cascade joins transcript events
                // without a separator.
                const text = spoken ? ` ${message.text}` : message.text;
                spoken = true;
                textPending = true;
                Queue.offerUnsafe(events, { kind: "transcript", text, final: true });
                return;
              }
              case "step": {
                const step = message.inactivity.find(
                  ({ horizonS }) => horizonS === settings.turnHorizon,
                );
                // Without its horizon the rule could never end a turn: the stream fails instead.
                if (step === undefined) return fail("gradium_turn_horizon_missing");
                inactiveSteps = step.probability > settings.turnThreshold ? inactiveSteps + 1 : 0;
                // A count already past the required steps still ends the turn once text is
                // pending: Gradium commits text a delay after its speech, so the last words can
                // arrive after the pause has begun to count.
                if (
                  inactiveSteps >= settings.turnSteps &&
                  textPending &&
                  turnFlushId === null &&
                  finalizeFlushId === null
                ) {
                  turnFlushId = nextFlushId++;
                  sendNow(socket, { type: "flush", flush_id: turnFlushId });
                }
                return;
              }
              case "flushed": {
                // Gradium sends any text the flush settled before its `flushed`.
                if (message.flushId === turnFlushId) {
                  turnFlushId = null;
                  textPending = false;
                  Queue.offerUnsafe(events, { kind: "turn_ended" });
                } else if (message.flushId === finalizeFlushId) {
                  textPending = false;
                  Queue.offerUnsafe(events, { kind: "finalized" });
                  Deferred.doneUnsafe(finalized, Effect.void);
                }
                return;
              }
            }
          };
          /**
           * The stream's connection: upgraded, set up and `ready` within the connection limit.
           * Released, it ends the stream and closes.
           */
          const socket = yield* Effect.acquireRelease(
            upgrade,
            (open) =>
              Effect.sync(() => {
                const wasSettled = settled;
                released = true;
                if (!wasSettled) {
                  try {
                    open.send(
                      JSON.stringify({ type: "end_of_stream" } satisfies RecognitionRequest),
                    );
                  } catch {
                    /* Closing the connection still ends the stream. */
                  }
                }
                try {
                  open.close(1000, "recognition_released");
                } catch {
                  /* An already-closed connection needs no release. */
                }
                Queue.endUnsafe(events);
              }),
            { interruptible: true },
          ).pipe(
            Effect.tap((open) =>
              Effect.gen(function* () {
                open.addEventListener("message", onMessage(open));
                open.addEventListener("close", () => fail("gradium_connection_closed"));
                open.addEventListener("error", () => fail("gradium_connection_failed"));
                sendNow(open, {
                  type: "setup",
                  model_name: settings.model,
                  input_format: inputFormat,
                  json_config: { language: "en", delay_in_frames: settings.delayInFrames },
                });
                yield* Deferred.await(ready);
              }),
            ),
            // A connection not ready at its limit is abandoned: its request is aborted.
            Effect.timeoutOrElse({
              duration: providerConnectionTimeLimit,
              orElse: () =>
                Effect.fail(new SpeechInputFailed({ code: "gradium_connection_timeout" })),
            }),
          );
          const send = (message: RecognitionRequest) =>
            Effect.suspend(() =>
              settled
                ? Effect.fail(new SpeechInputFailed({ code: "gradium_closed" }))
                : sendNow(socket, message)
                  ? Effect.void
                  : Effect.fail(new SpeechInputFailed({ code: "gradium_send_failed" })),
            );
          return {
            ingest: (audio: Uint8Array) => send({ type: "audio", audio: encodeBase64(audio) }),
            events: Stream.fromQueue(events),
            finalize: Effect.suspend(() => {
              if (finalizeFlushId === null) finalizeFlushId = nextFlushId++;
              return send({ type: "flush", flush_id: finalizeFlushId });
            }).pipe(Effect.andThen(Deferred.await(finalized))),
          };
        }),
      }),
    ),
  );
}
