export type LessonAssignmentReadiness =
  | "READY"
  | "CONFIRMATION_REQUIRED"
  | "BLOCKED";

export function classifyMappingAssignmentReadiness(input: {
  sourceScopeVerified: boolean;
  sourceSetVerified: boolean;
  structuralCoverageValid: boolean;
  microNodeCount: number;
  reviewFindingCount: number;
}): LessonAssignmentReadiness {
  if (
    !input.sourceScopeVerified
    || !input.sourceSetVerified
    || !input.structuralCoverageValid
    || input.microNodeCount === 0
  ) {
    return "BLOCKED";
  }
  return input.reviewFindingCount > 0
    ? "CONFIRMATION_REQUIRED"
    : "READY";
}