import { originalRealtimeSelection } from "./conversationSelection.ts";
import { createInterviewConversationInput } from "../../runtime/testing/interviewConversationPreset.ts";
import { describe, expect, it } from "vitest";

import {
  buildConfiguredInterviewExecution,
  buildLabRuntimeStartRequest,
  buildApplicationRuntimeStartRequest,
  parseInterviewDefinition,
  parseRuntimeStartRequest,
  type InterviewDefinition,
  type LabRuntimeStartInput,
  type ApplicationRuntimeStartInput,
} from "./runtimeStart";

const definition: InterviewDefinition = {
  warmUp: "  Start with this exact warm-up.  ",
  followUpPolicy: { enabled: true },
  questions: [
    { id: "question_1", text: "First saved question", maxFollowUps: 1 },
    { id: "question_2", text: "Second saved question", maxFollowUps: 1 },
  ],
  closing: "  End with this exact closing.  ",
};

const applicationInput = {
  selection: originalRealtimeSelection,
  runId: "response_1",
  profile: "realtime-v1",
  connection: { exchangeId: "exchange_1", input: { sdp: "v=0" } },
  agentInput: createInterviewConversationInput("  Sample prompt.  "),
  startupExpiresAt: 30_000,
} satisfies ApplicationRuntimeStartInput;

const labInput = {
  runId: "lab_1",
  profile: "realtime-v1",
  connection: { exchangeId: "exchange_1", input: { sdp: "v=0" } },
  selection: originalRealtimeSelection,
  agentInput: createInterviewConversationInput("Use this raw Lab instruction."),
  startupExpiresAt: 30_000,
} satisfies LabRuntimeStartInput;

describe("Runtime start contract", () => {
  it("carries raw Lab Agent input unchanged without interpreting tool fields", () => {
    const agentInput = { finishInterviewDescription: 42, futureAgentField: [true, null] };
    const request = buildLabRuntimeStartRequest({ ...labInput, agentInput });
    expect(parseRuntimeStartRequest(request)).toEqual({ ok: true, value: request });
    expect(request.execution).toEqual({
      agentInput,
    });
  });

  it("carries opaque Agent/connection input and rejects malformed or inherited common identity fields", () => {
    const current = {
      selection: originalRealtimeSelection,
      runId: "run_probe",
      profile: "probe",
      connection: { exchangeId: "first", input: { challenge: 17 } },
      execution: { agentInput: { question: "What changed?" } },
      startupExpiresAt: 30000,
    };
    expect(parseRuntimeStartRequest(current)).toEqual({ ok: true, value: current });
    for (const connection of [
      { input: { challenge: 17 } },
      { exchangeId: 42 },
      { exchangeId: "first", extra: true },
    ])
      expect(parseRuntimeStartRequest({ ...current, connection })).toMatchObject({ ok: false });
    const inherited = { input: { challenge: 17 } };
    Object.setPrototypeOf(inherited, { exchangeId: "first" });
    expect(parseRuntimeStartRequest({ ...current, connection: inherited })).toMatchObject({
      ok: false,
    });
    const { profile, ...inheritedProfile } = current;
    Object.setPrototypeOf(inheritedProfile, { profile });
    expect(parseRuntimeStartRequest(inheritedProfile)).toMatchObject({ ok: false });
  });

  it("carries execution settings as opaque data that only the selected execution reads", () => {
    const settings = { model: "any-model", nested: { voice: "any-voice" }, cap: "inf" };
    const lab = buildLabRuntimeStartRequest({ ...labInput, executionSettings: settings });
    expect(parseRuntimeStartRequest(lab)).toEqual({ ok: true, value: lab });
    expect(lab.executionSettings).toEqual(settings);
    const application = buildApplicationRuntimeStartRequest(applicationInput);
    expect(application).not.toHaveProperty("executionSettings");
    expect(parseRuntimeStartRequest({ ...application, executionSettings: Number.NaN })).toEqual({
      ok: false,
      error: "invalid_execution_settings",
    });
  });
  it("uses one creation timestamp for both applications and retires startedAt", () => {
    for (const request of [
      buildApplicationRuntimeStartRequest({ ...applicationInput, createdAt: 1_700_000_000_123 }),
      buildLabRuntimeStartRequest({ ...labInput, createdAt: 1_700_000_000_123 }),
    ]) {
      expect(request).toMatchObject({ createdAt: 1_700_000_000_123 });
      expect(parseRuntimeStartRequest(JSON.parse(JSON.stringify(request)))).toEqual({
        ok: true,
        value: request,
      });
      expect(parseRuntimeStartRequest({ ...request, startedAt: 1_700_000_000_123 })).toMatchObject({
        ok: false,
      });
      for (const createdAt of ["1700000000123", null, 1.5])
        expect(parseRuntimeStartRequest({ ...request, createdAt })).toMatchObject({ ok: false });
    }
  });

  it("checks missing and nested fields on otherwise valid JSON requests", () => {
    const request = buildApplicationRuntimeStartRequest(applicationInput);
    // Timestamp omission keeps the existing optional-start contract.
    expect(parseRuntimeStartRequest(JSON.parse(JSON.stringify(request)))).toEqual({
      ok: true,
      value: request,
    });
    const { runId: _runId, ...missingRunId } = request;
    const invalidRequests = [
      missingRunId,
      { ...request, createdAt: { value: 123 } },
      { ...request, execution: { eventName: "Event" } },
      { ...request, diagnosticsContext: { surface: "test", extra: true } },
    ];
    for (const invalid of invalidRequests) {
      expect(parseRuntimeStartRequest(JSON.parse(JSON.stringify(invalid)))).toMatchObject({
        ok: false,
      });
    }
  });

  it("rejects inherited selection identity at the actual Start ingress", () => {
    const request = buildApplicationRuntimeStartRequest(applicationInput);
    const conversation = { id: originalRealtimeSelection.conversation.id };
    Object.setPrototypeOf(conversation, { version: 1 });
    expect(
      parseRuntimeStartRequest({ ...request, selection: { ...request.selection, conversation } }),
    ).toMatchObject({ ok: false });
  });

  it("rejects inherited fields at the request and nested execution ingress", () => {
    const request = buildApplicationRuntimeStartRequest(applicationInput);
    for (const field of [
      "runId",
      "profile",
      "connection",
      "selection",
      "execution",
      "startupExpiresAt",
    ] as const) {
      const { [field]: inheritedValue, ...inherited } = request;
      Object.setPrototypeOf(inherited, { [field]: inheritedValue });
      expect(parseRuntimeStartRequest(inherited)).toMatchObject({ ok: false });
    }
    for (const field of ["agentInput"] as const) {
      const execution = { agentInput: applicationInput.agentInput };
      const { [field]: inheritedValue, ...inherited } = execution;
      Object.setPrototypeOf(inherited, { [field]: inheritedValue });
      expect(parseRuntimeStartRequest({ ...request, execution: inherited })).toMatchObject({
        ok: false,
      });
    }
    const inheritedDiagnostics: unknown = Object.create({ surface: "test" });
    expect(
      parseRuntimeStartRequest({ ...request, diagnosticsContext: inheritedDiagnostics }),
    ).toMatchObject({ ok: false });
    const inheritedRequest = { ...request };
    Object.setPrototypeOf(inheritedRequest, { extra: true });
    expect(parseRuntimeStartRequest(inheritedRequest)).toMatchObject({ ok: false });
    const inheritedExecution = { ...request.execution };
    Object.setPrototypeOf(inheritedExecution, { extra: true });
    expect(parseRuntimeStartRequest({ ...request, execution: inheritedExecution })).toMatchObject({
      ok: false,
    });
  });

  it("requires expiry at the actual Start ingress for both applications", () => {
    for (const request of [
      buildApplicationRuntimeStartRequest(applicationInput),
      buildLabRuntimeStartRequest(labInput),
    ]) {
      const { startupExpiresAt: _expiry, ...missingExpiry } = request;
      expect(parseRuntimeStartRequest(missingExpiry)).toMatchObject({ ok: false });
    }
  });

  it.each([
    { startupExpiresAt: "30000" },
    { startupExpiresAt: null },
    { startupExpiresAt: 1.5 },
    { startupExpiresAt: -1 },
    { startupExpiresAt: { value: 30_000 } },
  ])("rejects malformed application startup fields %j", (fields) => {
    const request = buildApplicationRuntimeStartRequest(applicationInput);
    expect(parseRuntimeStartRequest({ ...request, ...fields })).toMatchObject({ ok: false });
  });

  it("preserves authored definition strings while validating structure", () => {
    expect(parseInterviewDefinition(definition)).toEqual(definition);
    expect(
      parseInterviewDefinition({
        ...definition,
        unexpected: true,
      }),
    ).toBeNull();
  });

  it("rejects blank, duplicate, and unknown Question data", () => {
    expect(parseInterviewDefinition({ ...definition, warmUp: "   " })).toBeNull();
    expect(
      parseInterviewDefinition({
        ...definition,
        questions: [
          { id: "same", text: "One", maxFollowUps: 1 },
          { id: " same ", text: "Two", maxFollowUps: 1 },
        ],
      }),
    ).toBeNull();
    expect(
      parseInterviewDefinition({
        ...definition,
        questions: [{ id: "q", text: "Text", maxFollowUps: 1, required: true }],
      }),
    ).toBeNull();
  });

  it("packages both applications into one execution envelope and preserves authored strings", () => {
    expect(buildApplicationRuntimeStartRequest(applicationInput)).toMatchObject({
      runId: "response_1",
      execution: { agentInput: applicationInput.agentInput },
    });
    expect(buildLabRuntimeStartRequest(labInput)).toEqual({
      selection: originalRealtimeSelection,
      runId: "lab_1",
      profile: "realtime-v1",
      connection: { exchangeId: "exchange_1", input: { sdp: "v=0" } },
      execution: { agentInput: labInput.agentInput },
      startupExpiresAt: 30_000,
    });

    expect(
      parseRuntimeStartRequest({
        selection: originalRealtimeSelection,
        runId: "  run_1  ",
        profile: "realtime-v1",
        connection: { exchangeId: "exchange_1", input: { sdp: "v=0" } },
        execution: { agentInput: { instructions: "  Preserve these authored instructions.  " } },
        reasoningEffort: null,
        startupExpiresAt: 30_000,
      }),
    ).toEqual({
      ok: true,
      value: {
        selection: originalRealtimeSelection,
        runId: "run_1",
        profile: "realtime-v1",
        connection: { exchangeId: "exchange_1", input: { sdp: "v=0" } },
        execution: { agentInput: { instructions: "  Preserve these authored instructions.  " } },
        reasoningEffort: null,
        startupExpiresAt: 30_000,
      },
    });

    // The retired top-level duration copy is an unknown field, not a second duration source.
    expect(
      parseRuntimeStartRequest({
        ...buildApplicationRuntimeStartRequest(applicationInput),
        maxDurationMs: 300_000,
      }),
    ).toEqual({ ok: false, error: "invalid_runtime_start_request" });
  });

  it("does not expose callback protocol selection on application, Lab, or Runtime starts", () => {
    expect(buildApplicationRuntimeStartRequest(applicationInput)).not.toHaveProperty(
      "runtimeCallbackVersion",
    );
    expect(buildLabRuntimeStartRequest(labInput)).not.toHaveProperty("runtimeCallbackVersion");
    expect(
      parseRuntimeStartRequest({
        ...buildLabRuntimeStartRequest(labInput),
        runtimeCallbackVersion: 2,
      }),
    ).toEqual({ ok: false, error: "invalid_runtime_start_request" });
  });

  it("rejects unknown fields at every closed contract level", () => {
    expect(
      parseRuntimeStartRequest({
        selection: originalRealtimeSelection,
        runId: "run_1",
        profile: "realtime-v1",
        connection: { exchangeId: "exchange_1", input: { sdp: "v=0" } },
        execution: buildConfiguredInterviewExecution({ agentInput: applicationInput.agentInput }),
        unexpected: true,
      }),
    ).toEqual({ ok: false, error: "invalid_runtime_start_request" });

    expect(
      parseRuntimeStartRequest({
        selection: originalRealtimeSelection,
        runId: "run_1",
        profile: "realtime-v1",
        connection: { exchangeId: "exchange_1", input: { sdp: "v=0" } },
        execution: { agentInput: { instructions: "Use this raw instruction." }, unexpected: true },
      }),
    ).toEqual({ ok: false, error: "invalid_execution" });
  });

  it("rejects retired execution formats and malformed opaque input", () => {
    const request = buildLabRuntimeStartRequest(labInput);
    for (const execution of [
      { kind: "configured_interview", agentInput: applicationInput.agentInput },
      { kind: "raw_instructions", instructions: labInput.agentInput },
      {},
      { agentInput: undefined },
      { agentInput: () => null },
      { agentInput: { value: Number.POSITIVE_INFINITY } },
    ])
      expect(parseRuntimeStartRequest({ ...request, execution })).toEqual({
        ok: false,
        error: "invalid_execution",
      });
    for (const agentInput of [null, 42, "literal", [], { future: [true, null] }]) {
      const current = { ...request, execution: { agentInput } };
      expect(parseRuntimeStartRequest(current)).toEqual({ ok: true, value: current });
    }
  });

  it("maps schema failures to stable Runtime errors", () => {
    const validExecution = buildConfiguredInterviewExecution({
      agentInput: applicationInput.agentInput,
    });

    expect(parseRuntimeStartRequest({ execution: validExecution })).toEqual({
      ok: false,
      error: "missing_run_id",
    });
    expect(parseRuntimeStartRequest({ runId: "run_1" })).toEqual({
      ok: false,
      error: "missing_execution",
    });
    expect(
      parseRuntimeStartRequest({
        selection: originalRealtimeSelection,
        runId: "run_1",
        profile: "realtime-v1",
        connection: { exchangeId: "exchange_1", input: { sdp: "v=0" } },
        execution: validExecution,
        reasoningEffort: "extreme",
      }),
    ).toEqual({ ok: false, error: "invalid_reasoning_effort" });
    expect(
      parseRuntimeStartRequest({
        selection: originalRealtimeSelection,
        runId: "run_1",
        profile: "realtime-v1",
        connection: { exchangeId: "exchange_1", input: { sdp: "v=0" } },
        execution: validExecution,
        createdAt: 1.5,
      }),
    ).toEqual({ ok: false, error: "invalid_runtime_timestamp" });
    expect(
      parseRuntimeStartRequest({
        selection: originalRealtimeSelection,
        runId: "run_1",
        profile: "realtime-v1",
        connection: { exchangeId: "exchange_1", input: { sdp: "v=0" } },
        execution: validExecution,
        diagnosticsContext: { surface: "   " },
      }),
    ).toEqual({ ok: false, error: "invalid_diagnostics_context" });
  });
});
