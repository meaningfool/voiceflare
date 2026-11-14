// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserConversationSession } from "./conversationSession";

class Track {
  enabled = true;
  readyState = "live";
  stop(): void {
    this.readyState = "ended";
  }
}
class Stream {
  readonly track = new Track();
  getAudioTracks(): Track[] {
    return [this.track];
  }
  getTracks(): Track[] {
    return [this.track];
  }
}
class Channel extends EventTarget {
  readyState = "connecting";
}
class Peer extends EventTarget {
  readonly channel = new Channel();
  readonly close = vi.fn();
  readonly addTrack = vi.fn();
  readonly createOffer = vi.fn(async () => ({ type: "offer", sdp: "original-offer" }));
  readonly setLocalDescription = vi.fn(async () => undefined);
  readonly setRemoteDescription = vi.fn(async () => undefined);
  createDataChannel(): Channel {
    return this.channel;
  }
  track(stream: MediaStream): void {
    const event = new Event("track");
    Object.defineProperty(event, "streams", { value: [stream] });
    this.dispatchEvent(event);
  }
}
function mediaHarness() {
  const stream = new Stream();
  const peer = new Peer();
  const getUserMedia = vi.fn(async () => stream);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  const createPeer = vi.fn(function () {
    return peer;
  });
  vi.stubGlobal("RTCPeerConnection", createPeer);
  return { stream, peer, getUserMedia, createPeer };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred promise not initialized");
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("browser participation resource ownership", () => {
  it("disposes during microphone permission without ever creating a peer", async () => {
    const harness = mediaHarness();
    const microphone = deferred<Stream>();
    harness.getUserMedia.mockReturnValue(microphone.promise);
    const session = new BrowserConversationSession();
    const setup = session.prepare();
    const rejected = expect(setup).rejects.toMatchObject({ name: "AbortError" });
    session.dispose();
    microphone.resolve(harness.stream);
    await rejected;
    expect(harness.stream.track.readyState).toBe("ended");
    expect(harness.createPeer).not.toHaveBeenCalled();
    expect(document.querySelector("audio")).toBeNull();
  });

  it("does not apply a late offer or recreate resources after setup disposal", async () => {
    const harness = mediaHarness();
    const offer = deferred<{ type: string; sdp: string }>();
    harness.peer.createOffer.mockReturnValue(offer.promise);
    const session = new BrowserConversationSession();
    const setup = session.prepare();
    const rejected = expect(setup).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(harness.peer.createOffer).toHaveBeenCalledOnce());
    session.dispose();
    offer.resolve({ type: "offer", sdp: "original-offer" });
    await rejected;
    expect(harness.peer.setLocalDescription).not.toHaveBeenCalled();
    expect(harness.peer.close).toHaveBeenCalledOnce();
    expect(harness.stream.track.readyState).toBe("ended");
  });

  it("stops readiness retries and aborts their transport at the original fifteen-second bound", async () => {
    vi.useFakeTimers();
    const { peer } = mediaHarness();
    const sendReady = vi.fn(async (_signal: AbortSignal) => false);
    const session = new BrowserConversationSession();
    await session.prepare();
    session.setMediaReadyTransport(sendReady);
    peer.channel.readyState = "open";
    peer.track(new MediaStream());
    await session.applyAnswer("answer");
    session.setStartupDisposition("succeeded");

    await vi.advanceTimersByTimeAsync(14_999);
    expect(sendReady.mock.calls.length).toBeGreaterThan(1);
    const lastSignal = sendReady.mock.calls.at(-1)?.[0];
    expect(lastSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastSignal?.aborted).toBe(true);
    const attemptsAtCutoff = sendReady.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendReady).toHaveBeenCalledTimes(attemptsAtCutoff);
    expect(session.liveReady).toBe(true);
    session.dispose();
  });

  it("keeps the microphone off from Live until the opening has finished playing", async () => {
    const { stream, peer } = mediaHarness();
    const ready = vi.fn();
    const session = new BrowserConversationSession({ onReady: ready });
    await session.prepare();
    peer.channel.readyState = "open";
    peer.track(new MediaStream());
    await session.applyAnswer("answer");
    session.setStartupDisposition("succeeded");
    expect(ready).toHaveBeenCalledOnce();
    // The opening's audio is already playing; none of its provider events has arrived.
    expect(stream.track.enabled).toBe(false);
    session.observeOpenAiEvent("response.created");
    session.observeOpenAiEvent("output_audio_buffer.started");
    session.observeOpenAiEvent("response.done");
    expect(stream.track.enabled).toBe(false);
    session.observeOpenAiEvent("output_audio_buffer.stopped");
    expect(stream.track.enabled).toBe(true);
    session.dispose();
  });

  it("opens the microphone at Live when the opening finished playing before Live", async () => {
    const { stream, peer } = mediaHarness();
    const session = new BrowserConversationSession();
    await session.prepare();
    peer.channel.readyState = "open";
    peer.track(new MediaStream());
    await session.applyAnswer("answer");
    session.observeOpenAiEvent("response.created");
    session.observeOpenAiEvent("output_audio_buffer.started");
    session.observeOpenAiEvent("output_audio_buffer.stopped");
    expect(stream.track.enabled).toBe(false);
    session.setStartupDisposition("succeeded");
    expect(stream.track.enabled).toBe(true);
    session.dispose();
  });

  it("contains every Runtime Ending immediately and rejects stale playback readiness", async () => {
    const { stream, peer } = mediaHarness();
    const session = new BrowserConversationSession();
    await session.prepare();
    peer.channel.readyState = "open";
    peer.track(new MediaStream());
    await session.applyAnswer("answer");
    session.setStartupDisposition("succeeded");
    session.beginEnding("graceful_agent_completion");
    expect(stream.track.readyState).toBe("ended");
    expect(document.querySelector("audio")).toBeNull();
    session.beginEnding("hard_stop");
    session.observeOpenAiEvent("output_audio_buffer.stopped");
    peer.track(new MediaStream());
    expect(stream.track.enabled).toBe(false);
    expect(document.querySelector("audio")).toBeNull();
    expect(session.liveReady).toBe(false);
    session.dispose();
  });

  it("cancels participation observation on the cleanup bound without claiming server outcome", async () => {
    vi.useFakeTimers();
    const { peer, stream } = mediaHarness();
    const disposed = vi.fn();
    const observation = vi.fn();
    const session = new BrowserConversationSession({ onDisposed: disposed });
    await session.prepare();
    session.retainObservation(observation);
    session.beginEnding("hard_stop");
    expect(peer.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(peer.close).toHaveBeenCalledOnce();
    expect(stream.track.readyState).toBe("ended");
    expect(observation).toHaveBeenCalledOnce();
    expect(disposed).toHaveBeenCalledOnce();
    session.dispose();
    expect(observation).toHaveBeenCalledOnce();
    const lateObservation = vi.fn();
    session.retainObservation(lateObservation);
    expect(lateObservation).toHaveBeenCalledOnce();
  });
});
