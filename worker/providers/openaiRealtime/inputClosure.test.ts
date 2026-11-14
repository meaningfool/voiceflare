import { describe, expect, it } from "vitest";
import { normalizeProviderRuntimeObservation, type ParsedProviderEvent } from "./providerEvents.ts";
import { RealtimeInputClosure } from "./inputClosure.ts";

function nativeInput() {
  const closure = new RealtimeInputClosure();
  let sequence = 0;
  return {
    closure,
    observe(event: ParsedProviderEvent & { item_id?: string }, acceptsNewInput: boolean) {
      const observation = normalizeProviderRuntimeObservation(JSON.stringify(event), ++sequence);
      if (observation === null) throw new Error("unnormalized provider event");
      return closure.observe(observation, event.item_id, acceptsNewInput);
    },
  };
}

describe("Realtime participant input closure", () => {
  it("keeps speech admitted before the participation fence and excludes later speech", () => {
    const input = nativeInput();
    expect(
      input.observe({ type: "input_audio_buffer.speech_started", item_id: "a" }, true),
    ).toEqual({});
    expect(
      input.observe({ type: "input_audio_buffer.speech_started", item_id: "b" }, false),
    ).toEqual({ excludedParticipantInput: true });
    expect(input.observe({ type: "input_audio_buffer.committed", item_id: "a" }, false)).toEqual({
      consumedActiveInput: { itemId: "a" },
    });
    expect(
      input.observe(
        { type: "conversation.item.input_audio_transcription.completed", item_id: "a" },
        false,
      ),
    ).toEqual({});
    expect(input.observe({ type: "input_audio_buffer.committed", item_id: "b" }, false)).toEqual({
      excludedParticipantInput: true,
    });
    expect(
      input.observe(
        { type: "conversation.item.input_audio_transcription.completed", item_id: "b" },
        false,
      ),
    ).toEqual({ excludedParticipantInput: true });
  });

  it("settles admitted speech only with the item that speech named", () => {
    const input = nativeInput();
    input.observe({ type: "input_audio_buffer.speech_started", item_id: "a" }, true);
    // Before the shared session, Original settled admitted speech with whichever item came next.
    expect(input.observe({ type: "input_audio_buffer.committed", item_id: "other" }, true)).toEqual(
      {},
    );
    expect(input.closure.state.buffered).toEqual({ itemId: "a" });
    expect(input.observe({ type: "input_audio_buffer.committed", item_id: "a" }, true)).toEqual({
      consumedActiveInput: { itemId: "a" },
    });
    expect(input.closure.state.buffered).toBeNull();
  });

  it("attributes exactly one item to the final commit and closes admission", () => {
    const input = nativeInput();
    input.closure.requestCommit();
    expect(input.closure.commitOutcome).toEqual({ status: "dispatched" });
    expect(
      input.observe({ type: "input_audio_buffer.speech_started", item_id: "a" }, true),
    ).toEqual({ excludedParticipantInput: true });
    expect(input.observe({ type: "input_audio_buffer.committed", item_id: "final" }, true)).toEqual(
      { consumedActiveInput: { itemId: "final" } },
    );
    expect(input.closure.commitOutcome).toBeNull();
    expect(input.observe({ type: "input_audio_buffer.committed", item_id: "final" }, true)).toEqual(
      { excludedParticipantInput: true },
    );
    expect(input.observe({ type: "input_audio_buffer.committed", item_id: "late" }, true)).toEqual({
      excludedParticipantInput: true,
    });
  });
});
