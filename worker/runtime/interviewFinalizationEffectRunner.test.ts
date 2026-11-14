import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  finalizationEffectKinds,
  type FinalizationEffectKind,
  type FinalizationEffectRecord,
} from "./interviewFinalizationModel.ts";
import {
  finalizationEffectRecoveryContracts,
  runInterviewFinalizationEffect,
  type FinalizationEffectCrashPoint,
  type FinalizationEffectRunnerCapabilities,
} from "./interviewFinalizationEffectRunner.ts";

describe("Interview finalization effect runner", () => {
  it("defines the complete recovery contract for every effect kind", () => {
    expect(Object.keys(finalizationEffectRecoveryContracts).sort()).toEqual(
      [...finalizationEffectKinds].sort(),
    );
    for (const contract of Object.values(finalizationEffectRecoveryContracts)) {
      expect(Object.values(contract).every((value) => value.length > 0)).toBe(true);
    }
    expect(finalizationEffectRecoveryContracts.release_session).toEqual({
      correlation: "effect_id_and_provider_call_id",
      retry: "never_retry_uncertain_dispatch",
      consequence: "provider_close_event_documented_terminal_evidence_or_absolute_bound",
      benignRejection: "session_closed",
      deadline: "remaining_cutoff_or_retained_first_dispatch",
      terminalWarning: "session_release_failed_timed_out_or_uncertain",
    });
  });

  it.each(finalizationEffectKinds)("executes exactly the selected %s effect", async (kind) => {
    const capabilities = runnerCapabilities({ ready: true });
    const selected = effectForKind(kind);
    await expect(runSelectedEffect({ effect: selected, capabilities })).resolves.toMatchObject({
      kind: "outcome",
      effectId: selected.id,
      effectKind: kind,
    });
    expect(capabilities.repository.recordAttempt).toHaveBeenCalledOnce();
  });

  it.each([
    ["close_input", { kind: "close_input", commandId: "run:1", heldItemId: null }],
    ["discard_later_input", { kind: "discard_later_input", commandId: "run:1" }],
    [
      "cancel_reply",
      { kind: "cancel_reply", commandId: "run:1", responseId: "response_to_cancel" },
    ],
    ["stop_output", { kind: "stop_output", commandId: "run:1" }],
  ] as const)("sends only the selected semantic %s operation", async (kind, expectedOperation) => {
    const capabilities = runnerCapabilities({ ready: true });
    await expect(
      runSelectedEffect({ effect: effectForKind(kind), capabilities }),
    ).resolves.toMatchObject({
      effectId: "run:1",
      effectKind: kind,
      outcome: { status: "dispatched" },
    });
    expect(capabilities.provider.sendFinalizationOperation).toHaveBeenCalledExactlyOnceWith(
      expectedOperation,
    );
    expect(capabilities.provider.release).not.toHaveBeenCalled();
  });

  it.each(finalizationEffectKinds)("injects every durable crash boundary for %s", async (kind) => {
    for (const point of [
      "after_attempt_before_dispatch",
      "after_dispatch_before_outcome",
    ] as const satisfies readonly FinalizationEffectCrashPoint[]) {
      const capabilities = runnerCapabilities({ ready: true });
      const selected = effectForKind(kind);
      await expect(
        runSelectedEffect({
          effect: selected,
          capabilities,
          crashInjector: (observed, candidate) => {
            expect(candidate).toBe(selected);
            if (observed === point) throw new Error(`injected_crash:${point}`);
          },
        }),
      ).rejects.toThrow(`injected_crash:${point}`);
      expect(capabilities.repository.recordAttempt).toHaveBeenCalledOnce();
      if (point === "after_dispatch_before_outcome") {
        if (kind === "release_session") {
          expect(capabilities.provider.release).toHaveBeenCalledOnce();
        } else if (kind !== "compute_transcript_digest" && kind !== "arm_alarm") {
          expect(capabilities.provider.sendFinalizationOperation).toHaveBeenCalledOnce();
        }
      }
    }
  });

  it.each(["close_input", "discard_later_input", "cancel_reply", "stop_output"] as const)(
    "leaves %s sending when the provider throws while dispatching",
    async (kind) => {
      const capabilities = runnerCapabilities({
        ready: true,
        sendFinalizationOperation: () => {
          throw new Error("injected_crash:while_sending");
        },
      });
      await expect(
        runSelectedEffect({ effect: effectForKind(kind), capabilities }),
      ).rejects.toThrow("injected_crash:while_sending");
      expect(capabilities.repository.recordAttempt).toHaveBeenCalledOnce();
    },
  );

  it("leaves selected hangup sending when the provider throws during dispatch", async () => {
    const capabilities = runnerCapabilities({
      release: () => Effect.die(new Error("injected_crash:during_hangup")),
    });
    await expect(
      runSelectedEffect({
        effect: effectForKind("release_session"),
        capabilities,
      }),
    ).rejects.toThrow("injected_crash:during_hangup");
    expect(capabilities.repository.recordAttempt).toHaveBeenCalledOnce();
  });

  it.each(["sending", "dispatched", "failed", "uncertain"] as const)(
    "rejects a selected effect already in %s state",
    async (status) => {
      const capabilities = runnerCapabilities({ ready: true });
      await expect(runSelectedEffect({ effect: effect({ status }), capabilities })).rejects.toThrow(
        `invalid_finalization_effect_status:${status}`,
      );
      expect(capabilities.repository.recordAttempt).not.toHaveBeenCalled();
    },
  );

  it("records the selected pending attempt before dispatching its command", async () => {
    const calls: string[] = [];
    const capabilities = runnerCapabilities({
      ready: true,
      recordAttempt: (effectId) => calls.push(`attempt:${effectId}`),
      sendFinalizationOperation: (command) => {
        calls.push(`sendFinalizationOperation:${command.kind}`);
        return { status: "dispatched" };
      },
    });
    await runSelectedEffect({
      effect: effect({ kind: "close_input" }),
      capabilities,
    });
    expect(calls).toEqual(["attempt:run:1", "sendFinalizationOperation:close_input"]);
  });

  it("returns a definite pre-dispatch failure when a selected provider command lacks sideband", async () => {
    const capabilities = runnerCapabilities({ ready: false });
    await expect(
      runSelectedEffect({
        effect: effect({ kind: "discard_later_input" }),
        capabilities,
      }),
    ).resolves.toMatchObject({
      outcome: { status: "failed", code: "session_unavailable_before_dispatch" },
    });
    expect(capabilities.repository.recordAttempt).not.toHaveBeenCalled();
    expect(capabilities.provider.sendFinalizationOperation).not.toHaveBeenCalled();
  });

  it("records a failed socket send as uncertain because dispatch began", async () => {
    const capabilities = runnerCapabilities({
      ready: true,
      sendFinalizationOperation: () => ({ status: "failed", code: "provider_command_send_failed" }),
    });
    await expect(
      runSelectedEffect({
        effect: effect({ kind: "stop_output" }),
        capabilities,
      }),
    ).resolves.toMatchObject({
      outcome: { status: "uncertain", code: "provider_command_send_failed" },
    });
    expect(capabilities.provider.sendFinalizationOperation).toHaveBeenCalledOnce();
  });

  it("runs digest and alarm effects without sideband", async () => {
    for (const kind of ["compute_transcript_digest", "arm_alarm"] as const) {
      const capabilities = runnerCapabilities({ ready: false });
      await expect(
        runSelectedEffect({ effect: effectForKind(kind), capabilities }),
      ).resolves.toMatchObject({ effectKind: kind, outcome: { status: "dispatched" } });
    }
  });

  it("delegates selected provider hangup without requiring sideband", async () => {
    const capabilities = runnerCapabilities({
      ready: false,
      release: () => Effect.succeed({ status: "failed" as const, code: "hangup_failed" }),
    });
    await expect(
      runSelectedEffect({
        effect: effect({ kind: "release_session" }),
        capabilities,
      }),
    ).resolves.toMatchObject({ outcome: { status: "failed", code: "hangup_failed" } });
  });

  it.each(["", " "])(
    "rejects a cancel-response effect with invalid response identity %s",
    async (responseId) => {
      const capabilities = runnerCapabilities({ ready: true });
      const selected: FinalizationEffectRecord = {
        ...effectFields(),
        kind: "cancel_reply",
        responseId,
      };
      await expect(
        runSelectedEffect({
          effect: selected,
          capabilities,
        }),
      ).rejects.toThrow("invalid_finalization_effect:cancel_reply_response_id");
      expect(capabilities.repository.recordAttempt).not.toHaveBeenCalled();
    },
  );

  it.each([-1, 1.5])(
    "rejects a digest effect with invalid transcript revision %s",
    async (revision) => {
      const capabilities = runnerCapabilities({ ready: false });
      const selected: FinalizationEffectRecord = {
        ...effectFields(),
        kind: "compute_transcript_digest",
        revision,
      };
      await expect(
        runSelectedEffect({
          effect: selected,
          capabilities,
        }),
      ).rejects.toThrow("invalid_finalization_effect:compute_transcript_digest_revision");
      expect(capabilities.repository.recordAttempt).not.toHaveBeenCalled();
    },
  );
});

type ActiveEffectStatus = Exclude<FinalizationEffectRecord["status"], "skipped">;

function effectFields(status: ActiveEffectStatus = "pending") {
  return { id: "run:1", status, acceptance: "unobserved", attemptCount: 0 } as const;
}

function effect({
  kind = "stop_output",
  status = "pending",
}: Partial<
  Readonly<{
    kind: Exclude<FinalizationEffectKind, "cancel_reply" | "compute_transcript_digest">;
    status: ActiveEffectStatus;
  }>
> = {}): FinalizationEffectRecord {
  // Split the kinds so each object stays within TypeScript's discriminated-union check.
  return kind === "close_input"
    ? { ...effectFields(status), kind, heldItemId: null }
    : { ...effectFields(status), kind };
}

function effectForKind(kind: FinalizationEffectKind): FinalizationEffectRecord {
  if (kind === "cancel_reply") {
    return { ...effectFields(), kind, responseId: "response_to_cancel" };
  }
  if (kind === "compute_transcript_digest") {
    return { ...effectFields(), kind, revision: 3 };
  }
  return effect({ kind });
}

function runnerCapabilities(
  overrides: Readonly<{
    ready?: boolean;
    recordAttempt?: (effectId: string) => void;
    sendFinalizationOperation?: FinalizationEffectRunnerCapabilities["provider"]["sendFinalizationOperation"];
    release?: FinalizationEffectRunnerCapabilities["provider"]["release"];
  }> = {},
): FinalizationEffectRunnerCapabilities {
  const sendFinalizationOperation: FinalizationEffectRunnerCapabilities["provider"]["sendFinalizationOperation"] =
    overrides.sendFinalizationOperation ?? (() => ({ status: "dispatched" }));
  const release: FinalizationEffectRunnerCapabilities["provider"]["release"] =
    overrides.release ?? (() => Effect.succeed({ status: "dispatched" as const }));
  return {
    repository: { recordAttempt: vi.fn(overrides.recordAttempt ?? (() => undefined)) },
    connection: { ready: overrides.ready ?? false },
    provider: {
      sendFinalizationOperation: vi.fn(sendFinalizationOperation),
      release: vi.fn(release),
    },
  };
}

function runSelectedEffect(input: Parameters<typeof runInterviewFinalizationEffect>[0]) {
  return Effect.runPromise(Effect.suspend(() => runInterviewFinalizationEffect(input)));
}
