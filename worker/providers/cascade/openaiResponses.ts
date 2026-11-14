import { Deferred, Effect, Layer, Stream } from "effect";
import { z } from "zod";
import { boundary, failure } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import {
  CascadeLanguageModel,
  LanguageModelFailed,
  type LanguageModelEvent,
  type LanguageModelRequest,
  type PreparedToolChoice,
} from "./adapters.ts";
import type { CascadeAdapterOptions, CascadeProviderDeclaration } from "./providerDeclaration.ts";
import { jsonText } from "./providerJson.ts";
import { modelAnswerStartTimeLimit } from "./providerTimeLimits.ts";
import type { ReasoningEffort } from "../../runtime/nativeContracts.ts";
import type { PreparedInstructions } from "../../runtime/nodeContentContracts.ts";

type ProviderPromptReference = Extract<PreparedInstructions, { kind: "provider_prompt" }>["prompt"];

/**
 * The OpenAI Responses adapter of the Cascade language-model contract. Each request streams,
 * is not stored at OpenAI, and carries the caller's instructions and tools verbatim. The
 * adapter runs the model of the session's provider settings, with reasoning off unless the
 * caller's request sets an effort.
 */
export const openAiResponsesUrl = "https://api.openai.com/v1/responses";

/** OpenAI Responses models Cascade may run on; the first is the one it always ran. */
export const openAiResponsesModels = Object.freeze(["gpt-5.4-mini-2026-03-17"] as const);

const settingFields = { model: z.enum(openAiResponsesModels) };
const provider = z.literal("openai");

/** The OpenAI Responses settings a Start may give, beside `provider`; each may be left out. */
export const openAiResponsesGivenSettings = z
  .strictObject(settingFields)
  .partial()
  .extend({ provider });

/** The OpenAI Responses settings a session uses, every one decided. */
export const openAiResponsesSettings = z.strictObject({ provider, ...settingFields });
export type OpenAiResponsesSettings = z.output<typeof openAiResponsesSettings>;

type ResponsesInputMessage = { role: "developer" | "assistant" | "user"; content: string };

/** The Responses request fields the adapter sends. */
type ResponsesRequestBody = {
  model: string;
  stream: true;
  store: false;
  input: ResponsesInputMessage[];
  prompt?: ProviderPromptReference;
  instructions?: string;
  tools?: {
    type: "function";
    name: string;
    description: string;
    parameters: Readonly<Record<string, unknown>>;
    strict: false;
  }[];
  tool_choice?: PreparedToolChoice;
  reasoning: { effort: ReasoningEffort };
  max_output_tokens?: number;
};

/**
 * The request body. A literal prompt is the response's first input item, as a developer
 * message, because Responses requires an input and the opening has no history yet; a provider
 * prompt is referenced, with its operational instructions as the request's instructions. The
 * conversation history follows, and `store: false` keeps it out of OpenAI's storage. A request
 * without tools sends no `tools`, and one without a tool choice no `tool_choice`.
 */
export function openAiResponsesRequestBody(
  model: string,
  request: LanguageModelRequest,
): ResponsesRequestBody {
  const instructions = request.instructions;
  const body: ResponsesRequestBody = {
    model,
    stream: true,
    store: false,
    input: [],
    reasoning: { effort: request.reasoning?.effort ?? "none" },
  };
  if (request.tools.length > 0)
    body.tools = request.tools.map((tool) => ({
      type: tool.type,
      name: tool.name,
      description: tool.description,
      parameters: structuredClone(tool.parameters),
      // The caller's parameter schema is used as written, not rewritten for strict mode.
      strict: false,
    }));
  if (request.toolChoice !== null) body.tool_choice = structuredClone(request.toolChoice);
  // The conversation so far, in order: the interviewer's generated text as the assistant's
  // messages and each participant transcript as the user's, each verbatim.
  const history = request.history.map(
    (turn): ResponsesInputMessage => ({
      role: turn.role === "interviewer" ? "assistant" : "user",
      content: turn.text,
    }),
  );
  if (instructions.kind === "literal")
    body.input = [{ role: "developer", content: instructions.text }, ...history];
  else {
    body.input = history;
    body.prompt = structuredClone(instructions.prompt);
    if (request.operationalInstructions.length > 0)
      body.instructions = request.operationalInstructions;
  }
  if (request.maxOutputTokens !== "inf") body.max_output_tokens = request.maxOutputTokens;
  return body;
}

/** The model that answered a completed response, and the tokens OpenAI counted for it. */
type ResponseUsage = Readonly<{ model: string; inputTokens: number; outputTokens: number }>;

const tokenCount = z.number().int().safe().nonnegative();

/** One server-sent event of a streamed response, as the adapter uses it. */
type ResponseStreamEvent =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "tool_call"; callId: string; name: string; arguments: string }>
  | Readonly<{ kind: "output_item"; itemType: string; characters: number | null }>
  | Readonly<{ kind: "completed"; usage: ResponseUsage | null }>
  | Readonly<{ kind: "failed"; code: string }>
  | Readonly<{ kind: "ignored" }>;

const code = (value: string | null | undefined, fallback: string) =>
  value === null || value === undefined || value.length === 0 ? fallback : value;

const terminalOrTextTypes = [
  "response.output_text.delta",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
];

/** The events the adapter reads, each mapped to its owned meaning. */
const responseStreamEventSchema = z.union([
  z
    .object({ type: z.literal("response.output_text.delta"), delta: z.string() })
    .transform(({ delta }): ResponseStreamEvent => ({ kind: "text", text: delta })),
  z
    .object({
      type: z.literal("response.output_item.done"),
      item: z.object({
        type: z.literal("function_call"),
        call_id: z.string().min(1),
        name: z.string().min(1),
        arguments: z.string(),
      }),
    })
    .transform(
      ({ item }): ResponseStreamEvent => ({
        kind: "tool_call",
        callId: item.call_id,
        name: item.name,
        arguments: item.arguments,
      }),
    ),
  // A completed message reports the length of its text, which its deltas already delivered.
  z
    .object({
      type: z.literal("response.output_item.done"),
      item: z.object({
        type: z.literal("message"),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
      }),
    })
    .transform(
      ({ item }): ResponseStreamEvent => ({
        kind: "output_item",
        itemType: "message",
        characters: item.content
          .filter((part) => part.type === "output_text")
          .reduce((total, part) => total + (part.text?.length ?? 0), 0),
      }),
    ),
  // Any other completed item, such as reasoning, reports only its type.
  z
    .object({
      type: z.literal("response.output_item.done"),
      item: z.object({ type: z.string().min(1) }),
    })
    .refine(({ item }) => item.type !== "function_call")
    .transform(
      ({ item }): ResponseStreamEvent => ({
        kind: "output_item",
        itemType: item.type,
        characters: null,
      }),
    ),
  z
    .object({
      type: z.literal("response.completed"),
      response: z.object({
        model: z.string().min(1),
        usage: z.object({ input_tokens: tokenCount, output_tokens: tokenCount }),
      }),
    })
    .transform(
      ({ response }): ResponseStreamEvent => ({
        kind: "completed",
        usage: {
          model: response.model,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      }),
    ),
  // A completed response without a usable usage account still completes; its usage is unknown.
  z
    .object({ type: z.literal("response.completed") })
    .transform((): ResponseStreamEvent => ({ kind: "completed", usage: null })),
  z
    .object({
      type: z.literal("response.failed"),
      response: z.object({ error: z.object({ code: z.string().nullish() }).nullish() }),
    })
    .transform(
      ({ response }): ResponseStreamEvent => ({
        kind: "failed",
        code: `openai_response_failed:${code(response.error?.code, "unknown")}`,
      }),
    ),
  z
    .object({
      type: z.literal("response.incomplete"),
      response: z.object({
        incomplete_details: z.object({ reason: z.string().nullish() }).nullish(),
      }),
    })
    .transform(
      ({ response }): ResponseStreamEvent => ({
        kind: "failed",
        code: `openai_response_incomplete:${code(response.incomplete_details?.reason, "unknown")}`,
      }),
    ),
  // The stream's error names its code inside `error`, as an exhausted credit balance does;
  // an older shape names it at the top level.
  z
    .object({
      type: z.literal("error"),
      code: z.string().nullish(),
      error: z.object({ code: z.string().nullish() }).nullish(),
    })
    .transform(
      (event): ResponseStreamEvent => ({
        kind: "failed",
        code: `openai_stream_error:${code(event.error?.code ?? event.code, "unknown")}`,
      }),
    ),
  // Every other event. A text, terminal or completed function-call event whose shape no
  // member above accepts is not ignored: it is undecodable.
  z
    .object({ type: z.string(), item: z.object({ type: z.unknown() }).optional() })
    .refine(
      (event) =>
        !terminalOrTextTypes.includes(event.type) &&
        !(event.type === "response.output_item.done" && event.item?.type === "function_call"),
    )
    .transform((): ResponseStreamEvent => ({ kind: "ignored" })),
]);

/**
 * OpenAI's streamed response events, which evolve independently of Runtime. The adapter
 * reads text deltas, completed function calls and the terminal outcome, with the completed
 * response's model and token usage when it reports them. Every completed output item is also
 * read as evidence: its type, and a message's text length. Partial function-call arguments
 * acquire no authority and, like every other event type, are ignored.
 */
export const decodeResponseStreamEvent = boundary.tolerant({
  source: "OpenAI Responses server-sent event data",
  variants: [{ schema: jsonText(responseStreamEventSchema), convert: (event) => event }],
  otherwise: failure("openai_stream_event_undecodable"),
});

/**
 * Groups the lines of a server-sent event stream into each event's data. A blank line ends an
 * event; only `data:` fields carry payload, joined by newlines.
 */
function sseData<E, R>(lines: Stream.Stream<string, E, R>): Stream.Stream<string, E, R> {
  return lines.pipe(
    Stream.mapAccum(
      (): readonly string[] => [],
      (data, line): readonly [readonly string[], readonly string[]] => {
        if (line === "") return [[], data.length === 0 ? [] : [data.join("\n")]];
        if (!line.startsWith("data:")) return [data, []];
        const value = line.slice(5);
        return [[...data, value.startsWith(" ") ? value.slice(1) : value], []];
      },
    ),
  );
}

/**
 * Fails a response that has not started to answer within its time limit of being sent: its first
 * text, tool call or completed output item. Other server-sent events, such as the response's
 * creation, do not start the answer.
 */
function answerStartedInTime(
  response: Stream.Stream<LanguageModelEvent, LanguageModelFailed>,
): Stream.Stream<LanguageModelEvent, LanguageModelFailed> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const limit = Deferred.await(started).pipe(
        Effect.timeoutOrElse({
          duration: modelAnswerStartTimeLimit,
          orElse: () =>
            Effect.fail(new LanguageModelFailed({ code: "openai_response_start_timeout" })),
        }),
      );
      // The response's end, not the limit's, ends the stream.
      return Stream.merge(
        response.pipe(Stream.tap(() => Deferred.succeed(started, undefined))),
        Stream.drain(Stream.fromEffect(limit)),
        { haltStrategy: "left" },
      );
    }),
  );
}

/**
 * OpenAI Responses as Cascade's language model, chosen with `languageModel.provider: "openai"`.
 * It needs the OpenAI API key, and reports each response's tokens, naming the model that
 * answered.
 */
export const openAiResponsesProvider = Object.freeze({
  provider: "openai",
  defaults: Object.freeze({ provider: "openai", model: "gpt-5.4-mini-2026-03-17" }),
  credentials: ["OPENAI_API_KEY"],
  usage: Object.freeze({ provider: "openai" }),
  adapter: (options, settings) => openAiResponsesLanguageModel(options, settings),
} satisfies CascadeProviderDeclaration<OpenAiResponsesSettings, CascadeLanguageModel>);

function openAiResponsesLanguageModel(
  options: CascadeAdapterOptions,
  { model }: OpenAiResponsesSettings,
): Layer.Layer<CascadeLanguageModel> {
  return Layer.effect(
    CascadeLanguageModel,
    Effect.sync(() => {
      return CascadeLanguageModel.of({
        usage: openAiResponsesProvider.usage,
        respond: (modelRequest) =>
          Stream.unwrap(
            Effect.gen(function* () {
              // The request lives as long as the response stream: ending or interrupting the
              // stream aborts it, so a cancelled response stops at the provider too.
              const request = new AbortController();
              yield* Effect.addFinalizer(() => Effect.sync(() => request.abort()));
              const response = yield* Effect.tryPromise({
                try: (interrupted) =>
                  options.transport(openAiResponsesUrl, {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${options.apiKey}`,
                      "Content-Type": "application/json",
                      Accept: "text/event-stream",
                    },
                    body: JSON.stringify(openAiResponsesRequestBody(model, modelRequest)),
                    signal: AbortSignal.any([request.signal, interrupted]),
                  }),
                catch: () => new LanguageModelFailed({ code: "openai_transport_failed" }),
              });
              const body = response.body;
              if (!response.ok || body === null) {
                yield* Effect.promise(
                  () => body?.cancel().catch(() => undefined) ?? Promise.resolve(),
                );
                return Stream.fail(
                  new LanguageModelFailed({ code: `openai_http_${String(response.status)}` }),
                );
              }
              let completed = false;
              const events = Stream.fromReadableStream({
                evaluate: () => body,
                onError: () => new LanguageModelFailed({ code: "openai_stream_failed" }),
              }).pipe(
                Stream.decodeText,
                Stream.splitLines,
                sseData,
                Stream.mapEffect((data) => {
                  const decoded = decodeResponseStreamEvent(data);
                  return decoded.ok
                    ? Effect.succeed(decoded.value)
                    : Effect.fail(new LanguageModelFailed({ code: decoded.error.code }));
                }),
                // The terminal event ends the response; nothing after it is read.
                Stream.takeUntil((event) => {
                  if (event.kind === "completed") completed = true;
                  return completed;
                }),
                Stream.flatMap((event): Stream.Stream<LanguageModelEvent, LanguageModelFailed> => {
                  switch (event.kind) {
                    case "text":
                      return event.text.length === 0 ? Stream.empty : Stream.succeed(event);
                    case "tool_call":
                      // The call is also a completed output item.
                      return Stream.make(
                        { kind: "output_item", itemType: "function_call", characters: null },
                        event,
                      );
                    case "output_item":
                      return Stream.succeed(event);
                    case "failed":
                      return Stream.fail(new LanguageModelFailed({ code: event.code }));
                    case "completed":
                      return event.usage === null
                        ? Stream.empty
                        : Stream.succeed({ kind: "usage", ...event.usage });
                    case "ignored":
                      return Stream.empty;
                  }
                }),
              );
              // A stream that closes before its terminal event did not complete.
              return Stream.concat(
                events,
                Stream.suspend(() =>
                  completed
                    ? Stream.empty
                    : Stream.fail(new LanguageModelFailed({ code: "openai_stream_closed" })),
                ),
              );
            }),
          ).pipe(answerStartedInTime),
      });
    }),
  );
}
