import { jsonResponse, safeString } from "../../shared/http.ts";
import { decodeRuntimeConnectionExchange } from "../../shared/contracts/runtimeConnection.ts";
import { parseRuntimeStartRequest } from "../../shared/contracts/runtimeStart.ts";
import type { RuntimeControllerCapability, RuntimeEnvironmentCapabilities } from "../types.ts";

type RuntimeControllerOperation =
  | "state"
  | "start"
  | "fake-control-ready"
  | "presence"
  | "media-ready";

type RuntimeControllerResponseOperation =
  | "connection"
  | "events"
  | "diagnostics"
  | "complete"
  | "required-stop"
  | "resolve-application-acceptance";

type RuntimeControllerPayload = Readonly<Record<string, unknown>> & Readonly<{ runId: string }>;

type JsonObjectResult =
  | Readonly<{ ok: true; value: Record<string, unknown> }>
  | Readonly<{ ok: false }>;

export async function handleRuntimeControllerRoute(
  request: Request,
  env: RuntimeEnvironmentCapabilities,
): Promise<Response | null> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments[0] !== "_runtime" || segments[1] !== "controllers" || segments.length < 3) {
    return null;
  }

  const runId = decodeRuntimeControllerRunId(segments[2] ?? "");

  if (runId === null) {
    return jsonResponse(request, env, { error: "invalid_runtime_controller_request" }, 400);
  }

  if (runId.length === 0) {
    return jsonResponse(request, env, { error: "missing_run_id" }, 400);
  }

  const controllerResult = getRuntimeControllerResponse(request, env, runId);

  if (!controllerResult.ok) {
    if (segments[3] === "connection" && request.method === "POST") {
      return jsonResponse(
        request,
        env,
        { error: "runtime_controller_unavailable", acceptance: "not_accepted" },
        503,
      );
    }
    return controllerResult.response;
  }

  const controller = controllerResult.controller;

  try {
    if (
      segments.length === 4 &&
      segments[3] === "resolve-application-acceptance" &&
      request.method === "POST"
    ) {
      return await callRuntimeControllerResponse(controller, "resolve-application-acceptance", {
        runId,
      });
    }

    if (segments.length === 4 && segments[3] === "attachment" && request.method === "GET") {
      // The browser's media attachment upgrade passes to the Run's Durable Object unchanged;
      // its selected execution session accepts or refuses it.
      const url = new URL("https://runtime-controller.local/attachment");
      url.searchParams.set("runId", runId);
      return await controller.fetch(new Request(url, request));
    }

    if (segments.length === 3 && request.method === "GET") {
      const result = await callRuntimeController(controller, "state", { runId });
      return result.state === null
        ? jsonResponse(request, env, { error: "runtime_controller_not_started" }, 404)
        : jsonResponse(request, env, result.state);
    }

    if (segments.length === 4 && segments[3] === "start" && request.method === "POST") {
      const payload = await readOptionalJsonObject(request);

      if (!payload.ok) {
        return jsonResponse(request, env, { error: "invalid_runtime_controller_request" }, 400);
      }

      const target = payload.value.deliveryTarget;
      if (
        target === null ||
        typeof target !== "object" ||
        Array.isArray(target) ||
        !("integration" in target) ||
        target.integration !== request.headers.get("X-Runtime-Application")
      ) {
        return jsonResponse(
          request,
          env,
          { error: "runtime_delivery_application_mismatch", acceptance: "not_accepted" },
          400,
        );
      }
      return jsonResponse(
        request,
        env,
        await callRuntimeController(controller, "start", {
          ...payload.value,
          runId,
        }),
        201,
      );
    }

    if (segments.length === 4 && segments[3] === "connection" && request.method === "POST") {
      const payload = await readJsonObject(request);

      if (!payload.ok) {
        return jsonResponse(
          request,
          env,
          { error: "invalid_runtime_controller_request", acceptance: "not_accepted" },
          400,
        );
      }

      const runtimeStartRequest = {
        ...payload.value,
        runId,
      };
      if (payload.value.execution === undefined) {
        return await callRuntimeControllerResponse(controller, "connection", {
          runId,
          connection: decodeRuntimeConnectionExchange(payload.value.connection),
        });
      }
      const parsedStartRequest = parseRuntimeStartRequest(runtimeStartRequest);

      if (!parsedStartRequest.ok) {
        return jsonResponse(
          request,
          env,
          { error: parsedStartRequest.error, acceptance: "not_accepted" },
          400,
        );
      }

      if (parsedStartRequest.value.deliveryTarget === undefined) {
        return jsonResponse(
          request,
          env,
          { error: "runtime_delivery_unconfigured", acceptance: "not_accepted" },
          400,
        );
      }
      if (
        parsedStartRequest.value.deliveryTarget !== undefined &&
        request.headers.get("X-Runtime-Application") !==
          parsedStartRequest.value.deliveryTarget.integration
      ) {
        return jsonResponse(
          request,
          env,
          { error: "runtime_delivery_application_mismatch", acceptance: "not_accepted" },
          400,
        );
      }
      return await callRuntimeControllerResponse(
        controller,
        "connection",
        parsedStartRequest.value,
      );
    }

    if (
      segments.length === 4 &&
      (segments[3] === "events" || segments[3] === "diagnostics") &&
      request.method === "GET"
    ) {
      return await callRuntimeControllerResponse(
        controller,
        segments[3],
        {
          runId,
        },
        new URL(request.url).searchParams,
        request.signal,
      );
    }

    if (
      segments.length === 4 &&
      segments[3] === "fake-control-ready" &&
      request.method === "POST"
    ) {
      const payload = await readOptionalJsonObject(request);

      if (!payload.ok) {
        return jsonResponse(request, env, { error: "invalid_runtime_controller_request" }, 400);
      }

      return jsonResponse(
        request,
        env,
        await callRuntimeController(controller, "fake-control-ready", {
          ...payload.value,
          runId,
        }),
      );
    }

    if (segments.length === 4 && segments[3] === "complete" && request.method === "POST") {
      const payload = await readJsonObject(request);

      if (!payload.ok) {
        return jsonResponse(request, env, { error: "invalid_runtime_controller_request" }, 400);
      }

      return await callRuntimeControllerResponse(controller, "complete", {
        ...payload.value,
        runId,
      });
    }

    if (segments.length === 4 && segments[3] === "required-stop" && request.method === "POST") {
      const payload = await readJsonObject(request);
      if (!payload.ok) {
        return jsonResponse(request, env, { error: "invalid_runtime_controller_request" }, 400);
      }
      return await callRuntimeControllerResponse(controller, "required-stop", {
        ...payload.value,
        runId,
      });
    }

    if (
      segments.length === 4 &&
      (segments[3] === "presence" || segments[3] === "media-ready") &&
      request.method === "POST"
    ) {
      const payload = await readJsonObject(request);

      if (!payload.ok) {
        return jsonResponse(request, env, { error: "invalid_runtime_controller_request" }, 400);
      }

      return jsonResponse(
        request,
        env,
        await callRuntimeController(controller, segments[3], {
          ...payload.value,
          runId,
        }),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return runtimeControllerErrorResponse(request, env, message);
  }

  return null;
}

async function callRuntimeController(
  controller: RuntimeControllerCapability,
  operation: RuntimeControllerOperation,
  payload: RuntimeControllerPayload,
): Promise<Record<string, unknown>> {
  const response =
    operation === "state"
      ? await controller.fetch(
          new Request(
            `https://runtime-controller.local/state?runId=${encodeURIComponent(payload.runId)}`,
          ),
        )
      : await controller.fetch(
          new Request(`https://runtime-controller.local/${operation}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          }),
        );
  const result = await response.json();

  if (!isRecord(result)) {
    throw new Error("runtime_controller_failed");
  }

  if (!response.ok) {
    throw new Error(typeof result.error === "string" ? result.error : "runtime_controller_failed");
  }

  return result;
}

async function callRuntimeControllerResponse(
  controller: RuntimeControllerCapability,
  operation: RuntimeControllerResponseOperation,
  payload: RuntimeControllerPayload,
  searchParams: URLSearchParams | null = null,
  signal?: AbortSignal,
): Promise<Response> {
  const url = new URL(`https://runtime-controller.local/${operation}`);

  if (operation === "events" || operation === "diagnostics") {
    if (searchParams !== null) {
      for (const [key, value] of searchParams) {
        url.searchParams.set(key, value);
      }
    }

    url.searchParams.set("runId", payload.runId);

    return await controller.fetch(new Request(url, { method: "GET", signal: signal ?? null }));
  }

  return await controller.fetch(
    new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
  );
}

function getRuntimeControllerResponse(
  request: Request,
  env: RuntimeEnvironmentCapabilities,
  runId: string,
):
  | Readonly<{ ok: true; controller: RuntimeControllerCapability }>
  | Readonly<{ ok: false; response: Response }> {
  const namespace = env.INTERVIEW_RUNTIME_CONTROLLER;

  if (namespace === undefined) {
    return {
      ok: false,
      response: jsonResponse(request, env, { error: "runtime_controller_unavailable" }, 503),
    };
  }

  if (typeof namespace.getByName === "function") {
    return {
      ok: true,
      controller: namespace.getByName(runId),
    };
  }

  if (typeof namespace.idFromName === "function" && typeof namespace.get === "function") {
    return {
      ok: true,
      controller: namespace.get(namespace.idFromName(runId)),
    };
  }

  return {
    ok: false,
    response: jsonResponse(request, env, { error: "runtime_controller_unavailable" }, 503),
  };
}

async function readOptionalJsonObject(request: Request): Promise<JsonObjectResult> {
  if (request.headers.get("Content-Length") === "0" || request.body === null) {
    return {
      ok: true,
      value: {},
    };
  }

  return readJsonObject(request);
}

async function readJsonObject(request: Request): Promise<JsonObjectResult> {
  try {
    const value = await request.json();

    if (!isRecord(value)) {
      return {
        ok: false,
      };
    }

    return {
      ok: true,
      value,
    };
  } catch {
    return {
      ok: false,
    };
  }
}

function runtimeControllerErrorResponse(
  request: Request,
  env: RuntimeEnvironmentCapabilities,
  message: string,
): Response {
  switch (message) {
    case "missing_run_id":
      return jsonResponse(request, env, { error: "missing_run_id" }, 400);
    case "invalid_runtime_duration":
      return jsonResponse(request, env, { error: "invalid_runtime_duration" }, 400);
    case "invalid_runtime_presence_request":
      return jsonResponse(request, env, { error: "invalid_runtime_presence_request" }, 400);
    case "invalid_end_reason":
      return jsonResponse(request, env, { error: "invalid_end_reason" }, 400);
    case "runtime_controller_not_started":
      return jsonResponse(request, env, { error: "runtime_controller_not_started" }, 404);
    case "runtime_controller_run_mismatch":
      return jsonResponse(request, env, { error: "runtime_controller_run_mismatch" }, 409);
    default:
      return jsonResponse(
        request,
        env,
        {
          error: "runtime_controller_failed",
          message,
        },
        500,
      );
  }
}

function isRecord<Value>(value: Value): value is Value & Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeRuntimeControllerRunId(value: string): string | null {
  try {
    return safeString(decodeURIComponent(value), "");
  } catch {
    return null;
  }
}
