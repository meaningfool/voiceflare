import { describe, expect, it } from "vitest";

import {
  arbitrateInterviewRuntimeControllerWork,
  arbitrationWorkForObservation,
  controllerArbitrationContractLedger,
} from "./interviewFinalizationArbitration.ts";

describe("Interview Runtime Controller arbitration contract", () => {
  it.each(controllerArbitrationContractLedger)("enforces $id", (row) => {
    expect(arbitrateInterviewRuntimeControllerWork(row.input)).toEqual(row.expected);
  });

  it("keeps the five provider-close evidence classes distinct", () => {
    const evidence = controllerArbitrationContractLedger.flatMap((row) =>
      row.input.eligibleWork.flatMap((work) =>
        work.kind === "terminal_close_evidence" || work.kind === "nonterminal_close_evidence"
          ? [work.evidence]
          : [],
      ),
    );

    expect(new Set(evidence)).toEqual(
      new Set(["hangup_acknowledged", "hangup_already_closed", "session_closed_observed"]),
    );
  });

  it("classifies a successful hangup effect as nonterminal acknowledgement evidence", () => {
    expect(
      arbitrationWorkForObservation(
        {
          kind: "effect_outcome",
          effectId: "run:hangup",
          outcome: { status: "dispatched" },
          at: 100,
        },
        { hangupEffectId: "run:hangup" },
      ),
    ).toEqual({
      entry: "effect_outcome",
      work: {
        id: "incoming:hangup_acknowledged",
        kind: "nonterminal_close_evidence",
        evidence: "hangup_acknowledged",
      },
    });
  });

  it("preserves provider-session close property presence and insertion order", () => {
    const providerClose = arbitrationWorkForObservation({
      kind: "session_closed_observed",
      generation: 2,
      sequence: 42,
      at: 100,
    });

    expect(Object.keys(providerClose.work)).toEqual(["id", "kind", "order", "evidence"]);
    expect(providerClose.work).toEqual({
      id: "incoming:session_closed_observed",
      kind: "terminal_close_evidence",
      order: 42,
      evidence: "session_closed_observed",
    });
  });

  it("selects the earlier persisted live deadline and uses timebox for an equal tie", () => {
    const input = (timeboxAt: number, presenceAt: number) => ({
      entry: "alarm" as const,
      eligibleWork: [
        {
          id: "deadline:presence_grace",
          kind: "presence_grace_deadline" as const,
          due: true,
          deadlineAt: presenceAt,
        },
        {
          id: "deadline:timebox",
          kind: "timebox_deadline" as const,
          due: true,
          deadlineAt: timeboxAt,
        },
        { id: "heartbeat", kind: "presence_renewal" as const },
      ],
    });

    expect(arbitrateInterviewRuntimeControllerWork(input(100, 200)).selected).toBe(
      "deadline:timebox",
    );
    expect(arbitrateInterviewRuntimeControllerWork(input(200, 100)).selected).toBe(
      "deadline:presence_grace",
    );
    expect(arbitrateInterviewRuntimeControllerWork(input(100, 100)).selected).toBe(
      "deadline:timebox",
    );
  });

  it.each([
    { timebox: 200, presence: 150, media: 150, selected: "media" },
    { timebox: 150, presence: 150, media: 150, selected: "timebox" },
    { timebox: 200, presence: 100, media: 150, selected: "presence" },
    { timebox: 200, presence: 200, media: 150, selected: "media" },
  ])(
    "keeps earlier deadline authority and defines the readiness tie: $selected",
    ({ timebox, presence, media, selected }) => {
      expect(
        arbitrateInterviewRuntimeControllerWork({
          entry: "alarm",
          eligibleWork: [
            { id: "presence", kind: "presence_grace_deadline", deadlineAt: presence },
            { id: "media", kind: "browser_media_ready_deadline", deadlineAt: media },
            { id: "timebox", kind: "timebox_deadline", deadlineAt: timebox },
          ],
        }).selected,
      ).toBe(selected);
    },
  );

  it("orders exactly the already-valid candidates supplied by orchestration", () => {
    expect(
      arbitrateInterviewRuntimeControllerWork({
        entry: "effect_dispatch",
        eligibleWork: [
          { id: "publication", kind: "publication", due: true },
          { id: "effect:one", kind: "provider_effect", order: 0 },
        ],
      }),
    ).toEqual({
      selected: "effect:one",
      deferred: ["publication"],
    });
  });
});
