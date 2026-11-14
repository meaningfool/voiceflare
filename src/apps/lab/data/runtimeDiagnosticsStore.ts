import { runtimeDiagnosticRecordSchema } from "../../../../worker/shared/contracts/runtimeDiagnostics.ts";
import { createLabWorkerClient, type LabWorkerFetch } from "./labWorkerClient";
import type { CompletionReviewStatus, FinalTurnFlushStatus } from "../realtimeClient/liveInterview";
import type { RealtimeSessionSummary } from "../../../shared/browser/transcript";
import { z } from "zod";
import { boundary } from "../../../../tools/boundary-contracts/boundary-contracts.mjs";

const runtimeEventRecordSchema = z.strictObject({
  runId: z.string(),
  observedAt: z.number(),
  sequence: z.number(),
  elapsedMs: z.number(),
  type: z.string(),
  payloadJson: z.string(),
  runtimeRecord: runtimeDiagnosticRecordSchema.optional(),
});
const runtimeSetupFailureKindSchema = z.union([
  z.literal("browser_media"),
  z.literal("browser_peer"),
  z.literal("provider_signaling"),
  z.literal("runtime_worker_unavailable"),
  z.literal("session_setup"),
  z.literal("browser_runtime_event_stream"),
]);
const runtimeDiagnosticSourceSchema = z.union([
  z.literal("browser"),
  z.literal("lab_worker"),
  z.literal("runtime_controller"),
  z.literal("provider"),
]);
const runtimeSetupFailureSchema = z.strictObject({
  failureKind: runtimeSetupFailureKindSchema,
  source: runtimeDiagnosticSourceSchema,
  errorText: z.string(),
  code: z.string().optional(),
});
const realtimeSessionSummarySchema = z.strictObject({
  model: z.string().optional(),
  voice: z.string().optional(),
  maxOutputTokens: z.union([z.number().int().min(1).max(4096), z.literal("inf")]).optional(),
  reasoningEffort: z.string().optional(),
  inputNoiseReduction: z.strictObject({ type: z.string().optional() }).optional(),
  turnDetection: z
    .strictObject({
      type: z.string().optional(),
      createResponse: z.boolean().optional(),
      interruptResponse: z.boolean().optional(),
      eagerness: z.string().optional(),
      threshold: z.number().optional(),
    })
    .optional(),
});
const interviewPromptProvenanceSchema = z.strictObject({
  promptId: z.string(),
  promptFileName: z.string().optional(),
  contentHash: z.string(),
});
const finalTurnFlushStatusSchema = z.union([
  z.literal("sidebandClosed"),
  z.literal("timedOut"),
  z.literal("sidebandUnavailable"),
]);
const completionReviewStatusSchema = z.union([z.literal("clean"), z.literal("warning")]);
const runtimeRunDiagnosticsSchema = z.strictObject({
  runId: z.string(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  surface: z.union([z.literal("lab"), z.literal("product")]).optional(),
  environment: z.string().optional(),
  appResourceKind: z.string().optional(),
  appResourceId: z.string().optional(),
  diagnosticSchemaVersion: z.number().optional(),
  runtimeControllerVersion: z.string().optional(),
  expiresAt: z.number().optional(),
  sessionId: z.string().optional(),
  setupFailure: runtimeSetupFailureSchema.optional(),
  settingsSummary: realtimeSessionSummarySchema.optional(),
  promptProvenance: interviewPromptProvenanceSchema.optional(),
  completionStatus: finalTurnFlushStatusSchema.optional(),
  completionReviewStatus: completionReviewStatusSchema.optional(),
  completionDebugText: z.string().optional(),
});
const runtimeEventListSchema = z.array(runtimeEventRecordSchema);
const diagnosticsMutationAcknowledgementSchema = z.strictObject({
  ok: z.literal(true),
});
const runtimeEventAppendAcknowledgementSchema = z.strictObject({
  stored: z.literal(true),
  reason: z.literal("lab"),
  storedCount: z.number().int().nonnegative(),
});

export type RuntimeEventRecord = z.output<typeof runtimeEventRecordSchema>;

export type RuntimeSetupFailureKind = z.output<typeof runtimeSetupFailureKindSchema>;

export type RuntimeDiagnosticSource = z.output<typeof runtimeDiagnosticSourceSchema>;

export type RuntimeSetupFailure = z.output<typeof runtimeSetupFailureSchema>;

export type RuntimeLiveDegradationKind =
  | "browser_runtime_event_stream"
  | "sideband_websocket"
  | "provider_error"
  | "session_failed";

export type RuntimeRunDiagnostics = z.output<typeof runtimeRunDiagnosticsSchema>;

type CompletionDiagnosticsPayload = {
  completionStatus: FinalTurnFlushStatus;
  completionReviewStatus?: CompletionReviewStatus | undefined;
  completionDebugText: string;
};

type LiveDegradationPayload = {
  source: RuntimeDiagnosticSource;
  degradationKind: RuntimeLiveDegradationKind;
  errorText?: string;
  code?: string;
};

type EndingStartedPayload = {
  source: RuntimeDiagnosticSource;
  endReason?: string;
  trigger?: string;
};

type FinalTurnFlushFinishedPayload = {
  source: "browser";
  status: FinalTurnFlushStatus;
  inputCommitSent?: boolean;
  completionReviewStatus?: CompletionReviewStatus;
  debugText?: string;
};

type RuntimeEventPayload =
  | LiveDegradationPayload
  | EndingStartedPayload
  | FinalTurnFlushFinishedPayload;

export type RuntimeDiagnosticsStore = {
  recordProviderCall: (request: { runId: string; sessionId: string }) => Promise<void>;
  recordSetupFailure: (request: { runId: string } & RuntimeSetupFailure) => Promise<void>;
  recordSettingsSummary: (request: {
    runId: string;
    settingsSummary: RealtimeSessionSummary;
  }) => Promise<void>;
  recordCompletionDiagnostics: (request: {
    runId: string;
    completionStatus: FinalTurnFlushStatus;
    completionReviewStatus?: CompletionReviewStatus;
    completionDebugText: string;
  }) => Promise<void>;
  recordLiveDegradation: (request: {
    runId: string;
    degradationKind: RuntimeLiveDegradationKind;
    source: RuntimeDiagnosticSource;
    errorText?: string;
    code?: string;
  }) => Promise<void>;
  recordEndingStarted: (request: {
    runId: string;
    endReason?: string;
    trigger?: string;
    source: RuntimeDiagnosticSource;
  }) => Promise<void>;
  recordFinalTurnFlushFinished: (request: {
    runId: string;
    status: FinalTurnFlushStatus;
    inputCommitSent?: boolean;
    completionReviewStatus?: CompletionReviewStatus;
    debugText?: string;
  }) => Promise<void>;
  appendRuntimeEvents: (request: { runId: string; records: RuntimeEventRecord[] }) => Promise<void>;
  getRunDiagnostics: (runId: string) => Promise<RuntimeRunDiagnostics | null>;
  listRuntimeEvents: (runId: string) => Promise<RuntimeEventRecord[]>;
};

export type WorkerRuntimeDiagnosticsStoreOptions = {
  fetchImpl?: LabWorkerFetch;
};

const labApiPrefix = "/_api";

export function createWorkerRuntimeDiagnosticsStore(
  labWorkerUrl: string,
  options: WorkerRuntimeDiagnosticsStoreOptions = {},
): RuntimeDiagnosticsStore {
  const client = createLabWorkerClient(labWorkerUrl, options.fetchImpl);

  return {
    async recordProviderCall(request) {
      await client.patch(
        `${labApiPrefix}/runs/${encodeURIComponent(request.runId)}/diagnostics`,
        {
          sessionId: request.sessionId,
        },
        decodeDiagnosticsMutationAcknowledgement,
      );
    },

    async recordSetupFailure(request) {
      const setupFailure: RuntimeSetupFailure = {
        failureKind: request.failureKind,
        source: request.source,
        errorText: request.errorText,
      };
      if (request.code !== undefined) setupFailure.code = request.code;
      await client.patch(
        `${labApiPrefix}/runs/${encodeURIComponent(request.runId)}/diagnostics`,
        {
          setupFailure,
        },
        decodeDiagnosticsMutationAcknowledgement,
      );
    },

    async recordSettingsSummary(request) {
      await client.patch(
        `${labApiPrefix}/runs/${encodeURIComponent(request.runId)}/diagnostics`,
        {
          settingsSummary: request.settingsSummary,
        },
        decodeDiagnosticsMutationAcknowledgement,
      );
    },

    async recordCompletionDiagnostics(request) {
      const diagnostics: CompletionDiagnosticsPayload = {
        completionStatus: request.completionStatus,
        completionReviewStatus: request.completionReviewStatus,
        completionDebugText: request.completionDebugText,
      };
      await client.patch(
        `${labApiPrefix}/runs/${encodeURIComponent(request.runId)}/diagnostics`,
        diagnostics,
        decodeDiagnosticsMutationAcknowledgement,
      );
    },

    async recordLiveDegradation(request) {
      const payload: LiveDegradationPayload = {
        source: request.source,
        degradationKind: request.degradationKind,
      };
      if (request.errorText !== undefined) payload.errorText = request.errorText;
      if (request.code !== undefined) payload.code = request.code;
      await appendRuntimeEvent(client, request.runId, "browser.live_degraded", payload);
    },

    async recordEndingStarted(request) {
      const payload: EndingStartedPayload = {
        source: request.source,
      };
      if (request.endReason !== undefined) payload.endReason = request.endReason;
      if (request.trigger !== undefined) payload.trigger = request.trigger;
      await appendRuntimeEvent(client, request.runId, "browser.ending_started", payload);
    },

    async recordFinalTurnFlushFinished(request) {
      const payload: FinalTurnFlushFinishedPayload = {
        source: "browser",
        status: request.status,
      };
      if (request.inputCommitSent !== undefined) payload.inputCommitSent = request.inputCommitSent;
      if (request.completionReviewStatus !== undefined) {
        payload.completionReviewStatus = request.completionReviewStatus;
      }
      if (request.debugText !== undefined) payload.debugText = request.debugText;
      await appendRuntimeEvent(client, request.runId, "browser.final_turn_flush_finished", payload);
    },

    async appendRuntimeEvents(request) {
      await client.post(
        `${labApiPrefix}/runs/${encodeURIComponent(request.runId)}/runtime-events`,
        {
          records: request.records.map((record) => ({
            observedAt: record.observedAt,
            sequence: record.sequence,
            elapsedMs: record.elapsedMs,
            type: record.type,
            payloadJson: record.payloadJson,
          })),
        },
        decodeRuntimeEventAppendAcknowledgement,
      );
    },

    async getRunDiagnostics(runId) {
      return await client.getOptional(
        `${labApiPrefix}/runs/${encodeURIComponent(runId)}/diagnostics`,
        decodeRuntimeRunDiagnostics,
      );
    },

    async listRuntimeEvents(runId) {
      return await client.get(
        `${labApiPrefix}/runs/${encodeURIComponent(runId)}/runtime-events`,
        decodeRuntimeEventList,
      );
    },
  };
}

async function appendRuntimeEvent(
  client: ReturnType<typeof createLabWorkerClient>,
  runId: string,
  type: string,
  payload: RuntimeEventPayload,
): Promise<void> {
  const observedAt = Date.now();
  await client.post(
    `${labApiPrefix}/runs/${encodeURIComponent(runId)}/runtime-events`,
    {
      records: [
        {
          runId,
          observedAt,
          sequence: observedAt,
          elapsedMs: 0,
          type,
          payloadJson: JSON.stringify(payload),
        },
      ],
    },
    decodeRuntimeEventAppendAcknowledgement,
  );
}

const decodeRuntimeRunDiagnostics = boundary({
  schema: runtimeRunDiagnosticsSchema,
  convert: (value): RuntimeRunDiagnostics => value,
});

const decodeRuntimeEventList = boundary({
  schema: runtimeEventListSchema,
  convert: (value): RuntimeEventRecord[] => value,
});

const decodeDiagnosticsMutationAcknowledgement = boundary({
  schema: diagnosticsMutationAcknowledgementSchema,
  convert: (value) => value.ok,
});

const decodeRuntimeEventAppendAcknowledgement = boundary({
  schema: runtimeEventAppendAcknowledgementSchema,
  convert: (value) => value.stored,
});
