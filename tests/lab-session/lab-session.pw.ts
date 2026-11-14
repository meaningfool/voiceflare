import { defaultFinishInterviewDescription } from "../../src/apps/lab/content/presets.ts";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

const prompt = await readFile(
  new URL("../lab-content/prompts/interview.md", import.meta.url),
  "utf8",
);
let runId = "controlled-lab-experiment";
const startedAt = 1_800_000_000_000;

async function installNativeMedia(page: Page) {
  await page.addInitScript(String.raw`(() => {
    const audio = new AudioContext();
    const microphone = audio.createMediaStreamDestination().stream;
    const playback = audio.createMediaStreamDestination().stream;
    const track = microphone.getAudioTracks()[0];
    if (track === undefined) throw new Error("Missing controlled native microphone track");
    const stop = track.stop.bind(track);
    track.stop = () => {
      stop();
      document.documentElement.dataset.microphoneStopped = "true";
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => microphone },
    });
    class Peer extends EventTarget {
      addTrack() {}
      createDataChannel() {
        return Object.assign(new EventTarget(), { readyState: "open" });
      }
      async createOffer() {
        return { type: "offer", sdp: "v=0\r\ncontrolled-lab-offer" };
      }
      async setLocalDescription() {}
      async setRemoteDescription() {
        document.documentElement.dataset.answerApplied = "true";
        this.dispatchEvent(Object.assign(new Event("track"), { streams: [playback] }));
        window.testLateTrack = () => this.dispatchEvent(Object.assign(new Event("track"), { streams: [playback] }));
      }
      close() {
        document.documentElement.dataset.peerClosed = "true";
        playback.getTracks().forEach((item) => item.stop());
        void audio.close();
      }
    }
    Object.defineProperty(window, "RTCPeerConnection", { configurable: true, value: Peer });
  })()`);
}

async function controlLab(page: Page, failure = false, retryStart = false, loseReplies = false) {
  let allocated = false;
  let startupPermitted = false;
  let finishingDeadlineAt: number | null = null;
  let endingAccepted = false;
  let completedReason: "participant_stopped" | "agent_requested_end" = "participant_stopped";
  let endAcknowledgement: Promise<void> | null = null;
  let acknowledgeEnd = () => {};
  let endRequested = false;
  let terminal = false;
  let startRequests = 0;
  let mediaReadyRequests = 0;
  let terminalReads = 0;
  let firstStartBody: string | null = null;
  const endReasons: string[] = [];
  const unexpected: string[] = [];
  const terminalResult = () => ({
    runId,
    endedAt: startedAt + 1000,
    runtimeUsage: { completeness: "complete", observations: [] },
    ...(failure
      ? { outcome: "failed_to_start" }
      : {
          outcome: "completed",
          reason: completedReason,
          liveAt: startedAt + 1,
          transcriptSnapshot: { revision: 1, digest: `sha256:${"a".repeat(64)}`, turnCount: 0 },
          transcriptCompleteness: "complete",
          transcriptIncompleteReasons: [],
        }),
  });
  const record = () => {
    const base = { runId, startedAt, transcriptTurnCount: 0 };
    if (!terminal) return base;
    return {
      ...base,
      endedAt: startedAt + 1000,
      outcome: failure ? "failed" : "ended",
      endReason: failure ? "runtime_failed" : completedReason,
    };
  };
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/_api/")) return route.continue();
    expect(url.origin).toBe(new URL(test.info().project.use.baseURL ?? "").origin);
    expect(request.headers()["authorization"]).toBeUndefined();
    const json = <Body>(body: Body, status = 200, headers = {}) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers,
        body: JSON.stringify(body),
      });
    if (url.pathname === "/_api/conversation-selections")
      return json({
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
      });
    if (url.pathname === "/_api/prompts")
      return json([{ id: "interview", fileName: "interview.md", content: prompt }]);
    if (url.pathname === "/_api/runtime/runs") {
      startRequests += 1;
      const body = z
        .object({
          profile: z.literal("realtime-v1"),
          attemptId: z.string().uuid(),
          connection: z.object({
            exchangeId: z.string().uuid(),
            input: z.object({ sdp: z.string() }),
          }),
          selection: z.object({
            conversation: z.object({ id: z.literal("original-interview"), version: z.literal(1) }),
            execution: z.object({ id: z.literal("realtime"), version: z.literal(1) }),
          }),
          agentInput: z.object({
            interviewingDurationMs: z.number(),
            contract: z.literal("original-interview-input/v1"),
            interviewing: z.object({
              instructions: z.object({ kind: z.literal("literal"), text: z.string() }),
              toolDescriptions: z.object({ finish_interview: z.string() }),
            }),
          }),
          reasoningEffort: z.string(),
          promptProvenance: z.object({ promptId: z.string(), contentHash: z.string() }),
          executionSettings: z.object({ model: z.string() }),
        })
        .parse(request.postDataJSON());
      runId = `lab_${body.attemptId}`;
      allocated = true;
      expect(body.connection.input.sdp).toBe("v=0\r\ncontrolled-lab-offer");
      expect(body.agentInput.interviewing.instructions.text).toBe(prompt);
      expect(body.agentInput.interviewing.toolDescriptions.finish_interview).toBe(
        defaultFinishInterviewDescription,
      );
      expect(body.agentInput.interviewingDurationMs).toBe(60000);
      expect(body.reasoningEffort).toBe("low");
      expect(body.promptProvenance.promptId).toBe("interview");
      if (loseReplies) return route.abort("failed");
      if (retryStart) {
        if (firstStartBody === null) {
          firstStartBody = request.postData();
          return route.abort("failed");
        }
        expect(request.postData()).toBe(firstStartBody);
      }
      return json(
        {
          runId,
          exchangeId: body.connection.exchangeId,
          acceptance: "accepted",
          reply: { sdp: "v=0\r\ncontrolled-lab-answer" },
          diagnostics: { sessionId: "rtc_controlled_lab" },
        },
        200,
        { "X-Lab-Run-Id": runId, "X-Lab-Run-Started-At": String(startedAt) },
      );
    }
    if (url.pathname === `/_api/runtime/runs/${runId}/startup`) {
      if (failure) terminal = true;
      return json({
        runId,
        disposition: failure ? "failed" : startupPermitted ? "succeeded" : "pending",
        decidedAt: failure || startupPermitted ? startedAt + 1 : null,
        reason: failure ? "runtime_failed" : startupPermitted ? "readiness_confirmed" : null,
        stopRequired: failure,
      });
    }
    if (url.pathname === "/_api/runtime/events") {
      expect(url.searchParams.get("runId")).toBe(runId);
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `retry: 100\n\nevent: session.control_sent\ndata: {}\n\n${finishingDeadlineAt === null ? "" : `event: runtime.conversation_state\ndata: ${JSON.stringify({ state: "finishing", deadlineAt: finishingDeadlineAt })}\n\n`}${endingAccepted ? 'event: runtime.ending\ndata: {"endReason":"agent_requested_end","strategy":"hard_stop"}\n\nevent: session.provider_event\ndata: {"type":"output_audio_buffer.started"}\n\n' : ""}${endRequested && terminal ? "event: runtime.controller_completed\ndata: {}\n\n" : ""}`,
      });
    }
    if (url.pathname === `/_api/runtime/runs/${runId}/media-ready`) {
      mediaReadyRequests += 1;
      expect(request.method()).toBe("POST");
      return json({ ok: true });
    }
    if (url.pathname === "/_api/runtime/presence") {
      expect(url.searchParams.get("runId")).toBe(runId);
      return json({ ok: true });
    }
    if (url.pathname === `/_api/runtime/runs/${runId}/complete`) {
      const body = z.object({ endReason: z.string() }).parse(request.postDataJSON());
      endReasons.push(body.endReason);
      endRequested = true;
      if (endAcknowledgement !== null) await endAcknowledgement;
      return json({ ok: true });
    }
    if (url.pathname === "/_api/runs") return json(allocated ? [record()] : []);
    if (url.pathname === `/_api/runs/${runId}`) {
      if (terminal) terminalReads += 1;
      const detail = { ...record(), transcript: { turns: [] }, responseUsage: [] };
      return json(terminal ? { ...detail, terminalResult: terminalResult() } : detail);
    }
    // Browser diagnostic writes are not terminal evidence.
    if (url.pathname.startsWith(`/_api/runs/${runId}/`) && request.method() !== "GET")
      return json({ ok: true, stored: true, reason: "lab", storedCount: 1 });
    if (url.pathname.startsWith(`/_api/runs/${runId}/`)) return json([]);
    unexpected.push(`${request.method()} ${url.pathname}`);
    return json({ error: "unexpected_controlled_request" }, 501);
  });
  await installNativeMedia(page);
  await page.goto("/");
  await expect(page.locator("#live-prompt-editor")).toHaveValue(prompt);
  await expect(page.locator("#live-finish-description")).toHaveValue(
    defaultFinishInterviewDescription,
  );
  await page.locator('[data-lab-run-setting="maxDurationMs"]').click();
  await page.locator('[data-lab-setting-option="60000"]').click();
  return {
    permitStartup: () => {
      startupPermitted = true;
    },
    beginFinishing: () => {
      finishingDeadlineAt = Date.now() + 10_000;
    },
    acceptEnding: () => {
      completedReason = "agent_requested_end";
      endingAccepted = true;
    },
    holdEndAcknowledgement: () => {
      endAcknowledgement = new Promise<void>((resolve) => {
        acknowledgeEnd = resolve;
      });
    },
    acknowledgeEnd: () => acknowledgeEnd(),
    commitOutcome: () => {
      terminal = true;
    },
    starts: () => startRequests,
    readiness: () => mediaReadyRequests,
    terminalReads: () => terminalReads,
    endReasons,
    unexpected,
  };
}

test("Lab waits for authoritative startup then ends the same experiment and releases native resources", async ({
  page,
}) => {
  const controls = await controlLab(page, false, true);
  await page.getByTestId("lab-start-interview").click();
  await expect.poll(controls.readiness).toBe(1);
  await expect(page.locator("html")).toHaveAttribute("data-answer-applied", "true");
  await expect(page.getByTestId("lab-interview")).toHaveAttribute("data-runtime-phase", "setup");
  controls.permitStartup();
  await expect(page.getByTestId("lab-interview")).toHaveAttribute("data-runtime-phase", "live");
  controls.beginFinishing();
  await expect(page.getByTestId("conversation-state")).toHaveText("finishing");
  await expect(page.getByTestId("lab-interview")).toHaveAttribute("data-runtime-phase", "live");
  await expect(page.locator("html")).toHaveAttribute("data-microphone-stopped", "true");
  await expect(page.locator("audio")).toHaveCount(1);
  controls.holdEndAcknowledgement();
  await page.getByTestId("lab-finish-interview").click();
  await expect(page.locator("html")).toHaveAttribute("data-microphone-stopped", "true");
  await expect(page.locator("audio")).toHaveCount(0);
  await expect.poll(() => controls.endReasons).toEqual(["participant_stopped"]);
  await expect(page.getByTestId("lab-interview")).toHaveAttribute("data-runtime-phase", "ending");
  const participationStatus = page.getByRole("status");
  await expect(participationStatus).toContainText("Thank you");
  const finishedPresentation = await participationStatus.textContent();
  await expect(page.locator("html")).not.toHaveAttribute("data-peer-closed", "true");
  expect(controls.terminalReads()).toBe(0);
  controls.acknowledgeEnd();
  await page.evaluate("window.testLateTrack()");
  await expect(page.locator("audio")).toHaveCount(0);
  controls.commitOutcome();
  await expect(page.getByTestId("lab-interview")).toHaveAttribute("data-runtime-phase", "ended");
  await expect(participationStatus).toHaveText(finishedPresentation ?? "");
  await expect(page.locator("html")).toHaveAttribute("data-peer-closed", "true");
  await page.getByTestId("lab-transcripts-tab").click();
  await page.locator(`[data-run-id="${runId}"]`).click();
  await expect(page.locator(`[data-run-id="${runId}"]`)).toHaveAttribute("aria-pressed", "true");
  await expect.poll(controls.terminalReads).toBeGreaterThan(0);
  await expect(page.getByTestId("lab-terminal-outcome")).toHaveAttribute(
    "data-runtime-outcome",
    "completed",
  );
  expect(controls.endReasons).toContain("participant_stopped");
  expect(controls.starts()).toBe(2);
  expect(controls.unexpected).toEqual([]);
});

test("accepted Ending discards Lab playback and holds the provider call until final result delivery", async ({
  page,
}) => {
  const controls = await controlLab(page);
  controls.permitStartup();
  await page.getByTestId("lab-start-interview").click();
  await expect(page.getByTestId("lab-interview")).toHaveAttribute("data-runtime-phase", "live");
  controls.beginFinishing();
  await expect(page.getByTestId("conversation-state")).toHaveText("finishing");
  await expect(page.locator("audio")).toHaveCount(1);
  controls.acceptEnding();
  await expect(page.getByTestId("lab-interview")).toHaveAttribute("data-runtime-phase", "ending");
  await expect(page.getByRole("status")).toContainText("Thank you");
  const finishedPresentation = await page.getByRole("status").textContent();
  await expect(page.locator("audio")).toHaveCount(0);
  await page.evaluate("window.testLateTrack()");
  await expect(page.locator("audio")).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-peer-closed", "true");
  expect(controls.terminalReads()).toBe(0);
  controls.commitOutcome();
  await expect(page.getByTestId("lab-interview")).toHaveAttribute("data-runtime-phase", "ended");
  await expect(page.getByRole("status")).toHaveText(finishedPresentation ?? "");
  await expect(page.locator("html")).toHaveAttribute("data-peer-closed", "true");
  await expect(page.locator("audio")).toHaveCount(0);
  expect(controls.unexpected).toEqual([]);
});

test("Lab startup failure stays attributable to the allocated experiment and releases media", async ({
  page,
}) => {
  const controls = await controlLab(page, true);
  await page.getByTestId("lab-start-interview").click();
  await expect(page.getByTestId("lab-interview")).toHaveAttribute("data-runtime-phase", "failed");
  await expect(page.locator("html")).toHaveAttribute("data-microphone-stopped", "true");
  await expect(page.locator("html")).toHaveAttribute("data-peer-closed", "true");
  await expect(page.locator("audio")).toHaveCount(0);
  await page.getByTestId("lab-transcripts-tab").click();
  await page.locator(`[data-run-id="${runId}"]`).click();
  await expect(page.locator(`[data-run-id="${runId}"]`)).toHaveAttribute("aria-pressed", "true");
  await expect.poll(controls.terminalReads).toBeGreaterThan(0);
  await expect(page.getByTestId("lab-terminal-outcome")).toHaveAttribute(
    "data-runtime-outcome",
    "failed_to_start",
  );
  expect(controls.starts()).toBe(1);
  expect(controls.unexpected).toEqual([]);
});

test("Lab disposal after a lost Start reply releases media and recovers the original experiment", async ({
  page,
}) => {
  const controls = await controlLab(page, true, false, true);
  await page.getByTestId("lab-start-interview").click();
  await expect.poll(controls.starts).toBeGreaterThan(0);
  await page.getByTestId("lab-finish-interview").click();
  await expect(page.locator("html")).toHaveAttribute("data-microphone-stopped", "true");
  await expect(page.locator("html")).toHaveAttribute("data-peer-closed", "true");
  await expect(page.locator("audio")).toHaveCount(0);
  await expect(page.getByTestId("lab-interview")).toHaveAttribute("data-runtime-phase", "ending");
  controls.commitOutcome();
  await expect(page.getByTestId("lab-interview")).toHaveAttribute("data-runtime-phase", "failed");
  await expect(page.locator("html")).not.toHaveAttribute("data-answer-applied", "true");
  expect(controls.endReasons).toContain("participant_stopped");
  await page.getByTestId("lab-transcripts-tab").click();
  await page.locator(`[data-run-id="${runId}"]`).click();
  await expect(page.getByTestId("lab-terminal-outcome")).toHaveAttribute(
    "data-runtime-outcome",
    "failed_to_start",
  );
  expect(controls.unexpected).toEqual([]);
});
