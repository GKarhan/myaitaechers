/**
 * Shared mastery-level and personalized next-action utilities.
 *
 * Single source of truth for:
 *  - 5-state mastery level derivation from stored scores + review_schedule.dueAt
 *  - centralized next-action decision (Knowledge Tree → Personalized Learning)
 *  - recommendation priority ordering
 *
 * Used by: quizzes.ts (result/analysis endpoints), knowledge-tree.ts.
 *
 * States:
 *   not_started  – no evidence yet
 *   in_progress  – confidence < 50 (actively uncertain)
 *   weak         – confidence ≥ 50 but mastery < 80
 *   mastered     – mastery ≥ 80, confidence ≥ 50, not overdue
 *   needs_review – would be mastered but spaced-repetition review is overdue
 *
 * needs_review folds to "mastered" in the Knowledge Tree (KT shows only 4 blocks).
 * Quiz result recommendations surface needs_review at priority 2 — more urgent than weak+deep.
 */

export type MasteryLevel =
  | "mastered"
  | "needs_review"
  | "weak"
  | "in_progress"
  | "not_started";

export type PersonalizedAction =
  | "REVIEW"          // mastered / needs_review → [REVIEW]
  | "LEARN_TARGETED"  // weak → [LEARN_TARGETED]
  | "LEARN_FULL"      // in_progress → [LEARN_FULL]
  | "STUDY_FIRST";    // not_started → [STUDY_FIRST]

export interface PersonalizedNextAction {
  /** Semantic state — matches the 4 KT blocks plus needs_review. */
  state: "mastered" | "needs_review" | "partial" | "in_progress" | "not_started";
  /** Semantic action — UI maps this to display text / buttons. */
  action: PersonalizedAction;
  /** Mastery score (0–100) at time of decision; null for not_started. */
  masteryScore: number | null;
  /**
   * Remediation intensity — only present for LEARN_TARGETED:
   *   "light" → mastery > 50%  (shorter targeted remediation)
   *   "deep"  → mastery ≤ 50%  (broader remediation)
   */
  intensity?: "light" | "deep";
}

/**
 * Derive the 5-state mastery level from knowledge_nodes scores + review schedule.
 *
 * @param masteryScore     – knowledge_nodes.mastery_score  (null = not scored)
 * @param confidenceScore  – knowledge_nodes.confidence_score (null = not scored)
 * @param dueAt            – review_schedule.due_at for this node; null = no schedule yet
 *
 * Rules (evaluated in order):
 *  1. Both null → not_started
 *  2. confidence < 50 → in_progress  (confidence is the primary gate)
 *  3. mastery ≥ 80:
 *       overdue (dueAt ≤ now) → needs_review
 *       otherwise             → mastered
 *  4. fallthrough → weak
 */
export function getMasteryLevelFromScores(
  masteryScore: number | null,
  confidenceScore: number | null,
  dueAt?: Date | null,
): MasteryLevel {
  if (masteryScore === null && confidenceScore === null) return "not_started";
  if ((confidenceScore ?? 0) < 50) return "in_progress";
  if ((masteryScore ?? 0) >= 80) {
    if (dueAt != null && dueAt <= new Date()) return "needs_review";
    return "mastered";
  }
  return "weak";
}

/**
 * Central decision function: mastery state → Personalized Next Action.
 *
 * Decision table:
 *   mastered      → REVIEW          (Կrrknел)
 *   needs_review  → REVIEW          (same action, higher priority)
 *   weak (>50%)   → LEARN_TARGETED light
 *   weak (≤50%)   → LEARN_TARGETED deep
 *   in_progress   → LEARN_FULL
 *   not_started   → STUDY_FIRST
 */
export function getPersonalizedNextAction(params: {
  masteryLevel: MasteryLevel;
  masteryScore: number | null;
}): PersonalizedNextAction {
  const { masteryLevel, masteryScore } = params;
  switch (masteryLevel) {
    case "mastered":
      return { state: "mastered", action: "REVIEW", masteryScore: masteryScore ?? 100 };
    case "needs_review":
      return { state: "needs_review", action: "REVIEW", masteryScore: masteryScore ?? 100 };
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
 * Deterministic recommendation priority (lower = higher urgency).
 *
 * 1 → in_progress   (Չγαtи — needs full learning urgently)
 * 2 → needs_review  (mastered but overdue for spaced-rep — at risk of forgetting)
 * 3 → weak ≤ 50%    (deep remediation needed)
 * 4 → not_started / weak > 50% (never studied, or lighter remediation)
 * 5 → mastered      (review only, lowest urgency)
 *
 * Tie-break within same priority: lower nodeId first (deterministic).
 */
export function recommendationPriority(
  masteryLevel: MasteryLevel,
  masteryScore: number | null,
): number {
  if (masteryLevel === "in_progress") return 1;
  if (masteryLevel === "needs_review") return 2;
  if (masteryLevel === "weak" && (masteryScore ?? 50) <= 50) return 3;
  if (masteryLevel === "not_started") return 4;
  if (masteryLevel === "weak") return 4; // weak + light (> 50%)
  return 5; // mastered
}
