import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { platformBuildOptions } from "../shared/testing/platformBuild.ts";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createRuntimeTranscriptSnapshot } from "../shared/runtimeTranscriptSnapshot.ts";
import { liveFinalizationAggregate } from "./testing/finalizationFixtures.ts";
import type { RuntimePublicationRecord } from "./runtimePublication.ts";

let platform: Miniflare;
let script: string;
let directory: string;
let record: RuntimePublicationRecord;
let reply: ReturnType<typeof deferred<Response>>;
const callbacks: Request[] = [];

beforeAll(async () => {
  const bundle = await build({
    ...platformBuildOptions,
    stdin: {
      contents: `
        import { DurableObject } from "cloudflare:workers";
        import { Effect } from "effect";
        import { RuntimePublication } from "./worker/runtime/runtimePublication.ts";
        export class PublicationProbe extends DurableObject {
          constructor(ctx, env) {
            super(ctx, env);
            ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS publication (id INTEGER PRIMARY KEY, record TEXT NOT NULL)");
            this.wakeups = 0;
            this.publication = new RuntimePublication({
              execution: { run: (operation) => Effect.runPromise(operation), runExit: (operation) => Effect.runPromiseExit(operation) },
              storage: { read: () => this.read(), persist: (aggregate) => this.write({ ...this.read(), aggregate }) },
              events: { recordEvent() {}, recordUniqueDiagnostic() { return null; } },
              transports: { authorize: async () => {}, deliver: (_target, _callback, request) => env.CALLBACK.fetch(request) }, backgroundWork: { waitUntil: (task) => ctx.waitUntil(task) },
              requestAlarmRecomputation: () => Effect.sync(() => { this.wakeups++; }), now: () => Number(env.CLOCK),
            });
          }
          read() { const rows = this.ctx.storage.sql.exec("SELECT record FROM publication WHERE id = 1").toArray(); return rows[0] ? JSON.parse(rows[0].record) : null; }
          write(record) { this.ctx.storage.sql.exec("INSERT OR REPLACE INTO publication (id, record) VALUES (1, ?)", JSON.stringify(record)); }
          async fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/initialize") this.write(await request.json());
            if (path === "/schedule" || path === "/settle") {
              const record = this.read();
              const schedule = this.publication.scheduleTerminal({ completion: record.aggregate.state.completion, observedAt: Number(this.env.CLOCK) });
              if (!schedule.scheduled) return Response.json(schedule);
              if (path === "/settle") return Response.json(await schedule.task);
              return Response.json({ scheduled: true });
            }
            return Response.json({ record: this.read(), wakeups: this.wakeups });
          }
        }
        export default { fetch(request, env) { return env.PUBLICATION.getByName("publication").fetch(request); } };`,
      resolveDir: process.cwd(),
    },
  });
  script = bundle.outputFiles[0]?.text ?? "";
}, 30_000);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "publication-owner-"));
  reply = deferred<Response>();
  callbacks.length = 0;
  const snapshot = await createRuntimeTranscriptSnapshot(0, { turns: [] });
  const completion = {
    runId: "native_publication",
    outcome: "ended" as const,
    endReason: "participant_stopped" as const,
    source: "browser_request" as const,
    endingStartedAt: 1_000,
    endedAt: 2_000,
    finalizationCutoffAt: 11_000,
    finalizedAt: 2_000,
    transcriptSnapshot: snapshot,
    warnings: [],
  };
  const aggregate = liveFinalizationAggregate({ runId: completion.runId });
  record = {
    runId: completion.runId,
    deliveryTargetJson: JSON.stringify({
      integration: "lab",
      context: { runId: completion.runId },
    }),
    diagnosticsContextJson: JSON.stringify({ surface: "lab" }),
    aggregate: {
      ...aggregate,
      state: {
        stage: "ended",
        completion,
        publication: {
          status: "pending",
          publicationCutoffAt: 32_000,
          // The Transcript was delivered earlier: these attempts carry only the result.
          transcriptDelivered: true,
          completionDelivered: false,
          retryAt: null,
          attemptCount: 0,
          deliveredAt: null,
          lastError: null,
        },
        effects: [],
      },
    },
  };
  openPlatform(3_000);
  await platform.dispatchFetch("https://owner.test/initialize", {
    method: "POST",
    body: JSON.stringify(record),
  });
});

afterEach(async () => {
  // Disposal/reopen checks retained native SQLite, not arbitrary deployed eviction or skipped finalizers.
  await platform?.dispose();
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

function openPlatform(now: number) {
  platform = new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2026-06-05",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { PUBLICATION: { className: "PublicationProbe", useSQLite: true } },
    durableObjectsPersist: join(directory, "objects"),
    bindings: { CLOCK: String(now) },
    serviceBindings: {
      CALLBACK: async (request: Request) => {
        callbacks.push(request.clone());
        return reply.promise;
      },
    },
  });
}

async function inspect() {
  return (await platform.dispatchFetch("https://owner.test/inspect")).json();
}

async function acknowledge() {
  const callback = z
    .object({
      completion: z.object({
        transcriptSnapshot: z.object({
          revision: z.number(),
          digest: z.string(),
          turnCount: z.number(),
        }),
      }),
    })
    .parse(await callbacks[0]?.json());
  reply.resolve(
    Response.json({
      version: 2,
      status: "completed",
      requestedMatches: true,
      storedSnapshot: callback.completion.transcriptSnapshot,
    }),
  );
}

describe("publication owner on native workerd Durable Object storage", () => {
  it("retains publication after the scheduling response ends", async () => {
    expect(await (await platform.dispatchFetch("https://owner.test/schedule")).json()).toEqual({
      scheduled: true,
    });
    await expect.poll(() => callbacks.length).toBe(1);
    expect(await inspect()).toMatchObject({
      record: { aggregate: { state: { publication: { status: "pending" } } } },
      wakeups: 0,
    });
    await acknowledge();
    await expect.poll(inspect).toMatchObject({
      record: {
        aggregate: {
          state: {
            publication: {
              status: "delivered",
              publicationCutoffAt: 32_000,
              attemptCount: 1,
              deliveredAt: 3_000,
            },
          },
        },
      },
      wakeups: 1,
    });
  });

  it("reconstructs pending native SQLite work at the retained cutoff without another callback", async () => {
    reply.resolve(new Response(null, { status: 503 }));
    await platform.dispatchFetch("https://owner.test/schedule");
    await expect.poll(inspect).toMatchObject({
      record: {
        aggregate: {
          state: {
            publication: {
              status: "retrying",
              publicationCutoffAt: 32_000,
              retryAt: 5_000,
              attemptCount: 1,
            },
          },
        },
      },
      wakeups: 1,
    });
    await platform.dispose();
    openPlatform(32_000);
    expect(await (await platform.dispatchFetch("https://owner.test/settle")).json()).toEqual({
      status: "expired",
      cutoffAt: 32_000,
    });
    expect(await inspect()).toMatchObject({
      record: {
        aggregate: {
          state: {
            ...record.aggregate.state,
            publication: {
              status: "expired",
              publicationCutoffAt: 32_000,
              retryAt: null,
              attemptCount: 1,
            },
          },
        },
      },
      wakeups: 1,
    });
    expect(callbacks).toHaveLength(1);
  });
});

function deferred<Value>() {
  let resolve: (value: Value) => void = () => {
    throw new Error("uninitialized_deferred");
  };
  let reject: (error: Error) => void = () => {
    throw new Error("uninitialized_deferred");
  };
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
