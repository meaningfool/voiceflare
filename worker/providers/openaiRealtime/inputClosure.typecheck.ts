import type { RealtimeInputState } from "./inputClosure.ts";

function checkRealtimeInputState(): void {
  const committing: RealtimeInputState = {
    phase: "committing",
    buffered: { itemId: "item" },
    committedItemId: null,
    outcome: { status: "failed", code: "goodbye_command_rejected" },
  };
  const openCommit: RealtimeInputState = {
    phase: "open",
    buffered: null,
    committedItemId: null,
    // @ts-expect-error A final commit exists only after input admission closed.
    outcome: { status: "dispatched" },
  };
  const closedOutcome: RealtimeInputState = {
    phase: "closed",
    buffered: null,
    committedItemId: "item",
    // @ts-expect-error A settled commit no longer carries a commit outcome.
    outcome: { status: "failed", code: "goodbye_command_rejected" },
  };
  void committing;
  void openCommit;
  void closedOutcome;
}
void checkRealtimeInputState;
