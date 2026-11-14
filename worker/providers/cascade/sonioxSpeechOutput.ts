import { Cause, Deferred, Effect, Layer, Queue, Stream } from "effect";
import { z } from "zod";
import { boundary, failure } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import { cascadeMediaOutputFormat } from "../../shared/contracts/cascadeMedia.ts";
import { CascadeSpeechOutput, SpeechOutputFailed } from "./adapters.ts";
import type { CascadeAdapterOptions, CascadeProviderDeclaration } from "./providerDeclaration.ts";
import { jsonText } from "./providerJson.ts";
import {
  providerConnectionTimeLimit,
  speechOutputFirstAudioTimeLimit,
} from "./providerTimeLimits.ts";
import { sonioxSpeechOutputVoices } from "./sonioxVoices.ts";

/**
 * The Soniox real-time TTS adapter of the Cascade speech-output contract. Each output is one
 * synthesis stream on its own connection: the stream starts with the output's first text,
 * receives each text fragment as the model produced it, and ends with `text_end` once the
 * text is complete. Audio arrives in the profile's output format until `audio_end`, and the
 * stream completes only at `terminated`. Interrupting synthesis cancels the stream.
 */
export const sonioxSpeechOutputUrl = "https://tts-rt.soniox.com/tts-websocket";

/** Soniox real-time TTS models, as Soniox's catalog listed them on 2026-11-04. */
export const sonioxSpeechOutputModels = Object.freeze(["tts-rt-v2"] as const);

const settingFields = {
  model: z.enum(sonioxSpeechOutputModels),
  voice: z.enum(sonioxSpeechOutputVoices),
};
const provider = z.literal("soniox");

/** The Soniox speech-output settings a Start may give, beside `provider`; each may be left out. */
export const sonioxSpeechOutputGivenSettings = z
  .strictObject(settingFields)
  .partial()
  .extend({ provider });

/** The Soniox speech-output settings a session uses, every one decided. */
export const sonioxSpeechOutputSettings = z.strictObject({ provider, ...settingFields });
export type SonioxSpeechOutputSettings = z.output<typeof sonioxSpeechOutputSettings>;

/** The synthesis model and voice of the session's settings; English is fixed. */
type SonioxSpeechConfiguration = Readonly<{ model: string; language: "en"; voice: string }>;

/**
 * Soniox real-time TTS as Cascade's speech output: today's provider and voice. It needs the
 * Soniox API key, and reports the text its synthesis model was given and the audio it made,
 * naming the model of the session's settings.
 */
export const sonioxSpeechOutputProvider = Object.freeze({
  provider: "soniox",
  defaults: Object.freeze({ provider: "soniox", model: "tts-rt-v2", voice: "Adrian" }),
  credentials: ["SONIOX_API_KEY"],
  usage: Object.freeze({ provider: "soniox" }),
  adapter: (options, settings) => sonioxSpeechOutput(options, settings),
} satisfies CascadeProviderDeclaration<SonioxSpeechOutputSettings, CascadeSpeechOutput>);

/** One message the adapter sends on a synthesis stream. */
type SynthesisRequest =
  | Readonly<
      {
        stream_id: string;
        audio_format: string;
        sample_rate: number;
      } & SonioxSpeechConfiguration
    >
  | Readonly<{ stream_id: string; text: string; text_end: boolean }>;

/** One message of a synthesis stream, as the adapter uses it. */
type SynthesisMessage =
  | Readonly<{ kind: "audio"; streamId: string; audio: Uint8Array; end: boolean }>
  | Readonly<{ kind: "terminated"; streamId: string }>
  | Readonly<{ kind: "error"; streamId: string | null; type: string }>;

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Soniox's TTS WebSocket messages, which evolve independently of Runtime. The adapter
 * reads audio with its end flag, stream termination and errors; it requests no timestamps.
 */
export const decodeSynthesisMessage = boundary.tolerant({
  source: "Soniox real-time TTS WebSocket message",
  variants: [
    {
      schema: jsonText(
        z.object({
          stream_id: z.string().nullish(),
          error_type: z.string().min(1),
        }),
      ),
      convert: (message): SynthesisMessage => ({
        kind: "error",
        streamId: message.stream_id ?? null,
        type: message.error_type,
      }),
    },
    {
      schema: jsonText(
        z.object({
          stream_id: z.string(),
          audio: z.base64(),
          audio_end: z.boolean().optional(),
        }),
      ),
      convert: (message): SynthesisMessage => ({
        kind: "audio",
        streamId: message.stream_id,
        audio: decodeBase64(message.audio),
        end: message.audio_end === true,
      }),
    },
    {
      schema: jsonText(z.object({ stream_id: z.string(), terminated: z.literal(true) })),
      convert: (message): SynthesisMessage => ({
        kind: "terminated",
        streamId: message.stream_id,
      }),
    },
  ],
  otherwise: failure("soniox_message_undecodable"),
});

function sonioxSpeechOutput(
  options: CascadeAdapterOptions,
  { model, voice }: SonioxSpeechOutputSettings,
): Layer.Layer<CascadeSpeechOutput> {
  const connect = Effect.tryPromise({
    try: (signal) =>
      options.transport(sonioxSpeechOutputUrl, {
        headers: { Authorization: `Bearer ${options.apiKey}`, Upgrade: "websocket" },
        signal,
      }),
    catch: () => new SpeechOutputFailed({ code: "soniox_transport_failed" }),
  }).pipe(
    Effect.flatMap((response) => {
      const socket = response.webSocket;
      if (socket !== null) return Effect.succeed(socket);
      // A refused upgrade answers over HTTP; its body is not read.
      return Effect.promise(
        () => response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
      ).pipe(
        Effect.andThen(
          Effect.fail(new SpeechOutputFailed({ code: `soniox_http_${String(response.status)}` })),
        ),
      );
    }),
    // A connection still not open at its limit is abandoned: its request is aborted.
    Effect.timeoutOrElse({
      duration: providerConnectionTimeLimit,
      orElse: () => Effect.fail(new SpeechOutputFailed({ code: "soniox_connection_timeout" })),
    }),
  );
  return Layer.effect(
    CascadeSpeechOutput,
    Effect.sync(() => {
      const configuration: SonioxSpeechConfiguration = { model, language: "en", voice };
      return CascadeSpeechOutput.of({
        usage: { ...sonioxSpeechOutputProvider.usage, model },
        synthesize: (text) =>
          Stream.callback<Uint8Array, SpeechOutputFailed>((queue) =>
            Effect.gen(function* () {
              const streamId = `cascade_synthesis_${crypto.randomUUID()}`;
              let started = false;
              /** The stream received its first text; its first audio is due within the limit. */
              const textReceived = yield* Deferred.make<void>();
              let audioStarted = false;
              let textEnded = false;
              let audioEnded = false;
              let settled = false;
              // PCM samples are two bytes; a chunk boundary can split one.
              let carry: Uint8Array | null = null;
              const fail = (code: string) => {
                if (settled) return;
                settled = true;
                Queue.failCauseUnsafe(queue, Cause.fail(new SpeechOutputFailed({ code })));
              };
              const socket = yield* Effect.acquireRelease(
                connect.pipe(
                  Effect.tap((socket) =>
                    Effect.try({
                      try: () => socket.accept(),
                      catch: () => new SpeechOutputFailed({ code: "soniox_upgrade_failed" }),
                    }),
                  ),
                ),
                (socket) =>
                  Effect.sync(() => {
                    // A stream that has not terminated is cancelled; no later audio is delivered.
                    const cancel = started && !settled;
                    settled = true;
                    try {
                      if (cancel)
                        socket.send(JSON.stringify({ stream_id: streamId, cancel: true }));
                    } catch {
                      /* Releasing the connection still ends the stream. */
                    }
                    try {
                      socket.close(1000, "synthesis_released");
                    } catch {
                      /* An already-closed connection needs no release. */
                    }
                  }),
              );
              const send = (message: SynthesisRequest) => {
                try {
                  socket.send(JSON.stringify(message));
                  return true;
                } catch {
                  fail("soniox_send_failed");
                  return false;
                }
              };
              socket.addEventListener("message", (event) => {
                if (settled) return;
                const decoded = decodeSynthesisMessage(event.data);
                if (!decoded.ok) return fail(decoded.error.code);
                const message = decoded.value;
                if (message.kind === "error") return fail(`soniox_${message.type}`);
                if (message.streamId !== streamId) return fail("soniox_stream_unknown");
                if (message.kind === "terminated") {
                  if (!textEnded || !audioEnded) return fail("soniox_stream_terminated");
                  if (carry !== null) return fail("soniox_audio_incomplete");
                  settled = true;
                  Queue.endUnsafe(queue);
                  return;
                }
                if (audioEnded) return fail("soniox_audio_after_end");
                audioStarted = true;
                audioEnded = message.end;
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
              });
              socket.addEventListener("close", () => fail("soniox_connection_closed"));
              socket.addEventListener("error", () => fail("soniox_connection_failed"));
              yield* text.pipe(
                Stream.runForEach((piece) =>
                  Effect.sync(() => {
                    if (settled || piece.length === 0) return;
                    if (!started) {
                      started = true;
                      Deferred.doneUnsafe(textReceived, Effect.void);
                      if (
                        !send({
                          stream_id: streamId,
                          ...configuration,
                          audio_format: cascadeMediaOutputFormat.encoding,
                          sample_rate: cascadeMediaOutputFormat.sampleRate,
                        })
                      )
                        return;
                    }
                    send({ stream_id: streamId, text: piece, text_end: false });
                  }),
                ),
                Effect.andThen(
                  Effect.sync(() => {
                    if (settled) return;
                    textEnded = true;
                    // An output without text synthesizes nothing and opens no stream.
                    if (!started) {
                      settled = true;
                      Queue.endUnsafe(queue);
                      return;
                    }
                    send({ stream_id: streamId, text: "", text_end: true });
                  }),
                ),
                Effect.forkScoped,
              );
              // Synthesis that has produced no audio within its limit of receiving text fails.
              yield* Deferred.await(textReceived).pipe(
                Effect.andThen(Effect.sleep(speechOutputFirstAudioTimeLimit)),
                Effect.andThen(
                  Effect.sync(() => {
                    if (!audioStarted) fail("soniox_audio_timeout");
                  }),
                ),
                Effect.forkScoped,
              );
            }).pipe(
              // The callback runs apart from the stream: a failed connection must fail the stream.
              Effect.catch((error) =>
                Effect.sync(() => Queue.failCauseUnsafe(queue, Cause.fail(error))),
              ),
            ),
          ),
      });
    }),
  );
}
