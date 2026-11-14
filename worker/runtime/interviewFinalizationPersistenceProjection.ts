import type { RuntimeTranscriptTurn } from "../shared/runtimeControllerCallback.ts";
import {
  conversationNodeDeadline,
  getSerializedTranscriptTurns,
  readFinalizationTranscriptTurns,
  type InterviewFinalizationAggregate,
  type RuntimeFinalizationCompletion,
  type RuntimePublicationState,
} from "./interviewFinalizationModel.ts";
import {
  projectInterviewFinalizationLifecycle,
  type InterviewFinalizationPendingClose,
  type InterviewFinalizationPhase,
} from "./interviewFinalizationLifecycleProjection.ts";

export type InterviewFinalizationPersistenceFacts = Readonly<{
  liveDeadlineAt: number | null;
  /** Whether the Run has an application to deliver its result to. */
  deliveryConfigured: boolean;
}>;

export type InterviewFinalizationFrozenTranscript = Readonly<{
  turns: readonly RuntimeTranscriptTurn[];
  revision: number;
  digest: string;
  turnCount: number;
}>;

export type InterviewFinalizationPublicationDelivery = Readonly<{
  pending: boolean;
  deliveredAt: number | null;
  retryAt: number | null;
  lastError: string | null;
}>;

export type InterviewFinalizationPersistence = Readonly<{
  phase: InterviewFinalizationPhase;
  deadlineAt: number | null;
  pendingClose: InterviewFinalizationPendingClose | null;
  transcriptTurns: readonly RuntimeTranscriptTurn[];
  completion: RuntimeFinalizationCompletion | null;
  frozenTranscript: InterviewFinalizationFrozenTranscript | null;
  /** The frozen result's publication progress; a Run has none before it ends. */
  publication: RuntimePublicationState | null;
  publicationDelivery: InterviewFinalizationPublicationDelivery;
}>;

export function projectInterviewFinalizationPersistence(
  aggregate: InterviewFinalizationAggregate,
  facts: InterviewFinalizationPersistenceFacts,
): InterviewFinalizationPersistence {
  const lifecycle = projectInterviewFinalizationLifecycle(aggregate);
  const state = aggregate.state;

  let deadlineAt: number | null;
  let frozenTranscript: InterviewFinalizationFrozenTranscript | null = null;
  switch (state.stage) {
    case "live":
      deadlineAt =
        aggregate.conversationNodeExecution === undefined
          ? facts.liveDeadlineAt
          : conversationNodeDeadline(aggregate.conversationNodeExecution);
      break;
    case "draining":
      deadlineAt = state.finalizationCutoffAt;
      break;
    case "closing_provider":
      deadlineAt = state.finalizationCutoffAt;
      break;
    case "finalizing":
      deadlineAt = null;
      break;
    case "ended":
      deadlineAt = null;
      frozenTranscript = {
        turns: getSerializedTranscriptTurns(aggregate.transcriptCapture),
        ...state.completion.transcriptSnapshot,
      };
      break;
    default:
      return assertUnreachable(state);
  }

  const publication = state.stage === "ended" ? state.publication : null;
  const pending =
    publication !== null &&
    facts.deliveryConfigured &&
    (publication.status === "pending" || publication.status === "retrying");
  const retryAt =
    !pending || publication === null
      ? null
      : publication.status === "pending"
        ? (lifecycle.completion?.finalizedAt ?? null)
        : (publication.retryAt ?? publication.publicationCutoffAt);
  const deliveredAt = publication?.status === "delivered" ? publication.deliveredAt : null;
  const lastError =
    publication === null
      ? null
      : publication.status === "retrying" ||
          publication.status === "expired" ||
          publication.status === "blocked_snapshot_conflict" ||
          publication.status === "blocked_nonretryable_callback"
        ? publication.lastError
        : null;

  return {
    phase: lifecycle.phase,
    deadlineAt,
    pendingClose: lifecycle.pendingClose,
    transcriptTurns: readFinalizationTranscriptTurns(aggregate),
    completion: lifecycle.completion,
    frozenTranscript,
    publication,
    publicationDelivery: { pending, deliveredAt, retryAt, lastError },
  };
}

function assertUnreachable(value: never): never {
  throw new Error(`Unsupported Interview finalization state: ${JSON.stringify(value)}`);
}
