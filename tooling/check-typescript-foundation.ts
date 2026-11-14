import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parseWorkerCompatibility } from "./worker-compatibility-contract.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const javascriptExtensions = new Set([".cjs", ".js", ".jsx", ".mjs"]);
const ignoredDirectories = new Set([".astro", "dist", "dist-cc", "node_modules"]);
const ignoredJavaScriptRoots = new Set(["worker/generated"]);
const expectErrorContractPaths = new Set(["worker/runtime/openaiRealtimeDriver.test.ts"]);
const typePolicyFixtureDirectory = resolve(repositoryRoot, "tooling/type-policy-fixtures");
const lintTypePolicyFixtureDirectory = resolve(typePolicyFixtureDirectory, "lint");

/** What the check covers: the source roots, the generated TypeScript and the Worker configurations. */
export type TypeScriptFoundation = Readonly<{
  maintainedRoots: readonly string[];
  generatedTypeScriptPaths: readonly string[];
  wranglerConfigs: readonly string[];
}>;

/** The Runtime and Lab code's own roots, generated declarations and Worker configurations. */
export const typeScriptFoundation: TypeScriptFoundation = {
  maintainedRoots: ["src", "worker", "scripts", "tooling"],
  generatedTypeScriptPaths: ["worker/generated"],
  wranglerConfigs: ["wrangler.lab.jsonc", "wrangler.runtime.jsonc"],
};

export async function checkTypeScriptFoundation(foundation: TypeScriptFoundation): Promise<void> {
  await checkNoMaintainedJavaScript(foundation.maintainedRoots);
  await checkWranglerRuntimeAlignment(foundation.wranglerConfigs);
  await checkTypePolicyFixtures();
  await checkAuthorTypeScriptPolicy(foundation);

  console.log("TypeScript foundation architecture checks passed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkTypeScriptFoundation(typeScriptFoundation);
}

async function checkNoMaintainedJavaScript(maintainedRoots: readonly string[]): Promise<void> {
  const actual = (await collectMaintainedJavaScript(maintainedRoots)).sort();

  assert(
    actual.length === 0,
    `Maintained source and executable tooling must use TypeScript instead of JavaScript:\n${formatPaths(actual)}`,
  );
}

async function collectMaintainedJavaScript(maintainedRoots: readonly string[]): Promise<string[]> {
  const rootEntries = await readdir(repositoryRoot, { withFileTypes: true });
  const rootJavaScript = rootEntries
    .filter((entry) => entry.isFile() && hasJavaScriptExtension(entry.name))
    .map((entry) => entry.name);
  const nestedJavaScript = await Promise.all(
    maintainedRoots.map((root) => collectJavaScript(resolve(repositoryRoot, root))),
  );

  return [...rootJavaScript, ...nestedJavaScript.flat()].filter(
    (path) => !isWithinIgnoredRoot(path, ignoredJavaScriptRoots),
  );
}

async function collectJavaScript(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        paths.push(...(await collectJavaScript(absolutePath)));
      }
      continue;
    }

    if (entry.isFile() && hasJavaScriptExtension(entry.name)) {
      paths.push(relative(repositoryRoot, absolutePath));
    }
  }

  return paths;
}

async function checkAuthorTypeScriptPolicy(foundation: TypeScriptFoundation): Promise<void> {
  const paths = await collectAuthorTypeScript(foundation);
  const violations = (
    await Promise.all(
      paths.map(async (path) => {
        const contents = await readFile(resolve(repositoryRoot, path), "utf8");
        return findTypePolicyViolations(contents, path);
      }),
    )
  ).flat();

  assert(
    violations.length === 0,
    `Author-written TypeScript violates the no-evasion policy:\n${violations
      .map(({ path, line, message }) => `- ${path}:${line} ${message}`)
      .join("\n")}`,
  );
}

async function collectAuthorTypeScript(foundation: TypeScriptFoundation): Promise<string[]> {
  const rootEntries = await readdir(repositoryRoot, { withFileTypes: true });
  const rootTypeScript = rootEntries
    .filter((entry) => entry.isFile() && isTypeScriptPath(entry.name))
    .map((entry) => entry.name);
  const nestedTypeScript = await Promise.all(
    foundation.maintainedRoots.map((root) => collectTypeScript(resolve(repositoryRoot, root))),
  );

  const generatedTypeScriptPaths = new Set(foundation.generatedTypeScriptPaths);

  return [...rootTypeScript, ...nestedTypeScript.flat()].filter(
    (path) =>
      !isWithinIgnoredRoot(path, generatedTypeScriptPaths) && !isTypePolicyFixturePath(path),
  );
}

async function collectTypeScript(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        paths.push(...(await collectTypeScript(absolutePath)));
      }
      continue;
    }

    if (entry.isFile() && isTypeScriptPath(entry.name)) {
      paths.push(relative(repositoryRoot, absolutePath));
    }
  }

  return paths;
}

type TypePolicyViolation = {
  path: string;
  line: number;
  kind: "definite-assignment" | "double-assertion" | "explicit-any" | "non-null" | "suppression";
  message: string;
};

function findTypePolicyViolations(contents: string, path: string): TypePolicyViolation[] {
  const sourceFile = ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations: TypePolicyViolation[] = [];

  const addViolation = (node: ts.Node, kind: TypePolicyViolation["kind"], message: string) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    violations.push({ path, line, kind, message });
  };

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      addViolation(node, "explicit-any", "Explicit any is forbidden; start from unknown.");
    }

    if (ts.isNonNullExpression(node)) {
      addViolation(node, "non-null", "Non-null assertions are forbidden; prove the invariant.");
    }

    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      node.exclamationToken !== undefined
    ) {
      addViolation(
        node,
        "definite-assignment",
        "Definite-assignment assertions are forbidden; model initialization explicitly.",
      );
    }

    if (isAssertionExpression(node) && isAssertionExpression(unwrapParentheses(node.expression))) {
      addViolation(
        node,
        "double-assertion",
        "Double assertions are forbidden; narrow or adapt the value once.",
      );
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  for (const comment of collectComments(sourceFile)) {
    const directivePattern = /@ts-(ignore|nocheck|expect-error)(?:[ \t]+([^\r\n]*))?/gu;

    for (const directive of comment.text.matchAll(directivePattern)) {
      const directiveName = directive[1];
      if (directiveName === undefined) {
        continue;
      }

      const explanation = directive[2]?.trim() ?? "";
      const allowedExpectError =
        directiveName === "expect-error" &&
        explanation.length > 0 &&
        (path.endsWith(".typecheck.ts") || expectErrorContractPaths.has(path));

      if (!allowedExpectError) {
        const position = comment.pos + (directive.index ?? 0);
        violations.push({
          path,
          line: sourceFile.getLineAndCharacterOfPosition(position).line + 1,
          kind: "suppression",
          message:
            directiveName === "expect-error"
              ? "@ts-expect-error requires an explanation and an intentional compile-contract file."
              : `@ts-${directiveName} is forbidden in author-written TypeScript.`,
        });
      }
    }
  }

  return violations;
}

type SourceComment = {
  pos: number;
  text: string;
};

// Comments are read from the trivia around each parsed token, so template
// literals, regular expressions and JSX text keep their parser context.
function collectComments(sourceFile: ts.SourceFile): SourceComment[] {
  const contents = sourceFile.text;
  const tokens: ts.Node[] = [];

  const collectTokens = (node: ts.Node): void => {
    // JSDoc text stays in the leading trivia of the next token. The end-of-file
    // token's only children are its JSDoc, so it must remain a token.
    const children = node.getChildren(sourceFile).filter((child) => !ts.isJSDoc(child));
    if (children.length === 0) {
      tokens.push(node);
      return;
    }

    for (const child of children) {
      collectTokens(child);
    }
  };

  collectTokens(sourceFile);

  const comments = new Map<number, SourceComment>();
  const addRanges = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      comments.set(range.pos, { pos: range.pos, text: contents.slice(range.pos, range.end) });
    }
  };

  tokens.forEach((token, index) => {
    // JSX text has no trivia, and text after a JSX tag is never a comment.
    if (ts.isJsxText(token)) {
      return;
    }

    addRanges(ts.getLeadingCommentRanges(contents, token.pos));

    const next = tokens[index + 1];
    if (next === undefined || !ts.isJsxText(next)) {
      addRanges(ts.getTrailingCommentRanges(contents, token.end));
    }
  });

  return [...comments.values()].sort((left, right) => left.pos - right.pos);
}

async function checkTypePolicyFixtures(): Promise<void> {
  const expectedFixtures = new Map<string, TypePolicyViolation["kind"]>([
    ["definite-assignment.fixture", "definite-assignment"],
    ["directive-after-template.fixture", "suppression"],
    ["double-assertion.fixture", "double-assertion"],
    ["explicit-any.fixture", "explicit-any"],
    ["non-null.fixture", "non-null"],
    ["ts-expect-error.fixture", "suppression"],
    ["ts-ignore.fixture", "suppression"],
    ["ts-nocheck.fixture", "suppression"],
  ]);
  const actualFixtures = (await readdir(typePolicyFixtureDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();

  assert(
    arraysEqual(actualFixtures, [...expectedFixtures.keys()].sort()),
    "Type-policy negative fixtures must exactly cover the forbidden construct manifest.",
  );

  for (const [fixture, expectedKind] of expectedFixtures) {
    const contents = await readFile(resolve(typePolicyFixtureDirectory, fixture), "utf8");
    const violations = findTypePolicyViolations(
      contents,
      `tooling/type-policy-fixtures/${fixture}`,
    );
    assert(
      violations.some(({ kind }) => kind === expectedKind),
      `${fixture} must demonstrate a ${expectedKind} policy failure.`,
    );
  }

  await checkTypeAwareLintFixtures();
}

async function checkTypeAwareLintFixtures(): Promise<void> {
  const expectedFixtures = new Map<string, string>([
    ["floating-promise.lint.ts", "no-floating-promises"],
    ["misused-promise.lint.ts", "no-misused-promises"],
    ["unsafe-argument.lint.ts", "no-unsafe-argument"],
    ["unsafe-assignment.lint.ts", "no-unsafe-assignment"],
    ["unsafe-call.lint.ts", "no-unsafe-call"],
    ["unsafe-construction.lint.ts", "no-unsafe-call"],
    ["unsafe-member-access.lint.ts", "no-unsafe-member-access"],
    ["unsafe-return.lint.ts", "no-unsafe-return"],
    ["unsafe-type-assertion.lint.ts", "no-unsafe-type-assertion"],
  ]);
  const actualFixtures = (await readdir(lintTypePolicyFixtureDirectory))
    .filter((path) => path.endsWith(".ts"))
    .sort();

  assert(
    arraysEqual(actualFixtures, [...expectedFixtures.keys()].sort()),
    "Type-aware lint fixtures must exactly cover the forbidden rule manifest.",
  );

  const fixturePaths = actualFixtures.map((fixture) =>
    resolve(lintTypePolicyFixtureDirectory, fixture),
  );
  const result = await runOxlintForFixtures(fixturePaths);

  assert(
    result.exitCode === 1,
    `Type-aware lint fixtures must fail Oxlint with policy diagnostics (exit ${String(result.exitCode)}):\n${result.output}`,
  );

  const diagnostics = result.output.split("\n");
  for (const [fixture, expectedRule] of expectedFixtures) {
    assert(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.includes(fixture) &&
          diagnostic.includes(`[Error/typescript(${expectedRule})]`),
      ),
      `${fixture} must demonstrate a typescript/${expectedRule} lint failure:\n${result.output}`,
    );
  }
}

type LintProcessResult = {
  exitCode: number | null;
  output: string;
};

async function runOxlintForFixtures(fixturePaths: readonly string[]): Promise<LintProcessResult> {
  const temporaryFixtureDirectory = await mkdtemp(
    resolve(repositoryRoot, "type-policy-lint-fixtures-"),
  );
  const oxlintCli = resolve(repositoryRoot, "node_modules/oxlint/bin/oxlint");

  try {
    await Promise.all(
      fixturePaths.map(async (fixturePath) => {
        await writeFile(
          resolve(temporaryFixtureDirectory, basename(fixturePath)),
          await readFile(fixturePath),
        );
      }),
    );

    return await new Promise<LintProcessResult>((resolveProcess, rejectProcess) => {
      const child = spawn(process.execPath, [oxlintCli, "--quiet", "--format=unix", "."], {
        cwd: repositoryRoot,
      });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", rejectProcess);
      child.once("close", (exitCode) => {
        resolveProcess({ exitCode, output: `${stdout}${stderr}` });
      });
    });
  } finally {
    await rm(temporaryFixtureDirectory, { recursive: true });
  }
}

function isAssertionExpression(node: ts.Node): node is ts.AsExpression | ts.TypeAssertion {
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
}

function unwrapParentheses(node: ts.Expression): ts.Expression {
  let expression = node;
  while (ts.isParenthesizedExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
}

function isTypeScriptPath(path: string): boolean {
  return path.endsWith(".ts") || path.endsWith(".tsx");
}

function isTypePolicyFixturePath(path: string): boolean {
  return path.startsWith("tooling/type-policy-fixtures/");
}

function isWithinIgnoredRoot(path: string, ignoredRoots: ReadonlySet<string>): boolean {
  return [...ignoredRoots].some(
    (ignoredRoot) => path === ignoredRoot || path.startsWith(`${ignoredRoot}/`),
  );
}

async function checkWranglerRuntimeAlignment(wranglerConfigs: readonly string[]): Promise<void> {
  const contracts = await Promise.all(
    wranglerConfigs.map(async (path) => {
      const contents = await readFile(resolve(repositoryRoot, path), "utf8");
      const config = parseWorkerCompatibility(contents, path);
      return {
        path,
        compatibilityDate: config.compatibility_date,
        compatibilityFlags: config.compatibility_flags.sort(),
        // Incoming disconnect notification does not change platform declarations:
        // the pinned workerd generator emits the same body with or without this flag.
        // All other flags remain subject to exact alignment.
        runtimeTypeFlags: config.compatibility_flags
          .filter((flag) => flag !== "enable_request_signal")
          .sort(),
      };
    }),
  );
  const expected = contracts[0];

  assert(expected !== undefined, "At least one Wrangler configuration is required.");

  for (const contract of contracts.slice(1)) {
    assert(
      contract.compatibilityDate === expected.compatibilityDate &&
        arraysEqual(contract.runtimeTypeFlags, expected.runtimeTypeFlags),
      [
        "All Worker configurations must share compatibility_date and every compatibility flag except enable_request_signal while worker/generated/runtime.d.ts is shared.",
        `${expected.path}: ${expected.compatibilityDate} ${JSON.stringify(expected.compatibilityFlags)}`,
        `${contract.path}: ${contract.compatibilityDate} ${JSON.stringify(contract.compatibilityFlags)}`,
        "Generate a separate runtime declaration per Worker before intentionally diverging the remaining settings.",
      ].join("\n"),
    );
  }
}

function hasJavaScriptExtension(path: string): boolean {
  const extension = path.slice(path.lastIndexOf("."));
  return javascriptExtensions.has(extension);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatPaths(paths: readonly string[]): string {
  return paths.map((path) => `- ${path}`).join("\n");
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
