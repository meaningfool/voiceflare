import { act } from "react";
import { afterEach, beforeEach } from "vitest";
import { z } from "zod";

type VitestAsymmetricMatcher = Readonly<{
  asymmetricMatch(value: unknown): boolean;
}>;

const vitestAsymmetricMatcherSchema = z.custom<VitestAsymmetricMatcher>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "asymmetricMatch" in value &&
    typeof value.asymmetricMatch === "function",
);

export function readVitestAsymmetricMatcher<Value>(value: Value): VitestAsymmetricMatcher {
  return vitestAsymmetricMatcherSchema.parse(value);
}

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const hasDom = typeof document !== "undefined";
type ConsoleMethod = (...data: unknown[]) => void;
type CapturedConsoleCall = {
  method: "console.error" | "console.warn";
  data: unknown[];
};

let capturedCalls: CapturedConsoleCall[] = [];
let originalConsoleError: ConsoleMethod | undefined;
let originalConsoleWarn: ConsoleMethod | undefined;

if (hasDom) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

export async function runInAct(callback: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await callback();
    // Keep promise continuations started by the interaction inside the owner boundary.
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve();
    }
  });
}

beforeEach(() => {
  if (!hasDom) {
    return;
  }

  capturedCalls = [];
  originalConsoleError = console.error;
  originalConsoleWarn = console.warn;
  console.error = (...data) => {
    capturedCalls.push({ method: "console.error", data });
  };
  console.warn = (...data) => {
    capturedCalls.push({ method: "console.warn", data });
  };
});

afterEach(() => {
  if (!hasDom) {
    return;
  }

  const unexpectedCalls = capturedCalls;
  const restoreError = originalConsoleError;
  const restoreWarn = originalConsoleWarn;
  capturedCalls = [];
  originalConsoleError = undefined;
  originalConsoleWarn = undefined;

  if (restoreError !== undefined) {
    console.error = restoreError;
  }
  if (restoreWarn !== undefined) {
    console.warn = restoreWarn;
  }

  if (unexpectedCalls.length > 0) {
    throw new Error(formatUnexpectedConsoleCalls(unexpectedCalls));
  }
});

function formatUnexpectedConsoleCalls(calls: CapturedConsoleCall[]): string {
  const uniqueCalls = new Map<string, CapturedConsoleCall>();
  for (const call of calls) {
    const key = `${call.method}:${call.data.map(formatConsoleValue).join(" ")}`;
    uniqueCalls.set(key, call);
  }

  return [
    "Unexpected console output in a DOM test:",
    ...[...uniqueCalls.values()].map(
      ({ method, data }) => `${method}: ${data.map(formatConsoleValue).join(" ")}`,
    ),
  ].join("\n");
}

function formatConsoleValue<Value>(value: Value): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }

  try {
    return JSON.stringify(value) ?? "[unserializable value]";
  } catch {
    return "[unserializable value]";
  }
}
