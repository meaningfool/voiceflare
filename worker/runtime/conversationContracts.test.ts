import { admitImplementation } from "./admission/private/composition.ts";
import { implementExecutionHandlers } from "./admission/private/implementation.ts";
import { originalRealtimeImplementation } from "../implementations/originalRealtime/implementation.ts";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { runtimeHostAssembly } from "../runtimeHostComposition.ts";
import { originalRealtimeSelection } from "../shared/contracts/conversationSelection.ts";
import { expect, it } from "vitest";
import {
  declareStateContent,
  type ConversationState,
  type ConversationCallbackJson,
} from "./conversationContracts.ts";
import {
  originalInterviewContent,
  originalInterviewStates,
} from "../conversations/originalInterview.ts";
type DeclaredStates = Readonly<
  Record<string, ConversationState<unknown, ConversationCallbackJson>>
>;
it("refuses state content with missing, extra or structurally similar but different states", () => {
  const declared: DeclaredStates = originalInterviewStates;
  expect(() => declareStateContent(declared, {})).toThrow(
    "conversation_state_content_coverage_invalid",
  );
  expect(() =>
    declareStateContent(originalInterviewStates, {
      ...originalInterviewContent,
      extra: originalInterviewContent.interviewing,
    }),
  ).toThrow("conversation_state_content_coverage_invalid");
  expect(() =>
    declareStateContent(originalInterviewStates, {
      finishing: originalInterviewContent.finishing,
      interviewing: {
        ...originalInterviewContent.interviewing,
        contract: { ...originalInterviewStates.interviewing },
      },
    }),
  ).toThrow("conversation_state_content_contract_invalid");
});

it("accepts declared active and terminal states and refuses unknown persisted states", () => {
  expect(() =>
    runtimeHostAssembly.validateState(originalRealtimeSelection, "interviewing"),
  ).not.toThrow();
  expect(() =>
    runtimeHostAssembly.validateState(originalRealtimeSelection, "complete"),
  ).not.toThrow();
  expect(() =>
    runtimeHostAssembly.validateState(originalRealtimeSelection, "undeclared-state"),
  ).toThrow("conversation_visit_unavailable");
});

it("rejects incomplete execution ownership at composition before native work is available", () => {
  expect(() =>
    admitImplementation({ ...originalRealtimeImplementation, executionHandlers: {} }),
  ).toThrow("execution_handler_coverage_invalid");
  const declared: DeclaredStates = originalInterviewStates;
  expect(() => implementExecutionHandlers(declared, {})).toThrow(
    "execution_handler_coverage_invalid",
  );
});

it("makes a missing active-state execution handler a compiler error", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const configPath = fileURLToPath(new URL("../tsconfig.runtime.json", import.meta.url));
  const raw = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  const config = ts.parseJsonConfigFileContent(raw.config, ts.sys, root + "worker");
  const file = fileURLToPath(
    new URL("../implementations/originalRealtime/implementation.ts", import.meta.url),
  );
  const source = readFileSync(file, "utf8");
  const start = source.indexOf("    finishing: {", source.indexOf("executionHandlers:"));
  const end = source.indexOf("    },", start) + 7;
  expect(start).toBeGreaterThan(0);
  const host = ts.createCompilerHost(config.options);
  host.readFile = (path) =>
    path === file ? source.slice(0, start) + source.slice(end) : ts.sys.readFile(path);
  const program = ts.createProgram(config.fileNames, config.options, host);
  expect(
    ts
      .getPreEmitDiagnostics(program, program.getSourceFile(file))
      .some((diagnostic) => diagnostic.file?.fileName === file && diagnostic.code === 2345),
  ).toBe(true);
}, 20_000);

it("rejects incompatible execution entry policies during composition", () => {
  const nativeHandler = originalRealtimeImplementation.executionHandlers.interviewing;
  const retainedHandler = originalRealtimeImplementation.executionHandlers.finishing;
  if (nativeHandler === undefined || retainedHandler === undefined)
    throw new Error("handler_missing");
  const nativeWithoutEntry = { ...nativeHandler };
  Object.defineProperty(nativeWithoutEntry, "enter", { value: null });
  expect(() =>
    admitImplementation({
      ...originalRealtimeImplementation,
      executionHandlers: {
        ...originalRealtimeImplementation.executionHandlers,
        interviewing: nativeWithoutEntry,
      },
    }),
  ).toThrow("execution_handler_policy_invalid");

  const retainedWithEntry = { ...retainedHandler };
  Object.defineProperty(retainedWithEntry, "enter", {
    value: nativeHandler.enter,
  });
  expect(() =>
    admitImplementation({
      ...originalRealtimeImplementation,
      executionHandlers: {
        ...originalRealtimeImplementation.executionHandlers,
        finishing: retainedWithEntry,
      },
    }),
  ).toThrow("execution_handler_policy_invalid");
});

it("admits Original retained finishing output without an executable entry", () => {
  const implementation = admitImplementation(originalRealtimeImplementation);
  const admission = implementation.bindVisit(
    "finishing",
    {
      runId: "run",
      visitId: "visit",
      operationId: "operation",
      generation: 0,
    },
    () => true,
  );
  expect(admission.reporting.kind).toBe("retained_output");
  if (admission.reporting.kind !== "retained_output") throw new Error("retained_output_expected");
  expect(
    admission.reporting.observe({
      responseSettlement: "pending",
      outputAudioSettlement: "stopped",
      cleanupClaimed: false,
    }),
  ).toEqual({ kind: "pending" });
});
