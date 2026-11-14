export type RuntimeTranscriptTurn = Readonly<{
  role: "participant" | "conversationAgent";
  text: string;
}>;

export type RuntimeTranscript = Readonly<{
  turns: readonly RuntimeTranscriptTurn[];
}>;

export type RuntimeTranscriptSnapshot = Readonly<{
  revision: number;
  digest: string;
  turnCount: number;
  transcript: RuntimeTranscript;
}>;

export type RuntimeTranscriptSnapshotRef = Readonly<{
  revision: number;
  digest: string;
  turnCount: number;
}>;

export function canonicalizeRuntimeTranscript(transcript: RuntimeTranscript): string {
  return JSON.stringify({
    turns: transcript.turns.map(({ role, text }) => ({ role, text })),
  });
}

export async function computeRuntimeTranscriptDigest(
  transcript: RuntimeTranscript,
): Promise<string> {
  const encoded = new TextEncoder().encode(canonicalizeRuntimeTranscript(transcript));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );

  return `sha256:${hex}`;
}

export async function createRuntimeTranscriptSnapshot(
  revision: number,
  transcript: RuntimeTranscript,
): Promise<RuntimeTranscriptSnapshot> {
  return {
    revision,
    digest: await computeRuntimeTranscriptDigest(transcript),
    turnCount: transcript.turns.length,
    transcript,
  };
}

export function toTranscriptSnapshotRef(
  snapshot: RuntimeTranscriptSnapshot,
): RuntimeTranscriptSnapshotRef {
  return {
    revision: snapshot.revision,
    digest: snapshot.digest,
    turnCount: snapshot.turnCount,
  };
}

export function matchesTranscriptSnapshotRef(
  snapshot: RuntimeTranscriptSnapshot,
  reference: RuntimeTranscriptSnapshotRef,
): boolean {
  return (
    snapshot.revision === reference.revision &&
    snapshot.digest === reference.digest &&
    snapshot.turnCount === reference.turnCount
  );
}

export function matchesTranscriptSnapshotIdentity(
  left: RuntimeTranscriptSnapshotRef | null,
  right: RuntimeTranscriptSnapshotRef | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.revision === right.revision &&
    left.digest === right.digest &&
    left.turnCount === right.turnCount
  );
}
