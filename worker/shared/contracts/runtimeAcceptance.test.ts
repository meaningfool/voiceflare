import { describe, expect, it } from "vitest";
import {
  decodeRuntimeAcceptanceRequest,
  decodeRuntimeAcceptanceResponse,
} from "./runtimeAcceptance.ts";

describe("acceptance HTTP consumer contracts", () => {
  it("returns owned request and both finite response variants", () => {
    expect(decodeRuntimeAcceptanceRequest({ runId: "attempt" })).toEqual({ runId: "attempt" });
    for (const acceptance of ["accepted", "not_accepted"]) {
      expect(decodeRuntimeAcceptanceResponse({ runId: "attempt", acceptance })).toEqual({
        runId: "attempt",
        acceptance,
      });
    }
  });
  it.each([
    {},
    { runId: 42 },
    { runId: { value: "attempt" } },
    { runId: "" },
    { runId: "attempt", extra: true },
    Object.create({ runId: "attempt" }),
  ])("rejects invalid request %j", (value) => {
    expect(() => decodeRuntimeAcceptanceRequest(value)).toThrow();
  });
  it.each([
    {},
    { runId: "attempt" },
    { runId: 42, acceptance: "accepted" },
    { runId: "attempt", acceptance: true },
    { runId: "attempt", acceptance: { state: "accepted" } },
    { runId: "attempt", acceptance: "unknown" },
    { runId: "attempt", acceptance: "accepted", extra: true },
    Object.create({ runId: "attempt", acceptance: "accepted" }),
  ])("rejects invalid response %j", (value) => {
    expect(() => decodeRuntimeAcceptanceResponse(value)).toThrow();
  });
  it("excludes inherited extra fields", () => {
    const value: unknown = Object.assign(Object.create({ extra: true }), {
      runId: "attempt",
      acceptance: "accepted",
    });
    expect(decodeRuntimeAcceptanceResponse(value)).toEqual({
      runId: "attempt",
      acceptance: "accepted",
    });
    expect(
      decodeRuntimeAcceptanceRequest(
        Object.assign(Object.create({ extra: true }), { runId: "attempt" }),
      ),
    ).toEqual({ runId: "attempt" });
  });
});
