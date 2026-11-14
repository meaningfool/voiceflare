import { describe, expect, it } from "vitest";

import {
  decodeApplicationStartupDisposition,
  decodeRuntimeReadinessCallback,
  decodeRuntimeRequiredStopAcknowledgement,
  decodeRuntimeRequiredStopRequest,
} from "./applicationStartup.ts";

describe("Application startup consumer contracts", () => {
  it("decodes the finite readiness and stop protocol", () => {
    expect(decodeRuntimeReadinessCallback({ runId: "run_1", liveAt: 123 })).toEqual({
      runId: "run_1",
      liveAt: 123,
    });
    expect(
      decodeApplicationStartupDisposition({
        runId: "run_1",
        disposition: "failed",
        decidedAt: 124,
        reason: "deadline_expired",
        stopRequired: true,
      }),
    ).toEqual({
      runId: "run_1",
      disposition: "failed",
      decidedAt: 124,
      reason: "deadline_expired",
      stopRequired: true,
    });
    expect(
      decodeRuntimeRequiredStopRequest({ runId: "run_1", reason: "application_startup_failed" }),
    ).toEqual({ runId: "run_1", reason: "application_startup_failed" });
    expect(
      decodeRuntimeRequiredStopAcknowledgement({
        runId: "run_1",
        accepted: true,
        acceptance: "accepted",
      }),
    ).toEqual({ runId: "run_1", accepted: true, acceptance: "accepted" });
    expect(
      decodeRuntimeRequiredStopAcknowledgement({
        runId: "run_1",
        accepted: true,
        acceptance: "not_accepted",
      }),
    ).toEqual({ runId: "run_1", accepted: true, acceptance: "not_accepted" });
  });

  it.each([
    {},
    { runId: "run_1" },
    { runId: 1, liveAt: 123 },
    { runId: "run_1", liveAt: "123" },
    { runId: "run_1", liveAt: 123, extra: true },
    Object.create({ runId: "run_1", liveAt: 123 }),
  ])("rejects invalid readiness callback %j", (value) => {
    expect(() => decodeRuntimeReadinessCallback(value)).toThrow();
  });

  it.each([
    {},
    {
      runId: "run_1",
      disposition: "unknown",
      decidedAt: null,
      reason: null,
      stopRequired: false,
    },
    {
      runId: "run_1",
      disposition: "pending",
      decidedAt: null,
      reason: null,
      stopRequired: "false",
    },
    {
      runId: "run_1",
      disposition: "pending",
      decidedAt: null,
      reason: null,
      stopRequired: false,
      extra: true,
    },
  ])("rejects invalid startup disposition %j", (value) => {
    expect(() => decodeApplicationStartupDisposition(value)).toThrow();
  });

  it("requires stop protocol fields to be owned and exact", () => {
    expect(() =>
      decodeRuntimeRequiredStopRequest(
        Object.create({ runId: "run_1", reason: "application_startup_failed" }),
      ),
    ).toThrow();
    expect(() =>
      decodeRuntimeRequiredStopAcknowledgement({
        runId: "run_1",
        accepted: false,
        acceptance: "accepted",
      }),
    ).toThrow();
    expect(() =>
      decodeRuntimeRequiredStopAcknowledgement({
        runId: "run_1",
        accepted: true,
        acceptance: "accepted",
        extra: true,
      }),
    ).toThrow();
  });

  it.each([
    {},
    { runId: "run_1" },
    { reason: "application_startup_failed" },
    { runId: 42, reason: "application_startup_failed" },
    { runId: "run_1", reason: 42 },
    { runId: "run_1", reason: "participant_stopped" },
    { runId: "run_1", reason: "application_startup_failed", extra: true },
  ])("rejects malformed required-stop requests %j", (value) => {
    expect(() => decodeRuntimeRequiredStopRequest(value)).toThrow();
  });

  it.each([
    {},
    { runId: "run_1" },
    { accepted: true, acceptance: "accepted" },
    { runId: "run_1", accepted: true },
    { runId: 42, accepted: true, acceptance: "accepted" },
    { runId: "run_1", accepted: "true", acceptance: "accepted" },
    { runId: "run_1", accepted: true, acceptance: "unknown" },
    { runId: "run_1", accepted: true, acceptance: null },
    Object.create({ runId: "run_1", accepted: true, acceptance: "accepted" }),
  ])("rejects malformed required-stop acknowledgements %j", (value) => {
    expect(() => decodeRuntimeRequiredStopAcknowledgement(value)).toThrow();
  });

  it("keeps inherited extras outside owned stop protocol values", () => {
    const request = { runId: "run_1", reason: "application_startup_failed" };
    const acknowledgement = { runId: "run_1", accepted: true, acceptance: "not_accepted" };
    Object.setPrototypeOf(request, { extra: true });
    Object.setPrototypeOf(acknowledgement, { extra: true });

    const ownedRequest = decodeRuntimeRequiredStopRequest(request);
    const ownedAcknowledgement = decodeRuntimeRequiredStopAcknowledgement(acknowledgement);
    expect(ownedRequest).toEqual({
      runId: "run_1",
      reason: "application_startup_failed",
    });
    expect(ownedAcknowledgement).toEqual({
      runId: "run_1",
      accepted: true,
      acceptance: "not_accepted",
    });
    expect(ownedRequest).not.toHaveProperty("extra");
    expect(ownedAcknowledgement).not.toHaveProperty("extra");
  });

  it("excludes inherited extras from owned decoded values", () => {
    const disposition: unknown = Object.assign(Object.create({ extra: true }), {
      runId: "run_1",
      disposition: "succeeded",
      decidedAt: 123,
      reason: "readiness_confirmed",
      stopRequired: false,
    });
    expect(decodeApplicationStartupDisposition(disposition)).toEqual({
      runId: "run_1",
      disposition: "succeeded",
      decidedAt: 123,
      reason: "readiness_confirmed",
      stopRequired: false,
    });
  });
});
