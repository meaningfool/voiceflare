import { z } from "zod";

import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";
import { createLabWorkerClient, type LabWorkerFetch } from "./data/labWorkerClient";
import {
  createInterviewPromptProvenance,
  type InterviewPromptProvenance,
} from "./data/interviewPrompt";

export type LabPromptOption = {
  id: string;
  fileName: string;
  content: string;
  provenance: InterviewPromptProvenance;
};

const labPromptSchema = z.strictObject({
  id: z.string().min(1),
  fileName: z.string().min(1),
  content: z.string(),
});
const decodeLabPrompts = boundary({
  schema: z.array(labPromptSchema),
  convert: (prompts) =>
    prompts.map(({ id, fileName, content }) => ({
      id,
      fileName,
      content,
      provenance: createInterviewPromptProvenance({ promptId: id, content }),
    })),
});
const decodeLabPrompt = boundary({
  schema: labPromptSchema,
  convert: ({ id, fileName, content }) => ({
    id,
    fileName,
    content,
    provenance: createInterviewPromptProvenance({ promptId: id, content }),
  }),
});

export function createLabPromptStore(baseUrl: string, fetchImpl?: LabWorkerFetch) {
  const client = createLabWorkerClient(baseUrl, fetchImpl);
  return {
    listLabPrompts: () => client.get("/_api/prompts", decodeLabPrompts),
    createLabPrompt: (name: string, content: string) =>
      client.post("/_api/prompts", { name, content }, decodeLabPrompt),
    updateLabPrompt: (id: string, content: string) =>
      client.patch(`/_api/prompts/${encodeURIComponent(id)}`, { content }, decodeLabPrompt),
  };
}

export type LabPromptStore = ReturnType<typeof createLabPromptStore>;
