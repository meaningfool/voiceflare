import { type Cause, Duration, Effect, Exit, Layer, Queue, Stream } from "effect";
import {
  cascadeMediaInputFormat,
  cascadeMediaOutputFormat,
} from "../../../shared/contracts/cascadeMedia.ts";
import {
  CascadeLanguageModel,
  CascadeSpeechInput,
  CascadeSpeechOutput,
  LanguageModelFailed,
  SpeechInputFailed,
  SpeechOutputFailed,
  type SpeechInputEvent,
  type LanguageModelEvent,
  type LanguageModelRequest,
} from "../adapters.ts";
import { cascadeProviderDeclarations } from "../settings.ts";

/**
 * One scripted model response: its text pieces in order, then its completed tool calls. A
 * held response then stays open until its caller cancels it; a failing one then fails with
 * that code instead of completing.
 */
export type StandInResponse = Readonly<{
  text: readonly string[];
  toolCalls?: readonly Readonly<{ name: string; arguments: string }>[];
  hold?: true;
  failure?: string;
}>;

/** A script that answers each model request from what the request sends. */
export type StandInScript = (request: LanguageModelRequest) => StandInResponse;

export type CascadeStandInOptions = Readonly<{
  /**
   * The model's responses: a list, one per request in order, whose last one repeats, or a
   * script that answers each request. A request that finds no response fails with
   * `stand_in_response_unscripted`.
   */
  responses: readonly StandInResponse[] | StandInScript;
  /** The pause before each text piece the model streams. */
  textIntervalMs?: number;
  /** Audio per character of synthesized text. */
  audioPerCharacterMs?: number;
  /** The pause before each 100 ms audio frame; below 100 synthesis runs ahead of playback. */
  frameIntervalMs?: number;
  /** Observes each request as the language-model contract received it. */
  onRequest?: (request: LanguageModelRequest) => void;
  /** Observes each audio frame the speech-output stand-in synthesizes. */
  onAudio?: () => void;
  /** Observes each text piece the speech-output stand-in is given to synthesize. */
  onSynthesis?: (text: string) => void;
  /** Fails the synthesis given this text with this code once it delivered its first frame. */
  synthesisFailure?: Readonly<{ text: string; code: string }> | undefined;
  /** Observes each model response or synthesis its caller cancelled before it ended. */
  onCancel?: (work: "model" | "synthesis") => void;
  /** The utterances the speech-input stand-in recognizes, by their spoken length. */
  utterances?: readonly StandInUtterance[];
  /** The pause before speech input settles a finalization. */
  finalizeDelayMs?: number;
}>;

/**
 * One utterance the speech-input stand-in knows: a recorded clip's text and its length, and
 * optionally its phrases with their measured times. The stand-in reports the text of the known
 * utterance whose length matches the speech it heard; a finalization of speech that matches
 * none settles the spoken prefix of a longer one with phrases.
 */
export type StandInUtterance = Readonly<{
  text: string;
  durationSeconds: number;
  segments?: readonly Readonly<{ text: string; startSeconds: number; endSeconds: number }>[];
}>;

/**
 * The model the stand-ins report in their usage accounts. Each stand-in reports in the
 * vocabulary of the provider it stands in for, today's provider of its component, so a run on
 * them reports what the combination declares, naming this model.
 */
export const standInModel = "cascade-stand-in";

/** The provider of each component that the stand-ins stand in for: today's. */
const standsInFor = {
  speechInput: cascadeProviderDeclarations.speechInput[0].usage.provider,
  languageModel: cascadeProviderDeclarations.languageModel[0].usage.provider,
  speechOutput: cascadeProviderDeclarations.speechOutput[0].usage.provider,
};

const frameMs = 100;
const toneHz = 440;
const toneAmplitude = 0.2;

/**
 * Controlled stand-ins for the Cascade speech-input, language-model and speech-output
 * contracts. Their choices are scripted, so a run on them is deterministic and calls no
 * provider. Only local or test Runtime configuration selects them
 * (`RuntimeHostConfiguration.cascadeProviders`); a deployed Runtime never does, and Start
 * cannot choose them. They know nothing of any interview: the caller scripts the model's
 * responses and names the utterances speech input recognizes. They read no provider settings.
 */
export function cascadeStandIns(
  options: CascadeStandInOptions,
): Layer.Layer<CascadeSpeechInput | CascadeLanguageModel | CascadeSpeechOutput> {
  const responses = options.responses;
  const textIntervalMs = options.textIntervalMs ?? 50;
  const audioPerCharacterMs = options.audioPerCharacterMs ?? 45;
  const frameIntervalMs = options.frameIntervalMs ?? 50;
  // Scripted responses follow these stand-ins' requests, however often a session builds them.
  let requests = 0;
  const languageModel = Layer.sync(CascadeLanguageModel, () =>
    CascadeLanguageModel.of({
      usage: { provider: standsInFor.languageModel },
      respond: (request) =>
        Stream.suspend(() => {
          options.onRequest?.(structuredClone(request));
          const index = requests++;
          const response =
            typeof responses === "function"
              ? responses(request)
              : responses[Math.min(index, responses.length - 1)];
          if (response === undefined)
            return Stream.fail(new LanguageModelFailed({ code: "stand_in_response_unscripted" }));
          const events: LanguageModelEvent[] = [
            ...response.text.map((text): LanguageModelEvent => ({ kind: "text", text })),
            ...(response.toolCalls ?? []).map(
              (call, position): LanguageModelEvent => ({
                kind: "tool_call",
                callId: `call_stand_in_${String(index)}_${String(position)}`,
                name: call.name,
                arguments: call.arguments,
              }),
            ),
            // A scripted account: one input token per history turn, one output token per piece.
            {
              kind: "usage",
              model: standInModel,
              inputTokens: request.history.length + 1,
              outputTokens: response.text.length,
            },
          ];
          const ending =
            response.failure !== undefined
              ? Stream.fail(new LanguageModelFailed({ code: response.failure }))
              : response.hold === true
                ? Stream.never
                : Stream.empty;
          return Stream.fromIterable(events).pipe(
            Stream.mapEffect((event) =>
              Effect.as(Effect.sleep(Duration.millis(textIntervalMs)), event),
            ),
            Stream.concat(ending),
            Stream.onExit((exit) =>
              Exit.hasInterrupts(exit)
                ? Effect.sync(() => options.onCancel?.("model"))
                : Effect.void,
            ),
          );
        }),
    }),
  );
  const speechOutput = Layer.sync(CascadeSpeechOutput, () =>
    CascadeSpeechOutput.of({
      usage: { provider: standsInFor.speechOutput, model: standInModel },
      synthesize: (text) => {
        let phase = 0;
        let delivered = 0;
        let failing: string | null = null;
        return text.pipe(
          Stream.flatMap((piece) => {
            options.onSynthesis?.(piece);
            if (piece === options.synthesisFailure?.text) failing = options.synthesisFailure.code;
            const frames = Math.max(1, Math.ceil((piece.length * audioPerCharacterMs) / frameMs));
            return Stream.range(1, frames).pipe(
              Stream.mapEffect(() =>
                Effect.suspend(() => {
                  if (failing !== null && delivered > 0)
                    return Effect.fail(new SpeechOutputFailed({ code: failing }));
                  delivered += 1;
                  const frame = toneFrame(phase);
                  phase = frame.phase;
                  options.onAudio?.();
                  return Effect.succeed(frame.pcm);
                }).pipe(Effect.delay(Duration.millis(frameIntervalMs))),
              ),
            );
          }),
          Stream.onExit((exit) =>
            Exit.hasInterrupts(exit)
              ? Effect.sync(() => options.onCancel?.("synthesis"))
              : Effect.void,
          ),
        );
      },
    }),
  );
  const utterances = options.utterances ?? [];
  const speechInput = Layer.succeed(
    CascadeSpeechInput,
    CascadeSpeechInput.of({
      usage: { provider: standsInFor.speechInput, model: standInModel },
      open: Effect.gen(function* () {
        const events = yield* Queue.unbounded<SpeechInputEvent, SpeechInputFailed | Cause.Done>();
        const detector = new StandInSpeechDetector(utterances);
        const report = (heard: HeardUtterance | null, settled: SpeechInputEvent) => {
          if (heard?.text === null)
            return Effect.fail(new SpeechInputFailed({ code: "stand_in_speech_unrecognized" }));
          if (heard !== null)
            Queue.offerUnsafe(events, { kind: "transcript", text: heard.text, final: true });
          if (heard !== null || settled.kind === "finalized") Queue.offerUnsafe(events, settled);
          return Effect.void;
        };
        yield* Effect.addFinalizer(() => Effect.sync(() => Queue.endUnsafe(events)));
        return {
          ingest: (audio: Uint8Array) =>
            Effect.suspend(() => report(detector.ingest(audio), { kind: "turn_ended" })),
          events: Stream.fromQueue(events),
          // Speech without its trailing silence settles as heard so far, then acknowledges.
          finalize: Effect.suspend(() => report(detector.settle(true), { kind: "finalized" })).pipe(
            Effect.delay(Duration.millis(options.finalizeDelayMs ?? 0)),
          ),
        };
      }),
    }),
  );
  return Layer.mergeAll(speechInput, languageModel, speechOutput);
}

/** Speech the stand-in heard, with its known text, or null when no known utterance matches. */
type HeardUtterance = Readonly<{ text: string | null }>;

const inputFrameSamples = cascadeMediaInputFormat.sampleRate / 100;
/** A 10 ms frame is speech above this RMS level; the recorded clips' pauses stay below it. */
const speechLevel = 0.01;
/** This much silence after speech ends the turn: longer than any pause inside a clip. */
const endSilenceSamples = (cascadeMediaInputFormat.sampleRate * 700) / 1000;
/** The largest difference between heard speech and a known utterance's length. */
const lengthToleranceSeconds = 0.14;

/**
 * Detects speech followed by silence in the profile's input audio, measured in samples, so its
 * turn ends depend on the audio alone and not on when chunks arrive.
 */
class StandInSpeechDetector {
  readonly #utterances: readonly StandInUtterance[];
  #carry = new Uint8Array(0);
  #sample = 0;
  #speechStart: number | null = null;
  #speechEnd = 0;

  constructor(utterances: readonly StandInUtterance[]) {
    this.#utterances = utterances;
  }

  ingest(audio: Uint8Array): HeardUtterance | null {
    const bytes = new Uint8Array(this.#carry.length + audio.length);
    bytes.set(this.#carry);
    bytes.set(audio, this.#carry.length);
    const frameBytes = inputFrameSamples * 2;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    let heard: HeardUtterance | null = null;
    for (; offset + frameBytes <= bytes.length; offset += frameBytes) {
      let energy = 0;
      for (let index = 0; index < inputFrameSamples; index += 1) {
        const value = view.getInt16(offset + index * 2, true) / 0x8000;
        energy += value * value;
      }
      this.#sample += inputFrameSamples;
      if (Math.sqrt(energy / inputFrameSamples) > speechLevel) {
        this.#speechStart ??= this.#sample - inputFrameSamples;
        this.#speechEnd = this.#sample;
      } else if (this.#speechStart !== null && this.#sample - this.#speechEnd >= endSilenceSamples)
        heard ??= this.settle();
    }
    this.#carry = bytes.slice(offset);
    return heard;
  }

  /**
   * Ends the current speech, if any, as one utterance. A finalization (`cut`) of speech that
   * matches no known length was cut short: it settles the spoken prefix of the shortest known
   * utterance with phrases that is longer than the speech heard.
   */
  settle(cut = false): HeardUtterance | null {
    const start = this.#speechStart;
    if (start === null) return null;
    this.#speechStart = null;
    const seconds = (this.#speechEnd - start) / cascadeMediaInputFormat.sampleRate;
    let match: StandInUtterance | null = null;
    for (const utterance of this.#utterances)
      if (
        Math.abs(utterance.durationSeconds - seconds) <= lengthToleranceSeconds &&
        (match === null ||
          Math.abs(utterance.durationSeconds - seconds) < Math.abs(match.durationSeconds - seconds))
      )
        match = utterance;
    if (match !== null || !cut) return { text: match?.text ?? null };
    let longer: StandInUtterance | null = null;
    for (const utterance of this.#utterances)
      if (
        utterance.segments !== undefined &&
        utterance.segments.length > 0 &&
        utterance.durationSeconds > seconds &&
        (longer === null || utterance.durationSeconds < longer.durationSeconds)
      )
        longer = utterance;
    return { text: longer?.segments === undefined ? null : spokenPrefix(longer.segments, seconds) };
  }
}

/**
 * The text spoken in the first `seconds` of a recording: its whole phrases, then the words of
 * the phrase in progress in proportion to its elapsed time.
 */
function spokenPrefix(segments: NonNullable<StandInUtterance["segments"]>, seconds: number) {
  const parts: string[] = [];
  for (const segment of segments) {
    if (seconds >= segment.endSeconds) {
      parts.push(segment.text);
      continue;
    }
    if (seconds > segment.startSeconds) {
      const budget =
        segment.text.length *
        ((seconds - segment.startSeconds) / (segment.endSeconds - segment.startSeconds));
      let prefix = "";
      for (const word of segment.text.split(/\s+/)) {
        const next = prefix.length === 0 ? word : `${prefix} ${word}`;
        if (next.length > budget) break;
        prefix = next;
      }
      if (prefix.length > 0) parts.push(prefix);
    }
    break;
  }
  return parts.join(" ");
}

/** One 100 ms frame of a continuous tone in the profile's output format. */
function toneFrame(phase: number) {
  const samples = (cascadeMediaOutputFormat.sampleRate * frameMs) / 1000;
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  const step = (2 * Math.PI * toneHz) / cascadeMediaOutputFormat.sampleRate;
  let next = phase;
  for (let sample = 0; sample < samples; sample += 1) {
    view.setInt16(sample * 2, Math.round(Math.sin(next) * toneAmplitude * 0x7fff), true);
    next = (next + step) % (2 * Math.PI);
  }
  return { pcm, phase: next };
}
