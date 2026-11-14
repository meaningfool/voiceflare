import type { ApplicationCallbacks } from "./applicationCallbacks.ts";
import type { ExecutionCredentials } from "./nativeContracts.ts";
export type RuntimeFetchBinding = Readonly<{
  fetch(request: Request): Response | Promise<Response>;
}>;

export type RuntimeControllerCapability = RuntimeFetchBinding;

export type RuntimeControllerNamespaceCapability = Readonly<{
  getByName?(name: string): RuntimeControllerCapability;
  idFromName?(name: string): DurableObjectId;
  get?(id: DurableObjectId): RuntimeControllerCapability;
}>;

export type RuntimeEnvironmentCapabilities = Readonly<{
  [Binding in keyof RuntimeEnv]?: Binding extends "INTERVIEW_RUNTIME_CONTROLLER"
    ? RuntimeControllerNamespaceCapability
    : Binding extends `${string}_CALLBACK_WORKER`
      ? ApplicationCallbacks
      : RuntimeEnv[Binding];
}> &
  Readonly<{
    PROVIDER_HANGUP_TIMEOUT_MS?: unknown;
    RUNTIME_COMPLETION_CALLBACK_WORKER?: RuntimeFetchBinding;
  }>;

/** Runtime's credentials of these names from its environment; an unset one is absent. */
export function readRuntimeCredentials(
  environment: RuntimeEnvironmentCapabilities,
  names: readonly string[],
): ExecutionCredentials {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        names.includes(entry[0]) && typeof entry[1] === "string",
    ),
  );
}

export type RuntimeSettingName =
  | "PROVIDER_HANGUP_TIMEOUT_MS"
  | "RUNTIME_COMPLETION_CALLBACK_WORKER";

export type RuntimeSettingValue = string | number | RuntimeFetchBinding | undefined;

export function readRuntimeSetting(
  environment: RuntimeEnvironmentCapabilities,
  name: RuntimeSettingName,
): RuntimeSettingValue {
  const value = environment[name];

  if (name === "PROVIDER_HANGUP_TIMEOUT_MS") {
    return typeof value === "string" || typeof value === "number" ? value : undefined;
  }

  return isRuntimeFetchBinding(value) ? value : undefined;
}

function isRuntimeFetchBinding<Value>(value: Value): value is Value & RuntimeFetchBinding {
  return (
    value !== null &&
    typeof value === "object" &&
    "fetch" in value &&
    typeof value.fetch === "function"
  );
}
