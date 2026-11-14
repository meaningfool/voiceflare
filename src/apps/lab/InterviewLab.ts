import {
  defaultFinishInterviewDescription,
  defaultClosingSentence,
  questionPromptPresets,
  nextQuestionDescription,
} from "./content/presets";
import {
  canStartLabConversation,
  type LabConversationOption,
  type LabConversationStore,
} from "./data/conversationCatalog";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { createInterviewPromptProvenance } from "./data/interviewPrompt";

import type {
  LabInterviewConfig,
  LabInterviewSession,
  LabInterviewStartRequest,
  LabInterviewStatus,
} from "./interviewClient";
import type { LabRealtimeClient } from "./realtimeClient/labRealtimeClient";
import type { LabCascadeClient } from "./cascadeClient/labCascadeClient";
import type { LabRunDetail, LabRunListItem, LabRunStore } from "./data/labRunStore";
import { RUNTIME_WORKER_UNAVAILABLE_MESSAGE } from "./realtimeClient/realtimeSignaling";
import type { LabPromptOption, LabPromptStore } from "./labPrompts";
import { InterviewLabShell } from "./InterviewLabShell";
import { LiveInterviewSurface, type LabMaxDurationPreset } from "./LiveInterviewSurface";
import {
  defaultLabConversationEditor,
  findLabConversationEditor,
  isLabConversationComplete,
  type LabConversationEditor,
  type LabConversationFields,
  type LiveInterviewPromptState,
} from "./conversationEditors";
import {
  applyRealtimeSettingsChange,
  cascadeExecutionPanel,
  createRealtimeRunSettings,
  realtimeExecutionPanel,
  realtimeSettingsReady,
  type LabExecutionPanel,
  type RealtimeRunSettings,
  type RealtimeSettingsChange,
} from "./executionPanels";
import { TranscriptReviewSurface } from "./TranscriptReviewSurface";
import { cascadeMediaConnectionProfile } from "../../../worker/shared/contracts/cascadeMedia.ts";
import { isMissingCredentialsRefusal } from "../../../worker/shared/contracts/conversationSelection.ts";
import type {
  LabCascadeProviderOptions,
  LabCascadeProviderOptionsStore,
} from "./data/cascadeProviderOptions";
import {
  applyLabCascadeChange,
  createLabCascadeChoices,
  labCascadeExecutionSettings,
  type LabCascadeChange,
  type LabCascadeChoices,
} from "./cascadeClient/labCascadeSettings";

export type InterviewLabSurface = "liveInterview" | "transcripts";

type Surface = InterviewLabSurface;
type SetupFailureInput = Error | string | undefined;
type RuntimeFailureRecorder = {
  current: (() => Promise<void>) | null;
};

type AppState = {
  activeSurface: Surface;
  interviews: LabRunListItem[];
  selectedInterview: LabRunDetail | null;
  selectedInterviewId: string | null;
  isLoadingList: boolean;
  isLoadingInterview: boolean;
  liveRuntimeStatus: LabInterviewStatus;
  liveInterviewId: string | null;
  livePromptOptions: readonly LabPromptOption[];
  selectedPromptId: string | null;
  selectedMaxDurationMs: number;
  /** The Realtime panel's values; Cascade starts take its reasoning effort too, as before. */
  realtime: RealtimeRunSettings;
  /** The Cascade providers Cascade declares, loaded once the catalog offers a Cascade entry. */
  cascadeOptions: LabCascadeProviderOptions | null;
  cascadeOptionsError: string | null;
  /** The Cascade panel's values, today's providers once the providers load. */
  cascade: LabCascadeChoices | null;
  livePrompt: LiveInterviewPromptState;
  conversationOptions: readonly LabConversationOption[];
  selectedConversationId: string | null;
  conversationError: string | null;
  finishInterviewDescription: string;
  questionPrompts: readonly string[];
  nextQuestionDescription: string;
  closingSentence: string;
  maximumClosingDurationMs: number;
  conversationDrafts: Record<
    string,
    {
      livePrompt: LiveInterviewPromptState;
      finishInterviewDescription: string;
      closingSentence: string;
    }
  >;
  errorText: string | null;
};

export type InterviewLabDependencies = {
  appRoot: HTMLElement;
  labRunStore: LabRunStore | null;
  runtimeDiagnosticsStore?: unknown;
  labRealtimeClient: LabRealtimeClient | null;
  /** The Cascade client, which a Cascade selection's connection profile opens. */
  labCascadeClient?: LabCascadeClient | null;
  liveInterviewPrompts?: readonly LabPromptOption[];
  labPromptStore?: LabPromptStore | null;
  labConversationStore?: LabConversationStore | null;
  /** Lab Worker's list of the providers Cascade declares, which the Cascade panel offers. */
  labCascadeProviderOptionsStore?: LabCascadeProviderOptionsStore | null;
};

let appRoot: HTMLElement | null = null;
let labRunStore: LabRunStore | null = null;
let labPromptStore: LabPromptStore | null = null;
let labRealtimeClient: LabRealtimeClient | null = null;
let labCascadeClient: LabCascadeClient | null = null;
let labCascadeProviderOptionsStore: LabCascadeProviderOptionsStore | null = null;
let liveRuntimeSession: LabInterviewSession | null = null;
let liveStartController: AbortController | null = null;
let liveStartGeneration = 0;
let reactRoot: Root | null = null;
let transcriptListReadGeneration = 0;
let transcriptDetailReadGeneration = 0;

const labMaxDurationPresets = [
  { label: "1 minute", value: 1 * 60 * 1000 },
  { label: "3 minutes", value: 3 * 60 * 1000 },
  { label: "5 minutes", value: 5 * 60 * 1000 },
  { label: "8 minutes", value: 8 * 60 * 1000 },
  { label: "15 minutes", value: 15 * 60 * 1000 },
] as const satisfies readonly LabMaxDurationPreset[];
const defaultLabMaxDurationMs = 5 * 60 * 1000;

const state: AppState = createInitialAppState();

export function mountInterviewLab(dependencies: InterviewLabDependencies): void {
  liveStartGeneration += 1;
  liveStartController?.abort();
  liveStartController = null;
  void liveRuntimeSession?.cancel("Lab view replaced.");
  transcriptListReadGeneration += 1;
  transcriptDetailReadGeneration += 1;
  if (reactRoot !== null) {
    reactRoot.unmount();
  }

  appRoot = dependencies.appRoot;
  reactRoot = createRoot(appRoot);
  labRunStore = dependencies.labRunStore;
  labPromptStore = dependencies.labPromptStore ?? null;
  labRealtimeClient = dependencies.labRealtimeClient;
  labCascadeClient = dependencies.labCascadeClient ?? null;
  labCascadeProviderOptionsStore = dependencies.labCascadeProviderOptionsStore ?? null;
  liveRuntimeSession = null;
  Object.assign(state, createInitialAppState(dependencies.liveInterviewPrompts ?? []));
  render();
  if (dependencies.labConversationStore !== undefined)
    void loadConversations(dependencies.labConversationStore);
  void loadLabRuns();
  if (dependencies.labPromptStore !== undefined) {
    void loadLabPrompts(dependencies.labPromptStore);
  }
}

async function loadLabPrompts(store: LabPromptStore | null): Promise<void> {
  if (store === null) {
    setState({
      livePrompt: {
        status: "unavailable",
        message: "Set VITE_LAB_WORKER_URL before loading prompts.",
      },
    });
    return;
  }

  try {
    const prompts = await store.listLabPrompts();
    const selectedPrompt = prompts[0] ?? null;
    setState({
      livePromptOptions: prompts,
      selectedPromptId: selectedPrompt?.id ?? null,
      livePrompt: keepsPresetInstructions()
        ? state.livePrompt
        : createLivePromptState(selectedPrompt),
    });
  } catch {
    if (keepsPresetInstructions()) return;
    setState({
      livePrompt: {
        status: "unavailable",
        message: "Could not load Lab prompts. Refresh to retry.",
      },
    });
  }
}

function setState(nextState: Partial<AppState>): void {
  Object.assign(state, nextState);
  render();
}

function getSelectedLivePromptOption(): LabPromptOption | null {
  return state.livePromptOptions.find((option) => option.id === state.selectedPromptId) ?? null;
}

function areRunSettingsDisabled(): boolean {
  return (
    isRuntimeStarting(state.liveRuntimeStatus) ||
    state.liveRuntimeStatus.phase === "live" ||
    state.liveRuntimeStatus.phase === "ending"
  );
}

function createInitialAppState(livePromptOptions: readonly LabPromptOption[] = []): AppState {
  const selectedPrompt = livePromptOptions[0] ?? null;

  return {
    activeSurface: "liveInterview",
    interviews: [],
    selectedInterview: null,
    selectedInterviewId: null,
    isLoadingList: false,
    isLoadingInterview: false,
    liveRuntimeStatus: createReadyRuntimeStatus(),
    liveInterviewId: null,
    livePromptOptions,
    selectedPromptId: selectedPrompt?.id ?? null,
    selectedMaxDurationMs: defaultLabMaxDurationMs,
    realtime: createRealtimeRunSettings(),
    cascadeOptions: null,
    cascadeOptionsError: null,
    cascade: null,
    livePrompt: createLivePromptState(selectedPrompt),
    conversationOptions: [],
    selectedConversationId: null,
    conversationError: null,
    finishInterviewDescription: defaultFinishInterviewDescription,
    questionPrompts: [...questionPromptPresets],
    nextQuestionDescription,
    closingSentence: defaultClosingSentence,
    maximumClosingDurationMs: 45_000,
    conversationDrafts: {},
    errorText: null,
  };
}

function createLivePromptState(promptOption: LabPromptOption | null): LiveInterviewPromptState {
  const prompt = promptOption?.content ?? "";

  if (promptOption === null) {
    return {
      status: "unavailable",
      message: "No Lab prompts are available.",
    };
  }

  return {
    status: "ready",
    prompt,
  };
}

function createReadyRuntimeStatus(): LabInterviewStatus {
  return {
    phase: "setup",
    label: "Ready",
    detail: "Start a local Interview when you are ready.",
  };
}

function createSetupFailedRuntimeStatus(error?: SetupFailureInput): LabInterviewStatus {
  const status: LabInterviewStatus = {
    phase: "failed",
    label: "Could Not Start Interview",
    detail: getSetupFailureDetail(error),
    failureKind: "setup",
  };
  const message = error instanceof Error ? error.message : error;
  if (message !== undefined && isMissingCredentialsRefusal(message)) status.startRefusal = message;
  return status;
}

function getSetupFailureDetail(error?: SetupFailureInput): string {
  return isRuntimeWorkerUnavailableText(error)
    ? RUNTIME_WORKER_UNAVAILABLE_MESSAGE
    : "The Interview did not reach a usable live state. Runtime diagnostics are available outside normal Lab review.";
}

/** The page's account of a Start Runtime refused because it lacks a chosen provider's key. */
function describeStartRefusal(refusal: string): string {
  const names = refusal.slice("missing_credentials:".length).split(",").join(", ");
  return `Runtime refused the Start (${refusal}): it lacks ${names}, which the chosen providers need.`;
}

function getFailedRuntimeStatusDetail(status: LabInterviewStatus): string {
  if (status.phase !== "failed") {
    return status.detail;
  }

  if (status.startRefusal !== undefined) return describeStartRefusal(status.startRefusal);

  return status.failureKind === "setup" &&
    (isRuntimeWorkerUnavailableText(status.errorText) ||
      isRuntimeWorkerUnavailableText(status.detail))
    ? RUNTIME_WORKER_UNAVAILABLE_MESSAGE
    : "The Interview did not reach the expected state. Runtime diagnostics are available outside normal Lab review.";
}

function isRuntimeWorkerUnavailableText(value: Error | string | undefined): boolean {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  return text.includes(RUNTIME_WORKER_UNAVAILABLE_MESSAGE);
}

function isRuntimeStarting(status: LabInterviewStatus): boolean {
  return status.phase === "setup" && status.label !== "Ready";
}

function getRuntimeStatusClass(status: LabInterviewStatus): string {
  switch (status.phase) {
    case "setup":
      if (status.label === "Ready") return "ready";
      if (status.label === "Microphone Ready") return "microphoneReady";
      return "openingRealtimeCall";
    case "live":
      return "live";
    case "ending":
      return "openingSideband";
    case "ended":
      return status.endStatus === "endedWithWarning" ? "completedWithWarning" : "microphoneReady";
    case "failed":
      return status.failureKind === "ending" ? "completionFailed" : "setupFailed";
  }
}

function selectLivePrompt(promptId: string): void {
  const promptOption = state.livePromptOptions.find((option) => option.id === promptId) ?? null;
  setState({
    selectedPromptId: promptOption?.id ?? null,
    livePrompt: createLivePromptState(promptOption),
  });
}

async function saveLivePrompt(choice: "replace" | "new", name?: string): Promise<string | null> {
  const selected = getSelectedLivePromptOption();
  if (labPromptStore === null || selected === null || state.livePrompt.status !== "ready")
    return "Prompt storage is unavailable.";
  const content = state.livePrompt.prompt;
  try {
    const saved =
      choice === "replace"
        ? await labPromptStore.updateLabPrompt(selected.id, content)
        : await labPromptStore.createLabPrompt(name ?? "", content);
    const options =
      choice === "replace"
        ? state.livePromptOptions.map((option) => (option.id === saved.id ? saved : option))
        : [...state.livePromptOptions, saved].sort((a, b) => a.fileName.localeCompare(b.fileName));
    setState({
      livePromptOptions: options,
      selectedPromptId: saved.id,
      livePrompt: { status: "ready", prompt: content },
    });
    return null;
  } catch (error) {
    if (error instanceof Error && error.message === "lab_prompt_name_taken")
      return "A saved prompt with that name already exists.";
    if (error instanceof Error && error.message === "invalid_lab_prompt_name")
      return "Use a name without slashes, up to 120 characters.";
    return "Could not save the prompt. Try again.";
  }
}

function selectMaxDurationMs(value: number): void {
  const duration = labMaxDurationPresets.find((preset) => preset.value === value);

  if (duration === undefined) {
    return;
  }

  setState({
    selectedMaxDurationMs: duration.value,
  });
}

function changeRealtimeSettings(change: RealtimeSettingsChange): void {
  setState({ realtime: applyRealtimeSettingsChange(state.realtime, change) });
}

function changeCascadeSettings(change: LabCascadeChange): void {
  if (state.cascadeOptions === null || state.cascade === null) return;
  setState({ cascade: applyLabCascadeChange(state.cascadeOptions, state.cascade, change) });
}

function selectedOption(): LabConversationOption | undefined {
  return state.conversationOptions.find((option) => option.id === state.selectedConversationId);
}

/** Whether an entry is selected and Runtime reports it can start. */
function selectedCanStart(): boolean {
  const option = selectedOption();
  return option !== undefined && canStartLabConversation(option);
}

/** The selected Conversation's editor; Original's until an entry is selected. */
function selectedEditor(): LabConversationEditor {
  return findLabConversationEditor(selectedOption()) ?? defaultLabConversationEditor;
}

/** Whether loading saved prompts leaves the instructions alone: they are not a saved prompt's. */
function keepsPresetInstructions(): boolean {
  return selectedEditor().instructions !== "savedPrompt";
}

function conversationFields(): LabConversationFields {
  return {
    livePrompt: state.livePrompt,
    finishInterviewDescription: state.finishInterviewDescription,
    questionPrompts: state.questionPrompts,
    nextQuestionDescription: state.nextQuestionDescription,
    closingSentence: state.closingSentence,
    maximumClosingDurationMs: state.maximumClosingDurationMs,
  };
}

/** Whether the selected Conversation's fields make a complete input: its editor's check. */
function conversationComplete(): boolean {
  return isLabConversationComplete(
    selectedEditor(),
    conversationFields(),
    state.selectedMaxDurationMs,
  );
}

/** Starts a run through the selected execution's client. */
type LabExecutionStart = (request: LabInterviewStartRequest) => Promise<LabInterviewSession>;

/**
 * The selected execution: its panel, whether its settings let a run start, and its client with
 * its settings as they are now, or `null` without a client.
 */
type LabSelectedExecution = Readonly<{
  panel: LabExecutionPanel;
  ready: boolean;
  start: LabExecutionStart | null;
}>;

function selectedExecution(): LabSelectedExecution {
  // The selected entry opens the Cascade client when it accepts the Cascade media profile.
  if (selectedOption()?.connectionProfiles?.includes(cascadeMediaConnectionProfile) === true) {
    const client = labCascadeClient;
    // Until the providers load, a Start sends no settings: today's providers.
    const cascadeSettings =
      state.cascadeOptions === null || state.cascade === null
        ? undefined
        : labCascadeExecutionSettings(state.cascadeOptions, state.cascade);
    return {
      panel: cascadeExecutionPanel({
        options: state.cascadeOptions,
        optionsError: state.cascadeOptionsError,
        choices: state.cascade,
        disabled: areRunSettingsDisabled(),
        onChange: changeCascadeSettings,
      }),
      ready: true,
      start:
        client === null
          ? null
          : (request) =>
              client.start({
                ...request,
                runtimeConfig: { ...request.runtimeConfig, cascadeSettings },
              }),
    };
  }
  const client = labRealtimeClient;
  const realtimeSettings = { ...state.realtime.settings };
  return {
    panel: realtimeExecutionPanel({
      values: state.realtime,
      outputSettingsDisabled:
        isRuntimeStarting(state.liveRuntimeStatus) || state.liveRuntimeStatus.phase === "ending",
      onChange: changeRealtimeSettings,
    }),
    ready: realtimeSettingsReady(state.realtime),
    start:
      client === null
        ? null
        : (request) =>
            client.start({
              ...request,
              runtimeConfig: { ...request.runtimeConfig, realtimeSettings },
            }),
  };
}

function selectConversation(id: string): void {
  if (areRunSettingsDisabled() || id === state.selectedConversationId) return;
  const option = state.conversationOptions.find((entry) => entry.id === id);
  // An entry Runtime cannot start is offered disabled.
  if (option === undefined || !canStartLabConversation(option)) return;
  const drafts = { ...state.conversationDrafts };
  if (state.selectedConversationId !== null)
    drafts[state.selectedConversationId] = {
      livePrompt: state.livePrompt,
      finishInterviewDescription: state.finishInterviewDescription,
      closingSentence: state.closingSentence,
    };
  const draft =
    drafts[id] ??
    (findLabConversationEditor(option) ?? defaultLabConversationEditor).draft(
      createLivePromptState(getSelectedLivePromptOption()),
    );
  setState({ selectedConversationId: id, conversationDrafts: drafts, ...draft });
}

function createRuntimeConfigFromLabRunSettings(): LabInterviewConfig {
  return {
    ...selectedEditor().config(conversationFields()),
    selection: selectedOption()?.selection,
    maxDurationMs: state.selectedMaxDurationMs,
    // Both clients take a reasoning effort, which only the Realtime panel offers.
    reasoningEffort: state.realtime.reasoningEffort,
  };
}

export type LabLiveStatusContent = {
  label: string;
  detail: string;
};

export function getLiveStatusContent(status: LabInterviewStatus): LabLiveStatusContent {
  switch (status.phase) {
    case "setup":
      return status.label === "Ready"
        ? {
            label: "Ready",
            detail: "Start a local Interview when you are ready.",
          }
        : {
            label: "Starting",
            detail: "Lab is preparing the interview.",
          };
    case "live":
      return {
        label: "Live",
        detail: "The Interview is live.",
      };
    case "ending":
      return {
        label: "Thank you",
        detail: "Your participation is finished.",
      };
    case "ended":
      return {
        label: status.endStatus === "cancelled" ? "Cancelled" : "Thank you",
        detail:
          status.endStatus === "cancelled"
            ? "The Interview was cancelled."
            : "Your participation is finished.",
      };
    case "failed":
      return {
        label:
          status.failureKind === "ending" ? "Could Not End Interview" : "Could Not Start Interview",
        detail: getFailedRuntimeStatusDetail(status),
      };
  }
}

export function toLabRuntimeStatus(status: LabInterviewStatus): LabInterviewStatus {
  switch (status.phase) {
    case "setup":
      return {
        phase: "setup",
        label: status.label,
        detail: status.detail,
      };
    case "live": {
      const live: LabInterviewStatus = {
        phase: "live",
        label: status.label,
        detail: status.detail,
      };
      if (status.conversation !== undefined) live.conversation = status.conversation;
      return live;
    }
    case "ending":
      return {
        phase: "ending",
        label: status.label,
        detail: status.detail,
      };
    case "ended":
      const endedStatus: LabInterviewStatus = {
        phase: "ended",
        label: status.label,
        detail: status.detail,
        endStatus: status.endStatus,
      };
      if (status.transcriptWarning !== undefined) {
        endedStatus.transcriptWarning = status.transcriptWarning;
      }
      return endedStatus;
    case "failed": {
      const failed: LabInterviewStatus = {
        phase: "failed",
        label: status.label,
        detail: getFailedRuntimeStatusDetail(status),
        failureKind: status.failureKind,
      };
      // A Start refusal is a protocol code the page shows, not a debug fact.
      if (status.startRefusal !== undefined) failed.startRefusal = status.startRefusal;
      return failed;
    }
  }
}

function areLabRuntimeStatusesEqual(
  currentStatus: LabInterviewStatus,
  nextStatus: LabInterviewStatus,
): boolean {
  return JSON.stringify(currentStatus) === JSON.stringify(nextStatus);
}

async function loadLabRuns(preferredRunId?: string): Promise<void> {
  const readGeneration = ++transcriptListReadGeneration;
  transcriptDetailReadGeneration += 1;
  const store = labRunStore;
  if (store === null) {
    setState({
      errorText: "Set VITE_LAB_WORKER_URL before loading stored Interviews.",
    });
    return;
  }

  setState({
    isLoadingList: true,
    isLoadingInterview: false,
    errorText: null,
  });

  try {
    const interviews = await store.listLabRuns();
    if (readGeneration !== transcriptListReadGeneration) return;
    const selectedId = preferredRunId ?? state.selectedInterviewId ?? interviews[0]?.runId;

    setState({
      interviews,
      selectedInterview: null,
      selectedInterviewId: selectedId ?? null,
      isLoadingList: false,
    });

    if (selectedId !== undefined) {
      await loadLabRun(selectedId);
    }
  } catch (error) {
    if (readGeneration !== transcriptListReadGeneration) return;
    setState({
      isLoadingList: false,
      errorText: error instanceof Error ? error.message : "Could not load Transcripts.",
    });
  }
}

async function loadLabRun(id: string): Promise<void> {
  const readGeneration = ++transcriptDetailReadGeneration;
  const store = labRunStore;
  if (store === null) {
    setState({
      errorText: "Set VITE_LAB_WORKER_URL before opening a Transcript.",
    });
    return;
  }

  setState({
    selectedInterview: null,
    selectedInterviewId: id,
    isLoadingInterview: true,
    errorText: null,
  });

  try {
    const interview = await store.getLabRun(id);
    if (readGeneration !== transcriptDetailReadGeneration) return;

    setState({
      selectedInterview: interview,
      isLoadingInterview: false,
    });
  } catch (error) {
    if (readGeneration !== transcriptDetailReadGeneration) return;
    setState({
      isLoadingInterview: false,
      errorText: error instanceof Error ? error.message : "Could not open Transcript.",
    });
  }
}

async function startLiveInterview(): Promise<void> {
  const execution = selectedExecution();
  if (!execution.ready) return;
  if (!conversationComplete()) {
    setState({
      liveRuntimeStatus: createSetupFailedRuntimeStatus(),
    });
    return;
  }

  const activeLabRunStore = labRunStore;
  const startExecution = execution.start;

  if (activeLabRunStore === null) {
    setState({
      liveRuntimeStatus: createSetupFailedRuntimeStatus(),
    });
    return;
  }

  if (startExecution === null) {
    setState({
      liveRuntimeStatus: createSetupFailedRuntimeStatus(),
    });
    return;
  }

  const selectedPrompt = getSelectedLivePromptOption();
  const runtimeConfig = createRuntimeConfigFromLabRunSettings();

  const generation = ++liveStartGeneration;
  await cancelLiveRuntimeSession("Starting a new Interview.");
  if (generation !== liveStartGeneration) return;
  const controller = new AbortController();
  liveStartController = controller;

  setState({
    liveRuntimeStatus: {
      phase: "setup",
      label: "Starting Interview",
      detail: "Lab is preparing the interview.",
    },
  });

  const runtimeFailureRecorder: RuntimeFailureRecorder = { current: null };

  try {
    const startRequest: LabInterviewStartRequest = {
      signal: controller.signal,
      onRunAllocated(runIdentity) {
        if (generation !== liveStartGeneration) return;
        setState({
          liveInterviewId: runIdentity.runId,
        });

        let runtimeFailureEndPromise: Promise<void> | null = null;
        runtimeFailureRecorder.current = async () => {
          if (runtimeFailureEndPromise === null) {
            runtimeFailureEndPromise = activeLabRunStore.recordSetupFailureEnd({
              runId: runIdentity.runId,
              endedAt: Date.now(),
            });
          }

          await runtimeFailureEndPromise;
        };
      },
      runtimeConfig,
      onStatus(status) {
        if (generation !== liveStartGeneration) return;
        const liveRuntimeStatus = toLabRuntimeStatus(status);
        const shouldReleaseLiveSession =
          liveRuntimeStatus.phase === "ended" || liveRuntimeStatus.phase === "failed";

        if (shouldReleaseLiveSession) {
          liveRuntimeSession = null;
        }

        if (liveRuntimeStatus.phase === "failed" && liveRuntimeStatus.failureKind === "setup") {
          void (runtimeFailureRecorder.current?.() ?? Promise.resolve()).catch(() => undefined);
        }

        if (
          shouldReleaseLiveSession ||
          !areLabRuntimeStatusesEqual(state.liveRuntimeStatus, liveRuntimeStatus)
        ) {
          setState({
            liveRuntimeStatus,
          });
        }
      },
    };
    if (selectedPrompt !== null)
      startRequest.promptProvenance = createInterviewPromptProvenance({
        promptId: selectedPrompt.id,
        content: startRequest.runtimeConfig.instructions,
      });
    const session = await startExecution(startRequest);
    if (generation !== liveStartGeneration) {
      await session.cancel("Lab view replaced.");
      return;
    }
    liveRuntimeSession =
      session.getStatus().phase === "ended" || session.getStatus().phase === "failed"
        ? null
        : session;
    setState({
      liveInterviewId: session.handle.runId,
    });
  } catch (error) {
    if (generation !== liveStartGeneration) return;
    liveRuntimeSession = null;
    const recordFailure = runtimeFailureRecorder.current;
    await (recordFailure === null ? Promise.resolve() : recordFailure()).catch(() => undefined);
    if (generation !== liveStartGeneration) return;
    setState({
      liveRuntimeStatus: createSetupFailedRuntimeStatus(
        error instanceof Error || typeof error === "string" ? error : undefined,
      ),
    });
  }
}

async function cancelLiveRuntimeSession(reason: string): Promise<void> {
  liveStartController?.abort();
  if (liveRuntimeSession === null) {
    return;
  }

  const session = liveRuntimeSession;
  liveRuntimeSession = null;
  await session.cancel(reason);
}

async function endLiveInterview(): Promise<void> {
  if (liveRuntimeSession === null) {
    if (state.liveRuntimeStatus.phase === "setup") {
      liveStartController?.abort("participant_stopped");
      setState({
        liveRuntimeStatus: {
          phase: "ending",
          label: "Resolving Interview",
          detail: "Local participation stopped; the experiment outcome is still being resolved.",
        },
      });
      return;
    }
    if (labRunStore === null) {
      setState({
        liveRuntimeStatus: createSetupFailedRuntimeStatus(),
      });
    }
    return;
  }

  const session = liveRuntimeSession;
  const generation = liveStartGeneration;

  try {
    const result = await session.complete("participant_stopped");
    if (generation !== liveStartGeneration) return;
    liveRuntimeSession = null;

    setState({
      activeSurface: result.transcriptEvidence.turnCount > 0 ? "transcripts" : state.activeSurface,
      liveInterviewId: result.runId,
      liveRuntimeStatus: toLabRuntimeStatus(session.getStatus()),
    });
    if (result.transcriptEvidence.turnCount > 0) {
      await loadLabRuns(result.runId);
    }
  } catch {
    if (generation !== liveStartGeneration) return;
    liveRuntimeSession = null;
    setState({
      liveRuntimeStatus: toLabRuntimeStatus(session.getStatus()),
    });
  }
}

function selectSurface(surface: Surface): void {
  if (state.activeSurface === surface) {
    return;
  }

  setState({ activeSurface: surface });

  if (surface === "transcripts") {
    void loadLabRuns();
  }
}

function render(): void {
  if (appRoot === null || reactRoot === null) {
    throw new Error("Interview Lab requires an app root before rendering.");
  }
  const execution = selectedExecution();

  flushSync(() => {
    reactRoot?.render(
      createElement(InterviewLabShell, {
        activeSurface: state.activeSurface,
        runtimePhase: state.liveRuntimeStatus.phase,
        runId: state.liveInterviewId,
        liveInterviewSurface: createElement(LiveInterviewSurface, {
          // Each execution's page starts afresh, as each had its own page before.
          key: execution.panel.idPrefix,
          panel: execution.panel,
          editor: selectedEditor(),
          fields: conversationFields(),
          onFieldsChange: (change: Partial<LabConversationFields>) => setState(change),
          savedPrompts: {
            options: state.livePromptOptions,
            selectedPromptId: state.selectedPromptId,
            onPromptChange: selectLivePrompt,
            canSavePrompt:
              selectedEditor().instructions !== "none" &&
              labPromptStore !== null &&
              state.livePrompt.status === "ready" &&
              state.livePrompt.prompt !== getSelectedLivePromptOption()?.content,
            onSavePrompt: saveLivePrompt,
          },
          conversationOptions: state.conversationOptions,
          selectedConversationId: state.selectedConversationId,
          conversationError: state.conversationError,
          onConversationChange: selectConversation,
          canStartInterview:
            conversationComplete() &&
            execution.ready &&
            selectedCanStart() &&
            !isRuntimeStarting(state.liveRuntimeStatus) &&
            state.liveRuntimeStatus.phase !== "live" &&
            state.liveRuntimeStatus.phase !== "ending",
          isLiveSessionActive:
            liveRuntimeSession !== null ||
            (liveStartController !== null && state.liveRuntimeStatus.phase === "setup"),
          isRunSettingsDisabled: areRunSettingsDisabled(),
          isRuntimeStarting: isRuntimeStarting(state.liveRuntimeStatus),
          liveInterviewId: state.liveInterviewId,
          maxDurationPresets: labMaxDurationPresets,
          selectedMaxDurationMs: state.selectedMaxDurationMs,
          onMaxDurationChange: selectMaxDurationMs,
          onStartInterview() {
            void startLiveInterview();
          },
          onEndInterview() {
            void endLiveInterview();
          },
          runtimeStatus: state.liveRuntimeStatus,
          statusClassName: getRuntimeStatusClass(state.liveRuntimeStatus),
          statusContent: getLiveStatusContent(state.liveRuntimeStatus),
        }),

        onSurfaceChange: selectSurface,
        transcriptSurface: createElement(TranscriptReviewSurface, {
          errorText: state.errorText,
          interviews: state.interviews,
          isLoadingInterview: state.isLoadingInterview,
          isLoadingList: state.isLoadingList,
          onRefresh() {
            void loadLabRuns();
          },
          onSelectInterview(runId: string) {
            void loadLabRun(runId);
          },
          selectedInterview: state.selectedInterview,
          selectedInterviewId: state.selectedInterviewId,
        }),
      }),
    );
  });
}

async function loadConversations(store: LabConversationStore | null): Promise<void> {
  if (store === null) {
    setState({
      conversationError: "Set VITE_LAB_WORKER_URL before loading conversation selections.",
    });
    return;
  }
  try {
    const catalog = await store.list();
    // Lab offers exactly the entries whose input format one of its editors makes.
    const options = catalog.selections.filter(
      (entry) => findLabConversationEditor(entry) !== undefined,
    );
    setState({
      conversationOptions: options,
      // The first entry Runtime can start; the first entry when it can start none.
      selectedConversationId: (options.find(canStartLabConversation) ?? options[0])?.id ?? null,
      conversationError:
        options.length === 0 ? "No supported conversation selections are available." : null,
    });
    if (
      options.some((option) => option.connectionProfiles?.includes(cascadeMediaConnectionProfile))
    )
      void loadCascadeProviderOptions(labCascadeProviderOptionsStore);
  } catch {
    setState({ conversationError: "Could not load conversation selections. Refresh to retry." });
  }
}

/** Loads the providers the Cascade panel offers; a Cascade Start uses today's until they load. */
async function loadCascadeProviderOptions(
  store: LabCascadeProviderOptionsStore | null,
): Promise<void> {
  if (store === null) return;
  try {
    const options = await store.load();
    // A replaced Lab view has its own store.
    if (store !== labCascadeProviderOptionsStore) return;
    setState({
      cascadeOptions: options,
      cascadeOptionsError: null,
      cascade: createLabCascadeChoices(options),
    });
  } catch {
    if (store !== labCascadeProviderOptionsStore) return;
    setState({
      cascadeOptionsError: "Could not load Cascade providers; a Start uses today's providers.",
    });
  }
}
