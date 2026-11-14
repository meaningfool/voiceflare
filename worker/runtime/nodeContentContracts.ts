import type { SemanticReport } from "./executionContracts.ts";
export type PreparedInstructions =
  | Readonly<{ kind: "literal"; text: string }>
  | Readonly<{
      kind: "provider_prompt";
      prompt: Readonly<{
        id: string;
        version?: string;
        variables?: Readonly<Record<string, string | number | boolean>>;
      }>;
    }>;
export type PreparedTool = Readonly<{
  type: "function";
  name: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
}>;
export type ConversationToolInvocation = Readonly<{
  toolName: string;
  arguments?: unknown;
  callId?: string;
  itemId?: string;
  responseId?: string;
  type?: string;
}>;
export type ConversationToolIntent = Readonly<{
  kind: "conversation_event";
  report?: SemanticReport<unknown>;
}>;
export type PreparedConversationNode = Readonly<{
  instructions: PreparedInstructions;
  operationalInstructions: string;
  tools: readonly PreparedTool[];
}>;
/**
 * A closing state's content: the one sentence the interviewer says to close, exactly as the
 * Conversation's input gives it. Nothing generates it or reasons about it; each kit's closing
 * says it as its provider allows.
 */
export type PreparedClosing = Readonly<{ sentence: string }>;
