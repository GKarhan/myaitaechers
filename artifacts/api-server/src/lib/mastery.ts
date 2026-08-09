/**
 * Shared mastery-level and personalized next-action utilities.
 *
 * Single source of truth for:
 *  - 4-state mastery level derivation from stored scores
 *  - centralized next-action decision (Knowledge Tree → Personalized Learning)
 *  - recommendation priority ordering
 *
 * Used by: quizzes.ts result/analysis endpoints.
 * Knowledge Tree route (knowledge-tree.ts) has its own inline copy that also
 * handles needs_review/dueAt; this version folds needs_review → mastered so
 * the result page always shows the 4 visible states only.
 */

export type MasteryLevel = "mastered" | "weak" | "in_progress" | "not_started";

export type PersonalizedAction =
  | "REVIEW"          // mastered → [REVIEW]
  | "LEARN_TARGETED"  // weak → [LEARN_TARGETED]
  | "LEARN_FULL"      // in_progress → [LEARN_FULL]
  | "STUDY_FIRST";    // not_started → [STUDY_FIRST]

export interface PersonalizedNextAction {
  /** Semantic state matching the 4 KT blocks. */
  state: "mastered" | "partial" | "in_progress" | "not_started";
  /** Semantic action — UI maps this to display text / buttons. */
  action: PersonalizedAction;
  /** Mastery score (0-100) at the time of the decision; null for not_started. */
  masteryScore: number | null;
  /**
   * Remediation intensity — only present for LEARN_TARGETED:
   *   "light"  → mastery >50%  (2/3, 67% — targeted/shorter remediation)
   *   "deep"   → mastery ≤50%  (1/3, 33% — broader remediation)
   */
  intensity?: "light" | "deep";
}

/**
 * Derive the 4-state mastery level from knowledge_nodes scores.
 * needs_review (spaced-rep overdue) is folded into "mastered" — matches the
 * Knowledge Tree UI behaviour where only 4 blocks are shown.
 */
export function getMasteryLevelFromScores(
  masteryScore: number | null,
  confidenceScore: number | null,
): MasteryLevel {
  if (masteryScore === null && confidenceScore === null) return "not_started";
  if ((confidenceScore ?? 0) < 50) return "in_progress";
  if ((masteryScore ?? 0) >= 80) return "mastered"; // needs_review folded
  return "weak";
}

/**
 * Central decision function: Knowledge Tree state → Personalized Next Action.
 *
 * Returns a typed semantic object.  UI layers map this to display text/buttons.
 *
 * Decision table:
 *   mastered     → REVIEW        (Կрккнел)
 *   weak (>50%)  → LEARN_TARGETED light
 *   weak (≤50%)  → LEARN_TARGETED deep
 *   in_progress  → LEARN_FULL    (Лиарже сум совоpел)
 *   not_started  → STUDY_FIRST   (Усумнасирел → сов.)
 */
export function getPersonalizedNextAction(params: {
  masteryLevel: MasteryLevel;
  masteryScore: number | null;
}): PersonalizedNextAction {
  const { masteryLevel, masteryScore } = params;
  switch (masteryLevel) {
    case "mastered":
      return { state: "mastered", action: "REVIEW", masteryScore: masteryScore ?? 100 };
    case "weak": {
      const pct = masteryScore ?? 50;
      return {
        state: "partial",
        action: "LEARN_TARGETED",
        masteryScore: pct,
        intensity: pct > 50 ? "light" : "deep",
      };
    }
    case "in_progress":
      return { state: "in_progress", action: "LEARN_FULL", masteryScore: masteryScore ?? 0 };
    default: // not_started
      return { state: "not_started", action: "STUDY_FIRST", masteryScore: null };
  }
}

/**
 * Deterministic recommendation priority (lower number = higher priority).
 *
 * 1 → in_progress   (Չγαtи — needs full learning urgently)
 * 2 → weak ≤50%     (Masnak'i — deeper remediation)
 * 3 → not_started   (Derrchi — never studied)
 * 4 → weak >50%     (Masnak'i — lighter remediation)
 * 5 → mastered      (Giti — review only)
 */
export function recommendationPriority(
  masteryLevel: MasteryLevel,
  masteryScore: number | null,
): number {
  if (masteryLevel === "in_progress") return 1;
  if (masteryLevel === "weak" && (masteryScore ?? 50) <= 50) return 2;
  if (masteryLevel === "not_started") return 3;
  if (masteryLevel === "weak") return 4;
  return 5; // mastered
}
