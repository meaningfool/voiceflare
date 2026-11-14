import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectConversationBoundaryViolations } from "./check-conversation-boundaries.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function write(root: string, file: string, source: string) {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), source);
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "conversation-guard-"));
  temporary.push(root);
  for (const path of [
    "worker/runtime/conversationContracts.ts",
    "worker/runtime/executionContracts.ts",
    "worker/runtime/diagnosticContracts.ts",
    "worker/runtime/nodeContentContracts.ts",
    "worker/runtime/interviewRuntimeController.ts",
    "worker/runtime/interviewStartupCoordinator.ts",
    "worker/runtime/conversationStartup.ts",
    "worker/runtime/interviewFinalizationCoordinator.ts",
    "worker/conversations/originalInterview.ts",
    "worker/conversations/goodbyeInterview.ts",
    "worker/conversations/questionsInterview.ts",
    "worker/implementations/originalRealtime/implementation.ts",
    "worker/implementations/goodbyeRealtime/implementation.ts",
    "worker/providers/openaiRealtime/connection.ts",
  ])
    await write(root, path, "export const valid = true;");
  return root;
}
describe("Conversation/execution architecture guard", () => {
  it("accepts the actual production graph, using only neutral native communication contracts", async () => {
    expect(await collectConversationBoundaryViolations()).toEqual([]);
  });
  it("rejects implementation sequence allocation and prebuilt append capabilities", async () => {
    const root = await fixture();
    await write(
      root,
      "worker/implementations/originalRealtime/providerSession.ts",
      `export function invalid(events) { events.nextDiagnosticSequence(); events.recordEvent("runtime.event_recorded", {}); }`,
    );
    expect(await collectConversationBoundaryViolations({ root })).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "implementation diagnostic construction bypass 'nextDiagnosticSequence'",
        ),
        expect.stringContaining("implementation cannot append prebuilt Runtime diagnostics"),
      ]),
    );
  });
  it.each([
    'import { decideConversationTransition as decide } from "../runtime/admission/private/definition.ts"; export { decide };',
    'export * from "../runtime/admission/private/definition.ts";',
    'export { issueStateReporter as issue } from "../runtime/admission/private/reporting.ts";',
    'export type Raw = import("../runtime/admission/private/implementation.ts").RuntimeImplementationDefinition;',
  ])("rejects private deep imports and reexports from any authored module: %s", async (source) => {
    const root = await fixture();
    for (const name of ["definition", "reporting", "implementation"])
      await write(
        root,
        "worker/runtime/admission/private/" + name + ".ts",
        "export const valid = true;",
      );
    await write(root, "escape.ts", source.replaceAll('"../runtime/', '"./worker/runtime/'));
    await write(
      root,
      "worker/runtime/interviewRuntimeController.ts",
      'export * from "../../escape.ts";',
    );
    expect(await collectConversationBoundaryViolations({ root })).toEqual(
      expect.arrayContaining([expect.stringContaining("escape.ts: private module dependency")]),
    );
  });
  it.each([
    [
      "executionContracts",
      'export { issueStateReporter as escaped } from "./admission/private/reporting.ts";',
    ],
    [
      "executionContracts",
      'import { issueStateReporter as issue } from "./admission/private/reporting.ts"; export const escaped = () => issue();',
    ],
    [
      "executionContracts",
      'export type { ReportingAuthority as Escaped } from "./admission/private/reporting.ts";',
    ],
    ["executionContracts", 'export * from "./admission/private/reporting.ts";'],
    [
      "conversationAdmission",
      'export { dispatchReportedNode as escaped } from "./admission/private/composition.ts";',
    ],
    [
      "implementationContracts",
      'export type { RuntimeImplementationDefinition as Escaped } from "./admission/private/implementation.ts";',
    ],
  ])("rejects private authority escaping through %s: %s", async (facade, source) => {
    const root = await fixture();
    for (const name of ["reporting", "composition", "implementation"])
      await write(
        root,
        "worker/runtime/admission/private/" + name + ".ts",
        "export const valid = true;",
      );
    await write(root, "worker/runtime/" + facade + ".ts", source);
    await write(root, "worker/runtime/helper.ts", 'export * from "./' + facade + '.ts";');
    await write(
      root,
      "worker/runtime/interviewRuntimeController.ts",
      'export * from "./helper.ts";',
    );
    expect(await collectConversationBoundaryViolations({ root })).toEqual(
      expect.arrayContaining([expect.stringContaining(facade + ".ts: private module dependency")]),
    );
  });
  it("fails closed when a required boundary owner is missing", async () => {
    const root = await fixture();
    await rm(join(root, "worker/runtime/executionContracts.ts"));
    expect(await collectConversationBoundaryViolations({ root })).toContain(
      "worker/runtime/executionContracts.ts: required boundary owner missing",
    );
  });
  it("fails closed when a pair folder has no definition", async () => {
    const root = await fixture();
    await write(root, "worker/implementations/newPair/session.ts", "export const valid = true;");
    expect(await collectConversationBoundaryViolations({ root })).toEqual([
      "worker/implementations/newPair/implementation.ts: required boundary owner missing",
    ]);
  });
  it.each(["worker/conversations", "worker/implementations", "worker/providers"])(
    "fails closed when %s holds no boundary owner",
    async (directory) => {
      const root = await fixture();
      await rm(join(root, directory), { recursive: true });
      expect(await collectConversationBoundaryViolations({ root })).toContain(
        `${directory}: required boundary owners missing`,
      );
    },
  );
  it.each([
    'import "../implementations/originalRealtime/implementation.ts";',
    'export * from "../implementations/originalRealtime/implementation.ts";',
    'import type * as Native from "../implementations/originalRealtime/implementation.ts"; export type Input = typeof Native;',
    'export type Input = import("../implementations/originalRealtime/implementation.ts").Input;',
  ])(
    "rejects direct and transitive concrete dependencies through authored import/export edges: %s",
    async (source) => {
      const root = await fixture();
      await write(root, "worker/conversations/originalInterview.ts", source);
      expect(
        (await collectConversationBoundaryViolations({ root })).some(
          (value) =>
            value.includes("pure boundary: forbidden dependency") &&
            value.includes("worker/implementations/originalRealtime/implementation.ts"),
        ),
      ).toBe(true);
      await write(root, "worker/conversations/helper.ts", source);
      await write(
        root,
        "worker/conversations/originalInterview.ts",
        'export * from "./helper.ts";',
      );
      expect(
        (await collectConversationBoundaryViolations({ root })).some((value) =>
          value.includes(
            "originalInterview.ts -> worker/conversations/helper.ts -> worker/implementations/originalRealtime/implementation.ts",
          ),
        ),
      ).toBe(true);
    },
  );
  it.each([
    'const transport = fetch; export const action = () => transport("https://invalid.test");',
    'const host = globalThis; export const action = () => host["fetch"]("https://invalid.test");',
    "export const action = ({ dispatch: perform }) => perform();",
    'import { request as action } from "node:http"; export { action };',
    'import { runPromise as action } from "effect"; export { action };',
    'export { runPromise as action } from "effect";',
    'export const action = ({ sql: database }) => database.exec("SELECT 1");',
    'export const action = () => import("./other.ts");',
  ])("rejects transitive raw capabilities and dynamic execution: %s", async (source) => {
    const root = await fixture();
    await write(
      root,
      "worker/conversations/originalInterview.ts",
      'import { action } from "./helper.ts"; export { action };',
    );
    await write(root, "worker/conversations/helper.ts", source);
    await write(root, "worker/conversations/other.ts", "export const value = true;");
    expect(
      (await collectConversationBoundaryViolations({ root })).some((value) =>
        /raw capability|external dependency|dynamic module/u.test(value),
      ),
    ).toBe(true);
  });
  it.each([
    "worker/runtime/interviewRuntimeController.ts",
    "worker/shared/persistence/storage.ts",
    "worker/runtimeHostComposition.ts",
    "worker/implementations/originalCascade/providerSession.ts",
  ])("rejects Conversation access to host, persistence or an execution: %s", async (target) => {
    const root = await fixture();
    await write(root, target, "export const value = true;");
    await write(root, "worker/conversations/originalInterview.ts", 'export * from "./helper.ts";');
    const specifier = target.replace(/^worker\//u, "../");
    await write(root, "worker/conversations/helper.ts", `export * from "${specifier}";`);
    expect(
      (await collectConversationBoundaryViolations({ root })).some(
        (value) => value.includes("pure boundary: forbidden dependency") && value.includes(target),
      ),
    ).toBe(true);
  });
  it("rejects generic Runtime composition dependencies even when hidden behind type exports", async () => {
    const root = await fixture();
    await write(root, "worker/runtimeHostComposition.ts", "export type Value = string;");
    await write(
      root,
      "worker/runtime/bridge.ts",
      'export type { Value } from "../runtimeHostComposition.ts";',
    );
    await write(
      root,
      "worker/runtime/interviewRuntimeController.ts",
      'import type { Value } from "./bridge.ts"; export type Input = Value;',
    );
    expect(
      (await collectConversationBoundaryViolations({ root })).some(
        (value) =>
          value.includes("generic boundary: forbidden dependency") &&
          value.includes("bridge.ts -> worker/runtimeHostComposition.ts"),
      ),
    ).toBe(true);
  });
  it("rejects a spike hidden behind a production export outside the source roots", async () => {
    const root = await fixture();
    await write(
      root,
      "docs/neutral.ts",
      'export * from "./exploration/spikes/disposable-conversation-machines/plugin.ts";',
    );
    await write(root, "src/entry.ts", 'export * from "../docs/neutral.ts";');
    expect(
      (await collectConversationBoundaryViolations({ root })).some((value) =>
        value.startsWith("docs/neutral.ts: disposable spike dependency"),
      ),
    ).toBe(true);
  });
  it("rejects generic native acquisition even through type-only implementation imports", async () => {
    const root = await fixture();
    await write(
      root,
      "worker/implementations/originalRealtime/providerSession.ts",
      "export class ProviderSession {}",
    );
    await write(
      root,
      "worker/runtime/interviewRuntimeController.ts",
      'import type { ProviderSession } from "../implementations/originalRealtime/providerSession.ts"; export type Session = ProviderSession;',
    );
    expect(
      (await collectConversationBoundaryViolations({ root })).some((value) =>
        value.includes("generic boundary: forbidden dependency"),
      ),
    ).toBe(true);
  });
  it("lets pairs of either execution kind share a Conversation definition without importing one another", async () => {
    const root = await fixture();
    const shared =
      'import { valid } from "../../conversations/originalInterview.ts"; export const handler = valid;';
    await write(root, "worker/implementations/originalRealtime/implementation.ts", shared);
    await write(root, "worker/implementations/originalCascade/implementation.ts", shared);
    await write(root, "worker/implementations/originalCascade/session.ts", shared);
    expect(await collectConversationBoundaryViolations({ root })).toEqual([]);
    await write(
      root,
      "worker/implementations/originalCascade/session.ts",
      'export { handler } from "../originalRealtime/implementation.ts";',
    );
    await write(
      root,
      "worker/providers/openaiRealtime/helper.ts",
      'export { valid } from "../../conversations/originalInterview.ts";',
    );
    expect(await collectConversationBoundaryViolations({ root })).toEqual([
      "worker/implementations/originalCascade/session.ts: cross-implementation dependency 'worker/implementations/originalRealtime/implementation.ts'",
      "worker/providers/openaiRealtime/helper.ts: provider kit dependency on Conversation 'worker/conversations/originalInterview.ts'",
    ]);
  });
  it.each([
    'export { command } from "../originalRealtime/providerCommands.ts";',
    'import type { Command } from "../originalRealtime/providerCommands.ts"; export type Input = Command;',
  ])("rejects cross-implementation native helpers: %s", async (source) => {
    const root = await fixture();
    await write(
      root,
      "worker/implementations/originalRealtime/providerCommands.ts",
      "export const command = {}; export type Command = {}; ",
    );
    await write(root, "worker/implementations/goodbyeRealtime/helper.ts", source);
    expect(await collectConversationBoundaryViolations({ root })).toContain(
      "worker/implementations/goodbyeRealtime/helper.ts: cross-implementation dependency 'worker/implementations/originalRealtime/providerCommands.ts'",
    );
  });
  it.each([
    'export { ProviderSession } from "../../implementations/goodbyeRealtime/providerSession.ts";',
    'import type { ProviderSession } from "../../implementations/goodbyeRealtime/providerSession.ts"; export type Session = ProviderSession;',
  ])("rejects a provider kit dependency on a Realtime pair: %s", async (source) => {
    const root = await fixture();
    await write(
      root,
      "worker/implementations/goodbyeRealtime/providerSession.ts",
      "export class ProviderSession {}",
    );
    await write(root, "worker/providers/openaiRealtime/helper.ts", source);
    expect(await collectConversationBoundaryViolations({ root })).toContain(
      "worker/providers/openaiRealtime/helper.ts: provider kit dependency on implementation 'worker/implementations/goodbyeRealtime/providerSession.ts'",
    );
  });
  it.each([
    ["generic", "worker/runtime/interviewRuntimeController.ts", "../providers"],
    ["pure", "worker/conversations/originalInterview.ts", "../providers"],
  ])("keeps the provider kit outside the %s boundary", async (policy, owner, prefix) => {
    const root = await fixture();
    await write(
      root,
      "worker/providers/openaiRealtime/providerCommands.ts",
      "export type Command = {};",
    );
    await write(
      root,
      owner,
      `import type { Command } from "${prefix}/openaiRealtime/providerCommands.ts"; export type Input = Command;`,
    );
    expect(
      (await collectConversationBoundaryViolations({ root })).some((value) =>
        value.startsWith(`${policy} boundary: forbidden dependency ${owner} -> worker/providers/`),
      ),
    ).toBe(true);
  });
  it("rejects disposable spike imports from every production surface", async () => {
    const root = await fixture();
    await write(
      root,
      "src/apps/lab/entry.ts",
      'export * from "../../../../docs/exploration/spikes/disposable-conversation-machines/plugin.ts";',
    );
    expect(
      (await collectConversationBoundaryViolations({ root })).some((value) =>
        value.startsWith("src/apps/lab/entry.ts: disposable spike dependency"),
      ),
    ).toBe(true);
  });
});
