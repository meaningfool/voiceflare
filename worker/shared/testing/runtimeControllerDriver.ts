import { z } from "zod";

import { boundary } from "../../../tools/boundary-contracts/boundary-contracts.mjs";

type RuntimeControllerFetchTarget = Readonly<{
  fetch(request: Request): Response | Promise<Response>;
}>;

export type RuntimeControllerDriverResponse = Readonly<{
  status: number;
  data: Record<string, unknown>;
  headers: Headers;
}> &
  Readonly<Record<string, unknown>>;

type JsonRequest = Readonly<Record<string, unknown>>;
type RuntimeControllerJson = z.output<typeof runtimeControllerJsonSchema>;
type RuntimeControllerResponseData = RuntimeControllerJson | string | undefined;

const runtimeControllerJsonSchema = z.json();

const readRuntimeControllerJson = boundary({
  schema: runtimeControllerJsonSchema,
  convert: (value): RuntimeControllerJson => value,
});

type EventsRequest = Readonly<{
  runId: string;
  sessionId?: string;
  durationMs: number;
}>;

export class RuntimeControllerTestDriver {
  readonly #controller: RuntimeControllerFetchTarget;
  readonly #baseUrl: string;

  constructor(
    controller: RuntimeControllerFetchTarget,
    baseUrl = "https://runtime-controller.test",
  ) {
    this.#controller = controller;
    this.#baseUrl = baseUrl;
  }

  /** Start requires an explicit Conversation selection and its execution input. */
  async start(
    request: JsonRequest & Readonly<{ selection: unknown; execution: unknown }>,
  ): Promise<RuntimeControllerDriverResponse> {
    return this.#jsonRequest("/start", request);
  }

  /**
   * Starts a Run through its connection exchange, as every application does.
   * A success also answers the Realtime profile's SDP answer as `answerSdp`.
   */
  async startConnection(request: JsonRequest): Promise<RuntimeControllerDriverResponse> {
    const normalizedRequest = withStartupDefaults(request);
    const response = await this.#request("/connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalizedRequest),
    });
    const result: Record<string, unknown> = requireObject(response.data);
    if (response.status >= 400) return this.#withData(response, result);

    const reply = isRecord(result.reply) ? result.reply : {};
    const diagnostics = isRecord(result.diagnostics) ? result.diagnostics : {};
    return this.#withData(response, {
      ...result,
      answerSdp: typeof reply.sdp === "string" ? reply.sdp : "",
      sessionId: typeof diagnostics.sessionId === "string" ? diagnostics.sessionId : "",
      sessionLocation:
        typeof diagnostics.sessionLocation === "string" ? diagnostics.sessionLocation : null,
      upstreamRequestId:
        typeof diagnostics.upstreamRequestId === "string" ? diagnostics.upstreamRequestId : null,
      settingsSummary: readEncodedJsonObject(response.headers.get("X-Runtime-Settings-Summary")),
    });
  }

  async resolveApplicationAcceptance(
    request: JsonRequest,
  ): Promise<RuntimeControllerDriverResponse> {
    return this.#jsonRequest("/resolve-application-acceptance", request);
  }

  async requiredStop(request: JsonRequest): Promise<RuntimeControllerDriverResponse> {
    return this.#jsonRequest("/required-stop", request);
  }

  async fakeControlReady(request: JsonRequest = {}): Promise<RuntimeControllerDriverResponse> {
    return this.#jsonRequest("/fake-control-ready", request);
  }

  async complete(request: JsonRequest): Promise<RuntimeControllerDriverResponse> {
    return this.#jsonRequest("/complete", request);
  }

  async mediaReady(request: JsonRequest): Promise<RuntimeControllerDriverResponse> {
    return this.#jsonRequest("/media-ready", request);
  }

  async presence(request: JsonRequest): Promise<RuntimeControllerDriverResponse> {
    return this.#jsonRequest("/presence", request);
  }

  async events(request: EventsRequest): Promise<RuntimeControllerDriverResponse> {
    const search = new URLSearchParams({
      runId: request.runId,
      durationMs: String(request.durationMs),
    });
    if (request.sessionId !== undefined) {
      search.set("sessionId", request.sessionId);
    }

    const response = await this.#request(`/events?${search.toString()}`);
    if (response.status >= 400) {
      return this.#withData(response, requireObject(response.data));
    }

    const events = typeof response.data === "string" ? parseEventStream(response.data) : [];
    return this.#withData(response, { events });
  }

  async state(
    request: Readonly<{ runId?: string }> = {},
  ): Promise<RuntimeControllerDriverResponse> {
    const search = request.runId === undefined ? "" : `?runId=${encodeURIComponent(request.runId)}`;
    return this.#jsonRequest(`/state${search}`, {}, "GET");
  }

  async #jsonRequest(
    path: string,
    request: JsonRequest,
    method: "GET" | "POST" = "POST",
  ): Promise<RuntimeControllerDriverResponse> {
    const init: RequestInit = { method };
    if (method === "POST") {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(request);
    }
    const response = await this.#request(path, init);
    return this.#withData(response, requireObject(response.data));
  }

  async #request(
    path: string,
    init: RequestInit = {},
  ): Promise<Readonly<{ status: number; data: RuntimeControllerResponseData; headers: Headers }>> {
    const response = await this.#controller.fetch(new Request(`${this.#baseUrl}${path}`, init));
    const body = await response.text();
    const contentType = response.headers.get("Content-Type") ?? "";
    const data = contentType.includes("application/json") ? parseJson(body) : body;
    return { status: response.status, data, headers: response.headers };
  }

  #withData<Data extends Record<string, unknown>>(
    response: Readonly<{
      status: number;
      data: RuntimeControllerResponseData;
      headers: Headers;
    }>,
    data: Data,
  ): RuntimeControllerDriverResponse {
    return {
      ...data,
      status: response.status,
      data,
      headers: response.headers,
    };
  }
}

/**
 * A Start's delivery target: the application Runtime delivers this Run's callbacks to, Lab or the
 * test application.
 */
export function deliveryTo(integration: "test" | "lab", runId: string) {
  return { deliveryTarget: { integration, context: { runId } } } as const;
}

function withStartupDefaults(request: JsonRequest) {
  const normalized = { ...request };
  if (!Object.hasOwn(request, "startupExpiresAt")) {
    normalized.startupExpiresAt = Date.now() + 30_000;
  }
  return normalized;
}

function requireObject<Value>(value: Value): Value & Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }

  throw new Error("runtime_controller_driver_expected_object_response");
}

function readEncodedJsonObject(value: string | null): Record<string, unknown> {
  if (value === null) {
    return {};
  }

  try {
    const parsed = parseJson(decodeURIComponent(value));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJson(value: string): RuntimeControllerJson | undefined {
  try {
    return readRuntimeControllerJson(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function parseEventStream(
  value: string,
): readonly Readonly<{ event: string; data: RuntimeControllerJson | string }>[] {
  return value
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const event = block.match(/^event:\s*(.+)$/mu)?.[1] ?? "message";
      const dataText = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (dataText.length === 0) {
        return null;
      }

      let data: RuntimeControllerJson | string = dataText;
      try {
        data = readRuntimeControllerJson(JSON.parse(dataText));
      } catch {
        // Keep non-JSON SSE payloads as text.
      }

      return { event, data };
    })
    .filter(
      (entry): entry is Readonly<{ event: string; data: RuntimeControllerJson | string }> =>
        entry !== null,
    );
}

function isRecord<Value>(value: Value): value is Value & Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
