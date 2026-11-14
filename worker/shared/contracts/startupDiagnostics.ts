import { z } from "zod";

import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";

/**
 * The startup stages every execution shares, Runtime's and the browser's. `sessionConnected` is
 * the execution's session connecting once its provider work exists: Realtime's side connection,
 * or where Cascade's setup fails. An execution's own steps are its own diagnostics.
 */
export const startupStages = [
  "browserStarted",
  "microphoneReady",
  "connectionInputReady",
  "requestSent",
  "responseCreationStarted",
  "responseCreated",
  "runtimeDispatched",
  "runtimeAccepted",
  "modelPrepared",
  "providerRequested",
  "providerCreated",
  "sessionConnected",
  "liveAt",
  "connectionReplyReceived",
  "connectionReplyApplied",
  "browserReady",
  "firstPresence",
] as const;
export const startupStageSchema = z.enum(startupStages);
export type StartupStage = z.infer<typeof startupStageSchema>;
const timestamp = z.number().int().nonnegative().safe();
export const startupObservationSchema = z.object({
  stage: startupStageSchema,
  at: timestamp,
  failure: z.boolean().optional(),
  cleanup: z.enum(["unknown", "not_needed", "not_attempted", "acknowledged", "failed"]).optional(),
});
export type StartupObservation = z.infer<typeof startupObservationSchema>;
export const decodeStartupObservation = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value))),
    startupObservationSchema,
  ),
  convert: (value): StartupObservation => value,
});
export const decodeStartupCallback = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value))),
    z.object({ runId: z.string().min(1), observation: startupObservationSchema }),
  ),
  convert: (value) => value,
});
const browserStageSchema = z.enum([
  "browserStarted",
  "microphoneReady",
  "connectionInputReady",
  "requestSent",
  "connectionReplyReceived",
  "connectionReplyApplied",
  "browserReady",
]);
export const decodeBrowserStartup = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value))),
    z
      .array(
        z.object({ stage: browserStageSchema, at: timestamp, failure: z.literal(true).optional() }),
      )
      .max(7),
  ),
  convert: (value) => value,
});
const timelineSchema = z.partialRecord(startupStageSchema, timestamp);
export const decodeStoredStartup = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value))),
    z.object({
      acceptanceResolutionAttemptCount: z.number().int().min(0).max(10).optional(),
      stages: timelineSchema,
      failures: z.partialRecord(startupStageSchema, startupObservationSchema),
    }),
  ),
  convert: (value) => value,
});
function failureStartStage(stage: StartupStage): StartupStage | undefined {
  switch (stage) {
    case "runtimeDispatched":
      return "responseCreated";
    case "runtimeAccepted":
      return "runtimeDispatched";
    case "modelPrepared":
      return "runtimeAccepted";
    case "providerCreated":
      return "providerRequested";
    case "sessionConnected":
      return "providerCreated";
    case "liveAt":
      return "sessionConnected";
    case "connectionReplyApplied":
      return "connectionReplyReceived";
    case "browserReady":
      return "connectionReplyApplied";
    default:
      return undefined;
  }
}

export function summarizeStartup(value: ReturnType<typeof decodeStoredStartup>) {
  const stages = value.stages;
  const failureStage = startupStages.findLast((stage) => value.failures[stage] !== undefined);
  const failure = failureStage === undefined ? undefined : value.failures[failureStage];
  const duration = (start: StartupStage, end: StartupStage): number | null => {
    const from = stages[start];
    const to = stages[end];
    return from === undefined || to === undefined || to < from ? null : to - from;
  };
  const failureStart = failure === undefined ? undefined : failureStartStage(failure.stage);
  const failureStartedAt = failureStart === undefined ? undefined : stages[failureStart];
  const failedStageDuration =
    failure === undefined || failureStartedAt === undefined || failure.at < failureStartedAt
      ? null
      : failure.at - failureStartedAt;
  return {
    outcome:
      stages.liveAt !== undefined
        ? "live"
        : failure === undefined || failure.stage === "runtimeAccepted"
          ? "unknown"
          : "failed",
    lastStage: startupStages.findLast((stage) => stages[stage] !== undefined) ?? null,
    stages,
    durationsMs: {
      browserPreparation: duration("browserStarted", "requestSent"),
      applicationResponseCreation: duration("responseCreationStarted", "responseCreated"),
      applicationPreparation: duration("responseCreated", "runtimeDispatched"),
      dispatchToAcceptance: duration("runtimeDispatched", "runtimeAccepted"),
      runtimeSetup: duration("runtimeAccepted", "liveAt"),
      modelPreparation: duration("runtimeAccepted", "modelPrepared"),
      failedStage: failedStageDuration,
      providerSetup: duration("providerRequested", "providerCreated"),
      sessionSetup: duration("providerCreated", "sessionConnected"),
      backendStartup: duration("responseCreated", "liveAt"),
      browserReplyWait: duration("requestSent", "connectionReplyReceived"),
      browserReplyApplication: duration("connectionReplyReceived", "connectionReplyApplied"),
      participantPerceivedStartup: duration("browserStarted", "browserReady"),
    },
    failureStage: failure?.stage ?? null,
    failureAt: failure?.at ?? null,
    cleanupStatus: failure?.cleanup ?? "unknown",
    acceptanceResolutionAttemptCount: value.acceptanceResolutionAttemptCount ?? 0,
  };
}
