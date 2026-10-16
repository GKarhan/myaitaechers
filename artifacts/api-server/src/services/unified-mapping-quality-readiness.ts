/**
 * Strict readiness review for NEW unified maps only.
 * Legacy final approval remains unchanged. Pure function: no DB writes and
 * never grants teacher approval or publishes a lesson.
 *
 * Unlike a UI stage's "completed" flag, each evidence gate is evaluated
 * independently. Unknown evidence is not interpreted as a passing result.
 */
export type UnifiedQualityArea = "C1" | "C2" | "TEACHING_PACKAGE" | "TASKS" | "OUTCOMES";
export type UnifiedQualityState = "PASS" | "REVIEW_REQUIRED" | "FAIL" | "NOT_CHECKED";
export interface UnifiedQualityCheck {
  area: UnifiedQualityArea;
  code: string;
  state: UnifiedQualityState;
  details?: string;
}
export interface UnifiedQualityReport {
  status: "QUALITY_READY" | "TEACHER_REVIEW_REQUIRED" | "BLOCKED";
  readyForTeacherApproval: boolean;
  teacherApproved: false;
  checks: UnifiedQualityCheck[];
  blockingCodes: string[];
  reviewCodes: string[];
}
const MANDATORY_AREAS: readonly UnifiedQualityArea[] = ["C1", "C2", "TEACHING_PACKAGE", "TASKS", "OUTCOMES"];

export function assessUnifiedMappingReadiness(checks: readonly UnifiedQualityCheck[]): UnifiedQualityReport {
  const all = [...checks];
  for (const area of MANDATORY_AREAS) {
    if (!all.some(check => check.area === area)) {
      all.push({ area, code: area + "_NOT_CHECKED", state: "NOT_CHECKED" });
    }
  }
  const blockingCodes = all.filter(x => x.state === "FAIL" || x.state === "NOT_CHECKED").map(x => x.code);
  const reviewCodes = all.filter(x => x.state === "REVIEW_REQUIRED").map(x => x.code);
  const status = blockingCodes.length > 0
    ? "BLOCKED"
    : reviewCodes.length > 0 ? "TEACHER_REVIEW_REQUIRED" : "QUALITY_READY";
  return {
    status,
    readyForTeacherApproval: status !== "BLOCKED",
    teacherApproved: false,
    checks: all,
    blockingCodes,
    reviewCodes,
  };
}
