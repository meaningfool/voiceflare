import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { z } from "zod";
import { bin, type OwnedProcesses } from "./processes.ts";

export const labConfig = "wrangler.lab.jsonc";
export const runtimeConfig = "wrangler.runtime.jsonc";

const labDevSchema = z.object({ dev: z.object({ port: z.number().int().positive() }) });

/** The port the Lab's Wrangler configuration gives its local server. */
export function labPort(root: string): number {
  return labDevSchema.parse(parse(readFileSync(join(root, labConfig), "utf8"))).dev.port;
}

/**
 * Applies the Lab's migrations to its local database: Wrangler's own local state, or the state
 * in `persistTo`.
 */
export function migrateLabDatabase(owned: OwnedProcesses, persistTo?: string): Promise<void> {
  return owned.run(bin(owned.root, "wrangler"), [
    "d1",
    "migrations",
    "apply",
    "LAB_DB",
    "--local",
    "-c",
    labConfig,
    ...(persistTo === undefined ? [] : ["--persist-to", persistTo]),
  ]);
}

/**
 * Builds the Lab page for the Lab Worker at `origin` to serve: into the folder its Wrangler
 * configuration serves, or into `outDir`.
 */
export function buildLabPage(
  owned: OwnedProcesses,
  origin: string,
  outDir?: string,
): Promise<void> {
  return owned.run(
    bin(owned.root, "vite"),
    [
      "build",
      "--mode",
      "lab",
      ...(outDir === undefined ? [] : ["--outDir", outDir, "--emptyOutDir"]),
    ],
    { ...process.env, VITE_LAB_WORKER_URL: origin },
  );
}
