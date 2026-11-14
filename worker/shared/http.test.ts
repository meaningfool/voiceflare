import { describe, expect, it } from "vitest";

import {
  clampInteger,
  corsHeaders,
  jsonResponse,
  redactSecrets,
  safeString,
  withoutUndefined,
} from "./http.ts";
import type { HttpEnvironment } from "./http.ts";
import { handleHealth } from "./routes/health.ts";

describe("Shared HTTP helpers", () => {
  it("uses wildcard CORS for Worker environments without an origin binding", () => {
    const environment = {
      ASSETS: "test-assets-binding",
    };
    const headers = corsHeaders(new Request("https://example.test/health"), environment);

    expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(headers.get("Access-Control-Allow-Methods")).toBe("GET,POST,PATCH,OPTIONS");
  });

  it("keeps invalid origin bindings on the wildcard fallback", () => {
    const malformedEnvironment: HttpEnvironment = new Proxy(
      {},
      {
        get: (_target, property) => (property === "ALLOWED_ORIGIN" ? 42 : undefined),
      },
    );
    const headers = corsHeaders(new Request("https://example.test/health"), malformedEnvironment);
    const hiddenBindingHeaders = corsHeaders(
      new Request("https://example.test/health"),
      new Proxy(
        { ALLOWED_ORIGIN: "https://hidden.example.test" },
        {
          has: () => false,
        },
      ),
    );

    expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(hiddenBindingHeaders.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("preserves configured CORS, JSON, cache, status, and redaction behavior", async () => {
    const origin = "https://product.example.test";
    const request = new Request("https://example.test/resource", {
      headers: {
        Origin: origin,
      },
    });
    const response = jsonResponse(
      request,
      { ALLOWED_ORIGIN: origin },
      {
        apiKey: "sk-test-secret",
        ephemeralKey: "ek_test_secret",
      },
      201,
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      apiKey: "sk-redacted",
      ephemeralKey: "ek_redacted",
    });
  });

  it("keeps health and scalar helper behavior stable", async () => {
    const response = handleHealth(
      new Request("https://example.test/health"),
      { RUNTIME_WORKER: "test-runtime-binding" },
      "runtime",
      { region: "local" },
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "runtime",
      region: "local",
    });
    expect(safeString("  value  ", "fallback")).toBe("value");
    expect(safeString(null, "fallback")).toBe("fallback");
    expect(clampInteger("750", 2_000, 10_000)).toBe(1_000);
    expect(clampInteger("25000", 2_000, 10_000)).toBe(10_000);
    expect(withoutUndefined({ kept: true, dropped: undefined })).toEqual({ kept: true });
    expect(redactSecrets(["sk-one", { token: "ek_two" }])).toEqual([
      "sk-redacted",
      { token: "ek_redacted" },
    ]);
    expect(redactSecrets(undefined)).toBeUndefined();
  });

  it("preserves own dictionary keys without changing object prototypes", () => {
    const input: unknown = JSON.parse(
      '{"__proto__":{"token":"sk-secret"},"kept":true,"dropped":null}',
    );
    const defined = withoutUndefined({
      ...Object.fromEntries(Object.entries(input ?? {})),
      dropped: undefined,
    });

    expect(Object.hasOwn(defined, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(defined)).toBe(Object.prototype);
    expect(redactSecrets(defined)).toEqual(
      JSON.parse('{"__proto__":{"token":"sk-redacted"},"kept":true}'),
    );
    expect(Object.getPrototypeOf(redactSecrets(defined))).toBe(Object.prototype);
    expect(JSON.stringify(defined)).toBe('{"__proto__":{"token":"sk-secret"},"kept":true}');
  });
});
