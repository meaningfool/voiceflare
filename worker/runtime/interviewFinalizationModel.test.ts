import { expect, it } from "vitest";
import { isSameJson } from "./interviewFinalizationModel.ts";

// Change detection skips a durable write when this returns true, so it must agree with the
// stored JSON document: a missed difference would drop a Runtime transition.
it("compares values as their stored JSON documents", () => {
  const stored = { stage: "live", effects: [{ id: "run:1", status: "pending" }], at: 1 };
  expect(
    isSameJson(stored, { at: 1, effects: [{ status: "pending", id: "run:1" }], stage: "live" }),
  ).toBe(true);
  expect(isSameJson({ ...stored, limitation: undefined }, stored)).toBe(true);
  expect(isSameJson([undefined], [null])).toBe(true);
  expect(isSameJson(stored, { ...stored, effects: [{ id: "run:1", status: "sending" }] })).toBe(
    false,
  );
  expect(isSameJson(stored, { ...stored, limitation: null })).toBe(false);
  expect(isSameJson({ items: [] }, { items: {} })).toBe(false);
  expect(isSameJson(stored, null)).toBe(false);
});
