import { expect, it } from "vitest";
import { z } from "zod";
import {
  consumeStateReport,
  createReportingAuthority,
  issueStateReporter,
} from "./admission/private/reporting.ts";
const contract = {
  event: z.strictObject({
    kind: z.literal("finish_intent"),
    responseId: z.string(),
    toolCallId: z.string(),
  }),
};
const event = { kind: "finish_intent", responseId: "response-1", toolCallId: "tool-1" } as const;
const identity = { runId: "run-1", visitId: "visit-1", operationId: "operation-1", generation: 1 };
it("requires the expected issuer and consumes each accepted report once", () => {
  const authority = createReportingAuthority();
  const reporter = issueStateReporter(contract, identity, () => true, authority);
  const report = reporter.report(event);
  expect(report).not.toBeNull();
  if (report === null) throw new Error("missing_report");
  expect(consumeStateReport(undefined, contract, authority)).toBeNull();
  expect(consumeStateReport(report, contract, authority)).toEqual(event);
  expect(consumeStateReport(report, contract, authority)).toBeNull();
  const foreign = reporter.report(event);
  if (foreign === null) throw new Error("missing_report");
  expect(consumeStateReport(foreign, contract, createReportingAuthority())).toBeNull();
});
it("rechecks captured scope at commit and refuses new stale reports", () => {
  const authority = createReportingAuthority();
  let current = true;
  const reporter = issueStateReporter(contract, identity, () => current, authority);
  const report = reporter.report(event);
  if (report === null) throw new Error("missing_report");
  current = false;
  expect(consumeStateReport(report, contract, authority)).toBeNull();
  expect(reporter.report(event)).toBeNull();
});
it("detaches identities and events and requires the exact selected contract", () => {
  const authority = createReportingAuthority();
  const inputIdentity = structuredClone(identity);
  const inputEvent = { ...event, responseId: "response-1" };
  const reporter = issueStateReporter(
    contract,
    inputIdentity,
    (issued) => issued.visitId === "visit-1",
    authority,
  );
  inputIdentity.visitId = "visit-2";
  const report = reporter.report(inputEvent);
  inputEvent.responseId = "response-2";
  if (report === null) throw new Error("missing_report");
  expect(consumeStateReport(report, contract, authority)).toEqual(event);
  const otherContract = reporter.report(event);
  if (otherContract === null) throw new Error("missing_report");
  expect(consumeStateReport(otherContract, { event: contract.event }, authority)).toBeNull();
  expect(() => JSON.stringify(reporter.report(event))).toThrow("semantic_report_not_persistable");
});
