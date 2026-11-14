export type {
  ConversationToolInvocation,
  ConversationToolIntent,
  PreparedConversationNode,
} from "./nodeContentContracts.ts";
/**
 * One node dispatch handed to execution. Runtime and admission see the erased default;
 * a selected pair's handlers see the input and reporter of the dispatched state.
 */
export type NodeDispatchInput<
  State extends string = string,
  Input = import("./conversationContracts.ts").ConversationCallbackJson,
  Event = import("./conversationContracts.ts").ConversationCallbackJson,
> = Readonly<{
  state: State;
  input: import("./conversationContracts.ts").DetachedReadonly<Input>;
  identity: import("./executionContracts.ts").ExecutionIdentity;
  deadlineAt: number | null;
  clock: () => number;
  reporter: import("./executionContracts.ts").StateReporter<Event>;
  onComplete(report: import("./executionContracts.ts").SemanticReport<unknown>): Promise<void>;
  onFailure(reason: string, responseId?: string): Promise<void>;
  /** The reply whose tool call caused the node. */
  triggeringReplyId?: string | undefined;
  /** Whether that reply had already settled when the node was dispatched. */
  triggeringReplySettled?: boolean;
  /** The tool call that caused the node, which the execution may answer. */
  triggeringToolCallId?: string | undefined;
  inputClosure?: Pick<
    import("./interviewFinalizationModel.ts").FinalInputState,
    "admittedItemId" | "obligation"
  >;
  /**
   * Takes over Runtime's pending input-closure step (`close_input`) for the node, which then
   * carries it out and reports its outcome with `reportInputClosure`; returns the step's command
   * id, or null when the node is no longer current or the step was already taken, as by Ending.
   */
  claimInputClosure?(): string | null;
  /** Reuse retained attribution for an automatic response observed during a prompt handoff. */
  observeOutputIdentity?(responseId: string, originatingResponseId?: string): void;
  /**
   * The node settled the closed input: with the participant item that answers it, or none, and
   * the operations the execution expects to report usage for it, under its own keys, such as
   * the item's transcription. Runtime records those and names none of its own.
   */
  settleInputClosure?(
    itemId: string | null,
    expectedUsage?: readonly import("./runtimeUsage.ts").ExpectedUsageEvidence[],
  ): void;
  /** The outcome of the input-closure step the node claimed. */
  reportInputClosure?(
    commandId: string,
    outcome: import("./interviewFinalizationModel.ts").FinalizationEffectOutcome,
  ): void;
}>;

type DeclaredStates = import("./conversationContracts.ts").ConversationStates;
/** The dispatch of each named state of a Conversation, discriminated by `state`. */
export type ConversationNodeDispatch<
  S extends DeclaredStates,
  Name extends Extract<keyof S, string> = Extract<keyof S, string>,
> = {
  [State in Name]: NodeDispatchInput<
    State,
    import("zod").z.output<S[State]["input"]>,
    import("zod").z.output<S[State]["event"]>
  >;
}[Name];
/** A pair's native session entry for the node dispatches of its own Conversation. */
export type NativeNodeEntry<S extends DeclaredStates> = Readonly<{
  enterNode(input: ConversationNodeDispatch<S>): void;
}>;
/** The registry-paired native entry as admission sees it; only the pair's handlers call it. */
export type NativeNodeOwner = Readonly<{ enterNode(input: never): void }>;

/** A bound retained-output owner interprets durable evidence without issuing native work. */
export type RetainedOutputProof = Readonly<{
  responseSettlement: import("./interviewFinalizationModel.ts").GracefulCompletionState["responseSettlement"];
  outputAudioSettlement: import("./interviewFinalizationModel.ts").GracefulCompletionState["outputAudioSettlement"];
  cleanupClaimed: boolean;
}>;
export type RetainedOutputInterpretation =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "failed"; reason: string }>
  | Readonly<{ kind: "report"; report: import("./executionContracts.ts").SemanticReport<unknown> }>;
export type ReportingPolicy =
  | Readonly<{ kind: "native" }>
  | Readonly<{
      kind: "retained_output";
      observe(proof: RetainedOutputProof): RetainedOutputInterpretation;
    }>;

export type { RuntimeImplementation, ConversationAdmission } from "./conversationAdmission.ts";

/** A Run's selected implementation with its accepted input, decoded once for this entry. */
export type SelectedConversation = Readonly<{
  agent: import("./conversationAdmission.ts").RuntimeImplementation;
  execution: import("../shared/contracts/runtimeStart.ts").InterviewExecution;
  accepted: import("./conversationContracts.ts").AcceptedConversation;
}>;

/**
 * The Runtime instance holds its Run's accepted Conversation input. Start or reconstruction
 * decodes it once; later timers, transitions and dispatches reuse the owned value.
 */
export class AcceptedConversations {
  readonly #resolve: (
    selection: import("../shared/contracts/conversationSelection.ts").ConversationSelection,
  ) => import("./conversationAdmission.ts").RuntimeImplementation;
  #retained: Readonly<{
    runId: string;
    source: object;
    key: string;
    selected: SelectedConversation;
  }> | null = null;

  constructor(
    resolve: (
      selection: import("../shared/contracts/conversationSelection.ts").ConversationSelection,
    ) => import("./conversationAdmission.ts").RuntimeImplementation,
  ) {
    this.#resolve = resolve;
  }

  select(
    runId: string,
    accepted: Pick<SelectedConversation, "execution"> &
      Readonly<{
        selection: import("../shared/contracts/conversationSelection.ts").ConversationSelection;
      }>,
  ): SelectedConversation {
    // The repository reuses one decoded snapshot per stored value, so the same snapshot is
    // recognized without serializing it. Otherwise the selection and accepted input of a Run
    // stay fixed, and the key identifies one decode.
    if (this.#retained?.runId === runId && this.#retained.source === accepted)
      return this.#retained.selected;
    const key = JSON.stringify([runId, accepted.selection, accepted.execution]);
    if (this.#retained?.key === key) {
      this.#retained = { ...this.#retained, source: accepted };
      return this.#retained.selected;
    }
    const agent = this.#resolve(accepted.selection);
    const selected: SelectedConversation = Object.freeze({
      agent,
      execution: structuredClone(accepted.execution),
      accepted: agent.accept(accepted.execution.agentInput),
    });
    this.#retained = { runId, source: accepted, key, selected };
    return selected;
  }
}
