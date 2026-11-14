import { describe, expect, it } from "vitest";
import { Effect, Exit, Stream } from "effect";
import { CascadeSpeechInput, type SpeechInputEvent } from "../adapters.ts";
import { cascadeStandIns } from "./standIns.ts";

/** Input-format PCM: a 220 Hz tone for speech, zeros for silence, both 16 kHz mono. */
function pcm(seconds: number, speech: boolean): Uint8Array {
  const samples = Math.round(seconds * 16_000);
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  if (speech)
    for (let index = 0; index < samples; index += 1)
      view.setInt16(
        index * 2,
        Math.round(Math.sin((index * 2 * Math.PI * 220) / 16_000) * 8_000),
        true,
      );
  return bytes;
}

/** Feeds the audio in 64 ms chunks, as the Lab page sends it, and collects the events. */
function recognize(audio: readonly Uint8Array[], finalize = false) {
  const providers = cascadeStandIns({
    responses: [],
    utterances: [
      { text: "The talks were clear and the room was quiet.", durationSeconds: 2.03 },
      { text: "The speakers explained their ideas clearly.", durationSeconds: 2.29 },
      {
        text: "The room was quiet. The talks were clear.",
        durationSeconds: 6,
        segments: [
          { text: "The room was quiet.", startSeconds: 0, endSeconds: 3 },
          { text: "The talks were clear.", startSeconds: 3, endSeconds: 6 },
        ],
      },
    ],
  });
  return Effect.gen(function* () {
    const speech = yield* CascadeSpeechInput;
    const stream = yield* speech.open;
    for (const part of audio)
      for (let offset = 0; offset < part.length; offset += 2_048)
        yield* stream.ingest(part.subarray(offset, offset + 2_048));
    if (finalize) yield* stream.finalize;
    const events: SpeechInputEvent[] = [];
    yield* stream.events.pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.timeout("50 millis"),
      Effect.ignore,
    );
    return events;
  }).pipe(Effect.scoped, Effect.provide(providers), Effect.runPromiseExit);
}

describe("Cascade speech-input stand-in", () => {
  it("reports the known utterance whose length matches speech followed by silence", async () => {
    expect(await recognize([pcm(0.5, false), pcm(2.27, true), pcm(0.8, false)])).toEqual(
      Exit.succeed([
        { kind: "transcript", text: "The speakers explained their ideas clearly.", final: true },
        { kind: "turn_ended" },
      ]),
    );
  });

  it("ends no turn in silence, or while the trailing silence is still short", async () => {
    expect(await recognize([pcm(30, false)])).toEqual(Exit.succeed([]));
    expect(await recognize([pcm(1.98, true), pcm(0.5, false)])).toEqual(Exit.succeed([]));
  });

  it("settles speech without its trailing silence at finalization, then acknowledges", async () => {
    expect(await recognize([pcm(0.5, false), pcm(2.03, true)], true)).toEqual(
      Exit.succeed([
        {
          kind: "transcript",
          text: "The talks were clear and the room was quiet.",
          final: true,
        },
        { kind: "finalized" },
      ]),
    );
    expect(await recognize([pcm(3, false)], true)).toEqual(Exit.succeed([{ kind: "finalized" }]));
  });

  it("settles the spoken prefix of a longer known utterance when Stop cuts it short", async () => {
    // 4.5 s of a 6 s answer: its first phrase, and the words of half its second.
    expect(await recognize([pcm(0.5, false), pcm(4.5, true)], true)).toEqual(
      Exit.succeed([
        { kind: "transcript", text: "The room was quiet. The talks", final: true },
        { kind: "finalized" },
      ]),
    );
  });

  it("fails recognition of speech that matches no known utterance", async () => {
    const exit = await recognize([pcm(1.2, true), pcm(0.8, false)]);
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain(
      "stand_in_speech_unrecognized",
    );
  });
});
