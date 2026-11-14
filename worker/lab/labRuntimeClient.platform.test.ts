import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { platformBuildOptions } from "../shared/testing/platformBuild.ts";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

let platform: Miniflare;
let directory: string;
let reopen: () => Miniflare;
const requests: Request[] = [];
const bodies: unknown[] = [];
beforeAll(async () => {
  const bundle = await build({
    ...platformBuildOptions,
    stdin: {
      resolveDir: process.cwd(),
      contents: `
    import {requestLabRequiredStop} from "./worker/lab/labRuntimeClient.ts";
    import {LabStartupDeadline} from "./worker/lab/labStartupDeadline.ts";
    export class DeadlineProbe extends LabStartupDeadline {
      async snapshot() {return {startup: await this.ctx.storage.get("startup"), alarmAt: await this.ctx.storage.getAlarm()};}
    }
    export default {async fetch(request,env) {
      const url = new URL(request.url);
      if (url.pathname !== "/stop") {
        const stub = env.LAB_STARTUP_DEADLINE.getByName("lab_original");
        if (url.pathname === "/arm") {
          try {await stub.arm("lab_original", Number(url.searchParams.get("expiresAt")));}
          catch {return new Response(null, {status:409});}
        }
        return Response.json(await stub.snapshot());
      }
      let observed;
      const caller = {fetch(input){ observed=input; return env.RUNTIME_WORKER.fetch(input); }};
      const result = await requestLabRequiredStop(caller, new Request("https://runtime.internal/_runtime/controllers/lab_bounded/required-stop", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({runId:"lab_bounded",reason:"application_startup_failed"})}));
      return Response.json({result, aborted: observed.signal.aborted});
    }};`,
    },
  });
  directory = await mkdtemp(join(tmpdir(), "lab-bounded-"));
  reopen = () =>
    new Miniflare({
      modules: true,
      script: bundle.outputFiles[0]?.text ?? "",
      durableObjects: { LAB_STARTUP_DEADLINE: { className: "DeadlineProbe", useSQLite: true } },
      durableObjectsPersist: directory,
      compatibilityDate: "2026-06-05",
      compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
      serviceBindings: {
        RUNTIME_WORKER: async (request: Request) => {
          requests.push(request);
          bodies.push(await request.json());
          return new Promise<Response>(() => {});
        },
      },
    });
  platform = reopen();
}, 30_000);
afterAll(async () => {
  await platform?.dispose();
  await rm(directory, { recursive: true, force: true });
});
describe("native Lab bounded required-stop caller", () => {
  it("returns an uncertain stop at its bound and aborts its actual request without retrying", async () => {
    const response = await platform.dispatchFetch("https://lab.test/stop");
    expect(await response.json()).toEqual({ result: null, aborted: true });
    expect(bodies).toEqual([{ runId: "lab_bounded", reason: "application_startup_failed" }]);
    expect(requests).toHaveLength(1);
    // Native transport cancellation does not establish remote execution cancellation.
  }, 10_000);
  it("reconstructs the original deadline and rejects a rearm that would renew it", async () => {
    const expiresAt = Date.now() + 60_000;
    const inspect = async (path: string) => {
      const response = await platform.dispatchFetch(`https://lab.test/${path}`);
      return z
        .object({
          startup: z.object({ runId: z.string(), expiresAt: z.number() }),
          alarmAt: z.number(),
        })
        .parse(await response.json());
    };
    expect(await inspect(`arm?expiresAt=${expiresAt}`)).toEqual({
      startup: { runId: "lab_original", expiresAt },
      alarmAt: expiresAt,
    });
    await platform.dispose();
    platform = reopen();
    expect(await inspect("snapshot")).toEqual({
      startup: { runId: "lab_original", expiresAt },
      alarmAt: expiresAt,
    });
    expect(
      (await platform.dispatchFetch(`https://lab.test/arm?expiresAt=${expiresAt + 30_000}`)).status,
    ).toBe(409);
    expect(await inspect(`arm?expiresAt=${expiresAt}`)).toEqual({
      startup: { runId: "lab_original", expiresAt },
      alarmAt: expiresAt,
    });
  });
});
