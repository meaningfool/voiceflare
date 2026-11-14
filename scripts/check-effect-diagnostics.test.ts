import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectEffectEdgeViolations,
  collectEffectScopeViolations,
  collectEffectStyleViolations,
  collectRuntimeGlobalViolations,
  runEffectDiagnostics,
} from "./check-effect-diagnostics.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function write(root: string, file: string, source: string) {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), source);
}
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "effect-scope-"));
  temporary.push(root);
  return root;
}

/**
 * Each style of Effect code the project uses, with one `Date.now()` in it. `seen` marks the
 * styles in which the Effect language service itself recognizes Effect code.
 */
const styles = [
  { style: "Effect.gen", seen: true, code: "Effect.gen(function* () { return READ; })" },
  {
    style: "instance alias with Effect.gen",
    seen: true,
    code: "new (class { value = 1; read() { const self = this; return Effect.gen(function* () { return READ + self.value; }); } })().read()",
  },
  { style: "Effect.sync", seen: true, code: "Effect.sync(() => READ)" },
  { style: "Effect.suspend", seen: true, code: "Effect.suspend(() => Effect.succeed(READ))" },
  { style: "Effect.promise", seen: true, code: "Effect.promise(async () => READ)" },
  {
    style: "Effect.tryPromise",
    seen: true,
    code: "Effect.tryPromise({ try: async () => READ, catch: () => new Error() })",
  },
  {
    style: "Effect.try",
    seen: true,
    code: "Effect.try({ try: () => READ, catch: () => new Error() })",
  },
  { style: "pipe with Effect.map", seen: false, code: "Effect.void.pipe(Effect.map(() => READ))" },
  {
    style: "pipe with Effect.flatMap",
    seen: false,
    code: "pipe(Effect.void, Effect.flatMap(() => Effect.succeed(READ)))",
  },
  {
    style: "Effect.andThen",
    seen: false,
    code: "Effect.andThen(Effect.void, () => Effect.succeed(READ))",
  },
  {
    style: "Effect.tap",
    seen: false,
    code: "Effect.void.pipe(Effect.tap(() => Effect.succeed(READ)))",
  },
  {
    style: "Effect.catch",
    seen: false,
    code: "Effect.fail(new Error()).pipe(Effect.catch(() => Effect.succeed(READ)))",
  },
  {
    style: "Effect.acquireUseRelease",
    seen: false,
    code: "Effect.acquireUseRelease(Effect.void, () => Effect.succeed(READ), () => Effect.void)",
  },
  { style: "Effect.clockWith", seen: false, code: "Effect.clockWith(() => Effect.succeed(READ))" },
  {
    style: "Stream.mapEffect",
    seen: false,
    code: "Stream.succeed(1).pipe(Stream.mapEffect(() => Effect.succeed(READ)))",
  },
  {
    style: "Stream.runForEach",
    seen: false,
    code: "Stream.runForEach(Stream.succeed(1), () => Effect.succeed(READ))",
  },
  {
    style: "Layer.effect",
    seen: true,
    code: "Layer.effect(Probe, Effect.gen(function* () { return READ; }))",
  },
] as const;

/** A probe module with one style per line, from line 4 on. */
function probe(read: string) {
  return [
    'import { Context, Effect, Layer, Stream, pipe } from "effect";',
    'class Probe extends Context.Service<Probe, number>()("probe/Probe") {}',
    "export const probes = [",
    ...styles.map(({ code }) => `  ${code.replaceAll("READ", read)},`),
    "];",
    "export const outside = () => Date.now();",
    "",
  ].join("\n");
}
const styleLine = (index: number) => index + 4;
const outsideLine = styles.length + 5;

describe("Effect diagnostic scope guard", () => {
  it("requires the scope to list every Effect owner and nothing else", async () => {
    const root = await temporaryRoot();
    const owner = 'import { Effect } from "effect";\nexport const owned = Effect.void;';
    await write(root, "worker/listedOwner.ts", owner);
    await write(root, "worker/unlistedOwner.ts", 'import type { Layer } from "effect/Layer";');
    await write(root, "worker/testing/support.ts", owner);
    await write(root, "worker/plainContract.ts", "export type Contract = { id: string };");
    await write(
      root,
      "tsconfig.effect.json",
      JSON.stringify({ include: ["worker/listedOwner.ts", "worker/plainContract.ts"] }),
    );

    expect(collectEffectScopeViolations({ root })).toEqual([
      "Effect owner missing from tsconfig.effect.json: worker/unlistedOwner.ts",
      "tsconfig.effect.json lists a file that imports no Effect: worker/plainContract.ts",
    ]);
  });
});

describe("Effect code style", () => {
  it("refuses a generator passed to Effect.gen with options", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "worker/lab/owner.ts",
      [
        'import { Effect } from "effect";',
        "export class Owner {",
        "  value = 1;",
        "  hidden() {",
        "    return Effect.gen({ self: this }, function* () { return this.value; });",
        "  }",
        "  seen() {",
        "    const self = this;",
        "    return Effect.gen(function* () { return self.value; });",
        "  }",
        "}",
      ].join("\n"),
    );

    expect(collectEffectStyleViolations({ root })).toEqual([
      "worker/lab/owner.ts:5 passes options to Effect.gen, whose generator the Effect " +
        "diagnostics then do not inspect; alias the instance (`const self = this;`) and pass " +
        "the generator alone.",
    ]);
  });
});

describe("Runtime and kit globals", () => {
  it("reports a clock read in every style of Effect code and outside it, in Runtime code only", async () => {
    const root = await temporaryRoot();
    await write(root, "worker/runtime/probe.ts", probe("Date.now()"));
    await write(root, "worker/lab/probe.ts", probe("Date.now()"));

    expect(collectRuntimeGlobalViolations({ root, exemptions: [] })).toEqual([
      ...styles.map(
        (_, index) =>
          `worker/runtime/probe.ts:${styleLine(index)} (probes) calls Date.now(); Runtime and kit code uses Effect's Clock.`,
      ),
      `worker/runtime/probe.ts:${outsideLine} (outside) calls Date.now(); Runtime and kit code uses Effect's Clock.`,
    ]);
  });

  it("reports every way of reading the time, a timer and fetch in kit code", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "worker/providers/cascade/probe.ts",
      [
        "export const reads = () => [",
        "  new Date(),",
        "  Date(),",
        "  globalThis.Date.now(),",
        "  performance.now(),",
        '  new Date("2026-11-01T00:00:00Z"),',
        "  setTimeout(() => undefined, 1),",
        "  globalThis.setInterval(() => undefined, 1),",
        '  fetch("https://provider.test"),',
        "  Date.now,",
        "];",
      ].join("\n"),
    );

    expect(collectRuntimeGlobalViolations({ root, exemptions: [] })).toEqual([
      "worker/providers/cascade/probe.ts:2 (reads) calls new Date(); Runtime and kit code uses Effect's Clock.",
      "worker/providers/cascade/probe.ts:3 (reads) calls Date(); Runtime and kit code uses Effect's Clock.",
      "worker/providers/cascade/probe.ts:4 (reads) calls Date.now(); Runtime and kit code uses Effect's Clock.",
      "worker/providers/cascade/probe.ts:5 (reads) calls performance.now(); Runtime and kit code uses Effect's Clock.",
      "worker/providers/cascade/probe.ts:7 (reads) calls setTimeout(); Runtime and kit code uses Effect timers.",
      "worker/providers/cascade/probe.ts:8 (reads) calls setInterval(); Runtime and kit code uses Effect timers.",
      "worker/providers/cascade/probe.ts:9 (reads) calls fetch(); Runtime and kit code uses an injected transport.",
      "worker/providers/cascade/probe.ts:10 (reads) passes Date.now as a value; Runtime and kit code uses Effect's Clock.",
    ]);
  });

  it("leaves out exactly the reads an exemption names", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "worker/runtime/events.ts",
      [
        "export class Events {",
        "  record(at = Date.now()) { return at; }",
        "  expire() { return [Date.now(), Date.now()]; }",
        "}",
      ].join("\n"),
    );
    const exemption = (within: string, reads: number) => ({
      file: "worker/runtime/events.ts",
      within,
      global: "clock" as const,
      reads,
      reason: "Synchronous storage time.",
    });

    expect(
      collectRuntimeGlobalViolations({
        root,
        exemptions: [exemption("Events.record", 1), exemption("Events.expire", 1)],
      }),
    ).toEqual([
      "worker/runtime/events.ts (Events.expire) is exempt for 1 clock read(s) but has 2 at line 3, 3.",
    ]);
    expect(
      collectRuntimeGlobalViolations({
        root,
        exemptions: [exemption("Events.record", 1), exemption("Events.removed", 1)],
      }),
    ).toEqual([
      "worker/runtime/events.ts (Events.removed) is exempt for 1 clock read(s) but has 0.",
      "worker/runtime/events.ts:3 (Events.expire) calls Date.now(); Runtime and kit code uses Effect's Clock.",
      "worker/runtime/events.ts:3 (Events.expire) calls Date.now(); Runtime and kit code uses Effect's Clock.",
    ]);
  });
});

/** One form of each crossing, as the report names it. */
const crossingForms = [
  {
    code: "Effect.promise(async () => 1)",
    text: "turns a promise into Effect with Effect.promise",
  },
  {
    code: "Effect.tryPromise(async () => 1)",
    text: "turns a promise into Effect with Effect.tryPromise",
  },
  { code: "Effect.runPromise(Effect.void)", text: "launches Effect with Effect.runPromise" },
  { code: "Effect.runSync(Effect.void)", text: "launches Effect with Effect.runSync" },
  { code: "Effect.runFork(Effect.void)", text: "launches Effect with Effect.runFork" },
  {
    code: "Effect.runPromiseExit(Effect.void)",
    text: "launches Effect with Effect.runPromiseExit",
  },
  { code: "Effect.runSyncExit(Effect.void)", text: "launches Effect with Effect.runSyncExit" },
  { code: "Effect.runCallback(Effect.void)", text: "launches Effect with Effect.runCallback" },
  {
    code: "Effect.runPromiseWith(Context.empty())(Effect.void)",
    text: "launches Effect with Effect.runPromiseWith",
  },
  {
    code: "ManagedRuntime.make(Layer.empty).runPromise(Effect.void)",
    text: "launches Effect with a runtime's runPromise",
  },
  { code: "runtime.runSync(Effect.void)", text: "launches Effect with a runtime's runSync" },
  { code: "Deferred.makeUnsafe()", text: "uses the escape hatch Deferred.makeUnsafe" },
  { code: "Queue.offerUnsafe(queue, 1)", text: "uses the escape hatch Queue.offerUnsafe" },
  {
    code: "clock.currentTimeMillisUnsafe()",
    text: "uses the escape hatch clock.currentTimeMillisUnsafe",
  },
] as const;

/** A probe module with the crossing in each style of Effect code, then outside Effect code. */
function crossingProbe(crossing: string) {
  return probe(crossing).replace(
    "export const outside = () => Date.now();",
    `export const outside = () => ${crossing};`,
  );
}
const crossingReport = (file: string, line: number, within: string, text: string) =>
  `${file}:${line} (${within}) ${text}; Runtime and kit code crosses between promises and ` +
  "Effect only at a listed edge (effectEdges).";

describe("Runtime and kit Effect edge", () => {
  it("reports each crossing in every style of Effect code and outside it, in Runtime code only", async () => {
    for (const { code, text } of crossingForms) {
      const root = await temporaryRoot();
      await write(root, "worker/runtime/probe.ts", crossingProbe(code));
      await write(root, "worker/lab/probe.ts", crossingProbe(code));

      expect(collectEffectEdgeViolations({ root, edges: [] }), code).toEqual([
        ...styles.flatMap(({ style }, index) => [
          // The promise styles are crossings themselves, reported before the one inside them.
          ...(style === "Effect.promise" || style === "Effect.tryPromise"
            ? [
                crossingReport(
                  "worker/runtime/probe.ts",
                  styleLine(index),
                  "probes",
                  `turns a promise into Effect with ${style}`,
                ),
              ]
            : []),
          crossingReport("worker/runtime/probe.ts", styleLine(index), "probes", text),
        ]),
        crossingReport("worker/runtime/probe.ts", outsideLine, "outside", text),
      ]);
    }
  });

  it("reports a crossing however the file names Effect or its member", async () => {
    const root = await temporaryRoot();
    const file = "worker/providers/openaiRealtime/probe.ts";
    await write(
      root,
      file,
      [
        'import { Effect as E } from "effect";',
        'import * as Eff from "effect/Effect";',
        'import { runPromise as launch } from "effect/Effect";',
        'import { makeUnsafe } from "effect/Deferred";',
        "export const aliased = () => E.promise(async () => 1);",
        "export const namespaced = () => Eff.tryPromise(async () => 1);",
        "export const named = () => launch(E.void);",
        "export const destructured = () => { const { runSync } = E; return runSync(E.void); };",
        'export const element = () => E["runFork"](E.void);',
        "export const deferred = () => makeUnsafe<void>();",
      ].join("\n"),
    );

    expect(collectEffectEdgeViolations({ root, edges: [] })).toEqual([
      crossingReport(file, 3, "(module)", "launches Effect with Effect.runPromise"),
      crossingReport(file, 4, "(module)", "uses the escape hatch Deferred.makeUnsafe"),
      crossingReport(file, 5, "aliased", "turns a promise into Effect with Effect.promise"),
      crossingReport(file, 6, "namespaced", "turns a promise into Effect with Effect.tryPromise"),
      crossingReport(file, 8, "destructured", "launches Effect with Effect.runSync"),
      crossingReport(file, 9, "element", "launches Effect with Effect.runFork"),
    ]);
  });

  it("accepts the crossings a listed edge makes, in the module or the declaration it names", async () => {
    const root = await temporaryRoot();
    const file = "worker/providers/cascade/probe.ts";
    await write(
      root,
      file,
      [
        'import { Deferred, Effect } from "effect";',
        "export const adapter = () => Effect.promise(async () => 1);",
        "export const launch = () => Effect.runPromise(Effect.void);",
        "export const settle = () => Deferred.makeUnsafe();",
      ].join("\n"),
    );
    const edge = { file, reason: "A provider adapter." };

    expect(
      collectEffectEdgeViolations({
        root,
        edges: [{ ...edge, crossings: ["promise", "launch", "escape"] }],
      }),
    ).toEqual([]);
    expect(
      collectEffectEdgeViolations({
        root,
        edges: [
          { ...edge, within: "adapter", crossings: ["promise"] },
          { ...edge, within: "launch", crossings: ["launch"] },
        ],
      }),
    ).toEqual([crossingReport(file, 4, "settle", "uses the escape hatch Deferred.makeUnsafe")]);
    // An edge accepts only the kinds of crossing it lists.
    expect(
      collectEffectEdgeViolations({ root, edges: [{ ...edge, crossings: ["promise", "escape"] }] }),
    ).toEqual([crossingReport(file, 3, "launch", "launches Effect with Effect.runPromise")]);
  });

  it("refuses a listed edge that no longer makes a crossing it lists", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "worker/runtime/edge.ts",
      'import { Effect } from "effect";\nexport const read = () => Effect.promise(async () => 1);',
    );

    expect(
      collectEffectEdgeViolations({
        root,
        edges: [
          { file: "worker/runtime/edge.ts", crossings: ["promise", "launch"], reason: "An edge." },
          { file: "worker/runtime/removed.ts", crossings: ["escape"], reason: "Gone." },
          {
            file: "worker/runtime/edge.ts",
            within: "write",
            crossings: ["promise"],
            reason: "Gone too.",
          },
        ],
      }),
    ).toEqual([
      "worker/runtime/edge.ts is listed for launch crossings but makes none; remove it from the list.",
      "worker/runtime/removed.ts is listed for escape crossings but makes none; remove it from the list.",
      "worker/runtime/edge.ts (write) is listed for promise crossings but makes none; remove it from the list.",
    ]);
  });
});

describe("Effect language service", () => {
  it(
    "reports a clock read in each style it recognizes as Runtime Effect code",
    { timeout: 120_000 },
    async () => {
      const root = await temporaryRoot();
      await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
      await write(
        root,
        "tsconfig.json",
        JSON.stringify({
          extends: resolve("tsconfig.base.json"),
          compilerOptions: { lib: ["ES2023", "DOM"], noUnusedLocals: false },
          include: ["worker/**/*.ts"],
        }),
      );
      await write(root, "worker/runtime/probe.ts", probe("Date.now()"));

      const { output, failed } = runEffectDiagnostics({
        root,
        files: [join(root, "worker/runtime/probe.ts")],
      });
      const reported = [
        ...output.matchAll(/probe\.ts\((\d+),\d+\): error effect\(globalDateInEffect\)/gu),
      ].map((match) => Number(match[1]));

      expect(failed).toBe(true);
      for (const [index, { style, seen }] of styles.entries())
        if (seen) expect(reported, style).toContain(styleLine(index));
    },
  );
});
