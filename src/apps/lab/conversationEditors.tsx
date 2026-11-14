import type { ReactNode } from "react";

import { Button } from "@/apps/lab/components/ui/button";
import { Field, FieldLabel } from "@/apps/lab/components/ui/field";
import {
  defaultFinishInterviewDescription,
  defaultClosingSentence,
  goodbyeFinishDescription,
  goodbyeInterviewInstructions,
} from "./content/presets";
import {
  goodbyeInterviewInputBuilder,
  originalInterviewInputBuilder,
  questionsInterviewInputBuilder,
  type LabInterviewInputBuilder,
} from "./data/conversationPresets";
import type { LabInterviewConfig } from "./interviewClient";

export type LiveInterviewPromptState =
  | {
      status: "ready";
      prompt: string;
    }
  | {
      status: "unavailable";
      message: string;
    };

/** The Conversation fields the Lab page keeps; the selected Conversation's editor shows its own. */
export type LabConversationFields = Readonly<{
  livePrompt: LiveInterviewPromptState;
  finishInterviewDescription: string;
  questionPrompts: readonly string[];
  nextQuestionDescription: string;
  closingSentence: string;
  maximumClosingDurationMs: number;
}>;

/** The fields a Conversation's first selection starts from; later selections keep their draft. */
export type LabConversationDraft = Pick<
  LabConversationFields,
  "livePrompt" | "finishInterviewDescription" | "closingSentence"
>;

/** What the selected Conversation's fields give the Lab client's config. */
export type LabConversationConfig = Pick<
  LabInterviewConfig,
  | "instructions"
  | "finishInterviewDescription"
  | "questionPrompts"
  | "nextQuestionDescription"
  | "closingSentence"
  | "maximumClosingDurationMs"
>;

export type LabConversationEditorProps = Readonly<{
  fields: LabConversationFields;
  onFieldsChange: (change: Partial<LabConversationFields>) => void;
  /** Locks the fields: while a run is starting, live or ending, and while a prompt is saved. */
  disabled: boolean;
  /** Locks the instructions, which the page may keep editable while a run is live. */
  instructionsDisabled: boolean;
  /** Lab's saved prompts, offered above the instructions when the page has them. */
  savedPrompts?: ReactNode;
}>;

/**
 * One Conversation's Lab editor: its fields, shown on the page of either execution, and its
 * completeness check, which is the Conversation's input builder's check.
 */
export type LabConversationEditor = Readonly<{
  builder: LabInterviewInputBuilder;
  /**
   * Where the instructions come from: the selected saved prompt, the Conversation's preset (which
   * a saved prompt may replace), or nowhere, for a Conversation without a single instructions
   * field.
   */
  instructions: "savedPrompt" | "preset" | "none";
  /** The fields of the Conversation's first selection, from the selected saved prompt or presets. */
  draft(savedPrompt: LiveInterviewPromptState): LabConversationDraft;
  config(fields: LabConversationFields): LabConversationConfig;
  /** The Conversation's fields in the page's Settings, beside the interview duration. */
  Settings: ((props: LabConversationEditorProps) => ReactNode) | null;
  /** The Conversation's fields in the page's Prompt section. */
  Prompt: (props: LabConversationEditorProps) => ReactNode;
}>;

function readyPrompt(fields: LabConversationFields): string {
  return fields.livePrompt.status === "ready" ? fields.livePrompt.prompt : "";
}

const goodbyeDraft = (): LabConversationDraft => ({
  livePrompt: { status: "ready", prompt: goodbyeInterviewInstructions },
  finishInterviewDescription: goodbyeFinishDescription,
  closingSentence: defaultClosingSentence,
});

const originalEditor: LabConversationEditor = {
  builder: originalInterviewInputBuilder,
  instructions: "savedPrompt",
  draft: (savedPrompt) => ({
    livePrompt: savedPrompt,
    finishInterviewDescription: defaultFinishInterviewDescription,
    closingSentence: defaultClosingSentence,
  }),
  config: (fields) => ({
    instructions: readyPrompt(fields),
    finishInterviewDescription: fields.finishInterviewDescription,
  }),
  Settings: null,
  Prompt: (props) => (
    <>
      <InstructionsField label="Working prompt" {...props} />
      <FinishDescriptionField {...props} />
    </>
  ),
};

const goodbyeEditor: LabConversationEditor = {
  builder: goodbyeInterviewInputBuilder,
  instructions: "preset",
  draft: goodbyeDraft,
  config: (fields) => ({
    instructions: readyPrompt(fields),
    finishInterviewDescription: fields.finishInterviewDescription,
    closingSentence: fields.closingSentence,
    maximumClosingDurationMs: fields.maximumClosingDurationMs,
  }),
  Settings: ClosingDurationField,
  Prompt: (props) => (
    <>
      <InstructionsField label="Interviewing instructions" {...props} />
      <FinishDescriptionField {...props} />
      <ClosingSentenceField {...props} />
    </>
  ),
};

const questionsEditor: LabConversationEditor = {
  builder: questionsInterviewInputBuilder,
  instructions: "none",
  draft: goodbyeDraft,
  config: (fields) => ({
    // The first question stands for the run's instructions, as its prompt provenance.
    instructions: fields.questionPrompts.at(0) ?? "",
    finishInterviewDescription: fields.finishInterviewDescription,
    questionPrompts: fields.questionPrompts,
    nextQuestionDescription: fields.nextQuestionDescription,
    closingSentence: fields.closingSentence,
    maximumClosingDurationMs: fields.maximumClosingDurationMs,
  }),
  Settings: ClosingDurationField,
  Prompt: (props) => (
    <>
      <FinishDescriptionField {...props} />
      <QuestionPromptFields {...props} />
      <ClosingSentenceField {...props} />
    </>
  ),
};

/** Lab's editors by the input format each makes; Lab offers exactly the entries they accept. */
const labConversationEditors: ReadonlyMap<string, LabConversationEditor> = new Map(
  [originalEditor, goodbyeEditor, questionsEditor].map((editor) => [
    editor.builder.inputContract,
    editor,
  ]),
);

/** The page shows Original's fields until the catalog is loaded and an entry selected. */
export const defaultLabConversationEditor: LabConversationEditor = originalEditor;

/** The editor of a catalog entry's input format, or `undefined` when Lab has none. */
export function findLabConversationEditor(
  entry: Readonly<{ inputContract: string }> | undefined,
): LabConversationEditor | undefined {
  return entry === undefined ? undefined : labConversationEditors.get(entry.inputContract);
}

/** Whether the editor's fields make a complete input for an interview of this duration. */
export function isLabConversationComplete(
  editor: LabConversationEditor,
  fields: LabConversationFields,
  maxDurationMs: number,
): boolean {
  try {
    editor.builder.build({ ...editor.config(fields), maxDurationMs });
    return true;
  } catch {
    return false;
  }
}

function InstructionsField({
  label,
  fields,
  onFieldsChange,
  instructionsDisabled,
  savedPrompts,
}: LabConversationEditorProps & { label: string }) {
  const { livePrompt } = fields;
  // The saved prompts explain why no prompt is loaded.
  const showsUnavailable = savedPrompts !== undefined && livePrompt.status === "unavailable";
  return (
    <>
      {savedPrompts}
      <Field className="run-setting-field live-prompt-editor-field">
        <FieldLabel htmlFor="live-prompt-editor">{label}</FieldLabel>
        <textarea
          id="live-prompt-editor"
          className="live-prompt-editor"
          value={livePrompt.status === "ready" ? livePrompt.prompt : ""}
          onChange={(event) =>
            onFieldsChange({ livePrompt: { status: "ready", prompt: event.currentTarget.value } })
          }
          disabled={livePrompt.status !== "ready" || instructionsDisabled}
          aria-describedby={showsUnavailable ? "live-prompt-message" : undefined}
        />
        {showsUnavailable ? (
          <p id="live-prompt-message" role="alert">
            {livePrompt.message}
          </p>
        ) : null}
      </Field>
    </>
  );
}

function FinishDescriptionField({ fields, onFieldsChange, disabled }: LabConversationEditorProps) {
  return (
    <Field className="run-setting-field live-prompt-editor-field">
      <FieldLabel htmlFor="live-finish-description">Finish interview tool description</FieldLabel>
      <textarea
        id="live-finish-description"
        className="live-prompt-editor"
        value={fields.finishInterviewDescription}
        onChange={(event) =>
          onFieldsChange({ finishInterviewDescription: event.currentTarget.value })
        }
        disabled={disabled}
      />
    </Field>
  );
}

/** The sentence Goodbye says to close, exactly: no model generates it. */
function ClosingSentenceField({ fields, onFieldsChange, disabled }: LabConversationEditorProps) {
  return (
    <Field className="run-setting-field">
      <FieldLabel htmlFor="live-closing-sentence">Closing sentence</FieldLabel>
      <input
        id="live-closing-sentence"
        type="text"
        value={fields.closingSentence}
        onChange={(event) => onFieldsChange({ closingSentence: event.currentTarget.value })}
        disabled={disabled}
        required
      />
    </Field>
  );
}

/** The Goodbye's own maximum duration, which follows interviewing time. */
function ClosingDurationField({ fields, onFieldsChange, disabled }: LabConversationEditorProps) {
  return (
    <Field>
      <FieldLabel htmlFor="maximum-goodbye-duration">Maximum Goodbye duration (seconds)</FieldLabel>
      <input
        id="maximum-goodbye-duration"
        data-testid="maximum-goodbye-duration"
        type="number"
        min={1}
        max={3600}
        step={1}
        value={fields.maximumClosingDurationMs / 1000}
        disabled={disabled}
        onChange={(event) => {
          const value = Number(event.currentTarget.value);
          if (Number.isSafeInteger(value) && value > 0 && value <= 3600)
            onFieldsChange({ maximumClosingDurationMs: value * 1000 });
        }}
      />
    </Field>
  );
}

/** Each question's full instructions and the `next_question` tool description. */
function QuestionPromptFields({ fields, onFieldsChange, disabled }: LabConversationEditorProps) {
  const { questionPrompts } = fields;
  return (
    <>
      {questionPrompts.map((prompt, index) => (
        <Field key={index} className="run-setting-field live-prompt-editor-field">
          <FieldLabel htmlFor={`live-question-${index}`}>
            Full question {index + 1} instructions
          </FieldLabel>
          <textarea
            id={`live-question-${index}`}
            className="live-prompt-editor"
            value={prompt}
            disabled={disabled}
            required
            onChange={(event) =>
              onFieldsChange({
                questionPrompts: questionPrompts.map((text, position) =>
                  position === index ? event.currentTarget.value : text,
                ),
              })
            }
          />
          <Button
            type="button"
            disabled={disabled || questionPrompts.length <= 1}
            onClick={() =>
              onFieldsChange({
                questionPrompts: questionPrompts.filter((_, position) => position !== index),
              })
            }
          >
            Remove question
          </Button>
        </Field>
      ))}
      <Button
        type="button"
        disabled={disabled || questionPrompts.length >= 16}
        onClick={() => onFieldsChange({ questionPrompts: [...questionPrompts, ""] })}
      >
        Add question
      </Button>
      <Field>
        <FieldLabel htmlFor="live-next-question-description">
          next_question tool description
        </FieldLabel>
        <textarea
          id="live-next-question-description"
          className="live-prompt-editor"
          value={fields.nextQuestionDescription}
          required
          disabled={disabled}
          onChange={(event) =>
            onFieldsChange({ nextQuestionDescription: event.currentTarget.value })
          }
        />
      </Field>
    </>
  );
}
