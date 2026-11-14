import { z } from "zod";
import { boundary } from "../../tools/boundary-contracts/boundary-contracts.mjs";
import { interviewExecutionSchema } from "../shared/contracts/runtimeStart.ts";
export type {
  RuntimeImplementation as ConversationAgent,
  PreparedConversationNode as PreparedConversationAgent,
  ConversationToolInvocation,
  ConversationToolIntent,
} from "./implementationContracts.ts";
// Current host-owned persistence contract; selection is supplied by composition, never Start JSON.
export const decodeConversationAgentSelection = boundary({
  schema: z.preprocess(
    (value) => {
      if (
        value === null ||
        typeof value !== "object" ||
        !Object.hasOwn(value, "id") ||
        !("execution" in value) ||
        !Object.hasOwn(value, "execution")
      )
        return null;
      const execution = value.execution;
      if (
        execution !== null &&
        typeof execution === "object" &&
        ["agentInput"].some((field) => field in execution && !Object.hasOwn(execution, field))
      )
        return null;
      return value;
    },
    z.strictObject({ id: z.string().min(1), execution: interviewExecutionSchema.nullable() }),
  ),
  convert: (selection) => selection,
});
