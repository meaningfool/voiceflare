import { questionsRealtimeSelection, goodbyeRealtimeSelection } from "../runtimeHostComposition.ts";
import {
  sampleGoodbyeInput,
  sampleClosingSentence,
  sampleGoodbyeInterviewInstructions,
  sampleQuestionPrompts,
  sampleQuestionsInput,
} from "./testing/sampleInterviews.ts";
import { platformBuildOptions } from "../shared/testing/platformBuild.ts";
import { originalRealtimeSelection } from "../shared/contracts/conversationSelection.ts";
import { createInterviewConversationInput as testInterviewInput } from "./testing/interviewConversationPreset.ts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { finalizationEffectKinds } from "./interviewFinalizationModel.ts";

let platform: Miniflare;
let script: string;
let persistence: string;
let controlledClockAt: number | undefined;

function createPlatform() {
  return new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2026-06-05",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { CONTROLLER: { className: "Controller", useSQLite: true } },
    durableObjectsPersist: persistence,
    bindings: controlledClockAt === undefined ? {} : { TEST_CLOCK_NOW: controlledClockAt },
  });
}

beforeAll(async () => {
  persistence = await mkdtemp(join(tmpdir(), "610-native-"));
  const bundle = await build({
    ...platformBuildOptions,
    stdin: {
      contents: `import { InterviewRuntimeController } from "./worker/runtime/interviewRuntimeController.ts";
        import { createRuntimeHostDelivery } from "./worker/runtimeHostDelivery.ts";
        import { realtimeTestDriver } from "./worker/providers/openaiRealtime/testing/testDriver.ts";
        import { providerSuccess } from "./worker/runtime/providerOutcomes.ts";
        import { InterviewFinalizationRepository } from "./worker/runtime/interviewFinalizationRepository.ts";
        import { enterConversationNode } from "./worker/runtime/conversationNode.ts";
        import { createRuntimeHostAssembly, runtimeHostAssembly } from "./worker/runtimeHostComposition.ts";
        import { createFakeRealtimeSideConnection } from "./worker/providers/openaiRealtime/testing/fakeSideConnection.ts";
        import { toProviderRealtimeSession } from "./worker/providers/openaiRealtime/preparedModelSession.ts";
        export class Controller extends InterviewRuntimeController {
          constructor(ctx, env) {
            let clockAt = env.TEST_CLOCK_NOW;
            if (typeof clockAt === "number") Date.now = () => clockAt;
            let holdInput = false;
            let inputHeld = false;
            const sides = [];
            let hangups = 0;
            let creations = 0;
            const connections = [];
            // The session each call was created with, as OpenAI receives it.
            const calls = [];
            const driver = realtimeTestDriver({
              createCall: async (input) => {creations+=1;calls.push(toProviderRealtimeSession(input.session));return providerSuccess({ status: 201, answerSdp: "answer-sdp", responseContentType: "application/sdp", sessionLocation: "https://provider.test/rtc_native", sessionId: "rtc_native", upstreamRequestId: "req_native" });},
              connectSideband: async (input) => {
                connections.push(input.callId);
                const side = createFakeRealtimeSideConnection();
                sides.push(side);
                return providerSuccess(side.connection);
              },
              hangUp: async () => { hangups += 1; return providerSuccess({ status: 204, upstreamRequestId: "req_hangup" }); },
            });
            // A Run named gate-* runs under the voice Gate's test options, as a local build sets them.
            const controlled = createRuntimeHostAssembly({
              realtimeDriver: driver,
              gateTestOptions: (ctx.id.name ?? "").startsWith("gate-")
                ? { noTools: true, suppliedNextQuestion: true }
                : undefined,
            });
            const assembly = {...controlled, createSession(input, selection) {
              const issueSink = input.issueSink;
              if (issueSink === undefined) return controlled.createSession(input, selection);
              return controlled.createSession({...input, issueSink(runId, generation) {
                const sink = issueSink(runId, generation);
                return async fact => {
                  if (holdInput && fact.kind === "provider_observation" && fact.observation?.kind === "participant_answer_created") {
                    inputHeld = true;
                    await new Promise(() => {});
                  }
                  await sink(fact);
                };
              }}, selection);
            }};
            super(ctx, env, { assembly, delivery: createRuntimeHostDelivery(env) });
            this.peer = () => sides.at(-1)?.provider ?? null;
            this.commandEvidence = () => ({ commands: sides.flatMap((side) => side.commands), hangups,creations,connections,calls });
            this.probeContext = ctx;
            this.crashNative = () => {for (const side of sides) side.sever();};
            this.holdInput = () => {holdInput=true;};
            this.inputHeld = () => inputHeld;
            this.setClockAt = at => {clockAt=at;};
          }
          async fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/commands") return Response.json(this.commandEvidence());
            if (path === "/hold-input") {this.holdInput();return Response.json({ok:true});}
            if (path === "/input-held") return Response.json({held:this.inputHeld()});
            if (path === "/clock") {this.setClockAt(Number(new URL(request.url).searchParams.get("at")));return Response.json({ok:true});}
            if(path === "/pause-alarm" || path === "/crash") {
              // Abrupt process loss cannot admit graceful socket teardown receipts.
              if(path === "/crash") this.crashNative();
              await this.probeContext.storage.deleteAlarm();
              return Response.json({ok:true});
            }
            if(path === "/run-alarm") {await this.alarm();return Response.json({ok:true});}
            if(path === "/node-fixture") {
              const status=new URL(request.url).searchParams.get("status");
              if(status!=="pending" && status!=="claimed" && status!=="dispatched")return new Response(null,{status:400});
              const repository=new InterviewFinalizationRepository(this.probeContext.storage);
              const row=repository.requireState();
              const snapshot=JSON.parse(row.conversation_selection_json);
              const aggregate=repository.readAggregate(row);
              const implementation=runtimeHostAssembly.resolve(snapshot.selection);
              // Use real admission/persistence at the boundary before native dispatch.
              const question = new URL(request.url).searchParams.get("target") === "question";
              const entered=enterConversationNode(aggregate,implementation,implementation.accept(snapshot.execution.agentInput),question ? "question" : "goodbye",{reason:question ? "agent_requested_end" : "timebox_reached",at:Date.now(),...(question ? {context:{questionIndex:1,questionCount:snapshot.execution.agentInput.questions.length}} : {})});
              const retained={...entered,conversationNodeExecution:{...entered.conversationNodeExecution,dispatch:{...entered.conversationNodeExecution.dispatch,status}}};
              if(new URL(request.url).searchParams.get("mismatch")==="1") {
                retained.conversationNodeExecution.dispatch.input=question ? snapshot.execution.agentInput.questions[0] : {closingSentence:snapshot.execution.agentInput.interviewing.instructions.text};
              }
              repository.persistAggregate(retained,null);
              return Response.json({ok:true});
            }
            if(path === "/recovery") {
              const repository=new InterviewFinalizationRepository(this.probeContext.storage);
              const row=repository.requireState();
              const aggregate=repository.readAggregate(row);
              return Response.json({selection:JSON.parse(row.conversation_selection_json).selection,liveAt:row.live_at,deadlineAt:row.deadline_at,visit:aggregate.conversationVisit,node:aggregate.conversationNodeExecution,stage:aggregate.state.stage,endReason:aggregate.state.stage==="ended"?aggregate.state.completion.endReason:aggregate.state.endReason,endingStartedAt:aggregate.state.stage==="ended"?aggregate.state.completion.endingStartedAt:aggregate.state.endingStartedAt,finalizationCutoffAt:aggregate.state.stage==="ended"?aggregate.state.completion.finalizationCutoffAt:aggregate.state.finalizationCutoffAt,inputBuffered:row.execution_state_json==null?null:JSON.parse(row.execution_state_json).inputBuffered,receivedEvents:row.session_event_count,alarmAt:await this.probeContext.storage.getAlarm(),evidenceGap:aggregate.applicationTranscriptProof?.evidenceGap??false,usageIncomplete:aggregate.runtimeUsage?.incomplete??false,result:aggregate.applicationTranscriptProof?.result,finalInputCommit:aggregate.state.effects.find(effect=>effect.kind==="close_input")??null});
            }
            if (path === "/opening-fixture") {
              // Model a crash after readiness persistence or the synchronous dispatch claim.
              const opening = new URL(request.url).searchParams.get("opening");
              if (opening !== "pending" && opening !== "claimed") return new Response(null, { status: 400 });
              this.probeContext.storage.sql.exec("UPDATE runtime_controller_state SET browser_media_ready_at = ?, opening_state = ?", Date.now(), opening);
              return Response.json({ ok: true });
            }
            if (path === "/opening") {
              return Response.json({ row: this.probeContext.storage.sql.exec("SELECT live_at, browser_media_ready_deadline_at, browser_media_ready_at, opening_state FROM runtime_controller_state").one(), alarmAt: await this.probeContext.storage.getAlarm() });
            }
            if (path === "/provider") {
              const peer = this.peer();
              return peer === null ? new Response("not connected", { status: 409 }) : new Response(null, { status: 101, webSocket: peer });
            }
            if (path === "/policy" || path === "/durable-policy") {
              const row = this.probeContext.storage.sql.exec("SELECT session_id, startup_expires_at, finalization_state_json FROM runtime_controller_state").one();
              const aggregate = JSON.parse(row.finalization_state_json);
              let state = aggregate.state;
              let finalInput = aggregate.finalInput;
              if (path === "/durable-policy") {
                const { stage: _stage, effects: _effects, warnings: _warnings,
                  ...retainedState } = state;
                state = retainedState;
                if (finalInput !== null) {
                  const { obligation: _obligation, quietDeadline: _quietDeadline, ...retainedFinalInput } = finalInput;
                  finalInput = retainedFinalInput;
                }
              }
              return Response.json({ callId: row.session_id, startupExpiresAt: row.startup_expires_at,
                aggregate: { state, finalInput,
                  gracefulCompletion: aggregate.gracefulCompletion,
                  providerGeneration: aggregate.providerGeneration,
                  nextProviderSequence: aggregate.nextProviderSequence } });
            }
            return super.fetch(request);
          }
        }
        export default { fetch(request, env) {
          const identity = new URL(request.url).searchParams.get("controller") ?? "native-session";
          return env.CONTROLLER.getByName(identity).fetch(request);
        }};`,
      resolveDir: process.cwd(),
    },
  });
  script = bundle.outputFiles[0]?.text ?? "";
  platform = createPlatform();
}, 30_000);

afterAll(async () => {
  await platform?.dispose();
  if (persistence !== undefined) await rm(persistence, { recursive: true, force: true });
});

afterEach(async () => {
  if (controlledClockAt === undefined) return;
  await platform.dispose();
  controlledClockAt = undefined;
  platform = createPlatform();
});

async function state() {
  return (await platform.dispatchFetch("https://probe.test/state")).json();
}

async function policy() {
  return z
    .object({
      callId: z.string(),
      aggregate: z.object({
        state: z.object({
          stage: z.string(),
          endReason: z.string(),
          effects: z.array(
            z.object({
              id: z.string(),
              kind: z.enum(finalizationEffectKinds),
              status: z.enum(["pending", "sending", "dispatched", "failed", "uncertain"]),
              attemptCount: z.number().int().nonnegative(),
            }),
          ),
        }),
      }),
    })
    .parse(await (await platform.dispatchFetch("https://probe.test/policy")).json());
}

async function durablePolicy() {
  return (await platform.dispatchFetch("https://probe.test/durable-policy")).json();
}

function transcriptEvent(id: string, text: string) {
  return JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    event_id: id,
    item_id: id,
    transcript: text,
  });
}

describe("retained provider connection on actual workerd", () => {
  const openingEvidence = z.object({
    row: z.object({
      live_at: z.number(),
      browser_media_ready_deadline_at: z.number(),
      browser_media_ready_at: z.number().nullable(),
      opening_state: z.enum(["pending", "claimed", "sent"]),
    }),
    alarmAt: z.number().nullable(),
  });
  const commandEvidence = z.object({
    commands: z.array(z.object({ type: z.string() })),
    hangups: z.number(),
  });
  const requestFor = (
    runId: string,
    path: string,
    init?: Parameters<Miniflare["dispatchFetch"]>[1],
  ) =>
    platform.dispatchFetch(
      `https://probe.test${path}${path.includes("?") ? "&" : "?"}controller=${runId}`,
      init,
    );
  const startWaiting = async (runId: string) => {
    const start = await requestFor(runId, "/connection", {
      method: "POST",
      body: JSON.stringify({
        runId,
        profile: "realtime-v1",
        connection: { exchangeId: "exchange", input: { sdp: "v=0\r\n" } },
        startupExpiresAt: Date.now() + 30_000,
        selection: originalRealtimeSelection,
        execution: { agentInput: testInterviewInput("Interview the participant.") },
      }),
    });
    expect({
      status: start.status,
      reply: connectionReply.parse(await start.json()).reply,
    }).toEqual({
      status: 200,
      reply: { sdp: "answer-sdp" },
    });
    await expect
      .poll(async () => (await requestFor(runId, "/state")).json())
      .toMatchObject({ state: { phase: "live" } });
    return openingEvidence.parse(await (await requestFor(runId, "/opening")).json());
  };
  const readCommands = async (runId: string) =>
    commandEvidence.parse(await (await requestFor(runId, "/commands")).json());

  it.each(["pending", "pending_ready", "claimed", "sent"] as const)(
    "reconstructs a native %s opening from retained SQLite without duplicate dispatch",
    async (opening) => {
      const runId = `native-opening-${opening}`;
      const original = await startWaiting(runId);
      expect(
        (await readCommands(runId)).commands.filter(({ type }) => type === "response.create"),
      ).toEqual([]);
      if (opening === "sent") {
        await requestFor(runId, "/media-ready", {
          method: "POST",
          body: JSON.stringify({ runId }),
        });
        expect(
          (await readCommands(runId)).commands.filter(({ type }) => type === "response.create"),
        ).toHaveLength(1);
      } else if (opening !== "pending") {
        await requestFor(
          runId,
          `/opening-fixture?opening=${opening === "pending_ready" ? "pending" : "claimed"}`,
          { method: "POST" },
        );
      }
      await platform.dispose();
      platform = createPlatform();
      await requestFor(runId, "/state");
      if (opening === "pending")
        await requestFor(runId, "/media-ready", {
          method: "POST",
          body: JSON.stringify({ runId }),
        });
      await expect
        .poll(async () => {
          const evidence = await readCommands(runId);
          return evidence.commands.filter(({ type }) => type === "response.create");
        })
        .toHaveLength(opening.startsWith("pending") ? 1 : 0);
      const restored = openingEvidence.parse(await (await requestFor(runId, "/opening")).json());
      expect(restored.row).toMatchObject({
        live_at: original.row.live_at,
        browser_media_ready_deadline_at: original.row.live_at + 15_000,
        opening_state: opening === "claimed" ? "claimed" : "sent",
      });
      await requestFor(runId, "/media-ready", { method: "POST", body: JSON.stringify({ runId }) });
      expect(
        (await readCommands(runId)).commands.filter(({ type }) => type === "response.create"),
      ).toHaveLength(opening.startsWith("pending") ? 1 : 0);
      await requestFor(runId, "/complete", {
        method: "POST",
        body: JSON.stringify({ runId, endReason: "participant_stopped" }),
      });
    },
    20_000,
  );

  it.each([false, true])(
    "applies the native readiness deadline and preserves an earlier End (End first: %s)",
    async (endFirst) => {
      const runId = `native-opening-deadline-${endFirst}`;
      const original = await startWaiting(runId);
      if (endFirst)
        await requestFor(runId, "/complete", {
          method: "POST",
          body: JSON.stringify({ runId, endReason: "participant_stopped" }),
        });
      else
        await requestFor(runId, "/presence", {
          method: "POST",
          body: JSON.stringify({ runId, mediaPresent: true }),
        });
      await expect
        .poll(async () => (await requestFor(runId, "/state")).json(), { timeout: 28_000 })
        .toMatchObject({
          state: {
            phase: "ended",
            completion: { endReason: endFirst ? "participant_stopped" : "runtime_failed" },
          },
        });
      const ended = await (await requestFor(runId, "/state")).json();
      if (!endFirst) {
        const completion = z
          .object({
            state: z.object({
              completion: z.object({ endedAt: z.number(), finalizationCutoffAt: z.number() }),
            }),
          })
          .parse(ended).state.completion;
        expect(completion.endedAt).toBeGreaterThanOrEqual(original.row.live_at + 15_000);
        expect(completion.endedAt).toBeLessThanOrEqual(Date.now());
        expect(completion.finalizationCutoffAt).toBe(completion.endedAt + 10_000);
      }
      await requestFor(runId, "/media-ready", { method: "POST", body: JSON.stringify({ runId }) });
      const completionSnapshot = z
        .object({ state: z.object({ completion: z.json() }) })
        .parse(ended).state.completion;
      expect(
        z
          .object({ state: z.object({ completion: z.json() }) })
          .parse(await (await requestFor(runId, "/state")).json()).state.completion,
      ).toEqual(completionSnapshot);
      const evidence = await readCommands(runId);
      expect(evidence.commands.filter(({ type }) => type === "response.create")).toEqual([]);
      expect(evidence.hangups).toBe(1);
      expect(
        openingEvidence.parse(await (await requestFor(runId, "/opening")).json()).row
          .browser_media_ready_at,
      ).toBeNull();
    },
    30_000,
  );
  it("processes native provider events after response end and independent observer cancellation, then reconstructs durable policy", async () => {
    await platform.dispose();
    // Keep policy time before quiet settlement across both real processes. Native
    // scheduling remains real; future alarm timestamps cannot spin while time is held.
    controlledClockAt = Date.now() + 60_000;
    platform = createPlatform();
    const start = await platform.dispatchFetch("https://probe.test/connection", {
      method: "POST",
      body: JSON.stringify({
        runId: "native-session",
        profile: "realtime-v1",
        connection: { exchangeId: "exchange", input: { sdp: "v=0\r\n" } },
        startupExpiresAt: controlledClockAt + 30_000,
        selection: originalRealtimeSelection,
        execution: { agentInput: testInterviewInput("Interview the participant.") },
      }),
    });
    const { reply } = connectionReply.parse(await start.json());
    expect({ status: start.status, reply }).toEqual({ status: 200, reply: { sdp: "answer-sdp" } });
    await expect.poll(state).toMatchObject({ state: { phase: "live" } });
    const upgrade = await platform.dispatchFetch("https://probe.test/provider", {
      headers: { Upgrade: "websocket" },
    });
    const provider = upgrade.webSocket;
    if (provider === null) throw new Error("missing_native_provider_socket");
    const openingFrames: unknown[] = [];
    provider.addEventListener("message", (event) => {
      if (typeof event.data !== "string") throw new Error("unexpected_native_provider_frame");
      const value: unknown = JSON.parse(event.data);
      const envelope = z.object({ type: z.string() }).parse(value);
      if (envelope.type === "response.create") openingFrames.push(value);
    });
    provider.accept();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(openingFrames).toEqual([]);
    const liveBeforeReady = await state();
    const openingBeforeReady = z
      .object({
        row: z.object({
          live_at: z.number(),
          browser_media_ready_deadline_at: z.number(),
          browser_media_ready_at: z.null(),
          opening_state: z.literal("pending"),
        }),
        alarmAt: z.number(),
      })
      .parse(await (await platform.dispatchFetch("https://probe.test/opening")).json());
    expect(openingBeforeReady.row.browser_media_ready_deadline_at).toBe(
      openingBeforeReady.row.live_at + 15000,
    );
    await platform.dispatchFetch("https://probe.test/presence", {
      method: "POST",
      body: JSON.stringify({ runId: "native-session", mediaPresent: true }),
    });
    const wake = z
      .object({ alarmAt: z.number() })
      .parse(await (await platform.dispatchFetch("https://probe.test/opening")).json());
    expect(wake.alarmAt).toBe(openingBeforeReady.row.live_at + 15000);
    expect(
      await (
        await platform.dispatchFetch("https://probe.test/media-ready", {
          method: "POST",
          body: JSON.stringify({ runId: "native-session" }),
        })
      ).json(),
    ).toEqual({ ok: true });
    await expect
      .poll(() => openingFrames)
      .toEqual([
        expect.objectContaining({
          type: "response.create",
        }),
      ]);
    await platform.dispatchFetch("https://probe.test/media-ready", {
      method: "POST",
      body: JSON.stringify({ runId: "native-session" }),
    });
    expect(openingFrames).toHaveLength(1);
    expect(await state()).toMatchObject(
      z
        .object({
          state: z.object({ phase: z.literal("live"), liveAt: z.number(), deadlineAt: z.number() }),
        })
        .parse(liveBeforeReady),
    );
    // This send happens after the initiating HTTP response's body has finished.
    provider.send(transcriptEvent("after-response", "Provider work survives response end."));
    await expect
      .poll(state)
      .toMatchObject({ state: { transcript: { turnCount: 1 }, session: { eventCount: 1 } } });
    const observer = await platform.dispatchFetch(
      "https://probe.test/events?runId=native-session&durationMs=30000",
    );
    expect(observer.headers.get("content-type")).toContain("text/event-stream");
    const reader = observer.body?.getReader();
    if (reader === undefined) throw new Error("missing_native_observer_stream");
    await reader.read();
    await reader.cancel("observer_finished");
    provider.send(transcriptEvent("after-cancel", "Provider work survives observer cancellation."));
    await expect.poll(state).toMatchObject({
      state: { phase: "live", transcript: { turnCount: 2 }, session: { eventCount: 2 } },
    });
    const stopped = await platform.dispatchFetch("https://probe.test/complete", {
      method: "POST",
      body: JSON.stringify({
        runId: "native-session",
        endReason: "participant_stopped",
        now: Date.now(),
      }),
    });
    expect(stopped.status).toBe(202);
    await stopped.text();
    const before = await policy();
    expect(before).toMatchObject({
      callId: "rtc_native",
      aggregate: { state: { stage: "draining", endReason: "participant_stopped" } },
    });
    const retainedPolicy = await durablePolicy();
    // Reconstruct from the same SQLite storage without requesting owner shutdown.
    // Local disposal can deliver a real socket disconnect; it does not model deployed eviction.
    await platform.dispose();
    platform = createPlatform();
    await expect
      .poll(state)
      .toMatchObject({ state: { phase: "ending", transcript: { turnCount: 2 } } });
    expect(await durablePolicy()).toEqual(retainedPolicy);
    const reconstructed = await policy();
    for (const effect of before.aggregate.state.effects) {
      const retained = reconstructed.aggregate.state.effects.find(({ id }) => id === effect.id);
      expect(retained).toMatchObject({ id: effect.id, kind: effect.kind });
      if (
        effect.status === "dispatched" &&
        effect.kind !== "arm_alarm" &&
        effect.kind !== "compute_transcript_digest"
      ) {
        expect(retained).toMatchObject({ status: "dispatched", attemptCount: effect.attemptCount });
      }
    }
  }, 20_000);
});

/** The connection exchange's reply, as the browser reads it. */
const connectionReply = z.object({ reply: z.unknown() });
const recoveryEvidence = z.object({
  selection: z.object({
    conversation: z.object({ id: z.string(), version: z.number() }),
    execution: z.object({ id: z.string(), version: z.number() }),
  }),
  liveAt: z.number(),
  deadlineAt: z.number().nullable(),
  stage: z.string(),
  endReason: z.string().optional(),
  endingStartedAt: z.number().optional(),
  finalizationCutoffAt: z.number().optional(),
  inputBuffered: z.boolean().nullable(),
  receivedEvents: z.number(),
  alarmAt: z.number().nullable(),
  evidenceGap: z.boolean(),
  usageIncomplete: z.boolean(),
  finalInputCommit: z
    .object({ status: z.string(), attemptCount: z.number(), acceptance: z.string() })
    .nullable(),
  result: z
    .object({
      transcriptCompleteness: z.string(),
      transcriptIncompleteReasons: z.array(z.object({ kind: z.string() })),
      runtimeUsage: z.object({ completeness: z.string() }),
    })
    .nullable()
    .optional(),
  visit: z.object({
    state: z.string(),
    visitId: z.string(),
    operationId: z.string(),
    context: z.object({ questionIndex: z.number(), questionCount: z.number() }).optional(),
  }),
  node: z.object({
    timers: z.array(z.object({ id: z.string(), deadlineAt: z.number() })),
    mediaCutoffAt: z.number(),
    closingCutoffAt: z.number().optional(),
    participantEnd: z.object({ at: z.number(), source: z.string() }).optional(),
    reservation: z.object({ reason: z.string(), at: z.number() }).optional(),
    dispatch: z
      .object({
        status: z.string(),
        limitation: z.string().optional(),
        input: z.union([
          z.object({ closingSentence: z.string() }),
          z.object({
            instructions: z.object({ kind: z.literal("literal"), text: z.string() }),
            toolDescriptions: z.record(z.string(), z.string()),
          }),
        ]),
      })
      .optional(),
  }),
});
const nativeCommandEvidence = z.object({
  commands: z.array(
    z.object({
      type: z.string(),
      session: z
        .object({
          type: z.string(),
          instructions: z.string().optional(),
          audio: z.object({
            input: z.object({
              turn_detection: z
                .object({
                  type: z.string(),
                  eagerness: z.string().optional(),
                  create_response: z.boolean(),
                  interrupt_response: z.boolean(),
                })
                .nullable(),
            }),
          }),
        })
        .optional(),
      response: z
        .object({
          instructions: z.string().optional(),
          input: z.array(z.unknown()).optional(),
          metadata: z.record(z.string(), z.string()).optional(),
        })
        .optional(),
    }),
  ),
  hangups: z.number(),
  creations: z.number(),
  connections: z.array(z.string()),
});
const recoveryRequest = (
  runId: string,
  path: string,
  init?: Parameters<Miniflare["dispatchFetch"]>[1],
) =>
  platform.dispatchFetch(
    `https://probe.test${path}${path.includes("?") ? "&" : "?"}controller=${runId}`,
    init,
  );
const readRecovery = async (runId: string) =>
  recoveryEvidence.parse(await (await recoveryRequest(runId, "/recovery")).json());
const goodbyeCommands = async (runId: string) =>
  nativeCommandEvidence
    .parse(await (await recoveryRequest(runId, "/commands")).json())
    .commands.filter(
      (command) => command.type === "response.create" && command.response?.metadata !== undefined,
    );
async function waitPast(deadlineAt: number) {
  const remaining = deadlineAt - Date.now() + 30;
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}
async function startGoodbyeRecovery(
  runId: string,
  durationMs = 2_000,
  questions = false,
  semanticVadEagerness?: "low" | "high",
) {
  const request = {
    runId,
    profile: "realtime-v1",
    connection: { exchangeId: "exchange", input: { sdp: "v=0\r\n" } },
    startupExpiresAt: Date.now() + 30_000,
    selection: questions ? questionsRealtimeSelection : goodbyeRealtimeSelection,
    execution: {
      agentInput: questions
        ? sampleQuestionsInput(sampleQuestionPrompts, { interviewingDurationMs: durationMs })
        : sampleGoodbyeInput({ interviewingDurationMs: durationMs }),
    },
  };
  const start = await recoveryRequest(runId, "/connection", {
    method: "POST",
    body: JSON.stringify(
      semanticVadEagerness === undefined
        ? request
        : {
            ...request,
            diagnosticsContext: { surface: "lab" },
            executionSettings: {
              model: "gpt-realtime-2",
              voice: "marin",
              speed: 1,
              inputNoiseReduction: "far_field",
              semanticVadEagerness,
              maxOutputTokens: 700,
              truncation: "auto",
            },
          },
    ),
  });
  expect({ status: start.status, reply: connectionReply.parse(await start.json()).reply }).toEqual({
    status: 200,
    reply: { sdp: "answer-sdp" },
  });
  await recoveryRequest(runId, "/pause-alarm", { method: "POST" });
  await recoveryRequest(runId, "/media-ready", { method: "POST", body: JSON.stringify({ runId }) });
  await recoveryRequest(runId, "/pause-alarm", { method: "POST" });
  const initial = await readRecovery(runId);
  expect(initial.selection).toEqual(
    questions ? questionsRealtimeSelection : goodbyeRealtimeSelection,
  );
  expect(initial.node).toEqual({
    timers: [{ id: "interviewing", deadlineAt: initial.liveAt + durationMs }],
    mediaCutoffAt: initial.liveAt + durationMs,
  });
  return initial;
}
/** The interviewing timer is the initial node's only declared timer. */
function interviewingDeadlineAt(initial: z.output<typeof recoveryEvidence>): number {
  return z.number().parse(initial.node.timers.find(({ id }) => id === "interviewing")?.deadlineAt);
}
async function crashProcess(runId: string) {
  await recoveryRequest(runId, "/crash", { method: "POST" });
  await platform.dispose();
}
async function restoreProcess(runId: string) {
  platform = createPlatform();
  const response = await recoveryRequest(runId, "/state");
  expect(response.status, await response.text()).toBe(200);
}
async function endRecoveryRun(runId: string) {
  await recoveryRequest(runId, "/complete", {
    method: "POST",
    body: JSON.stringify({ runId, endReason: "participant_stopped" }),
  });
}
async function completeRecoveredGoodbye(runId: string, hasEvidenceGap = true) {
  const command = (await goodbyeCommands(runId))[0];
  const response = await recoveryRequest(runId, "/provider", { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;
  if (socket === null) throw new Error("recovered_provider_socket_missing");
  socket.accept();
  socket.send(
    JSON.stringify({
      type: "response.done",
      response: {
        id: "recovered-closing",
        status: "completed",
        metadata: command?.response?.metadata,
        output: [
          {
            type: "message",
            id: "recovered-closing-item",
            role: "assistant",
            content: [{ type: "audio", transcript: "Thank you. Goodbye." }],
          },
        ],
      },
    }),
  );
  socket.send(
    JSON.stringify({ type: "output_audio_buffer.stopped", response_id: "recovered-closing" }),
  );
  await expect
    .poll(() => readRecovery(runId), { timeout: 12_000 })
    .toMatchObject({
      stage: "ended",
      endReason: "timebox_reached",
      node: { dispatch: { status: "complete" } },
      result: {
        transcriptCompleteness: hasEvidenceGap ? "incomplete" : "complete",
        runtimeUsage: { completeness: "incomplete" },
      },
    });
  if (hasEvidenceGap)
    expect((await readRecovery(runId)).result?.transcriptIncompleteReasons).toContainEqual({
      kind: "conversation_evidence_gap",
    });
  socket.close();
}

describe("Goodbye recovery across independent workerd processes", () => {
  it.each(["ending-budget", "media-cutoff"] as const)(
    "retains the first participant End across a process loss after %s",
    async (recoveryTime) => {
      await platform.dispose();
      controlledClockAt = 1_700_000_000_000;
      platform = createPlatform();
      const runId = `goodbye-end-held-prefix-${recoveryTime}`;
      const initial = await startGoodbyeRecovery(runId);
      const response = await recoveryRequest(runId, "/provider", {
        headers: { Upgrade: "websocket" },
      });
      const socket = response.webSocket;
      if (socket === null) throw new Error("provider_socket_missing");
      socket.accept();
      socket.send(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "answer" }));
      await expect.poll(() => readRecovery(runId)).toMatchObject({ inputBuffered: true });
      await recoveryRequest(runId, `/clock?at=${interviewingDeadlineAt(initial) + 1}`, {
        method: "POST",
      });
      await recoveryRequest(runId, "/run-alarm", { method: "POST" });
      await recoveryRequest(runId, "/hold-input", { method: "POST" });
      socket.send(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "answer" }));
      socket.send(
        JSON.stringify({
          type: "session.updated",
          session: { audio: { input: { turn_detection: null } } },
        }),
      );
      await expect
        .poll(async () => (await recoveryRequest(runId, "/input-held")).json())
        .toEqual({ held: true });
      await expect.poll(() => goodbyeCommands(runId)).toHaveLength(1);
      const closing = await readRecovery(runId);
      const closingCutoffAt = z.number().parse(closing.node.closingCutoffAt);
      expect(closing.node.reservation?.at).toBe(interviewingDeadlineAt(initial) + 1);
      expect(closingCutoffAt).toBe(interviewingDeadlineAt(initial) + 1 + 45_000);
      const requestedAt = interviewingDeadlineAt(initial) + 1000;
      await recoveryRequest(runId, `/clock?at=${requestedAt}`, { method: "POST" });
      // Stop is durably accepted while the existing FIFO handoff remains held.
      const ending = await recoveryRequest(runId, "/complete", {
        method: "POST",
        body: JSON.stringify({
          runId,
          endReason: "participant_stopped",
          source: "browser_request",
        }),
      });
      expect(ending.status).toBe(202);
      await expect
        .poll(() => readRecovery(runId))
        .toMatchObject({
          stage: "draining",
          visit: { state: "complete" },
          endingStartedAt: requestedAt,
          finalizationCutoffAt: requestedAt + 10_000,
          node: {
            closingCutoffAt,
            dispatch: { status: "failed", limitation: "closing_interrupted" },
          },
        });
      await crashProcess(runId);
      controlledClockAt =
        recoveryTime === "ending-budget" ? requestedAt + 12_000 : closingCutoffAt + 1000;
      await restoreProcess(runId);
      await expect
        .poll(() => readRecovery(runId))
        .toMatchObject({
          stage: "ended",
          endReason: "timebox_reached",
          endingStartedAt: requestedAt,
          finalizationCutoffAt: requestedAt + 10_000,
          visit: { state: "complete" },
          node: { closingCutoffAt, dispatch: { status: "failed" } },
          result: {
            transcriptCompleteness: "incomplete",
            runtimeUsage: { completeness: "incomplete" },
          },
        });
      expect((await readRecovery(runId)).result?.transcriptIncompleteReasons).toContainEqual({
        kind: "conversation_evidence_gap",
      });
      expect(
        nativeCommandEvidence.parse(await (await recoveryRequest(runId, "/commands")).json()),
      ).toMatchObject({ commands: [], creations: 0, connections: [] });
    },
    20_000,
  );
  it("retains the closing's silent-tail input closure after process reconstruction without native replay", async () => {
    const runId = "goodbye-completed-skip";
    const initial = await startGoodbyeRecovery(runId);
    await waitPast(interviewingDeadlineAt(initial));
    await recoveryRequest(runId, "/run-alarm", { method: "POST" });
    await expect.poll(() => goodbyeCommands(runId)).toHaveLength(1);
    await completeRecoveredGoodbye(runId, false);
    const ended = await readRecovery(runId);
    // The closing took over the input closure and found no answer to commit.
    expect(ended.finalInputCommit).toEqual({
      status: "dispatched",
      attemptCount: 1,
      acceptance: "unobserved",
    });
    expect(
      nativeCommandEvidence
        .parse(await (await recoveryRequest(runId, "/commands")).json())
        .commands.filter(({ type }) => type === "input_audio_buffer.commit"),
    ).toEqual([]);
    await crashProcess(runId);
    await restoreProcess(runId);
    expect(await readRecovery(runId)).toMatchObject({
      stage: "ended",
      endingStartedAt: ended.endingStartedAt,
      finalizationCutoffAt: ended.finalizationCutoffAt,
      finalInputCommit: ended.finalInputCommit,
      result: { transcriptCompleteness: "complete", transcriptIncompleteReasons: [] },
    });
    expect(
      nativeCommandEvidence.parse(await (await recoveryRequest(runId, "/commands")).json()),
    ).toMatchObject({ commands: [], creations: 0, connections: [] });
  }, 20_000);
  it.each(["before-expiry", "after-expiry"] as const)(
    "retains the selected pair and absolute media allowance across %s reconstruction",
    async (timing) => {
      const runId = `goodbye-recovery-${timing}`;
      const initial = await startGoodbyeRecovery(
        runId,
        timing === "before-expiry" ? 60_000 : 2_000,
      );
      await crashProcess(runId);
      if (timing === "after-expiry") await waitPast(interviewingDeadlineAt(initial));
      const restorationStartedAt = Date.now();
      await restoreProcess(runId);
      const restorationFinishedAt = Date.now();
      if (timing === "before-expiry") {
        const reconstructed = await readRecovery(runId);
        expect(reconstructed).toMatchObject({
          selection: goodbyeRealtimeSelection,
          visit: { state: "interrupted" },
          node: {
            timers: initial.node.timers,
            mediaCutoffAt: initial.node.mediaCutoffAt,
          },
        });
        await expect
          .poll(() => readRecovery(runId), { timeout: 12_000 })
          .toMatchObject({ stage: "ended", endReason: "runtime_failed" });
        const ended = await readRecovery(runId);
        expect(ended.node).toEqual(initial.node);
        expect(await goodbyeCommands(runId)).toEqual([]);
        expect(
          nativeCommandEvidence
            .parse(await (await recoveryRequest(runId, "/commands")).json())
            .commands.filter(({ type }) => type === "response.create"),
        ).toEqual([]);
        return;
      }
      await expect.poll(() => goodbyeCommands(runId)).toHaveLength(1);
      const restored = await readRecovery(runId);
      const closingEnteredAt = z.number().parse(restored.node.reservation?.at);
      expect(closingEnteredAt).toBeGreaterThanOrEqual(restorationStartedAt);
      expect(closingEnteredAt).toBeLessThanOrEqual(restorationFinishedAt);
      expect(
        nativeCommandEvidence.parse(await (await recoveryRequest(runId, "/commands")).json()),
      ).toMatchObject({ creations: 0, connections: ["rtc_native"] });
      expect(restored, JSON.stringify(restored)).toMatchObject({
        selection: goodbyeRealtimeSelection,
        visit: { state: "goodbye" },
        node: {
          timers: [{ id: "closing", deadlineAt: closingEnteredAt + 45_000 }],
          mediaCutoffAt: closingEnteredAt + 45_000,
          closingCutoffAt: closingEnteredAt + 45_000,
          reservation: { reason: "timebox_reached", at: closingEnteredAt },
          dispatch: { status: "claimed" },
        },
      });
      // The deadline started this closing: its session update stops turns and leaves the
      // instructions, its reply asks for the closing sentence alone, and no call is answered.
      const sent = nativeCommandEvidence.parse(
        await (await recoveryRequest(runId, "/commands")).json(),
      ).commands;
      const [closingUpdate, ...otherUpdates] = sent.filter(
        (command) =>
          command.type === "session.update" && command.session?.audio.input.turn_detection === null,
      );
      expect(otherUpdates).toEqual([]);
      expect(closingUpdate?.session).not.toHaveProperty("instructions");
      const closingReply = (await goodbyeCommands(runId))[0]?.response;
      expect(closingReply?.instructions?.endsWith(`\n\n${sampleClosingSentence}`)).toBe(true);
      expect(closingReply?.input).toEqual([]);
      expect(sent.filter(({ type }) => type === "conversation.item.create")).toEqual([]);
      await recoveryRequest(runId, "/run-alarm", { method: "POST" });
      expect(await goodbyeCommands(runId)).toHaveLength(1);
      expect((await readRecovery(runId)).node).toMatchObject({
        reservation: restored.node.reservation,
        mediaCutoffAt: restored.node.mediaCutoffAt,
        closingCutoffAt: restored.node.closingCutoffAt,
      });
      expect(await readRecovery(runId)).toMatchObject({ evidenceGap: true, usageIncomplete: true });
      await completeRecoveredGoodbye(runId);
      await endRecoveryRun(runId);
    },
    20_000,
  );
  it.each(["pending", "claimed", "sent"] as const)(
    "recovers a %s closing intent without renewing or replaying uncertain speech",
    async (status) => {
      const runId = `goodbye-recovery-dispatch-${status}`;
      const initial = await startGoodbyeRecovery(runId);
      await waitPast(interviewingDeadlineAt(initial));
      if (status === "sent") {
        await recoveryRequest(runId, "/run-alarm", { method: "POST" });
        await expect.poll(() => goodbyeCommands(runId)).toHaveLength(1);
      } else {
        const arranged = await recoveryRequest(runId, `/node-fixture?status=${status}`, {
          method: "POST",
        });
        expect(arranged.status).toBe(200);
        expect(await goodbyeCommands(runId)).toEqual([]);
      }
      const checkpoint = await readRecovery(runId);
      const closingEnteredAt = z.number().parse(checkpoint.node.reservation?.at);
      expect(closingEnteredAt).toBeGreaterThanOrEqual(interviewingDeadlineAt(initial));
      expect(checkpoint.node.mediaCutoffAt).toBe(closingEnteredAt + 45_000);
      expect(checkpoint.node.closingCutoffAt).toBe(closingEnteredAt + 45_000);
      await crashProcess(runId);
      await restoreProcess(runId);
      if (status === "pending") {
        await expect.poll(() => goodbyeCommands(runId)).toHaveLength(1);
        // A finishing visit keeps its identity on recovery; the claim belongs to that visit.
        expect(await readRecovery(runId)).toMatchObject({
          visit: checkpoint.visit,
          node: { dispatch: { status: "claimed" } },
        });
        expect(await readRecovery(runId)).toMatchObject({
          evidenceGap: true,
          usageIncomplete: true,
        });
        await completeRecoveredGoodbye(runId);
      } else {
        await expect
          .poll(() => readRecovery(runId))
          .toMatchObject({ node: { dispatch: { limitation: "closing_recovery_uncertain" } } });
        expect(await goodbyeCommands(runId)).toEqual([]);
      }
      const retained = await readRecovery(runId);
      expect(
        nativeCommandEvidence.parse(await (await recoveryRequest(runId, "/commands")).json())
          .creations,
      ).toBe(0);
      expect(retained.selection).toEqual(goodbyeRealtimeSelection);
      expect(retained.node.reservation).toEqual(checkpoint.node.reservation);
      expect(retained.node.mediaCutoffAt).toBe(checkpoint.node.mediaCutoffAt);
      expect(retained.node.closingCutoffAt).toBe(checkpoint.node.closingCutoffAt);
      await endRecoveryRun(runId);
    },
    20_000,
  );
  it.each([true, false])(
    "recovers pending Goodbye input settlement before admitting speech (speaking: %s)",
    async (speaking) => {
      const runId = `goodbye-recovery-pending-input-${speaking}`;
      const initial = await startGoodbyeRecovery(runId);
      const first = (
        await recoveryRequest(runId, "/provider", { headers: { Upgrade: "websocket" } })
      ).webSocket;
      if (first === null) throw new Error("provider_socket_missing");
      first.accept();
      first.send(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "answer" }));
      await expect.poll(() => readRecovery(runId)).toMatchObject({ inputBuffered: true });
      // Speech that stopped without a commit stays the participant's uncommitted answer, which
      // the Realtime kit keeps for a restart.
      if (!speaking) {
        first.send(
          JSON.stringify({ type: "input_audio_buffer.speech_stopped", item_id: "answer" }),
        );
        await expect.poll(() => readRecovery(runId)).toMatchObject({ receivedEvents: 2 });
      }
      await recoveryRequest(runId, "/pause-alarm", { method: "POST" });
      await waitPast(interviewingDeadlineAt(initial));
      expect(
        (await recoveryRequest(runId, "/node-fixture?status=pending", { method: "POST" })).status,
      ).toBe(200);
      const checkpoint = await readRecovery(runId);
      expect(checkpoint.finalInputCommit?.status).toBe("pending");
      await crashProcess(runId);
      await restoreProcess(runId);
      await expect
        .poll(
          async () =>
            nativeCommandEvidence.parse(await (await recoveryRequest(runId, "/commands")).json())
              .commands,
        )
        .toContainEqual(expect.objectContaining({ type: "session.update" }));
      expect(await goodbyeCommands(runId)).toEqual([]);
      const restored = (
        await recoveryRequest(runId, "/provider", { headers: { Upgrade: "websocket" } })
      ).webSocket;
      if (restored === null) throw new Error("recovered_provider_socket_missing");
      restored.accept();
      restored.send(
        JSON.stringify({
          type: "session.updated",
          session: { audio: { input: { turn_detection: null } } },
        }),
      );
      await expect
        .poll(async () =>
          nativeCommandEvidence
            .parse(await (await recoveryRequest(runId, "/commands")).json())
            .commands.filter((command) => command.type === "input_audio_buffer.commit"),
        )
        .toHaveLength(1);
      expect(await goodbyeCommands(runId)).toEqual([]);
      restored.send(
        JSON.stringify({ type: "input_audio_buffer.committed", item_id: "manual-answer" }),
      );
      restored.send(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "manual-answer",
          transcript: "The final answer remains eligible.",
        }),
      );
      await expect.poll(() => goodbyeCommands(runId)).toHaveLength(1);
      expect((await readRecovery(runId)).node.closingCutoffAt).toBe(
        checkpoint.node.closingCutoffAt,
      );
      await endRecoveryRun(runId);
      restored.close();
    },
    20_000,
  );
  it("rejects schema-valid retained pending input that differs from accepted configuration before native recovery", async () => {
    const runId = "goodbye-recovery-input-mismatch";
    const initial = await startGoodbyeRecovery(runId);
    await waitPast(interviewingDeadlineAt(initial));
    const arranged = await recoveryRequest(runId, "/node-fixture?status=pending&mismatch=1", {
      method: "POST",
    });
    expect(arranged.status).toBe(200);
    const checkpoint = await readRecovery(runId);
    expect(checkpoint.node.dispatch).toMatchObject({
      status: "pending",
      input: { closingSentence: sampleGoodbyeInterviewInstructions },
    });
    await crashProcess(runId);
    await restoreProcess(runId);
    await expect
      .poll(() => readRecovery(runId))
      .toMatchObject({
        endReason: "timebox_reached",
        node: { dispatch: { status: "failed", limitation: "conversation_node_input_invalid" } },
      });
    const recovered = await readRecovery(runId);
    expect(recovered.selection).toEqual(goodbyeRealtimeSelection);
    expect(recovered.node.reservation).toEqual(checkpoint.node.reservation);
    expect(recovered.node.mediaCutoffAt).toBe(checkpoint.node.mediaCutoffAt);
    expect(recovered.node.closingCutoffAt).toBe(checkpoint.node.closingCutoffAt);
    const native = nativeCommandEvidence.parse(
      await (await recoveryRequest(runId, "/commands")).json(),
    );
    expect(native.creations).toBe(0);
    expect(native.connections).toEqual([]);
    expect(native.commands.filter(({ type }) => type === "response.create")).toEqual([]);
    await endRecoveryRun(runId);
  }, 20_000);
});

describe("Questions recovery across independent workerd processes", () => {
  it("restores accepted non-default automatic turn detection after pending Question recovery", async () => {
    const runId = "questions-recovery-retained-vad";
    await startGoodbyeRecovery(runId, 60_000, true, "high");
    expect(
      (
        await recoveryRequest(runId, "/node-fixture?status=pending&target=question", {
          method: "POST",
        })
      ).status,
    ).toBe(200);
    await crashProcess(runId);
    await restoreProcess(runId);
    const response = await recoveryRequest(runId, "/provider", {
      headers: { Upgrade: "websocket" },
    });
    const socket = response.webSocket;
    if (socket === null) throw new Error("recovered_provider_socket_missing");
    socket.accept();
    const commands = async () =>
      nativeCommandEvidence.parse(await (await recoveryRequest(runId, "/commands")).json());
    const configuration = async (automatic: boolean) =>
      (await commands()).commands.find(
        (command) =>
          command.type === "session.update" &&
          command.session?.audio.input.turn_detection?.create_response === automatic,
      )?.session;
    await expect
      .poll(() => configuration(false))
      .toMatchObject({
        audio: {
          input: {
            turn_detection: {
              type: "semantic_vad",
              eagerness: "high",
              create_response: false,
              interrupt_response: false,
            },
          },
        },
      });
    const update = await configuration(false);
    socket.send(
      JSON.stringify({
        type: "session.updated",
        event_id: "recovered-question-suppression",
        session: update,
      }),
    );
    await expect.poll(() => goodbyeCommands(runId)).toHaveLength(1);
    const created = (await goodbyeCommands(runId))[0];
    socket.send(
      JSON.stringify({
        type: "response.created",
        response: { id: "recovered-question", metadata: created?.response?.metadata },
      }),
    );
    await expect
      .poll(() => configuration(true))
      .toEqual({
        type: "realtime",
        audio: {
          input: {
            turn_detection: {
              type: "semantic_vad",
              eagerness: "high",
              create_response: true,
              interrupt_response: false,
            },
          },
        },
      });
    const restored = await configuration(true);
    socket.send(
      JSON.stringify({
        type: "session.updated",
        event_id: "recovered-question-restoration",
        session: { ...restored, instructions: update?.instructions },
      }),
    );
    expect(await readRecovery(runId)).toMatchObject({
      stage: "live",
      visit: { state: "question", context: { questionIndex: 1, questionCount: 2 } },
    });
    expect((await commands()).creations).toBe(0);
    await endRecoveryRun(runId);
    socket.close();
  });
  it.each(["pending", "claimed", "dispatched"] as const)(
    "retains the cursor and shared deadline after a %s question entry",
    async (status) => {
      const runId = `questions-recovery-${status}`;
      const initial = await startGoodbyeRecovery(runId, 60_000, true);
      expect(
        (
          await recoveryRequest(runId, `/node-fixture?status=${status}&target=question`, {
            method: "POST",
          })
        ).status,
      ).toBe(200);
      const before = await readRecovery(runId);
      expect(before.visit.context).toEqual({ questionIndex: 1, questionCount: 2 });
      await crashProcess(runId);
      await restoreProcess(runId);
      const restored = await readRecovery(runId);
      expect(restored.visit.context).toEqual(before.visit.context);
      expect(restored.node.timers).toEqual(initial.node.timers);
      expect(restored.node.dispatch?.input).toEqual(before.node.dispatch?.input);
      const commands = nativeCommandEvidence.parse(
        await (await recoveryRequest(runId, "/commands")).json(),
      );
      expect(commands.creations).toBe(0);
      if (status === "pending") {
        expect(restored.visit.operationId).not.toBe(before.visit.operationId);
        expect(restored.stage).toBe("live");
        await endRecoveryRun(runId);
      } else {
        expect(restored.stage).not.toBe("live");
        expect(
          commands.commands.filter((command) => command.type === "response.create"),
        ).toHaveLength(0);
      }
    },
  );
  it("refuses a schema-valid Question prompt inconsistent with the durable cursor before native acquisition", async () => {
    const runId = "questions-recovery-input-mismatch";
    await startGoodbyeRecovery(runId, 60_000, true);
    expect(
      (
        await recoveryRequest(runId, "/node-fixture?status=pending&target=question&mismatch=1", {
          method: "POST",
        })
      ).status,
    ).toBe(200);
    await crashProcess(runId);
    await restoreProcess(runId);
    await expect
      .poll(() => readRecovery(runId))
      .toMatchObject({ node: { dispatch: { limitation: "conversation_node_input_invalid" } } });
    const commands = nativeCommandEvidence.parse(
      await (await recoveryRequest(runId, "/commands")).json(),
    );
    expect(commands.creations).toBe(0);
    expect(commands.connections).toEqual([]);
    expect(commands.commands).toEqual([]);
  });
});

describe("the voice Gate's test options on actual workerd", () => {
  const gateEvidence = z.object({
    commands: z.array(z.record(z.string(), z.json())),
    calls: z.array(z.record(z.string(), z.json())),
  });
  const commandsOf = async (runId: string) =>
    gateEvidence.parse(await (await recoveryRequest(runId, "/commands")).json());
  const recordsOf = async (runId: string, type: string) =>
    z
      .object({ records: z.array(z.object({ type: z.string(), payloadJson: z.string() })) })
      .parse(await (await recoveryRequest(runId, `/diagnostics?runId=${runId}`)).json())
      .records.filter((record) => record.type === type)
      .map((record) => z.record(z.string(), z.json()).parse(JSON.parse(record.payloadJson)));
  const sessionUpdate = z.object({
    type: z.literal("session.update"),
    session: z.object({
      instructions: z.string().optional(),
      tools: z.array(z.json()).optional(),
      audio: z.object({
        input: z.object({ turn_detection: z.object({ create_response: z.boolean() }) }),
      }),
    }),
  });

  it("creates the call without tools, supplies next_question for question 1's answer and enters question 2", async () => {
    const runId = "gate-questions";
    await startGoodbyeRecovery(runId, 60_000, true);
    // The call offers no tool and no tool choice, and OpenAI's turn detection starts no reply
    // for the opening question's turns.
    const [call] = (await commandsOf(runId)).calls;
    expect(call).toMatchObject({
      tools: [],
      audio: { input: { turn_detection: { create_response: false } } },
    });
    expect(call).not.toHaveProperty("tool_choice");
    expect(await recordsOf(runId, "gate.test_options")).toEqual([
      { noTools: true, suppliedReply: "next_question" },
    ]);

    const response = await recoveryRequest(runId, "/provider", {
      headers: { Upgrade: "websocket" },
    });
    const socket = response.webSocket;
    if (socket === null) throw new Error("provider_socket_missing");
    socket.accept();
    // Question 1's answer ends on its own: OpenAI commits it and starts no reply.
    socket.send(
      JSON.stringify({
        type: "input_audio_buffer.committed",
        event_id: "event-answer-1",
        item_id: "answer-1",
        previous_item_id: null,
      }),
    );
    const updates = async (automatic: boolean) =>
      (await commandsOf(runId)).commands.flatMap((command) => {
        const update = sessionUpdate.safeParse(command);
        return update.success &&
          update.data.session.audio.input.turn_detection.create_response === automatic
          ? [{ ...update.data, sent: command }]
          : [];
      });
    // Question 2's node: its instructions with no tools, while automatic turns stay off.
    await expect.poll(async () => (await updates(false)).length, { timeout: 10_000 }).toBe(1);
    const [suppressed] = await updates(false);
    expect(suppressed?.session.tools).toEqual([]);
    expect(suppressed?.session.instructions).toBe(sampleQuestionPrompts[1]);
    socket.send(
      JSON.stringify({
        type: "session.updated",
        event_id: "gate-suppressed",
        session: suppressed?.sent.session,
      }),
    );
    await expect.poll(() => goodbyeCommands(runId), { timeout: 10_000 }).toHaveLength(1);
    const [created] = await goodbyeCommands(runId);
    socket.send(
      JSON.stringify({
        type: "response.created",
        response: { id: "question-2", metadata: created?.response?.metadata },
      }),
    );
    await expect.poll(async () => (await updates(true)).length, { timeout: 10_000 }).toBe(1);
    // OpenAI never saw the supplied call: no output answers it and no reply was cancelled.
    const types = (await commandsOf(runId)).commands.map((command) => command.type);
    expect(types).not.toContain("conversation.item.create");
    expect(types).not.toContain("response.cancel");
    expect(await recordsOf(runId, "realtime.reply_supplied")).toEqual([
      expect.objectContaining({ toolName: "next_question" }),
    ]);
    expect(await recordsOf(runId, "conversation.transition")).toEqual([
      { from: "question", to: "question", questionIndex: 1 },
    ]);
    expect(await readRecovery(runId)).toMatchObject({
      stage: "live",
      visit: { state: "question", context: { questionIndex: 1, questionCount: 2 } },
    });
    await endRecoveryRun(runId);
    socket.close();
  }, 30_000);

  it("supplies nothing for the answer Ending commits after End", async () => {
    const runId = "gate-questions-end";
    await startGoodbyeRecovery(runId, 60_000, true);
    const response = await recoveryRequest(runId, "/provider", {
      headers: { Upgrade: "websocket" },
    });
    const socket = response.webSocket;
    if (socket === null) throw new Error("provider_socket_missing");
    socket.accept();
    socket.send(JSON.stringify({ type: "input_audio_buffer.speech_started", event_id: "speech" }));
    await endRecoveryRun(runId);
    // Ending closes input before it commits the answer in progress.
    await expect
      .poll(async () => (await commandsOf(runId)).commands.map((command) => command.type), {
        timeout: 10_000,
      })
      .toContain("input_audio_buffer.commit");
    socket.send(
      JSON.stringify({
        type: "input_audio_buffer.committed",
        event_id: "event-final-answer",
        item_id: "final-answer",
        previous_item_id: null,
      }),
    );
    await expect
      .poll(async () => (await readRecovery(runId)).receivedEvents, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(2);
    expect(await recordsOf(runId, "realtime.reply_supplied")).toEqual([]);
    expect(await recordsOf(runId, "conversation.transition")).not.toContainEqual(
      expect.objectContaining({ to: "question" }),
    );
    socket.close();
  }, 30_000);
});
