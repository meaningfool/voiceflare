import type {
  AcceptedConversation,
  ConversationCallbackJson,
  ConversationMetadata,
  ConversationTransitionDecision,
} from "../../conversationContracts.ts";
import { requireConversationState } from "../../conversationContracts.ts";
import { consumeStateReport, createReportingAuthority, issueStateReporter } from "./reporting.ts";
import {
  acceptConversation,
  decideConversationTransition,
  describeConversation,
} from "./definition.ts";
import {
  implementExecutionHandlers,
  type RuntimeImplementationDefinition,
} from "./implementation.ts";
import type { ExecutionIdentity, SemanticReport } from "../../executionContracts.ts";
import type {
  NativeNodeOwner,
  NodeDispatchInput,
  ReportingPolicy,
} from "../../implementationContracts.ts";

export type ConversationAdmission = Readonly<{
  implementation: RuntimeImplementation;
  admit(
    report: SemanticReport<unknown> | undefined,
  ): Readonly<{ transition: ConversationTransitionDecision; responseId?: string }> | null;
  reporting: ReportingPolicy;
}>;
/** Runtime's preparation of a selected state's content; the node input is still JSON. */
export type RuntimeNodePreparation = Readonly<{
  runId: string;
  state: string;
  nodeInput?: ConversationCallbackJson | undefined;
}>;
export type RuntimeImplementation = Pick<
  RuntimeImplementationDefinition,
  "id" | "interpretTool" | "finalizedDiagnostics"
> &
  Readonly<{
    conversation: ConversationMetadata;
    /** Decodes a Run's accepted input once for one Runtime entry. */
    accept(input: ConversationCallbackJson): AcceptedConversation;
    /** What the model receives in a state, prepared from that state's selected node input. */
    prepareContent(
      input: RuntimeNodePreparation,
    ): import("../../nodeContentContracts.ts").PreparedConversationNode;
    /**
     * The selected execution's settings for this Run, in its own format, which the registry adds.
     * Start choices it cannot prepare from are refused with `invalid_execution_settings`.
     */
    prepareSettings?(
      input: import("../../nativeContracts.ts").ExecutionSettingsPreparation,
    ): import("../../nativeContracts.ts").PreparedExecutionSettings;
    runtimeTransition(
      state: string,
      event: ConversationCallbackJson,
      context?: ConversationCallbackJson,
    ): ConversationTransitionDecision;
    bindVisit(
      state: string,
      identity: ExecutionIdentity,
      current: (issued: ExecutionIdentity) => boolean,
      context?: ConversationCallbackJson,
    ): ConversationAdmission;
  }>;

/** The selected definition and live report authority never leave this owner. */
const dispatchers = new WeakMap<
  ConversationAdmission,
  (input: Omit<NodeDispatchInput, "reporter">, native: NativeNodeOwner) => void
>();

/** The selected pair's native session receives the dispatch its handler is typed for. */
export function dispatchReportedNode(
  admission: ConversationAdmission,
  input: Omit<NodeDispatchInput, "reporter">,
  native: NativeNodeOwner,
): void {
  const dispatch = dispatchers.get(admission);
  if (dispatch === undefined) throw new Error("conversation_admission_unavailable");
  dispatch(input, native);
}

/**
 * Registration erases a pair's typed definition here and nowhere else. A typed handler
 * receives only the node input the Conversation selected for the state it is bound to.
 */
export function admitImplementation(
  erased: RuntimeImplementationDefinition,
): RuntimeImplementation {
  const source = erased.conversation;
  const handlers = implementExecutionHandlers(source.states, erased.executionHandlers);
  const conversation = describeConversation(source);
  // The node input is the Conversation's own selection for this state: selected at startup, or
  // retained in the snapshot that reconstruction compared with a fresh selection. Preparation
  // is a Runtime→execution handoff, so it receives one detached copy.
  const detachNodeInput = (state: string, nodeInput: ConversationCallbackJson | undefined) => {
    if (requireConversationState(source, state) === null || nodeInput === undefined)
      throw new Error("conversation_node_input_unavailable");
    return structuredClone(nodeInput);
  };
  let operations: Pick<
    RuntimeImplementation,
    "id" | "interpretTool" | "prepareContent" | "finalizedDiagnostics"
  > = {
    id: erased.id,
    interpretTool: erased.interpretTool,
    prepareContent: (input) =>
      erased.prepare({
        runId: input.runId,
        state: input.state,
        nodeInput: detachNodeInput(input.state, input.nodeInput),
      }),
  };
  if (erased.finalizedDiagnostics !== undefined)
    operations = { ...operations, finalizedDiagnostics: erased.finalizedDiagnostics };
  const implementation: RuntimeImplementation = Object.freeze({
    ...operations,
    conversation,
    accept: (input) => acceptConversation(source, input),
    runtimeTransition: (state, event, context) =>
      decideConversationTransition(source, state, event, "runtime", context),
    bindVisit(state, identity, current, context) {
      const contract = requireConversationState(source, state);
      const authority = createReportingAuthority();
      const issue: import("../../executionContracts.ts").ReporterFactory = (requested) => {
        if (contract === null || !Object.is(requested, contract))
          throw new Error("conversation_report_contract_unavailable");
        return issueStateReporter(requested, identity, current, authority);
      };
      const bound = contract === null ? null : handlers[state]?.bind(issue);
      if (contract !== null && bound === undefined)
        throw new Error("execution_handler_unavailable");
      const admission: ConversationAdmission = Object.freeze({
        implementation:
          bound == null
            ? implementation
            : Object.freeze({ ...implementation, interpretTool: bound.interpretTool }),
        reporting: bound?.reporting ?? { kind: "native" },
        admit(report) {
          if (contract === null) return null;
          const event = consumeStateReport(report, contract, authority);
          if (event === null) return null;
          const responseId =
            typeof event === "object" &&
            event !== null &&
            "responseId" in event &&
            typeof event.responseId === "string"
              ? event.responseId
              : undefined;
          const transition = decideConversationTransition(
            source,
            state,
            event,
            "execution",
            context,
          );
          return responseId === undefined ? { transition } : { transition, responseId };
        },
      });
      const handler = handlers[state];
      if (bound !== null && bound !== undefined && bound.reporting.kind !== handler?.policy)
        throw new Error("execution_handler_policy_invalid");
      dispatchers.set(admission, (input, native) => {
        // The typed handler receives only the node input of the state it is bound to.
        if (contract === null || input.state !== state)
          throw new Error("conversation_node_execution_invalid");
        if (handler?.enter == null) throw new Error("conversation_node_execution_unavailable");
        handler.enter({ ...input, reporter: issue(contract) }, native);
      });
      return admission;
    },
  });
  return implementation;
}
