import { Cause, Clock, Deferred, Duration, Effect, Layer, Queue, Schedule, Stream } from "effect";
import { z } from "zod";
import { boundary, failure } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import { cascadeMediaInputFormat } from "../../shared/contracts/cascadeMedia.ts";
import { CascadeSpeechInput, SpeechInputFailed, type SpeechInputEvent } from "./adapters.ts";
import type { CascadeAdapterOptions, CascadeProviderDeclaration } from "./providerDeclaration.ts";
import { jsonText } from "./providerJson.ts";
import { providerConnectionTimeLimit } from "./providerTimeLimits.ts";

/**
 * The Soniox real-time STT adapter of the Cascade speech-input contract. Each recognition
 * stream is one Soniox connection with endpoint detection: final tokens stream in order, and
 * the `<end>` token marks the end of the participant's turn after its preceding tokens became
 * final. While no audio is forwarded the adapter sends keepalives, so a silent participant
 * never ends the stream.
 */
export const sonioxSpeechInputUrl = "https://stt-rt.soniox.com/transcribe-websocket";

/**
 * Soniox real-time STT models that support every turn-detection setting below, as Soniox's
 * model catalog listed them on 2026-11-04; the first is the one Cascade always ran.
 */
export const sonioxSpeechInputModels = Object.freeze(["stt-rt-v5", "stt-rt-v6"] as const);

/**
 * Soniox's turn detection (https://soniox.com/speech-to-text/features/turn-detection):
 * - `endpointSensitivity`, -1.0 to 1.0: how readily a pause ends the turn; lower waits longer.
 * - `maxEndpointDelayMs`, 500 to 3000: the longest Soniox may wait after speech ends before it
 *   ends the turn.
 * - `endpointLatencyAdjustmentLevel`, 0 to 3: higher levels end turns sooner and may split
 *   speech into more turns.
 */
const settingFields = {
  model: z.enum(sonioxSpeechInputModels),
  endpointSensitivity: z.number().min(-1).max(1),
  maxEndpointDelayMs: z.number().int().min(500).max(3_000),
  endpointLatencyAdjustmentLevel: z.number().int().min(0).max(3),
};
const provider = z.literal("soniox");

/** The Soniox speech-input settings a Start may give, beside `provider`; each may be left out. */
export const sonioxSpeechInputGivenSettings = z
  .strictObject(settingFields)
  .partial()
  .extend({ provider });

/**
 * The Soniox speech-input settings a session uses, every one decided. The two turn-detection
 * settings Cascade never sent before are null unless a start gave them: they are then not sent,
 * and Soniox's own defaults (2000 ms and level 0) apply.
 */
export const sonioxSpeechInputSettings = z.strictObject({
  provider,
  ...settingFields,
  maxEndpointDelayMs: settingFields.maxEndpointDelayMs.nullable(),
  endpointLatencyAdjustmentLevel: settingFields.endpointLatencyAdjustmentLevel.nullable(),
});
export type SonioxSpeechInputSettings = z.output<typeof sonioxSpeechInputSettings>;

/** The recognition fields the adapter sends before the media profile's audio format. */
type SonioxRecognitionConfiguration = {
  model: string;
  language_hints: readonly string[];
  enable_endpoint_detection: true;
  endpoint_sensitivity: number;
  max_endpoint_delay_ms?: number;
  endpoint_latency_adjustment_level?: number;
};

/**
 * A recognition stream's configuration under the session's speech-input settings. English and
 * endpoint detection are fixed. A turn-detection setting the session leaves null is not sent,
 * so Soniox's own default applies.
 */
export function sonioxRecognitionConfiguration(
  settings: SonioxSpeechInputSettings,
): SonioxRecognitionConfiguration {
  const configuration: SonioxRecognitionConfiguration = {
    model: settings.model,
    language_hints: ["en"],
    enable_endpoint_detection: true,
    endpoint_sensitivity: settings.endpointSensitivity,
  };
  if (settings.maxEndpointDelayMs !== null)
    configuration.max_endpoint_delay_ms = settings.maxEndpointDelayMs;
  if (settings.endpointLatencyAdjustmentLevel !== null)
    configuration.endpoint_latency_adjustment_level = settings.endpointLatencyAdjustmentLevel;
  return configuration;
}

/** Soniox requires a message at least every 20 seconds without audio; 5 is its common choice. */
export const sonioxKeepaliveIntervalMs = 5_000;

/** One message of a recognition stream, as the adapter uses it. */
type RecognitionMessage =
  | Readonly<{ kind: "tokens"; final: readonly string[]; finished: boolean }>
  | Readonly<{ kind: "error"; type: string }>;

/** Soniox marks an endpoint and a finalization with these final tokens. */
const endToken = "<end>";
const finalizedToken = "<fin>";

/**
 * Soniox's STT WebSocket messages, which evolve independently of Runtime. The adapter
 * reads final tokens in order, the stream's end and errors; non-final tokens are provisional
 * and carry no text into a turn.
 */
export const decodeRecognitionMessage = boundary.tolerant({
  source: "Soniox real-time STT WebSocket message",
  variants: [
    {
      schema: jsonText(z.object({ error_type: z.string().min(1) })),
      convert: (message): RecognitionMessage => ({ kind: "error", type: message.error_type }),
    },
    {
      schema: jsonText(
        z.object({
          tokens: z.array(z.object({ text: z.string(), is_final: z.boolean() })),
          finished: z.boolean().optional(),
        }),
      ),
      convert: (message): RecognitionMessage => ({
        kind: "tokens",
        final: message.tokens.filter((token) => token.is_final).map((token) => token.text),
        finished: message.finished === true,
      }),
    },
  ],
  otherwise: failure("soniox_message_undecodable"),
});

/**
 * Soniox real-time STT as Cascade's speech input: today's provider, with its turn detection
 * slightly less likely to end a turn than Soniox's default 0 (user decision on #829,
 * 2026-10-30): at 0, a short pause between two sentences ended the turn before the second was
 * heard. It needs the Soniox API key, and reports the participant audio its recognition model
 * was sent, naming the model of the session's settings.
 */
export const sonioxSpeechInputProvider = Object.freeze({
  provider: "soniox",
  defaults: Object.freeze({
    provider: "soniox",
    model: "stt-rt-v5",
    endpointSensitivity: -0.3,
    maxEndpointDelayMs: null,
    endpointLatencyAdjustmentLevel: null,
  }),
  credentials: ["SONIOX_API_KEY"],
  usage: Object.freeze({ provider: "soniox" }),
  adapter: (options, settings) => sonioxSpeechInput(options, settings),
} satisfies CascadeProviderDeclaration<SonioxSpeechInputSettings, CascadeSpeechInput>);

function sonioxSpeechInput(
  options: CascadeAdapterOptions,
  settings: SonioxSpeechInputSettings,
): Layer.Layer<CascadeSpeechInput> {
  const connect = Effect.tryPromise({
    try: (signal) =>
      options.transport(sonioxSpeechInputUrl, {
        headers: { Authorization: `Bearer ${options.apiKey}`, Upgrade: "websocket" },
        signal,
      }),
    catch: () => new SpeechInputFailed({ code: "soniox_transport_failed" }),
  }).pipe(
    Effect.flatMap((response) => {
      const socket = response.webSocket;
      if (socket !== null) return Effect.succeed(socket);
      // A refused upgrade answers over HTTP; its body is not read.
      return Effect.promise(
        () => response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
      ).pipe(
        Effect.andThen(
          Effect.fail(new SpeechInputFailed({ code: `soniox_http_${String(response.status)}` })),
        ),
      );
    }),
    // A connection still not open at its limit is abandoned: its request is aborted.
    Effect.timeoutOrElse({
      duration: providerConnectionTimeLimit,
      orElse: () => Effect.fail(new SpeechInputFailed({ code: "soniox_connection_timeout" })),
    }),
  );
  return Layer.effect(
    CascadeSpeechInput,
    Effect.sync(() => {
      return CascadeSpeechInput.of({
        usage: { ...sonioxSpeechInputProvider.usage, model: settings.model },
        open: Effect.gen(function* () {
          const events = yield* Queue.unbounded<SpeechInputEvent, SpeechInputFailed | Cause.Done>();
          const finalized = yield* Deferred.make<void, SpeechInputFailed>();
          let released = false;
          let settled = false;
          let lastSentAt = yield* Clock.currentTimeMillis;
          const fail = (code: string) => {
            if (settled || released) return;
            settled = true;
            const error = new SpeechInputFailed({ code });
            Queue.failCauseUnsafe(events, Cause.fail(error));
            Deferred.doneUnsafe(finalized, Effect.fail(error));
          };
          const socket = yield* Effect.acquireRelease(
            connect.pipe(
              Effect.tap((socket) =>
                Effect.try({
                  try: () => socket.accept(),
                  catch: () => new SpeechInputFailed({ code: "soniox_upgrade_failed" }),
                }),
              ),
            ),
            (socket) =>
              Effect.sync(() => {
                released = true;
                try {
                  // An empty text frame ends the stream; nothing after it is read.
                  socket.send("");
                } catch {
                  /* Closing the connection still ends the stream. */
                }
                try {
                  socket.close(1000, "recognition_released");
                } catch {
                  /* An already-closed connection needs no release. */
                }
                Queue.endUnsafe(events);
              }),
          );
          const send = (data: string | Uint8Array) =>
            Effect.suspend(() =>
              settled
                ? Effect.fail(new SpeechInputFailed({ code: "soniox_closed" }))
                : Effect.try({
                    try: () => socket.send(data),
                    catch: () => {
                      fail("soniox_send_failed");
                      return new SpeechInputFailed({ code: "soniox_send_failed" });
                    },
                  }),
            ).pipe(
              Effect.andThen(Clock.currentTimeMillis),
              Effect.map((now) => {
                lastSentAt = now;
              }),
            );
          socket.addEventListener("message", (event) => {
            if (settled || released) return;
            const decoded = decodeRecognitionMessage(event.data);
            if (!decoded.ok) return fail(decoded.error.code);
            const message = decoded.value;
            if (message.kind === "error") return fail(`soniox_${message.type}`);
            let text = "";
            const flush = () => {
              if (text.length > 0)
                Queue.offerUnsafe(events, { kind: "transcript", text, final: true });
              text = "";
            };
            for (const token of message.final) {
              if (token === endToken) {
                flush();
                Queue.offerUnsafe(events, { kind: "turn_ended" });
              } else if (token === finalizedToken) {
                flush();
                Queue.offerUnsafe(events, { kind: "finalized" });
                Deferred.doneUnsafe(finalized, Effect.void);
              } else text += token;
            }
            flush();
            if (message.finished) {
              settled = true;
              Queue.endUnsafe(events);
            }
          });
          socket.addEventListener("close", () => fail("soniox_connection_closed"));
          socket.addEventListener("error", () => fail("soniox_connection_failed"));
          yield* send(
            JSON.stringify({
              ...sonioxRecognitionConfiguration(settings),
              audio_format: cascadeMediaInputFormat.encoding,
              sample_rate: cascadeMediaInputFormat.sampleRate,
              num_channels: cascadeMediaInputFormat.channels,
            }),
          );
          // Without forwarded audio, keepalives hold the stream open for as long as the
          // participant takes; the interviewing deadline, not the provider, bounds the wait.
          yield* Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (now - lastSentAt >= sonioxKeepaliveIntervalMs)
              yield* send(JSON.stringify({ type: "keepalive" }));
          }).pipe(
            Effect.repeat(Schedule.spaced(Duration.seconds(1))),
            // A failed keepalive already failed the stream with its whole cause; the loop stops.
            Effect.catchTag("SpeechInputFailed", () => Effect.void),
            Effect.forkScoped,
          );
          return {
            ingest: (audio: Uint8Array) => send(audio),
            events: Stream.fromQueue(events),
            finalize: send(JSON.stringify({ type: "finalize" })).pipe(
              Effect.andThen(Deferred.await(finalized)),
            ),
          };
        }),
      });
    }),
  );
}
