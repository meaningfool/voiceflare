import type { z } from "zod";
import type { ConversationDefinition } from "./definition.ts";
import type {
  ConversationExecutionInput,
  ConversationCallbackJson,
  ConversationStates,
  DetachedReadonly,
} from "../../conversationContracts.ts";
import type { ReporterFactory } from "./reporting.ts";
export type { ReporterFactory } from "./reporting.ts";
import type {
  ConversationNodeDispatch,
  NativeNodeOwner,
  PreparedConversationNode,
  ConversationToolInvocation,
  ConversationToolIntent,
  ReportingPolicy,
} from "../../implementationContracts.ts";

type StateName<S> = Extract<keyof S, string>;
/** The selected node input of one declared state, handed to its own preparation. */
export type ConversationNodePreparation<S extends ConversationStates> = {
  [State in StateName<S>]: Readonly<{
    runId: string;
    state: State;
    nodeInput: DetachedReadonly<z.output<S[State]["input"]>>;
  }>;
}[StateName<S>];

/**
 * A pair's implementation of its own Conversation. Handlers, preparation and native
 * entry are typed by the declared states; only admission sees the erased default.
 */
export type RuntimeImplementationDefinition<
  Conversation extends ConversationDefinition = ConversationDefinition,
  Native = NativeNodeOwner,
> = Readonly<{
  id: string;
  conversation: Conversation;
  finalizedDiagnostics?(
    completion: Readonly<{ warnings: readonly string[]; finalizedAt: number; endReason: string }>,
  ): readonly import("../../diagnosticContracts.ts").DiagnosticDescription[];
  executionHandlers: ExecutionHandlers<Conversation["states"], Native>;
  prepare(input: ConversationNodePreparation<Conversation["states"]>): PreparedConversationNode;
  interpretTool(
    invocation: ConversationToolInvocation,
    execution: ConversationExecutionInput | null,
  ): ConversationToolIntent | null;
}>;

export type BoundRuntimeImplementation<
  Policy extends ReportingPolicy["kind"] = ReportingPolicy["kind"],
> = Pick<RuntimeImplementationDefinition, "interpretTool"> &
  Readonly<{ reporting: Extract<ReportingPolicy, { kind: Policy }> }>;

/** Retained output interprets existing work; only native handlers can enter new work. */
export type RuntimeExecutionHandler<
  Contract = import("../../conversationContracts.ts").ConversationState<
    ConversationCallbackJson,
    ConversationCallbackJson
  >,
  Dispatch = import("../../implementationContracts.ts").NodeDispatchInput,
  Native = NativeNodeOwner,
> = Readonly<{ contract: Contract }> &
  (
    | Readonly<{
        policy: "native";
        // A method keeps each typed handler assignable to admission's erased table.
        enter(input: Dispatch, native: Native): void;
        bind(issue: ReporterFactory): BoundRuntimeImplementation<"native">;
      }>
    | Readonly<{
        policy: "retained_output";
        enter: null;
        bind(issue: ReporterFactory): BoundRuntimeImplementation<"retained_output">;
      }>
  );
/** One handler per declared state, receiving that state's dispatch and the pair's native entry. */
export type ExecutionHandlers<S extends ConversationStates, Native = NativeNodeOwner> = {
  readonly [State in StateName<S>]: RuntimeExecutionHandler<
    S[State],
    ConversationNodeDispatch<S, State>,
    Native
  >;
};

export function implementExecutionHandlers<
  const S extends ConversationStates,
  Native = NativeNodeOwner,
>(states: S, handlers: ExecutionHandlers<S, Native>): ExecutionHandlers<S, Native> {
  const names = Object.keys(states).sort();
  const supplied = Object.keys(handlers).sort();
  if (names.length !== supplied.length || names.some((name, index) => name !== supplied[index]))
    throw new Error("execution_handler_coverage_invalid");
  for (const name of names) {
    const handler = handlers[name];
    if (
      handler === undefined ||
      handler.contract !== states[name] ||
      typeof handler.bind !== "function"
    )
      throw new Error("execution_handler_contract_invalid");
    if (
      !(
        (handler.policy === "native" && typeof handler.enter === "function") ||
        (handler.policy === "retained_output" && handler.enter === null)
      )
    )
      throw new Error("execution_handler_policy_invalid");
  }
  return handlers;
}
