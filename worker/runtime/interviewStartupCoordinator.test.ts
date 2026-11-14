import { admitImplementation } from "./admission/private/composition.ts";
import type { RuntimeImplementation } from "./implementationContracts.ts";
import { createInterviewConversationInput as testInterviewInput } from "./testing/interviewConversationPreset.ts";
import { originalRealtimeSelection } from "../shared/contracts/conversationSelection.ts";
import { interviewAgent } from "../implementations/originalRealtime/implementation.ts";
import { originalInterviewConversation } from "../conversations/originalInterview.ts";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InterviewExecution, RuntimeStartRequest } from "../shared/contracts/runtimeStart.ts";
import { createLiveInterviewFinalizationAggregate } from "./interviewFinalizationModel.ts";
import { InterviewFinalizationRepository } from "./interviewFinalizationRepository.ts";
import {
  InterviewStartupCoordinator,
  deliverInterviewReadiness,
  type InterviewStartupAttempt,
  type InterviewStartupEvents,
  type InterviewStartupProvider,
  type RuntimeSetupInput,
  type RuntimeStartInput,
} from "./interviewStartupCoordinator.ts";
import type { SessionStartResult } from "./nativeContracts.ts";
import { decodeConversationSnapshot } from "./conversationExecution.ts";
import {
  decodeRealtimeSessionSettings,
  prepareRealtimeSettings,
} from "../providers/openaiRealtime/preparedModelSession.ts";
import { realtimeConnectionSetup } from "../providers/openaiRealtime/connection.ts";
import {
  createDurableObjectState,
  createTestDurableObjectContext,
} from "./testing/interviewRuntimeControllerTestHarness.ts";

const openDatabases: Array<ReturnType<typeof createTestDurableObjectContext>> = [];

afterEach(() => {
  for (const durable of openDatabases.splice(0)) durable.close();
});

describe("InterviewStartupCoordinator", () => {
  it("creates setup once, resumes a matching start, and rejects mismatches", async () => {
    const harness = setupCoordinator();
    const first = await harness.coordinator.startRuntime("run_startup", () => defaultStart);
    const repeated = await harness.coordinator.startRuntime("run_startup", () => defaultStart);

    expect(first.created).toBe(true);
    expect(first.state).toMatchObject({
      run_id: "run_startup",
      phase: "setup",
      created_at: defaultSetup.createdAt,
      started_at: defaultSetup.startedAt,
    });
    expect(first.state.runtime_id).toMatch(/^runtime_/u);
    expect(repeated).toEqual({ created: false, state: first.state });
    expect(harness.alarmRequests.request).toHaveBeenCalledOnce();
    await expect(
      harness.coordinator.startRuntime("run_startup", () => ({
        ...defaultStart,
        selection: {
          conversation: { id: "questions-interview", version: 1 },
          execution: { id: "realtime", version: 1 },
        },
      })),
    ).rejects.toThrow("conversation_selection_conflict");
    await expect(
      harness.coordinator.startRuntime("other_run", () => ({
        ...defaultStart,
        runId: "other_run",
      })),
    ).rejects.toThrow("runtime_controller_run_mismatch");
  });

  it("stores the prepared settings at setup and starts the call with them, preparing none on replay", async () => {
    const prepareSettings = vi.fn(prepareOriginalSettings);
    const harness = setupCoordinator({ implementation: { prepareSettings } });
    const request = realtimeRequest(configuredExecution);
    await harness.coordinator.startConnection(request, () => defaultSetup);
    const stored = decodeConversationSnapshot(
      JSON.parse(harness.repository.requireState().conversation_selection_json ?? "null"),
    ).executionSettings;
    expect(stored).toEqual({
      reasoningEffort: "low",
      prepared: prepareRealtimeSettings({ reasoningEffort: "low" }),
    });
    expect(harness.provider.start.mock.calls[0]?.[0].settings).toEqual(stored.prepared);
    // Setup prepares once, and the call's start once more to compare.
    expect(prepareSettings).toHaveBeenCalledTimes(2);
    await harness.coordinator.startConnection(request, () => defaultSetup);
    expect(prepareSettings).toHaveBeenCalledTimes(2);
    expect(harness.provider.start).toHaveBeenCalledOnce();
  });

  it("retains Lab's execution settings and the original deadline through reconstruction and replay", async () => {
    const harness = setupCoordinator();
    const settings = {
      model: "gpt-realtime-2.1",
      voice: "cedar",
      speed: 1,
      inputNoiseReduction: "off",
      semanticVadEagerness: "medium",
      maxOutputTokens: 700,
      truncation: "auto",
    } as const;
    const request = {
      ...realtimeRequest(rawExecution),
      executionSettings: settings,
      startupExpiresAt: 1_700_000_120_000,
    };
    const setup = {
      ...defaultSetup,
      startupExpiresAt: request.startupExpiresAt,
      deliveryTarget: { integration: "lab", context: { runId: "run_startup" } },
      diagnosticsContext: { surface: "lab" },
    };
    await harness.coordinator.startConnection(request, () => setup);
    const restored = new InterviewFinalizationRepository(
      createDurableObjectState(harness.durable.ctx).storage,
    );
    restored.initialize();
    expect(
      decodeConversationSnapshot(
        JSON.parse(restored.requireState().conversation_selection_json ?? "null"),
      ).executionSettings,
    ).toMatchObject({
      requested: settings,
      prepared: {
        outputAudio: { voice: "cedar" },
        inputAudio: { noiseReduction: { type: "off" } },
      },
    });
    expect(restored.requireState().startup_expires_at).toBe(1_700_000_120_000);
    await harness.coordinator.startConnection(
      { ...request, startupExpiresAt: request.startupExpiresAt + 60_000 },
      () => setup,
    );
    expect(harness.provider.start).toHaveBeenCalledOnce();
    expect(harness.provider.start.mock.calls[0]?.[0].settings).toMatchObject({
      model: "gpt-realtime-2.1",
      outputAudio: { voice: "cedar" },
    });
    expect(restored.requireState().startup_expires_at).toBe(1_700_000_120_000);
    await harness.coordinator.markLive(request.runId);
    expect(restored.readAggregate()).toMatchObject({
      runtimeUsage: { pending: [], observations: [], incomplete: false },
      applicationTranscriptProof: { liveAt: 1_700_000_030_000, obligations: [] },
    });
    expect(restored.requireState().runtime_usage_json).toBeNull();
  });

  it("refuses execution settings the selected execution cannot prepare, before setup", async () => {
    const harness = setupCoordinator();
    await expect(
      harness.coordinator.startConnection(
        {
          ...realtimeRequest(configuredExecution),
          executionSettings: { model: "gpt-realtime-mini" },
        },
        () => defaultSetup,
      ),
    ).rejects.toThrow("invalid_execution_settings");
    expect(harness.provider.start).not.toHaveBeenCalled();
    expect(harness.repository.readState()).toBeNull();
  });

  describe("the settings prepared again from the stored snapshot", () => {
    /** Prepares as the selected execution does, then as `again` changes it the second time. */
    function preparedAgain(
      again: (
        settings: ReturnType<typeof prepareRealtimeSettings>,
      ) => ReturnType<typeof prepareRealtimeSettings>,
    ) {
      return vi
        .fn(prepareOriginalSettings)
        .mockImplementationOnce(prepareOriginalSettings)
        .mockImplementationOnce((choices) => again(prepareRealtimeSettings(choices)));
    }

    it("continue when they equal the stored ones", async () => {
      const harness = setupCoordinator({
        implementation: { prepareSettings: preparedAgain((settings) => structuredClone(settings)) },
      });
      await harness.coordinator.startConnection(realtimeRequest(rawExecution), () => defaultSetup);
      expect(harness.provider.start).toHaveBeenCalledOnce();
      expect(harness.provider.start.mock.calls[0]?.[0].settings).toEqual(
        prepareRealtimeSettings({ reasoningEffort: "low" }),
      );
    });

    it.each([
      [
        "another voice",
        (settings: ReturnType<typeof prepareRealtimeSettings>) => ({
          ...settings,
          outputAudio: { ...settings.outputAudio, voice: "cedar" },
        }),
      ],
      [
        "another model",
        (settings: ReturnType<typeof prepareRealtimeSettings>) => ({
          ...settings,
          model: "gpt-realtime-2",
        }),
      ],
    ])("are refused before any provider work when they name %s", async (_change, change) => {
      const harness = setupCoordinator({
        implementation: { prepareSettings: preparedAgain(change) },
      });
      await expect(
        harness.coordinator.startConnection(realtimeRequest(rawExecution), () => defaultSetup),
      ).rejects.toThrow("prepared_settings_mismatch");
      expect(harness.provider.start).not.toHaveBeenCalled();
      expect(harness.repository.requireState()).toMatchObject({
        phase: "failed",
        session_id: null,
      });
    });
  });

  it.each([
    ["raw", rawExecution],
    ["configured", configuredExecution],
  ])(
    "prepares the %s execution and preserves provider-call identity on repeat",
    async (_kind, execution) => {
      const prepareSettings = vi.fn(prepareOriginalSettings);
      const harness = setupCoordinator({ implementation: { prepareSettings } });
      const request = realtimeRequest(execution);

      const first = await harness.coordinator.startConnection(request, () => defaultSetup);
      const repeatSetup = vi.fn(() => defaultSetup);
      const repeated = await harness.coordinator.startConnection(request, repeatSetup);

      expect(prepareSettings).toHaveBeenCalledWith({ reasoningEffort: "low" });
      expect(harness.provider.start).toHaveBeenCalledOnce();
      expect(harness.provider.start.mock.calls[0]?.[0].content).toEqual(
        admitImplementation(interviewAgent).prepareContent({
          runId: "run_startup",
          state: "interviewing",
          nodeInput: originalInterviewConversation.selectInput.interviewing(
            originalInterviewConversation.input(execution.agentInput),
            { runId: "run_startup" },
          ),
        }),
      );
      expect(first).toMatchObject({
        acceptance: "accepted",
        diagnostics: {
          sessionId: "call_startup",
          sessionLocation: "/v1/realtime/calls/call_startup",
          upstreamRequestId: "request_startup",
          settingsSummary: { model: "gpt-realtime-2.1" },
        },
      });
      expect(repeated).toEqual(first);
      expect(harness.provider.ensureConnected).toHaveBeenCalledTimes(2);
      expect(harness.repository.requireState().session_id).toBe("call_startup");
    },
  );

  it.each([
    ["fake control", { controlType: "fake_control_ready" }],
    ["provider readiness", { controlType: "response.created", eventId: "event_ready" }],
  ])(
    "activates timerless Live with operational presence supervision for %s",
    async (_source, controlPayload) => {
      const harness = setupCoordinator({
        connected: true,
        now: 1_700_000_030_000,
        implementation: timerlessConversation(),
      });
      await harness.coordinator.startRuntime("run_startup", () => defaultStart);

      await harness.coordinator.markLive("run_startup");

      const state = harness.repository.requireState();
      expect(state).toMatchObject({
        phase: "live",
        live_at: 1_700_000_030_000,
        deadline_at: null,
        presence_grace_until: 1_700_000_045_000,
      });
      expect(harness.repository.readAggregate()).toMatchObject({
        runId: "run_startup",
        providerGeneration: 0,
      });
      expect(harness.events.recordEvent).not.toHaveBeenCalledWith(
        "session.control_sent",
        controlPayload,
      );
      expect(harness.events.recordUniqueDiagnostic).toHaveBeenCalledWith(
        "runtime.live_reached",
        expect.any(Function),
        expect.objectContaining({ source: "runtime_controller" }),
      );
      expect(harness.alarmRequests.request).toHaveBeenCalledTimes(2);
    },
  );

  it("delivers application readiness once after durable Live and retains the application disposition", async () => {
    const notify = vi.fn(() =>
      Effect.succeed({
        runId: "run_startup",
        disposition: "failed" as const,
        decidedAt: 1_700_000_030_000,
        reason: "deadline_expired",
        stopRequired: true,
      }),
    );
    const harness = setupCoordinator({
      connected: true,
      now: 1_700_000_030_000,
      readiness: { notify },
    });
    await harness.coordinator.startRuntime("run_startup", () => ({
      ...defaultStart,
      deliveryTarget: readinessTarget,
      startupExpiresAt: 1_700_000_031_000,
    }));

    await expect(harness.coordinator.markLive("run_startup")).resolves.toBe("failed");
    await expect(harness.coordinator.markLive("run_startup")).resolves.toBeNull();

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith({
      runId: "run_startup",
      liveAt: 1_700_000_030_000,
      expiresAt: 1_700_000_031_000,
    });
    expect(harness.repository.requireState()).toMatchObject({
      phase: "live",
      readiness_attempted_at: 1_700_000_030_000,
      readiness_delivered_at: 1_700_000_030_000,
      readiness_disposition: "failed",
    });
  });

  it("delivers readiness once after a delayed alarm request and retains the delayed receipt", async () => {
    const dispatch = createGate();
    const alarm = createGate();
    const receipt = createGate();
    const notify = vi.fn(() =>
      Effect.promise(async () => {
        dispatch.release();
        await receipt.promise;
        return {
          runId: "run_startup",
          disposition: "succeeded" as const,
          decidedAt: 1_700_000_030_000,
          reason: "readiness_confirmed",
          stopRequired: false,
        };
      }),
    );
    const harness = setupCoordinator({ readiness: { notify } });
    await harness.coordinator.startRuntime("run_startup", () => ({
      ...defaultStart,
      deliveryTarget: readinessTarget,
      startupExpiresAt: 1_700_000_031_000,
    }));
    harness.alarmRequests.request.mockImplementationOnce(() => Effect.promise(() => alarm.promise));
    const owned = harness.coordinator.markLive("run_startup");
    await vi.waitFor(() => expect(harness.alarmRequests.request).toHaveBeenCalledTimes(2));
    expect(harness.repository.requireState()).toMatchObject({
      phase: "live",
      readiness_attempted_at: null,
    });
    expect(notify).not.toHaveBeenCalled();
    alarm.release();
    await dispatch.promise;
    expect(harness.repository.requireState()).toMatchObject({
      readiness_attempted_at: 1_700_000_030_000,
      readiness_disposition: null,
    });
    expect(await harness.coordinator.markLive("run_startup")).toBeNull();
    receipt.release();
    expect(await owned).toBe("succeeded");
    expect(notify).toHaveBeenCalledOnce();
    expect(harness.repository.requireState()).toMatchObject({
      phase: "live",
      startup_expires_at: 1_700_000_031_000,
      readiness_disposition: "succeeded",
    });
  });

  it("keeps one Live/readiness outcome when observations compete", async () => {
    const notify = vi.fn(() =>
      Effect.succeed({
        runId: "run_startup",
        disposition: "succeeded" as const,
        decidedAt: 1_700_000_030_000,
        reason: "readiness_confirmed",
        stopRequired: false,
      }),
    );
    const harness = setupCoordinator({
      readiness: { notify },
      implementation: timerlessConversation(),
    });
    await harness.coordinator.startRuntime("run_startup", () => ({
      ...defaultStart,
      deliveryTarget: readinessTarget,
      startupExpiresAt: 1_700_000_031_000,
    }));
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => harness.coordinator.markLive("run_startup")),
    );
    expect(outcomes.filter((outcome) => outcome === "succeeded")).toEqual(["succeeded"]);
    expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(11);
    expect(notify).toHaveBeenCalledOnce();
    expect(harness.repository.requireState()).toMatchObject({
      phase: "live",
      startup_expires_at: 1_700_000_031_000,
      live_at: 1_700_000_030_000,
      deadline_at: null,
      readiness_disposition: "succeeded",
    });
  });

  it("completes the admitted readiness claim after alarm rejection and surfaces that failure", async () => {
    const background = vi.fn((task: Promise<void>) => {
      void task.catch(() => undefined);
    });
    const failure = new Error("alarm_storage_rejected");
    const notify = vi.fn(() =>
      Effect.succeed({
        runId: "run_startup",
        disposition: "succeeded" as const,
        decidedAt: 1_700_000_030_000,
        reason: "readiness_confirmed",
        stopRequired: false,
      }),
    );
    const harness = setupCoordinator({ readiness: { notify }, background });
    await harness.coordinator.startRuntime("run_startup", () => ({
      ...defaultStart,
      deliveryTarget: readinessTarget,
    }));
    harness.alarmRequests.request.mockImplementationOnce(() => Effect.die(failure));
    await expect(harness.coordinator.markLive("run_startup")).rejects.toThrow(
      "alarm_storage_rejected",
    );
    await expect(background.mock.calls[1]?.[0]).rejects.toBe(failure);
    expect(await harness.coordinator.markLive("run_startup")).toBeNull();
    expect(notify).toHaveBeenCalledOnce();
    expect(harness.repository.requireState()).toMatchObject({
      phase: "live",
      readiness_disposition: "succeeded",
    });
  });

  it.each(["runtime.live_reached", "runtime.readiness_delivery_started"] as const)(
    "completes admitted readiness once after diagnostic defect at %s",
    async (diagnostic) => {
      const background = vi.fn((task: Promise<void>) => {
        void task.catch(() => undefined);
      });
      const failure = new Error("diagnostic_storage_rejected");
      const notify = vi.fn(() =>
        Effect.succeed({
          runId: "run_startup",
          disposition: "succeeded" as const,
          decidedAt: 1_700_000_030_000,
          reason: "readiness_confirmed",
          stopRequired: false,
        }),
      );
      const harness = setupCoordinator({ readiness: { notify }, background });
      await harness.coordinator.startRuntime("run_startup", () => ({
        ...defaultStart,
        deliveryTarget: readinessTarget,
        startupExpiresAt: 1_700_000_031_000,
      }));
      harness.events.recordUniqueDiagnostic.mockImplementation((type) => {
        if (type === diagnostic) throw failure;
      });
      await expect(harness.coordinator.markLive("run_startup")).rejects.toBe(failure);
      await expect(background.mock.calls[1]?.[0]).rejects.toBe(failure);
      expect(notify).toHaveBeenCalledOnce();
      expect(harness.repository.requireState()).toMatchObject({
        phase: "live",
        startup_expires_at: 1_700_000_031_000,
        readiness_attempted_at: 1_700_000_030_000,
        readiness_disposition: "succeeded",
      });
      expect(await harness.coordinator.markLive("run_startup")).toBeNull();
      expect(notify).toHaveBeenCalledOnce();
    },
  );

  it.each(["stalled_body", "late_headers"] as const)(
    "releases the local readiness body at the original cutoff with %s",
    async (point) => {
      vi.useFakeTimers();
      try {
        const cancelled = vi.fn();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"runId":'));
          },
          cancel: cancelled,
        });
        const headers = createGate();
        const cutoffAt = Date.now() + 750;
        const owned = Effect.runPromise(
          deliverInterviewReadiness({
            runId: "run_startup",
            liveAt: Date.now(),
            expiresAt: cutoffAt,
            async deliver() {
              if (point === "late_headers") await headers.promise;
              return new Response(body);
            },
          }),
        );
        await vi.advanceTimersByTimeAsync(750);
        expect(await owned).toBeNull();
        headers.release();
        await vi.advanceTimersByTimeAsync(0);
        expect(cancelled).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["raw", "configured"] as const)(
    "rejects invalid %s finish options before native creation",
    async (kind) => {
      for (const description of [42, "   ", null]) {
        const harness = setupCoordinator();
        const execution: InterviewExecution =
          kind === "raw"
            ? {
                agentInput: {
                  contract: "original-interview-input/v1",
                  interviewingDurationMs: 300_000,
                  interviewing: {
                    instructions: { kind: "literal", text: "Ask one useful question." },
                    toolDescriptions: { finish_interview: description },
                  },
                },
              }
            : {
                agentInput: {
                  contract: "original-interview-input/v1",
                  interviewingDurationMs: 300_000,
                  interviewing: {
                    instructions: { kind: "literal", text: "Saved flow" },
                    toolDescriptions: { finish_interview: description },
                  },
                },
              };
        await expect(
          harness.coordinator.startConnection(realtimeRequest(execution), () => defaultSetup),
        ).rejects.toThrow();
        expect(harness.repository.readState()).toBeNull();
        expect(harness.provider.start).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["raw", "configured"] as const)(
    "retains %s explicit finish options across reconstruction without recreating the call",
    async (kind) => {
      const description = "  Retained closing policy  ";
      const execution: InterviewExecution =
        kind === "raw"
          ? { agentInput: testInterviewInput("Ask one useful question.", description) }
          : {
              agentInput: testInterviewInput("Saved flow", description),
            };
      const harness = setupCoordinator();
      const request = realtimeRequest(execution);
      await harness.coordinator.startConnection(request, () => defaultSetup);
      const restored = new InterviewFinalizationRepository(
        createDurableObjectState(harness.durable.ctx).storage,
      );
      restored.initialize();
      const retained: unknown = JSON.parse(
        restored.requireState().conversation_start_json ?? "null",
      );
      expect(retained).toMatchObject({ selection: originalRealtimeSelection, execution });
      expect(harness.provider.start.mock.calls[0]?.[0].content.tools).toEqual([
        {
          type: "function",
          name: "finish_interview",
          description: "  Retained closing policy  ",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ]);
      await harness.coordinator.startConnection(request, () => defaultSetup);
      expect(harness.provider.start).toHaveBeenCalledOnce();
    },
  );

  it("rejects pure settings preparation failure before admission or native creation", async () => {
    const harness = setupCoordinator({
      implementation: {
        prepareSettings: () => {
          throw new Error("preparation_failed");
        },
      },
    });

    await expect(
      harness.coordinator.startConnection(realtimeRequest(rawExecution), () => defaultSetup),
    ).rejects.toThrow("preparation_failed");
    expect(harness.repository.readState()).toBeNull();
    expect(harness.provider.start).not.toHaveBeenCalled();
  });

  it("maps provider-call failure to the durable setup failure", async () => {
    const harness = setupCoordinator({
      providerResult: {
        ok: false,
        error: "provider_call_failed",
        reason: "provider_status:503",
      },
    });

    await expect(
      harness.coordinator.startConnection(realtimeRequest(rawExecution), () => defaultSetup),
    ).rejects.toThrow("provider_call_failed");
    expect(harness.repository.requireState().phase).toBe("failed");
    expect(harness.events.recordEvent).toHaveBeenCalledWith("session.failed", {
      message: "provider_status:503",
    });
  });

  it("maps pre-live sideband message failure and preserves the first diagnostic text", async () => {
    const harness = setupCoordinator();
    await harness.coordinator.startRuntime("run_startup", () => defaultStart);

    await harness.coordinator.applyProviderFailure({
      failure: "message",
      errorText: "provider_payload_failed",
      applyRuntimeFailure: true,
    });

    expect(harness.repository.requireState().phase).toBe("failed");
    expect(harness.events.recordUniqueDiagnostic).toHaveBeenCalledWith(
      "runtime.setup_failed",
      expect.any(Function),
      expect.objectContaining({
        failureKind: "session_setup",
        errorText: "provider_payload_failed",
      }),
    );
    expect(harness.events.recordEvent).toHaveBeenCalledWith("session.failed", {
      message: "session_message_failed_before_live",
    });
  });

  it("records a Cascade session failure before Live under the shared session stage", async () => {
    const harness = setupCoordinator();
    await harness.coordinator.startRuntime("run_startup", () => ({
      ...defaultStart,
      selection: {
        conversation: { id: "original-interview", version: 1 },
        execution: { id: "cascade", version: 1 },
      },
    }));

    // Cascade reports a lost session, as after a restart during setup, before it attached.
    await harness.coordinator.applyProviderFailure({
      failure: "session",
      errorText: "cascade_session_lost",
      applyRuntimeFailure: true,
    });

    expect(harness.repository.requireState().phase).toBe("failed");
    expect(harness.events.recordUniqueDiagnostic).toHaveBeenCalledWith(
      "runtime.startup",
      expect.any(Function),
      expect.objectContaining({ stage: "sessionConnected", failure: true }),
    );
    const setupFailures = harness.events.recordUniqueDiagnostic.mock.calls.filter(
      ([type]) => type === "runtime.setup_failed",
    );
    expect(setupFailures).not.toEqual([]);
    for (const [, , payload] of setupFailures)
      expect(payload).toEqual({
        failureKind: "session_setup",
        source: "runtime_controller",
        errorText: "cascade_session_lost",
      });
  });
});

const defaultSetup: RuntimeSetupInput = {
  runId: "run_startup",
  createdAt: 1_700_000_000_000,
  startedAt: 1_700_000_000_000,
  fakeSessionId: null,
  diagnosticsContext: { surface: "test" },
};

/** A Run with an application, which readiness is delivered to. */
const readinessTarget = { integration: "test", context: { runId: "run_startup" } };

const rawExecution: InterviewExecution = {
  agentInput: testInterviewInput("Ask one useful question."),
};

const defaultStart: RuntimeStartInput = {
  ...defaultSetup,
  selection: originalRealtimeSelection,
  execution: rawExecution,
};

const configuredExecution: InterviewExecution = {
  agentInput: testInterviewInput("Welcome the participant. Ask what stood out. Thank them."),
};

function realtimeRequest(execution: InterviewExecution): RuntimeStartRequest {
  return {
    selection: originalRealtimeSelection,
    runId: "run_startup",
    profile: "realtime-v1",
    connection: {
      exchangeId: "exchange_startup",
      input: { sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1" },
    },
    execution,
    createdAt: defaultSetup.startedAt,
    startupExpiresAt: defaultSetup.startedAt + 30_000,
    reasoningEffort: "low",
    diagnosticsContext: defaultSetup.diagnosticsContext,
  };
}

function setupCoordinator({
  implementation = {},
  providerResult,
  connected = false,
  now = 1_700_000_030_000,
  readiness,
  background,
}: Readonly<{
  /** Overrides the selected Original implementation, as a host composition would. */
  implementation?: Partial<RuntimeImplementation>;
  providerResult?: ProviderCallResult;
  connected?: boolean;
  now?: number;
  readiness?: ConstructorParameters<typeof InterviewStartupCoordinator>[0]["readiness"];
  background?: ConstructorParameters<typeof InterviewStartupCoordinator>[0]["background"];
}> = {}) {
  const durable = createTestDurableObjectContext();
  openDatabases.push(durable);
  const repository = new InterviewFinalizationRepository(
    createDurableObjectState(durable.ctx).storage,
  );
  repository.initialize();
  const events = {
    recordEvent: vi.fn(),
    recordUniqueDiagnostic: vi.fn(),
  } satisfies InterviewStartupEvents;
  const successfulResult: ProviderCallResult = {
    ok: true,
    answerSdp: "v=0\r\nanswer",
    sessionId: "call_startup",
    sessionLocation: "/v1/realtime/calls/call_startup",
    upstreamRequestId: "request_startup",
    settingsSummary: {},
  };
  const result = providerResult ?? successfulResult;
  const provider = {
    connected,
    summarizeSettings: (
      settings: Parameters<NonNullable<InterviewStartupProvider["summarizeSettings"]>>[0],
    ) => ({ model: decodeRealtimeSessionSettings(settings).model }),
    start: vi.fn((input: Parameters<InterviewStartupProvider["start"]>[0]) =>
      Effect.sync((): SessionStartResult => {
        if (!result.ok) return result;
        const recorded = { ...result, settingsSummary: input.settingsSummary };
        repository.recordSessionIdentity({
          runId: input.runId,
          sessionId: recorded.sessionId,
          sessionLocation: recorded.sessionLocation,
          upstreamRequestId: recorded.upstreamRequestId,
          settingsSummary: recorded.settingsSummary,
        });
        repository.recordSessionReply({
          runId: input.runId,
          sessionId: recorded.sessionId,
          reply: { sdp: recorded.answerSdp },
        });
        const { answerSdp, ...started } = recorded;
        return { ...started, reply: { sdp: answerSdp } };
      }),
    ),
    ensureConnected: vi.fn(),
  } satisfies InterviewStartupProvider;
  const alarmRequests = { request: vi.fn((): Effect.Effect<void> => Effect.void) };
  const attempt = {
    hasFailedStart: () => {
      const state = repository.readState();
      return state?.phase === "failed" && state.live_at === null;
    },
    mayGoLive: (at: number) =>
      Effect.sync(() => {
        const state = repository.requireState();
        if (
          state.phase === "setup" &&
          state.startup_expires_at !== null &&
          at >= state.startup_expires_at
        ) {
          repository.commitSetupFailure(state.run_id, state.startup_expires_at, at);
        }
        return repository.requireState().phase === "setup";
      }),
    failSetup: (runId: string) =>
      Effect.sync(() => {
        repository.commitSetupFailure(runId, now, now);
      }),
    // Like the attempt coordinator, this commits when called.
    commitLive: (input: Parameters<InterviewStartupAttempt["commitLive"]>[0]) =>
      Effect.succeed(repository.commitSetupToLive({ ...input, transitionAt: now })),
  } satisfies InterviewStartupAttempt;
  const coordinatorInput: ConstructorParameters<typeof InterviewStartupCoordinator>[0] = {
    resolveImplementation: () => ({
      ...admitImplementation(interviewAgent),
      prepareSettings: prepareOriginalSettings,
      ...implementation,
    }),
    // Realtime's setup as the registry hands it over, its validation awaited as an Effect.
    connectionSetup: () => ({
      profile: realtimeConnectionSetup.profile,
      validate: (input) => Effect.promise(() => realtimeConnectionSetup.validate(input)),
    }),
    missingCredentials: () => [],
    attempt,
    provider,
    repository,
    events,
    finalization: { initialize: createLiveInterviewFinalizationAggregate },
    now: () => now,
    alarmRequests,
    background: background ?? ((task) => durable.ctx.waitUntil(task)),
  };
  const startup =
    readiness === undefined
      ? new InterviewStartupCoordinator(coordinatorInput)
      : new InterviewStartupCoordinator({ ...coordinatorInput, readiness });
  // Each operation runs to completion, as the controller composes it.
  const coordinator = {
    startRuntime: (...args: Parameters<InterviewStartupCoordinator["startRuntime"]>) =>
      Effect.runPromise(startup.startRuntime(...args)),
    startConnection: (...args: Parameters<InterviewStartupCoordinator["startConnection"]>) =>
      Effect.runPromise(startup.startConnection(...args)),
    markLive: (...args: Parameters<InterviewStartupCoordinator["markLive"]>) =>
      Effect.runPromise(startup.markLive(...args)),
    applyProviderFailure: (
      ...args: Parameters<InterviewStartupCoordinator["applyProviderFailure"]>
    ) => Effect.runPromise(startup.applyProviderFailure(...args)),
  };
  return {
    durable,
    repository,
    provider,
    events,
    alarmRequests,
    coordinator,
  };
}

/** A Conversation without timers goes Live without a Conversation deadline. */
function timerlessConversation(): Pick<RuntimeImplementation, "accept"> {
  const original = admitImplementation(interviewAgent);
  return {
    accept(input) {
      const { timers, ...accepted } = original.accept(input);
      return accepted;
    },
  };
}

/** The fixture call's identity and SDP answer, or the failure it reports. */
type ProviderCallResult =
  | Readonly<{
      ok: true;
      answerSdp: string;
      sessionId: string;
      sessionLocation: string | null;
      upstreamRequestId: string | null;
      settingsSummary: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{ ok: false; error: string; reason: string }>;

/** Realtime's settings preparation, which the registry gives every Realtime pair. */
function prepareOriginalSettings(
  choices: Parameters<NonNullable<RuntimeImplementation["prepareSettings"]>>[0],
) {
  return prepareRealtimeSettings(choices);
}

function createGate() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    promise,
    release() {
      if (resolve === undefined) throw new Error("gate_not_initialized");
      resolve();
    },
  };
}
