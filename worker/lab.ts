import { corsHeaders, jsonResponse } from "./shared/http.ts";
import { handleHealth } from "./shared/routes/health.ts";
import {
  handleLabRunStart,
  handleLabConversationSelections,
  handleLabRuntimeConnection,
  handleLabRuntimeClose,
  handleLabRuntimeHealth,
  handleLabRuntimeStartup,
  handleLabRuntimePresence,
  handleLabRuntimeMediaReady,
  handleLabRuntimeMediaAttachment,
  handleLabRuntimeEvents,
} from "./lab/routes/labRuntime.ts";
import { handleLabStorageRoute } from "./lab/routes/labStorage.ts";
import { handleLabCascadeProviders } from "./lab/routes/labCascadeProviders.ts";
import { purgeExpiredRunDiagnosticEvents } from "./shared/persistence/runDiagnosticsD1.ts";
import type { LabEnvironmentCapabilities } from "./lab/types.ts";

export { LabStartupDeadline } from "./lab/labStartupDeadline.ts";
export { LabRuntimeCallbacks } from "./lab/labRuntimeCallbacks.ts";

const labServiceName = "lab";

export const labWorkerTestHarness = {
  async fetch(request: Request, env: LabEnvironmentCapabilities): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env),
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return handleHealth(request, env, labServiceName, {
        hasRuntimeWorkerBinding: env.RUNTIME_WORKER !== undefined,
        hasLabDatabaseBinding: env.LAB_DB !== undefined,
      });
    }

    if (request.method === "GET" && url.pathname === "/_api/conversation-selections") {
      return handleLabConversationSelections(request, env);
    }

    if (request.method === "GET" && url.pathname === "/_api/cascade-providers") {
      return handleLabCascadeProviders(request, env);
    }

    if (request.method === "GET" && isLabInternalPath(url.pathname, "/runtime/health")) {
      return handleLabRuntimeHealth(request, env);
    }

    if (request.method === "POST" && isLabInternalPath(url.pathname, "/runtime/runs")) {
      return handleLabRunStart(request, env);
    }

    if (
      request.method === "POST" &&
      /^\/_api\/runtime\/runs\/[^/]+\/connection$/.test(url.pathname)
    ) {
      return handleLabRuntimeConnection(request, env);
    }

    if (request.method === "GET" && /^\/_api\/runtime\/runs\/[^/]+\/startup$/.test(url.pathname)) {
      return handleLabRuntimeStartup(request, env);
    }

    if (request.method === "POST" && isLabRuntimeClosePath(url.pathname)) {
      return handleLabRuntimeClose(request, env);
    }

    if (
      request.method === "POST" &&
      /^\/_api\/runtime\/runs\/[^/]+\/media-ready$/.test(url.pathname)
    ) {
      return handleLabRuntimeMediaReady(request, env);
    }

    if (request.method === "GET" && /^\/_api\/runtime\/runs\/[^/]+\/media$/.test(url.pathname)) {
      return handleLabRuntimeMediaAttachment(request, env);
    }

    if (request.method === "POST" && isLabInternalPath(url.pathname, "/runtime/presence")) {
      return handleLabRuntimePresence(request, env);
    }

    if (request.method === "GET" && isLabInternalPath(url.pathname, "/runtime/events")) {
      return handleLabRuntimeEvents(request, env);
    }

    const labStorageResponse = await handleLabStorageRoute(request, env);

    if (labStorageResponse !== null) {
      return labStorageResponse;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      if (hasAssetsBinding(env) && isAssetRoute(url.pathname)) {
        return env.ASSETS.fetch(request);
      }

      if (isBrowserNavigation(request)) {
        return htmlNotFoundResponse(request);
      }
    }

    return jsonResponse(request, env, { error: "not_found" }, 404);
  },

  async scheduled(controller: ScheduledController, env: LabEnvironmentCapabilities) {
    if (env.LAB_DB === undefined) {
      throw new Error("missing_lab_database");
    }

    const result = await purgeExpiredRunDiagnosticEvents(env.LAB_DB, {
      now: controller.scheduledTime,
    });

    console.log(
      JSON.stringify({
        event: "run_diagnostics_retention_purged",
        service: labServiceName,
        scheduledTime: controller.scheduledTime,
        deletedRunEventCount: result.deletedCount,
      }),
    );
  },
} satisfies ExportedHandler<LabEnvironmentCapabilities>;

export default {
  fetch(request: Request, env: LabEnv, _ctx: ExecutionContext): Promise<Response> {
    return labWorkerTestHarness.fetch(request, env);
  },

  scheduled(controller: ScheduledController, env: LabEnv, _ctx: ExecutionContext): Promise<void> {
    return labWorkerTestHarness.scheduled(controller, env);
  },
} satisfies ExportedHandler<LabEnv>;

function isAssetRoute(pathname: string): boolean {
  return pathname === "/" || pathname.startsWith("/assets/");
}

function isLabInternalPath(pathname: string, suffix: string): boolean {
  return pathname === `/_api${suffix}`;
}

function isLabRuntimeClosePath(pathname: string): boolean {
  return /^\/_api\/runtime\/runs\/[^/]+\/complete$/.test(pathname);
}

function hasAssetsBinding(
  env: LabEnvironmentCapabilities,
): env is LabEnvironmentCapabilities & Required<Pick<LabEnvironmentCapabilities, "ASSETS">> {
  return env.ASSETS !== undefined && typeof env.ASSETS.fetch === "function";
}

function isBrowserNavigation(request: Request): boolean {
  return (
    request.headers.get("Sec-Fetch-Mode") === "navigate" ||
    request.headers.get("Accept")?.includes("text/html") === true
  );
}

function htmlNotFoundResponse(request: Request): Response {
  return new Response(request.method === "HEAD" ? null : notFoundHtml(), {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function notFoundHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>404 Not Found</title>
  </head>
  <body>
    <h1>404 Not Found</h1>
  </body>
</html>`;
}
