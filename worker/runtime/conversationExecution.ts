import { z } from "zod";
import { boundary } from "../../tools/boundary-contracts/boundary-contracts.mjs";
import {
  conversationSelectionSchema,
  type ConversationSelection,
} from "../shared/contracts/conversationSelection.ts";
import {
  interviewExecutionSchema,
  runtimeReasoningEffortValues,
  type InterviewExecution,
} from "../shared/contracts/runtimeStart.ts";
import type { ExecutionSettingsPreparation, PreparedExecutionSettings } from "./nativeContracts.ts";

export const conversationSnapshotSchema = z.strictObject({
  version: z.literal(1),
  selection: conversationSelectionSchema,
  initialState: z.string().min(1),
  initialNodeInput: z.json().optional(),
  initialContext: z.json().optional(),
  execution: interviewExecutionSchema,
  /**
   * The Run's start choices for its execution, and the settings the execution prepared from
   * them, in its own format. Runtime never reads either; it prepares again from the choices
   * and requires the result to equal the prepared settings.
   */
  executionSettings: z.strictObject({
    reasoningEffort: z.enum(runtimeReasoningEffortValues).nullable(),
    requested: z.json().optional(),
    prepared: z.json(),
  }),
  visitId: z.string().min(1),
  operationId: z.string().min(1),
});
export type ConversationSnapshot = z.output<typeof conversationSnapshotSchema>;
export const decodeConversationSnapshot = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value ?? null))),
    conversationSnapshotSchema,
  ),
  convert: (value) => value,
});
export function createConversationSnapshot(
  selection: ConversationSelection,
  execution: InterviewExecution,
  settings: ExecutionSettingsPreparation & Readonly<{ prepared: PreparedExecutionSettings }>,
  initialState: string,
  initialNodeInput?: import("./conversationContracts.ts").ConversationCallbackJson,
  initialContext?: import("./conversationContracts.ts").ConversationCallbackJson,
): ConversationSnapshot {
  return decodeConversationSnapshot({
    version: 1,
    selection,
    initialState,
    initialNodeInput,
    initialContext,
    execution,
    visitId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    executionSettings: settings,
  });
}
