import {
  admitImplementation as admitDefinition,
  dispatchReportedNode,
} from "../admission/private/composition.ts";
import type {
  BoundRuntimeImplementation,
  RuntimeImplementationDefinition,
} from "../admission/private/implementation.ts";
/**
 * A fixture agent: its own Conversation and content, with each state's handler bound by its
 * `bind`, or by Original Realtime's handlers when it declares none.
 */
type ConversationAgent = Omit<RuntimeImplementationDefinition, "executionHandlers"> &
  Partial<Pick<RuntimeImplementationDefinition, "executionHandlers">> &
  Readonly<{
    bind?(
      issue: import("../executionContracts.ts").ReporterFactory,
      state: string,
    ): BoundRuntimeImplementation;
  }>;
/** Binds a state as Original Realtime's execution handler for that state does. */
function bindOriginalRealtime(
  issue: import("../executionContracts.ts").ReporterFactory,
  state: string,
): BoundRuntimeImplementation {
  if (state === "finishing") return interviewAgent.executionHandlers.finishing.bind(issue);
  if (state !== "interviewing") throw new Error("conversation_report_contract_unavailable");
  return interviewAgent.executionHandlers.interviewing.bind(issue);
}
/**
 * Fixture agents keep their own content on the Original Realtime session contract, with Realtime's
 * settings for the given models.
 */
function admitImplementation(agent: ConversationAgent, models?: RealtimeUsageModels) {
  const admitted = admitDefinition({
    ...agent,
    executionHandlers: Object.fromEntries(
      Object.entries(agent.conversation.states).map(([state, contract]) => [
        state,
        state === "finishing"
          ? {
              contract,
              policy: "retained_output" as const,
              enter: null,
              bind: (issue: import("../executionContracts.ts").ReporterFactory) => {
                const bound = (agent.bind ?? bindOriginalRealtime).call(agent, issue, state);
                if (bound.reporting.kind !== "retained_output")
                  throw new Error("execution_handler_policy_invalid");
                return { ...bound, reporting: bound.reporting };
              },
            }
          : {
              contract,
              policy: "native" as const,
              enter: (
                input: import("../implementationContracts.ts").NodeDispatchInput,
                native: Readonly<{
                  enterNode(input: import("../implementationContracts.ts").NodeDispatchInput): void;
                }>,
              ) => native.enterNode(input),
              bind: (issue: import("../executionContracts.ts").ReporterFactory) => {
                const bound = (agent.bind ?? bindOriginalRealtime).call(agent, issue, state);
                if (bound.reporting.kind !== "native")
                  throw new Error("execution_handler_policy_invalid");
                return { ...bound, reporting: bound.reporting };
              },
            },
      ]),
    ),
  });
  return Object.freeze({
    ...admitted,
    prepareSettings: (choices: ExecutionSettingsPreparation) =>
      prepareRealtimeSettings(choices, models),
  });
}
import {
  createRuntimeHostAssembly,
  originalCascadeSelection,
  questionsRealtimeSelection,
  goodbyeRealtimeSelection,
} from "../../runtimeHostComposition.ts";
import {
  sampleFinishDescription,
  sampleGoodbyeInput,
  sampleClosingSentence,
  sampleQuestionPrompts,
  sampleQuestionsInput,
} from "./sampleInterviews.ts";
import type {
  ExecutionSettingsPreparation,
  ProviderSessionApplicationSink,
} from "../nativeContracts.ts";
import type { StateReporter, SemanticReport } from "../executionContracts.ts";
import { decodeConversationSnapshot } from "../conversationExecution.ts";
import { prepareRealtimeSettings } from "../../providers/openaiRealtime/preparedModelSession.ts";
import type { RealtimeUsageModels } from "../../providers/openaiRealtime/usage.ts";
import { z } from "zod";
import type { RuntimeHostAssembly } from "../runtimeHostAssembly.ts";
import { originalRealtimeSelection } from "../../shared/contracts/conversationSelection.ts";
import { createInterviewConversationInput } from "./interviewConversationPreset.ts";
import { interviewAgent } from "../../implementations/originalRealtime/implementation.ts";
import { testInterviewInstructions as INTERVIEW_AGENT_INSTRUCTIONS } from "./interviewConversationPreset.ts";
import { decodeConversationAgentSelection } from "../conversationAgent.ts";
import { decodeRuntimeConnectionResult } from "../../shared/contracts/runtimeConnection.ts";
import {
  decodeConnectionCheckpoint,
  type ConversationConnectionImplementation,
} from "../conversationConnection.ts";
import { decodeConversationOffer } from "../../providers/openaiRealtime/connection.ts";
import { applicationCallbacks } from "./applicationCallbacks.ts";
import { applicationCallbackUrl } from "../applicationCallbacks.ts";
import { deliveryTo } from "../../shared/testing/runtimeControllerDriver.ts";
import {
  handleLabRuntimeControllerCompletion,
  handleLabRuntimeControllerTranscript,
} from "../../lab/routes/labRuntime.ts";
import { applicationSetupDeadlineMs } from "../interviewAttemptPolicy.ts";
import { resultDeliveryGraceMs } from "../../shared/contracts/interviewLifecyclePolicy.ts";
import {
  parseInterruptedResult,
  parseCompletedResult,
  type CompletedResult,
  type InterruptedResult,
} from "../../shared/contracts/runtimeTerminalResult.ts";
import {
  decodeRuntimeCompletedCallback,
  decodeRuntimeEventRecordEnvelope,
  decodeRuntimeTranscriptUpdatedCallback,
  type RuntimeCompletedCallback,
  type RuntimeTranscriptUpdatedCallback,
} from "../../shared/runtimeControllerCallback.ts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runtimeWorkerTestHarness as runtimeWorker } from "../../runtime.ts";
import { createRuntimeTranscriptSnapshot } from "../../shared/runtimeTranscriptSnapshot.ts";
import type {
  ProviderHangup,
  ProviderSocketEvent,
  ProviderWebSocket,
} from "../../providers/openaiRealtime/openaiRealtimeDriver.ts";
import {
  openAiDriverOver,
  type RealtimeDriverScript,
  type ScriptedRealtimeDriver,
} from "../../providers/openaiRealtime/testing/testDriver.ts";
import {
  providerFailure,
  providerSuccess,
  type ProviderFailureOutcome,
  type ProviderOutcome,
} from "../providerOutcomes.ts";
import type { RuntimeControllerNamespaceCapability } from "../types.ts";
import { normalizeProviderRealtimeEvent } from "../../providers/openaiRealtime/providerEvents.ts";
import { advanceInterviewFinalization } from "../interviewFinalizationFSM.ts";
import {
  playbackMarginMs,
  type FinalizationEffectKind,
  type InterviewFinalizationAggregate,
} from "../interviewFinalizationModel.ts";
import {
  decodeInterviewFinalizationAggregate,
  parseJsonObject,
} from "../interviewFinalizationPersistenceDecoder.ts";
import {
  createLabRun,
  getLabRun,
  getRunDiagnostics,
  listRuntimeEvents,
} from "../../lab/persistence/labD1.ts";
import { createTestLabD1Database } from "../../shared/testing/d1.ts";
import { InterviewFinalizationRepository } from "../interviewFinalizationRepository.ts";
import {
  createDurableObjectState,
  createTestDurableObjectContext,
} from "./interviewRuntimeControllerTestHarness.ts";
import { findRunRecordView, readRunRecordView, readRunView } from "./runtimeRunView.ts";
import { decodeRuntimeToolCallPayload } from "../toolCallRecord.ts";
import {
  controllerDriver,
  createInterviewRuntimeController,
  type ProviderCreateCallInput,
  type ProviderSendCommandInput,
  type ProviderFinalizationOperationInput,
} from "./interviewRuntimeControllerTestDriver.ts";
type InterviewRuntimeController = ReturnType<typeof createInterviewRuntimeController>;

const runtimeUrl = "https://runtime.example.test";
/** A Run that began Ending, which may already have finished it when nothing remained to settle. */
const endingOrEnded: unknown = expect.stringMatching(/^(ending|ended)$/);

type SocketEventType = "message" | "close" | "error";
type SocketEvent = Readonly<{
  data?: string;
  code?: number;
}>;
type SocketListener = (event: SocketEvent) => void;
type ClosedListenerMap<EventType extends PropertyKey, Listener> = {
  [Type in EventType]: Listener[];
};
type TestRecord = Readonly<Record<string, unknown>>;
type PublicRuntimeControllerTestPayload = Readonly<{
  selection?: ReturnType<typeof originalStart>["selection"];
  execution?: ReturnType<typeof originalStart>["execution"];
  startedAt?: number;
  now?: number;
  mediaPresent?: boolean | null | string;
  endReason?: "participant_stopped" | "runtime_failed" | "timebox_reached";
  source?: "browser_request";
}>;

function createControlledProviderSocketListeners() {
  return {
    message: Array<SocketListener>(),
    close: Array<SocketListener>(),
    error: Array<SocketListener>(),
  } satisfies ClosedListenerMap<SocketEventType, SocketListener>;
}

function createControlledProviderSocket() {
  const listeners = createControlledProviderSocketListeners();
  const socket = {
    readyState: 1,
    accept: vi.fn(),
    send: vi.fn(),
    addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
      listeners[type].push(listener);
    }),
    close: vi.fn(),
  };

  return {
    socket,
    emit(type: SocketEventType, event: SocketEvent) {
      for (const listener of listeners[type]) listener(event);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Runtime-owned Start names its Conversation explicitly; these Runs use Original. */
function originalStart(interviewingDurationMs: number) {
  return {
    selection: originalRealtimeSelection,
    execution: {
      agentInput: createInterviewConversationInput(
        INTERVIEW_AGENT_INSTRUCTIONS,
        undefined,
        interviewingDurationMs,
      ),
    },
  };
}

/** Lab's Transcript and result handlers, which its private callbacks call, for the test override. */
function labCallbackFetch(env: Parameters<typeof handleLabRuntimeControllerCompletion>[1]) {
  return (request: Request) =>
    new URL(request.url).pathname === "/transcript"
      ? handleLabRuntimeControllerTranscript(request, env)
      : handleLabRuntimeControllerCompletion(request, env);
}

/**
 * A test override that stores each Transcript, as every application receives them, and gives each
 * result to `result`.
 */
function storingTranscripts(result: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname !== "/transcript") return result(request);
    const body: unknown = await request.json();
    const snapshot = isRecord(body) && isRecord(body.snapshot) ? body.snapshot : null;
    if (snapshot === null) throw new Error("Expected a Transcript snapshot callback.");
    return Response.json({
      version: 2,
      status: "stored",
      storedSnapshot: {
        revision: snapshot.revision,
        digest: snapshot.digest,
        turnCount: snapshot.turnCount,
      },
      requestedMatches: true,
    });
  };
}

export function registerInterviewRuntimeControllerPublicRoutesTests(): void {
  describe("Interview Runtime Controller public-routes", () => {
    it.each([false, true])(
      "preserves the HTTP failure when Cause observation storage rejects: %s",
      async (rejectDiagnostic) => {
        const durable = createTestDurableObjectContext();
        const controller = createInterviewRuntimeController(durable.ctx, {});
        const driver = controllerDriver(controller);
        const runId = "request-cause-observation";
        try {
          await driver.start({
            ...originalStart(60_000),
            runId,
            startedAt: Date.now(),
          });
          if (rejectDiagnostic)
            durable.storage.sql.exec(
              `CREATE TRIGGER reject_failure_observation
               BEFORE INSERT ON runtime_controller_events
               WHEN NEW.event_name = 'runtime.execution_failed'
               BEGIN
                 SELECT RAISE(ABORT, 'diagnostic_storage_rejected');
               END`,
            );
          const request = new Request(`${runtimeUrl}/complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          vi.spyOn(request, "json").mockRejectedValueOnce(new Error("native_request_read_failed"));

          const response = await controller.fetch(request);

          expect(response.status).toBe(500);
          await expect(response.json()).resolves.toEqual({ error: "native_request_read_failed" });
          const observations = durable.storage.sql
            .exec<{ payload_json: string }>(
              "SELECT payload_json FROM runtime_controller_events WHERE event_name = ?",
              "runtime.execution_failed",
            )
            .toArray()
            .map(({ payload_json }) => {
              const observation: unknown = JSON.parse(payload_json);
              return observation;
            });
          const observationTimeMatcher: unknown = expect.any(String);
          expect(observations).toEqual(
            rejectDiagnostic
              ? []
              : [
                  {
                    event: "runtime.execution_failed",
                    observedAt: observationTimeMatcher,
                    runId,
                    source: "runtime_controller",
                    operation: "fetch",
                    failure: false,
                    defect: true,
                    interruption: false,
                  },
                ],
          );
          await durable.flushWaitUntil();
        } finally {
          durable.close();
        }
      },
    );

    it.each([
      [
        "no Conversation",
        { selection: undefined, execution: undefined },
        400,
        "invalid_runtime_controller_request",
      ],
      [
        "a malformed selection",
        { ...originalStart(60_000), selection: { conversation: { id: "original-interview" } } },
        400,
        "invalid_runtime_controller_request",
      ],
      [
        "an execution without its input contract",
        { ...originalStart(60_000), execution: { agentInput: "ask", extra: true } },
        400,
        "invalid_runtime_controller_request",
      ],
      [
        "an undelivered selection",
        {
          ...originalStart(60_000),
          selection: {
            conversation: { id: "original-interview", version: 2 },
            execution: { id: "realtime", version: 1 },
          },
        },
        409,
        "conversation_selection_unavailable",
      ],
      [
        "input outside the selected contract",
        { ...originalStart(60_000), execution: { agentInput: { question: "What changed?" } } },
        400,
        "invalid_conversation_input",
      ],
    ])(
      "refuses Start with %s before creating Runtime state",
      async (_case, conversation, status, error) => {
        const durable = createTestDurableObjectContext();
        try {
          const driver = controllerDriver(createInterviewRuntimeController(durable.ctx, {}));
          const response = await driver.start({
            ...conversation,
            runId: "unselected-run",
            startedAt: 1_700_000_000_000,
          });
          expect({ status: response.status, data: response.data }).toEqual({
            status,
            data: { error },
          });
          await expect(driver.state({ runId: "unselected-run" })).resolves.toMatchObject({
            data: { state: null },
          });
        } finally {
          durable.close();
        }
      },
    );

    it("rejects malformed presence before it can renew the persisted grace", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const namespace = createControllerNamespace();
      const runId = "invalid-presence-run";

      try {
        await postPublicRuntimeController(namespace, runId, "start", {
          ...originalStart(60_000),
          startedAt: 1_700_000_000_000,
        });
        vi.setSystemTime(1_700_000_001_000);
        await postPublicRuntimeController(namespace, runId, "fake-control-ready", {
          now: 1_700_000_001_000,
        });

        for (const payload of [{}, { mediaPresent: null }, { mediaPresent: "false" }]) {
          const response = await postPublicRuntimeController(namespace, runId, "presence", payload);

          expect(response.status).toBe(400);
          await expect(response.json()).resolves.toEqual({
            error: "invalid_runtime_presence_request",
          });
        }
        await expect(
          getPublicRuntimeController(namespace, runId).then((stateResponse) =>
            stateResponse.json(),
          ),
        ).resolves.toMatchObject({
          presence: {
            graceUntil: 1_700_000_016_000,
            signalCount: 0,
          },
        });
      } finally {
        namespace.close();
      }
    });

    it("revalidates configured duration before persisting live deadlines", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const namespace = createControllerNamespace();
      const runId = "duration-crosses-live-boundary";
      const interviewingDurationMs = Number.MAX_SAFE_INTEGER - 1_000;

      try {
        const startResponse = await postPublicRuntimeController(namespace, runId, "start", {
          ...originalStart(interviewingDurationMs),
          startedAt: 1_000,
        });
        expect(startResponse.status).toBe(201);

        vi.setSystemTime(1_001);
        const liveResponse = await postPublicRuntimeController(
          namespace,
          runId,
          "fake-control-ready",
          { now: 1_001 },
        );
        expect(liveResponse.status).toBe(400);
        await expect(liveResponse.json()).resolves.toEqual({
          error: "invalid_runtime_duration",
        });

        const stateResponse = await getPublicRuntimeController(namespace, runId);
        const state = readRecord(await stateResponse.json());
        expect(state).toMatchObject({ phase: "setup" });
        expect(state).not.toHaveProperty("liveAt");
        expect(state).not.toHaveProperty("deadlineAt");
      } finally {
        namespace.close();
      }
    });

    it("preserves runtime identity through the supported start and state routes", async () => {
      const durable = createTestDurableObjectContext();
      const controller = createInterviewRuntimeController(durable.ctx, {});
      const driver = controllerDriver(controller);

      const firstResponse = await driver.start({
        ...originalStart(60_000),
        runId: "lab-run-1",
        startedAt: 1_700_000_000_000,
      });
      const secondResponse = await driver.start({
        ...originalStart(60_000),
        runId: "lab-run-1",
        startedAt: 1_700_000_999_000,
      });
      const stateResponse = await driver.state({ runId: "lab-run-1" });
      const first = readRecord(firstResponse.data);
      const second = readRecord(secondResponse.data);
      const state = readRecord(stateResponse.data);
      const firstState = readRecord(first.state);
      const secondState = readRecord(second.state);
      const persistedState = readRecord(state.state);

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      expect(stateResponse.status).toBe(200);
      expect(first).toMatchObject({
        created: true,
        state: {
          runId: "lab-run-1",
          phase: "setup",
          startedAt: 1_700_000_000_000,
        },
      });
      expect(second).toMatchObject({
        created: false,
        state: {
          runId: "lab-run-1",
          runtimeId: firstState.runtimeId,
          phase: "setup",
          startedAt: 1_700_000_000_000,
        },
      });
      expect(persistedState).toMatchObject({
        runId: "lab-run-1",
        runtimeId: firstState.runtimeId,
        phase: "setup",
        startedAt: 1_700_000_000_000,
      });
      expect(firstState.runtimeId).toMatch(/^runtime_[0-9a-f-]{36}$/u);
      expect(secondState.runtimeId).toBe(firstState.runtimeId);
      expect(persistedState.runtimeId).toBe(firstState.runtimeId);

      durable.close();
    });

    it("persists the current completion result through the public POST /complete route", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const namespace = createControllerNamespace();
      const runId = "public-complete-run";

      try {
        await postPublicRuntimeController(namespace, runId, "start", {
          ...originalStart(60_000),
          startedAt: 1_700_000_000_000,
        });
        vi.setSystemTime(1_700_000_001_000);
        await postPublicRuntimeController(namespace, runId, "fake-control-ready", {
          now: 1_700_000_001_000,
        });

        vi.setSystemTime(1_700_000_010_000);
        const completionResponse = await postPublicRuntimeController(namespace, runId, "complete", {
          endReason: "participant_stopped",
          now: 1_700_000_010_000,
          source: "browser_request",
        });
        const stateResponse = await getPublicRuntimeController(namespace, runId);

        expect(completionResponse.status).toBe(202);
        await expect(completionResponse.json()).resolves.toMatchObject({
          accepted: true,
          idempotent: false,
          conflict: false,
          state: { phase: "ending" },
        });
        expect(stateResponse.status).toBe(200);
        await expect(stateResponse.json()).resolves.toMatchObject({
          runId,
          phase: "ending",
        });
        vi.setSystemTime(1_700_000_019_000);
        await namespace.getByName(runId).alarm();
        vi.setSystemTime(1_700_000_020_000);
        await namespace.getByName(runId).alarm();
        await expect(
          getPublicRuntimeController(namespace, runId).then((response) => response.json()),
        ).resolves.toMatchObject({
          phase: "ended",
          completion: {
            endedAt: 1_700_000_010_000,
            outcome: "ended",
            endReason: "participant_stopped",
            source: "browser_request",
            transcriptSnapshot: { revision: 0, turnCount: 0 },
          },
        });
      } finally {
        namespace.close();
      }
    });

    it("persists post-live runtime failure through the public completion route", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const namespace = createControllerNamespace();
      const runId = "public-runtime-failed-run";

      try {
        await postPublicRuntimeController(namespace, runId, "start", {
          ...originalStart(60_000),
          startedAt: 1_700_000_000_000,
        });
        vi.setSystemTime(1_700_000_001_000);
        await postPublicRuntimeController(namespace, runId, "fake-control-ready", {
          now: 1_700_000_001_000,
        });

        vi.setSystemTime(1_700_000_010_000);
        const completionResponse = await postPublicRuntimeController(namespace, runId, "complete", {
          endReason: "runtime_failed",
          now: 1_700_000_010_000,
          source: "browser_request",
        });
        const stateResponse = await getPublicRuntimeController(namespace, runId);

        expect(completionResponse.status).toBe(202);
        await expect(completionResponse.json()).resolves.toMatchObject({
          accepted: true,
          state: {
            liveAt: 1_700_000_001_000,
            phase: "ending",
          },
        });
        expect(stateResponse.status).toBe(200);
        await expect(stateResponse.json()).resolves.toMatchObject({
          liveAt: 1_700_000_001_000,
          phase: "ending",
        });
        vi.setSystemTime(1_700_000_019_000);
        await namespace.getByName(runId).alarm();
        vi.setSystemTime(1_700_000_020_000);
        await namespace.getByName(runId).alarm();
        await expect(
          getPublicRuntimeController(namespace, runId).then((response) => response.json()),
        ).resolves.toMatchObject({
          phase: "ended",
          completion: {
            endedAt: 1_700_000_010_000,
            outcome: "failed",
            endReason: "runtime_failed",
            source: "browser_request",
          },
        });
      } finally {
        namespace.close();
      }
    });

    it("treats matching browser completion after timebox as idempotent", async () => {
      const namespace = createControllerNamespace();
      const runId = "public-timebox-complete-run";

      try {
        await postPublicRuntimeController(namespace, runId, "start", {
          ...originalStart(10_000),
          startedAt: 1_700_000_000_000,
        });
        vi.setSystemTime(1_700_000_001_000);
        await postPublicRuntimeController(namespace, runId, "fake-control-ready", {
          now: 1_700_000_001_000,
        });

        vi.spyOn(Date, "now").mockReturnValue(1_700_000_011_000);
        await namespace.getByName(runId).alarm();

        const endingResponse = await getPublicRuntimeController(namespace, runId);
        expect(endingResponse.status).toBe(200);
        await expect(endingResponse.json()).resolves.toMatchObject({
          phase: "ending",
          pendingClose: {
            endReason: "timebox_reached",
            source: "timebox_alarm",
            requestedAt: 1_700_000_011_000,
            fallbackAt: 1_700_000_021_000,
          },
        });

        vi.setSystemTime(1_700_000_010_000);
        const completionResponse = await postPublicRuntimeController(namespace, runId, "complete", {
          endReason: "timebox_reached",
          now: 1_700_000_012_000,
          source: "browser_request",
        });

        expect(completionResponse.status).toBe(202);
        await expect(completionResponse.json()).resolves.toMatchObject({
          accepted: false,
          idempotent: true,
          conflict: false,
          state: {
            phase: "ending",
          },
        });
        vi.spyOn(Date, "now").mockReturnValue(1_700_000_020_000);
        await namespace.getByName(runId).alarm();
        vi.spyOn(Date, "now").mockReturnValue(1_700_000_021_000);
        await namespace.getByName(runId).alarm();
        await expect(
          getPublicRuntimeController(namespace, runId).then((response) => response.json()),
        ).resolves.toMatchObject({
          phase: "ended",
          completion: {
            endReason: "timebox_reached",
            source: "timebox_alarm",
          },
        });
      } finally {
        namespace.close();
      }
    });

    it("routes completion presence and events through the Runtime Worker by app-owned runId", async () => {
      const namespace = createControllerNamespace();

      const firstResponse = await runtimeWorker.fetch(
        new Request(`${runtimeUrl}/_runtime/controllers/lab-run-1/start`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Runtime-Application": "lab",
          },
          body: JSON.stringify({
            ...originalStart(60_000),
            deliveryTarget: { integration: "lab", context: { runId: "lab-run-1" } },
            startedAt: 1_700_000_000_000,
          }),
        }),
        {
          INTERVIEW_RUNTIME_CONTROLLER: namespace.binding,
        },
      );
      const secondResponse = await runtimeWorker.fetch(
        new Request(`${runtimeUrl}/_runtime/controllers/lab-run-1/start`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Runtime-Application": "lab",
          },
          body: JSON.stringify({
            ...originalStart(60_000),
            deliveryTarget: { integration: "lab", context: { runId: "lab-run-1" } },
            startedAt: 1_700_000_999_000,
          }),
        }),
        {
          INTERVIEW_RUNTIME_CONTROLLER: namespace.binding,
        },
      );
      const otherResponse = await runtimeWorker.fetch(
        new Request(`${runtimeUrl}/_runtime/controllers/lab-run-2/start`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Runtime-Application": "lab",
          },
          body: JSON.stringify({
            ...originalStart(60_000),
            deliveryTarget: { integration: "lab", context: { runId: "lab-run-2" } },
            startedAt: 1_700_000_100_000,
          }),
        }),
        {
          INTERVIEW_RUNTIME_CONTROLLER: namespace.binding,
        },
      );
      const readyResponse = await runtimeWorker.fetch(
        new Request(`${runtimeUrl}/_runtime/controllers/lab-run-1/fake-control-ready`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            runId: "payload-run-must-not-win",
            now: 1_700_000_001_000,
          }),
        }),
        {
          INTERVIEW_RUNTIME_CONTROLLER: namespace.binding,
        },
      );
      const presenceResponse = await runtimeWorker.fetch(
        new Request(`${runtimeUrl}/_runtime/controllers/lab-run-1/presence`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            runId: "payload-run-must-not-win",
            now: 1_700_000_005_000,
            mediaPresent: true,
          }),
        }),
        {
          INTERVIEW_RUNTIME_CONTROLLER: namespace.binding,
        },
      );
      const eventsResponse = await runtimeWorker.fetch(
        new Request(
          `${runtimeUrl}/_runtime/controllers/lab-run-1/events?runId=payload-run-must-not-win&durationMs=1`,
        ),
        {
          INTERVIEW_RUNTIME_CONTROLLER: namespace.binding,
        },
      );
      await eventsResponse.text();
      vi.setSystemTime(1_700_000_010_000);
      const completionResponse = await runtimeWorker.fetch(
        new Request(`${runtimeUrl}/_runtime/controllers/lab-run-1/complete`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            runId: "payload-run-must-not-win",
            endReason: "participant_stopped",
            now: 1_700_000_010_000,
          }),
        }),
        {
          INTERVIEW_RUNTIME_CONTROLLER: namespace.binding,
        },
      );
      const stateResponse = await runtimeWorker.fetch(
        new Request(`${runtimeUrl}/_runtime/controllers/lab-run-1`),
        {
          INTERVIEW_RUNTIME_CONTROLLER: namespace.binding,
        },
      );
      const first = readRecord(await firstResponse.json());
      const second = readRecord(await secondResponse.json());
      const other = readRecord(await otherResponse.json());
      const ready = readRecord(await readyResponse.json());
      const presence = readRecord(await presenceResponse.json());
      const completion = readRecord(await completionResponse.json());
      const state = readRecord(await stateResponse.json());
      const firstState = readRecord(first.state);
      const secondState = readRecord(second.state);
      const otherState = readRecord(other.state);

      expect(firstResponse.status).toBe(201);
      expect(secondResponse.status).toBe(201);
      expect(otherResponse.status).toBe(201);
      expect(readyResponse.status).toBe(200);
      expect(presenceResponse.status).toBe(200);
      expect(eventsResponse.status).toBe(200);
      expect(eventsResponse.headers.get("Content-Type")).toContain("text/event-stream");
      expect(completionResponse.status).toBe(202);
      expect(stateResponse.status).toBe(200);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(secondState.runtimeId).toBe(firstState.runtimeId);
      expect(otherState.runtimeId).not.toBe(firstState.runtimeId);
      expect(readRecord(ready.state)).toMatchObject({ runId: "lab-run-1", phase: "live" });
      expect(presence).toMatchObject({
        accepted: true,
        state: {
          runId: "lab-run-1",
          presence: { lastSeenAt: 1_700_000_005_000 },
        },
      });
      expect(completion).toMatchObject({
        accepted: true,
        state: {
          runId: "lab-run-1",
          phase: "ending",
          pendingClose: { endReason: "participant_stopped" },
        },
      });
      expect(state).toMatchObject({
        runId: "lab-run-1",
        phase: "ending",
        pendingClose: { endReason: "participant_stopped" },
      });
      expect(namespace.getByName).toHaveBeenCalledWith("lab-run-1");
      expect(namespace.getByName).toHaveBeenCalledWith("lab-run-2");

      namespace.close();
    });

    it("rejects a malformed encoded Runtime Worker run ID before controller selection", async () => {
      const namespace = createControllerNamespace();

      const response = await runtimeWorker.fetch(
        new Request(`${runtimeUrl}/_runtime/controllers/%/events?durationMs=1`),
        {
          INTERVIEW_RUNTIME_CONTROLLER: namespace.binding,
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_runtime_controller_request",
      });
      expect(namespace.getByName).not.toHaveBeenCalled();
      namespace.close();
    });
  });
}

export function registerInterviewRuntimeControllerLifecycleTests(): void {
  describe("Interview Runtime Controller lifecycle", () => {
    it.each([
      {
        correlation: "commit",
        code: "input_audio_buffer_commit_empty",
        type: "error",
        settled: true,
      },
      {
        correlation: "other",
        code: "input_audio_buffer_commit_empty",
        type: "error",
        settled: false,
      },
      {
        correlation: "missing",
        code: "input_audio_buffer_commit_empty",
        type: "error",
        settled: false,
      },
      {
        correlation: "unrelated",
        code: "input_audio_buffer_commit_empty",
        type: "error",
        settled: false,
      },
      { correlation: "commit", code: "another_provider_error", type: "error", settled: false },
      {
        correlation: "commit",
        code: "input_audio_buffer_commit_empty",
        type: "rate_limits.updated",
        settled: false,
      },
    ] as const)(
      "settles final input only for its exact empty-buffer error: $type/$code/$correlation",
      async ({ correlation, code, type, settled }) => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        const durable = createTestDurableObjectContext();
        const controlled = createControlledProviderSocket();
        const sendFinalizationOperation = vi.fn((_input: ProviderFinalizationOperationInput) =>
          providerSuccess(undefined),
        );
        const controller = createInterviewRuntimeController(
          durable.ctx,
          {},
          {
            createCall: async () =>
              providerSuccess({
                status: 201,
                answerSdp: "answer-sdp",
                responseContentType: "application/sdp",
                sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_empty_input",
                sessionId: "rtc_empty_input",
                upstreamRequestId: "req_empty_input",
              }),
            connectSideband: async () => providerSuccess(controlled.socket),
            sendCommand: () => providerSuccess(undefined),
            sendFinalizationOperation,
            hangUp: async () => providerSuccess({ status: 204, upstreamRequestId: null }),
          },
        );
        const driver = controllerDriver(controller);
        const repository = new InterviewFinalizationRepository(
          createDurableObjectState(durable.ctx).storage,
        );
        try {
          await driver.startConnection({
            selection: originalRealtimeSelection,
            runId: "exact-empty-input",
            profile: "realtime-v1",
            connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
            createdAt: Date.now(),
            execution: {
              agentInput: createInterviewConversationInput(
                "Test bounded final input.",
                undefined,
                60_000,
              ),
            },
          });
          await vi.waitFor(async () =>
            expect(await driver.state()).toMatchObject({ state: { phase: "live" } }),
          );
          vi.setSystemTime(1_700_000_000_100);
          await driver.complete({
            runId: "exact-empty-input",
            endReason: "participant_stopped",
            now: Date.now(),
          });
          // Realtime translates the input closure into stopping automatic turns and a commit.
          await vi.waitFor(() =>
            expect(
              sendFinalizationOperation.mock.calls.some(
                ([input]) => input.operation.kind === "commit_input",
              ),
            ).toBe(true),
          );
          const commit = sendFinalizationOperation.mock.calls.find(
            ([input]) => input.operation.kind === "commit_input",
          )?.[0].operation;
          const other = sendFinalizationOperation.mock.calls.find(
            ([input]) => input.operation.kind === "disable_automatic_turns",
          )?.[0].operation;
          if (commit === undefined || other === undefined)
            throw new Error("Expected admitted ending commands.");
          const requestId =
            correlation === "commit"
              ? commit.commandId
              : correlation === "other"
                ? other.commandId
                : correlation === "unrelated"
                  ? "unrelated-request"
                  : undefined;
          // A matching envelope identity must never replace a missing nested request identity.
          controlled.emit("message", {
            data: JSON.stringify({
              event_id: correlation === "missing" ? commit.commandId : "empty-error-receipt",
              type,
              error: { code, event_id: requestId, message: "Provider rejected the request." },
            }),
          });
          await vi.waitFor(async () =>
            expect(await driver.state()).toMatchObject({ state: { session: { eventCount: 1 } } }),
          );
          expect(readRunView(repository).finalInput).toMatchObject({
            obligation: settled ? "settled" : "awaiting_item",
          });
          expect(readRunRecordView(repository).transcriptSnapshot).toEqual({
            turns: [],
          });
          if (correlation === "other") {
            // The rejection of the step's other command neither settles nor refuses the step.
            expect(readRunView(repository).effects).toContainEqual(
              expect.objectContaining({ id: commit.commandId, acceptance: "unobserved" }),
            );
          }
          expect(repository.readEventsByName("session.provider_event")[0]?.payload_json).toContain(
            code,
          );
        } finally {
          controlled.emit("close", { code: 1000 });
          await durable.flushWaitUntil();
          durable.close();
        }
      },
    );

    it("records each sideband message at the socket even when Runtime cannot interpret it", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const controlled = createControlledProviderSocket();
      const controller = createInterviewRuntimeController(
        durable.ctx,
        {},
        {
          createCall: async () =>
            providerSuccess({
              status: 201,
              answerSdp: "answer-sdp",
              responseContentType: "application/sdp",
              sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_raw_record",
              sessionId: "rtc_raw_record",
              upstreamRequestId: "req_raw_record",
            }),
          connectSideband: async () => providerSuccess(controlled.socket),
          sendCommand: () => providerSuccess(undefined),
          hangUp: async () => providerSuccess({ status: 204, upstreamRequestId: null }),
          normalizeRuntimeObservation: (data, input) => {
            if (typeof data === "string" && data.includes("uninterpretable"))
              throw new Error("provider_message_uninterpretable");
            return openAiDriverOver().normalizeRuntimeObservation(data, input);
          },
        },
      );
      const driver = controllerDriver(controller);
      const repository = new InterviewFinalizationRepository(
        createDurableObjectState(durable.ctx).storage,
      );
      const readPayloads = (eventName: string) =>
        repository
          .readEventsByName(eventName)
          .map(({ payload_json }) => parseJsonObject(payload_json));
      try {
        await driver.startConnection({
          selection: originalRealtimeSelection,
          runId: "raw-provider-record",
          profile: "realtime-v1",
          connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
          createdAt: Date.now(),
          execution: {
            agentInput: createInterviewConversationInput("Record raw receipts.", undefined, 60_000),
          },
        });
        await vi.waitFor(async () =>
          expect(await driver.state()).toMatchObject({ state: { phase: "live" } }),
        );
        controlled.emit("message", {
          data: JSON.stringify({ type: "rate_limits.updated", event_id: "evt_interpreted" }),
        });
        await vi.waitFor(() => expect(readPayloads("session.provider_event")).toHaveLength(1));
        controlled.emit("message", {
          data: JSON.stringify({
            type: "conversation.item.uninterpretable",
            event_id: "evt_uninterpretable",
            item_id: "item_raw",
          }),
        });

        expect(readPayloads("openai.message_received")).toEqual([
          expect.objectContaining({
            type: "rate_limits.updated",
            event_id: "evt_interpreted",
            generation: 1,
            sequence: 1,
            sessionId: "rtc_raw_record",
          }),
          expect.objectContaining({
            type: "conversation.item.uninterpretable",
            event_id: "evt_uninterpretable",
            item_id: "item_raw",
            generation: 1,
            sequence: 2,
            sessionId: "rtc_raw_record",
          }),
        ]);
        expect(readPayloads("session.provider_event")).toEqual([
          expect.objectContaining({ event_id: "evt_interpreted" }),
        ]);
      } finally {
        controlled.emit("close", { code: 1000 });
        await durable.flushWaitUntil();
        durable.close();
      }
    });

    it("keeps current completion asynchronous and finishes after its close bound", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const controller = createInterviewRuntimeController(durable.ctx, {});
      const driver = controllerDriver(controller);

      await driver.start({
        ...originalStart(60_000),
        runId: "current-run",
        startedAt: 1_700_000_000_000,
        fakeSessionId: "rtc_current",
      });
      await expect(driver.state({ runId: "current-run" })).resolves.toMatchObject({
        state: {
          phase: "setup",
        },
      });
      vi.setSystemTime(1_700_000_000_100);
      await driver.fakeControlReady({ runId: "current-run", now: 1_700_000_000_100 });

      const closeResponse = await controller.fetch(
        new Request(`${runtimeUrl}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId: "current-run",
            endReason: "participant_stopped",
            now: 1_700_000_001_000,
          }),
        }),
      );
      expect(closeResponse.status).toBe(202);
      await expect(closeResponse.json()).resolves.toMatchObject({ state: { phase: "ending" } });

      vi.setSystemTime(1_700_000_010_000);
      await controller.alarm();
      vi.setSystemTime(1_700_000_011_000);
      await controller.alarm();
      await durable.flushWaitUntil();

      await expect(driver.state({ runId: "current-run" })).resolves.toMatchObject({
        state: {
          phase: "ended",
          finalization: { stage: "ended", terminal: true },
          completion: {
            endReason: "participant_stopped",
            transcriptSnapshot: { revision: 0, turnCount: 0 },
          },
        },
      });
      durable.close();
    });

    it("uses the persisted live deadline before a same-turn manual finish", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const controller = createInterviewRuntimeController(durable.ctx, {});
      const driver = controllerDriver(controller);

      await driver.start({
        ...originalStart(20_000),
        runId: "deadline-before-finish",
        startedAt: 1_700_000_000_000,
      });
      vi.setSystemTime(1_700_000_001_000);
      await driver.fakeControlReady({
        runId: "deadline-before-finish",
        now: 1_700_000_001_000,
      });
      await controllerDriver(controller).presence({
        runId: "deadline-before-finish",
        now: 1_700_000_010_000,
        mediaPresent: true,
      });

      vi.setSystemTime(1_700_000_022_000);
      const result = await controllerDriver(controller).complete({
        runId: "deadline-before-finish",
        endReason: "participant_stopped",
        now: 1_700_000_022_000,
      });

      expect(result).toMatchObject({
        status: 202,
        accepted: false,
        conflict: true,
        state: {
          phase: "ending",
          pendingClose: {
            endReason: "timebox_reached",
            source: "timebox_alarm",
            requestedAt: 1_700_000_022_000,
          },
        },
      });
      durable.close();
    });

    it("classifies a matching request at the timebox deadline as idempotent", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const controller = createInterviewRuntimeController(durable.ctx, {});
      const driver = controllerDriver(controller);

      await driver.start({
        ...originalStart(10_000),
        runId: "deadline-matching-finish",
        startedAt: 1_700_000_000_000,
      });
      vi.setSystemTime(1_700_000_001_000);
      await driver.fakeControlReady({
        runId: "deadline-matching-finish",
        now: 1_700_000_001_000,
      });

      vi.setSystemTime(1_700_000_011_000);
      const result = await controllerDriver(controller).complete({
        runId: "deadline-matching-finish",
        endReason: "timebox_reached",
        now: 1_700_000_011_000,
      });

      expect(result).toMatchObject({
        status: 202,
        accepted: false,
        idempotent: true,
        conflict: false,
        state: {
          pendingClose: {
            endReason: "timebox_reached",
            source: "timebox_alarm",
            requestedAt: 1_700_000_011_000,
          },
        },
      });
      durable.close();
    });

    it("starts the authoritative timebox at usable live rather than setup", async () => {
      const durable = createTestDurableObjectContext();
      const controller = createInterviewRuntimeController(durable.ctx, {});
      const driver = controllerDriver(controller);

      await driver.start({
        ...originalStart(60_000),
        runId: "setup-excluded-from-timebox",
        startedAt: 1_700_000_000_000,
      });
      vi.setSystemTime(1_700_000_010_000);
      const live = await driver.fakeControlReady({
        runId: "setup-excluded-from-timebox",
        now: 1_700_000_010_000,
      });

      expect(live).toMatchObject({
        state: {
          phase: "live",
          liveAt: 1_700_000_010_000,
          deadlineAt: 1_700_000_070_000,
          presence: { graceUntil: 1_700_000_025_000 },
        },
      });
      durable.close();
    });

    it("contains active provider output when the Runtime timebox alarm expires", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const socketListeners = createControlledProviderSocketListeners();
      const socket = {
        readyState: 1,
        accept: vi.fn(),
        send: vi.fn(),
        addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
          socketListeners[type].push(listener);
        }),
        close: vi.fn(),
      };
      const providerDriver = {
        normalizeEvent: vi.fn(normalizeProviderRealtimeEvent),
        createCall: vi.fn(async () =>
          providerSuccess({
            status: 201,
            answerSdp: "answer-sdp",
            responseContentType: "application/sdp",
            sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_active_timebox",
            sessionId: "rtc_active_timebox",
            upstreamRequestId: "req_active_timebox",
          }),
        ),
        connectSideband: vi.fn(async () => providerSuccess(socket)),
        sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
          providerSuccess(undefined),
        ),
        sendCommand: vi.fn((_input: ProviderSendCommandInput) => providerSuccess(undefined)),
        hangUp: vi.fn(async () =>
          providerSuccess({ status: 200, upstreamRequestId: "req_active_timebox_hangup" }),
        ),
      } satisfies RealtimeDriverScript;
      const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
      const driver = controllerDriver(controller);

      try {
        await driver.startConnection({
          selection: originalRealtimeSelection,
          runId: "active-timebox-run",
          profile: "realtime-v1",
          connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
          createdAt: 1_700_000_000_000,
          execution: {
            agentInput: createInterviewConversationInput("Test active timebox.", undefined, 1_000),
          },
        });
        await vi.waitFor(async () => {
          await expect(driver.state({ runId: "active-timebox-run" })).resolves.toMatchObject({
            state: { phase: "live", deadlineAt: 1_700_000_001_000 },
          });
        });
        for (const listener of socketListeners.message) {
          listener({
            data: JSON.stringify({
              event_id: "event_active_timebox_response",
              type: "response.created",
              response: { id: "response_active_timebox" },
            }),
          });
        }
        await vi.waitFor(() => {
          expect(readRunView(durable).lifecycle).toMatchObject({
            stage: "live",
            activeResponseId: "response_active_timebox",
          });
        });

        vi.setSystemTime(1_700_000_001_000);
        await controller.alarm();
        vi.setSystemTime(1_700_000_010_000);
        await controller.alarm();

        expect(
          providerDriver.sendFinalizationOperation.mock.calls.map(([input]) => input.operation),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "cancel_response",
              responseId: "response_active_timebox",
            }),
            expect.objectContaining({ kind: "clear_input" }),
            expect.objectContaining({ kind: "clear_output" }),
          ]),
        );
        await expect(driver.state({ runId: "active-timebox-run" })).resolves.toMatchObject({
          state: {
            phase: "ending",
            pendingClose: { endReason: "timebox_reached", source: "timebox_alarm" },
            finalization: { stage: "closing_provider" },
          },
        });
      } finally {
        for (const listener of socketListeners.close) listener({ code: 1000 });
        await durable.flushWaitUntil();
        durable.close();
      }
    });

    it("selects the earlier overdue live deadline and gives an equal tie to timebox", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);

      for (const testCase of [
        {
          runId: "presence-first",
          presenceAt: 1_700_000_011_000,
          expectedReason: "participant_disconnected",
          expectedSource: "presence_timeout",
          expectedProviderAttemptCount: 1,
        },
        {
          runId: "timebox-first",
          presenceAt: 1_700_000_025_000,
          expectedReason: "timebox_reached",
          expectedSource: "timebox_alarm",
          expectedProviderAttemptCount: 1,
        },
        {
          runId: "equal-deadlines",
          presenceAt: 1_700_000_021_000,
          expectedReason: "timebox_reached",
          expectedSource: "timebox_alarm",
          expectedProviderAttemptCount: 1,
        },
      ] as const) {
        const durable = createTestDurableObjectContext();
        const controller = createInterviewRuntimeController(durable.ctx, {});
        const driver = controllerDriver(controller);
        await driver.start({
          ...originalStart(20_000),
          runId: testCase.runId,
          startedAt: 1_700_000_000_000,
        });
        vi.setSystemTime(1_700_000_001_000);
        await driver.fakeControlReady({ runId: testCase.runId, now: 1_700_000_001_000 });
        durable.storage.sql.exec(
          "UPDATE runtime_controller_state SET presence_grace_until = ? WHERE run_id = ?",
          testCase.presenceAt,
          testCase.runId,
        );

        vi.setSystemTime(1_700_000_030_000);
        await controller.alarm();

        await expect(driver.state({ runId: testCase.runId })).resolves.toMatchObject({
          state: {
            phase: "ending",
            pendingClose: {
              endReason: testCase.expectedReason,
              source: testCase.expectedSource,
              requestedAt: 1_700_000_030_000,
              fallbackAt: 1_700_000_040_000,
            },
          },
        });
        expect(
          readRunView(durable)
            .effects.filter(({ kind }) => kind === "close_input")
            .map(({ kind, attemptCount }) => ({ kind, attemptCount })),
        ).toEqual([{ kind: "close_input", attemptCount: testCase.expectedProviderAttemptCount }]);
        durable.close();
      }
    });

    it("applies an overdue finalization deadline before a stale sideband reconnect", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const controller = createInterviewRuntimeController(durable.ctx, {});
      const driver = controllerDriver(controller);

      try {
        await driver.start({
          ...originalStart(60_000),
          runId: "overdue-finalization-deadline-run",
          startedAt: 1_700_000_000_000,
          fakeSessionId: "rtc_overdue_finalization_deadline",
        });
        vi.setSystemTime(1_700_000_000_100);
        await driver.fakeControlReady({
          runId: "overdue-finalization-deadline-run",
          now: 1_700_000_000_100,
        });
        vi.setSystemTime(1_700_000_001_000);
        await controllerDriver(controller).complete({
          runId: "overdue-finalization-deadline-run",
          endReason: "participant_stopped",
          now: 1_700_000_001_000,
        });
        durable.storage.sql.exec(
          `UPDATE runtime_controller_state SET execution_wake_at = ? WHERE run_id = ?`,
          1_700_000_001_000,
          "overdue-finalization-deadline-run",
        );

        vi.setSystemTime(1_700_000_010_000);
        await controller.alarm();

        await expect(
          driver.state({ runId: "overdue-finalization-deadline-run" }),
        ).resolves.toMatchObject({
          state: {
            phase: "ending",
            finalization: { stage: "closing_provider" },
          },
        });
      } finally {
        durable.close();
        vi.useRealTimers();
      }
    });

    it("applies an overdue drain before a repeated inbound close request", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const controller = createInterviewRuntimeController(durable.ctx, {});
      const driver = controllerDriver(controller);

      try {
        await driver.start({
          ...originalStart(60_000),
          runId: "overdue-inbound-close-run",
          startedAt: 1_700_000_000_000,
          fakeSessionId: "rtc_overdue_inbound_close",
        });
        vi.setSystemTime(1_700_000_000_100);
        await driver.fakeControlReady({
          runId: "overdue-inbound-close-run",
          now: 1_700_000_000_100,
        });
        vi.setSystemTime(1_700_000_001_000);
        await controllerDriver(controller).complete({
          runId: "overdue-inbound-close-run",
          endReason: "participant_stopped",
          now: 1_700_000_001_000,
        });

        vi.setSystemTime(1_700_000_010_000);
        const repeated = await controller.fetch(
          new Request(`${runtimeUrl}/complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              runId: "overdue-inbound-close-run",
              endReason: "participant_stopped",
              now: 1_700_000_010_000,
            }),
          }),
        );

        expect(repeated.status).toBe(202);
        await expect(driver.state({ runId: "overdue-inbound-close-run" })).resolves.toMatchObject({
          state: {
            phase: "ending",
            finalization: { stage: "closing_provider" },
          },
        });
      } finally {
        durable.close();
        vi.useRealTimers();
      }
    });

    it("recomputes close effects after a diagnostic reaches an overdue drain", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const controlledSocket = createControlledProviderSocket();
      const providerDriver = {
        normalizeEvent: vi.fn(normalizeProviderRealtimeEvent),
        createCall: vi.fn(async () =>
          providerSuccess({
            status: 201,
            answerSdp: "answer-sdp",
            responseContentType: "application/sdp",
            sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_diagnostic_drain",
            sessionId: "rtc_diagnostic_drain",
            upstreamRequestId: "req_diagnostic_drain",
          }),
        ),
        connectSideband: vi.fn(async () => providerSuccess(controlledSocket.socket)),
        sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
          providerSuccess(undefined),
        ),
        sendCommand: vi.fn(() => providerSuccess(undefined)),
        hangUp: vi.fn(async () =>
          providerFailure({
            stage: "hangup",
            code: "provider_session_already_closed",
            providerStatus: 404,
            requestId: "req_diagnostic_drain_closed",
            retryable: false,
          }),
        ),
      } satisfies RealtimeDriverScript;
      const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
      const driver = controllerDriver(controller);

      try {
        await driver.startConnection({
          selection: originalRealtimeSelection,
          runId: "diagnostic-drain-run",
          profile: "realtime-v1",
          connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
          createdAt: 1_700_000_000_000,
          execution: {
            agentInput: createInterviewConversationInput(
              "Test deadline recomputation.",
              undefined,
              60_000,
            ),
          },
        });
        await vi.waitFor(async () => {
          await expect(driver.state({ runId: "diagnostic-drain-run" })).resolves.toMatchObject({
            state: { phase: "live" },
          });
        });

        vi.setSystemTime(1_700_000_000_200);
        await driver.complete({
          runId: "diagnostic-drain-run",
          endReason: "participant_stopped",
          now: 1_700_000_000_200,
        });

        vi.setSystemTime(1_700_000_009_300);
        controlledSocket.emit("message", {
          data: JSON.stringify({
            event_id: "event_diagnostic_drain",
            type: "rate_limits.updated",
            rate_limits: [],
          }),
        });
        await vi.waitFor(() => expect(providerDriver.hangUp).toHaveBeenCalledTimes(1), {
          timeout: 250,
        });
      } finally {
        controlledSocket.emit("close", { code: 1000 });
        await durable.flushWaitUntil();
        durable.close();
      }
    });

    it("applies an overdue drain without letting close effects overtake its provider fact", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const socketListeners = createControlledProviderSocketListeners();
      const socket = {
        readyState: 1,
        accept: vi.fn(),
        send: vi.fn(),
        addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
          socketListeners[type].push(listener);
        }),
        close: vi.fn(),
      };
      const providerDriver = {
        normalizeEvent: vi.fn(normalizeProviderRealtimeEvent),
        createCall: vi.fn(async () =>
          providerSuccess({
            status: 201,
            answerSdp: "answer-sdp",
            responseContentType: "application/sdp",
            sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_overdue_provider_fact",
            sessionId: "rtc_overdue_provider_fact",
            upstreamRequestId: "req_overdue_provider_fact",
          }),
        ),
        connectSideband: vi.fn(async () => providerSuccess(socket)),
        sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
          providerSuccess(undefined),
        ),
        sendCommand: vi.fn(() => providerSuccess(undefined)),
        hangUp: vi.fn(async () =>
          providerFailure({
            stage: "hangup",
            code: "provider_session_already_closed",
            providerStatus: 404,
            requestId: "req_already_closed",
            retryable: false,
          }),
        ),
      } satisfies RealtimeDriverScript;
      const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
      const driver = controllerDriver(controller);

      try {
        await driver.startConnection({
          selection: originalRealtimeSelection,
          runId: "overdue-provider-fact-run",
          profile: "realtime-v1",
          connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
          createdAt: 1_700_000_000_000,
          execution: {
            agentInput: createInterviewConversationInput(
              "Test provider ordering.",
              undefined,
              60_000,
            ),
          },
        });
        await vi.waitFor(async () => {
          await expect(driver.state({ runId: "overdue-provider-fact-run" })).resolves.toMatchObject(
            {
              state: { phase: "live" },
            },
          );
        });

        vi.setSystemTime(1_700_000_000_200);
        await controllerDriver(controller).complete({
          runId: "overdue-provider-fact-run",
          endReason: "participant_stopped",
          now: 1_700_000_000_200,
        });
        vi.setSystemTime(1_700_000_000_300);
        for (const listener of socketListeners.message) {
          listener({
            data: JSON.stringify({
              event_id: "event_overdue_item",
              type: "input_audio_buffer.committed",
              item_id: "item_overdue_provider_fact",
            }),
          });
        }
        await vi.waitFor(async () => {
          await expect(driver.state({ runId: "overdue-provider-fact-run" })).resolves.toMatchObject(
            {
              state: { session: { eventCount: 1 } },
            },
          );
        });

        vi.setSystemTime(1_700_000_009_300);
        for (const listener of socketListeners.message) {
          for (const data of [
            {
              event_id: "event_overdue_speech_stopped",
              type: "input_audio_buffer.speech_stopped",
            },
            {
              event_id: "event_overdue_transcription",
              type: "conversation.item.input_audio_transcription.completed",
              item_id: "item_overdue_provider_fact",
              transcript: "This provider fact arrived before close effects ran.",
            },
            {
              event_id: "event_overdue_transcription",
              type: "conversation.item.input_audio_transcription.completed",
              item_id: "item_overdue_provider_fact",
              transcript: "This provider fact arrived before close effects ran.",
            },
            {
              event_id: "event_overdue_nonfinalization_diagnostic",
              type: "rate_limits.updated",
              rate_limits: [],
            },
          ]) {
            listener({ data: JSON.stringify(data) });
          }
        }

        await vi.waitFor(async () => {
          await expect(driver.state({ runId: "overdue-provider-fact-run" })).resolves.toMatchObject(
            {
              state: {
                phase: "ended",
                transcript: { turnCount: 1 },
                completion: { transcriptSnapshot: { turnCount: 1 } },
              },
            },
          );
        });
        await vi.waitFor(() =>
          expect(
            durable.storage.sql
              .exec<{ count: number }>(
                "SELECT COUNT(*) AS count FROM runtime_controller_events WHERE event_name = ?",
                "runtime.transcript_persisted",
              )
              .one().count,
          ).toBeGreaterThan(0),
        );
      } finally {
        for (const listener of socketListeners.close) listener({ code: 1000 });
        await durable.flushWaitUntil();
        durable.close();
      }
    });

    it.each(["with_hangup_reply", "after_hangup_reply"] as const)(
      "freezes the received prefix when required text arrives %s",
      async (receiptTiming) => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        const durable = createTestDurableObjectContext();
        const socketListeners = createControlledProviderSocketListeners();
        const socket = {
          readyState: 1,
          accept: vi.fn(),
          send: vi.fn(),
          addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
            socketListeners[type].push(listener);
          }),
          close: vi.fn(),
        };
        type HangupOutcome = ProviderOutcome<ProviderHangup>;
        let resolveHangup: (outcome: HangupOutcome) => void = () => undefined;
        const hangup = new Promise<HangupOutcome>((resolve) => {
          resolveHangup = resolve;
        });
        const providerDriver = {
          normalizeEvent: vi.fn(normalizeProviderRealtimeEvent),
          createCall: vi.fn(async () =>
            providerSuccess({
              status: 201,
              answerSdp: "answer-sdp",
              responseContentType: "application/sdp",
              sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_queued_404",
              sessionId: "rtc_queued_404",
              upstreamRequestId: "req_queued_404",
            }),
          ),
          connectSideband: vi.fn(async () => providerSuccess(socket)),
          sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
            providerSuccess(undefined),
          ),
          sendCommand: vi.fn(() => providerSuccess(undefined)),
          hangUp: vi.fn(() => hangup),
        } satisfies RealtimeDriverScript;
        const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
        const driver = controllerDriver(controller);
        try {
          await driver.startConnection({
            selection: originalRealtimeSelection,
            runId: "queued-hangup-404-run",
            profile: "realtime-v1",
            connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
            createdAt: 1_700_000_000_000,
            execution: {
              agentInput: createInterviewConversationInput(
                "Test queued 404 ordering.",
                undefined,
                60_000,
              ),
            },
          });
          await vi.waitFor(async () => {
            await expect(driver.state({ runId: "queued-hangup-404-run" })).resolves.toMatchObject({
              state: { phase: "live" },
            });
          });
          vi.setSystemTime(1_700_000_000_100);
          await controllerDriver(controller).complete({
            runId: "queued-hangup-404-run",
            endReason: "participant_stopped",
            now: 1_700_000_000_100,
          });

          for (const listener of socketListeners.message) {
            listener({
              data: JSON.stringify({
                event_id: "event_queued_404_item",
                type: "input_audio_buffer.committed",
                item_id: "item_queued_404",
              }),
            });
          }
          await vi.waitFor(() => {
            expect(readRunView(durable).finalInput).toMatchObject({
              admittedItemId: "item_queued_404",
              obligation: "awaiting_transcription",
            });
          });

          vi.setSystemTime(1_700_000_009_200);
          const closeAlarm = controller.alarm();
          await vi.waitFor(() => expect(providerDriver.hangUp).toHaveBeenCalledOnce());
          resolveHangup(
            providerFailure({
              stage: "hangup",
              code: "provider_session_already_closed",
              providerStatus: 404,
              requestId: "req_queued_404_already_closed",
              retryable: false,
            }),
          );
          if (receiptTiming === "after_hangup_reply") await Promise.resolve();
          for (const data of [
            {
              event_id: "event_queued_404_transcript",
              type: "conversation.item.input_audio_transcription.completed",
              item_id: "item_queued_404",
              transcript: "This prefix was received before the 404 outcome was reduced.",
            },
          ]) {
            for (const listener of socketListeners.message) {
              listener({ data: JSON.stringify(data) });
            }
          }
          await closeAlarm;

          const afterQueuedPrefix = readRunView(durable);
          expect(readRunRecordView(durable).providerEventCount).toBe(2);
          expect(afterQueuedPrefix.transcript.items).toContainEqual(
            expect.objectContaining({
              itemId: "item_queued_404",
              text: "This prefix was received before the 404 outcome was reduced.",
            }),
          );

          await vi.waitFor(async () => {
            await expect(driver.state({ runId: "queued-hangup-404-run" })).resolves.toMatchObject({
              state: {
                phase: "ended",
                transcript: { turnCount: 1 },
                completion: { transcriptSnapshot: { turnCount: 1 } },
              },
            });
          });
          const ended = readRunView(durable);
          expect(ended.provider.acceptedOrder).toEqual({ generation: 1, sequence: 2 });
          expect(readRunRecordView(durable).frozenTranscript).toContain(
            "This prefix was received before the 404 outcome was reduced.",
          );
          expect(ended.transcript.items).toContainEqual(
            expect.objectContaining({
              itemId: "item_queued_404",
              text: "This prefix was received before the 404 outcome was reduced.",
            }),
          );
        } finally {
          for (const listener of socketListeners.close) listener({ code: 1000 });
          await durable.flushWaitUntil();
          durable.close();
        }
      },
    );

    it("persists the browser microphone-stop observation before finalization dispatch", async () => {
      const durable = createTestDurableObjectContext();
      const controller = createInterviewRuntimeController(durable.ctx, {});
      const driver = controllerDriver(controller);

      await driver.start({
        ...originalStart(60_000),
        runId: "microphone-stop-diagnostic-run",
        startedAt: 1_700_000_000_000,
        fakeSessionId: "rtc_microphone_stop_diagnostic",
      });
      vi.setSystemTime(1_700_000_000_100);
      await driver.fakeControlReady({
        runId: "microphone-stop-diagnostic-run",
        now: 1_700_000_000_100,
      });

      vi.setSystemTime(1_700_000_001_240);
      await expect(
        controllerDriver(controller).complete({
          runId: "microphone-stop-diagnostic-run",
          endReason: "participant_stopped",
          microphoneStoppedAt: 1_700_000_001_234,
          now: 1_700_000_001_240,
        }),
      ).resolves.toMatchObject({ accepted: true, ending: true });

      const records = durable.storage.sql
        .exec<{ payload_json: string }>(
          `SELECT payload_json FROM runtime_controller_events
           WHERE event_name = 'runtime.event_recorded' ORDER BY id ASC`,
        )
        .toArray()
        .map((row) => parseJsonObject(row.payload_json) ?? {});
      const microphoneRecord = records.find(
        (entry) => isRecord(entry.record) && entry.record.type === "runtime.microphone_stopped",
      );

      expect(microphoneRecord?.record).toMatchObject({
        observedAt: 1_700_000_001_234,
        type: "runtime.microphone_stopped",
        payloadJson: JSON.stringify({
          source: "browser",
          microphoneStoppedAt: 1_700_000_001_234,
        }),
      });
      durable.close();
    });

    it("emits canonical lifecycle diagnostics from Runtime-owned transitions", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const socketListeners = createControlledProviderSocketListeners();
      const socket = {
        readyState: 1,
        accept: vi.fn(),
        send: vi.fn(),
        addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
          socketListeners[type].push(listener);
        }),
        close: vi.fn(),
      };
      const providerDriver = {
        normalizeEvent: vi.fn(normalizeProviderRealtimeEvent),
        createCall: vi.fn(async () =>
          providerSuccess({
            status: 201,
            answerSdp: "answer-sdp",
            responseContentType: "application/sdp",
            sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_diagnostic_provider",
            sessionId: "rtc_diagnostic_provider",
            upstreamRequestId: "req_diagnostic_provider",
          }),
        ),
        connectSideband: vi.fn(async () => providerSuccess(socket)),
        sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
          providerSuccess(undefined),
        ),
        sendCommand: vi.fn(() => providerSuccess(undefined)),
        hangUp: vi.fn(async () =>
          providerFailure({
            stage: "hangup",
            code: "session_release_timed_out",
            timeoutMs: 8_000,
            retryable: true,
          }),
        ),
      } satisfies RealtimeDriverScript;
      const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
      const driver = controllerDriver(controller);

      await driver.startConnection({
        selection: originalRealtimeSelection,
        runId: "lab-run-1",
        profile: "realtime-v1",
        connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
        createdAt: 1_700_000_000_000,
        execution: {
          agentInput: createInterviewConversationInput(
            "Lifecycle diagnostics test.",
            undefined,
            60_000,
          ),
        },
      });
      await vi.waitFor(() => expect(providerDriver.connectSideband).toHaveBeenCalledOnce());
      await vi.waitFor(() => {
        expect(readRuntimeDiagnosticRecords(durable)).toContainEqual(
          expect.objectContaining({ type: "runtime.live_reached" }),
        );
      });
      for (const listener of socketListeners.message) {
        listener({
          data: JSON.stringify({
            type: "error",
            error: {
              message: "Provider reported a compact error.",
              code: "provider_error",
            },
          }),
        });
      }
      await vi.waitFor(() => {
        expect(readRuntimeDiagnosticRecords(durable)).toContainEqual(
          expect.objectContaining({ type: "runtime.live_degraded" }),
        );
      });
      vi.setSystemTime(1_700_000_010_000);
      await driver.complete({
        runId: "lab-run-1",
        endReason: "participant_stopped",
        now: 1_700_000_010_000,
        finalTurnFlush: {
          status: "sidebandClosed",
          inputCommitSent: true,
          completionReviewStatus: "clean",
          debugText: "Final turn evidence was retained.",
        },
      });
      vi.setSystemTime(1_700_000_016_000);
      await controller.alarm();
      vi.setSystemTime(1_700_000_019_000);
      await controller.alarm();

      const records = readRuntimeDiagnosticRecords(durable);
      const canonicalRecords = records.filter((record) =>
        [
          "runtime.live_reached",
          "runtime.live_degraded",
          "runtime.ending_started",
          "runtime.final_turn_flush_finished",
          "realtime.close_finished",
        ].includes(record.type),
      );

      expect(canonicalRecords.map((record) => record.type)).toEqual([
        "runtime.live_reached",
        "runtime.live_degraded",
        "runtime.ending_started",
        "runtime.final_turn_flush_finished",
        "realtime.close_finished",
      ]);
      expect(
        JSON.parse(requireDefined(canonicalRecords[1], "missing_degradation_record").payloadJson),
      ).toMatchObject({
        source: "provider",
        degradationKind: "provider_error",
        errorText: "Provider reported a compact error.",
        code: "provider_error",
      });
      expect(
        JSON.parse(requireDefined(canonicalRecords[3], "missing_flush_record").payloadJson),
      ).toMatchObject({
        source: "runtime_controller",
        status: "sidebandClosed",
        inputCommitSent: true,
        completionReviewStatus: "clean",
      });

      for (const listener of socketListeners.close) listener({ code: 1000 });
      await durable.flushWaitUntil();
      durable.close();
    });

    it("keeps the first accepted close decision and returns it for repeats or conflicts", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const controller = createInterviewRuntimeController(durable.ctx, {});

      await controllerDriver(controller).start({
        ...originalStart(60_000),
        runId: "lab-run-1",
        startedAt: 1_700_000_000_000,
      });
      vi.setSystemTime(1_700_000_001_000);
      await controllerDriver(controller).fakeControlReady({
        runId: "lab-run-1",
        now: 1_700_000_001_000,
      });

      vi.setSystemTime(1_700_000_010_000);
      const first = await controllerDriver(controller).complete({
        runId: "lab-run-1",
        endReason: "participant_stopped",
        now: 1_700_000_010_000,
      });
      vi.setSystemTime(1_700_000_010_000);
      const repeat = await controllerDriver(controller).complete({
        runId: "lab-run-1",
        endReason: "participant_stopped",
        now: 1_700_000_010_000,
      });
      vi.setSystemTime(1_700_000_010_000);
      const conflict = await controllerDriver(controller).complete({
        runId: "lab-run-1",
        endReason: "agent_requested_end",
        now: 1_700_000_010_000,
      });

      expect(first).toMatchObject({
        status: 202,
        accepted: true,
        state: {
          phase: "ending",
        },
      });
      expect(repeat).toMatchObject({
        status: 202,
        accepted: false,
        idempotent: true,
        conflict: false,
      });
      expect(conflict).toMatchObject({
        status: 202,
        accepted: false,
        idempotent: false,
        conflict: true,
      });
      const conflictRecord = requireDefined(
        readRuntimeDiagnosticRecords(durable).find(
          (record) => record.type === "runtime.ending_conflict",
        ),
        "missing_ending_conflict_record",
      );
      expect(JSON.parse(conflictRecord.payloadJson)).toMatchObject({
        source: "runtime_controller",
        authoritativeEndReason: "participant_stopped",
        requestedEndReason: "agent_requested_end",
        requestedTrigger: "browser_intent",
      });
      vi.setSystemTime(1_700_000_019_000);
      await controller.alarm();
      vi.setSystemTime(1_700_000_020_000);
      await controller.alarm();
      await expect(
        controllerDriver(controller).state({ runId: "lab-run-1" }),
      ).resolves.toMatchObject({
        state: {
          phase: "ended",
          completion: { endReason: "participant_stopped" },
        },
      });
      expect(durable.storage.currentAlarm).toBeNull();

      // A page that leaves sends its Stop for a Run that has already ended: it is not an ending
      // conflict, and the Run keeps its result and reason.
      vi.setSystemTime(1_700_000_030_000);
      await expect(
        controllerDriver(controller).complete({
          runId: "lab-run-1",
          endReason: "participant_disconnected",
          now: 1_700_000_030_000,
        }),
      ).resolves.toMatchObject({
        accepted: false,
        state: { phase: "ended", completion: { endReason: "participant_stopped" } },
      });
      expect(
        readRuntimeDiagnosticRecords(durable)
          .filter((record) => record.type === "runtime.ending_conflict")
          .map((record) => z.record(z.string(), z.json()).parse(JSON.parse(record.payloadJson))),
      ).toEqual([expect.objectContaining({ requestedEndReason: "agent_requested_end" })]);

      durable.close();
    });

    it("requests browser close on timebox before fallback completion", async () => {
      const durable = createTestDurableObjectContext();
      const controller = createInterviewRuntimeController(durable.ctx, {});

      await controllerDriver(controller).start({
        ...originalStart(60_000),
        runId: "lab-run-1",
        startedAt: 1_700_000_000_000,
      });
      vi.setSystemTime(1_700_000_001_000);
      await controllerDriver(controller).fakeControlReady({
        runId: "lab-run-1",
        now: 1_700_000_001_000,
      });
      await renewPresenceUntil(
        controller,
        "lab-run-1",
        [
          1_700_000_005_000, 1_700_000_010_000, 1_700_000_015_000, 1_700_000_020_000,
          1_700_000_025_000, 1_700_000_030_000, 1_700_000_035_000, 1_700_000_040_000,
          1_700_000_045_000, 1_700_000_050_000,
        ],
      );

      vi.spyOn(Date, "now").mockReturnValue(1_700_000_061_000);
      await controller.alarm();

      const requested = await controllerDriver(controller).state({
        runId: "lab-run-1",
      });
      const events = durable.storage.sql
        .exec<{ event_name: string; payload_json: string }>(
          `SELECT event_name, payload_json
        FROM runtime_controller_events
        ORDER BY id ASC`,
        )
        .toArray();

      const requestedState = readRecord(requested.state);
      expect(requestedState).toMatchObject({
        phase: "ending",
        pendingClose: {
          endReason: "timebox_reached",
          source: "timebox_alarm",
        },
      });
      expect(requireValue(requestedState, "missing_runtime_state").completion).toBeUndefined();
      const endingStartedRecord = requireDefined(
        readRuntimeDiagnosticRecords(durable).find(
          (record) => record.type === "runtime.ending_started",
        ),
        "missing_ending_started_record",
      );

      expect(events.map(({ event_name }) => event_name)).toContain("runtime.ending");
      expect(JSON.parse(endingStartedRecord.payloadJson)).toMatchObject({
        source: "runtime_controller",
        endReason: "timebox_reached",
        trigger: "controller_alarm",
      });
      expect(durable.storage.currentAlarm).toBe(1_700_000_062_000);

      await expect(
        controllerDriver(controller).presence({
          runId: "lab-run-1",
          now: 1_700_000_065_000,
          mediaPresent: true,
        }),
      ).resolves.toMatchObject({
        status: 200,
        accepted: false,
        state: {
          phase: "ending",
          pendingClose: {
            endReason: "timebox_reached",
          },
        },
      });

      vi.spyOn(Date, "now").mockReturnValue(1_700_000_070_000);
      await controller.alarm();
      vi.spyOn(Date, "now").mockReturnValue(1_700_000_071_000);
      await controller.alarm();

      await expect(
        controllerDriver(controller).state({ runId: "lab-run-1" }),
      ).resolves.toMatchObject({
        state: {
          phase: "ended",
          completion: {
            endReason: "timebox_reached",
            source: "timebox_alarm",
          },
        },
      });
      expect(durable.storage.currentAlarm).toBeNull();

      durable.close();
    });

    it("persists participant_disconnected completion without a browser observation stream", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const database = createTestLabD1Database();
      const created = await createLabRun(database.d1, {
        now: () => 1_700_000_000_000,
      });
      const durable = createTestDurableObjectContext();
      const callbackFetch = vi.fn(labCallbackFetch({ LAB_DB: database.d1 }));
      const controller = createInterviewRuntimeController(durable.ctx, {
        RUNTIME_COMPLETION_CALLBACK_WORKER: {
          fetch: callbackFetch,
        },
      });

      try {
        await controllerDriver(controller).start({
          ...originalStart(60_000),
          runId: created.runId,
          startedAt: created.startedAt,
          ...deliveryTo("lab", created.runId),
        });
        vi.setSystemTime(1_700_000_001_000);
        await controllerDriver(controller).fakeControlReady({
          runId: created.runId,
          now: 1_700_000_001_000,
        });

        vi.setSystemTime(1_700_000_016_000);
        await controller.alarm();
        vi.setSystemTime(1_700_000_025_000);
        await controller.alarm();
        vi.setSystemTime(1_700_000_026_000);
        await controller.alarm();
        await durable.flushWaitUntil();

        expect(callbackFetch).toHaveBeenCalledTimes(2);
        await expect(getLabRun(database.d1, created.runId)).resolves.toMatchObject({
          runId: created.runId,
          endedAt: 1_700_000_016_000,
          outcome: "failed",
          endReason: "runtime_failed",
        });
      } finally {
        durable.close();
        database.close();
      }
    });
  });
}

export function registerInterviewRuntimeControllerProviderConnectivityTests(): void {
  type ControlledProviderListeners = {
    message: ((event: ProviderSocketEvent) => void)[];
    close: ((event: ProviderSocketEvent) => void)[];
    error: ((event: ProviderSocketEvent) => void)[];
  };

  describe("retained connection close through the Runtime controller", () => {
    it.each(["native_close", "message_failure"] as const)(
      "drains the accepted prefix when %s triggers typed terminal hangup evidence",
      async (trigger) => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        const durable = createTestDurableObjectContext();
        const listeners: ControlledProviderListeners = {
          message: [],
          close: [],
          error: [],
        };
        const socket = {
          readyState: 1,
          accept: vi.fn(),
          send: vi.fn(),
          addEventListener: (
            type: keyof typeof listeners,
            listener: (event: ProviderSocketEvent) => void,
          ) => {
            listeners[type].push(listener);
          },
          removeEventListener: (
            type: keyof typeof listeners,
            listener: (event: ProviderSocketEvent) => void,
          ) => {
            const index = listeners[type].indexOf(listener);
            if (index >= 0) listeners[type].splice(index, 1);
          },
          close: vi.fn(),
        };
        const providerDriver = {
          normalizeEvent: (data) => {
            if (data === "controlled-message-failure") throw new Error("message_processing_failed");
            return openAiDriverOver().normalizeEvent(data);
          },
          createCall: async () =>
            providerSuccess({
              status: 201,
              answerSdp: "answer-sdp",
              responseContentType: "application/sdp",
              sessionLocation: "https://provider.test/rtc_native_close",
              sessionId: "rtc_native_close",
              upstreamRequestId: "req_native_close",
            }),
          connectSideband: async () => providerSuccess(socket),
          sendFinalizationOperation: () => providerSuccess(undefined),
          sendCommand: () => providerSuccess(undefined),
          hangUp: vi.fn(async () =>
            providerFailure({
              stage: "hangup",
              code: "provider_session_already_closed",
              providerStatus: 404,
              retryable: false,
            }),
          ),
        } satisfies RealtimeDriverScript;
        const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
        const driver = controllerDriver(controller);
        try {
          await driver.startConnection({
            selection: originalRealtimeSelection,
            runId: "native-close-drain",
            profile: "realtime-v1",
            connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
            createdAt: Date.now(),
            execution: {
              agentInput: createInterviewConversationInput(
                "Exercise native close.",
                undefined,
                60_000,
              ),
            },
          });
          await vi.waitFor(async () => {
            await expect(driver.state({ runId: "native-close-drain" })).resolves.toMatchObject({
              state: { phase: "live" },
            });
          });
          vi.setSystemTime(1_700_000_000_200);
          vi.setSystemTime(Date.now());
          await driver.complete({
            runId: "native-close-drain",
            endReason: "participant_stopped",
            now: Date.now(),
          });
          vi.setSystemTime(1_700_000_009_300);
          const diagnostic = JSON.stringify({
            event_id: "accepted-diagnostic",
            type: "rate_limits.updated",
            rate_limits: [],
          });
          if (trigger === "native_close") {
            for (const listener of [...listeners.message]) listener({ data: diagnostic });
            for (const listener of [...listeners.close]) listener({ code: 1000 });
          } else {
            for (const listener of [...listeners.message]) {
              listener({ data: "controlled-message-failure" });
              listener({ data: diagnostic });
            }
          }
          await vi.waitFor(() => expect(providerDriver.hangUp).toHaveBeenCalledOnce());
          await vi.waitFor(async () => {
            await expect(driver.state({ runId: "native-close-drain" })).resolves.toMatchObject({
              state: {
                phase: "ended",
                completion: { endReason: "participant_stopped" },
                session: { eventCount: trigger === "native_close" ? 1 : 2 },
              },
            });
          });
          await durable.flushWaitUntil();
          expect(socket.close).toHaveBeenCalledOnce();
          expect(listeners).toEqual({ message: [], close: [], error: [] });
        } finally {
          durable.close();
        }
      },
    );

    // A close that ends the side connection while the result waits only for the reports it
    // received to be handed over releases the session at once, before Ending's checkpoint.
    it("saves the result and releases the session when the side connection closes during Ending", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const listeners: ControlledProviderListeners = { message: [], close: [], error: [] };
      const socket = {
        readyState: 1,
        accept: vi.fn(),
        send: vi.fn(),
        addEventListener: (
          type: keyof typeof listeners,
          listener: (event: ProviderSocketEvent) => void,
        ) => {
          listeners[type].push(listener);
        },
        removeEventListener: (
          type: keyof typeof listeners,
          listener: (event: ProviderSocketEvent) => void,
        ) => {
          const index = listeners[type].indexOf(listener);
          if (index >= 0) listeners[type].splice(index, 1);
        },
        close: vi.fn(),
      };
      const hangUp = vi.fn(async () =>
        providerSuccess({ status: 200, upstreamRequestId: "req_close_ending" }),
      );
      const controller = createInterviewRuntimeController(
        durable.ctx,
        {},
        {
          createCall: async () =>
            providerSuccess({
              status: 201,
              answerSdp: "answer-sdp",
              responseContentType: "application/sdp",
              sessionLocation: "https://provider.test/rtc_close_ending",
              sessionId: "rtc_close_ending",
              upstreamRequestId: "req_close_ending",
            }),
          connectSideband: async () => providerSuccess(socket),
          sendFinalizationOperation: () => providerSuccess(undefined),
          sendCommand: () => providerSuccess(undefined),
          hangUp,
        },
      );
      const driver = controllerDriver(controller);
      const emit = (
        event: Readonly<{
          type: string;
          item_id: string;
          content_index?: number;
          transcript?: string;
        }>,
      ) => {
        for (const listener of [...listeners.message]) listener({ data: JSON.stringify(event) });
      };
      try {
        await driver.startConnection({
          selection: originalRealtimeSelection,
          runId: "close-during-ending",
          profile: "realtime-v1",
          connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
          createdAt: Date.now(),
          execution: {
            agentInput: createInterviewConversationInput("Exercise the close.", undefined, 60_000),
          },
        });
        await vi.waitFor(async () => {
          await expect(driver.state({ runId: "close-during-ending" })).resolves.toMatchObject({
            state: { phase: "live" },
          });
        });
        emit({ type: "input_audio_buffer.speech_started", item_id: "answer" });
        emit({ type: "input_audio_buffer.speech_stopped", item_id: "answer" });
        emit({ type: "input_audio_buffer.committed", item_id: "answer" });
        await vi.waitFor(async () => {
          await expect(driver.state({ runId: "close-during-ending" })).resolves.toMatchObject({
            state: { session: { eventCount: 3 } },
          });
        });
        vi.setSystemTime(1_700_000_000_200);
        await driver.complete({
          runId: "close-during-ending",
          endReason: "participant_stopped",
          now: Date.now(),
        });
        // The answer's text arrives, and the side connection closes before it was handed over.
        vi.setSystemTime(1_700_000_000_700);
        emit({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "answer",
          content_index: 0,
          transcript: "My answer.",
        });
        for (const listener of [...listeners.close]) listener({ code: 1006 });

        // No alarm runs: the close itself saves the result and starts the release, well before
        // Ending's nine-second checkpoint.
        await vi.waitFor(() => expect(hangUp).toHaveBeenCalledOnce());
        await vi.waitFor(async () => {
          await expect(driver.state({ runId: "close-during-ending" })).resolves.toMatchObject({
            state: {
              phase: "ended",
              completion: {
                endReason: "participant_stopped",
                transcriptSnapshot: { turnCount: 1 },
              },
            },
          });
        });
        expect(readRunView(durable).completion?.finalizedAt).toBeLessThan(1_700_000_001_200);
      } finally {
        durable.close();
      }
    });

    it("releases the live native connection when the controller runtime is disposed", async () => {
      const durable = createTestDurableObjectContext();
      const listeners: ControlledProviderListeners = { message: [], close: [], error: [] };
      const socket = {
        readyState: 1,
        accept: vi.fn(),
        send: vi.fn(),
        addEventListener: (
          type: keyof typeof listeners,
          listener: (event: ProviderSocketEvent) => void,
        ) => {
          listeners[type].push(listener);
        },
        removeEventListener: (
          type: keyof typeof listeners,
          listener: (event: ProviderSocketEvent) => void,
        ) => {
          const index = listeners[type].indexOf(listener);
          if (index >= 0) listeners[type].splice(index, 1);
        },
        close: vi.fn(),
      };
      const controller = createInterviewRuntimeController(
        durable.ctx,
        {},
        {
          createCall: async () =>
            providerSuccess({
              status: 201,
              answerSdp: "answer-sdp",
              responseContentType: "application/sdp",
              sessionLocation: "https://provider.test/rtc_disposed",
              sessionId: "rtc_disposed",
              upstreamRequestId: "req_disposed",
            }),
          connectSideband: async () => providerSuccess(socket),
          sendFinalizationOperation: () => providerSuccess(undefined),
          sendCommand: () => providerSuccess(undefined),
        },
      );
      const driver = controllerDriver(controller);
      try {
        await driver.startConnection({
          selection: originalRealtimeSelection,
          runId: "disposed-runtime",
          profile: "realtime-v1",
          connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
          createdAt: Date.now(),
          execution: {
            agentInput: createInterviewConversationInput(
              "Exercise runtime disposal.",
              undefined,
              60_000,
            ),
          },
        });
        await vi.waitFor(async () => {
          await expect(driver.state({ runId: "disposed-runtime" })).resolves.toMatchObject({
            state: { phase: "live" },
          });
        });
        await vi.waitFor(() => expect(listeners.message).toHaveLength(1));
        expect(socket.close).not.toHaveBeenCalled();

        await controller[Symbol.asyncDispose]();
        await durable.flushWaitUntil();

        expect(socket.close).toHaveBeenCalledOnce();
        expect(listeners).toEqual({ message: [], close: [], error: [] });
      } finally {
        durable.close();
      }
    });
  });

  describe("Interview Runtime Controller provider-connectivity", () => {
    it.each(["participant_stopped", "timebox_reached", "runtime_failed"] as const)(
      "rejects a late connection opening after %s wins",
      async (reason) => {
        vi.useFakeTimers();
        const liveAt = 1_700_000_001_000;
        vi.setSystemTime(liveAt - 1000);
        const durable = createTestDurableObjectContext();
        const runId = `late-opening-${reason}`;
        const original = createInterviewRuntimeController(durable.ctx, {});
        await controllerDriver(original).start({
          ...originalStart(reason === "timebox_reached" ? 10000 : 60000),
          runId,
        });
        durable.storage.sql.exec(
          "UPDATE runtime_controller_state SET provider_creation_started = 1, session_id = 'rtc_late' WHERE run_id = ?",
          runId,
        );
        vi.setSystemTime(liveAt);
        await controllerDriver(original).fakeControlReady({ runId, now: liveAt });
        if (reason !== "runtime_failed")
          durable.storage.sql.exec(
            "UPDATE runtime_controller_state SET browser_media_ready_at = ? WHERE run_id = ?",
            liveAt,
            runId,
          );
        const controlled = createControlledProviderSocket();
        const sideband = acceptanceDeferred<ProviderOutcome<ProviderWebSocket>>();
        const commands: unknown[] = [];
        const restored = createInterviewRuntimeController(
          durable.ctx,
          {},
          {
            connectSideband: () => sideband.promise,
            sendCommand: ({ command }) => {
              commands.push(command);
              return providerSuccess(undefined);
            },
            hangUp: async () => providerSuccess({ status: 204, upstreamRequestId: null }),
          },
        );
        await restored.alarm();
        if (reason === "participant_stopped") {
          vi.setSystemTime(liveAt + 2000);
          await controllerDriver(restored).complete({
            runId,
            endReason: "participant_stopped",
            source: "browser_request",
          });
        } else vi.setSystemTime(liveAt + (reason === "timebox_reached" ? 10000 : 15000));
        sideband.resolve(providerSuccess(controlled.socket));
        await vi.advanceTimersByTimeAsync(0);
        expect(commands).toEqual([]);
        await restored.alarm();
        await vi.waitFor(async () => {
          expect(await controllerDriver(restored).state({ runId })).toMatchObject({
            state: { phase: "ending", pendingClose: { endReason: reason } },
          });
        });
        expect(commands).toEqual([]);
        vi.setSystemTime(liveAt + 25000);
        await restored.alarm();
        durable.close();
      },
    );

    it.each(["pending", "pending_ready", "claimed", "sent", "legacy"] as const)(
      "restores a %s opening without replaying an uncertain command",
      async (openingState) => {
        vi.useFakeTimers();
        const liveAt = 1_700_000_001_000;
        vi.setSystemTime(liveAt - 1000);
        const durable = createTestDurableObjectContext();
        const runId = `opening-recovery-${openingState}`;
        const original = createInterviewRuntimeController(durable.ctx, {});
        await controllerDriver(original).start({
          ...originalStart(60_000),
          runId,
        });
        durable.storage.sql.exec(
          "UPDATE runtime_controller_state SET provider_creation_started = 1, session_id = 'rtc_restored' WHERE run_id = ?",
          runId,
        );
        vi.setSystemTime(liveAt);
        await controllerDriver(original).fakeControlReady({ runId, now: liveAt });
        durable.storage.sql.exec(
          "UPDATE runtime_controller_state SET opening_state = ?, browser_media_ready_at = ?, browser_media_ready_deadline_at = ? WHERE run_id = ?",
          openingState === "legacy"
            ? null
            : openingState === "pending_ready"
              ? "pending"
              : openingState,
          openingState === "pending" || openingState === "legacy" ? null : liveAt,
          openingState === "legacy" ? null : liveAt + 15000,
          runId,
        );
        const controlled = createControlledProviderSocket();
        const commands: unknown[] = [];
        const connections: string[] = [];
        const restored = createInterviewRuntimeController(
          durable.ctx,
          {},
          {
            connectSideband: async ({ callId }) => {
              connections.push(callId);
              return providerSuccess(controlled.socket);
            },
            sendCommand: ({ command }) => {
              commands.push(command);
              return providerSuccess(undefined);
            },
          },
        );
        await controllerDriver(restored).state({ runId });
        expect(commands).toEqual([]);
        const ready = () =>
          restored.fetch(
            new Request("https://controller.test/media-ready", {
              method: "POST",
              body: JSON.stringify({ runId }),
            }),
          );
        vi.setSystemTime(liveAt + 3000);
        if (openingState === "pending_ready") {
          expect(durable.storage.currentAlarm).toBeLessThanOrEqual(liveAt + 3000);
          await restored.alarm();
        } else expect(await (await ready()).json()).toEqual({ ok: true });
        expect(await controllerDriver(restored).state({ runId })).toMatchObject({
          state: {
            phase: openingState.startsWith("pending") ? "live" : "ending",
            runId,
            sessionId: "rtc_restored",
            liveAt,
          },
        });
        if (openingState.startsWith("pending"))
          await vi.waitFor(() => expect(connections).toEqual(["rtc_restored"]));
        else {
          expect(connections).toEqual([]);
          expect(await controllerDriver(restored).state({ runId })).toMatchObject({
            state: {
              pendingClose: { endReason: "runtime_failed", source: "session_disconnected" },
            },
          });
        }
        await vi.advanceTimersByTimeAsync(0);
        if (openingState !== "pending_ready") await ready();
        expect(commands).toHaveLength(openingState.startsWith("pending") ? 1 : 0);
        if (openingState.startsWith("pending"))
          expect(commands).toEqual([
            expect.objectContaining({
              type: "response.create",
            }),
          ]);
        const row = durable.storage.sql
          .exec<{
            live_at: number;
            opening_state: string | null;
            browser_media_ready_deadline_at: number | null;
          }>(
            "SELECT live_at, opening_state, browser_media_ready_deadline_at FROM runtime_controller_state",
          )
          .one();
        expect(row).toEqual({
          live_at: liveAt,
          opening_state: openingState.startsWith("pending")
            ? "sent"
            : openingState === "legacy"
              ? null
              : openingState,
          browser_media_ready_deadline_at: openingState === "legacy" ? null : liveAt + 15000,
        });
        await controllerDriver(restored).requiredStop({ runId });
        durable.close();
      },
    );

    it("keeps the media deadline fixed across heartbeats and reconstruction, with End winning earlier", async () => {
      vi.useFakeTimers();
      const liveAt = 1_700_000_001_000;
      vi.setSystemTime(liveAt - 1000);
      for (const stopFirst of [false, true]) {
        const durable = createTestDurableObjectContext();
        const runId = `media-deadline-${stopFirst}`;
        const original = createInterviewRuntimeController(durable.ctx, {});
        await controllerDriver(original).start({
          ...originalStart(60_000),
          runId,
        });
        // Synthetic provider admission keeps this clock-controlled controller probe offline.
        durable.storage.sql.exec(
          "UPDATE runtime_controller_state SET provider_creation_started = 1 WHERE run_id = ?",
          runId,
        );
        vi.setSystemTime(liveAt);
        await controllerDriver(original).fakeControlReady({ runId, now: liveAt });
        vi.setSystemTime(liveAt + 5000);
        await controllerDriver(original).presence({ runId, mediaPresent: true });
        if (stopFirst)
          await controllerDriver(original).complete({
            runId,
            endReason: "participant_stopped",
            source: "browser_request",
          });
        const restored = createInterviewRuntimeController(durable.ctx, {});
        vi.setSystemTime(liveAt + 10000);
        await controllerDriver(restored).presence({ runId, mediaPresent: true });
        const row = durable.storage.sql
          .exec<{ live_at: number; deadline_at: number; browser_media_ready_deadline_at: number }>(
            "SELECT live_at, deadline_at, browser_media_ready_deadline_at FROM runtime_controller_state",
          )
          .one();
        expect(row).toMatchObject({
          live_at: liveAt,
          browser_media_ready_deadline_at: liveAt + 15000,
        });
        if (!stopFirst) expect(row.deadline_at).toBe(liveAt + 60000);
        vi.setSystemTime(liveAt + 15000);
        const ready = await restored.fetch(
          new Request("https://controller.test/media-ready", {
            method: "POST",
            body: JSON.stringify({ runId }),
          }),
        );
        expect(await ready.json()).toEqual({ ok: true });
        vi.setSystemTime(liveAt + 25000);
        await restored.alarm();
        const state = await controllerDriver(restored).state({ runId });
        expect(state).toMatchObject({
          state: {
            phase: "ended",
            completion: {
              endReason: stopFirst ? "participant_stopped" : "runtime_failed",
              endedAt: stopFirst ? liveAt + 5000 : liveAt + 15000,
            },
          },
        });
        expect(
          durable.storage.sql
            .exec<{ browser_media_ready_at: number | null }>(
              "SELECT browser_media_ready_at FROM runtime_controller_state",
            )
            .one().browser_media_ready_at,
        ).toBeNull();
        durable.close();
        vi.setSystemTime(liveAt - 1000);
      }
    });

    it("retains presence evidence across restart and refuses to revive interrupted execution", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const original = createInterviewRuntimeController(durable.ctx, {});
      const driver = controllerDriver(original);
      await driver.start({
        ...originalStart(60_000),
        runId: "presence-restart",
        startedAt: 1_700_000_000_000,
      });
      vi.setSystemTime(1_700_000_001_000);
      await driver.fakeControlReady({ runId: "presence-restart", now: 1_700_000_001_000 });
      await controllerDriver(original).presence({
        runId: "presence-restart",
        now: 1_700_000_003_000,
        mediaPresent: true,
      });
      await controllerDriver(original).presence({
        runId: "presence-restart",
        now: 1_700_000_005_000,
        mediaPresent: false,
      });
      await controllerDriver(original).presence({
        runId: "presence-restart",
        now: 1_700_000_010_000,
        mediaPresent: false,
      });

      vi.setSystemTime(1_700_000_020_000);
      const reinstantiated = createInterviewRuntimeController(durable.ctx, {});
      const late = await controllerDriver(reinstantiated).presence({
        runId: "presence-restart",
        now: 1_700_000_020_000,
        mediaPresent: true,
      });

      expect(late).toMatchObject({
        status: 200,
        accepted: false,
        state: {
          presence: { graceUntil: 1_700_000_020_000, signalCount: 3 },
          // Reconstruction applies the lapsed presence grace before its own failure.
          pendingClose: {
            endReason: "participant_disconnected",
            source: "presence_timeout",
            requestedAt: 1_700_000_020_000,
          },
        },
      });
      expect(
        readRunView(durable)
          .effects.filter(({ kind }) => kind === "close_input")
          .map(({ kind, attemptCount }) => ({ kind, attemptCount })),
      ).toEqual([{ kind: "close_input", attemptCount: 0 }]);
      durable.close();
    });

    it("preserves an earlier trigger when Runtime fails during finalization", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const listeners = createControlledProviderSocketListeners();
      const socket = {
        readyState: 1,
        accept: vi.fn(),
        send: vi.fn(),
        addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
          listeners[type].push(listener);
        }),
        close: vi.fn(),
      };
      const providerDriver = {
        createCall: vi.fn(async () =>
          providerSuccess({
            status: 201,
            answerSdp: "answer-sdp",
            responseContentType: "application/sdp",
            sessionLocation:
              "https://api.openai.com/v1/realtime/calls/rtc_failure_during_finalization",
            sessionId: "rtc_failure_during_finalization",
            upstreamRequestId: "req_failure_during_finalization",
          }),
        ),
        connectSideband: vi
          .fn()
          .mockResolvedValueOnce(providerSuccess(socket))
          .mockResolvedValueOnce(
            providerFailure({
              stage: "session_setup",
              code: "sideband_connect_failed",
              retryable: false,
            }),
          ),
        sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
          providerSuccess(undefined),
        ),
        sendCommand: vi.fn(() => providerSuccess(undefined)),
      } satisfies RealtimeDriverScript;
      const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
      const driver = controllerDriver(controller);

      try {
        await driver.startConnection({
          selection: originalRealtimeSelection,
          runId: "failure-during-finalization",
          profile: "realtime-v1",
          connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
          createdAt: 1_700_000_000_000,
          execution: {
            agentInput: createInterviewConversationInput(
              "Test Runtime failure.",
              undefined,
              60_000,
            ),
          },
        });
        await vi.waitFor(async () => {
          await expect(
            driver.state({ runId: "failure-during-finalization" }),
          ).resolves.toMatchObject({
            state: { phase: "live" },
          });
        });
        vi.setSystemTime(1_700_000_000_100);
        await controllerDriver(controller).complete({
          runId: "failure-during-finalization",
          endReason: "participant_stopped",
          now: 1_700_000_000_100,
        });
        vi.setSystemTime(1_700_000_000_200);
        for (const listener of listeners.close) listener({ code: 1000 });
        await durable.flushWaitUntil();

        durable.storage.sql.exec(
          "UPDATE runtime_controller_state SET execution_wake_at = ? WHERE run_id = ?",
          1_700_000_000_300,
          "failure-during-finalization",
        );
        vi.setSystemTime(1_700_000_000_300);
        await controller.alarm();
        expect(providerDriver.connectSideband).toHaveBeenCalledOnce();
        await durable.flushWaitUntil();

        const { lifecycle } = readRunView(durable);
        if (lifecycle.stage === "live") {
          throw new Error("Expected persisted finalization state.");
        }
        const finalizationState = lifecycle.stage === "ended" ? lifecycle.completion : lifecycle;
        expect(finalizationState).toMatchObject({ endReason: "participant_stopped" });
        expect(finalizationState.warnings).not.toContain("runtime_failed_during_finalization");
      } finally {
        await durable.flushWaitUntil();
        durable.close();
      }
    });

    it("keeps pre-live sideband failure outside finalization", async () => {
      const durable = createTestDurableObjectContext();
      const providerDriver = {
        createCall: vi.fn(async () =>
          providerSuccess({
            status: 201,
            answerSdp: "answer-sdp",
            responseContentType: "application/sdp",
            sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_setup_failure",
            sessionId: "rtc_setup_failure",
            upstreamRequestId: "req_setup_failure",
          }),
        ),
        connectSideband: vi.fn(async () =>
          providerFailure({
            stage: "session_setup",
            code: "sideband_connect_failed",
            retryable: false,
          }),
        ),
      } satisfies RealtimeDriverScript;
      const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
      const driver = controllerDriver(controller);

      await driver.startConnection({
        selection: originalRealtimeSelection,
        runId: "pre-live-sideband-failure",
        profile: "realtime-v1",
        connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
        execution: {
          agentInput: createInterviewConversationInput("Test setup failure.", undefined, 60_000),
        },
      });
      await durable.flushWaitUntil();

      const failed = await driver.state({ runId: "pre-live-sideband-failure" });
      expect(failed).toMatchObject({ state: { phase: "failed" } });
      const failedState = readRecord(failed.state);
      expect(failedState).not.toHaveProperty("pendingClose");
      expect(failedState).not.toHaveProperty("completion");
      durable.close();
    });

    it("routes sideband message failures through Runtime failure before and after another trigger", async () => {
      vi.useFakeTimers();
      for (const afterAnotherTrigger of [false, true]) {
        vi.setSystemTime(1_700_000_000_000);
        const runId = afterAnotherTrigger
          ? "message-failure-after-trigger"
          : "message-failure-first";
        const durable = createTestDurableObjectContext();
        const listeners = createControlledProviderSocketListeners();
        const socket = {
          readyState: 1,
          accept: vi.fn(),
          send: vi.fn(),
          addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
            listeners[type].push(listener);
          }),
          close: vi.fn(),
        };
        const providerDriver = {
          normalizeEvent: vi.fn(() => {
            throw new Error("injected_sideband_message_failure");
          }),
          createCall: vi.fn(async () =>
            providerSuccess({
              status: 201,
              answerSdp: "answer-sdp",
              responseContentType: "application/sdp",
              sessionLocation: `https://api.openai.com/v1/realtime/calls/${runId}`,
              sessionId: runId,
              upstreamRequestId: `req_${runId}`,
            }),
          ),
          connectSideband: vi.fn(async () => providerSuccess(socket)),
          sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
            providerSuccess(undefined),
          ),
          sendCommand: vi.fn((_input: ProviderSendCommandInput) => providerSuccess(undefined)),
          hangUp: vi.fn(async () =>
            providerSuccess({ status: 200, upstreamRequestId: `req_${runId}_hangup` }),
          ),
        } satisfies RealtimeDriverScript;
        const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
        const driver = controllerDriver(controller);

        try {
          await driver.startConnection({
            selection: originalRealtimeSelection,
            runId,
            profile: "realtime-v1",
            connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
            createdAt: 1_700_000_000_000,
            execution: {
              agentInput: createInterviewConversationInput(
                "Test message failure.",
                undefined,
                60_000,
              ),
            },
          });
          await vi.waitFor(async () => {
            await expect(driver.state({ runId })).resolves.toMatchObject({
              state: { phase: "live" },
            });
          });
          if (afterAnotherTrigger) {
            vi.setSystemTime(1_700_000_000_100);
            await controllerDriver(controller).complete({
              runId,
              endReason: "participant_stopped",
              now: 1_700_000_000_100,
            });
          }

          vi.setSystemTime(1_700_000_000_200);
          for (const listener of listeners.message) {
            listener({
              data: JSON.stringify({
                event_id: `event_${runId}`,
                type: "response.created",
                response: { id: `response_${runId}` },
              }),
            });
          }

          await vi.waitFor(() => {
            const { lifecycle } = readRunView(durable);
            if (lifecycle.stage === "live" || lifecycle.stage === "ended") {
              throw new Error("Expected active finalization state after message failure.");
            }
            expect(lifecycle).toMatchObject(
              afterAnotherTrigger
                ? {
                    endReason: "participant_stopped",
                    source: "browser_request",
                    warnings: ["runtime_failed_during_finalization"],
                  }
                : {
                    endReason: "runtime_failed",
                    source: "session_message_failure",
                    warnings: [],
                  },
            );
          });

          vi.setSystemTime(1_700_000_010_000);
          await controller.alarm();
          vi.setSystemTime(1_700_000_020_000);
          await controller.alarm();

          await expect(driver.state({ runId })).resolves.toMatchObject({
            state: {
              phase: "ended",
              completion: afterAnotherTrigger
                ? {
                    endReason: "participant_stopped",
                    source: "browser_request",
                    outcome: "ended",
                    warnings: ["runtime_failed_during_finalization"],
                  }
                : {
                    endReason: "runtime_failed",
                    source: "session_message_failure",
                    outcome: "failed",
                    warnings: [],
                  },
            },
          });
        } finally {
          for (const listener of listeners.close) listener({ code: 1000 });
          await durable.flushWaitUntil();
          durable.close();
        }
      }
    });

    it.each([
      ["Original", originalRealtimeSelection, () => createInterviewConversationInput("Ask.")],
      ["Goodbye", goodbyeRealtimeSelection, () => sampleGoodbyeInput()],
      ["Questions", questionsRealtimeSelection, () => sampleQuestionsInput(sampleQuestionPrompts)],
    ] as const)(
      "ends the %s Realtime Run as interrupted when Runtime cannot save a report during Live",
      async (_name, selection, agentInput) => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        const runId = "report-save-failure";
        const durable = createTestDurableObjectContext();
        const provider = createControlledProviderSocket();
        const providerDriver = {
          normalizeEvent: vi.fn(normalizeProviderRealtimeEvent),
          createCall: vi.fn(async () =>
            providerSuccess({
              status: 201,
              answerSdp: "answer-sdp",
              responseContentType: "application/sdp",
              sessionLocation: `https://api.openai.com/v1/realtime/calls/${runId}`,
              sessionId: runId,
              upstreamRequestId: `req_${runId}`,
            }),
          ),
          connectSideband: vi.fn(async () => providerSuccess(provider.socket)),
          sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
            providerSuccess(undefined),
          ),
          sendCommand: vi.fn((_input: ProviderSendCommandInput) => providerSuccess(undefined)),
          hangUp: vi.fn(async () =>
            providerSuccess({ status: 200, upstreamRequestId: `req_${runId}_hangup` }),
          ),
        } satisfies RealtimeDriverScript;
        const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
        const driver = controllerDriver(controller);
        // The next save of a provider report fails, as a storage write failure would.
        const sql = durable.storage.sql;
        const exec = sql.exec.bind(sql);
        let failNextReportSave = false;
        vi.spyOn(sql, "exec").mockImplementation((query, ...params) => {
          if (failNextReportSave && query.includes("SET session_event_count")) {
            failNextReportSave = false;
            throw new Error("report_save_failed");
          }
          return exec(query, ...params);
        });

        try {
          await driver.startConnection({
            selection,
            runId,
            profile: "realtime-v1",
            connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
            createdAt: 1_700_000_000_000,
            execution: { agentInput: agentInput() },
          });
          await vi.waitFor(async () => {
            await expect(driver.state({ runId })).resolves.toMatchObject({
              state: { phase: "live" },
            });
          });

          vi.setSystemTime(1_700_000_000_200);
          failNextReportSave = true;
          provider.emit("message", {
            data: JSON.stringify({
              event_id: "event_unsaved",
              type: "response.created",
              response: { id: "response_unsaved" },
            }),
          });

          await vi.waitFor(() => {
            expect(readRunView(durable).lifecycle).toMatchObject({
              endReason: "runtime_failed",
              source: "session_message_failure",
              warnings: [],
            });
          });
          vi.setSystemTime(1_700_000_010_000);
          await controller.alarm();
          vi.setSystemTime(1_700_000_020_000);
          await controller.alarm();
          await expect(driver.state({ runId })).resolves.toMatchObject({
            state: {
              phase: "ended",
              completion: {
                endReason: "runtime_failed",
                source: "session_message_failure",
                outcome: "failed",
              },
            },
          });
          expect(failNextReportSave).toBe(false);
          // Runtime's report path decides it; the execution's message handling is not involved.
          expect(
            sql
              .exec<{ count: number }>(
                "SELECT COUNT(*) AS count FROM runtime_controller_events WHERE event_name = ?",
                "sideband.message_failed",
              )
              .one().count,
          ).toBe(0);
        } finally {
          provider.emit("close", { code: 1000 });
          await durable.flushWaitUntil();
          durable.close();
        }
      },
    );

    it("does not reconnect an existing call after terminal provider closure evidence", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const socketListeners = createControlledProviderSocketListeners();
      const socket = {
        readyState: 1,
        accept: vi.fn(),
        send: vi.fn(),
        addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
          socketListeners[type].push(listener);
        }),
        close: vi.fn(),
      };
      const providerDriver = {
        normalizeEvent: vi.fn(normalizeProviderRealtimeEvent),
        createCall: vi.fn(async () =>
          providerSuccess({
            status: 201,
            answerSdp: "answer-sdp",
            responseContentType: "application/sdp",
            sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_terminal_close",
            sessionId: "rtc_terminal_close",
            upstreamRequestId: "req_terminal_close",
          }),
        ),
        connectSideband: vi
          .fn()
          .mockResolvedValueOnce(providerSuccess(socket))
          .mockResolvedValue(
            providerFailure({
              stage: "session_setup",
              code: "sideband_call_id_not_found",
              providerStatus: 404,
              retryable: false,
            }),
          ),
        sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
          providerSuccess(undefined),
        ),
        sendCommand: vi.fn(() => providerSuccess(undefined)),
        hangUp: vi.fn(async () =>
          providerFailure({
            stage: "hangup",
            code: "session_release_failed",
            providerStatus: 404,
            requestId: "req_terminal_close_hangup",
            retryable: false,
          }),
        ),
      } satisfies RealtimeDriverScript;
      const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
      const driver = controllerDriver(controller);

      try {
        await driver.startConnection({
          selection: originalRealtimeSelection,
          runId: "terminal-close-retry-run",
          profile: "realtime-v1",
          connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
          createdAt: 1_700_000_000_000,
          execution: {
            agentInput: createInterviewConversationInput(
              "Test reconnect containment.",
              undefined,
              60_000,
            ),
          },
        });
        await vi.waitFor(async () => {
          await expect(driver.state({ runId: "terminal-close-retry-run" })).resolves.toMatchObject({
            state: { phase: "live" },
          });
        });

        vi.setSystemTime(1_700_000_000_100);
        for (const listener of socketListeners.message) {
          listener({
            data: JSON.stringify({ event_id: "event_terminal", type: "session.closed" }),
          });
        }
        await vi.advanceTimersByTimeAsync(0);
        await vi.waitFor(async () => {
          await expect(driver.state({ runId: "terminal-close-retry-run" })).resolves.toMatchObject({
            state: {
              phase: "ending",
              pendingClose: {
                endReason: "runtime_failed",
                source: "session_closed_observed",
                requestedAt: 1_700_000_000_100,
              },
              finalization: { stage: "draining" },
            },
          });
        });
        vi.setSystemTime(1_700_000_001_100);
        await controller.alarm();
        await expect(driver.state({ runId: "terminal-close-retry-run" })).resolves.toMatchObject({
          state: {
            phase: "ended",
            completion: {
              endReason: "runtime_failed",
              source: "session_closed_observed",
            },
          },
        });
        expect(providerDriver.hangUp).toHaveBeenCalledWith({
          apiKey: "",
          callId: "rtc_terminal_close",
          timeoutMs: 8_000,
        });
        for (const listener of socketListeners.close) listener({ code: 1000 });
        await durable.flushWaitUntil();
        expect(providerDriver.connectSideband).toHaveBeenCalledTimes(1);

        const repeated = await driver.startConnection({
          selection: originalRealtimeSelection,
          runId: "terminal-close-retry-run",
          profile: "realtime-v1",
          connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
          createdAt: 1_700_000_099_000,
          execution: {
            agentInput: createInterviewConversationInput(
              "Test reconnect containment.",
              undefined,
              60_000,
            ),
          },
        });

        // The connection exchange refuses an ended Run's repeat; it neither replays nor reconnects.
        expect(repeated).toMatchObject({ status: 409, error: "runtime_controller_start_failed" });
        expect(providerDriver.connectSideband).toHaveBeenCalledTimes(1);
      } finally {
        await durable.flushWaitUntil();
        durable.close();
      }
    });

    it("discards an in-flight reconnect after terminal hangup evidence", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const firstListeners = createControlledProviderSocketListeners();
      const secondListeners = createControlledProviderSocketListeners();
      const firstSocket = {
        readyState: 1,
        accept: vi.fn(),
        send: vi.fn(),
        addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
          firstListeners[type].push(listener);
        }),
        close: vi.fn(),
      };
      const secondSocket = {
        readyState: 1,
        accept: vi.fn(),
        send: vi.fn(),
        addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
          secondListeners[type].push(listener);
        }),
        close: vi.fn(),
      };
      type SidebandOutcome = ProviderOutcome<ProviderWebSocket>;
      let resolveReconnect: (outcome: SidebandOutcome) => void = () => undefined;
      const reconnect = new Promise<SidebandOutcome>((resolve) => {
        resolveReconnect = resolve;
      });
      const providerDriver = {
        normalizeEvent: vi.fn(normalizeProviderRealtimeEvent),
        createCall: vi.fn(async () =>
          providerSuccess({
            status: 201,
            answerSdp: "answer-sdp",
            responseContentType: "application/sdp",
            sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_inflight_reconnect",
            sessionId: "rtc_inflight_reconnect",
            upstreamRequestId: "req_inflight_reconnect",
          }),
        ),
        connectSideband: vi
          .fn()
          .mockResolvedValueOnce(providerSuccess(firstSocket))
          .mockReturnValueOnce(reconnect),
        sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
          providerSuccess(undefined),
        ),
        sendCommand: vi.fn(() => providerSuccess(undefined)),
        hangUp: vi.fn(async () =>
          providerFailure({
            stage: "hangup",
            code: "provider_session_already_closed",
            providerStatus: 404,
            requestId: "req_already_closed",
            retryable: false,
          }),
        ),
      } satisfies RealtimeDriverScript;
      const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
      const driver = controllerDriver(controller);

      try {
        await driver.startConnection({
          selection: originalRealtimeSelection,
          runId: "inflight-reconnect-terminal-run",
          profile: "realtime-v1",
          connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
          createdAt: 1_700_000_000_000,
          execution: {
            agentInput: createInterviewConversationInput(
              "Test in-flight reconnect.",
              undefined,
              60_000,
            ),
          },
        });
        await vi.waitFor(async () => {
          await expect(
            driver.state({ runId: "inflight-reconnect-terminal-run" }),
          ).resolves.toMatchObject({ state: { phase: "live" } });
        });
        vi.setSystemTime(1_700_000_000_100);
        await controllerDriver(controller).complete({
          runId: "inflight-reconnect-terminal-run",
          endReason: "participant_stopped",
          now: 1_700_000_000_100,
        });

        vi.setSystemTime(1_700_000_000_200);
        for (const listener of firstListeners.close) listener({ code: 1000 });
        await durable.flushWaitUntil();
        durable.storage.sql.exec(
          "UPDATE runtime_controller_state SET execution_wake_at = ? WHERE run_id = ?",
          1_700_000_000_300,
          "inflight-reconnect-terminal-run",
        );

        vi.setSystemTime(1_700_000_000_300);
        await controller.alarm();
        expect(providerDriver.connectSideband).toHaveBeenCalledOnce();

        vi.setSystemTime(1_700_000_001_100);
        await controller.alarm();
        await vi.waitFor(() => expect(providerDriver.hangUp).toHaveBeenCalledOnce());
        await expect(
          driver.state({ runId: "inflight-reconnect-terminal-run" }),
        ).resolves.toMatchObject({
          state: { finalization: { stage: "ended" } },
        });

        resolveReconnect(providerSuccess(secondSocket));
        expect(secondSocket.addEventListener).not.toHaveBeenCalled();
      } finally {
        for (const listener of secondListeners.close) listener({ code: 1000 });
        await durable.flushWaitUntil();
        durable.close();
      }
    });

    it("keeps an in-flight reconnect through quiet while the drain obligation remains open", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const firstListeners = createControlledProviderSocketListeners();
      const secondListeners = createControlledProviderSocketListeners();
      const firstSocket = {
        readyState: 1,
        accept: vi.fn(),
        send: vi.fn(),
        addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
          firstListeners[type].push(listener);
        }),
        close: vi.fn(),
      };
      const secondSocket = {
        readyState: 1,
        accept: vi.fn(),
        send: vi.fn(),
        addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
          secondListeners[type].push(listener);
        }),
        close: vi.fn(),
      };
      type SidebandOutcome = ProviderOutcome<ProviderWebSocket>;
      let resolveReconnect: (outcome: SidebandOutcome) => void = () => undefined;
      const reconnect = new Promise<SidebandOutcome>((resolve) => {
        resolveReconnect = resolve;
      });
      const providerDriver = {
        normalizeEvent: vi.fn(normalizeProviderRealtimeEvent),
        createCall: vi.fn(async () =>
          providerSuccess({
            status: 201,
            answerSdp: "answer-sdp",
            responseContentType: "application/sdp",
            sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_quiet_reconnect",
            sessionId: "rtc_quiet_reconnect",
            upstreamRequestId: "req_quiet_reconnect",
          }),
        ),
        connectSideband: vi
          .fn()
          .mockResolvedValueOnce(providerSuccess(firstSocket))
          .mockReturnValueOnce(reconnect),
        sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
          providerSuccess(undefined),
        ),
        sendCommand: vi.fn(() => providerSuccess(undefined)),
      } satisfies RealtimeDriverScript;
      const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
      const driver = controllerDriver(controller);

      try {
        await driver.startConnection({
          selection: originalRealtimeSelection,
          runId: "quiet-inflight-reconnect-run",
          profile: "realtime-v1",
          connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
          createdAt: 1_700_000_000_000,
          execution: {
            agentInput: createInterviewConversationInput(
              "Test quiet reconnect.",
              undefined,
              60_000,
            ),
          },
        });
        await vi.waitFor(async () => {
          await expect(
            driver.state({ runId: "quiet-inflight-reconnect-run" }),
          ).resolves.toMatchObject({
            state: { phase: "live" },
          });
        });
        vi.setSystemTime(1_700_000_000_100);
        await controllerDriver(controller).complete({
          runId: "quiet-inflight-reconnect-run",
          endReason: "participant_stopped",
          now: 1_700_000_000_100,
        });
        vi.setSystemTime(1_700_000_000_150);
        for (const listener of firstListeners.message) {
          listener({
            data: JSON.stringify({
              event_id: "event_quiet_reconnect_item",
              type: "input_audio_buffer.committed",
              item_id: "item_quiet_reconnect",
            }),
          });
        }
        await vi.waitFor(async () => {
          await expect(
            driver.state({ runId: "quiet-inflight-reconnect-run" }),
          ).resolves.toMatchObject({
            state: { session: { eventCount: 1 } },
          });
        });
        vi.setSystemTime(1_700_000_000_200);
        for (const listener of firstListeners.close) listener({ code: 1000 });
        await durable.flushWaitUntil();
        durable.storage.sql.exec(
          "UPDATE runtime_controller_state SET execution_wake_at = ? WHERE run_id = ?",
          1_700_000_000_300,
          "quiet-inflight-reconnect-run",
        );

        vi.setSystemTime(1_700_000_000_300);
        await controller.alarm();
        expect(providerDriver.connectSideband).toHaveBeenCalledOnce();

        vi.setSystemTime(1_700_000_001_200);
        resolveReconnect(providerSuccess(secondSocket));
        expect(secondSocket.addEventListener).not.toHaveBeenCalled();
        expect(secondSocket.close).not.toHaveBeenCalled();
        await expect(
          driver.state({ runId: "quiet-inflight-reconnect-run" }),
        ).resolves.toMatchObject({
          state: { finalization: { stage: "draining" } },
        });
      } finally {
        for (const listener of secondListeners.close) listener({ code: 1000 });
        await durable.flushWaitUntil();
        durable.close();
      }
    });

    it("discards an in-flight reconnect after the drain deadline", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const firstListeners = createControlledProviderSocketListeners();
      const secondListeners = createControlledProviderSocketListeners();
      const firstSocket = {
        readyState: 1,
        accept: vi.fn(),
        send: vi.fn(),
        addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
          firstListeners[type].push(listener);
        }),
        close: vi.fn(),
      };
      const secondSocket = {
        readyState: 1,
        accept: vi.fn(),
        send: vi.fn(),
        addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
          secondListeners[type].push(listener);
        }),
        close: vi.fn(),
      };
      type SidebandOutcome = ProviderOutcome<ProviderWebSocket>;
      let resolveReconnect: (outcome: SidebandOutcome) => void = () => undefined;
      const reconnect = new Promise<SidebandOutcome>((resolve) => {
        resolveReconnect = resolve;
      });
      const providerDriver = {
        normalizeEvent: vi.fn(normalizeProviderRealtimeEvent),
        createCall: vi.fn(async () =>
          providerSuccess({
            status: 201,
            answerSdp: "answer-sdp",
            responseContentType: "application/sdp",
            sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_overdue_reconnect",
            sessionId: "rtc_overdue_reconnect",
            upstreamRequestId: "req_overdue_reconnect",
          }),
        ),
        connectSideband: vi
          .fn()
          .mockResolvedValueOnce(providerSuccess(firstSocket))
          .mockReturnValueOnce(reconnect),
        sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
          providerSuccess(undefined),
        ),
        sendCommand: vi.fn(() => providerSuccess(undefined)),
      } satisfies RealtimeDriverScript;
      const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
      const driver = controllerDriver(controller);

      try {
        await driver.startConnection({
          selection: originalRealtimeSelection,
          runId: "overdue-inflight-reconnect-run",
          profile: "realtime-v1",
          connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
          createdAt: 1_700_000_000_000,
          execution: {
            agentInput: createInterviewConversationInput(
              "Test overdue reconnect.",
              undefined,
              60_000,
            ),
          },
        });
        await vi.waitFor(async () => {
          await expect(
            driver.state({ runId: "overdue-inflight-reconnect-run" }),
          ).resolves.toMatchObject({ state: { phase: "live" } });
        });
        vi.setSystemTime(1_700_000_000_100);
        await controllerDriver(controller).complete({
          runId: "overdue-inflight-reconnect-run",
          endReason: "participant_stopped",
          now: 1_700_000_000_100,
        });

        vi.setSystemTime(1_700_000_000_200);
        for (const listener of firstListeners.close) listener({ code: 1000 });
        await durable.flushWaitUntil();
        durable.storage.sql.exec(
          "UPDATE runtime_controller_state SET execution_wake_at = ? WHERE run_id = ?",
          1_700_000_000_300,
          "overdue-inflight-reconnect-run",
        );
        vi.setSystemTime(1_700_000_000_300);
        await controller.alarm();
        expect(providerDriver.connectSideband).toHaveBeenCalledOnce();

        vi.setSystemTime(1_700_000_006_101);
        resolveReconnect(providerSuccess(secondSocket));
        await Promise.resolve();

        expect(secondSocket.addEventListener).not.toHaveBeenCalled();
        expect(secondSocket.close).not.toHaveBeenCalled();
      } finally {
        for (const listener of secondListeners.close) listener({ code: 1000 });
        await durable.flushWaitUntil();
        durable.close();
      }
    });

    it("suppresses a closing-stage reconnect after a transient sideband disconnect", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const socketListeners = createControlledProviderSocketListeners();
      const socket = {
        readyState: 1,
        accept: vi.fn(),
        send: vi.fn(),
        addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
          socketListeners[type].push(listener);
        }),
        close: vi.fn(),
      };
      type HangupOutcome = ProviderOutcome<ProviderHangup>;
      let resolveHangup: (outcome: HangupOutcome) => void = () => undefined;
      const hangup = new Promise<HangupOutcome>((resolve) => {
        resolveHangup = resolve;
      });
      const providerDriver = {
        normalizeEvent: vi.fn(normalizeProviderRealtimeEvent),
        createCall: vi.fn(async () =>
          providerSuccess({
            status: 201,
            answerSdp: "answer-sdp",
            responseContentType: "application/sdp",
            sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_closing_disconnect",
            sessionId: "rtc_closing_disconnect",
            upstreamRequestId: "req_closing_disconnect",
          }),
        ),
        connectSideband: vi.fn(async () => providerSuccess(socket)),
        sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
          providerSuccess(undefined),
        ),
        sendCommand: vi.fn((_input: ProviderSendCommandInput) => providerSuccess(undefined)),
        hangUp: vi.fn((_input: Parameters<ScriptedRealtimeDriver["hangUp"]>[0]) => hangup),
      } satisfies RealtimeDriverScript;
      const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
      const driver = controllerDriver(controller);

      await driver.startConnection({
        selection: originalRealtimeSelection,
        runId: "closing-transient-disconnect-run",
        profile: "realtime-v1",
        connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
        createdAt: 1_700_000_000_000,
        execution: {
          agentInput: createInterviewConversationInput(
            "Test closing reconnect.",
            undefined,
            60_000,
          ),
        },
      });
      await vi.waitFor(async () => {
        await expect(
          driver.state({ runId: "closing-transient-disconnect-run" }),
        ).resolves.toMatchObject({
          state: { phase: "live" },
        });
      });
      vi.setSystemTime(1_700_000_000_100);
      await controllerDriver(controller).complete({
        runId: "closing-transient-disconnect-run",
        endReason: "participant_stopped",
        now: 1_700_000_000_100,
      });

      vi.setSystemTime(1_700_000_006_100);
      const closeAlarm = controller.alarm();
      await vi.waitFor(() => expect(providerDriver.hangUp).toHaveBeenCalledOnce());
      await expect(
        driver.state({ runId: "closing-transient-disconnect-run" }),
      ).resolves.toMatchObject({
        state: { phase: "ending", finalization: { stage: "finalizing" } },
      });
      for (const listener of socketListeners.close) listener({ code: 1000 });
      await vi.waitFor(() => {
        expect(
          readRuntimeDiagnosticRecords(durable).some(
            (record) => record.type === "realtime.close_only_reconnect_suppressed",
          ),
        ).toBe(true);
      });

      expect(
        durable.storage.sql
          .exec<{ execution_wake_at: number | null }>(
            `SELECT execution_wake_at FROM runtime_controller_state WHERE run_id = ?`,
            "closing-transient-disconnect-run",
          )
          .one().execution_wake_at,
      ).toBeNull();
      expect(
        readRuntimeDiagnosticRecords(durable).some(
          (record) => record.type === "realtime.close_only_reconnect_suppressed",
        ),
      ).toBe(true);

      resolveHangup(providerSuccess({ status: 200, upstreamRequestId: "req_closing_hangup" }));
      await closeAlarm;
      for (const listener of socketListeners.close) listener({ code: 1000 });
      await durable.flushWaitUntil();
      durable.close();
    });

    it("emits provider call diagnostics with the runtime diagnostics context", async () => {
      const durable = createTestDurableObjectContext();
      const providerDriver = {
        createCall: vi.fn(async () =>
          providerSuccess({
            status: 201,
            answerSdp: "answer-sdp",
            responseContentType: "application/sdp",
            sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_provider_call",
            sessionId: "rtc_provider_call",
            upstreamRequestId: "req_provider_call",
          }),
        ),
        connectSideband: vi.fn(async () =>
          providerFailure({
            stage: "session_setup",
            code: "sideband_call_id_not_found",
            providerStatus: 404,
            retryable: false,
          }),
        ),
      } satisfies RealtimeDriverScript;
      const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);

      await controllerDriver(controller).startConnection({
        selection: originalRealtimeSelection,
        runId: "lab-run-1",
        profile: "realtime-v1",
        connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
        createdAt: 1_700_000_000_000,
        execution: {
          agentInput: createInterviewConversationInput("Lab instructions", undefined, 60_000),
        },
        diagnosticsContext: {
          surface: "lab",
          environment: "test",
          appResourceKind: "lab_run",
          appResourceId: "lab-run-1",
        },
      });

      const providerCallRecord = requireDefined(
        readRuntimeDiagnosticRecords(durable).find(
          (record) => record.type === "realtime.call_recorded",
        ),
        "missing_provider_call_record",
      );

      expect(JSON.parse(providerCallRecord.payloadJson)).toMatchObject({
        surface: "lab",
        environment: "test",
        appResourceKind: "lab_run",
        appResourceId: "lab-run-1",
        source: "realtime_execution",
        phase: "setup",
        provider: "openai_realtime",
        sessionId: "rtc_provider_call",
        upstreamRequestId: "req_provider_call",
        settingsSummary: {
          model: "gpt-realtime-2.1",
          voice: "marin",
        },
      });
      expect(providerDriver.connectSideband).toHaveBeenCalledOnce();
      await durable.flushWaitUntil();

      durable.close();
    });

    it.each(["none", "minimal", "xhigh"])(
      "maps the %s reasoning effort through controller preparation",
      async (reasoningEffort) => {
        const durable = createTestDurableObjectContext();
        const providerDriver = {
          createCall: vi.fn(async (_input: ProviderCreateCallInput) =>
            providerSuccess({
              status: 201,
              answerSdp: "answer-sdp",
              responseContentType: "application/sdp",
              sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_reasoning",
              sessionId: "rtc_reasoning",
              upstreamRequestId: "req_reasoning",
            }),
          ),
          connectSideband: vi.fn(async () =>
            providerFailure({
              stage: "session_setup",
              code: "sideband_call_id_not_found",
              providerStatus: 404,
              retryable: false,
            }),
          ),
        } satisfies RealtimeDriverScript;
        const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);

        await controllerDriver(controller).startConnection({
          selection: originalRealtimeSelection,
          runId: `lab-run-${reasoningEffort}`,
          profile: "realtime-v1",
          connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
          execution: {
            agentInput: createInterviewConversationInput(
              "Distinctive Lab instructions",
              undefined,
              300_000,
            ),
          },
          reasoningEffort,
        });

        expect(
          requireDefined(providerDriver.createCall.mock.calls[0], "missing_create_call")[0].session
            .reasoning,
        ).toEqual(reasoningEffort === "none" ? null : { effort: reasoningEffort });
        expect(providerDriver.connectSideband).toHaveBeenCalledOnce();
        await durable.flushWaitUntil();
        durable.close();
      },
    );

    it.each([
      {},
      {
        contract: "interview-agent/v1",
        templateVersion: "configured-interview/v1",
        instructions: 42,
      },
      {
        contract: "interview-agent/v2",
        templateVersion: "configured-interview/v1",
        instructions: "Ask why",
      },
      { contract: "interview-agent/v1", templateVersion: { version: 1 }, instructions: "Ask why" },
    ])(
      "rejects malformed Agent input before admission or native creation: %j",
      async (agentInput) => {
        const durable = createTestDurableObjectContext();
        const provider = { createCall: vi.fn() } satisfies RealtimeDriverScript;
        const controller = createInterviewRuntimeController(durable.ctx, {}, provider);
        try {
          const response = await controllerDriver(controller).startConnection({
            selection: originalRealtimeSelection,
            runId: "invalid-agent-input",
            profile: "realtime-v1",
            connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
            execution: { agentInput },
          });
          expect(response.status).toBe(400);
          expect(response.data).toEqual({
            runId: "invalid-agent-input",
            exchangeId: "exchange",
            error: "invalid_conversation_input",
            acceptance: "not_accepted",
          });
          expect(provider.createCall).not.toHaveBeenCalled();
          expect(await controllerDriver(controller).state()).toMatchObject({
            state: null,
          });
          expect(readStartFailures(durable.ctx)).toEqual([
            expect.objectContaining({
              runId: "invalid-agent-input",
              operation: "connection",
              exchangeId: "exchange",
              error: "invalid_conversation_input",
              status: 400,
              failure: "refusal",
              acceptance: "not_accepted",
              stage: "runtimeAccepted",
            }),
          ]);
          await durable.flushWaitUntil();
        } finally {
          durable.close();
        }
      },
    );

    it("reports blank raw instructions before making a provider call", async () => {
      const durable = createTestDurableObjectContext();
      const providerDriver = {
        createCall: vi.fn(),
      } satisfies RealtimeDriverScript;
      const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);

      const response = await controllerDriver(controller).startConnection({
        selection: originalRealtimeSelection,
        runId: "invalid-execution-run",
        profile: "realtime-v1",
        connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
        execution: { agentInput: createInterviewConversationInput("   ") },
      });
      expect(response).toMatchObject({
        status: 400,
        data: { error: "invalid_conversation_input" },
      });
      expect(providerDriver.createCall).not.toHaveBeenCalled();

      durable.close();
    });

    it("does not call the provider when configured interview preparation fails", async () => {
      const durable = createTestDurableObjectContext();
      const providerDriver = {
        createCall: vi.fn(),
      } satisfies RealtimeDriverScript;
      const contentPreparer = vi.fn(() => {
        throw new Error("configured_interview_template_failed");
      });
      const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver, {
        prepareContent: contentPreparer,
      });

      const response = await controllerDriver(controller).startConnection({
        selection: originalRealtimeSelection,
        runId: "template-failure-run",
        profile: "realtime-v1",
        connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
        execution: originalStart(300_000).execution,
      });
      expect(response).toMatchObject({
        status: 500,
        data: { error: "configured_interview_template_failed" },
      });

      expect(contentPreparer).toHaveBeenCalledTimes(1);
      expect(providerDriver.createCall).not.toHaveBeenCalled();
      await expect(
        controllerDriver(controller).state({ runId: "template-failure-run" }),
      ).resolves.toMatchObject({
        state: null,
      });

      durable.close();
    });

    it("keeps lifecycle state in the controller while using an injected provider driver", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const socketListeners = createControlledProviderSocketListeners();
      const socketSend = vi.fn<(data: string) => void>();
      const socket = {
        readyState: 1,
        accept: vi.fn(),
        send: socketSend,
        addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
          socketListeners[type].push(listener);
        }),
        close: vi.fn(),
      };
      const emitSocketEvent = (type: SocketEventType, event: SocketEvent) => {
        for (const listener of socketListeners[type]) {
          listener(event);
        }
      };
      const providerDriver = {
        normalizeEvent: vi.fn(normalizeProviderRealtimeEvent),
        createCall: vi.fn(async (_input: ProviderCreateCallInput) =>
          providerSuccess({
            status: 201,
            answerSdp: "answer-sdp",
            responseContentType: "application/sdp",
            sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_fake_driver",
            sessionId: "rtc_fake_driver",
            upstreamRequestId: "req_fake_driver",
          }),
        ),
        connectSideband: vi.fn(async () => {
          socket.accept();
          return providerSuccess(socket);
        }),
        sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
          providerSuccess(undefined),
        ),
        sendCommand: vi.fn(({ socket: connectedSocket, command }: ProviderSendCommandInput) => {
          connectedSocket.send(JSON.stringify(command));
          return providerSuccess(undefined);
        }),
        hangUp: vi.fn(async () =>
          providerSuccess({
            status: 200,
            upstreamRequestId: "req_fake_hangup",
          }),
        ),
      } satisfies RealtimeDriverScript;
      const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);

      const created = await controllerDriver(controller).startConnection({
        selection: originalRealtimeSelection,
        runId: "lab-run-1",
        profile: "realtime-v1",
        connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
        createdAt: 1_700_000_000_000,
        execution: {
          agentInput: createInterviewConversationInput(
            "Injected driver instructions",
            undefined,
            60_000,
          ),
        },
        reasoningEffort: "high",
      });

      expect(providerDriver.createCall).toHaveBeenCalledTimes(1);
      expect(
        requireDefined(providerDriver.createCall.mock.calls[0], "missing_create_call")[0].session,
      ).toMatchObject({
        runId: "lab-run-1",
        model: "gpt-realtime-2.1",
        reasoning: { effort: "high" },
      });
      expect(created).toMatchObject({
        answerSdp: "answer-sdp",
        sessionId: "rtc_fake_driver",
        sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_fake_driver",
        upstreamRequestId: "req_fake_driver",
        settingsSummary: {
          model: "gpt-realtime-2.1",
          voice: "marin",
        },
      });

      expect(providerDriver.sendCommand).toHaveBeenCalledTimes(0);
      await controller.fetch(
        new Request("https://controller.test/media-ready", {
          method: "POST",
          body: JSON.stringify({ runId: "lab-run-1" }),
        }),
      );
      await vi.waitFor(() => {
        expect(providerDriver.connectSideband).toHaveBeenCalledTimes(1);
        expect(providerDriver.sendCommand).toHaveBeenCalledTimes(1);
      });
      expect(socket.accept).toHaveBeenCalledTimes(1);
      const sendCommandInput = requireDefined(
        providerDriver.sendCommand.mock.calls[0],
        "missing_send_command",
      )[0];
      expect(sendCommandInput.socket).toBe(socket);
      expect(sendCommandInput.command).toMatchObject({ type: "response.create" });
      expect(
        JSON.parse(requireDefined(socketSend.mock.calls[0], "missing_socket_send")[0]),
      ).toMatchObject({
        type: "response.create",
      });

      emitSocketEvent("message", {
        data: JSON.stringify({
          event_id: "event_agent_item_1",
          type: "response.output_item.added",
          response_id: "resp_agent_1",
          output_index: 0,
          item: { id: "item_agent_1" },
        }),
      });
      emitSocketEvent("message", {
        data: JSON.stringify({
          event_id: "event_agent_transcript_1",
          type: "response.output_audio_transcript.done",
          response_id: "resp_agent_1",
          item_id: "item_agent_1",
          output_index: 0,
          content_index: 0,
          transcript: "Welcome to the interview.",
        }),
      });

      await vi.waitFor(async () => {
        await expect(
          controllerDriver(controller).state({ runId: "lab-run-1" }),
        ).resolves.toMatchObject({
          state: {
            phase: "live",
            sessionId: "rtc_fake_driver",
            sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_fake_driver",
            upstreamRequestId: "req_fake_driver",
            session: { eventCount: 2 },
            transcript: { turnCount: 1 },
          },
        });
      });
      const providerCursorWrites = durable.storage.sql.executions.filter((execution) =>
        execution.sql.includes("SET session_event_count = ?"),
      );
      expect(providerCursorWrites).not.toHaveLength(0);
      expect(providerCursorWrites.every((execution) => execution.inTransaction)).toBe(true);
      expect(readRunRecordView(durable).transcriptSnapshot).toEqual({
        turns: [{ role: "conversationAgent", text: "Welcome to the interview." }],
      });
      const repeated = await controllerDriver(controller).startConnection({
        selection: originalRealtimeSelection,
        runId: "lab-run-1",
        profile: "realtime-v1",
        connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
        createdAt: 1_700_000_099_000,
        execution: {
          agentInput: createInterviewConversationInput(
            "Changed instructions must not replace the existing call",
            undefined,
            120_000,
          ),
        },
        reasoningEffort: "low",
      });

      expect(providerDriver.createCall).toHaveBeenCalledTimes(1);
      expect(providerDriver.connectSideband).toHaveBeenCalledTimes(1);
      expect(repeated).toMatchObject({
        status: 500,
        data: { error: "conversation_input_conflict" },
      });

      expect(
        durable.storage.sql
          .exec<{ provider_event_id: string }>(
            `SELECT provider_event_id FROM runtime_provider_event_ids
           WHERE provider_event_id = ?`,
            "event_agent_item_1",
          )
          .one(),
      ).toEqual({ provider_event_id: "event_agent_item_1" });

      emitSocketEvent("message", {
        data: JSON.stringify({
          event_id: "event_agent_item_1",
          type: "response.output_item.added",
          response_id: "resp_replayed",
          output_index: 0,
          item: { id: "item_replayed_must_not_be_admitted" },
        }),
      });
      await vi.waitFor(() => {
        expect(readRunRecordView(durable).providerEventCount).toBe(3);
        expect(readRunView(durable).transcript.items).not.toContainEqual(
          expect.objectContaining({ itemId: "item_replayed_must_not_be_admitted" }),
        );
      });

      emitSocketEvent("message", {
        data: JSON.stringify({
          event_id: "event_agent_transcript_1",
          type: "response.output_audio_transcript.done",
          response_id: "resp_agent_1",
          item_id: "item_agent_1",
          output_index: 0,
          content_index: 0,
          transcript: "A replay must not replace the accepted Transcript.",
        }),
      });
      await vi.waitFor(() => {
        expect(readRunRecordView(durable).providerEventCount).toBe(4);
        expect(readRunRecordView(durable).transcriptSnapshot).toEqual({
          turns: [{ role: "conversationAgent", text: "Welcome to the interview." }],
        });
      });

      emitSocketEvent("message", {
        data: JSON.stringify({
          type: "response.output_item.added",
          response_id: "resp_finish",
          output_index: 0,
          item: {
            id: "item_finish",
            type: "function_call",
            name: "finish_interview",
            call_id: "call_finish",
          },
        }),
      });

      emitSocketEvent("message", {
        data: JSON.stringify({
          type: "output_audio_buffer.started",
          response_id: "resp_finish",
        }),
      });

      emitSocketEvent("message", {
        data: JSON.stringify({
          type: "response.output_audio_transcript.done",
          response_id: "resp_finish",
          item_id: "item_finish_message",
          output_index: 1,
          content_index: 0,
          transcript: "Thank you for sharing your feedback.",
        }),
      });

      emitSocketEvent("message", {
        data: JSON.stringify({
          type: "response.function_call_arguments.done",
          response_id: "resp_finish",
          item_id: "item_finish",
          name: "finish_interview",
          call_id: "call_finish",
          arguments: "{}",
        }),
      });

      await vi.waitFor(async () => {
        expect(await controllerDriver(controller).state({ runId: "lab-run-1" })).toMatchObject({
          state: { phase: "live", conversation: { state: "finishing" } },
        });
      });
      expect(
        providerDriver.sendFinalizationOperation.mock.calls.map(([input]) => input.operation.kind),
      ).not.toEqual(expect.arrayContaining(["clear_input", "clear_output"]));

      emitSocketEvent("message", {
        data: JSON.stringify({
          type: "response.done",
          response: {
            id: "resp_finish",
            status: "completed",
            output: [
              {
                id: "item_finish",
                type: "function_call",
                name: "finish_interview",
                call_id: "call_finish",
                arguments: "{}",
              },
            ],
          },
        }),
      });

      emitSocketEvent("message", {
        data: JSON.stringify({
          type: "output_audio_buffer.stopped",
          response_id: "resp_finish",
        }),
      });
      // The finishing reply has had time to play before Ending.
      await vi.waitFor(() =>
        expect(readRunView(durable).nodeExecution?.endingAt).toBeTypeOf("number"),
      );
      vi.setSystemTime(Date.now() + playbackMarginMs);
      await controller.alarm();

      await vi.waitFor(async () => {
        await expect(
          controllerDriver(controller).state({ runId: "lab-run-1" }),
        ).resolves.toMatchObject({
          state: {
            phase: endingOrEnded,
            sessionId: "rtc_fake_driver",
            sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_fake_driver",
            upstreamRequestId: "req_fake_driver",
            session: { eventCount: 10 },
            transcript: { turnCount: 2 },
          },
        });
      });
      expect(readRunView(durable)).toMatchObject({
        agentCompletion: {
          callId: "call_finish",
          responseId: "resp_finish",
          responseSettlement: "completed",
          outputAudioSettlement: "stopped",
        },
      });
      const commandsAfterOutputSettlement = providerDriver.sendFinalizationOperation.mock.calls.map(
        ([input]) => input.operation.kind,
      );
      expect(commandsAfterOutputSettlement).toEqual([
        "disable_automatic_turns",
        "commit_input",
        "clear_output",
      ]);
      // The finishing reply had time to play, and Runtime's one-second quiet settled the final
      // input meanwhile, so Ending had nothing left to wait for: the Run has ended, and a later
      // Stop changes nothing.
      const override = await controllerDriver(controller).complete({
        runId: "lab-run-1",
        endReason: "participant_stopped",
        now: Date.now(),
      });
      expect(override).toMatchObject({
        accepted: false,
        state: { phase: "ended", completion: { endReason: "agent_requested_end" } },
      });
      expect(
        providerDriver.sendFinalizationOperation.mock.calls.map(([input]) => input.operation.kind),
      ).toEqual(commandsAfterOutputSettlement);
      expect(readRunView(durable)).toMatchObject({
        agentCompletion: {
          callId: "call_finish",
          responseId: "resp_finish",
          outputAudioSettlement: "stopped",
          participantMediaSafetyOverride: false,
        },
        lifecycle: { stage: "ended", completion: { endReason: "agent_requested_end" } },
      });
      emitSocketEvent("close", { code: 1000 });
      await durable.flushWaitUntil();
      await expect(
        controllerDriver(controller).state({ runId: "lab-run-1" }),
      ).resolves.toMatchObject({
        state: {
          phase: "ended",
          completion: {
            endReason: "agent_requested_end",
            transcriptSnapshot: { turnCount: 2 },
          },
        },
      });
      expect(providerDriver.hangUp).toHaveBeenCalledOnce();

      const completedReinstantiation = createInterviewRuntimeController(
        durable.ctx,
        {},
        providerDriver,
      );
      const completedState = await controllerDriver(completedReinstantiation).state({
        runId: "lab-run-1",
      });
      expect(completedState).toMatchObject({
        state: {
          phase: "ended",
          sessionId: "rtc_fake_driver",
          sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_fake_driver",
          upstreamRequestId: "req_fake_driver",
          session: { eventCount: 10 },
          transcript: { turnCount: 2 },
          completion: { endReason: "agent_requested_end" },
        },
      });

      durable.close();
    });

    it("persists sanitized provider hangup failure through supported completion", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const controlledSocket = createControlledProviderSocket();
      const providerDriver = {
        normalizeEvent: vi.fn(normalizeProviderRealtimeEvent),
        createCall: vi.fn(async () =>
          providerSuccess({
            status: 201,
            answerSdp: "answer-sdp",
            responseContentType: "application/sdp",
            sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_provider_call",
            sessionId: "rtc_provider_call",
            upstreamRequestId: "req_provider_call",
          }),
        ),
        connectSideband: vi.fn(async () => providerSuccess(controlledSocket.socket)),
        sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
          providerSuccess(undefined),
        ),
        sendCommand: vi.fn(() => providerSuccess(undefined)),
        hangUp: vi.fn(async (): Promise<ProviderOutcome<ProviderHangup>> => {
          const failure = {
            kind: "provider_failure" satisfies "provider_failure",
            stage: "hangup" satisfies "hangup",
            code: "session_release_failed" satisfies "session_release_failed",
            providerStatus: 503,
            requestId: "req_hangup_failure",
            responseBody: "Echoed confidential Lab prompt",
            retryable: true,
          } satisfies ProviderFailureOutcome & Readonly<{ responseBody: string }>;
          return { ok: false, failure };
        }),
      };
      const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
      const driver = controllerDriver(controller);

      await driver.startConnection({
        selection: originalRealtimeSelection,
        runId: "provider-hangup-sanitization-run",
        profile: "realtime-v1",
        connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
        createdAt: 1_700_000_000_000,
        execution: {
          agentInput: createInterviewConversationInput(
            "Hangup sanitization test.",
            undefined,
            60_000,
          ),
        },
      });
      await vi.waitFor(() => expect(providerDriver.connectSideband).toHaveBeenCalledOnce());
      await vi.waitFor(async () => {
        await expect(
          driver.state({ runId: "provider-hangup-sanitization-run" }),
        ).resolves.toMatchObject({ state: { phase: "live" } });
      });
      vi.setSystemTime(1_700_000_001_000);
      await driver.complete({
        runId: "provider-hangup-sanitization-run",
        endReason: "participant_stopped",
        now: 1_700_000_001_000,
      });
      controlledSocket.emit("close", { code: 1000 });
      await durable.flushWaitUntil();
      vi.setSystemTime(1_700_000_007_000);
      await controller.alarm();
      vi.setSystemTime(1_700_000_011_000);
      await controller.alarm();
      expect(providerDriver.hangUp).toHaveBeenCalledWith({
        apiKey: "",
        callId: "rtc_provider_call",
        timeoutMs: 4_000,
      });
      const reinstantiated = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
      const persisted = await controllerDriver(reinstantiated).state({
        runId: "provider-hangup-sanitization-run",
      });
      expect(persisted).toMatchObject({
        state: {
          completion: { endReason: "participant_stopped" },
        },
      });
      const warnings = readRecord(readRecord(persisted.state).completion).warnings;
      expect(Array.isArray(warnings)).toBe(true);
      expect(warnings).toContain("session_release_failed");
      const closeDiagnostic = requireDefined(
        readRuntimeDiagnosticRecords(durable).find(
          (record) => record.type === "realtime.close_finished",
        ),
        "missing_provider_close_diagnostic",
      );
      expect(JSON.parse(closeDiagnostic.payloadJson)).toMatchObject({
        source: "realtime_execution",
        result: "failed",
        status: 503,
        code: "session_release_failed",
      });
      expect(JSON.stringify({ persisted, closeDiagnostic })).not.toContain(
        "Echoed confidential Lab prompt",
      );

      durable.close();
    });

    it("renews browser presence and keeps the run live when media returns during grace", async () => {
      const durable = createTestDurableObjectContext();
      const controller = createInterviewRuntimeController(durable.ctx, {});

      await controllerDriver(controller).start({
        ...originalStart(60_000),
        runId: "lab-run-1",
        startedAt: 1_700_000_000_000,
      });
      vi.setSystemTime(1_700_000_001_000);
      await controllerDriver(controller).fakeControlReady({
        runId: "lab-run-1",
        now: 1_700_000_001_000,
      });
      // The presence-only synthetic fixture has already dispatched its opening.
      durable.storage.sql.exec(
        "UPDATE runtime_controller_state SET opening_state = 'sent' WHERE run_id = ?",
        "lab-run-1",
      );
      expect(
        (
          await controller.fetch(
            new Request("https://controller.test/media-ready", {
              method: "POST",
              body: JSON.stringify({ runId: "lab-run-1" }),
            }),
          )
        ).status,
      ).toBe(200);

      await expect(
        controllerDriver(controller).presence({
          runId: "lab-run-1",
          now: 1_700_000_005_000,
          mediaPresent: true,
        }),
      ).resolves.toMatchObject({
        status: 200,
        accepted: true,
        state: {
          phase: "live",
          presence: {
            lastSeenAt: 1_700_000_005_000,
            graceUntil: 1_700_000_020_000,
            mediaPresent: true,
            signalCount: 1,
          },
        },
      });
      await expect(
        controllerDriver(controller).presence({
          runId: "lab-run-1",
          now: 1_700_000_010_000,
          mediaPresent: false,
        }),
      ).resolves.toMatchObject({
        status: 200,
        accepted: true,
        state: {
          phase: "live",
          presence: {
            graceUntil: 1_700_000_025_000,
            mediaPresent: false,
            signalCount: 2,
          },
        },
      });
      await expect(
        controllerDriver(controller).presence({
          runId: "lab-run-1",
          now: 1_700_000_020_000,
          mediaPresent: true,
        }),
      ).resolves.toMatchObject({
        status: 200,
        accepted: true,
        state: {
          phase: "live",
          presence: {
            graceUntil: 1_700_000_035_000,
            mediaPresent: true,
            signalCount: 3,
          },
        },
      });

      const events = durable.storage.sql
        .exec(
          `SELECT event_name, payload_json
        FROM runtime_controller_events
        ORDER BY id ASC`,
        )
        .toArray();

      expect(events.map((event) => event.event_name)).toEqual(
        expect.arrayContaining(["runtime.presence_lost", "runtime.presence_restored"]),
      );
      expect(durable.storage.currentAlarm).toBeLessThanOrEqual(1_700_000_035_000);

      durable.close();
    });

    it("closes with participant_disconnected when browser presence grace expires", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const controller = createInterviewRuntimeController(durable.ctx, {});

      await controllerDriver(controller).start({
        ...originalStart(60_000),
        runId: "lab-run-1",
        startedAt: 1_700_000_000_000,
      });
      vi.setSystemTime(1_700_000_001_000);
      await controllerDriver(controller).fakeControlReady({
        runId: "lab-run-1",
        now: 1_700_000_001_000,
      });

      vi.setSystemTime(1_700_000_016_000);
      await controller.alarm();
      vi.setSystemTime(1_700_000_025_000);
      await controller.alarm();
      vi.setSystemTime(1_700_000_026_000);
      await controller.alarm();

      await expect(
        controllerDriver(controller).state({ runId: "lab-run-1" }),
      ).resolves.toMatchObject({
        state: {
          phase: "ended",
          completion: {
            endReason: "participant_disconnected",
            source: "presence_timeout",
            outcome: "ended",
          },
        },
      });
      expect(durable.storage.currentAlarm).toBeNull();

      durable.close();
    });
  });
}

export function registerInterviewRuntimeControllerPersistenceMigrationTests(): void {
  describe("Interview Runtime Controller persistence-migration", () => {
    it("never exposes live before its authoritative finalization aggregate is durable", async () => {
      const durable = createTestDurableObjectContext();
      const controller = createInterviewRuntimeController(durable.ctx, {});
      const driver = controllerDriver(controller);

      await driver.start({
        ...originalStart(60_000),
        runId: "atomic-live-cutover-run",
        startedAt: 1_700_000_000_000,
      });
      durable.storage.sql.exec(
        `CREATE TRIGGER reject_finalization_aggregate
       BEFORE UPDATE OF finalization_state_json ON runtime_controller_state
       WHEN NEW.finalization_state_json IS NOT NULL
       BEGIN
         SELECT RAISE(ABORT, 'injected_finalization_write_failure');
       END`,
      );

      const background = vi.spyOn(durable.ctx, "waitUntil").mockImplementationOnce((task) => {
        void task.catch(() => undefined);
      });
      vi.setSystemTime(1_700_000_000_100);
      await expect(
        driver.fakeControlReady({ runId: "atomic-live-cutover-run", now: 1_700_000_000_100 }),
      ).resolves.toMatchObject({ status: 500, error: "injected_finalization_write_failure" });
      await expect(background.mock.calls[0]?.[0]).rejects.toThrow(
        "injected_finalization_write_failure",
      );
      background.mockRestore();

      expect(
        durable.storage.sql
          .exec<{ phase: string; finalization_state_json: string | null }>(
            `SELECT phase, finalization_state_json
           FROM runtime_controller_state WHERE run_id = ?`,
            "atomic-live-cutover-run",
          )
          .one(),
      ).toEqual({ phase: "setup", finalization_state_json: null });
      durable.close();
    });

    it("persists the initial sideband connection in the atomic live cutover", async () => {
      const durable = createTestDurableObjectContext();
      const socketListeners = createControlledProviderSocketListeners();
      const socket = {
        readyState: 1,
        accept: vi.fn(),
        send: vi.fn(),
        addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
          socketListeners[type].push(listener);
        }),
        close: vi.fn(),
      };
      const providerDriver = {
        createCall: vi.fn(async () =>
          providerSuccess({
            status: 201,
            answerSdp: "answer-sdp",
            responseContentType: "application/sdp",
            sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_live_cutover_socket",
            sessionId: "rtc_live_cutover_socket",
            upstreamRequestId: "req_live_cutover_socket",
          }),
        ),
        connectSideband: vi.fn(async () => providerSuccess(socket)),
        sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
          providerSuccess(undefined),
        ),
        sendCommand: vi.fn(() => providerSuccess(undefined)),
      } satisfies RealtimeDriverScript;
      const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
      const driver = controllerDriver(controller);
      try {
        await driver.startConnection({
          selection: originalRealtimeSelection,
          runId: "live-cutover-socket-run",
          profile: "realtime-v1",
          connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
          createdAt: 1_700_000_000_000,
          execution: {
            agentInput: createInterviewConversationInput("Test live cutover.", undefined, 60_000),
          },
        });
        await vi.waitFor(async () => {
          await expect(driver.state()).resolves.toMatchObject({ state: { phase: "live" } });
        });

        const run = readRunView(durable);
        expect(run.provider).toMatchObject({ generation: 1 });
        expect(run.lifecycle.stage).toBe("live");
      } finally {
        for (const listener of socketListeners.close) listener({ code: 1000 });
        await durable.flushWaitUntil();
        durable.close();
      }
    });

    it("fails a malformed active aggregate closed without reconstructing it", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_002_000);
      const durable = createTestDurableObjectContext();
      const original = createInterviewRuntimeController(durable.ctx, {});
      const driver = controllerDriver(original);
      await driver.start({
        ...originalStart(60_000),
        runId: "malformed-active-run",
        startedAt: 1_700_000_000_000,
        fakeSessionId: "rtc_malformed_active",
      });
      vi.setSystemTime(1_700_000_000_100);
      await driver.fakeControlReady({ runId: "malformed-active-run", now: 1_700_000_000_100 });
      const malformedAggregate = JSON.stringify({ state: { stage: "draining" } });
      durable.storage.sql.exec(
        `UPDATE runtime_controller_state
       SET finalization_state_json = ?
       WHERE run_id = ?`,
        malformedAggregate,
        "malformed-active-run",
      );

      const reinstantiated = createInterviewRuntimeController(durable.ctx, {});
      await expect(
        controllerDriver(reinstantiated).state({ runId: "malformed-active-run" }),
      ).resolves.toMatchObject({
        status: 500,
        error: "invalid_finalization_state",
      });
      expect(
        durable.storage.sql
          .exec<{ phase: string; finalization_state_json: string }>(
            `SELECT phase, finalization_state_json FROM runtime_controller_state WHERE run_id = ?`,
            "malformed-active-run",
          )
          .one(),
      ).toEqual({ phase: "live", finalization_state_json: malformedAggregate });
      expect(
        durable.storage.sql
          .exec<{ event_name: string }>(
            `SELECT event_name FROM runtime_controller_events
           WHERE event_name = 'runtime.invalid_finalization_state'`,
          )
          .toArray(),
      ).toEqual([{ event_name: "runtime.invalid_finalization_state" }]);
      durable.close();
    });

    it("fails an active aggregate with a malformed transcript digest closed", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_002_000);
      const durable = createTestDurableObjectContext();
      const original = createInterviewRuntimeController(durable.ctx, {});
      const driver = controllerDriver(original);
      await driver.start({
        ...originalStart(60_000),
        runId: "malformed-digest-run",
        startedAt: 1_700_000_000_000,
      });
      vi.setSystemTime(1_700_000_000_100);
      await driver.fakeControlReady({ runId: "malformed-digest-run", now: 1_700_000_000_100 });
      const persisted: unknown = JSON.parse(
        durable.storage.sql
          .exec<{ finalization_state_json: string }>(
            `SELECT finalization_state_json FROM runtime_controller_state WHERE run_id = ?`,
            "malformed-digest-run",
          )
          .one().finalization_state_json,
      );
      if (!isRecord(persisted)) throw new Error("Expected a finalization aggregate.");
      const malformedAggregate = JSON.stringify({
        ...persisted,
        transcriptDigest: "not-a-sha256-digest",
      });
      durable.storage.sql.exec(
        `UPDATE runtime_controller_state
       SET finalization_state_json = ?, transcript_digest = ?
       WHERE run_id = ?`,
        malformedAggregate,
        "not-a-sha256-digest",
        "malformed-digest-run",
      );

      const reinstantiated = createInterviewRuntimeController(durable.ctx, {});
      await expect(
        controllerDriver(reinstantiated).state({ runId: "malformed-digest-run" }),
      ).resolves.toMatchObject({
        status: 500,
        error: "invalid_finalization_state",
      });
      expect(
        durable.storage.sql
          .exec<{ phase: string; finalization_state_json: string }>(
            `SELECT phase, finalization_state_json FROM runtime_controller_state WHERE run_id = ?`,
            "malformed-digest-run",
          )
          .one(),
      ).toEqual({ phase: "live", finalization_state_json: malformedAggregate });
      expect(
        durable.storage.sql
          .exec<{ event_name: string }>(
            `SELECT event_name FROM runtime_controller_events
           WHERE event_name = 'runtime.invalid_finalization_state'`,
          )
          .toArray(),
      ).toEqual([{ event_name: "runtime.invalid_finalization_state" }]);
      durable.close();
    });

    it("does not overwrite an already-correct Durable Object alarm during construction", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const original = createInterviewRuntimeController(durable.ctx, {});
      const driver = controllerDriver(original);
      await driver.start({
        ...originalStart(60_000),
        runId: "stable-alarm-run",
        startedAt: 1_700_000_000_000,
        fakeSessionId: "rtc_stable_alarm",
        startupExpiresAt: 1_700_000_120_000,
      });
      expect(durable.storage.currentAlarm).toBe(1_700_000_120_000);
      vi.mocked(durable.storage.setAlarm).mockClear();

      const reinstantiated = createInterviewRuntimeController(durable.ctx, {});
      await controllerDriver(reinstantiated).state({ runId: "stable-alarm-run" });

      expect(durable.storage.setAlarm).not.toHaveBeenCalled();
      expect(durable.storage.currentAlarm).toBe(1_700_000_120_000);
      durable.close();
    });

    it("retains identity and live timing while reconstruction interrupts lost continuity", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000123");
      const durable = createTestDurableObjectContext();
      const controller = createInterviewRuntimeController(durable.ctx, {});

      const start = await controllerDriver(controller).start({
        ...originalStart(60_000),
        runId: "lab-run-1",
        createdAt: 1_700_000_000_000,
        startedAt: 1_700_000_000_100,
        fakeSessionId: "rtc_fake_provider_call",
      });
      vi.setSystemTime(1_700_000_001_000);
      const live = await controllerDriver(controller).fakeControlReady({
        runId: "lab-run-1",
        now: 1_700_000_001_000,
      });
      const eventsPromise = controllerDriver(controller).events({
        runId: "lab-run-1",
        durationMs: 1,
      });
      await vi.advanceTimersByTimeAsync(251);
      const events = await eventsPromise;
      const reinstantiated = createInterviewRuntimeController(durable.ctx, {});

      expect(start).toMatchObject({
        created: true,
        state: {
          runId: "lab-run-1",
          runtimeId: "runtime_00000000-0000-4000-8000-000000000123",
          phase: "setup",
          fakeSessionId: "rtc_fake_provider_call",
        },
      });
      expect(live.state).toMatchObject({
        phase: "live",
        liveAt: 1_700_000_001_000,
        deadlineAt: 1_700_000_061_000,
        finalization: { stage: "live" },
        presence: {
          graceUntil: 1_700_000_016_000,
          signalCount: 0,
        },
      });
      expect(events.status).toBe(200);
      expect(readRecord(events.data).events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "session.control_sent" }),
          expect.objectContaining({ event: "runtime.presence_grace_started" }),
        ]),
      );
      expect(durable.storage.currentAlarm).toBe(1_700_000_016_000);
      await expect(
        controllerDriver(reinstantiated).state({
          runId: "lab-run-1",
        }),
      ).resolves.toMatchObject({
        state: {
          phase: "ending",
          liveAt: 1_700_000_001_000,
          deadlineAt: 1_700_000_011_251,
          presence: {
            graceUntil: 1_700_000_016_000,
          },
        },
      });

      durable.close();
    });
  });
}

export function registerInterviewRuntimeControllerPublicationTests(): void {
  describe("Interview Runtime Controller publication", () => {
    it("does not redeliver an acknowledged final transcript while retrying completion", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const callbackPaths: string[] = [];
      let completionAttempts = 0;
      const callbackFetch = vi.fn(async (request: Request) => {
        const pathname = new URL(request.url).pathname;
        callbackPaths.push(pathname);
        const body: unknown = await request.json();
        if (!isRecord(body)) throw new Error("Expected a callback object.");
        if (pathname.endsWith("/transcript")) {
          const snapshot = body.snapshot;
          if (!isRecord(snapshot)) throw new Error("Expected a Transcript snapshot callback.");
          return Response.json({
            version: 2,
            status: "stored",
            storedSnapshot: {
              revision: snapshot.revision,
              digest: snapshot.digest,
              turnCount: snapshot.turnCount,
            },
            requestedMatches: true,
          });
        }
        completionAttempts += 1;
        if (completionAttempts === 1) {
          return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
        }
        const completion = parseCompletedResult(body) ?? parseInterruptedResult(body);
        if (!isRecord(completion)) throw new Error("Expected a completion callback.");
        return Response.json({
          version: 2,
          status: "completed",
          storedSnapshot: completion.transcriptSnapshot,
          requestedMatches: true,
        });
      });
      const controller = createInterviewRuntimeController(durable.ctx, {
        RUNTIME_COMPLETION_CALLBACK_WORKER: { fetch: callbackFetch },
      });
      const driver = controllerDriver(controller);

      await driver.start({
        ...originalStart(60_000),
        runId: "independent-publication-run",
        startedAt: 1_700_000_000_000,
        fakeSessionId: "rtc_independent_publication",
        ...deliveryTo("lab", "independent-publication-run"),
      });
      vi.setSystemTime(1_700_000_000_100);
      await driver.fakeControlReady({
        runId: "independent-publication-run",
        now: 1_700_000_000_100,
      });
      vi.setSystemTime(1_700_000_001_000);
      await controllerDriver(controller).complete({
        runId: "independent-publication-run",
        endReason: "participant_stopped",
        now: 1_700_000_001_000,
      });

      vi.setSystemTime(1_700_000_010_000);
      await controller.alarm();
      vi.setSystemTime(1_700_000_011_000);
      await controller.alarm();
      await durable.flushWaitUntil();

      const readEndedRun = () => {
        const run = readRunView(durable);
        if (run.lifecycle.stage !== "ended") {
          throw new Error("Expected a durable ended aggregate.");
        }
        return run;
      };
      const failedPublication = readEndedRun();
      expect(failedPublication).toMatchObject({
        publication: {
          status: "retrying",
          publicationCutoffAt: 1_700_000_041_000,
          transcriptDelivered: true,
          completionDelivered: false,
          retryAt: 1_700_000_013_000,
          attemptCount: 1,
        },
      });
      const frozenIdentity = {
        lifecycle: failedPublication.lifecycle,
        effects: failedPublication.effects,
        transcript: failedPublication.transcript,
      };

      vi.setSystemTime(1_700_000_013_000);
      const restartedController = createInterviewRuntimeController(durable.ctx, {
        RUNTIME_COMPLETION_CALLBACK_WORKER: { fetch: callbackFetch },
      });
      const restartedDriver = controllerDriver(restartedController);
      await restartedController.alarm();
      await durable.flushWaitUntil();

      expect(callbackPaths).toEqual(["/transcript", "/completion", "/completion"]);
      await expect(
        restartedDriver.state({ runId: "independent-publication-run" }),
      ).resolves.toMatchObject({
        state: {
          callback: { pending: false, deliveredAt: 1_700_000_013_000, attemptCount: 2 },
        },
      });
      const deliveredPublication = readEndedRun();
      expect({
        lifecycle: deliveredPublication.lifecycle,
        effects: deliveredPublication.effects,
        transcript: deliveredPublication.transcript,
      }).toEqual(frozenIdentity);
      durable.close();
    });

    it("publishes a delayed callback only after local completion is observable", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      let resolveTranscript: (response: Response) => void = () => undefined;
      const delayedTranscript = new Promise<Response>((resolve) => {
        resolveTranscript = resolve;
      });
      let requestedTranscriptSnapshot: Record<string, unknown> | null = null;
      let observeTranscriptRequest = () => {};
      const transcriptRequested = new Promise<void>((resolve) => {
        observeTranscriptRequest = resolve;
      });
      const callbackFetch = vi.fn(async (request: Request) => {
        const body: unknown = await request.json();
        if (!isRecord(body)) throw new Error("Expected a callback object.");
        if (new URL(request.url).pathname.endsWith("/transcript")) {
          if (!isRecord(body.snapshot)) throw new Error("Expected a Transcript snapshot.");
          requestedTranscriptSnapshot = body.snapshot;
          observeTranscriptRequest();
          return await delayedTranscript;
        }
        const completion = parseCompletedResult(body) ?? parseInterruptedResult(body);
        if (!isRecord(completion)) throw new Error("Expected a completion callback.");
        return Response.json({
          version: 2,
          status: "completed",
          storedSnapshot: completion.transcriptSnapshot,
          requestedMatches: true,
        });
      });
      const controller = createInterviewRuntimeController(durable.ctx, {
        RUNTIME_COMPLETION_CALLBACK_WORKER: { fetch: callbackFetch },
      });
      const driver = controllerDriver(controller);

      await driver.start({
        ...originalStart(60_000),
        runId: "delayed-publication-run",
        startedAt: 1_700_000_000_000,
        fakeSessionId: "rtc_delayed_publication",
        ...deliveryTo("lab", "delayed-publication-run"),
      });
      vi.setSystemTime(1_700_000_000_100);
      await driver.fakeControlReady({
        runId: "delayed-publication-run",
        now: 1_700_000_000_100,
      });
      vi.setSystemTime(1_700_000_001_000);
      await controllerDriver(controller).complete({
        runId: "delayed-publication-run",
        endReason: "participant_stopped",
        now: 1_700_000_001_000,
      });

      vi.setSystemTime(1_700_000_010_000);
      await controller.alarm();
      vi.setSystemTime(1_700_000_011_000);
      // Publication is retained independently of the alarm's local finalization work.
      await controller.alarm();
      await transcriptRequested;
      expect(callbackFetch).toHaveBeenCalledOnce();

      await expect(driver.state({ runId: "delayed-publication-run" })).resolves.toMatchObject({
        state: {
          phase: "ended",
          finalization: { stage: "ended" },
          callback: { pending: true },
        },
      });
      if (requestedTranscriptSnapshot === null) {
        throw new Error("Expected a delayed Transcript publication.");
      }
      const { revision, digest, turnCount } = requestedTranscriptSnapshot;
      if (
        typeof revision !== "number" ||
        typeof digest !== "string" ||
        typeof turnCount !== "number"
      ) {
        throw new Error("Expected a valid delayed Transcript snapshot reference.");
      }
      resolveTranscript(
        Response.json({
          version: 2,
          status: "stored",
          storedSnapshot: {
            revision,
            digest,
            turnCount,
          },
          requestedMatches: true,
        }),
      );

      await vi.waitFor(() => expect(callbackFetch).toHaveBeenCalledTimes(2));
      await vi.waitFor(async () => {
        await expect(driver.state({ runId: "delayed-publication-run" })).resolves.toMatchObject({
          state: { callback: { pending: false } },
        });
      });
      await durable.flushWaitUntil();
      durable.close();
    });

    it("blocks publication when a success receipt names a different stored Transcript", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const callbackPaths: string[] = [];
      const callbackFetch = vi.fn((request: Request) => {
        callbackPaths.push(new URL(request.url).pathname);
        return Promise.resolve(
          Response.json({
            version: 2,
            status: "stored",
            storedSnapshot: {
              revision: 0,
              digest: `sha256:${"b".repeat(64)}`,
              turnCount: 0,
            },
            requestedMatches: true,
          }),
        );
      });
      const controller = createInterviewRuntimeController(durable.ctx, {
        RUNTIME_COMPLETION_CALLBACK_WORKER: { fetch: callbackFetch },
      });
      const driver = controllerDriver(controller);

      await driver.start({
        ...originalStart(60_000),
        runId: "mismatched-publication-receipt-run",
        startedAt: 1_700_000_000_000,
        fakeSessionId: "rtc_mismatched_publication_receipt",
        ...deliveryTo("lab", "mismatched-publication-receipt-run"),
      });
      vi.setSystemTime(1_700_000_000_100);
      await driver.fakeControlReady({
        runId: "mismatched-publication-receipt-run",
        now: 1_700_000_000_100,
      });
      vi.setSystemTime(1_700_000_001_000);
      await controllerDriver(controller).complete({
        runId: "mismatched-publication-receipt-run",
        endReason: "participant_stopped",
        now: 1_700_000_001_000,
      });

      vi.setSystemTime(1_700_000_010_000);
      await controller.alarm();
      vi.setSystemTime(1_700_000_011_000);
      await controller.alarm();
      await durable.flushWaitUntil();

      expect(readRunView(durable)).toMatchObject({
        publication: {
          status: "blocked_snapshot_conflict",
          transcriptDelivered: false,
          completionDelivered: false,
        },
      });
      expect(callbackPaths).toEqual(["/transcript"]);
      await expect(
        driver.state({ runId: "mismatched-publication-receipt-run" }),
      ).resolves.toMatchObject({
        state: { callback: { pending: false } },
      });
      durable.close();
    });

    it("reconstructs each injected publication boundary from the frozen snapshot", async () => {
      for (const crashPoint of ["before_request", "after_response_before_receipt"] as const) {
        vi.setSystemTime(1_700_000_000_000);
        const durable = createTestDurableObjectContext();
        const callbackBodies: string[] = [];
        const callbackFetch = vi.fn(async (request: Request) => {
          const body: unknown = await request.json();
          if (parseCompletedResult(body) === null && parseInterruptedResult(body) === null) {
            throw new Error("Expected a current completion callback.");
          }
          callbackBodies.push(JSON.stringify(body));
          return Response.json({
            version: 2,
            status: "completed",
            storedSnapshot: (parseCompletedResult(body) ?? parseInterruptedResult(body))
              ?.transcriptSnapshot,
            requestedMatches: true,
          });
        });
        let armed = true;
        let reached = 0;
        const env = {
          RUNTIME_COMPLETION_CALLBACK_WORKER: { fetch: storingTranscripts(callbackFetch) },
        };
        const runId = `publication-crash-${crashPoint}`;
        const controller = createInterviewRuntimeController(durable.ctx, env, {}, undefined, {
          // The Transcript's attempt passes each boundary first; crash at the result's.
          publication: (observed) => {
            if (armed && observed === crashPoint && ++reached === 2) {
              throw new Error(`injected_publication_crash:${crashPoint}`);
            }
          },
        });
        const driver = controllerDriver(controller);
        await driver.start({
          ...originalStart(60_000),
          runId,
          startedAt: 1_700_000_000_000,
          fakeSessionId: `rtc_publication_${crashPoint}`,
          ...deliveryTo("lab", runId),
        });
        vi.setSystemTime(1_700_000_000_100);
        await driver.fakeControlReady({ runId, now: 1_700_000_000_100 });
        vi.setSystemTime(1_700_000_001_000);
        await controllerDriver(controller).complete({
          runId,
          endReason: "participant_stopped",
          now: 1_700_000_001_000,
        });
        vi.setSystemTime(1_700_000_010_000);
        await controller.alarm();
        vi.setSystemTime(1_700_000_011_000);
        await controller.alarm();
        await durable.flushWaitUntil();

        const failed = readRunView(durable);
        if (failed.lifecycle.stage !== "ended") {
          throw new Error("Expected publication to follow frozen finalization.");
        }
        expect(failed.publication).toMatchObject({
          status: "retrying",
          publicationCutoffAt: 1_700_000_041_000,
          completionDelivered: false,
          attemptCount: 1,
          retryAt: 1_700_000_013_000,
        });
        const frozenIdentity = JSON.stringify({
          lifecycle: failed.lifecycle,
          effects: failed.effects,
          transcript: failed.transcript,
        });

        armed = false;
        vi.setSystemTime(1_700_000_013_000);
        const reconstructed = createInterviewRuntimeController(durable.ctx, env);
        await reconstructed.alarm();
        await durable.flushWaitUntil();
        const delivered = readRunView(durable);
        expect(delivered.publication).toMatchObject({
          status: "delivered",
          completionDelivered: true,
          attemptCount: 2,
        });
        expect(
          JSON.stringify({
            lifecycle: delivered.lifecycle,
            effects: delivered.effects,
            transcript: delivered.transcript,
          }),
        ).toBe(frozenIdentity);
        expect(callbackFetch).toHaveBeenCalledTimes(crashPoint === "before_request" ? 1 : 2);
        expect(new Set(callbackBodies).size).toBe(1);
        expect(
          durable.storage.sql
            .exec<{ count: number }>(
              `SELECT COUNT(*) AS count FROM runtime_controller_events
               WHERE event_name = 'runtime.controller_completed'`,
            )
            .one().count,
        ).toBe(1);
        durable.close();
      }
    });

    it("expires unreachable result publication at the original cutoff", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const callbackFetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
      const controller = createInterviewRuntimeController(durable.ctx, {
        RUNTIME_COMPLETION_CALLBACK_WORKER: { fetch: callbackFetch },
      });
      const driver = controllerDriver(controller);
      await driver.start({
        ...originalStart(60_000),
        runId: "bounded-publication-run",
        startedAt: 1_700_000_000_000,
        fakeSessionId: "rtc_bounded_publication",
        ...deliveryTo("lab", "bounded-publication-run"),
      });
      vi.setSystemTime(1_700_000_000_100);
      await driver.fakeControlReady({
        runId: "bounded-publication-run",
        now: 1_700_000_000_100,
      });
      vi.setSystemTime(1_700_000_001_000);
      await driver.complete({
        runId: "bounded-publication-run",
        endReason: "participant_stopped",
        now: 1_700_000_001_000,
      });
      vi.setSystemTime(1_700_000_010_000);
      await controller.alarm();

      const frozenStates: string[] = [];
      for (const wakeAt of [
        1_700_000_011_000, 1_700_000_013_000, 1_700_000_017_000, 1_700_000_025_000,
        1_700_000_033_000,
      ]) {
        vi.setSystemTime(wakeAt);
        await controller.alarm();
        await durable.flushWaitUntil();
        const run = readRunView(durable);
        if (run.lifecycle.stage !== "ended") throw new Error("Expected frozen result.");
        frozenStates.push(
          JSON.stringify({
            lifecycle: run.lifecycle,
            effects: run.effects,
            transcriptCapture: {
              sequence: run.transcript.sequence,
              items: run.transcript.items,
            },
            transcriptDigest: run.transcript.digest,
          }),
        );
      }

      vi.setSystemTime(1_700_000_041_000);
      await controller.alarm();
      await durable.flushWaitUntil();
      const expired = readRunView(durable);
      expect(new Set(frozenStates).size).toBe(1);
      expect(callbackFetch).toHaveBeenCalledTimes(5);
      expect(expired.publication).toMatchObject({
        status: "expired",
        publicationCutoffAt: 1_700_000_041_000,
        transcriptDelivered: false,
        completionDelivered: false,
        retryAt: null,
        attemptCount: 5,
        lastError: "transcript_callback_not_acknowledged",
      });
      expect(readRuntimeDiagnosticRecords(durable)).toContainEqual(
        expect.objectContaining({ type: "runtime.publication_expired" }),
      );
      durable.close();
    });

    it("delivers completion to the Lab Worker callback without an active browser stream", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const database = createTestLabD1Database();
      const created = await createLabRun(database.d1, {
        now: () => 1_700_000_000_000,
      });
      const durable = createTestDurableObjectContext();
      const callbackFetch = vi.fn(labCallbackFetch({ LAB_DB: database.d1 }));
      const controller = createInterviewRuntimeController(durable.ctx, {
        RUNTIME_COMPLETION_CALLBACK_WORKER: {
          fetch: callbackFetch,
        },
      });

      try {
        await controllerDriver(controller).start({
          ...originalStart(60_000),
          runId: created.runId,
          startedAt: created.startedAt,
          ...deliveryTo("lab", created.runId),
        });
        vi.setSystemTime(1_700_000_001_000);
        await controllerDriver(controller).fakeControlReady({
          runId: created.runId,
          now: 1_700_000_001_000,
        });

        vi.setSystemTime(1_700_000_010_000);
        const repository = new InterviewFinalizationRepository(
          createDurableObjectState(durable.ctx).storage,
        );
        // The selected Conversation's evidence for an admitted finish tool on a completed response.
        const live = repository.readAggregate();
        const finish = advanceInterviewFinalization(
          live,
          {
            kind: "conversation_evidence_observed",
            snapshot: {
              ...live,
              nextProviderSequence: 2,
              providerGeneration: 1,
              acceptedProviderOrder: {
                generation: 1,
                sequence: 1,
              },
              providerResponses: [
                {
                  responseId: "response_lab_closing",
                  status: "completed",
                  outputAudio: "pending",
                },
              ],
              gracefulCompletion: {
                callId: "call_lab_finish",
                responseId: "response_lab_closing",
                itemId: null,
                responseSettlement: "completed",
                outputAudioSettlement: "pending",
                participantMediaSafetyOverride: false,
              },
            },
            usageEvidence: [],
            effects: [],
            at: 1_700_000_010_000,
            notification: "completion",
          },
          { conversationTerminals: interviewAgent.conversation.terminalRoles },
        );
        repository.persistAggregate(finish.aggregate, finish.events);
        const audioStopped = advanceInterviewFinalization(finish.aggregate, {
          kind: "reply_delivery_stopped",
          generation: 1,
          sequence: 2,
        });
        repository.persistAggregate(audioStopped.aggregate, audioStopped.events);

        await expect(
          controllerDriver(controller).state({ runId: created.runId }),
        ).resolves.toMatchObject({
          state: { phase: "ending" },
        });
        vi.setSystemTime(1_700_000_011_000);
        await controller.alarm();
        vi.setSystemTime(1_700_000_019_000);
        await controller.alarm();
        vi.setSystemTime(1_700_000_020_000);
        await controller.alarm();
        await durable.flushWaitUntil();
        await expect(
          controllerDriver(controller).state({ runId: created.runId }),
        ).resolves.toMatchObject({
          state: {
            callback: {
              pending: false,
              deliveredAt: 1_700_000_020_000,
              attemptCount: 1,
            },
          },
        });
        expect(callbackFetch).toHaveBeenCalledTimes(2);
        await expect(getLabRun(database.d1, created.runId)).resolves.toMatchObject({
          runId: created.runId,
          endedAt: 1_700_000_010_000,
          outcome: "ended",
          endReason: "agent_requested_end",
        });
        await expect(getRunDiagnostics(database.d1, created.runId)).resolves.toMatchObject({
          surface: "lab",
          appResourceKind: "lab_run",
          appResourceId: created.runId,
          completionStatus: "runtimeCompleted",
          completionReviewStatus: "warning",
          completionDebugText: "Runtime completed with 0 Transcript turns.",
        });
        await expect(listRuntimeEvents(database.d1, created.runId)).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "runtime.app_end_state_persisted",
            }),
          ]),
        );
        await expect(listRuntimeEvents(database.d1, created.runId)).resolves.not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "runtime.lab_end_state_persisted",
            }),
          ]),
        );
        expect(durable.storage.currentAlarm).toBeNull();
      } finally {
        durable.close();
        database.close();
      }
    });

    it("keeps the Lab completion callback idempotent for repeated delivery", async () => {
      const database = createTestLabD1Database();
      const created = await createLabRun(database.d1, {
        now: () => 1_700_000_000_000,
      });
      const emptySnapshot = await createRuntimeTranscriptSnapshot(0, { turns: [] });
      const payload = {
        version: 2,
        type: "runtimeCompleted",
        completion: {
          runId: created.runId,
          outcome: "ended",
          endReason: "participant_stopped",
          source: "test",
          endingStartedAt: 1_700_000_009_000,
          endedAt: 1_700_000_010_000,
          finalizedAt: 1_700_000_011_000,
          transcriptSnapshot: {
            revision: emptySnapshot.revision,
            digest: emptySnapshot.digest,
            turnCount: emptySnapshot.turnCount,
          },
          warnings: [],
        },
      };

      try {
        const firstResponse = await handleLabRuntimeControllerCompletion(
          new Request(applicationCallbackUrl("completion"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          }),
          {
            LAB_DB: database.d1,
          },
        );
        const repeatResponse = await handleLabRuntimeControllerCompletion(
          new Request(applicationCallbackUrl("completion"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          }),
          {
            LAB_DB: database.d1,
          },
        );
        const conflictResponse = await handleLabRuntimeControllerCompletion(
          new Request(applicationCallbackUrl("completion"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              ...payload,
              completion: {
                ...payload.completion,
                endedAt: 1_700_000_020_000,
                endReason: "agent_requested_end",
              },
            }),
          }),
          {
            LAB_DB: database.d1,
          },
        );

        expect(firstResponse.status).toBe(200);
        await expect(firstResponse.json()).resolves.toEqual({
          version: 2,
          status: "completed",
          storedSnapshot: payload.completion.transcriptSnapshot,
          requestedMatches: true,
        });
        expect(repeatResponse.status).toBe(200);
        await expect(repeatResponse.json()).resolves.toEqual({
          version: 2,
          status: "idempotent",
          storedSnapshot: payload.completion.transcriptSnapshot,
          requestedMatches: true,
        });
        expect(conflictResponse.status).toBe(409);
        await expect(conflictResponse.json()).resolves.toEqual({
          version: 2,
          status: "completion_conflict",
          storedSnapshot: payload.completion.transcriptSnapshot,
          requestedMatches: true,
        });
        await expect(getLabRun(database.d1, created.runId)).resolves.toMatchObject({
          endedAt: 1_700_000_010_000,
          outcome: "ended",
          endReason: "participant_stopped",
        });
      } finally {
        database.close();
      }
    });

    it("persists Lab completion even when Runtime Event diagnostics fail", async () => {
      const database = createTestLabD1Database();
      const created = await createLabRun(database.d1, {
        now: () => 1_700_000_000_000,
      });
      const emptySnapshot = await createRuntimeTranscriptSnapshot(0, { turns: [] });

      try {
        await database.d1.prepare("DROP TABLE runtime_events").run();

        const response = await handleLabRuntimeControllerCompletion(
          new Request(applicationCallbackUrl("completion"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              version: 2,
              type: "runtimeCompleted",
              completion: {
                runId: created.runId,
                outcome: "ended",
                endReason: "participant_stopped",
                source: "test",
                endingStartedAt: 1_700_000_009_000,
                endedAt: 1_700_000_010_000,
                finalizedAt: 1_700_000_011_000,
                transcriptSnapshot: {
                  revision: emptySnapshot.revision,
                  digest: emptySnapshot.digest,
                  turnCount: emptySnapshot.turnCount,
                },
                warnings: [],
              },
            }),
          }),
          {
            LAB_DB: database.d1,
          },
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
          version: 2,
          status: "completed",
          storedSnapshot: {
            revision: emptySnapshot.revision,
            digest: emptySnapshot.digest,
            turnCount: emptySnapshot.turnCount,
          },
          requestedMatches: true,
        });
        await expect(getLabRun(database.d1, created.runId)).resolves.toMatchObject({
          endedAt: 1_700_000_010_000,
          outcome: "ended",
          endReason: "participant_stopped",
        });
        await expect(getRunDiagnostics(database.d1, created.runId)).resolves.toMatchObject({
          completionStatus: "runtimeCompleted",
          completionReviewStatus: "clean",
        });
      } finally {
        database.close();
      }
    });

    it("blocks an invalid callback acknowledgement without retrying", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const callbackFetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response("<html>Cloudflare Access login</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }),
        )
        .mockResolvedValueOnce(Response.json({ ok: true }));
      const controller = createInterviewRuntimeController(durable.ctx, {
        RUNTIME_COMPLETION_CALLBACK_WORKER: { fetch: storingTranscripts(callbackFetch) },
      });

      await controllerDriver(controller).start({
        ...originalStart(60_000),
        runId: "lab-run-1",
        startedAt: 1_700_000_000_000,
        ...deliveryTo("lab", "lab-run-1"),
      });
      vi.setSystemTime(1_700_000_001_000);
      await controllerDriver(controller).fakeControlReady({
        runId: "lab-run-1",
        now: 1_700_000_001_000,
      });

      vi.setSystemTime(1_700_000_010_000);
      await controllerDriver(controller).complete({
        runId: "lab-run-1",
        endReason: "participant_stopped",
        now: 1_700_000_010_000,
      });
      vi.setSystemTime(1_700_000_019_000);
      await controller.alarm();
      vi.setSystemTime(1_700_000_020_000);
      await controller.alarm();
      await durable.flushWaitUntil();
      const failedDelivery = await controllerDriver(controller).state({ runId: "lab-run-1" });
      expect(failedDelivery.state).toMatchObject({
        callback: {
          pending: false,
          attemptCount: 1,
          lastError: "callback_invalid_ack",
        },
      });
      expect(callbackFetch).toHaveBeenCalledOnce();
      expect(durable.storage.currentAlarm).toBeNull();

      durable.close();
    });

    it("records a stable callback conflict without reopening lifecycle", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const callbackFetch = vi.fn(async () =>
        Response.json({ error: "stable_conflict" }, { status: 409 }),
      );
      const controller = createInterviewRuntimeController(durable.ctx, {
        RUNTIME_COMPLETION_CALLBACK_WORKER: { fetch: storingTranscripts(callbackFetch) },
      });
      const driver = controllerDriver(controller);

      await driver.start({
        ...originalStart(60_000),
        runId: "stable-conflict-run",
        startedAt: 1_700_000_000_000,
        ...deliveryTo("lab", "stable-conflict-run"),
      });
      vi.setSystemTime(1_700_000_001_000);
      await driver.fakeControlReady({
        runId: "stable-conflict-run",
        now: 1_700_000_001_000,
      });
      vi.setSystemTime(1_700_000_010_000);
      await controllerDriver(controller).complete({
        runId: "stable-conflict-run",
        endReason: "participant_stopped",
        now: 1_700_000_010_000,
      });
      vi.setSystemTime(1_700_000_019_000);
      await controller.alarm();
      vi.setSystemTime(1_700_000_020_000);
      await controller.alarm();
      await durable.flushWaitUntil();

      await expect(driver.state({ runId: "stable-conflict-run" })).resolves.toMatchObject({
        state: {
          phase: "ended",
          callback: {
            pending: false,
            attemptCount: 1,
            lastError: "callback_http_409",
          },
        },
      });
      expect(callbackFetch).toHaveBeenCalledOnce();
      expect(readRuntimeDiagnosticRecords(durable)).toContainEqual(
        expect.objectContaining({ type: "runtime.publication_blocked" }),
      );
      expect(durable.storage.currentAlarm).toBeNull();
      durable.close();
    });
  });
}

export function registerInterviewRuntimeControllerEffectRecoveryTests(): void {
  describe("Interview Runtime Controller effect-recovery", () => {
    it("preserves the live owner of an in-flight hangup while competing provider closure arrives", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const socketListeners = createControlledProviderSocketListeners();
      const socket = {
        readyState: 1,
        accept: vi.fn(),
        send: vi.fn(),
        addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
          socketListeners[type].push(listener);
        }),
        close: vi.fn(),
      };
      const emitSocketEvent = (type: SocketEventType, event: SocketEvent) => {
        for (const listener of socketListeners[type]) listener(event);
      };
      type HangupOutcome = ProviderOutcome<ProviderHangup>;
      let resolveHangup: (outcome: HangupOutcome) => void = () => undefined;
      const hangupOutcome = new Promise<HangupOutcome>((resolve) => {
        resolveHangup = resolve;
      });
      const providerDriver = {
        normalizeEvent: vi.fn(normalizeProviderRealtimeEvent),
        createCall: vi.fn(async () =>
          providerSuccess({
            status: 201,
            answerSdp: "answer-sdp",
            responseContentType: "application/sdp",
            sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_inflight_hangup",
            sessionId: "rtc_inflight_hangup",
            upstreamRequestId: "req_inflight_hangup",
          }),
        ),
        connectSideband: vi.fn(async () => providerSuccess(socket)),
        sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
          providerSuccess(undefined),
        ),
        sendCommand: vi.fn(() => providerSuccess(undefined)),
        hangUp: vi.fn(() => hangupOutcome),
      } satisfies RealtimeDriverScript;
      const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);

      await controllerDriver(controller).startConnection({
        selection: originalRealtimeSelection,
        runId: "inflight-hangup-run",
        profile: "realtime-v1",
        connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
        createdAt: 1_700_000_000_000,
        execution: {
          agentInput: createInterviewConversationInput("Test in-flight hangup.", undefined, 60_000),
        },
      });
      await vi.waitFor(async () => {
        await expect(
          controllerDriver(controller).state({ runId: "inflight-hangup-run" }),
        ).resolves.toMatchObject({ state: { phase: "live" } });
      });
      vi.setSystemTime(1_700_000_001_000);
      await controllerDriver(controller).complete({
        runId: "inflight-hangup-run",
        endReason: "participant_stopped",
        now: 1_700_000_001_000,
      });

      vi.setSystemTime(1_700_000_007_000);
      const alarm = controller.alarm();
      await vi.waitFor(() => expect(providerDriver.hangUp).toHaveBeenCalledOnce());
      emitSocketEvent("message", {
        data: JSON.stringify({ event_id: "event_session_closed", type: "session.closed" }),
      });

      await vi.waitFor(async () => {
        await expect(
          controllerDriver(controller).state({ runId: "inflight-hangup-run" }),
        ).resolves.toMatchObject({
          state: { phase: "ending", finalization: { stage: "finalizing" } },
        });
      });

      expect(providerDriver.hangUp).toHaveBeenCalledOnce();
      resolveHangup(
        providerSuccess({
          status: 200,
          upstreamRequestId: "req_inflight_hangup_close",
        }),
      );
      await alarm;
      emitSocketEvent("close", { code: 1000 });
      await durable.flushWaitUntil();
      durable.close();
    });

    it("does not restore the sideband solely to dispatch ending provider commands", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const socketListeners = createControlledProviderSocketListeners();
      const socket = {
        readyState: 1,
        accept: vi.fn(),
        send: vi.fn(),
        addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
          socketListeners[type].push(listener);
        }),
        close: vi.fn(),
      };
      type SidebandOutcome = ProviderOutcome<ProviderWebSocket>;
      let resolveConnect: (outcome: SidebandOutcome) => void = () => undefined;
      const connection = new Promise<SidebandOutcome>((resolve) => {
        resolveConnect = resolve;
      });
      const sentCommandTypes: string[] = [];
      const providerDriver = {
        connectSideband: vi.fn(() => connection),
        sendCommand: vi.fn(() => providerSuccess(undefined)),
        sendFinalizationOperation: vi.fn((input: ProviderFinalizationOperationInput) => {
          sentCommandTypes.push(input.operation.kind);
          return providerSuccess(undefined);
        }),
      } satisfies RealtimeDriverScript;
      const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
      const driver = controllerDriver(controller);

      await driver.start({
        ...originalStart(60_000),
        runId: "pending-command-reconnect-run",
        startedAt: 1_700_000_000_000,
      });
      durable.storage.sql.exec(
        `UPDATE runtime_controller_state SET session_id = ? WHERE run_id = ?`,
        "rtc_pending_command_reconnect",
        "pending-command-reconnect-run",
      );
      vi.setSystemTime(1_700_000_000_100);
      await driver.fakeControlReady({
        runId: "pending-command-reconnect-run",
        now: 1_700_000_000_100,
      });

      vi.setSystemTime(1_700_000_001_000);
      await controllerDriver(controller).complete({
        runId: "pending-command-reconnect-run",
        endReason: "participant_stopped",
        now: 1_700_000_001_000,
      });

      expect(providerDriver.connectSideband).not.toHaveBeenCalled();
      vi.setSystemTime(1_700_000_002_001);
      await controller.alarm();
      expect(durable.storage.currentAlarm).toBeGreaterThan(1_700_000_002_001);
      expect(durable.storage.currentAlarm).toBeLessThanOrEqual(1_700_000_010_000);
      expect(providerDriver.sendFinalizationOperation).not.toHaveBeenCalled();
      const disconnectedEffects = readRunView(durable).effects;
      expect(
        disconnectedEffects.some(
          (effect) => effect.kind === "close_input" && effect.status === "failed",
        ),
      ).toBe(true);
      expect(providerDriver.sendFinalizationOperation).not.toHaveBeenCalled();
      expect(
        disconnectedEffects.some(
          (effect) => effect.kind === "arm_alarm" && effect.status === "dispatched",
        ),
      ).toBe(true);

      resolveConnect(providerSuccess(socket));
      expect(sentCommandTypes).toEqual([]);

      for (const listener of socketListeners.close) listener({ code: 1000 });
      await durable.flushWaitUntil();
      durable.close();
    });

    it("records reconstructed ending sideband loss without reconnecting", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const original = createInterviewRuntimeController(durable.ctx, {});
      const driver = controllerDriver(original);
      await driver.start({
        ...originalStart(60_000),
        runId: "reconstructed-ending-sideband-run",
        startedAt: 1_700_000_000_000,
      });
      durable.storage.sql.exec(
        `UPDATE runtime_controller_state SET session_id = ? WHERE run_id = ?`,
        "rtc_reconstructed_ending_sideband",
        "reconstructed-ending-sideband-run",
      );
      vi.setSystemTime(1_700_000_000_100);
      await driver.fakeControlReady({
        runId: "reconstructed-ending-sideband-run",
        now: 1_700_000_000_100,
      });
      vi.setSystemTime(1_700_000_001_000);
      await driver.complete({
        runId: "reconstructed-ending-sideband-run",
        endReason: "participant_stopped",
        now: 1_700_000_001_000,
      });
      const repository = new InterviewFinalizationRepository(
        createDurableObjectState(durable.ctx).storage,
      );
      expect(readRunView(repository).lifecycle.stage).toBe("draining");
      // The Realtime kit kept its side connection open when Runtime restarted.
      durable.storage.sql.exec(
        `UPDATE runtime_controller_state SET execution_state_json = ? WHERE run_id = ?`,
        JSON.stringify({ inputBuffered: false, sideConnectionOpen: true }),
        "reconstructed-ending-sideband-run",
      );

      const providerDriver = {
        connectSideband: vi.fn(async () =>
          providerSuccess(createControlledProviderSocket().socket),
        ),
        sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
          providerSuccess(undefined),
        ),
        sendCommand: vi.fn(() => providerSuccess(undefined)),
        hangUp: vi.fn(async () => providerSuccess({ status: 200, upstreamRequestId: "req_gap" })),
      } satisfies RealtimeDriverScript;
      const reconstructed = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
      await controllerDriver(reconstructed).state({
        runId: "reconstructed-ending-sideband-run",
      });

      expect(providerDriver.connectSideband).not.toHaveBeenCalled();

      vi.setSystemTime(1_700_000_002_100);
      await reconstructed.alarm();
      expect(providerDriver.connectSideband).not.toHaveBeenCalled();
      // The kit releases the session at Ending's checkpoint: the events its side connection
      // carried during the restart may be missing, which the result says (#978: the Realtime
      // kit's own missed-event detection, no longer Runtime's replay state).
      vi.setSystemTime(1_700_000_010_100);
      await reconstructed.alarm();
      vi.setSystemTime(1_700_000_011_100);
      await reconstructed.alarm();
      await vi.waitFor(() => expect(readRunView(repository).lifecycle.stage).toBe("ended"));
      expect(readRunView(repository).completion?.warnings).toContain("provider_observation_gap");
      expect(providerDriver.connectSideband).not.toHaveBeenCalled();
      durable.close();
    });

    it("dispatches a restored never-started hangup directly without sideband", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const original = createInterviewRuntimeController(durable.ctx, {});
      const driver = controllerDriver(original);
      await driver.start({
        ...originalStart(60_000),
        runId: "restored-hangup-404-run",
        startedAt: 1_700_000_000_000,
      });
      durable.storage.sql.exec(
        `UPDATE runtime_controller_state SET session_id = ? WHERE run_id = ?`,
        "rtc_restored_hangup_404",
        "restored-hangup-404-run",
      );
      vi.setSystemTime(1_700_000_000_100);
      await driver.fakeControlReady({
        runId: "restored-hangup-404-run",
        now: 1_700_000_000_100,
      });
      const repository = new InterviewFinalizationRepository(
        createDurableObjectState(durable.ctx).storage,
      );
      const persistedLive = repository.readAggregate();
      repository.persistAggregate(
        aggregateWithPendingEffect(persistedLive, "release_session"),
        null,
      );

      const providerDriver = {
        connectSideband: vi.fn(async () =>
          providerSuccess(createControlledProviderSocket().socket),
        ),
        sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
          providerSuccess(undefined),
        ),
        sendCommand: vi.fn(() => providerSuccess(undefined)),
        hangUp: vi.fn(async () =>
          providerFailure({
            stage: "hangup",
            code: "provider_session_already_closed",
            providerStatus: 404,
            requestId: "req_restored_404",
            retryable: false,
          }),
        ),
      } satisfies RealtimeDriverScript;
      const reconstructed = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
      await controllerDriver(reconstructed).state({ runId: "restored-hangup-404-run" });
      vi.setSystemTime(1_700_000_001_100);
      await reconstructed.alarm();
      expect(providerDriver.connectSideband).not.toHaveBeenCalled();
      expect(providerDriver.hangUp).toHaveBeenCalledOnce();
      expect(providerDriver.hangUp).toHaveBeenCalledWith({
        apiKey: "",
        callId: "rtc_restored_hangup_404",
        timeoutMs: 8_000,
      });
      vi.setSystemTime(1_700_000_010_100);
      await reconstructed.alarm();
      await vi.waitFor(() => {
        const run = readRunView(durable);
        expect(run.provider.acceptedOrder).toBeNull();
        expect(run.lifecycle.stage).toBe("ended");
      });
      expect(
        readRuntimeDiagnosticRecords(durable)
          .filter((record) => record.type === "realtime.closure_confidence")
          .map((record) => parseJsonObject(record.payloadJson)),
      ).toContainEqual(
        expect.objectContaining({
          confidence: "confirmed",
          basis: "documented_terminal_hangup_evidence",
        }),
      );

      await durable.flushWaitUntil();
      durable.close();
    });

    it("retries a digest after computation fails without stranding finalization", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const controller = createInterviewRuntimeController(durable.ctx, {});
      const driver = controllerDriver(controller);

      await driver.start({
        ...originalStart(60_000),
        runId: "digest-retry-run",
        startedAt: 1_700_000_000_000,
        fakeSessionId: "rtc_digest_retry",
      });
      vi.setSystemTime(1_700_000_000_100);
      await driver.fakeControlReady({ runId: "digest-retry-run", now: 1_700_000_000_100 });
      await controller.fetch(
        new Request(`${runtimeUrl}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId: "digest-retry-run",
            endReason: "participant_stopped",
            now: 1_700_000_001_000,
          }),
        }),
      );

      vi.setSystemTime(1_700_000_010_000);
      await controller.alarm();
      const digestFailure = vi
        .spyOn(crypto.subtle, "digest")
        .mockRejectedValueOnce(new Error("injected_digest_failure"));
      vi.setSystemTime(1_700_000_011_000);
      await expect(controller.alarm()).rejects.toThrow("injected_digest_failure");
      await expect(durable.flushWaitUntil()).rejects.toThrow("injected_digest_failure");

      const interrupted = readRunView(durable);
      const interruptedDigest = interrupted.effects.find(
        (effect) => effect.kind === "compute_transcript_digest",
      );
      expect(interrupted.lifecycle.stage).toBe("finalizing");
      expect(interruptedDigest).toMatchObject({ status: "pending" });

      digestFailure.mockRestore();
      vi.setSystemTime(1_700_000_011_000);
      await controller.alarm();
      await expect(
        controllerDriver(controller).state({ runId: "digest-retry-run" }),
      ).resolves.toMatchObject({ state: { phase: "ended" } });
      durable.close();
    });

    it("recovers an injected dispatched hangup defect in the same controller without replay or renewed cutoff", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      let armed = false;
      const hangUp = vi.fn(async () =>
        providerSuccess({ status: 200, upstreamRequestId: "req_same_instance" }),
      );
      const controller = createInterviewRuntimeController(
        durable.ctx,
        { OPENAI_API_KEY: "test-key" },
        { hangUp },
        undefined,
        {
          effect: (point, effect) => {
            if (
              armed &&
              point === "after_dispatch_before_outcome" &&
              effect.kind === "release_session"
            )
              throw new Error("injected_live_hangup_defect");
          },
        },
      );
      const driver = controllerDriver(controller);
      await driver.start({
        ...originalStart(60_000),
        runId: "live-exit-hangup",
        startedAt: 1_700_000_000_000,
      });
      durable.storage.sql.exec(
        "UPDATE runtime_controller_state SET session_id = ? WHERE run_id = ?",
        "rtc_same_instance",
        "live-exit-hangup",
      );
      vi.setSystemTime(1_700_000_000_100);
      await driver.fakeControlReady({ runId: "live-exit-hangup", now: 1_700_000_000_100 });
      const repository = new InterviewFinalizationRepository(
        createDurableObjectState(durable.ctx).storage,
      );
      repository.persistAggregate(
        aggregateWithPendingEffect(repository.readAggregate(), "release_session"),
        null,
      );
      armed = true;
      await expect(controller.alarm()).rejects.toThrow("injected_live_hangup_defect");
      await expect(durable.flushWaitUntil()).rejects.toThrow("injected_live_hangup_defect");
      armed = false;
      expect(
        readRunView(repository).effects.find(({ kind }) => kind === "release_session"),
      ).toMatchObject({ status: "uncertain", attemptCount: 1 });
      expect(readRunView(repository).lifecycle).toMatchObject({
        stage: "closing_provider",
        finalizationCutoffAt: 1_700_000_010_100,
        warnings: ["session_release_uncertain"],
      });
      vi.setSystemTime(1_700_000_010_101);
      await controller.alarm();
      const frozen = readRunView(repository);
      expect(frozen.lifecycle).toMatchObject({
        stage: "ended",
        completion: { finalizationCutoffAt: 1_700_000_010_100 },
      });
      await controller.alarm();
      const afterFrozen = readRunView(repository);
      expect({ lifecycle: afterFrozen.lifecycle, effects: afterFrozen.effects }).toEqual({
        lifecycle: frozen.lifecycle,
        effects: frozen.effects,
      });
      expect(hangUp).toHaveBeenCalledOnce();
      expect(repository.readEventsByName("runtime.controller_completed")).toHaveLength(1);
      await durable.flushWaitUntil();
      durable.close();
    });

    it("reconstructs every effect class at each injected controller dispatch boundary", async () => {
      const effectKinds = [
        "compute_transcript_digest",
        "close_input",
        "discard_later_input",
        "cancel_reply",
        "stop_output",
        "release_session",
        "arm_alarm",
      ] as const satisfies readonly FinalizationEffectKind[];
      const crashPoints = [
        "after_attempt_before_dispatch",
        "after_dispatch_before_outcome",
      ] as const;

      for (const kind of effectKinds) {
        for (const crashPoint of crashPoints) {
          vi.setSystemTime(1_700_000_000_000);
          const durable = createTestDurableObjectContext();
          const socketListeners = createControlledProviderSocketListeners();
          const socket = {
            readyState: 1,
            accept: vi.fn(),
            send: vi.fn(),
            addEventListener: vi.fn((type: SocketEventType, listener: SocketListener) => {
              socketListeners[type].push(listener);
            }),
            close: vi.fn(),
          };
          const providerDriver = {
            normalizeEvent: vi.fn(normalizeProviderRealtimeEvent),
            createCall: vi.fn(async () =>
              providerSuccess({
                status: 201,
                answerSdp: "answer-sdp",
                responseContentType: "application/sdp",
                sessionLocation: `https://api.openai.com/v1/realtime/calls/rtc_crash_${kind}`,
                sessionId: `rtc_crash_${kind}`,
                upstreamRequestId: `req_crash_${kind}`,
              }),
            ),
            connectSideband: vi.fn(async () => providerSuccess(socket)),
            sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
              providerSuccess(undefined),
            ),
            sendCommand: vi.fn((_input: ProviderSendCommandInput) => providerSuccess(undefined)),
            hangUp: vi.fn(async (_input: Parameters<ScriptedRealtimeDriver["hangUp"]>[0]) =>
              providerSuccess({ status: 200, upstreamRequestId: `req_hangup_${kind}` }),
            ),
          } satisfies RealtimeDriverScript;
          let armed = false;
          const controller = createInterviewRuntimeController(
            durable.ctx,
            {},
            providerDriver,
            undefined,
            {
              effect: (observed, effect) => {
                if (armed && effect.kind === kind && observed === crashPoint) {
                  throw new Error(`injected_effect_crash:${kind}:${crashPoint}`);
                }
              },
            },
          );
          await controllerDriver(controller).startConnection({
            selection: originalRealtimeSelection,
            runId: `effect-crash-${kind}-${crashPoint}`,
            profile: "realtime-v1",
            connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
            createdAt: 1_700_000_000_000,
            execution: {
              agentInput: createInterviewConversationInput(
                "Test effect reconstruction.",
                undefined,
                60_000,
              ),
            },
          });
          await vi.waitFor(async () => {
            await expect(
              controllerDriver(controller).state({
                runId: `effect-crash-${kind}-${crashPoint}`,
              }),
            ).resolves.toMatchObject({ state: { phase: "live" } });
          });
          const initialProviderCommandCount = vi.mocked(providerDriver.sendFinalizationOperation)
            .mock.calls.length;
          const initialHangupCount = vi.mocked(providerDriver.hangUp).mock.calls.length;
          const initialProviderDispatches = initialProviderCommandCount + initialHangupCount;
          const repository = new InterviewFinalizationRepository(
            createDurableObjectState(durable.ctx).storage,
          );
          const seeded = aggregateWithPendingEffect(repository.readAggregate(), kind);
          const targetEffect = requireDefined(
            seeded.state.effects.find((effect) => effect.kind === kind),
            `missing_seeded_effect:${kind}`,
          );
          if (decodeInterviewFinalizationAggregate(JSON.stringify(seeded)) === null) {
            throw new Error(`invalid_effect_crash_seed:${kind}`);
          }
          repository.persistAggregate(seeded, null);
          armed = true;

          await expect(controller.alarm()).rejects.toThrow(
            `injected_effect_crash:${kind}:${crashPoint}`,
          );
          await expect(durable.flushWaitUntil()).rejects.toThrow(
            `injected_effect_crash:${kind}:${crashPoint}`,
          );
          armed = false;
          // A caught defect observes the actual owner's exit in this same DO.
          // Seeded sending-state reconstruction below remains the abrupt-loss proof.
          expect(
            readRunView(repository).effects.find(({ id }) => id === targetEffect.id),
          ).toMatchObject({
            status:
              kind === "compute_transcript_digest" || kind === "arm_alarm"
                ? "pending"
                : "uncertain",
          });
          const providerDispatchesBeforeReconstruction =
            vi.mocked(providerDriver.sendFinalizationOperation).mock.calls.length +
            vi.mocked(providerDriver.hangUp).mock.calls.length -
            initialProviderDispatches;
          const reconstructed = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
          await controllerDriver(reconstructed).state({
            runId: `effect-crash-${kind}-${crashPoint}`,
          });
          const reconstructedRepository = new InterviewFinalizationRepository(
            createDurableObjectState(durable.ctx).storage,
          );
          const restoredEffect = readRunView(reconstructedRepository).effects.find(
            (effect) => effect.kind === kind,
          );
          expect(restoredEffect).toMatchObject({
            id: targetEffect.id,
            status:
              kind === "compute_transcript_digest" || kind === "arm_alarm"
                ? "pending"
                : "uncertain",
          });
          expect(
            vi.mocked(providerDriver.sendFinalizationOperation).mock.calls.length +
              vi.mocked(providerDriver.hangUp).mock.calls.length -
              initialProviderDispatches,
          ).toBe(providerDispatchesBeforeReconstruction);
          // Realtime carries an input closure that holds no answer as two commands.
          const commandsPerStep = kind === "close_input" ? 2 : 1;
          if (crashPoint === "after_dispatch_before_outcome" && isExternalEffect(kind)) {
            expect(providerDispatchesBeforeReconstruction).toBe(commandsPerStep);
          }

          await reconstructed.alarm();
          const expectedRecoveredStatus =
            kind === "compute_transcript_digest" || kind === "arm_alarm"
              ? "dispatched"
              : "uncertain";
          await vi.waitFor(() => {
            expect(
              readRunView(reconstructedRepository).effects.find(
                (effect) => effect.id === targetEffect.id,
              ),
            ).toMatchObject({ id: targetEffect.id, status: expectedRecoveredStatus });
          });
          const expectedExternalDispatches =
            isExternalEffect(kind) && crashPoint === "after_dispatch_before_outcome"
              ? commandsPerStep
              : 0;
          expect(
            vi.mocked(providerDriver.sendFinalizationOperation).mock.calls.length +
              vi.mocked(providerDriver.hangUp).mock.calls.length -
              initialProviderDispatches,
          ).toBe(expectedExternalDispatches);
          if (expectedExternalDispatches > 0 && kind !== "release_session") {
            const correlationIds = vi
              .mocked(providerDriver.sendFinalizationOperation)
              .mock.calls.slice(initialProviderCommandCount)
              .map(([input]) => input.operation.commandId);
            expect(new Set(correlationIds)).toEqual(
              new Set(
                kind === "close_input"
                  ? [`${targetEffect.id}_turns`, targetEffect.id]
                  : [targetEffect.id],
              ),
            );
          }
          if (expectedExternalDispatches > 0 && kind === "release_session") {
            expect(
              vi
                .mocked(providerDriver.hangUp)
                .mock.calls.slice(initialHangupCount)
                .map(([input]) => input.callId),
            ).toEqual(
              Array.from({ length: expectedExternalDispatches }, () => "rtc_crash_release_session"),
            );
          }

          for (const listener of socketListeners.close) listener({ code: 1000 });
          await durable.flushWaitUntil();
          durable.close();
        }
      }
    }, 10_000);

    it("reconstructs controller aggregate crashes without duplicating lifecycle events", async () => {
      for (const crashPoint of ["before_aggregate_write", "after_aggregate_write"] as const) {
        vi.setSystemTime(1_700_000_000_000);
        const durable = createTestDurableObjectContext();
        let armed = false;
        const runId = `aggregate-crash-${crashPoint}`;
        const controller = createInterviewRuntimeController(durable.ctx, {}, {}, undefined, {
          aggregatePersistence: (observed) => {
            if (armed && observed === crashPoint) {
              throw new Error(`injected_aggregate_crash:${crashPoint}`);
            }
          },
        });
        const driver = controllerDriver(controller);
        await driver.start({
          ...originalStart(60_000),
          runId,
          startedAt: 1_700_000_000_000,
        });
        vi.setSystemTime(1_700_000_000_100);
        await driver.fakeControlReady({ runId, now: 1_700_000_000_100 });
        armed = true;
        vi.setSystemTime(1_700_000_001_000);
        await expect(
          controllerDriver(controller).complete({
            runId,
            endReason: "participant_stopped",
            now: 1_700_000_001_000,
          }),
        ).resolves.toMatchObject({
          status: 500,
          error: `injected_aggregate_crash:${crashPoint}`,
        });
        armed = false;

        const reconstructed = createInterviewRuntimeController(durable.ctx, {});
        vi.setSystemTime(1_700_000_001_000);
        await controllerDriver(reconstructed).complete({
          runId,
          endReason: "participant_stopped",
          now: 1_700_000_001_000,
        });
        expect(
          durable.storage.sql
            .exec<{ count: number }>(
              `SELECT COUNT(*) AS count FROM runtime_controller_events
               WHERE event_name = 'runtime.ending'`,
            )
            .one().count,
        ).toBe(1);
        const afterRepeatedRequest = readRunView(durable);
        expect(
          afterRepeatedRequest.effects.filter((effect) => effect.kind === "close_input"),
        ).toHaveLength(1);
        durable.close();
      }
    });

    it("records an interrupted provider hangup as uncertain completion evidence", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const durable = createTestDurableObjectContext();
      const original = createInterviewRuntimeController(durable.ctx, {});
      const driver = controllerDriver(original);
      await driver.start({
        ...originalStart(60_000),
        runId: "interrupted-hangup-run",
        startedAt: 1_700_000_000_000,
        fakeSessionId: "rtc_interrupted_hangup",
      });
      vi.setSystemTime(1_700_000_000_100);
      await driver.fakeControlReady({ runId: "interrupted-hangup-run", now: 1_700_000_000_100 });
      vi.setSystemTime(1_700_000_001_000);
      await controllerDriver(original).complete({
        runId: "interrupted-hangup-run",
        endReason: "participant_stopped",
        now: 1_700_000_001_000,
      });
      const persisted: unknown = JSON.parse(
        durable.storage.sql
          .exec<{ finalization_state_json: string }>(
            `SELECT finalization_state_json FROM runtime_controller_state WHERE run_id = ?`,
            "interrupted-hangup-run",
          )
          .one().finalization_state_json,
      );
      if (!isRecord(persisted) || !isRecord(persisted.state)) {
        throw new Error("Expected an ending finalization aggregate.");
      }
      const nextEffectSequence = persisted.nextEffectSequence;
      if (typeof nextEffectSequence !== "number") {
        throw new Error("Expected the next persisted effect sequence.");
      }
      const existingEffects: readonly unknown[] = Array.isArray(persisted.state.effects)
        ? persisted.state.effects
        : [];
      durable.storage.sql.exec(
        `UPDATE runtime_controller_state
       SET finalization_state_json = ?, deadline_at = ?, next_effect_sequence = ?
       WHERE run_id = ?`,
        JSON.stringify({
          ...persisted,
          nextEffectSequence: nextEffectSequence + 1,
          finalInput: isRecord(persisted.finalInput)
            ? {
                ...persisted.finalInput,
                obligation: "settled",
                quietDeadline: 1_700_000_007_000,
              }
            : persisted.finalInput,
          state: {
            ...persisted.state,
            stage: "closing_provider",
            effects: [
              ...existingEffects,
              {
                id: `interrupted-hangup-run:${nextEffectSequence}`,
                kind: "release_session",
                status: "sending",
                acceptance: "unobserved",
                attemptCount: 0,
              },
            ],
          },
        }),
        1_700_000_015_000,
        nextEffectSequence + 1,
        "interrupted-hangup-run",
      );

      const reinstantiated = createInterviewRuntimeController(durable.ctx, {});
      await controllerDriver(reinstantiated).state({ runId: "interrupted-hangup-run" });
      const recovered = readRunView(durable);
      if (recovered.lifecycle.stage === "live") {
        throw new Error("Expected a recovered provider hangup.");
      }

      expect(recovered.effects).toContainEqual(
        expect.objectContaining({
          kind: "release_session",
          status: "uncertain",
          attemptCount: 1,
        }),
      );
      expect(recovered.lifecycle.warnings).toContain("session_release_uncertain");
      durable.close();
    });

    it("emits distinct provider close diagnostics for failure timeout and uncertainty", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const cases: readonly Readonly<{
        result: "succeeded" | "failed" | "timed_out" | "uncertain";
        hangUp: ScriptedRealtimeDriver["hangUp"];
      }>[] = [
        {
          result: "succeeded",
          hangUp: async () =>
            providerSuccess({
              status: 200,
              upstreamRequestId: "req_close_success",
            }),
        },
        {
          result: "failed",
          hangUp: async () =>
            providerFailure({
              stage: "hangup",
              code: "session_release_failed",
              providerStatus: 502,
              retryable: true,
            }),
        },
        {
          result: "timed_out",
          hangUp: async () =>
            providerFailure({
              stage: "hangup",
              code: "session_release_timed_out",
              timeoutMs: 8_000,
              retryable: true,
            }),
        },
        {
          result: "uncertain",
          hangUp: (input) =>
            openAiDriverOver(async () => {
              throw new TypeError("provider_hangup_response_lost");
            }).hangUp(input),
        },
      ];

      for (const [index, testCase] of cases.entries()) {
        vi.setSystemTime(1_700_000_000_000 + index);
        const durable = createTestDurableObjectContext();
        const controlledSocket = createControlledProviderSocket();
        const providerDriver = {
          normalizeEvent: vi.fn(normalizeProviderRealtimeEvent),
          createCall: vi.fn(async () =>
            providerSuccess({
              status: 201,
              answerSdp: "answer-sdp",
              responseContentType: "application/sdp",
              sessionLocation: `https://api.openai.com/v1/realtime/calls/rtc_close_${index}`,
              sessionId: `rtc_close_${index}`,
              upstreamRequestId: `req_close_${index}`,
            }),
          ),
          connectSideband: vi.fn(async () => providerSuccess(controlledSocket.socket)),
          sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
            providerSuccess(undefined),
          ),
          sendCommand: vi.fn(() => providerSuccess(undefined)),
          hangUp: vi.fn(testCase.hangUp),
        } satisfies RealtimeDriverScript;
        const controller = createInterviewRuntimeController(durable.ctx, {}, providerDriver);
        const driver = controllerDriver(controller);

        await driver.startConnection({
          selection: originalRealtimeSelection,
          runId: `lab-run-${index}`,
          profile: "realtime-v1",
          connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
          createdAt: 1_700_000_000_000 + index,
          execution: {
            agentInput: createInterviewConversationInput(
              "Provider close diagnostics.",
              undefined,
              60_000,
            ),
          },
        });
        await vi.waitFor(() => expect(providerDriver.connectSideband).toHaveBeenCalledOnce());
        vi.setSystemTime(1_700_000_010_000 + index);
        await driver.complete({
          runId: `lab-run-${index}`,
          endReason: "participant_stopped",
          now: 1_700_000_010_000 + index,
        });
        controlledSocket.emit("close", { code: 1000 });
        await durable.flushWaitUntil();
        vi.setSystemTime(1_700_000_016_000 + index);
        await controller.alarm();
        vi.setSystemTime(1_700_000_019_000 + index);
        await controller.alarm();

        expect(providerDriver.hangUp).toHaveBeenCalledWith({
          apiKey: "",
          callId: `rtc_close_${index}`,
          timeoutMs: 4_000,
        });
        const closeEvent = readRuntimeDiagnosticRecords(durable).find(
          (event) => event.type === "realtime.close_finished",
        );

        expect(JSON.parse(closeEvent?.payloadJson ?? "{}")).toMatchObject({
          source: "realtime_execution",
          result: testCase.result,
        });
        durable.close();
      }
    });
  });
}

function aggregateWithPendingEffect(
  live: InterviewFinalizationAggregate,
  kind: FinalizationEffectKind,
): InterviewFinalizationAggregate {
  if (kind === "compute_transcript_digest") {
    return {
      ...live,
      nextEffectSequence: live.nextEffectSequence + 1,
      state: {
        ...live.state,
        effects: [
          {
            id: `${live.runId}:${live.nextEffectSequence}`,
            kind,
            status: "pending",
            acceptance: "unobserved",
            attemptCount: 0,
            revision: live.transcriptRevision,
          },
        ],
      },
    };
  }
  let withObligation = live;
  if (kind === "cancel_reply" || kind === "stop_output") {
    withObligation = advanceInterviewFinalization(withObligation, {
      kind: "reply_started",
      responseId: "response_effect_crash",
      generation: withObligation.providerGeneration,
      sequence: withObligation.nextProviderSequence,
    }).aggregate;
  }
  if (kind === "stop_output") {
    withObligation = advanceInterviewFinalization(withObligation, {
      kind: "reply_delivery_started",
      responseId: "response_effect_crash",
      generation: withObligation.providerGeneration,
      sequence: withObligation.nextProviderSequence,
    }).aggregate;
  }
  if (kind === "discard_later_input") {
    withObligation = advanceInterviewFinalization(withObligation, {
      kind: "session_activity_observed",
      at: 1_700_000_000_050,
      generation: withObligation.providerGeneration,
      sequence: withObligation.nextProviderSequence,
    }).aggregate;
  }
  const draining = advanceInterviewFinalization(
    withObligation,
    {
      kind: "end_requested",
      reason: "participant_stopped",
      source: "crash_injection_test",
      at: 1_700_000_000_100,
    },
    { conversationTerminals: interviewAgent.conversation.terminalRoles },
  ).aggregate;
  const candidate =
    kind === "close_input" || kind === "arm_alarm"
      ? draining
      : advanceInterviewFinalization(draining, {
          kind: "deadline_reached",
          deadline: "drain",
          at: 1_700_000_009_100,
        }).aggregate;
  const target = candidate.state.effects.find((effect) => effect.kind === kind);
  if (target === undefined) throw new Error(`missing_effect_crash_target:${kind}`);
  return {
    ...candidate,
    state: {
      ...candidate.state,
      effects: candidate.state.effects.map((effect) =>
        effect.id === target.id
          ? { ...effect, status: "pending", acceptance: "unobserved", attemptCount: 0 }
          : { ...effect, status: "dispatched" },
      ),
    },
  };
}

function isExternalEffect(kind: FinalizationEffectKind): boolean {
  return kind !== "compute_transcript_digest" && kind !== "arm_alarm";
}

type RuntimeDiagnosticRecord = Readonly<{
  type: string;
  payloadJson: string;
}>;

function readRuntimeDiagnosticRecords(
  durable: ReturnType<typeof createTestDurableObjectContext>,
): RuntimeDiagnosticRecord[] {
  return durable.storage.sql
    .exec<{ payload_json: string }>(
      `SELECT payload_json
      FROM runtime_controller_events
      WHERE event_name = 'runtime.event_recorded'
      ORDER BY id ASC`,
    )
    .toArray()
    .map((row) => {
      const record = readRecord(readRecord(JSON.parse(row.payload_json)).record);
      return {
        type: readStringProperty(record, "type"),
        payloadJson: readStringProperty(record, "payloadJson"),
      };
    });
}

function createControllerNamespace() {
  const controllers = new Map<
    string,
    Readonly<{
      controller: InterviewRuntimeController;
      durable: ReturnType<typeof createTestDurableObjectContext>;
    }>
  >();
  const getByName = vi.fn((runId: string) => {
    const existing = controllers.get(runId);

    if (existing !== undefined) {
      return existing.controller;
    }

    const durable = createTestDurableObjectContext();
    const controller = createInterviewRuntimeController(durable.ctx, {});
    controllers.set(runId, {
      controller,
      durable,
    });
    return controller;
  });

  return {
    binding: {
      getByName,
    } satisfies RuntimeControllerNamespaceCapability,
    getByName,
    close() {
      for (const { durable } of controllers.values()) {
        durable.close();
      }
    },
  };
}

async function postPublicRuntimeController(
  namespace: ReturnType<typeof createControllerNamespace>,
  runId: string,
  operation: "start" | "fake-control-ready" | "complete" | "presence",
  payload: PublicRuntimeControllerTestPayload,
): Promise<Response> {
  return runtimeWorker.fetch(
    new Request(`${runtimeUrl}/_runtime/controllers/${runId}/${operation}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Runtime-Application": "lab",
      },
      body: JSON.stringify(
        operation === "start"
          ? { ...payload, deliveryTarget: { integration: "lab", context: { runId } } }
          : payload,
      ),
    }),
    {
      INTERVIEW_RUNTIME_CONTROLLER: namespace.binding,
    },
  );
}

async function getPublicRuntimeController(
  namespace: ReturnType<typeof createControllerNamespace>,
  runId: string,
): Promise<Response> {
  return runtimeWorker.fetch(new Request(`${runtimeUrl}/_runtime/controllers/${runId}`), {
    INTERVIEW_RUNTIME_CONTROLLER: namespace.binding,
  });
}

async function renewPresenceUntil(
  controller: InterviewRuntimeController,
  runId: string,
  timestamps: readonly number[],
): Promise<void> {
  for (const now of timestamps) {
    await controllerDriver(controller).presence({
      runId,
      now,
      mediaPresent: true,
    });
  }
}

/** The controller's failed-start records, which exist even when no Run was accepted. */
function readStartFailures(ctx: Parameters<typeof createDurableObjectState>[0]): unknown[] {
  return new InterviewFinalizationRepository(createDurableObjectState(ctx).storage)
    .readEventsByName("runtime.start_failed")
    .map(({ payload_json }) => parseJsonObject(payload_json));
}

function readRecord<Value>(value: Value): TestRecord {
  if (!isRecord(value)) {
    throw new TypeError("expected_test_record");
  }

  return value;
}

function isRecord<Value>(value: Value): value is Value & TestRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringProperty(value: TestRecord, key: string): string {
  const property = value[key];
  if (typeof property !== "string") {
    throw new TypeError(`expected_test_string:${key}`);
  }

  return property;
}

function requireDefined<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) {
    throw new Error(message);
  }

  return value;
}

function requireValue<Value>(value: Value | null | undefined, message: string): Value {
  if (value === null || value === undefined) {
    throw new Error(message);
  }

  return value;
}

export function registerFailedStartRegressionSuite() {
  const databases: ReturnType<typeof createTestDurableObjectContext>[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const db of databases.splice(0)) db.close();
  });
  const start = {
    selection: originalRealtimeSelection,
    runId: "response_failed_start",
    profile: "realtime-v1",
    connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
    execution: {
      agentInput: createInterviewConversationInput("Welcome. What stood out? Thank you."),
    },
    startupExpiresAt: 1_700_000_120_000,
    ...deliveryTo("test", "response_failed_start"),
    diagnosticsContext: { surface: "test" },
  };
  const createdCall = providerSuccess({
    status: 201,
    answerSdp: "v=0\r\nanswer",
    responseContentType: "application/sdp",
    sessionId: "rtc_known",
    sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_known",
    upstreamRequestId: "req_1",
  });
  function setup(
    callback = vi.fn(async (_request: Request) => Response.json({ ok: true })),
    overrides: RealtimeDriverScript = {},
    crashInjectors: Parameters<typeof createInterviewRuntimeController>[4] = {},
  ) {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const durable = createTestDurableObjectContext();
    databases.push(durable);
    const provider = {
      createCall: vi.fn(async () => createdCall),
      connectSideband: vi.fn(async () =>
        providerFailure({
          stage: "session_setup",
          code: "sideband_connect_failed",
          retryable: false,
        }),
      ),
      hangUp: vi.fn(async () => providerSuccess({ status: 200, upstreamRequestId: null })),
      ...overrides,
    };
    const env = {
      TEST_CALLBACK_WORKER: applicationCallbacks({ fetch: callback }),
      LAB_CALLBACK_WORKER: applicationCallbacks({ fetch: callback }),
      OPENAI_API_KEY: "test",
    };
    const controller = createInterviewRuntimeController(
      durable.ctx,
      env,
      provider,
      undefined,
      crashInjectors,
    );
    return { durable, provider, env, controller, driver: controllerDriver(controller), callback };
  }

  describe("Application acceptance resolution", () => {
    it("acknowledges duplicate required stops and fences provider creation before setup", async () => {
      const harness = setup();
      const stop = { runId: start.runId, reason: "application_startup_failed" };

      expect(await harness.driver.requiredStop(stop)).toMatchObject({
        status: 200,
        runId: start.runId,
        accepted: true,
        acceptance: "not_accepted",
      });
      expect(await harness.driver.requiredStop(stop)).toMatchObject({
        status: 200,
        runId: start.runId,
        accepted: true,
        acceptance: "not_accepted",
      });
      expect(await harness.driver.startConnection(start)).toMatchObject({
        acceptance: "not_accepted",
      });
      expect(harness.provider.createCall).not.toHaveBeenCalled();
    });

    it("acknowledges a live required stop after durable acceptance without waiting for cleanup", async () => {
      const harness = setup(undefined, {
        hangUp: vi.fn(() => new Promise<never>(() => undefined)),
      });
      await harness.driver.start(start);
      await harness.driver.fakeControlReady({ runId: start.runId });

      const stop = { runId: start.runId, reason: "application_startup_failed" };
      expect(await harness.driver.requiredStop(stop)).toMatchObject({
        status: 200,
        runId: start.runId,
        accepted: true,
        acceptance: "accepted",
      });
      expect(await harness.driver.requiredStop(stop)).toMatchObject({
        status: 200,
        runId: start.runId,
        accepted: true,
        acceptance: "accepted",
      });
      expect(harness.provider.hangUp).not.toHaveBeenCalled();
      expect(await harness.driver.state()).toMatchObject({ state: { phase: "ending" } });
    });

    it("routes resolution and Start to the same named Durable Object", async () => {
      const harness = setup();
      const getByName = vi.fn(() => harness.controller);
      const env = { INTERVIEW_RUNTIME_CONTROLLER: { getByName } };
      const response = await runtimeWorker.fetch(
        new Request(
          `${runtimeUrl}/_runtime/controllers/${start.runId}/resolve-application-acceptance`,
          { method: "POST" },
        ),
        env,
      );
      expect(await response.json()).toEqual({ runId: start.runId, acceptance: "not_accepted" });
      const rejected = await runtimeWorker.fetch(
        new Request(`${runtimeUrl}/_runtime/controllers/${start.runId}/connection`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(start),
        }),
        env,
      );
      expect(await rejected.json()).toMatchObject({ acceptance: "not_accepted" });
      expect(getByName.mock.calls).toEqual([[start.runId], [start.runId]]);
      expect(harness.provider.createCall).not.toHaveBeenCalled();
    });
    it("fences before setup, survives reconstruction and never creates a provider call", async () => {
      const harness = setup();
      for (let i = 0; i < 3; i += 1) {
        expect(
          await harness.driver.resolveApplicationAcceptance({ runId: start.runId }),
        ).toMatchObject({
          status: 200,
          runId: start.runId,
          acceptance: "not_accepted",
        });
      }
      const restored = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
      );
      expect(await controllerDriver(restored).startConnection(start)).toMatchObject({
        acceptance: "not_accepted",
      });
      expect(await controllerDriver(restored).state({ runId: start.runId })).toMatchObject({
        state: null,
      });
      expect(harness.provider.createCall).not.toHaveBeenCalled();
    });
    it("confirms setup while provider creation is pending without cancelling or duplicating it", async () => {
      const call = acceptanceDeferred<typeof createdCall>();
      const harness = setup(undefined, { createCall: vi.fn(() => call.promise) });
      const pending = harness.driver.startConnection(start);
      await vi.waitFor(() => expect(harness.provider.createCall).toHaveBeenCalledTimes(1));
      expect(
        await harness.driver.resolveApplicationAcceptance({ runId: start.runId }),
      ).toMatchObject({
        acceptance: "accepted",
      });
      const restored = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
      );
      expect(
        await controllerDriver(restored).resolveApplicationAcceptance({ runId: start.runId }),
      ).toMatchObject({ acceptance: "accepted" });
      expect(harness.provider.hangUp).not.toHaveBeenCalled();
      call.resolve(createdCall);
      expect(await pending).toMatchObject({ status: 200 });
      expect(harness.provider.createCall).toHaveBeenCalledTimes(1);
      await harness.durable.flushWaitUntil();
    });
    it("rejects malformed resolution input without writing a fence", async () => {
      const harness = setup();
      expect(
        await harness.driver.resolveApplicationAcceptance({ runId: start.runId, extra: true }),
      ).toMatchObject({ status: 500 });
      expect(await harness.driver.startConnection(start)).toMatchObject({ status: 200 });
      await harness.durable.flushWaitUntil();
    });
  });

  describe("Application accepted attempt terminalization", () => {
    it("returns SDP, then publishes only failed-start identity/time after sideband failure and closes the known call", async () => {
      const bodies: unknown[] = [];
      const harness = setup(
        vi.fn(async (request: Request) => {
          bodies.push(await request.json());
          return Response.json({ ok: true });
        }),
      );
      expect(await harness.driver.startConnection(start)).toMatchObject({
        status: 200,
        answerSdp: "v=0\r\nanswer",
      });
      await harness.durable.flushWaitUntil();
      expect(bodies).toEqual([
        {
          runId: start.runId,
          outcome: "failed_to_start",
          endedAt: Date.now(),
          runtimeUsage: { completeness: "incomplete", observations: [] },
        },
      ]);
      expect(harness.provider.hangUp).toHaveBeenCalledOnce();
      const state = await harness.driver.state();
      expect(state).toMatchObject({
        state: { phase: "failed", callback: { pending: false, attemptCount: 1 } },
      });
      expect(state.state).not.toHaveProperty("liveAt");
      expect(await harness.driver.startConnection(start)).toMatchObject({
        status: 409,
        acceptance: "accepted",
        error: "runtime_controller_start_failed",
      });
      expect(harness.provider.createCall).toHaveBeenCalledOnce();
    });

    it("publishes provider-creation failure without ever replaying it after reconstruction", async () => {
      const harness = setup(undefined, {
        createCall: vi.fn(async () =>
          providerFailure({
            stage: "call_creation",
            code: "provider_call_request_failed",
            retryable: true,
          }),
        ),
      });
      expect(await harness.driver.startConnection(start)).toMatchObject({
        status: 502,
        acceptance: "accepted",
        error: "provider_call_failed",
      });
      await harness.durable.flushWaitUntil();
      const restored = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
      );
      expect(await controllerDriver(restored).startConnection(start)).toMatchObject({
        status: 409,
        acceptance: "accepted",
        error: "runtime_controller_start_failed",
      });
      expect(harness.provider.createCall).toHaveBeenCalledOnce();
      expect(harness.callback).toHaveBeenCalledOnce();
      const refusedStart = {
        operation: "connection",
        failure: "refusal",
        acceptance: "accepted",
      };
      expect(readStartFailures(harness.durable.ctx)).toEqual([
        expect.objectContaining({
          ...refusedStart,
          error: "provider_call_failed",
          status: 502,
          stage: "providerCreated",
        }),
        expect.objectContaining({
          ...refusedStart,
          error: "runtime_controller_start_failed",
          status: 409,
          stage: "providerCreated",
        }),
      ]);
    });

    it("uses the persisted deadline on reconstruction, wins against late live readiness, and never creates a provider call", async () => {
      const harness = setup();
      const acceptedAt = Date.now();
      await harness.driver.start({ ...start, createdAt: acceptedAt, startedAt: acceptedAt });
      expect(harness.durable.storage.currentAlarm).toBe(acceptedAt + applicationSetupDeadlineMs);
      const restored = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
      );
      vi.setSystemTime(acceptedAt + applicationSetupDeadlineMs + 20_000);
      await controllerDriver(restored).fakeControlReady({ runId: start.runId });
      await harness.durable.flushWaitUntil();
      const request = harness.callback.mock.calls[0]?.[0];
      expect(await request?.json()).toEqual({
        runId: start.runId,
        outcome: "failed_to_start",
        endedAt: acceptedAt + applicationSetupDeadlineMs,
        runtimeUsage: { completeness: "complete", observations: [] },
      });
      expect(await controllerDriver(restored).state()).toMatchObject({
        state: {
          phase: "failed",
          callback: {
            publicationCutoffAt:
              acceptedAt + applicationSetupDeadlineMs + 20_000 + resultDeliveryGraceMs,
          },
        },
      });
      expect(harness.provider.createCall).not.toHaveBeenCalled();
    });

    it("rejects pre-expiry readiness evidence committed at the exact expiry", async () => {
      const harness = setup();
      const acceptedAt = Date.now();
      await harness.driver.start({ ...start, createdAt: acceptedAt, startedAt: acceptedAt });
      const expiry = acceptedAt + applicationSetupDeadlineMs;

      vi.setSystemTime(expiry);
      await harness.driver.fakeControlReady({ runId: start.runId, now: expiry - 1 });
      await harness.durable.flushWaitUntil();

      expect(await harness.driver.state()).toMatchObject({
        state: {
          phase: "failed",
          callback: {
            publicationCutoffAt: expiry + resultDeliveryGraceMs,
          },
        },
      });
      expect(harness.callback).toHaveBeenCalledOnce();
      expect(await harness.callback.mock.calls[0]?.[0].json()).toMatchObject({
        outcome: "failed_to_start",
        endedAt: expiry,
      });

      const restored = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
      );
      await controllerDriver(restored).fakeControlReady({ runId: start.runId, now: expiry - 1 });
      expect(await controllerDriver(restored).state()).toMatchObject({
        state: { phase: "failed" },
      });
    });

    it.each([
      ["before_aggregate_write", "failed"],
      ["after_aggregate_write", "ending"],
    ] as const)(
      "reconstructs the atomic Live decision at %s",
      async (crashPoint, expectedPhase) => {
        const harness = setup();
        const acceptedAt = Date.now();
        await harness.driver.start({ ...start, createdAt: acceptedAt, startedAt: acceptedAt });
        const interrupted = createInterviewRuntimeController(
          harness.durable.ctx,
          harness.env,
          harness.provider,
          undefined,
          {
            aggregatePersistence(point) {
              if (point === crashPoint) throw new Error("simulated_live_transition_crash");
            },
          },
        );
        vi.setSystemTime(acceptedAt + applicationSetupDeadlineMs - 1);
        const background = vi
          .spyOn(harness.durable.ctx, "waitUntil")
          .mockImplementationOnce((task) => {
            void task.catch(() => undefined);
          });

        expect(
          await controllerDriver(interrupted).fakeControlReady({
            runId: start.runId,
            now: Date.now(),
          }),
        ).toMatchObject({ status: 500, error: "simulated_live_transition_crash" });
        await expect(background.mock.calls[0]?.[0]).rejects.toThrow(
          "simulated_live_transition_crash",
        );
        background.mockRestore();

        const restored = createInterviewRuntimeController(
          harness.durable.ctx,
          harness.env,
          harness.provider,
        );
        vi.setSystemTime(acceptedAt + applicationSetupDeadlineMs);
        await restored.alarm();
        await harness.durable.flushWaitUntil();
        expect(await controllerDriver(restored).state()).toMatchObject({
          state: { phase: expectedPhase },
        });
      },
    );

    it("retries an identical result after the application committed but its callback response was lost", async () => {
      const bodies: unknown[] = [];
      const harness = setup(
        vi.fn(async (request: Request) => {
          bodies.push(await request.json());
          if (bodies.length === 1) throw new Error("response_lost");
          return Response.json({ ok: true });
        }),
      );
      await harness.driver.startConnection(start);
      await harness.durable.flushWaitUntil();
      const retryAt = harness.durable.storage.currentAlarm;
      const cutoffAt = Date.now() + resultDeliveryGraceMs;
      expect(retryAt).toBeGreaterThan(Date.now());
      const restored = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
      );
      vi.setSystemTime(retryAt ?? 0);
      await restored.alarm();
      await harness.durable.flushWaitUntil();
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(await controllerDriver(restored).state()).toMatchObject({
        state: {
          callback: {
            pending: false,
            attemptCount: 2,
            status: "delivered",
            publicationCutoffAt: cutoffAt,
          },
        },
      });
    });

    it("uses bounded outbox retry timing and expires exactly thirty seconds after materialization", async () => {
      const bodies: unknown[] = [];
      const harness = setup(
        vi.fn(async (request: Request) => {
          bodies.push(await request.json());
          return Response.json({ error: "unavailable" }, { status: 503 });
        }),
        {
          hangUp: vi.fn(async () =>
            providerFailure({
              stage: "hangup",
              code: "session_release_uncertain",
              retryable: false,
            }),
          ),
        },
      );
      const materializedAt = Date.now();
      await harness.driver.startConnection(start);
      await harness.durable.flushWaitUntil();

      const cutoffAt = materializedAt + resultDeliveryGraceMs;
      expect(await harness.driver.state()).toMatchObject({
        state: {
          callback: {
            pending: true,
            status: "retrying",
            publicationCutoffAt: cutoffAt,
            retryAt: materializedAt + 2_000,
            attemptCount: 1,
          },
        },
      });
      for (const expectedAt of [
        materializedAt + 2_000,
        materializedAt + 6_000,
        materializedAt + 14_000,
        materializedAt + 22_000,
      ]) {
        expect(harness.durable.storage.currentAlarm).toBe(expectedAt);
        vi.setSystemTime(expectedAt);
        await harness.controller.alarm();
        await harness.durable.flushWaitUntil();
      }
      expect(harness.durable.storage.currentAlarm).toBe(cutoffAt);
      expect(bodies).toHaveLength(5);
      expect(bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0]))).toBe(true);

      const restored = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
      );
      vi.setSystemTime(cutoffAt);
      await restored.alarm();
      await harness.durable.flushWaitUntil();
      expect(bodies).toHaveLength(5);
      expect(await controllerDriver(restored).state()).toMatchObject({
        state: {
          phase: "failed",
          callback: {
            pending: false,
            status: "expired",
            publicationCutoffAt: cutoffAt,
            attemptCount: 5,
            lastError: "callback_http_503",
          },
        },
      });
      const repository = new InterviewFinalizationRepository(
        createDurableObjectState(harness.durable.ctx).storage,
      );
      expect(
        repository
          .readEventsByName("runtime.event_recorded")
          .filter(
            (event) =>
              parseJsonObject(event.payload_json)?.record &&
              readRecord(parseJsonObject(event.payload_json)?.record).type ===
                "runtime.publication_expired",
          ),
      ).toHaveLength(1);
      expect(
        repository
          .readEventsByName("runtime.event_recorded")
          .filter(
            (event) =>
              parseJsonObject(event.payload_json)?.record &&
              readRecord(parseJsonObject(event.payload_json)?.record).type ===
                "runtime.provider_cleanup_unconfirmed",
          ),
      ).toHaveLength(1);
      expect(harness.provider.hangUp).toHaveBeenCalledOnce();

      vi.setSystemTime(cutoffAt + 10_000);
      await restored.alarm();
      await harness.durable.flushWaitUntil();
      expect(bodies).toHaveLength(5);
      expect(harness.durable.storage.currentAlarm).toBeNull();
    });

    it("retains the publication decision after rejected pre-dispatch alarm persistence and recovers on the same instance", async () => {
      const harness = setup();
      await harness.driver.start(start);
      const materializedAt = Date.now();
      const persisted = acceptanceDeferred<void>();
      vi.mocked(harness.durable.storage.setAlarm).mockImplementationOnce(async () => {
        await persisted.promise;
        throw new Error("alarm_storage_rejected");
      });
      expect(
        await harness.driver.requiredStop({
          runId: start.runId,
          reason: "application_startup_failed",
        }),
      ).toMatchObject({ accepted: true });
      const drained = expect(harness.durable.flushWaitUntil()).rejects.toThrow(
        "alarm_storage_rejected",
      );
      persisted.resolve();
      await drained;
      expect(harness.callback).not.toHaveBeenCalled();
      expect(await harness.driver.state()).toMatchObject({
        state: {
          phase: "failed",
          callback: {
            pending: true,
            status: "retrying",
            retryAt: materializedAt + 2_000,
            publicationCutoffAt: materializedAt + resultDeliveryGraceMs,
            attemptCount: 1,
          },
        },
      });
      vi.setSystemTime(materializedAt + 2_000);
      await harness.controller.alarm();
      await harness.durable.flushWaitUntil();
      expect(await harness.driver.state()).toMatchObject({
        state: {
          phase: "failed",
          callback: {
            pending: false,
            status: "delivered",
            publicationCutoffAt: materializedAt + resultDeliveryGraceMs,
            attemptCount: 2,
          },
        },
      });
      expect(harness.callback).toHaveBeenCalledOnce();
      await harness.controller.alarm();
      await harness.durable.flushWaitUntil();
      expect(harness.callback).toHaveBeenCalledOnce();
    });

    it("surfaces a rejected delivery owner and retries its retained receipt decision without reconstruction", async () => {
      const reply = acceptanceDeferred<Response>();
      let interrupted = false;
      const callback = vi.fn(async (_request: Request) => reply.promise);
      const harness = setup(
        callback,
        {},
        {
          publication(point) {
            if (point === "after_response_before_receipt" && !interrupted) {
              interrupted = true;
              throw new Error("simulated_publication_interruption");
            }
          },
        },
      );
      await harness.driver.start(start);
      const materializedAt = Date.now();
      await harness.driver.requiredStop({
        runId: start.runId,
        reason: "application_startup_failed",
      });
      const drained = expect(harness.durable.flushWaitUntil()).rejects.toThrow(
        "simulated_publication_interruption",
      );
      reply.resolve(Response.json({ ok: true }));
      await drained;
      expect(await harness.driver.state()).toMatchObject({
        state: {
          callback: {
            status: "retrying",
            pending: true,
            attemptCount: 1,
            retryAt: materializedAt + 2_000,
            publicationCutoffAt: materializedAt + resultDeliveryGraceMs,
          },
        },
      });
      callback.mockImplementationOnce(async () => Response.json({ ok: true }));
      vi.setSystemTime(materializedAt + 2_000);
      await harness.controller.alarm();
      await harness.durable.flushWaitUntil();
      expect(await harness.driver.state()).toMatchObject({
        state: {
          callback: {
            status: "delivered",
            pending: false,
            attemptCount: 2,
            publicationCutoffAt: materializedAt + resultDeliveryGraceMs,
          },
        },
      });
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it("keeps one failed-start delivery owner while alarm invocations compete", async () => {
      const reply = acceptanceDeferred<Response>();
      const callback = vi.fn(async (_request: Request) =>
        Response.json({ error: "unavailable" }, { status: 503 }),
      );
      const harness = setup(callback);
      await harness.driver.start(start);
      const materializedAt = Date.now();
      await harness.driver.requiredStop({
        runId: start.runId,
        reason: "application_startup_failed",
      });
      await harness.durable.flushWaitUntil();
      callback.mockImplementationOnce(() => reply.promise);
      vi.setSystemTime(materializedAt + 2_000);
      const admitted = harness.controller.alarm();
      await vi.advanceTimersByTimeAsync(0);
      expect(callback).toHaveBeenCalledTimes(2);
      const competing = Array.from({ length: 12 }, () => harness.controller.alarm());
      await vi.advanceTimersByTimeAsync(0);
      expect(callback).toHaveBeenCalledTimes(2);
      reply.resolve(Response.json({ ok: true }));
      await admitted;
      await Promise.all(competing);
      await harness.durable.flushWaitUntil();
      expect(await harness.driver.state()).toMatchObject({
        state: {
          phase: "failed",
          callback: {
            pending: false,
            status: "delivered",
            attemptCount: 2,
            publicationCutoffAt: materializedAt + resultDeliveryGraceMs,
          },
        },
      });
      expect(await callback.mock.calls[1]?.[0].json()).toEqual({
        runId: start.runId,
        outcome: "failed_to_start",
        endedAt: materializedAt,
        runtimeUsage: { completeness: "complete", observations: [] },
      });
      expect(harness.provider.hangUp).not.toHaveBeenCalled();
    });

    it("expires a pending pre-cutoff-schema result on reconstruction without granting a new window", async () => {
      const harness = setup(
        vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 })),
      );
      await harness.driver.startConnection(start);
      await harness.durable.flushWaitUntil();
      const repository = new InterviewFinalizationRepository(
        createDurableObjectState(harness.durable.ctx).storage,
      );
      const beforeMigration = readRunRecordView(repository);
      harness.durable.storage.sql.exec(
        `UPDATE runtime_controller_state
         SET failed_start_publication_cutoff_at = NULL,
             failed_start_publication_status = 'inactive', callback_retry_at = ?
         WHERE run_id = ?`,
        Date.now() + 10 * 60_000,
        start.runId,
      );

      const restored = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
      );
      await restored.alarm();
      await harness.durable.flushWaitUntil();

      expect(harness.callback).toHaveBeenCalledOnce();
      expect(await controllerDriver(restored).state()).toMatchObject({
        state: {
          callback: {
            pending: false,
            status: "expired",
            publicationCutoffAt: Date.now(),
            attemptCount: beforeMigration.callbackAttemptCount,
            lastError: beforeMigration.callbackLastError,
          },
        },
      });
    });

    it("does not count or erase diagnostics for work that reaches the cutoff before transport", async () => {
      const bodies: unknown[] = [];
      const harness = setup(
        vi.fn(async (request: Request) => {
          bodies.push(await request.json());
          return Response.json({ error: "unavailable" }, { status: 503 });
        }),
      );
      const materializedAt = Date.now();
      await harness.driver.startConnection(start);
      await harness.durable.flushWaitUntil();
      for (const expectedAt of [
        materializedAt + 2_000,
        materializedAt + 6_000,
        materializedAt + 14_000,
      ]) {
        vi.setSystemTime(expectedAt);
        await harness.controller.alarm();
        await harness.durable.flushWaitUntil();
      }

      const cutoffAt = materializedAt + resultDeliveryGraceMs;
      vi.mocked(harness.durable.storage.setAlarm).mockImplementation(async (scheduledAt) => {
        harness.durable.storage.currentAlarm = scheduledAt;
        if (scheduledAt === cutoffAt) vi.setSystemTime(cutoffAt);
      });
      vi.setSystemTime(materializedAt + 22_000);
      await harness.controller.alarm();
      await harness.durable.flushWaitUntil();

      expect(bodies).toHaveLength(4);
      expect(await harness.driver.state()).toMatchObject({
        state: {
          callback: {
            pending: false,
            status: "expired",
            publicationCutoffAt: cutoffAt,
            attemptCount: 4,
            lastError: "callback_http_503",
          },
        },
      });
    });

    it("stops publication retries after a contradictory callback", async () => {
      const harness = setup(
        vi.fn(async () => Response.json({ error: "terminal_result_conflict" }, { status: 409 })),
      );
      await harness.driver.startConnection(start);
      await harness.durable.flushWaitUntil();
      expect(harness.durable.storage.currentAlarm).toBeNull();
      await harness.controller.alarm();
      await harness.durable.flushWaitUntil();
      expect(harness.callback).toHaveBeenCalledOnce();
      expect(await harness.driver.state()).toMatchObject({
        state: {
          callback: {
            pending: false,
            status: "blocked_nonretryable_callback",
            lastError: "callback_http_409",
          },
        },
      });
    });

    it("terminalizes while provider creation is pending and cleans a late known call without going live", async () => {
      let resolveCall: ((value: typeof createdCall) => void) | undefined;
      const pendingCall = new Promise<typeof createdCall>((resolve) => {
        resolveCall = resolve;
      });
      const harness = setup(undefined, { createCall: vi.fn(() => pendingCall) });
      const request = harness.driver.startConnection(start);
      await vi.waitFor(() => expect(harness.provider.createCall).toHaveBeenCalledOnce());
      vi.setSystemTime(harness.durable.storage.currentAlarm ?? 0);
      await harness.controller.alarm();
      resolveCall?.(createdCall);
      expect(await request).toMatchObject({
        acceptance: "accepted",
        error: "runtime_controller_start_failed",
      });
      await harness.durable.flushWaitUntil();
      expect(harness.provider.hangUp).toHaveBeenCalledOnce();
      expect(harness.provider.connectSideband).not.toHaveBeenCalled();
      expect(harness.callback).toHaveBeenCalledOnce();
    });

    it.each(["complete", "reject"] as const)(
      "retains late native identity through a pending %s alarm handoff on the same instance",
      async (handoff) => {
        const headers = acceptanceDeferred<Response>();
        const fetchImpl: typeof fetch = vi.fn(() => headers.promise);
        const createCall = vi.fn((input: ProviderCreateCallInput) =>
          openAiDriverOver(fetchImpl).createCall(input),
        );
        const harness = setup(undefined, { createCall });
        const request = harness.driver.startConnection(start);
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
        const cutoff = createCall.mock.calls[0]?.[0].deadlineAt ?? 0;
        await vi.advanceTimersByTimeAsync(cutoff - Date.now());
        expect(await request).toMatchObject({
          acceptance: "accepted",
          error: "provider_call_failed",
        });
        const repository = new InterviewFinalizationRepository(
          createDurableObjectState(harness.durable.ctx).storage,
        );
        expect(readRunRecordView(repository)).toMatchObject({
          phase: "failed",
          sessionId: null,
        });
        const arm = acceptanceDeferred<void>();
        const setAlarm = vi
          .spyOn(harness.durable.storage, "setAlarm")
          .mockImplementationOnce(async () => {
            await arm.promise;
            if (handoff === "reject") throw new Error("alarm_storage_rejected");
          });
        const response = new Response("late-sdp", {
          status: 201,
          headers: {
            Location: "https://api.openai.com/v1/realtime/calls/rtc_native_late",
          },
        });
        const read = vi.spyOn(response, "text");
        headers.resolve(response);
        await vi.waitFor(() => expect(setAlarm).toHaveBeenCalled());
        expect(readRunRecordView(repository).sessionId).toBeNull();
        arm.resolve();
        await harness.durable.flushWaitUntil();
        await harness.controller.alarm();
        await harness.durable.flushWaitUntil();
        expect(readRunRecordView(repository)).toMatchObject({
          phase: "failed",
          sessionId: "rtc_native_late",
          sessionReplyJson: null,
          setupCleanupPending: false,
        });
        expect(vi.mocked(harness.provider.hangUp).mock.calls).toEqual([
          [expect.objectContaining({ callId: "rtc_native_late" })],
        ]);
        expect(harness.provider.connectSideband).toHaveBeenCalledTimes(0);
        expect(read).toHaveBeenCalledTimes(0);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      },
    );

    it("keeps durable identity when stopping the same instance during its asynchronous handoff", async () => {
      const headers = acceptanceDeferred<Response>();
      const fetchImpl: typeof fetch = vi.fn(() => headers.promise);
      const createCall = vi.fn((input: ProviderCreateCallInput) =>
        openAiDriverOver(fetchImpl).createCall(input),
      );
      const harness = setup(undefined, { createCall });
      const request = harness.driver.startConnection(start);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      const recompute = acceptanceDeferred<void>();
      vi.mocked(harness.durable.storage.getAlarm).mockImplementationOnce(async () => {
        await recompute.promise;
        return harness.durable.storage.currentAlarm;
      });
      const response = new Response("late-sdp", {
        status: 201,
        headers: {
          Location: "https://api.openai.com/v1/realtime/calls/rtc_identified_before_stop",
        },
      });
      const read = vi.spyOn(response, "text");
      headers.resolve(response);
      const repository = new InterviewFinalizationRepository(
        createDurableObjectState(harness.durable.ctx).storage,
      );
      await vi.waitFor(() =>
        expect(readRunRecordView(repository).sessionId).toBe("rtc_identified_before_stop"),
      );
      expect(
        await harness.driver.requiredStop({
          runId: start.runId,
          reason: "application_startup_failed",
        }),
      ).toMatchObject({ accepted: true });
      await vi.advanceTimersByTimeAsync(
        (createCall.mock.calls[0]?.[0].deadlineAt ?? 0) - Date.now(),
      );
      expect(await request).toMatchObject({ error: "provider_call_failed" });
      recompute.resolve();
      await harness.durable.flushWaitUntil();
      expect(readRunRecordView(repository)).toMatchObject({
        phase: "failed",
        sessionId: "rtc_identified_before_stop",
        sessionReplyJson: null,
        setupCleanupPending: false,
      });
      expect(vi.mocked(harness.provider.hangUp).mock.calls).toEqual([
        [expect.objectContaining({ callId: "rtc_identified_before_stop" })],
      ]);
      expect(harness.provider.connectSideband).toHaveBeenCalledTimes(0);
      expect(read).toHaveBeenCalledTimes(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("rechecks admitted operation identity after a late alarm await before persisting", async () => {
      const headers = acceptanceDeferred<Response>();
      const fetchImpl: typeof fetch = vi.fn(() => headers.promise);
      const createCall = vi.fn((input: ProviderCreateCallInput) =>
        openAiDriverOver(fetchImpl).createCall(input),
      );
      const harness = setup(undefined, { createCall });
      const request = harness.driver.startConnection(start);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(
        (createCall.mock.calls[0]?.[0].deadlineAt ?? 0) - Date.now(),
      );
      expect(await request).toMatchObject({ error: "provider_call_failed" });
      const arm = acceptanceDeferred<void>();
      const setAlarm = vi
        .spyOn(harness.durable.storage, "setAlarm")
        .mockImplementationOnce(() => arm.promise);
      headers.resolve(
        new Response("late-sdp", {
          status: 201,
          headers: {
            Location: "https://api.openai.com/v1/realtime/calls/rtc_stale_create",
          },
        }),
      );
      await vi.waitFor(() => expect(setAlarm).toHaveBeenCalled());
      harness.durable.storage.sql.exec(
        "UPDATE runtime_controller_state SET provider_creation_started = 0",
      );
      arm.resolve();
      await harness.durable.flushWaitUntil();
      const repository = new InterviewFinalizationRepository(
        createDurableObjectState(harness.durable.ctx).storage,
      );
      expect(readRunRecordView(repository)).toMatchObject({
        phase: "failed",
        sessionId: null,
        sessionReplyJson: null,
      });
      expect(vi.mocked(harness.provider.hangUp).mock.calls).toEqual([
        [expect.objectContaining({ callId: "rtc_stale_create" })],
      ]);
      expect(harness.provider.connectSideband).toHaveBeenCalledTimes(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("recovers a late identity after persistence interruption and never rearms completed cleanup", async () => {
      const creation = acceptanceDeferred<typeof createdCall>();
      let identify: ProviderCreateCallInput["onCallIdentified"];
      let injected = false;
      const harness = setup(
        undefined,
        {
          createCall: vi.fn(async (input: ProviderCreateCallInput) => {
            identify = input.onCallIdentified;
            return creation.promise;
          }),
        },
        {
          providerIdentity(point) {
            if (!injected && point === "after_identity_persisted") {
              injected = true;
              throw new Error("simulated_identity_persistence_interruption");
            }
          },
        },
      );
      const request = harness.driver.startConnection(start);
      await vi.waitFor(() => expect(identify).toBeTypeOf("function"));
      const identifyCall = requireDefined(identify, "expected provider identity callback");
      const deadline = harness.durable.storage.currentAlarm ?? 0;
      vi.setSystemTime(deadline);
      await harness.controller.alarm();
      // Startup's observed owner is still awaiting native creation. Observe failed-start
      // progress independently until that boundary resolves below.
      await vi.waitFor(async () =>
        expect(await harness.driver.state()).toMatchObject({
          state: { callback: { status: "delivered" } },
        }),
      );
      expect(harness.durable.storage.currentAlarm).toBeNull();
      const repository = new InterviewFinalizationRepository(
        createDurableObjectState(harness.durable.ctx).storage,
      );
      const sealedCompletion = readRunRecordView(repository).sealedCompletion;
      const identity = {
        status: 201,
        responseContentType: "application/sdp",
        sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_known",
        sessionId: "rtc_known",
        upstreamRequestId: "req_1",
      };

      await expect(identifyCall(identity)).rejects.toThrow(
        "simulated_identity_persistence_interruption",
      );
      expect(harness.durable.storage.currentAlarm).toBe(Date.now());
      expect(readRunRecordView(repository)).toMatchObject({
        sessionId: "rtc_known",
        sessionReplyJson: null,
        setupCleanupPending: true,
      });

      const restored = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
      );
      await restored.alarm();
      expect(harness.provider.hangUp).toHaveBeenCalledOnce();
      expect(readRunRecordView(repository)).toMatchObject({ setupCleanupPending: false });

      await identifyCall(identity);
      creation.resolve(createdCall);
      expect(await request).toMatchObject({
        acceptance: "accepted",
        error: "runtime_controller_start_failed",
      });
      await harness.durable.flushWaitUntil();
      expect(harness.provider.createCall).toHaveBeenCalledOnce();
      expect(harness.provider.hangUp).toHaveBeenCalledOnce();
      expect(readRunRecordView(repository)).toMatchObject({
        sessionReplyJson: JSON.stringify({ sdp: "v=0\r\nanswer" }),
        sealedCompletion: sealedCompletion,
        setupCleanupPending: false,
      });
    });

    it.each(["before_aggregate_write", "after_aggregate_write"] as const)(
      "recovers terminal decision at %s without losing publication intent",
      async (crashPoint) => {
        const harness = setup();
        const interrupted = createInterviewRuntimeController(
          harness.durable.ctx,
          harness.env,
          harness.provider,
          undefined,
          {
            aggregatePersistence(point) {
              if (point === crashPoint) throw new Error("simulated_crash");
            },
          },
        );
        await controllerDriver(interrupted).start({ ...start, createdAt: Date.now() });
        const deadline = harness.durable.storage.currentAlarm ?? 0;
        vi.setSystemTime(deadline + 500);
        await expect(interrupted.alarm()).rejects.toThrow("simulated_crash");
        const restored = createInterviewRuntimeController(
          harness.durable.ctx,
          harness.env,
          harness.provider,
        );
        await restored.alarm();
        await harness.durable.flushWaitUntil();
        const callback = harness.callback.mock.calls[0]?.[0];
        expect(await callback?.json()).toEqual({
          runId: start.runId,
          outcome: "failed_to_start",
          endedAt: deadline,
          runtimeUsage: { completeness: "complete", observations: [] },
        });
        expect(harness.callback).toHaveBeenCalledOnce();
        expect(await controllerDriver(restored).state()).toMatchObject({
          state: { phase: "failed", callback: { pending: false } },
        });
      },
    );

    it("keeps the live winner and existing completion authority after the setup deadline", async () => {
      const harness = setup();
      await harness.driver.start({ ...start, createdAt: Date.now() });
      const deadline = harness.durable.storage.currentAlarm ?? 0;
      vi.setSystemTime(deadline - 1);
      await harness.driver.fakeControlReady({ runId: start.runId });
      vi.setSystemTime(deadline);
      await harness.controller.alarm();
      expect(await harness.driver.state()).toMatchObject({ state: { phase: "live" } });
      expect(harness.callback).toHaveBeenCalledOnce();
      expect(new URL(harness.callback.mock.calls[0]?.[0].url ?? "").pathname).toBe("/readiness");
    });

    it("bounds readiness response parsing and retains an unknown disposition", async () => {
      const cancel = vi.fn();
      let markReading: () => void = () => {
        throw new Error("readiness_reader_uninitialized");
      };
      const reading = new Promise<void>((resolve) => {
        markReading = resolve;
      });
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"disposition":"succeeded",'));
          },
          pull() {
            markReading();
          },
          cancel,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
      const harness = setup(vi.fn(async () => response));
      await harness.driver.start({ ...start, createdAt: Date.now() });

      const ready = harness.driver.fakeControlReady({ runId: start.runId });
      await reading;
      await vi.advanceTimersByTimeAsync(4_000);

      await expect(ready).resolves.toMatchObject({ state: { phase: "live" } });
      const repository = new InterviewFinalizationRepository(
        createDurableObjectState(harness.durable.ctx).storage,
      );
      expect(readRunRecordView(repository)).toMatchObject({
        readinessDisposition: "unknown",
        readinessDeliveredAt: null,
      });
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    });

    it("records unconfirmed cleanup without withholding the terminal result", async () => {
      const harness = setup(undefined, {
        hangUp: vi.fn(async () =>
          providerFailure({ stage: "hangup", code: "session_release_uncertain", retryable: false }),
        ),
      });
      await harness.driver.startConnection(start);
      await harness.durable.flushWaitUntil();
      const repository = new InterviewFinalizationRepository(
        createDurableObjectState(harness.durable.ctx).storage,
      );
      expect(
        repository
          .readEventsByName("runtime.event_recorded")
          .filter(
            (event) =>
              parseJsonObject(event.payload_json)?.record &&
              readRecord(parseJsonObject(event.payload_json)?.record).type ===
                "runtime.provider_cleanup_unconfirmed",
          ),
      ).toHaveLength(1);
      expect(harness.callback).toHaveBeenCalledOnce();
    });

    it("preserves failed-start publication retries when late provider messages drain", async () => {
      const controlled = createControlledProviderSocket();
      let terminalAttempts = 0;
      const callback = vi.fn(async (request: Request) => {
        if (new URL(request.url).pathname === "/readiness") {
          return Response.json({
            runId: start.runId,
            disposition: "succeeded",
            decidedAt: Date.now(),
            reason: "readiness_confirmed",
            stopRequired: false,
          });
        }
        terminalAttempts += 1;
        return terminalAttempts === 1
          ? Response.json({ error: "unavailable" }, { status: 503 })
          : Response.json({ ok: true });
      });
      const harness = setup(callback, {
        connectSideband: vi.fn(async () => {
          vi.setSystemTime(Date.now() + applicationSetupDeadlineMs);
          return providerSuccess(controlled.socket);
        }),
        sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
          providerSuccess(undefined),
        ),
        sendCommand: vi.fn(() => providerSuccess(undefined)),
      });
      try {
        await harness.driver.startConnection(start);
        await vi.waitFor(() => expect(terminalAttempts).toBe(1));
        await vi.advanceTimersByTimeAsync(1);
        const retryAt = harness.durable.storage.currentAlarm;
        expect(retryAt).toBeGreaterThan(Date.now());
        controlled.emit("message", { data: JSON.stringify({ type: "session.updated" }) });
        await vi.advanceTimersByTimeAsync(1);
        expect(harness.durable.storage.currentAlarm).toBe(retryAt);
        vi.setSystemTime(retryAt ?? 0);
        await harness.controller.alarm();
        expect(terminalAttempts).toBe(2);
      } finally {
        controlled.emit("close", { code: 1000 });
        await harness.durable.flushWaitUntil();
      }
    });

    it("enforces the original Lab deadline and publishes a pre-live failed start", async () => {
      const harness = setup();
      await harness.driver.start({ ...start, diagnosticsContext: { surface: "lab" } });
      expect(harness.durable.storage.currentAlarm).toBe(start.startupExpiresAt);
      vi.setSystemTime(start.startupExpiresAt);
      expect(await harness.driver.fakeControlReady({ runId: start.runId })).toMatchObject({
        state: { phase: "failed" },
      });
      await harness.durable.flushWaitUntil();
      const state = await harness.driver.state();
      expect(state.state).not.toHaveProperty("liveAt");
      expect(harness.provider.createCall).not.toHaveBeenCalled();
      expect(harness.callback).toHaveBeenCalled();
    });
  });
}

function acceptanceDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve: (value: T) => {
      if (resolve === undefined) throw new Error("promise_not_initialized");
      resolve(value);
    },
  };
}

export function registerInterruptionRegressionSuite() {
  const startedAt = 1_700_000_000_000;
  const runId = "response_direct_interruption";
  const resources: Array<
    Readonly<{
      durable: ReturnType<typeof createTestDurableObjectContext>;
      controlled: ReturnType<typeof createControlledProviderSocket>;
    }>
  > = [];

  afterEach(async () => {
    for (const resource of resources.splice(0)) {
      resource.controlled.emit("close", { code: 1000 });
      await resource.durable.flushWaitUntil();
      resource.durable.close();
    }
  });

  function setup(
    surface: "test" | "lab" = "test",
    failure: "none" | "lost_response" | "conflict" = "none",
    overrides: RealtimeDriverScript = {},
    implementationOverride?: Parameters<typeof createInterviewRuntimeController>[3],
  ) {
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);
    const durable = createTestDurableObjectContext();
    const controlled = createControlledProviderSocket();
    resources.push({ durable, controlled });
    const interrupted: InterruptedResult[] = [];
    const completed: CompletedResult[] = [];
    const transcripts: RuntimeTranscriptUpdatedCallback[] = [];
    const legacy: RuntimeCompletedCallback[] = [];
    const callback = vi.fn(async (request: Request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname !== "/completion" && pathname !== "/transcript") {
        return Response.json({ ok: true });
      }
      expect(request.headers.get("X-Runtime-Callback")).toBe("interview-runtime-controller");
      // Runtime's host forwards no part of the stored URL, such as its query.
      expect(new URL(request.url).search).toBe("");
      const body: unknown = await request.json();
      if (pathname === "/transcript") {
        const transcript = decodeRuntimeTranscriptUpdatedCallback(body);
        transcripts.push(transcript);
        return Response.json({
          version: 2,
          status: "stored",
          requestedMatches: true,
          storedSnapshot: transcript.snapshot,
        });
      }
      const result = parseInterruptedResult(body) ?? parseCompletedResult(body);
      if (result !== null) {
        if (result.outcome === "interrupted") interrupted.push(result);
        else completed.push(result);
        expect(body).toEqual(result);
        if (failure === "lost_response" && interrupted.length + completed.length === 1)
          throw new Error("response_lost_after_commit");
        if (failure === "conflict")
          return Response.json({ error: "terminal_result_conflict" }, { status: 409 });
        return Response.json({
          version: 2,
          status: interrupted.length + completed.length > 1 ? "idempotent" : "completed",
          requestedMatches: true,
          storedSnapshot: result.transcriptSnapshot,
        });
      }
      const completion = decodeRuntimeCompletedCallback(body);
      legacy.push(completion);
      return Response.json({
        version: 2,
        status: "completed",
        requestedMatches: true,
        storedSnapshot: completion.completion.transcriptSnapshot,
      });
    });
    const provider = {
      createCall: vi.fn(async () =>
        providerSuccess({
          status: 201,
          answerSdp: "v=0\r\nanswer",
          responseContentType: "application/sdp",
          sessionId: "rtc_direct_interruption",
          sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_direct_interruption",
          upstreamRequestId: "req_direct_interruption",
        }),
      ),
      connectSideband: vi.fn(async () => providerSuccess(controlled.socket)),
      sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
        providerSuccess(undefined),
      ),
      sendCommand: vi.fn(() => providerSuccess(undefined)),
      hangUp: vi.fn(async () =>
        providerFailure({
          stage: "hangup",
          code: "session_release_failed",
          providerStatus: 404,
          retryable: false,
        }),
      ),
      ...overrides,
    };
    const env = {
      OPENAI_API_KEY: "test",
      TEST_CALLBACK_WORKER: applicationCallbacks({ fetch: callback }),
      LAB_CALLBACK_WORKER: applicationCallbacks({ fetch: callback }),
    };
    const controller = createInterviewRuntimeController(
      durable.ctx,
      env,
      provider,
      implementationOverride,
    );
    const start = {
      selection: originalRealtimeSelection,
      runId,
      profile: "realtime-v1",
      connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
      ...(surface === "test"
        ? { createdAt: startedAt, execution: originalStart(60_000).execution }
        : {
            createdAt: startedAt,
            execution: {
              agentInput: createInterviewConversationInput("Test direct continuity loss"),
            },
          }),
      ...deliveryTo(surface, runId),
      diagnosticsContext: { surface },
    };
    return {
      durable,
      controlled,
      provider,
      env,
      controller,
      start,
      driver: controllerDriver(controller),
      callback,
      interrupted,
      completed,
      transcripts,
      legacy,
    };
  }

  async function startLive(
    harness: ReturnType<typeof setup>,
    settings?: import("../../providers/openaiRealtime/settings.ts").RealtimeExecutionSettings,
  ) {
    const response = await harness.driver.startConnection(
      settings === undefined ? harness.start : { ...harness.start, executionSettings: settings },
    );
    expect(response.status, JSON.stringify(response.data)).toBe(200);
    await vi.waitFor(async () => {
      expect(await harness.driver.state()).toMatchObject({ state: { phase: "live" } });
    });
    await harness.controller.fetch(
      new Request("https://controller.test/media-ready", {
        method: "POST",
        body: JSON.stringify({ runId: harness.start.runId }),
      }),
    );
    // The application can persist Live before its callback receipt and initial Agent
    // command complete. Provider events arrive after that command is sent.
    await vi.advanceTimersByTimeAsync(0);
    if (harness.start.diagnosticsContext.surface === "test")
      expect(harness.provider.sendCommand).toHaveBeenCalledOnce();
  }

  async function seal(harness: ReturnType<typeof setup>, endedAt: number) {
    vi.setSystemTime(endedAt + 9_000);
    await harness.controller.alarm();
    vi.setSystemTime(endedAt + 20_000);
    await harness.controller.alarm();
    await vi.waitFor(async () => {
      expect(await harness.driver.state()).toMatchObject({ state: { phase: "ended" } });
    });
    await harness.controller.alarm();
    await vi.waitFor(() => {
      expect(
        harness.interrupted.length + harness.completed.length + harness.legacy.length,
      ).toBeGreaterThan(0);
    });
  }

  it.each(["test", "lab"] as const)(
    "publishes the current interviewer text received after End on %s",
    async (surface) => {
      const harness = setup(surface);
      await startLive(harness);
      const emit = (
        event:
          | { type: "response.created"; response: { id: string } }
          | { type: "response.done"; response: { id: string; status: "cancelled"; output: [] } }
          | { type: "output_audio_buffer.started"; response_id: string }
          | {
              type: "response.output_audio_transcript.done";
              response_id: string;
              item_id: string;
              transcript: string;
            },
      ) => harness.controlled.emit("message", { data: JSON.stringify(event) });
      emit({ type: "response.created", response: { id: "current" } });
      emit({ type: "output_audio_buffer.started", response_id: "current" });
      await vi.advanceTimersByTimeAsync(0);
      const endedAt = startedAt + 1_000;
      vi.setSystemTime(endedAt);
      await harness.driver.complete({ runId, endReason: "participant_stopped", now: endedAt });
      emit({ type: "response.done", response: { id: "current", status: "cancelled", output: [] } });
      await vi.advanceTimersByTimeAsync(0);
      vi.setSystemTime(endedAt + 9_000);
      await harness.controller.alarm();
      expect(await harness.driver.state()).toMatchObject({ state: { phase: "ending" } });
      vi.setSystemTime(endedAt + 9_500);
      emit({ type: "response.created", response: { id: "later" } });
      emit({ type: "response.done", response: { id: "later", status: "cancelled", output: [] } });
      emit({
        type: "response.output_audio_transcript.done",
        response_id: "current",
        item_id: "question",
        transcript: "What should we improve next?",
      });
      emit({
        type: "response.output_audio_transcript.done",
        response_id: "current",
        item_id: "question",
        transcript: "What should we improve next?",
      });
      emit({
        type: "response.output_audio_transcript.done",
        response_id: "later",
        item_id: "new-question",
        transcript: "Must stay excluded",
      });
      await vi.waitFor(async () =>
        expect(await harness.driver.state()).toMatchObject({ state: { phase: "ended" } }),
      );
      await harness.controller.alarm();
      await vi.waitFor(() =>
        expect(harness.transcripts.at(-1)?.snapshot.transcript.turns).toEqual([
          { role: "conversationAgent", text: "What should we improve next?" },
        ]),
      );
      await vi.waitFor(() => expect(harness.completed.length + harness.legacy.length).toBe(1));
      expect(harness.completed).toMatchObject([
        {
          reason: "participant_stopped",
          endedAt,
          transcriptCompleteness: "complete",
          transcriptSnapshot: { turnCount: 1 },
        },
      ]);
      expect(harness.legacy).toEqual([]);
    },
  );

  describe.each(["participant_stopped", "timebox_reached"] as const)(
    "Application completed publication %s",
    (reason) => {
      it("publishes accepted Ending entry with final captured text after a delayed deadline", async () => {
        const harness = setup();
        harness.start = {
          ...harness.start,
          execution: originalStart(10_000).execution,
        };
        await startLive(harness);
        vi.setSystemTime(startedAt + 1_000);
        harness.controlled.emit("message", {
          data: JSON.stringify({
            event_id: "final-item",
            type: "input_audio_buffer.committed",
            item_id: "final",
          }),
        });
        await vi.waitFor(async () =>
          expect(await harness.driver.state()).toMatchObject({ state: { phase: "live" } }),
        );
        const endedAt = startedAt + (reason === "timebox_reached" ? 10_500 : 2_000);
        vi.setSystemTime(endedAt);
        if (reason === "timebox_reached") await harness.controller.alarm();
        else await harness.driver.complete({ runId, endReason: reason, now: 1 });
        harness.controlled.emit("message", {
          data: JSON.stringify({
            event_id: "final-text",
            type: "conversation.item.input_audio_transcription.completed",
            item_id: "final",
            transcript: "Final captured feedback",
          }),
        });
        await vi.waitFor(async () =>
          expect(await harness.driver.state()).toMatchObject({
            state: { transcript: { turnCount: 1 } },
          }),
        );
        await seal(harness, endedAt);
        expect(harness.completed).toMatchObject([
          {
            outcome: "completed",
            reason,
            liveAt: startedAt,
            endedAt,
            transcriptCompleteness: "complete",
            transcriptSnapshot: { turnCount: 1 },
          },
        ]);
        expect(harness.legacy).toEqual([]);
        expect(harness.interrupted).toEqual([]);
      });
      it("recovers pending final proof and callback loss without changing the frozen result", async () => {
        const harness = setup("test", "lost_response");
        harness.start = {
          ...harness.start,
          execution: originalStart(10_000).execution,
        };
        await startLive(harness);
        harness.controlled.emit("message", {
          data: JSON.stringify({
            event_id: "pending-item",
            type: "input_audio_buffer.committed",
            item_id: "pending",
          }),
        });
        const endedAt = startedAt + (reason === "timebox_reached" ? 10_000 : 1_000);
        vi.setSystemTime(endedAt);
        if (reason === "timebox_reached") await harness.controller.alarm();
        else await harness.driver.complete({ runId, endReason: reason, now: endedAt });
        harness.controller = createInterviewRuntimeController(
          harness.durable.ctx,
          harness.env,
          harness.provider,
        );
        harness.driver = controllerDriver(harness.controller);
        await seal(harness, endedAt);
        expect(harness.completed[0]).toMatchObject({
          reason,
          endedAt,
          transcriptCompleteness: "incomplete",
        });
        const retryAt = requireValue(harness.durable.storage.currentAlarm, "expected_retry");
        const restored = createInterviewRuntimeController(
          harness.durable.ctx,
          harness.env,
          harness.provider,
        );
        vi.setSystemTime(retryAt);
        await restored.alarm();
        await vi.waitFor(() => expect(harness.completed).toHaveLength(2));
        expect(harness.completed[1]).toEqual(harness.completed[0]);
        expect(harness.transcripts).toHaveLength(1);
        expect(harness.legacy).toEqual([]);
      });
    },
  );

  it.each(["pending_item", "complete_snapshot"] as const)(
    "freezes incomplete at cutoff with a held required prefix over %s proof",
    async (proof) => {
      const harness = setup();
      await startLive(harness);
      const repository = new InterviewFinalizationRepository(
        createDurableObjectState(harness.durable.ctx).storage,
      );
      const endedAt = startedAt + 1_000;
      vi.setSystemTime(endedAt);
      await harness.driver.complete({ runId, endReason: "participant_stopped", now: endedAt });
      const ending = readRunView(repository).lifecycle;
      if (ending.stage !== "draining") throw new Error("Expected accepted ending.");
      expect(ending.finalizationCutoffAt).toBe(endedAt + 10_000);
      if (proof === "pending_item") {
        harness.controlled.emit("message", {
          data: JSON.stringify({
            event_id: "held-prefix-item",
            type: "input_audio_buffer.committed",
            item_id: "held-prefix",
          }),
        });
        await vi.waitFor(() =>
          expect(readRunView(repository).finalInput).toMatchObject({
            admittedItemId: "held-prefix",
            obligation: "awaiting_transcription",
          }),
        );
      }

      let releaseReceipt = () => {};
      const heldReceipt = new Promise<void>((resolve) => {
        releaseReceipt = resolve;
      });
      const writeAlarm = harness.durable.storage.setAlarm;
      let held = false;
      // Pause only the external platform alarm write in the receipt's deadline
      // preflight. The real repository and existing FIFO retain their normal work.
      harness.durable.storage.setAlarm = async (at) => {
        if (!held) {
          held = true;
          await heldReceipt;
        }
        await writeAlarm(at);
      };
      try {
        vi.setSystemTime(ending.drainDeadline);
        const heldEvent =
          proof === "pending_item"
            ? {
                event_id: "held-prefix-text",
                type: "conversation.item.input_audio_transcription.completed",
                item_id: "held-prefix",
                transcript: "Required text still awaiting handoff.",
              }
            : {
                event_id: "held-prefix-text",
                type: "input_audio_buffer.committed",
                item_id: "held-prefix",
              };
        harness.controlled.emit("message", { data: JSON.stringify(heldEvent) });
        await vi.waitFor(() => expect(held).toBe(true));
        expect(readRunRecordView(repository).providerEventCount).toBe(
          proof === "pending_item" ? 1 : 0,
        );
        if (proof === "complete_snapshot") {
          expect(readRunView(repository).transcriptProof?.obligations).toEqual([]);
          expect(readRunView(repository).finalInput).toMatchObject({
            obligation: "settled",
            inputToSettle: false,
            admittedItemId: null,
          });
        }
        expect(readRunView(repository).lifecycle).toMatchObject({ sessionClosed: false });
        vi.setSystemTime(ending.finalizationCutoffAt + 100);
        await harness.controller.alarm();
        await vi.waitFor(() => expect(harness.completed).toHaveLength(1));
        expect(harness.completed[0]).toMatchObject({
          endedAt,
          reason: "participant_stopped",
          transcriptCompleteness: "incomplete",
          transcriptSnapshot: { turnCount: 0 },
        });
        expect(harness.completed[0]?.transcriptIncompleteReasons).toEqual([
          { kind: "conversation_evidence_gap" },
          ...(proof === "pending_item"
            ? [
                {
                  kind: "eligible_transcript_item_pending",
                  itemId: "held-prefix",
                  role: "participant",
                },
              ]
            : []),
        ]);
        expect(readRunView(repository).transcriptProof).toMatchObject({
          evidenceGap: true,
        });
        const frozen = readRunRecordView(repository).frozenTranscript;
        const frozenResult = structuredClone(harness.completed[0]);
        expect(readRunView(repository).lifecycle.stage).toBe("ended");
        releaseReceipt();
        await harness.durable.flushWaitUntil();
        await harness.controller.alarm();
        expect(readRunRecordView(repository).frozenTranscript).toBe(frozen);
        expect(harness.completed).toEqual([frozenResult]);
        expect(readRunView(repository).transcriptProof?.result).toEqual(frozenResult);
      } finally {
        releaseReceipt();
        harness.durable.storage.setAlarm = writeAlarm;
      }
    },
  );

  it("retains Lab transcript and usage evidence from the same native receipt", async () => {
    const harness = setup("lab");
    await startLive(harness);
    harness.controlled.emit("message", {
      data: JSON.stringify({
        event_id: "lab-measured-input",
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "lab-measured-input",
        content_index: 0,
        transcript: "Lab feedback",
        usage: {
          type: "tokens",
          total_tokens: 7,
          input_tokens: 5,
          output_tokens: 2,
          input_token_details: { audio_tokens: 5, text_tokens: 0 },
        },
      }),
    });
    await vi.waitFor(async () =>
      expect(await harness.driver.state()).toMatchObject({
        state: { transcript: { turnCount: 1 } },
      }),
    );
    const repository = new InterviewFinalizationRepository(
      createDurableObjectState(harness.durable.ctx).storage,
    );
    expect(readRunView(repository).usage).toMatchObject({
      observations: [
        { model: "gpt-4o-mini-transcribe", measure: "input_audio", quantity: 5 },
        { model: "gpt-4o-mini-transcribe", measure: "output_text", quantity: 2 },
      ],
    });
    expect(readRunView(repository).transcript.items).toMatchObject([
      { itemId: "lab-measured-input", text: "Lab feedback" },
    ]);
    expect(readRunRecordView(repository).setupUsage).toBeNull();
    const endedAt = startedAt + 1_000;
    vi.setSystemTime(endedAt);
    await harness.driver.complete({ runId, endReason: "participant_stopped", now: endedAt });
    await seal(harness, endedAt);
    expect(harness.completed[0]).toMatchObject({
      outcome: "completed",
      runtimeUsage: {
        completeness: "complete",
        observations: [
          { model: "gpt-4o-mini-transcribe", measure: "input_audio", quantity: 5 },
          { model: "gpt-4o-mini-transcribe", measure: "output_text", quantity: 2 },
        ],
      },
      transcriptSnapshot: { turnCount: 1 },
    });
  });

  it("freezes Lab with incomplete usage within the cutoff while retaining its prepared override", async () => {
    const harness = setup("lab");
    await startLive(harness, {
      model: "gpt-realtime-2.1",
      voice: "cedar",
      speed: 1,
      inputNoiseReduction: "off",
      semanticVadEagerness: "medium",
      maxOutputTokens: 700,
      truncation: "auto",
    });
    const repository = new InterviewFinalizationRepository(
      createDurableObjectState(harness.durable.ctx).storage,
    );
    harness.controlled.emit("message", {
      data: JSON.stringify({
        event_id: "lab-pending-usage",
        type: "response.created",
        response: { id: "lab-response" },
      }),
    });
    await vi.waitFor(() =>
      expect(readRunView(repository).usage?.pending).toEqual([
        { componentRole: "speech_to_speech", key: "speech_to_speech:lab-response" },
      ]),
    );
    expect(
      decodeConversationSnapshot(readRunRecordView(repository).conversationSelection)
        .executionSettings.prepared,
    ).toMatchObject({
      model: "gpt-realtime-2.1",
      inputAudio: { noiseReduction: { type: "off" } },
      outputAudio: { voice: "cedar" },
    });
    const endedAt = startedAt + 1_000;
    vi.setSystemTime(endedAt);
    await harness.driver.complete({ runId, endReason: "participant_stopped" });
    await seal(harness, endedAt);
    expect(harness.completed[0]).toMatchObject({
      endedAt,
      outcome: "completed",
      runtimeUsage: { completeness: "incomplete", observations: [] },
    });
    expect(readRunView(repository).lifecycle.stage).toBe("ended");
  });

  it.each(["missing", "invalid", "overflow"] as const)(
    "publishes incomplete %s evidence without changing prior valid totals",
    async (evidence) => {
      const harness = setup();
      await startLive(harness);
      const repository = new InterviewFinalizationRepository(
        createDurableObjectState(harness.durable.ctx).storage,
      );
      const usage = {
        type: "tokens",
        total_tokens: 7,
        input_tokens: 5,
        output_tokens: 2,
        input_token_details: { audio_tokens: 5, text_tokens: 0 },
      };
      const emitItem = (id: string, measured: typeof usage | undefined) => {
        harness.controlled.emit("message", {
          data: JSON.stringify({
            event_id: `${id}-created`,
            type: "input_audio_buffer.committed",
            item_id: id,
          }),
        });
        harness.controlled.emit("message", {
          data: JSON.stringify({
            event_id: `${id}-text`,
            type: "conversation.item.input_audio_transcription.completed",
            item_id: id,
            content_index: 0,
            transcript: `Feedback ${id}`,
            usage: measured,
          }),
        });
      };
      emitItem("valid", usage);
      await vi.waitFor(() => expect(readRunView(repository).usage?.observations).toHaveLength(2));
      const prior = structuredClone(readRunView(repository).usage?.observations);
      const rejected =
        evidence === "missing"
          ? undefined
          : evidence === "invalid"
            ? { ...usage, total_tokens: 99 }
            : {
                ...usage,
                total_tokens: Number.MAX_SAFE_INTEGER,
                input_tokens: Number.MAX_SAFE_INTEGER - 2,
                input_token_details: { audio_tokens: Number.MAX_SAFE_INTEGER - 2, text_tokens: 0 },
              };
      emitItem("rejected", rejected);
      emitItem("rejected", rejected);
      await vi.waitFor(() => expect(readRunView(repository).transcript.items).toHaveLength(2));
      const endedAt = startedAt + 1_000;
      vi.setSystemTime(endedAt);
      await harness.driver.complete({ runId, endReason: "participant_stopped", now: endedAt });
      await seal(harness, endedAt);
      expect(harness.completed[0]?.runtimeUsage).toEqual({
        completeness: "incomplete",
        observations: prior,
      });
      expect(readRunView(repository).usage?.pending).toEqual([]);
    },
  );

  it("publishes no usage entry the combination does not declare, and the usage as incomplete", async () => {
    // Realtime's reports, with an entry Realtime does not declare beside each settled one's.
    const undeclared = {
      componentRole: "speech_to_text",
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
      measure: "input_image",
      unit: "token",
      quantity: 4,
    } as const;
    const harness = setup("test", "none", {
      normalizeRuntimeObservation: (data, input) => {
        const observation = openAiDriverOver().normalizeRuntimeObservation(data, input);
        if (observation === null || !("usage" in observation) || observation.usage === undefined)
          return observation;
        return {
          ...observation,
          usage: observation.usage.map((item) =>
            item.status === "satisfied"
              ? { ...item, measurements: [...item.measurements, undeclared] }
              : item,
          ),
        };
      },
    });
    await startLive(harness);
    harness.controlled.emit("message", {
      data: JSON.stringify({
        event_id: "undeclared-item",
        type: "input_audio_buffer.committed",
        item_id: "undeclared",
      }),
    });
    harness.controlled.emit("message", {
      data: JSON.stringify({
        event_id: "undeclared-text",
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "undeclared",
        content_index: 0,
        transcript: "Feedback",
        usage: {
          type: "tokens",
          total_tokens: 7,
          input_tokens: 5,
          output_tokens: 2,
          input_token_details: { audio_tokens: 5, text_tokens: 0 },
        },
      }),
    });
    await vi.waitFor(async () =>
      expect(await harness.driver.state()).toMatchObject({
        state: { transcript: { turnCount: 1 } },
      }),
    );
    const endedAt = startedAt + 1_000;
    vi.setSystemTime(endedAt);
    await harness.driver.complete({ runId, endReason: "participant_stopped", now: endedAt });
    await seal(harness, endedAt);
    const declared = { ...undeclared, unit: "token" } as const;
    expect(harness.completed[0]?.runtimeUsage).toEqual({
      completeness: "incomplete",
      observations: [
        { ...declared, measure: "input_audio", quantity: 5 },
        { ...declared, measure: "output_text", quantity: 2 },
      ],
    });
  });

  it("accounts one original final transcription receipt before terminal publication", async () => {
    const models = {
      speechToSpeech: "selected-realtime-host",
      speechToText: "selected-transcription-host",
    };
    const harness = setup(
      "test",
      "none",
      {
        createCall: async (input) => {
          expect(input.session.model).toBe("selected-realtime-host");
          return providerSuccess({
            status: 201,
            answerSdp: "v=0\r\nanswer",
            responseContentType: "application/sdp",
            sessionId: "rtc_direct_interruption",
            sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_direct_interruption",
            upstreamRequestId: "req_direct_interruption",
          });
        },
      },
      { prepareSettings: (choices) => prepareRealtimeSettings(choices, models) },
    );
    await startLive(harness);
    const retained = await harness.driver.startConnection(harness.start);
    expect(retained.status).toBe(200);
    const endedAt = startedAt + 1_000;
    vi.setSystemTime(endedAt);
    await harness.driver.complete({ runId, endReason: "participant_stopped", now: endedAt });
    harness.controlled.emit("message", {
      data: JSON.stringify({
        event_id: "usage-final-item",
        type: "input_audio_buffer.committed",
        item_id: "usage-final",
      }),
    });
    const receipt = {
      event_id: "usage-final-text",
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "usage-final",
      content_index: 0,
      transcript: "My final feedback.",
      usage: {
        type: "tokens",
        total_tokens: 7,
        input_tokens: 5,
        output_tokens: 2,
        input_token_details: { audio_tokens: 5, text_tokens: 0 },
      },
    };
    harness.controlled.emit("message", { data: JSON.stringify(receipt) });
    harness.controlled.emit("message", { data: JSON.stringify(receipt) });
    await vi.waitFor(async () =>
      expect(await harness.driver.state()).toMatchObject({
        state: { transcript: { turnCount: 1 } },
      }),
    );
    await seal(harness, endedAt);
    expect(harness.completed[0]?.runtimeUsage?.completeness).toBe("complete");
    expect(harness.completed[0]?.runtimeUsage?.observations).toEqual([
      {
        componentRole: "speech_to_text",
        provider: "openai",
        model: "selected-transcription-host",
        measure: "input_audio",
        unit: "token",
        quantity: 5,
      },
      {
        componentRole: "speech_to_text",
        provider: "openai",
        model: "selected-transcription-host",
        measure: "output_text",
        unit: "token",
        quantity: 2,
      },
    ]);
    const frozenResult = structuredClone(harness.completed[0]);
    const repository = new InterviewFinalizationRepository(
      createDurableObjectState(harness.durable.ctx).storage,
    );
    const frozenRun = readRunView(repository);
    const restored = createInterviewRuntimeController(
      harness.durable.ctx,
      harness.env,
      harness.provider,
      {
        prepareSettings: () => {
          throw new Error("retained_settings_must_not_be_prepared_again");
        },
      },
    );
    await restored.alarm();
    expect(readRunView(repository).usage).toEqual(frozenRun.usage);
    harness.controlled.emit("message", {
      data: JSON.stringify({ ...receipt, event_id: "late-usage-text", transcript: "Late rewrite" }),
    });
    await harness.controller.alarm();
    expect(harness.completed).toEqual([frozenResult]);
    const afterLateReceipt = readRunView(repository);
    expect({ lifecycle: afterLateReceipt.lifecycle, effects: afterLateReceipt.effects }).toEqual({
      lifecycle: frozenRun.lifecycle,
      effects: frozenRun.effects,
    });
    expect(readRunRecordView(repository).frozenTranscript).toContain("My final feedback.");
  });

  describe("Application reconstructed live interruption", () => {
    it.each([
      "silence",
      "participant",
      "assistant",
      "non_transcript",
      "captured",
      "legacy",
    ] as const)(
      "freezes the durable %s prefix, with no resumed interview or post-gap turns",
      async (activity) => {
        const harness = setup();
        await startLive(harness);
        const repository = new InterviewFinalizationRepository(
          createDurableObjectState(harness.durable.ctx).storage,
        );
        const observedAt = startedAt + 1_000;
        vi.setSystemTime(observedAt);
        const events =
          activity === "participant"
            ? [{ event_id: "accepted", type: "input_audio_buffer.speech_started" }]
            : activity === "assistant"
              ? [{ event_id: "accepted", type: "response.created", response: { id: "assistant" } }]
              : activity === "non_transcript"
                ? [{ event_id: "accepted", type: "rate_limits.updated", rate_limits: [] }]
                : activity === "captured" || activity === "legacy"
                  ? [
                      {
                        event_id: "accepted",
                        type: "conversation.item.input_audio_transcription.completed",
                        item_id: "prefix",
                        transcript: "Durable feedback",
                      },
                    ]
                  : [];
        for (const event of events)
          harness.controlled.emit("message", { data: JSON.stringify(event) });
        // Settle admission at this controlled clock before waitFor advances fake time.
        await vi.advanceTimersByTimeAsync(0);
        if (events.length > 0)
          await vi.waitFor(() =>
            expect(readRunView(repository).provider.lastObservationAt).toBe(observedAt),
          );
        vi.setSystemTime(startedAt + 2_000);
        // A repeated provider event ID must not turn a later receipt into a new durable observation.
        for (const event of events)
          harness.controlled.emit("message", { data: JSON.stringify(event) });
        await harness.driver.presence({ runId, now: Date.now(), mediaPresent: true });
        await harness.controller.alarm();
        if (activity === "legacy") {
          const { lastProviderObservationAt: _oldField, ...legacy } = repository.readAggregate();
          repository.persistAggregate(legacy, null);
        }
        vi.setSystemTime(startedAt + 3_000);
        const restored = createInterviewRuntimeController(
          harness.durable.ctx,
          harness.env,
          harness.provider,
        );
        harness.controller = restored;
        harness.driver = controllerDriver(restored);
        expect(await harness.driver.state()).toMatchObject({ state: { phase: "ending" } });
        expect(readRunView(repository).provider.lastObservationAt).toBe(
          events.length > 0 && activity !== "legacy" ? observedAt : undefined,
        );
        harness.controlled.emit("message", {
          data: JSON.stringify({
            event_id: "late",
            type: "conversation.item.input_audio_transcription.completed",
            item_id: "late",
            transcript: "After the gap",
          }),
        });
        await seal(harness, startedAt + 3_000);
        expect(harness.interrupted).toHaveLength(1);
        expect(harness.interrupted[0]).toMatchObject({
          endedAt: startedAt + 3_000,
          liveAt: startedAt,
          transcriptCompleteness: activity === "participant" ? "incomplete" : "complete",
          transcriptSnapshot: {
            turnCount: activity === "captured" || activity === "legacy" ? 1 : 0,
          },
        });
        expect(harness.transcripts.at(-1)?.snapshot.transcript.turns).toEqual(
          activity === "captured" || activity === "legacy"
            ? [{ role: "participant", text: "Durable feedback" }]
            : [],
        );
        expect(harness.provider.createCall).toHaveBeenCalledOnce();
        expect(harness.provider.hangUp).toHaveBeenCalled();
        const frozen = readRunView(repository);
        const again = createInterviewRuntimeController(
          harness.durable.ctx,
          harness.env,
          harness.provider,
        );
        await again.alarm();
        expect(readRunView(repository).persistedState).toEqual(frozen.persistedState);
        expect(harness.interrupted).toHaveLength(1);
      },
    );
  });

  it.each(["participant_stopped", "runtime_failed"] as const)(
    "reconstruction preserves the already accepted %s winner",
    async (endReason) => {
      const harness = setup();
      await startLive(harness);
      const endedAt = startedAt + 1_000;
      vi.setSystemTime(endedAt);
      await harness.driver.complete({ runId, endReason, now: endedAt });
      vi.setSystemTime(startedAt + 3_000);
      harness.controller = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
      );
      harness.driver = controllerDriver(harness.controller);
      await seal(harness, startedAt + 3_000);
      if (endReason === "runtime_failed") expect(harness.interrupted[0]).toMatchObject({ endedAt });
      else expect(harness.completed[0]).toMatchObject({ endedAt, reason: endReason });
    },
  );

  describe("Application directly observed live interruption", () => {
    it("publishes the queued provider prefix at accepted Ending without backdating to socket-close time", async () => {
      const harness = setup();
      await startLive(harness);
      const closedAt = startedAt + 1_000;
      const endedAt = startedAt + 3_000;
      vi.setSystemTime(closedAt - 10);
      for (const event of [
        { event_id: "prefix-item", type: "input_audio_buffer.committed", item_id: "prefix" },
        {
          event_id: "prefix-text",
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "prefix",
          transcript: "Captured before the close.",
        },
      ])
        harness.controlled.emit("message", { data: JSON.stringify(event) });
      vi.setSystemTime(closedAt);
      harness.controlled.emit("close", { code: 1006 });
      harness.controlled.emit("message", {
        data: JSON.stringify({
          event_id: "after-close",
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "prefix",
          transcript: "Must not replace the captured text.",
        }),
      });
      vi.setSystemTime(endedAt);
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(async () => {
        expect(await harness.driver.state()).toMatchObject({
          state: { phase: "ending", transcript: { turnCount: 1 } },
        });
      });
      await seal(harness, endedAt);
      const snapshot = await createRuntimeTranscriptSnapshot(1, {
        turns: [{ role: "participant", text: "Captured before the close." }],
      });
      expect(harness.transcripts.at(-1)?.snapshot).toEqual(snapshot);
      expect(harness.interrupted).toEqual([
        {
          runId,
          outcome: "interrupted",
          liveAt: startedAt,
          endedAt,
          transcriptSnapshot: {
            revision: snapshot.revision,
            digest: snapshot.digest,
            turnCount: 1,
          },
          transcriptCompleteness: "complete",
          transcriptIncompleteReasons: [],
          runtimeUsage: { completeness: "incomplete", observations: [] },
        },
      ]);
      expect(harness.legacy).toEqual([]);
      const restored = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
      );
      expect(await controllerDriver(restored).state()).toMatchObject({ state: { phase: "ended" } });
      await restored.alarm();
      expect(harness.interrupted).toHaveLength(1);
      expect(harness.provider.createCall).toHaveBeenCalledOnce();
    });

    it.each(["session_closed_observed", "provider_message_failure", "runtime_failure"] as const)(
      "publishes one interruption for %s with an empty certified Transcript",
      async (cause) => {
        let failureObservedAt = startedAt + 1_000;
        const harness = setup(
          "test",
          "none",
          cause === "provider_message_failure"
            ? {
                normalizeEvent: () => {
                  failureObservedAt = Date.now();
                  throw new Error("injected_provider_message_failure");
                },
              }
            : {},
        );
        await startLive(harness);
        const endedAt = startedAt + 1_000;
        vi.setSystemTime(endedAt);
        if (cause === "runtime_failure") {
          expect(
            await harness.driver.complete({ runId, endReason: "runtime_failed", now: endedAt }),
          ).toMatchObject({ status: 202 });
        } else {
          harness.controlled.emit("message", {
            data: JSON.stringify({
              event_id: "direct-failure",
              type: cause === "session_closed_observed" ? "session.closed" : "rate_limits.updated",
            }),
          });
          await vi.advanceTimersByTimeAsync(0);
          await vi.waitFor(async () => {
            expect(await harness.driver.state()).toMatchObject({ state: { phase: "ending" } });
          });
        }
        await seal(harness, endedAt);
        const snapshot = await createRuntimeTranscriptSnapshot(0, { turns: [] });
        expect(harness.interrupted).toEqual([
          {
            runId,
            outcome: "interrupted",
            liveAt: startedAt,
            endedAt: cause === "provider_message_failure" ? failureObservedAt : endedAt,
            transcriptSnapshot: { revision: 0, digest: snapshot.digest, turnCount: 0 },
            transcriptCompleteness: "complete",
            transcriptIncompleteReasons: [],
            runtimeUsage: {
              completeness: cause === "runtime_failure" ? "complete" : "incomplete",
              observations: [],
            },
          },
        ]);
        expect(harness.legacy).toEqual([]);
      },
    );

    it.each(["pending", "known_failure"] as const)(
      "publishes an incomplete Transcript when an eligible input remains %s",
      async (status) => {
        const harness = setup();
        await startLive(harness);
        const endedAt = startedAt + 1_000;
        vi.setSystemTime(endedAt - 10);
        harness.controlled.emit("message", {
          data: JSON.stringify({
            event_id: "incomplete-item",
            type: "input_audio_buffer.committed",
            item_id: "unfinished",
          }),
        });
        if (status === "known_failure") {
          harness.controlled.emit("message", {
            data: JSON.stringify({
              event_id: "incomplete-failure",
              type: "conversation.item.input_audio_transcription.failed",
              item_id: "unfinished",
              error: { code: "transcription_failed", message: "No final text" },
            }),
          });
        }
        vi.setSystemTime(endedAt);
        harness.controlled.emit("close", { code: 1006 });
        await vi.advanceTimersByTimeAsync(0);
        await vi.waitFor(async () => {
          expect(await harness.driver.state()).toMatchObject({ state: { phase: "ending" } });
        });
        expect(harness.interrupted).toEqual([]);
        await seal(harness, endedAt);
        expect(harness.interrupted).toMatchObject([
          {
            runId,
            outcome: "interrupted",
            liveAt: startedAt,
            endedAt,
            transcriptCompleteness: "incomplete",
            transcriptSnapshot: { turnCount: 0 },
          },
        ]);
        expect(harness.transcripts.at(-1)?.snapshot.transcript.turns).toEqual([]);
      },
    );

    it("accepts overdue presence expiry without backdating Ending entry", async () => {
      const harness = setup();
      await startLive(harness);
      vi.setSystemTime(startedAt + 1_000);
      const absence = await harness.driver.presence({
        runId,
        now: Date.now(),
        mediaPresent: false,
      });
      expect(absence).toMatchObject({ state: { presence: { graceUntil: startedAt + 16_000 } } });
      vi.setSystemTime(startedAt + 21_000);
      await harness.controller.alarm();
      await seal(harness, startedAt + 21_000);
      expect(harness.interrupted).toEqual([
        expect.objectContaining({
          outcome: "interrupted",
          liveAt: startedAt,
          endedAt: startedAt + 21_000,
        }),
      ]);
      expect(harness.legacy).toEqual([]);
    });

    it("keeps the application's Run live when presence is renewed before expiry", async () => {
      const harness = setup();
      await startLive(harness);
      vi.setSystemTime(startedAt + 1_000);
      await harness.driver.presence({ runId, now: Date.now(), mediaPresent: false });
      vi.setSystemTime(startedAt + 15_000);
      expect(
        await harness.driver.presence({ runId, now: Date.now(), mediaPresent: true }),
      ).toMatchObject({
        accepted: true,
        state: { phase: "live", presence: { graceUntil: startedAt + 30_000 } },
      });
      vi.setSystemTime(startedAt + 16_001);
      await harness.controller.alarm();
      expect(await harness.driver.state()).toMatchObject({ state: { phase: "live" } });
      expect(harness.interrupted).toEqual([]);
      expect(harness.legacy).toEqual([]);
    });

    it.each(["participant_stopped", "agent_requested_end"] as const)(
      "preserves an earlier %s through late presence expiry and code 1006",
      async (reason) => {
        const harness = setup();
        await startLive(harness);
        vi.setSystemTime(startedAt + 1_000);
        await harness.driver.presence({ runId, now: Date.now(), mediaPresent: false });
        vi.setSystemTime(startedAt + 2_000);
        const endingAt =
          reason === "participant_stopped"
            ? startedAt + 2_000
            : startedAt + 2_000 + playbackMarginMs;
        if (reason === "participant_stopped") {
          await harness.driver.complete({ runId, endReason: reason, now: Date.now() });
        } else {
          harness.controlled.emit("message", {
            data: JSON.stringify({
              event_id: "agent-finished",
              type: "response.done",
              response: {
                id: "closing-response",
                status: "completed",
                output: [
                  {
                    id: "finish-item",
                    type: "function_call",
                    name: "finish_interview",
                    call_id: "finish-call",
                    arguments: "{}",
                  },
                ],
              },
            }),
          });
          harness.controlled.emit("message", {
            data: JSON.stringify({
              event_id: "agent-audio-finished",
              type: "output_audio_buffer.stopped",
              response_id: "closing-response",
            }),
          });
          await vi.advanceTimersByTimeAsync(0);
          // The finishing reply has had time to play before Ending.
          vi.setSystemTime(endingAt);
          await harness.controller.alarm();
        }
        vi.setSystemTime(endingAt + 1_000);
        harness.controlled.emit("close", { code: 1006 });
        await vi.waitFor(async () => {
          expect(await harness.driver.state()).toMatchObject({
            state: { phase: endingOrEnded },
          });
        });
        await seal(harness, endingAt);
        vi.setSystemTime(endingAt + 18_000);
        await harness.controller.alarm();
        expect(harness.interrupted).toEqual([]);
        expect(harness.completed).toMatchObject([{ reason, endedAt: endingAt }]);
        expect(harness.legacy).toEqual([]);
      },
    );

    it.each(["direct", "reconstructed"] as const)(
      "retries the same %s sealed result after a lost response without resending its Transcript",
      async (cause) => {
        const harness = setup("test", "lost_response");
        await startLive(harness);
        const endedAt = startedAt + 1_000;
        vi.setSystemTime(endedAt);
        if (cause === "direct") {
          await harness.driver.complete({ runId, endReason: "runtime_failed", now: endedAt });
        } else {
          harness.controller = createInterviewRuntimeController(
            harness.durable.ctx,
            harness.env,
            harness.provider,
          );
          harness.driver = controllerDriver(harness.controller);
          await harness.driver.state();
        }
        await seal(harness, endedAt);
        expect(harness.interrupted[0]?.endedAt).toBe(endedAt);
        const retryAt = requireValue(
          harness.durable.storage.currentAlarm,
          "expected_publication_retry",
        );
        const restored = createInterviewRuntimeController(
          harness.durable.ctx,
          harness.env,
          harness.provider,
        );
        vi.setSystemTime(retryAt);
        await restored.alarm();
        await vi.waitFor(() => expect(harness.interrupted).toHaveLength(2));
        expect(harness.interrupted[1]).toEqual(harness.interrupted[0]);
        expect(harness.transcripts).toHaveLength(1);
        expect(await controllerDriver(restored).state()).toMatchObject({
          state: { phase: "ended", callback: { pending: false } },
        });
      },
    );

    it("stops retrying a contradictory terminal receipt without replacing the sealed result", async () => {
      const harness = setup("test", "conflict");
      await startLive(harness);
      const endedAt = startedAt + 1_000;
      vi.setSystemTime(endedAt);
      await harness.driver.complete({ runId, endReason: "runtime_failed", now: endedAt });
      await seal(harness, endedAt);
      await harness.controller.alarm();
      expect(harness.interrupted).toHaveLength(1);
      expect(harness.transcripts).toHaveLength(1);
      expect(await harness.driver.state()).toMatchObject({
        state: { phase: "ended", callback: { pending: false, lastError: "callback_http_409" } },
      });
    });

    it("publishes the common interrupted result for Lab sideband loss", async () => {
      const harness = setup("lab");
      await startLive(harness);
      vi.setSystemTime(startedAt + 1_000);
      harness.controlled.emit("close", { code: 1006 });
      await vi.advanceTimersByTimeAsync(0);
      await seal(harness, startedAt + 1_000);
      expect(harness.interrupted).toMatchObject([
        {
          outcome: "interrupted",
          endedAt: startedAt + 1_000,
          transcriptCompleteness: "complete",
          transcriptSnapshot: { turnCount: 0 },
        },
      ]);
      expect(harness.legacy).toEqual([]);
    });
  });
}

export function registerInterviewRuntimeControllerAgentCompletionTests() {
  const startedAt = 1_700_000_000_000;
  const endedAt = startedAt + 1_000;
  const runId = "agent-proof-response";
  type SocketEvent = Readonly<{ data?: string; code?: number }>;
  const resources: Array<{
    durable: ReturnType<typeof createTestDurableObjectContext>;
    close: (code: number) => void;
  }> = [];

  function setup(
    loseFirstReceipt = false,
    durationMs = 60_000,
    agent: ConversationAgent = interviewAgent,
  ) {
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);
    const durable = createTestDurableObjectContext();
    const listeners = {
      message: Array<(event: SocketEvent) => void>(),
      close: Array<(event: SocketEvent) => void>(),
      error: Array<(event: SocketEvent) => void>(),
    };
    const socket = {
      readyState: 1,
      accept: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(
        (type: keyof typeof listeners, listener: (event: SocketEvent) => void) =>
          listeners[type].push(listener),
      ),
    };
    const results: Array<CompletedResult | InterruptedResult> = [];
    const transcripts: RuntimeTranscriptUpdatedCallback[] = [];
    const callback = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path !== "/completion" && path !== "/transcript") return Response.json({ ok: true });
      const body: unknown = await request.json();
      if (path === "/transcript") {
        const transcript = decodeRuntimeTranscriptUpdatedCallback(body);
        transcripts.push(transcript);
        return Response.json({
          version: 2,
          status: "stored",
          requestedMatches: true,
          storedSnapshot: transcript.snapshot,
        });
      }
      const result = parseCompletedResult(body) ?? parseInterruptedResult(body);
      if (result === null) throw new Error("unexpected_nonshared_completion");
      expect(body).toEqual(result);
      results.push(result);
      if (loseFirstReceipt && results.length === 1) throw new Error("receipt_lost_after_commit");
      return Response.json({
        version: 2,
        status: results.length > 1 ? "idempotent" : "completed",
        requestedMatches: true,
        storedSnapshot: result.transcriptSnapshot,
      });
    });
    const provider = {
      createCall: vi.fn(async () =>
        providerSuccess({
          status: 201,
          answerSdp: "v=0",
          responseContentType: "application/sdp",
          sessionId: "rtc_agent",
          sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_agent",
          upstreamRequestId: "req_agent",
        }),
      ),
      connectSideband: vi.fn(async () => providerSuccess(socket)),
      sendFinalizationOperation: vi.fn((_input: ProviderFinalizationOperationInput) =>
        providerSuccess(undefined),
      ),
      sendCommand: vi.fn(() => providerSuccess(undefined)),
      hangUp: vi.fn(async () => providerSuccess({ status: 200, upstreamRequestId: null })),
    };
    const env = {
      OPENAI_API_KEY: "test",
      TEST_CALLBACK_WORKER: applicationCallbacks({ fetch: callback }),
    };
    const assembly = (controlled: RuntimeHostAssembly): RuntimeHostAssembly => ({
      ...controlled,
      resolve: () => admitImplementation(agent),
    });
    let controller = createInterviewRuntimeController(
      durable.ctx,
      env,
      provider,
      undefined,
      {},
      undefined,
      assembly,
    );
    const harness = {
      durable,
      provider,
      alarm: () => controller.alarm(),
      presence: () => controllerDriver(controller).presence({ runId, mediaPresent: true }),
      results,
      transcripts,
      callback,
      async start() {
        expect(
          await controllerDriver(controller).startConnection({
            selection: originalRealtimeSelection,
            runId,
            profile: "realtime-v1",
            connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
            createdAt: startedAt,
            execution: {
              agentInput: createInterviewConversationInput(
                "Hello. How was it? Thank you.",
                undefined,
                durationMs,
              ),
            },
            ...deliveryTo("test", runId),
            diagnosticsContext: { surface: "test" },
          }),
        ).toMatchObject({ status: 200 });
        await vi.waitFor(async () =>
          expect(await controllerDriver(controller).state()).toMatchObject({
            state: { phase: "live" },
          }),
        );
        await controller.fetch(
          new Request("https://controller.test/media-ready", {
            method: "POST",
            body: JSON.stringify({ runId }),
          }),
        );
        // Live is persisted before startup callbacks finish. Agent responses can
        // arrive only after the initial conversation command has been sent.
        await vi.advanceTimersByTimeAsync(0);
        expect(provider.sendCommand).toHaveBeenCalledOnce();
        vi.setSystemTime(endedAt);
      },
      async emit<Event extends object>(event: Event) {
        for (const listener of listeners.message) listener({ data: JSON.stringify(event) });
        await controllerDriver(controller).state();
        await vi.advanceTimersByTimeAsync(0);
      },
      close(code: number) {
        for (const listener of listeners.close) listener({ code });
      },
      state() {
        return controllerDriver(controller).state();
      },
      /** The finishing reply has had time to play: the margin passes and the alarm runs. */
      async played() {
        vi.setSystemTime(Date.now() + playbackMarginMs);
        await controller.alarm();
        await vi.advanceTimersByTimeAsync(0);
      },
      stop() {
        return controllerDriver(controller).complete({
          runId,
          endReason: "participant_stopped",
          now: Date.now(),
        });
      },
      reconstruct() {
        controller = createInterviewRuntimeController(
          durable.ctx,
          env,
          provider,
          undefined,
          {},
          undefined,
          assembly,
        );
      },
      async seal() {
        const finalizationAt = Date.now();
        vi.setSystemTime(finalizationAt + 10_000);
        await durable.flushWaitUntil();
        for (const offset of [9_000, 20_000, 21_000]) {
          vi.setSystemTime(finalizationAt + offset);
          await controller.alarm();
          await durable.flushWaitUntil();
        }
        await vi.waitFor(() => expect(results.length).toBeGreaterThan(0));
      },
      async retry() {
        vi.setSystemTime(endedAt + 40_000);
        await controller.alarm();
        await durable.flushWaitUntil();
      },
    };
    resources.push(harness);
    return harness;
  }

  afterEach(async () => {
    for (const harness of resources.splice(0)) {
      harness.close(1000);
      await harness.durable.flushWaitUntil();
      harness.durable.close();
    }
    vi.useRealTimers();
  });

  const finishItem = {
    id: "finish",
    type: "function_call",
    name: "finish_interview",
    call_id: "finish-call",
    arguments: "{}",
  };
  function finish(harness: ReturnType<typeof setup>) {
    return harness.emit({
      ...finishItem,
      event_id: "finish-accepted",
      type: "response.function_call_arguments.done",
      response_id: "winning",
      item_id: "finish",
    });
  }
  function terminal(
    harness: ReturnType<typeof setup>,
    items: string[] | null,
    includeFinish = true,
  ) {
    if (items === null)
      return harness.emit({
        event_id: "winning-terminal",
        type: "response.done",
        response: { id: "winning", status: "completed" },
      });
    return harness.emit({
      event_id: "winning-terminal",
      type: "response.done",
      response: {
        id: "winning",
        status: "completed",
        output: [
          ...(includeFinish ? [finishItem] : []),
          ...items.map((id) => ({
            id,
            type: "message",
            role: "assistant",
            content: [{ type: "audio" }],
          })),
        ],
      },
    });
  }
  function text(harness: ReturnType<typeof setup>, id: string) {
    return harness.emit({
      event_id: `text-${id}`,
      type: "response.output_audio_transcript.done",
      response_id: "winning",
      item_id: id,
      transcript: `Closing ${id}`,
    });
  }
  function stopped(harness: ReturnType<typeof setup>) {
    return harness.emit({ type: "output_audio_buffer.stopped", response_id: "winning" });
  }

  describe("Agent completion through provider and public controller ingress", () => {
    it("requires Original's bound execution report even when durable completion proof is already present", async () => {
      let release = false;
      const agent: ConversationAgent = {
        ...interviewAgent,
        bind(issue, state) {
          const bound = bindOriginalRealtime(issue, state);
          const reporting = bound.reporting;
          if (reporting.kind !== "retained_output") return bound;
          return {
            ...bound,
            reporting: {
              kind: "retained_output",
              observe: (proof) => (release ? reporting.observe(proof) : { kind: "pending" }),
            },
          };
        },
      };
      const h = setup(false, 60_000, agent);
      await h.start();
      const original = readRunView(h.durable).visit;
      await stopped(h);
      await terminal(h, []);
      const retained = readRunView(h.durable);
      expect(retained.lifecycle.stage).toBe("live");
      expect(retained.visit?.state).toBe("finishing");
      expect(retained.agentCompletion).toMatchObject({
        responseSettlement: "completed",
        outputAudioSettlement: "stopped",
        executionIdentity: { visitId: original?.visitId, operationId: original?.operationId },
      });
      release = true;
      await stopped(h);
      await h.played();
      expect(readRunView(h.durable).lifecycle.stage).not.toBe("live");
      expect(readRunView(h.durable).visit?.state).toBe("complete");
      expect(readRunView(h.durable).agentCompletion?.executionIdentity).toEqual(
        retained.agentCompletion?.executionIdentity,
      );
      expect(h.provider.sendCommand).toHaveBeenCalledOnce();
    });
    it.each(["sideband", "abnormal_sideband", "abnormal_sideband_before_ack", "native"] as const)(
      "preserves Original completion when checkpoint cleanup closes %s",
      async (closure) => {
        const h = setup();
        let acknowledge = () => {};
        if (closure === "abnormal_sideband_before_ack")
          h.provider.hangUp.mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                acknowledge = () =>
                  resolve(providerSuccess({ status: 200, upstreamRequestId: null }));
              }),
          );
        await h.start();
        await finish(h);
        vi.setSystemTime(endedAt + 6_000);
        const cleanup = h.alarm();
        await vi.waitFor(() => expect(h.provider.hangUp).toHaveBeenCalledOnce());
        if (closure !== "abnormal_sideband_before_ack") await cleanup;
        if (closure === "sideband") h.close(1000);
        else if (closure === "native") await h.emit({ type: "session.closed" });
        else h.close(1006);
        await vi.waitFor(() => expect(readRunView(h.durable).lifecycle.stage).not.toBe("live"));
        const afterClose = readRunView(h.durable);
        acknowledge();
        await cleanup;
        h.close(1000);
        await h.seal();
        expect(afterClose.visit?.state).toBe("complete");
        if (afterClose.lifecycle.stage === "live" || afterClose.lifecycle.stage === "ended")
          throw new Error("original_ending_not_admitted");
        expect(afterClose.lifecycle.endingStartedAt).toBeGreaterThanOrEqual(endedAt + 6_000);
        expect(afterClose.lifecycle.finalizationCutoffAt).toBe(
          afterClose.lifecycle.endingStartedAt + 10_000,
        );
        expect(afterClose.lifecycle.warnings).toEqual(["agent_output_not_fully_delivered"]);
        expect(h.provider.hangUp).toHaveBeenCalledOnce();
        expect(h.results[0]).toMatchObject({ outcome: "completed", reason: "agent_requested_end" });
      },
    );
    it.each([
      "early_sideband",
      "early_native",
      "overdue_native",
      "overdue_sideband",
      "error_close",
      "failed_hangup",
      "reconstructed_close",
    ] as const)(
      "keeps Original %s operational failure interrupted despite a reserved finish",
      async (failure) => {
        const h = setup();
        await h.start();
        await finish(h);
        if (failure === "failed_hangup")
          h.provider.hangUp.mockImplementationOnce(async () =>
            providerFailure({ stage: "hangup", code: "session_release_failed", retryable: false }),
          );
        if (
          failure === "error_close" ||
          failure === "failed_hangup" ||
          failure === "reconstructed_close"
        ) {
          vi.setSystemTime(endedAt + 6_000);
          await h.alarm();
          expect(h.provider.hangUp).toHaveBeenCalledOnce();
        }
        if (failure === "overdue_native" || failure === "overdue_sideband")
          vi.setSystemTime(endedAt + 6_500);
        if (failure === "reconstructed_close") {
          h.reconstruct();
          await h.alarm();
        } else if (failure === "early_native" || failure === "overdue_native") {
          if (failure === "early_native") vi.setSystemTime(endedAt + 2_000);
          await h.emit({ type: "session.closed" });
        } else h.close(failure === "error_close" ? 1011 : 1000);
        await vi.waitFor(() => expect(readRunView(h.durable).visit?.state).toBe("interrupted"));
        expect(readRunView(h.durable).lifecycle).toMatchObject({
          endReason: "agent_requested_end",
        });
        h.close(1000);
        await h.seal();
        expect(h.results[0]).toMatchObject({ outcome: "interrupted" });
      },
    );

    it.each(["cancelled", "completed", "participant_stopped"] as const)(
      "keeps Original delivery evidence honest for %s at the cleanup checkpoint",
      async (settlement) => {
        const h = setup();
        await h.start();
        await finish(h);
        vi.setSystemTime(endedAt + 6_000);
        await h.alarm();
        expect(h.provider.hangUp).toHaveBeenCalledOnce();
        if (settlement === "participant_stopped") {
          await h.stop();
        } else {
          await h.emit({
            type: "response.done",
            response: { id: "winning", status: settlement, output: [] },
          });
          await stopped(h);
        }
        const accepted = readRunView(h.durable);
        expect(accepted.visit?.state).toBe("complete");
        if (accepted.lifecycle.stage === "live") throw new Error("original_ending_not_admitted");
        expect(accepted.lifecycle.warnings).toEqual(
          settlement === "cancelled" ? ["agent_output_not_fully_delivered"] : [],
        );
        h.close(1000);
        await h.seal();
        expect(h.results[0]).toMatchObject({ outcome: "completed", reason: "agent_requested_end" });
      },
    );

    it("retains Original finishing across interview expiry without renewing output or cleanup permission", async () => {
      const h = setup(false, 10_000);
      await h.start();
      vi.setSystemTime(startedAt + 9_000);
      await finish(h);
      const closure = readRunView(h.durable).finalInput;
      expect(closure?.admissionCutoffAt).toBe(startedAt + 9_000);
      expect(readRunView(h.durable).visit?.state).toBe("finishing");
      vi.setSystemTime(startedAt + 10_000);
      await h.alarm();
      await h.presence();
      expect(readRunView(h.durable).lifecycle.stage).toBe("live");
      expect(readRunView(h.durable).nodeExecution?.closingCutoffAt).toBe(startedAt + 19_000);
      let releaseHangup = () => {};
      h.provider.hangUp.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseHangup = () =>
              resolve(providerSuccess({ status: 200, upstreamRequestId: null }));
          }),
      );
      vi.setSystemTime(startedAt + 15_000);
      const cleanup = h.alarm();
      await vi.waitFor(() => expect(h.provider.hangUp).toHaveBeenCalledOnce());
      expect(h.provider.hangUp).toHaveBeenCalledOnce();
      expect(readRunView(h.durable).lifecycle.stage).toBe("live");
      expect(readRunView(h.durable).finalInput?.effectId).toBe(closure?.effectId);
      vi.setSystemTime(startedAt + 19_000);
      const ending = h.alarm();
      await vi.waitFor(() => expect(readRunView(h.durable).lifecycle.stage).toBe("draining"));
      const accepted = readRunView(h.durable).lifecycle;
      const observedAt = Date.now();
      releaseHangup();
      await Promise.all([cleanup, ending]);
      if (accepted.stage !== "draining") throw new Error("original_ending_not_admitted");
      expect(accepted.endingStartedAt).toBeGreaterThanOrEqual(startedAt + 19_000);
      expect(accepted.endingStartedAt).toBeLessThanOrEqual(observedAt);
      expect(accepted.finalizationCutoffAt).toBe(accepted.endingStartedAt + 10_000);
      expect(accepted.warnings).toEqual(["agent_output_not_fully_delivered"]);
      expect(h.provider.sendCommand).toHaveBeenCalledOnce();
      h.close(1000);
      vi.setSystemTime(accepted.finalizationCutoffAt);
      await h.alarm();
    });

    it.each(
      ["text-event", "terminal-audio", "terminal-text"].flatMap((source) =>
        ["before", "after"].map((order) => ({ source, order })),
      ),
    )("captures $source final text with finish $order the evidence", async ({ source, order }) => {
      const harness = setup();
      await harness.start();
      if (order === "before") await finish(harness);
      await harness.emit({
        event_id: "winning-terminal",
        type: "response.done",
        response: {
          id: "winning",
          status: "completed",
          output: [
            ...(order === "before" ? [finishItem] : []),
            {
              id: "closing-message",
              type: "message",
              role: "assistant",
              content: [
                source === "terminal-audio"
                  ? { type: "output_audio", transcript: "Closing final text" }
                  : source === "terminal-text"
                    ? { type: "output_text", text: "Closing final text" }
                    : { type: "output_text" },
              ],
            },
          ],
        },
      });
      if (source === "text-event")
        await harness.emit({
          event_id: "closing-text",
          type: "response.output_text.done",
          response_id: "winning",
          item_id: "closing-message",
          output_index: 1,
          content_index: 0,
          text: "Closing final text",
        });
      if (order === "after") {
        vi.setSystemTime(endedAt + 500);
        await finish(harness);
      }
      await stopped(harness);
      await harness.played();
      harness.close(1006);
      await harness.seal();
      expect(harness.results[0]).toMatchObject({
        outcome: "completed",
        reason: "agent_requested_end",
        endedAt: (order === "before" ? endedAt : endedAt + 500) + playbackMarginMs,
        transcriptCompleteness: "complete",
        transcriptSnapshot: { turnCount: 1 },
      });
      expect(harness.transcripts.at(-1)).toMatchObject({
        snapshot: { transcript: { turns: [{ text: "Closing final text" }] } },
      });
    });

    it.each(["cancelled", "failed", "incomplete"])(
      "does not certify partial %s content from terminal status alone",
      async (status) => {
        const harness = setup();
        await harness.start();
        await finish(harness);
        await harness.emit({
          event_id: "winning-terminal",
          type: "response.done",
          response: {
            id: "winning",
            status,
            output: [
              finishItem,
              {
                id: "closing-message",
                type: "message",
                role: "assistant",
                content: [{ type: "output_audio", transcript: "Partial closing text" }],
              },
            ],
          },
        });
        expect(readRunView(harness.durable).visit?.state).toBe("interrupted");
        expect(readRunView(harness.durable).lifecycle).toMatchObject({
          endReason: "agent_requested_end",
        });
        await stopped(harness);
        harness.close(1006);
        await harness.seal();
        expect(harness.results[0]).toMatchObject({
          outcome: "interrupted",
          endedAt,
          transcriptCompleteness: "incomplete",
          transcriptSnapshot: { turnCount: 0 },
        });
      },
    );

    it.each(["before", "after"])(
      "retains every winning-response text when finish arrives %s final evidence",
      async (order) => {
        const harness = setup();
        await harness.start();
        if (order === "before") await finish(harness);
        await terminal(harness, ["first", "second"], order === "before");
        vi.setSystemTime(endedAt + 500);
        await text(harness, "first");
        await text(harness, "second");
        if (order === "after") {
          vi.setSystemTime(endedAt + 1_000);
          await finish(harness);
        }
        await stopped(harness);
        await harness.played();
        expect(await harness.stop()).toMatchObject({ accepted: false, conflict: true });
        harness.close(1006);
        await harness.seal();
        expect(harness.results).toHaveLength(1);
        expect(harness.results).toMatchObject([
          {
            outcome: "completed",
            reason: "agent_requested_end",
            endedAt: (order === "before" ? endedAt + 500 : endedAt + 1_000) + playbackMarginMs,
            transcriptCompleteness: "complete",
            transcriptSnapshot: { turnCount: 2 },
          },
        ]);
        expect(harness.transcripts.at(-1)).toMatchObject({
          snapshot: {
            transcript: { turns: [{ text: "Closing first" }, { text: "Closing second" }] },
          },
        });
      },
    );

    it.each([true, false])(
      "requires conclusive inventory for a response with no text (inventory=%s)",
      async (inventory) => {
        const harness = setup();
        await harness.start();
        await finish(harness);
        await terminal(harness, inventory ? [] : null);
        await stopped(harness);
        await harness.played();
        harness.close(1006);
        await harness.seal();
        expect(harness.results[0]).toMatchObject({
          reason: "agent_requested_end",
          endedAt: endedAt + playbackMarginMs,
          transcriptCompleteness: inventory ? "complete" : "incomplete",
        });
      },
    );

    it("seals missing final text incomplete after reconstruction and retries an identical shared result", async () => {
      const harness = setup(true);
      await harness.start();
      await finish(harness);
      await terminal(harness, ["first", "second"]);
      await text(harness, "first");
      await stopped(harness);
      await harness.played();
      harness.close(1006);
      vi.setSystemTime(endedAt + playbackMarginMs + 10_000);
      await harness.durable.flushWaitUntil();
      harness.reconstruct();
      await harness.seal();
      expect(harness.results[0]).toMatchObject({
        reason: "agent_requested_end",
        endedAt: endedAt + playbackMarginMs,
        transcriptCompleteness: "incomplete",
        transcriptSnapshot: { turnCount: 1 },
      });
      harness.reconstruct();
      await harness.retry();
      await vi.waitFor(() => expect(harness.results.length).toBeGreaterThan(1));
      expect(
        harness.results.every(
          (result) => JSON.stringify(result) === JSON.stringify(harness.results[0]),
        ),
      ).toBe(true);
    });
  });
}

export function registerConversationConnectionTests() {
  const probeSelection = {
    conversation: { id: "connection-probe", version: 1 },
    execution: { id: "probe", version: 1 },
  };
  const probeInput = z.strictObject({
    question: z.string().refine((text) => text.trim().length > 0),
  });
  const probeAgent: ConversationAgent = {
    id: "connection-probe/1",
    conversation: {
      ...interviewAgent.conversation,
      input: (input) =>
        interviewAgent.conversation.input(
          createInterviewConversationInput(probeInput.parse(input).question),
        ),
    },
    // The probe input selects Original's Interviewing node input.
    prepare: interviewAgent.prepare,
    interpretTool: () => null,
  };
  const probeImplementation = admitImplementation(probeAgent);
  const probeAssembly = (controlled: RuntimeHostAssembly): RuntimeHostAssembly => ({
    ...controlled,
    resolve(selection) {
      this.validateSelection(selection);
      return probeImplementation;
    },
    validateSelection(selection) {
      if (JSON.stringify(selection) !== JSON.stringify(probeSelection))
        throw new Error("conversation_selection_unavailable");
    },
    validateState(selection, state) {
      this.validateSelection(selection);
      if (!z.enum(["interviewing", "complete"]).safeParse(state).success)
        throw new Error("conversation_visit_unavailable");
    },
    validateInput(selection, input) {
      this.validateSelection(selection);
      if (!probeInput.safeParse(input).success) throw new Error("invalid_probe_agent");
    },
  });
  const contexts: Array<ReturnType<typeof createTestDurableObjectContext>> = [];
  afterEach(() => contexts.splice(0).forEach((context) => context.close()));
  const post = <Body>(path: string, body: Body) =>
    new Request(`https://runtime.local${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  describe("Conversation connection ownership", () => {
    it("validates native offer and stored exchange progress before returning their owned fields", () => {
      expect(decodeConversationOffer({ sdp: "v=0\r\n" })).toEqual({ sdp: "v=0\r\n" });
      for (const input of [{}, { sdp: 42 }, { sdp: { line: "v=0" } }, { sdp: "v=0", extra: true }])
        expect(() => decodeConversationOffer(input)).toThrow("invalid_sdp_offer");
      const inherited = {};
      Object.setPrototypeOf(inherited, { sdp: "v=0" });
      expect(() => decodeConversationOffer(inherited)).toThrow("invalid_sdp_offer");
      expect(
        decodeConnectionCheckpoint({
          exchangeId: "first",
          fingerprint: "opaque",
          status: "complete",
          reply: { ready: true },
        }),
      ).toEqual({
        exchangeId: "first",
        fingerprint: "opaque",
        status: "complete",
        reply: { ready: true },
      });
      for (const input of [
        {},
        { exchangeId: 42, fingerprint: "opaque", status: "complete" },
        { exchangeId: "first", fingerprint: "opaque", status: "invalid" },
        { exchangeId: "first", fingerprint: "opaque", status: "complete", extra: true },
      ])
        expect(() => decodeConnectionCheckpoint(input)).toThrow();
      const inheritedCheckpoint = { fingerprint: "opaque", status: "complete" };
      Object.setPrototypeOf(inheritedCheckpoint, { exchangeId: "first" });
      expect(() => decodeConnectionCheckpoint(inheritedCheckpoint)).toThrow();
    });
    it("validates native input without creating a run or requiring an injected implementation's real key", async () => {
      const implementation: ConversationConnectionImplementation = {
        profile: "probe",
        available: true,
        validateExecution: () => {},
        validate: async (input) => ({ fingerprint: JSON.stringify(input ?? null) }),
        exchange: async () => ({ reply: { ready: true } }),
      };
      const response = await runtimeWorker.fetch(
        post("/_runtime/connections/validate", {
          profile: "probe",
          connection: { exchangeId: "first" },
        }),
        {},
        undefined,
        implementation,
      );
      expect(await response.json()).toEqual({ profile: "probe", fingerprint: "null" });
      const rejected = await runtimeWorker.fetch(
        post("/_runtime/connections/validate", {
          profile: "realtime-v1",
          connection: { exchangeId: "first", input: { sdp: "bad" } },
        }),
        { OPENAI_API_KEY: "test" },
      );
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({ error: "invalid_sdp_offer" });
    });
    // An application checks its connection here before admitting a Start: a profile whose execution
    // lacks a credential is unavailable, as its Start is, and the refusal names it.
    it.each([
      ["realtime-v1", { sdp: "v=0\r\n" }, { SONIOX_API_KEY: "soniox-test" }, "OPENAI_API_KEY"],
      [
        "cascade-media-v1",
        {},
        { OPENAI_API_KEY: "sk-test", SONIOX_API_KEY: "soniox-test" },
        "CEREBRAS_API_KEY",
      ],
    ])(
      "refuses a connection check of profile %s while Runtime lacks its execution's credential",
      async (profile, input, env, missing) => {
        const connection = { exchangeId: "first", input };
        const refused = await runtimeWorker.fetch(
          post("/_runtime/connections/validate", { profile, connection }),
          env,
        );
        expect({ status: refused.status, body: await refused.json() }).toEqual({
          status: 503,
          body: { error: `missing_credentials:${missing}` },
        });
        const accepted = await runtimeWorker.fetch(
          post("/_runtime/connections/validate", { profile, connection }),
          { OPENAI_API_KEY: "sk-test", SONIOX_API_KEY: "soniox-test", CEREBRAS_API_KEY: "c-test" },
        );
        expect(accepted.status).toBe(200);
        expect(await accepted.json()).toMatchObject({ profile });
      },
    );
    it("rejects a Start whose connection profile the selected entry does not declare before provider work", async () => {
      const durable = createTestDurableObjectContext();
      contexts.push(durable);
      const createCall = vi.fn<ScriptedRealtimeDriver["createCall"]>();
      const controller = createInterviewRuntimeController(
        durable.ctx,
        { OPENAI_API_KEY: "test" },
        { createCall },
      );
      const response = await controller.fetch(
        post("/connection", {
          ...originalStart(60_000),
          runId: "run_undeclared_profile",
          profile: "cascade-media-v1",
          connection: { exchangeId: "first", input: { sdp: "v=0\r\n" } },
          createdAt: Date.now(),
          startupExpiresAt: Date.now() + 30_000,
        }),
      );
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 409,
        body: {
          runId: "run_undeclared_profile",
          exchangeId: "first",
          acceptance: "not_accepted",
          error: "connection_profile_unavailable",
        },
      });
      expect(await controllerDriver(controller).state()).toMatchObject({ state: null });
      expect(createCall).not.toHaveBeenCalled();
    });
    it.each([
      [
        "settings that are not Realtime's",
        originalRealtimeSelection,
        { model: "gpt-realtime-mini" },
      ],
      ["any settings on Cascade, which takes none", originalCascadeSelection, { voice: "marin" }],
    ])("refuses %s before setup or provider work", async (_case, selection, executionSettings) => {
      const durable = createTestDurableObjectContext();
      contexts.push(durable);
      const createCall = vi.fn<ScriptedRealtimeDriver["createCall"]>();
      const controller = createInterviewRuntimeController(
        durable.ctx,
        { OPENAI_API_KEY: "test" },
        { createCall },
      );
      const response = await controller.fetch(
        post("/connection", {
          ...originalStart(60_000),
          selection,
          executionSettings,
          runId: "run_invalid_settings",
          profile: "realtime-v1",
          connection: { exchangeId: "first", input: { sdp: "v=0\r\n" } },
          createdAt: Date.now(),
          startupExpiresAt: Date.now() + 30_000,
        }),
      );
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 400,
        body: {
          runId: "run_invalid_settings",
          exchangeId: "first",
          acceptance: "not_accepted",
          error: "invalid_execution_settings",
        },
      });
      expect(await controllerDriver(controller).state()).toMatchObject({ state: null });
      expect(createCall).not.toHaveBeenCalled();
    });
    // Runtime asks the selected combination whether its providers have their credentials. Cascade
    // with an OpenAI key and no Soniox key used to pass startup and fail once started.
    const cascadeDefaultKeys = { SONIOX_API_KEY: "soniox-test", CEREBRAS_API_KEY: "cerebras-test" };
    it.each([
      [
        "Cascade with OpenAI and Cerebras keys and no Soniox key",
        originalCascadeSelection,
        "cascade-media-v1",
        {},
        { OPENAI_API_KEY: "sk-test", CEREBRAS_API_KEY: "cerebras-test" },
        "missing_credentials:SONIOX_API_KEY",
        undefined,
      ],
      [
        "Realtime without an OpenAI key",
        originalRealtimeSelection,
        "realtime-v1",
        { sdp: "v=0\r\n" },
        { SONIOX_API_KEY: "soniox-test" },
        "missing_credentials:OPENAI_API_KEY",
        undefined,
      ],
      [
        "Cascade choosing Gradium speech input without a Gradium key",
        originalCascadeSelection,
        "cascade-media-v1",
        {},
        { OPENAI_API_KEY: "sk-test", ...cascadeDefaultKeys },
        "missing_credentials:GRADIUM_API_KEY",
        { speechInput: { provider: "gradium" } },
      ],
      [
        "Cascade choosing Gradium speech output without a Gradium key",
        originalCascadeSelection,
        "cascade-media-v1",
        {},
        { OPENAI_API_KEY: "sk-test", ...cascadeDefaultKeys },
        "missing_credentials:GRADIUM_API_KEY",
        { speechOutput: { provider: "gradium" } },
      ],
      [
        "Cascade on its default Cerebras language model without a Cerebras key",
        originalCascadeSelection,
        "cascade-media-v1",
        {},
        { OPENAI_API_KEY: "sk-test", SONIOX_API_KEY: "soniox-test" },
        "missing_credentials:CEREBRAS_API_KEY",
        undefined,
      ],
      [
        "Cascade choosing the OpenAI language model without an OpenAI key",
        originalCascadeSelection,
        "cascade-media-v1",
        {},
        cascadeDefaultKeys,
        "missing_credentials:OPENAI_API_KEY",
        { languageModel: { provider: "openai" } },
      ],
    ])(
      "refuses a start of %s before setup or provider work, naming the missing credential",
      async (_case, selection, profile, input, env, error, executionSettings) => {
        const durable = createTestDurableObjectContext();
        contexts.push(durable);
        const providerRequest = vi.fn<typeof fetch>(() => {
          throw new Error("unexpected_provider_request");
        });
        vi.stubGlobal("fetch", providerRequest);
        // The registry on the real providers: no test driver, no stand-ins.
        const controller = createInterviewRuntimeController(
          durable.ctx,
          env,
          {},
          undefined,
          {},
          undefined,
          createRuntimeHostAssembly(),
        );
        const response = await controller.fetch(
          post("/connection", {
            ...originalStart(60_000),
            selection,
            // JSON leaves out settings that are undefined: those starts give none.
            executionSettings,
            runId: "run_missing_credentials",
            profile,
            connection: { exchangeId: "first", input },
            createdAt: Date.now(),
            startupExpiresAt: Date.now() + 30_000,
          }),
        );
        expect({ status: response.status, body: await response.json() }).toEqual({
          status: 503,
          body: {
            runId: "run_missing_credentials",
            exchangeId: "first",
            acceptance: "not_accepted",
            error,
          },
        });
        expect(await controllerDriver(controller).state()).toMatchObject({ state: null });
        expect(providerRequest).not.toHaveBeenCalled();
      },
    );
    it("hands a browser attachment to the selected Realtime session, which refuses it without native work", async () => {
      const durable = createTestDurableObjectContext();
      contexts.push(durable);
      const createCall = vi.fn<ScriptedRealtimeDriver["createCall"]>();
      const connectSideband = vi.fn<ScriptedRealtimeDriver["connectSideband"]>();
      const controller = createInterviewRuntimeController(
        durable.ctx,
        { OPENAI_API_KEY: "test" },
        { createCall, connectSideband },
      );
      await controllerDriver(controller).start({
        ...originalStart(60_000),
        runId: "run_attachment",
        startedAt: Date.now(),
      });
      const response = await controller.fetch(
        new Request("https://runtime.local/attachment?runId=run_attachment", {
          headers: { Upgrade: "websocket" },
        }),
      );
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 409,
        body: { error: "browser_attachment_unavailable" },
      });
      expect(createCall).not.toHaveBeenCalled();
      expect(connectSideband).not.toHaveBeenCalled();
    });
    it("retains structured Agent input, optional initial input, and successive exchange replay on one run", async () => {
      const durable = createTestDurableObjectContext();
      contexts.push(durable);
      const received: Array<unknown> = [];
      const implementation: ConversationConnectionImplementation = {
        profile: "probe",
        available: true,
        validateExecution: (execution) => {
          if (
            typeof execution.agentInput !== "object" ||
            execution.agentInput === null ||
            !("question" in execution.agentInput)
          )
            throw new Error("invalid_probe_agent");
        },
        validate: async (input) => ({ fingerprint: JSON.stringify(input ?? null) }),
        exchange: async (input) => {
          received.push(input);
          return { reply: { step: input.connection.exchangeId } };
        },
      };
      const controller = createInterviewRuntimeController(
        durable.ctx,
        {},
        {},
        undefined,
        {},
        implementation,
        probeAssembly,
      );
      const start = {
        selection: probeSelection,
        runId: "run_probe",
        profile: "probe",
        connection: { exchangeId: "first" },
        execution: { agentInput: { question: "What changed?" } },
        createdAt: Date.now(),
        startupExpiresAt: Date.now() + 30000,
      };
      const first = decodeRuntimeConnectionResult(
        await (await controller.fetch(post("/connection", start))).json(),
      );
      expect(first).toEqual({
        runId: "run_probe",
        exchangeId: "first",
        acceptance: "accepted",
        reply: { step: "first" },
      });
      const second = decodeRuntimeConnectionResult(
        await (
          await controller.fetch(
            post("/connection", {
              runId: "run_probe",
              connection: { exchangeId: "second", input: { challenge: 17 } },
            }),
          )
        ).json(),
      );
      expect(second.reply).toEqual({ step: "second" });
      const repeated = decodeRuntimeConnectionResult(
        await (
          await controller.fetch(
            post("/connection", {
              runId: "run_probe",
              connection: { exchangeId: "second", input: { challenge: 17 } },
            }),
          )
        ).json(),
      );
      expect(repeated).toEqual(second);
      expect(received).toHaveLength(2);
      expect(received).toEqual([
        expect.objectContaining({
          initial: true,
          execution: start.execution,
          originalDeadline: start.startupExpiresAt,
        }),
        expect.objectContaining({
          initial: false,
          execution: start.execution,
          originalDeadline: start.startupExpiresAt,
        }),
      ]);
      const conflict = decodeRuntimeConnectionResult(
        await (
          await controller.fetch(
            post("/connection", {
              runId: "run_probe",
              connection: { exchangeId: "second", input: { challenge: 18 } },
            }),
          )
        ).json(),
      );
      expect(conflict).toMatchObject({
        acceptance: "accepted",
        error: "connection_exchange_conflict",
      });
      expect(received).toHaveLength(2);
    });

    it("answers a failed exchange before acceptance as refused only for a startup refusal", async () => {
      const start = {
        selection: probeSelection,
        runId: "unaccepted_probe",
        profile: "probe",
        connection: { exchangeId: "first" },
        execution: { agentInput: { question: "What changed?" } },
        createdAt: Date.now(),
        startupExpiresAt: Date.now() + 30000,
      };
      const exchange = vi.fn(async () => ({ reply: { step: "never" } }));
      const exchangeWith = async (
        validate: ConversationConnectionImplementation["validate"],
        body: typeof start,
      ) => {
        const durable = createTestDurableObjectContext();
        contexts.push(durable);
        const controller = createInterviewRuntimeController(
          durable.ctx,
          {},
          {},
          undefined,
          {},
          { profile: "probe", available: true, validateExecution: () => {}, validate, exchange },
          probeAssembly,
        );
        const response = await controller.fetch(post("/connection", body));
        const answer = { status: response.status, body: await response.json() };
        expect(await controllerDriver(controller).state()).toMatchObject({ state: null });
        return {
          answer,
          startFailures: readStartFailures(durable.ctx),
          settled: durable.flushWaitUntil(),
        };
      };
      // Runtime records why the Start failed although no Run was accepted.
      const startFailure = {
        runId: start.runId,
        operation: "connection",
        exchangeId: "first",
        stage: "runtimeAccepted",
      };

      const refused = await exchangeWith(async () => ({ fingerprint: "probe" }), {
        ...start,
        profile: "other",
      });
      expect(refused.answer).toEqual({
        status: 409,
        body: {
          runId: start.runId,
          exchangeId: "first",
          acceptance: "not_accepted",
          error: "connection_profile_unavailable",
        },
      });
      expect(refused.startFailures).toEqual([
        expect.objectContaining({
          ...startFailure,
          error: "connection_profile_unavailable",
          status: 409,
          failure: "refusal",
          acceptance: "not_accepted",
        }),
      ]);
      await refused.settled;

      const failed = await exchangeWith(async () => {
        throw new Error("probe_validation_defect");
      }, start);
      expect(failed.answer).toEqual({
        status: 500,
        body: {
          runId: start.runId,
          exchangeId: "first",
          acceptance: "unresolved",
          error: "probe_validation_defect",
        },
      });
      expect(failed.startFailures).toEqual([
        expect.objectContaining({
          ...startFailure,
          error: "probe_validation_defect",
          status: 500,
          failure: "defect",
          acceptance: "unresolved",
        }),
      ]);
      await expect(failed.settled).rejects.toThrow("probe_validation_defect");
      expect(exchange).not.toHaveBeenCalled();
    });

    it("keeps malformed Agent input effect-free and never redispatches an uncertain initial exchange after reconstruction", async () => {
      const durable = createTestDurableObjectContext();
      contexts.push(durable);
      let creates = 0;
      const implementation: ConversationConnectionImplementation = {
        profile: "probe",
        available: true,
        validateExecution: (execution) => {
          if (
            execution.agentInput === null ||
            typeof execution.agentInput !== "object" ||
            !("question" in execution.agentInput)
          )
            throw new Error("invalid_probe_agent");
        },
        validate: async (input) => ({ fingerprint: JSON.stringify(input ?? null) }),
        exchange: async () => {
          creates++;
          throw new Error("probe_connection_defect");
        },
      };
      const start = {
        selection: probeSelection,
        runId: "uncertain_probe",
        profile: "probe",
        connection: { exchangeId: "first" },
        execution: { agentInput: { question: "What changed?" } },
        createdAt: Date.now(),
        startupExpiresAt: Date.now() + 30000,
      };
      const create = () =>
        createInterviewRuntimeController(
          durable.ctx,
          {},
          {},
          undefined,
          {},
          implementation,
          probeAssembly,
        );
      const initial = await create().fetch(post("/connection", start));
      expect(await initial.json()).toMatchObject({
        runId: start.runId,
        acceptance: "accepted",
        error: "probe_connection_defect",
      });
      await expect(durable.flushWaitUntil()).rejects.toThrow("probe_connection_defect");
      const reconstructed = create();
      const repeated = await reconstructed.fetch(
        post("/connection", { runId: start.runId, connection: { exchangeId: "first" } }),
      );
      expect(await repeated.json()).toMatchObject({
        acceptance: "accepted",
        error: "runtime_controller_start_in_progress",
      });
      const different = await reconstructed.fetch(
        post("/connection", {
          runId: start.runId,
          connection: { exchangeId: "different", input: { step: 2 } },
        }),
      );
      expect(await different.json()).toMatchObject({
        acceptance: "accepted",
        error: "runtime_controller_start_in_progress",
      });
      expect(creates).toBe(1);
      await durable.flushWaitUntil();
      const invalid = createTestDurableObjectContext();
      contexts.push(invalid);
      const owner = createInterviewRuntimeController(
        invalid.ctx,
        {},
        {},
        undefined,
        {},
        implementation,
        probeAssembly,
      );
      const rejected = await owner.fetch(
        post("/connection", {
          ...start,
          runId: "invalid_agent",
          execution: { agentInput: {} },
        }),
      );
      expect(await rejected.json()).toMatchObject({ error: "invalid_probe_agent" });
      expect(await controllerDriver(owner).state()).toMatchObject({ state: null });
      expect(creates).toBe(1);
      await invalid.flushWaitUntil();
    });
  });
}

export function registerInterviewRuntimeControllerAgentToolsTests() {
  const startedAt = 1_700_000_000_000;
  const runId = "alternate-agent-run";
  const toolNames = ["complete_feedback", "close_feedback"] as const;
  const testSelection = {
    conversation: { id: "alternate-feedback", version: 1 },
    execution: { id: "realtime", version: 1 },
  };
  const testInputSchema = z.strictObject({ allowedTool: z.enum(toolNames) });
  function testAssembly(
    agent: ConversationAgent,
    controlled: RuntimeHostAssembly,
  ): RuntimeHostAssembly {
    const validateSelection: RuntimeHostAssembly["validateSelection"] = (selection) => {
      if (JSON.stringify(selection) !== JSON.stringify(testSelection))
        throw new Error("conversation_selection_unavailable");
    };
    const implementation = admitImplementation(agent, {
      speechToSpeech: "gpt-realtime",
      speechToText: "gpt-4o-transcribe",
    });
    // The alternate Conversation runs on the Original Realtime execution and session.
    return {
      ...controlled,
      resolve: (selection) => {
        validateSelection(selection);
        return implementation;
      },
      createExecution: (input) =>
        controlled.createExecution({
          ...input,
          selection: () => originalRealtimeSelection,
        }),
      createSession: (input) => controlled.createSession(input, () => originalRealtimeSelection),
      declaredUsage: (selection) => {
        validateSelection(selection);
        return controlled.declaredUsage(originalRealtimeSelection);
      },
      connectionSetup: (selection, profile) => {
        validateSelection(selection);
        return controlled.connectionSetup(originalRealtimeSelection, profile);
      },
      missingCredentials: (selection, credentials) => {
        validateSelection(selection);
        return controlled.missingCredentials(originalRealtimeSelection, credentials);
      },
      validateSelection,
      validateState(selection, state) {
        validateSelection(selection);
        if (
          !Object.hasOwn(agent.conversation.states, state) &&
          !agent.conversation.terminalStates.includes(state)
        )
          throw new Error("conversation_visit_unavailable");
      },
      validateInput(selection, input) {
        validateSelection(selection);
        testInputSchema.parse(input);
      },
    };
  }

  // Preserve approved model-facing content; vary machine-readable names and opaque input only.
  const alternateStateContract = {
    id: "interviewing",
    input: testInputSchema,
    event: z.strictObject({
      kind: z.literal("finish_intent"),
      responseId: z.string(),
      toolCallId: z.string(),
    }),
  };
  /** Each tool the selected agent interprets reports a finish intent with its identities. */
  function bindAlternate(
    this: ConversationAgent,
    issue: import("../executionContracts.ts").ReporterFactory,
  ): BoundRuntimeImplementation {
    const reporter = issue(alternateStateContract);
    const selected = this;
    return {
      reporting: { kind: "native" },
      interpretTool(invocation, execution) {
        const intent = selected.interpretTool(invocation, execution);
        if (
          intent === null ||
          invocation.callId === undefined ||
          invocation.responseId === undefined
        )
          return intent;
        const report = reporter.report({
          kind: "finish_intent",
          responseId: invocation.responseId,
          toolCallId: invocation.callId,
        });
        return report === null ? null : { ...intent, report };
      },
    };
  }
  const alternateAgent: ConversationAgent = {
    conversation: {
      input: (input) => testInputSchema.parse(input),
      initial: "interviewing",
      states: { interviewing: alternateStateContract },
      selectInput: { interviewing: (input) => input },
      terminalStates: ["complete", "interrupted"],
      terminalRoles: { completion: "complete", interruption: "interrupted" },
      evaluate: { interviewing: () => "complete" },
    },
    bind: bindAlternate,
    id: "alternate-feedback/v1",
    prepare({ runId: selectedRunId }) {
      const content = interviewAgent.prepare({
        runId: selectedRunId,
        state: "interviewing",
        nodeInput: interviewAgent.conversation.input(
          createInterviewConversationInput(INTERVIEW_AGENT_INSTRUCTIONS),
        ).interviewing,
      });
      const tool = content.tools[0];
      if (tool === undefined) throw new Error("invalid_agent_fixture");
      return { ...content, tools: toolNames.map((name) => ({ ...tool, name })) };
    },
    interpretTool(invocation, execution) {
      if (execution === null) return null;
      const input = execution.agentInput;
      if (input === null || typeof input !== "object" || !("allowedTool" in input)) return null;
      const handlers = {
        complete_feedback: () => input.allowedTool === "complete_feedback",
        close_feedback: () => input.allowedTool === "close_feedback",
      };
      if (invocation.toolName !== "complete_feedback" && invocation.toolName !== "close_feedback")
        return null;
      return handlers[invocation.toolName]() ? { kind: "conversation_event" } : null;
    },
  };

  function controlledSocket() {
    const listeners = {
      message: Array<(event: ProviderSocketEvent) => void>(),
      close: Array<(event: ProviderSocketEvent) => void>(),
      error: Array<(event: ProviderSocketEvent) => void>(),
    };
    return {
      socket: {
        readyState: 1,
        accept() {},
        send() {},
        close() {},
        addEventListener(
          type: keyof typeof listeners,
          listener: (event: ProviderSocketEvent) => void,
        ) {
          listeners[type].push(listener);
        },
      },
      emit(event: string) {
        for (const listener of listeners.message) listener({ data: event });
      },
      close() {
        for (const listener of listeners.close) listener({ code: 1000 });
      },
    };
  }

  const resources: Array<{
    durable: ReturnType<typeof createTestDurableObjectContext>;
    sockets: Array<ReturnType<typeof controlledSocket>>;
  }> = [];
  function setup(
    allowedTool: (typeof toolNames)[number],
    agent: ConversationAgent = alternateAgent,
    issuedSinks?: ProviderSessionApplicationSink[],
  ) {
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);
    const durable = createTestDurableObjectContext();
    const sockets = [controlledSocket()];
    const nodes: import("../implementationContracts.ts").NodeDispatchInput[] = [];
    const sessions: ReturnType<RuntimeHostAssembly["createSession"]>[] = [];
    const env = {
      OPENAI_API_KEY: "test",
      TEST_CALLBACK_WORKER: applicationCallbacks({
        fetch: async () => Response.json({ ok: true }),
      }),
    };
    const provider = {
      createCall: vi.fn(async (_input: ProviderCreateCallInput) =>
        providerSuccess({
          status: 201,
          answerSdp: "v=0\r\nanswer",
          responseContentType: "application/sdp",
          sessionId: "rtc_alternate_agent",
          sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_alternate_agent",
          upstreamRequestId: "req_alternate_agent",
        }),
      ),
      connectSideband: vi.fn(async () => {
        const socket = sockets.at(-1);
        if (socket === undefined) throw new Error("missing_socket");
        return providerSuccess(socket.socket);
      }),
      sendCommand: () => providerSuccess(undefined),
      sendFinalizationOperation: () => providerSuccess(undefined),
      hangUp: async () => providerSuccess({ status: 204, upstreamRequestId: null }),
    };
    const assembly = (controlled: RuntimeHostAssembly): RuntimeHostAssembly => {
      const baseAssembly = testAssembly(agent, controlled);
      return {
        ...baseAssembly,
        createSession(input, selection) {
          const issue = input.issueSink;
          const session = baseAssembly.createSession(
            {
              ...input,
              issueSink(runId, generation) {
                if (issue === undefined) throw new Error("missing_sink_fixture");
                const sink = issue(runId, generation);
                issuedSinks?.push(sink);
                return sink;
              },
            },
            selection,
          );
          sessions.push(session);
          Object.defineProperty(session, "enterNode", {
            value: (
              node: Omit<import("../implementationContracts.ts").NodeDispatchInput, "reporter">,
              admission: import("../implementationContracts.ts").ConversationAdmission,
            ) =>
              dispatchReportedNode(admission, node, {
                enterNode(reported: import("../implementationContracts.ts").NodeDispatchInput) {
                  nodes.push(reported);
                },
              }),
          });
          return session;
        },
      };
    };
    const controller = createInterviewRuntimeController(
      durable.ctx,
      env,
      provider,
      undefined,
      {},
      undefined,
      assembly,
    );
    const repository = new InterviewFinalizationRepository(
      createDurableObjectState(durable.ctx).storage,
    );
    const harness = {
      durable,
      sockets,
      nodes,
      sessions,
      assembly,
      env,
      provider,
      controller,
      repository,
      driver: controllerDriver(controller),
      start: {
        selection: testSelection,
        runId,
        profile: "realtime-v1",
        connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
        createdAt: startedAt,
        execution: { agentInput: { allowedTool } },
        diagnosticsContext: { surface: "test" },
      },
    };
    resources.push(harness);
    return harness;
  }
  afterEach(async () => {
    for (const harness of resources.splice(0)) {
      for (const socket of harness.sockets) socket.close();
      await harness.durable.flushWaitUntil();
      harness.durable.close();
    }
    vi.useRealTimers();
  });
  async function startLive(harness: ReturnType<typeof setup>) {
    const response = await harness.driver.startConnection(harness.start);
    expect(response.status, JSON.stringify(response.data)).toBe(200);
    await vi.waitFor(async () =>
      expect(await harness.driver.state()).toMatchObject({ state: { phase: "live" } }),
    );
  }
  async function received(harness: ReturnType<typeof setup>, count: number) {
    await vi.waitFor(async () =>
      expect(await harness.driver.state()).toMatchObject({
        state: { session: { eventCount: count } },
      }),
    );
  }
  function firstSocket(harness: ReturnType<typeof setup>) {
    const socket = harness.sockets[0];
    if (socket === undefined) throw new Error("missing_socket");
    return socket;
  }
  function invocation(name: string, callId = "selected-call") {
    return { type: "function_call", id: "selected-item", name, call_id: callId, arguments: "{}" };
  }

  describe("selected Conversation Agent tools at the controller boundary", () => {
    it("rejects a stale production selection before durable admission or native work", async () => {
      const harness = setup("complete_feedback");
      const production = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
      );
      const result = await controllerDriver(production).startConnection({
        ...harness.start,
        selection: {
          ...originalRealtimeSelection,
          execution: { ...originalRealtimeSelection.execution, version: 2 },
        },
        execution: { agentInput: createInterviewConversationInput(INTERVIEW_AGENT_INSTRUCTIONS) },
      });
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.error).toBe("conversation_selection_unavailable");
      expect(findRunRecordView(harness.repository)).toBeNull();
      expect(harness.provider.createCall).not.toHaveBeenCalled();
      expect(harness.provider.connectSideband).not.toHaveBeenCalled();
    });
    it.each(["missing"] as const)(
      "refuses native recovery with %s conversation authority",
      async () => {
        const harness = setup("complete_feedback");
        await startLive(harness);
        const aggregate = harness.repository.readAggregate();
        if (aggregate.conversationVisit === undefined) throw new Error("missing_visit_fixture");
        const { conversationVisit: _removed, ...withoutVisit } = aggregate;
        harness.repository.persistAggregate(withoutVisit, null);
        const creates = harness.provider.createCall.mock.calls.length;
        const connects = harness.provider.connectSideband.mock.calls.length;
        const restored = createInterviewRuntimeController(
          harness.durable.ctx,
          harness.env,
          harness.provider,
          undefined,
          {},
          undefined,
          harness.assembly,
        );
        await expect(restored.alarm()).rejects.toThrow("conversation_visit_unavailable");
        expect(harness.provider.createCall.mock.calls).toHaveLength(creates);
        expect(harness.provider.connectSideband.mock.calls).toHaveLength(connects);
      },
    );

    it("refuses an undeclared original conversation state before reconnecting", async () => {
      const harness = setup("complete_feedback");
      const production = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
      );
      const driver = controllerDriver(production);
      expect(
        (
          await driver.startConnection({
            ...harness.start,
            selection: originalRealtimeSelection,
            execution: {
              agentInput: createInterviewConversationInput(INTERVIEW_AGENT_INSTRUCTIONS),
            },
          })
        ).status,
      ).toBe(200);
      await vi.waitFor(async () =>
        expect(await driver.state()).toMatchObject({ state: { phase: "live" } }),
      );
      const aggregate = harness.repository.readAggregate();
      const visit = aggregate.conversationVisit;
      if (visit === undefined) throw new Error("missing_visit_fixture");
      harness.repository.persistAggregate(
        { ...aggregate, conversationVisit: { ...visit, state: "undeclared-state" } },
        null,
      );
      const connects = harness.provider.connectSideband.mock.calls.length;
      const restored = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
      );
      await expect(restored.alarm()).rejects.toThrow("conversation_visit_unavailable");
      expect(harness.provider.connectSideband.mock.calls).toHaveLength(connects);
      expect(harness.provider.createCall).toHaveBeenCalledOnce();
    });

    it("refuses native recovery when the accepted selection is missing", async () => {
      const harness = setup("complete_feedback");
      await startLive(harness);
      harness.durable.storage.sql.exec(
        "UPDATE runtime_controller_state SET conversation_selection_json = NULL WHERE run_id = ?",
        runId,
      );
      const connects = harness.provider.connectSideband.mock.calls.length;
      const creates = harness.provider.createCall.mock.calls.length;
      const restored = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
        undefined,
        {},
        undefined,
        harness.assembly,
      );
      await expect(restored.alarm()).rejects.toThrow("conversation_selection_missing");
      expect(harness.provider.connectSideband.mock.calls).toHaveLength(connects);
      expect(harness.provider.createCall.mock.calls).toHaveLength(creates);
    });
    it("does not advance from a plugin return without an issued report", async () => {
      const returnOnly = {
        ...alternateAgent,
        bind: () => ({
          reporting: { kind: "native" as const },
          interpretTool: alternateAgent.interpretTool,
        }),
      };
      const harness = setup("complete_feedback", returnOnly);
      await startLive(harness);
      firstSocket(harness).emit(
        JSON.stringify({
          type: "response.done",
          response: {
            id: "unreported-response",
            status: "completed",
            output: [invocation("complete_feedback")],
          },
        }),
      );
      await received(harness, 1);
      expect(await harness.driver.state()).toMatchObject({ state: { phase: "live" } });
      const run = readRunView(harness.repository);
      expect(run.visit?.state).toBe("interviewing");
      expect(run.agentCompletion).toBeNull();
      expect(run.effects).toEqual([]);
    });
    it.each([null, "interviewing"])(
      "keeps admitted nonterminal decision %s live without shutdown work",
      async (target) => {
        const harness = setup("complete_feedback", {
          ...alternateAgent,
          conversation: {
            ...alternateAgent.conversation,
            evaluate: { interviewing: () => target },
          },
        });
        await startLive(harness);
        firstSocket(harness).emit(
          JSON.stringify({
            type: "response.done",
            response: {
              id: "continuing-response",
              status: "completed",
              output: [invocation("complete_feedback")],
            },
          }),
        );
        await received(harness, 1);
        expect(await harness.driver.state()).toMatchObject({ state: { phase: "live" } });
        const run = readRunView(harness.repository);
        expect(run.visit?.state).toBe("interviewing");
        expect(run.agentCompletion).toBeNull();
        expect(run.effects).toEqual([]);
      },
    );
    it("rejects a superseded connection's failure before its first native receipt", async () => {
      const sinks: ProviderSessionApplicationSink[] = [];
      const harness = setup("complete_feedback", alternateAgent, sinks);
      await startLive(harness);
      const previous = sinks[0];
      if (previous === undefined) throw new Error("missing_sink_fixture");
      expect(readRunRecordView(harness.repository).providerEventCount).toBe(0);
      harness.sockets.push(controlledSocket());
      const restored = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
        undefined,
        {},
        undefined,
        harness.assembly,
      );
      expect((await controllerDriver(restored).startConnection(harness.start)).status).toBe(200);
      await vi.waitFor(() => expect(harness.provider.connectSideband).toHaveBeenCalledTimes(2));
      const current = readRunView(harness.repository);
      await previous({
        kind: "failure",
        failure: "session",
        errorText: "obsolete_acquisition_failed",
        applyRuntimeFailure: true,
      });
      expect(await controllerDriver(restored).state()).toMatchObject({ state: { phase: "live" } });
      expect(readRunView(harness.repository).visit).toEqual(current.visit);
      expect(readRunView(harness.repository).agentCompletion).toBeNull();
      expect(readRunView(harness.repository).effects).toEqual([]);
      expect(
        readRuntimeDiagnosticRecords(harness.durable).some(
          (record) => record.type === "runtime.live_degraded",
        ),
      ).toBe(false);
    });

    it("records transcript-only attribution without inventing active work and promotes actual lifecycle receipts", async () => {
      const harness = setup("complete_feedback");
      await startLive(harness);
      const socket = firstSocket(harness);
      socket.emit(
        JSON.stringify({
          type: "response.output_audio_transcript.done",
          response_id: "evidence-response",
          item_id: "evidence-item",
          output_index: 0,
          content_index: 0,
          transcript: "Thank you for sharing your feedback.",
        }),
      );
      await received(harness, 1);
      expect(readRunView(harness.repository).provider.responses).toEqual([
        expect.objectContaining({
          responseId: "evidence-response",
          status: "unobserved",
          outputAudio: "pending",
        }),
      ]);
      socket.emit(
        JSON.stringify({ type: "response.created", response: { id: "evidence-response" } }),
      );
      await received(harness, 2);
      expect(readRunView(harness.repository).provider.responses[0]?.status).toBe("active");
      socket.emit(
        JSON.stringify({
          type: "response.done",
          response: { id: "evidence-response", status: "completed", output: [] },
        }),
      );
      await received(harness, 3);
      expect(readRunView(harness.repository).provider.responses[0]?.status).toBe("completed");
      expect(readRunView(harness.repository).agentCompletion).toBeNull();
      expect(readRunView(harness.repository).effects).toEqual([]);
    });

    it("starts and completes the selected declared initial state", async () => {
      const preparedStates: string[] = [];
      const harness = setup("complete_feedback", {
        ...alternateAgent,
        conversation: {
          ...alternateAgent.conversation,
          initial: "collecting",
          selectInput: { collecting: (input) => input },
          states: { collecting: alternateStateContract },
          evaluate: { collecting: () => "complete" },
        },
        prepare(input) {
          preparedStates.push(input.state);
          return alternateAgent.prepare(input);
        },
      });
      await startLive(harness);
      expect(preparedStates.length).toBeGreaterThan(0);
      expect(preparedStates.every((state) => state === "collecting")).toBe(true);
      expect(readRunView(harness.repository).visit?.state).toBe("collecting");
      firstSocket(harness).emit(
        JSON.stringify({
          type: "response.done",
          response: {
            id: "collecting-response",
            status: "completed",
            output: [invocation("complete_feedback")],
          },
        }),
      );
      await received(harness, 1);
      expect(await harness.driver.state()).toMatchObject({ state: { phase: "ending" } });
      expect(readRunView(harness.repository).visit?.state).toBe("complete");
    });

    it.each([
      ["completion", "finished", "finished"],
      ["interruption", "undeclared-state", "stopped"],
    ] as const)(
      "ends the visit in the selected Conversation's declared %s terminal",
      async (_role, target, terminal) => {
        const harness = setup("complete_feedback", {
          ...alternateAgent,
          conversation: {
            ...alternateAgent.conversation,
            terminalStates: ["finished", "stopped"],
            terminalRoles: { completion: "finished", interruption: "stopped" },
            evaluate: { interviewing: () => target },
          },
        });
        await startLive(harness);
        firstSocket(harness).emit(
          JSON.stringify({
            type: "response.done",
            response: {
              id: "terminal-response",
              status: "completed",
              output: [invocation("complete_feedback")],
            },
          }),
        );
        await vi.waitFor(async () =>
          expect(await harness.driver.state()).toMatchObject({ state: { phase: "ending" } }),
        );
        expect(readRunView(harness.repository).visit?.state).toBe(terminal);
      },
    );

    it("rejects an undeclared successor without persisting it or dispatching its native work", async () => {
      const harness = setup("complete_feedback", {
        ...alternateAgent,
        conversation: {
          ...alternateAgent.conversation,
          evaluate: { interviewing: () => "undeclared-state" },
        },
      });
      await startLive(harness);
      const before = readRunView(harness.repository).visit;
      firstSocket(harness).emit(
        JSON.stringify({
          type: "response.done",
          response: {
            id: "invalid-successor-response",
            status: "completed",
            output: [invocation("complete_feedback")],
          },
        }),
      );
      await vi.waitFor(async () =>
        expect(await harness.driver.state()).toMatchObject({
          state: { phase: "ending", pendingClose: { endReason: "runtime_failed" } },
        }),
      );
      const run = readRunView(harness.repository);
      expect(run.visit).toEqual({ ...before, state: "interrupted" });
      expect(run.agentCompletion).toBeNull();
      expect(harness.provider.createCall).toHaveBeenCalledOnce();
      expect(harness.provider.connectSideband).toHaveBeenCalledOnce();
      const degradation = readRuntimeDiagnosticRecords(harness.durable).find(
        (event) => event.type === "runtime.live_degraded",
      );
      expect(degradation?.payloadJson).toContain("conversation_visit_unavailable");
    });

    it("revokes actual reports across repeated visits while retaining late native evidence in its original scope", async () => {
      const reporters: Array<StateReporter<z.output<typeof alternateStateContract.event>>> = [];
      let replay: SemanticReport<unknown> | null = null;
      const harness = setup("complete_feedback", {
        ...alternateAgent,
        conversation: {
          ...alternateAgent.conversation,
          initial: "collecting",
          selectInput: { collecting: (input) => input, reviewing: (input) => input },
          states: { collecting: alternateStateContract, reviewing: alternateStateContract },
          evaluate: { collecting: () => "reviewing", reviewing: () => "collecting" },
        },
        bind(issue) {
          const reporter = issue(alternateStateContract);
          reporters.push(reporter);
          return {
            reporting: { kind: "native" },
            interpretTool(invocation, execution) {
              const intent = alternateAgent.interpretTool(invocation, execution);
              if (
                intent === null ||
                invocation.callId === undefined ||
                invocation.responseId === undefined
              )
                return intent;
              const report =
                replay ??
                reporter.report({
                  kind: "finish_intent",
                  responseId: invocation.responseId,
                  toolCallId: invocation.callId,
                });
              return report === null ? null : { ...intent, report };
            },
          };
        },
      });
      await startLive(harness);
      const initial = readRunView(harness.repository).visit;
      if (initial === null) throw new Error("missing_visit_fixture");
      const retained = decodeConversationSnapshot(
        readRunRecordView(harness.repository).conversationSelection,
      );
      const deadline = readRunRecordView(harness.repository).deadlineAt;
      const socket = firstSocket(harness);
      socket.emit(JSON.stringify({ type: "response.created", response: { id: "first-response" } }));
      socket.emit(JSON.stringify({ type: "response.created", response: { id: "old-response" } }));
      await received(harness, 2);
      const first = reporters[0];
      if (first === undefined) throw new Error("missing_reporter_fixture");
      const event = {
        kind: "finish_intent",
        responseId: "old-response",
        toolCallId: "old-call",
      } as const;
      const held = first.report(event);
      if (held === null) throw new Error("missing_report_fixture");
      socket.emit(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          response_id: "first-response",
          name: "complete_feedback",
          call_id: "first-call",
          arguments: "{}",
        }),
      );
      await received(harness, 3);
      const secondVisit = readRunView(harness.repository).visit;
      expect(secondVisit).toMatchObject({ state: "reviewing", revision: 1 });
      expect(secondVisit?.visitId).not.toBe(initial.visitId);
      expect(secondVisit?.operationId).not.toBe(initial.operationId);
      expect(first.report(event)).toBeNull();
      const reportersAfterEntry = [...reporters];
      socket.emit(
        JSON.stringify({
          type: "response.done",
          response: {
            id: "old-response",
            status: "completed",
            output: [
              invocation("complete_feedback", "old-call"),
              {
                type: "message",
                id: "old-message",
                role: "assistant",
                content: [{ type: "audio", transcript: "Thank you for sharing your feedback." }],
              },
            ],
            usage: {
              total_tokens: 7,
              input_tokens: 5,
              output_tokens: 2,
              input_token_details: {
                audio_tokens: 0,
                text_tokens: 5,
                image_tokens: 0,
                cached_tokens: 0,
                cached_tokens_details: { audio_tokens: 0, text_tokens: 0, image_tokens: 0 },
              },
              output_token_details: { audio_tokens: 0, text_tokens: 2 },
            },
          },
        }),
      );
      await received(harness, 4);
      const late = readRunView(harness.repository);
      expect(late.visit).toEqual(secondVisit);
      expect(
        late.provider.responses.find((response) => response.responseId === "old-response")
          ?.conversationScope,
      ).toMatchObject({ visitId: initial.visitId, operationId: initial.operationId });
      expect(late.transcript.items.find((item) => item.itemId === "old-message")?.text).toBe(
        "Thank you for sharing your feedback.",
      );
      expect(late.usage?.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ quantity: 5 }),
          expect.objectContaining({ quantity: 2 }),
        ]),
      );
      expect(reporters).toEqual(reportersAfterEntry);
      expect(late.agentCompletion).toBeNull();
      expect(late.effects).toEqual([]);
      socket.emit(
        JSON.stringify({ type: "response.created", response: { id: "second-response" } }),
      );
      socket.emit(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          response_id: "second-response",
          name: "complete_feedback",
          call_id: "second-call",
          arguments: "{}",
        }),
      );
      await received(harness, 6);
      const reentered = readRunView(harness.repository).visit;
      expect(reentered).toMatchObject({ state: "collecting", revision: 2 });
      expect(reentered?.visitId).not.toBe(initial.visitId);
      expect(first.report(event)).toBeNull();
      replay = held;
      socket.emit(
        JSON.stringify({ type: "response.created", response: { id: "replay-response" } }),
      );
      socket.emit(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          response_id: "replay-response",
          name: "complete_feedback",
          call_id: "replay-call",
          arguments: "{}",
        }),
      );
      await received(harness, 8);
      expect(readRunView(harness.repository).visit).toEqual(reentered);
      expect(await harness.driver.state()).toMatchObject({ state: { phase: "live" } });
      expect(readRunRecordView(harness.repository).deadlineAt).toBe(deadline);
      const current = decodeConversationSnapshot(
        readRunRecordView(harness.repository).conversationSelection,
      );
      // The accepted snapshot stays fixed; only the aggregate's visit carries current identity.
      expect(current).toEqual(retained);
    });

    it("settles an ordinary visit when its current native tool report completes the Conversation", async () => {
      const harness = setup("complete_feedback", {
        ...alternateAgent,
        conversation: {
          ...alternateAgent.conversation,
          initial: "collecting",
          selectInput: { collecting: (input) => input, reviewing: (input) => input },
          states: { collecting: alternateStateContract, reviewing: alternateStateContract },
          evaluate: { collecting: () => "reviewing", reviewing: () => "complete" },
        },
      });
      await startLive(harness);
      const socket = firstSocket(harness);
      socket.emit(
        JSON.stringify({
          type: "response.done",
          response: {
            id: "ordinary-entry",
            status: "completed",
            output: [invocation("complete_feedback")],
          },
        }),
      );
      await received(harness, 1);
      expect(readRunView(harness.repository).visit?.state).toBe("reviewing");
      socket.emit(
        JSON.stringify({ type: "response.created", response: { id: "ordinary-finish" } }),
      );
      socket.emit(
        JSON.stringify({
          type: "response.done",
          response: {
            id: "ordinary-finish",
            status: "completed",
            output: [invocation("complete_feedback", "ordinary-finish-call")],
          },
        }),
      );
      await received(harness, 3);
      expect(await harness.driver.state()).toMatchObject({ state: { phase: "ending" } });
      const completed = readRunView(harness.repository);
      expect(completed.lifecycle).toMatchObject({
        stage: "draining",
        endReason: "agent_requested_end",
      });
      expect(completed.visit?.state).toBe("complete");
      expect(completed.nodeExecution?.dispatch?.status).toBe("complete");
      expect(harness.nodes).toHaveLength(1);
    });

    it("renews an unclaimed ordinary operation atomically and revokes stale control before recovery", async () => {
      const reporters: StateReporter<z.output<typeof alternateStateContract.event>>[] = [];
      const harness = setup("complete_feedback", {
        ...alternateAgent,
        conversation: {
          ...alternateAgent.conversation,
          evaluate: { interviewing: () => "interviewing" },
        },
        bind(issue) {
          reporters.push(issue(alternateStateContract));
          return bindAlternate.call(this, issue);
        },
      });
      await startLive(harness);
      const session = harness.sessions[0];
      const old = reporters[0];
      if (session === undefined || old === undefined)
        throw new Error("pending_entry_fixture_missing");
      // Native connectivity is held after startup; the admitted entry cannot be claimed.
      Object.defineProperty(session, "connected", { get: () => false });
      firstSocket(harness).emit(
        JSON.stringify({
          type: "response.done",
          response: {
            id: "pending-entry",
            status: "completed",
            output: [invocation("complete_feedback")],
          },
        }),
      );
      await received(harness, 1);
      const pending = readRunView(harness.repository);
      expect(pending.nodeExecution?.dispatch?.status).toBe("pending");
      expect(harness.nodes).toEqual([]);
      const restored = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
        undefined,
        {},
        undefined,
        harness.assembly,
      );
      await restored.alarm();
      const recovered = readRunView(harness.repository);
      expect(recovered.visit?.operationId).not.toBe(pending.visit?.operationId);
      expect(recovered.visit?.visitId).toBe(pending.visit?.visitId);
      expect(recovered.nodeExecution?.dispatch).toMatchObject({
        input: { allowedTool: "complete_feedback" },
      });
      expect(
        old.report({ kind: "finish_intent", responseId: "pending-entry", toolCallId: "stale" }),
      ).toBeNull();
      expect(old.isCurrent()).toBe(false);
      expect(recovered.lifecycle.stage).toBe("live");
      expect(recovered.effects).toEqual([]);
      expect(recovered.nodeExecution?.dispatch?.status).toBe("claimed");
      expect(harness.nodes).toHaveLength(1);
      expect(harness.nodes[0]?.identity.operationId).toBe(recovered.visit?.operationId);
      expect(harness.provider.createCall).toHaveBeenCalledOnce();
    });

    it.each(["advance", "recover", "expire", "complete"] as const)(
      "dispatches ordinary entry with fresh authority and handles its %s through the owning path",
      async (action) => {
        const harness = setup("complete_feedback", {
          ...alternateAgent,
          conversation: {
            ...alternateAgent.conversation,
            initial: "collecting",
            selectInput: { collecting: (input) => input, reviewing: (input) => input },
            states: { collecting: alternateStateContract, reviewing: alternateStateContract },
            runtimeEvent: z.strictObject({ kind: z.literal("timebox_elapsed") }),
            timers: (_input, anchor) => ({
              timers:
                action === "expire"
                  ? [
                      {
                        id: "interview",
                        deadlineAt: anchor.liveAt + 60_000,
                        event: { kind: "timebox_elapsed" },
                      },
                    ]
                  : [],
            }),
            evaluate: {
              collecting: (received) => (received.origin === "runtime" ? "complete" : "reviewing"),
              reviewing: (received) =>
                received.origin === "runtime" || action === "complete" ? "complete" : "collecting",
            },
          },
        });
        await startLive(harness);
        const initial = readRunView(harness.repository).visit;
        firstSocket(harness).emit(
          JSON.stringify({
            type: "response.done",
            response: {
              id: "ordinary-entry",
              status: "completed",
              output: [invocation("complete_feedback")],
            },
          }),
        );
        await received(harness, 1);
        const node = harness.nodes[0];
        if (node === undefined) throw new Error("ordinary_entry_not_dispatched");
        expect(harness.nodes).toHaveLength(1);
        const entered = readRunView(harness.repository);
        expect(entered.visit).toMatchObject({
          state: "reviewing",
          visitId: node.identity.visitId,
          operationId: node.identity.operationId,
        });
        expect(entered.nodeExecution?.dispatch).toMatchObject({
          status: "claimed",
          input: { allowedTool: "complete_feedback" },
        });
        expect(node.identity.visitId).not.toBe(initial?.visitId);
        expect(node.identity.operationId).not.toBe(initial?.operationId);
        expect(node.deadlineAt).toBe(action === "expire" ? startedAt + 60_000 : null);
        expect(entered.finalInput).toBeNull();
        expect(entered.agentCompletion).toBeNull();
        expect(entered.lifecycle.stage).toBe("live");
        expect(entered.effects).toEqual([]);
        expect(entered.nodeExecution).toMatchObject({ reservation: undefined });
        const event = {
          kind: "finish_intent",
          responseId: "entry-report",
          toolCallId: "entry-call",
        };
        const report = node.reporter.report(event);
        const stale = node.reporter.report(event);
        if (report === null || stale === null) throw new Error("ordinary_report_not_issued");
        if (action === "recover") {
          const restored = createInterviewRuntimeController(
            harness.durable.ctx,
            harness.env,
            harness.provider,
            undefined,
            {},
            undefined,
            harness.assembly,
          );
          await restored.alarm();
          expect(readRunView(harness.repository).lifecycle).toMatchObject({
            stage: "draining",
            endReason: "runtime_failed",
          });
          expect(harness.nodes).toHaveLength(1);
        } else {
          if (action === "expire") vi.setSystemTime(startedAt + 60_000);
          await node.onComplete(report);
          const after = readRunView(harness.repository);
          if (action === "advance") {
            expect(after.visit).toMatchObject({ state: "collecting", revision: 2 });
            expect(after.lifecycle.stage).toBe("live");
            expect(after.effects).toEqual([]);
            expect(after.finalInput).toBeNull();
            expect(after.agentCompletion).toBeNull();
            expect(after.nodeExecution).toMatchObject({ reservation: undefined });
            expect(harness.nodes).toHaveLength(2);
            expect(harness.nodes[1]?.identity.operationId).not.toBe(node.identity.operationId);
          } else {
            expect(after.lifecycle).toMatchObject({
              stage: "draining",
              endReason: action === "complete" ? "agent_requested_end" : "timebox_reached",
            });
            expect(after.agentCompletion).toBeNull();
            expect(after.nodeExecution).toMatchObject({ limitation: undefined });
            expect(harness.nodes).toHaveLength(1);
          }
        }
        const settled = readRunView(harness.repository);
        expect(node.reporter.report(event)).toBeNull();
        expect(node.reporter.isCurrent()).toBe(false);
        await node.onComplete(stale);
        await node.onFailure("late_entry_failure");
        expect(readRunView(harness.repository).persistedState).toEqual(settled.persistedState);
        expect(harness.provider.createCall).toHaveBeenCalledOnce();
      },
    );

    it("shares declared timers across ordinary visits and removes the countdown in an untimed state without closing input", async () => {
      const harness = setup("complete_feedback", {
        ...alternateAgent,
        conversation: {
          ...alternateAgent.conversation,
          initial: "collecting",
          selectInput: {
            collecting: (input) => input,
            reviewing: (input) => input,
            untimed: (input) => input,
          },
          states: {
            collecting: alternateStateContract,
            reviewing: alternateStateContract,
            untimed: alternateStateContract,
          },
          runtimeEvent: z.strictObject({ kind: z.literal("timebox_elapsed") }),
          timers(_input, anchor) {
            return anchor.state === "untimed"
              ? { timers: [] }
              : {
                  timers: [
                    {
                      id: "interview",
                      deadlineAt: anchor.liveAt + 60_000,
                      event: { kind: "timebox_elapsed" },
                    },
                  ],
                  associatedTimerId: "interview",
                };
          },
          evaluate: {
            collecting: () => "reviewing",
            reviewing: () => "untimed",
            untimed: () => "collecting",
          },
        },
      });
      await startLive(harness);
      const socket = firstSocket(harness);
      let previous = readRunView(harness.repository).visit;
      expect(readRunRecordView(harness.repository).deadlineAt).toBe(startedAt + 60_000);
      for (const [index, target] of ["reviewing", "untimed", "collecting"].entries()) {
        vi.setSystemTime(startedAt + (index + 1) * 1_000);
        socket.emit(
          JSON.stringify({ type: "response.created", response: { id: `ordinary-${index}` } }),
        );
        socket.emit(
          JSON.stringify({
            type: "response.function_call_arguments.done",
            response_id: `ordinary-${index}`,
            name: "complete_feedback",
            call_id: `ordinary-call-${index}`,
            arguments: "{}",
          }),
        );
        await received(harness, (index + 1) * 2);
        const run = readRunView(harness.repository);
        expect(run.lifecycle.stage).toBe("live");
        expect(run.effects).toEqual([]);
        expect(run.finalInput).toBeNull();
        expect(run.agentCompletion).toBeNull();
        expect(run.visit?.state).toBe(target);
        expect(run.visit?.visitId).not.toBe(previous?.visitId);
        expect(run.visit?.operationId).not.toBe(previous?.operationId);
        const node = run.nodeExecution;
        for (const field of ["reservation", "closingCutoffAt", "retainedOutput", "cleanupAt"])
          expect(node).toMatchObject({ [field]: undefined });
        expect(node?.dispatch).toMatchObject({
          status: "claimed",
          input: { allowedTool: "complete_feedback" },
        });
        expect(harness.nodes).toHaveLength(index + 1);
        expect(harness.nodes[index]?.identity).toMatchObject({
          visitId: run.visit?.visitId,
          operationId: run.visit?.operationId,
        });
        expect(node?.timers).toEqual(
          target === "untimed"
            ? []
            : [
                {
                  id: "interview",
                  deadlineAt: startedAt + 60_000,
                  event: { kind: "timebox_elapsed" },
                },
              ],
        );
        expect(readRunRecordView(harness.repository).deadlineAt).toBe(
          target === "untimed" ? null : startedAt + 60_000,
        );
        previous = run.visit;
      }
    });

    it("revokes controller-issued report and failure handles on reconstruction", async () => {
      let reporter: StateReporter<z.output<typeof alternateStateContract.event>> | undefined;
      const harness = setup("complete_feedback", {
        ...alternateAgent,
        bind(issue) {
          reporter = issue(alternateStateContract);
          return bindAlternate.call(this, issue);
        },
      });
      await startLive(harness);
      firstSocket(harness).emit(
        JSON.stringify({ type: "response.created", response: { id: "held-response" } }),
      );
      await received(harness, 1);
      const held = reporter;
      if (held === undefined) throw new Error("missing_reporter_fixture");
      const event = {
        kind: "finish_intent",
        responseId: "held-response",
        toolCallId: "held-call",
      } as const;
      const token = held.report(event);
      expect(token).not.toBeNull();
      firstSocket(harness).emit(
        JSON.stringify({
          type: "response.done",
          response: { id: "held-response", status: "completed", output: [] },
        }),
      );
      await received(harness, 2);
      const before = readRunView(harness.repository);
      const socket = controlledSocket();
      harness.sockets.push(socket);
      const restored = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
        undefined,
        {},
        undefined,
        harness.assembly,
      );
      await restored.alarm();
      expect(harness.provider.connectSideband).toHaveBeenCalledOnce();
      expect(held.report(event)).toBeNull();
      expect(held.isCurrent()).toBe(false);
      const recovered = readRunView(harness.repository);
      expect(recovered.visit?.visitId).toBe(before.visit?.visitId);
      expect(recovered.visit?.operationId).not.toBe(before.visit?.operationId);
      expect(recovered.lifecycle).toMatchObject({
        stage: "draining",
        endReason: "runtime_failed",
        endingStartedAt: startedAt + 250,
        finalizationCutoffAt: startedAt + 10_250,
      });
      firstSocket(harness).emit(
        JSON.stringify({
          type: "response.done",
          response: {
            id: "held-response",
            status: "completed",
            output: [invocation("complete_feedback", "held-call")],
          },
        }),
      );
      await received(harness, 3);
      expect(readRunView(harness.repository).visit).toEqual(recovered.visit);
      expect(readRunView(harness.repository).agentCompletion).toBeNull();
    });

    it("detaches actual execution callbacks from admitted input, native request and retained receipts", async () => {
      const harness = setup("complete_feedback", {
        ...alternateAgent,
        prepare(input) {
          const content = structuredClone(alternateAgent.prepare(input));
          const nodeInput = input.nodeInput;
          if (typeof nodeInput !== "object" || nodeInput === null)
            throw new Error("invalid_agent_fixture");
          Object.assign(nodeInput, { allowedTool: "close_feedback" });
          queueMicrotask(() => {
            Object.assign(nodeInput, { allowedTool: null });
            if (content.tools[0] !== undefined)
              Object.assign(content.tools[0], {
                name: "mutated_tool",
                parameters: { invalid: true },
              });
          });
          return content;
        },
        interpretTool(invocation, execution) {
          const intent = alternateAgent.interpretTool(invocation, execution);
          if (execution !== null) Object.assign(execution, { agentInput: null });
          Object.assign(invocation, { responseId: "mutated-response", callId: "mutated-call" });
          return intent;
        },
      });
      await startLive(harness);
      expect(
        harness.provider.createCall.mock.calls[0]?.[0].session.tools.map((tool) => tool.name),
      ).toEqual(["complete_feedback", "close_feedback"]);
      expect(
        decodeConversationSnapshot(readRunRecordView(harness.repository).conversationSelection),
      ).toMatchObject({
        execution: { agentInput: { allowedTool: "complete_feedback" } },
        initialNodeInput: { allowedTool: "complete_feedback" },
      });
      firstSocket(harness).emit(
        JSON.stringify({
          type: "response.done",
          response: {
            id: "owned-response",
            status: "completed",
            output: [invocation("complete_feedback", "owned-call")],
          },
        }),
      );
      await received(harness, 1);
      expect(readRunView(harness.repository).agentCompletion).toMatchObject({
        responseId: "owned-response",
        callId: "owned-call",
      });
      expect(
        decodeConversationSnapshot(readRunRecordView(harness.repository).conversationSelection)
          .execution,
      ).toEqual({ agentInput: { allowedTool: "complete_feedback" } });
    });
    it.each(toolNames)(
      "prepares and dispatches %s after unrelated and unidentified native calls",
      async (toolName) => {
        const harness = setup(toolName);
        await startLive(harness);
        expect(
          harness.provider.createCall.mock.calls[0]?.[0].session.tools.map((tool) => tool.name),
        ).toEqual(["complete_feedback", "close_feedback"]);
        const socket = firstSocket(harness);
        socket.emit(
          JSON.stringify({
            type: "response.output_item.added",
            response_id: "unrelated-response",
            item: invocation("finish_interview"),
          }),
        );
        socket.emit(
          JSON.stringify({
            type: "response.function_call_arguments.done",
            response_id: "missing-call",
            name: toolName,
            arguments: "{}",
          }),
        );
        socket.emit(
          JSON.stringify({
            type: "response.function_call_arguments.done",
            call_id: "missing-response",
            name: toolName,
            arguments: "{}",
          }),
        );
        await received(harness, 3);
        expect(await harness.driver.state()).toMatchObject({ state: { phase: "live" } });
        vi.setSystemTime(startedAt + 1_000);
        socket.emit(
          JSON.stringify({
            type: "response.done",
            response: {
              id: "selected-response",
              status: "completed",
              output: [invocation("unknown_tool", "unknown-call"), invocation(toolName)],
            },
          }),
        );
        socket.emit(
          JSON.stringify({ type: "output_audio_buffer.stopped", response_id: "selected-response" }),
        );
        await vi.waitFor(async () =>
          expect(await harness.driver.state()).toMatchObject({
            state: { phase: "ending", pendingClose: { endReason: "agent_requested_end" } },
          }),
        );
        expect(readRunView(harness.repository).agentCompletion).toMatchObject({
          callId: "selected-call",
          responseId: "selected-response",
          responseSettlement: "completed",
          outputAudioSettlement: "stopped",
        });
      },
    );

    it("retains the first argument receipt's response and cutoff through duplicate and later tool calls", async () => {
      const harness = setup("complete_feedback");
      await startLive(harness);
      const socket = firstSocket(harness);
      const visit = readRunView(harness.repository).visit;
      vi.setSystemTime(startedAt + 1_000);
      const first = {
        type: "response.function_call_arguments.done",
        response_id: "first-response",
        item_id: "first-item",
        name: "complete_feedback",
        call_id: "first-call",
        arguments: "{}",
      };
      socket.emit(JSON.stringify(first));
      await received(harness, 1);
      const initial = readRunView(harness.repository);
      expect(initial.agentCompletion).toMatchObject({
        responseId: "first-response",
        callId: "first-call",
        executionIdentity: {
          runId,
          visitId: visit?.visitId,
          operationId: visit?.operationId,
          generation: 1,
        },
      });
      vi.setSystemTime(startedAt + 2_000);
      socket.emit(JSON.stringify(first));
      socket.emit(
        JSON.stringify({ ...first, response_id: "later-response", call_id: "later-call" }),
      );
      socket.emit(
        JSON.stringify({ type: "output_audio_buffer.stopped", response_id: "later-response" }),
      );
      await received(harness, 4);
      const replayed = readRunView(harness.repository);
      expect(initial.lifecycle).toMatchObject({
        stage: "draining",
        endingStartedAt: startedAt + 1_050,
        finalizationCutoffAt: startedAt + 11_050,
        drainDeadline: startedAt + 10_050,
      });
      expect(replayed.lifecycle).toMatchObject({
        stage: "draining",
        endingStartedAt: startedAt + 1_050,
        finalizationCutoffAt: startedAt + 11_050,
        drainDeadline: startedAt + 10_050,
      });
      expect(replayed.agentCompletion).toEqual(initial.agentCompletion);
      socket.emit(
        JSON.stringify({
          type: "response.done",
          response: { id: "first-response", status: "completed", output: [] },
        }),
      );
      socket.emit(
        JSON.stringify({ type: "output_audio_buffer.stopped", response_id: "first-response" }),
      );
      await vi.waitFor(async () =>
        expect(await harness.driver.state()).toMatchObject({ state: { phase: "ending" } }),
      );
    });

    it.each([
      {
        kind: "recognized",
        tool: invocation("close_feedback"),
        phase: "ending",
        responseId: "closing-response",
      },
      { kind: "unknown", tool: invocation("unknown_tool"), phase: "live", responseId: undefined },
      {
        kind: "missing identity",
        tool: {
          type: "function_call",
          id: "missing-call-item",
          name: "close_feedback",
          arguments: "{}",
        },
        phase: "live",
        responseId: undefined,
      },
    ])(
      "keeps same-receipt transcript and usage with a $kind tool",
      async ({ tool, phase, responseId }) => {
        const harness = setup("close_feedback");
        await startLive(harness);
        firstSocket(harness).emit(
          JSON.stringify({
            event_id: "closing-receipt",
            type: "response.done",
            response: {
              id: "closing-response",
              status: "completed",
              output: [
                {
                  id: "closing-text",
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "Thank you for sharing your feedback." }],
                },
                tool,
              ],
              usage: {
                total_tokens: 7,
                input_tokens: 5,
                output_tokens: 2,
                input_token_details: {
                  audio_tokens: 0,
                  text_tokens: 5,
                  image_tokens: 0,
                  cached_tokens: 0,
                  cached_tokens_details: { audio_tokens: 0, text_tokens: 0, image_tokens: 0 },
                },
                output_token_details: { audio_tokens: 0, text_tokens: 2 },
              },
            },
          }),
        );
        await received(harness, 1);
        expect(await harness.driver.state()).toMatchObject({
          state: { phase, transcript: { turnCount: 1 } },
        });
        expect(readRunRecordView(harness.repository).transcriptSnapshot).toEqual({
          turns: [{ role: "conversationAgent", text: "Thank you for sharing your feedback." }],
        });
        expect(readRunView(harness.repository).usage?.observations).toHaveLength(2);
        expect(readRunView(harness.repository).usage?.observations).toEqual(
          expect.arrayContaining([
            {
              componentRole: "speech_to_speech",
              provider: "openai",
              model: "gpt-realtime",
              measure: "uncached_input_text",
              unit: "token",
              quantity: 5,
            },
            {
              componentRole: "speech_to_speech",
              provider: "openai",
              model: "gpt-realtime",
              measure: "output_text",
              unit: "token",
              quantity: 2,
            },
          ]),
        );
        expect(readRunView(harness.repository).agentCompletion?.responseId).toBe(responseId);
      },
    );

    it("keeps handler failure visible and ends with runtime failure", async () => {
      const harness = setup("close_feedback", {
        ...alternateAgent,
        interpretTool() {
          throw new Error("selected_handler_failed");
        },
      });
      await startLive(harness);
      firstSocket(harness).emit(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          response_id: "failed-response",
          name: "close_feedback",
          call_id: "failed-call",
          arguments: "{}",
        }),
      );
      await vi.waitFor(async () =>
        expect(await harness.driver.state()).toMatchObject({
          state: { phase: "ending", pendingClose: { endReason: "runtime_failed" } },
        }),
      );
      expect(readRunView(harness.repository).agentCompletion).toBeNull();
      const degradation = readRuntimeDiagnosticRecords(harness.durable).find(
        (event) => event.type === "runtime.live_degraded",
      );
      expect(JSON.parse(degradation?.payloadJson ?? "null")).toMatchObject({
        degradationKind: "session_message",
        errorText: "selected_handler_failed",
      });
    });

    it("reconstructs the selected agent with its retained input rather than a replay's replacement input", async () => {
      const harness = setup("close_feedback");
      await startLive(harness);
      const socket = controlledSocket();
      harness.sockets.push(socket);
      const restored = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
        undefined,
        {},
        undefined,
        harness.assembly,
      );
      const driver = controllerDriver(restored);
      expect(
        (
          await driver.startConnection({
            ...harness.start,
            execution: { agentInput: { allowedTool: "complete_feedback" } },
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
      expect((await driver.startConnection(harness.start)).status).toBe(200);
      await vi.waitFor(() => expect(harness.provider.connectSideband).toHaveBeenCalledTimes(2));
      socket.emit(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          response_id: "wrong-input-response",
          name: "complete_feedback",
          call_id: "wrong-input-call",
          arguments: "{}",
        }),
      );
      await received(harness, 1);
      expect(await driver.state()).toMatchObject({ state: { phase: "live" } });
      socket.emit(
        JSON.stringify({ type: "response.created", response: { id: "restored-response" } }),
      );
      socket.emit(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          response_id: "restored-response",
          name: "close_feedback",
          call_id: "restored-call",
          arguments: "{}",
        }),
      );
      await received(harness, 3);
      expect(readRunView(harness.repository).agentCompletion).toMatchObject({
        callId: "restored-call",
        responseId: "restored-response",
      });
      expect(harness.provider.createCall).toHaveBeenCalledOnce();
    });

    it("rejects a restored run when its selected agent is unavailable in host composition", async () => {
      const harness = setup("close_feedback");
      await startLive(harness);
      const restored = createInterviewRuntimeController(
        harness.durable.ctx,
        harness.env,
        harness.provider,
      );
      const replay = await controllerDriver(restored).startConnection(harness.start);
      expect(replay.status).toBeGreaterThanOrEqual(400);
      expect(replay).toMatchObject({
        error: "conversation_selection_unavailable",
      });
      expect(harness.provider.createCall).toHaveBeenCalledOnce();
      expect(await harness.driver.state()).toMatchObject({ state: { phase: "live" } });
    });
  });

  describe("retained Conversation Agent selection contract", () => {
    const selection = {
      id: "alternate-feedback/v1",
      execution: { agentInput: { allowedTool: "close_feedback" } },
    };
    it("preserves host-selected identity and opaque input", () => {
      expect(decodeConversationAgentSelection(selection)).toEqual(selection);
    });
    it.each([
      { execution: selection.execution },
      { id: selection.id },
      { id: 12, execution: selection.execution },
      { id: selection.id, execution: {} },
      { id: selection.id, execution: { kind: "unsupported", agentInput: {} } },
      { id: selection.id, execution: { agentInput: { value: Number.NaN } } },
      { ...selection, extra: true },
    ])("rejects invalid current persistence contracts %#", (value) => {
      expect(() => decodeConversationAgentSelection(value)).toThrow();
    });
    it("rejects inherited required selection properties", () => {
      expect(() => decodeConversationAgentSelection(Object.create(selection))).toThrow();
    });
    it.each([Object.create(selection.execution)])(
      "rejects inherited execution properties %#",
      (execution: unknown) => {
        expect(() => decodeConversationAgentSelection({ id: selection.id, execution })).toThrow();
      },
    );
    it.each([
      { ...selection, __proto__: { unrelated: true } },
      { ...selection, execution: { ...selection.execution, __proto__: { unrelated: true } } },
    ])("rejects unrelated inherited envelope fields %#", (value) => {
      expect(() => decodeConversationAgentSelection(value)).toThrow();
    });
    it("excludes inherited opaque-input fields", () => {
      expect(
        decodeConversationAgentSelection({
          ...selection,
          execution: {
            ...selection.execution,
            agentInput: { allowedTool: "close_feedback", __proto__: { unrelated: true } },
          },
        }),
      ).toEqual(selection);
    });
  });
}

/**
 * A durable Runtime host on a controlled OpenAI Realtime provider, for one Conversation's
 * registered tests. Each Run starts the Conversation that `setup` selects; the host ends and
 * disposes every Run after each test.
 */
function durableRealtimeHost() {
  const resources: Array<{
    durable: ReturnType<typeof createTestDurableObjectContext>;
    controller: ReturnType<typeof createInterviewRuntimeController>;
    driver: ReturnType<typeof controllerDriver>;
    releaseInput(): void;
  }> = [];
  const liveAt = 1_700_000_000_000;
  function setup(
    options: Readonly<{
      questionCount?: number;
      /** Selects Original Realtime instead of Goodbye when no Question count is given. */
      original?: boolean;
      enforceSingleResponse?: boolean;
      holdQuestionAck?: "suppress" | "restore";
      holdCompletion?: boolean;
      skipMediaReady?: boolean;
      emptyFinalInput?: boolean;
      activeInputReplay?: boolean;
      holdCommittedInput?: boolean;
      holdInputCommit?: boolean;
      rejectInputCommit?: boolean;
      inputCommitItemId?: string;
    }> = {},
  ) {
    vi.useFakeTimers();
    vi.setSystemTime(liveAt);
    const durable = createTestDurableObjectContext();
    const listeners = new Map<string, Array<(event: ProviderSocketEvent) => void>>();
    const commands: Array<Record<string, z.output<ReturnType<typeof z.json>>>> = [];
    let activeNativeResponse: string | null = null;
    let effectiveInstructions = "";
    const heldQuestionAcks: Array<() => void> = [];
    const questionAcks: Array<ReturnType<typeof z.json>["_output"]> = [];
    let previousReplayItem = "opening-item";
    let replayCommitted = false;
    let releaseInput = () => {};
    let inputHeld = false;
    const settleReplayInput = (speechStopped = true) => {
      const previous = previousReplayItem;
      previousReplayItem = "answer";
      replayCommitted = true;
      if (speechStopped) emit({ type: "input_audio_buffer.speech_stopped", item_id: "answer" });
      emit({ type: "input_audio_buffer.committed", item_id: "answer", previous_item_id: previous });
      emit({
        type: "conversation.item.added",
        previous_item_id: previous,
        item: { id: "answer", type: "message", role: "user", status: "completed" },
      });
      emit({ type: "session.updated", session: { audio: { input: { turn_detection: null } } } });
    };
    const socket = {
      readyState: 1,
      accept() {},
      close() {},
      send(data: string) {
        const command = z.record(z.string(), z.json()).parse(JSON.parse(data));
        commands.push(command);
        if (options.enforceSingleResponse === true) {
          queueMicrotask(() => {
            if (
              command.type === "response.cancel" &&
              command.response_id === activeNativeResponse
            ) {
              const id = activeNativeResponse;
              activeNativeResponse = null;
              emit({ type: "response.done", response: { id, status: "cancelled", output: [] } });
            }
            if (command.type === "response.create" && activeNativeResponse !== null) {
              emit({
                type: "error",
                error: {
                  event_id: command.event_id,
                  code: "conversation_already_has_active_response",
                },
              });
            }
          });
        }
        if (
          command.type === "session.update" &&
          (options.holdCommittedInput !== true ||
            (typeof command.event_id === "string" && command.event_id.startsWith("evt_question_")))
        ) {
          const session = z
            .object({ instructions: z.string().optional(), audio: z.json() })
            .parse(command.session);
          effectiveInstructions = session.instructions ?? effectiveInstructions;
          const receipt = {
            type: "session.updated",
            event_id: `ack_${z.string().parse(command.event_id)}`,
            session: { ...session, instructions: effectiveInstructions },
          };
          const questionUpdate =
            typeof command.event_id === "string" && command.event_id.startsWith("evt_question_");
          if (questionUpdate) questionAcks.push(receipt);
          const hold =
            questionUpdate &&
            ((options.holdQuestionAck === "suppress" && session.instructions !== undefined) ||
              (options.holdQuestionAck === "restore" && session.instructions === undefined));
          if (hold) heldQuestionAcks.push(() => emit(receipt));
          else queueMicrotask(() => emit(receipt));
        }
        if (command.type === "input_audio_buffer.commit" && options.rejectInputCommit === true)
          queueMicrotask(() =>
            emit({
              type: "error",
              error: { event_id: command.event_id, code: "controlled_rejection" },
            }),
          );
        if (options.activeInputReplay === true) {
          if (
            command.type === "input_audio_buffer.commit" &&
            options.holdInputCommit !== true &&
            options.rejectInputCommit !== true
          ) {
            const itemId = replayCommitted
              ? "silent-tail"
              : (options.inputCommitItemId ?? "answer");
            const previous = previousReplayItem;
            previousReplayItem = itemId;
            replayCommitted = true;
            queueMicrotask(() => {
              emit({
                type: "input_audio_buffer.committed",
                item_id: itemId,
                previous_item_id: previous,
              });
              emit({
                type: "conversation.item.added",
                previous_item_id: previous,
                item: { id: itemId, type: "message", role: "user", status: "completed" },
              });
            });
          }
          if (
            command.type === "response.create" &&
            typeof command.response === "object" &&
            command.response !== null &&
            "metadata" in command.response
          ) {
            const previous = previousReplayItem;
            previousReplayItem = "closing-item";
            queueMicrotask(() => {
              emit({
                type: "response.created",
                response: {
                  id: "closing",
                  metadata:
                    command.response &&
                    typeof command.response === "object" &&
                    "metadata" in command.response
                      ? command.response.metadata
                      : null,
                },
              });
              emit({
                type: "conversation.item.added",
                previous_item_id: previous,
                item: {
                  id: "closing-item",
                  type: "message",
                  role: "assistant",
                  status: "in_progress",
                },
              });
            });
          }
        }
        if (options.emptyFinalInput === true && command.type === "input_audio_buffer.commit")
          queueMicrotask(() => {
            emit({ type: "input_audio_buffer.committed", item_id: "silent-tail" });
            emit({
              type: "conversation.item.input_audio_transcription.completed",
              item_id: "silent-tail",
              transcript: "",
            });
          });
      },
      addEventListener(type: string, listener: (event: ProviderSocketEvent) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
    };
    const provider = {
      createCall: vi.fn(async () =>
        providerSuccess({
          status: 201,
          answerSdp: "v=0\r\nanswer",
          responseContentType: "application/sdp",
          sessionId: "rtc_goodbye",
          sessionLocation: "https://api.openai.com/v1/realtime/calls/rtc_goodbye",
          upstreamRequestId: "req_goodbye",
        }),
      ),
      connectSideband: vi.fn(async () => providerSuccess(socket)),
      hangUp: vi.fn(async () => providerSuccess({ status: 204, upstreamRequestId: null })),
    };
    let admitCompletion: (() => Promise<void>) | undefined;
    const assembly = (controlled: RuntimeHostAssembly): RuntimeHostAssembly =>
      options.holdCompletion !== true && options.holdCommittedInput !== true
        ? controlled
        : {
            ...controlled,
            createSession(input, selection) {
              const holdSink =
                (sink: typeof input.sink): typeof input.sink =>
                async (fact) => {
                  if (
                    options.holdCommittedInput === true &&
                    fact.kind === "provider_observation" &&
                    fact.observation?.kind === "participant_answer_created" &&
                    fact.observation.itemId === "answer"
                  ) {
                    inputHeld = true;
                    await new Promise<void>((resolve) => {
                      releaseInput = resolve;
                    });
                  }
                  await sink(fact);
                };
              const issueSink = input.issueSink;
              let sessionInput = { ...input, sink: holdSink(input.sink) };
              if (issueSink !== undefined)
                sessionInput = {
                  ...sessionInput,
                  issueSink: (runId: string, generation: number) =>
                    holdSink(issueSink(runId, generation)),
                };
              const session = controlled.createSession(sessionInput, selection);
              return {
                ...session,
                get connected() {
                  return session.connected;
                },
                get connecting() {
                  return session.connecting;
                },
                enterNode(node, admission) {
                  if (options.holdCompletion !== true) {
                    session.enterNode?.(node, admission);
                    return;
                  }
                  session.enterNode?.(
                    {
                      ...node,
                      onComplete(report) {
                        return new Promise<void>((resolve, reject) => {
                          admitCompletion = () => node.onComplete(report).then(resolve, reject);
                        });
                      },
                    },
                    admission,
                  );
                },
              };
            },
          };
    const controller = createInterviewRuntimeController(
      durable.ctx,
      { OPENAI_API_KEY: "controlled" },
      provider,
      undefined,
      {},
      undefined,
      assembly,
    );
    const driver = controllerDriver(controller);
    const repository = new InterviewFinalizationRepository(
      createDurableObjectState(durable.ctx).storage,
    );
    const input =
      options.questionCount !== undefined
        ? sampleQuestionsInput(sampleQuestionPrompts.slice(0, options.questionCount), {
            interviewingDurationMs: 10_000,
          })
        : sampleGoodbyeInput({ interviewingDurationMs: 10_000 });
    const emit = <Event>(event: Event) => {
      if (options.enforceSingleResponse === true) {
        const receipt = z
          .object({
            type: z.string(),
            response: z.object({ id: z.string() }).optional(),
          })
          .parse(event);
        if (receipt.type === "response.created")
          activeNativeResponse = receipt.response?.id ?? null;
        if (receipt.type === "response.done" && receipt.response?.id === activeNativeResponse)
          activeNativeResponse = null;
      }
      for (const listener of listeners.get("message") ?? [])
        listener({ data: JSON.stringify(event) });
    };
    const start = async (accepted = input) => {
      const response = await driver.startConnection({
        runId: "goodbye-host",
        selection:
          options.questionCount !== undefined
            ? questionsRealtimeSelection
            : options.original === true
              ? originalRealtimeSelection
              : goodbyeRealtimeSelection,
        profile: "realtime-v1",
        connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
        createdAt: liveAt,
        execution: {
          agentInput:
            options.original === true
              ? createInterviewConversationInput(INTERVIEW_AGENT_INSTRUCTIONS, undefined, 60_000)
              : accepted,
        },
        diagnosticsContext: { surface: "lab" },
      });
      expect(response.status, JSON.stringify(response.data)).toBe(200);
      await vi.waitFor(async () =>
        expect(await driver.state()).toMatchObject({ state: { phase: "live" } }),
      );
      if (options.skipMediaReady !== true)
        expect((await driver.mediaReady({ runId: "goodbye-host" })).status).toBe(200);
    };
    const finish = async () => {
      emit({ type: "response.created", response: { id: "interview" } });
      emit({
        type: "response.function_call_arguments.done",
        response_id: "interview",
        call_id: "finish",
        name: "finish_interview",
        arguments: "{}",
      });
      emit({
        type: "response.done",
        response: {
          id: "interview",
          status: "completed",
          output: [
            { type: "function_call", name: "finish_interview", call_id: "finish", arguments: "{}" },
          ],
        },
      });
      await vi.waitFor(() =>
        expect(
          commands.some(
            (entry) =>
              entry.type === "response.create" &&
              typeof entry.response === "object" &&
              entry.response !== null &&
              "metadata" in entry.response,
          ),
        ).toBe(true),
      );
    };
    const closing = () => {
      const command = commands.find(
        (entry) =>
          entry.type === "response.create" &&
          typeof entry.response === "object" &&
          entry.response !== null &&
          "metadata" in entry.response,
      );
      if (
        command === undefined ||
        typeof command.response !== "object" ||
        command.response === null ||
        !("metadata" in command.response)
      )
        throw new Error("closing_command_missing");
      return command.response;
    };
    const complete = () => {
      const response = closing();
      emit({
        type: "response.done",
        response: {
          id: "closing",
          status: "completed",
          metadata: response.metadata,
          output: [
            {
              type: "message",
              id: "closing-item",
              role: "assistant",
              content: [{ type: "audio", transcript: "Thank you. Goodbye." }],
            },
          ],
        },
      });
      emit({ type: "output_audio_buffer.stopped", response_id: "closing" });
    };
    /**
     * The delivered closing has had time to play: once Runtime admitted its completion, the
     * margin passes and Runtime's alarm begins the Ending it waited for.
     */
    const played = async () => {
      await vi.waitFor(() =>
        expect(readRunView(repository).nodeExecution?.endingAt).toBeTypeOf("number"),
      );
      vi.setSystemTime(Date.now() + playbackMarginMs);
      await controller.alarm();
    };
    const harness = {
      durable,
      commands,
      provider,
      controller,
      driver,
      repository,
      input,
      emit,
      start,
      finish,
      closing,
      // The closing's session update, the answer to the call that started it, and its reply.
      closingEntry: () =>
        commands.filter(
          (command) =>
            (command.type === "session.update" &&
              typeof command.session === "object" &&
              command.session !== null &&
              "tool_choice" in command.session &&
              command.session.tool_choice === "none") ||
            command.type === "conversation.item.create" ||
            (command.type === "response.create" &&
              typeof command.response === "object" &&
              command.response !== null &&
              "metadata" in command.response),
        ),
      complete,
      played,
      settleReplayInput,
      questionAcks,
      questionUpdates: () =>
        commands.filter(
          (command) =>
            command.type === "session.update" &&
            typeof command.event_id === "string" &&
            command.event_id.startsWith("evt_question_") &&
            typeof command.session === "object" &&
            command.session !== null &&
            "instructions" in command.session,
        ),
      releaseQuestionAck: () => heldQuestionAcks.shift()?.(),
      inputHeld: () => inputHeld,
      releaseInput: () => releaseInput(),
      heldCompletion: () => admitCompletion,
    };
    resources.push(harness);
    return harness;
  }
  // The closing is bounded by its own deadline only: however long its report is held, the
  // closing reports nothing more, and Runtime's closing alarm decides the outcome.
  async function expectHeldReportDecidedByClosingAlarm(h: ReturnType<typeof setup>) {
    await h.start();
    await h.finish();
    h.complete();
    await vi.waitFor(() => expect(h.heldCompletion()).toBeTypeOf("function"));
    const cutoff = readRunView(h.repository).nodeExecution?.closingCutoffAt;
    if (cutoff === undefined) throw new Error("missing_closing_cutoff");
    // The participant stays present until the cutoff, so only the closing cutoff is due when the
    // alarm runs, after the former reporting deadline 10 seconds past it.
    for (const at of [Date.now() + 10_000, Date.now() + 20_000, Date.now() + 30_000, cutoff - 1]) {
      await vi.advanceTimersByTimeAsync(Math.min(at, cutoff - 1) - Date.now());
      expect((await h.driver.presence({ runId: "goodbye-host", mediaPresent: true })).status).toBe(
        200,
      );
    }
    await vi.advanceTimersByTimeAsync(cutoff + 10_001 - Date.now());
    expect(readRunView(h.repository).lifecycle.stage).toBe("live");
    expect(readRunView(h.repository).nodeExecution?.limitation).toBeUndefined();
    await h.controller.alarm();
    await vi.waitFor(() =>
      expect(readRunView(h.repository).nodeExecution).toMatchObject({
        limitation: "closing_cutoff_exhausted",
        dispatch: { status: "failed" },
      }),
    );
    await vi.waitFor(() =>
      expect(readRunView(h.repository).lifecycle).toMatchObject({
        stage: "ended",
        completion: { endReason: "agent_requested_end", warnings: ["closing_cutoff_exhausted"] },
      }),
    );
    // Releasing the stale report cannot replace the admitted limitation.
    await h.heldCompletion()?.();
    expect(readRunView(h.repository).nodeExecution?.limitation).toBe("closing_cutoff_exhausted");
  }
  afterEach(async () => {
    for (const h of resources.splice(0)) {
      h.releaseInput();
      await h.driver.complete({ runId: "goodbye-host", endReason: "participant_stopped" });
      await vi.advanceTimersByTimeAsync(70_000);
      await h.controller.alarm();
      await h.durable.flushWaitUntil();
      h.durable.close();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  return { liveAt, setup, expectHeldReportDecidedByClosingAlarm };
}

type DurableRealtimeHostRun = ReturnType<ReturnType<typeof durableRealtimeHost>["setup"]>;
/** The Run's retained Runtime tool-call records, decoded. */
const recordedToolCalls = (h: DurableRealtimeHostRun) =>
  readRuntimeDiagnosticRecords(h.durable)
    .filter((record) => record.type === "runtime.tool_call_handled")
    .map((record) => decodeRuntimeToolCallPayload(record.payloadJson));
const callTool = (
  h: DurableRealtimeHostRun,
  responseId: string,
  callId: string,
  name: string,
  metadata?: z.output<ReturnType<typeof z.json>>,
) => {
  h.emit({
    type: "response.created",
    response: metadata === undefined ? { id: responseId } : { id: responseId, metadata },
  });
  h.emit({
    type: "response.function_call_arguments.done",
    response_id: responseId,
    call_id: callId,
    name,
    arguments: "{}",
  });
  h.emit({
    type: "response.done",
    response: {
      id: responseId,
      status: "completed",
      output: [{ type: "function_call", name, call_id: callId, arguments: "{}" }],
    },
  });
};
/**
 * The interviewer's reply in the first step is still being generated when the interview
 * deadline starts the closing at `deadlineAt`, or when the participant presses Stop: its item,
 * its text and a late tool call reach Runtime only afterwards. The deadline's closing then
 * completes. Returns the first step's visit and the Run once ended.
 */
async function cutReply(h: DurableRealtimeHostRun, cut: "deadline" | "stop", deadlineAt: number) {
  await h.start();
  const step = readRunView(h.repository).visit;
  h.emit({ type: "response.created", response: { id: "cut-reply" } });
  await vi.waitFor(() =>
    expect(
      readRunView(h.repository).provider.responses.map(({ responseId }) => responseId),
    ).toContain("cut-reply"),
  );
  if (cut === "deadline") {
    vi.setSystemTime(deadlineAt);
    await h.controller.alarm();
    await vi.waitFor(() => expect(readRunView(h.repository).visit?.state).toBe("goodbye"));
  } else {
    expect(
      (await h.driver.complete({ runId: "goodbye-host", endReason: "participant_stopped" })).status,
    ).toBe(202);
  }
  const entered = readRunView(h.repository);
  h.emit({
    type: "conversation.item.added",
    item: { id: "cut-item", role: "assistant", type: "message", status: "in_progress" },
  });
  h.emit({
    type: "response.output_audio_transcript.done",
    response_id: "cut-reply",
    item_id: "cut-item",
    transcript: "What did you think of the",
  });
  h.emit({
    type: "response.function_call_arguments.done",
    response_id: "cut-reply",
    call_id: "late-finish",
    name: "finish_interview",
    arguments: "{}",
  });
  h.emit({
    type: "response.done",
    response: {
      id: "cut-reply",
      status: "cancelled",
      output: [
        { type: "message", id: "cut-item", role: "assistant", content: [{ type: "audio" }] },
      ],
    },
  });
  await vi.waitFor(() => expect(recordedToolCalls(h)).toHaveLength(1));
  // The late tool call changed neither the step nor its node.
  expect(readRunView(h.repository).visit).toEqual(entered.visit);
  expect(readRunView(h.repository).nodeExecution?.reservation).toEqual(
    entered.nodeExecution?.reservation,
  );
  if (cut === "deadline") {
    await vi.waitFor(() => expect(h.closing().metadata).toBeDefined());
    h.complete();
    await h.played();
  }
  await vi.waitFor(() => expect(readRunView(h.repository).lifecycle.stage).not.toBe("live"));
  await vi.advanceTimersByTimeAsync(15_000);
  await h.controller.alarm();
  await h.durable.flushWaitUntil();
  return { step, run: readRunView(h.repository) };
}
/** What the Run kept of the reply `cutReply` cut, and how it recorded the late tool call. */
async function cutReplyOutcome(
  h: DurableRealtimeHostRun,
  cut: "deadline" | "stop",
  deadlineAt: number,
) {
  const { step, run } = await cutReply(h, cut, deadlineAt);
  const item = run.transcript.items.find(({ itemId }) => itemId === "cut-item");
  return {
    turns: run.transcript.turns,
    // The step the kept item is filed under is the visit of the reply that produced it.
    itemStep: {
      responseId: item?.responseId,
      visitId: run.provider.responses.find(({ responseId }) => responseId === item?.responseId)
        ?.conversationScope?.visitId,
    },
    firstStep: { responseId: "cut-reply", visitId: step?.visitId },
    toolCalls: recordedToolCalls(h).map(({ toolCallId, state, outcome, ...record }) => ({
      toolCallId,
      state,
      outcome,
      reason: "reason" in record ? record.reason : undefined,
    })),
    endReason: run.lifecycle.stage === "ended" ? run.lifecycle.completion.endReason : null,
  };
}

/**
 * An interviewer reply that OpenAI ends as failed or cut short, or cancels without the session
 * asking, on each Realtime pair, through the durable Runtime host: the first reply of the
 * conversation or a later one. It ends the interview as interrupted on every pair (user's
 * decision, option A); a reply the session cancelled itself ends nothing.
 */
export function registerRealtimeReplyFailureTests(): void {
  const { setup } = durableRealtimeHost();
  const pairs = [
    { pair: "Original", options: { original: true } },
    { pair: "Goodbye", options: {} },
    { pair: "Questions", options: { questionCount: 2 } },
  ] as const;
  const cases = pairs.flatMap(({ pair, options }) =>
    (["failed", "incomplete", "cancelled"] as const).flatMap((status) =>
      (["first", "later"] as const).map((reply) => ({ pair, options, status, reply })),
    ),
  );

  describe("an interviewer reply OpenAI ends as failed or cut short", () => {
    it.each(cases)(
      "on $pair, a $status $reply reply ends the interview as interrupted",
      async ({ options, status, reply }) => {
        const h = setup(options);
        await h.start();
        const before = readRunRecordView(h.repository).providerEventCount;
        if (reply === "later") {
          h.emit({ type: "response.created", response: { id: "answered" } });
          h.emit({
            type: "response.done",
            response: { id: "answered", status: "completed", output: [] },
          });
        }
        h.emit({ type: "response.created", response: { id: "cut-short" } });
        h.emit({ type: "response.done", response: { id: "cut-short", status, output: [] } });
        await vi.waitFor(() =>
          expect(readRunRecordView(h.repository).providerEventCount).toBeGreaterThanOrEqual(
            before + (reply === "later" ? 4 : 2),
          ),
        );
        await vi.waitFor(() =>
          expect(readRunView(h.repository).lifecycle).toMatchObject({
            stage: "draining",
            endReason: "runtime_failed",
          }),
        );
        expect(readRunView(h.repository).visit?.state).toBe("interrupted");
        expect(
          readRuntimeDiagnosticRecords(h.durable).some(
            (record) =>
              record.type === "runtime.live_degraded" &&
              record.payloadJson.includes(`interviewer_response_${status}`),
          ),
        ).toBe(true);
      },
    );

    it("ends nothing when the reply was one the session cancelled itself", async () => {
      // Entering the next Question cancels an automatic reply created meanwhile.
      const h = setup({ questionCount: 2 });
      await h.start();
      callTool(h, "first-question", "advance", "next_question");
      await vi.waitFor(() => expect(h.questionUpdates()).toHaveLength(1));
      h.emit({ type: "response.created", response: { id: "automatic" } });
      await vi.waitFor(() =>
        expect(h.commands).toContainEqual({
          type: "response.cancel",
          event_id: "evt_question_late_automatic",
          response_id: "automatic",
        }),
      );
      h.emit({
        type: "response.done",
        response: { id: "automatic", status: "cancelled", output: [] },
      });
      await vi.waitFor(() =>
        expect(h.commands.filter((command) => command.type === "response.create")).toHaveLength(2),
      );
      expect(readRunView(h.repository).lifecycle.stage).toBe("live");
      expect(readRunView(h.repository).visit?.context).toEqual({
        questionIndex: 1,
        questionCount: 2,
      });
    });

    it("on Original, a reply Runtime cancels while finishing ends nothing", async () => {
      const h = setup({ original: true });
      await h.start();
      h.emit({ type: "response.created", response: { id: "interview" } });
      h.emit({
        type: "response.function_call_arguments.done",
        response_id: "interview",
        call_id: "finish",
        name: "finish_interview",
        arguments: "{}",
      });
      await vi.waitFor(() => expect(readRunView(h.repository).visit?.state).toBe("finishing"));
      // An automatic reply while the finishing reply plays: Runtime cancels it.
      h.emit({ type: "response.created", response: { id: "automatic" } });
      await vi.waitFor(() =>
        expect(h.commands).toContainEqual(
          expect.objectContaining({ type: "response.cancel", response_id: "automatic" }),
        ),
      );
      // The session hands receipts to Runtime one at a time: once the receipt after the
      // cancelled reply's end is saved, that end and anything reported after it were handled.
      const before = readRunRecordView(h.repository).providerEventCount;
      h.emit({
        type: "response.done",
        response: { id: "automatic", status: "cancelled", output: [] },
      });
      h.emit({ type: "rate_limits.updated", rate_limits: [] });
      await vi.waitFor(() =>
        expect(readRunRecordView(h.repository).providerEventCount).toBeGreaterThanOrEqual(
          before + 2,
        ),
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(readRunView(h.repository).lifecycle.stage).toBe("live");
      h.emit({
        type: "response.done",
        response: {
          id: "interview",
          status: "completed",
          output: [
            { type: "function_call", name: "finish_interview", call_id: "finish", arguments: "{}" },
          ],
        },
      });
      h.emit({ type: "output_audio_buffer.stopped", response_id: "interview" });
      await h.played();
      await vi.waitFor(() =>
        expect(readRunView(h.repository).lifecycle).toMatchObject({
          stage: "draining",
          endReason: "agent_requested_end",
        }),
      );
      expect(readRunView(h.repository).visit?.state).toBe("complete");
    });
  });

  describe("Stop while an interviewer reply is in progress", () => {
    it.each(pairs)("on $pair, Ending alone cancels the reply", async ({ options }) => {
      const h = setup(options);
      await h.start();
      h.emit({ type: "response.created", response: { id: "speaking" } });
      h.emit({ type: "output_audio_buffer.started", response_id: "speaking" });
      await vi.waitFor(() =>
        expect(
          readRunView(h.repository).provider.responses.map(({ responseId }) => responseId),
        ).toContain("speaking"),
      );
      expect(
        (await h.driver.complete({ runId: "goodbye-host", endReason: "participant_stopped" }))
          .status,
      ).toBe(202);
      await vi.advanceTimersByTimeAsync(1);
      const cancels = h.commands
        .filter(
          (command) =>
            command.type === "response.cancel" || command.type === "output_audio_buffer.clear",
        )
        .map((command) => ({
          type: command.type,
          kit: String(command.event_id).startsWith("evt_question_"),
        }));
      // Ending cancels the reply and clears its output on every pair. Outside a node's entry,
      // the kit's containment sends nothing of its own, and the cancelled reply is no failure.
      expect(cancels.filter(({ kit }) => kit)).toEqual([]);
      expect(cancels.map(({ type }) => type)).toEqual(
        expect.arrayContaining(["response.cancel", "output_audio_buffer.clear"]),
      );
      h.emit({
        type: "response.done",
        response: { id: "speaking", status: "cancelled", output: [] },
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(readRunView(h.repository).lifecycle).toMatchObject({
        endReason: "participant_stopped",
      });
    });
  });
}

export function registerOriginalRuntimeTests(): void {
  const { setup } = durableRealtimeHost();

  describe("Runtime tool-call records through the durable Runtime host", () => {
    it("records Original's finish as a transition to finishing", async () => {
      const h = setup({ original: true });
      await h.start();
      const interviewing = readRunView(h.repository).visit;
      callTool(h, "interview", "finish", "finish_interview");
      await vi.waitFor(() => expect(readRunView(h.repository).visit?.state).toBe("finishing"));
      await vi.waitFor(() => expect(recordedToolCalls(h)).toHaveLength(1));
      expect(recordedToolCalls(h)).toEqual([
        {
          toolName: "finish_interview",
          toolCallId: "finish",
          responseId: "interview",
          argumentsBytes: 2,
          state: "interviewing",
          visitId: interviewing?.visitId,
          operationId: interviewing?.operationId,
          outcome: "transitioned",
          to: "finishing",
        },
      ]);
    });
  });

  describe("Original's finishing reply through the durable Runtime host", () => {
    // Runtime releases the session six seconds into finishing; a reply delivered just before
    // that still plays out its margin: neither the release nor Ending cuts it.
    it("lets a finishing reply delivered before Runtime's cleanup play out its margin before Ending", async () => {
      const h = setup({ original: true });
      await h.start();
      callTool(h, "interview", "finish", "finish_interview");
      await vi.waitFor(() => expect(readRunView(h.repository).visit?.state).toBe("finishing"));
      const cleanupAt = readRunView(h.repository).nodeExecution?.cleanupAt ?? 0;
      vi.setSystemTime(cleanupAt - 500);
      h.emit({
        type: "response.done",
        response: {
          id: "interview",
          status: "completed",
          output: [
            { type: "function_call", name: "finish_interview", call_id: "finish", arguments: "{}" },
          ],
        },
      });
      h.emit({ type: "output_audio_buffer.stopped", response_id: "interview" });
      await vi.waitFor(() =>
        expect(readRunView(h.repository).nodeExecution?.endingAt).toBeTypeOf("number"),
      );
      const endingAt = readRunView(h.repository).nodeExecution?.endingAt ?? 0;
      expect(endingAt).toBeGreaterThan(cleanupAt);
      vi.setSystemTime(cleanupAt);
      await h.controller.alarm();
      await vi.advanceTimersByTimeAsync(0);
      expect(readRunView(h.repository).lifecycle.stage).toBe("live");
      expect(readRunView(h.repository).nodeExecution?.cleanupClaimed).toBe(false);
      expect(h.provider.hangUp).not.toHaveBeenCalled();
      vi.setSystemTime(endingAt);
      await h.controller.alarm();
      await vi.advanceTimersByTimeAsync(0);
      const lifecycle = readRunView(h.repository).lifecycle;
      expect(lifecycle.stage === "ended" ? lifecycle.completion : lifecycle).toMatchObject({
        endReason: "agent_requested_end",
        endingStartedAt: endingAt,
      });
    });
  });
}

export function registerQuestionsRuntimeTests(): void {
  const { liveAt, setup, expectHeldReportDecidedByClosingAlarm } = durableRealtimeHost();

  describe("Runtime tool-call records through the durable Runtime host", () => {
    it("records each Questions tool call once with the Question it was received in", async () => {
      const h = setup({ questionCount: 2 });
      await h.start();
      const first = readRunView(h.repository).visit;
      callTool(h, "first-question", "advance", "next_question");
      await vi.waitFor(() => expect(h.questionUpdates()).toHaveLength(1));
      const second = readRunView(h.repository).visit;
      callTool(h, "last-question", "advance-past-last", "next_question", h.closing().metadata);
      await vi.waitFor(() => expect(recordedToolCalls(h)).toHaveLength(2));
      expect(readRunView(h.repository).visit).toEqual(second);
      callTool(
        h,
        "last-question-finish",
        "finish-questions",
        "finish_interview",
        h.closing().metadata,
      );
      await vi.waitFor(() => expect(readRunView(h.repository).visit?.state).toBe("goodbye"));
      await vi.waitFor(() => expect(recordedToolCalls(h)).toHaveLength(3));
      expect(recordedToolCalls(h)).toEqual([
        {
          toolName: "next_question",
          toolCallId: "advance",
          responseId: "first-question",
          argumentsBytes: 2,
          state: "question",
          visitId: first?.visitId,
          operationId: first?.operationId,
          context: { questionIndex: 0, questionCount: 2 },
          outcome: "transitioned",
          to: "question",
        },
        {
          toolName: "next_question",
          toolCallId: "advance-past-last",
          responseId: "last-question",
          argumentsBytes: 2,
          state: "question",
          visitId: second?.visitId,
          operationId: second?.operationId,
          context: { questionIndex: 1, questionCount: 2 },
          outcome: "ignored",
          reason: "no_transition",
        },
        {
          toolName: "finish_interview",
          toolCallId: "finish-questions",
          responseId: "last-question-finish",
          argumentsBytes: 2,
          state: "question",
          visitId: second?.visitId,
          operationId: second?.operationId,
          context: { questionIndex: 1, questionCount: 2 },
          outcome: "transitioned",
          to: "goodbye",
        },
      ]);
    });
  });

  describe("registered Questions through the durable Runtime host", () => {
    it.each(["empty", "tools", "goodbye"] as const)(
      "rejects invalid %s Question input before provider acquisition",
      async (invalid) => {
        const h = setup({ questionCount: 2 });
        const accepted = sampleQuestionsInput(sampleQuestionPrompts, {
          interviewingDurationMs: 10_000,
        });
        const input =
          invalid === "empty"
            ? { ...accepted, questions: [] }
            : invalid === "tools"
              ? {
                  ...accepted,
                  questions: [
                    {
                      instructions: { kind: "literal", text: sampleQuestionPrompts.at(0) ?? "" },
                      toolDescriptions: { finish_interview: sampleFinishDescription },
                    },
                  ],
                }
              : { ...accepted, goodbye: { closingSentence: 42 } };
        const result = await h.driver.startConnection({
          runId: "goodbye-host",
          selection: questionsRealtimeSelection,
          profile: "realtime-v1",
          connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
          createdAt: liveAt,
          execution: { agentInput: input },
        });
        expect(result.status).toBeGreaterThanOrEqual(400);
        expect(findRunRecordView(h.repository)).toBeNull();
        expect(h.provider.createCall).not.toHaveBeenCalled();
        expect(h.provider.connectSideband).not.toHaveBeenCalled();
      },
    );
    it.each(["before_settlement", "after_settlement", "other_command", "failed_goodbye"] as const)(
      "keeps cancellation acknowledgements scoped during final Question handoff (%s)",
      async (receipt) => {
        const h = setup({ questionCount: 2, holdCommittedInput: true });
        await h.start();
        h.emit({ type: "response.created", response: { id: "first-question-finish" } });
        h.emit({
          type: "response.function_call_arguments.done",
          response_id: "first-question-finish",
          call_id: "advance-first-question",
          name: "next_question",
          arguments: "{}",
        });
        h.emit({
          type: "response.done",
          response: { id: "first-question-finish", status: "completed", output: [] },
        });
        await vi.waitFor(() => expect(h.questionUpdates()).toHaveLength(1));
        h.emit({
          type: "response.created",
          response: { id: "final-question-finish", metadata: h.closing().metadata },
        });
        h.emit({
          type: "response.function_call_arguments.done",
          response_id: "final-question-finish",
          call_id: "finish-questions",
          name: "finish_interview",
          arguments: "{}",
        });
        await vi.waitFor(() =>
          expect(
            h.commands.filter(
              (command) =>
                command.type === "session.update" &&
                typeof command.session === "object" &&
                command.session !== null &&
                typeof command.event_id === "string" &&
                !command.event_id.startsWith("evt_question_"),
            ),
          ).toHaveLength(1),
        );
        const cancellation = h.commands.find(
          (command) =>
            command.type === "response.cancel" &&
            typeof command.event_id === "string" &&
            command.event_id.startsWith("evt_goodbye_"),
        );
        expect(cancellation?.response_id).toBe("final-question-finish");
        const acknowledgeCancellation = () =>
          h.emit({
            type: "error",
            error: { event_id: cancellation?.event_id, code: "response_cancel_not_active" },
          });
        if (receipt === "before_settlement") {
          acknowledgeCancellation();
          h.emit({
            type: "error",
            error: {
              event_id: "evt_goodbye_retired_cancel_old",
              code: "response_cancel_not_active",
            },
          });
          await vi.advanceTimersByTimeAsync(1);
          expect(readRunView(h.repository).lifecycle.stage).toBe("live");
          expect(
            h.commands.filter(
              (command) => command.type === "response.create" && command.response !== undefined,
            ),
          ).toHaveLength(1);
        }
        h.emit({
          type: "response.done",
          response: {
            id: "final-question-finish",
            status: "completed",
            output: [
              {
                type: "function_call",
                name: "finish_interview",
                call_id: "finish-questions",
                arguments: "{}",
              },
            ],
          },
        });
        h.emit({
          type: "session.updated",
          session: { audio: { input: { turn_detection: null } } },
        });
        await vi.waitFor(() =>
          expect(
            h.commands.filter(
              (command) => command.type === "response.create" && command.response !== undefined,
            ),
          ).toHaveLength(2),
        );
        const command = h.commands.filter((entry) => entry.type === "response.create").at(-1);
        if (command === undefined) throw new Error("missing_goodbye_command");
        const response = command.response;
        if (response === null || typeof response !== "object" || !("metadata" in response))
          throw new Error("missing_goodbye_response");
        if (receipt === "other_command")
          h.emit({
            type: "error",
            error: { event_id: command.event_id, code: "response_cancel_not_active" },
          });
        else if (receipt !== "before_settlement") acknowledgeCancellation();
        h.emit({
          type: "response.created",
          response: { id: "normal-goodbye", metadata: response.metadata },
        });
        h.emit({
          type: "response.done",
          response: {
            id: "normal-goodbye",
            status: receipt === "failed_goodbye" ? "failed" : "completed",
            metadata: response.metadata,
            output: [
              {
                type: "message",
                id: "goodbye-item",
                role: "assistant",
                content: [{ type: "audio", transcript: "Thank you. Goodbye." }],
              },
            ],
          },
        });
        h.emit({ type: "output_audio_buffer.stopped", response_id: "normal-goodbye" });
        // A closing that failed gets no wait for its playback.
        if (receipt !== "other_command" && receipt !== "failed_goodbye") await h.played();
        await vi.waitFor(() => expect(readRunView(h.repository).lifecycle.stage).not.toBe("live"));
        expect(readRunView(h.repository).visit?.state).toBe(
          receipt === "other_command" || receipt === "failed_goodbye" ? "interrupted" : "complete",
        );
      },
    );
    it("leaves a Goodbye report still held past the closing deadline to Runtime's closing alarm", async () => {
      await expectHeldReportDecidedByClosingAlarm(
        setup({ questionCount: 1, holdCompletion: true }),
      );
    });
    it("finishes early through Goodbye without exposing the second prompt", async () => {
      const h = setup({ questionCount: 2 });
      await h.start();
      expect(
        z
          .array(
            z.object({
              session: z.object({
                instructions: z.object({ kind: z.literal("literal"), text: z.string() }),
              }),
            }),
          )
          .parse(h.provider.createCall.mock.calls.at(0))[0]?.session.instructions,
      ).toEqual({ kind: "literal", text: sampleQuestionPrompts[0] });
      await h.finish();
      expect(readRunView(h.repository).visit?.state).toBe("goodbye");
      expect(h.questionUpdates()).toHaveLength(0);
      h.complete();
      await h.played();
      await vi.waitFor(() =>
        expect(readRunView(h.repository).lifecycle).toMatchObject({
          stage: "ended",
          completion: { endReason: "agent_requested_end" },
        }),
      );
    });
    it.each(["before_settlement", "after_replacement"])(
      "keeps automatic responses during Question handoff under the old visit (%s)",
      async (stage) => {
        const h = setup({ questionCount: 2 });
        await h.start();
        const first = readRunView(h.repository).visit;
        h.emit({ type: "response.created", response: { id: "handoff-first" } });
        h.emit({
          type: "response.function_call_arguments.done",
          response_id: "handoff-first",
          call_id: "handoff-next",
          name: "next_question",
          arguments: "{}",
        });
        await vi.waitFor(() =>
          expect(readRunView(h.repository).visit?.context).toEqual({
            questionIndex: 1,
            questionCount: 2,
          }),
        );
        const second = readRunView(h.repository).visit;
        expect(h.questionUpdates()).toHaveLength(0);
        if (stage === "after_replacement") {
          h.emit({
            type: "response.done",
            response: { id: "handoff-first", status: "completed", output: [] },
          });
          await vi.waitFor(() => expect(h.questionUpdates()).toHaveLength(1));
        }
        h.emit({ type: "response.created", response: { id: "old-automatic" } });
        h.emit({
          type: "response.function_call_arguments.done",
          response_id: "old-automatic",
          call_id: "old-finish",
          name: "finish_interview",
          arguments: "{}",
        });
        h.emit({
          type: "response.done",
          response: { id: "old-automatic", status: "completed", output: [] },
        });
        await vi.waitFor(() =>
          expect(
            readRunView(h.repository).provider.responses.find(
              (response) => response.responseId === "old-automatic",
            )?.status,
          ).toBe("completed"),
        );
        expect(readRunView(h.repository).visit).toEqual(second);
        expect(
          readRunView(h.repository).provider.responses.find(
            (response) => response.responseId === "old-automatic",
          )?.conversationScope,
        ).toMatchObject({ visitId: first?.visitId, operationId: first?.operationId });
        h.emit({
          type: "response.done",
          response: { id: "handoff-first", status: "completed", output: [] },
        });
        await vi.waitFor(() => expect(h.questionUpdates()).toHaveLength(1));
        h.emit({
          type: "response.created",
          response: { id: "second-owned", metadata: h.closing().metadata },
        });
        h.emit({
          type: "response.function_call_arguments.done",
          response_id: "second-owned",
          call_id: "second-finish",
          name: "finish_interview",
          arguments: "{}",
        });
        h.emit({
          type: "response.done",
          response: { id: "second-owned", status: "completed", output: [] },
        });
        await vi.waitFor(() => expect(readRunView(h.repository).visit?.state).toBe("goodbye"));
      },
    );

    it("contains active old automatic output before requesting the next Question", async () => {
      const h = setup({ questionCount: 2, enforceSingleResponse: true });
      await h.start();
      h.emit({ type: "response.created", response: { id: "first-native" } });
      h.emit({
        type: "response.function_call_arguments.done",
        response_id: "first-native",
        call_id: "advance-native",
        name: "next_question",
        arguments: "{}",
      });
      await vi.waitFor(() =>
        expect(readRunView(h.repository).visit?.context).toEqual({
          questionIndex: 1,
          questionCount: 2,
        }),
      );
      h.emit({
        type: "response.done",
        response: { id: "first-native", status: "completed", output: [] },
      });
      h.emit({ type: "response.created", response: { id: "old-automatic-active" } });
      h.emit({ type: "output_audio_buffer.started", response_id: "old-automatic-active" });
      await vi.waitFor(() => expect(h.questionUpdates()).toHaveLength(1));
      await vi.waitFor(() =>
        expect(readRunRecordView(h.repository).providerEventCount).toBeGreaterThanOrEqual(7),
      );
      expect(readRunView(h.repository).lifecycle.stage).toBe("live");
      expect(h.commands).toContainEqual({
        type: "response.cancel",
        event_id: "evt_question_late_old-automatic-active",
        response_id: "old-automatic-active",
      });
      h.emit({
        type: "response.created",
        response: { id: "second-native", metadata: h.closing().metadata },
      });
      h.emit({
        type: "response.function_call_arguments.done",
        response_id: "second-native",
        call_id: "finish-native",
        name: "finish_interview",
        arguments: "{}",
      });
      h.emit({
        type: "response.done",
        response: { id: "second-native", status: "completed", output: [] },
      });
      await vi.waitFor(() => expect(readRunView(h.repository).visit?.state).toBe("goodbye"));
    });

    it.each([
      ["suppress", "stop"],
      ["restore", "stop"],
      ["suppress", "deadline"],
      ["restore", "deadline"],
    ] as const)("fences a pending %s acknowledgement on %s", async (phase, cause) => {
      const h = setup({ questionCount: 2, holdQuestionAck: phase });
      await h.start();
      h.emit({ type: "response.created", response: { id: "pending-ack-q1" } });
      h.emit({
        type: "response.function_call_arguments.done",
        response_id: "pending-ack-q1",
        call_id: "pending-ack-next",
        name: "next_question",
        arguments: "{}",
      });
      h.emit({
        type: "response.done",
        response: { id: "pending-ack-q1", status: "completed", output: [] },
      });
      await vi.waitFor(() => expect(h.questionAcks).toHaveLength(1));
      if (phase === "restore") {
        await vi.waitFor(() =>
          expect(
            h.commands.filter(
              (command) => command.type === "response.create" && command.response !== undefined,
            ),
          ).toHaveLength(1),
        );
        h.emit({
          type: "response.created",
          response: { id: "pending-ack-q2", metadata: h.closing().metadata },
        });
        await vi.waitFor(() => expect(h.questionAcks).toHaveLength(2));
      } else
        expect(
          h.commands.filter(
            (command) => command.type === "response.create" && command.response !== undefined,
          ),
        ).toHaveLength(0);
      if (cause === "stop") {
        expect(
          (await h.driver.complete({ runId: "goodbye-host", endReason: "participant_stopped" }))
            .status,
        ).toBe(202);
        expect(readRunView(h.repository).visit?.state).toBe("complete");
      } else {
        await vi.advanceTimersByTimeAsync(10_001);
        await h.controller.alarm();
        expect(readRunView(h.repository).visit?.state).toBe("goodbye");
        expect(readRunView(h.repository).nodeExecution?.reservation?.reason).toBe(
          "timebox_reached",
        );
      }
      const ownedCommands = () =>
        h.commands.filter(
          (command) =>
            typeof command.event_id === "string" && command.event_id.startsWith("evt_question_"),
        );
      const before = [...ownedCommands()];
      h.releaseQuestionAck();
      await vi.advanceTimersByTimeAsync(1);
      expect(ownedCommands()).toEqual(before);
      expect(readRunView(h.repository).visit?.state).toBe(
        cause === "stop" ? "complete" : "goodbye",
      );
      await vi.advanceTimersByTimeAsync(45_001);
      expect(readRunView(h.repository).lifecycle.stage).not.toBe("live");
    });

    it("waits for every old response after suppression before creating the next Question", async () => {
      const h = setup({ questionCount: 2, holdQuestionAck: "suppress" });
      await h.start();
      h.emit({ type: "response.created", response: { id: "settlement-q1" } });
      h.emit({
        type: "response.function_call_arguments.done",
        response_id: "settlement-q1",
        call_id: "settlement-next",
        name: "next_question",
        arguments: "{}",
      });
      h.emit({
        type: "response.done",
        response: { id: "settlement-q1", status: "completed", output: [] },
      });
      await vi.waitFor(() => expect(h.questionAcks).toHaveLength(1));
      h.emit({ type: "response.created", response: { id: "old-unsettled-one" } });
      h.emit({ type: "response.created", response: { id: "old-unsettled-two" } });
      h.releaseQuestionAck();
      await vi.advanceTimersByTimeAsync(1);
      const requested = () =>
        h.commands.filter(
          (command) => command.type === "response.create" && command.response !== undefined,
        );
      expect(requested()).toHaveLength(0);
      h.emit({
        type: "response.done",
        response: { id: "old-unsettled-one", status: "cancelled", output: [] },
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(requested()).toHaveLength(0);
      h.emit({
        type: "response.done",
        response: { id: "old-unsettled-two", status: "cancelled", output: [] },
      });
      await vi.waitFor(() => expect(requested()).toHaveLength(1));
      expect(readRunView(h.repository).lifecycle.stage).toBe("live");
    });

    it.each(["stop", "deadline"] as const)(
      "does not restore automatic output when %s wins before correlated creation",
      async (cause) => {
        const h = setup({ questionCount: 2 });
        await h.start();
        h.emit({ type: "response.created", response: { id: "creation-q1" } });
        h.emit({
          type: "response.function_call_arguments.done",
          response_id: "creation-q1",
          call_id: "creation-next",
          name: "next_question",
          arguments: "{}",
        });
        h.emit({
          type: "response.done",
          response: { id: "creation-q1", status: "completed", output: [] },
        });
        await vi.waitFor(() =>
          expect(
            h.commands.filter(
              (command) => command.type === "response.create" && command.response !== undefined,
            ),
          ).toHaveLength(1),
        );
        const response = h.closing();
        if (cause === "stop")
          await h.driver.complete({ runId: "goodbye-host", endReason: "participant_stopped" });
        else {
          await vi.advanceTimersByTimeAsync(10_001);
          await h.controller.alarm();
        }
        const visit = readRunView(h.repository).visit;
        h.emit({
          type: "response.created",
          response: { id: "late-correlated-question", metadata: response.metadata },
        });
        await vi.advanceTimersByTimeAsync(1);
        expect(
          h.commands.filter(
            (command) =>
              typeof command.event_id === "string" && command.event_id.endsWith("_restore"),
          ),
        ).toHaveLength(0);
        expect(readRunView(h.repository).visit).toEqual(visit);
        expect(h.commands).toContainEqual(
          expect.objectContaining({
            type: "response.cancel",
            response_id: "late-correlated-question",
          }),
        );
      },
    );

    it("does not acknowledge a fresh identical Question with an earlier configuration replay", async () => {
      const h = setup({ questionCount: 3, holdQuestionAck: "suppress" });
      await h.start(
        sampleQuestionsInput([...sampleQuestionPrompts, ...sampleQuestionPrompts.slice(1)], {
          interviewingDurationMs: 10_000,
        }),
      );
      const advance = (id: string) => {
        h.emit({
          type: "response.function_call_arguments.done",
          response_id: id,
          call_id: id,
          name: "next_question",
          arguments: "{}",
        });
        h.emit({ type: "response.done", response: { id, status: "completed", output: [] } });
      };
      h.emit({ type: "response.created", response: { id: "ack-replay-first" } });
      advance("ack-replay-first");
      await vi.waitFor(() => expect(h.questionAcks).toHaveLength(1));
      const previous = h.questionAcks[0];
      h.releaseQuestionAck();
      const requests = () =>
        h.commands.filter(
          (command) => command.type === "response.create" && command.response !== undefined,
        );
      await vi.waitFor(() => expect(requests()).toHaveLength(1));
      h.emit({
        type: "response.created",
        response: { id: "ack-replay-second", metadata: h.closing().metadata },
      });
      await vi.waitFor(() => expect(h.questionAcks).toHaveLength(2));
      advance("ack-replay-second");
      await vi.waitFor(() => expect(h.questionAcks).toHaveLength(3));
      h.emit(previous);
      await vi.advanceTimersByTimeAsync(1);
      expect(requests()).toHaveLength(1);
      h.releaseQuestionAck();
      await vi.waitFor(() => expect(requests()).toHaveLength(2));
      expect(readRunView(h.repository).visit?.context).toEqual({
        questionIndex: 2,
        questionCount: 3,
      });
    });

    it("does not clear current Question audio when settled response creation is replayed", async () => {
      const h = setup({ questionCount: 3 });
      await h.start(
        sampleQuestionsInput([...sampleQuestionPrompts, ...sampleQuestionPrompts.slice(1)], {
          interviewingDurationMs: 10_000,
        }),
      );
      const advance = (id: string) => {
        h.emit({
          type: "response.function_call_arguments.done",
          response_id: id,
          call_id: id,
          name: "next_question",
          arguments: "{}",
        });
        h.emit({ type: "response.done", response: { id, status: "completed", output: [] } });
      };
      h.emit({ type: "response.created", response: { id: "replay-first" } });
      advance("replay-first");
      await vi.waitFor(() => expect(h.questionUpdates()).toHaveLength(1));
      const secondCreated = {
        type: "response.created",
        event_id: "second-created",
        response: { id: "replay-second", metadata: h.closing().metadata },
      };
      h.emit(secondCreated);
      h.emit({ type: "output_audio_buffer.started", response_id: "replay-second" });
      advance("replay-second");
      await vi.waitFor(() => expect(h.questionUpdates()).toHaveLength(2));
      h.emit({ type: "output_audio_buffer.stopped", response_id: "replay-second" });
      h.emit({
        type: "response.created",
        response: {
          id: "playing-third",
          metadata: {
            runtime_operation_id: readRunView(h.repository).visit?.operationId,
          },
        },
      });
      h.emit({ type: "output_audio_buffer.started", response_id: "playing-third" });
      await vi.waitFor(() =>
        expect(
          readRunView(h.repository).provider.responses.find(
            (response) => response.responseId === "playing-third",
          ),
        ).toMatchObject({ status: "active", outputAudio: "active" }),
      );
      // Only the speech of the reply that moved to the third Question was cut.
      expect(h.commands.filter((command) => command.type === "output_audio_buffer.clear")).toEqual([
        {
          type: "output_audio_buffer.clear",
          event_id: "evt_question_late_output_replay-second",
        },
      ]);
      const commandsBeforeReplay = [...h.commands];
      const third = readRunView(h.repository).visit;
      h.emit(secondCreated);
      h.emit({ type: "output_audio_buffer.started", response_id: "replay-second" });
      await vi.advanceTimersByTimeAsync(1);
      expect(h.commands).toEqual(commandsBeforeReplay);
      expect(readRunView(h.repository).visit).toEqual(third);
    });

    it("admits immediate Stop while Question entry waits for the previous response", async () => {
      const h = setup({ questionCount: 2 });
      await h.start();
      h.emit({ type: "response.created", response: { id: "held-q1" } });
      h.emit({
        type: "response.function_call_arguments.done",
        response_id: "held-q1",
        call_id: "held-next",
        name: "next_question",
        arguments: "{}",
      });
      await vi.waitFor(() =>
        expect(readRunView(h.repository).nodeExecution?.dispatch?.status).toBe("claimed"),
      );
      const stopped = await h.driver.complete({
        runId: "goodbye-host",
        endReason: "participant_stopped",
      });
      expect(stopped.status).toBe(202);
      expect(readRunView(h.repository).visit?.state).toBe("complete");
      h.emit({
        type: "response.done",
        response: { id: "held-q1", status: "completed", output: [] },
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(
        h.commands.filter(
          (command) => command.type === "response.create" && command.response !== undefined,
        ),
      ).toHaveLength(0);
    });
    // The reply that calls next_question is still playing when it ends.
    const moveWhilePlaying = async (h: DurableRealtimeHostRun) => {
      await h.start();
      h.emit({ type: "response.created", response: { id: "moving-q1" } });
      h.emit({ type: "output_audio_buffer.started", response_id: "moving-q1" });
      h.emit({
        type: "response.function_call_arguments.done",
        response_id: "moving-q1",
        call_id: "moving-next",
        name: "next_question",
        arguments: "{}",
      });
      h.emit({ type: "response.done", response: { id: "moving-q1", status: "completed" } });
      await vi.waitFor(() => expect(h.questionAcks).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(1);
    };
    const questionEntry = (h: DurableRealtimeHostRun) =>
      h.commands
        .filter(
          (command) =>
            command.type === "output_audio_buffer.clear" ||
            command.type === "conversation.item.create" ||
            (command.type === "response.create" && command.response !== undefined),
        )
        .map((command) => command.type);

    it("cuts the speech of the reply that moves to the next Question at once, then requests it", async () => {
      const h = setup({ questionCount: 2 });
      await moveWhilePlaying(h);
      // No playback stop is awaited: the cut, the answer to the call and the Question's reply.
      await vi.waitFor(() => expect(questionEntry(h)).toContain("response.create"));
      expect(questionEntry(h)).toEqual([
        "output_audio_buffer.clear",
        "conversation.item.create",
        "response.create",
      ]);
      // The answer to the call follows the cut, so the next reply does not read the cut speech
      // as the conversation's latest turn.
      expect(h.commands.find((command) => command.type === "output_audio_buffer.clear")).toEqual({
        type: "output_audio_buffer.clear",
        event_id: "evt_question_late_output_moving-q1",
      });
      expect(
        readRuntimeDiagnosticRecords(h.durable)
          .filter((record) => record.type === "realtime.reply_cut")
          .map((record) => z.record(z.string(), z.json()).parse(JSON.parse(record.payloadJson))),
      ).toMatchObject([
        { source: "realtime_execution", provider: "openai_realtime", responseId: "moving-q1" },
      ]);
      expect(readRunView(h.repository).lifecycle).toMatchObject({ stage: "live" });
    });

    // The report belongs to the Question the reply moved on from.
    it("does not end the Run when Runtime cannot save a report of the reply that moved to the next Question", async () => {
      const h = setup({ questionCount: 2 });
      await moveWhilePlaying(h);
      await vi.waitFor(() => expect(questionEntry(h)).toContain("response.create"));
      const sql = h.durable.storage.sql;
      const exec = sql.exec.bind(sql);
      let failNextReportSave = false;
      vi.spyOn(sql, "exec").mockImplementation((query, ...params) => {
        if (failNextReportSave && query.includes("SET session_event_count")) {
          failNextReportSave = false;
          throw new Error("report_save_failed");
        }
        return exec(query, ...params);
      });
      failNextReportSave = true;
      // OpenAI's answer to the cut of that reply's speech.
      h.emit({ type: "output_audio_buffer.cleared", response_id: "moving-q1" });
      await vi.advanceTimersByTimeAsync(1);
      expect(failNextReportSave).toBe(false);
      expect(questionEntry(h)).toEqual([
        "output_audio_buffer.clear",
        "conversation.item.create",
        "response.create",
      ]);
      expect(readRunView(h.repository).lifecycle).toMatchObject({ stage: "live" });
    });

    // The entry cut by the deadline reports nothing: until Runtime's alarm delivers its own
    // expiry, the Run stays in the Question it was entering.
    it("stops quietly when the shared deadline passes before the reply that moves to the next Question settled, and enters Goodbye through Runtime's expiry", async () => {
      const h = setup({ questionCount: 2 });
      await h.start();
      h.emit({ type: "response.created", response: { id: "moving-q1" } });
      h.emit({ type: "output_audio_buffer.started", response_id: "moving-q1" });
      h.emit({
        type: "response.function_call_arguments.done",
        response_id: "moving-q1",
        call_id: "moving-next",
        name: "next_question",
        arguments: "{}",
      });
      await vi.waitFor(() =>
        expect(readRunView(h.repository).nodeExecution?.dispatch?.status).toBe("claimed"),
      );
      await vi.advanceTimersByTimeAsync(10_001);
      expect(readRunView(h.repository).visit?.state).toBe("question");
      expect(readRunView(h.repository).lifecycle.stage).toBe("live");
      await h.controller.alarm();
      expect(readRunView(h.repository).visit?.state).toBe("goodbye");
      expect(readRunView(h.repository).nodeExecution?.reservation?.reason).toBe("timebox_reached");
      expect(
        h.commands.some(
          (command) =>
            command.type === "response.create" &&
            typeof command.event_id === "string" &&
            command.event_id.startsWith("evt_question_"),
        ),
      ).toBe(false);
      // Goodbye's closing waits for that reply to settle.
      h.emit({ type: "response.done", response: { id: "moving-q1", status: "completed" } });
      await vi.waitFor(() => expect(h.closingEntry().at(-1)?.type).toBe("response.create"));
      h.complete();
      await h.played();
      await vi.waitFor(() =>
        expect(readRunView(h.repository).lifecycle).toMatchObject({
          stage: "ended",
          completion: { endReason: "timebox_reached", warnings: [] },
        }),
      );
    });
    // A reply cut by the deadline's closing keeps its text, as Stop keeps it.
    it.each(["deadline", "stop"] as const)(
      "keeps the text of a reply cut by the closing under its own step (%s)",
      async (cut) => {
        const outcome = await cutReplyOutcome(setup({ questionCount: 2 }), cut, liveAt + 10_001);
        const kept = { role: "conversationAgent", text: "What did you think of the" };
        // The kept text is filed under the step whose reply produced it.
        expect(outcome.itemStep).toEqual(outcome.firstStep);
        if (cut === "deadline") {
          expect(outcome.turns).toEqual([
            kept,
            { role: "conversationAgent", text: "Thank you. Goodbye." },
          ]);
          // The cut reply's late tool call stays refused.
          expect(outcome.toolCalls).toEqual([
            {
              toolCallId: "late-finish",
              state: "goodbye",
              outcome: "ignored",
              reason: "out_of_scope",
            },
          ]);
          expect(outcome.endReason).toBe("timebox_reached");
        } else {
          expect(outcome.turns).toEqual([kept]);
          expect(outcome.endReason).toBe("participant_stopped");
        }
      },
    );
    it.each([1, 2])(
      "retains caller prompts, advances once, and bounds a %s-question run",
      async (count) => {
        const h = setup({ questionCount: count });
        await h.start();
        const initial = readRunView(h.repository).visit;
        expect(initial?.context).toEqual({ questionIndex: 0, questionCount: count });
        const accepted = h.provider.createCall.mock.calls;
        expect(accepted).toHaveLength(1);
        h.emit({ type: "response.created", response: { id: "q1" } });
        h.emit({
          type: "response.function_call_arguments.done",
          response_id: "q1",
          call_id: "advance-1",
          name: "next_question",
          arguments: "{}",
        });
        h.emit({ type: "response.done", response: { id: "q1", status: "completed", output: [] } });
        await vi.waitFor(() =>
          expect(
            readRunView(h.repository).provider.responses.some(
              (response) => response.responseId === "q1" && response.status === "completed",
            ),
          ).toBe(true),
        );
        if (count === 1) {
          expect(readRunView(h.repository).visit).toEqual(initial);
          expect(h.questionUpdates()).toHaveLength(0);
          return;
        }
        await vi.waitFor(() => expect(h.questionUpdates()).toHaveLength(1));
        const q2 = readRunView(h.repository);
        expect(q2.visit?.context).toEqual({ questionIndex: 1, questionCount: 2 });
        expect(q2.visit?.operationId).not.toBe(initial?.operationId);
        expect(q2.visit?.visitId).not.toBe(initial?.visitId);
        expect(q2.nodeExecution?.timers).toEqual([
          {
            id: "interviewing",
            deadlineAt: liveAt + 10_000,
            event: { kind: "interview_time_elapsed" },
          },
        ]);
        expect(h.commands.find((command) => command.type === "session.update")).toMatchObject({
          session: { instructions: sampleQuestionPrompts[1] },
        });
        expect(
          h.commands.find((command) => command.type === "conversation.item.create"),
        ).toMatchObject({ item: { call_id: "advance-1", output: "{}" } });
        expect(q2.finalInput).toBeNull();
        expect(q2.nodeExecution).toMatchObject({ reservation: undefined });
        h.emit({
          type: "response.function_call_arguments.done",
          response_id: "q1",
          call_id: "advance-1",
          name: "next_question",
          arguments: "{}",
        });
        h.emit({ type: "session.updated", session: { instructions: sampleQuestionPrompts[0] } });
        await vi.waitFor(() =>
          expect(readRunRecordView(h.repository).providerEventCount).toBeGreaterThanOrEqual(5),
        );
        expect(readRunView(h.repository).visit).toEqual(q2.visit);
        expect(h.questionUpdates()).toHaveLength(1);
        expect(h.provider.createCall).toHaveBeenCalledOnce();
        expect(h.provider.connectSideband).toHaveBeenCalledOnce();
        vi.setSystemTime(liveAt + 10_001);
        await h.controller.alarm();
        expect(readRunView(h.repository).visit?.state).toBe("goodbye");
        expect(readRunView(h.repository).nodeExecution?.closingCutoffAt).toBe(liveAt + 55_001);
        // Each step change interrupts the work of the step it leaves: no execution failed.
        await vi.advanceTimersByTimeAsync(0);
        expect(
          readRuntimeDiagnosticRecords(h.durable).filter(
            (record) => record.type === "runtime.execution_exit",
          ),
        ).toEqual([]);
      },
    );
    it("contains a late requested Question response under its original visit without granting it new control", async () => {
      const h = setup({ questionCount: 3 });
      await h.start(
        sampleQuestionsInput([...sampleQuestionPrompts, ...sampleQuestionPrompts.slice(1)], {
          interviewingDurationMs: 10_000,
        }),
      );
      const advance = (id: string, correlated = false) => {
        h.emit({
          type: "response.created",
          response: { id, metadata: correlated ? h.closing().metadata : undefined },
        });
        h.emit({
          type: "response.function_call_arguments.done",
          response_id: id,
          call_id: id,
          name: "next_question",
          arguments: "{}",
        });
        h.emit({ type: "response.done", response: { id, status: "completed", output: [] } });
      };
      advance("advance-first");
      await vi.waitFor(() => expect(h.questionUpdates()).toHaveLength(1));
      const second = readRunView(h.repository).visit;
      const delayed = h.closing();
      advance("advance-second", true);
      await vi.waitFor(() => expect(h.questionUpdates()).toHaveLength(2));
      const third = readRunView(h.repository).visit;
      h.emit({
        type: "response.created",
        response: { id: "delayed-second", metadata: delayed.metadata },
      });
      h.emit({
        type: "response.function_call_arguments.done",
        response_id: "delayed-second",
        call_id: "stale-finish",
        name: "finish_interview",
        arguments: "{}",
      });
      h.emit({
        type: "response.done",
        response: { id: "delayed-second", status: "failed", output: [] },
      });
      await vi.waitFor(() =>
        expect(readRunRecordView(h.repository).providerEventCount).toBeGreaterThanOrEqual(9),
      );
      const run = readRunView(h.repository);
      expect(run.visit).toEqual(third);
      expect(run.visit?.context).toEqual({ questionIndex: 2, questionCount: 3 });
      expect(
        run.provider.responses.find((response) => response.responseId === "delayed-second")
          ?.conversationScope,
      ).toMatchObject({ visitId: second?.visitId, operationId: second?.operationId });
      expect(h.commands).toContainEqual({
        type: "response.cancel",
        event_id: "evt_question_late_delayed-second",
        response_id: "delayed-second",
      });
      expect(run.retainedInterviewerResponseId).toBeUndefined();
    });

    it("binds Question command rejection to the issuing visit", async () => {
      const h = setup({ questionCount: 2 });
      await h.start();
      h.emit({ type: "response.created", response: { id: "question-error-owner" } });
      h.emit({
        type: "response.function_call_arguments.done",
        response_id: "question-error-owner",
        call_id: "next-error-owner",
        name: "next_question",
        arguments: "{}",
      });
      h.emit({
        type: "response.done",
        response: { id: "question-error-owner", status: "completed", output: [] },
      });
      await vi.waitFor(() => expect(h.questionUpdates()).toHaveLength(1));
      const current = readRunView(h.repository).visit;
      h.emit({
        type: "error",
        error: { event_id: "evt_question_retired_update", code: "controlled_rejection" },
      });
      h.emit({ type: "response.created", response: { id: "question-error-owner" } });
      h.emit({
        type: "response.done",
        response: { id: "question-error-owner", status: "failed", output: [] },
      });
      await vi.waitFor(() =>
        expect(readRunRecordView(h.repository).providerEventCount).toBeGreaterThanOrEqual(5),
      );
      expect(readRunView(h.repository).visit).toEqual(current);
      const update = h.commands.find((command) => command.type === "session.update");
      h.emit({
        type: "error",
        error: { event_id: update?.event_id, code: "controlled_rejection" },
      });
      await vi.waitFor(() =>
        expect(readRunView(h.repository).lifecycle).toMatchObject({
          stage: "draining",
          endReason: "runtime_failed",
        }),
      );
      expect(readRunView(h.repository).visit?.state).toBe("interrupted");
    });

    it.each(["initial", "later"])(
      "interrupts when the current %s Question response fails",
      async (visit) => {
        const h = setup({ questionCount: 2 });
        await h.start();
        if (visit === "later") {
          h.emit({ type: "response.created", response: { id: "first-question" } });
          h.emit({
            type: "response.function_call_arguments.done",
            response_id: "first-question",
            call_id: "advance-question",
            name: "next_question",
            arguments: "{}",
          });
          h.emit({
            type: "response.done",
            response: { id: "first-question", status: "completed", output: [] },
          });
          await vi.waitFor(() => expect(h.questionUpdates()).toHaveLength(1));
        }
        const response = visit === "later" ? h.closing() : {};
        h.emit({
          type: "response.created",
          response: {
            id: "failed-question",
            metadata: "metadata" in response ? response.metadata : undefined,
          },
        });
        h.emit({
          type: "response.done",
          response: { id: "failed-question", status: "failed", output: [] },
        });
        await vi.waitFor(() =>
          expect(readRunView(h.repository).lifecycle).toMatchObject({
            stage: "draining",
            endReason: "runtime_failed",
          }),
        );
        expect(readRunView(h.repository).visit?.state).toBe("interrupted");
      },
    );

    it("enters bounded Goodbye when the shared deadline expires during a held Question handoff", async () => {
      const h = setup({ questionCount: 2 });
      await h.start();
      h.emit({ type: "response.created", response: { id: "held-question" } });
      h.emit({
        type: "response.function_call_arguments.done",
        response_id: "held-question",
        call_id: "held-advance",
        name: "next_question",
        arguments: "{}",
      });
      await vi.waitFor(() =>
        expect(readRunView(h.repository).nodeExecution?.dispatch?.status).toBe("claimed"),
      );
      await vi.advanceTimersByTimeAsync(10_001);
      await h.controller.alarm();
      expect(readRunView(h.repository).visit?.state).toBe("goodbye");
      expect(readRunView(h.repository).lifecycle.stage).toBe("live");
      expect(readRunView(h.repository).nodeExecution?.reservation?.reason).toBe("timebox_reached");
    });

    it("does not dispatch a claimed Question entry again after reconstruction", async () => {
      const h = setup({ questionCount: 2 });
      await h.start();
      h.emit({ type: "response.created", response: { id: "q1-held" } });
      h.emit({
        type: "response.function_call_arguments.done",
        response_id: "q1-held",
        call_id: "advance-held",
        name: "next_question",
        arguments: "{}",
      });
      await vi.waitFor(() =>
        expect(readRunView(h.repository).nodeExecution?.dispatch?.status).toBe("claimed"),
      );
      expect(h.questionUpdates()).toHaveLength(0);
      const restored = createInterviewRuntimeController(
        h.durable.ctx,
        { OPENAI_API_KEY: "controlled" },
        h.provider,
      );
      await restored.alarm();
      expect(readRunView(h.repository).visit?.context).toEqual({
        questionIndex: 1,
        questionCount: 2,
      });
      expect(readRunView(h.repository).lifecycle).toMatchObject({
        stage: "draining",
        endReason: "runtime_failed",
      });
      h.emit({
        type: "response.done",
        response: { id: "q1-held", status: "completed", output: [] },
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(h.questionUpdates()).toHaveLength(0);
      expect(h.provider.createCall).toHaveBeenCalledOnce();
    });
  });
}

export function registerGoodbyeRuntimeTests(): void {
  const { liveAt, setup, expectHeldReportDecidedByClosingAlarm } = durableRealtimeHost();

  describe("Runtime tool-call records through the durable Runtime host", () => {
    it("records Goodbye's finish as a transition and an unknown tool as rejected", async () => {
      const h = setup();
      await h.start();
      const interviewing = readRunView(h.repository).visit;
      callTool(h, "lookup", "lookup-call", "lookup_weather");
      await vi.waitFor(() => expect(recordedToolCalls(h)).toHaveLength(1));
      expect(readRunView(h.repository).visit).toEqual(interviewing);
      await h.finish();
      await vi.waitFor(() => expect(recordedToolCalls(h)).toHaveLength(2));
      expect(
        recordedToolCalls(h).map(({ toolName, toolCallId, state, visitId, ...outcome }) => ({
          toolName,
          toolCallId,
          state,
          visitId,
          outcome: "to" in outcome ? outcome.to : outcome.reason,
        })),
      ).toEqual([
        {
          toolName: "lookup_weather",
          toolCallId: "lookup-call",
          state: "interviewing",
          visitId: interviewing?.visitId,
          outcome: "unknown_tool",
        },
        {
          toolName: "finish_interview",
          toolCallId: "finish",
          state: "interviewing",
          visitId: interviewing?.visitId,
          outcome: "goodbye",
        },
      ]);
      expect(recordedToolCalls(h).map((entry) => entry.outcome)).toEqual([
        "rejected",
        "transitioned",
      ]);
    });

    it("records a call without its identities as rejected", async () => {
      const h = setup();
      await h.start();
      h.emit({ type: "response.created", response: { id: "anonymous" } });
      h.emit({
        type: "response.function_call_arguments.done",
        response_id: "anonymous",
        name: "finish_interview",
        arguments: '{"reason":"done"}',
      });
      await vi.waitFor(() => expect(recordedToolCalls(h)).toHaveLength(1));
      expect(recordedToolCalls(h)).toMatchObject([
        {
          toolName: "finish_interview",
          toolCallId: null,
          responseId: "anonymous",
          argumentsBytes: 17,
          state: "interviewing",
          outcome: "rejected",
          reason: "undecodable",
        },
      ]);
    });
  });

  describe("registered Goodbye through the durable Runtime host", () => {
    it.each(["answer", "manual-answer"])(
      "retains the spoken order when expiry commits an active input as %s",
      async (itemId) => {
        const h = setup({ activeInputReplay: true, inputCommitItemId: itemId });
        await h.start();
        h.emit({
          type: "conversation.item.added",
          item: { id: "opening-item", role: "assistant", type: "message", status: "completed" },
        });
        h.emit({
          type: "response.output_audio_transcript.done",
          response_id: "opening",
          item_id: "opening-item",
          transcript: "Welcome. What worked well at the event?",
        });
        h.emit({ type: "input_audio_buffer.speech_started", item_id: "answer" });
        await vi.waitFor(() =>
          expect(readRunView(h.repository).execution).toMatchObject({ inputBuffered: true }),
        );
        vi.setSystemTime(liveAt + 10_001);
        h.emit({ type: "input_audio_buffer.speech_started", item_id: "late-after-expiry" });
        await h.controller.alarm();
        await vi.waitFor(() =>
          expect(h.commands.find((command) => command.type === "session.update")).toMatchObject({
            session: {
              audio: {
                input: {
                  turn_detection: null,
                },
              },
            },
          }),
        );
        await vi.waitFor(() => expect(h.closing().metadata).toBeDefined());
        h.complete();
        await h.played();
        await vi.waitFor(() => expect(readRunView(h.repository).lifecycle.stage).not.toBe("live"));
        h.emit({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: itemId,
          transcript: "The talks were clear and the room was quiet.",
        });
        await vi.waitFor(() =>
          expect(readRunView(h.repository).transcriptProof?.obligations).toContainEqual({
            itemId,
            role: "participant",
            status: "captured",
          }),
        );
        await vi.advanceTimersByTimeAsync(15_000);
        await h.controller.alarm();
        await h.durable.flushWaitUntil();
        expect(readRunView(h.repository).transcript.turns).toEqual([
          { role: "conversationAgent", text: "Welcome. What worked well at the event?" },
          { role: "participant", text: "The talks were clear and the room was quiet." },
          { role: "conversationAgent", text: "Thank you. Goodbye." },
        ]);
        expect(
          h.commands.filter((command) => command.type === "input_audio_buffer.commit"),
        ).toHaveLength(1);
      },
    );
    // The reply that called finish_interview already finished when the closing cancels it at
    // Goodbye entry: that cancel crosses the reply's end in transit and draws "not active". The
    // reply's audio still plays when Ending starts, but OpenAI already reported its end, so
    // Ending's step sends no second cancel (#1060).
    it("cancels a finished reply only at the closing's entry, not again for Ending", async () => {
      const h = setup();
      await h.start();
      h.emit({ type: "response.created", response: { id: "interview" } });
      h.emit({ type: "output_audio_buffer.started", response_id: "interview" });
      h.emit({
        type: "response.function_call_arguments.done",
        response_id: "interview",
        call_id: "finish",
        name: "finish_interview",
        arguments: "{}",
      });
      const cancels = () =>
        h.commands.filter(
          (command) => command.type === "response.cancel" && command.response_id === "interview",
        );
      await vi.waitFor(() => expect(cancels()).toHaveLength(1));
      h.emit({
        type: "response.done",
        response: {
          id: "interview",
          status: "completed",
          output: [
            {
              type: "function_call",
              name: "finish_interview",
              call_id: "finish",
              arguments: "{}",
            },
          ],
        },
      });
      h.emit({
        type: "error",
        error: { event_id: cancels()[0]?.event_id, code: "response_cancel_not_active" },
      });
      await vi.waitFor(() => expect(h.closing().metadata).toBeDefined());
      h.complete();
      await h.played();
      await vi.waitFor(() =>
        expect(readRunView(h.repository).effects).toContainEqual(
          expect.objectContaining({
            kind: "cancel_reply",
            responseId: "interview",
            status: "dispatched",
          }),
        ),
      );
      expect(cancels()).toHaveLength(1);
      h.emit({ type: "output_audio_buffer.cleared", response_id: "interview" });
      await vi.advanceTimersByTimeAsync(15_000);
      await h.controller.alarm();
      await h.durable.flushWaitUntil();
      expect(readRunView(h.repository).lifecycle).toMatchObject({
        stage: "ended",
        completion: { endReason: "agent_requested_end", warnings: [] },
      });
      expect(
        readRuntimeDiagnosticRecords(h.durable).filter(
          (record) => record.type === "runtime.live_degraded",
        ),
      ).toEqual([]);
    });
    // Ending cancels a reply that still generates when the participant presses Stop, and the
    // reply's end crosses that cancel in transit.
    it.each([
      {
        answer: "response_cancel_not_active",
        step: { status: "dispatched", acceptance: "benign_rejection" },
        degraded: [],
      },
      {
        answer: "controlled_cancel_failure",
        step: { status: "failed", acceptance: "rejected" },
        degraded: ["controlled_cancel_failure"],
      },
    ])(
      "records Ending's cancel of a reply that ended in transit as nothing to cancel, not a degradation ($answer)",
      async ({ answer, step, degraded }) => {
        const h = setup();
        await h.start();
        h.emit({ type: "response.created", response: { id: "interview" } });
        h.emit({ type: "output_audio_buffer.started", response_id: "interview" });
        await h.driver.complete({ runId: "goodbye-host", endReason: "participant_stopped" });
        const cancels = () =>
          h.commands.filter(
            (command) => command.type === "response.cancel" && command.response_id === "interview",
          );
        await vi.waitFor(() => expect(cancels()).toHaveLength(1));
        const ending = cancels()[0];
        h.emit({
          type: "response.done",
          response: { id: "interview", status: "completed", output: [] },
        });
        h.emit({ type: "error", error: { event_id: ending?.event_id, code: answer } });
        await vi.waitFor(() =>
          expect(
            readRunView(h.repository).effects.find((effect) => effect.id === ending?.event_id),
          ).toMatchObject({ kind: "cancel_reply", ...step }),
        );
        h.emit({ type: "output_audio_buffer.cleared", response_id: "interview" });
        await vi.advanceTimersByTimeAsync(15_000);
        await h.controller.alarm();
        await h.durable.flushWaitUntil();
        expect(readRunView(h.repository).lifecycle).toMatchObject({
          stage: "ended",
          completion: { endReason: "participant_stopped" },
        });
        expect(
          readRuntimeDiagnosticRecords(h.durable)
            .filter((record) => record.type === "runtime.live_degraded")
            .map(
              (record) => z.object({ code: z.string() }).parse(JSON.parse(record.payloadJson)).code,
            ),
        ).toEqual(degraded);
      },
    );
    it("keeps post-Interviewing input evidence-only without dirtying or interrupting Goodbye", async () => {
      const h = setup({ emptyFinalInput: true });
      await h.start();
      h.emit({ type: "input_audio_buffer.speech_started", item_id: "answer" });
      h.emit({ type: "input_audio_buffer.committed", item_id: "answer" });
      await vi.waitFor(() =>
        expect(readRunView(h.repository)).toMatchObject({
          lifecycle: { activeInputItemId: "answer" },
          execution: { inputBuffered: false },
        }),
      );
      h.emit({
        type: "conversation.item.added",
        item: {
          id: "answer",
          role: "user",
          type: "message",
          status: "completed",
        },
      });
      await h.finish();
      h.emit({ type: "input_audio_buffer.speech_started", item_id: "late-answer" });
      h.emit({ type: "input_audio_buffer.committed", item_id: "late-answer" });
      h.emit({
        type: "conversation.item.added",
        item: {
          id: "late-answer",
          role: "user",
          type: "message",
          status: "completed",
        },
      });
      h.emit({
        type: "conversation.item.input_audio_transcription.failed",
        item_id: "late-answer",
      });
      h.emit({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "late-answer",
        transcript: "Ignored microphone tail",
        usage: {
          type: "tokens",
          total_tokens: 7,
          input_tokens: 5,
          output_tokens: 2,
          input_token_details: { audio_tokens: 5, text_tokens: 0 },
        },
      });
      await vi.waitFor(() =>
        expect(readRunView(h.repository).usage).toMatchObject({
          observations: [
            { model: "gpt-4o-mini-transcribe", measure: "input_audio", quantity: 5 },
            { model: "gpt-4o-mini-transcribe", measure: "output_text", quantity: 2 },
          ],
        }),
      );
      expect(readRunView(h.repository)).toMatchObject({
        lifecycle: { stage: "live", activeInputItemId: "answer" },
        execution: { inputBuffered: false },
      });
      expect(readRunView(h.repository).transcriptProof?.obligations).not.toContainEqual(
        expect.objectContaining({ itemId: "late-answer" }),
      );
      h.complete();
      await h.played();
      await vi.waitFor(() => expect(readRunView(h.repository).lifecycle.stage).not.toBe("live"));
      h.emit({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "answer",
        transcript: "The talks were clear and the room was quiet.",
      });
      await vi.waitFor(() =>
        expect(readRunView(h.repository).transcriptProof?.obligations).toContainEqual({
          itemId: "answer",
          role: "participant",
          status: "captured",
        }),
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await h.controller.alarm();
      await h.durable.flushWaitUntil();
      const frozen = readRunView(h.repository);
      expect(frozen.transcriptProof?.result).toMatchObject({
        reason: "agent_requested_end",
        transcriptCompleteness: "complete",
        transcriptIncompleteReasons: [],
      });
      expect(frozen.transcript.turns).toEqual([
        { role: "participant", text: "The talks were clear and the room was quiet." },
        { role: "conversationAgent", text: "Thank you. Goodbye." },
      ]);
      expect(h.commands.filter((command) => command.type === "input_audio_buffer.commit")).toEqual(
        [],
      );
    });
    it("does not manufacture a failed participant transcript from silent input after successful closing", async () => {
      const h = setup({ emptyFinalInput: true });
      await h.start();
      h.emit({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "answer",
        transcript: "The talks were clear and the room was quiet.",
      });
      await h.finish();
      h.complete();
      await h.played();
      await vi.waitFor(() => expect(readRunView(h.repository).lifecycle.stage).not.toBe("live"));
      const endingView = readRunView(h.repository);
      // The closing took over the input closure and found no answer to commit.
      const commit = endingView.effects.find((effect) => effect.kind === "close_input");
      expect(commit).toMatchObject({
        status: "dispatched",
        attemptCount: 1,
        acceptance: "unobserved",
      });
      expect(endingView.finalInput?.obligation).toBe("settled");
      expect(h.commands.filter((command) => command.type === "input_audio_buffer.commit")).toEqual(
        [],
      );
      // Persistence encoding: the settled input closure round-trips and invalid variants are
      // refused.
      const ending = h.repository.readAggregate();
      const persistedCommit = ending.state.effects.find((effect) => effect.kind === "close_input");
      expect(decodeInterviewFinalizationAggregate(JSON.stringify(ending))).toEqual(ending);
      for (const invalid of [
        { kind: "discard_later_input" },
        { status: "skipped" },
        { heldItemId: "" },
        { heldItemId: undefined },
      ]) {
        expect(
          decodeInterviewFinalizationAggregate(
            JSON.stringify({
              ...ending,
              state: {
                ...ending.state,
                effects: ending.state.effects.map((effect) =>
                  effect.id === persistedCommit?.id ? { ...effect, ...invalid } : effect,
                ),
              },
            }),
          ),
        ).toBeNull();
      }
      expect(
        decodeInterviewFinalizationAggregate(
          JSON.stringify({
            ...ending,
            conversationNodeExecution: {
              ...ending.conversationNodeExecution,
              dispatch: { ...ending.conversationNodeExecution?.dispatch, status: "claimed" },
            },
          }),
        ),
      ).toBeNull();
      await vi.advanceTimersByTimeAsync(15_000);
      await h.controller.alarm();
      await h.durable.flushWaitUntil();
      const frozen = readRunView(h.repository);
      expect(frozen.transcriptProof?.result).toMatchObject({
        transcriptCompleteness: "complete",
        transcriptIncompleteReasons: [],
      });
      const persistedFrozen = h.repository.readAggregate();
      expect(decodeInterviewFinalizationAggregate(JSON.stringify(persistedFrozen))).toEqual(
        persistedFrozen,
      );
      expect(frozen.effects.filter((effect) => effect.kind === "close_input")).toEqual([commit]);
      expect(h.commands.filter((command) => command.type === "input_audio_buffer.commit")).toEqual(
        [],
      );
    });
    it.each([true, false])(
      "waits for an already committed participant item without committing another silent item (transcript available: %s)",
      async (transcriptAvailable) => {
        const h = setup({ emptyFinalInput: true });
        await h.start();
        h.emit({ type: "input_audio_buffer.speech_started", item_id: "answer" });
        await vi.waitFor(() =>
          expect(readRunView(h.repository).execution).toMatchObject({ inputBuffered: true }),
        );
        h.emit({ type: "input_audio_buffer.committed", item_id: "answer" });
        await vi.waitFor(() =>
          expect(readRunView(h.repository).execution).toMatchObject({ inputBuffered: false }),
        );
        await h.finish();
        h.complete();
        await h.played();
        await vi.waitFor(() => expect(readRunView(h.repository).lifecycle.stage).not.toBe("live"));
        expect(
          h.commands.filter((command) => command.type === "input_audio_buffer.commit"),
        ).toEqual([]);
        expect(readRunView(h.repository).finalInput).toMatchObject({
          admittedItemId: "answer",
          obligation: "awaiting_transcription",
        });
        if (transcriptAvailable) {
          h.emit({
            type: "conversation.item.input_audio_transcription.completed",
            item_id: "answer",
            transcript: "The talks were clear and the room was quiet.",
          });
          await vi.waitFor(() =>
            expect(readRunView(h.repository).transcriptProof?.obligations).toContainEqual({
              itemId: "answer",
              role: "participant",
              status: "captured",
            }),
          );
        }
        await vi.advanceTimersByTimeAsync(15_000);
        await h.controller.alarm();
        await h.durable.flushWaitUntil();
        expect(readRunView(h.repository).transcriptProof?.result).toMatchObject({
          transcriptCompleteness: transcriptAvailable ? "complete" : "incomplete",
          transcriptIncompleteReasons: transcriptAvailable
            ? []
            : [{ kind: "eligible_transcript_item_pending", itemId: "answer", role: "participant" }],
        });
      },
    );
    it("persists an already received input before duplicate End and an alarm can finalize Goodbye", async () => {
      const h = setup({ activeInputReplay: true, holdCommittedInput: true });
      await h.start();
      h.emit({ type: "input_audio_buffer.speech_started", item_id: "answer" });
      await vi.waitFor(() =>
        expect(readRunView(h.repository).execution).toMatchObject({ inputBuffered: true }),
      );
      vi.setSystemTime(liveAt + 10_001);
      await h.controller.alarm();
      await vi.waitFor(() =>
        expect(h.commands).toContainEqual(expect.objectContaining({ type: "session.update" })),
      );
      h.settleReplayInput(false);
      h.emit({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "answer",
        transcript: "The talks were clear and the room was quiet.",
        usage: {
          type: "tokens",
          total_tokens: 7,
          input_tokens: 5,
          output_tokens: 2,
          input_token_details: { audio_tokens: 5, text_tokens: 0 },
        },
      });
      await vi.waitFor(() => expect(h.inputHeld()).toBe(true));
      await vi.waitFor(() => expect(h.closing().metadata).toBeDefined());
      vi.setSystemTime(liveAt + 11_000);
      const firstEnd = h.driver.complete({
        runId: "goodbye-host",
        endReason: "participant_stopped",
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() =>
        expect(readRunView(h.repository).nodeExecution).toMatchObject({
          limitation: "closing_interrupted",
          dispatch: { status: "failed" },
        }),
      );
      // Persistence encoding: the held state round-trips and invalid participant ends are refused.
      const held = h.repository.readAggregate();
      expect(decodeInterviewFinalizationAggregate(JSON.stringify(held))).toEqual(held);
      for (const participantEnd of [
        { at: -1, source: "browser_request" },
        { at: liveAt + 11_000, source: "" },
        { at: liveAt + 55_000, source: "browser_request" },
      ])
        expect(
          decodeInterviewFinalizationAggregate(
            JSON.stringify({
              ...held,
              conversationNodeExecution: { ...held.conversationNodeExecution, participantEnd },
            }),
          ),
        ).toBeNull();
      const duplicateEnd = h.driver.complete({
        runId: "goodbye-host",
        endReason: "participant_stopped",
      });
      // A held native prefix cannot extend Stop's accepted finalization cutoff.
      vi.setSystemTime(liveAt + 15_000);
      await h.controller.alarm();
      expect(readRunView(h.repository).lifecycle.stage).toBe("draining");
      expect((await firstEnd).status).toBe(202);
      expect(h.commands.filter((command) => command.type === "input_audio_buffer.commit")).toEqual(
        [],
      );
      h.releaseInput();
      await Promise.all([firstEnd, duplicateEnd]);
      await vi.waitFor(() =>
        expect(readRunView(h.repository).transcriptProof?.obligations).toContainEqual(
          expect.objectContaining({ itemId: "answer", status: "captured" }),
        ),
      );
      vi.setSystemTime(liveAt + 21_000);
      await h.controller.alarm();
      await h.durable.flushWaitUntil();
      const final = readRunView(h.repository);
      expect(final.lifecycle).toMatchObject({
        stage: "ended",
        completion: {
          endReason: "timebox_reached",
          endedAt: liveAt + 11_000,
          finalizationCutoffAt: liveAt + 21_000,
        },
      });
      expect(final.transcriptProof?.result).toMatchObject({
        // End interrupted the native closing response before its final inventory.
        transcriptCompleteness: "incomplete",
        transcriptIncompleteReasons: [{ kind: "conversation_evidence_gap" }],
      });
      expect(final.transcriptProof?.result?.runtimeUsage?.observations).toEqual(
        expect.arrayContaining([
          {
            componentRole: "speech_to_text",
            provider: "openai",
            model: "gpt-4o-mini-transcribe",
            measure: "input_audio",
            unit: "token",
            quantity: 5,
          },
          {
            componentRole: "speech_to_text",
            provider: "openai",
            model: "gpt-4o-mini-transcribe",
            measure: "output_text",
            unit: "token",
            quantity: 2,
          },
        ]),
      );
      expect(final.usage?.pending).not.toContainEqual(
        expect.objectContaining({ key: "speech_to_text:answer" }),
      );
      const persistedFinal = h.repository.readAggregate();
      expect(decodeInterviewFinalizationAggregate(JSON.stringify(persistedFinal))).toEqual(
        persistedFinal,
      );
      expect(
        decodeInterviewFinalizationAggregate(
          JSON.stringify({
            ...persistedFinal,
            conversationNodeExecution: {
              ...persistedFinal.conversationNodeExecution,
              participantEnd: { at: liveAt + 11_001, source: "browser_request" },
            },
          }),
        ),
      ).toBeNull();
      expect(final.transcript.turns).toEqual([
        { role: "participant", text: "The talks were clear and the room was quiet." },
      ]);
      expect(h.commands.filter((command) => command.type === "input_audio_buffer.commit")).toEqual(
        [],
      );
    });
    it("bounds a stalled received-input handoff at the first End budget without dispatching a silent commit", async () => {
      const h = setup({ activeInputReplay: true, holdCommittedInput: true });
      await h.start();
      h.emit({ type: "input_audio_buffer.speech_started", item_id: "answer" });
      await vi.waitFor(() =>
        expect(readRunView(h.repository).execution).toMatchObject({ inputBuffered: true }),
      );
      vi.setSystemTime(liveAt + 10_001);
      await h.controller.alarm();
      await vi.waitFor(() =>
        expect(h.commands).toContainEqual(expect.objectContaining({ type: "session.update" })),
      );
      h.settleReplayInput(false);
      await vi.waitFor(() => expect(h.inputHeld()).toBe(true));
      await vi.waitFor(() => expect(h.closing().metadata).toBeDefined());
      vi.setSystemTime(liveAt + 11_000);
      const ending = h.driver.complete({ runId: "goodbye-host", endReason: "participant_stopped" });
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() =>
        expect(readRunView(h.repository).nodeExecution?.dispatch?.status).toBe("failed"),
      );
      await vi.advanceTimersByTimeAsync(10_001);
      await ending;
      await h.controller.alarm();
      const frozen = readRunView(h.repository);
      expect(frozen.lifecycle).toMatchObject({
        stage: "ended",
        completion: {
          endReason: "timebox_reached",
          endedAt: liveAt + 11_000,
          finalizationCutoffAt: liveAt + 21_000,
        },
      });
      expect(frozen.transcriptProof?.result).toMatchObject({
        transcriptCompleteness: "incomplete",
        transcriptIncompleteReasons: [
          { kind: "conversation_evidence_gap" },
          { kind: "eligible_transcript_item_pending", itemId: "answer", role: "participant" },
        ],
      });
      expect(h.commands.filter((command) => command.type === "input_audio_buffer.commit")).toEqual(
        [],
      );
      h.releaseInput();
      await h.durable.flushWaitUntil();
      expect(readRunView(h.repository).persistedState).toEqual(frozen.persistedState);
    });
    it.each(
      ["expiry", "stop"].flatMap((cause) => [true, false].map((speaking) => ({ cause, speaking }))),
    )(
      "preserves new buffered speech and older late text across $cause (speaking: $speaking)",
      async ({ cause, speaking }) => {
        const h = setup({ activeInputReplay: true, holdInputCommit: true });
        await h.start();
        h.emit({ type: "input_audio_buffer.committed", item_id: "older" });
        h.emit({
          type: "conversation.item.added",
          item: { id: "older", type: "message", role: "user", status: "completed" },
        });
        h.emit({ type: "input_audio_buffer.speech_started", item_id: "answer" });
        // The kit keeps the uncommitted speech as it arrives; Runtime holds the older item.
        expect(readRunView(h.repository).execution).toMatchObject({ inputBuffered: true });
        await vi.waitFor(() =>
          expect(readRunView(h.repository).transcriptProof?.obligations).toContainEqual({
            itemId: "older",
            role: "participant",
            status: "pending",
          }),
        );
        // Speech that stopped without a commit is still the participant's uncommitted answer.
        if (!speaking) h.emit({ type: "input_audio_buffer.speech_stopped", item_id: "answer" });
        // A repeated receipt for the earlier turn cannot consume this buffer.
        h.emit({ type: "input_audio_buffer.committed", item_id: "older" });
        if (cause === "expiry") {
          vi.setSystemTime(liveAt + 10_001);
          await h.controller.alarm();
        } else await h.driver.complete({ runId: "goodbye-host", endReason: "participant_stopped" });
        await vi.waitFor(() =>
          expect(
            h.commands.filter((command) => command.type === "input_audio_buffer.commit"),
          ).toHaveLength(1),
        );
        h.emit({
          type: "input_audio_buffer.committed",
          item_id: "manual-answer",
          previous_item_id: "older",
        });
        h.emit({
          type: "conversation.item.added",
          previous_item_id: "older",
          item: { id: "manual-answer", type: "message", role: "user", status: "completed" },
        });
        if (cause === "expiry") {
          await vi.waitFor(() => expect(h.closing().metadata).toBeDefined());
          h.complete();
          await h.played();
        }
        await vi.waitFor(() => expect(readRunView(h.repository).lifecycle.stage).not.toBe("live"));
        h.emit({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "manual-answer",
          transcript: "The newer answer.",
        });
        h.emit({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "older",
          transcript: "The earlier answer.",
        });
        await vi.waitFor(() =>
          expect(readRunView(h.repository).transcriptProof?.obligations).toEqual(
            expect.arrayContaining([
              { itemId: "older", role: "participant", status: "captured" },
              { itemId: "manual-answer", role: "participant", status: "captured" },
            ]),
          ),
        );
        await vi.advanceTimersByTimeAsync(15_000);
        await h.controller.alarm();
        await h.durable.flushWaitUntil();
        expect(
          readRunView(h.repository).transcript.turns.filter((turn) => turn.role === "participant"),
        ).toEqual([
          { role: "participant", text: "The earlier answer." },
          { role: "participant", text: "The newer answer." },
        ]);
        expect(
          h.commands.filter((command) => command.type === "input_audio_buffer.commit"),
        ).toHaveLength(1);
      },
    );
    it("retains a provider-assigned final input identity when Stop wins before suppression acknowledgement", async () => {
      const h = setup({
        activeInputReplay: true,
        holdCommittedInput: true,
        inputCommitItemId: "manual-answer",
      });
      await h.start();
      h.emit({ type: "input_audio_buffer.speech_started", item_id: "answer" });
      await vi.waitFor(() =>
        expect(readRunView(h.repository).execution).toMatchObject({ inputBuffered: true }),
      );
      vi.setSystemTime(liveAt + 10_001);
      await h.controller.alarm();
      await vi.waitFor(() =>
        expect(h.commands).toContainEqual(expect.objectContaining({ type: "session.update" })),
      );
      expect(h.commands.filter((command) => command.type === "input_audio_buffer.commit")).toEqual(
        [],
      );
      expect(
        (await h.driver.complete({ runId: "goodbye-host", endReason: "participant_stopped" }))
          .status,
      ).toBe(202);
      await vi.waitFor(() =>
        expect(readRunView(h.repository).finalInput?.admittedItemId).toBe("manual-answer"),
      );
      h.emit({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "manual-answer",
        transcript: "The final answer remains eligible.",
      });
      await vi.waitFor(() =>
        expect(readRunView(h.repository).transcriptProof?.obligations).toContainEqual({
          itemId: "manual-answer",
          role: "participant",
          status: "captured",
        }),
      );
      expect(
        h.commands.filter((command) => command.type === "input_audio_buffer.commit"),
      ).toHaveLength(1);
      expect(h.commands.filter((command) => command.type === "response.create")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(15_000);
      await h.controller.alarm();
      await h.durable.flushWaitUntil();
      expect(readRunView(h.repository).transcript.turns).toEqual([
        { role: "participant", text: "The final answer remains eligible." },
      ]);
    });
    it("retains participant input when End cancels Goodbye before native input settlement", async () => {
      const h = setup({ activeInputReplay: true, holdInputCommit: true });
      await h.start();
      h.emit({ type: "input_audio_buffer.speech_started", item_id: "answer" });
      await vi.waitFor(() =>
        expect(readRunView(h.repository).execution).toMatchObject({ inputBuffered: true }),
      );
      vi.setSystemTime(liveAt + 10_001);
      await h.controller.alarm();
      await vi.waitFor(() =>
        expect(h.commands).toContainEqual(expect.objectContaining({ type: "session.update" })),
      );
      await vi.waitFor(() =>
        expect(
          h.commands.filter((command) => command.type === "input_audio_buffer.commit"),
        ).toHaveLength(1),
      );
      expect(
        (await h.driver.complete({ runId: "goodbye-host", endReason: "participant_stopped" }))
          .status,
      ).toBe(202);
      await vi.waitFor(() =>
        expect(
          h.commands.filter((command) => command.type === "input_audio_buffer.commit"),
        ).toHaveLength(1),
      );
      const commitIndex = h.commands.findIndex(
        (command) => command.type === "input_audio_buffer.commit",
      );
      expect(h.commands.slice(0, commitIndex)).not.toContainEqual(
        expect.objectContaining({ type: "input_audio_buffer.clear" }),
      );
      expect(h.commands.filter((command) => command.type === "response.create")).toHaveLength(1);
      h.settleReplayInput();
      h.emit({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "answer",
        transcript: "The talks were clear and the room was quiet.",
      });
      await vi.waitFor(() =>
        expect(readRunView(h.repository).transcriptProof?.obligations).toContainEqual({
          itemId: "answer",
          role: "participant",
          status: "captured",
        }),
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await h.controller.alarm();
      await h.durable.flushWaitUntil();
      expect(readRunView(h.repository).transcript.turns).toEqual([
        { role: "participant", text: "The talks were clear and the room was quiet." },
      ]);
    });
    it("retains rejected input as incomplete without retrying its commit in Ending", async () => {
      const h = setup({ activeInputReplay: true, rejectInputCommit: true });
      await h.start();
      h.emit({ type: "input_audio_buffer.speech_started", item_id: "answer" });
      await vi.waitFor(() =>
        expect(readRunView(h.repository).execution).toMatchObject({ inputBuffered: true }),
      );
      vi.setSystemTime(liveAt + 10_001);
      await h.controller.alarm();
      await vi.waitFor(() =>
        expect(readRunView(h.repository).nodeExecution).toMatchObject({
          limitation: "goodbye_command_rejected",
        }),
      );
      await h.driver.complete({ runId: "goodbye-host", endReason: "participant_stopped" });
      await vi.advanceTimersByTimeAsync(15_000);
      await h.controller.alarm();
      await h.durable.flushWaitUntil();
      const final = readRunView(h.repository);
      expect(final.lifecycle).toMatchObject({
        stage: "ended",
        completion: { endReason: "timebox_reached" },
      });
      expect(final.transcriptProof?.result).toMatchObject({
        transcriptCompleteness: "incomplete",
      });
      expect(
        h.commands.filter((command) => command.type === "input_audio_buffer.commit"),
      ).toHaveLength(1);
      expect(h.commands.filter((command) => command.type === "response.create")).toHaveLength(1);
    });
    it("retains failed participant proof without committing another silent item", async () => {
      const h = setup({ emptyFinalInput: true });
      await h.start();
      h.emit({ type: "input_audio_buffer.committed", item_id: "failed-answer" });
      h.emit({
        type: "conversation.item.input_audio_transcription.failed",
        item_id: "failed-answer",
      });
      await h.finish();
      h.complete();
      await h.played();
      await vi.waitFor(() => expect(readRunView(h.repository).lifecycle.stage).not.toBe("live"));
      expect(h.commands.filter((command) => command.type === "input_audio_buffer.commit")).toEqual(
        [],
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await h.controller.alarm();
      await h.durable.flushWaitUntil();
      expect(readRunView(h.repository).transcriptProof?.result).toMatchObject({
        transcriptCompleteness: "incomplete",
        transcriptIncompleteReasons: [
          { kind: "eligible_transcript_item_failed", itemId: "failed-answer", role: "participant" },
        ],
      });
    });
    it.each(["participant_stopped", "timebox_reached"] as const)(
      "preserves unfinished speech when %s ends the Interviewing visit",
      async (reason) => {
        const h = setup();
        await h.start();
        h.emit({ type: "input_audio_buffer.speech_started" });
        await vi.waitFor(() =>
          expect(readRunView(h.repository).execution).toMatchObject({ inputBuffered: true }),
        );
        if (reason === "participant_stopped")
          expect(
            (await h.driver.complete({ runId: "goodbye-host", endReason: reason })).status,
          ).toBe(202);
        else {
          vi.setSystemTime(liveAt + 10_001);
          await h.controller.alarm();
          await vi.advanceTimersByTimeAsync(45_001);
          await h.controller.alarm();
        }
        await vi.waitFor(() =>
          expect(
            h.commands.filter((command) => command.type === "input_audio_buffer.commit"),
          ).toHaveLength(1),
        );
        expect(readRunView(h.repository).finalInput).toMatchObject({
          inputToSettle: true,
          obligation: "awaiting_item",
        });
      },
    );
    it.each([false, true])(
      "retains process-loss uncertainty before closing recovery (opening pending: %s)",
      async (skipMediaReady) => {
        const h = setup({ skipMediaReady });
        await h.start();
        expect(readRunView(h.repository).usage?.incomplete).toBe(false);
        if (skipMediaReady) {
          vi.setSystemTime(liveAt + 10_001);
          await h.controller.alarm();
          await vi.waitFor(() => expect(h.closing().metadata).toBeDefined());
        } else vi.setSystemTime(liveAt + 55_001);
        const restored = createInterviewRuntimeController(
          h.durable.ctx,
          { OPENAI_API_KEY: "controlled" },
          h.provider,
        );
        await controllerDriver(restored).state();
        expect(readRunView(h.repository).transcriptProof?.evidenceGap).toBe(true);
        expect(readRunView(h.repository).usage?.incomplete).toBe(true);
        expect(readRunView(h.repository).nodeExecution).toMatchObject({
          ...(skipMediaReady
            ? { limitation: "closing_recovery_uncertain", dispatch: { status: "failed" } }
            : { dispatch: { status: "pending" }, closingCutoffAt: liveAt + 100_001 }),
        });
        expect(h.commands.filter((command) => command.type === "response.create")).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(skipMediaReady ? 15_000 : 55_000);
        await restored.alarm();
        await h.controller.alarm();
        await vi.advanceTimersByTimeAsync(10_000);
        await restored.alarm();
        await h.controller.alarm();
        await h.durable.flushWaitUntil();
        expect(readRunView(h.repository).transcriptProof?.result).toMatchObject({
          transcriptCompleteness: "incomplete",
          runtimeUsage: { completeness: "incomplete" },
        });
      },
    );
    it("never starts an Interviewing opening when media becomes ready after closing admission", async () => {
      const h = setup({ skipMediaReady: true });
      await h.start();
      vi.setSystemTime(liveAt + 10_001);
      await h.controller.alarm();
      await vi.waitFor(() => expect(h.closing().metadata).toBeDefined());
      expect(h.commands.filter((command) => command.type === "response.create")).toHaveLength(1);
      expect((await h.driver.mediaReady({ runId: "goodbye-host" })).status).toBe(200);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.commands.filter((command) => command.type === "response.create")).toHaveLength(1);
      expect(readRunRecordView(h.repository).openingState).toBe("pending");
      expect(readRunView(h.repository).visit?.state).toBe("goodbye");
    });
    it("accepts an identical Goodbye Start idempotently through the retained registry selection", async () => {
      const h = setup();
      await h.start();
      const repeated = await h.driver.startConnection({
        runId: "goodbye-host",
        selection: goodbyeRealtimeSelection,
        profile: "realtime-v1",
        connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
        createdAt: liveAt,
        execution: { agentInput: h.input },
        diagnosticsContext: { surface: "lab" },
      });
      expect(repeated.status).toBe(200);
      expect(h.provider.createCall).toHaveBeenCalledOnce();
    });
    it("records known no-audio closing failure without inventing a transcript evidence gap", async () => {
      const h = setup({ emptyFinalInput: true });
      await h.start();
      await h.finish();
      h.emit({
        type: "response.created",
        response: { id: "closing", metadata: h.closing().metadata },
      });
      h.emit({
        type: "response.done",
        response: {
          id: "closing",
          status: "completed",
          metadata: h.closing().metadata,
          output: [
            {
              type: "message",
              id: "closing-item",
              role: "assistant",
              content: [{ type: "text", text: "Thank you. Goodbye." }],
            },
          ],
        },
      });
      await vi.waitFor(() => expect(readRunView(h.repository).lifecycle.stage).not.toBe("live"));
      expect(readRunView(h.repository).nodeExecution?.limitation).toBeDefined();
      expect(readRunView(h.repository).visit?.state).toBe("interrupted");
      expect(readRunView(h.repository).transcriptProof?.interrupted).toBe(true);
      expect(readRunView(h.repository).transcriptProof?.evidenceGap).not.toBe(true);
      await vi.advanceTimersByTimeAsync(70_000);
      await h.controller.alarm();
      await h.durable.flushWaitUntil();
      expect(readRunView(h.repository).transcriptProof?.result).toMatchObject({
        outcome: "interrupted",
        transcriptCompleteness: "complete",
        transcriptIncompleteReasons: [],
      });
      const state = readRunView(h.repository).lifecycle;
      if (state.stage !== "ended") throw new Error("terminal_result_not_frozen");
      expect(state.completion.endReason).toBe("agent_requested_end");
      expect(state.completion.warnings).toContain("closing_response_failed");
      const assessments = h.repository
        .readEventsByName("runtime.event_recorded")
        .map((row) =>
          decodeRuntimeEventRecordEnvelope(readRecord(JSON.parse(row.payload_json)).record),
        )
        .filter((record) => record.type === "conversation.closing_assessment");
      expect(assessments).toHaveLength(1);
      expect(assessments[0]).toMatchObject({
        runId: "goodbye-host",
        source: "conversation",
        selection: goodbyeRealtimeSelection,
      });
      expect(JSON.parse(assessments[0]?.payloadJson ?? "null")).toMatchObject({
        warnings: ["closing_response_failed"],
        endReason: "agent_requested_end",
        finalizedAt: state.completion.finalizedAt,
      });
    });
    it("rejects a blank closing sentence before any native provider work", async () => {
      const h = setup();
      const response = await h.driver.startConnection({
        runId: "goodbye-host",
        selection: goodbyeRealtimeSelection,
        profile: "realtime-v1",
        connection: { exchangeId: "exchange", input: { sdp: "v=0" } },
        execution: { agentInput: { ...h.input, goodbye: { closingSentence: "" } } },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(h.provider.createCall).not.toHaveBeenCalled();
      expect(h.provider.connectSideband).not.toHaveBeenCalled();
      expect(h.commands).toEqual([]);
    });
    it("retains detached accepted node input when caller configuration changes", async () => {
      const h = setup();
      await h.start();
      h.input.goodbye.closingSentence = "";
      await h.finish();
      await vi.waitFor(() => expect(h.closing().metadata).toBeDefined());
      expect(h.closing().instructions).toMatch(/\n\nThank you\. Goodbye\.$/);
      expect(readRunView(h.repository).nodeExecution?.dispatch?.input).toEqual({
        closingSentence: sampleClosingSentence,
      });
    });
    // OpenAI reports the closing's audio stopped once it finished sending it; the participant
    // still has to hear its end. Ending, which clears output and hangs up, waits for the margin.
    it("announces the end only once the delivered closing had the margin to play, and clears nothing before", async () => {
      const h = setup();
      await h.start();
      await h.finish();
      await vi.waitFor(() => expect(h.closing().metadata).toBeDefined());
      const deliveredAt = Date.now();
      h.complete();
      await vi.waitFor(() =>
        expect(readRunView(h.repository).nodeExecution?.endingAt).toBeTypeOf("number"),
      );
      const endingAt = readRunView(h.repository).nodeExecution?.endingAt ?? 0;
      expect(endingAt - deliveredAt).toBeGreaterThanOrEqual(playbackMarginMs);
      const sentAtDelivery = h.commands.length;
      vi.setSystemTime(endingAt - 1);
      await h.controller.alarm();
      await vi.advanceTimersByTimeAsync(0);
      expect(readRunView(h.repository).lifecycle.stage).toBe("live");
      expect(readRunView(h.repository).visit?.state).toBe("complete");
      expect(h.commands.slice(sentAtDelivery)).toEqual([]);
      expect(h.provider.hangUp).not.toHaveBeenCalled();
      expect(h.repository.readEventsByName("runtime.ending")).toEqual([]);
      vi.setSystemTime(endingAt);
      await h.controller.alarm();
      await vi.advanceTimersByTimeAsync(0);
      const ending = h.repository.readEventsByName("runtime.ending");
      expect(ending).toHaveLength(1);
      expect(JSON.parse(ending[0]?.payload_json ?? "{}")).toMatchObject({
        endReason: "agent_requested_end",
      });
      const lifecycle = readRunView(h.repository).lifecycle;
      expect(
        lifecycle.stage === "ended" ? lifecycle.completion.endingStartedAt : lifecycle,
      ).toEqual(
        lifecycle.stage === "ended"
          ? endingAt
          : expect.objectContaining({ endingStartedAt: endingAt }),
      );
      expect(h.commands.slice(sentAtDelivery)).toContainEqual(
        expect.objectContaining({ type: "output_audio_buffer.clear" }),
      );
    });
    it("cuts the closing at once when Stop lands during its margin, keeping the reserved reason", async () => {
      const h = setup();
      await h.start();
      await h.finish();
      await vi.waitFor(() => expect(h.closing().metadata).toBeDefined());
      h.complete();
      await vi.waitFor(() =>
        expect(readRunView(h.repository).nodeExecution?.endingAt).toBeTypeOf("number"),
      );
      const endingAt = readRunView(h.repository).nodeExecution?.endingAt ?? 0;
      const sentAtDelivery = h.commands.length;
      vi.setSystemTime(endingAt - 1_000);
      const stoppedAt = Date.now();
      const stop = await h.driver.complete({
        runId: "goodbye-host",
        endReason: "participant_stopped",
      });
      // Runtime admits the Stop, which begins Ending at once with the reason the finish reserved.
      expect(stop).toMatchObject({ accepted: true });
      await vi.advanceTimersByTimeAsync(0);
      const lifecycle = readRunView(h.repository).lifecycle;
      expect(lifecycle.stage).not.toBe("live");
      const ending = lifecycle.stage === "ended" ? lifecycle.completion : lifecycle;
      expect(ending).toMatchObject({
        endReason: "agent_requested_end",
        endingStartedAt: stoppedAt,
      });
      expect("warnings" in ending ? ending.warnings : []).not.toContain("closing_interrupted");
      expect(h.commands.slice(sentAtDelivery)).toContainEqual(
        expect.objectContaining({ type: "output_audio_buffer.clear" }),
      );
    });
    it("selects full caller input, claims one native closing and completes only after correlated audio evidence", async () => {
      const h = setup();
      await h.start();
      const interviewingVisit = readRunView(h.repository).visit;
      await h.finish();
      h.emit({ type: "response.output_audio.delta", response_id: "interview" });
      await vi.waitFor(() => {
        const records = h.repository
          .readEventsByName("runtime.event_recorded")
          .map((row) =>
            decodeRuntimeEventRecordEnvelope(readRecord(JSON.parse(row.payload_json)).record),
          )
          .filter((record) => record.type === "realtime.provider_event_observed");
        const finish = records.find((record) =>
          record.payloadJson.includes("response.function_call_arguments.done"),
        );
        const late = records.find((record) =>
          record.payloadJson.includes("response.output_audio.delta"),
        );
        for (const record of [finish, late])
          expect(record).toMatchObject({
            source: "execution",
            visitId: interviewingVisit?.visitId,
            operationId: interviewingVisit?.operationId,
          });
      });
      const run = readRunView(h.repository);
      expect(run.nodeExecution).toMatchObject({
        reservation: {
          reason: "agent_requested_end",
          triggeringResponseId: "interview",
          toolCallId: "finish",
        },
        dispatch: { status: "claimed" },
      });
      expect(run.visit?.state).toBe("goodbye");
      expect(h.closingEntry()).toMatchObject([
        {
          type: "session.update",
          session: { tools: [], tool_choice: "none" },
        },
        {
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: "finish", output: "{}" },
        },
        {
          type: "response.create",
          response: {
            tools: [],
            tool_choice: "none",
            output_modalities: ["audio"],
            input: [],
            reasoning: { effort: "minimal" },
          },
        },
      ]);
      expect(h.closingEntry()).toHaveLength(3);
      expect(h.closingEntry()[0]?.session).not.toHaveProperty("instructions");
      expect(h.closing().instructions).toMatch(/\n\nThank you\. Goodbye\.$/);
      h.complete();
      await h.played();
      await vi.waitFor(() => expect(readRunView(h.repository).lifecycle.stage).not.toBe("live"));
      expect(readRunView(h.repository).nodeExecution?.dispatch?.status).toBe("complete");
      expect(readRunView(h.repository).agentCompletion).toMatchObject({
        responseId: "closing",
        callId: null,
        responseSettlement: "completed",
        outputAudioSettlement: "stopped",
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await h.controller.alarm();
      await h.durable.flushWaitUntil();
      const state = readRunView(h.repository).lifecycle;
      if (state.stage !== "ended") throw new Error("terminal_result_not_frozen");
      const assessments = h.repository
        .readEventsByName("runtime.event_recorded")
        .map((row) =>
          decodeRuntimeEventRecordEnvelope(readRecord(JSON.parse(row.payload_json)).record),
        )
        .filter((record) => record.type === "conversation.closing_assessment");
      expect(assessments).toHaveLength(1);
      expect(assessments[0]).toMatchObject({
        runId: "goodbye-host",
        source: "conversation",
        selection: goodbyeRealtimeSelection,
      });
      expect(JSON.parse(assessments[0]?.payloadJson ?? "null")).toEqual({
        warnings: [],
        endReason: "agent_requested_end",
        finalizedAt: state.completion.finalizedAt,
      });
    });
    it("enters closing from idle server expiry without a tool identity and retains the original absolute cutoff", async () => {
      const h = setup();
      await h.start();
      vi.setSystemTime(liveAt + 10_001);
      await h.controller.alarm();
      await vi.waitFor(() => expect(readRunView(h.repository).visit?.state).toBe("goodbye"));
      expect(readRunView(h.repository).nodeExecution).toMatchObject({
        mediaCutoffAt: liveAt + 55_001,
        closingCutoffAt: liveAt + 55_001,
        reservation: { reason: "timebox_reached", at: liveAt + 10_001 },
      });
      expect(readRunView(h.repository).nodeExecution?.reservation).toMatchObject({
        toolCallId: undefined,
      });
      for (const elapsed of [10_001, 20_000, 30_000, 40_000, 50_000]) {
        vi.setSystemTime(liveAt + elapsed);
        expect(
          (await h.driver.presence({ runId: "goodbye-host", mediaPresent: true })).status,
        ).toBe(200);
        expect(readRunView(h.repository).lifecycle, `presence at ${elapsed}`).toMatchObject({
          stage: "live",
        });
      }
      vi.setSystemTime(liveAt + 55_001);
      await h.controller.alarm();
      expect(
        readRunView(h.repository).nodeExecution?.limitation,
        JSON.stringify(readRunView(h.repository).lifecycle),
      ).toBe("closing_cutoff_exhausted");
      await vi.waitFor(() =>
        expect(readRunView(h.repository).lifecycle).toMatchObject({
          stage: "ended",
          completion: { endReason: "timebox_reached", warnings: ["closing_cutoff_exhausted"] },
        }),
      );
    });
    // A reply cut by the deadline's closing keeps its text, as Stop keeps it.
    it.each(["deadline", "stop"] as const)(
      "keeps the text of a reply cut by the closing under its own step (%s)",
      async (cut) => {
        const outcome = await cutReplyOutcome(setup(), cut, liveAt + 10_001);
        const kept = { role: "conversationAgent", text: "What did you think of the" };
        // The kept text is filed under the step whose reply produced it.
        expect(outcome.itemStep).toEqual(outcome.firstStep);
        if (cut === "deadline") {
          expect(outcome.turns).toEqual([
            kept,
            { role: "conversationAgent", text: "Thank you. Goodbye." },
          ]);
          // The cut reply's late tool call stays refused.
          expect(outcome.toolCalls).toEqual([
            {
              toolCallId: "late-finish",
              state: "goodbye",
              outcome: "ignored",
              reason: "out_of_scope",
            },
          ]);
          expect(outcome.endReason).toBe("timebox_reached");
        } else {
          expect(outcome.turns).toEqual([kept]);
          expect(outcome.endReason).toBe("participant_stopped");
        }
      },
    );
    it("rejects a held successful native report after the persisted cutoff even before alarm delivery", async () => {
      const h = setup({ holdCompletion: true });
      await h.start();
      await h.finish();
      h.complete();
      await vi.waitFor(() => expect(h.heldCompletion()).toBeTypeOf("function"));
      const cutoff = readRunView(h.repository).nodeExecution?.closingCutoffAt;
      if (cutoff === undefined) throw new Error("missing_closing_cutoff");
      vi.setSystemTime(cutoff + 1);
      await h.heldCompletion()?.();
      expect(readRunView(h.repository).nodeExecution).toMatchObject({
        limitation: "closing_cutoff_exhausted",
        dispatch: { status: "failed" },
      });
      await vi.waitFor(() =>
        expect(readRunView(h.repository).lifecycle).toMatchObject({
          stage: "ended",
          completion: { endReason: "agent_requested_end", warnings: ["closing_cutoff_exhausted"] },
        }),
      );
    });
    it("leaves a native report still held past the closing deadline to Runtime's closing alarm", async () => {
      await expectHeldReportDecidedByClosingAlarm(setup({ holdCompletion: true }));
    });
    it.each(["before_settlement", "after_settlement", "other_command"] as const)(
      "keeps its own cancellation acknowledgement from failing closing (%s)",
      async (receipt) => {
        const h = setup();
        await h.start();
        h.emit({ type: "response.created", response: { id: "interview" } });
        h.emit({
          type: "response.function_call_arguments.done",
          response_id: "interview",
          call_id: "finish",
          name: "finish_interview",
          arguments: "{}",
        });
        await vi.waitFor(() =>
          expect(h.commands).toContainEqual(
            expect.objectContaining({ type: "response.cancel", response_id: "interview" }),
          ),
        );
        const cancellation = h.commands.find(
          (command) => command.type === "response.cancel" && command.response_id === "interview",
        );
        const closingCommands = () =>
          h.commands.filter(
            (command) =>
              command.type === "response.create" &&
              typeof command.event_id === "string" &&
              command.event_id.startsWith("evt_goodbye_"),
          );
        const acknowledgeCancellation = () =>
          h.emit({
            type: "error",
            error: { event_id: cancellation?.event_id, code: "response_cancel_not_active" },
          });
        if (receipt === "before_settlement") {
          acknowledgeCancellation();
          await vi.advanceTimersByTimeAsync(1);
          expect(readRunView(h.repository).lifecycle.stage).toBe("live");
          expect(closingCommands()).toHaveLength(0);
        }
        h.emit({
          type: "response.done",
          response: {
            id: "interview",
            status: "completed",
            output: [
              {
                type: "function_call",
                name: "finish_interview",
                call_id: "finish",
                arguments: "{}",
              },
            ],
          },
        });
        await vi.waitFor(() => expect(closingCommands()).toHaveLength(1));
        const command = closingCommands()[0];
        if (receipt === "other_command")
          h.emit({
            type: "error",
            error: { event_id: command?.event_id, code: "response_cancel_not_active" },
          });
        else if (receipt === "after_settlement") acknowledgeCancellation();
        h.complete();
        // A closing that failed gets no wait for its playback.
        if (receipt !== "other_command") await h.played();
        await vi.waitFor(() => expect(readRunView(h.repository).lifecycle.stage).not.toBe("live"));
        expect(readRunView(h.repository).visit?.state).toBe(
          receipt === "other_command" ? "interrupted" : "complete",
        );
      },
    );
    it("arbitrates an already-due interview deadline before a delayed model finish and never renews closing", async () => {
      const h = setup();
      await h.start();
      vi.setSystemTime(liveAt + 10_001);
      h.emit({ type: "response.created", response: { id: "late-interview" } });
      h.emit({
        type: "response.done",
        response: {
          id: "late-interview",
          status: "completed",
          output: [
            {
              type: "function_call",
              name: "finish_interview",
              call_id: "late-tool",
              arguments: "{}",
            },
          ],
        },
      });
      await vi.waitFor(() =>
        expect(readRunView(h.repository).nodeExecution?.reservation?.reason).toBe(
          "timebox_reached",
        ),
      );
      const admitted = readRunView(h.repository).nodeExecution;
      expect(admitted?.reservation).toMatchObject({ toolCallId: undefined });
      expect(admitted?.closingCutoffAt).toBe((admitted?.reservation?.at ?? 0) + 45_000);
      expect(admitted?.reservation?.at).toBeGreaterThanOrEqual(liveAt + 10_001);
      h.emit({
        type: "response.done",
        response: {
          id: "other-late",
          status: "completed",
          output: [
            {
              type: "function_call",
              name: "finish_interview",
              call_id: "other-tool",
              arguments: "{}",
            },
          ],
        },
      });
      await h.controller.alarm();
      expect(readRunView(h.repository).nodeExecution?.closingCutoffAt).toBe(
        admitted?.closingCutoffAt,
      );
    });
    it("retains the accepted finish invocation when an unrelated tool precedes it in the receipt", async () => {
      const h = setup();
      await h.start();
      h.emit({ type: "response.created", response: { id: "mixed-tools" } });
      h.emit({
        type: "response.done",
        response: {
          id: "mixed-tools",
          status: "completed",
          output: [
            { type: "function_call", name: "unrelated", call_id: "wrong-tool", arguments: "{}" },
            {
              type: "function_call",
              name: "finish_interview",
              call_id: "actual-finish",
              arguments: "{}",
            },
          ],
        },
      });
      await vi.waitFor(() =>
        expect(readRunView(h.repository).nodeExecution?.reservation).toMatchObject({
          triggeringResponseId: "mixed-tools",
          toolCallId: "actual-finish",
        }),
      );
    });
    it("contains participant End during closing without replacing the reserved finish reason", async () => {
      const h = setup();
      await h.start();
      await h.finish();
      await h.driver.complete({
        runId: "goodbye-host",
        endReason: "participant_stopped",
        now: liveAt + 1000,
      });
      expect(h.commands.some((entry) => entry.type === "output_audio_buffer.clear")).toBe(true);
      expect(readRunView(h.repository).nodeExecution?.limitation).toBe("closing_interrupted");
      await vi.waitFor(() =>
        expect(readRunView(h.repository).lifecycle).toMatchObject({
          stage: "ended",
          completion: { endReason: "agent_requested_end" },
        }),
      );
    });
  });
}
