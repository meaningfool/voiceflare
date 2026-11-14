import { describe, expect, it } from "vitest";
import { decodeRuntimeDiagnosticPage } from "./contracts/runtimeDiagnostics.ts";

import {
  decodeRuntimeCompletedCallback,
  decodeRuntimeEventRecordEnvelope,
  decodeRuntimeTranscriptUpdatedCallback,
  isRuntimeEndReason,
  isResultWarning,
  isRuntimeTerminalOutcome,
  isRuntimeTranscriptPayload,
  isRuntimeTranscriptSnapshotRef,
  isRuntimeTranscriptTurn,
  runtimeCompletedCallbackType,
  runtimeTranscriptUpdatedCallbackType,
  type RuntimeTranscriptPayload,
  type RuntimeTranscriptTurn,
} from "./runtimeControllerCallback.ts";

function checkStrictTranscriptNarrowing(value: RuntimeTranscriptPayload): void {
  if (isRuntimeTranscriptPayload(value, { requireTranscriptTurns: true })) {
    const firstTurn: RuntimeTranscriptTurn | undefined = value.turns[0];
    void firstTurn;
  }
}

void checkStrictTranscriptNarrowing;

describe("Runtime Controller protocol contracts", () => {
  it("validates the shared terminal outcome and end-reason vocabulary", () => {
    for (const outcome of ["ended", "failed"]) expect(isRuntimeTerminalOutcome(outcome)).toBe(true);
    expect(isRuntimeTerminalOutcome("completed")).toBe(false);
    for (const reason of [
      "participant_stopped",
      "timebox_reached",
      "agent_requested_end",
      "participant_disconnected",
      "runtime_failed",
    ])
      expect(isRuntimeEndReason(reason)).toBe(true);
    expect(isRuntimeEndReason("agent_completed_interview")).toBe(false);
    expect(isRuntimeEndReason("future_reason")).toBe(false);
  });

  it("keeps nested current-contract validators as typed predicates", () => {
    expect(Object.hasOwn(isRuntimeTerminalOutcome, "boundary")).toBe(false);
    expect(Object.hasOwn(isRuntimeEndReason, "boundary")).toBe(false);
    expect(Object.hasOwn(isResultWarning, "boundary")).toBe(false);
    expect(Object.hasOwn(isRuntimeTranscriptTurn, "boundary")).toBe(false);
    expect(Object.hasOwn(isRuntimeTranscriptPayload, "boundary")).toBe(false);
    expect(Object.hasOwn(isRuntimeTranscriptSnapshotRef, "boundary")).toBe(false);
  });

  it("accepts only the current snapshot-identified completion callback", () => {
    const callback = {
      version: 2,
      type: runtimeCompletedCallbackType,
      completion: {
        runId: "run_123",
        outcome: "ended",
        endReason: "agent_requested_end",
        source: "test",
        endingStartedAt: 1_700_000_000_000,
        endedAt: 1_700_000_001_000,
        finalizedAt: 1_700_000_002_000,
        transcriptSnapshot: {
          revision: 0,
          digest: `sha256:${"0".repeat(64)}`,
          turnCount: 0,
        },
        warnings: [],
      },
    };

    const decoded = decodeRuntimeCompletedCallback({
      ...callback,
      ignored: { fromRawInput: true },
      completion: {
        ...callback.completion,
        ignored: { fromRawInput: true },
      },
    });

    expect(decoded).toEqual(callback);
    expect(decoded).not.toBe(callback);
    expect(decoded.completion).not.toBe(callback.completion);
    expect(decoded.completion.transcriptSnapshot).not.toBe(callback.completion.transcriptSnapshot);
    expect(decoded.completion.warnings).not.toBe(callback.completion.warnings);
    expect(decoded).not.toHaveProperty("ignored");
    expect(decoded.completion).not.toHaveProperty("ignored");
    expect(() => decodeRuntimeCompletedCallback({ ...callback, version: 1 })).toThrow();
    expect(() => decodeRuntimeCompletedCallback({ ...callback, version: undefined })).toThrow();
    expect(() => decodeRuntimeCompletedCallback({ ...callback, runId: "run_123" })).toThrow();
    expect(() =>
      decodeRuntimeCompletedCallback({
        ...callback,
        completion: { ...callback.completion, transcriptSnapshot: undefined },
      }),
    ).toThrow();
    expect(() =>
      decodeRuntimeCompletedCallback({
        ...callback,
        completion: { ...callback.completion, endReason: "agent_completed_interview" },
      }),
    ).toThrow();
    const { endReason, ...ownCompletion } = callback.completion;
    Object.setPrototypeOf(ownCompletion, { endReason });
    expect(() =>
      decodeRuntimeCompletedCallback({ ...callback, completion: ownCompletion }),
    ).toThrow();
    // A warning is Runtime's own or one its execution declares: readers check its shape only.
    const withWarnings = (warnings: unknown[]) => ({
      ...callback,
      completion: { ...callback.completion, warnings },
    });
    expect(
      decodeRuntimeCompletedCallback(
        withWarnings(["session_close_unconfirmed", "provider_observation_gap"]),
      ).completion.warnings,
    ).toEqual(["session_close_unconfirmed", "provider_observation_gap"]);
    for (const warning of ["", "Events may be missing", "gap-", 42, null])
      expect(() => decodeRuntimeCompletedCallback(withWarnings([warning]))).toThrow();
    expect(() => decodeRuntimeCompletedCallback(null)).toThrow();
    expect(() => decodeRuntimeCompletedCallback([])).toThrow();
    expect(() =>
      decodeRuntimeCompletedCallback({
        ...callback,
        completion: { ...callback.completion, finalizedAt: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toThrow();
  });

  it("accepts only the current snapshot-identified transcript callback", () => {
    const callback = {
      version: 2,
      type: runtimeTranscriptUpdatedCallbackType,
      runId: "run_123",
      snapshot: {
        revision: 1,
        digest: `sha256:${"0".repeat(64)}`,
        turnCount: 1,
        transcript: {
          turns: [{ role: "participant", text: "The hallway track was useful." }],
        },
      },
    };

    const decoded = decodeRuntimeTranscriptUpdatedCallback({
      ...callback,
      ignored: { fromRawInput: true },
      snapshot: {
        ...callback.snapshot,
        ignored: { fromRawInput: true },
        transcript: {
          ...callback.snapshot.transcript,
          ignored: { fromRawInput: true },
          turns: [
            {
              ...callback.snapshot.transcript.turns[0],
              ignored: { fromRawInput: true },
            },
          ],
        },
      },
    });

    expect(decoded).toEqual(callback);
    expect(decoded).not.toBe(callback);
    expect(decoded.snapshot).not.toBe(callback.snapshot);
    expect(decoded.snapshot.transcript).not.toBe(callback.snapshot.transcript);
    expect(decoded.snapshot.transcript.turns).not.toBe(callback.snapshot.transcript.turns);
    expect(decoded.snapshot.transcript.turns[0]).not.toBe(callback.snapshot.transcript.turns[0]);
    expect(decoded).not.toHaveProperty("ignored");
    expect(decoded.snapshot).not.toHaveProperty("ignored");
    expect(decoded.snapshot.transcript).not.toHaveProperty("ignored");
    expect(decoded.snapshot.transcript.turns[0]).not.toHaveProperty("ignored");
    expect(() => decodeRuntimeTranscriptUpdatedCallback({ ...callback, version: 1 })).toThrow();
    expect(() =>
      decodeRuntimeTranscriptUpdatedCallback({ ...callback, version: undefined }),
    ).toThrow();
    expect(() =>
      decodeRuntimeTranscriptUpdatedCallback({
        ...callback,
        snapshot: { ...callback.snapshot, turnCount: 2 },
      }),
    ).toThrow();
    for (const role of ["participant", "conversationAgent"]) {
      expect(
        decodeRuntimeTranscriptUpdatedCallback({
          ...callback,
          snapshot: {
            ...callback.snapshot,
            transcript: { turns: [{ role, text: "Current turn" }] },
          },
        }).snapshot.transcript.turns,
      ).toEqual([{ role, text: "Current turn" }]);
    }
    for (const inherited of [{ role: "participant" }, { text: "Inherited turn" }]) {
      const turn = { role: "participant", text: "Current turn" };
      for (const key of Object.keys(inherited)) Reflect.deleteProperty(turn, key);
      Object.setPrototypeOf(turn, inherited);
      expect(() =>
        decodeRuntimeTranscriptUpdatedCallback({
          ...callback,
          snapshot: { ...callback.snapshot, transcript: { turns: [turn] } },
        }),
      ).toThrow();
    }
    for (const role of ["moderator", 42]) {
      expect(() =>
        decodeRuntimeTranscriptUpdatedCallback({
          ...callback,
          snapshot: {
            ...callback.snapshot,
            transcript: { turns: [{ role, text: "Invalid role" }] },
          },
        }),
      ).toThrow();
    }
    expect(isRuntimeTranscriptPayload({ turns: [] }, { requireTranscriptTurns: true })).toBe(true);
    expect(isRuntimeTranscriptPayload({ turns: [{}] })).toBe(true);
    expect(isRuntimeTranscriptPayload({ turns: [{}] }, { requireTranscriptTurns: true })).toBe(
      false,
    );
    expect(isRuntimeTranscriptPayload({})).toBe(false);
    expect(() => decodeRuntimeTranscriptUpdatedCallback(null)).toThrow();
    expect(() => decodeRuntimeTranscriptUpdatedCallback([])).toThrow();
  });

  it("validates shared Runtime Event record envelopes", () => {
    const record = {
      recordId: "run:1",
      runId: "run",
      source: "runtime",
      selection: null,
      visitId: null,
      operationId: null,
      observedAt: 1_700_000_000_000,
      sequence: 1,
      elapsedMs: 250,
      type: "realtime.sideband_closed",
      payloadJson: '{"source":"runtime_controller"}',
    };

    const decoded = decodeRuntimeEventRecordEnvelope(record);
    expect(() => decodeRuntimeEventRecordEnvelope({ ...record, ignored: true })).toThrow();

    expect(decoded).toEqual(record);
    expect(decoded).not.toBe(record);
    expect(decoded).not.toHaveProperty("ignored");
    expect(() => decodeRuntimeEventRecordEnvelope({ ...record, payloadJson: {} })).toThrow();
    expect(() => decodeRuntimeEventRecordEnvelope({ ...record, observedAt: Number.NaN })).toThrow();
    for (const invalid of [
      { ...record, runId: undefined },
      { ...record, source: "browser" },
      {
        ...record,
        selection: {
          conversation: { id: 42, version: 1 },
          execution: { id: "realtime", version: 1 },
        },
      },
      { ...record, payloadJson: "{" },
      Object.assign(Object.create({ runId: "run" }), { ...record, runId: undefined }),
      Object.create(record),
    ])
      expect(() => decodeRuntimeEventRecordEnvelope(invalid)).toThrow();
    expect(
      decodeRuntimeEventRecordEnvelope(Object.assign(Object.create({ inherited: true }), record)),
    ).toEqual(record);

    const page = { runId: "run", records: [record], cursor: 1, hasMore: false };
    expect(decodeRuntimeDiagnosticPage(page)).toEqual(page);
    for (const invalid of [
      { ...page, runId: undefined },
      { ...page, cursor: -1 },
      { ...page, hasMore: "false" },
      { ...page, records: {} },
      { ...page, records: [{ ...record, source: "browser" }] },
      { ...page, records: [{ ...record, selection: { conversation: { id: 42 } } }] },
      { ...page, extra: true },
      Object.create(page),
    ])
      expect(() => decodeRuntimeDiagnosticPage(invalid)).toThrow();
  });
});
