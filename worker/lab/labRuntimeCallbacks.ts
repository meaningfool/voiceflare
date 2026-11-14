import { WorkerEntrypoint } from "cloudflare:workers";
import type { LabEnvironmentCapabilities } from "./types.ts";
import { getLabDatabase, labRunExists } from "./persistence/labD1.ts";
import {
  handleLabRuntimeControllerCompletion,
  handleLabRuntimeControllerReadiness,
  handleLabRuntimeControllerTranscript,
} from "./routes/labRuntime.ts";

/** Lab's application callbacks, which Runtime calls on its private binding. */
export class LabRuntimeCallbacks extends WorkerEntrypoint<LabEnvironmentCapabilities> {
  async authorizeDelivery(request: Request): Promise<Response> {
    const runId = new URL(request.url).searchParams.get("runId") ?? "";
    const db = getLabDatabase(this.env);
    if (db === null || !(await labRunExists(db, runId))) return new Response(null, { status: 403 });
    return Response.json({ runId, authorized: true });
  }
  readiness(request: Request): Promise<Response> {
    return handleLabRuntimeControllerReadiness(request, this.env);
  }
  transcript(request: Request): Promise<Response> {
    return handleLabRuntimeControllerTranscript(request, this.env);
  }
  completion(request: Request): Promise<Response> {
    return handleLabRuntimeControllerCompletion(request, this.env);
  }
  /** Lab records its startup timings from its page, so it keeps nothing of Runtime's. */
  startupDiagnostic(): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 204 }));
  }
}
