import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { devVarsFile, readDevVars, savedKeys, withKeys, writeDevVars } from "./providerKeys.ts";

const names = ["OPENAI_API_KEY", "SONIOX_API_KEY", "CEREBRAS_API_KEY"];
const folders: string[] = [];
function project(): string {
  const folder = mkdtempSync(join(tmpdir(), "dev-vars-"));
  folders.push(folder);
  return folder;
}
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("saved provider keys", () => {
  it("sets keys in an existing .dev.vars, keeps every other line and limits it to its owner", () => {
    const root = project();
    writeFileSync(
      join(root, devVarsFile),
      "# my settings\nOTHER=1\nexport OPENAI_API_KEY=old\n\nOPENAI_API_KEY=older # again\n",
      { mode: 0o644 },
    );
    const keys = new Map([
      ["OPENAI_API_KEY", "sk-new#1"],
      ["SONIOX_API_KEY", ""],
    ]);
    writeDevVars(root, withKeys(readDevVars(root), keys));

    expect(readDevVars(root)).toBe(
      "# my settings\nOTHER=1\nOPENAI_API_KEY='sk-new#1'\n\nSONIOX_API_KEY=\n",
    );
    expect(statSync(join(root, devVarsFile)).mode & 0o777).toBe(0o600);
    // A skipped key is saved empty; a key never asked for is not saved at all.
    expect(savedKeys(readDevVars(root), names)).toEqual(
      new Map([
        ["OPENAI_API_KEY", "sk-new#1"],
        ["SONIOX_API_KEY", ""],
      ]),
    );
  });

  it("creates .dev.vars for its owner only", () => {
    const root = project();
    expect(savedKeys(readDevVars(root), names)).toEqual(new Map());
    writeDevVars(root, withKeys(readDevVars(root), new Map([["CEREBRAS_API_KEY", "csk-1"]])));

    expect(statSync(join(root, devVarsFile)).mode & 0o777).toBe(0o600);
    expect(savedKeys(readDevVars(root), names)).toEqual(new Map([["CEREBRAS_API_KEY", "csk-1"]]));
  });
});
