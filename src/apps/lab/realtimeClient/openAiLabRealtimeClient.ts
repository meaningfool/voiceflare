import {
  BrowserConversationSession,
  type BrowserEndingStrategy,
} from "../../../browser/conversationSession";
import { readLabOutcome, type LabRunDetail, type LabRunEndReason } from "../data/labRunStore";
import {
  buildRuntimeEventsUrl,
  deriveLabAttemptRunId,
  RealtimeCallError,
  requestRuntimeClose,
  sendRuntimePresence,
  sendRuntimeMediaReady,
  signalRealtimeCall,
} from "./realtimeSignaling";
import type { LabRealtimeClient, LabRealtimeClientStartRequest } from "./labRealtimeClient";
import {
  createLabInterviewStatusChannel,
  type LabInterviewEndResult,
  type LabInterviewSession,
  type LabInterviewStatus,
  type LabInterviewRunIdentity,
  type LabInterviewTranscriptEvidence,
} from "../interviewClient";
import { z } from "zod";
import {
  findLabInterviewInputBuilder,
  type LabInterviewInputBuilder,
} from "../data/conversationPresets";
import { originalRealtimeSelection } from "../../../../worker/shared/contracts/conversationSelection.ts";
import { boundary, failure } from "../../../../tools/boundary-contracts/boundary-contracts.mjs";

/** How long a polled terminal result waits for the Run's queued events to reach the page. */
const runtimeEventDrainBoundMs = 2_000;

const labStartupDispositionSchema = z.strictObject({
  runId: z.string().min(1),
  disposition: z.enum(["pending", "succeeded", "failed"]),
  decidedAt: z.number().int().safe().nonnegative().nullable(),
  reason: z.string().nullable(),
  stopRequired: z.boolean(),
});
export const decodeLabStartupDisposition = boundary({
  schema: z
    .unknown()
    .refine(
      (value) =>
        value !== null &&
        typeof value === "object" &&
        labStartupDispositionSchema.keyof().options.every((key) => Object.hasOwn(value, key)),
    )
    .pipe(labStartupDispositionSchema),
  convert: (value) => value,
});
type ReadLabStartup = (options: {
  endpointBaseUrl: string;
  runId: string;
  signal: AbortSignal;
}) => Promise<ReturnType<typeof decodeLabStartupDisposition>>;
async function readLabStartupDefault(options: Parameters<ReadLabStartup>[0]) {
  const response = await fetch(
    new URL(
      `/_api/runtime/runs/${encodeURIComponent(options.runId)}/startup`,
      options.endpointBaseUrl,
    ),
    { credentials: "same-origin", signal: options.signal },
  );
  if (!response.ok) throw new Error("lab_startup_unavailable");
  return decodeLabStartupDisposition(await response.json());
}
export type OpenAiLabRealtimeClientOptions = {
  labWorkerUrl: string;
  sidebandEventsFactory?: (url: string) => {
    addEventListener: (type: string, listener: EventListener) => void;
    close: () => void;
  };
  signalRealtimeCall?: typeof signalRealtimeCall;
  requestRuntimeClose?: typeof requestRuntimeClose;
  sendRuntimePresence?: typeof sendRuntimePresence;
  sendRuntimeMediaReady?: typeof sendRuntimeMediaReady;
  readLabStartup?: ReadLabStartup;
  readLabOutcome?: typeof readLabOutcome;
  now?: () => number;
};

/** Lab retains transport and experiment identity. Common participation owns native resources. */
export function createOpenAiLabRealtimeClient(
  options: OpenAiLabRealtimeClientOptions,
): LabRealtimeClient {
  return {
    async start(request) {
      const attempt = new LabParticipation(options, request);
      await attempt.start();
      return attempt;
    },
  };
}
class LabParticipation implements LabInterviewSession {
  private identity: LabInterviewRunIdentity | null = null;
  private recoveryRunId: string | null = null;
  private startSubmitted = false;
  private readonly channel = createLabInterviewStatusChannel({
    phase: "setup",
    label: "Microphone Permission",
    detail: "Preparing the Interview connection.",
  });
  private readonly media: BrowserConversationSession;
  private readonly startup = new AbortController();
  private readonly recovery = new AbortController();
  private readonly startupDeadline: number;
  private readonly outcomeDeadline: number;
  /** The selected Conversation's input builder, found once; Original when none is selected. */
  private readonly inputBuilder: LabInterviewInputBuilder | undefined;
  private readonly attemptId = crypto.randomUUID();
  private readonly exchangeId = crypto.randomUUID();
  private readonly now: () => number;
  private readonly options: OpenAiLabRealtimeClientOptions;
  private readonly request: LabRealtimeClientStartRequest;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private startupBound: ReturnType<typeof setTimeout> | null = null;
  private outcomeTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private closeRuntimeEvents: (() => void) | null = null;
  private runtimeEventsDraining = false;
  private runtimeEventsCompleted = false;
  private acceptedConversation: Readonly<{ state: string; deadlineAt: number | null }> | undefined;
  private result: LabInterviewEndResult | null = null;
  private pendingTerminal: LabRunDetail | null = null;
  private outcomePromise: Promise<LabInterviewEndResult> | null = null;
  private resolveOutcome: ((result: LabInterviewEndResult) => void) | null = null;
  private rejectOutcome: ((error: Error) => void) | null = null;
  private ending: BrowserEndingStrategy | null = null;
  private microphoneStoppedAt: number | null = null;
  private goodbyeCaptureStopped = false;
  private requestedEndReason: LabRunEndReason | null = null;
  private transcriptEvidence: LabInterviewTranscriptEvidence = {
    transcript: { turns: [] },
    turnCount: 0,
  };
  constructor(options: OpenAiLabRealtimeClientOptions, request: LabRealtimeClientStartRequest) {
    this.options = options;
    this.request = { ...request, runtimeConfig: { ...request.runtimeConfig } };
    if (request.runtimeConfig.realtimeSettings !== undefined)
      this.request.runtimeConfig.realtimeSettings = { ...request.runtimeConfig.realtimeSettings };
    if (request.promptProvenance !== undefined)
      this.request.promptProvenance = { ...request.promptProvenance };
    this.now = options.now ?? Date.now;
    this.startupDeadline = this.now() + 35_000;
    this.inputBuilder = findLabInterviewInputBuilder(
      request.runtimeConfig.selection ?? originalRealtimeSelection,
    );
    this.outcomeDeadline =
      this.now() +
      request.runtimeConfig.maxDurationMs +
      60_000 +
      (this.inputBuilder?.closingLimit === true
        ? (request.runtimeConfig.maximumClosingDurationMs ?? 45_000)
        : 10_000);
    this.media = new BrowserConversationSession({
      onReady: () => {
        this.notify({
          phase: "live",
          label: "Live",
          detail: "The live Interview runtime is connected.",
        });
      },
      onPlaybackSettled: () => this.media.dispose(),
      onDisposed: () => {
        this.microphoneStoppedAt ??= this.now();
        this.stopParticipation();
        if (this.pendingTerminal !== null) this.finish(this.pendingTerminal);
      },
    });
    request.signal?.addEventListener(
      "abort",
      () => {
        this.media.dispose();
        if (this.recoveryRunId !== null)
          void this.requestEnd(this.failureEndReason()).catch(() => undefined);
      },
      { once: true },
    );
    if (request.signal?.aborted) this.media.dispose();
    if (!this.media.disposed)
      this.startupBound = setTimeout(() => {
        if (this.media.liveReady || this.ending !== null) return;
        this.media.dispose();
        if (this.recoveryRunId !== null) {
          this.unresolved(
            "Application startup was not confirmed; the experiment outcome is still being resolved.",
          );
          void this.requestEnd("runtime_failed").catch(() => undefined);
        }
      }, 35_000);
  }
  get handle(): LabInterviewRunIdentity {
    if (this.identity === null) throw new Error("lab_run_not_allocated");
    return this.identity;
  }
  getStatus(): LabInterviewStatus {
    return this.channel.getStatus();
  }
  subscribe(listener: (status: LabInterviewStatus) => void): () => void {
    return this.channel.subscribe(listener);
  }
  getTranscriptEvidence(): LabInterviewTranscriptEvidence {
    return this.transcriptEvidence;
  }
  private notify(status: LabInterviewStatus): void {
    const projected =
      this.acceptedConversation === undefined
        ? status
        : { ...status, conversation: this.acceptedConversation };
    this.channel.notify(projected);
    this.request.onStatus?.(projected);
  }
  async start(): Promise<void> {
    const config = structuredClone(this.request.runtimeConfig);
    if (!Number.isSafeInteger(config.maxDurationMs) || config.maxDurationMs <= 0) {
      this.media.dispose();
      throw new Error("invalid_lab_duration");
    }
    try {
      if (this.inputBuilder === undefined) throw new Error("conversation_selection_unavailable");
      // Incomplete input is refused here, before media preparation requests the microphone.
      const agentInput = this.inputBuilder.build(config);
      const native = await this.media.prepare();
      if (this.media.disposed) throw new DOMException("Participation disposed", "AbortError");
      const signalInput = {
        endpointBaseUrl: this.options.labWorkerUrl,
        offerSdp: native.offerSdp,
        attemptId: this.attemptId,
        exchangeId: this.exchangeId,
        deadlineAt: this.startupDeadline,
        signal: this.media.signal,
        onRunAllocated: (identity: LabInterviewRunIdentity) => this.allocate(identity),
        agentInput,
        selection: config.selection,
        reasoningEffort: config.reasoningEffort,
        promptProvenance: this.request.promptProvenance ?? null,
        executionSettings: config.realtimeSettings,
      };
      let answer;
      this.startSubmitted = true;
      for (;;) {
        try {
          answer = await (this.options.signalRealtimeCall ?? signalRealtimeCall)(signalInput);
          break;
        } catch (error) {
          if (error instanceof RealtimeCallError && error.runIdentity !== null)
            this.allocate(error.runIdentity);
          if (
            this.media.disposed ||
            this.now() >= this.startupDeadline ||
            !(error instanceof TypeError)
          )
            throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
        }
      }
      this.allocate(answer.runIdentity);
      if (this.media.disposed) return;
      this.media.setMediaReadyTransport((signal) =>
        (this.options.sendRuntimeMediaReady ?? sendRuntimeMediaReady)({
          endpointBaseUrl: this.options.labWorkerUrl,
          runId: this.handle.runId,
          signal,
        }),
      );
      await this.media.applyAnswer(answer.answerSdp);
      this.observe(answer.sessionId);
      void this.pollStartup();
    } catch (error) {
      if (error instanceof RealtimeCallError && error.runIdentity !== null)
        this.allocate(error.runIdentity);
      this.media.dispose();
      if (
        this.identity === null &&
        error instanceof RealtimeCallError &&
        (error.code === "invalid_run_start_request" ||
          error.code === "invalid_prompt_provenance" ||
          error.code === "missing_lab_database")
      )
        throw error;
      if (this.identity === null && this.startSubmitted) {
        this.beginRecovery(deriveLabAttemptRunId(this.attemptId));
        this.unresolved(
          "Local participation stopped; the experiment outcome is still being resolved.",
        );
        void this.requestEnd(this.failureEndReason()).catch(() => undefined);
        await this.outcomePromise;
        return;
      }
      if (this.identity !== null) {
        this.unresolved(
          "Local participation stopped; the experiment outcome is still being resolved.",
        );
        void this.requestEnd(this.failureEndReason()).catch(() => undefined);
        return;
      }
      throw error;
    }
  }
  private allocate(identity: LabInterviewRunIdentity): void {
    if (this.identity !== null) {
      if (this.identity.runId !== identity.runId || this.identity.startedAt !== identity.startedAt)
        throw new Error("lab_attempt_identity_mismatch");
      return;
    }
    this.identity = identity;
    this.request.onRunAllocated?.(identity);
    this.beginRecovery(identity.runId);
  }
  private beginRecovery(runId: string): void {
    if (this.recoveryRunId !== null) {
      if (this.recoveryRunId !== runId) throw new Error("lab_attempt_identity_mismatch");
      return;
    }
    this.recoveryRunId = runId;
    this.outcomePromise = new Promise((resolve, reject) => {
      this.resolveOutcome = resolve;
      this.rejectOutcome = reject;
    });
    void this.outcomePromise.catch(() => undefined);
    // Recovery belongs to the application and survives disposal of participation.
    this.recoveryTimer = setTimeout(
      () => {
        this.recovery.abort();
        if (this.outcomeTimer !== null) clearTimeout(this.outcomeTimer);
        this.media.dispose();
        this.notify({
          phase: "failed",
          failureKind: "runtime",
          label: "Outcome Unresolved",
          detail: "The experiment outcome could not be confirmed within its recovery bound.",
        });
        this.rejectOutcome?.(new Error("lab_outcome_unresolved"));
      },
      Math.max(0, this.outcomeDeadline - this.now()),
    );
    void this.pollOutcome();
  }
  private unresolved(detail: string): void {
    this.notify({ phase: "ending", label: "Resolving Interview", detail });
  }
  private async pollStartup(): Promise<void> {
    if (this.startup.signal.aborted || this.media.disposed) return;
    const remaining = this.startupDeadline - this.now();
    if (remaining <= 0) {
      this.media.dispose();
      void this.requestEnd("runtime_failed").catch(() => undefined);
      this.unresolved(
        "Application startup was not confirmed; the experiment outcome is still being resolved.",
      );
      return;
    }
    try {
      const verdict = await (this.options.readLabStartup ?? readLabStartupDefault)({
        endpointBaseUrl: this.options.labWorkerUrl,
        runId: this.handle.runId,
        signal: AbortSignal.any([
          this.startup.signal,
          AbortSignal.timeout(Math.min(2_000, remaining)),
        ]),
      });
      if (this.startup.signal.aborted || this.media.disposed) return;
      if (verdict.runId !== this.handle.runId) throw new Error("lab_startup_identity_mismatch");
      this.media.setStartupDisposition(verdict.disposition);
      if (verdict.disposition === "succeeded" && this.media.liveReady) return;
      if (verdict.disposition === "failed") {
        this.unresolved(
          "Application startup failed; the experiment outcome is still being resolved.",
        );
        if (verdict.stopRequired) void this.requestEnd("runtime_failed").catch(() => undefined);
        return;
      }
    } catch {
      /* Lost reads retry only the original attempt and deadline. */
    }
    if (!this.media.disposed && !this.startup.signal.aborted)
      this.startupTimer = setTimeout(() => void this.pollStartup(), 500);
  }
  private async pollOutcome(): Promise<void> {
    if (this.recovery.signal.aborted || this.recoveryRunId === null) return;
    try {
      const detail = await (this.options.readLabOutcome ?? readLabOutcome)({
        endpointBaseUrl: this.options.labWorkerUrl,
        runId: this.recoveryRunId,
        timeoutMs: 2_000,
        signal: this.recovery.signal,
      });
      if (this.recovery.signal.aborted) return;
      if (detail !== null && this.identity === null && detail.runId === this.recoveryRunId) {
        this.allocate({ runId: detail.runId, startedAt: detail.startedAt });
      }
      if (
        detail !== null &&
        (detail.runId !== this.handle.runId || detail.startedAt !== this.handle.startedAt)
      )
        throw new Error("lab_outcome_identity_mismatch");
      if (detail?.terminalResult !== undefined) {
        this.finish(detail);
        return;
      }
    } catch {
      /* Delivery and reads may lose acknowledgement; never replace the Run. */
    }
    if (!this.recovery.signal.aborted)
      this.outcomeTimer = setTimeout(() => void this.pollOutcome(), 500);
  }
  private finish(detail: LabRunDetail): void {
    const terminal = detail.terminalResult;
    if (terminal === undefined || terminal.runId !== this.handle.runId)
      throw new Error("lab_terminal_identity_mismatch");
    this.recovery.abort();
    if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);
    this.pendingTerminal = null;
    // Polling can learn the result while the stream still queues this Run's earlier events, such
    // as Goodbye's playback stop. Media stops now; the stream stays open until it delivers the
    // Run's completion event, ends, or the bound passes.
    if (this.closeRuntimeEvents !== null && !this.runtimeEventsCompleted) {
      this.runtimeEventsDraining = true;
      setTimeout(() => this.closeRuntimeEvents?.(), runtimeEventDrainBoundMs);
    }
    this.media.dispose();
    this.transcriptEvidence = {
      transcript: detail.transcript,
      turnCount: detail.transcriptTurnCount,
      capturedAt: terminal.endedAt,
    };
    const failed = terminal.outcome !== "completed";
    const warning =
      terminal.outcome !== "failed_to_start" && terminal.transcriptCompleteness !== "complete";
    const endStatus = warning ? "endedWithWarning" : "ended";
    if (warning)
      this.transcriptEvidence.warning = {
        reviewStatus: "warning",
        summary: "Transcript may be incomplete or degraded.",
      };
    this.result = {
      runId: this.handle.runId,
      endedAt: terminal.endedAt,
      endStatus,
      transcriptEvidence: this.transcriptEvidence,
      terminalResult: terminal,
    };
    if (failed)
      this.notify({
        phase: "failed",
        failureKind: terminal.outcome === "failed_to_start" ? "setup" : "runtime",
        label: "Interview Failed",
        detail: "The experiment records contain the authoritative Runtime outcome.",
      });
    else {
      const status: LabInterviewStatus = {
        phase: "ended",
        label: "Thank you",
        detail: warning
          ? "The Interview ended, but the Transcript may be incomplete or degraded."
          : "The Interview ended and Transcript evidence is ready.",
        endStatus,
      };
      if (this.transcriptEvidence.warning !== undefined)
        status.transcriptWarning = this.transcriptEvidence.warning;
      this.notify(status);
    }
    this.resolveOutcome?.(this.result);
  }
  private observe(sessionId: string): void {
    if (this.media.disposed) return;
    const source = (this.options.sidebandEventsFactory ?? ((url) => new EventSource(url)))(
      buildRuntimeEventsUrl(
        this.options.labWorkerUrl,
        this.handle.runId,
        sessionId,
        this.request.runtimeConfig.maxDurationMs +
          25_000 +
          (this.inputBuilder?.closingLimit === true
            ? (this.request.runtimeConfig.maximumClosingDurationMs ?? 45_000)
            : 10_000),
      ),
    );
    this.closeRuntimeEvents = () => {
      this.closeRuntimeEvents = null;
      source.close();
    };
    this.media.retainObservation(() => {
      if (!this.runtimeEventsDraining) this.closeRuntimeEvents?.();
    });
    // The stream belongs to this Run, so its completion event follows every earlier event.
    source.addEventListener("runtime.controller_completed", () => {
      this.runtimeEventsCompleted = true;
      if (this.runtimeEventsDraining) this.closeRuntimeEvents?.();
    });
    // Runtime ends the stream after the terminal record; do not let EventSource reconnect.
    source.addEventListener("error", () => {
      if (this.runtimeEventsDraining) this.closeRuntimeEvents?.();
    });
    source.addEventListener("session.provider_event", (event) => {
      this.media.observeOpenAiEvent(readPlaybackEvent(event));
    });
    source.addEventListener("runtime.conversation_state", (event) => {
      if (this.media.disposed || this.ending !== null || !(event instanceof MessageEvent)) return;
      try {
        if (typeof event.data !== "string") return;
        const accepted = decodeLabConversationState(JSON.parse(event.data));
        this.acceptedConversation = accepted;
        if (accepted.state === "goodbye" || accepted.state === "finishing") {
          this.microphoneStoppedAt ??= this.now();
          this.goodbyeCaptureStopped = true;
          this.media.stopMicrophone();
        }
        const status = this.channel.getStatus();
        if (status.phase === "live") this.notify({ ...status, label: accepted.state });
      } catch {
        /* Invalid state facts cannot grant media permission. */
      }
    });
    for (const type of ["runtime.ending", "runtime.controller_close_requested"])
      source.addEventListener(type, (event) => {
        if (this.media.disposed || this.result !== null) return;
        const ending = readEndingEvent(event);
        if (ending === null) return;
        this.beginEnding(ending.strategy ?? "hard_stop");
      });
    this.sendPresence();
    this.presenceTimer = setInterval(() => this.sendPresence(), 5_000);
  }
  private sendPresence(): void {
    if (this.media.disposed) return;
    void (this.options.sendRuntimePresence ?? sendRuntimePresence)({
      endpointBaseUrl: this.options.labWorkerUrl,
      runId: this.handle.runId,
      mediaPresent: this.goodbyeCaptureStopped ? this.media.liveReady : this.media.mediaPresent,
      timeoutMs: 3_000,
    }).catch(() => undefined);
  }
  private stopParticipation(): void {
    this.startup.abort();
    if (this.startupBound !== null) clearTimeout(this.startupBound);
    if (this.startupTimer !== null) clearTimeout(this.startupTimer);
    if (this.presenceTimer !== null) clearInterval(this.presenceTimer);
  }
  private beginEnding(strategy: BrowserEndingStrategy): void {
    if (this.ending === "hard_stop") return;
    this.microphoneStoppedAt ??= this.now();
    this.ending = "hard_stop";
    const live = this.media.liveReady;
    this.media.beginEnding(strategy);
    this.notify({
      phase: "ending",
      label: "Thank you",
      detail: "Your participation has finished.",
    });
    // Ending from Live stops capture and playback only. The provider call and Runtime events stay
    // open so final input can settle; the terminal result or the bounded cleanup releases them.
    // Ending before Live has no input to settle and stops startup at once.
    if (live) this.stopParticipation();
    else this.media.dispose();
    if (this.pendingTerminal !== null) this.finish(this.pendingTerminal);
  }
  private async requestEnd(endReason: LabRunEndReason): Promise<void> {
    // A Run this page has seen end needs no Stop, as when the page leaves it for the next Run.
    if (this.recoveryRunId === null || this.result !== null) return;
    if (this.requestedEndReason === endReason) return;
    this.requestedEndReason = endReason;
    await (this.options.requestRuntimeClose ?? requestRuntimeClose)({
      endpointBaseUrl: this.options.labWorkerUrl,
      runId: this.recoveryRunId,
      timeoutMs: 4_000,
      endReason,
      microphoneStoppedAt: this.microphoneStoppedAt ?? this.now(),
    });
  }
  private failureEndReason(): LabRunEndReason {
    if (this.request.signal?.reason === "participant_stopped") return "participant_stopped";
    return this.request.signal?.aborted ? "participant_disconnected" : "runtime_failed";
  }
  async complete(endReason: LabRunEndReason): Promise<LabInterviewEndResult> {
    if (this.result !== null) return this.result;
    const override =
      endReason === "participant_stopped" && this.ending === "graceful_agent_completion";
    if (this.ending === null || override) {
      this.beginEnding("hard_stop");
      void this.requestEnd(endReason).catch(() => undefined);
    }
    if (this.outcomePromise === null) throw new Error("lab_run_not_allocated");
    return this.outcomePromise;
  }
  async cancel(_reason?: string): Promise<void> {
    this.media.dispose();
    if (this.identity !== null && this.result === null) {
      this.unresolved(
        "Local participation stopped; the experiment outcome is still being resolved.",
      );
      void this.requestEnd("participant_disconnected").catch(() => undefined);
    }
  }
}
const endingEventSchema = z.object({
  endReason: z.enum([
    "participant_stopped",
    "timebox_reached",
    "agent_requested_end",
    "participant_disconnected",
    "runtime_failed",
  ]),
  strategy: z.enum(["hard_stop", "graceful_agent_completion"]).optional(),
});
const openAiEventSchema = z.object({ type: z.string() });
export const decodeLabEndingEvent = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value))),
    endingEventSchema,
  ),
  convert: (value) => value,
});
// OpenAI adds event fields independently; Lab consumes only the validated native event name.
export const decodeLabPlaybackEvent = boundary.tolerant({
  source: "OpenAI Realtime events forwarded by Lab sideband",
  variants: [
    {
      schema: z.preprocess(
        (value) => z.json().parse(JSON.parse(JSON.stringify(value))),
        openAiEventSchema,
      ),
      convert: (value) => value.type,
    },
  ],
  otherwise: failure("unrecognized_playback_event"),
});
function readPlaybackEvent(event: Event): string | null {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") return null;
  try {
    const result = decodeLabPlaybackEvent(JSON.parse(event.data));
    return result.ok ? result.value : null;
  } catch {
    return null;
  }
}
function readEndingEvent(event: Event): ReturnType<typeof decodeLabEndingEvent> | null {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") return null;
  try {
    return decodeLabEndingEvent(JSON.parse(event.data));
  } catch {
    return null;
  }
}

export const decodeLabConversationState = boundary({
  schema: z.preprocess(
    (value) => z.json().parse(JSON.parse(JSON.stringify(value))),
    z.object({
      state: z.string().min(1),
      deadlineAt: z.number().int().safe().nonnegative().nullable(),
    }),
  ),
  convert: (value) => value,
});
