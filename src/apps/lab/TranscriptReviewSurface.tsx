import {
  CircleAlertIcon,
  FileTextIcon,
  InboxIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useId } from "react";

import { Message, MessageContent } from "@/apps/lab/components/ai-elements/message";
import { Alert, AlertDescription, AlertTitle } from "@/apps/lab/components/ui/alert";
import { Avatar, AvatarFallback } from "@/apps/lab/components/ui/avatar";
import { Badge } from "@/apps/lab/components/ui/badge";
import { Button } from "@/apps/lab/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/apps/lab/components/ui/empty";
import { Separator } from "@/apps/lab/components/ui/separator";
import { cn } from "@/apps/lab/lib/utils";
import { formatOutputUsage, getMatchedAnswerUsage, getOutputUsageSummary } from "./lib/outputUsage";
import type { LabRunDetail, LabRunEndReason, LabRunListItem } from "./data/labRunStore";
import {
  getInterviewTiming,
  getOrderedTranscriptTurns,
  type TranscriptRoleLabels,
} from "../../shared/browser/transcript";

const transcriptRoleLabels: TranscriptRoleLabels = {
  participant: "Participant",
  conversationAgent: "Interview Agent",
};

type TranscriptReviewSurfaceProps = {
  errorText: string | null;
  interviews: readonly LabRunListItem[];
  isLoadingInterview: boolean;
  isLoadingList: boolean;
  onRefresh: () => void;
  onSelectInterview: (runId: string) => void;
  selectedInterview: LabRunDetail | null;
  selectedInterviewId: string | null;
};

export function TranscriptReviewSurface({
  errorText,
  interviews,
  isLoadingInterview,
  isLoadingList,
  onRefresh,
  onSelectInterview,
  selectedInterview,
  selectedInterviewId,
}: TranscriptReviewSurfaceProps) {
  const titleId = useId();
  const runListHeadingId = useId();
  const detailHeadingId = useId();

  return (
    <section aria-labelledby={titleId} className="transcript-surface">
      <div className="transcript-toolbar">
        <div className="transcript-toolbar-copy">
          <h2 id={titleId}>Transcripts</h2>
          <p className="muted">Saved Lab runs.</p>
        </div>

        <div className="transcript-controls">
          <Button
            className="secondary-button transcript-refresh-button"
            data-testid="lab-transcript-refresh"
            disabled={isLoadingList}
            onClick={onRefresh}
            type="button"
            variant="outline"
          >
            {isLoadingList ? (
              <LoaderCircleIcon aria-hidden="true" data-icon="inline-start" />
            ) : (
              <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
            )}
            {isLoadingList ? "Loading" : "Refresh"}
          </Button>
        </div>
      </div>

      {errorText === null ? null : (
        <Alert className="error-banner" variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>Could not load Transcripts</AlertTitle>
          <AlertDescription>{errorText}</AlertDescription>
        </Alert>
      )}

      <div className="transcript-layout">
        <div
          className="interview-list-scroll"
          role="region"
          aria-labelledby={runListHeadingId}
          tabIndex={0}
        >
          <aside aria-labelledby={runListHeadingId} className="interview-list">
            <h3 className="sr-only" id={runListHeadingId}>
              Saved Lab runs
            </h3>
            <TranscriptRunRail
              interviews={interviews}
              isLoading={isLoadingList}
              onSelectInterview={onSelectInterview}
              selectedInterviewId={selectedInterviewId}
            />
          </aside>
        </div>

        <TranscriptDetail
          detailHeadingId={detailHeadingId}
          isLoading={isLoadingInterview}
          selectedInterview={selectedInterview}
        />
      </div>
    </section>
  );
}

function TranscriptRunRail({
  interviews,
  isLoading,
  onSelectInterview,
  selectedInterviewId,
}: {
  interviews: readonly LabRunListItem[];
  isLoading: boolean;
  onSelectInterview: (runId: string) => void;
  selectedInterviewId: string | null;
}) {
  if (isLoading) {
    return (
      <div aria-live="polite" className="transcript-rail-state">
        <LoaderCircleIcon aria-hidden="true" className="transcript-loading-icon" />
        <p className="muted">Loading Transcripts...</p>
      </div>
    );
  }

  if (interviews.length === 0) {
    return (
      <Empty className="transcript-empty transcript-empty-rail">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <InboxIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No Lab Runs found</EmptyTitle>
          <EmptyDescription>Start a live Interview to create local Lab data.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return interviews.map((interview) => (
    <RunListItem
      interview={interview}
      isSelected={interview.runId === selectedInterviewId}
      key={interview.runId}
      onSelect={() => onSelectInterview(interview.runId)}
    />
  ));
}

function RunListItem({
  interview,
  isSelected,
  onSelect,
}: {
  interview: LabRunListItem;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const timing = getInterviewTiming(interview);
  const reviewStatus = getLabRunReviewStatusLabel(interview);
  const turnCount = formatTurnCount(interview.transcriptTurnCount);
  const reviewSummary = `${reviewStatus} · ${turnCount}`;

  return (
    <Button
      aria-current={isSelected ? "true" : undefined}
      aria-label={`${isSelected ? "Selected transcript run" : "Open transcript run"}: ${interview.runId}, ${reviewSummary}`}
      aria-pressed={isSelected}
      className={cn("interview-row", isSelected && "interview-row-selected")}
      data-run-id={interview.runId}
      onClick={onSelect}
      type="button"
      variant={isSelected ? "secondary" : "outline"}
    >
      <span className="interview-row-title" dir="auto" title={timing.startedLabel}>
        {timing.startedLabel}
      </span>
      <span className="interview-row-id" dir="auto" title={interview.runId}>
        {interview.runId}
      </span>
      <span className="interview-row-meta" dir="auto" title={reviewSummary}>
        {reviewSummary}
      </span>
    </Button>
  );
}

function TranscriptDetail({
  detailHeadingId,
  isLoading,
  selectedInterview,
}: {
  detailHeadingId: string;
  isLoading: boolean;
  selectedInterview: LabRunDetail | null;
}) {
  if (isLoading) {
    return (
      <article aria-live="polite" className="transcript-detail transcript-detail-state">
        <LoaderCircleIcon aria-hidden="true" className="transcript-loading-icon" />
        <p className="muted">Opening Transcript...</p>
      </article>
    );
  }

  if (selectedInterview === null) {
    return (
      <article className="transcript-detail">
        <Empty className="transcript-empty transcript-empty-detail">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileTextIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Select a Lab Run.</EmptyTitle>
            <EmptyDescription>
              Choose a recorded run from the rail to read its Transcript.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </article>
    );
  }

  const timing = getInterviewTiming(selectedInterview);
  const turns = getOrderedTranscriptTurns(selectedInterview.transcript, transcriptRoleLabels);
  const usageSummary = getOutputUsageSummary(selectedInterview);
  const matchedUsage = getMatchedAnswerUsage(selectedInterview);

  return (
    <article
      key={selectedInterview.runId}
      aria-labelledby={detailHeadingId}
      className="transcript-detail"
      tabIndex={0}
    >
      <div className="transcript-heading">
        <div className="transcript-heading-copy">
          <h3 id={detailHeadingId}>Transcript</h3>
          <p className="transcript-run-id" dir="auto" title={selectedInterview.runId}>
            {selectedInterview.runId}
          </p>
        </div>
        <div className="transcript-heading-badges">
          <Badge variant={getRunBadgeVariant(selectedInterview)}>
            {getLabRunStatusLabel(selectedInterview)}
          </Badge>
          <Badge variant="outline">{formatTurnCount(selectedInterview.transcriptTurnCount)}</Badge>
        </div>
      </div>

      <dl className="timing-list">
        <TimingItem label="Started" value={timing.startedLabel} />
        <TimingItem label="Ended" value={timing.endedLabel} />
        <TimingItem label="Duration" value={timing.durationLabel} />
        {selectedInterview.terminalResult === undefined ? null : (
          <div>
            <dt>Runtime outcome</dt>
            <dd
              data-testid="lab-terminal-outcome"
              data-runtime-outcome={selectedInterview.terminalResult.outcome}
            >
              {selectedInterview.terminalResult.outcome === "failed_to_start"
                ? "Failed to start"
                : selectedInterview.terminalResult.outcome === "interrupted"
                  ? "Interrupted"
                  : "Completed"}
            </dd>
          </div>
        )}
        {hasLabRunEndState(selectedInterview) ? (
          <TimingItem
            label="Ending reason"
            value={getLabRunEndReasonLabel(selectedInterview.endReason)}
          />
        ) : null}
      </dl>

      {selectedInterview.closingDiagnostic === undefined ? null : (
        <section aria-label="Goodbye diagnostic" data-testid="lab-closing-diagnostic">
          <h4>Goodbye diagnostic</h4>
          {selectedInterview.closingDiagnostic.status === "checked" ? (
            <p>No closing limitation reported.</p>
          ) : selectedInterview.closingDiagnostic.status === "unknown" ? (
            <p>Closing evidence is unavailable.</p>
          ) : (
            <p role="status">
              Closing was limited: {selectedInterview.closingDiagnostic.warnings.join(", ")}
            </p>
          )}
        </section>
      )}
      <section className="output-usage-summary" aria-label="Response output usage">
        <h4>Response output usage</h4>
        {usageSummary.peak === null ? (
          <p>No response output usage reported.</p>
        ) : (
          <dl className="timing-list">
            <TimingItem
              label="Peak usage"
              value={formatOutputUsage(usageSummary.peak, selectedInterview.maxOutputTokens)}
            />
            {typeof selectedInterview.maxOutputTokens === "number" ? (
              <TimingItem
                label="Near limit (80% or more)"
                value={`${usageSummary.nearLimitCount} of ${usageSummary.responseCount} responses`}
              />
            ) : (
              <TimingItem label="Reported responses" value={String(usageSummary.responseCount)} />
            )}
          </dl>
        )}
      </section>

      <Separator className="transcript-detail-separator" />

      {turns.length === 0 ? (
        <Empty className="transcript-empty transcript-empty-detail">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileTextIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No Transcript turns recorded for this Lab Run.</EmptyTitle>
            <EmptyDescription>
              The run exists, but no participant or Interview Agent turns were persisted.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ol className="turn-list">
          {turns.map((turn) => (
            <TranscriptTurn
              key={`${turn.turnNumber}-${turn.role}-${turn.text}`}
              label={`${turn.turnNumber}. ${turn.roleLabel}`}
              role={turn.role}
              text={turn.text}
              usage={matchedUsage.get(turn.turnNumber)}
              outputCap={selectedInterview.maxOutputTokens}
            />
          ))}
        </ol>
      )}
    </article>
  );
}

function TimingItem({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd dir="auto" title={value}>
        {value}
      </dd>
    </>
  );
}

function TranscriptTurn({
  label,
  role,
  text,
  usage,
  outputCap,
}: {
  label: string;
  role: "participant" | "conversationAgent";
  text: string;
  usage: NonNullable<LabRunDetail["responseUsage"]>[number] | undefined;
  outputCap: number | "inf" | undefined;
}) {
  const isParticipant = role === "participant";

  return (
    <li className={cn("turn", `turn-${role}`)}>
      <div className={cn("turn-message", isParticipant && "turn-message-participant")}>
        <Avatar aria-hidden="true" size="default">
          <AvatarFallback>{isParticipant ? "PA" : "IA"}</AvatarFallback>
        </Avatar>
        <Message from={isParticipant ? "user" : "assistant"} className="turn-message-frame">
          <MessageContent className="turn-message-content" dir="auto">
            <span className="turn-label" dir="auto" title={label}>
              {label}
            </span>
            <p className="turn-text">{text}</p>
            {usage === undefined ? null : (
              <p className="turn-usage">{formatOutputUsage(usage.outputTokens, outputCap)}</p>
            )}
          </MessageContent>
        </Message>
      </div>
    </li>
  );
}

function getLabRunReviewStatusLabel(run: LabRunListItem | LabRunDetail): string {
  const statusLabel = getLabRunStatusLabel(run);

  if (!hasLabRunEndState(run)) {
    return statusLabel;
  }

  return `${statusLabel} · ${getLabRunEndReasonLabel(run.endReason)}`;
}

function getLabRunStatusLabel(run: LabRunListItem | LabRunDetail): string {
  if (run.outcome === "failed") {
    return "Failed";
  }

  if (run.endedAt === undefined) {
    return "In Progress";
  }

  return "Ended";
}

function hasLabRunEndState(run: LabRunListItem | LabRunDetail): boolean {
  return run.endedAt !== undefined || run.outcome !== undefined;
}

function getLabRunEndReasonLabel(reason: LabRunEndReason | undefined): string {
  switch (reason) {
    case "participant_stopped":
      return "Manual finish";
    case "timebox_reached":
      return "Timebox reached";
    case "agent_requested_end":
      return "Agent requested end";
    case "participant_disconnected":
      return "Participant disconnected";
    case "runtime_failed":
      return "Runtime failed";
    case undefined:
      return "Not recorded";
  }
}

function getRunBadgeVariant(
  run: LabRunListItem | LabRunDetail,
): "default" | "secondary" | "destructive" | "outline" {
  if (run.outcome === "failed") {
    return "destructive";
  }

  if (run.endedAt === undefined) {
    return "default";
  }

  return "secondary";
}

function formatTurnCount(turnCount: number): string {
  return `${turnCount} turns`;
}
