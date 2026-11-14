import { z } from "zod";
import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import { conversationSelectionSchema } from "./conversationSelection.ts";

export const runtimeDiagnosticRetentionMs = 30 * 24 * 60 * 60 * 1000;

export const diagnosticPayloadJsonSchema = z.string().transform((text) => {
  z.json().parse(JSON.parse(text));
  return text;
});

const runtimeDiagnosticRecordValueSchema = z.strictObject({
  recordId: z.string().min(1),
  runId: z.string().min(1),
  source: z.enum(["runtime", "conversation", "execution"]),
  selection: conversationSelectionSchema.nullable(),
  visitId: z.string().min(1).nullable(),
  operationId: z.string().min(1).nullable(),
  observedAt: z.number().int().safe().nonnegative(),
  sequence: z.number().int().safe().positive(),
  elapsedMs: z.number().int().safe().nonnegative(),
  type: z.string().min(1),
  payloadJson: diagnosticPayloadJsonSchema,
});
export const runtimeDiagnosticRecordSchema = z.preprocess(
  (value) => (value === undefined ? value : z.json().parse(value)),
  runtimeDiagnosticRecordValueSchema,
);
export type RuntimeDiagnosticRecord = Readonly<z.output<typeof runtimeDiagnosticRecordSchema>>;
export const decodeRuntimeDiagnosticRecord = boundary({
  schema: runtimeDiagnosticRecordSchema,
  convert: (record) => record,
});
export const diagnosticOmissionSchema = z.strictObject({
  diagnosticOmitted: z.literal(true),
  reason: z.enum(["payload_size", "redaction_invalid"]),
});
export const runtimeDiagnosticPageSchema = z.strictObject({
  runId: z.string().min(1),
  records: z.array(runtimeDiagnosticRecordSchema).max(100),
  cursor: z.number().int().safe().nonnegative(),
  hasMore: z.boolean(),
});
export const decodeRuntimeDiagnosticPage = boundary({
  schema: z.preprocess(
    (value) => (value === undefined ? value : z.json().parse(value)),
    runtimeDiagnosticPageSchema,
  ),
  convert: (page) => page,
});
