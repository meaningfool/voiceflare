import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { constants } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

/** A command this project installs, such as `wrangler`. */
export function bin(root: string, name: string): string {
  return join(root, "node_modules", ".bin", name);
}

/** The exit code of a process a signal ended: 128 and the signal's number. */
function signalCode(signal: NodeJS.Signals): number {
  return 128 + constants.signals[signal];
}

/**
 * The processes a command starts, each in its own process group with every process it starts in
 * turn, such as Wrangler's workerd. Stopping ends every group and waits until none remains, so
 * stopping the command leaves no process running.
 */
export class OwnedProcesses {
  readonly root: string;
  readonly #groups = new Set<number>();
  #stopping: Promise<void> | null = null;

  /** `root` is the project's folder, where every process starts. */
  constructor(root: string) {
    this.root = root;
  }

  /**
   * Starts a process in the project's folder and returns its exit code; a stop gives the code of
   * its signal. It reads no input, so the terminal stays with this command.
   */
  start(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
    const child = spawn(command, args, {
      cwd: this.root,
      env,
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    const group = child.pid;
    if (group !== undefined) this.#groups.add(group);
    return new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        // A group with no process left is forgotten, so a later process given its number is
        // never signalled.
        if (group !== undefined && !signalGroup(group, 0)) this.#groups.delete(group);
        resolve(code ?? (signal === null ? 1 : signalCode(signal)));
      });
    });
  }

  /** Runs a process to its end, and fails when it fails. */
  async run(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<void> {
    const code = await this.start(command, args, env);
    if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${code}.`);
  }

  /** Ends every group: SIGTERM first, SIGKILL after ten seconds. Safe to call again. */
  stop(): Promise<void> {
    this.#stopping ??= this.#stopGroups();
    return this.#stopping;
  }

  async #stopGroups(): Promise<void> {
    for (const group of this.#groups) signalGroup(group, "SIGTERM");
    if (await this.#allGone(10_000)) return;
    for (const group of this.#groups) signalGroup(group, "SIGKILL");
    if (await this.#allGone(2_000)) return;
    console.error(`Processes remain in groups ${[...this.#groups].join(", ")}.`);
  }

  async #allGone(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const group of this.#groups) if (!signalGroup(group, 0)) this.#groups.delete(group);
      if (this.#groups.size === 0) return true;
      if (Date.now() > deadline) return false;
      await delay(100);
    }
  }
}

/** Sends a signal to a process group; false when no process of the group remains. */
function signalGroup(group: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-group, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

/**
 * Runs `work` and exits with its code once every owned process has stopped. Ctrl-C, a closed
 * terminal or SIGTERM stop them too, and then exit with the signal's code; a second signal waits
 * for the same stop.
 */
export function runOwning(owned: OwnedProcesses, work: () => Promise<number>): void {
  const finish = async (code: number) => {
    await owned.stop();
    process.exit(code);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => {
      void finish(signalCode(signal));
    });
  void (async () => {
    let code = 1;
    try {
      code = await work();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    await finish(code);
  })();
}

/** A free loopback port, for a check's own Lab. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("No free port");
  return address.port;
}

const labHealthSchema = z.object({ service: z.literal("lab") });

/** The exit code of the process serving the Lab, once it has exited. */
type ServingExit = { code?: number };

/**
 * Waits until the Lab Worker at `origin` answers its health check, for at most two minutes, and
 * fails as soon as the process serving it exits.
 */
export async function waitForLab(origin: string, serving: Promise<number>): Promise<void> {
  const exit: ServingExit = {};
  void serving.then(
    (code) => {
      exit.code = code;
    },
    () => {
      exit.code = 1;
    },
  );
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (exit.code !== undefined)
      throw new Error(`Runtime and Lab stopped with ${exit.code} before they were ready.`);
    try {
      const response = await fetch(new URL("/health", origin));
      if (response.ok && labHealthSchema.safeParse(await response.json()).success) return;
    } catch {
      // Not listening yet.
    }
    await delay(250);
  }
  throw new Error(`The Lab did not answer at ${origin} within two minutes.`);
}
