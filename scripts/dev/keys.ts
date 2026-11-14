import { fileURLToPath } from "node:url";
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

// `pnpm keys [NAME…]`: changes the saved provider keys, all of them or the ones named. Runtime
// reads them at the next `pnpm dev`.
const root = fileURLToPath(new URL("../../", import.meta.url));
const names = await providerKeyNames();
const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !names.includes(name));
if (unknown.length > 0) {
  console.error(`Runtime reads no ${unknown.join(", ")}. Its keys are ${names.join(", ")}.`);
  process.exit(2);
}
const chosen = requested.length > 0 ? names.filter((name) => requested.includes(name)) : names;
const text = readDevVars(root);
console.log(`Provider keys in ${devVarsFile}:\n${keyStatus(names, savedKeys(text, names))}\n`);
console.log(
  "Type or paste a new key, press Enter to keep a key as it is, or type - to remove it. Input " +
    "is hidden.",
);
const answers = hiddenAnswers();
const changes = new Map<string, string>();
for (const name of chosen) {
  const answer = await askKey(answers, `${name}: `);
  if (answer === null) break;
  if (answer !== "") changes.set(name, answer === "-" ? "" : answer);
}
answers.close();
if (changes.size === 0) console.log("No change.");
else {
  const updated = withKeys(text, changes);
  writeDevVars(root, updated);
  console.log(
    `Saved ${devVarsFile}:\n${keyStatus(names, savedKeys(updated, names))}\n` +
      "Restart pnpm dev to use the change.",
  );
}
