/**
 * Single-action lesson mapping: pure orchestration plan.
 *
 * This module deliberately does not persist data or call any existing mapping
 * route. Its first use is as a safe contract for a future server-side runner:
 * one teacher action, sequential prerequisites, and no silent publication.
 *
 * C1 -> C2 -> Teaching Package -> review. Existing teacher edits and approvals
 * are preserved by the underlying stage implementations.
 */
export type UnifiedMappingStage = "source_and_c1" | "c2_paths" | "teaching_package" | "teacher_review";
export type UnifiedMappingStageStatus = "pending" | "running" | "completed" | "blocked" | "failed";
export type UnifiedMappingOutcome = "needs_source" | "ready_to_start" | "in_progress" | "needs_review" | "blocked";

export interface UnifiedMappingSnapshot {
  hasSource: boolean;
  hasValidPageRange: boolean;
  c1: UnifiedMappingStageStatus;
  c2: UnifiedMappingStageStatus;
  teachingPackage: UnifiedMappingStageStatus;
  /**
   * Approval is never automated. This flag means all mandatory validation
   * gates have passed, not that the teacher approved the lesson.
   */
  validationPassed: boolean;
}

export interface UnifiedMappingPlan {
  outcome: UnifiedMappingOutcome;
  nextStage: UnifiedMappingStage | null;
  requiresTeacherApproval: true;
  reasons: string[];
}

export function planUnifiedLessonMapping(s: UnifiedMappingSnapshot): UnifiedMappingPlan {
  const base = { requiresTeacherApproval: true as const };
  if (!s.hasSource || !s.hasValidPageRange) {
    return { ...base, outcome: "needs_source", nextStage: null, reasons: [
      !s.hasSource ? "SOURCE_REQUIRED" : "PAGE_RANGE_INVALID",
    ] };
  }

  const stages: Array<[UnifiedMappingStage, UnifiedMappingStageStatus]> = [
    ["source_and_c1", s.c1],
    ["c2_paths", s.c2],
    ["teaching_package", s.teachingPackage],
  ];

  for (const [stage, status] of stages) {
    if (status === "failed" || status === "blocked") {
      return { ...base, outcome: "blocked", nextStage: null, reasons: [stage + "_" + status] };
    }
    if (status === "running") {
      return { ...base, outcome: "in_progress", nextStage: stage, reasons: [] };
    }
    if (status === "pending") {
      return { ...base, outcome: "ready_to_start", nextStage: stage, reasons: [] };
    }
  }

  return {
    ...base,
    outcome: s.validationPassed ? "needs_review" : "blocked",
    nextStage: s.validationPassed ? "teacher_review" : null,
    reasons: s.validationPassed ? [] : ["FINAL_VALIDATION_FAILED"],
  };
}
