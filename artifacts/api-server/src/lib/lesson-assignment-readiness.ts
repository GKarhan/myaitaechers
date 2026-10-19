import type {
  LessonValidationResult,
  ValidationIssue,
} from "./lesson-final-approval.js";

export type LessonAssignmentReadiness =
  | "READY"
  | "CONFIRMATION_REQUIRED"
  | "BLOCKED";

export interface LessonAssignmentReadinessResult {
  canAssign: boolean;
  readiness: LessonAssignmentReadiness;
  hardBlockers: ValidationIssue[];
  warnings: ValidationIssue[];
}

const HARD_BLOCKER_CODES = new Set([
  "NO_MICRONODES",
  "COMPLETE_MAP_COGNITIVE_PATH_INVALID",
  "NO_USABLE_MICRONODES",
  "LOST_SOURCE_IDENTITY",
  "LOST_SOURCE_EXERCISES",
]);

function isHardBlocker(issue: ValidationIssue): boolean {
  return HARD_BLOCKER_CODES.has(issue.code)
    || issue.code.startsWith("INVALID_TOPIC_SEQUENCE_")
    || issue.code.startsWith("INVALID_NODE_SEQUENCE_");
}

function issueKey(issue: ValidationIssue): string {
  return [
    issue.code,
    issue.nodeId ?? "",
    issue.count ?? "",
    issue.messageArm,
  ].join(":");
}

function uniqueIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = issueKey(issue);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Canonical assignment authority.
 *
 * Upstream validators remain free to report strict mapping/content diagnostics.
 * Only this bounded allowlist may convert a diagnostic into an assignment-fatal
 * condition. Every other finding remains visible and requires an explicit
 * teacher decision.
 */
export function resolveLessonAssignmentReadiness(
  validation: LessonValidationResult,
): LessonAssignmentReadinessResult {
  const findings = uniqueIssues([
    ...validation.errors,
    ...validation.overrideable,
    ...validation.warnings,
  ]);
  const hardBlockers = findings.filter(isHardBlocker);

  if (validation.summary.usableNodes === 0 && !hardBlockers.some(
    (issue) => issue.code === "NO_MICRONODES" || issue.code === "NO_USABLE_MICRONODES",
  )) {
    hardBlockers.push({
      code: "NO_USABLE_MICRONODES",
      messageArm: "Դասը չունի սովորողին ցուցադրելու համար օգտագործելի MicroNode։",
    });
  }

  const hardKeys = new Set(hardBlockers.map(issueKey));
  const warnings = findings.filter((issue) => !hardKeys.has(issueKey(issue)));
  const canAssign = hardBlockers.length === 0;

  return {
    canAssign,
    readiness: !canAssign
      ? "BLOCKED"
      : warnings.length > 0
        ? "CONFIRMATION_REQUIRED"
        : "READY",
    hardBlockers,
    warnings,
  };
}