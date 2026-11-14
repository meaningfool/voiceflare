export const applicationSetupDeadlineMs = 120_000;

export type RuntimeSetupTransitionState = Readonly<{
  phase: "setup" | "live" | "ending" | "ended" | "failed";
  startupExpiresAt: number | null;
}>;

export type RuntimeSetupTransitionDecision =
  | Readonly<{ kind: "commit_live" }>
  | Readonly<{ kind: "commit_failed_start"; endedAt: number }>
  | Readonly<{ kind: "unchanged" }>;

/**
 * Owns provider-independent pre-Live transition eligibility. Provider evidence
 * supplies `liveEvidenceAt`; the transition owner supplies `transitionAt` from
 * the clock immediately before the atomic durable write.
 */
export function decideRuntimeSetupTransition(
  state: RuntimeSetupTransitionState,
  event:
    | Readonly<{
        kind: "execution_ready";
        liveEvidenceAt: number;
        transitionAt: number;
      }>
    | Readonly<{ kind: "setup_failed"; observedAt: number }>,
): RuntimeSetupTransitionDecision {
  if (state.phase !== "setup") return { kind: "unchanged" };

  if (event.kind === "execution_ready") {
    if (state.startupExpiresAt !== null && event.transitionAt >= state.startupExpiresAt) {
      return { kind: "commit_failed_start", endedAt: state.startupExpiresAt };
    }
    return { kind: "commit_live" };
  }

  return {
    kind: "commit_failed_start",
    endedAt:
      state.startupExpiresAt === null
        ? event.observedAt
        : Math.min(event.observedAt, state.startupExpiresAt),
  };
}
