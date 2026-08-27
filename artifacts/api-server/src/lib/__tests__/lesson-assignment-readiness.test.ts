import assert from "node:assert/strict";
import {
  resolveLessonAssignmentReadiness,
} from "../lesson-assignment-readiness.js";
import type {
  LessonValidationResult,
  ValidationIssue,
} from "../lesson-final-approval.js";

function validation(input: {
  errors?: ValidationIssue[];
  overrideable?: ValidationIssue[];
  warnings?: ValidationIssue[];
  usableNodes?: number;
  totalNodes?: number;
} = {}): LessonValidationResult {
  const totalNodes = input.totalNodes ?? input.usableNodes ?? 5;
  return {
    readiness: "READY",
    errors: input.errors ?? [],
    overrideable: input.overrideable ?? [],
    warnings: input.warnings ?? [],
    summary: {
      totalNodes,
      approvedNodes: totalNodes,
      totalTopics: totalNodes > 0 ? 1 : 0,
      sourceExercises: 0,
      approvedSourceExercises: 0,
      draftSourceExercises: 0,
      phase2CompleteNodes: 0,
      missingLONodes: 0,
      emptyNodes: 0,
      usableNodes: input.usableNodes ?? totalNodes,
    },
  };
}

const issue = (code: string): ValidationIssue => ({ code, messageArm: code });

// CASE 1: no findings.
let result = resolveLessonAssignmentReadiness(validation());
assert.equal(result.canAssign, true);
assert.equal(result.readiness, "READY");

// CASE 2: readable source without ownership is review-only.
result = resolveLessonAssignmentReadiness(validation({
  errors: [issue("UNRESOLVED_INSTRUCTIONAL_SOURCE")],
}));
assert.equal(result.hardBlockers.length, 0);
assert.ok(result.warnings.some((finding) => finding.code === "UNRESOLVED_INSTRUCTIONAL_SOURCE"));

// CASE 3: missing/review Cognitive Path is review-only.
result = resolveLessonAssignmentReadiness(validation({
  warnings: [issue("COGNITIVE_PATH_INVALID"), issue("COGNITIVE_PATH_REVIEW_REQUIRED")],
}));
assert.equal(result.canAssign, true);
assert.equal(result.readiness, "CONFIRMATION_REQUIRED");

// CASE 4: missing Teaching Content is review-only.
result = resolveLessonAssignmentReadiness(validation({
  overrideable: [issue("MISSING_PHASE2")],
}));
assert.equal(result.hardBlockers.length, 0);
assert.equal(result.warnings[0]?.code, "MISSING_PHASE2");

// CASE 5: multiple warning families produce one canonical confirmation state.
result = resolveLessonAssignmentReadiness(validation({
  errors: [issue("UNRESOLVED_INSTRUCTIONAL_SOURCE")],
  overrideable: [issue("MISSING_PHASE2")],
  warnings: [issue("COGNITIVE_PATH_INVALID")],
}));
assert.equal(result.readiness, "CONFIRMATION_REQUIRED");
assert.equal(result.warnings.length, 3);

// CASE 6: the canonical result requires confirmation when warnings exist.
assert.equal(result.canAssign, true);
assert.equal(result.readiness, "CONFIRMATION_REQUIRED");

// CASE 7: explicit override is enforced by the mutation against this same result.
assert.equal(result.hardBlockers.length, 0);

// CASE 8: an explicit override can never bypass a true hard blocker.
result = resolveLessonAssignmentReadiness(validation({
  errors: [issue("INVALID_NODE_SEQUENCE_GAP")],
}));
assert.equal(result.canAssign, false);
assert.equal(result.readiness, "BLOCKED");

// CASE 9: frontend readiness and mutation receive all policy fields from one result.
assert.deepEqual(Object.keys(result).sort(), [
  "canAssign",
  "hardBlockers",
  "readiness",
  "warnings",
]);

// CASE 10: five valid nodes plus source/path/content review remains assignable.
result = resolveLessonAssignmentReadiness(validation({
  totalNodes: 5,
  usableNodes: 5,
  errors: [
    { ...issue("UNRESOLVED_INSTRUCTIONAL_SOURCE"), count: 5 },
    issue("MICRONODE_SOURCE_ALIGNMENT_REQUIRED"),
  ],
  overrideable: [issue("MISSING_PHASE2")],
  warnings: [issue("COGNITIVE_PATH_INVALID")],
}));
assert.equal(result.canAssign, true);
assert.equal(result.readiness, "CONFIRMATION_REQUIRED");
assert.equal(result.hardBlockers.length, 0);

// Fatal no-content state is derived centrally even if a strict validator reports
// only per-node quality findings.
result = resolveLessonAssignmentReadiness(validation({
  totalNodes: 5,
  usableNodes: 0,
  errors: [issue("MISSING_LO"), issue("EMPTY_NODE")],
}));
assert.equal(result.canAssign, false);
assert.ok(result.hardBlockers.some((finding) => finding.code === "NO_USABLE_MICRONODES"));

console.log("lesson-assignment-readiness: 11 passed, 0 failed");