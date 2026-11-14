import {
  providerFailure,
  providerSuccess,
  type ProviderOutcome,
} from "../../runtime/providerOutcomes.ts";

export type ProviderCommand =
  | TurnDetectionUpdateCommand
  | SessionInstructionsUpdateCommand
  | FunctionCallOutputCommand
  | TrackedResponseCommand
  | AudioResponseCommand
  | InitialInterviewResponseCommand
  | DisableAutomaticTurnsCommand
  | FinalInputCommitCommand
  | ClearInputCommand
  | CancelResponseCommand
  | ClearOutputCommand;

export type InitialInterviewResponseCommand = Readonly<{
  event_id: string;
  type: "response.create";
}>;

export type DisableAutomaticTurnsCommand = Readonly<{
  event_id: string;
  type: "session.update";
  session: Readonly<{
    type: "realtime";
    instructions?: string;
    tools?: readonly [];
    tool_choice?: "none";
    audio: Readonly<{
      input: Readonly<{
        turn_detection: null | Readonly<{
          type: string;
          eagerness?: string;
          threshold?: number;
          create_response: false;
          interrupt_response: false;
        }>;
      }>;
    }>;
  }>;
}>;

export type FinalInputCommitCommand = Readonly<{
  event_id: string;
  type: "input_audio_buffer.commit";
}>;

export type ClearInputCommand = Readonly<{
  event_id: string;
  type: "input_audio_buffer.clear";
}>;

export type CancelResponseCommand = Readonly<{
  event_id: string;
  type: "response.cancel";
  response_id: string;
}>;

export type ClearOutputCommand = Readonly<{
  event_id: string;
  type: "output_audio_buffer.clear";
}>;

export type ProviderCommandSocket = Readonly<{
  send(data: string): void;
}>;

export function buildInitialInterviewResponseCommand(
  now = Date.now(),
): InitialInterviewResponseCommand {
  return {
    event_id: `evt_initial_interview_response_${now}`,
    type: "response.create",
  };
}

export function buildDisableAutomaticTurnsCommand(eventId: string): DisableAutomaticTurnsCommand {
  return {
    event_id: eventId,
    type: "session.update",
    session: {
      type: "realtime",
      audio: {
        input: {
          turn_detection: null,
        },
      },
    },
  };
}

export function buildFinalInputCommitCommand(eventId: string): FinalInputCommitCommand {
  return {
    event_id: eventId,
    type: "input_audio_buffer.commit",
  };
}

export function buildClearInputCommand(eventId: string): ClearInputCommand {
  return {
    event_id: eventId,
    type: "input_audio_buffer.clear",
  };
}

export function buildCancelResponseCommand(
  eventId: string,
  responseId: string,
): CancelResponseCommand {
  return {
    event_id: eventId,
    type: "response.cancel",
    response_id: responseId,
  };
}

export function buildClearOutputCommand(eventId: string): ClearOutputCommand {
  return {
    event_id: eventId,
    type: "output_audio_buffer.clear",
  };
}

export function sendProviderCommand(
  socket: ProviderCommandSocket,
  command: ProviderCommand,
): ProviderOutcome<void> {
  try {
    socket.send(JSON.stringify(command));
    return providerSuccess(undefined);
  } catch {
    return providerFailure({
      stage: "provider_command",
      code: "provider_command_send_failed",
      retryable: true,
    });
  }
}

/**
 * A spoken reply with its own instructions, from a fresh context (an empty `input`), that lands
 * in the default conversation, reasons at the lowest effort and can call no tool.
 */
export type AudioResponseCommand = Readonly<{
  event_id: string;
  type: "response.create";
  response: Readonly<{
    output_modalities: readonly ["audio"];
    instructions: string;
    input: readonly [];
    conversation: "auto";
    reasoning: Readonly<{ effort: "minimal" }>;
    tools: readonly [];
    tool_choice: "none";
    metadata: Readonly<{ runtime_operation_id: string }>;
  }>;
}>;

export type TurnDetection = Readonly<{
  type: string;
  eagerness?: string;
  threshold?: number;
  create_response: boolean;
  interrupt_response: boolean;
}>;
export type InputTurnConfiguration = Readonly<{
  input: Readonly<{ turn_detection: TurnDetection }>;
}>;
export type TurnDetectionUpdateCommand = Readonly<{
  type: "session.update";
  event_id: string;
  session: Readonly<{ type: "realtime"; audio: InputTurnConfiguration }>;
}>;
export type SessionInstructionsUpdateCommand = Readonly<{
  type: "session.update";
  event_id: string;
  session: Readonly<{
    type: "realtime";
    instructions: string;
    tools: readonly import("../../runtime/nodeContentContracts.ts").PreparedTool[];
    audio: InputTurnConfiguration;
  }>;
}>;
export type FunctionCallOutputCommand = Readonly<{
  type: "conversation.item.create";
  event_id: string;
  item: Readonly<{ type: "function_call_output"; call_id: string; output: string }>;
}>;
export type TrackedResponseCommand = Readonly<{
  type: "response.create";
  event_id: string;
  response: Readonly<{ metadata: Readonly<{ runtime_operation_id: string }> }>;
}>;
