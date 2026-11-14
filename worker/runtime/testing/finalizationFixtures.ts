import { prepareConversationReceipt } from "../conversationObserve.ts";
import { advanceInterviewFinalization } from "../interviewFinalizationFSM.ts";
import {
  createLiveInterviewFinalizationAggregate,
  type FinalizationDecision,
  type InterviewFinalizationAggregate,
  type ProviderFinalizationObservation,
  type SerializedTranscriptCapture,
} from "../interviewFinalizationModel.ts";
import { createRuntimeUsageAccounting } from "../runtimeUsage.ts";

/** A Live aggregate as go-live creates it: Transcript proof from `liveAt`, empty usage accounting. */
export function liveFinalizationAggregate(
  input: Readonly<{
    runId: string;
    liveAt?: number;
    transcriptCapture?: SerializedTranscriptCapture;
  }>,
): InterviewFinalizationAggregate {
  return createLiveInterviewFinalizationAggregate({
    liveAt: 0,
    runtimeUsage: createRuntimeUsageAccounting(),
    ...input,
  });
}

/**
 * The coordinator's receipt seam without a selected Conversation: the native receipt is
 * interpreted into semantic evidence, and only that evidence advances finalization.
 */
export function receiveConversationReceipt(
  aggregate: InterviewFinalizationAggregate,
  observation: ProviderFinalizationObservation,
): FinalizationDecision {
  return advanceInterviewFinalization(
    aggregate,
    prepareConversationReceipt(aggregate, observation),
    {
      usageEvidenceSupplied: true,
    },
  );
}
