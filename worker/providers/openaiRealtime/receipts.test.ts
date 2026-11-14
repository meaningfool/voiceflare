import { describe, expect, it } from "vitest";
import { decodeRealtimeReceipt } from "./receipts.ts";

// The kit's node operations settle their commands and replies on these receipts: the closing
// reads replies, audio and command errors, and a pair's own node entries also read the
// acknowledged configuration.
describe("Realtime receipts", () => {
  it("validates reply fields and excludes unowned data", () => {
    for (const event of [
      {},
      { type: 42 },
      { type: "response.done", response: { id: 42 } },
      { type: "response.done", response: { id: "closing", status: 1 } },
      { type: "response.done", response: { id: "closing", metadata: { operation: 1 } } },
      { type: "response.done", response: { id: "closing", output: [{ content: [{ type: 42 }] }] } },
      { type: "output_audio_buffer.stopped", response_id: 42 },
    ])
      expect(decodeRealtimeReceipt(JSON.stringify(event)).ok).toBe(false);
    expect(
      decodeRealtimeReceipt(
        JSON.stringify({
          type: "output_audio_buffer.stopped",
          response_id: "closing",
          unknown: "unexpected",
        }),
      ),
    ).toEqual({ ok: true, value: { type: "output_audio_buffer.stopped", response_id: "closing" } });
  });
  it("validates effective configuration and error code at the provider ingress", () => {
    for (const event of [
      { type: "session.updated", session: { audio: { input: { turn_detection: 42 } } } },
      { type: "session.updated", session: { audio: { input: null } } },
      { type: "error", error: { code: 42 } },
      { type: "error", error: { event_id: 42 } },
    ])
      expect(decodeRealtimeReceipt(JSON.stringify(event)).ok).toBe(false);
    expect(
      decodeRealtimeReceipt(
        JSON.stringify({
          type: "session.updated",
          session: { ignored: true, audio: { input: { turn_detection: null, ignored: true } } },
        }),
      ),
    ).toEqual({
      ok: true,
      value: { type: "session.updated", session: { audio: { input: { turn_detection: null } } } },
    });
  });
  it("validates the effective-configuration acknowledgement details before ownership", () => {
    for (const event of [
      { type: "session.updated", event_id: 12 },
      { type: "session.updated", session: { instructions: 12 } },
      ...[
        { type: 12 },
        { eagerness: [] },
        { threshold: "high" },
        { create_response: "false" },
        { interrupt_response: 1 },
      ].map((turns) => ({
        type: "session.updated",
        session: { audio: { input: { turn_detection: turns } } },
      })),
    ])
      expect(decodeRealtimeReceipt(JSON.stringify(event)).ok).toBe(false);
    expect(
      decodeRealtimeReceipt(
        JSON.stringify({
          type: "session.updated",
          event_id: "configuration-ack",
          ignored: true,
          session: {
            instructions: "",
            audio: {
              input: {
                turn_detection: {
                  type: "semantic_vad",
                  eagerness: "high",
                  create_response: false,
                  interrupt_response: false,
                  ignored: true,
                },
              },
            },
          },
        }),
      ),
    ).toEqual({
      ok: true,
      value: {
        type: "session.updated",
        event_id: "configuration-ack",
        session: {
          instructions: "",
          audio: {
            input: {
              turn_detection: {
                type: "semantic_vad",
                eagerness: "high",
                create_response: false,
                interrupt_response: false,
              },
            },
          },
        },
      },
    });
  });
});
