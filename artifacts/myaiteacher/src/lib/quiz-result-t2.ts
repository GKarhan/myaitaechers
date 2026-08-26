export type RetestStrategy = "PARTIAL_AND_NOT_KNOWN" | "NOT_KNOWN_ONLY";

export type RetestAuthorityPayload = {
  attemptId: number;
  strategy: RetestStrategy;
  counts: {
    partial: number;
    notKnown: number;
    eligible: number;
  };
};

export type RetestAuthorityUiState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      combinedCount: number;
      notKnownOnlyCount: number;
      hasActionableRetest: boolean;
    };

export type SelectedNextAction = RetestStrategy | "FINISH";

export const STUDENT_RESULTS_FINISH_PATH = "/dashboard";

export type TargetedRetestCreationPayload =
  | {
      created: false;
      reason: "NO_ELIGIBLE_NODES";
      sourceAttemptId: number;
      strategy: RetestStrategy;
    }
  | {
      created: true;
      reused: boolean;
      sourceAttemptId: number;
      strategy: RetestStrategy;
      quizId: number;
      assignmentId: number;
    };

export function buildTargetedRetestRequest(
  sourceAttemptId: number,
  strategy: RetestStrategy,
) {
  return { sourceAttemptId, strategy };
}

export function parseTargetedRetestCreationPayload(
  value: unknown,
): TargetedRetestCreationPayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const strategy = payload.strategy;
  if (
    !Number.isInteger(payload.sourceAttemptId) ||
    (strategy !== "PARTIAL_AND_NOT_KNOWN" && strategy !== "NOT_KNOWN_ONLY")
  ) {
    return null;
  }

  if (payload.created === false && payload.reason === "NO_ELIGIBLE_NODES") {
    return payload as TargetedRetestCreationPayload;
  }
  if (
    payload.created === true &&
    typeof payload.reused === "boolean" &&
    Number.isInteger(payload.quizId) &&
    Number.isInteger(payload.assignmentId)
  ) {
    return payload as TargetedRetestCreationPayload;
  }
  return null;
}

export function summarizeRetestAuthority(
  combined: RetestAuthorityPayload,
  notKnownOnly: RetestAuthorityPayload,
): RetestAuthorityUiState {
  const combinedCount = Math.max(0, combined.counts.eligible);
  const notKnownOnlyCount = Math.max(0, notKnownOnly.counts.eligible);

  return {
    status: "ready",
    combinedCount,
    notKnownOnlyCount,
    hasActionableRetest: combinedCount > 0 || notKnownOnlyCount > 0,
  };
}

export function getRetestAuthorityUiState(input: {
  loading: boolean;
  error: boolean;
  combined: RetestAuthorityPayload | null;
  notKnownOnly: RetestAuthorityPayload | null;
}): RetestAuthorityUiState {
  if (input.loading) return { status: "loading" };
  if (input.error || !input.combined || !input.notKnownOnly) {
    return { status: "error" };
  }
  return summarizeRetestAuthority(input.combined, input.notKnownOnly);
}

export function shouldShowExplanation(
  explanation: string | null | undefined,
  otherExplanation?: string | null,
): boolean {
  return Boolean(explanation && explanation !== otherExplanation);
}

export function formatAnswer(
  options: readonly string[],
  selectedIndex: number,
): string {
  const letter = Number.isInteger(selectedIndex) && selectedIndex >= 0
    ? String.fromCharCode(65 + selectedIndex)
    : "—";
  return `${letter}. ${options[selectedIndex] ?? "—"}`;
}