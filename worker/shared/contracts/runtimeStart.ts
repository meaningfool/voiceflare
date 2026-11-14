import {
  conversationSelectionSchema,
  type ConversationSelection,
} from "./conversationSelection.ts";
import { z } from "zod";
import { runtimeDeliveryTargetSchema, type RuntimeDeliveryTarget } from "./runtimeDelivery.ts";
import {
  runtimeConnectionExchangeSchema,
  type RuntimeConnectionExchange,
} from "./runtimeConnection.ts";

import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";

export const runtimeReasoningEffortValues = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const);

const nonBlankStringSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "must not be blank",
});

const trimmedNonBlankStringSchema = nonBlankStringSchema.transform((value) => value.trim());

const safeIntegerSchema = z.number().refine(Number.isSafeInteger, {
  message: "must be a safe integer",
});

const interviewQuestionSchema = z.strictObject({
  id: nonBlankStringSchema,
  text: nonBlankStringSchema,
  maxFollowUps: z.union([z.literal(0), z.literal(1), z.literal(2)]),
});

export const interviewDefinitionSchema = z
  .strictObject({
    warmUp: nonBlankStringSchema,
    followUpPolicy: z.strictObject({
      enabled: z.boolean(),
    }),
    questions: z.array(interviewQuestionSchema),
    closing: nonBlankStringSchema,
  })
  .superRefine((definition, context) => {
    const questionIds = new Set<string>();

    definition.questions.forEach((question, index) => {
      const normalizedId = question.id.trim();

      if (questionIds.has(normalizedId)) {
        context.addIssue({
          code: "custom",
          path: ["questions", index, "id"],
          message: "duplicate_question_id",
        });
      }

      questionIds.add(normalizedId);
    });
  });

const agentInputTransportSchema = z.json();

// Runtime retains opaque agent-owned input; only the selected Agent interprets it.
export const interviewExecutionSchema = z.strictObject({
  agentInput: agentInputTransportSchema,
});

export const runtimeDiagnosticsContextSchema = z.strictObject({
  surface: trimmedNonBlankStringSchema.optional(),
  environment: trimmedNonBlankStringSchema.optional(),
  appResourceKind: trimmedNonBlankStringSchema.optional(),
  appResourceId: trimmedNonBlankStringSchema.optional(),
  runtimeControllerVersion: trimmedNonBlankStringSchema.optional(),
});

const reasoningEffortSchema = z.enum(runtimeReasoningEffortValues);
/**
 * The selected execution's settings, carried as opaque JSON: only that execution interprets
 * them, and it refuses settings it cannot prepare before any provider work. Lab sends its
 * Realtime settings here; an application may send none.
 */
const executionSettingsSchema = z.json();

export const runtimeStartRequestSchema = z.strictObject({
  runId: trimmedNonBlankStringSchema,
  selection: conversationSelectionSchema,
  profile: trimmedNonBlankStringSchema,
  connection: runtimeConnectionExchangeSchema,
  execution: interviewExecutionSchema,
  createdAt: safeIntegerSchema.optional(),
  startupExpiresAt: safeIntegerSchema.nonnegative(),
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
  executionSettings: executionSettingsSchema.optional(),
  deliveryTarget: runtimeDeliveryTargetSchema.optional(),
  diagnosticsContext: runtimeDiagnosticsContextSchema.optional(),
});

export type InterviewDefinition = z.output<typeof interviewDefinitionSchema>;

export type InterviewExecution = z.output<typeof interviewExecutionSchema>;

export type RuntimeReasoningEffort = z.output<typeof reasoningEffortSchema>;
export type ExecutionSettings = z.output<typeof executionSettingsSchema>;

export type RuntimeDiagnosticsContext = z.output<typeof runtimeDiagnosticsContextSchema>;

export type RuntimeStartRequest = z.output<typeof runtimeStartRequestSchema>;

export type ApplicationRuntimeStartInput = Readonly<{
  runId: string;
  selection: ConversationSelection;
  profile: string;
  connection: RuntimeConnectionExchange;
  agentInput: z.output<typeof agentInputTransportSchema>;
  createdAt?: number;
  startupExpiresAt: number;
  reasoningEffort?: RuntimeReasoningEffort | null;
  deliveryTarget?: RuntimeDeliveryTarget;
  diagnosticsContext?: RuntimeDiagnosticsContext;
}>;

export type LabRuntimeStartInput = Readonly<{
  runId: string;
  selection: ConversationSelection;
  profile: string;
  connection: RuntimeConnectionExchange;
  instructions?: string;
  agentInput: z.output<typeof agentInputTransportSchema>;
  createdAt?: number;
  startupExpiresAt: number;
  reasoningEffort?: RuntimeReasoningEffort | null;
  executionSettings?: ExecutionSettings;
  deliveryTarget?: RuntimeDeliveryTarget;
  diagnosticsContext?: RuntimeDiagnosticsContext;
}>;

export type RuntimeStartParseResult =
  | Readonly<{
      ok: true;
      value: RuntimeStartRequest;
    }>
  | Readonly<{
      ok: false;
      error: RuntimeStartError;
    }>;

export type RuntimeStartError =
  | "invalid_runtime_start_request"
  | "missing_run_id"
  | "missing_execution"
  | "invalid_execution"
  | "invalid_configured_interview"
  | "invalid_event_name"
  | "invalid_interview_definition"
  | "invalid_question"
  | "duplicate_question_id"
  | "blank_raw_instructions"
  | "invalid_reasoning_effort"
  | "invalid_execution_settings"
  | "invalid_runtime_timestamp"
  | "invalid_startup_expiry"
  | "invalid_diagnostics_context";

interface InterviewDefinitionParser {
  (value: unknown): InterviewDefinition | null;
}

interface InterviewExecutionParser {
  (value: unknown): InterviewExecution | null;
}

interface RuntimeStartRequestParser {
  (value: unknown): RuntimeStartParseResult;
}

interface RuntimeReasoningEffortGuard {
  (value: unknown): value is RuntimeReasoningEffort;
}

export const parseInterviewDefinition: InterviewDefinitionParser = (value) => {
  const parsed = interviewDefinitionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export const parseInterviewExecution: InterviewExecutionParser = (value) => {
  const parsed = interviewExecutionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const ownRuntimeStartFieldsSchema = z.unknown().superRefine((value, context) => {
  if (!isRecord(value)) return;
  for (const [source, fields, path] of [
    [value, runtimeStartRequestSchema.keyof().options, []],
    [value.execution, ["agentInput"], ["execution"]],
    [value.connection, ["exchangeId", "input"], ["connection"]],
    [
      value.diagnosticsContext,
      runtimeDiagnosticsContextSchema.keyof().options,
      ["diagnosticsContext"],
    ],
  ] as const) {
    if (!isRecord(source)) continue;
    for (const field of fields) {
      if (field in source && !Object.hasOwn(source, field)) {
        context.addIssue({
          code: "custom",
          path: [...path, field],
          message: "must be an own property",
        });
      }
    }
  }
});

const runtimeStartRequestBoundary = boundary({
  schema: ownRuntimeStartFieldsSchema.pipe(runtimeStartRequestSchema),
  convert: (request) => request,
});

export const parseRuntimeStartRequest: RuntimeStartRequestParser = (value) => {
  try {
    return { ok: true, value: runtimeStartRequestBoundary(value) };
  } catch {
    const invalid = runtimeStartRequestSchema.safeParse(value);

    return {
      ok: false,
      error: invalid.success
        ? "invalid_runtime_start_request"
        : mapRuntimeStartSchemaError(value, invalid.error.issues),
    };
  }
};

export type ConfiguredInterviewExecutionInput = Readonly<{
  agentInput: z.output<typeof agentInputTransportSchema>;
}>;

export function buildConfiguredInterviewExecution(
  input: ConfiguredInterviewExecutionInput,
): InterviewExecution {
  const parsed = parseInterviewExecution({
    agentInput: input.agentInput,
  });

  if (parsed === null) {
    throw new Error("invalid_configured_interview");
  }

  return parsed;
}

export function buildRawInstructionsExecution(
  instructions: string,
  agentInput?: z.output<typeof agentInputTransportSchema>,
): InterviewExecution {
  if (instructions.trim().length === 0) throw new Error("blank_raw_instructions");
  if (
    agentInput !== undefined &&
    (agentInput === null || typeof agentInput !== "object" || Array.isArray(agentInput))
  )
    throw new Error("invalid_execution");
  const parsed = parseInterviewExecution({
    agentInput: { ...agentInput, instructions },
  });

  if (parsed === null) {
    throw new Error("blank_raw_instructions");
  }

  return parsed;
}

export function buildApplicationRuntimeStartRequest(
  input: ApplicationRuntimeStartInput,
): RuntimeStartRequest {
  return buildRuntimeStartRequest({
    ...input,
    execution: buildConfiguredInterviewExecution(input),
  });
}

export function buildLabRuntimeStartRequest(input: LabRuntimeStartInput): RuntimeStartRequest {
  return buildRuntimeStartRequest({
    ...input,
    execution: buildConfiguredInterviewExecution({ agentInput: input.agentInput }),
  });
}

export const isReasoningEffort: RuntimeReasoningEffortGuard = (
  value,
): value is RuntimeReasoningEffort => reasoningEffortSchema.safeParse(value).success;

type RuntimeStartBuilderInput = Readonly<{
  runId: string;
  selection: ConversationSelection;
  profile: string;
  connection: RuntimeConnectionExchange;
  execution: InterviewExecution;
  createdAt?: number;
  startupExpiresAt: number;
  reasoningEffort?: RuntimeReasoningEffort | null;
  executionSettings?: ExecutionSettings;
  deliveryTarget?: RuntimeDeliveryTarget;
  diagnosticsContext?: RuntimeDiagnosticsContext;
}>;

type MutableRuntimeStartRequest = {
  -readonly [Key in keyof RuntimeStartRequest]: RuntimeStartRequest[Key];
};

function buildRuntimeStartRequest(input: RuntimeStartBuilderInput): RuntimeStartRequest {
  const candidate: MutableRuntimeStartRequest = {
    runId: input.runId,
    selection: input.selection,
    profile: input.profile,
    connection: input.connection,
    execution: input.execution,
    startupExpiresAt: input.startupExpiresAt,
  };

  if (input.createdAt !== undefined) candidate.createdAt = input.createdAt;
  if (input.startupExpiresAt !== undefined) candidate.startupExpiresAt = input.startupExpiresAt;
  if (input.reasoningEffort !== undefined) candidate.reasoningEffort = input.reasoningEffort;
  if (input.executionSettings !== undefined) candidate.executionSettings = input.executionSettings;
  if (input.deliveryTarget !== undefined) candidate.deliveryTarget = input.deliveryTarget;
  if (input.diagnosticsContext !== undefined) {
    candidate.diagnosticsContext = input.diagnosticsContext;
  }

  const parsed = parseRuntimeStartRequest(candidate);

  if (!parsed.ok) {
    throw new Error(parsed.error);
  }

  return parsed.value;
}

type RuntimeStartSchemaIssue = Readonly<{
  code: string;
  path: readonly PropertyKey[];
}>;

function mapRuntimeStartSchemaError<Value>(
  value: Value,
  issues: readonly RuntimeStartSchemaIssue[],
): RuntimeStartError {
  if (!isRecord(value)) {
    return "invalid_runtime_start_request";
  }

  if (issues.some((issue) => issue.code === "unrecognized_keys" && issue.path.length === 0)) {
    return "invalid_runtime_start_request";
  }

  if (hasIssueAt(issues, "runId")) {
    return "missing_run_id";
  }

  if (hasIssueAt(issues, "reasoningEffort")) {
    return "invalid_reasoning_effort";
  }
  if (hasIssueAt(issues, "executionSettings")) return "invalid_execution_settings";

  if (!Object.hasOwn(value, "execution")) {
    return "missing_execution";
  }

  if (hasIssueAt(issues, "execution")) {
    return "invalid_execution";
  }

  if (hasIssueAt(issues, "createdAt")) {
    return "invalid_runtime_timestamp";
  }

  if (hasIssueAt(issues, "diagnosticsContext")) {
    return "invalid_diagnostics_context";
  }

  if (hasIssueAt(issues, "startupExpiresAt")) return "invalid_startup_expiry";

  return "invalid_runtime_start_request";
}

function hasIssueAt(issues: readonly RuntimeStartSchemaIssue[], field: string): boolean {
  return issues.some((issue) => issue.path[0] === field);
}

function isRecord<Value>(value: Value): value is Value & Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
