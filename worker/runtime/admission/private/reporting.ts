import { z } from "zod";
import { conversationJsonSchema } from "../../conversationContracts.ts";
const authorityBrand: unique symbol = Symbol("reporting-authority");
export type ReportingAuthority = Readonly<{ [authorityBrand]: true }>;
export function createReportingAuthority(): ReportingAuthority {
  return Object.freeze({ [authorityBrand]: true });
}

export const executionIdentitySchema = z.strictObject({
  runId: z.string().min(1),
  visitId: z.string().min(1),
  operationId: z.string().min(1),
  generation: z.number().int().nonnegative(),
});
export type ExecutionIdentity = Readonly<z.output<typeof executionIdentitySchema>>;
class SemanticReport<Event> {
  readonly #eventType: Event | undefined;
  constructor() {
    this.#eventType = undefined;
  }
  toJSON(): never {
    void this.#eventType;
    throw new Error("semantic_report_not_persistable");
  }
}
export type { SemanticReport };
/**
 * The opaque token owns report authority: its issuer, the exact contract and the current
 * visit. Its private record holds the one owned copy of the event, decoded at capture.
 */
type ReportRecord = Readonly<{
  authority: ReportingAuthority;
  event: unknown;
  contract: object;
  current(): boolean;
}>;
const reports = new WeakMap<object, ReportRecord>();
export type StateReporter<Event> = Readonly<{
  report(event: NoInfer<Event>): SemanticReport<Event> | null;
  isCurrent(): boolean;
}>;
export type ReporterFactory = <Event>(
  contract: Readonly<{ event: z.ZodType<Event> }>,
) => StateReporter<Event>;
export function issueStateReporter<Event>(
  contract: Readonly<{ event: z.ZodType<Event> }>,
  identity: ExecutionIdentity,
  current: (issued: ExecutionIdentity) => boolean,
  authority: ReportingAuthority,
): StateReporter<Event> {
  const issued = structuredClone(identity);
  return Object.freeze({
    report(event: Event) {
      if (!current(issued)) return null;
      // Capture detaches execution's value once and decodes it by the declared event contract.
      const owned = contract.event.parse(structuredClone(event));
      if (!current(issued)) return null;
      const token = new SemanticReport<Event>();
      reports.set(token, { authority, contract, event: owned, current: () => current(issued) });
      return token;
    },
    isCurrent: () => current(issued),
  });
}
export function consumeStateReport<Event>(
  token: SemanticReport<unknown> | undefined,
  contract: Readonly<{ event: z.ZodType<Event> }>,
  authority: ReportingAuthority,
): Event | null {
  if (token === undefined) return null;
  const record = reports.get(token);
  reports.delete(token);
  if (
    record === undefined ||
    record.authority !== authority ||
    !capturedBy(record, contract) ||
    !record.current()
  )
    return null;
  // The record is private and consumed once, so its captured event is handed over as is.
  return record.event;
}
function capturedBy<Event>(
  record: ReportRecord,
  contract: Readonly<{ event: z.ZodType<Event> }>,
): record is ReportRecord & Readonly<{ event: Event }> {
  return record.contract === contract;
}
export const conversationVisitSchema = z.strictObject({
  context: conversationJsonSchema.optional(),
  state: z.string().min(1),
  visitId: z.string().min(1),
  operationId: z.string().min(1),
  revision: z.number().int().nonnegative().optional(),
});
export type ConversationVisit = z.output<typeof conversationVisitSchema>;
