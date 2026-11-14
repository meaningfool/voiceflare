import { DurableObject } from "cloudflare:workers";

import { requestLabRequiredStop } from "./labRuntimeClient.ts";
import { completeEmptyRuntimeUsage } from "../shared/contracts/runtimeTerminalResult.ts";
import { persistLabTerminalResult } from "./persistence/labTerminalResults.ts";
import type { D1DatabaseCapability } from "../shared/persistence/runDiagnosticsD1.ts";
import type { LabFetchBinding, LabStartupDeadlineNamespaceCapability } from "./types.ts";
import {
  acknowledgeLabRequiredStop,
  getLabStartupState,
  recordLabStopAttempt,
  resolveOverdueLabStartup,
  type LabStartupState,
} from "./persistence/labStartup.ts";

const recoveryWakeMs = 10 * 60_000;

type LabStartupDeadlineEnvironment = Readonly<{
  LAB_STARTUP_DEADLINE?: LabStartupDeadlineNamespaceCapability;
}>;

export async function armLabStartupDeadline(
  env: LabStartupDeadlineEnvironment,
  runId: string,
  expiresAt: number,
): Promise<void> {
  if (env.LAB_STARTUP_DEADLINE === undefined) throw new Error("missing_startup_deadline");
  await env.LAB_STARTUP_DEADLINE.getByName(runId).arm(runId, expiresAt);
}

export async function wakeLabStartupDeadline(
  env: LabStartupDeadlineEnvironment,
  runId: string,
): Promise<void> {
  if (env.LAB_STARTUP_DEADLINE === undefined) return;
  await env.LAB_STARTUP_DEADLINE.getByName(runId).wake(runId);
}

export class LabStartupDeadline extends DurableObject<LabEnv> {
  async arm(runId: string, expiresAt: number): Promise<void> {
    const retained = await this.ctx.storage.get<{ runId: string; expiresAt: number }>("startup");
    if (retained !== undefined && (retained.runId !== runId || retained.expiresAt !== expiresAt))
      throw new Error("startup_deadline_mismatch");
    await this.ctx.storage.put("startup", retained ?? { runId, expiresAt });
    await this.ctx.storage.put("runId", runId);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > expiresAt) await this.ctx.storage.setAlarm(expiresAt);
  }

  async wake(runId: string): Promise<void> {
    const stored = await this.ctx.storage.get<string>("runId");
    if (stored !== undefined && stored !== runId) throw new Error("startup_deadline_mismatch");
    if (stored === undefined) await this.ctx.storage.put("runId", runId);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + recoveryWakeMs);
    const runId = await this.ctx.storage.get<string>("runId");
    if (runId === undefined) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const state = await processLabStartupWork(this.env, runId, Date.now());
    if (state === null) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.delete("runId");
      return;
    }
    const next = nextLabStartupWake(state);
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.delete("runId");
    } else {
      await this.ctx.storage.setAlarm(next);
    }
  }
}

export async function processLabStartupWork(
  env: Readonly<{
    LAB_DB: D1DatabaseCapability;
    RUNTIME_WORKER: LabFetchBinding;
  }>,
  runId: string,
  now: number,
): Promise<LabStartupState | null> {
  let state = await resolveOverdueLabStartup(env.LAB_DB, runId, now);
  if (
    state === null ||
    state.status !== "failed" ||
    !state.stopRequired ||
    state.stopAcknowledgedAt !== null ||
    (state.stopRetryAt !== null && state.stopRetryAt > now)
  ) {
    return state;
  }

  const attemptCount = state.stopAttemptCount + 1;
  const exponent = Math.min(Math.max(0, Math.floor(state.stopAttemptCount)), 6);
  const retryAt = now + Math.min(recoveryWakeMs, 10_000 * 2 ** exponent);
  await recordLabStopAttempt(env.LAB_DB, { runId, retryAt, attemptCount });
  const acknowledgement = await requestLabRequiredStop(
    env.RUNTIME_WORKER,
    new Request(
      `https://runtime.internal/_runtime/controllers/${encodeURIComponent(runId)}/required-stop`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: runId, reason: "application_startup_failed" }),
      },
    ),
  );
  if (acknowledgement?.runId === runId) {
    // Runtime fenced a Run it never accepted, so it will publish no result: Lab records the
    // failed start itself before retiring the stop. A failed write leaves the stop to retry.
    const resultOwned =
      acknowledgement.acceptance === "accepted" ||
      (await persistLabTerminalResult(env.LAB_DB, {
        runId,
        outcome: "failed_to_start",
        endedAt: Date.now(),
        runtimeUsage: completeEmptyRuntimeUsage,
      }).then(
        () => true,
        () => false,
      ));
    // An uncertain acknowledgement write is resolved by the authoritative read below.
    if (resultOwned)
      await acknowledgeLabRequiredStop(env.LAB_DB, runId, Date.now()).catch(() => undefined);
  }
  state = await getLabStartupState(env.LAB_DB, runId);
  return state;
}

export function nextLabStartupWake(state: LabStartupState): number | null {
  if (state.status === "pending") return state.expiresAt;
  if (state.status === "failed" && state.stopRequired && state.stopAcknowledgedAt === null)
    return state.stopRetryAt ?? Date.now();
  return null;
}
