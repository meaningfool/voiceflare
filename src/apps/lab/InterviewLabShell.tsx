import { type ReactNode } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/apps/lab/components/ui/tabs";
import type { InterviewLabSurface } from "./InterviewLab";
import type { LabInterviewStatus } from "./interviewClient";

type InterviewLabShellProps = {
  activeSurface: InterviewLabSurface;
  liveInterviewSurface: ReactNode;
  onSurfaceChange: (surface: InterviewLabSurface) => void;
  runtimePhase: LabInterviewStatus["phase"];
  /** The allocated Run, which stays identified after the view leaves Live Interview. */
  runId: string | null;
  transcriptSurface: ReactNode;
};

export function InterviewLabShell({
  activeSurface,
  liveInterviewSurface,
  onSurfaceChange,
  runtimePhase,
  runId,
  transcriptSurface,
}: InterviewLabShellProps) {
  return (
    <Tabs
      value={activeSurface}
      onValueChange={(value) => {
        const surface = toInterviewLabSurface(value);

        if (surface !== null) {
          onSurfaceChange(surface);
        }
      }}
      className="app-shell"
      data-testid="lab-interview"
      data-runtime-phase={runtimePhase}
      data-live-run-id={runId ?? undefined}
    >
      <header className="app-header">
        <div>
          <h1>Interview Lab</h1>
          <p className="app-brand">Interview Lab</p>
        </div>

        <TabsList aria-label="Primary surfaces" className="tabs">
          <TabsTrigger
            className="tab"
            onClick={() => {
              onSurfaceChange("liveInterview");
            }}
            value="liveInterview"
          >
            Live Interview
          </TabsTrigger>
          <TabsTrigger
            className="tab"
            data-testid="lab-transcripts-tab"
            onClick={() => {
              onSurfaceChange("transcripts");
            }}
            value="transcripts"
          >
            Transcripts
          </TabsTrigger>
        </TabsList>
      </header>

      <main className="surface">
        <TabsContent className="surface-tab-content" value="liveInterview">
          {activeSurface === "liveInterview" ? liveInterviewSurface : null}
        </TabsContent>
        <TabsContent className="surface-tab-content" value="transcripts">
          {activeSurface === "transcripts" ? transcriptSurface : null}
        </TabsContent>
      </main>
    </Tabs>
  );
}

function toInterviewLabSurface(value: string): InterviewLabSurface | null {
  switch (value) {
    case "liveInterview":
      return "liveInterview";
    case "transcripts":
      return "transcripts";
    default:
      return null;
  }
}
