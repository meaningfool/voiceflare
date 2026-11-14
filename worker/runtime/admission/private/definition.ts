import { z } from "zod";
import type {
  AcceptedConversation,
  ConversationCallbackJson,
  ConversationDeclaration,
  ConversationMetadata,
  ConversationState,
  ConversationTransitionDecision,
} from "../../conversationContracts.ts";
import { requireConversationState } from "../../conversationContracts.ts";
/**
 * The one place Conversation structure is erased. Every typed declaration is assignable
 * here. Admission decodes what Runtime holds as erased JSON (context and Runtime events)
 * when it hands it back; the Conversation's own typed outputs are not decoded again.
 */
export type ConversationDefinition = Omit<
  ConversationDeclaration<
    Readonly<Record<string, ConversationState<ConversationCallbackJson, ConversationCallbackJson>>>,
    string,
    ConversationCallbackJson,
    ConversationCallbackJson | undefined,
    ConversationCallbackJson
  >,
  "context"
> &
  Readonly<{
    context?: Readonly<{
      schema: z.ZodType<ConversationCallbackJson>;
      initial(input: ConversationCallbackJson): ConversationCallbackJson;
    }>;
  }>;

/** Runtime-facing JSON metadata; accepted input is decoded only by `acceptConversation`. */
export function describeConversation(conversation: ConversationDefinition): ConversationMetadata {
  const declared = conversation.context;
  let metadata: ConversationMetadata = {
    initial: conversation.initial,
    states: conversation.states,
    terminalStates: conversation.terminalStates,
    terminalRoles: conversation.terminalRoles,
  };
  if (declared !== undefined) metadata = { ...metadata, context: { schema: declared.schema } };
  if (conversation.diagnostics !== undefined)
    metadata = { ...metadata, diagnostics: conversation.diagnostics };
  if (conversation.runtimeEvent !== undefined)
    metadata = { ...metadata, runtimeEvent: conversation.runtimeEvent };
  return Object.freeze(metadata);
}

/**
 * Decodes a Run's accepted input once. The frozen typed value serves every later timer,
 * context and node-input selection of the same Runtime entry without another decode.
 */
export function acceptConversation(
  conversation: ConversationDefinition,
  input: ConversationCallbackJson,
): AcceptedConversation {
  // The accepted-input decoder owns the configuration boundary and detaches its input. The
  // initial context and the selected node input are typed outputs of the Conversation.
  const accepted = freezeOwned(conversation.input(input));
  const declared = conversation.context;
  const timers = conversation.timers;
  let owner: AcceptedConversation = {
    initialContext: declared?.initial(accepted),
    selectInput(state, selection) {
      if (requireConversationState(conversation, state) === null)
        throw new Error("conversation_node_input_unavailable");
      const select = Object.hasOwn(conversation.selectInput, state)
        ? conversation.selectInput[state]
        : undefined;
      if (select === undefined) throw new Error("conversation_input_state_invalid");
      return select(accepted, {
        runId: selection.runId,
        context: decodeRuntimeContext(conversation, selection.context),
      });
    },
  };
  if (timers !== undefined)
    owner = {
      ...owner,
      timers(anchor) {
        if (!Object.hasOwn(conversation.states, anchor.state))
          throw new Error("conversation_visit_unavailable");
        return timers(accepted, anchor);
      },
    };
  return Object.freeze(owner);
}

/**
 * Runtime holds a Conversation's context as erased JSON: the initial context, a decision's
 * context, or the stored visit. It is decoded by the declared schema when handed back.
 */
function decodeRuntimeContext(
  conversation: ConversationDefinition,
  context: ConversationCallbackJson | undefined,
): ConversationCallbackJson | undefined {
  return conversation.context?.schema.parse(context);
}

function freezeOwned(value: ConversationCallbackJson): ConversationCallbackJson {
  if (typeof value === "object" && value !== null)
    for (const nested of Object.values(value)) freezeOwned(nested);
  return Object.freeze(value);
}

export function decideConversationTransition(
  conversation: ConversationDefinition,
  state: string,
  event: ConversationCallbackJson,
  origin: "execution" | "runtime" = "execution",
  context?: ConversationCallbackJson,
): ConversationTransitionDecision {
  const contract = requireConversationState(conversation, state);
  if (contract === null) throw new Error("conversation_event_state_invalid");
  const evaluate = Object.hasOwn(conversation.evaluate, state)
    ? conversation.evaluate[state]
    : undefined;
  if (evaluate === undefined) throw new Error("conversation_event_state_invalid");
  let accepted = event;
  // A Runtime event is erased JSON that Runtime chose; it is decoded into the declared runtime
  // vocabulary here. An execution event was decoded by this state's contract at report capture.
  if (origin === "runtime") {
    if (conversation.runtimeEvent === undefined)
      throw new Error("conversation_runtime_event_unavailable");
    accepted = conversation.runtimeEvent.parse(event);
  }
  const ownedContext = decodeRuntimeContext(conversation, context);
  const evaluated = evaluate({ origin, event: accepted }, ownedContext);
  // The evaluated context is the Conversation's own typed output; the next decode of it is the
  // stored-context decode when Runtime hands it back.
  const retainedContext =
    typeof evaluated === "object" && evaluated !== null && evaluated.context !== undefined
      ? evaluated.context
      : ownedContext;
  const contextFields = retainedContext === undefined ? {} : { context: retainedContext };
  const target = typeof evaluated === "object" && evaluated !== null ? evaluated.target : evaluated;
  const diagnostics =
    typeof evaluated === "object" && evaluated !== null ? evaluated.diagnostics : [];
  if (target === null) return { target, terminal: false, diagnostics, ...contextFields };
  requireConversationState(conversation, target);
  return {
    target,
    terminal: conversation.terminalStates.includes(target),
    diagnostics,
    ...contextFields,
  };
}
