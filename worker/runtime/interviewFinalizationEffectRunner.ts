import { selectEndingOperation } from "./conversationEnd.ts";
import { Effect } from "effect";
import { type EndingOperation } from "./nativeContracts.ts";
import {
  type FinalizationEffectKind,
  type FinalizationEffectOutcome,
  type FinalizationEffectRecord,
  type InputClosureSettlement,
} from "./interviewFinalizationModel.ts";

export type FinalizationEffectRunnerResult = Readonly<{
  kind: "outcome";
  effectId: string;
  effectKind: FinalizationEffectKind;
  outcome: FinalizationEffectOutcome;
  digestRevision?: number;
}>;

export type FinalizationEffectCrashPoint =
  | "after_attempt_before_dispatch"
  | "after_dispatch_before_outcome";

export type FinalizationEffectRunnerCapabilities = Readonly<{
  repository: Readonly<{ recordAttempt(effectId: string): void }>;
  connection: Readonly<{ ready: boolean }>;
  provider: Readonly<{
    sendFinalizationOperation(operation: EndingOperation): FinalizationEffectOutcome;
    /** How the execution would settle an input closure that is not dispatched. */
    describeInputClosure?(
      operation: Extract<EndingOperation, { kind: "close_input" }>,
    ): InputClosureSettlement | undefined;
    /** Dispatches the session's release when called; the returned Effect awaits its outcome. */
    release(): Effect.Effect<FinalizationEffectOutcome>;
  }>;
}>;

// Call within the coordinator's synchronous selection section: validation,
// durable claim and native dispatch have no scheduler boundary between them.
export function runInterviewFinalizationEffect({
  effect,
  capabilities,
  crashInjector,
}: Readonly<{
  effect: FinalizationEffectRecord;
  capabilities: FinalizationEffectRunnerCapabilities;
  crashInjector?: (point: FinalizationEffectCrashPoint, effect: FinalizationEffectRecord) => void;
}>): Effect.Effect<FinalizationEffectRunnerResult> {
  if (effect.status !== "pending") {
    throw new Error(`invalid_finalization_effect_status:${effect.status}`);
  }
  assertExecutableEffect(effect);
  if (requiresConnectedSession(effect.kind) && !capabilities.connection.ready) {
    const outcome: FinalizationEffectOutcome = {
      status: "failed",
      code: "session_unavailable_before_dispatch",
    };
    const settlement =
      effect.kind === "close_input"
        ? capabilities.provider.describeInputClosure?.({
            kind: "close_input",
            commandId: effect.id,
            heldItemId: effect.heldItemId,
          })
        : undefined;
    return Effect.succeed({
      kind: "outcome",
      effectId: effect.id,
      effectKind: effect.kind,
      outcome: settlement === undefined ? outcome : { ...outcome, settlement },
    });
  }
  capabilities.repository.recordAttempt(effect.id);
  crashInjector?.("after_attempt_before_dispatch", effect);
  if (effect.kind === "compute_transcript_digest") {
    const result: FinalizationEffectRunnerResult = {
      kind: "outcome",
      effectId: effect.id,
      effectKind: effect.kind,
      outcome: { status: "dispatched" },
      digestRevision: effect.revision,
    };
    crashInjector?.("after_dispatch_before_outcome", effect);
    return Effect.succeed(result);
  }
  if (effect.kind === "arm_alarm") {
    const result = {
      kind: "outcome",
      effectId: effect.id,
      effectKind: effect.kind,
      outcome: { status: "dispatched" },
    } as const;
    crashInjector?.("after_dispatch_before_outcome", effect);
    return Effect.succeed(result);
  }
  if (effect.kind === "release_session") {
    return capabilities.provider.release().pipe(
      Effect.map((outcome) => {
        crashInjector?.("after_dispatch_before_outcome", effect);
        return { kind: "outcome", effectId: effect.id, effectKind: effect.kind, outcome };
      }),
    );
  }

  const providerOutcome = capabilities.provider.sendFinalizationOperation(
    selectEndingOperation(effect),
  );
  const result = {
    kind: "outcome",
    effectId: effect.id,
    effectKind: effect.kind,
    // Once socket dispatch begins, a thrown/failed send cannot establish that
    // the provider saw nothing. Preserve that ambiguity and never resend.
    outcome:
      providerOutcome.status === "failed"
        ? { ...providerOutcome, status: "uncertain" as const }
        : providerOutcome,
  } as const;
  crashInjector?.("after_dispatch_before_outcome", effect);
  return Effect.succeed(result);
}

function requiresConnectedSession(kind: FinalizationEffectKind): boolean {
  return kind !== "compute_transcript_digest" && kind !== "arm_alarm" && kind !== "release_session";
}

function assertExecutableEffect(effect: FinalizationEffectRecord): void {
  if (effect.kind === "cancel_reply" && effect.responseId.trim().length === 0) {
    throw new Error("invalid_finalization_effect:cancel_reply_response_id");
  }
  if (
    effect.kind === "compute_transcript_digest" &&
    (!Number.isSafeInteger(effect.revision) || effect.revision < 0)
  ) {
    throw new Error("invalid_finalization_effect:compute_transcript_digest_revision");
  }
}

export { finalizationEffectRecoveryContracts } from "./conversationEnd.ts";

export type { FinalizationEffectRecoveryContract } from "./conversationEnd.ts";
