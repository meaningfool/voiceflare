import { z } from "zod";

import { boundary } from "../../tools/boundary-contracts/boundary-contracts.mjs";
import type { ProviderTranscriptRole } from "./nativeContracts.ts";
import type { SerializedTranscriptCapture } from "./interviewFinalizationModel.ts";

const persistedTranscriptCaptureSchema = z
  .object({
    sequence: z.unknown().optional(),
    items: z.unknown().optional(),
  })
  .catch({});

const persistedTranscriptItemSchema = z
  .object({
    itemId: z.unknown(),
    firstSeenSequence: z.unknown().optional(),
    previousItemId: z.unknown().optional(),
    role: z.unknown().optional(),
    responseId: z.unknown().optional(),
    outputIndex: z.unknown().optional(),
    contentIndex: z.unknown().optional(),
    text: z.unknown().optional(),
    finalSequence: z.unknown().optional(),
  })
  .passthrough();

type TranscriptItem = {
  itemId: string;
  firstSeenSequence: number;
  previousItemId?: string;
  role?: ProviderTranscriptRole;
  responseId?: string;
  outputIndex?: number;
  contentIndex?: number;
  text?: string;
  finalSequence?: number;
};

export type TranscriptCapture = {
  sequence: number;
  items: Map<string, TranscriptItem>;
};

export function createTranscriptCapture(): TranscriptCapture {
  return {
    sequence: 0,
    items: new Map(),
  };
}

export function serializeTranscriptCapture(
  capture: TranscriptCapture,
): SerializedTranscriptCapture {
  return {
    sequence: capture.sequence,
    items: [...capture.items.values()].map((item) => ({ ...item })),
  };
}

export const restoreTranscriptCapture = boundary({
  schema: persistedTranscriptCaptureSchema,
  convert: (value): TranscriptCapture => {
    const sequence =
      typeof value.sequence === "number" &&
      Number.isSafeInteger(value.sequence) &&
      value.sequence >= 0
        ? value.sequence
        : 0;
    const items = new Map<string, TranscriptItem>();

    if (Array.isArray(value.items)) {
      for (const candidate of value.items) {
        const parsedCandidate = persistedTranscriptItemSchema.safeParse(candidate);
        if (!parsedCandidate.success) continue;
        const persistedItem = parsedCandidate.data;
        const itemId = persistedItem.itemId;
        if (typeof itemId !== "string") continue;
        const previousItemId =
          typeof persistedItem.previousItemId === "string"
            ? persistedItem.previousItemId
            : undefined;
        const role =
          persistedItem.role === "participant" || persistedItem.role === "conversationAgent"
            ? persistedItem.role
            : undefined;
        const responseId =
          typeof persistedItem.responseId === "string" ? persistedItem.responseId : undefined;
        const outputIndex =
          typeof persistedItem.outputIndex === "number" ? persistedItem.outputIndex : undefined;
        const contentIndex =
          typeof persistedItem.contentIndex === "number" ? persistedItem.contentIndex : undefined;
        const text = typeof persistedItem.text === "string" ? persistedItem.text : undefined;
        const finalSequence =
          typeof persistedItem.finalSequence === "number" ? persistedItem.finalSequence : undefined;
        const item: TranscriptItem = {
          itemId,
          firstSeenSequence:
            typeof persistedItem.firstSeenSequence === "number" &&
            Number.isSafeInteger(persistedItem.firstSeenSequence)
              ? persistedItem.firstSeenSequence
              : sequence,
        };
        if (previousItemId !== undefined) item.previousItemId = previousItemId;
        if (role !== undefined) item.role = role;
        if (responseId !== undefined) item.responseId = responseId;
        if (outputIndex !== undefined) item.outputIndex = outputIndex;
        if (contentIndex !== undefined) item.contentIndex = contentIndex;
        if (text !== undefined) item.text = text;
        if (finalSequence !== undefined) item.finalSequence = finalSequence;
        items.set(item.itemId, item);
      }
    }

    return { sequence, items };
  },
});
