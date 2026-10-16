/** Convert canonical, persisted final-approval evidence into strict unified-map checks.
 * The old approval rules remain untouched. This is a read-only projection,
 * deliberately stricter for NEW unified drafts, and never auto-publishes.
 */
import type { LessonValidationResult } from "../lib/lesson-final-approval.js";
import { assessUnifiedMappingReadiness, type UnifiedQualityCheck } from "./unified-mapping-quality-readiness.js";

export interface PersistedUnifiedMapEvidence {
  finalApproval: LessonValidationResult;
  nodeCount: number;
  cognitiveNodeCount: number;
  validCognitiveTargetNodeCount: number;
  outcomeCount: number;
  outcomesWithRequiredNodeCount: number;
  expectedTextbookTaskCount: number | null;
  preservedTextbookTaskCount: number;
}

export function evaluatePersistedUnifiedMapEvidence(e: PersistedUnifiedMapEvidence) {
  const codes = new Set(e.finalApproval.errors.map(issue => issue.code));
  const review = new Set([...e.finalApproval.overrideable, ...e.finalApproval.warnings].map(issue => issue.code));
  const checks: UnifiedQualityCheck[] = [];
  const put = (area: UnifiedQualityCheck["area"], code: string, state: UnifiedQualityCheck["state"]) =>
    checks.push({ area, code, state });

  put("C1", "C1_CANONICAL_VALIDATION", codes.size || e.nodeCount === 0 ? "FAIL" : "PASS");
  if (e.nodeCount > 0 && e.cognitiveNodeCount === e.nodeCount && e.validCognitiveTargetNodeCount === e.nodeCount) {
    put("C2", "C2_ALL_NODES_HAVE_VALID_TARGET", "PASS");
  } else {
    put("C2", "C2_COGNITIVE_PATH_INCOMPLETE", "FAIL");
  }
  if (e.nodeCount > 0 && e.finalApproval.summary.phase2CompleteNodes === e.nodeCount) {
    put("TEACHING_PACKAGE", "TEACHING_PACKAGE_COMPLETE", "PASS");
  } else {
    put("TEACHING_PACKAGE", "TEACHING_PACKAGE_INCOMPLETE", "FAIL");
  }
  if (e.expectedTextbookTaskCount === null) {
    put("TASKS", "TASK_SOURCE_BASELINE_UNKNOWN", "NOT_CHECKED");
  } else if (e.preservedTextbookTaskCount < e.expectedTextbookTaskCount || codes.has("LOST_SOURCE_EXERCISES") || codes.has("LOST_SOURCE_IDENTITY")) {
    put("TASKS", "TASK_SOURCE_LOSS", "FAIL");
  } else {
    put("TASKS", "TEXTBOOK_TASK_COUNT_PRESERVED", "PASS");
  }
  if (e.outcomeCount === 0) {
    put("OUTCOMES", "NO_CANONICAL_OUTCOMES", "NOT_CHECKED");
  } else if (e.outcomesWithRequiredNodeCount !== e.outcomeCount) {
    put("OUTCOMES", "OUTCOMES_WITHOUT_REQUIRED_MICRONODE", "FAIL");
  } else {
    put("OUTCOMES", "ALL_OUTCOMES_HAVE_REQUIRED_NODES", "PASS");
  }
  if (review.size > 0) put("C1", "EXISTING_APPROVAL_REVIEW_REQUIRED", "REVIEW_REQUIRED");
  return assessUnifiedMappingReadiness(checks);
}
