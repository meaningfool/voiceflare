export type BrowserEndingStrategy = "hard_stop" | "graceful_agent_completion";

export type ConversationMedia = Readonly<{
  peer: RTCPeerConnection;
  stream: MediaStream;
  remoteAudio: HTMLAudioElement;
  dataChannel: RTCDataChannel;
  offerSdp: string;
}>;

type SessionOptions = Readonly<{
  onStage?: (stage: string) => void;
  onReady?: () => void;
  onPlaybackSettled?: () => void;
  onDisposed?: () => void;
}>;

/** Owns one native audio connection. Application transport and recovery outlive it. */
export class BrowserConversationSession {
  private media: ConversationMedia | null = null;
  private stream: MediaStream | null = null;
  private peer: RTCPeerConnection | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private readonly options: SessionOptions;
  private readonly lifetime = new AbortController();
  private readonly readiness = new AbortController();
  private setup: Promise<ConversationMedia> | null = null;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private readinessTimer: ReturnType<typeof setTimeout> | null = null;
  private readinessDeadline: ReturnType<typeof setTimeout> | null = null;
  private readyTransport: ((signal: AbortSignal) => Promise<boolean>) | null = null;
  private observationDisposers = new Set<() => void>();
  private answerApplied = false;
  private readinessStarted = false;
  private startupPermitted = false;
  private liveNotified = false;
  private ending: BrowserEndingStrategy | null = null;
  private playbackContained = false;
  private microphoneStopped = false;
  private outputBufferActive = false;
  private gracefulSettlementObserved = false;

  constructor(options: SessionOptions = {}) {
    this.options = options;
  }

  get disposed(): boolean {
    return this.lifetime.signal.aborted;
  }

  get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  get nativeReady(): boolean {
    return (
      !this.disposed &&
      this.answerApplied &&
      this.media !== null &&
      this.media.remoteAudio.srcObject !== null &&
      this.media.dataChannel.readyState === "open"
    );
  }

  get liveReady(): boolean {
    return this.nativeReady && this.startupPermitted && this.ending === null;
  }

  get playbackSettled(): boolean {
    return this.gracefulSettlementObserved;
  }

  get mediaPresent(): boolean {
    return (
      !this.disposed &&
      (this.media?.stream.getAudioTracks().some((track) => track.readyState !== "ended") ?? false)
    );
  }

  prepare(): Promise<ConversationMedia> {
    this.setup ??= this.prepareMedia();
    return this.setup;
  }

  private assertActive(): void {
    if (this.disposed) throw new DOMException("Participation disposed", "AbortError");
  }

  private async prepareMedia(): Promise<ConversationMedia> {
    this.assertActive();
    if (navigator.mediaDevices?.getUserMedia === undefined)
      throw new Error("microphone_unavailable");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (this.disposed) {
      for (const track of stream.getTracks()) track.stop();
      this.assertActive();
    }
    this.stream = stream;
    try {
      this.options.onStage?.("microphoneReady");
      this.assertActive();
      for (const track of stream.getAudioTracks()) track.enabled = false;
      const peer = new RTCPeerConnection();
      this.peer = peer;
      const remoteAudio = document.createElement("audio");
      this.remoteAudio = remoteAudio;
      remoteAudio.autoplay = true;
      remoteAudio.hidden = true;
      document.body.append(remoteAudio);
      const dataChannel = peer.createDataChannel("oai-events");
      this.media = { peer, stream, remoteAudio, dataChannel, offerSdp: "" };
      peer.addEventListener(
        "track",
        (event) => {
          if (this.disposed || this.playbackContained) return;
          const [remoteStream] = event.streams;
          if (remoteStream !== undefined) remoteAudio.srcObject = remoteStream;
          this.coordinateReadiness();
        },
        { signal: this.lifetime.signal },
      );
      dataChannel.addEventListener("open", () => this.coordinateReadiness(), {
        signal: this.lifetime.signal,
      });
      for (const name of ["closing", "close"]) {
        dataChannel.addEventListener(name, () => this.cancelReadiness(), {
          signal: this.lifetime.signal,
        });
      }
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      const offer = await peer.createOffer();
      this.assertActive();
      await peer.setLocalDescription(offer);
      this.assertActive();
      if (typeof offer.sdp !== "string") throw new Error("missing_offer");
      this.media = { peer, stream, remoteAudio, dataChannel, offerSdp: offer.sdp };
      this.options.onStage?.("connectionInputReady");
      return this.media;
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  async applyAnswer(sdp: string): Promise<void> {
    this.assertActive();
    if (this.media === null) throw new Error("media_not_prepared");
    await this.media.peer.setRemoteDescription({ type: "answer", sdp });
    this.assertActive();
    this.answerApplied = true;
    this.options.onStage?.("connectionReplyApplied");
    this.coordinateReadiness();
  }

  setMediaReadyTransport(send: (signal: AbortSignal) => Promise<boolean>): void {
    if (this.disposed) return;
    this.readyTransport = send;
    this.coordinateReadiness();
  }

  setStartupDisposition(disposition: "pending" | "succeeded" | "failed"): void {
    if (this.disposed) return;
    this.startupPermitted = disposition === "succeeded";
    if (disposition === "failed") this.dispose();
    else this.coordinateReadiness();
  }

  private coordinateReadiness(): void {
    if (!this.nativeReady || this.ending !== null) return;
    if (this.liveReady && !this.liveNotified) {
      this.liveNotified = true;
      // Interviewer audio can play before its provider events arrive, so Live
      // alone never opens the microphone: the opening's playback settling does.
      this.setMicrophoneEnabled(this.gracefulSettlementObserved && !this.outputBufferActive);
      this.options.onReady?.();
    }
    if (this.readyTransport === null || this.readinessStarted || this.readiness.signal.aborted)
      return;
    this.readinessStarted = true;
    this.readinessDeadline = setTimeout(() => this.cancelReadiness(), 15_000);
    const send = async (): Promise<void> => {
      if (!this.nativeReady || this.readiness.signal.aborted) return;
      try {
        if (
          await this.readyTransport?.(
            AbortSignal.any([this.readiness.signal, AbortSignal.timeout(2_000)]),
          )
        ) {
          this.cancelReadiness();
          return;
        }
      } catch {
        // Retry only inside this connection's original readiness bound.
      }
      if (!this.readiness.signal.aborted) this.readinessTimer = setTimeout(() => void send(), 500);
    };
    void send();
  }

  private cancelReadiness(): void {
    this.readiness.abort();
    if (this.readinessTimer !== null) clearTimeout(this.readinessTimer);
    if (this.readinessDeadline !== null) clearTimeout(this.readinessDeadline);
    this.readinessTimer = null;
    this.readinessDeadline = null;
  }

  /** A transport subscription belongs to participation, never to recovery. */
  retainObservation(dispose: () => void): void {
    if (this.disposed) dispose();
    else this.observationDisposers.add(dispose);
  }

  private setMicrophoneEnabled(enabled: boolean): void {
    if (this.disposed || this.microphoneStopped || this.media === null) return;
    for (const track of this.media.stream.getAudioTracks()) track.enabled = enabled;
  }

  stopMicrophone(): void {
    if (this.microphoneStopped) return;
    this.microphoneStopped = true;
    for (const track of this.stream?.getAudioTracks() ?? []) {
      track.enabled = false;
      track.stop();
    }
  }

  stopPlayback(): void {
    this.playbackContained = true;
    const audio = this.remoteAudio;
    if (audio === null) return;
    audio.muted = true;
    audio.pause();
    audio.srcObject = null;
    audio.remove();
  }

  beginEnding(_strategy: BrowserEndingStrategy): void {
    if (this.disposed) return;
    if (this.ending === "hard_stop") return;
    this.ending = "hard_stop";
    this.cancelReadiness();
    this.stopMicrophone();
    this.stopPlayback();
    this.scheduleCleanup();
  }

  scheduleCleanup(): void {
    if (this.disposed || this.cleanupTimer !== null) return;
    this.cleanupTimer = setTimeout(() => this.dispose(), 25_000);
  }

  /** The app decodes provider ingress into the native event name once. */
  observeOpenAiEvent(eventType: string | null): void {
    if (this.disposed || this.playbackContained || this.media === null) return;
    switch (eventType) {
      case "response.created":
        this.outputBufferActive = false;
        this.setMicrophoneEnabled(false);
        break;
      case "response.output_item.added":
      case "response.content_part.added":
        this.setMicrophoneEnabled(false);
        break;
      case "response.output_audio.delta":
      case "response.output_audio_transcript.delta":
      case "response.audio.delta":
      case "response.audio_transcript.delta":
      case "output_audio_buffer.started":
        this.outputBufferActive = true;
        this.setMicrophoneEnabled(false);
        break;
      case "response.done":
        if (this.outputBufferActive) return;
        this.settlePlayback();
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.outputBufferActive = false;
        this.settlePlayback();
        break;
    }
  }

  private settlePlayback(): void {
    this.gracefulSettlementObserved = true;
    this.setMicrophoneEnabled(this.liveReady);
    if (this.ending === "graceful_agent_completion") this.options.onPlaybackSettled?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.lifetime.abort();
    this.cancelReadiness();
    if (this.cleanupTimer !== null) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = null;
    this.stopMicrophone();
    for (const track of this.stream?.getTracks() ?? []) {
      if (track.readyState !== "ended") track.stop();
    }
    this.stopPlayback();
    this.peer?.close();
    for (const dispose of this.observationDisposers) dispose();
    this.observationDisposers.clear();
    this.options.onDisposed?.();
  }
}
