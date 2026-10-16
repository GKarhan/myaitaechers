/** Pure conflict/resume decision for a single canonical lesson map.
 * Never infer completion from a stale background job alone.
 */
export type JobState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "coverage_failed"
  | "none";
export interface UnifiedResumeState {
  activeC1: JobState;
  activeC2?: JobState;
  staleActiveJob?: boolean;
  invalidC2Count?: number;
  activeTeaching: JobState;
  hasCanonicalNodes: boolean;
  c1SourceVerified: boolean;
  c2MissingCount: number;
  teachingMissingCount: number;
  hasTeacherEdits: boolean;
}
export type UnifiedResumeDecision =
  | { action: "WAIT"; reason: string }
  | { action: "REVIEW"; reason: string }
  | {
      action: "START_C1" | "START_C2" | "START_TEACHING" | "QUALITY_CHECK";
      reason: string;
    };
export function decideUnifiedResume(
  s: UnifiedResumeState,
): UnifiedResumeDecision {
  if (s.staleActiveJob)
    return { action: "REVIEW", reason: "STALE_JOB_REQUIRES_REVIEW" };
  if (["pending", "running"].includes(s.activeC2 ?? "none"))
    return { action: "WAIT", reason: "EXISTING_C2_JOB_ACTIVE" };
  if (
    ["pending", "running"].includes(s.activeC1) ||
    ["pending", "running"].includes(s.activeTeaching)
  )
    return { action: "WAIT", reason: "EXISTING_JOB_ACTIVE" };
  if (s.activeC1 === "coverage_failed")
    return { action: "REVIEW", reason: "C1_SOURCE_COVERAGE_FAILED" };
  if (!s.hasCanonicalNodes) {
    if (s.activeC1 === "failed")
      return {
        action: "REVIEW",
        reason: "C1_FAILED_RETRY_REQUIRES_CONFIRMATION",
      };
    return { action: "START_C1", reason: "NO_CANONICAL_MAP" };
  }
  if (!s.c1SourceVerified)
    return { action: "REVIEW", reason: "C1_NOT_VERIFIED" };
  if (s.hasTeacherEdits && (s.c2MissingCount > 0 || s.teachingMissingCount > 0))
    return { action: "REVIEW", reason: "TEACHER_EDITS_REQUIRE_REVIEW" };
  if ((s.invalidC2Count ?? 0) > 0)
    return { action: "REVIEW", reason: "EXISTING_C2_PATH_INVALID" };
  if (s.c2MissingCount > 0) return { action: "START_C2", reason: "C2_MISSING" };
  if (s.teachingMissingCount > 0)
    return { action: "START_TEACHING", reason: "TEACHING_MISSING" };
  return { action: "QUALITY_CHECK", reason: "GENERATED_STAGES_PRESENT" };
}
