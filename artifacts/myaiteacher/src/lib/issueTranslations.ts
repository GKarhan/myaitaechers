// ────────────────────────────────────────────────────────────────────────────
// Frontend translation layer — Contract v1.2 mapping pipeline
//
// Mirrors mapTextTranslations.ts (api-server) at the UI boundary.
//
// Rendering path:
//   structured error → issueType → translateIssue(e) → user-facing string
//
// Round 1.5: all templates are [EN-PLACEHOLDER] stubs.
// Round 1.6: replace each stub body with the exact Armenian string.
//            Use issue.entityId, issue.line, and any structured params
//            available in the error object for dynamic values.
// ────────────────────────────────────────────────────────────────────────────

/** Minimal type for any issue that can be translated. */
export interface TranslatableIssue {
  issueType: string;
  description: string;
  entityId?: string | null;
  line?: number | null;
  severity?: string;
}

type IssueTranslationFn = (issue: TranslatableIssue) => string;

// ── Translation lookup table ──────────────────────────────────────────────────
//
// One entry per issueType. All 49 issueTypes are listed explicitly.
// If a new validator/inserter issueType is added, add it here too.
// The api-server test:translations suite verifies completeness.
//
const ISSUE_TRANSLATIONS: Record<string, IssueTranslationFn> = {

  // ── Lesson structure ───────────────────────────────────────────────────────
  "lesson-missing":            (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "lesson-title-empty":        (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "lesson-subject-empty":      (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "lesson-grade-invalid":      (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "lesson-textbook-empty":     (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "lesson-pages-invalid":      (i) => `[EN-PLACEHOLDER] ${i.description}`,

  // ── ID format errors ───────────────────────────────────────────────────────
  "node-id-invalid":           (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "micronode-id-invalid":      (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "sourceblock-id-invalid":    (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "exercise-id-invalid":       (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "dependency-id-invalid":     (i) => `[EN-PLACEHOLDER] ${i.description}`,

  // ── Duplicate ID errors ────────────────────────────────────────────────────
  "duplicate-node-id":         (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "duplicate-micronode-id":    (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "duplicate-sourceblock-id":  (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "duplicate-exercise-id":     (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "duplicate-dependency-id":   (i) => `[EN-PLACEHOLDER] ${i.description}`,

  // ── Orphan / parent ────────────────────────────────────────────────────────
  "orphan-micronode":          (i) => `[EN-PLACEHOLDER] ${i.description}`,

  // ── MicroNode field errors ─────────────────────────────────────────────────
  "mn-title-empty":            (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "mn-type-invalid":           (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "mn-learning-objective-empty": (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "mn-confidence-missing":     (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "mn-confidence-range":       (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "mn-coverage-invalid":       (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "mn-status-invalid":         (i) => `[EN-PLACEHOLDER] ${i.description}`,

  // ── Source block field errors ──────────────────────────────────────────────
  "sb-text-empty":             (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "sb-page-missing":           (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "sb-blocktype-invalid":      (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "sb-status-invalid":         (i) => `[EN-PLACEHOLDER] ${i.description}`,

  // ── Reference errors ───────────────────────────────────────────────────────
  "ref-sourceblock-unknown":   (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "ref-sourcequote-mismatch":  (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "ref-exercise-unknown":      (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "ref-prerequisite-unknown":  (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "ref-related-mn-unknown":    (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "ref-dep-from-unknown":      (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "ref-dep-to-unknown":        (i) => `[EN-PLACEHOLDER] ${i.description}`,

  // ── UNREADABLE block rule (§8 absolute error) ──────────────────────────────
  "unreadable-block-referenced": (i) => `[EN-PLACEHOLDER] ${i.description}`,

  // ── Exercise field errors ──────────────────────────────────────────────────
  "ex-text-empty":             (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "ex-type-invalid":           (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "ex-difficulty-invalid":     (i) => `[EN-PLACEHOLDER] ${i.description}`,

  // ── Dependency field errors ────────────────────────────────────────────────
  "dep-type-invalid":          (i) => `[EN-PLACEHOLDER] ${i.description}`,

  // ── Warnings ──────────────────────────────────────────────────────────────
  "warn-sb-needs-review-referenced": (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "warn-sb-orphan":            (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "warn-ex-orphan":            (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "warn-mn-no-sources":        (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "warn-related-mn-extra":     (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "warn-ex-multi-related":     (i) => `[EN-PLACEHOLDER] ${i.description}`,

  // ── Page-range warning ─────────────────────────────────────────────────────
  "sb-page-out-of-range":      (i) => `[EN-PLACEHOLDER] ${i.description}`,

  // ── Inserter-generated (mapping_review_items display) ──────────────────────
  "related-mn-deferred":       (i) => `[EN-PLACEHOLDER] ${i.description}`,
  "ex-multi-related-deferred": (i) => `[EN-PLACEHOLDER] ${i.description}`,
};

/**
 * Translate a validation issue into a user-facing string.
 *
 * Rendering path (required by Contract §25 compliance):
 *   structured error → issueType → ISSUE_TRANSLATIONS[issueType] → string
 *
 * Falls back to a sentinel string if issueType is not in the table,
 * so missing entries are immediately visible rather than silently
 * passing through raw English.
 */
export function translateIssue(issue: TranslatableIssue): string {
  const fn = ISSUE_TRANSLATIONS[issue.issueType];
  if (!fn) {
    return `[EN-PLACEHOLDER:UNKNOWN-TYPE:${issue.issueType}] ${issue.description}`;
  }
  return fn(issue);
}
