import type { ExecutionCredentials } from "../../runtime/nativeContracts.ts";

/** The credential OpenAI's Realtime API needs: the OpenAI API key, named as Runtime reads it. */
export const realtimeCredentials = ["OPENAI_API_KEY"] as const;

/** The Realtime provider's own credential from Runtime's set; empty when Runtime lacks it. */
export function realtimeApiKey(credentials: ExecutionCredentials): string {
  return credentials.OPENAI_API_KEY ?? "";
}
