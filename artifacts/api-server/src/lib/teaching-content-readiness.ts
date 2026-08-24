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

/** Source-alignment review is a hard C1 boundary for every enrichment entry point. */
export function requiresSourceAlignmentReview(changeReason: string | null | undefined): boolean {
  return typeof changeReason === "string" && changeReason.startsWith("SOURCE_ALIGNMENT:");
}

const PEDAGOGICAL_REVIEW_REASONS = new Set([
  "ATOMICITY_REVIEW_REQUIRED",
  "DUPLICATE_REVIEW_REQUIRED",
  "DUPLICATE_REVIEW_REJECTED",
]);

/**
 * Semantic mapping findings are source-safe but must receive an explicit
 * teacher decision before bulk approval, Phase 2 enrichment, or final delivery.
 * Resolved markers are deliberately not included, so an individual approval is
 * the only path that clears this boundary.
 */
export function requiresPedagogicalReview(changeReason: string | null | undefined): boolean {
  if (typeof changeReason !== "string") return false;
  return changeReason.split("|").some((reason) =>
    [...PEDAGOGICAL_REVIEW_REASONS].some(
      (reviewReason) => reason === reviewReason || reason.startsWith(`${reviewReason}:`),
    )
    || reason.startsWith("ATOMICITY_REVIEW_UNAVAILABLE:"),
  );
}

/** Any unresolved review reason that requires an individual teacher action. */
export function requiresExplicitTeacherReview(changeReason: string | null | undefined): boolean {
  return requiresSourceAlignmentReview(changeReason) || requiresPedagogicalReview(changeReason);
}

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

/**
 * Normal AI enrichment is strictly fill-only. A partial node may include
 * teacher-authored material, so a persisted non-empty field is never replaced.
 */
export function getMissingTeachingContentPatch(
  existing: TeachingContentFields,
  candidate: TeachingContentFields,
): TeachingContentFields {
  const patch: TeachingContentFields = {};
  if (typeof existing.childFriendlyExplanation !== "string" || !existing.childFriendlyExplanation.trim()) {
    if (typeof candidate.childFriendlyExplanation === "string" && candidate.childFriendlyExplanation.trim()) {
      patch.childFriendlyExplanation = candidate.childFriendlyExplanation;
    }
  }
  if (typeof existing.commonMisconception !== "string" || !existing.commonMisconception.trim()) {
    if (typeof candidate.commonMisconception === "string" && candidate.commonMisconception.trim()) {
      patch.commonMisconception = candidate.commonMisconception;
    }
  }
  if (!Array.isArray(existing.basicExamples) || existing.basicExamples.length === 0) {
    if (Array.isArray(candidate.basicExamples) && candidate.basicExamples.length > 0) {
      patch.basicExamples = candidate.basicExamples;
    }
  }
  if (!Array.isArray(existing.nonExamples) || existing.nonExamples.length === 0) {
    if (Array.isArray(candidate.nonExamples) && candidate.nonExamples.length > 0) {
      patch.nonExamples = candidate.nonExamples;
    }
  }
  return patch;
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