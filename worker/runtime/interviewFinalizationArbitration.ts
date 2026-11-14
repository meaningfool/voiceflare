import type { FinalizationInput, FinalizationObservation } from "./interviewFinalizationModel.ts";

export type FinalizationContractCoverage =
  | Readonly<{
      kind: "automated_test";
      file: string;
      title: string;
    }>
  | Readonly<{
      kind: "controlled_trace";
      name: string;
      evidence: string;
    }>
  | Readonly<{
      kind: "later_owning_issue";
      issue: `#${number}`;
      scope: string;
    }>;

export type InterviewRuntimeControllerEntry =
  | "alarm"
  | "reconstruction"
  | "inbound_request"
  | "provider_observation"
  | "effect_outcome"
  | "presence_observation"
  | "runtime_failure"
  | "execution_wake"
  | "effect_dispatch";

export type ProviderCloseEvidence =
  | "hangup_acknowledged"
  | "hangup_already_closed"
  | "session_closed_observed";

export type InterviewRuntimeControllerWork = Readonly<{
  id: string;
  kind:
    | "timebox_deadline"
    | "presence_grace_deadline"
    | "browser_media_ready_deadline"
    | "drain_deadline"
    | "provider_close_deadline"
    | "inbound_request"
    | "provider_observation"
    | "effect_outcome"
    | "execution_wake"
    | "provider_effect"
    | "presence_renewal"
    | "runtime_failure"
    | "terminal_close_evidence"
    | "nonterminal_close_evidence"
    | "publication";
  due?: boolean;
  deadlineAt?: number;
  order?: number;
  evidence?: ProviderCloseEvidence;
}>;

export type InterviewRuntimeControllerArbitrationInput = Readonly<{
  entry: InterviewRuntimeControllerEntry;
  eligibleWork: readonly InterviewRuntimeControllerWork[];
}>;

export type InterviewRuntimeControllerArbitrationResult = Readonly<{
  selected: string | null;
  deferred: readonly string[];
}>;

type InterviewRuntimeControllerObservationWork = Readonly<{
  entry: InterviewRuntimeControllerEntry;
  work: InterviewRuntimeControllerWork;
}>;

export type ControllerArbitrationContractRow = Readonly<{
  id: `arbitration.${string}`;
  owningIssue: `#${number}`;
  input: InterviewRuntimeControllerArbitrationInput;
  expected: InterviewRuntimeControllerArbitrationResult;
  rule: string;
  coverage: FinalizationContractCoverage;
}>;

const arbitrationCoverage = {
  kind: "automated_test",
  file: "worker/runtime/interviewFinalizationArbitration.test.ts",
  title: "enforces $id",
} as const satisfies FinalizationContractCoverage;

export function arbitrateInterviewRuntimeControllerWork(
  input: InterviewRuntimeControllerArbitrationInput,
): InterviewRuntimeControllerArbitrationResult {
  const candidates = [...input.eligibleWork];
  candidates.sort(compareControllerWork);
  const selected = candidates[0]?.id ?? null;
  const deferred = candidates.slice(selected === null ? 0 : 1).map((work) => work.id);
  return { selected, deferred };
}

type NonDeadlineFinalizationObservation = Exclude<
  FinalizationInput,
  Readonly<{ kind: "deadline_reached" }>
>;

export function arbitrationWorkForObservation(
  observation: NonDeadlineFinalizationObservation,
  context: Readonly<{ hangupEffectId?: string }> = {},
): InterviewRuntimeControllerObservationWork {
  switch (observation.kind) {
    case "end_requested":
      return {
        entry: "inbound_request",
        work: { id: "incoming:end_requested", kind: "inbound_request" },
      };
    case "runtime_failure_observed":
      return {
        entry: "runtime_failure",
        work: { id: "incoming:runtime_failure", kind: "runtime_failure" },
      };
    case "session_closed_observed":
      return {
        entry: "provider_observation",
        work: {
          id: "incoming:session_closed_observed",
          kind: "terminal_close_evidence",
          order: observation.sequence,
          evidence: "session_closed_observed",
        },
      };
    case "effect_outcome":
      return observation.outcome.code === "session_closed"
        ? {
            entry: "effect_outcome",
            work: {
              id: "incoming:hangup_already_closed",
              kind: "terminal_close_evidence",
              evidence: "hangup_already_closed",
            },
          }
        : observation.effectId === context.hangupEffectId &&
            observation.outcome.status === "dispatched"
          ? {
              entry: "effect_outcome",
              work: {
                id: "incoming:hangup_acknowledged",
                kind: "nonterminal_close_evidence",
                evidence: "hangup_acknowledged",
              },
            }
          : {
              entry: "effect_outcome",
              work: { id: "incoming:effect_outcome", kind: "effect_outcome" },
            };
    case "conversation_evidence_observed":
    case "evidence_prefix_processed":
    case "transcript_digest_computed":
    case "execution_warning_attached":
      return {
        entry: "effect_outcome",
        work: { id: "incoming:transcript_digest", kind: "effect_outcome" },
      };
    case "interrupted_effects_recovered":
      return {
        entry: "reconstruction",
        work: { id: "incoming:effect_recovery", kind: "provider_effect" },
      };
    case "transcript_item_observed":
    case "participant_answer_created":
    case "participant_answer_transcribed":
    case "participant_answer_transcription_failed":
    case "agent_transcript_finalized":
    case "reply_started":
    case "reply_generated":
    case "reply_cancelled":
    case "reply_delivery_started":
    case "reply_delivery_stopped":
    case "session_activity_observed":
    case "session_error_observed":
    case "nothing_to_settle":
    case "nothing_to_cancel":
      return {
        entry: "provider_observation",
        work: {
          id: `incoming:${observation.kind}`,
          kind: "provider_observation",
          order: observation.sequence,
        },
      };
    default: {
      const unhandled: never = observation;
      return unhandled;
    }
  }
}

export function finalizationObservationAt(
  observation: FinalizationObservation,
  fallbackAt: number,
): number {
  if ("observedAt" in observation && typeof observation.observedAt === "number") {
    return observation.observedAt;
  }
  return "at" in observation && typeof observation.at === "number" ? observation.at : fallbackAt;
}

function compareControllerWork(
  left: InterviewRuntimeControllerWork,
  right: InterviewRuntimeControllerWork,
): number {
  if (isLiveDeadlineWork(left) && isLiveDeadlineWork(right)) {
    const timestampOrder =
      (left.deadlineAt ?? Number.POSITIVE_INFINITY) -
      (right.deadlineAt ?? Number.POSITIVE_INFINITY);
    if (timestampOrder !== 0) return timestampOrder;
    if (left.kind !== right.kind) {
      // Missing readiness has its defined failure even when initial presence grace
      // expires simultaneously; an equal timebox keeps its existing precedence.
      const rank = (kind: InterviewRuntimeControllerWork["kind"]) =>
        kind === "timebox_deadline" ? 0 : kind === "browser_media_ready_deadline" ? 1 : 2;
      return rank(left.kind) - rank(right.kind);
    }
  }
  if (
    isSerializedProviderQueueWork(left) &&
    isSerializedProviderQueueWork(right) &&
    left.order !== undefined &&
    right.order !== undefined
  ) {
    return left.order - right.order;
  }
  return (
    controllerWorkPriority(left) - controllerWorkPriority(right) ||
    (left.order ?? Number.POSITIVE_INFINITY) - (right.order ?? Number.POSITIVE_INFINITY)
  );
}

function isLiveDeadlineWork(work: InterviewRuntimeControllerWork): boolean {
  return (
    work.kind === "timebox_deadline" ||
    work.kind === "presence_grace_deadline" ||
    work.kind === "browser_media_ready_deadline"
  );
}

function isSerializedProviderQueueWork(work: InterviewRuntimeControllerWork): boolean {
  return (
    work.kind === "provider_observation" ||
    (work.kind === "terminal_close_evidence" && work.evidence === "session_closed_observed")
  );
}

function controllerWorkPriority(work: InterviewRuntimeControllerWork): number {
  switch (work.kind) {
    case "timebox_deadline":
    case "presence_grace_deadline":
    case "browser_media_ready_deadline":
    case "drain_deadline":
    case "provider_close_deadline":
      return 0;
    case "terminal_close_evidence":
      return 10;
    case "effect_outcome":
      return 20;
    case "provider_observation":
    case "nonterminal_close_evidence":
      return 30;
    case "inbound_request":
    case "presence_renewal":
    case "runtime_failure":
      return 40;
    case "execution_wake":
      return 50;
    case "provider_effect":
      return 60;
    case "publication":
      return 70;
  }
}

export const controllerArbitrationContractLedger = [
  {
    id: "arbitration.alarm.earlier_timebox_before_presence",
    owningIssue: "#252",
    input: {
      entry: "alarm",
      eligibleWork: [
        { id: "timebox", kind: "timebox_deadline", due: true, deadlineAt: 100 },
        { id: "presence", kind: "presence_grace_deadline", due: true, deadlineAt: 200 },
      ],
    },
    expected: { selected: "timebox", deferred: ["presence"] },
    rule: "The earlier persisted live deadline wins when both deadlines are overdue.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.alarm.earlier_presence_before_timebox",
    owningIssue: "#252",
    input: {
      entry: "alarm",
      eligibleWork: [
        { id: "timebox", kind: "timebox_deadline", due: true, deadlineAt: 200 },
        { id: "presence", kind: "presence_grace_deadline", due: true, deadlineAt: 100 },
      ],
    },
    expected: { selected: "presence", deferred: ["timebox"] },
    rule: "Presence wins when its persisted expiry predates the timebox.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.alarm.equal_live_deadlines_timebox_first",
    owningIssue: "#252",
    input: {
      entry: "alarm",
      eligibleWork: [
        { id: "presence", kind: "presence_grace_deadline", due: true, deadlineAt: 100 },
        { id: "timebox", kind: "timebox_deadline", due: true, deadlineAt: 100 },
      ],
    },
    expected: { selected: "timebox", deferred: ["presence"] },
    rule: "Equal live deadlines use the normative timebox tie-break.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.presence_observation.overdue_presence_before_renewal",
    owningIssue: "#252",
    input: {
      entry: "presence_observation",
      eligibleWork: [
        { id: "presence", kind: "presence_grace_deadline", due: true, deadlineAt: 100 },
        { id: "renewal", kind: "presence_renewal" },
      ],
    },
    expected: { selected: "presence", deferred: ["renewal"] },
    rule: "An overdue grace expiry is persisted before same-turn renewal.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.presence_observation.overdue_timebox_before_renewal",
    owningIssue: "#252",
    input: {
      entry: "presence_observation",
      eligibleWork: [
        { id: "timebox", kind: "timebox_deadline", due: true, deadlineAt: 100 },
        { id: "renewal", kind: "presence_renewal" },
      ],
    },
    expected: { selected: "timebox", deferred: ["renewal"] },
    rule: "An overdue timebox is persisted before same-turn presence renewal.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.inbound_request.overdue_timebox_before_finish",
    owningIssue: "#252",
    input: {
      entry: "inbound_request",
      eligibleWork: [
        { id: "timebox", kind: "timebox_deadline", due: true, deadlineAt: 100 },
        { id: "finish", kind: "inbound_request" },
      ],
    },
    expected: { selected: "timebox", deferred: ["finish"] },
    rule: "A persisted timebox expiry wins over a later manual finish.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.inbound_request.overdue_presence_before_finish",
    owningIssue: "#252",
    input: {
      entry: "inbound_request",
      eligibleWork: [
        { id: "presence", kind: "presence_grace_deadline", due: true, deadlineAt: 100 },
        { id: "finish", kind: "inbound_request" },
      ],
    },
    expected: { selected: "presence", deferred: ["finish"] },
    rule: "A persisted presence expiry wins over a later manual finish.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.runtime_failure.overdue_presence_before_failure",
    owningIssue: "#252",
    input: {
      entry: "runtime_failure",
      eligibleWork: [
        { id: "presence", kind: "presence_grace_deadline", due: true, deadlineAt: 100 },
        { id: "failure", kind: "runtime_failure" },
      ],
    },
    expected: { selected: "presence", deferred: ["failure"] },
    rule: "An overdue live deadline is durable before a same-turn Runtime failure.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.runtime_failure.overdue_timebox_before_failure",
    owningIssue: "#252",
    input: {
      entry: "runtime_failure",
      eligibleWork: [
        { id: "timebox", kind: "timebox_deadline", due: true, deadlineAt: 100 },
        { id: "failure", kind: "runtime_failure" },
      ],
    },
    expected: { selected: "timebox", deferred: ["failure"] },
    rule: "An overdue timebox is durable before a same-turn Runtime failure.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.alarm.overdue_timebox_before_reconnect",
    owningIssue: "#252",
    input: {
      entry: "alarm",
      eligibleWork: [
        { id: "timebox", kind: "timebox_deadline", due: true, deadlineAt: 100 },
        { id: "reconnect", kind: "execution_wake" },
      ],
    },
    expected: { selected: "timebox", deferred: ["reconnect"] },
    rule: "Live expiry runs before reconnect work from the expired stage.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.alarm.overdue_presence_before_reconnect",
    owningIssue: "#252",
    input: {
      entry: "alarm",
      eligibleWork: [
        { id: "presence", kind: "presence_grace_deadline", due: true, deadlineAt: 100 },
        { id: "reconnect", kind: "execution_wake" },
      ],
    },
    expected: { selected: "presence", deferred: ["reconnect"] },
    rule: "Presence expiry runs before reconnect work from the expired live stage.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.effect_dispatch.overdue_presence_before_old_effect",
    owningIssue: "#252",
    input: {
      entry: "effect_dispatch",
      eligibleWork: [
        { id: "presence", kind: "presence_grace_deadline", due: true, deadlineAt: 100 },
        { id: "old-effect", kind: "provider_effect" },
      ],
    },
    expected: { selected: "presence", deferred: ["old-effect"] },
    rule: "Effect dispatch applies overdue presence before restored live-stage effects.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.effect_dispatch.overdue_timebox_before_old_effect",
    owningIssue: "#252",
    input: {
      entry: "effect_dispatch",
      eligibleWork: [
        { id: "timebox", kind: "timebox_deadline", due: true, deadlineAt: 100 },
        { id: "old-effect", kind: "provider_effect" },
      ],
    },
    expected: { selected: "timebox", deferred: ["old-effect"] },
    rule: "Effect dispatch applies an overdue timebox before restored live-stage effects.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.publication.only_after_ended",
    owningIssue: "#254",
    input: {
      entry: "effect_dispatch",
      eligibleWork: [
        { id: "publication", kind: "publication", due: true },
        { id: "digest", kind: "provider_effect" },
      ],
    },
    expected: { selected: "digest", deferred: ["publication"] },
    rule: "Publication work remains invalid until durable finalization reaches ended.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.publication.valid_after_ended",
    owningIssue: "#254",
    input: {
      entry: "alarm",
      eligibleWork: [{ id: "publication", kind: "publication", due: true }],
    },
    expected: { selected: "publication", deferred: [] },
    rule: "Only publication work remains eligible after durable finalization has ended.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.alarm.drain_before_reconnect",
    owningIssue: "#254",
    input: {
      entry: "alarm",
      eligibleWork: [
        { id: "drain", kind: "drain_deadline", due: true },
        { id: "reconnect", kind: "execution_wake" },
      ],
    },
    expected: { selected: "drain", deferred: ["reconnect"] },
    rule: "An overdue drain deadline wins over reconnect work from the expiring stage.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.reconstruction.close_before_provider_effect",
    owningIssue: "#254",
    input: {
      entry: "reconstruction",
      eligibleWork: [
        { id: "close", kind: "provider_close_deadline", due: true },
        { id: "provider-effect", kind: "provider_effect" },
      ],
    },
    expected: { selected: "close", deferred: ["provider-effect"] },
    rule: "Reconstruction applies due provider-close work before restored effects.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.inbound_request.deadline_before_request",
    owningIssue: "#290",
    input: {
      entry: "inbound_request",
      eligibleWork: [
        { id: "drain", kind: "drain_deadline", due: true },
        { id: "request", kind: "inbound_request" },
      ],
    },
    expected: { selected: "drain", deferred: ["request"] },
    rule: "An inbound request cannot renew or prolong an expired obligation.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.provider_observation.deadline_before_new_fact",
    owningIssue: "#290",
    input: {
      entry: "provider_observation",
      eligibleWork: [
        { id: "drain", kind: "drain_deadline", due: true },
        { id: "provider-event", kind: "provider_observation", order: 42 },
      ],
    },
    expected: { selected: "drain", deferred: ["provider-event"] },
    rule: "Persisted deadline classification precedes a newer provider fact.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.effect_outcome.deadline_before_outcome",
    owningIssue: "#290",
    input: {
      entry: "effect_outcome",
      eligibleWork: [
        { id: "close", kind: "provider_close_deadline", due: true },
        {
          id: "hangup-ack",
          kind: "nonterminal_close_evidence",
          evidence: "hangup_acknowledged",
        },
      ],
    },
    expected: {
      selected: "close",
      deferred: ["hangup-ack"],
    },
    rule: "A late effect outcome is classified after the persisted close bound.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.stage_transition.keeps_closing_reconnect",
    owningIssue: "#254",
    input: {
      entry: "effect_dispatch",
      eligibleWork: [{ id: "reconnect", kind: "execution_wake" }],
    },
    expected: {
      selected: "reconnect",
      deferred: [],
    },
    rule: "Closing may reconnect while work owned only by the prior drain stage is discarded.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.provider_queue.preserves_accepted_order",
    owningIssue: "#254",
    input: {
      entry: "provider_observation",
      eligibleWork: [
        { id: "provider-43", kind: "provider_observation", order: 43 },
        { id: "provider-42", kind: "provider_observation", order: 42 },
      ],
    },
    expected: { selected: "provider-42", deferred: ["provider-43"] },
    rule: "Provider observations preserve their accepted serialized sequence.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.effect_dispatch.graceful_containment_during_drain",
    owningIssue: "#253",
    input: {
      entry: "effect_dispatch",
      eligibleWork: [
        {
          id: "cancel-later-response",
          kind: "provider_effect",
        },
      ],
    },
    expected: { selected: "cancel-later-response", deferred: [] },
    rule: "Later-response and participant-override containment dispatch during graceful drain.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.provider_queue.prefix_before_terminal_close",
    owningIssue: "#290",
    input: {
      entry: "provider_observation",
      eligibleWork: [
        { id: "provider-42", kind: "provider_observation", order: 42 },
        {
          id: "provider-close-43",
          kind: "terminal_close_evidence",
          evidence: "session_closed_observed",
          order: 43,
        },
      ],
    },
    expected: { selected: "provider-42", deferred: ["provider-close-43"] },
    rule: "The accepted provider prefix is processed before its later terminal close barrier.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.close_evidence.terminal_before_reconnect",
    owningIssue: "#254",
    input: {
      entry: "execution_wake",
      eligibleWork: [
        {
          id: "already-closed",
          kind: "terminal_close_evidence",
          evidence: "hangup_already_closed",
          order: 2,
        },
        {
          id: "provider-session-close",
          kind: "terminal_close_evidence",
          evidence: "session_closed_observed",
          order: 4,
        },
        { id: "reconnect", kind: "execution_wake" },
      ],
    },
    expected: {
      selected: "already-closed",
      deferred: ["provider-session-close", "reconnect"],
    },
    rule: "Only typed terminal evidence outranks reconnect.",
    coverage: arbitrationCoverage,
  },
  {
    id: "arbitration.reconstruction.reconnect_before_restored_provider_effect",
    owningIssue: "#254",
    input: {
      entry: "reconstruction",
      eligibleWork: [
        {
          id: "restored-provider-effect",
          kind: "provider_effect",
        },
        { id: "reconnect", kind: "execution_wake" },
      ],
    },
    expected: {
      selected: "reconnect",
      deferred: ["restored-provider-effect"],
    },
    rule: "Restored provider effects wait until the execution's wake-up has run.",
    coverage: arbitrationCoverage,
  },
] as const satisfies readonly ControllerArbitrationContractRow[];
