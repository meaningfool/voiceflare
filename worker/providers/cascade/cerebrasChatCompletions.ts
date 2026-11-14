import { Deferred, Duration, Effect, Layer, Stream } from "effect";
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

/**
 * The Cerebras Chat Completions adapter of the Cascade language-model contract (plan decision 9).
 * Each request streams and carries the caller's literal instructions and tools verbatim. Cerebras
 * stores no prompts, so a request whose instructions reference an OpenAI stored prompt fails
 * before any provider request.
 */
export const cerebrasChatCompletionsUrl = "https://api.cerebras.ai/v1/chat/completions";

/** Cerebras models Cascade may run on (user, 2026-11-05): `qwen-3.8-27b` only. */
export const cerebrasChatCompletionsModels = Object.freeze(["qwen-3.8-27b"] as const);

/**
 * The reasoning efforts `qwen-3.8-27b` accepts; it refuses `minimal` and `xhigh`. A Start that
 * chooses Cerebras with another effort is refused before provider work.
 */
export const cerebrasReasoningEfforts: readonly ReasoningEffort[] = Object.freeze([
  "none",
  "low",
  "medium",
  "high",
]);

/**
 * The output cap every request sends. Without one, Cerebras reserves about 17,000 tokens of the
 * account's per-minute quota for each request; 1,024 leaves room for reasoning at `low`.
 */
export const cerebrasOutputTokenCap = 1024;

/**
 * The waits before each retry of a `queue_exceeded` refusal (user, 2026-11-06): four retries at
 * most, so five attempts, with no retry after the 4 s wait. A `retry-after` header neither adds
 * attempts nor lengthens them. Every attempt stays inside the answer-start limit, which counts
 * from the first.
 */
export const cerebrasQueueRetryWaits = Object.freeze([
  Duration.millis(500),
  Duration.seconds(1),
  Duration.seconds(2),
  Duration.seconds(4),
]);

const settingFields = { model: z.enum(cerebrasChatCompletionsModels) };
const provider = z.literal("cerebras");

/** The Cerebras settings a Start may give, beside `provider`; each may be left out. */
export const cerebrasChatCompletionsGivenSettings = z
  .strictObject(settingFields)
  .partial()
  .extend({ provider });

/** The Cerebras settings a session uses, every one decided. */
export const cerebrasChatCompletionsSettings = z.strictObject({
  provider,
  ...settingFields,
});
export type CerebrasChatCompletionsSettings = z.output<typeof cerebrasChatCompletionsSettings>;

type ChatMessage = { role: "system" | "assistant" | "user"; content: string };

type ChatToolChoice = "auto" | "none" | { type: "function"; function: { name: string } };

/** The Chat Completions request fields the adapter sends. */
type ChatCompletionsRequestBody = {
  model: string;
  stream: true;
  messages: ChatMessage[];
  tools?: {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Readonly<Record<string, unknown>>;
      strict: false;
    };
  }[];
  tool_choice?: ChatToolChoice;
  reasoning_effort: ReasoningEffort;
  max_completion_tokens: number;
};

function chatToolChoice(choice: PreparedToolChoice): ChatToolChoice {
  return typeof choice === "string"
    ? choice
    : { type: "function", function: { name: choice.name } };
}

/**
 * The request body for literal instructions: they are the first `system` message, then the
 * conversation so far, the interviewer's generated text as the assistant's messages and each
 * participant transcript as the user's, each verbatim. qwen refuses a request with no user
 * message, so while no participant has spoken an empty user message follows (approved by the
 * user, 2026-11-05). With no effort requested, `none` is sent: left out, the model would reason.
 * A request without tools sends no `tools`, and one without a tool choice no `tool_choice`, as
 * under the voice Gate's options.
 */
export function cerebrasChatCompletionsRequestBody(
  model: string,
  instructions: string,
  request: LanguageModelRequest,
): ChatCompletionsRequestBody {
  const history = request.history.map(
    (turn): ChatMessage => ({
      role: turn.role === "interviewer" ? "assistant" : "user",
      content: turn.text,
    }),
  );
  const opening = request.history.every((turn) => turn.role !== "participant");
  const body: ChatCompletionsRequestBody = {
    model,
    stream: true,
    messages: [
      { role: "system", content: instructions },
      ...history,
      ...(opening ? [{ role: "user" as const, content: "" }] : []),
    ],
    reasoning_effort: request.reasoning?.effort ?? "none",
    max_completion_tokens:
      request.maxOutputTokens === "inf"
        ? cerebrasOutputTokenCap
        : Math.min(request.maxOutputTokens, cerebrasOutputTokenCap),
  };
  if (request.tools.length > 0)
    body.tools = request.tools.map((tool) => ({
      type: tool.type,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: structuredClone(tool.parameters),
        // The caller's parameter schema is used as written, not rewritten for strict mode.
        strict: false,
      },
    }));
  if (request.toolChoice !== null) body.tool_choice = chatToolChoice(request.toolChoice);
  return body;
}

const tokenCount = z.number().int().safe().nonnegative();

/** One streamed chunk as the adapter uses it, or the stream's end marker. */
type CompletionStreamEvent =
  | Readonly<{
      kind: "chunk";
      model: string;
      content: string;
      reasoning: boolean;
      toolCalls: readonly Readonly<{
        callId: string;
        name: string;
        arguments: string;
      }>[];
      finishReason: string | null;
      usage: Readonly<{ inputTokens: number; outputTokens: number }> | null;
    }>
  | Readonly<{ kind: "done" }>;

/**
 * A `chat.completion.chunk`. Only the first choice is read: the adapter asks for one. Each tool
 * call arrives whole in its chunk, with its id, name and complete arguments; a fragment without
 * them is not accepted. The last chunk carries the finish reason and the usage account.
 */
const completionChunkSchema = z
  .object({
    model: z.string().min(1),
    choices: z.array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            reasoning: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  id: z.string().min(1),
                  function: z.object({
                    name: z.string().min(1),
                    arguments: z.string(),
                  }),
                }),
              )
              .nullish(),
          })
          .optional(),
        finish_reason: z.string().min(1).nullish(),
      }),
    ),
    usage: z.object({ prompt_tokens: tokenCount, completion_tokens: tokenCount }).nullish(),
  })
  .transform(({ model, choices, usage }): CompletionStreamEvent => {
    const [choice] = choices;
    return {
      kind: "chunk",
      model,
      content: choice?.delta?.content ?? "",
      reasoning: (choice?.delta?.reasoning ?? "").length > 0,
      toolCalls: (choice?.delta?.tool_calls ?? []).map((call) => ({
        callId: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      finishReason: choice?.finish_reason ?? null,
      usage:
        usage === null || usage === undefined
          ? null
          : {
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens,
            },
    };
  });

/**
 * Cerebras's streamed Chat Completions data, which evolves independently of Runtime: each
 * chunk's text, reasoning, whole tool calls, finish reason and final usage account, and the
 * `[DONE]` marker that ends the stream. Anything else is undecodable.
 */
export const decodeCerebrasStreamData = boundary.tolerant({
  source: "Cerebras Chat Completions server-sent event data",
  variants: [
    {
      schema: z.literal("[DONE]"),
      convert: (): CompletionStreamEvent => ({ kind: "done" }),
    },
    { schema: jsonText(completionChunkSchema), convert: (event) => event },
  ],
  otherwise: failure("cerebras_stream_event_undecodable"),
});

/**
 * The code a Cerebras error body names, such as `queue_exceeded` or `token_quota_exceeded` on a
 * 429. Bodies without a code are undecodable: the refusal's reason is then unknown.
 */
export const decodeCerebrasErrorBody = boundary.tolerant({
  source: "Cerebras Chat Completions error response body",
  variants: [
    {
      schema: jsonText(z.object({ code: z.string().min(1) })),
      convert: ({ code }) => ({ code }),
    },
  ],
  otherwise: failure("cerebras_error_undecodable"),
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

/** The response's streamed events, from Cerebras's chunks to Cascade's model events. */
function completionEvents(
  body: NonNullable<Response["body"]>,
): Stream.Stream<LanguageModelEvent, LanguageModelFailed> {
  /** The item the chunks are streaming: its reasoning, or the message and its text so far. */
  let open: "reasoning" | "message" | null = null;
  let characters = 0;
  let finished = false;
  let done = false;
  let usage: Readonly<{ model: string; inputTokens: number; outputTokens: number }> | null = null;
  /** Chat Completions has no output items: each ends when another kind of output starts. */
  const close = (): LanguageModelEvent[] => {
    const ended = open;
    open = null;
    if (ended === "reasoning")
      return [{ kind: "output_item", itemType: "reasoning", characters: null }];
    if (ended === "message") return [{ kind: "output_item", itemType: "message", characters }];
    return [];
  };
  const read = (
    event: CompletionStreamEvent,
  ): readonly LanguageModelEvent[] | LanguageModelFailed => {
    if (event.kind === "done") {
      if (!finished) return new LanguageModelFailed({ code: "cerebras_stream_closed" });
      done = true;
      return usage === null ? [] : [{ kind: "usage", ...usage }];
    }
    const events: LanguageModelEvent[] = [];
    if (event.reasoning && open !== "reasoning") {
      events.push(...close());
      open = "reasoning";
    }
    // With reasoning on, the text starts with blank lines: a message starts at its first
    // visible character, so neither the transcript nor speech output receives them.
    const text = open === "message" ? event.content : event.content.replace(/^\s+/, "");
    if (text.length > 0) {
      if (open !== "message") {
        events.push(...close());
        open = "message";
        characters = 0;
      }
      characters += text.length;
      events.push({ kind: "text", text });
    }
    for (const call of event.toolCalls) {
      events.push(...close());
      // The call is also a completed output item.
      events.push(
        { kind: "output_item", itemType: "function_call", characters: null },
        { kind: "tool_call", ...call },
      );
    }
    if (event.usage !== null) usage = { model: event.model, ...event.usage };
    if (event.finishReason !== null) {
      // A reply that reaches the output cap is incomplete, as OpenAI's `response.incomplete` is.
      if (event.finishReason !== "stop" && event.finishReason !== "tool_calls")
        return new LanguageModelFailed({
          code: `cerebras_response_incomplete:${event.finishReason}`,
        });
      finished = true;
      events.push(...close());
    }
    return events;
  };
  const events = Stream.fromReadableStream({
    evaluate: () => body,
    onError: () => new LanguageModelFailed({ code: "cerebras_stream_failed" }),
  }).pipe(
    Stream.decodeText,
    Stream.splitLines,
    sseData,
    Stream.mapEffect((data) => {
      const decoded = decodeCerebrasStreamData(data);
      if (!decoded.ok) return Effect.fail(new LanguageModelFailed({ code: decoded.error.code }));
      const outcome = read(decoded.value);
      return outcome instanceof LanguageModelFailed
        ? Effect.fail(outcome)
        : Effect.succeed(outcome);
    }),
    // The end marker ends the response; nothing after it is read.
    Stream.takeUntil(() => done),
    Stream.flatMap((events) => Stream.fromIterable(events)),
  );
  // A stream that closes before its end marker did not complete.
  return Stream.concat(
    events,
    Stream.suspend(() =>
      done
        ? Stream.empty
        : Stream.fail(new LanguageModelFailed({ code: "cerebras_stream_closed" })),
    ),
  );
}

/**
 * Cerebras `qwen-3.8-27b` as Cascade's language model: today's provider and model (#1131), also
 * chosen with `languageModel.provider: "cerebras"`. It needs the Cerebras API key, accepts only
 * some reasoning efforts, and reports each response's tokens, naming the model that answered.
 */
export const cerebrasChatCompletionsProvider = Object.freeze({
  provider: "cerebras",
  defaults: Object.freeze({ provider: "cerebras", model: "qwen-3.8-27b" }),
  credentials: ["CEREBRAS_API_KEY"],
  usage: Object.freeze({ provider: "cerebras" }),
  reasoningEfforts: cerebrasReasoningEfforts,
  adapter: (options, settings) => cerebrasLanguageModel(options, settings),
} satisfies CascadeProviderDeclaration<CerebrasChatCompletionsSettings, CascadeLanguageModel>);

function cerebrasLanguageModel(
  options: CascadeAdapterOptions,
  { model }: CerebrasChatCompletionsSettings,
): Layer.Layer<CascadeLanguageModel> {
  return Layer.succeed(
    CascadeLanguageModel,
    CascadeLanguageModel.of({
      usage: cerebrasChatCompletionsProvider.usage,
      respond: (modelRequest) => {
        const instructions = modelRequest.instructions;
        // Cerebras has no stored prompts: a reference to OpenAI's cannot be sent.
        if (instructions.kind !== "literal")
          return Stream.fail(
            new LanguageModelFailed({ code: "cerebras_provider_prompt_unsupported" }),
          );
        const body = JSON.stringify(
          cerebrasChatCompletionsRequestBody(model, instructions.text, modelRequest),
        );
        return Stream.suspend(() => {
          const attempts: Attempts = { sent: 0, queueRefused: 0 };
          return answerStartedInTime(requestWithRetries(options, body, attempts), attempts);
        });
      },
    }),
  );
}

/** The attempts a response has sent so far, and the capacity refusals among them. */
type Attempts = { sent: number; queueRefused: number };

/**
 * Sends the request and streams its answer. A `queue_exceeded` refusal is asked again after its
 * wait, while waits remain; every other refusal or failed status fails the response at once.
 */
function requestWithRetries(
  options: CascadeAdapterOptions,
  body: string,
  attempts: Attempts,
): Stream.Stream<LanguageModelEvent, LanguageModelFailed> {
  return Stream.unwrap(
    Effect.gen(function* () {
      // The requests live as long as the response stream: ending or interrupting the stream
      // aborts them, so a cancelled response stops at the provider too.
      const request = new AbortController();
      yield* Effect.addFinalizer(() => Effect.sync(() => request.abort()));
      const attempt = (): Stream.Stream<LanguageModelEvent, LanguageModelFailed> =>
        Stream.unwrap(
          Effect.gen(function* () {
            attempts.sent += 1;
            const sent = attempts.sent;
            const response = yield* Effect.tryPromise({
              try: (interrupted) =>
                options.transport(cerebrasChatCompletionsUrl, {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${options.apiKey}`,
                    "Content-Type": "application/json",
                    Accept: "text/event-stream",
                  },
                  body,
                  signal: AbortSignal.any([request.signal, interrupted]),
                }),
              catch: () => new LanguageModelFailed({ code: "cerebras_transport_failed" }),
            });
            const responseBody = response.body;
            if (response.ok && responseBody !== null) return completionEvents(responseBody);
            const code = `cerebras_http_${String(response.status)}`;
            if (response.status !== 429) {
              yield* Effect.promise(
                () => responseBody?.cancel().catch(() => undefined) ?? Promise.resolve(),
              );
              return Stream.fail(new LanguageModelFailed({ code }));
            }
            const refused = decodeCerebrasErrorBody(
              yield* Effect.promise(() => response.text().catch(() => "")),
            );
            const reason = refused.ok ? refused.value.code : "unknown";
            const wait = cerebrasQueueRetryWaits[sent - 1];
            if (reason !== "queue_exceeded" || wait === undefined)
              return Stream.fail(
                new LanguageModelFailed({ code, refusal: { reason, attempts: sent } }),
              );
            // Cerebras's capacity, not the account's quota. A refused request produced no
            // output, so asking again after the wait duplicates nothing.
            attempts.queueRefused += 1;
            const retry: LanguageModelEvent = {
              kind: "retry",
              refusal: reason,
              attempt: sent,
              waitMs: Duration.toMillis(wait),
            };
            return Stream.concat(
              Stream.succeed(retry),
              Stream.unwrap(Effect.sleep(wait).pipe(Effect.map(() => attempt()))),
            );
          }),
        );
      return attempt();
    }),
  );
}

/**
 * Fails a response that has not started to answer within its time limit of its first attempt:
 * its first text, tool call or completed output item. A retry neither starts the answer nor
 * restarts the limit. A limit reached while capacity refusals were being retried fails as the
 * refusal, naming it and the attempts made.
 */
function answerStartedInTime(
  response: Stream.Stream<LanguageModelEvent, LanguageModelFailed>,
  attempts: Readonly<Attempts>,
): Stream.Stream<LanguageModelEvent, LanguageModelFailed> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const limit = Deferred.await(started).pipe(
        Effect.timeoutOrElse({
          duration: modelAnswerStartTimeLimit,
          orElse: () =>
            Effect.fail(
              attempts.queueRefused > 0
                ? new LanguageModelFailed({
                    code: "cerebras_http_429",
                    refusal: { reason: "queue_exceeded", attempts: attempts.sent },
                  })
                : new LanguageModelFailed({ code: "cerebras_response_start_timeout" }),
            ),
        }),
      );
      // The response's end, not the limit's, ends the stream.
      return Stream.merge(
        response.pipe(
          Stream.tap((event) =>
            event.kind === "retry" ? Effect.void : Deferred.succeed(started, undefined),
          ),
        ),
        Stream.drain(Stream.fromEffect(limit)),
        { haltStrategy: "left" },
      );
    }),
  );
}
