import { expect, test, type APIRequestContext, type Page, type Response } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  defaultClosingSentence,
  defaultFinishInterviewDescription,
  goodbyeFinishDescription,
  goodbyeInterviewInstructions,
  nextQuestionDescription,
  questionPromptPresets,
} from "../lab-content/presets.ts";

// The Lab page, Lab's Worker and Runtime are real; only OpenAI's transport (in workerd) and the
// browser's native media and peer (here) are controlled. Lab runs on the substitute content
// folder, `tests/lab-content/`, from an empty prompt library.
async function installMedia(page: Page, offer = "controlled-lab-offer") {
  await page.addInitScript(`(() => {
    const audio = new AudioContext();
    const microphone = audio.createMediaStreamDestination().stream;
    const playback = audio.createMediaStreamDestination().stream;
    const track = microphone.getAudioTracks()[0];
    if (track === undefined) throw new Error("Missing controlled microphone track");
    const stop = track.stop.bind(track);
    track.stop = () => { stop(); document.documentElement.dataset.microphoneStopped = "true"; };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => { document.documentElement.dataset.microphoneAcquired = "true"; return microphone; } } });
    class Peer extends EventTarget {
      addTrack() {}
      createDataChannel() { return Object.assign(new EventTarget(), { readyState: "open" }); }
      async createOffer() { return { type: "offer", sdp: "v=0\\r\\n" + ${JSON.stringify(offer)} }; }
      async setLocalDescription() {}
      async setRemoteDescription() { document.documentElement.dataset.answerApplied = "true"; this.dispatchEvent(Object.assign(new Event("track"), { streams: [playback] })); }
      close() { document.documentElement.dataset.peerClosed = "true"; playback.getTracks().forEach((item) => item.stop()); void audio.close(); }
    }
    Object.defineProperty(window, "RTCPeerConnection", { configurable: true, value: Peer });
  })()`);
}

const isStart = (response: Response) =>
  new URL(response.url()).pathname === "/_api/runtime/runs" &&
  response.request().method() === "POST";

function allocatedRun(response: Response): string {
  const runId = response.headers()["x-lab-run-id"];
  if (runId === undefined) throw new Error("Lab allocated no experiment");
  return runId;
}

const terminalResultSchema = z.record(z.string(), z.json());
const labRunSchema = z.object({
  runId: z.string(),
  terminalResult: terminalResultSchema.optional(),
});

/** Lab's record of the experiment, with Runtime's result once Runtime has delivered it. */
async function deliveredResult(request: APIRequestContext, runId: string) {
  const response = await request.get(`/_api/runs/${encodeURIComponent(runId)}`);
  expect(response.status()).toBe(200);
  return labRunSchema.parse(await response.json());
}

/** The provider operations Runtime has made, in order, across this run's interviews. */
async function providerOperations(request: APIRequestContext) {
  return z.array(z.string()).parse(await (await request.get("/__test/provider-operations")).json());
}

async function expectReleased(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("data-microphone-stopped", "true");
  await expect(page.locator("html")).toHaveAttribute("data-peer-closed", "true");
  await expect(page.locator("audio")).toHaveCount(0);
}

async function expectRecordedOutcome(page: Page, runId: string, outcome: string) {
  await page.getByTestId("lab-transcripts-tab").click();
  await page.locator(`[data-run-id="${runId}"]`).click();
  await expect(page.getByTestId("lab-terminal-outcome")).toHaveAttribute(
    "data-runtime-outcome",
    outcome,
  );
}

test("a provider failure at Start ends the experiment as failed_to_start without live timing", async ({
  page,
  request,
}) => {
  await installMedia(page, "fail-start");
  await page.goto("/");
  const start = page.waitForResponse(isStart);
  await page.getByTestId("lab-start-interview").click();
  const runId = allocatedRun(await start);
  await expect(page.getByTestId("lab-interview")).toHaveAttribute("data-runtime-phase", "failed", {
    timeout: 30_000,
  });
  await expectReleased(page);
  await expect
    .poll(async () => (await deliveredResult(request, runId)).terminalResult)
    .toMatchObject({ runId, outcome: "failed_to_start" });
  expect((await deliveredResult(request, runId)).terminalResult).not.toHaveProperty("liveAt");
  await expectRecordedOutcome(page, runId, "failed_to_start");
});

test("a lost Start reply retries the same attempt with one provider call and resolves its real result", async ({
  page,
  request,
}) => {
  const before = await providerOperations(request);
  const starts: string[] = [];
  let runId: string | null = null;
  await page.route("**/_api/runtime/runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    starts.push(route.request().postData() ?? "");
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    runId = response.headers()["x-lab-run-id"] ?? null;
    if (starts.length === 1) return route.abort("failed");
    return route.fulfill({ response });
  });
  await installMedia(page);
  await page.goto("/");
  await page.getByTestId("lab-start-interview").click();
  await expect(page.getByTestId("lab-interview")).toHaveAttribute("data-runtime-phase", "live", {
    timeout: 30_000,
  });
  await expect(page.locator("html")).toHaveAttribute("data-answer-applied", "true");
  expect(starts).toHaveLength(2);
  expect(starts[1]).toBe(starts[0]);
  if (runId === null) throw new Error("Lab allocated no experiment");
  const experiment: string = runId;
  await page.getByTestId("lab-finish-interview").click();
  await expect(page.locator("html")).toHaveAttribute("data-microphone-stopped", "true");
  await expect(page.getByTestId("lab-interview")).toHaveAttribute("data-runtime-phase", "ended", {
    timeout: 30_000,
  });
  await expect(page.locator("html")).toHaveAttribute("data-peer-closed", "true");
  expect(await deliveredResult(request, experiment)).toMatchObject({
    runId: experiment,
    terminalResult: { runId: experiment, outcome: "completed", reason: "participant_stopped" },
  });
  await expect
    .poll(async () => {
      const state: unknown = await (
        await request.get(`/__test/runtime?runId=${encodeURIComponent(experiment)}`)
      ).json();
      return state;
    })
    .toMatchObject({
      phase: "ended",
      callback: { pending: false },
      completion: { runId: experiment, endReason: "participant_stopped" },
    });
  expect((await providerOperations(request)).slice(before.length)).toEqual(["/create", "/hangup"]);
  await page.reload();
  await expectRecordedOutcome(page, experiment, "completed");
  await expect(page.locator("html")).not.toHaveAttribute("data-microphone-acquired", "true");
});

test("Runtime's Ending stops Lab media and holds the provider call until its delivered result", async ({
  page,
  request,
}) => {
  await installMedia(page);
  await page.goto("/");
  const start = page.waitForResponse(isStart);
  const observation = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/_api/runtime/events",
  );
  await page.getByTestId("lab-start-interview").click();
  const runId = allocatedRun(await start);
  await expect(page.getByTestId("lab-interview")).toHaveAttribute("data-runtime-phase", "live", {
    timeout: 30_000,
  });
  const events = await observation;
  expect(events.status()).toBe(200);
  expect(events.headers()["content-type"]).toContain("text/event-stream");
  let releaseReads = () => {};
  const readGate = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  let readObserved = () => {};
  const observedRead = new Promise<void>((resolve) => {
    readObserved = resolve;
  });
  await page.route(`**/_api/runs/${runId}`, async (route) => {
    const response = await route.fetch();
    readObserved();
    await readGate;
    await route.fulfill({ response });
  });
  // The End comes from outside the page: the page learns of Ending from Runtime's events.
  const end = await request.post(`/_api/runtime/runs/${encodeURIComponent(runId)}/complete`, {
    data: { endReason: "participant_stopped" },
  });
  expect(end.ok()).toBe(true);
  try {
    await expect(page.locator("html")).toHaveAttribute("data-microphone-stopped", "true", {
      timeout: 1500,
    });
    await expect(page.locator("audio")).toHaveCount(0);
    await expect(page.getByTestId("lab-interview")).toHaveAttribute("data-runtime-phase", "ending");
    await observedRead;
    await expect(page.locator("html")).not.toHaveAttribute("data-peer-closed", "true");
  } finally {
    releaseReads();
  }
  await expect(page.getByTestId("lab-interview")).toHaveAttribute("data-runtime-phase", "ended", {
    timeout: 30_000,
  });
  await expect(page.locator("html")).toHaveAttribute("data-peer-closed", "true");
  expect(await deliveredResult(request, runId)).toMatchObject({
    runId,
    terminalResult: { runId, outcome: "completed", reason: "participant_stopped" },
  });
});

const substitutePrompt = await readFile(
  new URL("../lab-content/prompts/interview.md", import.meta.url),
  "utf8",
);
const startSchema = z.object({
  agentInput: z.object({
    interviewing: z.json().optional(),
    questions: z.json().optional(),
    goodbye: z.json().optional(),
  }),
});

/** The interview input Lab sends with Start, after an interview that reached Live and ended. */
async function startAndEnd(page: Page) {
  const start = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/_api/runtime/runs" && request.method() === "POST",
  );
  await page.getByTestId("lab-start-interview").click();
  const { agentInput } = startSchema.parse((await start).postDataJSON());
  await expect(page.getByTestId("lab-interview")).toHaveAttribute("data-runtime-phase", "live", {
    timeout: 30_000,
  });
  await page.getByTestId("lab-finish-interview").click();
  await expect(page.getByTestId("lab-interview")).toHaveAttribute("data-runtime-phase", "ended", {
    timeout: 30_000,
  });
  return agentInput;
}

async function chooseConversation(page: Page, id: string) {
  await page.goto("/");
  await page.locator('[data-lab-run-setting="conversationSelection"]').click();
  await page.locator(`[data-lab-setting-option="${id}"]`).click();
}

test("Lab fills its empty prompt library from its content folder, and offers and sends that folder's texts", async ({
  page,
  request,
}) => {
  await installMedia(page);
  await page.goto("/");
  await expect(page.locator("#live-prompt-editor")).toHaveValue(substitutePrompt);
  expect(await (await request.get("/_api/prompts")).json()).toEqual([
    { id: "interview", fileName: "interview.md", content: substitutePrompt },
  ]);
  await expect(page.locator("#live-finish-description")).toHaveValue(
    defaultFinishInterviewDescription,
  );
  const original = await startAndEnd(page);
  expect(original.interviewing).toEqual({
    instructions: { kind: "literal", text: substitutePrompt },
    toolDescriptions: { finish_interview: defaultFinishInterviewDescription },
  });

  await chooseConversation(page, "goodbye-interview-realtime");
  await expect(page.locator("#live-prompt-editor")).toHaveValue(goodbyeInterviewInstructions);
  await expect(page.locator("#live-finish-description")).toHaveValue(goodbyeFinishDescription);
  await expect(page.locator("#live-closing-sentence")).toHaveValue(defaultClosingSentence);
  const goodbye = await startAndEnd(page);
  expect(goodbye.interviewing).toEqual({
    instructions: { kind: "literal", text: goodbyeInterviewInstructions },
    toolDescriptions: { finish_interview: goodbyeFinishDescription },
  });
  expect(goodbye.goodbye).toEqual({ closingSentence: defaultClosingSentence });

  await chooseConversation(page, "questions-interview-realtime");
  for (const [index, question] of questionPromptPresets.entries())
    await expect(page.locator(`#live-question-${index}`)).toHaveValue(question);
  await expect(page.locator("#live-next-question-description")).toHaveValue(
    nextQuestionDescription,
  );
  await expect(page.locator("#live-finish-description")).toHaveValue(goodbyeFinishDescription);
  await expect(page.locator("#live-closing-sentence")).toHaveValue(defaultClosingSentence);
  const questions = await startAndEnd(page);
  expect(questions.questions).toEqual(
    questionPromptPresets.map((text) => ({
      instructions: { kind: "literal", text },
      toolDescriptions: {
        next_question: nextQuestionDescription,
        finish_interview: goodbyeFinishDescription,
      },
    })),
  );
  expect(questions.goodbye).toEqual({ closingSentence: defaultClosingSentence });
});
