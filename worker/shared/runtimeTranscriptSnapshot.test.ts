import { describe, expect, it } from "vitest";
import {
  canonicalizeRuntimeTranscript,
  computeRuntimeTranscriptDigest,
  createRuntimeTranscriptSnapshot,
  matchesTranscriptSnapshotRef,
  toTranscriptSnapshotRef,
} from "./runtimeTranscriptSnapshot.ts";

describe("Runtime Transcript snapshots", () => {
  // Literal UTF-8 canonical bytes and SHA-256 computed independently with Python hashlib.
  it("matches the fixed ordered transcript vector and exact identity axes", async () => {
    const transcript = {
      turns: [
        { role: "conversationAgent" as const, text: "A closing question." },
        { role: "participant" as const, text: "  Keep the spaces.  " },
      ],
    };
    const reference = {
      revision: 7,
      digest: "sha256:0a11a5190b328ee62b08747a9a0d7f8f74109ebdbc1dcb2e6b43dd02a69b1104",
      turnCount: 2,
    };
    expect(canonicalizeRuntimeTranscript(transcript)).toBe(
      '{"turns":[{"role":"conversationAgent","text":"A closing question."},{"role":"participant","text":"  Keep the spaces.  "}]}',
    );
    await expect(computeRuntimeTranscriptDigest(transcript)).resolves.toBe(reference.digest);
    const snapshot = await createRuntimeTranscriptSnapshot(7, transcript);
    expect(snapshot).toEqual({ ...reference, transcript });
    expect(toTranscriptSnapshotRef(snapshot)).toEqual(reference);
    expect(matchesTranscriptSnapshotRef(snapshot, reference)).toBe(true);
    for (const mismatched of [
      { ...reference, revision: 8 },
      { ...reference, digest: "sha256:wrong" },
      { ...reference, turnCount: 1 },
    ])
      expect(matchesTranscriptSnapshotRef(snapshot, mismatched)).toBe(false);
  });
  it("matches the independent empty revision-zero vector", async () => {
    await expect(createRuntimeTranscriptSnapshot(0, { turns: [] })).resolves.toEqual({
      revision: 0,
      digest: "sha256:d5fb095584e9f878eda4919412601f834c18fc24b3310d16ce21830a025a95f8",
      turnCount: 0,
      transcript: { turns: [] },
    });
  });
});
