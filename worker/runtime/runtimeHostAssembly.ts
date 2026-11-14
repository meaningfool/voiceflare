import { Cause, type Effect, Exit, type Fiber, type Scope } from "effect";
import type { RuntimeImplementation, NodeDispatchInput } from "./implementationContracts.ts";
import type { InputClosureSettlement } from "./interviewFinalizationModel.ts";
import type { SelectedConnectionSetup } from "./conversationConnection.ts";
import type { ConversationSelection } from "../shared/contracts/conversationSelection.ts";
import type { UsageDeclaration } from "../shared/contracts/runtimeTerminalResult.ts";
import type {
  ExecutionCredentials,
  ExecutionSettingsSummary,
  PreparedExecutionSettings,
  ProviderSessionStorage,
  ProviderSessionEvents,
  ProviderSessionBackgroundWork,
  ProviderSessionApplicationSink,
  SessionReleaseAnswer,
  EndingOperation,
  EndingOperationDispatch,
  ProviderObservationOrder,
  ProviderReceiptPrefix,
  SessionStartInput,
  SessionStartResult,
} from "./nativeContracts.ts";
/**
 * The host's Effect execution bridge. It runs on the host runtime's services.
 * Operations cross it only with `E = never`: each caller handles its declared
 * failures before crossing, so a rejection or a failed Exit carries a defect or
 * interruption only.
 *
 * The selected Run's native execution owner holds one Scope for its native
 * resources. Each entry holds the owner; once the Run is retired, the owner closes
 * after the outermost entry returns. That release interrupts remaining native work
 * without reporting it as a failure. Closing the host's Scope closes the owner.
 */
export type ExecutionBridge = Readonly<{
  run<A>(operation: Effect.Effect<A, never>): Promise<A>;
  runExit<A>(operation: Effect.Effect<A, never>): Promise<Exit.Exit<A, never>>;
  /**
   * Holds one entry for an operation that runs on the host's own runtime. Native
   * release waits for the outermost entry, and a failed entry is reported as a
   * failed bridged operation is.
   */
  enter<A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  /**
   * Starts a native operation now, as a fiber in the owner's Scope, which owns it until
   * the owner closes. The owner observes its Exit. Without an available owner (no
   * selection, or a retired or closed Run) nothing starts: the fiber is already
   * interrupted.
   */
  supervise<A>(operation: Effect.Effect<A, never>): Fiber.Fiber<A, never>;
}>;
/**
 * The selected execution's native session. Runtime starts it, hands it the browser's media
 * attachment and releases it; how each step maps to native work, such as a provider call,
 * its side connection and its hangup, belongs to the selected execution's adapter.
 * Ending dispatches its operations through this session.
 */
export type RuntimeProviderSession = Readonly<{
  /** The selected execution's summary of its prepared settings, kept for diagnostics. */
  summarizeSettings(settings: PreparedExecutionSettings): ExecutionSettingsSummary;
  connected: boolean;
  connecting: boolean;
  feasible: boolean;
  trySendOpening(): Promise<void>;
  /**
   * Dispatches the native start when called, so a caller's durable claim and that dispatch
   * stay one synchronous step. The returned Effect awaits its result.
   */
  start(input: SessionStartInput): Effect.Effect<SessionStartResult>;
  /**
   * Hands the browser's media attachment request to the session. A session whose browser
   * attaches through its connection reply refuses it.
   */
  attachBrowser(request: Request): Promise<Response>;
  ensureConnected(sessionId: string): void;
  reconcileLifetime(): void;
  sendFinalizationOperation(operation: EndingOperation): EndingOperationDispatch;
  /**
   * How the execution would settle an input closure it cannot carry out now, as when its
   * session is not connected: Runtime keeps it with the step's failure.
   */
  describeInputClosure?(
    operation: Extract<EndingOperation, { kind: "close_input" }>,
  ): InputClosureSettlement | undefined;
  /**
   * Releases the session's native resources, bounded by `timeoutCapMs` when given, and answers
   * whether the session is closed or its closure is not confirmed.
   */
  release(sessionId: string | null, timeoutCapMs?: number): Promise<SessionReleaseAnswer>;
  closeBarrier(accepted: ProviderObservationOrder | null): ProviderObservationOrder | null;
  sampleReceiptPrefix(): ProviderReceiptPrefix;
  drain(): Promise<void>;
  enterNode?(
    input: Omit<NodeDispatchInput, "reporter">,
    admission: import("./conversationAdmission.ts").ConversationAdmission,
  ): void;
  containNode?(): void;
}>;
/**
 * The selected execution's session as Runtime holds it: Runtime awaits its release and its drain
 * as Effects. `release` dispatches the hangup when called; the returned Effect awaits its result.
 */
export type SelectedProviderSession = Omit<RuntimeProviderSession, "release" | "drain"> &
  Readonly<{
    release(sessionId: string | null, timeoutCapMs?: number): Effect.Effect<SessionReleaseAnswer>;
    drain(): Effect.Effect<void>;
  }>;
export type RuntimeProviderSessionInput = Readonly<{
  /** Runtime's credentials, by name; each provider of the selected execution takes its own. */
  credentials: ExecutionCredentials;
  /**
   * The connection profile of the Run's start. It names the execution that started a call
   * before any Conversation is admitted, which releases that call after a failed start.
   */
  connectionProfile: () => string;
  hangupTimeoutSetting?: string | undefined;
  storage: ProviderSessionStorage;
  events: ProviderSessionEvents;
  backgroundWork: ProviderSessionBackgroundWork;
  sink: ProviderSessionApplicationSink;
  execution: Pick<ExecutionBridge, "run" | "supervise">;
  issueSink?: (runId: string, generation: number) => ProviderSessionApplicationSink;
}>;
/**
 * Resolves every Conversation/execution pair from a Run's accepted selection.
 * There is no default pair: each path that needs an implementation names its selection.
 */
export type RuntimeHostAssembly = Readonly<{
  /** The credentials Runtime reads from its environment: those its executions' providers declare. */
  credentialNames: readonly string[];
  resolve(selection: ConversationSelection): RuntimeImplementation;
  validateSelection(selection: ConversationSelection): void;
  /**
   * The credentials the selected combination needs and the set lacks, none when it can start:
   * Runtime asks this before any provider work. With a Run's prepared settings, these are the
   * credentials of the providers those settings choose; without, those its catalog availability
   * names.
   */
  missingCredentials(
    selection: ConversationSelection,
    credentials: ExecutionCredentials,
    settings?: PreparedExecutionSettings,
  ): readonly string[];
  /**
   * The setup of a connection profile that the selection declares. A profile the selection
   * does not declare is unavailable, before any native work.
   */
  connectionSetup(selection: ConversationSelection, profile: string): SelectedConnectionSetup;
  validateState(selection: ConversationSelection, state: string): void;
  /**
   * The usage entries the selection's providers declare, which Runtime publishes; none for a
   * selection outside the registry.
   */
  declaredUsage(selection: ConversationSelection): readonly UsageDeclaration[];
  /**
   * The result warnings the selection's execution declares, which Runtime publishes when it
   * attaches them; none for a selection outside the registry.
   */
  declaredWarnings(selection: ConversationSelection): readonly string[];
  validateInput(
    selection: ConversationSelection,
    input: import("../shared/contracts/runtimeStart.ts").InterviewExecution["agentInput"],
  ): void;
  /** Acquires the bridge in the caller's Scope, on the caller's runtime services. */
  createExecution(input: RuntimeExecutionInput): Effect.Effect<ExecutionBridge, never, Scope.Scope>;
  createSession(
    input: RuntimeProviderSessionInput,
    selection: () => ConversationSelection | null,
  ): SelectedProviderSession;
}>;
export type RuntimeExecutionInput = Readonly<{
  /** Receives each native work's failure or defect; work stopped by interruption only did not fail. */
  failure: (cause: Cause.Cause<unknown>) => void;
  selection: () => ConversationSelection | null;
  retired?: () => boolean;
  retainRelease?: (task: Promise<unknown>) => void;
}>;

/** The host's retention of a detached owner. It rejects only when the owner fails. */
export function retainOwner<Value>(owner: Fiber.Fiber<Value>): Promise<void> {
  return new Promise((resolve, reject) => {
    owner.addObserver((exit) =>
      Exit.isFailure(exit) ? reject(Cause.squash(exit.cause)) : resolve(),
    );
  });
}
