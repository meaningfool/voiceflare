import { applicationCallbackUrl } from "./runtime/applicationCallbacks.ts";
import { afterEach, describe, expect, it } from "vitest";

import {
  completeLabRunFromSnapshot,
  createLabRun,
  getLabRun,
  persistLabRunTranscriptSnapshot,
} from "./lab/persistence/labD1.ts";
import {
  handleLabRuntimeControllerCompletion,
  handleLabRuntimeControllerTranscript,
} from "./lab/routes/labRuntime.ts";
import {
  runtimeCompletedCallbackType,
  runtimeTranscriptUpdatedCallbackType,
  type RuntimeCompletion,
  type RuntimeTranscript,
} from "./shared/runtimeControllerCallback.ts";
import {
  createRuntimeTranscriptSnapshot,
  type RuntimeTranscriptSnapshot,
} from "./shared/runtimeTranscriptSnapshot.ts";
import { createTestLabD1Database, type TestD1DatabaseHandle } from "./shared/testing/d1.ts";

const labDatabases: TestD1DatabaseHandle[] = [];

afterEach(() => {
  for (const database of labDatabases.splice(0)) {
    database.close();
  }
});

describe("Runtime Transcript identity persistence", () => {
  it("keeps Lab persistence isomorphic", async () => {
    const database = createTestLabD1Database();
    labDatabases.push(database);
    const run = await createLabRun(database.d1, { now: () => 1_700_000_000_000 });
    const empty = await snapshot(0, { turns: [] });

    await expect(
      persistLabRunTranscriptSnapshot(database.d1, { runId: run.runId, snapshot: empty }),
    ).resolves.toMatchObject({ status: "idempotent" });
    await database.d1
      .prepare("UPDATE lab_runs SET transcript_json = ? WHERE run_id = ?")
      .bind(JSON.stringify({ turns: [], providerMetadata: "pre-canonical-row" }), run.runId)
      .run();
    await expect(
      persistLabRunTranscriptSnapshot(database.d1, { runId: run.runId, snapshot: empty }),
    ).resolves.toMatchObject({ status: "idempotent", requestedMatches: true });
    await expect(
      completeLabRunFromSnapshot(database.d1, {
        completion: makeCompletion(run.runId, empty, 1_700_000_030_000),
      }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      completeLabRunFromSnapshot(database.d1, {
        completion: makeCompletion(run.runId, empty, 1_700_000_030_001),
      }),
    ).resolves.toMatchObject({ status: "completion_conflict" });
  });
});

describe("Runtime Transcript callback routes", () => {
  it("covers bounded delayed and retried Lab callback cases", async () => {
    const harness = await createCallbackHarness();
    const empty = await snapshot(0, { turns: [] });
    const first = await snapshot(1, {
      turns: [{ role: "participant", text: "The hallway track." }],
    });
    const firstWithProviderMetadata = {
      ...first,
      transcript: {
        turns: [
          {
            text: "The hallway track.",
            providerItemId: "item_ignored_by_canonical_identity",
            role: "participant",
          },
        ],
      },
    };
    const conflictingFirst = await snapshot(1, {
      turns: [{ role: "participant", text: "The keynote." }],
    });
    const latest = await snapshot(2, {
      turns: [
        { role: "participant", text: "The hallway track." },
        { role: "conversationAgent", text: "What made it useful?" },
      ],
    });
    const sealedConflict = await snapshot(3, {
      turns: [{ role: "participant", text: "Too late." }],
    });

    await expectReceipt(harness.transcript(firstWithProviderMetadata), 200, "stored");
    await expectReceipt(harness.transcript(first), 200, "idempotent");
    await expectReceipt(harness.transcript(conflictingFirst), 409, "conflict");
    await expectReceipt(harness.transcript(empty), 200, "stale");
    await expectReceipt(harness.transcript(latest), 200, "stored");

    const mismatchedCompletion = makeCompletion(harness.runId, first, 1_700_000_030_000);
    await expectReceipt(harness.completion(mismatchedCompletion), 409, "snapshot_mismatch");
    const completion = makeCompletion(harness.runId, latest, 1_700_000_030_000);
    await expectReceipt(harness.completion(completion), 200, "completed");
    await expectReceipt(harness.transcript(latest), 200, "idempotent");
    await expectReceipt(harness.transcript(sealedConflict), 409, "sealed");
    await expectReceipt(harness.completion(completion), 200, "idempotent");
    await expectReceipt(
      harness.completion(makeCompletion(harness.runId, latest, 1_700_000_030_001)),
      409,
      "completion_conflict",
    );
  });

  it("rejects unversioned and callback-v1 Lab payloads without persistence side effects", async () => {
    const harness = await createCallbackHarness();
    const empty = await snapshot(0, { turns: [] });
    const rejected = await snapshot(1, {
      turns: [{ role: "participant", text: "Must not be stored." }],
    });
    const completion = makeCompletion(harness.runId, empty, 1_700_000_030_000);
    for (const version of [undefined, 1] as const) {
      const transcriptResponse = await harness.obsoleteTranscript(version, {
        turns: [{ role: "participant", text: "Must not be stored." }],
      });
      expect(transcriptResponse.status).toBe(400);
      await expect(transcriptResponse.json()).resolves.toEqual({
        error: "invalid_runtime_transcript_callback",
      });
      const completionResponse = await harness.obsoleteCompletion(version, completion);
      expect(completionResponse.status).toBe(400);
      await expect(completionResponse.json()).resolves.toEqual({
        error: "invalid_runtime_completion_callback",
      });
      const currentTranscriptResponse = await harness.unsupportedCurrentTranscript(
        version,
        rejected,
      );
      expect(currentTranscriptResponse.status).toBe(400);
      await expect(currentTranscriptResponse.json()).resolves.toEqual({
        error: "invalid_runtime_transcript_callback",
      });
      const currentCompletionResponse = await harness.unsupportedCurrentCompletion(
        version,
        completion,
      );
      expect(currentCompletionResponse.status).toBe(400);
      await expect(currentCompletionResponse.json()).resolves.toEqual({
        error: "invalid_runtime_completion_callback",
      });
    }

    await expect(harness.state()).resolves.toMatchObject({
      transcript: { turns: [] },
      transcriptTurnCount: 0,
    });
    expect((await harness.state()).endedAt).toBeUndefined();
    await expectReceipt(harness.transcript(empty), 200, "idempotent");
    await expectReceipt(harness.completion(completion), 200, "completed");
  });

  it("rejects current Lab callbacks for pre-current rows with nullable snapshot identity", async () => {
    const harness = await createCallbackHarness();
    const current = await snapshot(1, {
      turns: [{ role: "participant", text: "Must not initialize this row." }],
    });
    await harness.clearSnapshotIdentity();

    await expectReceipt(harness.transcript(current), 409, "conflict");
    await expectReceipt(
      harness.completion(makeCompletion(harness.runId, current, 1_700_000_030_000)),
      409,
      "snapshot_mismatch",
    );
    await expect(harness.rawState()).resolves.toEqual({
      ended_at: null,
      runtime_completion_json: null,
      transcript_digest: null,
      transcript_json: '{"turns":[]}',
      transcript_revision: null,
      transcript_turn_count: null,
    });
  });
});

async function snapshot(
  revision: number,
  transcript: RuntimeTranscript,
): Promise<RuntimeTranscriptSnapshot> {
  return createRuntimeTranscriptSnapshot(revision, transcript);
}

function makeCompletion(
  runId: string,
  snapshotValue: RuntimeTranscriptSnapshot,
  endedAt: number,
): RuntimeCompletion {
  return {
    runId,
    outcome: "ended",
    endReason: "participant_stopped",
    source: "test",
    endingStartedAt: endedAt - 1_000,
    endedAt,
    finalizedAt: endedAt + 1_000,
    transcriptSnapshot: {
      revision: snapshotValue.revision,
      digest: snapshotValue.digest,
      turnCount: snapshotValue.turnCount,
    },
    warnings: [],
  };
}

type CallbackHarness = Readonly<{
  runId: string;
  transcript(snapshot: unknown): Promise<Response>;
  completion(completion: RuntimeCompletion): Promise<Response>;
  obsoleteTranscript(version: 1 | undefined, transcript: RuntimeTranscript): Promise<Response>;
  obsoleteCompletion(version: 1 | undefined, completion: RuntimeCompletion): Promise<Response>;
  unsupportedCurrentTranscript(
    version: 1 | undefined,
    snapshot: RuntimeTranscriptSnapshot,
  ): Promise<Response>;
  unsupportedCurrentCompletion(
    version: 1 | undefined,
    completion: RuntimeCompletion,
  ): Promise<Response>;
  clearSnapshotIdentity(): Promise<void>;
  rawState(): Promise<Readonly<Record<string, unknown>> | null>;
  state(): Promise<Readonly<{
    endedAt?: number;
    transcript: RuntimeTranscript;
    transcriptTurnCount: number;
  }> | null>;
}>;

type ObsoleteTranscriptCallbackBody = Readonly<{
  type: typeof runtimeTranscriptUpdatedCallbackType;
  runId: string;
  transcript: RuntimeTranscript;
}>;

type ObsoleteCompletionCallbackBody = Readonly<{
  type: typeof runtimeCompletedCallbackType;
  runId: string;
  endedAt: number;
  outcome: RuntimeCompletion["outcome"];
  endReason: RuntimeCompletion["endReason"];
  completion: Readonly<{ source: string }>;
}>;

type ObsoleteCallbackBody = ObsoleteTranscriptCallbackBody | ObsoleteCompletionCallbackBody;

type CurrentCallbackBodyWithoutVersion =
  | Readonly<{
      type: typeof runtimeTranscriptUpdatedCallbackType;
      runId: string;
      snapshot: RuntimeTranscriptSnapshot;
    }>
  | Readonly<{
      type: typeof runtimeCompletedCallbackType;
      completion: RuntimeCompletion;
    }>;

async function createCallbackHarness(): Promise<CallbackHarness> {
  const database = createTestLabD1Database();
  labDatabases.push(database);
  const run = await createLabRun(database.d1, { now: () => 1_700_000_000_000 });
  return {
    runId: run.runId,
    transcript: (snapshotValue) =>
      handleLabRuntimeControllerTranscript(
        callbackRequest(applicationCallbackUrl("transcript"), {
          version: 2,
          type: runtimeTranscriptUpdatedCallbackType,
          runId: run.runId,
          snapshot: snapshotValue,
        }),
        { LAB_DB: database.d1 },
      ),
    completion: (completion) =>
      handleLabRuntimeControllerCompletion(
        callbackRequest(applicationCallbackUrl("completion"), {
          version: 2,
          type: runtimeCompletedCallbackType,
          completion,
        }),
        { LAB_DB: database.d1 },
      ),
    obsoleteTranscript: (version, transcript) =>
      handleLabRuntimeControllerTranscript(
        callbackRequest(
          applicationCallbackUrl("transcript"),
          obsoleteCallbackBody(version, {
            type: runtimeTranscriptUpdatedCallbackType,
            runId: run.runId,
            transcript,
          }),
        ),
        { LAB_DB: database.d1 },
      ),
    obsoleteCompletion: (version, completion) =>
      handleLabRuntimeControllerCompletion(
        callbackRequest(
          applicationCallbackUrl("completion"),
          obsoleteCallbackBody(version, {
            type: runtimeCompletedCallbackType,
            runId: completion.runId,
            endedAt: completion.endedAt,
            outcome: completion.outcome,
            endReason: completion.endReason,
            completion: { source: completion.source },
          }),
        ),
        { LAB_DB: database.d1 },
      ),
    unsupportedCurrentTranscript: (version, snapshotValue) =>
      handleLabRuntimeControllerTranscript(
        callbackRequest(
          applicationCallbackUrl("transcript"),
          unsupportedVersionBody(version, {
            type: runtimeTranscriptUpdatedCallbackType,
            runId: run.runId,
            snapshot: snapshotValue,
          }),
        ),
        { LAB_DB: database.d1 },
      ),
    unsupportedCurrentCompletion: (version, completion) =>
      handleLabRuntimeControllerCompletion(
        callbackRequest(
          applicationCallbackUrl("completion"),
          unsupportedVersionBody(version, {
            type: runtimeCompletedCallbackType,
            completion,
          }),
        ),
        { LAB_DB: database.d1 },
      ),
    clearSnapshotIdentity: async () => {
      await database.d1
        .prepare(
          `UPDATE lab_runs
           SET transcript_revision = NULL,
               transcript_digest = NULL,
               transcript_turn_count = NULL
           WHERE run_id = ?`,
        )
        .bind(run.runId)
        .run();
    },
    rawState: () =>
      database.d1
        .prepare(
          `SELECT
             ended_at,
             runtime_completion_json,
             transcript_digest,
             transcript_json,
             transcript_revision,
             transcript_turn_count
           FROM lab_runs
           WHERE run_id = ?`,
        )
        .bind(run.runId)
        .first(),
    state: () => getLabRun(database.d1, run.runId),
  };
}

function obsoleteCallbackBody(version: 1 | undefined, body: ObsoleteCallbackBody) {
  if (version === undefined) return body;
  return { ...body, version };
}

function unsupportedVersionBody(version: 1 | undefined, body: CurrentCallbackBodyWithoutVersion) {
  if (version === undefined) return body;
  return { ...body, version };
}

function callbackRequest<Body extends Readonly<Record<string, unknown>>>(
  url: string,
  body: Body,
): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function expectReceipt(
  responsePromise: Promise<Response>,
  expectedHttpStatus: number,
  expectedStatus: string,
): Promise<void> {
  const response = await responsePromise;
  expect(response.status).toBe(expectedHttpStatus);
  await expect(response.json()).resolves.toMatchObject({
    version: 2,
    status: expectedStatus,
  });
}
