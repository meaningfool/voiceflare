import { z } from "zod";
import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import { usageDeclarationSchema } from "../../../src/browser/runtimeTerminalResult.ts";
import { resultWarningSchema } from "./resultWarnings.ts";

export const conversationSelectionSchema = z.preprocess(
  (value) => z.json().parse(JSON.parse(JSON.stringify(value ?? null))),
  z.strictObject({
    conversation: z.strictObject({ id: z.string().min(1), version: z.number().int().positive() }),
    execution: z.strictObject({ id: z.string().min(1), version: z.number().int().positive() }),
  }),
);
export type ConversationSelection = z.output<typeof conversationSelectionSchema>;
export const originalRealtimeSelection: ConversationSelection = Object.freeze({
  conversation: Object.freeze({ id: "original-interview", version: 1 }),
  execution: Object.freeze({ id: "realtime", version: 1 }),
});
/**
 * A credential's name, as its provider declares it and as Runtime reads it from its environment,
 * such as `OPENAI_API_KEY`.
 */
const credentialNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
/**
 * Whether a combination can start on this Runtime: the credentials its providers need under
 * this Runtime's configuration, none when it is configured with stand-ins, and those of them
 * Runtime lacks. It can start when none is missing.
 */
const combinationAvailabilitySchema = z.strictObject({
  credentials: z.array(credentialNameSchema),
  missingCredentials: z.array(credentialNameSchema),
});
export type CombinationAvailability = z.output<typeof combinationAvailabilitySchema>;
export const conversationCatalogSchema = z.strictObject({
  selections: z.array(
    z.strictObject({
      id: z.string().min(1),
      version: z.number().int().positive(),
      name: z.string().min(1),
      selection: conversationSelectionSchema,
      connectionProfiles: z.array(z.string().min(1)),
      inputContract: z.string().min(1),
      /** The usage entries this combination can report, declared by its providers. */
      usage: z.array(usageDeclarationSchema),
      /**
       * The result warnings this combination's execution may attach, declared next to its code;
       * Runtime's own warnings, `runtimeWarnings`, are the same for every combination.
       */
      warnings: z.array(resultWarningSchema),
      availability: combinationAvailabilitySchema,
    }),
  ),
});
export type ConversationCatalog = z.output<typeof conversationCatalogSchema>;
export const decodeConversationCatalog = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value ?? null))),
    conversationCatalogSchema,
  ),
  convert: (value) => value,
});

/**
 * The refusal of a combination that cannot start because Runtime lacks credentials its providers
 * need: `missing_credentials:` followed by their names, comma-separated, such as
 * `missing_credentials:SONIOX_API_KEY`.
 */
export function missingCredentialsRefusal(names: readonly string[]): string {
  return `missing_credentials:${names.join(",")}`;
}
const missingCredentialsRefusalSchema = z
  .string()
  .regex(/^missing_credentials:[A-Z][A-Z0-9_]*(,[A-Z][A-Z0-9_]*)*$/);
export function isMissingCredentialsRefusal(code: string): boolean {
  return missingCredentialsRefusalSchema.safeParse(code).success;
}

/**
 * Runtime's catalog check of a selection's interview input, and of the execution settings the
 * Start will carry, asked before any Run starts. Runtime answers 204 when the selected
 * Conversation accepts the input, its execution can prepare the settings and the combination can
 * start, or 400 with one of `conversationInputRefusals` or a `missingCredentialsRefusal`.
 */
export const conversationInputCheckPath = "/_runtime/conversation-inputs/validate";
const conversationInputCheckSchema = z.strictObject({
  selection: conversationSelectionSchema,
  agentInput: z.json(),
  /** The Start's execution settings, opaque here: only the selected execution reads them. */
  executionSettings: z.json().optional(),
});
export type ConversationInputCheck = z.output<typeof conversationInputCheckSchema>;
export const decodeConversationInputCheck = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value ?? null))),
    conversationInputCheckSchema,
  ),
  convert: (value) => value,
});
export const conversationInputRefusals = [
  "conversation_selection_unavailable",
  "invalid_conversation_input",
  "invalid_execution_settings",
] as const;
export const decodeConversationInputRefusal = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value ?? null))),
    z.strictObject({
      error: z.union([z.enum(conversationInputRefusals), missingCredentialsRefusalSchema]),
    }),
  ),
  convert: (value) => value.error,
});
