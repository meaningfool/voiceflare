import type { z } from "zod";
import {
  conversationDiagnostics as originalDiagnostics,
  originalInterviewIdentity,
} from "./originalInterview.ts";
import {
  conversationDiagnostics as goodbyeDiagnostics,
  goodbyeInterviewIdentity,
} from "./goodbyeInterview.ts";
import {
  conversationDiagnostics as questionsDiagnostics,
  questionsInterviewIdentity,
} from "./questionsInterview.ts";

type ConversationIdentity = Readonly<{ id: string; version: number }>;

/**
 * Every Conversation module, by identity, with the diagnostics it declares. Runtime's catalog
 * check holds the registry to this list, so readers that need a Conversation's own records, such
 * as Lab's closing review and the voice suite, derive them from here rather than naming ids.
 */
export const conversationModules: readonly Readonly<{
  identity: ConversationIdentity;
  diagnostics: Readonly<Record<string, z.ZodType>>;
}>[] = Object.freeze([
  { identity: originalInterviewIdentity, diagnostics: originalDiagnostics },
  { identity: goodbyeInterviewIdentity, diagnostics: goodbyeDiagnostics },
  { identity: questionsInterviewIdentity, diagnostics: questionsDiagnostics },
]);

/** The diagnostic a Conversation records when it assesses its closing. */
export const closingAssessmentType = "conversation.closing_assessment";

/**
 * The declaration of a Conversation's closing assessment, from its module, when it assesses its
 * closing; none for a Conversation that has no closing or is not a module here.
 */
export function closingAssessmentOf(conversation: ConversationIdentity): z.ZodType | undefined {
  const module = conversationModules.find(
    ({ identity }) => identity.id === conversation.id && identity.version === conversation.version,
  );
  return module === undefined
    ? undefined
    : new Map(Object.entries(module.diagnostics)).get(closingAssessmentType);
}
