/**
 * Current persisted Teaching Content is the only completion authority for a
 * retry. Generation job history is intentionally excluded: it is diagnostic
 * history, not lesson readiness.
 */
export type TeachingContentFields = {
  childFriendlyExplanation?: string | null;
  commonMisconception?: string | null;
  basicExamples?: unknown;
  nonExamples?: unknown;
};

export function hasCompleteTeachingContent(content: TeachingContentFields): boolean {
  return typeof content.childFriendlyExplanation === "string"
    && content.childFriendlyExplanation.trim().length > 0
    && typeof content.commonMisconception === "string"
    && content.commonMisconception.trim().length > 0
    && Array.isArray(content.basicExamples)
    && content.basicExamples.length > 0
    && Array.isArray(content.nonExamples)
    && content.nonExamples.length > 0;
}

export function summarizeCurrentTeachingContent<T extends TeachingContentFields>(
  nodes: readonly T[],
): { total: number; complete: number; missing: number; retryAllowed: boolean } {
  const complete = nodes.filter(hasCompleteTeachingContent).length;
  const missing = nodes.length - complete;
  return {
    total: nodes.length,
    complete,
    missing,
    retryAllowed: nodes.length > 0 && missing > 0,
  };
}

/** One rejected, fresh provider candidate may receive exactly one repair attempt. */
export function shouldRunBoundedPhase2Repair(
  result: { skipped: boolean; groundingAudit?: { valid: boolean } | null },
  repairAttempts: number,
): boolean {
  return repairAttempts === 0 && result.skipped && result.groundingAudit?.valid === false;
}