import { endConversation } from "./conversationEnd.ts";
import { liveFinalizationAggregate } from "./testing/finalizationFixtures.ts";
import { createRuntimeUsageAccounting } from "./runtimeUsage.ts";
import { describe, expect, it } from "vitest";

import { type InterviewFinalizationAggregate } from "./interviewFinalizationModel.ts";
import { advanceInterviewFinalization } from "./interviewFinalizationFSM.ts";
import { decodeInterviewFinalizationAggregate } from "./interviewFinalizationPersistenceDecoder.ts";

describe("finalization persistence decoder ownership", () => {
  it.each([undefined, false, true])("preserves compatible evidence-gap proof %s", (evidenceGap) => {
    let raw: InterviewFinalizationAggregate = {
      ...liveFinalizationAggregate({ runId: "run_decoder" }),
      runtimeUsage: createRuntimeUsageAccounting(),
      applicationTranscriptProof: {
        liveAt: 100,
        interrupted: false,
        obligations: [],
        closeBarrier: null,
        result: null,
      },
    };
    const proof = raw.applicationTranscriptProof;
    if (proof !== undefined && evidenceGap !== undefined)
      raw = { ...raw, applicationTranscriptProof: { ...proof, evidenceGap } };
    expect(decodeInterviewFinalizationAggregate(JSON.stringify(raw))).toEqual(raw);
    expect(
      decodeInterviewFinalizationAggregate(
        JSON.stringify({
          ...raw,
          applicationTranscriptProof: { ...raw.applicationTranscriptProof, evidenceGap: "true" },
        }),
      ),
    ).toBeNull();
  });

  it("returns an owned copy of a valid current aggregate", () => {
    const raw = liveFinalizationAggregate({ runId: "run_decoder" });
    const decoded = decodeInterviewFinalizationAggregate(raw);
    expect(decoded).toEqual(raw);
    expect(decoded).not.toBe(raw);
    expect(decoded?.state).not.toBe(raw.state);
  });

  it("rejects inherited aggregate fields before they can become owned state", () => {
    const aggregate = liveFinalizationAggregate({ runId: "run_decoder" });
    const inherited: unknown = Object.create(aggregate);
    expect(() => decodeInterviewFinalizationAggregate(inherited)).toThrow(
      "The boundary schema rejected the input",
    );
  });

  it("rejects prototype-shaped unknown fields from stored JSON", () => {
    const aggregate = liveFinalizationAggregate({ runId: "run_decoder" });
    const raw = JSON.stringify({ ...aggregate, ["__proto__"]: { unexpected: true } });
    expect(decodeInterviewFinalizationAggregate(raw)).toBeNull();
  });
});

it("validates and detaches persisted response and finishing-output authority", () => {
  const identity = {
    runId: "run_decoder",
    visitId: "visit-1",
    operationId: "operation-1",
    generation: 1,
  };
  const response = {
    responseId: "response-1",
    status: "completed" as const,
    outputAudio: "stopped" as const,
    conversationScope: identity,
  };
  const live = {
    ...liveFinalizationAggregate({ runId: "run_decoder" }),
    conversationVisit: { state: "complete", visitId: "visit-1", operationId: "operation-1" },
    providerResponses: [response],
  };
  const aggregate = endConversation(live, {
    reason: "agent_requested_end",
    source: "agent_completion",
    acceptedAt: 100,
    cutoffAt: 10_100,
    completionReference: {
      callId: "call-1",
      responseId: "response-1",
      itemId: null,
      responseSettlement: "completed" as const,
      outputAudioSettlement: "stopped" as const,
      participantMediaSafetyOverride: false,
      executionIdentity: identity,
    },
  }).aggregate;
  const decoded = decodeInterviewFinalizationAggregate(aggregate);
  expect(decoded).toEqual(aggregate);
  expect(
    decodeInterviewFinalizationAggregate({
      ...aggregate,
      state: { ...aggregate.state, strategy: "graceful_agent_completion" },
    }),
  ).toBeNull();
  identity.operationId = "mutated-operation";
  expect(decoded?.providerResponses[0]?.conversationScope?.operationId).toBe("operation-1");
  expect(decoded?.gracefulCompletion?.executionIdentity?.operationId).toBe("operation-1");
  const valid = {
    runId: "run_decoder",
    visitId: "visit-1",
    operationId: "operation-1",
    generation: 1,
  };
  for (const invalid of [
    {},
    { ...valid, runId: 42 },
    { ...valid, runId: "other-run" },
    { ...valid, visitId: null },
    { ...valid, operationId: { id: "nested" } },
    { ...valid, generation: "1" },
    { ...valid, generation: -1 },
    { ...valid, successor: "complete" },
  ]) {
    expect(
      decodeInterviewFinalizationAggregate({
        ...aggregate,
        providerResponses: [{ ...response, conversationScope: invalid }],
      }),
    ).toBeNull();
    expect(
      decodeInterviewFinalizationAggregate({
        ...aggregate,
        gracefulCompletion: { ...aggregate.gracefulCompletion, executionIdentity: invalid },
      }),
    ).toBeNull();
  }
  const inheritedScope: unknown = Object.create(valid);
  expect(() =>
    decodeInterviewFinalizationAggregate({
      ...aggregate,
      providerResponses: [{ ...response, conversationScope: inheritedScope }],
    }),
  ).toThrow("The boundary schema rejected the input");
  const inheritedExtra: unknown = Object.assign(Object.create({ successor: "unowned" }), valid);
  expect(() =>
    decodeInterviewFinalizationAggregate({
      ...aggregate,
      providerResponses: [{ ...response, conversationScope: inheritedExtra }],
    }),
  ).toThrow("The boundary schema rejected the input");

  if (decoded === null || decoded.finalInput === null) throw new Error("missing_owned_ending");
  const nodeSettledClosing = {
    ...decoded,
    conversationNodeExecution: {
      kind: "finishing",
      timers: [],
      mediaCutoffAt: 55_000,
      closingCutoffAt: 10_100,
      reservation: { reason: "agent_requested_end", source: "agent_completion", at: 100 },
      dispatch: { input: {}, status: "complete" },
    },
    applicationTranscriptProof: {
      liveAt: 1,
      interrupted: false,
      obligations: [],
      closeBarrier: null,
      result: null,
      inventoriedResponseIds: ["response-1"],
    },
    runtimeUsage: createRuntimeUsageAccounting(),
    finalInput: { ...decoded.finalInput, obligation: "settled" },
    state: {
      ...decoded.state,
      effects: decoded.state.effects.map((effect) =>
        // The closing settled the closed input itself.
        effect.kind === "close_input" ? { ...effect, status: "dispatched" as const } : effect,
      ),
    },
  } satisfies InterviewFinalizationAggregate;
  expect(decodeInterviewFinalizationAggregate(JSON.stringify(nodeSettledClosing))).toEqual(
    nodeSettledClosing,
  );
  // The input closure keeps the execution's account of how it settles, as two booleans.
  const finalInput = nodeSettledClosing.finalInput;
  for (const [field, value] of [
    ["inputToSettle", true],
    ["answerFollows", true],
  ] as const) {
    const accepted = { ...nodeSettledClosing, finalInput: { ...finalInput, [field]: value } };
    expect(decodeInterviewFinalizationAggregate(JSON.stringify(accepted))).toEqual(accepted);
    for (const invalid of [null, "true", 1, {}])
      expect(
        decodeInterviewFinalizationAggregate(
          JSON.stringify({
            ...nodeSettledClosing,
            finalInput: { ...finalInput, [field]: invalid },
          }),
        ),
      ).toBeNull();
    const { [field]: _missing, ...withoutField } = finalInput;
    expect(
      decodeInterviewFinalizationAggregate(
        JSON.stringify({ ...nodeSettledClosing, finalInput: withoutField }),
      ),
    ).toBeNull();
  }
});

it("decodes an ordinary dispatch whose identity is the current visit", () => {
  const aggregate = {
    ...liveFinalizationAggregate({ runId: "ordinary-dispatch" }),
    conversationVisit: { state: "reviewing", visitId: "visit-1", operationId: "operation-1" },
    conversationNodeExecution: {
      kind: "ordinary",
      mediaCutoffAt: null,
      timers: [],
      dispatch: { input: { accepted: true }, status: "pending" },
    },
  } satisfies InterviewFinalizationAggregate;
  expect(decodeInterviewFinalizationAggregate(JSON.stringify(aggregate))).toEqual(aggregate);
  const { conversationVisit: _visit, ...withoutVisit } = aggregate;
  expect(decodeInterviewFinalizationAggregate(JSON.stringify(withoutVisit))).toBeNull();
  const dispatch = aggregate.conversationNodeExecution.dispatch;
  for (const invalid of [
    // The visit owns the dispatched state and identity; a dispatch cannot repeat them.
    { ...dispatch, visitId: "visit-1" },
    { ...dispatch, operationId: "operation-1" },
    { ...dispatch, state: "reviewing" },
    { ...dispatch, limitation: "closing_interrupted" },
    { ...dispatch, input: undefined },
    { ...dispatch, status: 42 },
    { ...dispatch, extra: true },
  ])
    expect(
      decodeInterviewFinalizationAggregate(
        JSON.stringify({
          ...aggregate,
          conversationNodeExecution: { ...aggregate.conversationNodeExecution, dispatch: invalid },
        }),
      ),
    ).toBeNull();
});

it("decodes Conversation node execution only as an ordinary, finishing or retained-output variant", () => {
  const ordinary = {
    ...liveFinalizationAggregate({ runId: "node-variants" }),
    conversationVisit: { state: "finishing", visitId: "visit-1", operationId: "operation-1" },
    conversationNodeExecution: {
      kind: "ordinary",
      mediaCutoffAt: 900,
      timers: [{ id: "finishing", deadlineAt: 800, event: { kind: "finishing_time_elapsed" } }],
      associatedTimerId: "finishing",
      dispatch: { input: {}, status: "claimed" },
    },
  } satisfies InterviewFinalizationAggregate;
  const node = ordinary.conversationNodeExecution;
  const finishing = {
    ...node,
    kind: "finishing",
    reservation: { reason: "timebox_reached", source: "timebox_alarm", at: 200 },
    closingCutoffAt: 800,
    dispatch: { input: {}, status: "failed", limitation: "closing_interrupted" },
  } as const;
  const retained = {
    ...finishing,
    kind: "retained_output",
    dispatch: { input: {}, status: "dispatched" },
    cleanup: { status: "claimed", at: 600, effectId: "node-variants:1" },
  } as const;
  for (const valid of [
    node,
    { ...node, dispatch: { input: {}, status: "uncertain", limitation: "recovery_uncertain" } },
    finishing,
    { ...finishing, participantEnd: { at: 300, source: "browser_request" } },
    retained,
    { ...retained, cleanup: { status: "scheduled", at: 600 } },
    // A node that completed waits for its last reply to play (#1018).
    { ...finishing, dispatch: { input: {}, status: "complete" }, endingAt: 850 },
    { ...retained, dispatch: { input: {}, status: "complete" }, endingAt: 850 },
  ])
    expect(
      decodeInterviewFinalizationAggregate(
        JSON.stringify({ ...ordinary, conversationNodeExecution: valid }),
      ),
    ).not.toBeNull();
  const { reservation: _reservation, ...finishingWithoutReservation } = finishing;
  const { dispatch: _dispatch, ...finishingWithoutDispatch } = finishing;
  for (const invalid of [
    { ...node, kind: "closing" },
    { ...node, reservation: finishing.reservation },
    { ...node, closingCutoffAt: 800 },
    { ...node, interviewDeadlineAt: 800 },
    { ...node, timers: [...node.timers, ...node.timers] },
    { ...node, associatedTimerId: "missing" },
    finishingWithoutReservation,
    finishingWithoutDispatch,
    { ...finishing, mediaCutoffAt: null },
    { ...finishing, reservation: { ...finishing.reservation, reason: "participant_stopped" } },
    { ...finishing, closingCutoffAt: 199 },
    { ...finishing, closingCutoffAt: 901 },
    { ...finishing, cleanup: retained.cleanup },
    { ...finishing, participantEnd: { at: 199, source: "browser_request" } },
    { ...finishing, participantEnd: { at: 800, source: "browser_request" } },
    {
      ...finishing,
      dispatch: { input: {}, status: "failed" },
      participantEnd: { at: 300, source: "browser_request" },
    },
    { ...retained, cleanup: { status: "claimed", at: 600 } },
    { ...retained, cleanup: { status: "scheduled", at: 600, effectId: "node-variants:1" } },
    { ...retained, cleanup: undefined },
    // Only a node that completed waits for its reply to play.
    { ...finishing, endingAt: 850 },
    { ...retained, endingAt: 850 },
    { ...node, endingAt: 850 },
    { ...finishing, dispatch: { input: {}, status: "complete" }, endingAt: -1 },
    { ...finishing, dispatch: { input: {}, status: "complete" }, endingAt: "850" },
  ])
    expect(
      decodeInterviewFinalizationAggregate(
        JSON.stringify({ ...ordinary, conversationNodeExecution: invalid }),
      ),
    ).toBeNull();
});

it("keeps a Live completion only for retained output or a node that waits for its reply to play", () => {
  const waiting = {
    ...liveFinalizationAggregate({ runId: "waiting-node" }),
    conversationVisit: { state: "complete", visitId: "visit-1", operationId: "operation-1" },
    conversationNodeExecution: {
      kind: "finishing",
      mediaCutoffAt: 900,
      timers: [],
      reservation: { reason: "agent_requested_end", source: "agent_completion", at: 200 },
      closingCutoffAt: 800,
      dispatch: { input: {}, status: "complete" },
      endingAt: 850,
    },
    providerResponses: [
      { responseId: "closing", status: "completed", outputAudio: "stopped", playbackEndsAt: 840 },
    ],
    gracefulCompletion: {
      callId: null,
      responseId: "closing",
      itemId: null,
      responseSettlement: "completed",
      outputAudioSettlement: "stopped",
      participantMediaSafetyOverride: false,
    },
  } satisfies InterviewFinalizationAggregate;
  expect(decodeInterviewFinalizationAggregate(JSON.stringify(waiting))).toMatchObject({
    conversationNodeExecution: { endingAt: 850 },
    providerResponses: [{ responseId: "closing", playbackEndsAt: 840 }],
  });
  const { endingAt: _endingAt, ...notWaiting } = waiting.conversationNodeExecution;
  for (const invalid of [
    { ...waiting, conversationNodeExecution: notWaiting },
    {
      ...waiting,
      providerResponses: [{ ...waiting.providerResponses[0], playbackEndsAt: "840" }],
    },
  ])
    expect(decodeInterviewFinalizationAggregate(JSON.stringify(invalid))).toBeNull();
});

it("decodes persisted final input only as an obligation variant", () => {
  const draining = advanceInterviewFinalization(
    liveFinalizationAggregate({ runId: "final_input_decoder" }),
    { kind: "end_requested", reason: "participant_stopped", source: "browser_request", at: 100 },
  ).aggregate;
  const admitted = advanceInterviewFinalization(draining, {
    kind: "participant_answer_created",
    itemId: "final-item",
    generation: draining.providerGeneration,
    sequence: draining.nextProviderSequence,
  }).aggregate;
  if (draining.finalInput === null || admitted.finalInput === null)
    throw new Error("missing_final_input");
  expect(draining.finalInput.obligation).toBe("awaiting_item");
  expect(admitted.finalInput).toMatchObject({
    obligation: "awaiting_transcription",
    admittedItemId: "final-item",
  });
  for (const valid of [draining, admitted])
    expect(decodeInterviewFinalizationAggregate(JSON.stringify(valid))).toEqual(valid);

  for (const [name, raw] of Object.entries({
    awaitingItemWithItem: {
      ...draining,
      finalInput: { ...draining.finalInput, admittedItemId: "final-item" },
    },
    awaitingTranscriptionWithoutItem: {
      ...admitted,
      finalInput: { ...admitted.finalInput, admittedItemId: null },
    },
    settledWithNumericItem: {
      ...admitted,
      finalInput: { ...admitted.finalInput, obligation: "settled", admittedItemId: 42 },
    },
    unknownObligation: {
      ...admitted,
      finalInput: { ...admitted.finalInput, obligation: "admitted" },
    },
    unknownWarning: {
      ...draining,
      finalInput: { ...draining.finalInput, warning: "post_end_input_leaked" },
    },
    missingEffectId: {
      ...draining,
      finalInput: { ...draining.finalInput, effectId: undefined },
    },
    unownedField: {
      ...draining,
      finalInput: { ...draining.finalInput, finalInputAdmitted: false },
    },
    storedAdmissionOnEnding: {
      ...admitted,
      state: { ...admitted.state, finalInputAdmitted: true, admittedInputItemId: "final-item" },
    },
  }))
    expect(decodeInterviewFinalizationAggregate(JSON.stringify(raw)), name).toBeNull();
});
