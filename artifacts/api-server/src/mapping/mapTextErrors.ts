// ────────────────────────────────────────────────────────────────────────────
// Error code constants and factory helpers for the TEXT-import pipeline.
// ────────────────────────────────────────────────────────────────────────────

import type { ValidationIssue, ValidationSeverity } from "./mapTextTypes.js";

// ── Error code constants ──────────────────────────────────────────────────────

// Structure / presence
export const E_LESSON_MISSING           = "lesson-missing";
export const E_LESSON_TITLE_EMPTY       = "lesson-title-empty";
export const E_LESSON_SUBJECT_EMPTY     = "lesson-subject-empty";
export const E_LESSON_GRADE_INVALID     = "lesson-grade-invalid";
export const E_LESSON_TEXTBOOK_EMPTY    = "lesson-textbook-empty";
export const E_LESSON_PAGES_INVALID     = "lesson-pages-invalid";

// ID format
export const E_NODE_ID_INVALID          = "node-id-invalid";
export const E_MICRONODE_ID_INVALID     = "micronode-id-invalid";
export const E_SOURCEBLOCK_ID_INVALID   = "sourceblock-id-invalid";
export const E_EXERCISE_ID_INVALID      = "exercise-id-invalid";
export const E_DEPENDENCY_ID_INVALID    = "dependency-id-invalid";

// Duplicates
export const E_DUPLICATE_NODE_ID        = "duplicate-node-id";
export const E_DUPLICATE_MICRONODE_ID   = "duplicate-micronode-id";
export const E_DUPLICATE_SOURCEBLOCK_ID = "duplicate-sourceblock-id";
export const E_DUPLICATE_EXERCISE_ID    = "duplicate-exercise-id";
export const E_DUPLICATE_DEPENDENCY_ID  = "duplicate-dependency-id";

// Orphan / parent resolution
export const E_ORPHAN_MICRONODE         = "orphan-micronode";

// MicroNode field errors
export const E_MN_TITLE_EMPTY           = "mn-title-empty";
export const E_MN_TYPE_INVALID          = "mn-type-invalid";
export const E_MN_LEARNING_OBJ_EMPTY   = "mn-learning-objective-empty";
export const E_MN_CONFIDENCE_MISSING    = "mn-confidence-missing";
export const E_MN_CONFIDENCE_RANGE      = "mn-confidence-range";
export const E_MN_COVERAGE_INVALID      = "mn-coverage-invalid";
export const E_MN_STATUS_INVALID        = "mn-status-invalid";

// Source block field errors
export const E_SB_PAGE_MISSING          = "sb-page-missing";
export const E_SB_BLOCKTYPE_INVALID     = "sb-blocktype-invalid";
export const E_SB_STATUS_INVALID        = "sb-status-invalid";
export const E_SB_TEXT_EMPTY            = "sb-text-empty";

// Reference errors
export const E_REF_SOURCEBLOCK_UNKNOWN  = "ref-sourceblock-unknown";
export const E_REF_SOURCEQUOTE_MISMATCH = "ref-sourcequote-mismatch";
export const E_REF_EXERCISE_UNKNOWN     = "ref-exercise-unknown";
export const E_REF_PREREQ_UNKNOWN       = "ref-prerequisite-unknown";
export const E_REF_RELATED_UNKNOWN      = "ref-related-mn-unknown";
export const E_REF_DEP_FROM_UNKNOWN     = "ref-dep-from-unknown";
export const E_REF_DEP_TO_UNKNOWN       = "ref-dep-to-unknown";

// UNREADABLE block rule (absolute — contract §8)
export const E_UNREADABLE_BLOCK_REF     = "unreadable-block-referenced";

// Exercise / Dependency field errors
export const E_EX_TEXT_EMPTY            = "ex-text-empty";
export const E_EX_LEARNER_TEXT_UNSAFE   = "ex-learner-text-unsafe";
export const E_EX_SOURCEBLOCK_UNKNOWN   = "ex-sourceblock-unknown";
export const E_EX_TYPE_INVALID          = "ex-type-invalid";
export const E_EX_DIFFICULTY_INVALID    = "ex-difficulty-invalid";
export const E_EX_ANSWER_CONTRACT_INVALID = "ex-answer-contract-invalid";
export const E_DEP_TYPE_INVALID         = "dep-type-invalid";

// ── Warning code constants ────────────────────────────────────────────────────

export const W_SB_NEEDS_REVIEW_REF      = "warn-sb-needs-review-referenced";
export const W_SB_ORPHAN               = "warn-sb-orphan";
export const W_EX_ORPHAN               = "warn-ex-orphan";
export const W_MN_NO_SOURCES           = "warn-mn-no-sources";
export const W_RELATED_MN_EXTRA        = "warn-related-mn-extra";
export const W_EX_MULTI_RELATED        = "warn-ex-multi-related";

// ── Factory helpers ───────────────────────────────────────────────────────────

export function makeIssue(
  severity:   ValidationSeverity,
  issueType:  string,
  entityId:   string | null,
  description: string,
  line:       number | null = null,
): ValidationIssue {
  return { severity, issueType, entityId, description, line };
}

export function makeError(issueType: string, entityId: string | null, description: string, line?: number | null): ValidationIssue {
  return makeIssue("error", issueType, entityId, description, line ?? null);
}

export function makeWarning(issueType: string, entityId: string | null, description: string, line?: number | null): ValidationIssue {
  return makeIssue("warning", issueType, entityId, description, line ?? null);
}
