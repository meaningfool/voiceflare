import { canStartLabConversation, type LabConversationOption } from "./data/conversationCatalog";
import { CheckCircle2Icon, CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/apps/lab/components/ui/alert";
import { Badge } from "@/apps/lab/components/ui/badge";
import { Button } from "@/apps/lab/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/apps/lab/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/apps/lab/components/ui/dialog";
import type {
  LabConversationEditor,
  LabConversationEditorProps,
  LabConversationFields,
} from "./conversationEditors";
import type { LabExecutionPanel } from "./executionPanels";
import type { LabInterviewStatus } from "./interviewClient";
import { LabSelectField } from "./LabSelectField";
import type { LabPromptOption } from "./labPrompts";
import { addMissingKeys } from "./content/providerKeys";

export type LabMaxDurationPreset = {
  label: string;
  value: number;
};

/** Lab's saved prompts, which the page offers when the selected execution's panel has them. */
export type LabSavedPrompts = Readonly<{
  options: readonly LabPromptOption[];
  selectedPromptId: string | null;
  onPromptChange: (promptId: string) => void;
  canSavePrompt: boolean;
  onSavePrompt: (choice: "replace" | "new", name?: string) => Promise<string | null>;
}>;

type LiveInterviewSurfaceProps = {
  /** The selected execution's panel. */
  panel: LabExecutionPanel;
  /** The selected Conversation's editor. */
  editor: LabConversationEditor;
  fields: LabConversationFields;
  onFieldsChange: (change: Partial<LabConversationFields>) => void;
  savedPrompts: LabSavedPrompts;
  conversationOptions: readonly LabConversationOption[];
  selectedConversationId: string | null;
  conversationError: string | null;
  onConversationChange: (id: string) => void;
  canStartInterview: boolean;
  isLiveSessionActive: boolean;
  isRunSettingsDisabled: boolean;
  isRuntimeStarting: boolean;
  liveInterviewId: string | null;
  maxDurationPresets: readonly LabMaxDurationPreset[];
  selectedMaxDurationMs: number;
  onMaxDurationChange: (value: number) => void;
  onStartInterview: () => void;
  onEndInterview: () => void;
  runtimeStatus: LabInterviewStatus;
  statusClassName: string;
  statusContent: {
    label: string;
    detail: string;
  };
};

/**
 * Lab's live interview page: the selected Conversation's editor combined with the selected
 * execution's panel.
 */
export function LiveInterviewSurface({
  panel,
  editor,
  fields,
  onFieldsChange,
  savedPrompts,
  conversationOptions,
  selectedConversationId,
  conversationError,
  onConversationChange,
  canStartInterview,
  isLiveSessionActive,
  isRunSettingsDisabled,
  isRuntimeStarting,
  liveInterviewId,
  maxDurationPresets,
  selectedMaxDurationMs,
  onMaxDurationChange,
  onStartInterview,
  onEndInterview,
  runtimeStatus,
  statusClassName,
  statusContent,
}: LiveInterviewSurfaceProps) {
  const [now, setNow] = useState(Date.now);
  const isInterviewLive = runtimeStatus.phase === "live";
  const conversation = isInterviewLive ? runtimeStatus.conversation : undefined;
  const showsCountdown = panel.liveFacts === "settings";
  useEffect(() => {
    if (!showsCountdown || conversation?.deadlineAt == null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [showsCountdown, conversation?.deadlineAt]);
  const remainingInterviewMs =
    conversation?.deadlineAt == null ? null : Math.max(0, conversation.deadlineAt - now);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveChoice, setSaveChoice] = useState<"replace" | "new">("replace");
  const [saveName, setSaveName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  async function submitSave() {
    if (isSaving || (saveChoice === "new" && saveName.trim().length === 0)) return;
    setIsSaving(true);
    const error = await savedPrompts.onSavePrompt(saveChoice, saveName);
    setIsSaving(false);
    if (error !== null) {
      setSaveError(error);
      return;
    }
    setSaveOpen(false);
    setSaveName("");
    setSaveError(null);
  }
  const statusDescriptionId = useId();
  const shouldShowEndButton = isLiveSessionActive && runtimeStatus.phase !== "ending";
  const closesWithGoodbye = editor.builder.closingLimit;
  // The keys Runtime lacks for the combinations it cannot start, in catalog order.
  const missingKeys = [
    ...new Set(conversationOptions.flatMap((option) => option.availability.missingCredentials)),
  ];
  const conversationState =
    conversation === undefined ? null : (
      <p data-testid="conversation-state">{conversation.state}</p>
    );
  const editorProps: LabConversationEditorProps = {
    fields,
    onFieldsChange,
    disabled: isRunSettingsDisabled || isSaving,
    // With saved prompts, the instructions stay editable while live; saving still locks them.
    instructionsDisabled: panel.savedPrompts ? isSaving : isRunSettingsDisabled,
    savedPrompts: panel.savedPrompts ? (
      <SavedPromptPicker savedPrompts={savedPrompts} disabled={isSaving} />
    ) : undefined,
  };
  const id = panel.idPrefix;

  return (
    <section className="live-surface" aria-label={panel.label}>
      <div className="live-surface-grid">
        <section aria-labelledby={`${id}-interview-heading`} className="live-interview-panel">
          <div className="live-interview-header">
            <h2 id={`${id}-interview-heading`}>{panel.heading}</h2>
            <Badge
              aria-label={`Interview status: ${statusContent.label}`}
              variant={getStatusBadgeVariant(runtimeStatus)}
            >
              {statusContent.label}
            </Badge>
          </div>

          <Alert
            aria-live="polite"
            className={`live-status live-status-${statusClassName}`}
            role="status"
          >
            <RuntimeStatusIcon status={runtimeStatus} />
            <AlertTitle className="live-status-label">{statusContent.label}</AlertTitle>
            <AlertDescription id={statusDescriptionId}>{statusContent.detail}</AlertDescription>
          </Alert>

          <div className="live-actions">
            <Button
              data-testid="lab-start-interview"
              aria-describedby={statusDescriptionId}
              className="primary-button"
              disabled={!canStartInterview || isSaving}
              onClick={onStartInterview}
              type="button"
            >
              {isRuntimeStarting ? "Starting" : "Start Interview"}
            </Button>
            <Button
              data-testid="lab-finish-interview"
              className="secondary-button"
              hidden={!shouldShowEndButton}
              onClick={onEndInterview}
              type="button"
              variant="outline"
            >
              End Interview
            </Button>
          </div>
          <dl className="live-runtime-summary">
            <RuntimeSummaryItem label="Interview ID" value={liveInterviewId ?? "Not started"} />
            <RuntimeSummaryItem label="State" value={statusContent.label} />
          </dl>
          {panel.liveFacts === "interview" ? conversationState : null}
        </section>
      </div>
      <div className="live-workspace-grid">
        <section aria-labelledby={`${id}-settings-heading`} className="live-settings-panel">
          <div className="live-section-heading">
            <h2 id={`${id}-settings-heading`}>Settings</h2>
          </div>

          <div className="run-settings">
            <FieldGroup className="run-settings-grid">
              <LabSelectField
                label="Conversation and execution"
                name="conversationSelection"
                disabled={isRunSettingsDisabled || conversationOptions.length === 0}
                options={conversationOptions.map((option) =>
                  canStartLabConversation(option)
                    ? { label: option.name, value: option.id }
                    : {
                        label: `${option.name} (missing ${option.availability.missingCredentials.join(", ")})`,
                        value: option.id,
                        disabled: true,
                      },
                )}
                value={selectedConversationId}
                onValueChange={onConversationChange}
                placeholder="Loading selections"
              />
              {missingKeys.length === 0 ? null : (
                <p data-testid="lab-missing-keys">
                  Missing keys: {missingKeys.join(", ")}. {addMissingKeys}
                </p>
              )}
              {conversationError === null ? null : <p role="alert">{conversationError}</p>}
              {panel.closingNote && closesWithGoodbye ? (
                <p>Interview time is followed by the separate Goodbye limit.</p>
              ) : null}
              {editor.Settings === null ? null : (
                <editor.Settings {...editorProps} disabled={isRunSettingsDisabled} />
              )}
              {panel.liveFacts === "settings" ? conversationState : null}
              {showsCountdown && remainingInterviewMs !== null ? (
                <p data-testid="interview-countdown" role="timer">
                  {Math.ceil(remainingInterviewMs / 1000)} seconds remaining
                </p>
              ) : null}
              <LabSelectField
                disabled={isRunSettingsDisabled}
                label={closesWithGoodbye ? "Interview duration" : "Max duration"}
                name="maxDurationMs"
                onValueChange={(value) => onMaxDurationChange(Number(value))}
                options={maxDurationPresets.map((preset) => ({
                  label: preset.label,
                  value: String(preset.value),
                }))}
                value={String(selectedMaxDurationMs)}
              />
              {panel.settings}
            </FieldGroup>
          </div>
        </section>
        <section aria-labelledby={`${id}-prompt-heading`} className="live-prompt-panel">
          <div className="live-section-heading">
            <h2 id={`${id}-prompt-heading`}>Prompt</h2>
          </div>
          <FieldGroup className="run-settings-grid">
            <editor.Prompt {...editorProps} />
            {panel.savedPrompts ? (
              <Button
                type="button"
                disabled={!savedPrompts.canSavePrompt}
                onClick={() => setSaveOpen(true)}
              >
                Save As
              </Button>
            ) : null}
          </FieldGroup>
          {panel.savedPrompts ? (
            <Dialog
              open={saveOpen}
              onOpenChange={(open) => {
                if (!isSaving) {
                  setSaveOpen(open);
                  setSaveError(null);
                }
              }}
            >
              <DialogContent>
                <DialogTitle className="text-lg font-semibold">Save prompt</DialogTitle>
                <DialogDescription className="mb-4 text-sm text-muted-foreground">
                  Choose where to save the current editor text.
                </DialogDescription>
                <div className="flex flex-col gap-3">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="save-choice"
                      checked={saveChoice === "replace"}
                      onChange={() => setSaveChoice("replace")}
                    />
                    Replace current prompt
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="save-choice"
                      checked={saveChoice === "new"}
                      onChange={() => setSaveChoice("new")}
                    />
                    Save as new prompt
                  </label>
                  {saveChoice === "new" ? (
                    <Field>
                      <FieldLabel htmlFor="new-prompt-name">Name</FieldLabel>
                      <input
                        id="new-prompt-name"
                        className="rounded-md border px-3 py-2"
                        value={saveName}
                        onChange={(event) => setSaveName(event.currentTarget.value)}
                        required
                        maxLength={120}
                      />
                    </Field>
                  ) : null}
                  {saveError !== null ? (
                    <p role="alert" className="text-destructive">
                      {saveError}
                    </p>
                  ) : null}
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setSaveOpen(false)}
                      disabled={isSaving}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      onClick={() => {
                        void submitSave();
                      }}
                      disabled={isSaving || (saveChoice === "new" && saveName.trim().length === 0)}
                    >
                      {isSaving ? "Saving…" : "Save"}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          ) : null}
        </section>
      </div>
    </section>
  );
}

/** The saved prompt to load into the instructions, and a reload of its saved text. */
function SavedPromptPicker({
  savedPrompts,
  disabled,
}: {
  savedPrompts: LabSavedPrompts;
  disabled: boolean;
}) {
  const { options, selectedPromptId, onPromptChange } = savedPrompts;
  const promptFileOptions = options.map((option) => ({
    label: option.fileName,
    value: option.id,
  }));
  return (
    <>
      <LabSelectField
        className="live-prompt-selector"
        disabled={promptFileOptions.length === 0 || disabled}
        label="Saved prompt"
        name="promptId"
        onValueChange={onPromptChange}
        onValueReselect={onPromptChange}
        options={promptFileOptions}
        placeholder="No Lab prompts configured"
        value={selectedPromptId}
      />
      <Button
        type="button"
        variant="outline"
        className="live-prompt-reload"
        disabled={selectedPromptId === null || disabled}
        onClick={() => {
          if (selectedPromptId !== null) onPromptChange(selectedPromptId);
        }}
      >
        Reload saved prompt
      </Button>
    </>
  );
}

function RuntimeSummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="live-runtime-summary-item">
      <dt>{label}</dt>
      <dd dir="auto" title={value}>
        {value}
      </dd>
    </div>
  );
}

function RuntimeStatusIcon({ status }: { status: LabInterviewStatus }) {
  if (status.phase === "failed") {
    return <CircleAlertIcon className="text-destructive" />;
  }

  if (status.phase === "setup" && status.label !== "Ready") {
    return <LoaderCircleIcon className="text-primary" />;
  }

  return <CheckCircle2Icon className="text-primary" />;
}

function getStatusBadgeVariant(
  status: LabInterviewStatus,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status.phase) {
    case "live":
      return "default";
    case "failed":
      return "destructive";
    case "ending":
    case "setup":
      return "outline";
    case "ended":
      return "secondary";
  }
}
