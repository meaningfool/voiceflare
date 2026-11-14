import { Cause, Data, Effect, Exit, Fiber } from "effect";
import { decodeConversationOffer } from "./connection.ts";
import { composeRealtimeSession, decodeRealtimeSessionSettings } from "./preparedModelSession.ts";
import { superviseRetained } from "../../runtime/nativeWorkOwner.ts";
import { ProviderIdentityPersistenceError } from "./openaiRealtimeDriver.ts";
import {
  RealtimeSession,
  SinkRejected,
  type RealtimeNodeReports,
  type RealtimeSessionConfiguration,
  type RealtimeSessionInput,
  type RealtimeSessionSink,
} from "./session.ts";
import type { ConversationStates } from "../../runtime/conversationContracts.ts";
import type { ConversationNodeDispatch } from "../../runtime/implementationContracts.ts";
import type {
  ProviderSessionApplicationSink,
  ProviderSessionBackgroundWork,
  ProviderSessionStorage,
  SessionStartInput,
  SessionStartResult,
} from "../../runtime/nativeContracts.ts";
import type { RuntimeProviderSession } from "../../runtime/runtimeHostAssembly.ts";

/** The call's creation was interrupted, or never started, because the Run's owner closed. */
class NativeCallCreationInterrupted extends Data.TaggedError("NativeCallCreationInterrupted") {}

/** The Runtime session contract as a Realtime pair offers it, before Runtime's own members. */
export type RealtimeRuntimeSession = Omit<
  RuntimeProviderSession,
  "summarizeSettings" | "enterNode"
>;

/**
 * What the kit's session is created with: Runtime's capabilities as Runtime offers them, with
 * promises, and the Realtime driver.
 */
export type RealtimeRuntimeSessionInput = Omit<
  RealtimeSessionInput,
  "storage" | "sink" | "issueSink"
> &
  Readonly<{
    storage: ProviderSessionStorage;
    sink: ProviderSessionApplicationSink;
    issueSink?: (runId: string, generation: number) => ProviderSessionApplicationSink;
  }>;

/**
 * The Realtime kit's session behind Runtime's session contract: the only module that speaks
 * it, and the one place where Runtime's promises become the session's Effects (`effectEdges` in
 * `scripts/check-effect-diagnostics.ts`): the Durable Object's calls, and Runtime's sink, storage
 * and node reports.
 *
 * Start creates the OpenAI call for the browser's SDP offer and replies with its SDP answer,
 * dispatching it when called so that a caller's durable claim and that dispatch stay one
 * synchronous step; release hangs the call up. The browser attaches through that answer, so a
 * separate attachment is refused. The pair's configuration names the kit operation that enters
 * each dispatched node; containment fences node work.
 */
export function createRealtimeRuntimeSession<S extends ConversationStates>(
  input: RealtimeRuntimeSessionInput,
  configuration: RealtimeSessionConfiguration<S>,
): RealtimeRuntimeSession &
  Readonly<{ enterNode(dispatch: ConversationNodeDispatch<S>): void; containNode(): void }> {
  const { storage, sink, issueSink, ...capabilities } = input;
  const { backgroundWork, execution } = capabilities;
  const session = new RealtimeSession(
    {
      ...capabilities,
      storage: {
        read: () => storage.read(),
        claimOpening: (runId) => storage.claimOpening(runId),
        markOpeningSent: (runId) => storage.markOpeningSent(runId),
        // A refused write is the identity's persistence failure, with the write's cause.
        recordSessionIdentity: (record) =>
          Effect.tryPromise({
            try: async () => {
              await storage.recordSessionIdentity(record);
            },
            catch: (cause) =>
              new ProviderIdentityPersistenceError({
                cause,
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          }),
        recordSessionReply: (record) =>
          Effect.tryPromise({
            try: async () => storage.recordSessionReply(record),
            catch: (cause) =>
              new ProviderIdentityPersistenceError({
                cause,
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          }),
        setGeneration: (runId, generation) => storage.setGeneration(runId, generation),
        markStarted: (runId, startedAt) => storage.markStarted(runId, startedAt),
        markClosed: (runId, closedAt) => storage.markClosed(runId, closedAt),
        scheduleWake: (runId, wakeAt) => storage.scheduleWake(runId, wakeAt),
        hasEventIdentity: (providerEventId) => storage.hasEventIdentity(providerEventId),
        recordExecutionState: (runId, state) => storage.recordExecutionState?.(runId, state),
      },
      sink: sessionSink(sink),
      issueSink: (runId, generation) =>
        sessionSink(issueSink === undefined ? sink : issueSink(runId, generation)),
    },
    configuration,
  );
  const adapted: RealtimeRuntimeSession = {
    get connected() {
      return session.connected;
    },
    get connecting() {
      return session.connecting;
    },
    get feasible() {
      return session.feasible;
    },
    trySendOpening: () => execution.run(session.sendOpening),
    start: (start) => startCall(session, input, start),
    attachBrowser: () =>
      Promise.resolve(Response.json({ error: "browser_attachment_unavailable" }, { status: 409 })),
    ensureConnected: (sessionId) => session.ensureConnected(sessionId),
    reconcileLifetime: () => session.reconcileLifetime(),
    sendFinalizationOperation: (operation) => session.sendFinalizationOperation(operation),
    describeInputClosure: (operation) => session.describeInputClosure(operation),
    release: (sessionId, timeoutCapMs) => execution.run(session.release(sessionId, timeoutCapMs)),
    closeBarrier: (accepted) => session.closeBarrier(accepted),
    sampleReceiptPrefix: () => session.sampleReceiptPrefix(),
    // A failed connection task rejects the drain, as a defect for its caller.
    drain: () => execution.run(session.drain.pipe(Effect.orDie)),
  };
  // The adapted members keep their accessors, such as `connected`.
  return Object.assign(adapted, {
    enterNode: (dispatch: ConversationNodeDispatch<S>) =>
      session.enterNode(dispatch, nodeReports(dispatch, backgroundWork)),
    containNode: () => session.containNodes(),
  });
}

/** Runtime's sink as the session awaits it: each report is made when the Effect runs. */
function sessionSink(sink: ProviderSessionApplicationSink): RealtimeSessionSink {
  return (fact) =>
    Effect.tryPromise({ try: () => sink(fact), catch: (cause) => new SinkRejected({ cause }) });
}

/**
 * A node's reports to Runtime as the session's node work makes them. A report is made when its
 * Effect runs, or at once with `failNow`, and the platform keeps it until Runtime received it.
 */
function nodeReports(
  dispatch: Pick<ConversationNodeDispatch<ConversationStates>, "onComplete" | "onFailure">,
  backgroundWork: ProviderSessionBackgroundWork,
): RealtimeNodeReports {
  return {
    onComplete: (report) =>
      Effect.promise(() => {
        const reported = dispatch.onComplete(report);
        backgroundWork.waitUntil(reported);
        return reported;
      }),
    onFailure: (reason, responseId) => Effect.promise(() => dispatch.onFailure(reason, responseId)),
    failNow: (reason) => backgroundWork.waitUntil(dispatch.onFailure(reason)),
  };
}

function startCall<S extends ConversationStates>(
  session: RealtimeSession<S>,
  input: RealtimeRuntimeSessionInput,
  start: SessionStartInput,
): Effect.Effect<SessionStartResult> {
  // The setup of the Realtime profile already accepted this offer before the start's claim.
  const offer = decodeConversationOffer(start.connection);
  const call = {
    runId: start.runId,
    sdp: offer.sdp,
    // Realtime prepared these settings at setup; the call's session adds the opening content.
    session: composeRealtimeSession(
      start.runId,
      start.content,
      decodeRealtimeSessionSettings(start.settings),
    ),
    settingsSummary: start.settingsSummary,
  };
  const creation = superviseRetained(
    input.execution,
    input.backgroundWork,
    session.createCall(
      start.deadlineAt === undefined ? call : { ...call, deadlineAt: start.deadlineAt },
    ),
  );
  return Effect.flatMap(Fiber.await(creation), (exit) =>
    Exit.isSuccess(exit)
      ? Effect.succeed<SessionStartResult>(
          exit.value.ok
            ? {
                ok: true,
                reply: { sdp: exit.value.answerSdp },
                sessionId: exit.value.sessionId,
                sessionLocation: exit.value.sessionLocation,
                upstreamRequestId: exit.value.upstreamRequestId,
                settingsSummary: exit.value.settingsSummary,
              }
            : exit.value,
        )
      : // A failed creation keeps its whole cause. One the owner refused or interrupted, when
        // the Run ended first, is a defect for the caller, which was not itself interrupted.
        Cause.hasInterruptsOnly(exit.cause)
        ? Effect.die(new NativeCallCreationInterrupted())
        : Effect.failCause(exit.cause),
  );
}
