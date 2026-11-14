import {
  cascadeMediaConnectionProfile,
  decodeCascadeMediaStartReply,
  decodeCascadeMediaServerMessage,
  type CascadeMediaConnectionReply,
} from "../../../../worker/shared/contracts/cascadeMedia.ts";
import {
  decodeConversationInputRefusal,
  isMissingCredentialsRefusal,
} from "../../../../worker/shared/contracts/conversationSelection.ts";
import type { LabCascadeExecutionSettings } from "./labCascadeSettings";
import {
  findLabInterviewInputBuilder,
  type LabInterviewInput,
  type LabInterviewInputBuilder,
} from "../data/conversationPresets";
import { readLabOutcome, type LabRunDetail, type LabRunEndReason } from "../data/labRunStore";
import {
  createLabInterviewStatusChannel,
  type LabInterviewClient,
  type LabInterviewConfig,
  type LabInterviewEndResult,
  type LabInterviewRunIdentity,
  type LabInterviewSession,
  type LabInterviewStartRequest,
  type LabInterviewStatus,
  type LabInterviewTranscriptEvidence,
} from "../interviewClient";
// Lab's own startup and Ending decoders; no Realtime media code.
import {
  decodeLabConversationState,
  decodeLabEndingEvent,
  decodeLabStartupDisposition,
} from "../realtimeClient/openAiLabRealtimeClient";
import {
  deriveLabAttemptRunId,
  LAB_RUN_ID_HEADER,
  LAB_RUN_STARTED_AT_HEADER,
  requestRuntimeClose,
  sendRuntimeMediaReady,
  sendRuntimePresence,
} from "../realtimeClient/realtimeSignaling";

/**
 * Lab's Cascade participation client. It starts a Cascade Run through Lab, attaches the Run's
 * media over Lab's WebSocket route and plays each interviewer output as its audio arrives,
 * through an HTML `audio` element whose source is a `MediaStream`. For each listening
 * opportunity the server offers, it re-enables its microphone track once the preceding output
 * has played and streams the microphone until the opportunity closes; there is no Record or
 * Send control. Browser playback is never a Runtime acknowledgement. It shares no media code
 * with the Realtime client.
 */
export type LabCascadeClientOptions = Readonly<{
  labWorkerUrl: string;
  fetchImpl?: typeof fetch;
  openMediaSocket?: (url: string) => WebSocket;
  now?: () => number;
}>;

const startupBoundMs = 35_000;
/**
 * Runtime announces a normal end once the closing has had time to play, plus its two-second
 * margin. Should that announcement be lost, the page leaves Live this long after the closing
 * finished playing locally.
 */
const endingAnnouncementBoundMs = 5_000;
/** Lab's default maximum Goodbye duration, as the Realtime client applies it. */
const defaultClosingDurationMs = 45_000;

/** The Cascade client's interview: the shared config and the Cascade settings it sends. */
export type LabCascadeClientConfig = LabInterviewConfig & {
  cascadeSettings?: LabCascadeExecutionSettings | undefined;
};

export type LabCascadeClient = LabInterviewClient<LabCascadeClientConfig>;

/** Lab's Start request for a Cascade selection: its profile carries no native input. */
type CascadeStartBody = {
  attemptId: string;
  profile: typeof cascadeMediaConnectionProfile;
  connection: { exchangeId: string; input: Record<never, never> };
  selection: NonNullable<LabInterviewConfig["selection"]>;
  agentInput: LabInterviewInput;
  reasoningEffort: LabInterviewConfig["reasoningEffort"];
  promptProvenance?: NonNullable<LabInterviewStartRequest["promptProvenance"]>;
  executionSettings?: LabCascadeExecutionSettings;
};

/**
 * A refused Start's code when the page shows it: Runtime lacks the credential of a chosen
 * provider. Lab answers a Start with the refusal of Runtime's input check.
 */
async function readStartRefusal(response: Response): Promise<string | undefined> {
  try {
    const refusal = decodeConversationInputRefusal(await response.json());
    return isMissingCredentialsRefusal(refusal) ? refusal : undefined;
  } catch {
    return undefined;
  }
}

export function createLabCascadeClient(options: LabCascadeClientOptions): LabCascadeClient {
  return {
    async start(request) {
      const participation = new CascadeParticipation(options, request);
      await participation.start();
      return participation;
    },
  };
}

/**
 * Plays identified outputs in arrival order; clearing stops every scheduled chunk at once.
 * An output has played locally once its explicit end arrived and its last chunk finished.
 */
class CascadePlayback {
  readonly element: HTMLAudioElement;
  readonly #context: AudioContext;
  readonly #destination: MediaStreamAudioDestinationNode;
  readonly #sources = new Set<AudioBufferSourceNode>();
  readonly #cleared = new Set<string>();
  /** Each output's chunks still scheduled or playing. */
  readonly #playing = new Map<string, Set<AudioBufferSourceNode>>();
  readonly #ended = new Set<string>();
  readonly #played = new Map<string, (() => void)[]>();
  #playhead = 0;
  #closed = false;

  constructor(format: CascadeMediaConnectionReply["output"]) {
    this.#context = new AudioContext({ sampleRate: format.sampleRate });
    this.#destination = this.#context.createMediaStreamDestination();
    this.element = document.createElement("audio");
    this.element.autoplay = true;
    this.element.dataset.labCascadeOutput = "";
    this.element.srcObject = this.#destination.stream;
    document.body.append(this.element);
    void this.#context.resume().catch(() => undefined);
    void this.element.play().catch(() => undefined);
  }

  play(outputId: string, audio: string): void {
    if (this.#closed || this.#cleared.has(outputId)) return;
    const bytes = Uint8Array.from(atob(audio), (character) => character.charCodeAt(0));
    const samples = Math.floor(bytes.length / 2);
    if (samples === 0) return;
    const buffer = this.#context.createBuffer(1, samples, this.#context.sampleRate);
    const channel = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let sample = 0; sample < samples; sample += 1)
      channel[sample] = view.getInt16(sample * 2, true) / 0x8000;
    const source = this.#context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#destination);
    const startAt = Math.max(this.#context.currentTime + 0.02, this.#playhead);
    source.start(startAt);
    this.#playhead = startAt + buffer.duration;
    this.#sources.add(source);
    const playing = this.#playing.get(outputId) ?? new Set();
    playing.add(source);
    this.#playing.set(outputId, playing);
    source.addEventListener("ended", () => {
      this.#sources.delete(source);
      playing.delete(source);
      this.#settle(outputId);
    });
  }

  /** The output's explicit end arrived: it has played once its scheduled chunks finish. */
  end(outputId: string): void {
    this.#ended.add(outputId);
    this.#settle(outputId);
  }

  /** Resolves once the output has finished playing locally; a cleared output never does. */
  played(outputId: string): Promise<void> {
    return new Promise((resolve) => {
      this.#played.set(outputId, [...(this.#played.get(outputId) ?? []), resolve]);
      this.#settle(outputId);
    });
  }

  #settle(outputId: string): void {
    if (
      this.#closed ||
      this.#cleared.has(outputId) ||
      !this.#ended.has(outputId) ||
      (this.#playing.get(outputId)?.size ?? 0) > 0
    )
      return;
    const waiting = this.#played.get(outputId) ?? [];
    this.#played.delete(outputId);
    for (const resolve of waiting) resolve();
  }

  /** Stops an output's scheduled audio at once; its later chunks are discarded. */
  clear(outputId: string | null): void {
    if (outputId !== null) this.#cleared.add(outputId);
    for (const source of this.#sources) {
      try {
        source.stop();
      } catch {
        /* An already stopped chunk has nothing left to clear. */
      }
    }
    this.#sources.clear();
    this.#playhead = 0;
  }

  close(): void {
    if (this.#closed) return;
    this.clear(null);
    this.#closed = true;
    this.element.pause();
    this.element.srcObject = null;
    this.element.remove();
    void this.#context.close().catch(() => undefined);
  }
}

/**
 * Streams the microphone to the media session in the profile's input format while a
 * listening opportunity is open. The participation enables the microphone track only then,
 * so the audio sent is the participant's answer or ordinary silence.
 */
class CascadeCapture {
  readonly #context: AudioContext;
  readonly #processor: ScriptProcessorNode;
  #opportunityId: string | null = null;

  constructor(
    microphone: MediaStream,
    format: CascadeMediaConnectionReply["input"],
    send: (opportunityId: string, audio: string) => void,
  ) {
    this.#context = new AudioContext({ sampleRate: format.sampleRate });
    const source = this.#context.createMediaStreamSource(microphone);
    this.#processor = this.#context.createScriptProcessor(1024, 1, 1);
    const muted = this.#context.createGain();
    muted.gain.value = 0;
    source.connect(this.#processor);
    // The processor runs only when connected to the output; the participant hears nothing.
    this.#processor.connect(muted);
    muted.connect(this.#context.destination);
    this.#processor.addEventListener("audioprocess", (event) => {
      const opportunityId = this.#opportunityId;
      if (opportunityId === null) return;
      send(opportunityId, encodePcm(event.inputBuffer.getChannelData(0)));
    });
    void this.#context.resume().catch(() => undefined);
  }

  listen(opportunityId: string | null): void {
    this.#opportunityId = opportunityId;
  }

  close(): void {
    this.#opportunityId = null;
    this.#processor.disconnect();
    void this.#context.close().catch(() => undefined);
  }
}

/** 16-bit little-endian PCM of the samples, as base64. */
function encodePcm(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, Math.round(sample * 0x7fff), true);
  }
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

class CascadeParticipation implements LabInterviewSession {
  readonly #options: LabCascadeClientOptions;
  readonly #request: LabInterviewStartRequest<LabCascadeClientConfig>;
  readonly #now: () => number;
  readonly #attemptId = crypto.randomUUID();
  readonly #exchangeId = crypto.randomUUID();
  readonly #channel = createLabInterviewStatusChannel({
    phase: "setup",
    label: "Starting Interview",
    detail: "Lab is preparing the interview.",
  });
  readonly #recovery = new AbortController();
  #identity: LabInterviewRunIdentity | null = null;
  /** The selected Conversation's input builder, found once at start. */
  #inputBuilder: LabInterviewInputBuilder | null = null;
  #playback: CascadePlayback | null = null;
  #capture: CascadeCapture | null = null;
  /** The listening opportunity the server offered last; the browser listens once it played. */
  #opportunityId: string | null = null;
  #microphone: MediaStream | null = null;
  #socket: WebSocket | null = null;
  #events: EventSource | null = null;
  #presence: ReturnType<typeof setInterval> | null = null;
  /** Participation has finished: no input, no further media and no presence. */
  #ended = false;
  /** The page has left Live: playback is closed and the finished presentation shows. */
  #leftLive = false;
  /** Runtime reported `finishing` or `goodbye`: the interviewer output now is the closing. */
  #closing = false;
  /** The interviewer output that started last; once Runtime reported a closing, it is that. */
  #lastOutputId: string | null = null;
  /** Runtime announced the end: once the page left Live, its media attachment may close. */
  #endAnnounced = false;
  /** Leaves Live should Runtime's announcement after the played closing be lost. */
  #announcementBound: ReturnType<typeof setTimeout> | null = null;
  /** Runtime's accepted Conversation state, once reported. */
  #conversation: Readonly<{ state: string; deadlineAt: number | null }> | undefined;
  #requestedEnd: LabRunEndReason | null = null;
  /** The code a refused Start carried, which the page shows: Runtime lacks a provider's key. */
  #startRefusal: string | undefined;
  #result: LabInterviewEndResult | null = null;
  #outcome: Promise<LabInterviewEndResult> | null = null;
  #resolveOutcome: ((result: LabInterviewEndResult) => void) | null = null;
  #transcriptEvidence: LabInterviewTranscriptEvidence = {
    transcript: { turns: [] },
    turnCount: 0,
  };

  constructor(
    options: LabCascadeClientOptions,
    request: LabInterviewStartRequest<LabCascadeClientConfig>,
  ) {
    this.#options = options;
    this.#request = request;
    this.#now = options.now ?? Date.now;
    request.signal?.addEventListener(
      "abort",
      () => {
        this.#beginEnding();
        void this.#requestEnd(
          request.signal?.reason === "participant_stopped"
            ? "participant_stopped"
            : "participant_disconnected",
        ).catch(() => undefined);
      },
      { once: true },
    );
  }

  get handle(): LabInterviewRunIdentity {
    if (this.#identity === null) throw new Error("lab_run_not_allocated");
    return this.#identity;
  }

  getStatus(): LabInterviewStatus {
    return this.#channel.getStatus();
  }

  subscribe(listener: (status: LabInterviewStatus) => void): () => void {
    return this.#channel.subscribe(listener);
  }

  getTranscriptEvidence(): LabInterviewTranscriptEvidence {
    return this.#transcriptEvidence;
  }

  /** A failed start releases local media; once a Run is allocated it is ended and resolved. */
  async start(): Promise<void> {
    try {
      await this.#start();
    } catch (error) {
      this.#beginEnding();
      if (this.#identity === null) throw error;
      void this.#requestEnd("runtime_failed").catch(() => undefined);
      this.#notify({
        phase: "ending",
        label: "Resolving Interview",
        detail: "Application startup failed; the experiment outcome is still being resolved.",
      });
    }
  }

  async #start(): Promise<void> {
    const config = this.#request.runtimeConfig;
    if (!Number.isSafeInteger(config.maxDurationMs) || config.maxDurationMs <= 0)
      throw new Error("invalid_lab_duration");
    if (config.selection === undefined) throw new Error("conversation_selection_missing");
    const fetchImpl = this.#options.fetchImpl ?? fetch;
    const inputBuilder = findLabInterviewInputBuilder(config.selection);
    if (inputBuilder === undefined) throw new Error("conversation_selection_unavailable");
    this.#inputBuilder = inputBuilder;
    // Incomplete input is refused here, before the microphone is requested.
    const agentInput = inputBuilder.build(config);
    // The page contract: the microphone track stays disabled outside listening, and the same
    // live track is re-enabled for each listening opportunity.
    this.#microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.#setMicrophone(false);
    if (this.#ended) {
      this.#stopMicrophone();
      return;
    }
    const body: CascadeStartBody = {
      attemptId: this.#attemptId,
      profile: cascadeMediaConnectionProfile,
      connection: { exchangeId: this.#exchangeId, input: {} },
      selection: config.selection,
      agentInput,
      reasoningEffort: config.reasoningEffort,
    };
    if (this.#request.promptProvenance !== undefined)
      body.promptProvenance = this.#request.promptProvenance;
    if (config.cascadeSettings !== undefined) body.executionSettings = config.cascadeSettings;
    const response = await fetchImpl(new URL("/_api/runtime/runs", this.#options.labWorkerUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(startupBoundMs),
    });
    // Read before the Run is allocated, so its failed outcome can name the refusal.
    if (!response.ok) this.#startRefusal = await readStartRefusal(response);
    const runId = response.headers.get(LAB_RUN_ID_HEADER)?.trim() ?? "";
    const startedAt = Number(response.headers.get(LAB_RUN_STARTED_AT_HEADER));
    if (runId.length > 0 && Number.isSafeInteger(startedAt)) this.#allocate({ runId, startedAt });
    if (!response.ok || this.#identity === null)
      throw new Error(this.#startRefusal ?? `cascade_start_failed:${String(response.status)}`);
    if (this.handle.runId !== deriveLabAttemptRunId(this.#attemptId))
      throw new Error("lab_connection_identity_mismatch");
    const accepted = decodeCascadeMediaStartReply(await response.json());
    if (accepted.runId !== this.handle.runId || accepted.exchangeId !== this.#exchangeId)
      throw new Error("cascade_connection_reply_mismatch");
    const reply = accepted.reply;
    if (this.#ended) return;
    this.#playback = new CascadePlayback(reply.output);
    const microphone = this.#microphone;
    if (microphone === null) return;
    this.#capture = new CascadeCapture(microphone, reply.input, (opportunityId, audio) =>
      this.#socket?.send(JSON.stringify({ type: "input.audio", opportunityId, audio })),
    );
    this.#attachMedia();
    this.#observeEnding();
    this.#sendPresence();
    this.#presence = setInterval(() => this.#sendPresence(), 5_000);
    void this.#awaitStartup(this.#now() + startupBoundMs);
  }

  #allocate(identity: LabInterviewRunIdentity): void {
    if (this.#identity !== null) return;
    this.#identity = identity;
    this.#request.onRunAllocated?.(identity);
    this.#outcome = new Promise((resolve) => {
      this.#resolveOutcome = resolve;
    });
    void this.#pollOutcome();
  }

  #notify(status: LabInterviewStatus): void {
    const projected =
      this.#conversation === undefined ? status : { ...status, conversation: this.#conversation };
    this.#channel.notify(projected);
    this.#request.onStatus?.(projected);
  }

  #attachMedia(): void {
    const url = new URL(
      `/_api/runtime/runs/${encodeURIComponent(this.handle.runId)}/media`,
      this.#options.labWorkerUrl,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = (this.#options.openMediaSocket ?? ((target) => new WebSocket(target)))(
      url.toString(),
    );
    this.#socket = socket;
    socket.addEventListener("open", () => {
      // Readiness: the attachment is open and the output element is in place.
      void sendRuntimeMediaReady({
        endpointBaseUrl: this.#options.labWorkerUrl,
        runId: this.handle.runId,
        signal: this.#recovery.signal,
      }).catch(() => undefined);
    });
    socket.addEventListener("message", (event) => this.#receive(event));
    socket.addEventListener("close", () => {
      this.#socket = null;
      // The attachment dropped during the closing: nothing more can play there, so the page
      // leaves Live at once instead of waiting for Runtime's announcement.
      if (this.#closing) this.#beginEnding();
    });
  }

  #receive(event: MessageEvent): void {
    if (this.#leftLive || typeof event.data !== "string") return;
    let message;
    try {
      message = decodeCascadeMediaServerMessage(JSON.parse(event.data));
    } catch {
      return;
    }
    switch (message.type) {
      case "output.started":
        this.#closeListening();
        this.#lastOutputId = message.outputId;
        break;
      case "output.audio":
        this.#playback?.play(message.outputId, message.audio);
        break;
      case "output.ended":
        this.#playback?.end(message.outputId);
        void this.#awaitAnnouncement(message.outputId);
        break;
      case "output.cancelled":
      case "output.failed":
        this.#playback?.clear(message.outputId);
        break;
      case "input.listening":
        void this.#openListening(message.opportunityId, message.afterOutputId);
        break;
      case "input.closed":
        if (this.#opportunityId === message.opportunityId) this.#closeListening();
        break;
    }
  }

  /**
   * Listening opens once the server offered it and the preceding output finished playing
   * locally; a pause inside that output's audio does not open it.
   */
  async #openListening(opportunityId: string, afterOutputId: string | null): Promise<void> {
    this.#opportunityId = opportunityId;
    if (afterOutputId !== null) await this.#playback?.played(afterOutputId);
    if (this.#ended || this.#opportunityId !== opportunityId) return;
    this.#setMicrophone(true);
    this.#capture?.listen(opportunityId);
  }

  /** Closes listening: no audio is sent and the microphone track is disabled. */
  #closeListening(): void {
    this.#opportunityId = null;
    this.#capture?.listen(null);
    this.#setMicrophone(false);
  }

  #setMicrophone(enabled: boolean): void {
    for (const track of this.#microphone?.getAudioTracks() ?? []) track.enabled = enabled;
  }

  #observeEnding(): void {
    const config = this.#request.runtimeConfig;
    const url = new URL("/_api/runtime/events", this.#options.labWorkerUrl);
    url.searchParams.set("runId", this.handle.runId);
    // The stream outlasts interviewing, then Goodbye's own maximum or the finishing allowance.
    url.searchParams.set(
      "durationMs",
      String(
        config.maxDurationMs +
          25_000 +
          (this.#inputBuilder?.closingLimit === true
            ? (config.maximumClosingDurationMs ?? defaultClosingDurationMs)
            : 10_000),
      ),
    );
    const events = new EventSource(url);
    this.#events = events;
    // The page shows Runtime's accepted Conversation state. Once participation has finished,
    // as when Goodbye starts, the microphone stops: no participant input follows.
    events.addEventListener("runtime.conversation_state", (event) => {
      if (this.#ended || !(event instanceof MessageEvent) || typeof event.data !== "string") return;
      let accepted;
      try {
        accepted = decodeLabConversationState(JSON.parse(event.data));
      } catch {
        return;
      }
      this.#conversation = accepted;
      if (accepted.state === "goodbye" || accepted.state === "finishing") {
        this.#closing = true;
        this.#stopMicrophone();
      }
      const status = this.#channel.getStatus();
      if (status.phase === "live") this.#notify({ ...status, label: accepted.state });
    });
    events.addEventListener("runtime.ending", (event) => {
      if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
      try {
        decodeLabEndingEvent(JSON.parse(event.data));
      } catch {
        return;
      }
      this.#endAnnounced = true;
      // Runtime announces a normal end once the closing has had time to play, and every other
      // end at once: either way the page leaves Live now, and a page that already left, as at
      // End, closes the attachment it kept open for this announcement.
      this.#beginEnding();
      this.#closeMedia();
    });
    // Runtime ends the stream after the terminal record; it does not reconnect.
    events.addEventListener("error", () => events.close());
  }

  async #awaitStartup(deadlineAt: number): Promise<void> {
    while (!this.#ended && this.#now() < deadlineAt) {
      try {
        const response = await (this.#options.fetchImpl ?? fetch)(
          new URL(
            `/_api/runtime/runs/${encodeURIComponent(this.handle.runId)}/startup`,
            this.#options.labWorkerUrl,
          ),
          { signal: AbortSignal.any([this.#recovery.signal, AbortSignal.timeout(2_000)]) },
        );
        if (response.ok) {
          const startup = decodeLabStartupDisposition(await response.json());
          if (startup.disposition === "succeeded") {
            if (!this.#ended)
              this.#notify({ phase: "live", label: "Live", detail: "The Interview is live." });
            return;
          }
          if (startup.disposition === "failed") break;
        }
      } catch {
        /* A lost read retries within the original startup bound. */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (this.#ended) return;
    this.#beginEnding();
    void this.#requestEnd("runtime_failed");
  }

  async #pollOutcome(): Promise<void> {
    while (!this.#recovery.signal.aborted) {
      try {
        const detail = await readLabOutcome({
          endpointBaseUrl: this.#options.labWorkerUrl,
          runId: this.handle.runId,
          timeoutMs: 2_000,
          signal: this.#recovery.signal,
        });
        if (detail?.terminalResult !== undefined) {
          this.#finish(detail);
          return;
        }
      } catch {
        /* Reads may be lost; the Run is never replaced. */
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  #finish(detail: LabRunDetail): void {
    const terminal = detail.terminalResult;
    if (terminal === undefined || terminal.runId !== this.handle.runId) return;
    this.#recovery.abort();
    this.#release();
    this.#transcriptEvidence = {
      transcript: detail.transcript,
      turnCount: detail.transcriptTurnCount,
      capturedAt: terminal.endedAt,
    };
    const failed = terminal.outcome !== "completed";
    this.#result = {
      runId: this.handle.runId,
      endedAt: terminal.endedAt,
      endStatus: "ended",
      transcriptEvidence: this.#transcriptEvidence,
      terminalResult: terminal,
    };
    if (!failed) {
      this.#notify({
        phase: "ended",
        label: "Thank you",
        detail: "The Interview ended.",
        endStatus: "ended",
      });
    } else {
      const status: LabInterviewStatus = {
        phase: "failed",
        failureKind: terminal.outcome === "failed_to_start" ? "setup" : "runtime",
        label: "Interview Failed",
        detail: "The experiment records contain the authoritative Runtime outcome.",
      };
      if (this.#startRefusal !== undefined) status.startRefusal = this.#startRefusal;
      this.#notify(status);
    }
    this.#resolveOutcome?.(this.#result);
  }

  /**
   * An output's end arrived: once it has played locally and it is the closing, Runtime announces
   * the end within its margin. Should that announcement be lost, the page leaves Live after a
   * bound; it keeps the attachment open, since Runtime has not announced the end, until the
   * terminal result releases it.
   */
  async #awaitAnnouncement(outputId: string): Promise<void> {
    await this.#playback?.played(outputId);
    if (
      this.#leftLive ||
      !this.#closing ||
      this.#lastOutputId !== outputId ||
      this.#announcementBound !== null
    )
      return;
    this.#announcementBound = setTimeout(() => this.#beginEnding(), endingAnnouncementBoundMs);
  }

  /**
   * The single finished presentation: playback and the microphone stop at once and do not
   * resume. A local Stop while the closing plays ends it here too. The media attachment stays
   * open until Runtime announces the end, so the Stop that follows reaches Runtime while it is
   * open: Runtime treats an attachment that closes while the Run is Live as lost.
   */
  #beginEnding(): void {
    if (this.#leftLive) return;
    this.#ended = true;
    this.#leftLive = true;
    if (this.#announcementBound !== null) clearTimeout(this.#announcementBound);
    this.#stopMicrophone();
    this.#playback?.close();
    if (this.#endAnnounced) this.#closeMedia();
    this.#notify({
      phase: "ending",
      label: "Thank you",
      detail: "Your participation is finished.",
    });
  }

  #release(): void {
    this.#ended = true;
    this.#leftLive = true;
    if (this.#announcementBound !== null) clearTimeout(this.#announcementBound);
    this.#stopMicrophone();
    this.#playback?.close();
    this.#closeMedia();
    this.#events?.close();
    if (this.#presence !== null) clearInterval(this.#presence);
  }

  #closeMedia(): void {
    this.#socket?.close(1000, "participation_ended");
  }

  #stopMicrophone(): void {
    this.#opportunityId = null;
    this.#capture?.close();
    this.#capture = null;
    for (const track of this.#microphone?.getTracks() ?? []) track.stop();
    this.#microphone = null;
  }

  #sendPresence(): void {
    if (this.#ended || this.#identity === null) return;
    void sendRuntimePresence({
      endpointBaseUrl: this.#options.labWorkerUrl,
      runId: this.#identity.runId,
      mediaPresent: this.#socket !== null,
      timeoutMs: 3_000,
    }).catch(() => undefined);
  }

  async #requestEnd(endReason: LabRunEndReason): Promise<void> {
    // A Run this page has seen end needs no Stop, as when the page leaves it for the next Run.
    if (this.#identity === null || this.#requestedEnd !== null || this.#result !== null) return;
    this.#requestedEnd = endReason;
    const stopped = await requestRuntimeClose({
      endpointBaseUrl: this.#options.labWorkerUrl,
      runId: this.#identity.runId,
      timeoutMs: 4_000,
      endReason,
    });
    // A Stop that failed or was refused within its bound announces nothing: the attachment
    // closes now, and Runtime ends a Run still Live on the lost connection.
    if (!stopped.ok) this.#closeMedia();
  }

  async complete(endReason: LabRunEndReason): Promise<LabInterviewEndResult> {
    if (this.#result !== null) return this.#result;
    this.#beginEnding();
    void this.#requestEnd(endReason).catch(() => undefined);
    if (this.#outcome === null) throw new Error("lab_run_not_allocated");
    return this.#outcome;
  }

  async cancel(_reason?: string): Promise<void> {
    this.#beginEnding();
    void this.#requestEnd("participant_disconnected").catch(() => undefined);
  }
}
