# Adding a Conversation, an execution or a combination

Runtime runs an interview as a combination: one Conversation on one execution. Runtime's catalog
(`GET /_runtime/conversation-selections`) lists every registered combination, and the Lab offers
the ones it can edit. This guide names every place to change when you add one, and the checks that
cover it. [Architecture](architecture.md) explains the parts.

## The parts

| Part         | Where                                                                                       | Holds                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Conversation | `worker/conversations/<name>Interview.ts`                                                   | Every rule that does not depend on the provider: input, states, what the model receives per state, tool meaning, closing. |
| Execution    | a kit folder, `worker/providers/openaiRealtime/` or `worker/providers/cascade/`             | How the conversation is carried out: provider connections, the kit session and its node operations.                       |
| Pair         | `worker/implementations/<conversation><Execution>/`, for example `goodbyeCascade/`          | The Conversation's implementation on that execution, and its configuration of the kit session.                            |
| Combination  | one `combination({ conversation, execution, implementation, session })` row in the registry | Nothing of its own: its catalog id, name and version derive from its Conversation and execution.                          |

The registry is `worker/runtimeHostComposition.ts`. It has three tables: `conversations`,
`executions` and `registry`, the combination rows in catalog order.

## The sharing rule

Share an abstraction, not code. A shared piece is justified by what it is, not by how many
implementations use it. The test: remove every implementation but one; the shared piece must still
make sense as a concept with its own contract. Similar code is a signal, not a justification.

Each implementation stands on its own with its own tests. A kit's tests check its contract through
its own interface, and a pair's tests check only what the pair adds. Shared test support is a fake
of a provider or a test client of a protocol, owned by what it imitates or drives. When
implementations differ, make them consistent rather than grow the shared interface.

## What each addition touches

| Adding                                            | Sections                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A combination of an existing Conversation and kit | [Pair](#the-pair), [registry row](#the-registry), [catalog check](#runtimes-catalog-check) |
| A Conversation on existing executions             | All of the above, the [Conversation module](#the-conversation-module) and [Lab](#lab)      |
| An execution                                      | [Execution](#a-new-execution), then a pair per Conversation it runs, and Lab               |

Every addition ends with the [checks](#checks-that-cover-the-addition) and a
[run in the Lab](#running-it). Today's Conversations take all their wording from their input, so a
new one adds no wording to Runtime. The texts its Lab editor starts from go in the Lab's content
folder.

## The Conversation module

Start from the existing module closest to the new one: `originalInterview.ts` (one interviewing
state, then finishing), `goodbyeInterview.ts` (interviewing, then a Goodbye closing) or
`questionsInterview.ts` (one question state visited per question, then Goodbye). The module states,
in this order:

1. **Input.** A strict Zod schema whose `contract` is the literal input format,
   `<conversation id>-input/v1`, and its decoder, `decode<Name>InterviewInput`, a `boundary(...)`
   declaration from `tools/boundary-contracts/`.
2. **States.** `<name>InterviewStates`: per state, an `id` of the form
   `<conversation id>/<version>/<state>`, its `input` schema and its `event` schema. The state that
   ends participation, such as Goodbye or Original's `finishing`, sets `finishesParticipation: true`.
3. **What the model receives per state.** `<name>InterviewContent`, declared with
   `declareStateContent` (`worker/runtime/conversationContracts.ts`), which requires an entry for
   every state. `prepare` returns a `PreparedConversationNode`: instructions, operational
   instructions and tools, built from the state's input. A state that sends the model nothing, such
   as Original's `finishing`, declares `prepare: null`. A closing state, such as Goodbye, returns a
   `PreparedClosing` instead: the closing sentence its input carries (`{ sentence }`), which no
   model generates.
4. **What a tool call means.** `interpret<Name>InterviewTool`, which takes the tool invocation and,
   optionally, the state's reporter. Built on `reportToolCall`, it returns the call's intent and,
   given a reporter, reports the state's event. Each tool is declared once in the module, and both
   the state's content and the interpreter use it, as `nextQuestionTool` is in Questions.
5. **The closing assessment**, for a Conversation with a Goodbye: `assess<Name>InterviewClosing`,
   which records `conversation.closing_assessment` from the module's `conversationDiagnostics`.
6. **The definition.** `<name>InterviewConversation`, made with `declareConversation` (input,
   diagnostics, states, Runtime events, terminal states and, when transitions need it, a
   `context`, as Questions keeps its question position) and its `progression` (the initial state,
   the terminal roles, the timers per state, the input each state selects, and the transitions in
   `evaluate`).

Keep Conversations separate: a Goodbye state declared by two Conversations stays declared in each,
and a copy of another module keeps its own names. The module is pure.
`scripts/check-conversation-boundaries.ts` lets it import only `zod`, `effect`, the Runtime
contracts (`worker/runtime/conversationContracts.ts`, `executionContracts.ts`,
`diagnosticContracts.ts`, `nodeContentContracts.ts`), `worker/shared/contracts/` and the boundary
parser, and refuses raw capabilities such as `fetch`, `Date`, timers and computed property access.

Its tests are `worker/conversations/<name>Interview.test.ts`: the input check, the transitions,
what the model receives in each state, what each tool call means and the closing assessment, as
`goodbyeInterview.test.ts` shows.

## The pair

A pair folder is `worker/implementations/<conversation><Execution>/` with two files. `index.ts`
exports only the implementation definition and the session configuration. `implementation.ts`
holds them; the boundary check requires it in every pair folder. Start from a pair on the same
execution whose Conversation has the same states, such as `goodbyeCascade/` or `goodbyeRealtime/`.
A pair declares no settings: the execution's settings come from its kit through the registry row.

### Its configuration of the kit session

The configuration is a value: `<pair>SessionConfiguration`, checked with
`satisfies CascadeSessionConfiguration<typeof <name>InterviewStates>`
(`worker/providers/cascade/runtimeSession.ts`) or `satisfies RealtimeSessionConfiguration<...>`
(`worker/providers/openaiRealtime/session.ts`). It has two fields:

- `opening: { state, content }`: the state the session opens with, and its content from the
  Conversation module. Each kit opens with a conversing phase, so the interviewer speaks first.
- `nodes`: for each state the session enters, the kit operation that carries it:
  - `{ operation: "conversing", content }`: a conversing phase, where the interviewer and the
    participant take turns under the phase's settings, as each later question in Questions;
  - `{ operation: "closing", content, completed }`: the closing, where input closes and the closing
    sentence is said. `completed` turns the delivered output's id into the state's completion
    event, as Goodbye's `(responseId) => ({ kind: "goodbye_completed", responseId })`. Its content
    is a `PreparedClosing`. Cascade gives the sentence to speech output with no model request;
    Realtime's one reply asks the model to repeat it, with no history, no tool and minimal
    reasoning.

A state the session never enters has no node: the opening state, unless the session enters it
again as Questions does each later `question`, or a state that keeps the output that entered it,
such as Original's `finishing`. Finishing is the default: when input closes and nothing else is
entered, the reply in progress plays to its end, so Original's configurations have `nodes: {}`.
Runtime entering a state the configuration does not name fails with `native_node_unavailable`. The
kit sets the session's defaults, such as tool choice, history and reasoning effort; a pair does not
repeat them.

### Its implementation definition

A `RuntimeImplementationDefinition`, typed by the Conversation's definition and, when its session
enters nodes, by `NativeNodeEntry` of its states, with:

- `id`: `<conversation id>/<version>/<execution id>`, such as `goodbye-interview/1/cascade`.
- `conversation`: the Conversation module's definition, the same object the registry's
  `conversations` table names.
- `executionHandlers`: `implementExecutionHandlers(states, { ... })`, one handler per state, each
  naming its state as `contract`; a missing one is refused. A state the session enters has
  `policy: "native"` and an `enter` that calls `native.enterNode(input)`. A state the session only
  opens with, such as Original's `interviewing`, may instead have an `enter` that throws
  `native_node_unavailable`, as the Original pairs and Cascade Goodbye do. A state that keeps the
  output that entered it has `policy: "retained_output"`, `enter: null` and an `observe` that reads
  the output's proof. Each handler's `bind` is the pair's reporting policy for that state, usually
  calling `interpret<Name>InterviewTool` with the state's reporter.
- `prepare`: the opening state's content, from the configuration's `opening`. Runtime hands it to
  the session's start with the execution's prepared settings.
- `interpretTool`: the Conversation's interpreter, without a reporter.
- `finalizedDiagnostics`: the closing assessment, when the Conversation has one.

A pair never imports another pair, a kit never imports a pair or a Conversation, and pair code
never builds Runtime diagnostics itself; the boundary check refuses each.

Its tests check only what it adds. Runtime's durable-host tests per Conversation are
`worker/runtime/<name>Runtime.test.ts`, such as `goodbyeRuntime.test.ts`. Cascade pairs are tested
on workerd by platform tests such as `worker/runtime/cascadeGoodbye.platform.test.ts`, which drive
the real Runtime host through `cascadeRunClient` (`worker/runtime/testing/`) on the kit's stand-ins
(`worker/providers/cascade/testing/standIns.ts`), scripted by `standInInterviewResponse` in
`worker/runtimeLocalInterviewScript.ts` or by the test.

### When a node belongs in a pair's own code

Each kit offers its node procedures as operations of its contract: the conversing phase, the
closing, and finishing as the default. Conversations declare no node kinds. A node only one pair
needs is carried out by that pair's own code, using the kit's providers if needed. It moves into
the kit only when it becomes an abstraction of the kit's contract, which a second pair needing the
same behavior may reveal. No pair has one today, and a kit session's configuration names only kit
operations, so the first such node needs its own design, under the sharing rule, rather than a new
kind of entry in the configuration.

## The registry

In `worker/runtimeHostComposition.ts`:

1. For a new Conversation, import its definition and its identity, and add it to `conversations`:
   its identity (`id` and `version`, which its module exports, as `goodbyeInterviewIdentity`),
   `name`, `inputContract` and `definition`. The definition's `input` decoder is the input check
   Runtime applies at start and the Lab asks through Runtime. Add the module to
   `conversationModules` in `worker/conversations/registered.ts` too; the catalog check refuses a
   registered Conversation missing there.
2. Import the pair from its `index.ts` and add its row to `registry`, in catalog order:

   ```ts
   combination({
     conversation: conversations.goodbye,
     execution: executions.cascade,
     implementation: cascadeGoodbyeImplementation,
     session: cascadeGoodbyeSessionConfiguration,
   }),
   ```

The row derives the catalog id (`<conversation id>-<execution id>`), the name
(`<Conversation name> · <execution name>`), the version (1), the connection profiles, the usage its
execution's providers declare, the result warnings its execution declares and the execution's
settings preparation for its Conversation, such as Cascade's provider combination
`cascade-v1/<conversation id>`. Its `session` value is typed by the Conversation's states, so
another Conversation's configuration fails compilation. A row whose implementation names another
Conversation's definition fails registration with `conversation_definition_mismatch`. Export a
selection constant with `selectionOf` only when tests need it.

## Runtime's catalog check

`worker/runtime/conversationCatalog.test.ts` checks every registered combination through the
catalog, as Runtime does at start:

- Its first test lists the whole catalog literally. Add the new entry there.
- Its `it.each` tests take every entry from `conversationCatalog` and check that:
  - the selection resolves, and each connection profile has its setup;
  - its usage declarations and its warning declarations are present, each once, and are the ones
    Runtime publishes;
  - its credential declarations are complete: it can start with exactly the credentials it
    declares, and not without any one of them;
  - its Conversation is a Conversation module;
  - the input check accepts the sample of the entry's input format and refuses every other
    format's sample.
- The samples are `worker/runtime/testing/conversationInputSamples.ts`, keyed by input format. A
  new input format needs its sample there: Runtime's own test content, which no model receives.

Run it alone with `pnpm vitest run worker/runtime/conversationCatalog.test.ts`.

## Lab

The Lab offers exactly the catalog entries whose input format has an editor, and shows the panel of
the entry's execution: Cascade's when the entry accepts the `cascade-media-v1` profile, Realtime's
otherwise (`selectedExecution` in `src/apps/lab/InterviewLab.ts`). It disables the entries whose
`availability` in the catalog names missing credentials, and selects the first one it can start. A
new combination of an existing Conversation and execution therefore appears in the Lab with no Lab
change.

A new Conversation needs:

- **Its input builder**, in `src/apps/lab/data/conversationPresets.ts`: a
  `create<Name>ConversationInput` that refuses incomplete fields, a `LabInterviewInputBuilder`
  (`inputContract`, `closingLimit`, `build`), its input in the `LabInterviewInput` union, and its
  entry in `labInterviewInputBuilders`, keyed by Conversation id. Both Lab clients find it with
  `findLabInterviewInputBuilder(selection)`. New fields join `LabInterviewInputFields`.
- **Its editor**, in `src/apps/lab/conversationEditors.tsx`: a `LabConversationEditor` (its
  builder, where its instructions come from, its first draft, its config, and its `Settings` and
  `Prompt` fields), added to `labConversationEditors`, keyed by input format.
  `isLabConversationComplete` is the builder's `build`. New fields join `LabConversationFields`,
  `LabInterviewConfig` (`src/apps/lab/interviewClient.ts`) and the fields `LabConversationConfig`
  picks from it, and the page's state, its defaults and `conversationFields()` in
  `src/apps/lab/InterviewLab.ts`.
- **Its texts**, in the Lab's content folder, `src/apps/lab/content/presets.ts`: the texts its
  editor starts from. `tests/lab-content/presets.ts` has the same exports with other texts, and
  `pnpm test:lab-runtime-session` runs the Lab on it, so add each new export there too.
- **Its closing review** needs no Lab change: a Conversation whose module declares
  `conversation.closing_assessment` gets one, read with its own declaration (`closingAssessmentOf`
  in `worker/conversations/registered.ts`, used by
  `worker/lab/persistence/labClosingDiagnostics.ts`).

A Conversation that reuses another's input format finds that format's editor, so the Lab offers it,
but its Start fails with `conversation_selection_unavailable` until its builder is registered under
its own Conversation id.

The Lab's tests: the editors and panels in `src/apps/lab/InterviewLab.test.ts` ("Interview Lab
editors and execution panels"), and each client's refusal of incomplete input before the
microphone.

## A new execution

An execution is a kit and a row of `executions`.

### The kit

`worker/providers/<kit>/` holds:

- its provider contracts, its session and node operations (a conversing phase, a closing, and
  finishing as the default), and its configuration type (`<Kit>SessionConfiguration<S>`, as
  above);
- one Runtime adapter, the only module that speaks Runtime's session contract, as
  `createRealtimeRuntimeSession` (`openaiRealtime/runtimeSession.ts`) and `CascadeRuntimeSession`
  (`cascade/runtimeSession.ts`) do;
- a connection setup (`realtimeConnectionSetup`, `cascadeMediaConnectionSetup`);
- its settings, in its own format: their preparation from the start's reasoning effort and
  execution settings, which refuses execution settings it does not take with
  `invalid_execution_settings` (`prepareRealtimeSettings`, `prepareCascadeSettings`); the decoder
  of the settings Runtime stored, which its session reads back (`decodeRealtimeSessionSettings`,
  `decodeCascadeSessionSettings`); and their summary for diagnostics. Runtime stores the prepared
  settings without reading them, and refuses a Run whose settings, prepared again at call creation,
  differ.

**Usage.** Usage entries the kit reports name their own model. Each provider declares, next to its
code, the component, provider, measure and unit of the entries it reports
(`realtimeUsageDeclarations`, `cascadeProviderUsage`); Runtime publishes no other entry. The kit
attaches its usage reports to its observations as `usage`: each operation `expected` before its
provider work, then `satisfied` with its entries or `unavailable`. An operation still expected, or
an unknown or undeclared entry, makes the published usage incomplete.

**Cascade's providers.** Each provider module declares, next to its adapter, its settings schemas
and defaults, its credential, its usage source and the adapter itself (`sonioxSpeechInputProvider`,
`gradiumSpeechInputProvider`, `openAiResponsesProvider`, `cerebrasChatCompletionsProvider`,
`sonioxSpeechOutputProvider`, `gradiumSpeechOutputProvider`, of the type in
`providerDeclaration.ts`). A language model that accepts only some reasoning efforts names them in
`reasoningEfforts`, as Cerebras does, and the settings preparation refuses a Start choosing it with
another. A language model's request sends no tools when the request has none, and no tool choice
when its `toolChoice` is null. `settings.ts` composes the providers into one settings group per
component, each naming its `provider`; a group that names none is the first registered provider's.
The session provides `CascadeProviderSettings` from its prepared settings, and
`cascadeProviderAdapters` builds one adapter per component, of the provider those settings choose,
with that provider's settings. Each provider service names the provider and model of its entries in
its `usage` field, and `cascadeProviderUsage` declares the measures of each component on every
registered provider, so a provider added there names itself in both.

**Tests.** The kit's tests check its contract through its own interface, with fakes of its
providers in its `testing/` folder. The session is written with Effect.

### The registry

Add the kit's configuration type to `PairSessionValues`, and its entry to `executions` (`id`,
`version`, `name`, `connections`, `credentials`, `declaredCredentials`, `runCredentials`,
`hasStandIns`, `usage`, `warnings`, `prepareSettings`, `summarizeSettings`, `createSession`,
`releaseCall`), checked with `satisfies RegisteredExecution<"<id>">`.

- Controlled providers for test Runtimes go in `RuntimeHostConfiguration` as Layers of the kit's
  provider services, as `cascadeProviders` and `realtimeDriver` (the Realtime kit's
  `realtimeTestDriver`) do. `hasStandIns` says when the configuration gives the execution such
  providers, which need no credential. The Runtime that `pnpm dev` runs takes its configuration
  from `worker/runtimeLocalConfiguration.ts`, which gives the real providers.
- `releaseCall` releases a call the execution started, by its identity alone. It is Runtime's
  cleanup after a failed start that admitted no Conversation, which reaches the execution that
  accepts the start's connection profile. Like the session's own release, it answers a
  `SessionReleaseAnswer` (`worker/runtime/nativeContracts.ts`): closed, or close not confirmed with
  how the release failed, if it did.

### Credentials

Each provider declares the credentials it needs next to its code, by the name Runtime reads from
its environment, as `realtimeCredentials` (`openaiRealtime/credentials.ts`) and each Cascade
provider declaration's `credentials` do.

- The execution's `credentials` lists those a Run without settings needs, which its catalog
  availability names.
- `declaredCredentials` lists every one a provider it may run on declares.
- `runCredentials` gives those a Run's prepared settings need, for the providers they choose
  (`cascadeRunCredentials`).

Runtime reads every declared name from its environment and hands the set to the session as
`credentials` (`RuntimeProviderSessionInput`, `worker/runtime/runtimeHostAssembly.ts`); each
provider takes its own by name, as `cascadeProviderAdapters` does. Runtime refuses to start a Run
whose combination or chosen providers lack one, with `missing_credentials:<names>`, and its catalog
reports a combination's availability, so the Lab disables it.

Locally, Runtime reads its keys from `.dev.vars`. `pnpm dev` and `pnpm keys` ask for every name the
providers declare, so a new key needs no change there. Add it to `secrets.required` in
`wrangler.runtime.jsonc`, though: Wrangler binds only the secrets listed there.

### Warnings

The result warnings the kit attaches with its `result_warning` fact are declared next to its code
(`realtimeResultWarnings`, `cascadeResultWarnings`), as the execution's `warnings`. Runtime's own
warnings are `runtimeWarnings` and need no declaration. Runtime publishes an attached warning only
when the Run's combination declares it, and its catalog shows each combination's `warnings`. The
kit's records carry its own `source`, such as `realtime_execution`, and name its provider; Runtime's
name none.

### The Effect checks

Every file of the kit that imports Effect is listed in `tsconfig.effect.json`, and the kit's folder
joins the list of Runtime and kit folders in `runtimeOwner` in `scripts/check-effect-diagnostics.ts`,
which the clock rule and the Effect edge cover. The kit's Runtime adapter, and each adapter that
wraps a native API (a promise one such as `fetch`, or a callback one such as a WebSocket's events),
get their own entries in `effectEdges` in the same script. Each entry names the crossings it makes
(`promise`, `launch`, `escape`) and why it is an edge. An adapter whose native calls are bounded by
a deadline may instead await them through `callUntilDeadline` (`worker/shared/deadline.ts`) and need
no entry, as the Realtime driver does. The rest of the kit, its session and node operations
included, reaches promises, launches and `…Unsafe` escape hatches only through those places.

### Lab

Its panel in `src/apps/lab/executionPanels.tsx` (`LabExecutionPanel`), its choice in
`selectedExecution`, and a client implementing `LabInterviewClient`
(`src/apps/lab/interviewClient.ts`).

## Checks that cover the addition

`pnpm check` runs all of them; run them one by one while working.

- `pnpm typecheck`: the configuration's type against the Conversation's states, the row's `session`
  value, and the handlers.
- The catalog check, above, over every registered combination.
- `pnpm architecture:check`, including the boundary scripts. Both take their lists from the folders,
  so a new Conversation, pair or kit is covered without a list edit:
  - `scripts/check-conversation-boundaries.ts`: every pair folder holds its `implementation.ts`;
    Conversation modules are pure; pairs do not import one another; kits import no pair or
    Conversation.
  - `scripts/check-boundary-contract-declarations.ts`, for a new input decoder.
- `pnpm effect:check`. Among other rules, it refuses a production Worker file that imports Effect,
  a pair's included, unless `tsconfig.effect.json` lists it, and it enforces the clock rule in
  Runtime and kit code. In that code it also refuses `Effect.promise`, `Effect.tryPromise`, `run…`
  launchers and `…Unsafe` escape hatches outside the places `effectEdges` lists, and an entry whose
  place no longer makes a crossing it lists. A pair makes no such crossing.

## Running it

The two browser checks need no provider key; install their browser once with
`pnpm exec playwright install chromium`.

- A pair or the registry: `pnpm test:lab-runtime-session`. It runs the Lab page, the Lab Worker
  and Runtime together on Realtime, with only OpenAI's side of the call and the browser's media
  controlled. Cascade pairs are covered on the stand-ins by the platform tests `pnpm check` runs.
- Lab code: `pnpm test:lab-session` and `pnpm test:lab-runtime-session`.
- A provider session, a pair's behavior or its wording: a real interview in the Lab, with the
  providers' keys (`pnpm dev`). It calls the providers and is billed to your accounts.
