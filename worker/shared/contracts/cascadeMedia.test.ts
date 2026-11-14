import { describe, expect, it } from "vitest";
import {
  decodeCascadeMediaClientMessage,
  decodeCascadeMediaServerMessage,
  decodeCascadeMediaStartReply,
} from "./cascadeMedia.ts";
import { cascadeMediaConnectionSetup } from "../../providers/cascade/connection.ts";

describe("Cascade media protocol decoders", () => {
  it.each([
    { type: "output.started", outputId: "out-1" },
    { type: "output.audio", outputId: "out-1", sequence: 0, audio: "AAAA" },
    { type: "output.ended", outputId: "out-1", chunkCount: 1 },
    { type: "output.cancelled", outputId: "out-1" },
    { type: "output.failed", outputId: "out-1", code: "speech_output_failed" },
    { type: "input.listening", opportunityId: "listen-1", afterOutputId: "out-1" },
    { type: "input.listening", opportunityId: "listen-1", afterOutputId: null },
    { type: "input.closed", opportunityId: "listen-1" },
  ])("returns the owned $type message", (message) => {
    expect(decodeCascadeMediaServerMessage(message)).toEqual(message);
  });

  it.each([
    { type: "output.started" },
    { type: "output.audio", outputId: "out-1", sequence: "0", audio: "AAAA" },
    { type: "output.audio", outputId: "out-1", sequence: -1, audio: "AAAA" },
    { type: "output.audio", outputId: "out-1", sequence: 0, audio: "not base64!" },
    { type: "output.ended", outputId: "out-1" },
    { type: "output.failed", outputId: "out-1", code: "" },
    { type: "output.resumed", outputId: "out-1" },
    { type: "output.started", outputId: "out-1", extra: true },
    Object.create({ type: "output.started", outputId: "out-1" }),
    { type: "input.listening", opportunityId: "listen-1" },
    { type: "input.listening", opportunityId: "", afterOutputId: null },
    { type: "input.closed" },
  ])("rejects a message outside the browser's contract: %j", (message) => {
    expect(() => decodeCascadeMediaServerMessage(message)).toThrow();
  });

  const reply = {
    runId: "lab_run",
    exchangeId: "exchange",
    acceptance: "accepted",
    reply: {
      output: { encoding: "pcm_s16le", sampleRate: 24_000, channels: 1 },
      input: { encoding: "pcm_s16le", sampleRate: 16_000, channels: 1 },
    },
  };
  it("returns an accepted Start's output format, excluding Runtime's diagnostics", () => {
    expect(
      decodeCascadeMediaStartReply({ ...reply, diagnostics: { sessionId: "cascade_x" } }),
    ).toEqual(reply);
  });

  it.each([
    { ...reply, acceptance: "unresolved" },
    { ...reply, runId: 42 },
    { ...reply, reply: { sdp: "v=0" } },
    { ...reply, reply: { ...reply.reply, output: { ...reply.reply.output, sampleRate: 48_000 } } },
    { ...reply, reply: { ...reply.reply, output: { ...reply.reply.output, encoding: "opus" } } },
    { ...reply, reply: { output: reply.reply.output } },
    { ...reply, reply: { ...reply.reply, input: { ...reply.reply.input, sampleRate: 48_000 } } },
    Object.assign(Object.create({ reply: reply.reply }), { ...reply, reply: undefined }),
  ])("rejects a Start reply the browser cannot play: %j", (value) => {
    expect(() => decodeCascadeMediaStartReply(value)).toThrow();
  });
});

describe("Cascade media session's decoder of browser messages", () => {
  it("returns the owned audio of the named listening opportunity", () => {
    const message = { type: "input.audio", opportunityId: "listen-1", audio: "AAAA" };
    expect(decodeCascadeMediaClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it.each([
    "not json",
    JSON.stringify({ type: "input.audio", opportunityId: "listen-1" }),
    JSON.stringify({ type: "input.audio", opportunityId: "", audio: "AAAA" }),
    JSON.stringify({ type: "input.audio", opportunityId: 1, audio: "AAAA" }),
    JSON.stringify({ type: "input.audio", opportunityId: "listen-1", audio: "not base64!" }),
    JSON.stringify({ type: "input.audio", opportunityId: "listen-1", audio: "AAAA", extra: 1 }),
    JSON.stringify({ type: "output.started", outputId: "out-1" }),
    new Uint8Array([1, 2]),
  ])("rejects a message the session cannot attribute to an opportunity: %j", (data) => {
    expect(() => decodeCascadeMediaClientMessage(data)).toThrow();
  });
});

describe("Cascade media connection setup", () => {
  it("accepts the empty Start input and fingerprints the profile", async () => {
    expect(cascadeMediaConnectionSetup.profile).toBe("cascade-media-v1");
    await expect(cascadeMediaConnectionSetup.validate({})).resolves.toEqual({
      fingerprint: "cascade-media-v1",
    });
  });

  it.each([undefined, null, { sdp: "v=0" }, []])(
    "refuses native input the profile does not take: %j",
    (input) => {
      expect(() => cascadeMediaConnectionSetup.validate(input)).toThrow(
        "invalid_cascade_media_connection",
      );
    },
  );
});
