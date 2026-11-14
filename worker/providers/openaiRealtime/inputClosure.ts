import type { ExecutionIdentity } from "../../runtime/executionContracts.ts";
import type { RealtimeObservation } from "./speech.ts";

/** Admitted participant speech that no native item has committed yet. */
type BufferedInput = Readonly<{ itemId: string | null }>;
type InputEvidence = Readonly<{
  buffered: BufferedInput | null;
  committedItemId: string | null;
}>;
/** The shared outcome of the one commit of the final answer, whoever asked first. */
export type InputCommitOutcome =
  | Readonly<{ status: "dispatched" }>
  | Readonly<{ status: "failed"; code: string }>;
/**
 * Participant input: open, closed once, or committing the final answer. The commit is claimed
 * before its command is sent, so a committing input already reports it dispatched; a provider
 * rejection of that command turns its outcome into a failure.
 */
export type RealtimeInputState =
  | (InputEvidence & Readonly<{ phase: "open" }>)
  | (InputEvidence & Readonly<{ phase: "closed" }>)
  | (InputEvidence & Readonly<{ phase: "committing"; outcome: InputCommitOutcome }>);

/**
 * The node that owns the closed input, once it entered: its identity is attached to the item
 * that settles the buffered speech or the final commit, and it hears each committed item and
 * that settlement.
 */
export type InputClosureOwner = Readonly<{
  identity: ExecutionIdentity;
  committed(itemId: string): void;
  settled(): void;
}>;

/** What one provider observation means for participant input. */
export type InputObservation = Readonly<{
  /** Speech that no longer counts: input had closed before it was admitted. */
  excludedParticipantInput?: true;
  /** The item that settled the buffered speech or the final commit, with its owner if known. */
  consumedActiveInput?: Readonly<{ itemId: string; identity?: ExecutionIdentity }>;
}>;

function close(state: RealtimeInputState): RealtimeInputState {
  return state.phase === "open" ? { ...state, phase: "closed" } : state;
}
function requestCommit(state: RealtimeInputState): RealtimeInputState {
  if (state.phase === "committing") return state;
  return {
    phase: "committing",
    buffered: state.buffered,
    committedItemId: state.committedItemId,
    outcome: { status: "dispatched" },
  };
}
function rejectCommit(state: RealtimeInputState, code: string): RealtimeInputState {
  return state.phase === "committing" ? { ...state, outcome: { status: "failed", code } } : state;
}
function admitActivity(
  state: Extract<RealtimeInputState, { phase: "open" }>,
  itemId: string | undefined,
): RealtimeInputState {
  return { ...state, buffered: { itemId: itemId ?? null } };
}
function retainActivity(state: RealtimeInputState): RealtimeInputState {
  return state.buffered === null ? { ...state, buffered: { itemId: null } } : state;
}
function recordCommittedItem(state: RealtimeInputState, itemId: string): RealtimeInputState {
  return { ...state, committedItemId: itemId };
}
function retainCommittedItem(state: RealtimeInputState, itemId: string): RealtimeInputState {
  return state.committedItemId === null ? recordCommittedItem(state, itemId) : state;
}
/** The owned native item settles the buffered speech and any final commit. */
function consumeBuffered(state: RealtimeInputState): RealtimeInputState {
  if (state.phase !== "committing") return { ...state, buffered: null };
  return { phase: "closed", buffered: null, committedItemId: state.committedItemId };
}

/**
 * The Realtime kit's participant input closure, one per session: which participant speech
 * still counts once input closed, and the one commit of the final answer, whoever asks first
 * (Ending's commit or a closing node). Speech admitted while input was open keeps counting
 * after it closed: its items, their transcriptions and the item that commits it. So do the
 * participant items Runtime retained before a restart. Speech that starts after input closed
 * does not, except the one item that answers the final commit.
 */
export class RealtimeInputClosure {
  #state: RealtimeInputState = { phase: "open", buffered: null, committedItemId: null };
  // These sets index native item evidence; the input phase lives only in #state.
  readonly #admitted = new Set<string>();
  readonly #committed = new Set<string>();
  readonly #excluded = new Set<string>();
  #owner: InputClosureOwner | null = null;

  get state(): RealtimeInputState {
    return this.#state;
  }
  /** The final commit's shared outcome while it is pending, otherwise null. */
  get commitOutcome(): InputCommitOutcome | null {
    return this.#state.phase === "committing" ? this.#state.outcome : null;
  }
  /** Closes input: speech that starts from now on no longer counts. */
  close(): void {
    this.#state = close(this.#state);
  }
  /** Claims the final commit before its command is sent; a second claim reuses the first. */
  requestCommit(): void {
    this.#state = requestCommit(this.#state);
  }
  rejectCommit(code: string): void {
    this.#state = rejectCommit(this.#state, code);
  }
  /** Restores what Runtime retained of the closed input when a node enters after a restart. */
  retain(input: Readonly<{ committedItemId: string | null; activityObserved: boolean }>): void {
    if (input.committedItemId !== null) {
      this.#admitted.add(input.committedItemId);
      this.#committed.add(input.committedItemId);
      this.#state = retainCommittedItem(this.#state, input.committedItemId);
    }
    if (input.activityObserved) this.#state = retainActivity(this.#state);
  }
  /** Attributes the closed input to the node that entered; it stays its owner. */
  attribute(owner: InputClosureOwner): void {
    this.#owner = owner;
  }

  /**
   * Observes one provider observation in arrival order. `itemId` is the native item the
   * observation names, `acceptsNewInput` whether Runtime still admits participant input, and
   * `retainedItemIds` the participant items Runtime already holds as evidence.
   */
  observe(
    observation: RealtimeObservation,
    itemId: string | undefined,
    acceptsNewInput: boolean,
    retainedItemIds: readonly string[] = [],
  ): InputObservation {
    for (const retained of retainedItemIds) {
      this.#admitted.add(retained);
      this.#committed.add(retained);
    }
    if (!acceptsNewInput) this.#state = close(this.#state);
    if (
      observation.kind === "participant_answer_created" &&
      this.#committed.has(observation.itemId)
    )
      return { excludedParticipantInput: true };
    const ownedCommit =
      observation.kind === "participant_answer_created" &&
      (this.#state.buffered?.itemId === observation.itemId ||
        (this.#state.phase === "committing" &&
          !this.#admitted.has(observation.itemId) &&
          !this.#excluded.has(observation.itemId)));
    if (observation.kind === "speech_started") {
      if (this.#state.phase !== "open") {
        if (itemId !== undefined) this.#excluded.add(itemId);
        return { excludedParticipantInput: true };
      }
      this.#state = admitActivity(this.#state, itemId);
      if (itemId !== undefined) this.#admitted.add(itemId);
    }
    if (
      observation.kind === "speech_stopped" &&
      this.#state.phase !== "open" &&
      itemId !== (this.#state.buffered?.itemId ?? null)
    )
      return { excludedParticipantInput: true };
    if (
      observation.kind === "participant_answer_created" ||
      observation.kind === "participant_answer_transcribed" ||
      observation.kind === "participant_answer_transcription_failed" ||
      (observation.kind === "transcript_item_observed" && observation.role === "participant")
    ) {
      if (this.#state.phase !== "open" && !this.#admitted.has(observation.itemId) && !ownedCommit)
        return { excludedParticipantInput: true };
      this.#admitted.add(observation.itemId);
      if (observation.kind === "participant_answer_created") {
        this.#committed.add(observation.itemId);
        this.#state = recordCommittedItem(this.#state, observation.itemId);
        this.#owner?.committed(observation.itemId);
      }
    }
    if (observation.kind !== "participant_answer_created" || !ownedCommit) return {};
    this.#state = consumeBuffered(this.#state);
    const owner = this.#owner;
    if (owner === null) return { consumedActiveInput: { itemId: observation.itemId } };
    owner.settled();
    return { consumedActiveInput: { itemId: observation.itemId, identity: owner.identity } };
  }
}
