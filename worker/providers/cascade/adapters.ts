import { Context, Data, type Effect, type Layer, type Scope, type Stream } from "effect";
import type { PreparedInstructions, PreparedTool } from "../../runtime/nodeContentContracts.ts";
import type { ReasoningEffort } from "../../runtime/nativeContracts.ts";
import type { CascadeProviderSettings } from "./settings.ts";
import type { CascadeUsageSource } from "./usage.ts";

/** Which tool the model may call: any, none, or the one named. */
export type PreparedToolChoice =
  | "auto"
  | "none"
  | Readonly<{
      type: "function";
      name: string;
    }>;

/**
 * The Cascade kit's provider contracts. A Cascade pair's flow reaches its speech-input,
 * language-model and speech-output providers only through these services, so a provider
 * is substituted by providing another Layer; the pair never names a provider.
 */

/**
 * One turn of the conversation so far, in conversational order: the interviewer text the
 * execution submitted for synthesis, or a participant turn's transcript.
 */
export type ConversationHistoryTurn = Readonly<{
  role: "interviewer" | "participant";
  text: string;
}>;

/**
 * One language-model request. The instructions, operational instructions and tools are the
 * caller's own, passed verbatim; the contract adds no wording. The history is the execution's
 * own record of the conversation; no provider stores it. The adapter chooses its model. A
 * request without tools and with a null tool choice sends neither, as under the Gate's options.
 */
export type LanguageModelRequest = Readonly<{
  history: readonly ConversationHistoryTurn[];
  instructions: PreparedInstructions;
  operationalInstructions: string;
  tools: readonly PreparedTool[];
  toolChoice: PreparedToolChoice | null;
  maxOutputTokens: number | "inf";
  reasoning: Readonly<{ effort: ReasoningEffort }> | null;
}>;

/**
 * One event of a streamed model response, in the order the provider produced it. Each output
 * item the provider completed is also reported as evidence of what the model produced: its
 * type and, for a message, the length of its text; text after it belongs to a later item. A
 * response may end with the provider's account of its usage: the model that answered and its
 * tokens. A provider that refused an attempt before any of the response streamed, and is asked
 * again, reports the retry: the refusal, the attempt it refused and the wait before the next. A
 * retry does not start the answer.
 */
export type LanguageModelEvent =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "tool_call"; callId: string; name: string; arguments: string }>
  | Readonly<{ kind: "output_item"; itemType: string; characters: number | null }>
  | Readonly<{ kind: "usage"; model: string; inputTokens: number; outputTokens: number }>
  | Readonly<{ kind: "retry"; refusal: string; attempt: number; waitMs: number }>;

/**
 * The model response failed; its code names the provider failure. A provider's refusal names
 * its reason and the attempts made, so a capacity refusal reads apart from an exhausted quota.
 */
export class LanguageModelFailed extends Data.TaggedError("LanguageModelFailed")<{
  code: string;
  refusal?: Readonly<{ reason: string; attempts: number }>;
}> {}

export class CascadeLanguageModel extends Context.Service<
  CascadeLanguageModel,
  Readonly<{
    /**
     * Streams one response: its text and completed tool calls in order. The stream's end
     * is the response's successful completion and a failure its failed outcome; interrupting
     * the stream cancels the response.
     */
    respond(request: LanguageModelRequest): Stream.Stream<LanguageModelEvent, LanguageModelFailed>;
    /** The provider its usage entries name; each response's account names its model. */
    usage: Readonly<{ provider: string }>;
  }>
>()("providers/cascade/CascadeLanguageModel") {}

/** Speech synthesis failed; its code names the provider failure. */
export class SpeechOutputFailed extends Data.TaggedError("SpeechOutputFailed")<{
  code: string;
}> {}

export class CascadeSpeechOutput extends Context.Service<
  CascadeSpeechOutput,
  Readonly<{
    /**
     * Synthesizes one output. Text arrives incrementally and its stream's end is the end of
     * the text; the provider aggregates it as it needs. Audio chunks, in the profile's output
     * format, stream in order; the audio stream ends when synthesis has finished, and
     * interrupting it cancels synthesis.
     */
    synthesize(text: Stream.Stream<string>): Stream.Stream<Uint8Array, SpeechOutputFailed>;
    /** The provider and model its usage entries name. */
    usage: CascadeUsageSource;
  }>
>()("providers/cascade/CascadeSpeechOutput") {}

/**
 * One participant-turn observation of a speech-input stream: final transcript text in order,
 * the provider's end-of-turn signal, which closes the text since the previous one, and the
 * acknowledgement of a finalization request, which follows all text the request settled.
 */
export type SpeechInputEvent =
  | Readonly<{ kind: "transcript"; text: string; final: boolean }>
  | Readonly<{ kind: "turn_ended" }>
  | Readonly<{ kind: "finalized" }>;

/** Speech recognition failed; its code names the provider failure. */
export class SpeechInputFailed extends Data.TaggedError("SpeechInputFailed")<{
  code: string;
}> {}

/**
 * One open recognition stream. Closing the Scope that opened it closes the stream. Silence of
 * any length is ordinary input: it ends no turn and fails no provider operation.
 */
export type SpeechInputStream = Readonly<{
  /** Forwards participant audio in the media profile's input format. */
  ingest(audio: Uint8Array): Effect.Effect<void, SpeechInputFailed>;
  events: Stream.Stream<SpeechInputEvent, SpeechInputFailed>;
  /**
   * Asks the provider to settle the audio forwarded so far: its text arrives as final
   * transcript events, then a `finalized` event. Completes on the provider's acknowledgement.
   */
  finalize: Effect.Effect<void, SpeechInputFailed>;
}>;

export class CascadeSpeechInput extends Context.Service<
  CascadeSpeechInput,
  Readonly<{
    open: Effect.Effect<SpeechInputStream, SpeechInputFailed, Scope.Scope>;
    /** The provider and model its usage entries name. */
    usage: CascadeUsageSource;
  }>
>()("providers/cascade/CascadeSpeechInput") {}

/**
 * The speech-input, language-model and speech-output providers of a Cascade session: the real
 * adapters built from Runtime's provider credentials, which read the session's provider
 * settings, or a local or test Runtime's controlled stand-ins.
 */
export type CascadeProviders = Layer.Layer<
  CascadeSpeechInput | CascadeLanguageModel | CascadeSpeechOutput,
  never,
  CascadeProviderSettings
>;
