// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { readVitestAsymmetricMatcher, runInAct } from "@/test/domTestSetup";

import { createInterviewPromptProvenance } from "./data/interviewPrompt";
import {
  questionPromptPresets,
  nextQuestionDescription,
  goodbyeInterviewInstructions,
  goodbyeFinishDescription,
  defaultClosingSentence,
} from "./content/presets";
import { addMissingKeys } from "./content/providerKeys";
import type {
  LabInterviewClient,
  LabInterviewConfig,
  LabInterviewStartRequest,
  LabInterviewStatus,
} from "./interviewClient";
import type {
  LabRealtimeClient,
  LabRealtimeClientConfig,
  LabRealtimeClientStartRequest,
} from "./realtimeClient/labRealtimeClient";
import type { LabCascadeClientConfig } from "./cascadeClient/labCascadeClient";
import { createWorkerLabRunStore, type LabRunDetail, type LabRunStore } from "./data/labRunStore";
import { RUNTIME_WORKER_UNAVAILABLE_MESSAGE } from "./realtimeClient/realtimeSignaling";
import type { RuntimeDiagnosticsStore } from "./data/runtimeDiagnosticsStore";
import {
  type InterviewLabDependencies,
  mountInterviewLab,
  toLabRuntimeStatus,
} from "./InterviewLab";
import type { LabPromptOption, LabPromptStore } from "./labPrompts";
import type { LabCascadeProviderOptions } from "./data/cascadeProviderOptions";
import { cascadeMediaConnectionProfile } from "../../../worker/shared/contracts/cascadeMedia.ts";
import type { CombinationAvailability } from "../../../worker/shared/contracts/conversationSelection.ts";

const labConversationStore = {
  list: async () => ({
    selections: [
      {
        id: "original-interview-realtime",
        version: 1,
        name: "Original interview · Realtime",
        selection: {
          conversation: { id: "original-interview", version: 1 },
          execution: { id: "realtime", version: 1 },
        },
        connectionProfiles: ["realtime-v1"],
        inputContract: "original-interview-input/v1",
        usage: [],
        warnings: [],
        availability: { credentials: ["OPENAI_API_KEY"], missingCredentials: [] },
      },
    ],
  }),
};

async function mountLab(dependencies: InterviewLabDependencies): Promise<void> {
  await runInAct(() => mountInterviewLab({ labConversationStore, ...dependencies }));
}

describe("Interview Lab status projection", () => {
  it.each(["limited", "checked", "unknown"] as const)(
    "shows saved Goodbye diagnostic %s independently of transcript outcome",
    async (status) => {
      const root = document.createElement("div");
      document.body.append(root);
      const run = {
        runId: "saved-goodbye",
        startedAt: 1000,
        endedAt: 2000,
        outcome: "ended" as const,
        endReason: "timebox_reached" as const,
        transcriptTurnCount: 0,
        transcript: { turns: [] },
        closingDiagnostic: {
          status,
          warnings: status === "limited" ? ["closing_cutoff_exhausted"] : [],
        },
      };
      await mountLab({
        appRoot: root,
        labRealtimeClient: null,
        labRunStore: {
          ...createFakeLabRunStore(),
          listLabRuns: async () => [
            {
              runId: run.runId,
              startedAt: run.startedAt,
              endedAt: run.endedAt,
              outcome: run.outcome,
              endReason: run.endReason,
              transcriptTurnCount: 0,
            },
          ],
          getLabRun: async () => run,
        },
      });
      await runInAct(() =>
        requiredElement(root, '[data-testid="lab-transcripts-tab"]', HTMLButtonElement).click(),
      );
      await flushPromises();
      const diagnostic = requiredElement(
        root,
        '[data-testid="lab-closing-diagnostic"]',
        HTMLElement,
      );
      if (status === "limited")
        expect(diagnostic.textContent).toContain("closing_cutoff_exhausted");
      else if (status === "checked") {
        expect(diagnostic.textContent).toContain("No closing limitation reported");
        expect(diagnostic.textContent).not.toContain("successful");
      } else {
        expect(diagnostic.textContent).toContain("unavailable");
        expect(diagnostic.textContent).not.toContain("successful");
      }
    },
  );
  it("enables Save As for changed text and selects a newly saved prompt", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const prompts = createLabPromptOptions();
    const createLabPrompt = vi
      .fn<LabPromptStore["createLabPrompt"]>()
      .mockImplementation(async (name, content) => ({
        id: "new",
        fileName: name,
        content,
        provenance: createInterviewPromptProvenance({ promptId: "new", content }),
      }));
    const updateLabPrompt = vi
      .fn<LabPromptStore["updateLabPrompt"]>()
      .mockImplementation(async (id, content) => ({
        id,
        fileName: "Experiment",
        content,
        provenance: createInterviewPromptProvenance({ promptId: id, content }),
      }));
    await mountLab({
      appRoot: root,
      labRunStore: createFakeLabRunStore(),
      labRealtimeClient: null,
      labPromptStore: { listLabPrompts: async () => prompts, createLabPrompt, updateLabPrompt },
    });
    await flushPromises();
    const saveAs = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Save As",
    );
    expect(saveAs?.disabled).toBe(true);
    const editor = requiredElement(root, "#live-prompt-editor", HTMLTextAreaElement);
    await runInAct(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        editor,
        "Changed text\n",
      );
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(saveAs?.disabled).toBe(false);
    await runInAct(() => saveAs?.click());
    const newChoice = [
      ...document.querySelectorAll<HTMLInputElement>('input[name="save-choice"]'),
    ][1];
    await runInAct(() => newChoice?.click());
    const name = requiredElement(document.body, "#new-prompt-name", HTMLInputElement);
    await runInAct(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        name,
        "Experiment",
      );
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Save",
    );
    await runInAct(() => confirm?.click());
    await flushPromises();
    expect(createLabPrompt).toHaveBeenCalledWith("Experiment", "Changed text\n");
    expect(root.querySelector<HTMLSelectElement>(".live-prompt-selector select")?.value).toBe(
      "new",
    );
    expect(root.querySelector<HTMLTextAreaElement>("#live-prompt-editor")?.value).toBe(
      "Changed text\n",
    );
    const selectedEditor = requiredElement(root, "#live-prompt-editor", HTMLTextAreaElement);
    await runInAct(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        selectedEditor,
        "Replacement\n",
      );
      selectedEditor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await runInAct(() => saveAs?.click());
    const replaceChoice = document.querySelector<HTMLInputElement>('input[name="save-choice"]');
    await runInAct(() => replaceChoice?.click());
    const replaceConfirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Save",
    );
    await runInAct(() => replaceConfirm?.click());
    await flushPromises();
    expect(updateLabPrompt).toHaveBeenCalledWith("new", "Replacement\n");
    expect(saveAs?.disabled).toBe(true);
    root.remove();
  });
  it("loads saved prompts from the Lab store and exposes read failures", async () => {
    const root = document.createElement("div");
    const listLabPrompts = vi
      .fn<LabPromptStore["listLabPrompts"]>()
      .mockResolvedValueOnce(createLabPromptOptions())
      .mockRejectedValueOnce(new Error("database unavailable"));
    await mountLab({
      appRoot: root,
      labRunStore: createFakeLabRunStore(),
      labRealtimeClient: null,
      labPromptStore: { listLabPrompts, createLabPrompt: vi.fn(), updateLabPrompt: vi.fn() },
    });
    await flushPromises();
    expect(root.querySelector<HTMLTextAreaElement>("#live-prompt-editor")?.value).toBe(
      "Sample prompt",
    );
    await mountLab({
      appRoot: root,
      labRunStore: createFakeLabRunStore(),
      labRealtimeClient: null,
      labPromptStore: { listLabPrompts, createLabPrompt: vi.fn(), updateLabPrompt: vi.fn() },
    });
    await flushPromises();
    expect(root.querySelector("#live-prompt-message")?.textContent).toContain(
      "Could not load Lab prompts",
    );
    expect(root.querySelector<HTMLTextAreaElement>("#live-prompt-editor")?.disabled).toBe(true);
  });

  it("strips runtime debug facts before storing normal Lab status", () => {
    expect(
      toLabRuntimeStatus({
        phase: "failed",
        label: "Provider Setup Failed",
        detail: "Sideband ledger failed before the Interview reached live.",
        failureKind: "setup",
        errorText: "Provider/signaling failed: rtc_provider_call sideband ledger stack trace.",
        notice: {
          severity: "warning",
          text: "Provider warning with rtc_provider_call.",
        },
        debugFacts: [
          {
            label: "Runtime Call",
            value: "rtc_provider_call",
          },
        ],
      }),
    ).toEqual({
      phase: "failed",
      label: "Provider Setup Failed",
      detail:
        "The Interview did not reach the expected state. Runtime diagnostics are available outside normal Lab review.",
      failureKind: "setup",
    });
  });

  it("updates the displayed prompt when the selected prompt file changes before start", async () => {
    const root = document.createElement("div");

    await mountLab({
      appRoot: root,
      labRunStore: createFakeLabRunStore(),
      runtimeDiagnosticsStore: createFakeRuntimeDiagnosticsStore(),
      labRealtimeClient: null,
      liveInterviewPrompts: createLabPromptOptionsWithSecondFileFirst(),
    });

    await Promise.resolve();
    await Promise.resolve();

    const promptSelect = root.querySelector<HTMLSelectElement>(".live-prompt-selector select");

    if (promptSelect === null) {
      throw new Error("Expected a prompt selector.");
    }

    await runInAct(() => {
      promptSelect.value = "short-form";
      promptSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await Promise.resolve();

    const rerenderedPromptSelect = root.querySelector<HTMLSelectElement>(
      ".live-prompt-selector select",
    );
    expect(rerenderedPromptSelect?.value).toBe("short-form");
    expect(root.querySelector<HTMLTextAreaElement>("#live-prompt-editor")?.value).toBe(
      "Short-form prompt",
    );
  });

  it("restores saved text when the selected prompt is selected again", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    await mountLab({
      appRoot: root,
      labRunStore: createFakeLabRunStore(),
      labRealtimeClient: null,
      liveInterviewPrompts: createLabPromptOptions(),
    });

    const editor = requiredElement(root, "#live-prompt-editor", HTMLTextAreaElement);
    await runInAct(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        editor,
        "Unsaved change",
      );
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const trigger = requiredElement(
      root,
      ".live-prompt-selector [data-slot='select-trigger']",
      HTMLElement,
    );
    await runInAct(() => {
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }),
      );
    });
    const selectedItem = requiredElement(
      document.body,
      "[data-slot='select-item'][data-state='checked']",
      HTMLElement,
    );
    await runInAct(() => {
      selectedItem.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }),
      );
    });
    await flushPromises();

    expect(root.querySelector<HTMLTextAreaElement>("#live-prompt-editor")?.value).toBe(
      "Sample prompt",
    );
    await mountLab({
      appRoot: document.createElement("div"),
      labRunStore: createFakeLabRunStore(),
      labRealtimeClient: null,
      liveInterviewPrompts: createLabPromptOptions(),
    });
    root.remove();
  });

  it("refreshes Transcript review when the Transcripts tab is selected", async () => {
    const root = document.createElement("div");
    const interview = createReadableTranscriptInterview();
    const listLabRuns = vi
      .fn<LabRunStore["listLabRuns"]>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([interview]);
    const getLabRun = vi.fn<LabRunStore["getLabRun"]>().mockResolvedValue(interview);

    await mountLab({
      appRoot: root,
      labRunStore: {
        ...createFakeLabRunStore(),
        listLabRuns,
        getLabRun,
      },
      runtimeDiagnosticsStore: createFakeRuntimeDiagnosticsStore(),
      labRealtimeClient: null,
      liveInterviewPrompts: createLabPromptOptions(),
    });

    await Promise.resolve();
    await Promise.resolve();

    await runInAct(async () => {
      root.querySelectorAll<HTMLButtonElement>(".tab")[1]?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listLabRuns).toHaveBeenCalledTimes(2);
    expect(root.textContent).toContain("Ended · Manual finish · 1 turns");
    expect(root.textContent).toContain("Ending reasonManual finish");
    expect(root.textContent).toContain("It worked.");
    expect(root.querySelector(".turn-list")?.textContent).not.toContain("Manual finish");
  });

  it("shows matched output usage beside the answer and summarizes unmatched usage", async () => {
    const root = document.createElement("div");
    const interview: LabRunDetail = {
      ...createReadableTranscriptInterview(),
      transcriptTurnCount: 2,
      transcript: {
        turns: [
          { role: "participant", text: "Question" },
          { role: "conversationAgent", text: "Answer" },
        ],
      },
      maxOutputTokens: 100,
      responseUsage: [
        { responseId: "matched", outputTokens: 80, answerTurnNumber: 2 },
        { responseId: "unmatched", outputTokens: 95 },
      ],
    };
    await mountLab({
      appRoot: root,
      labRunStore: {
        ...createFakeLabRunStore(),
        listLabRuns: vi.fn().mockResolvedValue([interview]),
        getLabRun: vi.fn().mockResolvedValue(interview),
      },
      labRealtimeClient: null,
      liveInterviewPrompts: createLabPromptOptions(),
    });
    await flushPromises();
    await runInAct(() => root.querySelectorAll<HTMLButtonElement>(".tab")[1]?.click());
    await flushPromises();

    const detail = root.querySelector<HTMLElement>(".transcript-detail");
    expect(detail?.tabIndex).toBe(0);
    expect(detail?.getAttribute("aria-labelledby")).toBe(detail?.querySelector("h3")?.id);
    expect(detail?.querySelector(".turn-list .turn:last-child .turn-usage")?.textContent).toBe(
      "80 / 100 output tokens (80%)",
    );
    expect(root.querySelectorAll(".turn-usage")).toHaveLength(1);
    expect(root.querySelector(".turn-usage")?.textContent).toBe("80 / 100 output tokens (80%)");
    expect(root.querySelector(".output-usage-summary")?.textContent).toContain(
      "95 / 100 output tokens (95%)",
    );
    expect(root.querySelector(".output-usage-summary")?.textContent).toContain("2 of 2 responses");
  });

  it("shows Transcript load errors without leaving the React tab blank", async () => {
    const root = document.createElement("div");

    await mountLab({
      appRoot: root,
      labRunStore: null,
      runtimeDiagnosticsStore: createFakeRuntimeDiagnosticsStore(),
      labRealtimeClient: null,
      liveInterviewPrompts: createLabPromptOptions(),
    });

    await Promise.resolve();

    await runInAct(async () => {
      root.querySelectorAll<HTMLButtonElement>(".tab")[1]?.click();
      await Promise.resolve();
    });

    expect(root.textContent).toContain("Could not load Transcripts");
    expect(root.textContent).toContain("Set VITE_LAB_WORKER_URL before loading stored Interviews.");
    expect(root.textContent).toContain("No Lab Runs found");
  });

  it.each([
    { earlierResult: "success", settleEarlierFirst: false },
    { earlierResult: "failure", settleEarlierFirst: false },
    { earlierResult: "success", settleEarlierFirst: true },
    { earlierResult: "failure", settleEarlierFirst: true },
  ] as const)(
    "keeps the latest Transcript selection when an earlier $earlierResult arrives (earlier first: $settleEarlierFirst)",
    async ({ earlierResult, settleEarlierFirst }) => {
      const root = document.createElement("div");
      const reads = createDelayedTranscriptReads();
      await mountLab({
        appRoot: root,
        labRunStore: reads.store,
        labRealtimeClient: null,
      });
      await runInAct(() =>
        requiredElement(root, '[data-testid="lab-transcripts-tab"]', HTMLButtonElement).click(),
      );
      await flushPromises();
      reads.delayDetails();

      await runInAct(() => {
        requiredElement(root, '[data-run-id="run-a"]', HTMLButtonElement).click();
        requiredElement(root, '[data-run-id="run-b"]', HTMLButtonElement).click();
      });

      if (settleEarlierFirst) {
        await runInAct(() => reads.settleFirst(earlierResult));
        expect(
          requiredElement(root, '[data-run-id="run-b"]', HTMLButtonElement).getAttribute(
            "aria-pressed",
          ),
        ).toBe("true");
        expect(root.querySelector('article[aria-live="polite"]')).not.toBeNull();
        expect(root.querySelector('[role="alert"]')).toBeNull();
      }

      await runInAct(() => reads.settleSecond());
      if (!settleEarlierFirst) {
        await runInAct(() => reads.settleFirst(earlierResult));
      }

      const runA = requiredElement(root, '[data-run-id="run-a"]', HTMLButtonElement);
      const runB = requiredElement(root, '[data-run-id="run-b"]', HTMLButtonElement);
      expect(runA.getAttribute("aria-pressed")).toBe("false");
      expect(runB.getAttribute("aria-pressed")).toBe("true");
      expect(runB.getAttribute("aria-current")).toBe("true");
      expect(root.querySelector("article")?.textContent).toContain("Transcript from run B.");
      expect(root.querySelector("article")?.textContent).not.toContain("Transcript from run A.");
      expect(root.querySelector('article[aria-live="polite"]')).toBeNull();
      expect(root.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it("finishes a Transcript refresh after invalidating a pending detail read", async () => {
    const root = document.createElement("div");
    const reads = createDelayedTranscriptReads();
    await mountLab({
      appRoot: root,
      labRunStore: reads.store,
      labRealtimeClient: null,
    });
    await runInAct(() =>
      requiredElement(root, '[data-testid="lab-transcripts-tab"]', HTMLButtonElement).click(),
    );
    await flushPromises();
    reads.delayDetails();
    await runInAct(() => requiredElement(root, '[data-run-id="run-a"]', HTMLButtonElement).click());
    reads.delayList();
    const refresh = requiredElement(
      root,
      '[data-testid="lab-transcript-refresh"]',
      HTMLButtonElement,
    );
    await runInAct(() => refresh.click());

    expect(refresh.disabled).toBe(true);
    expect(root.querySelector("[data-run-id]")).toBeNull();
    await runInAct(() => reads.settleFirst("success"));
    expect(root.querySelector("article")?.textContent).not.toContain("Transcript from run A.");
    expect(refresh.disabled).toBe(true);

    await runInAct(() => reads.settleList());
    expect(root.querySelectorAll("[data-run-id]")).toHaveLength(2);
    expect(refresh.disabled).toBe(false);
    await runInAct(() => reads.settleFirst("success"));
    expect(root.querySelector("article")?.textContent).toContain("Transcript from run A.");
    expect(root.querySelector('article[aria-live="polite"]')).toBeNull();
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(["success", "failure"] as const)(
    "ignores a pending Transcript %s from the previous Lab mount",
    async (earlierResult) => {
      const root = document.createElement("div");
      const reads = createDelayedTranscriptReads();
      await mountLab({
        appRoot: root,
        labRunStore: reads.store,
        labRealtimeClient: null,
      });
      await runInAct(() =>
        requiredElement(root, '[data-testid="lab-transcripts-tab"]', HTMLButtonElement).click(),
      );
      await flushPromises();
      reads.delayDetails();
      await runInAct(() =>
        requiredElement(root, '[data-run-id="run-a"]', HTMLButtonElement).click(),
      );

      await mountLab({
        appRoot: root,
        labRunStore: createWorkerLabRunStore("https://lab.example", {
          fetchImpl: async () => Response.json([]),
        }),
        labRealtimeClient: null,
      });
      await runInAct(() =>
        requiredElement(root, '[data-testid="lab-transcripts-tab"]', HTMLButtonElement).click(),
      );
      await flushPromises();
      await runInAct(() => reads.settleFirst(earlierResult));

      expect(root.querySelector("[data-run-id]")).toBeNull();
      expect(root.querySelector("article")?.textContent).not.toContain("Transcript from run A.");
      expect(root.querySelector('article[aria-live="polite"]')).toBeNull();
      expect(root.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it("keeps Start disabled when the delivered selection catalog cannot be loaded", async () => {
    const root = document.createElement("div");
    const { runtime, startRequests } = createControllableLabRealtimeClient();
    await mountLab({
      appRoot: root,
      labRunStore: createFakeLabRunStore(),
      labRealtimeClient: runtime,
      liveInterviewPrompts: createLabPromptOptions(),
      labConversationStore: {
        list: async () => {
          throw new TypeError("network interrupted");
        },
      },
    });
    await flushPromises();
    expect(
      requiredElement(root, '[data-testid="lab-start-interview"]', HTMLButtonElement).disabled,
    ).toBe(true);
    expect(startRequests).toEqual([]);
  });

  it("snapshots the full edited finish description together with the selected instructions", async () => {
    const root = document.createElement("div");
    const { runtime, startRequests } = createControllableLabRealtimeClient();
    await mountLab({
      appRoot: root,
      labRunStore: createFakeLabRunStore(),
      labRealtimeClient: runtime,
      liveInterviewPrompts: createLabPromptOptions(),
    });
    await flushPromises();
    const editor = requiredElement(root, "#live-finish-description", HTMLTextAreaElement);
    await runInAct(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        editor,
        "  Selected finish description.  ",
      );
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await runInAct(() =>
      requiredElement(root, '[data-testid="lab-start-interview"]', HTMLButtonElement).click(),
    );
    await flushPromises();
    expect(startRequests[0]?.runtimeConfig).toMatchObject({
      instructions: "Sample prompt",
      finishInterviewDescription: "  Selected finish description.  ",
      selection: {
        conversation: { id: "original-interview", version: 1 },
        execution: { id: "realtime", version: 1 },
      },
    });
    expect(requiredElement(root, "#live-finish-description", HTMLTextAreaElement).disabled).toBe(
      true,
    );
  });

  it("starts the Lab Interview with the selected Run settings", async () => {
    const root = document.createElement("div");
    const labRunStore = createFakeLabRunStore();
    const runtimeDiagnosticsStore = createFakeRuntimeDiagnosticsStore();
    const { runtime, startRequests, emitStatus } = createControllableLabRealtimeClient();

    await mountLab({
      appRoot: root,
      labRunStore,
      runtimeDiagnosticsStore,
      labRealtimeClient: runtime,
      liveInterviewPrompts: createLabPromptOptions(),
    });

    await Promise.resolve();
    await Promise.resolve();

    const promptSelect = root.querySelector<HTMLSelectElement>(".live-prompt-selector select");
    const maxDurationSelect = root.querySelector<HTMLSelectElement>("select[name='maxDurationMs']");
    const reasoningEffortSelect = root.querySelector<HTMLSelectElement>(
      "select[name='reasoningEffort']",
    );

    if (promptSelect === null || maxDurationSelect === null || reasoningEffortSelect === null) {
      throw new Error("Expected Run settings controls.");
    }

    await runInAct(async () => {
      promptSelect.value = "short-form";
      promptSelect.dispatchEvent(new Event("change", { bubbles: true }));
      maxDurationSelect.value = String(8 * 60 * 1000);
      maxDurationSelect.dispatchEvent(new Event("change", { bubbles: true }));
      reasoningEffortSelect.value = "high";
      reasoningEffortSelect.dispatchEvent(new Event("change", { bubbles: true }));
      for (const [name, value] of [
        ["realtimeModel", "gpt-realtime-2.1"],
        ["voice", "cedar"],
        ["inputNoiseReduction", "near_field"],
        ["semanticVadEagerness", "high"],
      ] as const) {
        const select = root.querySelector<HTMLSelectElement>(`select[name='${name}']`);
        if (select === null) throw new Error(`Expected ${name} selector`);
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const speed = root.querySelector<HTMLInputElement>("input[name='speed']");
      if (speed === null) throw new Error("Expected speed input");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        speed,
        "1.25",
      );
      speed.dispatchEvent(new Event("input", { bubbles: true }));
      root.querySelector<HTMLButtonElement>(".primary-button")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(labRunStore.createLabRun).not.toHaveBeenCalled();
    expect(startRequests[0]).toMatchObject({
      promptProvenance: {
        promptId: "short-form",
        contentHash: createInterviewPromptProvenance({
          promptId: "short-form",
          content: "Short-form prompt",
        }).contentHash,
      },
      runtimeConfig: {
        instructions: "Short-form prompt",
        maxDurationMs: 8 * 60 * 1000,
        reasoningEffort: "high",
        realtimeSettings: {
          model: "gpt-realtime-2.1",
          voice: "cedar",
          speed: 1.25,
          inputNoiseReduction: "near_field",
          semanticVadEagerness: "high",
          maxOutputTokens: 700,
          truncation: "auto",
        },
      },
      onRunAllocated: readVitestAsymmetricMatcher(expect.any(Function)),
      onStatus: readVitestAsymmetricMatcher(expect.any(Function)),
    });
    await runInAct(async () => {
      await Promise.resolve();
    });
    expect(root.querySelector<HTMLTextAreaElement>("#live-prompt-editor")?.value).toBe(
      "Short-form prompt",
    );
    expect(
      [...root.querySelectorAll<HTMLSelectElement>(".run-settings select")].map(
        (select) => select.disabled,
      ),
    ).toEqual([true, true, false, false, false, false, false, false, false]);
    await runInAct(() => {
      const model = root.querySelector<HTMLSelectElement>("select[name='realtimeModel']");
      if (model === null) throw new Error("Expected model selector");
      model.value = "gpt-realtime-2";
      model.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(startRequests[0]?.runtimeConfig.realtimeSettings?.model).toBe("gpt-realtime-2.1");
    expect(root.querySelector<HTMLSelectElement>("select[name='realtimeModel']")?.value).toBe(
      "gpt-realtime-2",
    );
    await runInAct(() =>
      emitStatus({ phase: "ended", label: "Ended", detail: "Done.", endStatus: "ended" }),
    );
    await runInAct(() => root.querySelector<HTMLButtonElement>(".primary-button")?.click());
    await flushPromises();
    expect(startRequests[1]?.runtimeConfig.realtimeSettings?.model).toBe("gpt-realtime-2");
  });

  it("snapshots output controls at Start and applies live edits to the next run", async () => {
    const root = document.createElement("div");
    const { runtime, startRequests, emitStatus } = createControllableLabRealtimeClient();
    await mountLab({
      appRoot: root,
      labRunStore: createFakeLabRunStore(),
      labRealtimeClient: runtime,
      liveInterviewPrompts: createLabPromptOptions(),
    });
    await flushPromises();

    await runInAct(() => {
      const input = requiredElement(root, "#output-token-cap", HTMLInputElement);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "4097",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(root.querySelector<HTMLButtonElement>(".primary-button")?.disabled).toBe(true);

    await runInAct(() => {
      const input = requiredElement(root, "#output-token-cap", HTMLInputElement);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "1024",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const truncation = requiredElement(root, "select[name='truncation']", HTMLSelectElement);
      truncation.value = "disabled";
      truncation.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await runInAct(() => root.querySelector<HTMLButtonElement>(".primary-button")?.click());
    await flushPromises();
    expect(startRequests[0]?.runtimeConfig.realtimeSettings).toMatchObject({
      maxOutputTokens: 1024,
      truncation: "disabled",
    });

    await runInAct(() => {
      const mode = requiredElement(root, "select[name='outputCapMode']", HTMLSelectElement);
      mode.value = "inf";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
      const truncation = requiredElement(root, "select[name='truncation']", HTMLSelectElement);
      truncation.value = "auto";
      truncation.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(startRequests[0]?.runtimeConfig.realtimeSettings).toMatchObject({
      maxOutputTokens: 1024,
      truncation: "disabled",
    });
    await runInAct(() =>
      emitStatus({ phase: "ended", label: "Ended", detail: "Done.", endStatus: "ended" }),
    );
    await runInAct(() => root.querySelector<HTMLButtonElement>(".primary-button")?.click());
    await flushPromises();
    expect(startRequests[1]?.runtimeConfig.realtimeSettings).toMatchObject({
      maxOutputTokens: "inf",
      truncation: "auto",
    });
  });

  it("shows actionable recovery when the Runtime Worker service binding is unavailable", async () => {
    const root = document.createElement("div");

    await mountLab({
      appRoot: root,
      labRunStore: createFakeLabRunStore(),
      runtimeDiagnosticsStore: createFakeRuntimeDiagnosticsStore(),
      labRealtimeClient: {
        start: vi.fn((request: LabRealtimeClientStartRequest) => {
          request.onRunAllocated?.({
            runId: "lab-interview",
            startedAt: 1_700_000_000_000,
          });
          return Promise.reject(new Error(RUNTIME_WORKER_UNAVAILABLE_MESSAGE));
        }),
      },
      liveInterviewPrompts: createLabPromptOptions(),
    });

    await Promise.resolve();
    await Promise.resolve();

    await runInAct(() => root.querySelector<HTMLButtonElement>(".primary-button")?.click());
    await flushPromises();

    expect(root.textContent).toContain("Could Not Start Interview");
    expect(root.textContent).toContain(RUNTIME_WORKER_UNAVAILABLE_MESSAGE);
  });

  it("does not create a Lab Run when setup fails before Worker allocation", async () => {
    const root = document.createElement("div");
    const labRunStore = createFakeLabRunStore();

    await mountLab({
      appRoot: root,
      labRunStore,
      runtimeDiagnosticsStore: createFakeRuntimeDiagnosticsStore(),
      labRealtimeClient: {
        start: vi.fn().mockRejectedValue(new Error("Microphone permission was denied.")),
      },
      liveInterviewPrompts: createLabPromptOptions(),
    });

    await Promise.resolve();
    await Promise.resolve();

    await runInAct(() => root.querySelector<HTMLButtonElement>(".primary-button")?.click());
    await flushPromises();

    expect(labRunStore.createLabRun).not.toHaveBeenCalled();
    expect(labRunStore.recordSetupFailureEnd).not.toHaveBeenCalled();
    expect(root.textContent).toContain("Could Not Start Interview");
  });

  it("persists runtime failures with the runtime_failed ending reason", async () => {
    const root = document.createElement("div");
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_010_000);
    const labRunStore = createFakeLabRunStore();

    try {
      await mountLab({
        appRoot: root,
        labRunStore,
        runtimeDiagnosticsStore: createFakeRuntimeDiagnosticsStore(),
        labRealtimeClient: {
          start: vi.fn((request: LabRealtimeClientStartRequest) => {
            request.onRunAllocated?.({
              runId: "lab-interview",
              startedAt: 1_700_000_000_000,
            });
            return Promise.reject(new Error("Runtime unavailable."));
          }),
        },
        liveInterviewPrompts: createLabPromptOptions(),
      });

      await Promise.resolve();
      await Promise.resolve();

      await runInAct(() => root.querySelector<HTMLButtonElement>(".primary-button")?.click());
      await flushPromises();

      expect(labRunStore.recordSetupFailureEnd).toHaveBeenCalledWith({
        runId: "lab-interview",
        endedAt: 1_700_000_010_000,
      });
    } finally {
      now.mockRestore();
    }
  });

  it("locks duration while the Lab Interview is starting", async () => {
    const root = document.createElement("div");

    await mountLab({
      appRoot: root,
      labRunStore: createFakeLabRunStore(),
      runtimeDiagnosticsStore: createFakeRuntimeDiagnosticsStore(),
      labRealtimeClient: createPendingStartLabRealtimeClient(),
      liveInterviewPrompts: createLabPromptOptions(),
    });

    await Promise.resolve();
    await Promise.resolve();

    await runInAct(() => root.querySelector<HTMLButtonElement>(".primary-button")?.click());
    await Promise.resolve();

    expect(
      [...root.querySelectorAll<HTMLSelectElement>(".run-settings select")].map(
        (select) => select.disabled,
      ),
    ).toEqual([true, true, false, false, false, false, false, true, true]);
  });

  it("makes duration editable again after the Interview ends", async () => {
    const root = document.createElement("div");
    const { runtime } = createControllableLabRealtimeClient();

    await mountLab({
      appRoot: root,
      labRunStore: createFakeLabRunStore(),
      runtimeDiagnosticsStore: createFakeRuntimeDiagnosticsStore(),
      labRealtimeClient: runtime,
      liveInterviewPrompts: createLabPromptOptions(),
    });

    await Promise.resolve();
    await Promise.resolve();

    await runInAct(() => root.querySelector<HTMLButtonElement>(".primary-button")?.click());
    await flushPromises();
    await runInAct(() => root.querySelector<HTMLButtonElement>(".secondary-button")?.click());
    await flushPromises();

    const promptSelect = root.querySelector<HTMLSelectElement>(".live-prompt-selector select");
    const maxDurationSelect = root.querySelector<HTMLSelectElement>("select[name='maxDurationMs']");
    const reasoningEffortSelect = root.querySelector<HTMLSelectElement>(
      "select[name='reasoningEffort']",
    );
    expect(promptSelect?.disabled).toBe(false);
    expect(maxDurationSelect?.disabled).toBe(false);
    expect(reasoningEffortSelect?.disabled).toBe(false);

    if (promptSelect === null) {
      throw new Error("Expected a prompt selector.");
    }

    await runInAct(async () => {
      promptSelect.value = "short-form";
      promptSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(root.querySelector<HTMLTextAreaElement>("#live-prompt-editor")?.value).toBe(
      "Short-form prompt",
    );
  });

  it("locks session settings while active and unlocks them after automatic completion", async () => {
    const root = document.createElement("div");
    const { emitStatus, runtime } = createControllableLabRealtimeClient();

    await mountLab({
      appRoot: root,
      labRunStore: createFakeLabRunStore(),
      runtimeDiagnosticsStore: createFakeRuntimeDiagnosticsStore(),
      labRealtimeClient: runtime,
      liveInterviewPrompts: createLabPromptOptions(),
    });

    await Promise.resolve();
    await Promise.resolve();

    await runInAct(() => root.querySelector<HTMLButtonElement>(".primary-button")?.click());
    await flushPromises();

    for (const phase of ["live", "ending"] as const) {
      await runInAct(() => emitStatus({ phase, label: "", detail: "" }));
      expect(root.querySelector<HTMLSelectElement>('select[name="maxDurationMs"]')?.disabled).toBe(
        true,
      );
      expect(root.querySelector<HTMLSelectElement>('select[name="outputCapMode"]')?.disabled).toBe(
        phase === "ending",
      );
      expect(root.querySelector<HTMLSelectElement>('select[name="truncation"]')?.disabled).toBe(
        phase === "ending",
      );
    }

    await runInAct(() => {
      emitStatus({
        phase: "ended",
        label: "Ended",
        detail: "The Interview ended and Transcript evidence is ready.",
        endStatus: "ended",
      });
    });

    expect(root.querySelector<HTMLButtonElement>(".secondary-button")?.hidden).toBe(true);
    expect(
      [...root.querySelectorAll<HTMLSelectElement>(".run-settings select")].map(
        (select) => select.disabled,
      ),
    ).toEqual([false, false, false, false, false, false, false, false, false]);
    expect(root.querySelector('[role="status"]')?.textContent).toContain("Thank you");
  });

  it("keeps the working prompt editable after Start and snapshots text for the next run", async () => {
    const root = document.createElement("div");
    const { runtime, startRequests, emitStatus } = createControllableLabRealtimeClient();

    await mountLab({
      appRoot: root,
      labRunStore: createFakeLabRunStore(),
      labRealtimeClient: runtime,
      liveInterviewPrompts: createLabPromptOptions(),
    });
    const editor = requiredElement(root, "#live-prompt-editor", HTMLTextAreaElement);
    await runInAct(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        editor,
        "Edited before Start\n",
      );
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await runInAct(() => root.querySelector<HTMLButtonElement>(".live-prompt-reload")?.click());
    expect(root.querySelector<HTMLTextAreaElement>("#live-prompt-editor")?.value).toBe(
      "Sample prompt",
    );
    await runInAct(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        editor,
        "Edited before Start\n",
      );
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await runInAct(() => root.querySelector<HTMLButtonElement>(".primary-button")?.click());
    await flushPromises();
    expect(startRequests[0]?.runtimeConfig.instructions).toBe("Edited before Start\n");

    await runInAct(() =>
      emitStatus({ phase: "live", label: "Live", detail: "The Interview is live." }),
    );
    const liveEditor = requiredElement(root, "#live-prompt-editor", HTMLTextAreaElement);
    const promptSelect = requiredElement(root, ".live-prompt-selector select", HTMLSelectElement);
    expect(liveEditor.disabled).toBe(false);
    expect(promptSelect.disabled).toBe(false);
    await runInAct(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        liveEditor,
        "Changed while live",
      );
      liveEditor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(startRequests[0]?.runtimeConfig.instructions).toBe("Edited before Start\n");
    await runInAct(() =>
      emitStatus({ phase: "ended", label: "Ended", detail: "Done.", endStatus: "ended" }),
    );
    await runInAct(() => root.querySelector<HTMLButtonElement>(".primary-button")?.click());
    await flushPromises();
    expect(startRequests[1]?.runtimeConfig.instructions).toBe("Changed while live");
    await runInAct(() => {
      promptSelect.value = "sample-prompt";
      promptSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(root.querySelector<HTMLTextAreaElement>("#live-prompt-editor")?.value).toBe(
      "Sample prompt",
    );
  });
});

describe("Interview Lab editors and execution panels", () => {
  type Execution = "realtime" | "cascade";
  const canStart: CombinationAvailability = { credentials: [], missingCredentials: [] };
  const catalogEntry = (conversation: string, execution: Execution) => ({
    id: `${conversation}-interview-${execution}`,
    version: 1,
    name: `${conversation} · ${execution}`,
    selection: {
      conversation: { id: `${conversation}-interview`, version: 1 },
      execution: { id: execution, version: 1 },
    },
    connectionProfiles: [execution === "cascade" ? cascadeMediaConnectionProfile : "realtime-v1"],
    inputContract: `${conversation}-interview-input/v1`,
    usage: [],
    warnings: [],
    availability: canStart,
  });
  const sixCombinations = (["realtime", "cascade"] as const).flatMap((execution) =>
    ["original", "goodbye", "questions"].map((conversation) =>
      catalogEntry(conversation, execution),
    ),
  );

  // Lab Worker's answer: two providers for each speech component, so a provider change shows. The
  // second speech input declares Gradium's turn rule.
  const cascadeProviders: LabCascadeProviderOptions = {
    speechInput: [
      {
        provider: "soniox",
        lists: { model: { values: ["stt-rt-v5", "stt-rt-v6"], default: "stt-rt-v5" } },
        numbers: {},
      },
      {
        provider: "second-stt",
        lists: {},
        numbers: {
          turnHorizon: { values: [0.5, 1, 2, 3], default: 2 },
          turnThreshold: { minimum: 0, maximum: 1, integer: false, default: 0.5 },
          turnSteps: { minimum: 1, maximum: 10, integer: true, default: 3 },
        },
      },
    ],
    languageModel: [
      {
        provider: "openai",
        lists: { model: { values: ["gpt-mini"], default: "gpt-mini" } },
        numbers: {},
      },
    ],
    speechOutput: [
      {
        provider: "soniox",
        lists: {
          model: { values: ["tts-rt-v2"], default: "tts-rt-v2" },
          voice: { values: ["Adrian", "Nina"], default: "Adrian" },
        },
        numbers: {},
      },
      {
        provider: "second-tts",
        lists: { voice: { values: ["Alto", "Bass"], default: "Bass" } },
        numbers: {},
      },
    ],
  };

  async function mountCombinations(
    selections = sixCombinations,
    providers: () => Promise<LabCascadeProviderOptions> = async () => cascadeProviders,
  ) {
    const root = document.createElement("div");
    document.body.append(root);
    const realtime = createControllableLabRealtimeClient();
    const cascade = createControllableLabRealtimeClient<LabCascadeClientConfig>();
    const providerLoads = vi.fn(providers);
    await mountLab({
      appRoot: root,
      labRunStore: createFakeLabRunStore(),
      labRealtimeClient: realtime.runtime,
      labCascadeClient: cascade.runtime,
      liveInterviewPrompts: createLabPromptOptions(),
      labConversationStore: { list: async () => ({ selections }) },
      labCascadeProviderOptionsStore: { load: providerLoads },
    });
    await flushPromises();
    const conversationSelect = () =>
      requiredElement(root, 'select[name="conversationSelection"]', HTMLSelectElement);
    const startButton = () =>
      requiredElement(root, '[data-testid="lab-start-interview"]', HTMLButtonElement);
    const setting = (name: string) =>
      requiredElement(root, `select[name="${name}"]`, HTMLSelectElement);
    return {
      root,
      realtime,
      cascade,
      providerLoads,
      startButton,
      offered: () => [...conversationSelect().options].map((option) => option.value),
      settingValues: (name: string) => [...setting(name).options].map((option) => option.value),
      settingValue: (name: string) => setting(name).value,
      async set(name: string, value: string) {
        await runInAct(() => {
          setting(name).value = value;
          setting(name).dispatchEvent(new Event("change", { bubbles: true }));
        });
      },
      settingNames: () =>
        [...root.querySelectorAll<HTMLSelectElement>(".run-settings select")].map(
          (select) => select.name,
        ),
      async choose(id: string) {
        await runInAct(() => {
          conversationSelect().value = id;
          conversationSelect().dispatchEvent(new Event("change", { bubbles: true }));
        });
      },
      async fill(selector: string, value: string) {
        const field = requiredElement(root, selector, HTMLElement);
        const prototype =
          field instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : HTMLTextAreaElement.prototype;
        await runInAct(() => {
          Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
          field.dispatchEvent(new Event("input", { bubbles: true }));
        });
      },
      async start() {
        await runInAct(() => startButton().click());
        await flushPromises();
      },
    };
  }

  it("offers exactly the catalog entries whose input format has an editor", async () => {
    const page = await mountCombinations([
      catalogEntry("original", "realtime"),
      { ...catalogEntry("original", "realtime"), id: "later", inputContract: "later-input/v1" },
      catalogEntry("questions", "cascade"),
    ]);
    expect(page.offered()).toEqual(["original-interview-realtime", "questions-interview-cascade"]);
    expect(page.root.querySelector('[data-testid="lab-missing-keys"]')).toBeNull();
  });

  it("disables the entries Runtime reports it cannot start and starts only one it can", async () => {
    const lacking = (entry: ReturnType<typeof catalogEntry>, missingCredentials: string[]) => ({
      ...entry,
      availability: {
        credentials: ["SONIOX_API_KEY", "CEREBRAS_API_KEY"],
        missingCredentials,
      },
    });
    const page = await mountCombinations([
      lacking(catalogEntry("original", "cascade"), ["SONIOX_API_KEY"]),
      catalogEntry("original", "realtime"),
      lacking(catalogEntry("goodbye", "cascade"), ["SONIOX_API_KEY", "CEREBRAS_API_KEY"]),
    ]);
    const options = () =>
      [
        ...requiredElement(page.root, 'select[name="conversationSelection"]', HTMLSelectElement)
          .options,
      ].map((option) => [option.value, option.disabled]);
    expect(options()).toEqual([
      ["original-interview-cascade", true],
      ["original-interview-realtime", false],
      ["goodbye-interview-cascade", true],
    ]);
    // One hint names each key a disabled entry lacks, once, and says how to add them.
    const hint =
      requiredElement(page.root, '[data-testid="lab-missing-keys"]', HTMLElement).textContent ?? "";
    expect(hint).toContain(addMissingKeys);
    expect(hint.replace(addMissingKeys, "").match(/\w+_API_KEY/gu)).toEqual([
      "SONIOX_API_KEY",
      "CEREBRAS_API_KEY",
    ]);
    // The first entry it can start is selected, and choosing one it cannot start changes nothing.
    await page.choose("goodbye-interview-cascade");
    await page.start();
    expect(page.cascade.startRequests).toEqual([]);
    expect(page.realtime.startRequests.map(({ runtimeConfig }) => runtimeConfig.selection)).toEqual(
      [catalogEntry("original", "realtime").selection],
    );
  });

  it("offers no Start when Runtime can start none of the entries", async () => {
    const page = await mountCombinations([
      {
        ...catalogEntry("original", "realtime"),
        availability: { credentials: ["OPENAI_API_KEY"], missingCredentials: ["OPENAI_API_KEY"] },
      },
    ]);
    expect(page.startButton().disabled).toBe(true);
  });

  it.each(["realtime", "cascade"] as const)(
    "edits Original on %s: its instructions and finish description, checked by its builder",
    async (execution) => {
      const page = await mountCombinations();
      const { realtime, cascade } = page;
      const client = execution === "realtime" ? realtime : cascade;
      await page.choose(`original-interview-${execution}`);
      expect(requiredElement(page.root, "#live-prompt-editor", HTMLTextAreaElement).value).toBe(
        "Sample prompt",
      );
      expect(page.root.querySelector("#live-closing-sentence")).toBeNull();
      expect(page.root.querySelector('[data-testid="maximum-goodbye-duration"]')).toBeNull();
      expect(page.root.querySelector("#live-question-0")).toBeNull();
      await page.fill("#live-prompt-editor", " ");
      expect(page.startButton().disabled).toBe(true);
      await page.fill("#live-prompt-editor", "Edited instructions");
      await page.fill("#live-finish-description", "");
      expect(page.startButton().disabled).toBe(true);
      await page.fill("#live-finish-description", "Edited finish description");
      await page.start();
      expect(realtime.startRequests.length + cascade.startRequests.length).toBe(1);
      const config = client.startRequests[0]?.runtimeConfig;
      expect(config).toMatchObject({
        instructions: "Edited instructions",
        finishInterviewDescription: "Edited finish description",
        maxDurationMs: 300_000,
        selection: catalogEntry("original", execution).selection,
      });
      expect(config).not.toHaveProperty("closingSentence");
      expect(config).not.toHaveProperty("questionPrompts");
    },
  );

  it.each(["realtime", "cascade"] as const)(
    "edits Goodbye on %s from its presets, keeps its draft and submits only complete input",
    async (execution) => {
      const page = await mountCombinations();
      const client = execution === "realtime" ? page.realtime : page.cascade;
      await page.choose(`goodbye-interview-${execution}`);
      expect(requiredElement(page.root, "#live-prompt-editor", HTMLTextAreaElement).value).toBe(
        goodbyeInterviewInstructions,
      );
      expect(
        requiredElement(page.root, "#live-finish-description", HTMLTextAreaElement).value,
      ).toBe(goodbyeFinishDescription);
      await page.fill("#live-closing-sentence", " ");
      expect(page.startButton().disabled).toBe(true);
      const exactGoodbye = `  ${defaultClosingSentence}  `;
      await page.fill("#live-closing-sentence", exactGoodbye);
      await page.choose(`original-interview-${execution}`);
      expect(page.root.querySelector("#live-closing-sentence")).toBeNull();
      await page.choose(`goodbye-interview-${execution}`);
      expect(requiredElement(page.root, "#live-closing-sentence", HTMLInputElement).value).toBe(
        exactGoodbye,
      );
      expect(
        requiredElement(page.root, '[data-testid="maximum-goodbye-duration"]', HTMLInputElement)
          .value,
      ).toBe("45");
      await page.fill('[data-testid="maximum-goodbye-duration"]', "12");
      await page.start();
      expect(client.startRequests[0]?.runtimeConfig).toMatchObject({
        maxDurationMs: 300_000,
        maximumClosingDurationMs: 12_000,
        instructions: goodbyeInterviewInstructions,
        finishInterviewDescription: goodbyeFinishDescription,
        closingSentence: exactGoodbye,
        selection: catalogEntry("goodbye", execution).selection,
      });
    },
  );

  it.each(["realtime", "cascade"] as const)(
    "edits Questions on %s: its question list, next_question description and Goodbye",
    async (execution) => {
      const page = await mountCombinations();
      const client = execution === "realtime" ? page.realtime : page.cascade;
      await page.choose(`questions-interview-${execution}`);
      expect(page.root.querySelector("#live-prompt-editor")).toBeNull();
      expect(requiredElement(page.root, "#live-question-0", HTMLTextAreaElement).value).toBe(
        questionPromptPresets[0],
      );
      await page.fill("#live-question-1", "");
      expect(page.startButton().disabled).toBe(true);
      await page.fill("#live-question-1", questionPromptPresets.at(1) ?? "");
      await page.fill("#live-next-question-description", " ");
      expect(page.startButton().disabled).toBe(true);
      await page.fill("#live-next-question-description", nextQuestionDescription);
      expect(page.root.querySelector('[data-testid="maximum-goodbye-duration"]')).not.toBeNull();
      await page.start();
      expect(client.startRequests[0]?.runtimeConfig).toMatchObject({
        instructions: questionPromptPresets[0],
        questionPrompts: questionPromptPresets,
        nextQuestionDescription,
        finishInterviewDescription: goodbyeFinishDescription,
        closingSentence: defaultClosingSentence,
        maximumClosingDurationMs: 45_000,
        selection: catalogEntry("questions", execution).selection,
      });
    },
  );

  it("shows the Realtime panel's settings for every Conversation and starts with them", async () => {
    const page = await mountCombinations();
    for (const conversation of ["original", "goodbye", "questions"]) {
      await page.choose(`${conversation}-interview-realtime`);
      expect(page.settingNames()).toEqual([
        "conversationSelection",
        "maxDurationMs",
        "realtimeModel",
        "reasoningEffort",
        "voice",
        "inputNoiseReduction",
        "semanticVadEagerness",
        "outputCapMode",
        "truncation",
      ]);
    }
    await page.fill("#output-token-cap", "0");
    expect(page.startButton().disabled).toBe(true);
    await page.fill("#output-token-cap", "512");
    await page.start();
    expect(page.cascade.startRequests).toEqual([]);
    const config = page.realtime.startRequests[0]?.runtimeConfig;
    expect(config).toMatchObject({
      reasoningEffort: "low",
      realtimeSettings: { model: "gpt-realtime-2.1", maxOutputTokens: 512 },
    });
    expect(config).not.toHaveProperty("cascadeSettings");
  });

  it("offers Cascade's providers for every Conversation and starts with today's sending no settings", async () => {
    const page = await mountCombinations();
    await page.fill("#output-token-cap", "0");
    for (const conversation of ["original", "goodbye", "questions"]) {
      await page.choose(`${conversation}-interview-cascade`);
      expect(page.settingNames()).toEqual([
        "conversationSelection",
        "maxDurationMs",
        "cascade.speechInput.provider",
        "cascade.speechInput.model",
        "cascade.languageModel.provider",
        "cascade.languageModel.model",
        "cascade.speechOutput.provider",
        "cascade.speechOutput.model",
        "cascade.speechOutput.voice",
      ]);
      expect(page.root.querySelector('select[name="promptId"]')).toBeNull();
    }
    expect(page.settingValues("cascade.speechOutput.provider")).toEqual(["soniox", "second-tts"]);
    expect(page.settingValue("cascade.speechOutput.voice")).toBe("Adrian");
    // A Realtime output limit left invalid does not hold back a Cascade start.
    await page.start();
    expect(page.realtime.startRequests).toEqual([]);
    const config = page.cascade.startRequests[0]?.runtimeConfig;
    expect(config).toMatchObject({
      reasoningEffort: "low",
      selection: catalogEntry("questions", "cascade").selection,
    });
    expect(config).not.toHaveProperty("realtimeSettings");
    expect(config?.cascadeSettings).toBeUndefined();
  });

  it("starts Cascade with the chosen providers, each new provider from its own defaults", async () => {
    const page = await mountCombinations();
    await page.choose("original-interview-cascade");
    await page.set("cascade.speechInput.model", "stt-rt-v6");
    await page.set("cascade.speechOutput.provider", "second-tts");
    // The second provider declares no model and its own voices, Bass by default.
    expect(page.root.querySelector('select[name="cascade.speechOutput.model"]')).toBeNull();
    expect(page.settingValues("cascade.speechOutput.voice")).toEqual(["Alto", "Bass"]);
    expect(page.settingValue("cascade.speechOutput.voice")).toBe("Bass");
    await page.set("cascade.speechOutput.voice", "Alto");
    await page.start();
    expect(page.cascade.startRequests[0]?.runtimeConfig.cascadeSettings).toEqual({
      speechInput: { provider: "soniox", model: "stt-rt-v6" },
      speechOutput: { provider: "second-tts", voice: "Alto" },
    });
  });

  it("offers the chosen speech input's turn rule from its defaults and starts with the values chosen", async () => {
    const page = await mountCombinations();
    await page.choose("original-interview-cascade");
    await page.set("cascade.speechInput.provider", "second-stt");
    expect(page.settingNames().slice(2, 6)).toEqual([
      "cascade.speechInput.provider",
      "cascade.speechInput.turnHorizon",
      "cascade.speechInput.turnThreshold",
      "cascade.speechInput.turnSteps",
    ]);
    expect(page.settingValues("cascade.speechInput.turnHorizon")).toEqual(["0.5", "1", "2", "3"]);
    expect(page.settingValues("cascade.speechInput.turnThreshold")).toEqual(
      Array.from({ length: 21 }, (_, step) => String(step / 20)),
    );
    expect(page.settingValues("cascade.speechInput.turnSteps")).toEqual(
      Array.from({ length: 10 }, (_, index) => String(index + 1)),
    );
    const turnValues = () =>
      ["turnHorizon", "turnThreshold", "turnSteps"].map((setting) =>
        page.settingValue(`cascade.speechInput.${setting}`),
      );
    expect(turnValues()).toEqual(["2", "0.5", "3"]);
    await page.set("cascade.speechInput.turnHorizon", "0.5");
    await page.set("cascade.speechInput.turnThreshold", "0.75");
    await page.set("cascade.speechInput.turnSteps", "6");
    expect(turnValues()).toEqual(["0.5", "0.75", "6"]);
    // Another speech input hides the turn rule; choosing it again starts from its defaults.
    await page.set("cascade.speechInput.provider", "soniox");
    expect(page.root.querySelector('select[name="cascade.speechInput.turnHorizon"]')).toBeNull();
    await page.set("cascade.speechInput.provider", "second-stt");
    expect(turnValues()).toEqual(["2", "0.5", "3"]);
    await page.set("cascade.speechInput.turnThreshold", "0.9");
    await page.set("cascade.speechInput.turnSteps", "1");
    await page.start();
    expect(page.cascade.startRequests[0]?.runtimeConfig.cascadeSettings).toEqual({
      speechInput: { provider: "second-stt", turnHorizon: 2, turnThreshold: 0.9, turnSteps: 1 },
    });
  });

  it("loads Cascade's providers only for a catalog with a Cascade entry", async () => {
    const page = await mountCombinations([catalogEntry("original", "realtime")]);
    expect(page.providerLoads).not.toHaveBeenCalled();
  });

  it("starts Cascade with today's providers when its providers cannot load", async () => {
    const page = await mountCombinations(sixCombinations, async () => {
      throw new Error("Interview Lab Worker request failed with status 503.");
    });
    await page.choose("original-interview-cascade");
    expect(page.settingNames()).toEqual(["conversationSelection", "maxDurationMs"]);
    expect(page.root.querySelector('.run-settings [role="alert"]')).not.toBeNull();
    await page.start();
    expect(page.cascade.startRequests[0]?.runtimeConfig.cascadeSettings).toBeUndefined();
  });

  it("shows the credential a Start was refused for", async () => {
    const page = await mountCombinations();
    await page.choose("original-interview-cascade");
    await page.start();
    await runInAct(() =>
      page.cascade.emitStatus({
        phase: "failed",
        failureKind: "setup",
        label: "Interview Failed",
        detail: "The experiment records contain the authoritative Runtime outcome.",
        startRefusal: "missing_credentials:GRADIUM_API_KEY",
      }),
    );
    await flushPromises();
    const status = requiredElement(page.root, '[role="status"]', HTMLElement);
    expect(status.textContent).toContain("missing_credentials:GRADIUM_API_KEY");
  });
});

describe("Interview Lab runtime behavior contract", () => {
  it("uses accepted state deadlines without resetting a shared timer or ending locally at zero", async () => {
    const root = document.createElement("div");
    const { runtime, emitStatus } = createControllableLabRealtimeClient();
    await mountLab({
      appRoot: root,
      labRunStore: createFakeLabRunStore(),
      labRealtimeClient: runtime,
      liveInterviewPrompts: createLabPromptOptions(),
    });
    await runInAct(() => root.querySelector<HTMLButtonElement>(".primary-button")?.click());
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      const publish = async (state: string, deadlineAt: number | null) =>
        runInAct(() =>
          emitStatus({
            phase: "live",
            label: "Live",
            detail: "",
            conversation: { state, deadlineAt },
          }),
        );
      await publish("question-one", 160_000);
      expect(root.querySelector('[data-testid="interview-countdown"]')?.textContent).toBe(
        "60 seconds remaining",
      );
      await runInAct(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await publish("question-two", 160_000);
      expect(root.querySelector('[data-testid="interview-countdown"]')?.textContent).toBe(
        "50 seconds remaining",
      );
      await publish("untimed", null);
      expect(root.querySelector('[data-testid="interview-countdown"]')).toBeNull();
      await publish("goodbye", 155_000);
      expect(root.querySelector('[data-testid="interview-countdown"]')?.textContent).toBe(
        "45 seconds remaining",
      );
      await runInAct(async () => {
        await vi.advanceTimersByTimeAsync(45_000);
      });
      expect(root.querySelector('[data-testid="interview-countdown"]')?.textContent).toBe(
        "0 seconds remaining",
      );
      expect(root.querySelector('[data-testid="conversation-state"]')?.textContent).toBe("goodbye");
      expect(
        requiredElement(root, '[data-testid="lab-finish-interview"]', HTMLButtonElement).disabled,
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not mark the Lab Interview live until the runtime reports live", async () => {
    const root = document.createElement("div");
    const { emitStatus, runtime } = createDeferredLiveLabRealtimeClient();

    await mountLab({
      appRoot: root,
      labRunStore: createFakeLabRunStore(),
      runtimeDiagnosticsStore: createFakeRuntimeDiagnosticsStore(),
      labRealtimeClient: runtime,
      liveInterviewPrompts: createLabPromptOptions(),
    });

    await Promise.resolve();
    await Promise.resolve();

    await runInAct(() => root.querySelector<HTMLButtonElement>(".primary-button")?.click());
    await flushPromises();

    expect(root.querySelector(".live-status-label")?.textContent).toBe("Starting");
    expect(root.querySelector<HTMLButtonElement>(".primary-button")?.disabled).toBe(true);

    await runInAct(() => {
      emitStatus({
        phase: "live",
        label: "Live",
        detail: "The Interview is live.",
      });
    });

    expect(root.querySelector(".live-status-label")?.textContent).toBe("Live");
  });

  it("persists an asynchronous setup failure after explicit start as runtime failed", async () => {
    const root = document.createElement("div");
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_010_000);
    const labRunStore = createFakeLabRunStore();
    const { emitStatus, runtime } = createDeferredLiveLabRealtimeClient();

    try {
      await mountLab({
        appRoot: root,
        labRunStore,
        runtimeDiagnosticsStore: createFakeRuntimeDiagnosticsStore(),
        labRealtimeClient: runtime,
        liveInterviewPrompts: createLabPromptOptions(),
      });

      await Promise.resolve();
      await Promise.resolve();

      await runInAct(() => root.querySelector<HTMLButtonElement>(".primary-button")?.click());
      await flushPromises();

      await runInAct(() => {
        emitStatus({
          phase: "failed",
          label: "Could Not Start Interview",
          detail: "The Interview did not reach a usable live state.",
          failureKind: "setup",
          errorText: "Provider/signaling failed: sideband could not attach.",
        });
      });
      await flushPromises();

      expect(labRunStore.recordSetupFailureEnd).toHaveBeenCalledWith({
        runId: "lab-interview",
        endedAt: 1_700_000_010_000,
      });
      expect(root.textContent).toContain("Could Not Start Interview");
    } finally {
      now.mockRestore();
    }
  });

  it.each(["runtime", "ending"] as const)(
    "does not use setup-failure persistence for a post-setup %s failure",
    async (failureKind) => {
      const root = document.createElement("div");
      const labRunStore = createFakeLabRunStore();
      const { emitStatus, runtime } = createDeferredLiveLabRealtimeClient();

      await mountLab({
        appRoot: root,
        labRunStore,
        runtimeDiagnosticsStore: createFakeRuntimeDiagnosticsStore(),
        labRealtimeClient: runtime,
        liveInterviewPrompts: createLabPromptOptions(),
      });

      await Promise.resolve();
      await Promise.resolve();

      await runInAct(() => root.querySelector<HTMLButtonElement>(".primary-button")?.click());
      await flushPromises();
      await runInAct(() => {
        emitStatus({
          phase: "live",
          label: "Live",
          detail: "The Interview is live.",
        });
      });

      if (failureKind === "ending") {
        await runInAct(() => {
          emitStatus({
            phase: "ending",
            label: "Ending Interview",
            detail: "Lab is finalizing the Interview.",
          });
        });
      }

      await runInAct(() => {
        emitStatus({
          phase: "failed",
          label: "Interview Failed",
          detail: "The Runtime failed after setup.",
          failureKind,
        });
      });
      await flushPromises();

      expect(labRunStore.recordSetupFailureEnd).not.toHaveBeenCalled();
    },
  );

  it("does not start participation after the view is replaced during cancellation", async () => {
    const root = document.createElement("div");
    const first = createDeferredLiveLabRealtimeClient();
    const start = vi.fn(first.runtime.start.bind(first.runtime));
    const dependencies = {
      appRoot: root,
      labRunStore: createFakeLabRunStore(),
      liveInterviewPrompts: createLabPromptOptions(),
    };
    await mountLab({ ...dependencies, labRealtimeClient: { start } });
    const replacement = createDeferredLiveLabRealtimeClient();
    await runInAct(() => {
      root.querySelector<HTMLButtonElement>('[data-testid="lab-start-interview"]')?.click();
      mountInterviewLab({ ...dependencies, labRealtimeClient: replacement.runtime });
    });
    await flushPromises();
    expect(start).not.toHaveBeenCalled();
    expect(
      root.querySelector('[data-testid="lab-interview"]')?.getAttribute("data-runtime-phase"),
    ).toBe("setup");
  });

  it("ignores an old setup failure after its storage reply arrives in a replacement view", async () => {
    const root = document.createElement("div");
    let release = () => {};
    const storageReply = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recordSetupFailureEnd = vi.fn(async () => storageReply);
    await mountLab({
      appRoot: root,
      labRunStore: { ...createFakeLabRunStore(), recordSetupFailureEnd },
      liveInterviewPrompts: createLabPromptOptions(),
      labRealtimeClient: {
        async start(request) {
          request.onRunAllocated?.({ runId: "lab-interview", startedAt: 1_700_000_000_000 });
          throw new Error("lost Start reply");
        },
      },
    });
    await runInAct(() =>
      root.querySelector<HTMLButtonElement>('[data-testid="lab-start-interview"]')?.click(),
    );
    await flushPromises();
    expect(recordSetupFailureEnd).toHaveBeenCalledOnce();
    const replacement = createDeferredLiveLabRealtimeClient();
    await mountLab({
      appRoot: root,
      labRunStore: createFakeLabRunStore(),
      liveInterviewPrompts: createLabPromptOptions(),
      labRealtimeClient: replacement.runtime,
    });
    await runInAct(() =>
      root.querySelector<HTMLButtonElement>('[data-testid="lab-start-interview"]')?.click(),
    );
    await flushPromises();
    await runInAct(() =>
      replacement.emitStatus({ phase: "live", label: "Live", detail: "The Interview is live." }),
    );
    await runInAct(release);
    await flushPromises();
    expect(
      root.querySelector('[data-testid="lab-interview"]')?.getAttribute("data-runtime-phase"),
    ).toBe("live");
    await runInAct(() =>
      root.querySelector<HTMLButtonElement>('[data-testid="lab-finish-interview"]')?.click(),
    );
    await flushPromises();
    expect(
      root.querySelector('[data-testid="lab-interview"]')?.getAttribute("data-runtime-phase"),
    ).toBe("ended");
  });

  it.each(["resolved", "rejected"] as const)(
    "ignores an old %s End reply after the Lab view is replaced",
    async (disposition) => {
      const root = document.createElement("div");
      const first = createDeferredLiveLabRealtimeClient();
      let release = () => {};
      const ending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const delayedRuntime: LabRealtimeClient = {
        async start(request) {
          const session = await first.runtime.start(request);
          const complete = session.complete.bind(session);
          session.complete = async (reason) => {
            await ending;
            if (disposition === "rejected") throw new Error("lost End reply");
            return complete(reason);
          };
          return session;
        },
      };
      const dependencies = {
        appRoot: root,
        labRunStore: createFakeLabRunStore(),
        liveInterviewPrompts: createLabPromptOptions(),
      };
      await mountLab({ ...dependencies, labRealtimeClient: delayedRuntime });
      await runInAct(() =>
        root.querySelector<HTMLButtonElement>('[data-testid="lab-start-interview"]')?.click(),
      );
      await flushPromises();
      await runInAct(() =>
        first.emitStatus({ phase: "live", label: "Live", detail: "The Interview is live." }),
      );
      await runInAct(() =>
        root.querySelector<HTMLButtonElement>('[data-testid="lab-finish-interview"]')?.click(),
      );

      const replacement = createDeferredLiveLabRealtimeClient();
      await mountLab({ ...dependencies, labRealtimeClient: replacement.runtime });
      await runInAct(() =>
        root.querySelector<HTMLButtonElement>('[data-testid="lab-start-interview"]')?.click(),
      );
      await flushPromises();
      await runInAct(() =>
        replacement.emitStatus({ phase: "live", label: "Live", detail: "The Interview is live." }),
      );
      await runInAct(release);
      await flushPromises();
      expect(
        root.querySelector('[data-testid="lab-interview"]')?.getAttribute("data-runtime-phase"),
      ).toBe("live");
      await runInAct(() =>
        root.querySelector<HTMLButtonElement>('[data-testid="lab-finish-interview"]')?.click(),
      );
      await flushPromises();
      expect(
        root.querySelector('[data-testid="lab-interview"]')?.getAttribute("data-runtime-phase"),
      ).toBe("ended");
    },
  );

  it("opens Transcript review after manual stop completes with transcript evidence", async () => {
    const root = document.createElement("div");
    const interview = createReadableTranscriptInterview();
    const listLabRuns = vi
      .fn<LabRunStore["listLabRuns"]>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([interview]);
    const getLabRun = vi.fn<LabRunStore["getLabRun"]>().mockResolvedValue(interview);
    const { emitStatus, runtime } = createDeferredLiveLabRealtimeClient({
      completeTurnCount: 1,
    });

    await mountLab({
      appRoot: root,
      labRunStore: {
        ...createFakeLabRunStore(),
        listLabRuns,
        getLabRun,
      },
      runtimeDiagnosticsStore: createFakeRuntimeDiagnosticsStore(),
      labRealtimeClient: runtime,
      liveInterviewPrompts: createLabPromptOptions(),
    });

    await Promise.resolve();
    await Promise.resolve();

    await runInAct(() => root.querySelector<HTMLButtonElement>(".primary-button")?.click());
    await flushPromises();
    await runInAct(() => {
      emitStatus({
        phase: "live",
        label: "Live",
        detail: "The Interview is live.",
      });
    });

    await runInAct(() => root.querySelector<HTMLButtonElement>(".secondary-button")?.click());
    await flushPromises();

    expect(root.querySelectorAll<HTMLButtonElement>(".tab")[1]?.getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(root.textContent).toContain("It worked.");
    expect(listLabRuns).toHaveBeenCalledTimes(2);
    // Voice verification reads the saved Run after the view leaves Live Interview.
    expect(
      root.querySelector('[data-testid="lab-interview"]')?.getAttribute("data-live-run-id"),
    ).toBe("lab-interview");
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

function createLabPromptOptions(): LabPromptOption[] {
  return [
    createLabPromptOption("sample-prompt", "sample-prompt.md", "Sample prompt"),
    createLabPromptOption("short-form", "short-form.md", "Short-form prompt"),
  ];
}

function createLabPromptOptionsWithSecondFileFirst(): LabPromptOption[] {
  return [
    createLabPromptOption("second-prompt", "second-prompt.md", "Second prompt"),
    createLabPromptOption("short-form", "short-form.md", "Short-form prompt"),
  ];
}

function createLabPromptOption(id: string, fileName: string, content: string): LabPromptOption {
  return {
    id,
    fileName,
    content,
    provenance: createInterviewPromptProvenance({
      promptId: id,
      content,
    }),
  };
}

function createReadableTranscriptInterview(): LabRunDetail {
  return {
    runId: "transcript-run",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_010_000,
    outcome: "ended",
    endReason: "participant_stopped",
    transcriptTurnCount: 1,
    transcript: {
      turns: [
        {
          role: "participant",
          text: "It worked.",
        },
      ],
    },
  };
}

async function flushPromises(): Promise<void> {
  await runInAct(() => undefined);
}

function createDelayedTranscriptReads() {
  const runA: LabRunDetail = {
    ...createReadableTranscriptInterview(),
    runId: "run-a",
    transcript: { turns: [{ role: "participant", text: "Transcript from run A." }] },
  };
  const runB: LabRunDetail = {
    ...createReadableTranscriptInterview(),
    runId: "run-b",
    transcript: { turns: [{ role: "participant", text: "Transcript from run B." }] },
  };
  const list = [runA, runB].map(({ runId, startedAt, transcriptTurnCount }) => ({
    runId,
    startedAt,
    transcriptTurnCount,
  }));
  let delayList = false;
  let delayDetails = false;
  let resolveList: (response: Response) => void = () => {
    throw new Error("Expected the Transcript list request to be pending.");
  };
  let resolveFirst: (response: Response) => void = () => {
    throw new Error("Expected the first Transcript request to be pending.");
  };
  let resolveSecond: (response: Response) => void = () => {
    throw new Error("Expected the second Transcript request to be pending.");
  };
  const store = createWorkerLabRunStore("https://lab.example", {
    fetchImpl: async (input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      if (path === "/_api/runs") {
        if (!delayList) return Response.json(list);
        return await new Promise<Response>((resolve) => {
          resolveList = resolve;
        });
      }
      if (path === "/_api/runs/run-a") {
        if (!delayDetails) return Response.json(runA);
        return await new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }
      if (path === "/_api/runs/run-b") {
        return await new Promise<Response>((resolve) => {
          resolveSecond = resolve;
        });
      }
      throw new Error(`Unexpected Lab request: ${path}`);
    },
  });

  return {
    store,
    delayList() {
      delayList = true;
    },
    delayDetails() {
      delayDetails = true;
    },
    settleList() {
      resolveList(Response.json(list));
    },
    settleFirst(result: "success" | "failure") {
      resolveFirst(
        result === "success"
          ? Response.json(runA)
          : Response.json({ error: "Run A is unavailable." }, { status: 503 }),
      );
    },
    settleSecond() {
      resolveSecond(Response.json(runB));
    },
  };
}

function createFakeLabRunStore(): LabRunStore {
  return {
    createLabRun: vi.fn().mockResolvedValue({
      runId: "lab-interview",
      startedAt: 1_700_000_000_000,
    }),
    recordSetupFailureEnd: vi.fn().mockResolvedValue(undefined),
    listLabRuns: vi.fn().mockResolvedValue([]),
    getLabRun: vi.fn().mockResolvedValue(null),
  };
}

function createFakeRuntimeDiagnosticsStore(): RuntimeDiagnosticsStore {
  return {
    recordProviderCall: vi.fn().mockResolvedValue(undefined),
    recordSetupFailure: vi.fn().mockResolvedValue(undefined),
    recordSettingsSummary: vi.fn().mockResolvedValue(undefined),
    recordCompletionDiagnostics: vi.fn().mockResolvedValue(undefined),
    recordLiveDegradation: vi.fn().mockResolvedValue(undefined),
    recordEndingStarted: vi.fn().mockResolvedValue(undefined),
    recordFinalTurnFlushFinished: vi.fn().mockResolvedValue(undefined),
    appendRuntimeEvents: vi.fn().mockResolvedValue(undefined),
    getRunDiagnostics: vi.fn().mockResolvedValue(null),
    listRuntimeEvents: vi.fn().mockResolvedValue([]),
  };
}

function createPendingStartLabRealtimeClient(): LabRealtimeClient {
  return {
    start: vi.fn(() => new Promise<never>(() => {})),
  };
}

function createControllableLabRealtimeClient<
  Config extends LabInterviewConfig = LabRealtimeClientConfig,
>() {
  let statusListener: LabInterviewStartRequest<Config>["onStatus"];
  let currentStatus: LabInterviewStatus = {
    phase: "setup",
    label: "Ready",
    detail: "Start a local Interview when you are ready.",
  };
  const startRequests: LabInterviewStartRequest<Config>[] = [];

  const runtime: LabInterviewClient<Config> = {
    async start(request) {
      startRequests.push(request);
      statusListener = request.onStatus;
      request.onRunAllocated?.({
        runId: "lab-interview",
        startedAt: 1_700_000_000_000,
      });
      currentStatus = {
        phase: "live",
        label: "Live",
        detail: "The Interview is live.",
      };
      statusListener?.(currentStatus);

      return {
        handle: {
          runId: "lab-interview",
          startedAt: 1_700_000_000_000,
        },
        getStatus() {
          return currentStatus;
        },
        subscribe() {
          return () => {};
        },
        async complete() {
          currentStatus = {
            phase: "ended",
            label: "Ended",
            detail: "The Interview has ended.",
            endStatus: "ended",
          };

          return {
            runId: "lab-interview",
            endedAt: 1_700_000_030_000,
            endStatus: "ended",
            transcriptEvidence: {
              transcript: {
                turns: [],
              },
              turnCount: 0,
            },
          };
        },
        async cancel(reason = "Cancelled by the test.") {
          currentStatus = {
            phase: "ended",
            label: "Cancelled",
            detail: reason,
            endStatus: "cancelled",
          };

          return {
            runId: "lab-interview",
            endedAt: 1_700_000_030_000,
            endStatus: "cancelled",
            transcriptEvidence: {
              transcript: {
                turns: [],
              },
              turnCount: 0,
            },
            debugText: reason,
          };
        },
        getTranscriptEvidence() {
          return {
            transcript: {
              turns: [],
            },
            turnCount: 0,
          };
        },
      };
    },
  };

  return {
    emitStatus(status: LabInterviewStatus) {
      currentStatus = status;
      statusListener?.(status);
    },
    startRequests,
    runtime,
  };
}

function createDeferredLiveLabRealtimeClient(options: { completeTurnCount?: number } = {}) {
  let statusListener: Parameters<LabRealtimeClient["start"]>[0]["onStatus"];
  let currentStatus: LabInterviewStatus = {
    phase: "setup",
    label: "Ready",
    detail: "Start a local Interview when you are ready.",
  };

  const runtime: LabRealtimeClient = {
    async start(request) {
      statusListener = request.onStatus;
      request.onRunAllocated?.({
        runId: "lab-interview",
        startedAt: 1_700_000_000_000,
      });
      currentStatus = {
        phase: "setup",
        label: "Opening Transcript Capture",
        detail: "Lab is attaching Transcript capture to the live Interview.",
      };
      statusListener?.(currentStatus);

      return {
        handle: {
          runId: "lab-interview",
          startedAt: 1_700_000_000_000,
        },
        getStatus() {
          return currentStatus;
        },
        subscribe() {
          return () => {};
        },
        async complete() {
          currentStatus = {
            phase: "ended",
            label: "Ended",
            detail: "The Interview has ended.",
            endStatus: "ended",
          };

          return {
            runId: "lab-interview",
            endedAt: 1_700_000_030_000,
            endStatus: "ended",
            transcriptEvidence: {
              transcript: {
                turns: [],
              },
              turnCount: options.completeTurnCount ?? 0,
            },
          };
        },
        async cancel(reason = "Cancelled by the test.") {
          currentStatus = {
            phase: "ended",
            label: "Cancelled",
            detail: reason,
            endStatus: "cancelled",
          };

          return {
            runId: "lab-interview",
            endedAt: 1_700_000_030_000,
            endStatus: "cancelled",
            transcriptEvidence: {
              transcript: {
                turns: [],
              },
              turnCount: 0,
            },
            debugText: reason,
          };
        },
        getTranscriptEvidence() {
          return {
            transcript: {
              turns: [],
            },
            turnCount: options.completeTurnCount ?? 0,
          };
        },
      };
    },
  };

  return {
    emitStatus(status: LabInterviewStatus) {
      currentStatus = status;
      statusListener?.(status);
    },
    runtime,
  };
}

function requiredElement<T extends HTMLElement>(
  root: HTMLElement,
  selector: string,
  type: { new (): T },
): T {
  const element = root.querySelector(selector);
  if (!(element instanceof type)) throw new Error(`Missing ${selector}`);
  return element;
}
