import { Cause, Deferred, Effect, Layer, Queue, Stream } from "effect";
import { z } from "zod";
import { boundary, failure } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import { CascadeSpeechOutput, SpeechOutputFailed } from "./adapters.ts";
import type { CascadeAdapterOptions, CascadeProviderDeclaration } from "./providerDeclaration.ts";
import { jsonText } from "./providerJson.ts";
import {
  providerConnectionTimeLimit,
  speechOutputFirstAudioTimeLimit,
} from "./providerTimeLimits.ts";

/**
 * The Gradium TTS adapter of the Cascade speech-output contract. Each output with text is one
 * connection, opened at its first text: `setup` names the voice and the profile's 24 kHz PCM,
 * and text is sent once Gradium answers `ready`. Gradium joins successive text messages with a
 * space, so the adapter sends only whole words: text up to the last whitespace received, and
 * the rest once the text has ended, followed by `end_of_stream`. Audio arrives until Gradium's
 * own `end_of_stream`. Gradium has no cancel message: interrupting synthesis closes the
 * connection. The global host serves it (user, 2026-11-05).
 */
export const gradiumSpeechOutputUrl = "https://api.gradium.ai/api/speech/tts";

/** Gradium's TTS model; `default` is the only one its documentation names. */
export const gradiumSpeechOutputModels = Object.freeze(["default"] as const);

/**
 * The Gradium catalog voices a Cascade start may choose, by name. The user's shortlist
 * (2026-11-06) is the first voice of the spike's picker page; the first entry is the default.
 */
export const gradiumSpeechOutputVoices = Object.freeze(["Everly"] as const);

/** The `voice_id` Gradium reads for each voice. */
const gradiumVoiceIds = Object.freeze({
  Everly: "vjFyp2BcCyTlUmYb",
} satisfies Record<(typeof gradiumSpeechOutputVoices)[number], string>);

/** Gradium's name of the profile's output format: 16-bit mono PCM at 24 kHz. */
const outputFormat = "pcm_24000";

const settingFields = {
  model: z.enum(gradiumSpeechOutputModels),
  voice: z.enum(gradiumSpeechOutputVoices),
};
const provider = z.literal("gradium");

/** The Gradium speech-output settings a Start may give, beside `provider`; each may be left out. */
export const gradiumSpeechOutputGivenSettings = z
  .strictObject(settingFields)
  .partial()
  .extend({ provider });

/** The Gradium speech-output settings a session uses, every one decided. */
export const gradiumSpeechOutputSettings = z.strictObject({ provider, ...settingFields });
export type GradiumSpeechOutputSettings = z.output<typeof gradiumSpeechOutputSettings>;

/**
 * Gradium TTS as Cascade's speech output. It needs the Gradium API key; Gradium reports no
 * usage, so Cascade measures the text it was given and the audio it made, naming the model of
 * the session's settings.
 */
export const gradiumSpeechOutputProvider = Object.freeze({
  provider: "gradium",
  defaults: Object.freeze({ provider: "gradium", model: "default", voice: "Everly" }),
  credentials: ["GRADIUM_API_KEY"],
  usage: Object.freeze({ provider: "gradium" }),
  adapter: (options, settings) => gradiumSpeechOutput(options, settings),
} satisfies CascadeProviderDeclaration<GradiumSpeechOutputSettings, CascadeSpeechOutput>);

/** One message the adapter sends on a synthesis connection. */
type SynthesisRequest =
  | Readonly<{ type: "setup"; model_name: string; voice_id: string; output_format: string }>
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{ type: "end_of_stream" }>;

/** One message of a synthesis connection, as the adapter uses it. */
type SynthesisMessage =
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "audio"; audio: Uint8Array }>
  | Readonly<{ kind: "end" }>
  | Readonly<{ kind: "error"; code: number | null }>
  | Readonly<{ kind: "ignored" }>;

/** The message types the adapter reads; one of these in a shape it cannot use is undecodable. */
const readTypes: readonly string[] = ["ready", "audio", "end_of_stream", "error"];

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Gradium's TTS WebSocket messages, which evolve independently of Runtime. The adapter reads
 * `ready`, base64 `audio`, the server's `end_of_stream` and `error` with its numeric code. Every
 * other type, such as the `text` timestamps of what was spoken, is ignored.
 */
export const decodeGradiumSynthesisMessage = boundary.tolerant({
  source: "Gradium TTS WebSocket message",
  variants: [
    {
      schema: jsonText(
        z.union([
          z
            .object({ type: z.literal("ready") })
            .transform((): SynthesisMessage => ({ kind: "ready" })),
          z.object({ type: z.literal("audio"), audio: z.base64() }).transform(
            ({ audio }): SynthesisMessage => ({
              kind: "audio",
              audio: decodeBase64(audio),
            }),
          ),
          z
            .object({ type: z.literal("end_of_stream") })
            .transform((): SynthesisMessage => ({ kind: "end" })),
          z
            .object({ type: z.literal("error"), code: z.number().int().nullish() })
            .transform(({ code }): SynthesisMessage => ({ kind: "error", code: code ?? null })),
          z
            .object({ type: z.string() })
            .refine(({ type }) => !readTypes.includes(type))
            .transform((): SynthesisMessage => ({ kind: "ignored" })),
        ]),
      ),
      convert: (message) => message,
    },
  ],
  otherwise: failure("gradium_message_undecodable"),
});

/** Where the text received so far may be cut: just after its last whitespace, or 0. */
function wholeWordsEnd(text: string): number {
  const match = /\s(?=\S*$)/.exec(text);
  return match === null ? 0 : match.index + 1;
}

function gradiumSpeechOutput(
  options: CascadeAdapterOptions,
  { model, voice }: GradiumSpeechOutputSettings,
): Layer.Layer<CascadeSpeechOutput> {
  const upgrade = Effect.tryPromise({
    try: (signal) =>
      options.transport(gradiumSpeechOutputUrl, {
        headers: { "x-api-key": options.apiKey, Upgrade: "websocket" },
        signal,
      }),
    catch: () => new SpeechOutputFailed({ code: "gradium_transport_failed" }),
  }).pipe(
    Effect.flatMap((response) => {
      const socket = response.webSocket;
      if (socket !== null) return Effect.succeed(socket);
      // A refused upgrade answers over HTTP; its body is not read.
      return Effect.promise(
        () => response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
      ).pipe(
        Effect.andThen(
          Effect.fail(new SpeechOutputFailed({ code: `gradium_http_${String(response.status)}` })),
        ),
      );
    }),
    Effect.tap((socket) =>
      Effect.try({
        try: () => socket.accept(),
        catch: () => new SpeechOutputFailed({ code: "gradium_upgrade_failed" }),
      }),
    ),
  );
  return Layer.effect(
    CascadeSpeechOutput,
    Effect.sync(() =>
      CascadeSpeechOutput.of({
        usage: { ...gradiumSpeechOutputProvider.usage, model },
        synthesize: (text) =>
          Stream.callback<Uint8Array, SpeechOutputFailed>((queue) =>
            Effect.gen(function* () {
              /** The output received its first text: its connection opens and audio is due. */
              const textReceived = yield* Deferred.make<void>();
              /** Gradium answered `ready`: text may be sent. */
              const ready = yield* Deferred.make<void>();
              let started = false;
              let socket: WebSocket | null = null;
              let isReady = false;
              // Text received and not yet sent: what follows the last whitespace sent.
              let pending = "";
              let textEnded = false;
              let endSent = false;
              let audioStarted = false;
              let settled = false;
              // PCM samples are two bytes; a chunk boundary can split one.
              let carry: Uint8Array | null = null;
              const fail = (code: string) => {
                if (settled) return;
                settled = true;
                Queue.failCauseUnsafe(queue, Cause.fail(new SpeechOutputFailed({ code })));
              };
              const send = (open: WebSocket, message: SynthesisRequest) => {
                try {
                  open.send(JSON.stringify(message));
                  return true;
                } catch {
                  fail("gradium_send_failed");
                  return false;
                }
              };
              /** Sends the whole words received so far, and the rest once the text has ended. */
              const sendText = () => {
                if (socket === null || !isReady || settled || endSent) return;
                const end = textEnded ? pending.length : wholeWordsEnd(pending);
                const words = pending.slice(0, end).trim();
                pending = pending.slice(end);
                if (words.length > 0 && !send(socket, { type: "text", text: words })) return;
                if (!textEnded) return;
                endSent = true;
                send(socket, { type: "end_of_stream" });
              };
              const onMessage = (event: MessageEvent) => {
                if (settled) return;
                const decoded = decodeGradiumSynthesisMessage(event.data);
                if (!decoded.ok) return fail(decoded.error.code);
                const message = decoded.value;
                switch (message.kind) {
                  case "ignored":
                    return;
                  case "error":
                    return fail(
                      message.code === null
                        ? "gradium_error"
                        : `gradium_error_${String(message.code)}`,
                    );
                  case "ready":
                    isReady = true;
                    Deferred.doneUnsafe(ready, Effect.void);
                    return;
                  case "end": {
                    if (!endSent) return fail("gradium_stream_ended");
                    if (carry !== null) return fail("gradium_audio_incomplete");
                    settled = true;
                    Queue.endUnsafe(queue);
                    return;
                  }
                  case "audio": {
                    if (!isReady) return fail("gradium_audio_before_ready");
                    audioStarted = true;
                    let audio = message.audio;
                    if (carry !== null) {
                      const joined = new Uint8Array(carry.length + audio.length);
                      joined.set(carry);
                      joined.set(audio, carry.length);
                      audio = joined;
                      carry = null;
                    }
                    if (audio.length % 2 === 1) {
                      carry = audio.slice(-1);
                      audio = audio.subarray(0, -1);
                    }
                    if (audio.length > 0) Queue.offerUnsafe(queue, audio);
                    return;
                  }
                }
              };
              /**
               * The output's connection, opened once it has text: upgraded, set up and `ready`
               * within the connection limit. Released, it closes, which stops any synthesis.
               */
              const connect = Effect.gen(function* () {
                const open = yield* Effect.acquireRelease(
                  upgrade,
                  (open) =>
                    Effect.sync(() => {
                      // Nothing Gradium sends after the release is delivered.
                      settled = true;
                      try {
                        open.close(1000, "synthesis_released");
                      } catch {
                        /* An already-closed connection needs no release. */
                      }
                    }),
                  { interruptible: true },
                );
                socket = open;
                open.addEventListener("message", onMessage);
                open.addEventListener("close", () => fail("gradium_connection_closed"));
                open.addEventListener("error", () => fail("gradium_connection_failed"));
                if (
                  !send(open, {
                    type: "setup",
                    model_name: model,
                    voice_id: gradiumVoiceIds[voice],
                    output_format: outputFormat,
                  })
                )
                  return;
                yield* Deferred.await(ready);
              }).pipe(
                // A connection not ready at its limit is abandoned: its request is aborted.
                Effect.timeoutOrElse({
                  duration: providerConnectionTimeLimit,
                  orElse: () =>
                    Effect.fail(new SpeechOutputFailed({ code: "gradium_connection_timeout" })),
                }),
                Effect.andThen(Effect.sync(sendText)),
              );
              yield* text.pipe(
                Stream.runForEach((piece) =>
                  Effect.sync(() => {
                    if (settled) return;
                    pending += piece;
                    if (!started && pending.trim().length > 0) {
                      started = true;
                      Deferred.doneUnsafe(textReceived, Effect.void);
                    }
                    sendText();
                  }),
                ),
                Effect.andThen(
                  Effect.sync(() => {
                    if (settled) return;
                    textEnded = true;
                    // An output without text synthesizes nothing and opens no connection.
                    if (!started) {
                      settled = true;
                      Queue.endUnsafe(queue);
                      return;
                    }
                    sendText();
                  }),
                ),
                Effect.forkScoped,
              );
              yield* Deferred.await(textReceived).pipe(
                Effect.andThen(connect),
                // The connection runs apart from the stream: its failure must fail the stream.
                Effect.catch(({ code }) => Effect.sync(() => fail(code))),
                Effect.forkScoped,
              );
              // Synthesis that has produced no audio within its limit of receiving text fails.
              yield* Deferred.await(textReceived).pipe(
                Effect.andThen(Effect.sleep(speechOutputFirstAudioTimeLimit)),
                Effect.andThen(
                  Effect.sync(() => {
                    if (!audioStarted) fail("gradium_audio_timeout");
                  }),
                ),
                Effect.forkScoped,
              );
            }),
          ),
      }),
    ),
  );
}
