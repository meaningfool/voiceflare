import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function scopedFiles(root: string): string[] {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path.join(root, "tsconfig.effect.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (!parsed || parsed.errors.length || parsed.fileNames.length === 0) {
    throw new Error("Effect diagnostic scope must resolve to a nonempty valid TypeScript project.");
  }
  return parsed.fileNames.map((file) => path.resolve(file));
}

const relativeTo = (root: string, file: string) =>
  path.relative(root, file).split(path.sep).join("/");

/** Production Worker files: tests, type checks, declarations and test support are not. */
function productionWorkerFiles(root: string): string[] {
  return readdirSync(path.join(root, "worker"), { recursive: true, encoding: "utf8" })
    .filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts") &&
        !file.endsWith(".typecheck.ts") &&
        !file.endsWith(".d.ts") &&
        !file.split(path.sep).includes("testing"),
    )
    .map((file) => path.join(root, "worker", file));
}

// The scope is exactly the Effect owners: every production Worker file that imports
// Effect. A listed file without an Effect import only adds an empty diagnostics run;
// the CLI resolves each owner's imports through its own project, not this list.
const effectImport = /\bfrom\s+["']effect(?:\/[^"']*)?["']/u;
export function collectEffectScopeViolations({
  root = repositoryRoot,
}: { root?: string } = {}): string[] {
  const scoped = scopedFiles(root);
  const owners = productionWorkerFiles(root).filter((file) =>
    effectImport.test(readFileSync(file, "utf8")),
  );
  return [
    ...owners
      .filter((file) => !scoped.includes(file))
      .map((file) => `Effect owner missing from tsconfig.effect.json: ${relativeTo(root, file)}`),
    ...scoped
      .filter((file) => !owners.includes(file))
      .map(
        (file) =>
          `tsconfig.effect.json lists a file that imports no Effect: ${relativeTo(root, file)}`,
      ),
  ];
}

// Runtime and kit code: Runtime, the pairs, both execution kits and the registry.
// Browser code is not part of it.
const runtimeOwner = (relative: string): boolean =>
  relative === "worker/runtimeHostComposition.ts" ||
  [
    "worker/runtime/",
    "worker/implementations/",
    "worker/providers/openaiRealtime/",
    "worker/providers/cascade/",
  ].some((prefix) => relative.startsWith(prefix));

/**
 * The declaration a node sits in: `Class.member` inside a class, otherwise the outermost
 * function or variable around it.
 */
function enclosingName(node: ts.Node): string {
  let name = "(module)";
  for (let current = node.parent; current !== undefined; current = current.parent) {
    const declared = ts.isConstructorDeclaration(current)
      ? "constructor"
      : (ts.isMethodDeclaration(current) ||
            ts.isPropertyDeclaration(current) ||
            ts.isGetAccessorDeclaration(current) ||
            ts.isSetAccessorDeclaration(current) ||
            ts.isFunctionDeclaration(current) ||
            ts.isVariableDeclaration(current)) &&
          current.name !== undefined &&
          (ts.isIdentifier(current.name) || ts.isPrivateIdentifier(current.name))
        ? current.name.text
        : null;
    if (declared === null) continue;
    name =
      ts.isClassLike(current.parent) && current.parent.name !== undefined
        ? `${current.parent.name.text}.${declared}`
        : declared;
  }
  return name;
}

/** Each node of a file that `matches` describes, with its line and declaration. */
function findings<Match>(file: string, matches: (node: ts.Node) => Match | null) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: Array<Readonly<{ line: number; within: string; match: Match }>> = [];
  const visit = (node: ts.Node) => {
    const match = matches(node);
    if (match !== null)
      found.push({
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        within: enclosingName(node),
        match,
      });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// The Effect diagnostics treat a generator passed to `Effect.gen` directly as Effect code.
// Passed with options, as in `Effect.gen({ self: this }, function* () { … })`, its body is
// invisible to them, so a `Date.now()`, a timer or a `fetch` there passes unreported.
// Alias the instance instead (`const self = this;`) and pass the generator alone.
function isEffectGenWithOptions(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Effect" &&
    callee.name.text === "gen" &&
    node.arguments.length > 1
  );
}

/** Every production Worker file that passes options to `Effect.gen`. */
export function collectEffectStyleViolations({
  root = repositoryRoot,
}: { root?: string } = {}): string[] {
  return productionWorkerFiles(root).flatMap((file) =>
    findings(file, (node) => (isEffectGenWithOptions(node) ? node : null)).map(
      (found) =>
        `${relativeTo(root, file)}:${found.line} passes options to Effect.gen, whose generator ` +
        "the Effect diagnostics then do not inspect; alias the instance " +
        "(`const self = this;`) and pass the generator alone.",
    ),
  );
}

type RuntimeGlobal = "clock" | "timer" | "fetch";

/** A global's name, read bare or through `globalThis`. */
function globalName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "globalThis"
  )
    return expression.name.text;
  return null;
}

/** `Date.now` or `performance.now`, read bare or through `globalThis`. */
function clockNow(expression: ts.Expression): string | null {
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "now") return null;
  const owner = globalName(expression.expression);
  return owner === "Date" || owner === "performance" ? owner : null;
}

function runtimeGlobal(node: ts.Node): Readonly<{ global: RuntimeGlobal; text: string }> | null {
  if (ts.isNewExpression(node))
    return globalName(node.expression) === "Date" && (node.arguments?.length ?? 0) === 0
      ? { global: "clock", text: "calls new Date()" }
      : null;
  if (ts.isPropertyAccessExpression(node)) {
    // Passed on as a value, as in a default `now = Date.now`, it reads the time later.
    const owner = clockNow(node);
    const called = ts.isCallExpression(node.parent) && node.parent.expression === node;
    return owner !== null && !called
      ? { global: "clock", text: `passes ${owner}.now as a value` }
      : null;
  }
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  const owner = clockNow(callee);
  if (owner !== null) return { global: "clock", text: `calls ${owner}.now()` };
  const name = globalName(callee);
  if (name === "Date") return { global: "clock", text: "calls Date()" };
  if (name === "setTimeout" || name === "setInterval")
    return { global: "timer", text: `calls ${name}()` };
  if (name === "fetch") return { global: "fetch", text: "calls fetch()" };
  return null;
}

/**
 * A read of the time, a timer or a `fetch` that the rule leaves out of Runtime and kit code:
 * `reads` counts them in the named declaration, so a new one there still fails.
 */
export type RuntimeGlobalExemption = Readonly<{
  file: string;
  within: string;
  global: RuntimeGlobal;
  reads: number;
  reason: string;
}>;

const eventLog =
  "Runtime's event log stamps and expires its rows at the time of its own synchronous " +
  "Durable Object storage write, called from native code paths as well as Effect code.";
const realtimeSession =
  "Called by the Realtime session copies outside Effect code; the shared Effect-first " +
  "Realtime session (plan decisions 4 and 22) and the Realtime driver as an Effect service " +
  "(decision 21) read it from the Clock instead.";

/** The reads the rule leaves out; each other one in Runtime and kit code fails the check. */
export const runtimeGlobalExemptions: readonly RuntimeGlobalExemption[] = [
  {
    file: "worker/runtime/runtimeEvents.ts",
    within: "RuntimeEvents.recordDiagnostic",
    global: "clock",
    reads: 1,
    reason: eventLog,
  },
  {
    file: "worker/runtime/runtimeEvents.ts",
    within: "RuntimeEvents.executionDiagnostics",
    global: "clock",
    reads: 1,
    reason: eventLog,
  },
  {
    file: "worker/runtime/runtimeEvents.ts",
    within: "RuntimeEvents.recordConversationDiagnostics",
    global: "clock",
    reads: 1,
    reason: eventLog,
  },
  {
    file: "worker/runtime/runtimeEvents.ts",
    within: "RuntimeEvents.#validationFailure",
    global: "clock",
    reads: 1,
    reason: eventLog,
  },
  {
    file: "worker/runtime/runtimeEvents.ts",
    within: "RuntimeEvents.readDiagnostics",
    global: "clock",
    reads: 1,
    reason: eventLog,
  },
  {
    file: "worker/runtime/interviewFinalizationRepository.ts",
    within: "InterviewFinalizationRepository.#createSchema",
    global: "clock",
    reads: 1,
    reason:
      "The schema migration bounds legacy failed-start publications inside its synchronous " +
      "SQL schema setup, before any Effect runs.",
  },
  {
    file: "worker/runtime/interviewFinalizationRepository.ts",
    within: "InterviewFinalizationRepository.#recordControllerEventRaw",
    global: "clock",
    reads: 1,
    reason: eventLog,
  },
  {
    file: "worker/runtime/interviewFinalizationComposition.ts",
    within: "observationAt",
    global: "clock",
    reads: 1,
    reason:
      "The finalization decision's fallback for an observation that carries no time; " +
      "observations from the executions carry their receipt time.",
  },
  {
    file: "worker/providers/openaiRealtime/providerEvents.ts",
    within: "normalizeProviderRuntimeObservation",
    global: "clock",
    reads: 1,
    reason: realtimeSession,
  },
  {
    file: "worker/providers/openaiRealtime/providerCommands.ts",
    within: "buildInitialInterviewResponseCommand",
    global: "clock",
    reads: 1,
    reason: realtimeSession,
  },
  {
    file: "worker/providers/cascade/providers.ts",
    within: "cascadeProviderAdapters",
    global: "fetch",
    reads: 1,
    reason:
      "The platform's fetch is the default of the transport that Cascade's providers " +
      "receive; they call only that injected transport.",
  },
];

// Runtime and kit code reads the time, sets timers and calls `fetch` only through Effect
// services (Clock, Effect timers, injected transports), inside or outside Effect code. The
// language service tells Effect code apart only in some styles, so this rule is syntactic.
export function collectRuntimeGlobalViolations({
  root = repositoryRoot,
  exemptions = runtimeGlobalExemptions,
}: { root?: string; exemptions?: readonly RuntimeGlobalExemption[] } = {}): string[] {
  const reads = productionWorkerFiles(root).flatMap((file) => {
    const relative = relativeTo(root, file);
    return runtimeOwner(relative)
      ? findings(file, runtimeGlobal).map((read) => ({ ...read, file: relative }))
      : [];
  });
  const exempts = (exemption: RuntimeGlobalExemption, read: (typeof reads)[number]) =>
    read.file === exemption.file &&
    read.within === exemption.within &&
    read.match.global === exemption.global;
  const instead = {
    clock: "Effect's Clock",
    timer: "Effect timers",
    fetch: "an injected transport",
  };
  const violations: string[] = [];
  for (const exemption of exemptions) {
    const lines = reads.filter((read) => exempts(exemption, read)).map((read) => read.line);
    if (lines.length !== exemption.reads)
      violations.push(
        `${exemption.file} (${exemption.within}) is exempt for ${exemption.reads} ` +
          `${exemption.global} read(s) but has ${lines.length}` +
          `${lines.length > 0 ? ` at line ${lines.join(", ")}` : ""}.`,
      );
  }
  for (const read of reads)
    if (!exemptions.some((exemption) => exempts(exemption, read)))
      violations.push(
        `${read.file}:${read.line} (${read.within}) ${read.match.text}; Runtime and kit ` +
          `code uses ${instead[read.match.global]}.`,
      );
  return violations;
}

/**
 * The three kinds of crossing between Effect and the code around it that Runtime and kit code
 * keeps to its edge:
 *
 * - `promise`: a promise becomes Effect (`Effect.promise`, `Effect.tryPromise`);
 * - `launch`: Effect is launched (`runPromise`, `runSync`, `runFork`, `runCallback` and their
 *   `…Exit` and `…With` variants, on `Effect` or on a `ManagedRuntime`);
 * - `escape`: an `…Unsafe` escape hatch, such as `Deferred.doneUnsafe` or a Clock's
 *   `currentTimeMillisUnsafe`.
 */
export type EffectCrossing = "promise" | "launch" | "escape";

/**
 * A listed place where crossings are allowed: a module, or one declaration within it (named as
 * `Class.member` or the outermost function or variable around the crossing), with the kinds of
 * crossing it makes and why that place is an edge. Each listed kind must still occur there.
 */
export type EffectEdge = Readonly<{
  file: string;
  within?: string;
  crossings: readonly EffectCrossing[];
  reason: string;
}>;

/**
 * The places in Runtime and kit code where a promise may become Effect, Effect may be launched
 * and an escape hatch may be used. Code anywhere else in Runtime, a kit, a pair or the registry
 * goes through one of them; a new crossing elsewhere is rewritten rather than listed.
 */
export const effectEdges: readonly EffectEdge[] = [
  {
    file: "worker/runtime/interviewRuntimeController.ts",
    crossings: ["promise", "launch", "escape"],
    reason:
      "The Durable Object calls in here: its entries, request bodies and input gate are " +
      "promises, each entry launches on the controller's ManagedRuntime, and the controller " +
      "reads its Clock synchronously once, as `now`, for the coordinators it composes.",
  },
  {
    file: "worker/runtime/runtimeControllerServices.ts",
    crossings: ["promise"],
    reason:
      "The controller runtime's alarm service: the Durable Object's alarm storage is a promise API.",
  },
  {
    file: "worker/runtime/nativeWorkOwner.ts",
    crossings: ["launch", "escape"],
    reason:
      "The Run's native work owner: native callers start and await work in it, and its Scope " +
      "exists from its synchronous construction.",
  },
  {
    file: "worker/runtime/interviewFinalizationCoordinator.ts",
    within: "InterviewFinalizationCoordinator.#runNativeCallback",
    crossings: ["launch"],
    reason:
      "A node's completion and failure reach Runtime as native callbacks that their caller awaits.",
  },
  {
    file: "worker/runtime/runtimeEvents.ts",
    within: "RuntimeEvents.#createStream",
    crossings: ["launch"],
    reason: "The platform's ReadableStream starts the Runtime event stream's body.",
  },
  {
    file: "worker/runtime/webPlatform.ts",
    crossings: ["promise"],
    reason:
      "The Web platform's promise APIs that Runtime awaits, Web Crypto's digest, a response " +
      "body and the microtask queue, become Effect here.",
  },
  {
    file: "worker/runtimeHostComposition.ts",
    crossings: ["promise", "launch"],
    reason:
      "The registry joins Runtime to the pairs: its execution bridge launches Effect for native " +
      "callers, and the session and connection setup it selects turn the pair's promises into " +
      "the Effects Runtime awaits.",
  },
  {
    file: "worker/providers/openaiRealtime/runtimeSession.ts",
    crossings: ["promise"],
    reason:
      "The Realtime kit's Runtime adapter: Runtime's promise contract (sink, storage, node " +
      "reports) becomes the session's Effects here.",
  },
  {
    file: "worker/providers/openaiRealtime/sideConnectionEvents.ts",
    crossings: ["escape"],
    reason:
      "The Realtime session's native edge: each side connection event is stamped and queued " +
      "synchronously as it arrives, and settles the node waits it answers (`ReceiptWait`).",
  },
  {
    file: "worker/providers/cascade/runtimeSession.ts",
    crossings: ["promise"],
    reason:
      "The Cascade kit's Runtime adapter: Runtime's promise contract meets the turn-taking loop's Effects.",
  },
  {
    file: "worker/providers/cascade/cerebrasChatCompletions.ts",
    crossings: ["promise"],
    reason:
      "The Cascade model adapter wraps Cerebras Chat Completions' fetch and its streamed body.",
  },
  {
    file: "worker/providers/cascade/openaiResponses.ts",
    crossings: ["promise"],
    reason: "The Cascade model adapter wraps OpenAI Responses' fetch and its streamed body.",
  },
  {
    file: "worker/providers/cascade/sonioxSpeechInput.ts",
    crossings: ["promise", "escape"],
    reason:
      "The Soniox speech-input adapter: its WebSocket's callbacks feed the transcript stream.",
  },
  {
    file: "worker/providers/cascade/sonioxSpeechOutput.ts",
    crossings: ["promise", "escape"],
    reason: "The Soniox speech-output adapter: its WebSocket's callbacks feed the audio stream.",
  },
  {
    file: "worker/providers/cascade/gradiumSpeechInput.ts",
    crossings: ["promise", "escape"],
    reason:
      "The Gradium speech-input adapter: its WebSocket's callbacks feed the recognition stream.",
  },
  {
    file: "worker/providers/cascade/gradiumSpeechOutput.ts",
    crossings: ["promise", "escape"],
    reason: "The Gradium speech-output adapter: its WebSocket's callbacks feed the audio stream.",
  },
  {
    file: "worker/providers/cascade/mediaSession.ts",
    crossings: ["escape"],
    reason: "The browser's media WebSocket: its callbacks feed the participant's audio stream.",
  },
];

const launchName = /^run(?:Promise|Sync|Fork|Callback)(?:Exit)?(?:With)?$/u;

/**
 * The names a file's imports give to Effect: `Effect` itself and its aliases (`import { Effect
 * as E } from "effect"`, `import * as E from "effect/Effect"`), and each member imported by name
 * from a module (`import { runPromise } from "effect/Effect"`), with that module's name.
 */
type EffectImports = Readonly<{
  effect: ReadonlySet<string>;
  members: ReadonlyMap<string, Readonly<{ module: string; name: string }>>;
}>;

const importsByFile = new WeakMap<ts.SourceFile, EffectImports>();
function effectImports(source: ts.SourceFile): EffectImports {
  const known = importsByFile.get(source);
  if (known !== undefined) return known;
  const effect = new Set(["Effect"]);
  const members = new Map<string, Readonly<{ module: string; name: string }>>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const from = statement.moduleSpecifier.text;
    if (from !== "effect" && !from.startsWith("effect/")) continue;
    const module = from === "effect" ? null : from.slice("effect/".length);
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      if (module === "Effect") effect.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (module === null && imported === "Effect") effect.add(element.name.text);
      else if (module !== null) members.set(element.name.text, { module, name: imported });
    }
  }
  const imports = { effect, members };
  importsByFile.set(source, imports);
  return imports;
}

/**
 * The member a node reads, with its receiver when that is a name: a property access, an
 * element access by a literal name, a property taken by destructuring (`const { runSync } =
 * Effect`), or a member imported by name from an Effect module, at its import.
 */
function memberRead(node: ts.Node): Readonly<{ name: string; receiver: string | null }> | null {
  const named = (expression: ts.Expression | undefined) =>
    expression !== undefined && ts.isIdentifier(expression) ? expression.text : null;
  if (ts.isPropertyAccessExpression(node))
    return { name: node.name.text, receiver: named(node.expression) };
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return { name: node.argumentExpression.text, receiver: named(node.expression) };
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const property = node.propertyName ?? node.name;
    if (!ts.isIdentifier(property) && !ts.isStringLiteralLike(property)) return null;
    const declaration = node.parent.parent;
    return {
      name: property.text,
      receiver: ts.isVariableDeclaration(declaration) ? named(declaration.initializer) : null,
    };
  }
  if (ts.isImportSpecifier(node)) {
    const member = effectImports(node.getSourceFile()).members.get(node.name.text);
    return member === undefined ? null : { name: member.name, receiver: member.module };
  }
  return null;
}

/**
 * The crossing a node makes, read from the syntax as the other rules here are: a member read,
 * called or passed on as a value, through whatever name the file's imports give it.
 * `Effect.promise` and `Effect.tryPromise` turn a promise into Effect; a `run…` launcher on
 * `Effect`, or on any other receiver such as a `ManagedRuntime`, launches it; any member whose
 * name ends in `Unsafe` is an escape hatch.
 */
function effectCrossing(
  node: ts.Node,
): Readonly<{ crossing: EffectCrossing; text: string }> | null {
  const member = memberRead(node);
  if (member === null) return null;
  const { name, receiver } = member;
  const onEffect = receiver !== null && effectImports(node.getSourceFile()).effect.has(receiver);
  if (onEffect && (name === "promise" || name === "tryPromise"))
    return { crossing: "promise", text: `turns a promise into Effect with Effect.${name}` };
  if (launchName.test(name))
    return {
      crossing: "launch",
      text: `launches Effect with ${onEffect ? "Effect." : "a runtime's "}${name}`,
    };
  if (name.endsWith("Unsafe"))
    return {
      crossing: "escape",
      text: `uses the escape hatch ${receiver === null ? "" : `${receiver}.`}${name}`,
    };
  return null;
}

/**
 * Runtime and kit code turns promises into Effect, launches Effect and uses `…Unsafe` escape
 * hatches only at its listed edges. Each other crossing fails, as does an edge that no longer
 * makes a crossing it lists.
 */
export function collectEffectEdgeViolations({
  root = repositoryRoot,
  edges = effectEdges,
}: { root?: string; edges?: readonly EffectEdge[] } = {}): string[] {
  const crossings = productionWorkerFiles(root).flatMap((file) => {
    const relative = relativeTo(root, file);
    return runtimeOwner(relative)
      ? findings(file, effectCrossing).map((found) => ({ ...found, file: relative }))
      : [];
  });
  const at = (edge: EffectEdge, found: (typeof crossings)[number]) =>
    edge.file === found.file && (edge.within === undefined || edge.within === found.within);
  const allows = (edge: EffectEdge, found: (typeof crossings)[number]) =>
    at(edge, found) && edge.crossings.includes(found.match.crossing);
  const violations: string[] = [];
  for (const edge of edges)
    for (const crossing of edge.crossings)
      if (!crossings.some((found) => at(edge, found) && found.match.crossing === crossing))
        violations.push(
          `${edge.file}${edge.within === undefined ? "" : ` (${edge.within})`} is listed for ` +
            `${crossing} crossings but makes none; remove it from the list.`,
        );
  for (const found of crossings)
    if (!edges.some((edge) => allows(edge, found)))
      violations.push(
        `${found.file}:${found.line} (${found.within}) ${found.match.text}; Runtime and kit ` +
          "code crosses between promises and Effect only at a listed edge (effectEdges).",
      );
  return violations;
}

// The CLI uses --project to enumerate files, but discovers each file's TypeScript
// project independently. Supply plugin options explicitly so every selected owner
// is checked under the repository's existing project references. No tsc patching.
const options = {
  diagnostics: true,
  diagnosticSeverity: {
    anyUnknownInErrorContext: "error",
    runEffectInsideEffect: "error",
    unsafeEffectTypeAssertion: "error",
  },
};
const runtimeOwnerOptions = {
  ...options,
  diagnosticSeverity: {
    ...options.diagnosticSeverity,
    globalDateInEffect: "error",
    globalTimersInEffect: "error",
    globalFetchInEffect: "error",
  },
};

/**
 * Runs the Effect language service on each file, Runtime and kit files with the global
 * rules. It returns the output and whether any file reported an error.
 */
export function runEffectDiagnostics({
  root = repositoryRoot,
  files = scopedFiles(root),
  onOutput = () => undefined,
}: {
  root?: string;
  files?: readonly string[];
  onOutput?: (text: string) => void;
} = {}) {
  let output = "";
  let failed = false;
  // In 0.87.5 a multi-file scan can dispose a language service that a later file
  // reuses through project references. Isolate each selected file in its own CLI
  // process; this also makes skipped-file detection unambiguous.
  for (const file of files) {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(import.meta.resolve("@effect/language-service/cli.js")),
        "diagnostics",
        "--file",
        file,
        "--format",
        "text",
        "--strict",
        "--lspconfig",
        JSON.stringify(runtimeOwner(relativeTo(root, file)) ? runtimeOwnerOptions : options),
      ],
      { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const text = (result.stdout ?? "") + (result.stderr ?? "");
    output += text;
    onOutput(text);
    if (result.error) throw result.error;

    // A successful CLI process can otherwise report zero checked files when the
    // plugin is absent. Every selected owner must actually receive diagnostics.
    if (!/Checked 1 files out of 1 files\./u.test(result.stdout)) {
      throw new Error(`Effect diagnostics did not check ${file}.`);
    }
    if (result.status !== 0) failed = true;
  }
  return { output, failed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scope = collectEffectScopeViolations();
  if (scope.length > 0) {
    throw new Error(
      `Effect diagnostic scope must list exactly the Effect owners:\n${scope.join("\n")}`,
    );
  }
  const refused = [
    ...collectEffectStyleViolations(),
    ...collectRuntimeGlobalViolations(),
    ...collectEffectEdgeViolations(),
  ];
  if (refused.length > 0) {
    throw new Error(`Effect code rules:\n${refused.join("\n")}`);
  }
  const fileNames = scopedFiles(repositoryRoot);
  const { failed } = runEffectDiagnostics({
    files: fileNames,
    onOutput: (text) => process.stdout.write(text),
  });
  if (failed) process.exitCode = 1;
  console.log(`Effect diagnostic scope: ${fileNames.length} files checked.`);
}
