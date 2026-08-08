// ────────────────────────────────────────────────────────────────────────────
// Translation layer — Contract v1.2 mapping pipeline
//
// Architecture: a lookup table keyed by exact issueType value.
// Each entry is a template function that accepts a TranslatableIssue
// and returns the user-facing description string.
//
// Round 1.5 status: all templates are [EN-PLACEHOLDER] stubs.
// Round 1.6: replace each stub body with the exact Armenian string,
//            using the structured fields (entityId, line, params) for
//            dynamic values. Do NOT change the function signatures or
//            the issueType keys.
// ────────────────────────────────────────────────────────────────────────────

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Minimal interface passed to every template function.
 * The full ValidationIssue is a superset of this type.
 */
export interface TranslatableIssue {
  /** Exact issueType constant — used as the lookup key. */
  issueType: string;
  /** English description produced by the validator (used as EN-PLACEHOLDER). */
  description: string;
  /** Entity ID (node id, block id, exercise id, etc.) where applicable. */
  entityId?: string | null;
  /** Source line number in the TEXT input, where known. */
  line?: number | null;
  /** Severity tag from the validator. */
  severity?: string;
}

/** Template function signature — one per issueType. */
export type IssueTranslationFn = (issue: TranslatableIssue) => string;

// ── Complete issueType inventory ──────────────────────────────────────────────
//
// This array lists every issueType that can be emitted by:
//   (a) the validator (mapTextValidator.ts)
//   (b) the inserter (mapTextInserter.ts, for review-item issueTypes)
//
// Test F asserts that every entry here has a mapping in ISSUE_TRANSLATIONS.
// Test F also asserts that no issueType appears twice.
//
// If a new issueType is added to the validator or inserter, add it here AND
// to ISSUE_TRANSLATIONS. The test will catch the omission.
//
export const ALL_ISSUE_TYPES: readonly string[] = [
  // ── Lesson structure ─────────────────────────────────────────────────────
  "lesson-missing",            // E_LESSON_MISSING
  "lesson-title-empty",        // E_LESSON_TITLE_EMPTY
  "lesson-subject-empty",      // E_LESSON_SUBJECT_EMPTY
  "lesson-grade-invalid",      // E_LESSON_GRADE_INVALID     | params: grade
  "lesson-textbook-empty",     // E_LESSON_TEXTBOOK_EMPTY
  "lesson-pages-invalid",      // E_LESSON_PAGES_INVALID     | params: pagesFrom, pagesTo

  // ── ID format errors ─────────────────────────────────────────────────────
  "node-id-invalid",           // E_NODE_ID_INVALID           | params: id
  "micronode-id-invalid",      // E_MICRONODE_ID_INVALID       | params: id
  "sourceblock-id-invalid",    // E_SOURCEBLOCK_ID_INVALID     | params: id
  "exercise-id-invalid",       // E_EXERCISE_ID_INVALID        | params: id
  "dependency-id-invalid",     // E_DEPENDENCY_ID_INVALID      | params: id

  // ── Duplicate ID errors ──────────────────────────────────────────────────
  "duplicate-node-id",         // E_DUPLICATE_NODE_ID          | params: id
  "duplicate-micronode-id",    // E_DUPLICATE_MICRONODE_ID     | params: id
  "duplicate-sourceblock-id",  // E_DUPLICATE_SOURCEBLOCK_ID   | params: id
  "duplicate-exercise-id",     // E_DUPLICATE_EXERCISE_ID      | params: id
  "duplicate-dependency-id",   // E_DUPLICATE_DEPENDENCY_ID    | params: id

  // ── Orphan / parent ───────────────────────────────────────────────────────
  "orphan-micronode",          // E_ORPHAN_MICRONODE            | params: id, parentNodeId

  // ── MicroNode field errors ───────────────────────────────────────────────
  "mn-title-empty",            // E_MN_TITLE_EMPTY              | params: id
  "mn-type-invalid",           // E_MN_TYPE_INVALID             | params: id, received, expected
  "mn-learning-objective-empty", // E_MN_LEARNING_OBJ_EMPTY    | params: id
  "mn-confidence-missing",     // E_MN_CONFIDENCE_MISSING       | params: id
  "mn-confidence-range",       // E_MN_CONFIDENCE_RANGE         | params: id, value (0-100)
  "mn-coverage-invalid",       // E_MN_COVERAGE_INVALID         | params: id, received, expected
  "mn-status-invalid",         // E_MN_STATUS_INVALID           | params: id, received, expected

  // ── Source block field errors ────────────────────────────────────────────
  "sb-text-empty",             // E_SB_TEXT_EMPTY               | params: id
  "sb-page-missing",           // E_SB_PAGE_MISSING             | params: id
  "sb-blocktype-invalid",      // E_SB_BLOCKTYPE_INVALID        | params: id, received, expected
  "sb-status-invalid",         // E_SB_STATUS_INVALID           | params: id, received, expected

  // ── Reference errors ─────────────────────────────────────────────────────
  // NOTE: "ref-sourceblock-unknown" covers two message variants (sourceBlockId path
  //       and sourceRef path). Both share the same issueType. The translation
  //       template uses issue.description for this round (both are [EN-PLACEHOLDER]).
  "ref-sourceblock-unknown",   // E_REF_SOURCEBLOCK_UNKNOWN     | params: mnId/exId, refId
  "ref-sourcequote-mismatch",  // E_REF_SOURCEQUOTE_MISMATCH   | params: mnId, quote, sbId
  "ref-exercise-unknown",      // E_REF_EXERCISE_UNKNOWN        | params: mnId, exId
  "ref-prerequisite-unknown",  // E_REF_PREREQ_UNKNOWN          | params: mnId, prereqId
  "ref-related-mn-unknown",    // E_REF_RELATED_UNKNOWN         | params: entityId (MN or EX), relId
  "ref-dep-from-unknown",      // E_REF_DEP_FROM_UNKNOWN        | params: depId, from
  "ref-dep-to-unknown",        // E_REF_DEP_TO_UNKNOWN          | params: depId, to

  // ── UNREADABLE block rule (contract §8, absolute error) ──────────────────
  // NOTE: "unreadable-block-referenced" covers two message variants
  //       (sourceBlockIds path and sourceRef path).
  "unreadable-block-referenced", // E_UNREADABLE_BLOCK_REF     | params: mnId, sbId

  // ── Exercise field errors ────────────────────────────────────────────────
  "ex-text-empty",             // E_EX_TEXT_EMPTY               | params: id
  "ex-type-invalid",           // E_EX_TYPE_INVALID             | params: id, received
  "ex-difficulty-invalid",     // E_EX_DIFFICULTY_INVALID       | params: id, received, expected

  // ── Dependency field errors ──────────────────────────────────────────────
  "dep-type-invalid",          // E_DEP_TYPE_INVALID            | params: depId, received

  // ── Warnings ─────────────────────────────────────────────────────────────
  "warn-sb-needs-review-referenced", // W_SB_NEEDS_REVIEW_REF  | params: mnId, sbId
  "warn-sb-orphan",            // W_SB_ORPHAN                   | params: id
  "warn-ex-orphan",            // W_EX_ORPHAN                   | params: id
  "warn-mn-no-sources",        // W_MN_NO_SOURCES               | params: id
  "warn-related-mn-extra",     // W_RELATED_MN_EXTRA            | params: mnId, count, firstId
  "warn-ex-multi-related",     // W_EX_MULTI_RELATED            | params: exId, count, firstId

  // ── Page-range warning (inline in validator — not exported as constant) ──
  "sb-page-out-of-range",      // inline in validator §12        | params: sbId, page, pFrom, pTo

  // ── Inserter-generated issueTypes (appear in mapping_review_items) ───────
  "related-mn-deferred",       // inserter step 3                | params: mnId, relatedMnId
  "ex-multi-related-deferred", // inserter step 4                | params: exId, relatedMnId
] as const;

// ── Translation lookup table ──────────────────────────────────────────────────
//
// ROUND 1.5: Every entry is an [EN-PLACEHOLDER] stub.
//
// Each template function receives the full TranslatableIssue so that
// Round 1.6 can replace the stub body with:
//   return `<Armenian text using issue.entityId, issue.line, params...>`;
//
// Do NOT change the function signatures or key strings between rounds.
// Do NOT rename issueType constants (Contract §C).
//
export const ISSUE_TRANSLATIONS: Record<string, IssueTranslationFn> = {

  // ── Lesson structure ───────────────────────────────────────────────────────

  "lesson-missing": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  "lesson-title-empty": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  "lesson-subject-empty": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: grade (number)
  "lesson-grade-invalid": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  "lesson-textbook-empty": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: pagesFrom (number), pagesTo (number)
  "lesson-pages-invalid": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // ── ID format errors ───────────────────────────────────────────────────────

  // params: id (string — the invalid id value)
  "node-id-invalid": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: id (string)
  "micronode-id-invalid": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: id (string)
  "sourceblock-id-invalid": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: id (string)
  "exercise-id-invalid": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: id (string)
  "dependency-id-invalid": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // ── Duplicate ID errors ────────────────────────────────────────────────────

  // params: id (string)
  "duplicate-node-id": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: id (string)
  "duplicate-micronode-id": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: id (string)
  "duplicate-sourceblock-id": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: id (string)
  "duplicate-exercise-id": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: id (string)
  "duplicate-dependency-id": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // ── Orphan / parent ────────────────────────────────────────────────────────

  // params: entityId = mn.id (string), parentNodeId available via description
  "orphan-micronode": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // ── MicroNode field errors ─────────────────────────────────────────────────

  // params: entityId = mn.id (string)
  "mn-title-empty": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = mn.id, received = microNodeType, expected = valid list
  "mn-type-invalid": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = mn.id
  "mn-learning-objective-empty": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = mn.id
  "mn-confidence-missing": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = mn.id, value = confidenceScore (number, 0-100 range violated)
  "mn-confidence-range": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = mn.id, received = sourceCoverage value, expected = valid list
  "mn-coverage-invalid": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = mn.id, received = status value, expected = valid list
  "mn-status-invalid": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // ── Source block field errors ──────────────────────────────────────────────

  // params: entityId = sb.id
  "sb-text-empty": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = sb.id
  "sb-page-missing": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = sb.id, received = blockType, expected = valid list
  "sb-blocktype-invalid": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = sb.id, received = status, expected = valid list
  "sb-status-invalid": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // ── Reference errors ───────────────────────────────────────────────────────

  // params: entityId = mn.id, refId = sourceBlockId or sourceRef blockId
  // NOTE: two message variants share this key (sourceBlockIds path vs sourceRef path).
  "ref-sourceblock-unknown": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = mn.id, quote = first 40 chars, sbId = source block id
  "ref-sourcequote-mismatch": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = mn.id, exId = exerciseId
  "ref-exercise-unknown": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = mn.id, prereqId = prerequisite MN id
  "ref-prerequisite-unknown": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = mn.id OR ex.id, relId = relatedMicroNode id
  "ref-related-mn-unknown": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = dep.id, from = dep.from MN id
  "ref-dep-from-unknown": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = dep.id, to = dep.to MN id
  "ref-dep-to-unknown": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // ── UNREADABLE block rule ──────────────────────────────────────────────────

  // params: entityId = mn.id, sbId = the UNREADABLE source block id
  // NOTE: two message variants (sourceBlockIds path vs sourceRef path).
  "unreadable-block-referenced": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // ── Exercise field errors ──────────────────────────────────────────────────

  // params: entityId = ex.id
  "ex-text-empty": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = ex.id, received = exerciseType
  "ex-type-invalid": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = ex.id, received = difficulty, expected = valid list
  "ex-difficulty-invalid": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // ── Dependency field errors ────────────────────────────────────────────────

  // params: entityId = dep.id, received = dependencyType
  "dep-type-invalid": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // ── Warnings ──────────────────────────────────────────────────────────────

  // params: entityId = mn.id, sbId = the NEEDS_REVIEW block id
  "warn-sb-needs-review-referenced": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = sourceBlockId
  "warn-sb-orphan": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = exerciseId
  "warn-ex-orphan": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = mn.id
  "warn-mn-no-sources": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = mn.id, count = relatedMicroNodes.length, firstId = first MN id
  "warn-related-mn-extra": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = ex.id, count = relatedMicroNodes.length, firstId = first MN id
  "warn-ex-multi-related": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // ── Page-range warning ─────────────────────────────────────────────────────

  // params: entityId = sb.id, page = sourcePage, pFrom/pTo = lesson page range
  "sb-page-out-of-range": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // ── Inserter-generated (mapping_review_items) ──────────────────────────────

  // params: entityId = lesson_nodes.id (DB id), mnId, relatedMnId in description
  "related-mn-deferred": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

  // params: entityId = lesson_exercises.id (DB id), exId, relatedMnId in description
  "ex-multi-related-deferred": (issue) =>
    `[EN-PLACEHOLDER] ${issue.description}`,

} satisfies Record<string, IssueTranslationFn>;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Translate a ValidationIssue (or any object with issueType + description)
 * into a user-facing string via the translation lookup table.
 *
 * If the issueType is not found in the table (should never happen if
 * ALL_ISSUE_TYPES and ISSUE_TRANSLATIONS are kept in sync), falls back to
 * "[EN-PLACEHOLDER] " + issue.description so the [EN-PLACEHOLDER] sentinel
 * is always visible rather than silently passing through raw English.
 */
export function translateIssue(issue: TranslatableIssue): string {
  const fn = ISSUE_TRANSLATIONS[issue.issueType];
  if (!fn) {
    // Fallback: unknown issueType — still prefix with sentinel so the
    // problem is immediately visible in the UI.
    return `[EN-PLACEHOLDER:UNKNOWN-TYPE:${issue.issueType}] ${issue.description}`;
  }
  return fn(issue);
}
