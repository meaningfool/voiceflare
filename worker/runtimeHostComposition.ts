import {
  admitImplementation,
  dispatchReportedNode,
} from "./runtime/admission/private/composition.ts";
import type { RuntimeImplementationDefinition } from "./runtime/admission/private/implementation.ts";
import { Cause, Context, Data, Duration, Effect, Exit, Fiber, RcRef, Scope } from "effect";
import {
  originalInterviewConversation,
  originalInterviewIdentity,
} from "./conversations/originalInterview.ts";
import {
  goodbyeInterviewConversation,
  goodbyeInterviewIdentity,
} from "./conversations/goodbyeInterview.ts";
import {
  nextQuestionTool,
  questionsInterviewConversation,
  questionsInterviewIdentity,
} from "./conversations/questionsInterview.ts";
import type { GateSessionOptions, GateTestOptions } from "./runtime/gateTestOptions.ts";
import {
  originalRealtimeImplementation,
  originalRealtimeSessionConfiguration,
} from "./implementations/originalRealtime/index.ts";
import {
  goodbyeRealtimeImplementation,
  goodbyeRealtimeSessionConfiguration,
} from "./implementations/goodbyeRealtime/index.ts";
import {
  questionsRealtimeImplementation,
  questionsRealtimeSessionConfiguration,
} from "./implementations/questionsRealtime/index.ts";
import {
  cascadeOriginalImplementation,
  cascadeOriginalSessionConfiguration,
} from "./implementations/originalCascade/index.ts";
import {
  cascadeGoodbyeImplementation,
  cascadeGoodbyeSessionConfiguration,
} from "./implementations/goodbyeCascade/index.ts";
import {
  cascadeQuestionsImplementation,
  cascadeQuestionsSessionConfiguration,
} from "./implementations/questionsCascade/index.ts";
import {
  openAiRealtimeDriver,
  type RealtimeDriverLayer,
} from "./providers/openaiRealtime/openaiRealtimeDriver.ts";
import { hangUpExactProviderCall } from "./providers/openaiRealtime/callHangup.ts";
import { createRealtimeRuntimeSession } from "./providers/openaiRealtime/runtimeSession.ts";
import { realtimeApiKey, realtimeCredentials } from "./providers/openaiRealtime/credentials.ts";
import type { RealtimeSessionConfiguration } from "./providers/openaiRealtime/session.ts";
import { realtimeConnectionSetup } from "./providers/openaiRealtime/connection.ts";
import {
  decodeRealtimeSessionSettings,
  prepareRealtimeSettings,
  summarizePreparedModelSession,
} from "./providers/openaiRealtime/preparedModelSession.ts";
import { realtimeUsageDeclarations } from "./providers/openaiRealtime/usage.ts";
import { realtimeResultWarnings } from "./providers/openaiRealtime/warnings.ts";
import { cascadeResultWarnings } from "./providers/cascade/warnings.ts";
import { cascadeMediaConnectionSetup } from "./providers/cascade/connection.ts";
import type { CascadeProviders } from "./providers/cascade/adapters.ts";
import {
  cascadeDeclaredCredentials,
  cascadeProviderAdapters,
  cascadeProviderCredentials,
  cascadeProviderUsage,
  cascadeRunCredentials,
} from "./providers/cascade/providers.ts";
import {
  cascadeCombination,
  decodeCascadeSessionSettings,
  prepareCascadeSettings,
  summarizeCascadeSettings,
} from "./providers/cascade/preparedSession.ts";
import {
  CascadeRuntimeSession,
  releaseCascadeCall,
  type CascadeSessionConfiguration,
  type CascadeSessionInput,
} from "./providers/cascade/runtimeSession.ts";
import type {
  RuntimeHostAssembly,
  RuntimeProviderSession,
  RuntimeProviderSessionInput,
  ExecutionBridge,
} from "./runtime/runtimeHostAssembly.ts";
import {
  missingCredentials,
  type ExecutionCredentials,
  type ExecutionSettingsPreparation,
  type ExecutionSettingsSummary,
  type PreparedExecutionSettings,
  type SessionReleaseAnswer,
} from "./runtime/nativeContracts.ts";
import { NativeWorkOwner } from "./runtime/nativeWorkOwner.ts";
import type {
  ConnectionSetup,
  RuntimeConnectionExchange,
} from "./shared/contracts/runtimeConnection.ts";
import {
  missingCredentialsRefusal,
  type CombinationAvailability,
  type ConversationSelection,
  type ConversationCatalog,
} from "./shared/contracts/conversationSelection.ts";
import type { UsageDeclaration } from "./shared/contracts/runtimeTerminalResult.ts";
import type { InterviewExecution } from "./shared/contracts/runtimeStart.ts";
import {
  requireConversationState,
  validateConversationDefinition,
  type ConversationStates,
} from "./runtime/conversationContracts.ts";
import type { NativeNodeOwner, RuntimeImplementation } from "./runtime/implementationContracts.ts";
import type { ConversationDefinition } from "./runtime/admission/private/definition.ts";

/**
 * A Conversation as the registry knows it: its identity, its name, the input format it
 * accepts and its definition, whose input decoder is its input check.
 */
type RegisteredConversation<Definition extends ConversationDefinition = ConversationDefinition> =
  Readonly<{
    id: string;
    version: number;
    name: string;
    inputContract: string;
    definition: Definition;
  }>;

/**
 * The session value a pair gives each execution, typed by its Conversation's states: its
 * configuration of that execution's kit session. Another Conversation's value fails compilation.
 */
type PairSessionValues<S extends ConversationStates> = Readonly<{
  realtime: RealtimeSessionConfiguration<S>;
  cascade: CascadeSessionConfiguration<S>;
}>;
type ExecutionId = keyof PairSessionValues<ConversationStates>;

/**
 * An execution as the registry knows it: its identity, its name, the connection setups of the
 * profiles it accepts, the credentials its providers need and the usage they declare, its
 * settings, prepared in its own format and summarized for diagnostics, and how a pair's session
 * is created from the pair's own session value, such as its configuration of the kit's session.
 */
type RegisteredExecution<Id extends ExecutionId = ExecutionId> = Readonly<{
  id: Id;
  version: number;
  name: string;
  connections: readonly ConnectionSetup[];
  /**
   * The credentials its providers need without settings, as each provider declares them: those
   * its combinations' availability names.
   */
  credentials: readonly string[];
  /** Every credential a provider it may run on declares: those Runtime reads for it. */
  declaredCredentials: readonly string[];
  /** The credentials a Run with these prepared settings needs, for the providers they choose. */
  runCredentials(settings: PreparedExecutionSettings): readonly string[];
  /** Whether a Runtime configuration gives it stand-ins for its providers, which need none. */
  hasStandIns(configuration: RuntimeHostConfiguration): boolean;
  /** The usage entries its providers report; Runtime publishes no other. */
  usage: readonly UsageDeclaration[];
  /**
   * The result warnings it attaches with its `result_warning` fact, declared next to its code;
   * Runtime publishes no other from it. Runtime's own warnings are `runtimeWarnings`.
   */
  warnings: readonly string[];
  /** Prepares a Run's settings for a Conversation; refuses choices it cannot prepare from. */
  prepareSettings(
    choices: ExecutionSettingsPreparation,
    conversation: string,
  ): PreparedExecutionSettings;
  summarizeSettings(settings: PreparedExecutionSettings): ExecutionSettingsSummary;
  createSession<S extends ConversationStates>(
    pairSession: PairSessionValues<S>[Id],
    input: RuntimeProviderSessionInput,
    configuration: RuntimeHostConfiguration,
  ): PairProviderSession;
  /**
   * Releases a call it started, by the call's identity alone: the cleanup of a failed start
   * whose Run admitted no Conversation, so no pair's session holds the call.
   */
  releaseCall(
    sessionId: string | null,
    timeoutCapMs: number | undefined,
    input: RuntimeProviderSessionInput,
    configuration: RuntimeHostConfiguration,
  ): Promise<SessionReleaseAnswer>;
}>;

/**
 * The credentials an execution needs under a Runtime configuration, none on stand-ins: a Run's,
 * for the providers its prepared settings choose, or without settings those its availability
 * names.
 */
function requiredCredentials(
  execution: Pick<RegisteredExecution, "credentials" | "runCredentials" | "hasStandIns">,
  configuration: RuntimeHostConfiguration,
  settings?: PreparedExecutionSettings,
): readonly string[] {
  if (execution.hasStandIns(configuration)) return [];
  return settings === undefined ? execution.credentials : execution.runCredentials(settings);
}

/** The Conversations, each stated once. */
const conversations = Object.freeze({
  original: {
    ...originalInterviewIdentity,
    name: "Original interview",
    inputContract: "original-interview-input/v1",
    definition: originalInterviewConversation,
  },
  goodbye: {
    ...goodbyeInterviewIdentity,
    name: "Dedicated Goodbye",
    inputContract: "goodbye-interview-input/v1",
    definition: goodbyeInterviewConversation,
  },
  questions: {
    ...questionsInterviewIdentity,
    name: "Questions",
    inputContract: "questions-interview-input/v1",
    definition: questionsInterviewConversation,
  },
} satisfies Record<string, RegisteredConversation>);

/** The executions, each stated once. */
const executions = Object.freeze({
  /** Realtime: the kit's session on the configured driver or OpenAI's, configured by the pair. */
  realtime: {
    id: "realtime",
    version: 1,
    name: "Realtime",
    connections: [realtimeConnectionSetup],
    credentials: realtimeCredentials,
    declaredCredentials: realtimeCredentials,
    runCredentials: () => realtimeCredentials,
    // Only a test Runtime configures a driver, the Realtime kit's test version.
    hasStandIns: (configuration) => configuration.realtimeDriver !== undefined,
    usage: realtimeUsageDeclarations,
    warnings: realtimeResultWarnings,
    prepareSettings: (choices) => prepareRealtimeSettings(choices),
    summarizeSettings: (settings) =>
      summarizePreparedModelSession(decodeRealtimeSessionSettings(settings)),
    createSession: (pairConfiguration, input, configuration) => {
      const { credentials, ...capabilities } = input;
      return createRealtimeRuntimeSession(
        {
          ...capabilities,
          apiKey: realtimeApiKey(credentials),
          driver: configuration.realtimeDriver ?? openAiRealtimeDriver(),
          providerFeasible: realtimeAvailable(credentials, configuration),
        },
        pairConfiguration,
      );
    },
    releaseCall: (sessionId, timeoutCapMs, input, configuration) =>
      hangUpExactProviderCall({
        sessionId,
        feasible: realtimeAvailable(input.credentials, configuration),
        apiKey: realtimeApiKey(input.credentials),
        hangupTimeoutSetting: input.hangupTimeoutSetting,
        timeoutCapMs,
        driver: configuration.realtimeDriver ?? openAiRealtimeDriver(),
        run: (operation) => input.execution.run(operation),
      }),
  } satisfies RegisteredExecution<"realtime">,
  /** Cascade: the kit's session on the configured providers, configured by the pair. */
  cascade: {
    id: "cascade",
    version: 1,
    name: "Cascade",
    connections: [cascadeMediaConnectionSetup],
    credentials: cascadeProviderCredentials,
    declaredCredentials: cascadeDeclaredCredentials,
    runCredentials: (settings) =>
      cascadeRunCredentials(decodeCascadeSessionSettings(settings).providers),
    // Only a local or test Runtime configures the controlled stand-ins.
    hasStandIns: (configuration) => configuration.cascadeProviders !== undefined,
    // The stand-ins report in the vocabulary of the providers they stand in for.
    usage: cascadeProviderUsage,
    warnings: cascadeResultWarnings,
    prepareSettings: (choices, conversation) =>
      prepareCascadeSettings(cascadeCombination(conversation), choices),
    summarizeSettings: (settings) =>
      summarizeCascadeSettings(decodeCascadeSessionSettings(settings)),
    createSession: (pairConfiguration, input, configuration) =>
      new CascadeRuntimeSession(cascadeSessionInput(input, configuration), pairConfiguration),
    releaseCall: (sessionId) => Promise.resolve(releaseCascadeCall(sessionId)),
  } satisfies RegisteredExecution<"cascade">,
});

/** Whether the Realtime execution's provider has its credential, or the kit's test driver. */
function realtimeAvailable(
  credentials: ExecutionCredentials,
  configuration: RuntimeHostConfiguration,
): boolean {
  return (
    missingCredentials(requiredCredentials(executions.realtime, configuration), credentials)
      .length === 0
  );
}

/** Every credential a registered execution's providers declare: those Runtime reads. */
const registeredCredentials: readonly string[] = [
  ...new Set(Object.values(executions).flatMap(({ declaredCredentials }) => declaredCredentials)),
];

/** The registered execution that accepts a connection profile. */
function executionOfProfile(profile: string): RegisteredExecution | undefined {
  return Object.values(executions).find(({ connections }) =>
    connections.some((setup) => setup.profile === profile),
  );
}

/** A selected pair's native provider session, before Runtime adds its summary and node admission. */
type PairProviderSession = Omit<RuntimeProviderSession, "summarizeSettings" | "enterNode"> &
  Partial<NativeNodeOwner>;
/** The pair's implementation, with its execution's settings preparation for its Conversation. */
type PairImplementation = RuntimeImplementation &
  Required<Pick<RuntimeImplementation, "prepareSettings">>;
/**
 * One registered combination, derived from its row; a missing member fails compilation. The
 * entry's session obtains its own native driver, and its connection setups declare the
 * profiles it accepts.
 */
type RegistryEntry = Readonly<{
  catalog: Omit<
    ConversationCatalog["selections"][number],
    "connectionProfiles" | "usage" | "warnings" | "availability"
  >;
  conversation: RegisteredConversation;
  connections: readonly ConnectionSetup[];
  usage: readonly UsageDeclaration[];
  /** The result warnings its execution may attach. */
  warnings: readonly string[];
  /**
   * The credentials its execution's providers need under a Runtime configuration: a Run's, for
   * the providers its prepared settings choose, or without settings those its availability names.
   */
  credentials(
    configuration: RuntimeHostConfiguration,
    settings?: PreparedExecutionSettings,
  ): readonly string[];
  implementation: PairImplementation;
  createSession(
    input: RuntimeProviderSessionInput,
    configuration: RuntimeHostConfiguration,
  ): PairProviderSession;
  summarizeSettings(settings: PreparedExecutionSettings): ExecutionSettingsSummary;
}>;

function selectionOf(
  conversation: RegisteredConversation,
  execution: Pick<RegisteredExecution, "id" | "version">,
): ConversationSelection {
  return Object.freeze({
    conversation: Object.freeze({
      id: conversation.id,
      version: conversation.version,
    }),
    execution: Object.freeze({ id: execution.id, version: execution.version }),
  });
}

/** Every combination is at its first version; one that changes on its own states its version. */
const combinationVersion = 1;

/**
 * One combination: a Conversation, an execution and its pair, which is the pair's
 * implementation definition of that Conversation and its session value for that execution.
 */
function combination<
  Definition extends ConversationDefinition,
  Native extends NativeNodeOwner,
  Id extends ExecutionId,
>(
  row: Readonly<{
    conversation: RegisteredConversation<Definition>;
    execution: RegisteredExecution<Id>;
    implementation: RuntimeImplementationDefinition<Definition, Native>;
    session: NoInfer<PairSessionValues<Definition["states"]>[Id]>;
  }>,
): RegistryEntry {
  const { conversation, execution, session } = row;
  if (row.implementation.conversation !== conversation.definition)
    throw new Error("conversation_definition_mismatch");
  const implementation = admitImplementation(row.implementation);
  return Object.freeze({
    catalog: {
      id: `${conversation.id}-${execution.id}`,
      version: combinationVersion,
      name: `${conversation.name} · ${execution.name}`,
      selection: selectionOf(conversation, execution),
      inputContract: conversation.inputContract,
    },
    conversation,
    connections: execution.connections,
    usage: execution.usage,
    warnings: execution.warnings,
    credentials: (configuration, settings) =>
      requiredCredentials(execution, configuration, settings),
    implementation: Object.freeze({
      ...implementation,
      prepareSettings: (choices: ExecutionSettingsPreparation) =>
        execution.prepareSettings(choices, conversation.id),
    }),
    createSession: (input, configuration) =>
      execution.createSession(
        gateSession(session, conversation, configuration.gateTestOptions),
        input,
        configuration,
      ),
    summarizeSettings: (settings) => execution.summarizeSettings(settings),
  });
}

/**
 * A pair's session value under the Gate test options of a local Runtime: the options it applies
 * to that pair, and none without them. The supplied `next_question` applies to Questions only.
 */
function gateSession<Session extends Readonly<{ gate?: GateSessionOptions }>>(
  session: Session,
  conversation: RegisteredConversation,
  options: GateTestOptions | undefined,
): Session {
  if (options === undefined) return session;
  const supplied =
    options.suppliedNextQuestion && conversation.id === questionsInterviewIdentity.id;
  return {
    ...session,
    gate: {
      noTools: options.noTools,
      suppliedReply: supplied ? { toolName: nextQuestionTool.name } : null,
    },
  };
}

/**
 * The combinations, in catalog order. Only complete, explicitly delivered pairs are
 * discoverable. This assembly acquires nothing.
 */
const registry: readonly RegistryEntry[] = [
  combination({
    conversation: conversations.original,
    execution: executions.realtime,
    implementation: originalRealtimeImplementation,
    session: originalRealtimeSessionConfiguration,
  }),
  combination({
    conversation: conversations.goodbye,
    execution: executions.realtime,
    implementation: goodbyeRealtimeImplementation,
    session: goodbyeRealtimeSessionConfiguration,
  }),
  combination({
    conversation: conversations.questions,
    execution: executions.realtime,
    implementation: questionsRealtimeImplementation,
    session: questionsRealtimeSessionConfiguration,
  }),
  combination({
    conversation: conversations.original,
    execution: executions.cascade,
    implementation: cascadeOriginalImplementation,
    session: cascadeOriginalSessionConfiguration,
  }),
  combination({
    conversation: conversations.goodbye,
    execution: executions.cascade,
    implementation: cascadeGoodbyeImplementation,
    session: cascadeGoodbyeSessionConfiguration,
  }),
  combination({
    conversation: conversations.questions,
    execution: executions.cascade,
    implementation: cascadeQuestionsImplementation,
    session: cascadeQuestionsSessionConfiguration,
  }),
];

/** Original interview on the Cascade execution, offered beside the Realtime selections. */
export const originalCascadeSelection = selectionOf(conversations.original, executions.cascade);
/** Dedicated Goodbye on the Cascade execution, offered beside the Realtime selections. */
export const goodbyeCascadeSelection = selectionOf(conversations.goodbye, executions.cascade);
/** Questions on the Cascade execution, offered beside the Realtime selections. */
export const questionsCascadeSelection = selectionOf(conversations.questions, executions.cascade);
export const questionsRealtimeSelection = selectionOf(conversations.questions, executions.realtime);
export const goodbyeRealtimeSelection = selectionOf(conversations.goodbye, executions.realtime);

/** A Cascade pair's session input: Runtime's session capabilities and the Cascade providers. */
function cascadeSessionInput(
  input: RuntimeProviderSessionInput,
  configuration: RuntimeHostConfiguration,
): CascadeSessionInput {
  return {
    // A local or test Runtime's configured providers, otherwise the real adapters.
    providers: configuration.cascadeProviders ?? cascadeProviderAdapters(input.credentials),
    storage: input.storage,
    events: input.events,
    backgroundWork: input.backgroundWork,
    sink: input.sink,
    execution: input.execution,
    issueSink: input.issueSink,
  };
}
/**
 * Runtime configuration of the registry. Every registered selection is offered; only the
 * Cascade providers and the Gate test options vary, which a local Runtime sets with its build
 * options and a test through its own assembly.
 */
export type RuntimeHostConfiguration = Readonly<{
  /**
   * The Realtime driver, as a service. Only a test Runtime configures it, with the Realtime
   * kit's test version (`realtimeTestDriver`), which needs no credential; without it a Realtime
   * session uses OpenAI's, which needs the credentials the Realtime kit declares.
   */
  realtimeDriver?: RealtimeDriverLayer | undefined;
  /**
   * The Cascade providers. Only a local or test Runtime configures them, with the controlled
   * stand-ins, which need no credential; Start never chooses them. Without them a Cascade
   * session uses the real adapters, which need the credentials each of them declares.
   */
  cascadeProviders?: CascadeProviders | undefined;
  /**
   * The voice Gate's test options. Only a local Runtime's build constants select them; a test
   * may pass them to its own assembly. Without them no session applies any.
   */
  gateTestOptions?: GateTestOptions | undefined;
}>;
/** No native owner is available: no registered selection, or the Run was retired or its host closed. */
class NativeOwnerUnavailable extends Data.TaggedError("NativeOwnerUnavailable") {}
function findEntry(selection: ConversationSelection) {
  return registry.find(
    ({ catalog }) =>
      catalog.selection.conversation.id === selection.conversation.id &&
      catalog.selection.conversation.version === selection.conversation.version &&
      catalog.selection.execution.id === selection.execution.id &&
      catalog.selection.execution.version === selection.execution.version,
  );
}
function resolveEntry(selection: ConversationSelection): RegistryEntry {
  const entry = findEntry(selection);
  if (entry === undefined) throw new Error("conversation_selection_unavailable");
  validateConversationDefinition(entry.implementation.conversation);
  return entry;
}
/** Whether a combination can start with Runtime's credentials under its configuration. */
function availabilityOf(
  entry: RegistryEntry,
  credentials: ExecutionCredentials,
  configuration: RuntimeHostConfiguration,
): CombinationAvailability {
  const required = entry.credentials(configuration);
  return {
    credentials: [...required],
    missingCredentials: [...missingCredentials(required, credentials)],
  };
}
/**
 * The registered combinations, each with whether it can start on a Runtime with these credentials
 * and this configuration.
 */
export function conversationCatalog(
  credentials: ExecutionCredentials,
  configuration: RuntimeHostConfiguration = {},
): ConversationCatalog {
  return structuredClone({
    selections: registry.map((entry) => {
      const {
        catalog: { inputContract, ...catalog },
        connections,
        usage,
        warnings,
      } = entry;
      return {
        ...catalog,
        connectionProfiles: connections.map(({ profile }) => profile),
        inputContract,
        usage: [...usage],
        warnings: [...warnings],
        availability: availabilityOf(entry, credentials, configuration),
      };
    }),
  });
}
/**
 * The selection's setup for a connection profile, whose validation Runtime awaits as an Effect;
 * a profile it does not declare is unavailable.
 */
function selectedConnectionSetup(
  selection: ConversationSelection,
  profile: string,
): ReturnType<RuntimeHostAssembly["connectionSetup"]> {
  const setup = resolveEntry(selection).connections.find(
    (candidate) => candidate.profile === profile,
  );
  if (setup === undefined) throw new Error("connection_profile_unavailable");
  return {
    profile: setup.profile,
    validate: (input) => Effect.promise(() => setup.validate(input)),
  };
}
/**
 * Validates a connection before any Run selects a pair, with a registered setup of its profile.
 * The execution that accepts the profile must be able to start: one that lacks credentials is
 * refused with `missingCredentialsRefusal`, before the validation.
 */
export async function validateRegisteredConnection(
  profile: string,
  connection: RuntimeConnectionExchange,
  credentials: ExecutionCredentials,
  configuration: RuntimeHostConfiguration = {},
): Promise<Readonly<{ profile: string; fingerprint: string }>> {
  const execution = executionOfProfile(profile);
  const setup = execution?.connections.find((candidate) => candidate.profile === profile);
  if (execution === undefined || setup === undefined)
    throw new Error("connection_profile_unavailable");
  const missing = missingCredentials(requiredCredentials(execution, configuration), credentials);
  if (missing.length > 0) throw new Error(missingCredentialsRefusal(missing));
  return { profile, ...(await setup.validate(connection.input)) };
}
function validateSelectedConversation(
  selection: ConversationSelection,
  input: InterviewExecution["agentInput"],
): void {
  const entry = resolveEntry(selection);
  try {
    entry.conversation.definition.input(input);
  } catch {
    // Input that the selected Conversation contract rejects is a malformed start request.
    throw new Error("invalid_conversation_input");
  }
}

/**
 * Cleanup after a failed start whose Run admitted no Conversation: the execution of the start's
 * connection profile releases the call it started.
 */
function releaseUnadmittedCall(
  sessionId: string | null,
  timeoutCapMs: number | undefined,
  input: RuntimeProviderSessionInput,
  configuration: RuntimeHostConfiguration,
): Promise<SessionReleaseAnswer> {
  const profile = input.connectionProfile();
  const execution = executionOfProfile(profile);
  if (execution === undefined)
    return Promise.resolve({
      status: "close_unconfirmed",
      failure: { status: "failed", timedOut: false, code: "connection_profile_unavailable" },
    });
  return execution.releaseCall(sessionId, timeoutCapMs, input, configuration);
}

/** The registry's assembly under one Runtime configuration. */
export function createRuntimeHostAssembly(
  configuration: RuntimeHostConfiguration = {},
): RuntimeHostAssembly {
  return {
    credentialNames: registeredCredentials,
    resolve: (selection) => resolveEntry(selection).implementation,
    validateSelection: (selection) => {
      resolveEntry(selection);
    },
    missingCredentials: (selection, credentials, settings) =>
      missingCredentials(resolveEntry(selection).credentials(configuration, settings), credentials),
    connectionSetup: (selection, profile) => selectedConnectionSetup(selection, profile),
    validateState(selection, state) {
      requireConversationState(resolveEntry(selection).implementation.conversation, state);
    },
    validateInput: (selection, input) => validateSelectedConversation(selection, input),
    declaredUsage: (selection) => findEntry(selection)?.usage ?? [],
    declaredWarnings: (selection) => findEntry(selection)?.warnings ?? [],
    createExecution: ({ failure, selection, retired, retainRelease }) =>
      Effect.gen(function* () {
        // The bridge runs on the host runtime's services; its owner gets its own Scope.
        const services = Context.omit(Scope.Scope)(yield* Effect.context<never>());
        // Native work that stops by interruption only stopped normally: a step change interrupts
        // the work of the step it leaves, and releasing a retired Run's owner interrupts what
        // remains. Only a failure or a defect is an execution failure.
        const report = (cause: Cause.Cause<unknown>): void => {
          if (!Cause.hasInterruptsOnly(cause)) failure(cause);
        };
        // Every entry holds the selected owner. A retired Run releases it once the outermost
        // entry has returned, and acquires no new one; closing the host's Scope releases it.
        const owners = yield* RcRef.make({
          acquire: Effect.suspend(() => {
            const current = selection();
            if (current === null || retired?.() === true)
              return Effect.fail(new NativeOwnerUnavailable());
            // A selection outside the registry runs its entries without a native owner.
            if (findEntry(current) === undefined) return Effect.fail(new NativeOwnerUnavailable());
            return Effect.acquireRelease(
              Effect.sync(() => new NativeWorkOwner(report, retainRelease, services)),
              (owner) => owner.close,
            );
          }),
          idleTimeToLive: Duration.infinity,
        });
        const releaseIfRetired = Effect.suspend(() => {
          if (retired?.() !== true) return Effect.void;
          return RcRef.invalidate(owners);
        });
        // The held owner, or null when none is available. A closed host refuses every owner.
        const heldOwner = RcRef.get(owners).pipe(
          Effect.catchTag("NativeOwnerUnavailable", () => Effect.succeed(null)),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.succeed(null) : Effect.failCause(cause),
          ),
        );
        const holding = <A, E, R>(
          use: (owner: NativeWorkOwner | null) => Effect.Effect<A, E, R>,
        ): Effect.Effect<A, E, R> =>
          Effect.acquireUseRelease(
            Scope.make(),
            (scope) =>
              heldOwner.pipe(
                Scope.provide(scope),
                Effect.flatMap((owner) =>
                  owner === null ? use(null) : use(owner).pipe(Effect.ensuring(releaseIfRetired)),
                ),
              ),
            (scope, exit) => Scope.close(scope, exit),
          );
        const runExit = <A>(operation: Effect.Effect<A, never>) =>
          holding((owner) =>
            owner === null
              ? Effect.exit(operation)
              : Effect.flatMap(owner.fork(operation), Fiber.await),
          );
        return {
          async run(operation) {
            const exit = await Effect.runPromiseWith(services)(runExit(operation));
            if (Exit.isSuccess(exit)) return exit.value;
            throw Cause.squash(exit.cause);
          },
          runExit: (operation) => Effect.runPromiseWith(services)(runExit(operation)),
          enter: <A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
            holding<A, E, R>((owner) =>
              owner === null
                ? operation
                : operation.pipe(
                    Effect.onExit((exit) =>
                      Exit.isFailure(exit) ? Effect.sync(() => failure(exit.cause)) : Effect.void,
                    ),
                  ),
            ),
          supervise: (operation) =>
            Effect.runSyncWith(services)(
              Effect.scoped(
                Effect.flatMap(heldOwner, (owner) =>
                  owner === null
                    ? Effect.forkDetach(Effect.interrupt, {
                        startImmediately: true,
                      })
                    : owner.fork(operation),
                ),
              ),
            ),
        } satisfies ExecutionBridge;
      }),
    createSession(input, selection) {
      let owner: PairProviderSession | null = null;
      // The selected combination has every credential its providers need.
      const feasible = () => {
        const current = selection();
        const entry = current === null ? undefined : findEntry(current);
        return (
          entry !== undefined &&
          missingCredentials(entry.credentials(configuration), input.credentials).length === 0
        );
      };
      const requireOwner = (): PairProviderSession => {
        if (owner !== null) return owner;
        const current = selection();
        if (current === null) throw new Error("native_session_selection_missing");
        owner = resolveEntry(current).createSession(input, configuration);
        return owner;
      };
      return {
        summarizeSettings(settings) {
          const current = selection();
          if (current === null) throw new Error("native_session_selection_missing");
          return resolveEntry(current).summarizeSettings(settings);
        },
        get connected() {
          return owner?.connected ?? false;
        },
        get connecting() {
          return owner?.connecting ?? false;
        },
        get feasible() {
          return feasible();
        },
        trySendOpening: () => owner?.trySendOpening() ?? Promise.resolve(),
        start: (args) => requireOwner().start(args),
        attachBrowser: (request) => requireOwner().attachBrowser(request),
        ensureConnected: (id) => requireOwner().ensureConnected(id),
        reconcileLifetime: () => owner?.reconcileLifetime(),
        sendFinalizationOperation: (operation) =>
          requireOwner().sendFinalizationOperation(operation),
        describeInputClosure: (operation) =>
          selection() === null ? undefined : requireOwner().describeInputClosure?.(operation),
        // The pair's release starts its hangup now; Runtime awaits it as an Effect.
        release: (id, timeout) => {
          const released =
            owner === null && selection() === null
              ? releaseUnadmittedCall(id, timeout, input, configuration)
              : requireOwner().release(id, timeout);
          return Effect.promise(() => released);
        },
        closeBarrier: (accepted) => owner?.closeBarrier(accepted) ?? accepted,
        sampleReceiptPrefix: () =>
          owner?.sampleReceiptPrefix() ?? {
            receivedOrder: null,
            processedThroughOrder: null,
          },
        // Without an owner there is nothing to drain; the step still settles a microtask later.
        drain: () => Effect.promise(() => owner?.drain() ?? Promise.resolve()),
        enterNode: (args, admission) => {
          const current = requireOwner();
          if (current.enterNode === undefined) throw new Error("native_node_unavailable");
          // The registry paired this session with the selected handlers' typed native entry.
          dispatchReportedNode(admission, args, {
            enterNode: (input) => current.enterNode?.(input),
          });
        },
        containNode: () => owner?.containNode?.(),
      };
    },
  };
}
/** The registry's assembly on the real Cascade providers: a deployed Runtime's. */
export const runtimeHostAssembly: RuntimeHostAssembly = createRuntimeHostAssembly();
