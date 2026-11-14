import type { Miniflare } from "miniflare";
import { expect } from "vitest";
import { z } from "zod";
import { decodeCascadeMediaServerMessage } from "../../shared/contracts/cascadeMedia.ts";
import type { ConversationSelection } from "../../shared/contracts/conversationSelection.ts";
import type {
  ExecutionSettings,
  InterviewExecution,
  RuntimeReasoningEffort,
} from "../../shared/contracts/runtimeStart.ts";

/**
 * A test client of Runtime's Cascade start and media protocol, as the Lab page drives it: the
 * Cascade start through the Run's controller, the media attachment, the Live wait and the
 * media-ready report. It reaches a test platform whose Worker routes each request to the
 * controller of the Run named by the `controller` query parameter.
 */
export function cascadeRunClient(platform: () => Pick<Miniflare, "dispatchFetch">) {
  function request(runId: string, path: string, init?: Parameters<Miniflare["dispatchFetch"]>[1]) {
    return platform().dispatchFetch(
      `https://probe.test${path}${path.includes("?") ? "&" : "?"}controller=${runId}`,
      init,
    );
  }

  /** A controller request: the Run identity and the fields of one of its routes. */
  function post(runId: string, path: string, body: ControllerRequest) {
    return request(runId, path, { method: "POST", body: JSON.stringify({ runId, ...body }) });
  }

  /** Starts the Run on the Cascade media profile, as the Lab Worker does. */
  function start(runId: string, run: CascadeStart) {
    return post(runId, "/connection", {
      startupExpiresAt: run.startupExpiresAt ?? Date.now() + 30_000,
      selection: run.selection,
      execution: { agentInput: run.agentInput },
      // A start without execution settings or an effort sends no field: JSON leaves out an
      // undefined value.
      executionSettings: run.executionSettings,
      reasoningEffort: run.reasoningEffort,
      profile: "cascade-media-v1",
      connection: { exchangeId: `exchange-${runId}`, input: {} },
    });
  }

  async function state(runId: string) {
    return runStateSchema.parse(await (await request(runId, "/state")).json()).state;
  }

  /** Attaches the Run's media as the browser does, keeping each server message it receives. */
  async function attach(runId: string): Promise<CascadeMedia> {
    const response = await request(runId, `/attachment?runId=${runId}`, {
      headers: { Upgrade: "websocket" },
    });
    const socket = response.webSocket;
    if (socket === null) throw new Error(`attachment refused: ${String(response.status)}`);
    const received: CascadeReceived[] = [];
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") throw new Error("Cascade media messages are text");
      received.push({
        at: Date.now(),
        message: decodeCascadeMediaServerMessage(JSON.parse(event.data)),
      });
    });
    socket.accept();
    return { socket, received };
  }

  /** Starts the Run, attaches its media and waits until the Run is Live. */
  async function attachLive(runId: string, run: CascadeStart) {
    expect((await start(runId, run)).status, "Runtime accepts the Cascade start").toBe(200);
    const media = await attach(runId);
    await expect.poll(async () => (await state(runId)).phase).toBe("live");
    return media;
  }

  /** Starts the Run, attaches its media, waits for Live and reports media readiness. */
  async function goLive(runId: string, run: CascadeStart) {
    const media = await attachLive(runId, run);
    expect(
      (await post(runId, "/media-ready", {})).status,
      "the browser reports media readiness",
    ).toBe(200);
    return media;
  }

  return { request, post, start, state, attach, attachLive, goLive };
}

/** The controller request fields these tests send besides the Run identity. */
type ControllerRequest = Readonly<{
  endReason?: "participant_stopped";
  mediaPresent?: boolean;
  startupExpiresAt?: number;
  selection?: ConversationSelection;
  execution?: Readonly<{ agentInput: InterviewExecution["agentInput"] }>;
  executionSettings?: ExecutionSettings | undefined;
  reasoningEffort?: RuntimeReasoningEffort | undefined;
  profile?: string;
  connection?: Readonly<{ exchangeId: string; input: Readonly<Record<never, never>> }>;
}>;

export type CascadeStart = Readonly<{
  selection: ConversationSelection;
  agentInput: InterviewExecution["agentInput"];
  /** The start's execution settings, Cascade's own; none unless given. */
  executionSettings?: ExecutionSettings | undefined;
  /** The Run's reasoning effort; none unless given. */
  reasoningEffort?: RuntimeReasoningEffort | undefined;
  startupExpiresAt?: number;
}>;

/** One media message from Runtime, with the time the browser received it. */
export type CascadeReceived = Readonly<{
  at: number;
  message: ReturnType<typeof decodeCascadeMediaServerMessage>;
}>;

export type CascadeMedia = Readonly<{
  socket: NonNullable<Awaited<ReturnType<Miniflare["dispatchFetch"]>>["webSocket"]>;
  received: CascadeReceived[];
}>;

/** The fields of the Run's public state these tests read. */
const runStateSchema = z.object({
  state: z.object({
    phase: z.string(),
    sessionId: z.string().optional(),
    /** The execution's summary of the settings the Run was prepared with. */
    settingsSummary: z.record(z.string(), z.json()).optional(),
    conversation: z.object({ deadlineAt: z.number().nullable() }).nullable().optional(),
    completion: z
      .object({
        endReason: z.string(),
        endingStartedAt: z.number(),
        warnings: z.array(z.string()),
      })
      .nullable()
      .optional(),
  }),
});
