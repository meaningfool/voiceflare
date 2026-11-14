import { z } from "zod";
import { decodeInterviewFinalizationAggregate } from "./interviewFinalizationPersistenceDecoder.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { platformBuildOptions } from "../shared/testing/platformBuild.ts";
import { Miniflare } from "miniflare";

let platform: Miniflare;

beforeAll(async () => {
  const bundle = await build({
    ...platformBuildOptions,
    stdin: {
      contents: `import { DurableObject } from "cloudflare:workers";
        import { Cause, Effect, Exit } from "effect";
        import { InterviewFinalizationCoordinator } from "./worker/runtime/interviewFinalizationCoordinator.ts";
        import { InterviewFinalizationRepository } from "./worker/runtime/interviewFinalizationRepository.ts";
        import { liveFinalizationAggregate } from "./worker/runtime/testing/finalizationFixtures.ts";
        import { advanceInterviewFinalization } from "./worker/runtime/interviewFinalizationFSM.ts";
        export class Finalization extends DurableObject {
          constructor(ctx, env) {
            super(ctx, env);
            this.instance = crypto.randomUUID();
            this.now = 1700000011001;
            this.calls = 0;
            this.exit = null;
            this.diagnostics = [];
            this.abort = new AbortController();
            this.repository = new InterviewFinalizationRepository(ctx.storage);
            this.repository.initialize();
            this.repository.createSetup({ runId: "native-finalization", runtimeId: "native-finalization",
              createdAt: 1700000000000, startedAt: 1700000000000,
              fakeSessionId: null,
              diagnosticsContext: { surface: "test" }, transcriptCapture: { sequence: 0, items: [] },
              publication: { status: "pending", transcriptDelivered: false, completionDelivered: false,
                retryAt: null, attemptCount: 0, deliveredAt: null, lastError: null } });
            this.repository.commitSetupToLive({ runId: "native-finalization", liveEvidenceAt: 1700000001000,
              transitionAt: 1700000001000, deadlineAt: 1700000061000, presenceGraceUntil: 1700000016000,
              aggregate: liveFinalizationAggregate({ runId: "native-finalization", liveAt: 1700000001000 }) });
            let aggregate = advanceInterviewFinalization(this.repository.readAggregate(), {
              kind: "end_requested", reason: "participant_stopped", source: "browser_request", at: 1700000002000 }).aggregate;
            for (const effect of aggregate.state.effects.filter(({status}) => status === "pending")) {
              aggregate = advanceInterviewFinalization(aggregate, { kind: "effect_outcome", effectId: effect.id,
                outcome: { status: "dispatched" }, at: 1700000002000 }).aggregate;
            }
            // Provider cleanup begins at the checkpoint while the final item's text is still owed.
            aggregate = advanceInterviewFinalization(aggregate, { kind: "participant_answer_created",
              itemId: "platform-final-item", generation: 1, sequence: 1 }).aggregate;
            aggregate = advanceInterviewFinalization(aggregate, { kind: "deadline_reached", deadline: "drain", at: 1700000011000 }).aggregate;
            this.repository.persistAggregate(aggregate, null);
            const now = () => this.now;
            this.coordinator = new InterviewFinalizationCoordinator({
              storage: { repository: this.repository, requestAlarm: (wakeAt) => Effect.sync(() => { this.wakeAt = wakeAt; }) },
              background: (task) => { ctx.waitUntil(task); task.catch((error) => { this.backgroundFailure = error.message; }); },
              now,
              publication: { scheduleTerminal: () => undefined },
              events: { recordEvent: () => undefined, recordDiagnostic: (type, payload) => this.diagnostics.push({ type, payload }) },
              provider: { connected: true, connecting: false, feasible: true, ensureConnected: () => undefined,
                sendFinalizationOperation: () => ({ status: "dispatched" }), drain: () => Effect.void,
                closeBarrier: (accepted) => accepted,
                release: () => { this.calls += 1; if (this.defect) throw new Error("background_native_defect");
                  const released = new Promise((resolve) => { this.finish = resolve; }); return Effect.promise(() => released); } }
            });
          }
          async fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/begin") {
              const owner = Effect.runPromiseExit(this.coordinator.executeSelectedRuntimeWorkEffect(), { signal: this.abort.signal });
              this.owner = owner.then((exit) => { this.exit = Exit.isFailure(exit) ? (Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "defect") : "completed"; });
              this.ctx.waitUntil(this.owner);
            }
            if (path === "/facade-defect") {
              this.defect = true;
              // This observer has left. The facade's real retained background
              // operation must independently report the defect.
              Effect.runPromise(this.coordinator.executeSelectedRuntimeWork()).catch(() => undefined);
            }
            if (path === "/interrupt") { this.abort.abort(); await this.owner; }
            if (path === "/alarm") { this.now = 1700000012001; await Effect.runPromise(this.coordinator.handleAlarmInvocation()); }
            if (path === "/late") {
              this.finish({ status: "closed" });
              await Effect.runPromise(this.coordinator.executeSelectedRuntimeWork());
            }
            return Response.json({ instance: this.instance, calls: this.calls, exit: this.exit,
              wakeAt: this.wakeAt, backgroundFailure: this.backgroundFailure, diagnostics: this.diagnostics, aggregate: this.repository.readAggregate(),
              completions: this.repository.readEventsByName("runtime.controller_completed").length });
          }
        }
        export default { fetch(request, env) { return env.FINALIZATION.getByName(new URL(request.url).searchParams.get("owner") ?? "same-instance").fetch(request); } };`,
      resolveDir: process.cwd(),
    },
  });
  platform = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]?.text ?? "",
    compatibilityDate: "2026-06-05",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { FINALIZATION: { className: "Finalization", useSQLite: true } },
  });
}, 30_000);

afterAll(async () => {
  await platform?.dispose();
});

describe("finalization Effect owner on actual workerd", () => {
  it("reconciles native interruption in the surviving SQLite instance and rejects late completion after the original cutoff", async () => {
    const begun = await state("/begin");
    expect(begun).toMatchObject({ aggregate: { state: { stage: "closing_provider" } } });
    await expect.poll(() => state("/state")).toMatchObject({ calls: 1 });
    const interrupted = await state("/interrupt");
    expect(interrupted.instance).toBe(begun.instance);
    expect(interrupted).toMatchObject({ calls: 1, exit: "interrupted" });
    expect(
      interrupted.aggregate.state.effects.find(({ kind }) => kind === "release_session"),
    ).toMatchObject({ status: "uncertain", attemptCount: 1 });
    const frozen = await state("/alarm");
    expect(frozen.instance).toBe(begun.instance);
    expect(frozen).toMatchObject({
      calls: 1,
      completions: 1,
      aggregate: {
        transcriptDigest: "sha256:d5fb095584e9f878eda4919412601f834c18fc24b3310d16ce21830a025a95f8",
        state: {
          stage: "ended",
          completion: { endReason: "participant_stopped", finalizationCutoffAt: 1_700_000_012_000 },
        },
      },
    });
    const late = await state("/late");
    expect(late.instance).toBe(begun.instance);
    expect(late.aggregate).toEqual(frozen.aggregate);
    expect(late).toMatchObject({ calls: 1, completions: 1 });
  });
  it("reports the retained Promise facade's defect on the native background path after its caller leaves", async () => {
    await state("/facade-defect?owner=background");
    await expect
      .poll(() => state("/state?owner=background"))
      .toMatchObject({
        calls: 1,
        backgroundFailure: "background_native_defect",
      });
    const observed = await state("/state?owner=background");
    expect(
      observed.aggregate.state.effects.find(({ kind }) => kind === "release_session"),
    ).toMatchObject({ status: "uncertain", attemptCount: 1 });
  });
});

async function state(path: string) {
  const response = await platform.dispatchFetch(`https://finalization.test${path}`);
  expect(response.status).toBe(200);
  // The probe adapter is owned test code; observations retain the actual
  // production decoder's concrete aggregate contract.
  const value = await response.json();
  const observed = stateSchema.parse(value);
  const aggregate = decodeInterviewFinalizationAggregate(JSON.stringify(observed.aggregate));
  if (aggregate === null) throw new Error("invalid_native_finalization_aggregate");
  return { ...observed, aggregate };
}

const stateSchema = z.object({
  instance: z.string(),
  calls: z.number(),
  exit: z.string().nullable(),
  wakeAt: z.number().nullable().optional(),
  aggregate: z.json(),
  completions: z.number(),
  backgroundFailure: z.string().optional(),
  diagnostics: z.array(z.object({ type: z.string(), payload: z.json() })),
});
