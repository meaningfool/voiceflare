import { redactSecrets, withoutUndefined, type RedactableData } from "./http.ts";

const maxDiagnosticStringLength = 500;
const sensitiveDiagnosticKeys = new Set([
  "authorization",
  "cookie",
  "headers",
  "instructions",
  "providerpayload",
  "prompt",
  "publiclinktoken",
  "rawprovider",
  "rawproviderevent",
  "rawproviderpayload",
  "request",
  "sdp",
  "set-cookie",
  "setcookie",
  "stack",
  "stackname",
  "text",
  "token",
  "transcript",
  "turns",
]);

export function sanitizeDiagnosticPayload<Value>(value: Value): RedactableData {
  const redacted = redactSecrets(value);

  if (typeof redacted === "string") {
    return normalizeDiagnosticString(redacted);
  }

  if (Array.isArray(redacted)) {
    return redacted.slice(0, 8).map((item) => sanitizeDiagnosticPayload(item));
  }

  if (redacted !== null && typeof redacted === "object") {
    return withoutUndefined(
      Object.fromEntries(
        Object.entries(redacted).map(([key, item]) => [
          key,
          shouldDropDiagnosticKey(key) ? undefined : sanitizeDiagnosticPayload(item),
        ]),
      ),
    );
  }

  return redacted;
}

function shouldDropDiagnosticKey(key: string): boolean {
  return sensitiveDiagnosticKeys.has(key.replace(/_/g, "").toLowerCase());
}

function normalizeDiagnosticString<Value>(value: Value, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = redactSecrets(value).trim().replace(/\s+/g, " ");

  if (normalized.length === 0) {
    return fallback;
  }

  return normalized.length > maxDiagnosticStringLength
    ? `${normalized.slice(0, maxDiagnosticStringLength - 3)}...`
    : normalized;
}
