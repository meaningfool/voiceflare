import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildLabPage, labConfig, labPort, migrateLabDatabase, runtimeConfig } from "./lab.ts";
import { bin, OwnedProcesses, runOwning, waitForLab } from "./processes.ts";
import {
  askKey,
  devVarsFile,
  hiddenAnswers,
  keyStatus,
  providerKeyNames,
  readDevVars,
  savedKeys,
  withKeys,
  writeDevVars,
} from "./providerKeys.ts";

// `pnpm dev [--port <port>]`: asks for each provider key not yet saved, prepares the Lab's
// database, builds its page and runs Runtime and Lab in one `wrangler dev` until Ctrl-C. The Lab
// listens on the port `wrangler.lab.jsonc` names unless `--port` names another.
const root = fileURLToPath(new URL("../../", import.meta.url));
const { values: options } = parseArgs({ options: { port: { type: "string" } } });
const port = options.port === undefined ? labPort(root) : Number(options.port);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("Usage: pnpm dev [--port <port>]");
  process.exit(2);
}
const names = await providerKeyNames();
let text = readDevVars(root);
const saved = savedKeys(text, names);
const missing = names.filter((name) => !saved.has(name));
if (missing.length > 0) {
  console.log(
    `Runtime reads these provider keys from ${devVarsFile}. Each is optional: the Lab offers the ` +
      "combinations whose keys are set.\nType or paste a key, or press Enter to skip it. Input is " +
      "hidden. pnpm keys changes the keys later.",
  );
  const answers = hiddenAnswers();
  const typed = new Map<string, string>();
  for (const name of missing) {
    const answer = await askKey(answers, `${name}: `);
    if (answer === null) break;
    typed.set(name, answer === "-" ? "" : answer);
  }
  answers.close();
  if (typed.size > 0) {
    text = withKeys(text, typed);
    writeDevVars(root, text);
  }
}
console.log(`Provider keys in ${devVarsFile}:\n${keyStatus(names, savedKeys(text, names))}\n`);

// Runtime takes its keys from `.dev.vars` alone. Without this, Wrangler reads them from `.env` and
// the environment when `.dev.vars` is absent.
const wranglerEnv: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !names.includes(name))),
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
};
const owned = new OwnedProcesses(root);
runOwning(owned, async () => {
  const origin = `http://127.0.0.1:${port}`;
  console.log("Preparing the Lab's database.");
  await migrateLabDatabase(owned);
  console.log("Building the Lab page.");
  await buildLabPage(owned, origin);
  console.log("Starting Runtime and Lab.");
  const serving = owned.start(
    bin(root, "wrangler"),
    [
      "dev",
      "-c",
      labConfig,
      "-c",
      runtimeConfig,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--show-interactive-dev-session=false",
    ],
    wranglerEnv,
  );
  await waitForLab(origin, serving);
  console.log(`\nLab: ${origin}\nCtrl-C stops Runtime and Lab.\n`);
  return serving;
});
