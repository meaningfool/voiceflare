import { afterEach, expect, it, vi } from "vitest";
import { runtimeWorkerTestHarness } from "../runtime.ts";
import { conversationCatalog, createRuntimeHostAssembly } from "../runtimeHostComposition.ts";
import {
  conversationInputCheckPath,
  decodeConversationCatalog,
  originalRealtimeSelection,
} from "../shared/contracts/conversationSelection.ts";
import type { InterviewExecution } from "../shared/contracts/runtimeStart.ts";
import { conversationInputSamples } from "./testing/conversationInputSamples.ts";
import { conversationModules } from "../conversations/registered.ts";
import { realtimeTestDriver } from "../providers/openaiRealtime/testing/testDriver.ts";
import { cascadeStandIns } from "../providers/cascade/testing/standIns.ts";
import { standInInterviewResponse } from "../runtimeLocalInterviewScript.ts";

afterEach(() => vi.unstubAllGlobals());
/** Runtime's credentials in its environment, as the tests set them. */
type RuntimeCredentials = Readonly<{
  OPENAI_API_KEY?: string;
  SONIOX_API_KEY?: string;
  CEREBRAS_API_KEY?: string;
}>;
// Runtime's credentials when it has every one its default providers declare.
const allCredentials = {
  OPENAI_API_KEY: "sk-test",
  SONIOX_API_KEY: "soniox-test",
  CEREBRAS_API_KEY: "cerebras-test",
};
async function discover(env: RuntimeCredentials = allCredentials) {
  const native = vi.fn(() => {
    throw new Error("unexpected_native_acquisition");
  });
  vi.stubGlobal("fetch", native);
  const response = await runtimeWorkerTestHarness.fetch(
    new Request("https://runtime.test/_runtime/conversation-selections"),
    env,
  );
  expect(response.status).toBe(200);
  expect(native).not.toHaveBeenCalled();
  return decodeConversationCatalog(await response.json());
}
/** What each execution's providers report: the combination's usage vocabulary. */
const declared = (componentRole: string, provider: string, unit: string, measures: string[]) =>
  measures.map((measure) => ({ componentRole, provider, measure, unit }));
const realtimeUsage = [
  ...declared("speech_to_speech", "openai", "token", [
    "uncached_input_text",
    "cached_input_text",
    "uncached_input_audio",
    "cached_input_audio",
    "output_text",
    "output_audio",
  ]),
  ...declared("speech_to_text", "openai", "token", ["input_audio", "input_text", "output_text"]),
];
const cascadeUsage = [
  // Cascade declares every provider it can run on, not only today's.
  ...declared("speech_to_text", "soniox", "audio_millisecond", ["input_audio"]),
  ...declared("speech_to_text", "gradium", "audio_millisecond", ["input_audio"]),
  ...declared("language_model", "cerebras", "token", ["input_text", "output_text"]),
  ...declared("language_model", "openai", "token", ["input_text", "output_text"]),
  ...declared("text_to_speech", "soniox", "character", ["input_text"]),
  ...declared("text_to_speech", "soniox", "audio_millisecond", ["output_audio"]),
  ...declared("text_to_speech", "gradium", "character", ["input_text"]),
  ...declared("text_to_speech", "gradium", "audio_millisecond", ["output_audio"]),
];
/**
 * The result warnings Realtime attaches (plan decision 11): speech after Ending closed input, a
 * repeated speech start, and events its side connection may have missed. Cascade attaches none.
 */
const realtimeWarnings = [
  "final_input_may_be_incomplete",
  "ambiguous_final_activity",
  "provider_observation_gap",
];
it("discovers delivered Original, Goodbye and Questions on Realtime and on Cascade without native acquisition", async () => {
  expect(await discover()).toEqual({
    selections: [
      {
        id: "original-interview-realtime",
        version: 1,
        name: "Original interview · Realtime",
        selection: {
          conversation: { id: "original-interview", version: 1 },
          execution: { id: "realtime", version: 1 },
        },
        connectionProfiles: ["realtime-v1"],
        inputContract: "original-interview-input/v1",
        usage: realtimeUsage,
        warnings: realtimeWarnings,
        availability: { credentials: ["OPENAI_API_KEY"], missingCredentials: [] },
      },
      {
        id: "goodbye-interview-realtime",
        version: 1,
        name: "Dedicated Goodbye · Realtime",
        selection: {
          conversation: { id: "goodbye-interview", version: 1 },
          execution: { id: "realtime", version: 1 },
        },
        connectionProfiles: ["realtime-v1"],
        inputContract: "goodbye-interview-input/v1",
        usage: realtimeUsage,
        warnings: realtimeWarnings,
        availability: { credentials: ["OPENAI_API_KEY"], missingCredentials: [] },
      },
      {
        id: "questions-interview-realtime",
        version: 1,
        name: "Questions · Realtime",
        selection: {
          conversation: { id: "questions-interview", version: 1 },
          execution: { id: "realtime", version: 1 },
        },
        connectionProfiles: ["realtime-v1"],
        inputContract: "questions-interview-input/v1",
        usage: realtimeUsage,
        warnings: realtimeWarnings,
        availability: { credentials: ["OPENAI_API_KEY"], missingCredentials: [] },
      },
      {
        id: "original-interview-cascade",
        version: 1,
        name: "Original interview · Cascade",
        selection: {
          conversation: { id: "original-interview", version: 1 },
          execution: { id: "cascade", version: 1 },
        },
        connectionProfiles: ["cascade-media-v1"],
        inputContract: "original-interview-input/v1",
        usage: cascadeUsage,
        warnings: [],
        availability: {
          credentials: ["SONIOX_API_KEY", "CEREBRAS_API_KEY"],
          missingCredentials: [],
        },
      },
      {
        id: "goodbye-interview-cascade",
        version: 1,
        name: "Dedicated Goodbye · Cascade",
        selection: {
          conversation: { id: "goodbye-interview", version: 1 },
          execution: { id: "cascade", version: 1 },
        },
        connectionProfiles: ["cascade-media-v1"],
        inputContract: "goodbye-interview-input/v1",
        usage: cascadeUsage,
        warnings: [],
        availability: {
          credentials: ["SONIOX_API_KEY", "CEREBRAS_API_KEY"],
          missingCredentials: [],
        },
      },
      {
        id: "questions-interview-cascade",
        version: 1,
        name: "Questions · Cascade",
        selection: {
          conversation: { id: "questions-interview", version: 1 },
          execution: { id: "cascade", version: 1 },
        },
        connectionProfiles: ["cascade-media-v1"],
        inputContract: "questions-interview-input/v1",
        usage: cascadeUsage,
        warnings: [],
        availability: {
          credentials: ["SONIOX_API_KEY", "CEREBRAS_API_KEY"],
          missingCredentials: [],
        },
      },
    ],
  });
});
it("refuses invalid current catalog values rather than accepting JSON-shaped evidence", async () => {
  const catalog = await discover();
  const entry = catalog.selections[0];
  if (entry === undefined) throw new Error("missing_selection");
  for (const invalid of [
    {},
    { selections: 42 },
    { selections: [{ ...entry, name: 42 }] },
    {
      selections: [
        {
          ...entry,
          selection: { ...entry.selection, conversation: { id: entry.selection.conversation.id } },
        },
      ],
    },
    { selections: [{ ...entry, connectionProfiles: [42] }] },
    { selections: [{ ...entry, availability: undefined }] },
    { selections: [{ ...entry, availability: { credentials: [] } }] },
    {
      selections: [{ ...entry, availability: { ...entry.availability, missingCredentials: [42] } }],
    },
    { selections: [{ ...entry, availability: { ...entry.availability, extra: true } }] },
    { selections: [{ ...entry, extra: true }] },
    { selections: [{ ...entry, usage: undefined }] },
    { selections: [{ ...entry, warnings: undefined }] },
    { selections: [{ ...entry, warnings: ["Events may be missing"] }] },
    { selections: [{ ...entry, warnings: [42] }] },
    { selections: [{ ...entry, usage: [{ ...entry.usage[0], unit: "second" }] }] },
    { selections: [{ ...entry, usage: [{ ...entry.usage[0], provider: " " }] }] },
    { selections: [{ ...entry, usage: [{ ...entry.usage[0], model: "gpt-realtime" }] }] },
    Object.create(catalog),
    { selections: [Object.create(entry)] },
  ])
    expect(() => decodeConversationCatalog(invalid)).toThrow();
});
// Each listed combination starts as Runtime starts it: its selection resolves to a valid
// definition with every state covered, each declared connection profile has a setup, its usage
// declarations are complete, each one once, and are what Runtime publishes, and its input check
// accepts its format's sample and refuses every other format's.
// Whether each combination can start follows Runtime's credentials: each provider needs the
// credential it declares, and stand-ins need none.
it.each([
  [{}, ["OPENAI_API_KEY"], ["SONIOX_API_KEY", "CEREBRAS_API_KEY"]],
  [{ OPENAI_API_KEY: "sk-test" }, [], ["SONIOX_API_KEY", "CEREBRAS_API_KEY"]],
  [
    { OPENAI_API_KEY: "sk-test", SONIOX_API_KEY: "", CEREBRAS_API_KEY: "cerebras-test" },
    [],
    ["SONIOX_API_KEY"],
  ],
  [{ OPENAI_API_KEY: "sk-test", SONIOX_API_KEY: "soniox-test" }, [], ["CEREBRAS_API_KEY"]],
  [{ SONIOX_API_KEY: "soniox-test", CEREBRAS_API_KEY: "cerebras-test" }, ["OPENAI_API_KEY"], []],
  [allCredentials, [], []],
])(
  "reports which combinations can start with credentials %j",
  async (env, realtimeMissing, cascadeMissing) => {
    const catalog = await discover(env);
    expect(
      catalog.selections.map(({ id, availability }) => [id, availability.missingCredentials]),
    ).toEqual([
      ["original-interview-realtime", realtimeMissing],
      ["goodbye-interview-realtime", realtimeMissing],
      ["questions-interview-realtime", realtimeMissing],
      ["original-interview-cascade", cascadeMissing],
      ["goodbye-interview-cascade", cascadeMissing],
      ["questions-interview-cascade", cascadeMissing],
    ]);
  },
);
it("reports every combination on stand-ins as able to start without credentials", () => {
  const standIns = {
    realtimeDriver: realtimeTestDriver(),
    cascadeProviders: cascadeStandIns({ responses: standInInterviewResponse }),
  };
  expect(
    conversationCatalog({}, standIns).selections.map(({ availability }) => availability),
  ).toEqual(Array.from({ length: 6 }, () => ({ credentials: [], missingCredentials: [] })));
});
it.each(conversationCatalog({}).selections)(
  "starts catalog entry $id as Runtime does",
  ({ selection, connectionProfiles, inputContract, usage, warnings, availability }) => {
    const assembly = createRuntimeHostAssembly();
    expect(() => assembly.validateSelection(selection)).not.toThrow();
    // Its Conversation is a Conversation module, which Lab and the voice suite read it from.
    expect(conversationModules.map(({ identity }) => identity)).toContainEqual(
      selection.conversation,
    );
    // Its warning declarations are what Runtime publishes from its execution, each once.
    expect(new Set(warnings).size).toBe(warnings.length);
    expect(assembly.declaredWarnings(selection)).toEqual(warnings);
    expect(usage.length).toBeGreaterThan(0);
    expect(new Set(usage.map((declaration) => JSON.stringify(declaration))).size).toBe(
      usage.length,
    );
    expect(assembly.declaredUsage(selection)).toEqual(usage);
    // Its credential declarations are complete: it can start with exactly the declared
    // credentials, and not without any one of them, which it names.
    const declared = Object.fromEntries(
      availability.credentials.map((name) => [name, "test-credential"]),
    );
    expect(availability.credentials).not.toEqual([]);
    expect(assembly.missingCredentials(selection, declared)).toEqual([]);
    for (const name of availability.credentials)
      expect(assembly.missingCredentials(selection, { ...declared, [name]: "" })).toEqual([name]);
    for (const profile of connectionProfiles)
      expect(assembly.connectionSetup(selection, profile).profile).toBe(profile);
    const sample = conversationInputSamples[inputContract];
    if (sample === undefined) throw new Error(`no sample input for ${inputContract}`);
    expect(() => assembly.validateInput(selection, sample)).not.toThrow();
    for (const [format, other] of Object.entries(conversationInputSamples))
      if (format !== inputContract)
        expect(() => assembly.validateInput(selection, other)).toThrow(
          "invalid_conversation_input",
        );
    const implementation = assembly.resolve(selection);
    const accepted = implementation.accept(sample);
    const initial = implementation.conversation.initial;
    const nodeInput = accepted.selectInput(initial, {
      runId: "run",
      context: accepted.initialContext,
    });
    const initialState = implementation.conversation.states[initial];
    if (initialState === undefined) throw new Error(`undeclared initial state ${initial}`);
    expect(() => initialState.input.parse(nodeInput)).not.toThrow();
  },
);
// Applications ask this check before starting a Run; it answers as Runtime decides at start.
async function checkInput(
  body: Readonly<{
    selection?: object;
    agentInput?: InterviewExecution["agentInput"] | undefined;
    executionSettings?: object;
    extra?: boolean;
  }>,
  env: RuntimeCredentials = allCredentials,
) {
  const native = vi.fn(() => {
    throw new Error("unexpected_native_acquisition");
  });
  vi.stubGlobal("fetch", native);
  const response = await runtimeWorkerTestHarness.fetch(
    new Request(`https://runtime.test${conversationInputCheckPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
  expect(native).not.toHaveBeenCalled();
  const text = await response.text();
  const parsed: unknown = text === "" ? null : JSON.parse(text);
  return { status: response.status, body: parsed };
}
it.each(conversationCatalog({}).selections)(
  "checks catalog entry $id's input as Runtime does at start",
  async ({ selection, inputContract }) => {
    expect(
      await checkInput({ selection, agentInput: conversationInputSamples[inputContract] }),
    ).toEqual({ status: 204, body: null });
    for (const [format, other] of Object.entries(conversationInputSamples))
      if (format !== inputContract)
        expect(await checkInput({ selection, agentInput: other })).toEqual({
          status: 400,
          body: { error: "invalid_conversation_input" },
        });
  },
);
// Each execution takes only its own settings: Lab's Realtime settings, or Cascade's.
const labRealtimeSettings = {
  model: "gpt-realtime-2",
  voice: "cedar",
  speed: 1.25,
  inputNoiseReduction: "off",
  semanticVadEagerness: "high",
  maxOutputTokens: "inf",
  truncation: "disabled",
};
const cascadeSettings = {
  speechInput: { endpointSensitivity: -0.5, maxEndpointDelayMs: 2_500 },
  speechOutput: { voice: "Nina" },
};
it.each(conversationCatalog({}).selections)(
  "checks the Start's execution settings for catalog entry $id as its execution does at start",
  async ({ selection, inputContract }) => {
    const agentInput = conversationInputSamples[inputContract];
    const accepted = { status: 204, body: null };
    const refused = { status: 400, body: { error: "invalid_execution_settings" } };
    const cascade = selection.execution.id === "cascade";
    expect(
      await checkInput({ selection, agentInput, executionSettings: labRealtimeSettings }),
    ).toEqual(cascade ? refused : accepted);
    expect(await checkInput({ selection, agentInput, executionSettings: cascadeSettings })).toEqual(
      cascade ? accepted : refused,
    );
    for (const executionSettings of [
      { ...labRealtimeSettings, speed: 2 },
      { ...labRealtimeSettings, extra: true },
      { ...cascadeSettings, speechInput: { maxEndpointDelayMs: 3_500 } },
      { ...cascadeSettings, extra: true },
    ])
      expect(await checkInput({ selection, agentInput, executionSettings })).toEqual(refused);
  },
);
it.each(conversationCatalog({}).selections)(
  "refuses catalog entry $id when Runtime lacks a credential its providers need, as at start",
  async ({ selection, inputContract, availability }) => {
    const agentInput = conversationInputSamples[inputContract];
    for (const name of availability.credentials)
      expect(
        await checkInput({ selection, agentInput }, { ...allCredentials, [name]: "" }),
      ).toEqual({ status: 400, body: { error: `missing_credentials:${name}` } });
    expect(await checkInput({ selection, agentInput }, {})).toEqual({
      status: 400,
      body: { error: `missing_credentials:${availability.credentials.join(",")}` },
    });
  },
);
it("refuses an unknown selection and a malformed check", async () => {
  const agentInput = conversationInputSamples["original-interview-input/v1"];
  for (const selection of [
    {
      conversation: { id: "unknown-interview", version: 1 },
      execution: { id: "realtime", version: 1 },
    },
    {
      conversation: { id: "original-interview", version: 2 },
      execution: { id: "realtime", version: 1 },
    },
    {
      conversation: { id: "original-interview", version: 1 },
      execution: { id: "cascade", version: 2 },
    },
  ])
    expect(await checkInput({ selection, agentInput })).toEqual({
      status: 400,
      body: { error: "conversation_selection_unavailable" },
    });
  for (const body of [
    { agentInput },
    { selection: originalRealtimeSelection },
    { selection: { conversation: { id: "original-interview" } }, agentInput },
    { selection: originalRealtimeSelection, agentInput, extra: true },
  ])
    expect(await checkInput(body)).toEqual({
      status: 400,
      body: { error: "invalid_conversation_input_check" },
    });
});
