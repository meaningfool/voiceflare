import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLabPage, labConfig, migrateLabDatabase } from "./lab.ts";
import { bin, freePort, OwnedProcesses, runOwning, waitForLab } from "./processes.ts";

// `pnpm test:lab-session` and `pnpm test:lab-runtime-session`: each builds the Lab page for its
// suite, migrates a Lab database of its own, serves both with Runtime from one workerd
// (`tests/lab-runtime-session/server.ts`) on a free port, and runs its Playwright suite there.
// Runtime's only provider key is a synthetic one for its controlled OpenAI transport, so no
// check reaches a provider. Arguments after the suite go to Playwright.
const suites = ["lab-session", "lab-runtime-session"] as const;
const [suite, ...playwrightArgs] = process.argv.slice(2);
const known = suites.find((name) => name === suite);
if (known === undefined) {
  console.error(`Usage: node scripts/dev/lab-check.ts <${suites.join("|")}> [Playwright options]`);
  process.exit(2);
}
const root = fileURLToPath(new URL("../../", import.meta.url));
const owned = new OwnedProcesses(root);
const temporary = mkdtempSync(join(tmpdir(), `${known}-`));
process.once("exit", () => rmSync(temporary, { recursive: true, force: true }));

runOwning(owned, async () => {
  const origin = `http://127.0.0.1:${await freePort()}`;
  const page = join(temporary, "page");
  const state = join(temporary, "state");
  await migrateLabDatabase(owned, state);
  if (known === "lab-session") {
    // The browser stubs the Lab Worker's whole API; the page is the Lab's own.
    await buildLabPage(owned, origin, page);
  } else {
    // The page and the Lab Worker take the substitute content folder, `tests/lab-content/`, and
    // the Lab fills its empty prompt library from it.
    await owned.run(process.execPath, ["tests/lab-runtime-session/build.ts", page], {
      ...process.env,
      VITE_LAB_WORKER_URL: origin,
    });
    await owned.run(bin(root, "wrangler"), [
      "d1",
      "execute",
      "LAB_DB",
      "--local",
      "-c",
      labConfig,
      "--persist-to",
      state,
      "--command",
      "DELETE FROM lab_prompts",
    ]);
  }
  const serving = owned.start(process.execPath, [
    "tests/lab-runtime-session/server.ts",
    new URL(origin).port,
    page,
    state,
  ]);
  await waitForLab(origin, serving);
  return owned.start(
    bin(root, "playwright"),
    ["test", "--config", `tests/${known}/playwright.config.ts`, ...playwrightArgs],
    { ...process.env, TEST_LAB_ORIGIN: origin },
  );
});
