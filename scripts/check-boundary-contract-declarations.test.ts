import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { collectBoundaryContractDeclarationViolations } from "./check-boundary-contract-declarations.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("boundary contract declaration check", () => {
  it("accepts the repository boundary declarations", async () => {
    await expect(collectBoundaryContractDeclarationViolations()).resolves.toEqual([]);
  }, 10_000);

  it.each([
    "convert: () => true",
    "convert: (_value) => false",
    "convert: () => { return true; }",
    "convert: function () { return true; }",
  ])("rejects a tolerant boundary that certifies the raw value with %s", async (converter) => {
    const root = await createFixture(
      `const parsed = boundary.tolerant({ source: "input", variants: [{ schema, ${converter} }], otherwise: failure("invalid") });`,
    );

    await expect(collectBoundaryContractDeclarationViolations({ root })).resolves.toEqual([
      expect.stringContaining("must return an owned parsed value"),
    ]);
  });

  it("allows a tolerant boundary that returns an owned value", async () => {
    const root = await createFixture(
      'const parsed = boundary.tolerant({ source: "provider", variants: [{ schema, convert: (value) => ({ id: value.id }) }], otherwise: failure("invalid") });',
    );

    await expect(collectBoundaryContractDeclarationViolations({ root })).resolves.toEqual([]);
  });

  it("does not treat an ordinary boolean converter as a boundary declaration", async () => {
    const root = await createFixture("const predicate = { convert: () => true };");

    await expect(collectBoundaryContractDeclarationViolations({ root })).resolves.toEqual([]);
  });
});

async function createFixture(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "boundary-contract-check-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "worker"), { recursive: true });
  await writeFile(join(root, "worker/example.ts"), source);
  return root;
}
