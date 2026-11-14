import type { InterviewPromptProvenance } from "./interviewPrompt";
import { createLabWorkerClient, type LabWorkerFetch } from "./labWorkerClient";
import type { Transcript } from "../../../shared/browser/transcript";
import { z } from "zod";
import {
  runtimeTerminalResultSchema,
  type RuntimeTerminalResult,
} from "../../../browser/runtimeTerminalResult";
import { boundary } from "../../../../tools/boundary-contracts/boundary-contracts.mjs";

const transcriptSchema = z.strictObject({
  turns: z.array(
    z.strictObject({
      role: z.union([z.literal("participant"), z.literal("conversationAgent")]),
      text: z.string(),
    }),
  ),
});

const createdLabRunSchema = z.strictObject({
  runId: z.string(),
  startedAt: z.number(),
});

const labRunEndOutcomeSchema = z.union([z.literal("ended"), z.literal("failed")]);
const labRunEndReasonSchema = z.union([
  z.literal("participant_stopped"),
  z.literal("timebox_reached"),
  z.literal("agent_requested_end"),
  z.literal("participant_disconnected"),
  z.literal("runtime_failed"),
]);
const labRunListItemSchema = z.strictObject({
  runId: z.string(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  outcome: labRunEndOutcomeSchema.optional(),
  endReason: labRunEndReasonSchema.optional(),
  transcriptTurnCount: z.number().int().nonnegative(),
});
const labRunDetailSchema = labRunListItemSchema.extend({
  transcript: transcriptSchema,
  terminalResult: runtimeTerminalResultSchema.optional(),
  closingDiagnostic: z
    .discriminatedUnion("status", [
      z.strictObject({ status: z.literal("unknown"), warnings: z.array(z.never()).length(0) }),
      z.strictObject({ status: z.literal("checked"), warnings: z.array(z.never()).length(0) }),
      z.strictObject({
        status: z.literal("limited"),
        warnings: z
          .array(
            z.enum([
              "closing_response_failed",
              "closing_cutoff_exhausted",
              "closing_recovery_uncertain",
              "closing_interrupted",
            ]),
          )
          .min(1),
      }),
    ])
    .optional(),
  executionModel: z.string().optional(),
  maxOutputTokens: z.union([z.number().int().min(1).max(4096), z.literal("inf")]).optional(),
  responseUsage: z
    .array(
      z.strictObject({
        responseId: z.string(),
        outputTokens: z.number().int().safe().nonnegative(),
        model: z.string().optional(),
        answerTurnNumber: z.number().int().positive().optional(),
      }),
    )
    .default([]),
});
const labRunListSchema = z.array(labRunListItemSchema);
const labRunMutationAcknowledgementSchema = z.strictObject({
  ok: z.literal(true),
});

export type CreatedLabRun = z.output<typeof createdLabRunSchema>;

export type CreateLabRunRequest = {
  promptProvenance?: InterviewPromptProvenance;
};

export type LabRunEndOutcome = z.output<typeof labRunEndOutcomeSchema>;

export type LabRunEndReason = z.output<typeof labRunEndReasonSchema>;

export type LabRunListItem = {
  runId: string;
  startedAt: number;
  endedAt?: number;
  outcome?: LabRunEndOutcome;
  endReason?: LabRunEndReason;
  transcriptTurnCount: number;
};

export type LabRunDetail = LabRunListItem & {
  transcript: Transcript;
  terminalResult?: RuntimeTerminalResult;
  closingDiagnostic?: { status: "limited" | "checked" | "unknown"; warnings: readonly string[] };
  executionModel?: string;
  maxOutputTokens?: number | "inf";
  responseUsage?: readonly {
    responseId: string;
    outputTokens: number;
    model?: string;
    answerTurnNumber?: number;
  }[];
};

export type LabRunStore = {
  createLabRun: (request?: CreateLabRunRequest) => Promise<CreatedLabRun>;
  recordSetupFailureEnd: (request: { runId: string; endedAt: number }) => Promise<void>;
  listLabRuns: () => Promise<LabRunListItem[]>;
  getLabRun: (runId: string) => Promise<LabRunDetail | null>;
};

export type WorkerLabRunStoreOptions = {
  fetchImpl?: LabWorkerFetch;
};

const labApiPrefix = "/_api";

export function createWorkerLabRunStore(
  labWorkerUrl: string,
  options: WorkerLabRunStoreOptions = {},
): LabRunStore {
  const client = createLabWorkerClient(labWorkerUrl, options.fetchImpl);

  return {
    async createLabRun(request = {}) {
      return await client.post(`${labApiPrefix}/runs`, request, decodeCreatedLabRun);
    },

    async recordSetupFailureEnd(request) {
      await client.patch(
        `${labApiPrefix}/runs/${encodeURIComponent(request.runId)}/setup-failure`,
        {
          endedAt: request.endedAt,
        },
        decodeLabRunMutationAcknowledgement,
      );
    },

    async listLabRuns() {
      return await client.get(`${labApiPrefix}/runs`, decodeLabRunList);
    },

    async getLabRun(runId) {
      return await client.getOptional(
        `${labApiPrefix}/runs/${encodeURIComponent(runId)}`,
        decodeLabRunDetail,
      );
    },
  };
}

const decodeCreatedLabRun = boundary({
  schema: createdLabRunSchema,
  convert: (value): CreatedLabRun => value,
});

const decodeLabRunList = boundary({
  schema: labRunListSchema,
  convert: (value): LabRunListItem[] => value.map(toLabRunListItem),
});

export const decodeLabRunDetail = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value))),
    labRunDetailSchema,
  ),
  convert: (value): LabRunDetail => {
    const detail: LabRunDetail = {
      ...toLabRunListItem(value),
      transcript: value.transcript,
      responseUsage: value.responseUsage.map((usage) => {
        const item: NonNullable<LabRunDetail["responseUsage"]>[number] = {
          responseId: usage.responseId,
          outputTokens: usage.outputTokens,
        };
        if (usage.model !== undefined) item.model = usage.model;
        if (usage.answerTurnNumber !== undefined) item.answerTurnNumber = usage.answerTurnNumber;
        return item;
      }),
    };
    if (value.terminalResult !== undefined) {
      if (value.terminalResult.runId !== value.runId)
        throw new Error("terminal_result_run_mismatch");
      detail.terminalResult = value.terminalResult;
    }
    if (value.closingDiagnostic !== undefined) detail.closingDiagnostic = value.closingDiagnostic;
    if (value.executionModel !== undefined) detail.executionModel = value.executionModel;
    if (value.maxOutputTokens !== undefined) detail.maxOutputTokens = value.maxOutputTokens;
    return detail;
  },
});

const decodeLabRunMutationAcknowledgement = boundary({
  schema: labRunMutationAcknowledgementSchema,
  convert: (value) => value.ok,
});

function toLabRunListItem(value: z.output<typeof labRunListItemSchema>): LabRunListItem {
  const item: LabRunListItem = {
    runId: value.runId,
    startedAt: value.startedAt,
    transcriptTurnCount: value.transcriptTurnCount,
  };
  if (value.endedAt !== undefined) item.endedAt = value.endedAt;
  if (value.outcome !== undefined) item.outcome = value.outcome;
  if (value.endReason !== undefined) item.endReason = value.endReason;
  return item;
}

/** Read persisted evidence independently of the browser participation lifetime. */
export async function readLabOutcome({
  endpointBaseUrl,
  runId,
  timeoutMs,
  signal,
  fetchImpl = fetch,
}: {
  endpointBaseUrl: string;
  runId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: LabWorkerFetch;
}): Promise<LabRunDetail | null> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal =
    signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
  const store = createWorkerLabRunStore(endpointBaseUrl, {
    fetchImpl: (input, init) =>
      fetchImpl(input, { ...init, signal: requestSignal, credentials: "same-origin" }),
  });
  requestSignal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(requestSignal.reason);
    requestSignal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([store.getLabRun(runId), aborted]);
  } finally {
    if (onAbort !== undefined) requestSignal.removeEventListener("abort", onAbort);
  }
}
