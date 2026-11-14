import type { D1DatabaseCapability } from "../shared/persistence/runDiagnosticsD1.ts";

export type LabFetchBinding = Readonly<{
  fetch(request: Request): Response | Promise<Response>;
}>;

export type LabEnvironmentCapabilities = Readonly<{
  [Binding in keyof LabEnv]?: LabBindingCapability<Binding>;
}> &
  Readonly<{
    ALLOWED_ORIGIN?: string;
  }>;

export type LabStartupDeadlineNamespaceCapability = Readonly<{
  getByName(name: string): Readonly<{
    arm(runId: string, expiresAt: number): Promise<void>;
    wake(runId: string): Promise<void>;
  }>;
}>;

type LabBindingCapability<Binding extends keyof LabEnv> = Binding extends "LAB_DB"
  ? D1DatabaseCapability
  : Binding extends "LAB_STARTUP_DEADLINE"
    ? LabStartupDeadlineNamespaceCapability
    : Binding extends "ASSETS" | "RUNTIME_WORKER"
      ? LabFetchBinding
      : LabEnv[Binding];
