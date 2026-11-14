import { build, type Plugin } from "esbuild";
import { parse } from "jsonc-parser";
import { Miniflare } from "miniflare";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { platformBuildOptions } from "../../worker/shared/testing/platformBuild.ts";
import { withSubstituteContent } from "./labContent.ts";

/**
 * Runtime with only OpenAI's transport controlled: its call creation, side connection and
 * hangup. Host, controller, Conversation and delivery are Runtime's own. An offer that names
 * `fail-start` makes call creation report the provider's 503.
 */
const runtimeEntry = `
import runtime from "./worker/runtime.ts";
import { InterviewRuntimeController } from "./worker/runtimeHostController.ts";
import { realtimeTestDriver } from "./worker/providers/openaiRealtime/testing/testDriver.ts";
import { providerSuccess, providerFailure } from "./worker/runtime/providerOutcomes.ts";
import { createFakeRealtimeSideConnection } from "./worker/providers/openaiRealtime/testing/fakeSideConnection.ts";
export class Controller extends InterviewRuntimeController {
  constructor(ctx, env) {
    let peer;
    super(ctx, env, { realtimeDriver: realtimeTestDriver({
      createCall: async (input) => {
        await env.PROVIDER.fetch("https://provider.test/create");
        if (input.sdp.includes("fail-start")) return providerFailure({stage:"call_creation",code:"provider_call_http_503",providerStatus:503,retryable:false});
        return providerSuccess({status:201,answerSdp:"v=0\\r\\ncontrolled-lab-answer",responseContentType:"application/sdp",sessionLocation:"https://provider.test/rtc_lab",sessionId:"rtc_lab",upstreamRequestId:"req_lab"});
      },
      connectSideband: async () => {
        const side = createFakeRealtimeSideConnection(); peer = side.provider; peer.accept();
        return providerSuccess(side.connection);
      },
      hangUp: async () => {
        await env.PROVIDER.fetch("https://provider.test/hangup");
        peer?.close(1000,"provider_hangup");
        return providerSuccess({status:204,upstreamRequestId:"req_lab_hangup"});
      }
    }) });
  }
}
export default runtime;`;

/** Test reads by path: the provider operations, a Run's Runtime state, else the Lab Worker. */
const routerEntry = `
export default { fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/__test/provider-operations") return env.PROVIDER.fetch("https://provider.test/operations");
  if (url.pathname === "/__test/runtime")
    return env.RUNTIME.fetch("https://runtime.test/_runtime/controllers/" + encodeURIComponent(url.searchParams.get("runId") ?? ""));
  return env.LAB.fetch(request);
} };`;

async function bundle(root: string, contents: string, plugins: Plugin[] = []): Promise<string> {
  const result = await build({
    ...platformBuildOptions,
    plugins,
    stdin: { contents, resolveDir: root },
  });
  return result.outputFiles[0]?.text ?? "";
}

/** The Lab Worker's imports of Lab's content folder, from the substitute content folder. */
const substituteContent: Plugin = {
  name: "lab-runtime-session-content",
  setup(build) {
    build.onResolve({ filter: /^\.\.?\// }, ({ path, resolveDir }) => {
      const own = resolve(resolveDir, path);
      const substitute = withSubstituteContent(own);
      return substitute === own ? undefined : { path: substitute };
    });
  },
};

const wranglerSchema = z.object({
  compatibility_date: z.string(),
  compatibility_flags: z.array(z.string()),
  d1_databases: z.array(z.object({ binding: z.string(), database_id: z.string() })).optional(),
});
async function wranglerConfig(root: string, file: string) {
  return wranglerSchema.parse(parse(await readFile(join(root, file), "utf8")));
}

/**
 * The Lab Worker, built with the substitute content folder, serving its built page and its D1
 * database, with the Runtime above; Runtime delivers to Lab through its private callbacks. Lab's database is the one `wrangler d1
 * migrations apply --local --persist-to <state>` prepared, read from `<state>/v3/d1`.
 */
export async function createLabRuntimePlatform(
  options: Readonly<{ port: number; root: string; labAssets: string; labState: string }>,
) {
  const [runtimeScript, labScript, lab, runtime] = await Promise.all([
    bundle(options.root, runtimeEntry),
    bundle(
      options.root,
      `export * from "./worker/lab.ts"; export { default } from "./worker/lab.ts";`,
      [substituteContent],
    ),
    wranglerConfig(options.root, "wrangler.lab.jsonc"),
    wranglerConfig(options.root, "wrangler.runtime.jsonc"),
  ]);
  const labDatabase = lab.d1_databases?.find(({ binding }) => binding === "LAB_DB");
  if (labDatabase === undefined) throw new Error("wrangler.lab.jsonc declares no LAB_DB");
  const operations: string[] = [];
  const platform = new Miniflare({
    host: "127.0.0.1",
    port: options.port,
    d1Persist: join(options.labState, "v3", "d1"),
    workers: [
      {
        name: "router",
        modules: true,
        script: routerEntry,
        compatibilityDate: lab.compatibility_date,
        serviceBindings: {
          LAB: "lab",
          RUNTIME: "runtime",
          PROVIDER: async () => Response.json(operations),
        },
      },
      {
        name: "lab",
        modules: true,
        script: labScript,
        compatibilityDate: lab.compatibility_date,
        compatibilityFlags: lab.compatibility_flags,
        assets: {
          directory: options.labAssets,
          binding: "ASSETS",
          routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
        },
        d1Databases: { LAB_DB: labDatabase.database_id },
        durableObjects: {
          LAB_STARTUP_DEADLINE: { className: "LabStartupDeadline", useSQLite: true },
        },
        serviceBindings: { RUNTIME_WORKER: "runtime" },
      },
      {
        name: "runtime",
        modules: true,
        script: runtimeScript,
        compatibilityDate: runtime.compatibility_date,
        compatibilityFlags: runtime.compatibility_flags,
        // Lab offers a Realtime Conversation only when Runtime holds OpenAI's key. The
        // controlled transport never sends it anywhere.
        bindings: { OPENAI_API_KEY: "synthetic-test-key" },
        durableObjects: {
          INTERVIEW_RUNTIME_CONTROLLER: { className: "Controller", useSQLite: true },
        },
        serviceBindings: {
          LAB_CALLBACK_WORKER: { name: "lab", entrypoint: "LabRuntimeCallbacks" },
          PROVIDER: async (request: Request) => {
            operations.push(new URL(request.url).pathname);
            return new Response(null, { status: 204 });
          },
        },
      },
    ],
  });
  await platform.ready;
  return platform;
}
