export type ProviderFailureStage =
  | "call_creation"
  | "session_setup"
  | "provider_command"
  | "hangup";

export type ProviderFailureCode =
  | "provider_call_request_failed"
  | "provider_call_response_read_failed"
  | `provider_call_http_${number}`
  | "sideband_connect_failed"
  | "sideband_call_id_not_found"
  | "sideband_connect_rejected"
  | "provider_command_send_failed"
  | "session_release_failed"
  // Provider adapters may emit this only from documented exact-call terminal evidence.
  | "provider_session_already_closed"
  | "session_release_uncertain"
  | "session_release_timed_out";

export type ProviderFailureOutcome = Readonly<{
  kind: "provider_failure";
  stage: ProviderFailureStage;
  code: ProviderFailureCode;
  providerStatus?: number;
  requestId?: string;
  retryable: boolean;
  timeoutMs?: number;
}>;

export type ProviderOutcome<T> =
  | Readonly<{
      ok: true;
      value: T;
    }>
  | Readonly<{
      ok: false;
      failure: ProviderFailureOutcome;
    }>;

export function providerSuccess<T>(value: T): ProviderOutcome<T> {
  return { ok: true, value };
}

export function providerFailure(
  failure: Omit<ProviderFailureOutcome, "kind">,
): ProviderOutcome<never> {
  return {
    ok: false,
    failure: {
      kind: "provider_failure",
      ...failure,
    },
  };
}

export function providerFailureText(failure: ProviderFailureOutcome): string {
  const status = failure.providerStatus === undefined ? "" : ` status=${failure.providerStatus}`;
  const requestId = failure.requestId === undefined ? "" : ` requestId=${failure.requestId}`;
  return `${failure.stage}:${failure.code}${status}${requestId}`;
}
