export interface HttpEnvironment {
  readonly ALLOWED_ORIGIN?: string;
}

export interface UndefinedEntries<Value> {
  readonly [key: string]: Value | undefined;
}

export interface DefinedEntries<Value> {
  [key: string]: Value;
}

export type RedactableData =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | CallableFunction
  | null
  | undefined
  | RedactableData[]
  | { readonly [key: string]: RedactableData };

/** `exposedHeaders` are the caller's own response headers its browser reads besides Location. */
export function corsHeaders<Environment extends object>(
  request: Request,
  env: Environment & HttpEnvironment,
  exposedHeaders: readonly string[] = [],
): Headers {
  const headers = new Headers();
  const allowedOrigin =
    "ALLOWED_ORIGIN" in env && typeof env.ALLOWED_ORIGIN === "string" ? env.ALLOWED_ORIGIN : "*";
  const requestOrigin = request.headers.get("Origin");

  headers.set(
    "Access-Control-Allow-Origin",
    allowedOrigin === "*" ? "*" : requestOrigin === allowedOrigin ? requestOrigin : allowedOrigin,
  );
  headers.set("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Expose-Headers", ["Location", ...exposedHeaders].join(","));

  return headers;
}

export function jsonResponse<Environment extends object, Data>(
  request: Request,
  env: Environment & HttpEnvironment,
  data: Data,
  status = 200,
  exposedHeaders: readonly string[] = [],
): Response {
  const headers = corsHeaders(request, env, exposedHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");

  return new Response(JSON.stringify(redactSecrets(data), null, 2), {
    status,
    headers,
  });
}

export function safeString<Value>(value: Value, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function clampInteger(value: string, fallback: number, max: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1_000, Math.min(max, parsed));
}

export function withoutUndefined<Value>(object: UndefinedEntries<Value>): DefinedEntries<Value> {
  const definedEntries: DefinedEntries<Value> = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined) continue;
    Object.defineProperty(definedEntries, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return definedEntries;
}

export function redactSecrets(value: string): string;
export function redactSecrets<Value>(value: Value): RedactableData;
export function redactSecrets<Value>(value: Value): RedactableData {
  if (typeof value === "string") {
    return redactSecretString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactSecrets(item)]),
    );
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function"
  ) {
    return value;
  }

  return value === null ? null : undefined;
}

function redactSecretString(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-redacted")
    .replace(/ek_[A-Za-z0-9_-]+/g, "ek_redacted");
}
