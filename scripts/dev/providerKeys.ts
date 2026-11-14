import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { parseEnv } from "node:util";
import { z } from "zod";

/**
 * Runtime's composition, which Node loads without the Workers runtime. TypeScript does not follow
 * this import, so the shape the commands read is checked when they load it.
 */
const runtimeComposition = new URL("../../worker/runtimeHostComposition.ts", import.meta.url);
const runtimeCompositionSchema = z.object({
  createRuntimeHostAssembly: z.function({
    input: [],
    output: z.object({ credentialNames: z.array(z.string()) }),
  }),
});

/** The provider keys Runtime reads, as its providers declare them, in Runtime's order. */
export async function providerKeyNames(): Promise<readonly string[]> {
  const composition: unknown = await import(runtimeComposition.href);
  return runtimeCompositionSchema.parse(composition).createRuntimeHostAssembly().credentialNames;
}

/**
 * Where the keys are saved. Wrangler reads this file beside each Worker's configuration and binds
 * only the secrets that configuration lists: Runtime's lists the provider keys, Lab's none.
 */
export const devVarsFile = ".dev.vars";

const devVarsHeader = [
  "# Provider keys for Runtime, read when pnpm dev starts. Change them with pnpm keys.",
  "# An empty key was skipped: pnpm dev does not ask for it again.",
];

/** `.dev.vars` as it is, empty when there is none. */
export function readDevVars(root: string): string {
  const path = join(root, devVarsFile);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Writes `.dev.vars`, readable and writable by its owner only. */
export function writeDevVars(root: string, text: string): void {
  const path = join(root, devVarsFile);
  if (existsSync(path)) chmodSync(path, 0o600);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Each provider key `.dev.vars` names, with its value: empty for a key that was skipped or
 * removed. A key it does not name was never asked for.
 */
export function savedKeys(text: string, names: readonly string[]): ReadonlyMap<string, string> {
  const saved = parseEnv(text);
  return new Map(
    names.flatMap((name) => (Object.hasOwn(saved, name) ? [[name, saved[name] ?? ""]] : [])),
  );
}

const assignment = /^\s*(?:export\s+)?([\w.-]+)\s*=/u;

/**
 * `.dev.vars` with these keys set, an empty value recording a skipped key. Each key replaces its
 * first assignment and drops any later one; every other line stays as it is.
 */
export function withKeys(text: string, keys: ReadonlyMap<string, string>): string {
  const lines = text === "" ? [...devVarsHeader] : text.replace(/\n$/u, "").split("\n");
  const written = new Set<string>();
  const kept = lines.flatMap((line) => {
    const name = assignment.exec(line)?.[1];
    if (name === undefined || !keys.has(name)) return [line];
    if (written.has(name)) return [];
    written.add(name);
    return [keyLine(name, keys.get(name) ?? "")];
  });
  const added = [...keys].flatMap(([name, value]) =>
    written.has(name) ? [] : [keyLine(name, value)],
  );
  return `${[...kept, ...added].join("\n")}\n`;
}

function keyLine(name: string, value: string): string {
  return value === "" ? `${name}=` : `${name}='${value}'`;
}

/** Whether a typed key can be saved: printable characters without spaces, quotes or backslashes. */
export function isKeyValue(value: string): boolean {
  return /^[\x21-\x7e]+$/u.test(value) && !/['"`\\]/u.test(value);
}

/** Each provider key with whether it is set, for the terminal: never a value. */
export function keyStatus(names: readonly string[], keys: ReadonlyMap<string, string>): string {
  const width = Math.max(...names.map((name) => name.length));
  return names
    .map((name) => `  ${name.padEnd(width)}  ${(keys.get(name) ?? "") === "" ? "not set" : "set"}`)
    .join("\n");
}

export type KeyAnswers = Readonly<{
  /** Asks a question and gives the trimmed answer, or null once the input has ended. */
  ask(question: string): Promise<string | null>;
  close(): void;
}>;

/**
 * Answers typed at the terminal without echo, or lines of piped input. Ctrl-C leaves at once,
 * saving nothing.
 */
export function hiddenAnswers(): KeyAnswers {
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  const reader = createInterface({
    input: process.stdin,
    output: muted,
    terminal: process.stdin.isTTY === true,
  });
  reader.on("SIGINT", () => {
    reader.close();
    process.stdout.write("\n");
    process.exit(130);
  });
  const lines = reader[Symbol.asyncIterator]();
  return {
    async ask(question: string): Promise<string | null> {
      process.stdout.write(question);
      const next = await lines.next();
      process.stdout.write("\n");
      return next.done === true ? null : next.value.trim();
    },
    close: () => reader.close(),
  };
}

/**
 * Asks for a key until the answer is one the commands take: a key, an empty answer, `-`, or null
 * when the input has ended.
 */
export async function askKey(answers: KeyAnswers, question: string): Promise<string | null> {
  for (;;) {
    const answer = await answers.ask(question);
    if (answer === null || answer === "" || answer === "-" || isKeyValue(answer)) return answer;
    console.log("  A key has no spaces, quotes or backslashes. Try again.");
  }
}
