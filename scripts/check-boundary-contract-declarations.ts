import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

type BoundaryContractCheckOptions = Readonly<{ root?: string }>;

export async function collectBoundaryContractDeclarationViolations({
  root = repositoryRoot,
}: BoundaryContractCheckOptions = {}): Promise<string[]> {
  const violations: string[] = [];

  for (const file of await collectSourceFiles(root)) {
    const relativePath = toRepoPath(root, file);
    const contents = await readFile(file, "utf8");
    const sourceFile = ts.createSourceFile(
      relativePath,
      contents,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(relativePath),
    );

    visit(sourceFile, (call) => {
      if (!isTolerantBoundaryCall(call.expression)) return;

      const descriptor = call.arguments[0];
      if (descriptor === undefined || !ts.isObjectLiteralExpression(descriptor)) return;

      const variants = readPropertyInitializer(descriptor, "variants");
      if (variants === null || !ts.isArrayLiteralExpression(variants)) return;

      for (const variant of variants.elements) {
        if (!ts.isObjectLiteralExpression(variant)) continue;
        const converter = readPropertyInitializer(variant, "convert");
        if (converter === null || !isBooleanCertificationConverter(converter)) continue;

        const position = sourceFile.getLineAndCharacterOfPosition(converter.getStart(sourceFile));
        violations.push(
          `${relativePath}:${position.line + 1}:${position.character + 1} ` +
            "boundary.tolerant converters must return an owned parsed value; use the schema directly for boolean predicates.",
        );
      }
    });
  }

  return violations;
}

function visit(node: ts.Node, onCall: (call: ts.CallExpression) => void): void {
  if (ts.isCallExpression(node)) onCall(node);
  ts.forEachChild(node, (child) => visit(child, onCall));
}

function isTolerantBoundaryCall(expression: ts.LeftHandSideExpression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "boundary" &&
    expression.name.text === "tolerant"
  );
}

function readPropertyInitializer(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | null {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || readPropertyName(property.name) !== name) continue;
    return unwrapExpression(property.initializer);
  }
  return null;
}

function readPropertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
}

function isBooleanCertificationConverter(expression: ts.Expression): boolean {
  const converter = unwrapExpression(expression);
  if (!ts.isArrowFunction(converter) && !ts.isFunctionExpression(converter)) return false;

  if (!ts.isBlock(converter.body)) {
    return isBooleanLiteral(unwrapExpression(converter.body));
  }

  const [statement] = converter.body.statements;
  return (
    statement !== undefined &&
    converter.body.statements.length === 1 &&
    ts.isReturnStatement(statement) &&
    statement.expression !== undefined &&
    isBooleanLiteral(unwrapExpression(statement.expression))
  );
}

function isBooleanLiteral(expression: ts.Expression): boolean {
  return (
    expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword
  );
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];

  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules" &&
        entry.name !== "dist" &&
        entry.name !== "coverage" &&
        entry.name !== "generated"
      ) {
        files.push(...(await collectSourceFiles(path)));
      }
      continue;
    }

    if (sourceExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js") || path.endsWith(".mjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function toRepoPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function main(): Promise<void> {
  const violations = await collectBoundaryContractDeclarationViolations();
  if (violations.length > 0) {
    console.error("Boundary contract declaration check failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }

  console.log("Boundary contract declaration check passed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
