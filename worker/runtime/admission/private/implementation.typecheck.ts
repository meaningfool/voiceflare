import { implementExecutionHandlers } from "./implementation.ts";

function checkExecutionHandlerPolicies(
  nativeHandler: Extract<
    import("./implementation.ts").RuntimeExecutionHandler,
    { policy: "native" }
  >,
  retainedHandler: Extract<
    import("./implementation.ts").RuntimeExecutionHandler,
    { policy: "retained_output" }
  >,
  enter: (input: import("../../implementationContracts.ts").NodeDispatchInput) => void,
): void {
  type Handler = import("./implementation.ts").RuntimeExecutionHandler;
  // @ts-expect-error Native execution requires a callable entry before composition.
  const nativeWithoutEntry: Handler = { ...nativeHandler, enter: null };
  // @ts-expect-error Retained output cannot start a new native execution.
  const retainedWithEntry: Handler = { ...retainedHandler, enter };
  void nativeWithoutEntry;
  void retainedWithEntry;
}
void checkExecutionHandlerPolicies;

type GoodbyeStates =
  typeof import("../../../conversations/goodbyeInterview.ts").goodbyeInterviewStates;
type QuestionsStates =
  typeof import("../../../conversations/questionsInterview.ts").questionsInterviewStates;
type Dispatch<
  S extends import("../../conversationContracts.ts").ConversationStates,
  State extends Extract<keyof S, string>,
> = import("../../implementationContracts.ts").ConversationNodeDispatch<S, State>;

function checkTypedNodeDispatch(
  goodbye: Dispatch<GoodbyeStates, "goodbye">,
  question: Dispatch<QuestionsStates, "question">,
  goodbyeNodes: import("../../implementationContracts.ts").NativeNodeEntry<GoodbyeStates>,
): void {
  goodbye.reporter.report({ kind: "goodbye_completed", responseId: "response" });
  // @ts-expect-error A Goodbye handler cannot report a Question event.
  goodbye.reporter.report({ kind: "next_question", responseId: "response", toolCallId: "call" });
  void goodbye.input.closingSentence;
  // @ts-expect-error A Goodbye handler cannot read the Question state's input.
  void goodbye.input.toolDescriptions;
  void question.input.toolDescriptions.next_question;
  goodbyeNodes.enterNode(goodbye);
  // @ts-expect-error A pair's native entry accepts only its own Conversation's dispatches.
  goodbyeNodes.enterNode(question);
}
void checkTypedNodeDispatch;

function checkHandlerRegistration(
  states: GoodbyeStates,
  nodes: import("../../implementationContracts.ts").NativeNodeEntry<GoodbyeStates>,
  bind: (
    issue: import("./reporting.ts").ReporterFactory,
  ) => import("./implementation.ts").BoundRuntimeImplementation<"native">,
): void {
  implementExecutionHandlers(states, {
    interviewing: {
      contract: states.interviewing,
      policy: "native",
      enter: (input, native: typeof nodes) => native.enterNode(input),
      bind,
    },
    goodbye: {
      contract: states.goodbye,
      policy: "native",
      enter: (input, native: typeof nodes) => native.enterNode(input),
      bind,
    },
  });
  implementExecutionHandlers(states, {
    interviewing: {
      contract: states.interviewing,
      policy: "native",
      enter: (input, native: typeof nodes) => native.enterNode(input),
      bind,
    },
    goodbye: {
      contract: states.goodbye,
      policy: "native",
      // @ts-expect-error A handler typed for another state's dispatch cannot be registered.
      enter: (input: Dispatch<GoodbyeStates, "interviewing">) => input.input.toolDescriptions,
      bind,
    },
  });
  implementExecutionHandlers(states, {
    interviewing: {
      // @ts-expect-error A handler must carry the contract of the state it serves.
      contract: states.goodbye,
      policy: "native",
      enter: (input, native: typeof nodes) => native.enterNode(input),
      bind,
    },
    goodbye: {
      contract: states.goodbye,
      policy: "native",
      enter: (input, native: typeof nodes) => native.enterNode(input),
      bind,
    },
  });
}
void checkHandlerRegistration;
