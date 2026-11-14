import { existsSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const contracts = [
  "worker/runtime/conversationContracts.ts",
  "worker/runtime/executionContracts.ts",
  "worker/runtime/diagnosticContracts.ts",
  "worker/runtime/nodeContentContracts.ts",
];
const genericRoots = [
  "worker/runtime/interviewRuntimeController.ts",
  "worker/runtime/interviewStartupCoordinator.ts",
  "worker/runtime/conversationStartup.ts",
  "worker/runtime/interviewFinalizationCoordinator.ts",
];
const required = [...contracts, ...genericRoots];
// Shared provider protocol code: it knows no Conversation or pair. Each folder is one kit.
const providerKits = "worker/providers";
// Conversation definitions shared by the executions paired with them: their rules, what the
// model receives in each state and what each tool call means. Pairs of any execution kind may
// depend on them; pairs still never depend on one another.
const sharedConversations = "worker/conversations";
// Each folder is one Conversation/execution pair, defined by its `implementation.ts`. The
// pairs and kits come from these folders, so a new one is checked without a list edit.
const implementations = "worker/implementations";
const privateOwners = [
  {
    directory: "worker/runtime/admission/private",
    owners: ["worker/runtimeHostComposition.ts", implementations],
  },
];
// Public facades may forward these contracts, never acquire private authority
// locally or expose it through an aliased export/helper.
const privateFacadeExports = new Map([
  [
    "worker/runtime/conversationAdmission.ts",
    {
      module: "worker/runtime/admission/private/composition.ts",
      values: new Set<string>(),
      types: new Set(["RuntimeImplementation", "ConversationAdmission"]),
    },
  ],
  [
    "worker/runtime/executionContracts.ts",
    {
      module: "worker/runtime/admission/private/reporting.ts",
      values: new Set(["executionIdentitySchema", "conversationVisitSchema"]),
      types: new Set([
        "ExecutionIdentity",
        "ConversationVisit",
        "SemanticReport",
        "StateReporter",
        "ReporterFactory",
      ]),
    },
  ],
]);
const trustedParser = new Set([
  "tools/boundary-contracts/boundary-contracts.mjs",
  "tools/boundary-contracts/boundary-contracts.d.mts",
]);
// These neutral utilities index the declared state/event schema. Ordinary Conversation
// handlers cannot hide capability access behind computed keys.
const schemaIndexing = new Set([...contracts, "worker/runtime/admission/private/reporting.ts"]);
const rawCapabilities = new Set([
  "fetch",
  "WebSocket",
  "XMLHttpRequest",
  "EventSource",
  "WebTransport",
  "Request",
  "Response",
  "globalThis",
  "global",
  "window",
  "self",
  "navigator",
  "process",
  "Deno",
  "Bun",
  "eval",
  "Function",
  "require",
  "importScripts",
  "Reflect",
  "DurableObject",
  "DurableObjectState",
  "DurableObjectStorage",
  "SqlStorage",
  "D1Database",
  "storage",
  "dispatch",
  "connect",
  "send",
  "createCall",
  "hangUp",
  "setTimeout",
  "setInterval",
  "Date",
  "crypto",
  "__proto__",
  "getPrototypeOf",
  "setPrototypeOf",
  "runPromise",
  "runFork",
  "runSync",
  "constructor",
  "sql",
  "exec",
  "transaction",
  "setAlarm",
  "blockConcurrencyWhile",
  "performance",
]);
type Reference = { specifier: string; typeOnly: boolean; node: ts.Node };
type Module = { path: string; source: ts.SourceFile; references: Reference[]; dynamic: boolean };
type Policy = "pure" | "generic";
const posix = (path: string) => path.split(sep).join("/");
const within = (path: string, directory: string) =>
  path === directory || path.startsWith(`${directory}/`);
const testFile = (path: string) => /(?:\.test\.[cm]?[jt]sx?$|\/testing\/)/u.test(path);

/** Follow authored import/export/type edges, including unused and erased edges.
 * This enforces repository ownership; it is not a JavaScript security sandbox.
 * Installed zod/effect and the exact boundary parser are trusted dependencies.
 */
export async function collectConversationBoundaryViolations({
  root = repositoryRoot,
}: { root?: string } = {}): Promise<string[]> {
  root = await realpath(root);
  const violations = new Set<string>();
  const modules = new Map<string, Module>();
  const report = (message: string) => {
    violations.add(message);
  };
  const files = await collectSources(root);
  for (const path of [...required, ...(await pairDefinitions(root))])
    if (!existsSync(resolve(root, path))) report(`${path}: required boundary owner missing`);
  for (const directory of [sharedConversations, implementations, providerKits])
    if (!files.some((path) => within(path, directory)))
      report(`${directory}: required boundary owners missing`);
  async function loadModule(path: string): Promise<Module | undefined> {
    const existing = modules.get(path);
    if (existing !== undefined) return existing;
    if (!existsSync(resolve(root, path))) return undefined;
    const source = ts.createSourceFile(
      path,
      await readFile(resolve(root, path), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const references: Reference[] = [];
    let dynamic = false;
    function visit(node: ts.Node): void {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        let typeOnly = ts.isImportDeclaration(node)
          ? node.importClause?.isTypeOnly === true
          : node.isTypeOnly;
        if (
          ts.isImportDeclaration(node) &&
          node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings) &&
          !node.importClause.name
        )
          typeOnly ||=
            node.importClause.namedBindings.elements.length > 0 &&
            node.importClause.namedBindings.elements.every((item) => item.isTypeOnly);
        references.push({ specifier: node.moduleSpecifier.text, typeOnly, node });
      } else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      )
        references.push({ specifier: node.argument.literal.text, typeOnly: true, node });
      else if (ts.isExternalModuleReference(node) && ts.isStringLiteralLike(node.expression))
        references.push({ specifier: node.expression.text, typeOnly: false, node });
      else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument))
          references.push({ specifier: argument.text, typeOnly: false, node });
        dynamic = true;
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    modules.set(path, { path, source, references, dynamic });
    for (const ref of references)
      if (/(?:disposable-conversation-machines|(?:^|\/)spikes?(?:\/|$))/u.test(ref.specifier))
        report(`${path}: disposable spike dependency '${ref.specifier}'`);
    return modules.get(path);
  }
  for (const path of files) await loadModule(path);
  const resolveReference = async (
    owner: string,
    ref: Reference,
    strict = true,
  ): Promise<string | null> => {
    if (
      !ref.specifier.startsWith(".") &&
      !isAbsolute(ref.specifier) &&
      !ref.specifier.startsWith("@/")
    )
      return null;
    const specifier = ref.specifier.startsWith("@/")
      ? resolve(root, "src", ref.specifier.slice(2))
      : ref.specifier;
    const result = ts.resolveModuleName(
      specifier,
      resolve(root, owner),
      { moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true },
      ts.sys,
    ).resolvedModule;
    if (!result) {
      if (strict) report(`${owner}: unresolved dependency '${ref.specifier}'`);
      return null;
    }
    const canonical = posix(relative(root, await realpath(result.resolvedFileName)));
    if (canonical.startsWith("../")) {
      report(`${owner}: dependency escapes repository '${ref.specifier}'`);
      return null;
    }
    return canonical;
  };
  function forbidden(path: string, policy: Policy): boolean {
    if (policy === "pure")
      return !(
        within(path, sharedConversations) ||
        contracts.includes(path) ||
        path === "worker/runtime/admission/private/reporting.ts" ||
        within(path, "worker/shared/contracts") ||
        path === "src/browser/runtimeTerminalResult.ts" ||
        trustedParser.has(path)
      );
    return (
      /^worker\/runtimeHost/u.test(path) ||
      within(path, sharedConversations) ||
      within(path, implementations) ||
      within(path, providerKits)
    );
  }
  function inspectCapabilities(module: Module): void {
    if (trustedParser.has(module.path)) return;
    function visit(node: ts.Node): void {
      if (ts.isImportDeclaration(node)) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
          for (const binding of bindings.elements) {
            const imported = binding.propertyName?.text ?? binding.name.text;
            if (rawCapabilities.has(imported))
              report(`${module.path}: imported raw capability '${imported}'`);
          }
        return;
      }
      if (ts.isExportDeclaration(node)) {
        if (node.exportClause && ts.isNamedExports(node.exportClause))
          for (const binding of node.exportClause.elements) {
            const exported = binding.propertyName?.text ?? binding.name.text;
            if (rawCapabilities.has(exported))
              report(`${module.path}: exported raw capability '${exported}'`);
          }
        if (
          node.moduleSpecifier &&
          ts.isStringLiteralLike(node.moduleSpecifier) &&
          !node.moduleSpecifier.text.startsWith(".") &&
          !node.isTypeOnly &&
          (!node.exportClause || ts.isNamespaceExport(node.exportClause))
        )
          report(`${module.path}: external wildcard capability export requires boundary review`);
        return;
      }
      const location = () =>
        `${module.path}:${module.source.getLineAndCharacterOfPosition(node.getStart(module.source)).line + 1}`;
      if (ts.isIdentifier(node) && rawCapabilities.has(node.text))
        report(`${location()}: raw capability or dynamic execution '${node.text}'`);
      if (ts.isPropertyAccessExpression(node) && node.name.text === "request")
        report(`${location()}: raw client request capability`);
      // Finite retained neutral-schema indexing: sorted usage keys and Zod's
      // issue path classification. No capability object is selected here.
      const schemaIndex =
        (module.path === "src/browser/runtimeTerminalResult.ts" &&
          node.getText(module.source) === "keys[index - 1]") ||
        (module.path === "worker/shared/contracts/runtimeStart.ts" &&
          node.getText(module.source) === "issue.path[0]");
      if (
        (ts.isElementAccessExpression(node) || ts.isComputedPropertyName(node)) &&
        !schemaIndexing.has(module.path) &&
        !schemaIndex
      )
        report(`${location()}: computed capability access requires boundary review`);
      ts.forEachChild(node, visit);
    }
    visit(module.source);
  }
  async function check(entry: string, policy: Policy): Promise<void> {
    const visited = new Set<string>();
    async function visit(path: string, chain: string[]): Promise<void> {
      if (visited.has(path)) return;
      visited.add(path);
      if (forbidden(path, policy)) {
        report(`${policy} boundary: forbidden dependency ${[...chain, path].join(" -> ")}`);
        return;
      }
      const module = modules.get(path) ?? (await loadModule(path));
      if (!module) return;
      if (module.dynamic) report(`${path}: dynamic module execution requires boundary review`);
      if (policy !== "generic") inspectCapabilities(module);
      for (const ref of module.references) {
        if (
          policy !== "generic" &&
          !ref.specifier.startsWith(".") &&
          !ref.specifier.startsWith("@/") &&
          !isAbsolute(ref.specifier) &&
          !["zod", "effect"].includes(ref.specifier)
        )
          report(`${path}: unapproved external dependency '${ref.specifier}'`);
        const target = await resolveReference(path, ref);
        if (target === null) continue;
        if (testFile(target)) {
          report(`${path}: production dependency on test owner '${target}'`);
          continue;
        }
        // Generic Runtime follows neutral communication types too; no concrete
        // implementation edge is permitted even when erased at runtime.
        await visit(target, [...chain, path]);
      }
    }
    await visit(entry, []);
  }
  // Production imports can hide a spike behind a helper outside worker/src.
  // Load reachable authored source edges before checking policy roots, retaining
  // strict resolution errors for those roots while ignoring ordinary asset URLs.
  for (const module of modules.values())
    for (const ref of module.references) {
      const target = await resolveReference(module.path, ref, false);
      const pair = /^worker\/implementations\/([^/]+)\//u.exec(module.path)?.[1];
      const targetPair =
        target === null ? undefined : /^worker\/implementations\/([^/]+)\//u.exec(target)?.[1];
      if (pair !== undefined && targetPair !== undefined && pair !== targetPair)
        report(`${module.path}: cross-implementation dependency '${target}'`);
      if (within(module.path, providerKits) && targetPair !== undefined)
        report(`${module.path}: provider kit dependency on implementation '${target}'`);
      if (
        within(module.path, providerKits) &&
        target !== null &&
        within(target, sharedConversations)
      )
        report(`${module.path}: provider kit dependency on Conversation '${target}'`);
      if (target !== null && /\.[cm]?[jt]sx?$/u.test(target) && !testFile(target))
        await loadModule(target);
    }
  for (const path of modules.keys())
    if (within(path, sharedConversations) || contracts.includes(path)) await check(path, "pure");
  for (const [path, module] of modules) {
    if (!within(path, implementations)) continue;
    function diagnosticAccess(node: ts.Node): void {
      if (
        ts.isPropertyAccessExpression(node) &&
        [
          "nextDiagnosticSequence",
          "recordDiagnostic",
          "recordUniqueDiagnostic",
          "recordControllerEvent",
          "recordEvent",
        ].includes(node.name.text)
      )
        report(`${path}: implementation diagnostic construction bypass '${node.name.text}'`);
      if (ts.isStringLiteral(node) && node.text === "runtime.event_recorded")
        report(`${path}: implementation cannot append prebuilt Runtime diagnostics`);
      ts.forEachChild(node, diagnosticAccess);
    }
    diagnosticAccess(module.source);
  }
  for (const path of genericRoots) await check(path, "generic");
  function approvedFacadeExport(path: string, dependency: string, ref: Reference): boolean {
    const facade = privateFacadeExports.get(path);
    const node = ref.node;
    return (
      facade?.module === dependency &&
      ts.isExportDeclaration(node) &&
      node.exportClause !== undefined &&
      ts.isNamedExports(node.exportClause) &&
      node.exportClause.elements.every((item) => {
        const name = item.propertyName?.text ?? item.name.text;
        return node.isTypeOnly || item.isTypeOnly
          ? facade.types.has(name)
          : facade.values.has(name);
      })
    );
  }
  for (const [path, module] of modules) {
    for (const ref of module.references) {
      const dependency = await resolveReference(path, ref, false);
      if (dependency === null) continue;
      for (const boundary of privateOwners)
        if (
          within(dependency, boundary.directory) &&
          !within(path, boundary.directory) &&
          !boundary.owners.some((owner) => within(path, owner)) &&
          !approvedFacadeExport(path, dependency, ref)
        )
          report(path + ": private module dependency '" + dependency + "'");
    }
  }
  return [...violations].sort();
}
/** The definition of every pair folder under `worker/implementations/`. */
async function pairDefinitions(root: string): Promise<string[]> {
  if (!existsSync(resolve(root, implementations))) return [];
  return (await readdir(resolve(root, implementations), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${implementations}/${entry.name}/implementation.ts`)
    .sort();
}
async function collectSources(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    if (!existsSync(resolve(root, directory))) return;
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const path = posix(`${directory}/${entry.name}`);
      if (entry.isDirectory()) await visit(path);
      else if (/\.[cm]?[jt]sx?$/u.test(path) && !testFile(path)) files.push(path);
    }
  }
  for (const directory of ["worker", "src", "tools"]) await visit(directory);
  return files;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = await collectConversationBoundaryViolations();
  if (violations.length > 0) {
    process.stderr.write(`${violations.join("\n")}\n`);
    process.exitCode = 1;
  } else process.stdout.write("Conversation/execution ownership boundaries passed.\n");
}
