import type {
  FinalizationEffectKind,
  InterviewFinalizationStage,
} from "./interviewFinalizationModel.ts";

// These decisions apply to pending records. Non-pending history remains valid
// in every stage, but cannot be selected for execution.
export type FinalizationPendingEffectPolicy =
  | "persist_and_run"
  | "persist_only"
  | "run_only"
  | "neither";
export type FinalizationEffectStagePolicy = Readonly<
  Record<
    InterviewFinalizationStage,
    Readonly<Record<FinalizationEffectKind, FinalizationPendingEffectPolicy>>
  >
>;

// Preserve the existing contract differences: live/finalizing alarms are
// runnable but not valid pending storage; closing retains a pending input closure
// without dispatching it. Consolidation must not widen decoding.
export const finalizationEffectStagePolicy = {
  live: {
    compute_transcript_digest: "persist_and_run",
    close_input: "persist_and_run",
    discard_later_input: "persist_and_run",
    cancel_reply: "persist_and_run",
    stop_output: "persist_and_run",
    release_session: "persist_and_run",
    arm_alarm: "run_only",
  },
  draining: {
    compute_transcript_digest: "persist_and_run",
    close_input: "persist_and_run",
    discard_later_input: "persist_and_run",
    cancel_reply: "persist_and_run",
    stop_output: "persist_and_run",
    release_session: "persist_and_run",
    arm_alarm: "persist_and_run",
  },
  closing_provider: {
    compute_transcript_digest: "persist_and_run",
    close_input: "persist_only",
    discard_later_input: "persist_and_run",
    cancel_reply: "persist_and_run",
    stop_output: "persist_and_run",
    release_session: "persist_and_run",
    arm_alarm: "persist_and_run",
  },
  finalizing: {
    compute_transcript_digest: "persist_and_run",
    close_input: "neither",
    discard_later_input: "neither",
    cancel_reply: "neither",
    stop_output: "neither",
    release_session: "persist_and_run",
    arm_alarm: "run_only",
  },
  ended: {
    compute_transcript_digest: "neither",
    close_input: "neither",
    discard_later_input: "neither",
    cancel_reply: "neither",
    stop_output: "neither",
    // The frozen result may retain one definitely-never-started hangup. Its
    // first dispatch is cleanup-only and must not reopen the result.
    release_session: "persist_and_run",
    arm_alarm: "neither",
  },
} as const satisfies FinalizationEffectStagePolicy;

export function permitsPendingFinalizationEffectPersistence(
  stage: InterviewFinalizationStage,
  kind: FinalizationEffectKind,
): boolean {
  const decision = finalizationEffectStagePolicy[stage][kind];
  return decision === "persist_and_run" || decision === "persist_only";
}

export function permitsFinalizationEffectExecution(
  stage: InterviewFinalizationStage,
  kind: FinalizationEffectKind,
): boolean {
  const decision = finalizationEffectStagePolicy[stage][kind];
  return decision === "persist_and_run" || decision === "run_only";
}
