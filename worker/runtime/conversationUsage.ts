import type { ConversationUsageEvidence, RuntimeUsageAccountingState } from "./runtimeUsage.ts";
import type {
  FinalizationObservation,
  InterviewFinalizationStage,
} from "./interviewFinalizationModel.ts";

/**
 * The usage evidence of one observation: what the execution reported with it, and the
 * uncertainty Runtime adds when the execution's connection or provider work ended while usage
 * might still be unreported. Runtime names no component, provider or operation of its own.
 */
export function observeConversationUsage(
  observation: FinalizationObservation,
  stage: InterviewFinalizationStage | "setup",
  execution: Pick<RuntimeUsageAccountingState, "pending" | "processedKeys" | "observations">,
): readonly ConversationUsageEvidence[] {
  const reported = "usage" in observation ? (observation.usage ?? []) : [];
  switch (observation.kind) {
    case "session_closed_observed":
      if (
        stage === "live" ||
        (stage === "setup" && hasObservedExecution(execution)) ||
        execution.pending.length > 0
      ) {
        return [...reported, { status: "uncertain" }];
      }
      return reported;
    case "runtime_failure_observed":
      // A failure of the execution's provider or session may leave usage unreported.
      if (observation.source.includes("provider") || observation.source.includes("session")) {
        return [{ status: "uncertain" }];
      }
      return reported;
    default:
      return reported;
  }
}

/** One kind of usage entry a combination declares: its component, provider, measure and unit. */
type DeclaredUsage = Pick<
  Extract<ConversationUsageEvidence, { status: "satisfied" }>["measurements"][number],
  "componentRole" | "provider" | "measure" | "unit"
>;

/**
 * Runtime's one check of reported usage, against the declarations of the providers in the Run's
 * combination: entries it declares pass, and an entry it does not declare is dropped, which makes
 * the published usage incomplete, as invalid usage does.
 */
export function admitDeclaredUsage(
  evidence: readonly ConversationUsageEvidence[],
  declarations: readonly DeclaredUsage[],
): readonly ConversationUsageEvidence[] {
  const declared = new Set(declarations.map(declarationKey));
  let undeclared = false;
  const admitted = evidence.map((item) => {
    if (item.status !== "satisfied") return item;
    const measurements = item.measurements.filter((entry) => declared.has(declarationKey(entry)));
    if (measurements.length === item.measurements.length) return item;
    undeclared = true;
    return { ...item, measurements };
  });
  return undeclared ? [...admitted, { status: "uncertain" }] : evidence;
}

function declarationKey(item: DeclaredUsage): string {
  return JSON.stringify([item.componentRole, item.provider, item.measure, item.unit]);
}

function hasObservedExecution(
  state: Pick<RuntimeUsageAccountingState, "pending" | "processedKeys" | "observations">,
): boolean {
  return (
    state.pending.length > 0 || state.processedKeys.length > 0 || state.observations.length > 0
  );
}
