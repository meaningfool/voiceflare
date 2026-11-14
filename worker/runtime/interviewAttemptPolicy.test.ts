import { describe, expect, it } from "vitest";

import { decideRuntimeSetupTransition } from "./interviewAttemptPolicy.ts";

const applicationSetup = {
  phase: "setup",
  startupExpiresAt: 2_000,
} as const;

describe("Runtime setup transition policy", () => {
  it("admits readiness only when the authoritative transition is before expiry", () => {
    expect(
      decideRuntimeSetupTransition(applicationSetup, {
        kind: "execution_ready",
        liveEvidenceAt: 1_900,
        transitionAt: 1_999,
      }),
    ).toEqual({ kind: "commit_live" });

    expect(
      decideRuntimeSetupTransition(applicationSetup, {
        kind: "execution_ready",
        liveEvidenceAt: 1_900,
        transitionAt: 2_000,
      }),
    ).toEqual({ kind: "commit_failed_start", endedAt: 2_000 });
  });

  it("clamps an application setup failure to the immutable expiry", () => {
    expect(
      decideRuntimeSetupTransition(applicationSetup, {
        kind: "setup_failed",
        observedAt: 2_100,
      }),
    ).toEqual({ kind: "commit_failed_start", endedAt: 2_000 });
  });

  it("cannot reopen a transition that already left setup", () => {
    expect(
      decideRuntimeSetupTransition(
        { ...applicationSetup, phase: "failed" },
        { kind: "execution_ready", liveEvidenceAt: 1_900, transitionAt: 1_900 },
      ),
    ).toEqual({ kind: "unchanged" });
  });
});
