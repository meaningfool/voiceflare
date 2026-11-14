import {
  Cause,
  Clock,
  Data,
  Deferred,
  Effect,
  Fiber,
  Queue,
  Schedule,
  Stream,
  SubscriptionRef,
} from "effect";
import type { z } from "zod";
import {
  decodeRealtimeSessionSettings,
  realtimeUsageModels,
  summarizePreparedModelSession,
  type PreparedModelSession,
} from "./preparedModelSession.ts";
import type { RealtimeUsageModels } from "./usage.ts";
import { executionDiagnostics } from "./diagnostics.ts";
import { exactProviderCallHangup, type CallHangupOutcome } from "./callHangup.ts";
import { acquireSideband } from "./sidebandAcquisition.ts";
import { superviseRetained } from "../../runtime/nativeWorkOwner.ts";
import { RealtimeInputClosure } from "./inputClosure.ts";
import { RealtimeClosing } from "./closing.ts";
import { RealtimeConversing } from "./conversing.ts";
import { decodeRealtimeReceipt, type RealtimeReceipt } from "./receipts.ts";
import type { RealtimeEndingCommand } from "./providerOperations.ts";
import {
  clockedDiagnostics,
  listenToSideConnection,
  type SideConnectionEvent,
} from "./sideConnectionEvents.ts";
import {
  ProviderIdentityPersistenceError,
  RealtimeDriver,
  summarizeProviderMessageReceipt,
  type RealtimeDriverLayer,
  type ProviderCallIdentity,
  type ProviderSocketEvent,
  type ProviderWebSocket,
  type RealtimeCallRequest,
  type RealtimeProviderDriver,
  type RealtimeSidebandRequest,
} from "./openaiRealtimeDriver.ts";
import { redactSecrets } from "../../shared/http.ts";
import type { DiagnosticContributor } from "../../runtime/diagnosticContracts.ts";
import type { ExecutionBridge } from "../../runtime/runtimeHostAssembly.ts";
import type { ConversationStates, DetachedReadonly } from "../../runtime/conversationContracts.ts";
import type { ConversationNodeDispatch } from "../../runtime/implementationContracts.ts";
import type { SemanticReport } from "../../runtime/executionContracts.ts";
import type {
  PreparedClosing,
  PreparedConversationNode,
} from "../../runtime/nodeContentContracts.ts";
import {
  providerFailureText,
  type ProviderFailureOutcome,
} from "../../runtime/providerOutcomes.ts";
import type {
  InputClosureSettlement,
  ProviderObservationOrder,
} from "../../runtime/interviewFinalizationModel.ts";
import { runtimeReport, type RealtimeObservation } from "./speech.ts";
import { decodeRealtimeExecutionState } from "./executionState.ts";
import type { RealtimeResultWarning } from "./warnings.ts";
import type {
  EndingOperation,
  EndingOperationDispatch,
  SessionReleaseAnswer,
  ProviderObservationPersistence,
  ProviderReceiptPrefix,
  ProviderSessionApplicationFact,
  ProviderSessionBackgroundWork,
  ProviderSessionEvents,
  ProviderSessionRecord,
  ProviderSessionStorage,
} from "../../runtime/nativeContracts.ts";
import type { RuntimeEventPayload } from "../../runtime/runtimeEvents.ts";
import { gateTestOptionsRecord, type GateSessionOptions } from "../../runtime/gateTestOptions.ts";

class ConnectionTaskFailure extends Data.TaggedError("ConnectionTaskFailure")<{
  cause: Cause.Cause<unknown>;
}> {}
/** A Runtime handoff of one message that failed: its normalization, its records or its report. */
class HandoffFailed extends Data.TaggedError("HandoffFailed")<{ cause: unknown }> {}

const reconnectDelayMs = 1_000;
const heartbeatInterval = "15 seconds";
const providerName = "openai_realtime";
/** The type a supplied reply's items name in their diagnostic summary; no provider sends it. */
const suppliedReplyType = "runtime.reply_supplied";

/** A report that Runtime's application sink rejected, with the rejection's cause. */
export class SinkRejected extends Data.TaggedError("SinkRejected")<{ cause: unknown }> {}
/** Runtime's application sink as the session awaits it. */
export type RealtimeSessionSink = (
  fact: ProviderSessionApplicationFact,
) => Effect.Effect<void, SinkRejected>;
/**
 * Runtime's storage of the session's record. The call's identity and answer are written
 * asynchronously, and the session awaits them as Effects; a refused write is the identity's
 * persistence failure.
 */
export type RealtimeSessionStorage = Omit<
  ProviderSessionStorage,
  "recordSessionIdentity" | "recordSessionReply"
> &
  Readonly<{
    recordSessionIdentity(
      input: Parameters<ProviderSessionStorage["recordSessionIdentity"]>[0],
    ): Effect.Effect<void, ProviderIdentityPersistenceError>;
    recordSessionReply(
      input: Parameters<ProviderSessionStorage["recordSessionReply"]>[0],
    ): Effect.Effect<void, ProviderIdentityPersistenceError>;
  }>;
/** A report whose rejection is a defect of its caller, with the rejection's own cause. */
function reportOrDie(report: Effect.Effect<void, SinkRejected>): Effect.Effect<void> {
  return Effect.catchTag(report, "SinkRejected", ({ cause }) => Effect.die(cause));
}
/**
 * A dispatched node's reports as the session's node work makes them. `onComplete` and
 * `onFailure` are Effects that await Runtime's receipt; `failNow` starts a failure report from a
 * synchronous path, such as a receipt's observation, without awaiting it.
 */
export type RealtimeNodeReports = Readonly<{
  onComplete(report: SemanticReport<unknown>): Effect.Effect<void>;
  onFailure(reason: string, responseId?: string): Effect.Effect<void>;
  failNow(reason: string): void;
}>;

/**
 * What the session works with: Runtime's capabilities, in the Effects the kit's Runtime adapter
 * (`runtimeSession.ts`) makes of them, and the Realtime driver as a service: OpenAI's, or a
 * test's version of it (`testing/testDriver.ts`).
 */
export type RealtimeSessionInput = Readonly<{
  apiKey: string;
  providerFeasible?: boolean;
  driver: RealtimeDriverLayer;
  hangupTimeoutSetting?: string | undefined;
  storage: RealtimeSessionStorage;
  events: ProviderSessionEvents;
  backgroundWork: ProviderSessionBackgroundWork;
  sink: RealtimeSessionSink;
  execution: Pick<ExecutionBridge, "run" | "supervise">;
  issueSink?: (runId: string, generation: number) => RealtimeSessionSink;
}>;

/** The session's creation of its OpenAI call: the call's identity and SDP answer, or why not. */
export type ProviderCallCreationResult =
  | Readonly<{
      ok: true;
      answerSdp: string;
      sessionId: string;
      sessionLocation: string | null;
      upstreamRequestId: string | null;
      settingsSummary: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{ ok: false; error: string; reason: string }>;

/** The call the session creates for the browser's SDP offer. */
export type RealtimeCallInput = Readonly<{
  runId: string;
  sdp: string;
  session: PreparedModelSession;
  settingsSummary: Readonly<Record<string, unknown>>;
  deadlineAt?: number;
}>;

type StateName<S extends ConversationStates> = Extract<keyof S, string>;
type StateInput<S extends ConversationStates, State extends StateName<S>> = DetachedReadonly<
  z.output<S[State]["input"]>
>;

/**
 * The kit operation that carries one Conversation state the session enters, and its settings:
 * the state's content from its Conversation module, which is what the model receives there.
 *
 * - `conversing`: a conversing phase (`conversing.ts`), such as a later question. Its literal
 *   instructions and its tools reach the model by session update.
 * - `closing`: the closing (`closing.ts`), such as Goodbye. Its content is the closing
 *   sentence, which its reply repeats with no history and no tool; `completed` turns the
 *   delivered closing reply's id into the state's completion event, such as `goodbye_completed`.
 */
export type RealtimeNode<Input, Event> =
  | Readonly<{ operation: "conversing"; content(input: Input): PreparedConversationNode }>
  | Readonly<{
      operation: "closing";
      content(input: Input): PreparedClosing;
      completed(responseId: string): Event;
    }>;

/**
 * A Realtime pair's configuration of the kit's session, a value: the state the session opens
 * with and its content, which call creation prepares, and, for each Conversation state the
 * session enters, the kit operation that carries it. A state the session never enters, such as
 * the opening state or one that keeps the output that entered it, has no node. Finishing, when
 * input closes and nothing else is entered, is the kit's default: the reply in progress plays to
 * its end. `gate` holds the voice Gate's test options when a local Runtime applies them
 * (`GateSessionOptions`): the call and each conversing node then carry no tools and no tool
 * choice, and a supplied reply answers the opening phase's first participant turn.
 */
export type RealtimeSessionConfiguration<S extends ConversationStates> = Readonly<{
  gate?: GateSessionOptions;
  opening: {
    [State in StateName<S>]: Readonly<{
      state: State;
      content(input: StateInput<S, State>): PreparedConversationNode;
    }>;
  }[StateName<S>];
  nodes: {
    readonly [State in StateName<S>]?: RealtimeNode<
      StateInput<S, State>,
      z.output<S[State]["event"]>
    >;
  };
}>;

/**
 * Where the session's nodes are, one named state at a time:
 *
 * - `conversing`: the conversation goes on in the opening phase or the last node entered;
 * - `entering`: the node-entry task enters a node of that kind for that operation;
 * - `closing`: the closing for that operation was entered and its reply created;
 * - `contained`: node work was contained, after a closing was entered or not, and no node acts.
 *   Runtime's containment (`by: "runtime"`: Stop, a failed node, Ending) lasts for the rest of
 *   the Run. The end of the generation that served the nodes (`by: "generation"`) lasts until
 *   the next generation connects, which resumes the conversation unless a closing was entered.
 *
 * Until a closing is entered, an interviewer reply that fails ends the interview
 * (`#replyFailure`); a closing decides its own reply's outcome.
 */
type NodeState =
  | Readonly<{ _tag: "conversing" }>
  | Readonly<{ _tag: "entering"; kind: "conversing" | "closing"; operation: string }>
  | Readonly<{ _tag: "closing"; operation: string; reply: string }>
  | Readonly<{ _tag: "contained"; by: "runtime" | "generation"; afterClosing: boolean }>;

/** OpenAI's statuses of an interviewer reply it ended without completing it. */
const unfinishedReplyStatuses: ReadonlySet<string> = new Set(["failed", "incomplete", "cancelled"]);

/** One connection generation: the side connection acquired for one generation number. */
type Generation = {
  readonly record: ProviderSessionRecord;
  /** The Realtime driver its connection was acquired with, which reads and commands it. */
  readonly driver: RealtimeProviderDriver;
  /** The models its usage entries name, from the Run's stored settings; none when unreadable. */
  readonly usageModels: RealtimeUsageModels | undefined;
  readonly number: number;
  readonly sessionId: string;
  readonly sink: RealtimeSessionSink;
  readonly startedAt: number;
  /** Its connection items, in arrival order, for the events task. */
  readonly items: Queue.Queue<ConnectionItem>;
  /** Completed when the generation is retired while it acquires its connection. */
  readonly retirement: Deferred.Deferred<void>;
  /** Completed when its task ended, failed when the task failed. */
  readonly ended: Deferred.Deferred<void, ConnectionTaskFailure>;
  /** The sequence of the last message whose Runtime handoff completed. */
  readonly handedOff: SubscriptionRef.SubscriptionRef<number>;
  /**
   * The receipts: the evidence received and the evidence processed, as Runtime reads them, and
   * the sequence of the last message queued for Runtime, which `drain` waits for.
   */
  readonly receipts: {
    received: ProviderObservationOrder | null;
    processed: ProviderObservationOrder | null;
    queued: number | null;
  };
  eventCount: number;
  readonly eventTypeCounts: Record<string, number>;
  readonly providerEventIds: Set<string>;
  /** Set once its observed close was reported, with whether a reconnection was scheduled. */
  closeReported: Readonly<{ reconnectScheduled: boolean }> | null;
  /** Set once its connection failed and that failure was reported: its close reports nothing. */
  failureReported: boolean;
};

/**
 * The connection, one named state at a time. A generation's task runs from `connecting` until
 * it ends; `closing` and `retired` keep it until then, and its end leaves `disconnected`,
 * `closed` or `retired` without a generation.
 */
type Connection =
  | Readonly<{ _tag: "awaiting_call" }>
  | Readonly<{ _tag: "connecting"; generation: Generation }>
  | Readonly<{ _tag: "connected"; generation: Generation; socket: ProviderWebSocket }>
  | Readonly<{
      _tag: "closing";
      generation: Generation;
      reason: string;
      socket: ProviderWebSocket | null;
    }>
  | Readonly<{
      _tag: "retired";
      generation: Generation | null;
      reason: string;
      socket: ProviderWebSocket | null;
    }>
  | Readonly<{ _tag: "disconnected"; generation: number; reconnectScheduled: boolean }>
  | Readonly<{ _tag: "closed"; reason: string }>;

/** What the events task takes, in arrival order. */
type ConnectionItem =
  | Readonly<{
      kind: "message";
      message: ProviderSocketEvent;
      sequence: number;
      observedAt: number;
      normalized: RealtimeObservation | null;
      providerEvent: ReturnType<RealtimeProviderDriver["normalizeEvent"]> | undefined;
      excludedParticipantInput: true | undefined;
      /** A warning for the Run's result that this message carries, reported before it. */
      resultWarning:
        | Extract<
            RealtimeResultWarning,
            "final_input_may_be_incomplete" | "ambiguous_final_activity"
          >
        | undefined;
      /** The failure of the interviewer reply this message ended, reported after its handoff. */
      replyFailure: string | undefined;
      /**
       * The Gate's supplied reply, numbered after the message that ended the turn it answers:
       * it came from no provider message, so it records no provider event.
       */
      supplied?: true;
    }>
  | Readonly<{ kind: "close"; reason: string; observed: false }>
  | Readonly<{ kind: "close"; reason: string; observed: true; at: number; code?: number }>
  | Readonly<{ kind: "defect"; defect: unknown }>;

/**
 * The Realtime kit's session, one per Run, shared by every Realtime pair. It holds:
 *
 * 1. the connection to OpenAI: the call's creation and its identity's persistence, one side
 *    connection per generation, the side connection's events handed to Runtime in order,
 *    reconnection (scheduled 1 s after a close Runtime still needs the connection for), a
 *    heartbeat every 15 s and the call's hang-up;
 * 2. the participant input closure (`inputClosure.ts`), which the session feeds every fresh
 *    observation and whose final-answer commit Ending and a closing node share;
 * 3. node entry, as the pair's configuration (`RealtimeSessionConfiguration`) names it: the
 *    opening and each node of the conversing kind through the conversing phase
 *    (`conversing.ts`), a closing through the closing (`closing.ts`), and finishing by default;
 *    containment, which fences node work for the rest of the Run when Runtime contains it and
 *    until the next generation connects when a generation ends; and the end of every failed
 *    interviewer reply, which ends the interview;
 * 4. Ending's translation: `sendFinalizationOperation` maps Runtime's operations to OpenAI
 *    commands through the driver, the commit through the input closure.
 *
 * Every task it starts runs in the Run's native work owner's Scope, kept alive by
 * `superviseRetained`: a generation's connection with its heartbeat and its events, the call's
 * creation and the node-entry task. Closing the owner interrupts them, and a generation's
 * finalizers remove its listeners and release its side connection. The session's state is one
 * value per concern: the connection (`Connection`), the nodes (`NodeState`), the input
 * closure's state and each generation's receipts; durable facts stay in Runtime's storage.
 *
 * Runtime calls in through `runtimeSession.ts`, the only module that speaks Runtime's session
 * contract.
 */
export class RealtimeSession<S extends ConversationStates> {
  readonly input = new RealtimeInputClosure();
  readonly #config: RealtimeSessionInput;
  readonly #configuration: RealtimeSessionConfiguration<S>;
  readonly #diagnostic: DiagnosticContributor<typeof executionDiagnostics>;
  readonly #conversing = new RealtimeConversing((responseId) =>
    this.#diagnostic(
      "realtime.reply_cut",
      { source: "realtime_execution", provider: providerName, responseId },
      { responseId },
    ),
  );
  readonly #closing = new RealtimeClosing(this.input);
  #connection: Connection = { _tag: "awaiting_call" };
  #nodes: NodeState = { _tag: "conversing" };
  /** The node-entry task: the entered node's work, until it ends or a later node replaces it. */
  #nodeEntry: Fiber.Fiber<void> | null = null;
  /** Replies Ending cancelled, which are not failures. */
  readonly #cancelledReplies = new Set<string>();
  /** The command id of Ending's stop of output, once sent: no new reply starts after it. */
  #outputStoppedBy: string | null = null;
  /** Replies that stopped output cancelled as they started; Ending's own cancel is not resent. */
  readonly #stoppedReplies = new Set<string>();
  /** Replies whose end (`response.done`) was received and judged; Ending cancels none of them. */
  readonly #endedReplies = new Set<string>();
  /**
   * Whether the participant's uncommitted speech is kept in Runtime's durable storage for
   * executions, so that a closing entered after a Runtime restart still settles it; null until
   * the session read it back.
   */
  #keptInputBuffered: boolean | null = null;
  /** Whether Ending's input-closure step closed participant input. */
  #endingClosedInput = false;
  /** Whether the participant is speaking: their speech started and has not stopped. */
  #speaking = false;
  /** Whether Runtime asked to release the session: a close from then on is expected. */
  #released = false;
  /** Whether OpenAI closed the session, or rejected the call as gone: it is known closed. */
  #sessionClosed = false;
  /** Whether the side connection closed unexpectedly: events it would carry may be missing. */
  #eventsMayBeMissing = false;
  /**
   * Whether the side connection was open when Runtime restarted, as the kit kept it, and no
   * connection opened since: the events it carried meanwhile may be missing.
   */
  #restoredOpen = false;
  /** Whether a side connection is open, as last kept in Runtime's durable storage. */
  #keptSideConnectionOpen = false;
  /**
   * The Gate's supplied reply while it is still due: it answers the first participant turn the
   * opening phase commits, before any node was entered, once. Only the instance that created
   * the call holds it, so a session restored after a Runtime restart supplies none.
   */
  #suppliedReply: Readonly<{ toolName: string }> | null = null;

  constructor(input: RealtimeSessionInput, configuration: RealtimeSessionConfiguration<S>) {
    this.#config = input;
    this.#configuration = configuration;
    this.#diagnostic = input.events.executionDiagnostics(executionDiagnostics);
  }

  get connected(): boolean {
    return socketOf(this.#connection) !== null;
  }
  /** Whether a generation's task is running. */
  get connecting(): boolean {
    return generationOf(this.#connection) !== null;
  }
  get feasible(): boolean {
    return this.#config.providerFeasible ?? this.#config.apiKey.length > 0;
  }

  /**
   * Enters a dispatched Conversation state with the kit operation the pair's configuration names
   * for it, as the node-entry task; a node entered while an earlier one still runs replaces its
   * task. A state with no node is not the session's to enter. Without an open connection the
   * node fails at once. Its reports go through `reports`, not the dispatch's own.
   */
  enterNode<State extends StateName<S>>(
    input: ConversationNodeDispatch<S, State>,
    reports: RealtimeNodeReports,
  ): void {
    const node: RealtimeNode<StateInput<S, State>, z.output<S[State]["event"]>> | undefined =
      this.#configuration.nodes[input.state];
    if (node === undefined) throw new Error("native_node_unavailable");
    const connection = this.#connection;
    if (connection._tag !== "connected") {
      reports.failNow("goodbye_sideband_unavailable");
      return;
    }
    const { socket } = connection;
    const operation = input.identity.operationId;
    // The opening phase is over: its supplied reply is no longer due.
    this.#suppliedReply = null;
    this.#retain(
      Promise.resolve().then(() =>
        this.#config.events.notifyControl("sideband.goodbye_started", {
          runId: input.identity.runId,
          operationId: operation,
        }),
      ),
    );
    if (this.#nodes._tag !== "contained")
      this.#nodes = { _tag: "entering", kind: node.operation, operation };
    if (node.operation === "conversing") {
      this.#runNodeEntry(
        this.#conversing
          .enter(
            {
              dispatch: { ...input, ...reports },
              content: this.#configuration.gate?.noTools
                ? { ...node.content(input.input), tools: [] }
                : node.content(input.input),
              settings: this.#config.storage.read()?.preparedSettings,
            },
            socket,
          )
          .pipe(
            // The node is done: the conversation goes on in it.
            Effect.ensuring(
              Effect.sync(() => {
                const nodes = this.#nodes;
                if (nodes._tag === "entering" && nodes.operation === operation)
                  this.#nodes = { _tag: "conversing" };
              }),
            ),
          ),
      );
      return;
    }
    this.#runNodeEntry(
      this.#closing.enter(
        {
          dispatch: {
            ...input,
            ...reports,
            observeOutputIdentity: (responseId, originatingResponseId) => {
              const nodes = this.#nodes;
              if (
                (nodes._tag === "entering" || nodes._tag === "closing") &&
                nodes.operation === operation
              )
                this.#nodes = { _tag: "closing", operation, reply: responseId };
              input.observeOutputIdentity?.(responseId, originatingResponseId);
            },
          },
          content: node.content(input.input),
          report: (responseId) => input.reporter.report(node.completed(responseId)),
        },
        socket,
      ),
    );
  }

  /** Runtime contains node work for the rest of the Run, as `#contain` describes. */
  containNodes(): void {
    this.#contain("runtime");
  }

  /**
   * Contains node work with the side connection the session holds, if any: the closing and the
   * conversing phase are fenced, every wait of the entered node fails, so its task ends sending
   * nothing more, and no node acts until the containment lifts (`NodeState`). A node being
   * entered also has its replies in flight cancelled and their output cleared; outside a node's
   * entry, the replies in progress are Ending's to cancel. Runtime's containment is never
   * narrowed to a generation's.
   */
  #contain(by: "runtime" | "generation"): void {
    const nodes = this.#nodes;
    const socket = socketOf(this.#connection);
    this.#nodes = {
      _tag: "contained",
      by: nodes._tag === "contained" && nodes.by === "runtime" ? "runtime" : by,
      afterClosing: closingEntered(nodes),
    };
    this.#closing.contain(socket);
    this.#conversing.contain(
      nodes._tag === "entering" && nodes.kind === "conversing" ? socket : null,
    );
  }

  /**
   * The end of `generation` contains its node work, unless a later generation already holds the
   * connection: a retired generation contained its own when it was retired (`#retire`).
   */
  #containGeneration(generation: Generation): void {
    if (generationOf(this.#connection) === generation) this.#contain("generation");
  }

  /**
   * A new generation holds the connection: node work that an earlier generation's end contained
   * resumes, and the conversation goes on in the opening phase or the last node entered. A node
   * whose entry that end interrupted is not entered again, and a contained closing stays so.
   */
  #resumeNodes(): void {
    const nodes = this.#nodes;
    if (nodes._tag !== "contained" || nodes.by !== "generation" || nodes.afterClosing) return;
    this.#nodes = { _tag: "conversing" };
    this.#conversing.resume();
    this.#closing.resume();
  }

  /** Runs node work as the node-entry task, replacing the task of a node entered earlier. */
  #runNodeEntry(entry: Effect.Effect<void>): void {
    const previous = this.#nodeEntry;
    this.#nodeEntry = superviseRetained(
      this.#config.execution,
      this.#config.backgroundWork,
      previous === null ? entry : Effect.andThen(Fiber.interrupt(previous), entry),
    );
  }

  /** Keeps a task of the node's reports alive until it settles. */
  #retain(task: Promise<unknown>): void {
    this.#config.backgroundWork.waitUntil(task);
  }

  /**
   * The failure to report for a fresh receipt, if it ends an interviewer reply that failed: OpenAI
   * ended it as failed or incomplete, or cancelled it without the session asking. A reply the
   * session cancelled itself (Ending's cancel, the conversing phase's) is not a failure, nor is
   * any reply once a closing was entered, which decides its own reply's outcome. Each reply's end
   * is judged once.
   */
  #replyFailure(receipt: RealtimeReceipt): string | undefined {
    if (receipt.type !== "response.done") return undefined;
    const id = receipt.response?.id;
    const status = receipt.response?.status;
    if (id === undefined || status === undefined || this.#endedReplies.has(id)) return undefined;
    this.#endedReplies.add(id);
    if (
      !unfinishedReplyStatuses.has(status) ||
      closingEntered(this.#nodes) ||
      this.#cancelledReplies.has(id) ||
      this.#conversing.cancelled(id)
    )
      return undefined;
    return `interviewer_response_${status}`;
  }

  /**
   * Creates the OpenAI call for the browser's offer and persists its identity as soon as the
   * driver observes it. Duplicate observations share one persistence, which outlives a caller
   * that stopped waiting; a refused or failed creation is the call's typed failure result.
   * Under the Gate's options the call's session is `gateCallSession`'s, and the session records
   * the options it applies.
   */
  createCall(input: RealtimeCallInput): Effect.Effect<ProviderCallCreationResult> {
    const self = this;
    const { storage, execution, backgroundWork, apiKey } = this.#config;
    const gate = this.#configuration.gate;
    const session = gateCallSession(input.session, gate);
    if (gate !== undefined) {
      this.#suppliedReply = gate.suppliedReply;
      this.#diagnostic("gate.test_options", gateTestOptionsRecord(gate));
    }
    let identified: ProviderCallIdentity | null = null;
    let persisted: Deferred.Deferred<void, ProviderIdentityPersistenceError> | null = null;
    let fallbackCleanup: Effect.Effect<SessionReleaseAnswer> | null = null;
    const recordIdentity = (identity: ProviderCallIdentity) =>
      storage
        .recordSessionIdentity({
          runId: input.runId,
          sessionId: identity.sessionId,
          sessionLocation: identity.sessionLocation,
          upstreamRequestId: identity.upstreamRequestId,
          settingsSummary: summarizePreparedModelSession(session),
        })
        .pipe(
          Effect.tap(() =>
            Effect.sync(() =>
              self.#diagnostic("realtime.call_identified", {
                source: "realtime_execution",
                phase: "setup",
                provider: providerName,
                sessionId: identity.sessionId,
                upstreamRequestId: identity.upstreamRequestId,
              }),
            ),
          ),
          Effect.catchTag("ProviderIdentityPersistenceError", (error) =>
            Effect.gen(function* () {
              // A committed identity already belongs to durable failed-start cleanup.
              // Otherwise retain one bounded cleanup attempt for the known exact call.
              const current = storage.read();
              if (current?.runId !== input.runId || current.sessionId !== identity.sessionId) {
                if (fallbackCleanup === null)
                  fallbackCleanup = yield* Effect.cached(
                    exactProviderCallHangup(self.exactCall(identity.sessionId)),
                  );
                yield* fallbackCleanup;
              }
              return yield* error;
            }),
          ),
        );
    // Admits the identity before any asynchronous storage or alarm work; duplicate
    // observations share this handoff, including when the original caller stopped waiting.
    const persistIdentity = (
      identity: ProviderCallIdentity,
    ): Effect.Effect<void, ProviderIdentityPersistenceError> =>
      Effect.gen(function* () {
        if (identified !== null) {
          if (identified.sessionId !== identity.sessionId)
            return yield* Effect.die(new Error("session_identity_conflict"));
          if (persisted !== null) return yield* Deferred.await(persisted);
        }
        identified = identity;
        const handoff = yield* Deferred.make<void, ProviderIdentityPersistenceError>();
        persisted = handoff;
        // A late identity of a Run whose owner is already gone must still reach durable
        // failed-start cleanup: the bridge runs it without an owner, where supervision would
        // start nothing.
        yield* Effect.sync(() =>
          backgroundWork.waitUntil(
            execution.run(
              Effect.uninterruptible(
                recordIdentity(identity).pipe(
                  // A failed handoff lets a later observation of the same call retry it.
                  Effect.tapError(() =>
                    Effect.sync(() => {
                      if (persisted === handoff) persisted = null;
                    }),
                  ),
                  Effect.exit,
                  Effect.flatMap((exit) => Deferred.done(handoff, exit)),
                ),
              ),
            ),
          ),
        );
        return yield* Deferred.await(handoff);
      });
    // The driver reports the identity from its native continuation, which awaits this promise;
    // persistence failure stays typed.
    const identifyCall = (identity: ProviderCallIdentity): Promise<void> =>
      execution
        .run(
          persistIdentity(identity).pipe(
            Effect.as(undefined),
            Effect.catchTag("ProviderIdentityPersistenceError", (error) => Effect.succeed(error)),
          ),
        )
        .then((failure) => {
          if (failure !== undefined) throw failure;
        });
    const failed = (error: string, reason: string): ProviderCallCreationResult => ({
      ok: false,
      error,
      reason,
    });
    return Effect.gen(function* () {
      const driver = yield* RealtimeDriver;
      let callInput: RealtimeCallRequest = {
        apiKey,
        sdp: input.sdp,
        session,
        onCallIdentified: identifyCall,
        retainCallIdentity: (task) => backgroundWork.waitUntil(task),
      };
      if (input.deadlineAt !== undefined)
        callInput = { ...callInput, deadlineAt: input.deadlineAt };
      const upstream = yield* driver.createCall(callInput);
      if (!upstream.ok)
        return failed("provider_call_failed", providerFailureText(upstream.failure));
      const sessionId = upstream.value.sessionId;
      if (sessionId === null)
        return failed("provider_call_missing_call_id", "provider_call_missing_call_id");
      yield* persistIdentity({
        status: upstream.value.status,
        responseContentType: upstream.value.responseContentType,
        sessionLocation: upstream.value.sessionLocation,
        sessionId,
        upstreamRequestId: upstream.value.upstreamRequestId,
      });
      const answerSdp = redactSecrets(upstream.value.answerSdp);
      yield* storage.recordSessionReply({
        runId: input.runId,
        sessionId,
        reply: { sdp: answerSdp },
      });
      self.#config.events.notifyControl("runtime.call_created", {
        sessionId,
        upstreamRequestId: upstream.value.upstreamRequestId,
      });
      self.#diagnostic("realtime.call_recorded", {
        source: "realtime_execution",
        phase: "setup",
        provider: providerName,
        sessionId,
        upstreamRequestId: upstream.value.upstreamRequestId,
        settingsSummary: summarizePreparedModelSession(session),
      });
      const created: ProviderCallCreationResult = {
        ok: true,
        answerSdp,
        sessionId,
        sessionLocation: upstream.value.sessionLocation,
        upstreamRequestId: upstream.value.upstreamRequestId,
        settingsSummary: summarizePreparedModelSession(session),
      };
      return created;
    }).pipe(
      // The declared persistence failure is the provider call's typed failure.
      Effect.catchTag("ProviderIdentityPersistenceError", (error) =>
        Effect.succeed(
          failed("provider_call_failed", `provider_call_request_failed:${error.message}`),
        ),
      ),
      Effect.provide(this.#config.driver),
    );
  }

  /** The exact-call hang-up of `sessionId`, bounded by `timeoutCapMs` when given. */
  exactCall(sessionId: string | null, timeoutCapMs?: number) {
    const { driver, apiKey, hangupTimeoutSetting } = this.#config;
    return {
      sessionId,
      feasible: this.feasible,
      apiKey,
      hangupTimeoutSetting,
      timeoutCapMs,
      driver,
    };
  }

  /** Ending's release of the call: its hang-up, whose outcome the kit records as it settles. */
  releaseCall(sessionId: string | null, timeoutCapMs?: number) {
    return {
      ...this.exactCall(sessionId, timeoutCapMs),
      onOutcome: (outcome: CallHangupOutcome) => this.#recordReleaseOutcome(outcome),
    };
  }

  /** What the hang-up achieved, and how confident the kit is that the session closed. */
  #recordReleaseOutcome(outcome: CallHangupOutcome): void {
    const result = classifyHangupOutcome(outcome);
    if (result === null) return;
    this.#diagnostic("realtime.close_finished", {
      source: "realtime_execution",
      provider: providerName,
      result,
      status:
        typeof outcome.status === "number" && Number.isFinite(outcome.status)
          ? outcome.status
          : undefined,
      code: readOptionalString(outcome.code),
    });
    this.#diagnostic(
      "realtime.closure_confidence",
      outcome.code === "provider_session_already_closed"
        ? {
            source: "realtime_execution",
            provider: providerName,
            confidence: "confirmed",
            basis: "documented_terminal_hangup_evidence",
          }
        : outcome.ok && outcome.status !== null && outcome.status !== 404
          ? {
              source: "realtime_execution",
              provider: providerName,
              confidence: "teardown_initiated_unconfirmed",
              basis: "hangup_acknowledged",
            }
          : {
              source: "realtime_execution",
              provider: providerName,
              confidence: "unconfirmed",
              basis: "hangup_not_confirmed",
            },
    );
  }

  /**
   * Keeps one connection generation for the Run's recorded call. A running generation that
   * still serves the record is kept; one that no longer does is retired, and a new generation
   * starts when Runtime requires the connection.
   */
  ensureConnected(sessionId: string): void {
    const { storage } = this.#config;
    const record = storage.read();
    const existing = liveGeneration(this.#connection);
    if (existing !== null) {
      if (
        record?.runId === existing.record.runId &&
        record.sessionId === existing.record.sessionId &&
        record.generation <= existing.number &&
        (socketOf(this.#connection) !== null || record.connectionRequired) &&
        record.retired !== true
      )
        return;
      this.#retireNow(existing);
    }
    if (
      !this.feasible ||
      record === null ||
      record.sessionId !== sessionId ||
      !record.connectionRequired ||
      record.retired === true
    )
      return;
    superviseRetained(
      this.#config.execution,
      this.#config.backgroundWork,
      this.#connect(record, sessionId),
    );
  }

  /** Retires the running generation once the record no longer needs it. */
  reconcileLifetime(): void {
    const generation = liveGeneration(this.#connection);
    if (generation === null) return;
    let record: ProviderSessionRecord | null;
    try {
      record = this.#config.storage.read();
    } catch {
      // Resource-only reconciliation must not replace a primary request/fact failure.
      // Keep ownership intact so a later normal reconciliation can retry.
      return;
    }
    if (
      record?.runId === generation.record.runId &&
      record.sessionId === generation.record.sessionId &&
      record.generation <= generation.number &&
      record.retired !== true
    )
      return;
    this.#retireNow(generation);
  }

  /**
   * Sends the opening reply once the Run is Live, the browser's media is ready and the durable
   * claim succeeds; the claim and the dispatch are one synchronous step. A failed dispatch
   * keeps the claim, reports the failure and closes the connection.
   */
  get sendOpening(): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      const { storage, events } = self.#config;
      const connection = self.#connection;
      const record = storage.read();
      if (
        connection._tag !== "connected" ||
        record === null ||
        record.runId !== connection.generation.record.runId ||
        record.sessionId !== connection.generation.sessionId ||
        record.canStartConversation === false ||
        record.canSendOpening === false ||
        record.browserMediaReady === false ||
        (record.openingState === undefined && !record.initialConnection) ||
        (record.openingState !== undefined && record.openingState !== "pending")
      )
        return;
      if (!storage.claimOpening(record.runId)) return;
      // The opening is the conversing phase's first: its reply has the call's own settings.
      const command = self.#conversing.openingReply();
      const sent = connection.generation.driver.sendCommand({ socket: connection.socket, command });
      if (!sent.ok) {
        // A failed or uncertain dispatch keeps the durable claim and follows failure ownership.
        const message = providerFailureText(sent.failure);
        events.notifyControl("session.failed", {
          message,
          sessionId: record.sessionId,
        });
        yield* reportOrDie(
          self.#config.sink({
            kind: "failure",
            failure: "session",
            errorText: message,
            applyRuntimeFailure: true,
          }),
        );
        yield* self.#stop(connection.generation, "failed", true);
        return;
      }
      storage.markOpeningSent(record.runId);
      events.notifyControl("session.control_sent", {
        controlType: command.type,
        eventId: command.event_id,
      });
    });
  }

  /**
   * Ending's translation: each step becomes OpenAI commands through the driver on the open
   * connection.
   * - Cancel a reply: `response.cancel` for it, unless stopped output already cancelled it or
   *   its end (`response.done`) was already received: the step is then carried out with no
   *   command. OpenAI's rejection of a cancel that crossed its reply's end in transit is reported
   *   as `nothing_to_cancel` (`providerEvents.ts`).
   * - Stop output: `output_audio_buffer.clear`, and from then on each reply OpenAI starts on its
   *   own, as from a turn end already in flight, is cancelled and its audio cleared
   *   (`#keepOutputStopped`), so no new reply starts.
   * - Close input and settle the last answer: automatic turns stop (`session.update`, sent as
   *   `<commandId>_turns`), then, only when Runtime holds no answer, the buffered input is
   *   committed under the step's own id. The commit goes through the input closure: whoever asked
   *   first, Ending or a closing, sent it, and a later ask returns its outcome without sending
   *   another. OpenAI's empty-buffer rejection of that commit is reported as `nothing_to_settle`
   *   (`providerEvents.ts`).
   * - Discard later input: `input_audio_buffer.clear`.
   */
  sendFinalizationOperation(operation: EndingOperation): EndingOperationDispatch {
    // After a Runtime restart, the step settles the speech kept before it.
    const record = this.#config.storage.read();
    if (record !== null) this.#restoreInput(record);
    const connection = this.#connection;
    if (connection._tag !== "connected")
      return operation.kind === "close_input"
        ? {
            status: "uncertain",
            code: "sideband_unavailable",
            settlement: this.describeInputClosure(operation),
          }
        : { status: "uncertain", code: "sideband_unavailable" };
    const send = (command: RealtimeEndingCommand) => {
      const sent = connection.generation.driver.sendFinalizationOperation({
        socket: connection.socket,
        operation: command,
      });
      return sent.ok
        ? ({ status: "dispatched" } as const)
        : ({ status: "failed", code: sent.failure.code } as const);
    };
    const { commandId } = operation;
    switch (operation.kind) {
      case "cancel_reply":
        // Stopped output already cancelled the reply, or OpenAI already reported its end, after
        // which `response.cancel` has nothing left to act on: its audio is stopping output's.
        if (
          this.#stoppedReplies.has(operation.responseId) ||
          this.#endedReplies.has(operation.responseId)
        )
          return { status: "dispatched" };
        // A reply Ending cancels is not a failure of that reply.
        this.#cancelledReplies.add(operation.responseId);
        return send({ kind: "cancel_response", commandId, responseId: operation.responseId });
      case "stop_output":
        this.#outputStoppedBy = commandId;
        return send({ kind: "clear_output", commandId });
      case "discard_later_input":
        return send({ kind: "clear_input", commandId });
      case "close_input": {
        this.#endingClosedInput = true;
        // Speech that no item committed yet is the last answer, even when Runtime holds an
        // earlier one: the step commits it. While the participant still speaks, the step answers
        // once OpenAI answers that commit, settled or empty; otherwise Runtime's quiet second
        // applies.
        const inputToSettle = this.input.state.buffered !== null;
        const commits = operation.heldItemId === null || inputToSettle;
        const speaking = this.#speaking;
        const answer = (
          dispatch: EndingOperationDispatch,
          answerFollows: boolean,
        ): EndingOperationDispatch => {
          const settlement: InputClosureSettlement = {
            supersedesHeld: operation.heldItemId !== null && inputToSettle,
            answerFollows: answerFollows && speaking && dispatch.status === "dispatched",
            inputToSettle,
          };
          return { ...dispatch, settlement };
        };
        const closed = send({ kind: "disable_automatic_turns", commandId: `${commandId}_turns` });
        if (closed.status !== "dispatched" || !commits) return answer(closed, false);
        const shared = this.input.commitOutcome;
        if (shared !== null) return answer(shared, true);
        this.input.requestCommit();
        return answer(send({ kind: "commit_input", commandId }), true);
      }
    }
  }

  /**
   * How the input closure would settle without a command: uncommitted speech, including speech
   * kept before a Runtime restart, is input to settle, and supersedes the answer Runtime holds.
   */
  describeInputClosure(
    operation: Extract<EndingOperation, { kind: "close_input" }>,
  ): InputClosureSettlement {
    const record = this.#config.storage.read();
    if (record !== null) this.#restoreInput(record);
    const inputToSettle = this.input.state.buffered !== null;
    return {
      supersedesHeld: operation.heldItemId !== null && inputToSettle,
      answerFollows: false,
      inputToSettle,
    };
  }

  /**
   * Once Ending stopped output, a reply OpenAI starts on its own is cancelled and its audio
   * cleared. A reply a node tagged is its node's: a contained closing cancels its own.
   */
  #keepOutputStopped(receipt: RealtimeReceipt, generation: Generation, socket: ProviderWebSocket) {
    const stoppedBy = this.#outputStoppedBy;
    const replyId = receipt.response?.id;
    if (
      stoppedBy === null ||
      receipt.type !== "response.created" ||
      replyId === undefined ||
      receipt.response?.metadata?.runtime_operation_id !== undefined ||
      this.#cancelledReplies.has(replyId)
    )
      return;
    this.#cancelledReplies.add(replyId);
    this.#stoppedReplies.add(replyId);
    const { driver } = generation;
    driver.sendFinalizationOperation({
      socket,
      operation: {
        kind: "cancel_response",
        commandId: `${stoppedBy}_cancel_${replyId}`,
        responseId: replyId,
      },
    });
    driver.sendFinalizationOperation({
      socket,
      operation: { kind: "clear_output", commandId: `${stoppedBy}_clear_${replyId}` },
    });
  }

  closeBarrier(accepted: ProviderObservationOrder | null): ProviderObservationOrder | null {
    const received = generationOf(this.#connection)?.receipts.received ?? null;
    if (received === null || (accepted !== null && compareOrder(received, accepted) < 0))
      return accepted;
    return received;
  }

  sampleReceiptPrefix(): ProviderReceiptPrefix {
    const receipts = generationOf(this.#connection)?.receipts;
    return {
      receivedOrder: receipts?.received ?? null,
      processedThroughOrder: receipts?.processed ?? null,
    };
  }

  /**
   * Waits until every message the current generation queued for Runtime was handed off, never
   * for its acquisition or its close; fails when its task failed.
   */
  get drain(): Effect.Effect<void, ConnectionTaskFailure> {
    return Effect.suspend(() => {
      const generation = generationOf(this.#connection);
      const target = generation?.receipts.queued ?? null;
      if (generation === null || target === null) return Effect.void;
      return Effect.raceFirst(
        SubscriptionRef.changes(generation.handedOff).pipe(
          Stream.takeUntil((sequence) => sequence >= target),
          Stream.runDrain,
        ),
        Deferred.await(generation.ended),
      );
    });
  }

  /**
   * One connection generation: acquire the side connection before its deadline, attach its
   * listeners, report readiness, send the opening, beat every 15 s, and hand its events to
   * Runtime one at a time until it closes; then report the close and schedule reconnection.
   */
  #connect(record: ProviderSessionRecord, sessionId: string): Effect.Effect<void> {
    const self = this;
    const { storage, events } = this.#config;
    return Effect.scoped(
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        const number = record.generation + 1;
        const generation: Generation = {
          record,
          driver: yield* RealtimeDriver,
          usageModels: storedUsageModels(record),
          number,
          sessionId,
          sink: self.#config.issueSink?.(record.runId, number) ?? self.#config.sink,
          startedAt,
          items: yield* Queue.unbounded<ConnectionItem>(),
          retirement: yield* Deferred.make<void>(),
          ended: yield* Deferred.make<void, ConnectionTaskFailure>(),
          handedOff: yield* SubscriptionRef.make(record.eventCount),
          receipts: { received: null, processed: null, queued: null },
          eventCount: record.eventCount,
          eventTypeCounts: {},
          providerEventIds: new Set(),
          closeReported: null,
          failureReported: false,
        };
        self.#connection = { _tag: "connecting", generation };
        yield* Effect.addFinalizer((exit) =>
          Effect.gen(function* () {
            self.#containGeneration(generation);
            self.#ended(generation);
            yield* Queue.shutdown(generation.items);
            yield* exit._tag === "Failure"
              ? Deferred.fail(generation.ended, new ConnectionTaskFailure({ cause: exit.cause }))
              : Deferred.succeed(generation.ended, undefined);
          }),
        );
        const isReconnect = !record.initialConnection;
        self.#restoreInput(record);
        if (record.initialConnection) {
          storage.setGeneration(record.runId, number);
          self.#diagnostic("realtime.side_connection_requested", {
            source: "realtime_execution",
            provider: "openai_realtime",
            at: startedAt,
          });
        }
        storage.markStarted(record.runId, startedAt);
        yield* self.#emitNow(generation, "sideband.connecting");
        // A reconnection retries without a deadline of its own; Runtime ends it by retiring the
        // connection once it no longer needs one.
        const deadlineAt = isReconnect ? null : (record.startupExpiresAt ?? null);
        let connectionInput: RealtimeSidebandRequest = {
          callId: sessionId,
          apiKey: self.#config.apiKey,
          emit: yield* clockedDiagnostics((event, data, at) =>
            self.#emit(generation, event, data, at),
          ),
          // Retain ignored-abort native completion until its late socket is released.
          retainAcquisition: (task) => self.#config.backgroundWork.waitUntil(task),
        };
        if (deadlineAt !== null)
          connectionInput = { ...connectionInput, retryDeadlineAt: deadlineAt };
        // Retirement ends the wait; the interrupted acquisition aborts its native attempt.
        const acquisition = yield* Effect.raceFirst(
          acquireSideband(connectionInput).pipe(
            Effect.map((socket) => ({ _tag: "connected", socket }) as const),
          ),
          Deferred.await(generation.retirement).pipe(Effect.as({ _tag: "retired" } as const)),
        ).pipe(
          Effect.catchTag("ProviderOperationFailed", ({ failure }) =>
            self.#connectionFailed(generation, isReconnect, failure).pipe(
              Effect.as({ _tag: "failed" } as const),
            ),
          ),
        );
        if (acquisition._tag === "retired") return;
        if (acquisition._tag === "connected") {
          const socket = acquisition.socket;
          // Even a driver that ignores abort can resolve late. Release before any stale admission.
          if (!self.#current(generation) || storage.read()?.connectionRequired !== true) {
            releaseSocket(socket, "sideband_restore_no_longer_allowed");
            return;
          }
          if (
            self.#connection._tag === "connecting" &&
            self.#connection.generation === generation
          ) {
            self.#connection = { _tag: "connected", generation, socket };
            self.#resumeNodes();
          }
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => releaseSocket(socket, self.#releaseReason(generation))),
          );
          if (record.initialConnection)
            events.recordStartup({
              stage: "sessionConnected",
              at: yield* Clock.currentTimeMillis,
            });
          yield* self.#emitNow(generation, "session.connected", { readyState: socket.readyState });
          yield* listenToSideConnection(socket, generation.items, (event) =>
            self.#arrive(generation, socket, event),
          );
          if (!isReconnect) {
            yield* self.#report(generation, {
              kind: "execution_ready",
              runId: record.runId,
              at: yield* Clock.currentTimeMillis,
            });
            if (!self.#current(generation) || storage.read()?.canStartConversation === false)
              yield* self.#stop(generation, "startup_stop_won_before_opening", true);
          }
          if (self.#open(generation)) {
            self.#restoredOpen = false;
            self.#keepSideConnectionOpen(record.runId, true);
            // A reconnection resumes Runtime's work, after any due deadline, before the opening.
            if (isReconnect)
              yield* self.#report(generation, { kind: "execution_resumed", generation: number });
            yield* self.sendOpening;
            yield* Effect.forkScoped(self.#heartbeat(generation));
          }
        }
        yield* Stream.fromQueue(generation.items).pipe(
          Stream.takeUntil((item) => item.kind !== "message"),
          Stream.runForEach((item) => {
            if (item.kind === "defect") return Effect.die(item.defect);
            if (item.kind === "close")
              return item.observed ? self.#closeObserved(generation, item) : Effect.void;
            return self.#handOff(generation, item);
          }),
        );
      }),
    ).pipe(Effect.provide(this.#config.driver));
  }

  /**
   * One native event as it arrives, in the socket's callback. A message is numbered, its
   * provider event deduplicated and decoded once, the input closure and the node operations
   * observe it, a fresh end of a failed interviewer reply is judged, and it is queued for
   * Runtime; a close or a failure ends admission and is queued after every message admitted
   * before it.
   */
  #arrive(
    generation: Generation,
    socket: ProviderWebSocket,
    event: SideConnectionEvent,
  ): ConnectionItem | readonly ConnectionItem[] | null {
    try {
      if (event.kind === "error") {
        if (!this.#open(generation) || !this.#current(generation)) return null;
        this.#emit(
          generation,
          "sideband.websocket_error",
          { message: "websocket_error" },
          event.at,
        );
        this.#config.events.recordLiveDegradation("sideband_websocket", {
          source: "realtime_execution",
          errorText: "OpenAI sideband WebSocket closed unexpectedly.",
        });
        return null;
      }
      if (event.kind === "close") {
        const code =
          typeof event.event.code === "number" && Number.isFinite(event.event.code)
            ? event.event.code
            : undefined;
        const reason = `openai_ws_close_${code === undefined || code === 0 ? "unknown" : code}`;
        if (!this.#closeAdmission(generation, reason)) return null;
        return code === undefined
          ? { kind: "close", reason, observed: true, at: event.at }
          : { kind: "close", reason, observed: true, at: event.at, code };
      }
      const message = event.event;
      if (!this.#current(generation)) {
        this.#recordReceipt(generation, message, { discarded: "retired" }, event.at);
        return this.#retire(generation);
      }
      if (!this.#open(generation)) {
        this.#recordReceipt(generation, message, { discarded: "closing" }, event.at);
        return null;
      }
      const sequence = generation.eventCount + 1;
      this.#recordReceipt(generation, message, { sequence }, event.at);
      generation.eventCount = sequence;
      const { storage } = this.#config;
      const { driver } = generation;
      const normalized = driver.normalizeRuntimeObservation(message.data, {
        sequence,
        observedAt: event.at,
        observeAllProviderEvents: generation.record.observeAllProviderEvents ?? false,
        usageModels: generation.usageModels,
      });
      const providerEventId =
        normalized !== null && "providerEventId" in normalized
          ? normalized.providerEventId
          : undefined;
      let providerEvent: ReturnType<RealtimeProviderDriver["normalizeEvent"]> | undefined;
      let input: ReturnType<RealtimeInputClosure["observe"]> = {};
      let fresh = false;
      let supplies = false;
      if (
        normalized !== null &&
        (providerEventId === undefined ||
          (!generation.providerEventIds.has(providerEventId) &&
            !storage.hasEventIdentity(providerEventId)))
      ) {
        fresh = true;
        generation.receipts.received = { generation: generation.number, sequence };
        if (providerEventId !== undefined) generation.providerEventIds.add(providerEventId);
        providerEvent = decodeProviderEvent(driver, message);
        const current = storage.read();
        // The opening phase's turn ended on its own while input is open: neither Ending's nor
        // a closing's commit, which close input first.
        supplies =
          this.#suppliedReply !== null &&
          normalized.kind === "participant_answer_created" &&
          this.#nodes._tag === "conversing" &&
          this.input.state.phase === "open" &&
          !this.#endingClosedInput &&
          current?.participantInputClosed !== true;
        input = this.input.observe(
          normalized,
          providerEvent?.diagnosticSummary.item_id,
          current?.participantInputClosed !== true,
          current?.eligibleParticipantInputIds,
        );
        this.#keepInputBuffered(generation.record.runId);
        if (normalized.kind === "session_closed_observed") this.#sessionClosed = true;
        if (normalized.kind === "session_closed_observed")
          this.#diagnostic("realtime.closure_confidence", {
            source: "realtime_execution",
            provider: providerName,
            confidence: "confirmed",
            basis: "provider_event",
          });
        if (normalized.kind === "speech_started") this.#speaking = true;
        if (normalized.kind === "speech_stopped") this.#speaking = false;
      }
      const resultWarning = this.#judgeLateSpeech(normalized, fresh);
      generation.receipts.queued = sequence;
      // Node settlement stays independent of the durable handoff, while reporting waits
      // include this receipt in their prefix.
      const receipt = decodeRealtimeReceipt(message.data);
      let replyFailure: string | undefined;
      if (receipt.ok) {
        this.#conversing.observe(receipt.value, socket);
        this.#closing.observe(receipt.value, socket);
        this.#keepOutputStopped(receipt.value, generation, socket);
        if (fresh) replyFailure = this.#replyFailure(receipt.value);
      }
      const item: ConnectionItem = {
        kind: "message",
        message,
        sequence,
        observedAt: event.at,
        normalized,
        providerEvent,
        excludedParticipantInput: input.excludedParticipantInput,
        resultWarning,
        replyFailure,
      };
      return supplies && input.excludedParticipantInput !== true
        ? [item, ...this.#supplyReply(generation, event.at)]
        : item;
    } catch (defect) {
      // Fence new admission; the original defect follows the accepted prefix.
      if (!this.#closeAdmission(generation, "failed")) return null;
      return { kind: "defect", defect };
    }
  }

  /**
   * The Gate's supplied reply, in place of the model's: a reply that started and completed with
   * its one tool call and no speech, numbered after the message that ended the turn it answers.
   * Runtime interprets its tool call as it would a model's; the conversing phase answers no tool
   * call for it, since OpenAI never saw one.
   */
  #supplyReply(generation: Generation, at: number): ConnectionItem[] {
    const supplied = this.#suppliedReply;
    if (supplied === null) return [];
    this.#suppliedReply = null;
    const responseId = `supplied_${crypto.randomUUID()}`;
    const callId = `supplied_call_${crypto.randomUUID()}`;
    this.#conversing.supply(callId);
    this.#diagnostic(
      "realtime.reply_supplied",
      {
        source: "realtime_execution",
        provider: providerName,
        responseId,
        toolName: supplied.toolName,
      },
      { responseId },
    );
    const invocation = {
      type: "function_call",
      toolName: supplied.toolName,
      callId,
      responseId,
      arguments: "{}",
    };
    const observations: readonly RealtimeObservation[] = [
      { kind: "reply_started", responseId, generation: generation.number, sequence: 0 },
      {
        kind: "reply_generated",
        responseId,
        status: "completed",
        toolInvocations: [invocation],
        transcriptInventoryComplete: true,
        generation: generation.number,
        sequence: 0,
      },
    ];
    return observations.map((observation) => {
      const sequence = generation.eventCount + 1;
      generation.eventCount = sequence;
      generation.receipts.received = { generation: generation.number, sequence };
      generation.receipts.queued = sequence;
      return {
        kind: "message",
        message: { data: JSON.stringify({ type: suppliedReplyType, response_id: responseId }) },
        sequence,
        observedAt: at,
        normalized: { ...observation, sequence, observedAt: at },
        providerEvent: undefined,
        excludedParticipantInput: undefined,
        resultWarning: undefined,
        replyFailure: undefined,
        supplied: true,
      };
    });
  }

  /** Hands one queued message to Runtime, then counts it processed. */
  #handOff(
    generation: Generation,
    item: Extract<ConnectionItem, { kind: "message" }>,
  ): Effect.Effect<void> {
    const self = this;
    const order = { generation: generation.number, sequence: item.sequence };
    const warned =
      item.resultWarning === undefined
        ? Effect.void
        : self.#report(generation, { kind: "result_warning", warning: item.resultWarning });
    return warned.pipe(
      Effect.andThen(() => self.#reportMessage(generation, item)),
      Effect.andThen(() => self.#reportReplyFailure(generation, item)),
      Effect.andThen(() => {
        // Rejected receipts also complete this handoff, independently of evidence admission.
        // Sample before the queue-drained notification.
        generation.receipts.processed = order;
        if (!self.#open(generation) || item.sequence !== generation.eventCount) return Effect.void;
        return generation
          .sink({ kind: "message_queue_drained" })
          .pipe(Effect.mapError(({ cause }) => new HandoffFailed({ cause })));
      }),
      // Runtime applies a report it cannot save itself. This handles the message's other
      // failures: its normalization, its records and the drained handoff.
      Effect.catchTag("HandoffFailed", ({ cause }) =>
        Effect.gen(function* () {
          const errorText = cause instanceof Error ? cause.message : String(cause);
          yield* self.#emitNow(generation, "sideband.message_failed", {
            message: errorText,
            stackName: cause instanceof Error ? cause.name : undefined,
          });
          self.#config.events.recordLiveDegradation("session_message", {
            source: "realtime_execution",
            errorText,
          });
          yield* self.#report(generation, {
            kind: "failure",
            failure: "message",
            errorText,
            applyRuntimeFailure: true,
          });
          // A failed handoff is processed only after its failure evidence has completed.
          generation.receipts.processed = order;
          yield* self.#report(generation, { kind: "message_queue_drained" });
        }),
      ),
      Effect.andThen(SubscriptionRef.set(generation.handedOff, item.sequence)),
    );
  }

  /**
   * Once the message that ended a failed interviewer reply was handed to Runtime, the failure
   * ends the interview as interrupted, if the Run is still Live: a Run that already left Live,
   * as Runtime's own retained-output finishing does when its reply fails, needs no other end.
   */
  #reportReplyFailure(
    generation: Generation,
    item: Extract<ConnectionItem, { kind: "message" }>,
  ): Effect.Effect<void> {
    const errorText = item.replyFailure;
    if (errorText === undefined || this.#config.storage.read()?.canStartConversation !== true)
      return Effect.void;
    return this.#report(generation, {
      kind: "failure",
      failure: "message",
      errorText,
      applyRuntimeFailure: true,
    });
  }

  /**
   * Reports one message's observation to Runtime, then records its provider event; a supplied
   * reply has none.
   */
  #reportMessage(
    generation: Generation,
    item: Extract<ConnectionItem, { kind: "message" }>,
  ): Effect.Effect<void, HandoffFailed> {
    const self = this;
    const attempt = <A>(step: () => A) =>
      Effect.try({ try: step, catch: (cause) => new HandoffFailed({ cause }) });
    return Effect.gen(function* () {
      const report = yield* attempt(() => self.#messageReport(generation, item));
      if (report === null) return;
      yield* generation
        .sink(report.fact)
        .pipe(Effect.mapError(({ cause }) => new HandoffFailed({ cause })));
      if (item.supplied === true) return;
      yield* attempt(() => self.#recordProviderEvent(report.providerEvent, report.summary));
    });
  }

  /** The message's Runtime report, or null once the record serves another call. */
  #messageReport(generation: Generation, item: Extract<ConnectionItem, { kind: "message" }>) {
    const state = this.#config.storage.read();
    if (state?.runId !== generation.record.runId || state.sessionId !== generation.sessionId)
      return null;
    const providerEvent = item.providerEvent ?? generation.driver.normalizeEvent(item.message.data);
    generation.eventTypeCounts[providerEvent.type] =
      (generation.eventTypeCounts[providerEvent.type] ?? 0) + 1;
    const summary = { sequence: item.sequence, ...providerEvent.diagnosticSummary };
    const observation =
      item.normalized === null
        ? null
        : { ...runtimeReport(item.normalized), generation: generation.number, at: item.observedAt };
    const providerEventId =
      observation !== null && "providerEventId" in observation
        ? observation.providerEventId
        : undefined;
    let persistence: ProviderObservationPersistence = {
      sessionId: generation.sessionId,
      sequence: item.sequence,
      diagnosticSummary: summary,
    };
    if (providerEventId !== undefined) persistence = { ...persistence, providerEventId };
    if (item.excludedParticipantInput === true)
      persistence = { ...persistence, excludedParticipantInput: true };
    const fact: ProviderSessionApplicationFact = {
      kind: "provider_observation",
      observation,
      persistence,
    };
    return { fact, providerEvent, summary };
  }

  /**
   * Speech after Ending closed participant input is not the last answer, and Runtime does not
   * wait for it: the result warns that the final input may be incomplete. Speech that starts
   * again under an event already received makes the final input ambiguous.
   */
  #judgeLateSpeech(
    observation: RealtimeObservation | null,
    fresh: boolean,
  ): "final_input_may_be_incomplete" | "ambiguous_final_activity" | undefined {
    if (!this.#endingClosedInput || observation?.kind !== "speech_started") return undefined;
    return fresh ? "final_input_may_be_incomplete" : "ambiguous_final_activity";
  }

  /** Reads back the speech kept before a Runtime restart, once per session. */
  #restoreInput(record: ProviderSessionRecord): void {
    if (this.#keptInputBuffered !== null) return;
    const kept = decodeRealtimeExecutionState(record.executionState);
    this.#keptInputBuffered = kept.inputBuffered;
    this.#keptSideConnectionOpen = kept.sideConnectionOpen;
    this.#restoredOpen = kept.sideConnectionOpen;
    if (kept.inputBuffered) this.input.retain({ committedItemId: null, activityObserved: true });
  }

  /** Keeps whether uncommitted speech remains, whenever that changes. */
  #keepInputBuffered(runId: string): void {
    const buffered = this.input.state.buffered !== null;
    if (buffered === this.#keptInputBuffered) return;
    this.#keptInputBuffered = buffered;
    this.#keep(runId);
  }

  /** Keeps whether a side connection is open, whenever that changes. */
  #keepSideConnectionOpen(runId: string, open: boolean): void {
    if (open === this.#keptSideConnectionOpen) return;
    this.#keptSideConnectionOpen = open;
    this.#keep(runId);
  }

  #keep(runId: string): void {
    this.#config.storage.recordExecutionState?.(runId, {
      inputBuffered: this.#keptInputBuffered === true,
      sideConnectionOpen: this.#keptSideConnectionOpen,
    });
  }

  /**
   * Releases the call: its hang-up, answered from the kit's own evidence. A session OpenAI
   * already rejected as gone is closed. Events the side connection may have missed attach the
   * warning that they may be missing before the answer.
   */
  release(sessionId: string | null, timeoutCapMs?: number): Effect.Effect<SessionReleaseAnswer> {
    const self = this;
    this.#released = true;
    return Effect.gen(function* () {
      const record = self.#config.storage.read();
      if (record !== null) self.#restoreInput(record);
      if (self.#eventsMayBeMissing || self.#restoredOpen)
        yield* reportOrDie(
          self.#config.sink({
            kind: "result_warning",
            warning: "provider_observation_gap" satisfies RealtimeResultWarning,
          }),
        );
      const answer = yield* exactProviderCallHangup(self.releaseCall(sessionId, timeoutCapMs));
      return self.#sessionClosed ? { status: "closed" as const } : answer;
    });
  }

  #recordProviderEvent(
    providerEvent: ReturnType<RealtimeProviderDriver["normalizeEvent"]>,
    summary: RuntimeEventPayload,
  ): void {
    const { events } = this.#config;
    if (providerEvent.error !== null) {
      events.notifyControl("sideband.provider_error", summary);
      if (providerEvent.error.reportAsDegradation)
        events.recordLiveDegradation("provider_error", {
          source: "provider",
          errorText: providerEvent.error.message,
          code: providerEvent.error.code,
        });
    }
    this.#diagnostic(
      "realtime.provider_event_observed",
      {
        ...providerEvent.runtimeEventPayload,
        providerEventType: providerEvent.type,
        source: "provider",
        provider: providerName,
      },
      {
        responseId:
          typeof providerEvent.runtimeEventPayload.responseId === "string"
            ? providerEvent.runtimeEventPayload.responseId
            : null,
      },
    );
  }

  /** Reports an observed close: Runtime learns of it and reconnection is scheduled when due. */
  #closeObserved(
    generation: Generation,
    item: Extract<ConnectionItem, { kind: "close"; observed: true }>,
  ): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      const connection = self.#connection;
      // Retirement is resource-only: it cannot write into a replacement run or invent evidence.
      if (connection._tag !== "closing" || connection.generation !== generation) return;
      const { storage } = self.#config;
      const now = yield* Clock.currentTimeMillis;
      self.#emit(
        generation,
        "session.closed",
        {
          reason: item.reason,
          eventCount: generation.eventCount,
          eventTypeCounts: generation.eventTypeCounts,
          sustainedMs: now - generation.startedAt,
        },
        now,
      );
      self.#diagnostic("realtime.sideband_closed", {
        source: "realtime_execution",
        provider: providerName,
        reason: item.reason,
        eventCount: generation.eventCount,
        eventTypeCounts: generation.eventTypeCounts,
      });
      storage.markClosed(generation.record.runId, now);
      self.#connection = { ...connection, socket: null };
      generation.receipts.received = null;
      self.#keepSideConnectionOpen(generation.record.runId, false);
      const state = storage.read();
      const serves =
        state?.runId === generation.record.runId && state.sessionId === generation.sessionId;
      // A normal close after Runtime asked to release the session is that release's own end.
      const releasedNormally = self.#released && (item.code === 1000 || item.code === 1006);
      if (serves && releasedNormally) yield* self.#report(generation, { kind: "session_released" });
      if (serves && !releasedNormally && !generation.failureReported) {
        // After OpenAI's session.closed, the connection carries nothing more.
        if (!self.#sessionClosed) self.#eventsMayBeMissing = true;
        // During Live, Runtime cannot go on without the side connection: the Run ends. During
        // Ending, the connection reports nothing more: Runtime reconsiders its result at once.
        yield* self.#report(generation, { kind: "session_lost", source: "session_disconnected" });
      }
      if (serves && !state.connectionRequired) {
        // Runtime no longer needs the side connection: it is not reconnected.
        self.#diagnostic("realtime.close_only_reconnect_suppressed", {
          source: "realtime_execution",
          provider: providerName,
          observedAt: item.at,
          generation: generation.number,
        });
        if (!self.#sessionClosed)
          self.#diagnostic("realtime.closure_confidence", {
            source: "realtime_execution",
            provider: providerName,
            confidence: "unconfirmed",
            basis: "session_disconnected",
          });
      }
      const current = storage.read();
      // A session OpenAI no longer knows is not reconnected.
      const reconnect =
        !self.#sessionClosed &&
        current?.runId === generation.record.runId &&
        current.sessionId === generation.sessionId &&
        current.connectionRequired;
      generation.closeReported = { reconnectScheduled: reconnect };
      if (!reconnect) return;
      storage.scheduleWake(current.runId, (yield* Clock.currentTimeMillis) + reconnectDelayMs);
      yield* self.#report(generation, { kind: "wake_scheduled" });
    });
  }

  /** An expected failure of the connection: reported, then the connection closes. */
  #connectionFailed(
    generation: Generation,
    isReconnect: boolean,
    failure: ProviderFailureOutcome,
  ): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      if (liveGeneration(self.#connection) !== generation) return;
      const message = providerFailureText(failure);
      yield* self.#emitNow(generation, "session.failed", {
        message,
        eventCount: generation.eventCount,
        eventTypeCounts: generation.eventTypeCounts,
      });
      // OpenAI no longer knows a call the kit reconnects to: the session is closed.
      const terminal = isReconnect && failure.code === "sideband_call_id_not_found";
      if (terminal) {
        self.#sessionClosed = true;
        self.#diagnostic("realtime.closure_confidence", {
          source: "realtime_execution",
          provider: providerName,
          confidence: "confirmed",
          basis: "terminal_reconnect_rejection",
        });
      }
      generation.failureReported = true;
      yield* self.#report(generation, {
        kind: "failure",
        failure: "session",
        errorText: message,
        applyRuntimeFailure: !terminal,
      });
      if (terminal)
        yield* self.#report(generation, {
          kind: "session_lost",
          source: "session_closed_observed",
        });
      yield* self.#stop(generation, terminal ? "session_closed_observed" : "failed", true);
    });
  }

  /** Every 15 s while connected: a heartbeat, or retirement once the record moved on. */
  #heartbeat(generation: Generation): Effect.Effect<void> {
    const self = this;
    const beat = Effect.gen(function* () {
      if (!self.#current(generation)) {
        const close = self.#retire(generation);
        if (close !== null) yield* Queue.offer(generation.items, close);
        return "stop" as const;
      }
      if (!self.#open(generation)) return "stop" as const;
      yield* self.#emitNow(generation, "sideband.heartbeat", {
        eventCount: generation.eventCount,
        eventTypeCounts: generation.eventTypeCounts,
      });
      return "beat" as const;
    });
    return Effect.sleep(heartbeatInterval).pipe(
      Effect.andThen(beat),
      Effect.repeat({
        schedule: Schedule.spaced(heartbeatInterval),
        while: (outcome) => outcome === "beat",
      }),
      Effect.asVoid,
      // A failing beat fails its generation after the accepted prefix.
      Effect.catchDefect((defect) => Queue.offer(generation.items, { kind: "defect", defect })),
    );
  }

  /** Closes the generation's admission and queues its close after the accepted prefix. */
  #stop(generation: Generation, reason: string, observed: true): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      if (!self.#closeAdmission(generation, reason)) return;
      yield* Queue.offer(generation.items, {
        kind: "close",
        reason,
        observed,
        at: yield* Clock.currentTimeMillis,
      });
    });
  }

  /** Moves an open generation to `closing`; false when it was no longer open. */
  #closeAdmission(generation: Generation, reason: string): boolean {
    const connection = this.#connection;
    if (!this.#open(generation)) return false;
    this.#connection = {
      _tag: "closing",
      generation,
      reason,
      socket: socketOf(connection),
    };
    return true;
  }

  /**
   * Retires a generation the record no longer serves: its node work is contained, no further
   * message is admitted, and the close it returns follows the accepted prefix. It returns null
   * when the generation had already stopped admitting.
   */
  #retire(generation: Generation): ConnectionItem | null {
    const connection = this.#connection;
    if (generationOf(connection) !== generation || connection._tag === "retired") return null;
    const open = this.#open(generation);
    this.#connection = {
      _tag: "retired",
      generation,
      reason: connection._tag === "closing" ? connection.reason : "retired",
      socket: socketOf(connection),
    };
    this.#contain("generation");
    return open ? { kind: "close", reason: "retired", observed: false } : null;
  }

  /** Retires a generation from a synchronous call: its acquisition ends and its close is queued. */
  #retireNow(generation: Generation): void {
    const close = this.#retire(generation);
    superviseRetained(
      this.#config.execution,
      this.#config.backgroundWork,
      Effect.all([
        Deferred.succeed(generation.retirement, undefined),
        close === null ? Effect.void : Queue.offer(generation.items, close),
      ]).pipe(Effect.asVoid),
    );
  }

  /** The generation's task ended: the connection leaves it. */
  #ended(generation: Generation): void {
    const connection = this.#connection;
    if (generationOf(connection) !== generation) return;
    if (connection._tag === "retired")
      this.#connection = {
        _tag: "retired",
        generation: null,
        reason: connection.reason,
        socket: null,
      };
    else if (generation.closeReported !== null)
      this.#connection = {
        _tag: "disconnected",
        generation: generation.number,
        reconnectScheduled: generation.closeReported.reconnectScheduled,
      };
    else
      this.#connection = {
        _tag: "closed",
        reason: connection._tag === "closing" ? connection.reason : "released",
      };
  }

  #releaseReason(generation: Generation): string {
    const connection = this.#connection;
    if (generationOf(connection) !== generation) return "retired";
    return connection._tag === "closing" || connection._tag === "retired"
      ? connection.reason
      : "released";
  }

  /** Whether the generation still admits messages. */
  #open(generation: Generation): boolean {
    const connection = this.#connection;
    return (
      (connection._tag === "connecting" || connection._tag === "connected") &&
      connection.generation === generation
    );
  }

  /** Whether the generation still serves the Run's record. */
  #current(generation: Generation): boolean {
    const state = this.#config.storage.read();
    return (
      liveGeneration(this.#connection) === generation &&
      state?.runId === generation.record.runId &&
      state.sessionId === generation.sessionId &&
      state.generation <= generation.number &&
      state.retired !== true
    );
  }

  #report(generation: Generation, fact: ProviderSessionApplicationFact): Effect.Effect<void> {
    return reportOrDie(generation.sink(fact));
  }

  #emitNow(
    generation: Generation,
    event: string,
    data: RuntimeEventPayload = {},
  ): Effect.Effect<void> {
    return Effect.map(Clock.currentTimeMillis, (now) => this.#emit(generation, event, data, now));
  }

  #emit(generation: Generation, event: string, data: RuntimeEventPayload, at: number): void {
    const redactedData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) redactedData[key] = redactSecrets(value);
    this.#config.events.notifyControl(event, {
      elapsedMs: at - generation.startedAt,
      sessionId: generation.sessionId,
      ...redactedData,
    });
  }

  /** The raw provider record: each message as the socket received it, before any decoder. */
  #recordReceipt(
    generation: Generation,
    message: ProviderSocketEvent,
    position: Readonly<{ sequence: number } | { discarded: "closing" | "retired" }>,
    at: number,
  ): void {
    try {
      this.#emit(
        generation,
        "openai.message_received",
        {
          generation: generation.number,
          ...position,
          ...summarizeProviderMessageReceipt(message.data),
        },
        at,
      );
    } catch {
      // The raw record never changes how the message is handled.
    }
  }
}

/**
 * The call's session under the Gate's options: with `noTools`, no tools and no tool choice; with
 * a supplied reply, OpenAI's turn detection starts no reply for the opening phase's turns, so
 * none competes with the supplied one. The first node entered restores the stored turn
 * detection.
 */
function gateCallSession(
  session: PreparedModelSession,
  gate: GateSessionOptions | undefined,
): PreparedModelSession {
  if (gate === undefined) return session;
  const tools = gate.noTools ? { tools: [], toolChoice: null } : {};
  const { turnDetection } = session.inputAudio;
  const inputAudio =
    gate.suppliedReply === null
      ? session.inputAudio
      : { ...session.inputAudio, turnDetection: { ...turnDetection, createResponse: false } };
  return { ...session, ...tools, inputAudio };
}

/** Whether a closing was entered: its reply's outcome is the closing's to decide. */
function closingEntered(nodes: NodeState): boolean {
  switch (nodes._tag) {
    case "entering":
      return nodes.kind === "closing";
    case "closing":
      return true;
    case "contained":
      return nodes.afterClosing;
    default:
      return false;
  }
}

function generationOf(connection: Connection): Generation | null {
  switch (connection._tag) {
    case "connecting":
    case "connected":
    case "closing":
    case "retired":
      return connection.generation;
    default:
      return null;
  }
}
/** The generation whose task runs and that is not retired. */
function liveGeneration(connection: Connection): Generation | null {
  return connection._tag === "retired" ? null : generationOf(connection);
}
function socketOf(connection: Connection): ProviderWebSocket | null {
  switch (connection._tag) {
    case "connected":
    case "closing":
    case "retired":
      return connection.socket;
    default:
      return null;
  }
}

/**
 * Decodes a provider event once, on arrival. A message the driver cannot decode is still
 * queued: its handoff decodes it again, and that failure is the message's failure, which
 * Runtime applies.
 */
function decodeProviderEvent(
  driver: RealtimeProviderDriver,
  message: ProviderSocketEvent,
): ReturnType<RealtimeProviderDriver["normalizeEvent"]> | undefined {
  try {
    return driver.normalizeEvent(message.data);
  } catch {
    return undefined;
  }
}

function compareOrder(left: ProviderObservationOrder, right: ProviderObservationOrder): number {
  return left.generation === right.generation
    ? left.sequence - right.sequence
    : left.generation - right.generation;
}

function releaseSocket(socket: ProviderWebSocket, reason: string): void {
  try {
    socket.close(1000, reason);
  } catch {
    /* Native release must not manufacture provider evidence. */
  }
}

/** The models the Run's stored settings name, or none when they cannot be read. */
function storedUsageModels(record: ProviderSessionRecord): RealtimeUsageModels | undefined {
  if (record.preparedSettings === undefined) return undefined;
  try {
    return realtimeUsageModels(decodeRealtimeSessionSettings(record.preparedSettings));
  } catch {
    return undefined;
  }
}

/** The hang-up's result as the close diagnostic names it; none for a hang-up never attempted. */
function classifyHangupOutcome(
  outcome: CallHangupOutcome,
): "succeeded" | "timed_out" | "uncertain" | "failed" | null {
  if (outcome.code === "provider_session_already_closed") return "succeeded";
  if (outcome.ok && outcome.status !== null && outcome.status !== 404) return "succeeded";
  if (outcome.status === 404) return "failed";
  const code = readOptionalString(outcome.code) ?? "";
  if (code.includes("timed_out") || code.includes("timeout")) return "timed_out";
  if (code.includes("uncertain")) return "uncertain";
  return outcome.ok ? null : "failed";
}

function readOptionalString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
