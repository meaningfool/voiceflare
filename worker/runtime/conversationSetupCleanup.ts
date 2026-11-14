import { Effect } from "effect";
import type { InterviewFinalizationRepository } from "./interviewFinalizationRepository.ts";
import type { ProviderSession } from "./nativeContracts.ts";
import type { RuntimeEvents } from "./runtimeEvents.ts";

/** Native pre-Live cleanup; the existing run owner retains the demand and publication order. */
export class ConversationSetupCleanup {
  readonly repository: InterviewFinalizationRepository;
  readonly provider: ProviderSession;
  readonly events: RuntimeEvents;
  constructor(
    repository: InterviewFinalizationRepository,
    provider: ProviderSession,
    events: RuntimeEvents,
  ) {
    this.repository = repository;
    this.provider = provider;
    this.events = events;
  }
  handlePending(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const state = this.repository.requireState();
      if (state.setup_cleanup_pending !== 1) return Effect.void;
      if (state.session_id === null) {
        if (state.provider_creation_started === 1) this.#unconfirmed(null);
        this.repository.finishSetupCleanup(state.run_id);
        return Effect.void;
      }
      return this.#hangUp(state.run_id, state.session_id);
    });
  }
  #hangUp(runId: string, sessionId: string): Effect.Effect<void> {
    // A rejected native hangup is a defect: it preserves the demand for recovery.
    return Effect.suspend(() => this.provider.release(sessionId)).pipe(
      Effect.map((result) => {
        if (result.status === "close_unconfirmed" && result.failure !== undefined)
          this.#unconfirmed(sessionId);
        // Typed unconfirmed/failure handled the demand.
        this.repository.finishSetupCleanup(runId);
      }),
    );
  }
  #unconfirmed(sessionId: string | null): void {
    this.events.recordUniqueDiagnostic(
      "runtime.provider_cleanup_unconfirmed",
      (payload) => payload.sessionId === sessionId,
      { reason: "provider_cleanup_unconfirmed", sessionId },
    );
  }
}
