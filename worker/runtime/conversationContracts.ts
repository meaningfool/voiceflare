import { z } from "zod";
import type { DiagnosticDeclarations, DiagnosticDescription } from "./diagnosticContracts.ts";
import type { StateReporter } from "./executionContracts.ts";
import type {
  ConversationToolIntent,
  ConversationToolInvocation,
  PreparedClosing,
  PreparedConversationNode,
} from "./nodeContentContracts.ts";

export type DetachedReadonly<Value> = {
  readonly [Key in keyof Value]: DetachedReadonly<Value[Key]>;
};
export type ConversationCallbackJson =
  | string
  | number
  | boolean
  | null
  | ConversationCallbackArray
  | ConversationCallbackObject;
interface ConversationCallbackArray extends ReadonlyArray<ConversationCallbackJson> {}
interface ConversationCallbackObject {
  readonly [key: string]: ConversationCallbackJson;
}
/**
 * Erased Conversation JSON as Runtime persists it: the same grammar as `z.json()`, typed as
 * the readonly values Conversations produce, so recording them needs no conversion parse.
 */
export const conversationJsonSchema: z.ZodType<ConversationCallbackJson> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(conversationJsonSchema).readonly(),
    z.record(z.string(), conversationJsonSchema).readonly(),
  ]),
);
export type ConversationExecutionInput = Readonly<{ agentInput: ConversationCallbackJson }>;
export type ConversationState<Input, Event> = Readonly<{
  id: string;
  finishesParticipation?: true;
  input: z.ZodType<Input>;
  event: z.ZodType<Event>;
}>;
/**
 * What one state says, prepared from that state's node input: what the model receives in a
 * conversing state, or the sentence a closing state says. A state that sends the model nothing,
 * such as one that keeps the output of the reply that entered it, declares `prepare: null`.
 */
export type StateContent<Input, Event> = Readonly<{
  contract: ConversationState<Input, Event>;
  prepare: ((input: DetachedReadonly<Input>) => PreparedConversationNode | PreparedClosing) | null;
}>;
export type ConversationStates = Readonly<
  Record<string, ConversationState<unknown, ConversationCallbackJson>>
>;
type States = ConversationStates;
type StateContents<S extends States> = {
  readonly [Key in keyof S]: StateContent<z.output<S[Key]["input"]>, z.output<S[Key]["event"]>>;
};
/**
 * A Conversation's content for every one of its states, written once in its Conversation module
 * and used by every execution. Coverage and codec identity are checked when it is declared.
 */
export function declareStateContent<const S extends States, const C extends StateContents<S>>(
  states: S,
  contents: C,
): C {
  const names = Object.keys(states).sort();
  const supplied = Object.keys(contents).sort();
  if (names.length !== supplied.length || names.some((name, index) => name !== supplied[index]))
    throw new Error("conversation_state_content_coverage_invalid");
  for (const name of names) {
    const content = contents[name];
    if (
      content === undefined ||
      content.contract !== states[name] ||
      (content.prepare !== null && typeof content.prepare !== "function")
    )
      throw new Error("conversation_state_content_contract_invalid");
  }
  return Object.freeze(contents);
}

/**
 * Turns a tool call into what it asks of the current state: the event `meaning` builds from the
 * call's response and call ids, reported through the state's reporter. Without a reporter the
 * call is only recognized; without both ids it is recognized and reports nothing, so Runtime
 * refuses it as undecodable.
 */
export function reportToolCall<Event>(
  invocation: ConversationToolInvocation,
  reporter: StateReporter<Event> | undefined,
  meaning: (identities: Readonly<{ responseId: string; toolCallId: string }>) => Event,
): ConversationToolIntent | null {
  if (
    reporter === undefined ||
    invocation.responseId === undefined ||
    invocation.callId === undefined
  )
    return { kind: "conversation_event" };
  const report = reporter.report(
    meaning({ responseId: invocation.responseId, toolCallId: invocation.callId }),
  );
  return report === null ? null : { kind: "conversation_event", report };
}

/** The declared terminals Runtime writes when a live Conversation ends normally or is interrupted. */
export type ConversationTerminalRoles<Terminal extends string = string> = Readonly<{
  completion: Terminal;
  interruption: Terminal;
}>;
export type ConversationStateName<S> = Extract<keyof S, string>;
/** A state's execution report or a declared runtime event, admitted before evaluation. */
export type ConversationReceivedEvent<Event, RuntimeEvent> =
  | Readonly<{ origin: "execution"; event: Event }>
  | Readonly<{ origin: "runtime"; event: RuntimeEvent }>;
export type ConversationEvaluation<Target extends string, Context> =
  | Target
  | null
  | Readonly<{
      target: Target | null;
      diagnostics: readonly DiagnosticDescription[];
      context?: Context;
    }>;
// Method signatures keep each typed declaration assignable to the private erased form.
type StateEvaluator<Event, RuntimeEvent, Target extends string, Context> = {
  evaluate(
    received: ConversationReceivedEvent<Event, RuntimeEvent>,
    context: Context,
  ): ConversationEvaluation<Target, Context>;
}["evaluate"];
/** A Conversation without declared context selects input from the Run alone. */
export type ConversationInputSelection<Context> = [Context] extends [never]
  ? Readonly<{ runId: string }>
  : Readonly<{ runId: string; context: Context }>;
type StateInputSelector<Input, StateInput, Context> = {
  select(input: Input, selection: ConversationInputSelection<Context>): StateInput;
}["select"];
export type ConversationTimerPlan<RuntimeEvent> = Readonly<{
  timers: readonly Readonly<{ id: string; deadlineAt: number; event: RuntimeEvent }>[];
  associatedTimerId?: string;
  retainedOutputCleanupAt?: number;
}>;
/** What a Conversation declares about itself: input, states, events, context and terminals. */
export type ConversationStructure<
  S extends States,
  Terminal extends string,
  Input,
  Context,
  RuntimeEvent extends ConversationCallbackJson,
> = Readonly<{
  /** The owned decoder for the accepted Conversation input. */
  input(value: ConversationCallbackJson): Input;
  states: S;
  terminalStates: readonly Terminal[];
  context?: Readonly<{ schema: z.ZodType<Context>; initial(input: Input): Context }>;
  runtimeEvent?: z.ZodType<RuntimeEvent>;
  diagnostics?: DiagnosticDeclarations;
}>;
/** Normal progression over the declared structure; every state has a selector and evaluator. */
export type ConversationProgression<
  S extends States,
  Terminal extends string,
  Input,
  Context,
  RuntimeEvent extends ConversationCallbackJson,
> = Readonly<{
  initial: ConversationStateName<S>;
  terminalRoles: ConversationTerminalRoles<Terminal>;
  timers?(
    input: Input,
    anchor: Readonly<{ liveAt: number; enteredAt: number; state: ConversationStateName<S> }>,
  ): ConversationTimerPlan<RuntimeEvent>;
  selectInput: {
    readonly [Name in ConversationStateName<S>]: StateInputSelector<
      Input,
      z.output<S[Name]["input"]>,
      Context
    >;
  };
  evaluate: {
    readonly [Name in ConversationStateName<S>]: StateEvaluator<
      z.output<S[Name]["event"]>,
      RuntimeEvent,
      ConversationStateName<S> | Terminal,
      Context
    >;
  };
}>;
/** A Conversation declared once. The private admission owner is the only place it is erased. */
export type ConversationDeclaration<
  S extends States,
  Terminal extends string,
  Input,
  Context,
  RuntimeEvent extends ConversationCallbackJson,
> = ConversationStructure<S, Terminal, Input, Context, RuntimeEvent> &
  ConversationProgression<S, Terminal, Input, Context, RuntimeEvent>;

/** Fixes the declared structure first, so its progression is checked against it. */
export function declareConversation<
  const S extends States,
  const Terminal extends string,
  Input,
  Context = never,
  RuntimeEvent extends ConversationCallbackJson = never,
>(structure: ConversationStructure<S, Terminal, Input, Context, RuntimeEvent>) {
  return Object.freeze({
    progression(
      progression: ConversationProgression<S, Terminal, Input, Context, RuntimeEvent>,
    ): ConversationDeclaration<S, Terminal, Input, Context, RuntimeEvent> {
      return Object.freeze({ ...structure, ...progression });
    },
  });
}

/** Conversation declares normal progression. Runtime admits the decision before effects. */
export type ConversationMetadata = Readonly<{
  initial: string;
  context?: Readonly<{ schema: z.ZodType<ConversationCallbackJson> }>;
  diagnostics?: DiagnosticDeclarations;
  runtimeEvent?: z.ZodType<ConversationCallbackJson>;
  states: States;
  terminalStates: readonly string[];
  terminalRoles: ConversationTerminalRoles;
}>;

/**
 * A Run's accepted Conversation input, decoded once by the admission owner for one
 * Runtime entry. Runtime sees JSON; the selected Conversation receives its typed input.
 */
export type AcceptedConversation = Readonly<{
  initialContext: ConversationCallbackJson | undefined;
  timers?(
    anchor: Readonly<{ liveAt: number; enteredAt: number; state: string }>,
  ): ConversationTimerPlan<ConversationCallbackJson>;
  /** The node input the Conversation selects for an active state; the stored context is decoded. */
  selectInput(
    state: string,
    selection: Readonly<{ runId: string; context?: ConversationCallbackJson | undefined }>,
  ): ConversationCallbackJson;
}>;

type ConversationStructureNames = Pick<
  ConversationMetadata,
  "initial" | "states" | "terminalStates" | "terminalRoles"
>;

export function validateConversationDefinition(conversation: ConversationStructureNames): void {
  if (
    !Object.hasOwn(conversation.states, conversation.initial) ||
    conversation.terminalStates.length === 0 ||
    new Set(conversation.terminalStates).size !== conversation.terminalStates.length ||
    conversation.terminalStates.some(
      (state) => state.length === 0 || Object.hasOwn(conversation.states, state),
    ) ||
    !conversation.terminalStates.includes(conversation.terminalRoles.completion) ||
    !conversation.terminalStates.includes(conversation.terminalRoles.interruption)
  )
    throw new Error("conversation_definition_invalid");
}

export function requireConversationState(
  conversation: ConversationStructureNames,
  state: string,
): ConversationState<unknown, ConversationCallbackJson> | null {
  validateConversationDefinition(conversation);
  if (Object.hasOwn(conversation.states, state)) return conversation.states[state] ?? null;
  if (conversation.terminalStates.includes(state)) return null;
  throw new Error("conversation_visit_unavailable");
}

export type ConversationTransitionDecision = Readonly<{
  target: string | null;
  terminal: boolean;
  diagnostics: readonly DiagnosticDescription[];
  context?: ConversationCallbackJson;
}>;
