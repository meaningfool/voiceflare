import { describe, expect, it } from "vitest";
import {
  decodeRuntimeConnectionExchange,
  decodeRuntimeConnectionValidationRequest,
  decodeRuntimeConnectionValidationResponse,
  decodeRuntimeConnectionResult,
} from "./runtimeConnection.ts";

describe("opaque Runtime connection wire", () => {
  it("carries optional/non-SDP contents while validating the owned envelope", () => {
    expect(decodeRuntimeConnectionExchange({ exchangeId: "first" })).toEqual({
      exchangeId: "first",
    });
    expect(
      decodeRuntimeConnectionValidationRequest({
        profile: "probe",
        connection: { exchangeId: "next", input: { challenge: 17 } },
      }),
    ).toEqual({ profile: "probe", connection: { exchangeId: "next", input: { challenge: 17 } } });
    expect(
      decodeRuntimeConnectionResult({
        runId: "run",
        exchangeId: "next",
        acceptance: "accepted",
        reply: ["ready", 7],
      }),
    ).toEqual({ runId: "run", exchangeId: "next", acceptance: "accepted", reply: ["ready", 7] });
  });
  it("rejects malformed validation envelopes and excludes inherited required fields", () => {
    expect(
      decodeRuntimeConnectionValidationResponse({ profile: "probe", fingerprint: "owned" }),
    ).toEqual({ profile: "probe", fingerprint: "owned" });
    for (const input of [
      { connection: { exchangeId: "first" } },
      { profile: 42, connection: { exchangeId: "first" } },
      { profile: "probe", connection: { exchangeId: 42 } },
      { profile: "probe", connection: { exchangeId: "first", extra: true } },
    ])
      expect(() => decodeRuntimeConnectionValidationRequest(input)).toThrow();
    for (const input of [
      { profile: "probe" },
      { profile: "probe", fingerprint: 42 },
      { profile: "probe", fingerprint: "owned", extra: true },
    ])
      expect(() => decodeRuntimeConnectionValidationResponse(input)).toThrow();
    const inherited = { profile: "probe" };
    Object.setPrototypeOf(inherited, { fingerprint: "owned" });
    expect(() => decodeRuntimeConnectionValidationResponse(inherited)).toThrow();
  });
  it.each([
    {},
    { exchangeId: 42 },
    { exchangeId: "" },
    { exchangeId: "valid", extra: true },
    Object.create({ exchangeId: "inherited" }),
  ])("rejects missing, malformed, unknown and inherited exchange fields: %j", (value) => {
    expect(() => decodeRuntimeConnectionExchange(value)).toThrow();
  });
  it.each([
    { runId: "run", exchangeId: "first" },
    { runId: 42, exchangeId: "first", acceptance: "accepted" },
    { runId: "run", exchangeId: "first", acceptance: "live" },
    { runId: "run", exchangeId: "first", acceptance: "accepted", error: 42 },
    { runId: "run", exchangeId: "first", acceptance: "accepted", extra: true },
    Object.create({ runId: "run", exchangeId: "first", acceptance: "accepted" }),
  ])("rejects invalid semantic results: %j", (value) =>
    expect(() => decodeRuntimeConnectionResult(value)).toThrow(),
  );
});
