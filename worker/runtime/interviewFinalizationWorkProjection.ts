import {
  type InterviewFinalizationExecutableEffect,
  type InterviewFinalizationExecutionFacts,
  type InterviewFinalizationProviderConnectionDemand,
} from "./conversationEnd.ts";
import { projectEffects, projectProviderConnection } from "./conversationEnd.ts";
import {
  conversationNodeDeadline,
  drainCheckpointAt,
  type FinalizationDeadline,
  type InterviewFinalizationAggregate,
  type RuntimePublicationState,
} from "./interviewFinalizationModel.ts";
import { type InterviewRuntimeControllerWork } from "./interviewFinalizationArbitration.ts";

export type InterviewFinalizationExecutionDeadline = Readonly<{
  deadline: FinalizationDeadline;
  deadlineAt: number;
  observationAt: number;
  due: boolean;
}>;

export type InterviewFinalizationPublicationDemand = Readonly<{
  requested: boolean;
  ready: boolean;
  readyAt: number | null;
  work: InterviewRuntimeControllerWork | null;
}>;

export type InterviewFinalizationExecution = Readonly<{
  nodeExecution: Readonly<{ active: boolean; dispatchPending: boolean; expired: boolean }>;
  reconstructionRequiresDisconnect: boolean;
  evidenceReconsiderationRequested: boolean;
  providerClosureObserved: boolean;
  finalizationCutoffAt: number | null;
  deadlines: readonly InterviewFinalizationExecutionDeadline[];
  nextDomainWakeAt: number | null;
  effects: readonly InterviewFinalizationExecutableEffect[];
  providerConnection: InterviewFinalizationProviderConnectionDemand;
  publication: InterviewFinalizationPublicationDemand;
  arbitrationCandidates: readonly InterviewRuntimeControllerWork[];
}>;

export function projectInterviewFinalizationExecution(
  aggregate: InterviewFinalizationAggregate,
  facts: InterviewFinalizationExecutionFacts,
): InterviewFinalizationExecution {
  const node = aggregate.conversationNodeExecution;
  const nodeDeadlineAt = node === undefined ? null : conversationNodeDeadline(node);
  const executionFacts = node === undefined ? facts : { ...facts, liveDeadlineAt: nodeDeadlineAt };
  const deadlines = projectDeadlines(aggregate, executionFacts);
  const effects = projectEffects(aggregate);
  const providerConnection = projectProviderConnection(aggregate, executionFacts, effects);
  const publication = projectPublication(aggregate, facts.now);
  const deadlineCandidates = deadlines.filter(({ due }) => due).map(deadlineWork);
  const effectCandidates = effects.map(({ work }) => work);
  const publicationCandidates = publication.work === null ? [] : [publication.work];
  const wakeUps = deadlines.map(({ deadlineAt }) => deadlineAt);

  const active = aggregate.state.stage === "live" && node?.dispatch !== undefined;
  return {
    nodeExecution: {
      active,
      dispatchPending: active && node?.dispatch?.status === "pending",
      expired: active && nodeDeadlineAt !== null && facts.now >= nodeDeadlineAt,
    },
    evidenceReconsiderationRequested:
      aggregate.state.stage !== "live" && aggregate.state.stage !== "ended",
    reconstructionRequiresDisconnect:
      aggregate.state.stage === "live"
        ? (node !== undefined && node.kind !== "ordinary") ||
          facts.openingPending !== true ||
          aggregate.providerResponses.length > 0 ||
          aggregate.transcriptCapture.items.length > 0
        : false,
    providerClosureObserved: "sessionClosed" in aggregate.state && aggregate.state.sessionClosed,
    finalizationCutoffAt: readFinalizationCutoffAt(aggregate),
    deadlines,
    nextDomainWakeAt: wakeUps.length === 0 ? null : Math.min(...wakeUps),
    effects,
    providerConnection,
    publication,
    arbitrationCandidates: [...deadlineCandidates, ...effectCandidates, ...publicationCandidates],
  };
}

function readFinalizationCutoffAt(aggregate: InterviewFinalizationAggregate): number | null {
  const state = aggregate.state;
  switch (state.stage) {
    case "live":
      return null;
    case "draining":
    case "closing_provider":
    case "finalizing":
      return state.finalizationCutoffAt;
    case "ended":
      return state.completion.finalizationCutoffAt;
    default:
      return assertUnreachable(state);
  }
}

function projectDeadlines(
  aggregate: InterviewFinalizationAggregate,
  facts: InterviewFinalizationExecutionFacts,
): readonly InterviewFinalizationExecutionDeadline[] {
  const state = aggregate.state;
  const timing = aggregate.conversationNodeExecution;
  switch (state.stage) {
    case "live":
      return [
        // A finish that completed waits for its reply to play; its cleanup would cut that reply.
        ...(timing?.kind === "retained_output" &&
        timing.cleanup.status === "scheduled" &&
        timing.endingAt === undefined
          ? [deadline("provider_close", timing.cleanup.at, timing.cleanup.at, facts.now)]
          : []),
        ...(facts.browserMediaReadyDeadlineAt == null
          ? []
          : [
              deadline(
                "browser_media_ready",
                facts.browserMediaReadyDeadlineAt,
                facts.now,
                facts.now,
              ),
            ]),
        ...(facts.liveDeadlineAt === null
          ? []
          : [deadline("timebox", facts.liveDeadlineAt, facts.now, facts.now)]),
        ...(facts.participantPresenceDeadlineAt === null
          ? []
          : [
              deadline("presence_grace", facts.participantPresenceDeadlineAt, facts.now, facts.now),
            ]),
      ];
    case "draining": {
      const drainAt = drainCheckpointAt(state);
      const checkpointAt = Math.min(drainAt, aggregate.finalInput?.quietDeadline ?? drainAt);
      return [
        deadline("drain", checkpointAt, facts.now, facts.now),
        deadline("finalization_cutoff", state.finalizationCutoffAt, facts.now, facts.now),
      ];
    }
    case "closing_provider":
      return [deadline("finalization_cutoff", state.finalizationCutoffAt, facts.now, facts.now)];
    case "finalizing":
    case "ended":
      return [];
    default:
      return assertUnreachable(state);
  }
}

function deadline(
  deadlineKind: InterviewFinalizationExecutionDeadline["deadline"],
  deadlineAt: number,
  observationAt: number,
  now: number,
): InterviewFinalizationExecutionDeadline {
  return {
    deadline: deadlineKind,
    deadlineAt,
    observationAt,
    due: deadlineAt <= now,
  };
}

function projectPublication(
  aggregate: InterviewFinalizationAggregate,
  now: number,
): InterviewFinalizationPublicationDemand {
  if (aggregate.state.stage !== "ended") {
    return { requested: false, ready: false, readyAt: null, work: null };
  }
  const publication = aggregate.state.publication;
  const readyAt = publicationReadyAt(
    publication,
    aggregate.state.completion.finalizedAt,
    publication.publicationCutoffAt,
  );
  const requested = readyAt !== null;
  const ready = readyAt !== null && readyAt <= now;
  return {
    requested,
    ready,
    readyAt,
    work: ready ? { id: "publication", kind: "publication", due: true, deadlineAt: readyAt } : null,
  };
}

function publicationReadyAt(
  publication: RuntimePublicationState,
  finalizedAt: number,
  cutoffAt: number,
): number | null {
  switch (publication.status) {
    case "pending":
      return finalizedAt;
    case "retrying":
      return Math.min(publication.retryAt ?? cutoffAt, cutoffAt);
    case "delivered":
    case "expired":
    case "blocked_snapshot_conflict":
    case "blocked_nonretryable_callback":
      return null;
    default:
      return assertUnreachable(publication);
  }
}

function deadlineWork(
  value: InterviewFinalizationExecutionDeadline,
): InterviewRuntimeControllerWork {
  const kindByDeadline = {
    timebox: "timebox_deadline",
    presence_grace: "presence_grace_deadline",
    browser_media_ready: "browser_media_ready_deadline",
    finalization_cutoff: "drain_deadline",
    drain: "drain_deadline",
    provider_close: "provider_close_deadline",
  } as const satisfies Record<
    InterviewFinalizationExecutionDeadline["deadline"],
    InterviewRuntimeControllerWork["kind"]
  >;
  return {
    id: `deadline:${value.deadline}`,
    kind: kindByDeadline[value.deadline],
    due: true,
    deadlineAt: value.deadlineAt,
  };
}

function assertUnreachable(value: never): never {
  throw new Error(`Unsupported Interview finalization execution value: ${JSON.stringify(value)}`);
}

export type { InterviewFinalizationExecutableEffect } from "./conversationEnd.ts";
export type { InterviewFinalizationExecutionFacts } from "./conversationEnd.ts";
export type { InterviewFinalizationProviderConnectionDemand } from "./conversationEnd.ts";
export type { FinalizationEffectExecutionRequirement } from "./conversationEnd.ts";
