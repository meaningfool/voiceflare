import type { LabRunDetail } from "../data/labRunStore";

type OutputUsage = NonNullable<LabRunDetail["responseUsage"]>[number];

type OutputUsageSummary = {
  peak: number | null;
  nearLimitCount: number | null;
  responseCount: number;
};

export function getOutputUsageSummary(run: LabRunDetail): OutputUsageSummary {
  const usage = run.responseUsage ?? [];
  const peak = usage.length === 0 ? null : Math.max(...usage.map((item) => item.outputTokens));
  const cap = run.maxOutputTokens;
  return {
    peak,
    responseCount: usage.length,
    nearLimitCount:
      typeof cap === "number"
        ? usage.filter((item) => item.outputTokens / cap >= 0.8).length
        : null,
  };
}

export function getMatchedAnswerUsage(run: LabRunDetail): ReadonlyMap<number, OutputUsage> {
  const matches = new Map<number, OutputUsage>();
  const duplicates = new Set<number>();
  for (const item of run.responseUsage ?? []) {
    const turnNumber = item.answerTurnNumber;
    if (
      turnNumber === undefined ||
      run.transcript.turns[turnNumber - 1]?.role !== "conversationAgent"
    )
      continue;
    if (matches.has(turnNumber)) {
      matches.delete(turnNumber);
      duplicates.add(turnNumber);
    } else if (!duplicates.has(turnNumber)) {
      matches.set(turnNumber, item);
    }
  }
  return matches;
}

export function formatOutputUsage(outputTokens: number, cap: number | "inf" | undefined): string {
  if (typeof cap !== "number") return `${outputTokens} output tokens`;
  return `${outputTokens} / ${cap} output tokens (${Math.round((outputTokens / cap) * 100)}%)`;
}
