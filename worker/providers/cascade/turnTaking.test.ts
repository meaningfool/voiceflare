import { afterEach, describe, expect, it } from "vitest";
import { type Cause, Effect, Exit, Layer, Queue, Scope, Stream } from "effect";
import {
  CascadeSpeechInput,
  type LanguageModelRequest,
  type SpeechInputEvent,
  type SpeechInputFailed,
} from "./adapters.ts";
import { CascadeMedia, CascadeMediaSession } from "./mediaSession.ts";
import {
  type CascadeMediaServerMessage,
  decodeCascadeMediaServerMessage,
} from "../../shared/contracts/cascadeMedia.ts";
import { cascadeStandIns, standInModel, type StandInResponse } from "./testing/standIns.ts";
import {
  type CascadePhaseSettings,
  type ClosingFailure,
  type InputSettlement,
  makeTurnTaking,
  type TurnTaking,
  type TurnTakingEvent,
  type TurnTakingPhase,
} from "./turnTaking.ts";

/**
 * The Cascade kit's turn-taking loop through its own interface: the model and speech output are
 * the kit's scripted stand-ins, speech input is scripted by each test, and the media session is
 * the kit's own over a socket that records what the browser would receive.
 */

const settings = (text: string): CascadePhaseSettings => ({
  instructions: { kind: "literal", text },
  operationalInstructions: "",
  tools: [],
  toolChoice: "auto",
  history: "conversation",
});

const scopes: Scope.Closeable[] = [];
afterEach(async () => {
  await Promise.all(
    scopes.splice(0).map((scope) => Effect.runPromise(Scope.close(scope, Exit.void))),
  );
});

/**
 * Starts a loop on scripted responses; each test drives it through its operations. Speech
 * output synthesizes a frame every 5 ms unless `speech` says otherwise, and may fail.
 */
async function startLoop(
  responses: readonly StandInResponse[],
  speech: Readonly<{
    frameIntervalMs?: number;
    synthesisFailure?: Readonly<{ text: string; code: string }>;
  }> = {},
) {
  /** Every event the loop reported, in order; `events` leaves out its usage reports. */
  const reported: TurnTakingEvent[] = [];
  const events: TurnTakingEvent[] = [];
  const requests: LanguageModelRequest[] = [];
  const cancelled: string[] = [];
  /** Each text piece speech output was given, in order. */
  const synthesized: string[] = [];
  const browser: CascadeMediaServerMessage[] = [];
  const diagnostics: Readonly<{ type: string; payload: unknown }>[] = [];
  const media = new CascadeMediaSession();
  media.attach(
    {
      send: (data) => browser.push(decodeCascadeMediaServerMessage(JSON.parse(data))),
      close: () => undefined,
      addEventListener: () => undefined,
    },
    () => undefined,
  );
  /** The open recognition stream, whose events the test says. */
  let recognition: Queue.Queue<SpeechInputEvent, SpeechInputFailed | Cause.Done> | null = null;
  const speechInput = Layer.succeed(
    CascadeSpeechInput,
    CascadeSpeechInput.of({
      usage: { provider: "test-speech-input", model: "test" },
      open: Effect.gen(function* () {
        const events = yield* Queue.unbounded<SpeechInputEvent, SpeechInputFailed | Cause.Done>();
        recognition = events;
        yield* Effect.addFinalizer(() => Queue.end(events));
        return {
          ingest: () => Effect.void,
          events: Stream.fromQueue(events),
          finalize: Effect.asVoid(Queue.offer(events, { kind: "finalized" })),
        };
      }),
    }),
  );
  const scope = Effect.runSync(Scope.make());
  scopes.push(scope);
  const services = await Effect.runPromise(
    Layer.build(
      Layer.mergeAll(
        cascadeStandIns({
          responses,
          textIntervalMs: 1,
          frameIntervalMs: speech.frameIntervalMs ?? 5,
          synthesisFailure: speech.synthesisFailure,
          onRequest: (request) => requests.push(request),
          onSynthesis: (text) => synthesized.push(text),
          onCancel: (work) => cancelled.push(work),
        }),
        speechInput,
        Layer.succeed(CascadeMedia, media.media),
      ),
    ).pipe(Scope.provide(scope)),
  );
  /** What the test does with each event as it is reported, before the loop goes on. */
  let react: (event: TurnTakingEvent) => Effect.Effect<void> = () => Effect.void;
  const loop: TurnTaking = await Effect.runPromise(
    makeTurnTaking({
      model: { maxOutputTokens: "inf", reasoning: null },
      inputEligible: () => true,
      emit: (event) =>
        Effect.sync(() => {
          reported.push(event);
          if (event.kind !== "usage") events.push(event);
        }).pipe(Effect.andThen(Effect.suspend(() => react(event)))),
      diagnostic: (type, payload) => void diagnostics.push({ type, payload }),
    }).pipe(Effect.provideContext(services), Scope.provide(scope)),
  );
  /** Speech input recognizes `events`; each test says what the participant said. */
  const recognize = (...said: readonly SpeechInputEvent[]) => {
    if (recognition === null) throw new Error("no recognition stream is open");
    return Effect.runPromise(Queue.offerAll(recognition, said));
  };
  /** The identity of the opening, the first phase's first reply. */
  const opened: string[] = [];
  return {
    loop,
    reported,
    events,
    requests,
    cancelled,
    synthesized,
    browser,
    diagnostics,
    run: (operation: Effect.Effect<void>) => Effect.runPromise(operation),
    /** Acts on each event while it is being reported, as Runtime's node dispatch can. */
    onReport: (handler: (event: TurnTakingEvent) => Effect.Effect<void>) => {
      react = handler;
    },
    /** Opens the conversation with its first phase, and returns the opening's identity. */
    open: async (text = "Interviewing") => {
      await Effect.runPromise(
        loop.converse({
          settings: settings(text),
          attributeReply: (outputId) => void opened.push(outputId),
          node: null,
        }),
      );
      const opening = opened[0];
      if (opening === undefined) throw new Error("the opening was not named");
      return opening;
    },
    /** The participant says `text` and speech input ends the turn. */
    say: (text: string) =>
      recognize({ kind: "transcript", text, final: true }, { kind: "turn_ended" }),
    /** The participant is still saying `text`: speech input recognized it, the turn goes on. */
    answering: (text: string) => recognize({ kind: "transcript", text, final: true }),
    kinds: () => events.map((event) => event.kind),
    browserKinds: () => browser.map((message) => message.type),
    /** The browser's messages without numbered audio, which timing decides, with their output. */
    browserLifecycle: () =>
      browser.flatMap((message) =>
        message.type === "output.audio"
          ? []
          : [
              "outputId" in message
                ? `${message.type} ${message.outputId}`
                : message.type === "input.listening"
                  ? "listening"
                  : message.type,
            ],
      ),
    /** The identities of the outputs the browser was offered, in order. */
    outputIds: () =>
      browser.flatMap((message) => (message.type === "output.started" ? [message.outputId] : [])),
  };
}

/** A phase carrying a node, which records what it reported through its callbacks. */
function nodePhase(text: string, deadlineInMs: number) {
  const attributed: string[] = [];
  const refused: string[] = [];
  const phase: TurnTakingPhase = {
    settings: settings(text),
    attributeReply: (outputId) => void attributed.push(outputId),
    node: {
      deadlineAt: Date.now() + deadlineInMs,
      current: () => true,
      refused: () => Effect.sync(() => void refused.push(text)),
    },
  };
  return { phase, attributed, refused };
}

/** A closing that says `sentence` and records what it reported through its callbacks. */
function closing(deadlineInMs: number, sentence: string) {
  const settled: InputSettlement[] = [];
  const attributed: string[] = [];
  const done: string[] = [];
  const failed: Array<Readonly<{ failure: ClosingFailure; outputId: string | undefined }>> = [];
  const reported = { settled, attributed, done, failed };
  return {
    reported,
    entry: {
      deadlineAt: Date.now() + deadlineInMs,
      sentence,
      claimInputClosure: () => true,
      inputSettled: (settlement: InputSettlement) => void reported.settled.push(settlement),
      attributeReply: (outputId: string) => void reported.attributed.push(outputId),
      done: (outputId: string) => Effect.sync(() => void reported.done.push(outputId)),
      failed: (failure: ClosingFailure, outputId?: string) =>
        Effect.sync(() => void reported.failed.push({ failure, outputId })),
    },
  };
}

/** When a delivered output finishes playing, which the real clock decides. */
const playbackTime: unknown = expect.any(Number);
const hello: StandInResponse = { text: ["Hello. ", "How was it?"] };
const moveOn = [{ name: "move_on", arguments: "{}" }];
/** Speech beside a call that moves on, whose synthesis runs on after its response completed. */
const movingOn: StandInResponse = {
  text: Array<string>(10).fill(
    "Thank you, that helps, and it is good to hear what made it clear. ",
  ),
  toolCalls: moveOn,
};

describe("Cascade turn-taking loop: conversing phase", () => {
  it("opens with the first phase's reply, admits the participant's turn and answers with the conversation so far", async () => {
    const run = await startLoop([hello, { text: ["Thank you."] }]);
    const opening = await run.open();
    await expect.poll(run.browserKinds).toContain("input.listening");
    // Generation and delivery run together: the reply can be final before its audio starts.
    expect(run.events[0]).toEqual({ kind: "output_started", outputId: opening });
    expect(run.events.slice(1, 3)).toEqual(
      expect.arrayContaining([
        { kind: "delivery_started", outputId: opening },
        {
          kind: "reply_generated",
          outputId: opening,
          outcome: "completed",
          text: "Hello. How was it?",
          toolCalls: [],
        },
      ]),
    );
    expect(run.events.slice(3)).toEqual([
      { kind: "delivery_stopped", outputId: opening, playbackEndsAt: playbackTime },
    ]);

    await run.say("It was clear.");
    await expect
      .poll(() => run.kinds().filter((kind) => kind === "delivery_stopped"))
      .toHaveLength(2);
    const [started, final] = run.events.slice(4, 6);
    expect(started?.kind).toBe("participant_item_started");
    expect(final).toEqual({
      kind: "participant_text_final",
      itemId: started !== undefined && "itemId" in started ? started.itemId : null,
      text: "It was clear.",
    });
    expect(run.requests.map(({ instructions }) => instructions)).toEqual([
      { kind: "literal", text: "Interviewing" },
      { kind: "literal", text: "Interviewing" },
    ]);
    expect(run.requests[1]?.history).toEqual([
      { role: "interviewer", text: "Hello. How was it?" },
      { role: "participant", text: "It was clear." },
    ]);
  });

  it("expects each output's and opportunity's usage before its provider work and settles it before its end", async () => {
    const run = await startLoop([hello]);
    const opening = await run.open();
    await expect.poll(run.browserKinds).toContain("input.listening");
    const listening = run.browser.find((message) => message.type === "input.listening");
    const opportunity =
      listening !== undefined && "opportunityId" in listening ? listening.opportunityId : null;
    const outputUsage = [
      {
        status: "satisfied",
        componentRole: "language_model",
        key: `language_model:${opening}`,
        measurements: [
          // The stand-in's account: one input token per history turn plus one, one output
          // token per text piece.
          entry("language_model", "cerebras", "input_text", "token", 1),
          entry("language_model", "cerebras", "output_text", "token", 2),
        ],
      },
      {
        status: "satisfied",
        componentRole: "text_to_speech",
        key: `text_to_speech:${opening}`,
        measurements: [
          entry("text_to_speech", "soniox", "input_text", "character", "Hello. How was it?".length),
          // 45 ms per character in whole 100 ms frames: four for "Hello. ", five for the rest.
          entry("text_to_speech", "soniox", "output_audio", "audio_millisecond", 900),
        ],
      },
    ];
    expect(run.reported).toEqual([
      { kind: "output_started", outputId: opening },
      {
        kind: "usage",
        usage: [
          { status: "expected", componentRole: "language_model", key: `language_model:${opening}` },
          { status: "expected", componentRole: "text_to_speech", key: `text_to_speech:${opening}` },
        ],
      },
      expect.objectContaining({ kind: run.reported[2]?.kind }),
      expect.objectContaining({ kind: run.reported[3]?.kind }),
      { kind: "usage", usage: outputUsage },
      { kind: "delivery_stopped", outputId: opening, playbackEndsAt: playbackTime },
      {
        kind: "usage",
        usage: [
          {
            status: "expected",
            componentRole: "speech_to_text",
            key: `speech_to_text:${opportunity}`,
          },
        ],
      },
    ]);

    // The opportunity closes with the participant's turn; this speech input was sent no audio.
    await run.say("It was clear.");
    await expect.poll(run.kinds).toContain("participant_text_final");
    expect(run.reported).toContainEqual({
      kind: "usage",
      usage: [
        {
          status: "satisfied",
          componentRole: "speech_to_text",
          key: `speech_to_text:${opportunity}`,
          measurements: [],
        },
      ],
    });
  });

  it("settles a cut output's usage, with the model's account it was given, before reporting its cancellation", async () => {
    const run = await startLoop([
      { text: ["Hello there, this opening takes a while."], hold: true },
    ]);
    const opening = await run.open();
    await expect.poll(run.browserKinds).toContain("output.audio");
    await run.run(run.loop.cancelOutput(opening));
    await expect.poll(run.kinds).toContain("output_cancelled");
    const settled = run.reported.findIndex(
      (event) => event.kind === "usage" && event.usage[0]?.status !== "expected",
    );
    const report = run.reported[settled];
    const [model, synthesis] = report?.kind === "usage" ? report.usage : [];
    expect(model).toEqual({
      status: "satisfied",
      componentRole: "language_model",
      key: `language_model:${opening}`,
      measurements: [
        entry("language_model", "cerebras", "input_text", "token", 1),
        entry("language_model", "cerebras", "output_text", "token", 1),
      ],
    });
    // The synthesis was given the whole text; the audio delivered depends on when it was cut.
    expect(synthesis).toMatchObject({
      status: "satisfied",
      componentRole: "text_to_speech",
      key: `text_to_speech:${opening}`,
    });
    expect(synthesis?.status === "satisfied" ? synthesis.measurements : []).toContainEqual(
      entry("text_to_speech", "soniox", "input_text", "character", 40),
    );
    // Its usage is settled before the output reports its end.
    expect(run.reported.findIndex(({ kind }) => kind === "output_cancelled")).toBeGreaterThan(
      settled,
    );
  });

  it("cuts the reply that moved on at entry, then speaks the phase's first reply without listening or its speech in the request", async () => {
    const run = await startLoop([hello, movingOn, { text: ["Question two?"] }]);
    await run.open();
    await expect.poll(run.browserKinds).toContain("input.listening");
    await run.say("It was clear.");
    // The reply that moves on completed with its call while its speech is still synthesized.
    await expect
      .poll(() => run.kinds().filter((kind) => kind === "reply_generated"))
      .toHaveLength(2);
    const [, moving] = run.outputIds();
    expect(run.browserLifecycle().at(-1)).toBe(`output.started ${String(moving)}`);
    const next = nodePhase("Question two", 5_000);
    await run.run(run.loop.converse(next.phase));

    await expect
      .poll(() => run.kinds().filter((kind) => kind === "delivery_stopped"))
      .toHaveLength(3);
    const [, , question] = run.outputIds();
    expect(question).toBe(next.attributed[0]);
    // The browser clears the reply at once and hears the phase's first reply next: no listening
    // opens between them, and none of the cut reply's audio follows its cancellation.
    expect(run.browserLifecycle().slice(4)).toEqual([
      `output.started ${String(moving)}`,
      `output.cancelled ${String(moving)}`,
      `output.started ${String(question)}`,
      `output.ended ${String(question)}`,
      "listening",
    ]);
    const cancelledAt = run.browser.findIndex(
      (message) => message.type === "output.cancelled" && message.outputId === moving,
    );
    expect(
      run.browser
        .slice(cancelledAt)
        .filter((message) => message.type === "output.audio" && message.outputId === moving),
    ).toEqual([]);
    expect(run.cancelled).toEqual(["synthesis"]);
    // Its completed reply keeps its text and call; its delivery is reported stopped at the cut.
    const reported = run.events.filter((event) => "outputId" in event && event.outputId === moving);
    expect(reported.map(({ kind }) => kind).sort()).toEqual([
      "delivery_started",
      "delivery_stopped",
      "output_started",
      "reply_generated",
    ]);
    expect(reported.at(-1)).toEqual({ kind: "delivery_stopped", outputId: moving });
    expect(reported).toContainEqual({
      kind: "reply_generated",
      outputId: moving,
      outcome: "completed",
      text: movingOn.text.join("").trim(),
      toolCalls: [expect.objectContaining({ name: "move_on" })],
    });
    expect(run.diagnostics).toContainEqual({
      type: "cascade.output_cut",
      payload: {
        source: "cascade_execution",
        provider: "cascade",
        outputId: moving,
        delivered: false,
      },
    });
    // The phase's request ends on the participant's answer, not on the speech that was cut.
    expect(run.requests[2]).toMatchObject({
      instructions: { kind: "literal", text: "Question two" },
      history: [
        { role: "interviewer", text: "Hello. How was it?" },
        { role: "participant", text: "It was clear." },
      ],
    });
    expect(next.refused).toEqual([]);
  });

  it("stops in the browser a reply that moved on after its end was delivered, and leaves its speech out of the request", async () => {
    const run = await startLoop([
      hello,
      { text: ["Thank you."], toolCalls: moveOn },
      { text: ["Question two?"] },
    ]);
    await run.open();
    await expect.poll(run.browserKinds).toContain("input.listening");
    await run.say("It was clear.");
    // The reply that moves on was delivered to its end, and the opportunity after it is open.
    await expect
      .poll(() => run.browserKinds().filter((kind) => kind === "input.listening"))
      .toHaveLength(2);
    const [, moving] = run.outputIds();
    const next = nodePhase("Question two", 5_000);
    await run.run(run.loop.converse(next.phase));

    await expect
      .poll(() => run.kinds().filter((kind) => kind === "delivery_stopped"))
      .toHaveLength(3);
    const question = next.attributed[0];
    // The browser may still be playing it: it is told to stop it before the phase's first reply.
    expect(run.browserLifecycle().slice(4)).toEqual([
      `output.started ${String(moving)}`,
      `output.ended ${String(moving)}`,
      "listening",
      "input.closed",
      `output.cancelled ${String(moving)}`,
      `output.started ${String(question)}`,
      `output.ended ${String(question)}`,
      "listening",
    ]);
    expect(run.diagnostics).toContainEqual({
      type: "cascade.output_cut",
      payload: {
        source: "cascade_execution",
        provider: "cascade",
        outputId: moving,
        delivered: true,
      },
    });
    expect(run.requests[2]?.history).toEqual([
      { role: "interviewer", text: "Hello. How was it?" },
      { role: "participant", text: "It was clear." },
    ]);
  });

  it("cuts nothing when the reply that moved on has no speech", async () => {
    const run = await startLoop([
      hello,
      { text: [], toolCalls: moveOn },
      { text: ["Question two?"] },
    ]);
    const opening = await run.open();
    await expect.poll(run.browserKinds).toContain("input.listening");
    // The phase is entered while the moving reply is reported, before its output ended.
    const next = nodePhase("Question two", 5_000);
    run.onReport((event) => {
      if (event.kind !== "reply_generated" || event.outputId === opening) return Effect.void;
      run.onReport(() => Effect.void);
      return run.loop.converse(next.phase);
    });
    await run.say("It was clear.");
    await expect.poll(() => run.outputIds()).toHaveLength(3);
    const [, moving, question] = run.outputIds();
    await expect
      .poll(() => run.kinds().filter((kind) => kind === "delivery_stopped"))
      .toHaveLength(3);

    // It ends as it would without the move: its end is delivered, nothing is cut or stopped, and
    // the phase's first reply follows with no listening between them.
    expect(run.browserLifecycle().slice(4)).toEqual([
      `output.started ${String(moving)}`,
      `output.ended ${String(moving)}`,
      `output.started ${String(question)}`,
      `output.ended ${String(question)}`,
      "listening",
    ]);
    expect(run.diagnostics.filter(({ type }) => type === "cascade.output_cut")).toEqual([]);
    expect(run.requests[2]?.history).toEqual([
      { role: "interviewer", text: "Hello. How was it?" },
      { role: "participant", text: "It was clear." },
    ]);
  });

  it("settles an open opportunity at entry instead of admitting a turn, then speaks the phase's first reply", async () => {
    const run = await startLoop([hello, { text: ["Question two?"] }]);
    await run.open();
    await expect.poll(run.browserKinds).toContain("input.listening");
    await run.answering("The talks");
    const next = nodePhase("Question two", 5_000);
    await run.run(run.loop.converse(next.phase));

    await expect
      .poll(() => run.kinds().filter((kind) => kind === "delivery_stopped"))
      .toHaveLength(2);
    // What was heard joins the history once, and no turn was admitted for it.
    expect(run.events.filter(({ kind }) => kind === "participant_text_final")).toEqual([
      expect.objectContaining({ text: "The talks" }),
    ]);
    expect(run.requests[1]).toMatchObject({
      instructions: { kind: "literal", text: "Question two" },
      history: [
        { role: "interviewer", text: "Hello. How was it?" },
        { role: "participant", text: "The talks" },
      ],
    });
    expect(run.browserKinds().filter((kind) => kind !== "output.audio")).toEqual([
      "output.started",
      "output.ended",
      "input.listening",
      "input.closed",
      "output.started",
      "output.ended",
      "input.listening",
    ]);
  });

  it("cancels the phase's first reply at the node's deadline, starts nothing more and reports nothing", async () => {
    const run = await startLoop([hello, { text: ["Question two? "], hold: true }]);
    await run.open();
    await expect.poll(run.browserKinds).toContain("input.listening");
    const next = nodePhase("Question two", 300);
    await run.run(run.loop.converse(next.phase));

    await expect.poll(() => next.attributed).toHaveLength(1);
    const question = next.attributed[0];
    await expect
      .poll(() => run.browser.at(-1))
      .toEqual({ type: "output.cancelled", outputId: question });
    expect(run.events.at(-1)).toEqual({
      kind: "output_cancelled",
      outputId: question,
      text: "Question two?",
    });
    expect(run.requests).toHaveLength(2);
    // At the interview deadline the phase stops quietly: Runtime's own expiry decides what follows.
    expect(next.refused).toEqual([]);
  });

  it("refuses a node's phase before the conversation opened and after containment", async () => {
    const run = await startLoop([hello]);
    const early = nodePhase("Too early", 5_000);
    await run.run(run.loop.converse(early.phase));
    expect(early.refused).toEqual(["Too early"]);

    await run.open();
    await run.run(run.loop.contain);
    const contained = nodePhase("Contained", 5_000);
    await run.run(run.loop.converse(contained.phase));
    expect(contained.refused).toEqual(["Contained"]);
    expect(run.requests).toHaveLength(1);
  });
});

/**
 * The kit's closing contract. Runtime enters it, for instance, when the interview's time limit
 * is reached: whatever the conversation is doing then, the closing takes over.
 */
describe("Cascade turn-taking loop: closing", () => {
  it("settles the answer in progress once with what was heard, then says the closing sentence with no model request and is done once it is delivered", async () => {
    const run = await startLoop([hello]);
    await run.open();
    await expect.poll(run.browserKinds).toContain("input.listening");
    await run.answering("The talks were clear");
    const { entry, reported } = closing(5_000, "Thank you. Goodbye.");

    await run.run(run.loop.enterClosing(entry));
    await expect.poll(() => reported.done).toHaveLength(1);
    const answers = run.events.filter(({ kind }) => kind === "participant_text_final");
    expect(answers).toEqual([expect.objectContaining({ text: "The talks were clear" })]);
    const [answer] = answers;
    expect(reported.settled).toEqual([
      { kind: "settled", itemId: answer !== undefined && "itemId" in answer ? answer.itemId : "" },
    ]);
    expect(reported.done).toEqual(reported.attributed);
    expect(reported.failed).toEqual([]);
    // The opening was the only model request: speech output is given the sentence itself.
    expect(run.requests).toHaveLength(1);
    expect(run.synthesized.at(-1)).toBe("Thank you. Goodbye.");
    const closingId = String(reported.attributed[0]);
    expect(
      run.events.filter((event) => "outputId" in event && event.outputId === closingId),
    ).toEqual([
      { kind: "output_started", outputId: closingId },
      {
        kind: "reply_generated",
        outputId: closingId,
        outcome: "completed",
        text: "Thank you. Goodbye.",
        toolCalls: [],
      },
      { kind: "delivery_started", outputId: closingId },
      { kind: "delivery_stopped", outputId: closingId, playbackEndsAt: playbackTime },
    ]);
    // The closing accounts for its synthesis only: no language-model usage.
    const closingUsage = run.reported.flatMap((event) =>
      event.kind === "usage"
        ? event.usage.flatMap((entry) =>
            "key" in entry && entry.key.endsWith(closingId) ? [`${entry.status} ${entry.key}`] : [],
          )
        : [],
    );
    expect(closingUsage).toEqual([
      `expected text_to_speech:${closingId}`,
      `satisfied text_to_speech:${closingId}`,
    ]);
    expect(run.browserKinds().filter((kind) => kind !== "output.audio")).toEqual([
      "output.started",
      "output.ended",
      "input.listening",
      "input.closed",
      "output.started",
      "output.ended",
    ]);
  });

  it("settles an open opportunity where nothing was said, with no item", async () => {
    const run = await startLoop([hello]);
    await run.open();
    await expect.poll(run.browserKinds).toContain("input.listening");
    const { entry, reported } = closing(5_000, "Thank you. Goodbye.");

    await run.run(run.loop.enterClosing(entry));
    await expect.poll(() => reported.done).toHaveLength(1);
    expect(reported.settled).toEqual([{ kind: "settled", itemId: null }]);
    expect(run.kinds()).not.toContain("participant_text_final");
  });

  it("cancels the interviewer's speech at entry, then says the closing sentence and is done once it is delivered", async () => {
    const run = await startLoop([
      { text: ["Welcome. ", "What did you think of the "], hold: true },
    ]);
    const opening = await run.open();
    await expect.poll(run.browserKinds).toContain("output.audio");
    const { entry, reported } = closing(5_000, "Thank you. Goodbye.");

    await run.run(run.loop.enterClosing(entry));
    await expect.poll(() => reported.done).toHaveLength(1);
    expect(reported.settled).toEqual([{ kind: "nothing_to_settle" }]);
    // The speech cut short keeps its submitted text; the closing follows it and no listening.
    expect(run.events).toContainEqual({
      kind: "output_cancelled",
      outputId: opening,
      text: "Welcome. What did you think of the",
    });
    const closingId = reported.attributed[0];
    expect(
      run.browser
        .filter(({ type }) => type !== "output.audio")
        .map((message) =>
          "outputId" in message ? `${message.type} ${message.outputId}` : message.type,
        ),
    ).toEqual([
      `output.started ${opening}`,
      `output.cancelled ${opening}`,
      `output.started ${String(closingId)}`,
      `output.ended ${String(closingId)}`,
    ]);
    expect(run.cancelled).toContain("model");
    expect(run.requests).toHaveLength(1);
  });

  it("cancels the closing at its own deadline and fails it with the deadline exceeded", async () => {
    // Each frame takes 200 ms, so the closing's synthesis outlasts its 400 ms deadline.
    const run = await startLoop([hello], { frameIntervalMs: 200 });
    await run.open();
    await expect.poll(run.browserKinds, { timeout: 3_000 }).toContain("input.listening");
    const { entry, reported } = closing(400, "Thank you. Goodbye.");
    const enteredAt = Date.now();

    await run.run(run.loop.enterClosing(entry));
    await expect.poll(() => reported.failed, { timeout: 3_000 }).toHaveLength(1);
    const failedAfter = Date.now() - enteredAt;
    expect(failedAfter).toBeGreaterThanOrEqual(350);
    expect(failedAfter).toBeLessThan(1_500);
    const closingId = reported.attributed[0];
    expect(reported.failed).toEqual([
      { failure: { kind: "deadline_exceeded" }, outputId: closingId },
    ]);
    expect(reported.done).toEqual([]);
    // Its synthesis and the closing in the browser are cancelled; the sentence was its text.
    expect(run.cancelled).toContain("synthesis");
    expect(run.events).toContainEqual(
      expect.objectContaining({ kind: "reply_generated", text: "Thank you. Goodbye." }),
    );
    expect(run.browser.at(-1)).toEqual({ type: "output.cancelled", outputId: closingId });
  });

  it("fails the closing, not the conversation, when its synthesis fails", async () => {
    const run = await startLoop([hello], {
      synthesisFailure: { text: "Thank you. Goodbye.", code: "speech_down" },
    });
    await run.open();
    await expect.poll(run.browserKinds).toContain("input.listening");
    const { entry, reported } = closing(5_000, "Thank you. Goodbye.");

    await run.run(run.loop.enterClosing(entry));
    await expect.poll(() => reported.failed).toHaveLength(1);
    expect(reported.failed).toEqual([
      { failure: { kind: "failure", code: "speech_down" }, outputId: reported.attributed[0] },
    ]);
    expect(run.kinds()).not.toContain("failed");
  });

  it("refuses a closing whose deadline already passed, and any closing after containment", async () => {
    const run = await startLoop([hello]);
    const late = closing(-1, "Thank you. Goodbye.");
    await run.run(run.loop.enterClosing(late.entry));
    expect(late.reported.failed).toEqual([
      { failure: { kind: "deadline_exceeded" }, outputId: undefined },
    ]);

    await run.run(run.loop.contain);
    const contained = closing(5_000, "Thank you. Goodbye.");
    await run.run(run.loop.enterClosing(contained.entry));
    expect(contained.reported.failed).toEqual([
      { failure: { kind: "interrupted" }, outputId: undefined },
    ]);
    expect(run.synthesized).toEqual([]);
  });
});

describe("Cascade turn-taking loop: input closure", () => {
  it("answers settled, with the answer's item, once the answer's text was reported", async () => {
    const run = await startLoop([hello]);
    await run.open();
    await expect.poll(run.browserKinds).toContain("input.listening");
    await run.answering("The talks were clear");

    const settlement = await Effect.runPromise(run.loop.closeInput);
    const answers = run.events.filter(({ kind }) => kind === "participant_text_final");
    expect(answers).toEqual([expect.objectContaining({ text: "The talks were clear" })]);
    const [answer] = answers;
    expect(settlement).toEqual({
      kind: "settled",
      itemId: answer !== undefined && "itemId" in answer ? answer.itemId : "",
    });
  });

  it("answers nothing to settle when the open opportunity recognized nothing", async () => {
    const run = await startLoop([hello]);
    await run.open();
    await expect.poll(run.browserKinds).toContain("input.listening");

    expect(await Effect.runPromise(run.loop.closeInput)).toEqual({ kind: "nothing_to_settle" });
    expect(run.kinds()).not.toContain("participant_item_started");
  });

  it("answers nothing to settle when no opportunity is open", async () => {
    const run = await startLoop([{ text: ["Hello. "], hold: true }]);
    await run.open();
    await expect.poll(run.browserKinds).toContain("output.audio");

    expect(await Effect.runPromise(run.loop.closeInput)).toEqual({ kind: "nothing_to_settle" });
  });
});

describe("Cascade turn-taking loop: output", () => {
  it("stops the output in flight and starts no other", async () => {
    const run = await startLoop([{ text: ["Hello. "], hold: true }]);
    const opening = await run.open();
    await expect.poll(run.browserKinds).toContain("output.audio");

    await run.run(run.loop.stopOutput);
    expect(run.events.at(-1)).toEqual({
      kind: "output_cancelled",
      outputId: opening,
      text: "Hello.",
    });
    expect(run.browser.at(-1)).toEqual({ type: "output.cancelled", outputId: opening });
    expect(run.cancelled).toContain("model");
    expect(run.requests).toHaveLength(1);
  });
});

/** One usage entry the stand-ins report, naming their model. */
function entry(
  componentRole: string,
  provider: string,
  measure: string,
  unit: string,
  quantity: number,
) {
  return { componentRole, provider, model: standInModel, measure, unit, quantity };
}
