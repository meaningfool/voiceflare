/**
 * The OpenAI commands that Ending's steps translate into on Realtime
 * (`RealtimeSession.sendFinalizationOperation`); the driver owns their wire encoding.
 */
export type RealtimeEndingCommand =
  | Readonly<{
      kind: "disable_automatic_turns" | "commit_input" | "clear_input" | "clear_output";
      commandId: string;
    }>
  | Readonly<{
      kind: "cancel_response";
      commandId: string;
      responseId: string;
    }>;
