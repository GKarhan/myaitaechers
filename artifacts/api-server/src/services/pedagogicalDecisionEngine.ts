/**
 * V2-R3 — Pedagogical Decision Engine
 *
 * Answers the question: "Given the student's REAL evaluated answer + learner state
 * + current cognitive level, WHAT SHOULD THE TEACHER DO NEXT?"
 *
 * INVARIANTS:
 * - Pure function — no DB reads or writes.  All inputs must be pre-fetched by caller.
 * - The AI model NEVER owns workflow transitions.  This function decides.
 * - Non-ANSWER intents (HELP, CONFUSED, CLARIFY, etc.) bypass this entirely.
 * - HELP does NOT consume remediation budget.
 * - Remediation is bounded — no infinite loop.
 * - A heavily-scaffolded correct answer is NOT independent mastery.
 * - Cognitive target and current demonstrated level are always kept separate.
 * - Repeated struggle does NOT permanently lower the curriculum target.
 */

// ── Re-export so callers have a single import ──────────────────────────────

export const COGNITIVE_LEVEL_ORDER = [
  "remember", "understand", "apply", "analyze", "evaluate", "create",
] as const;

export type CognitiveLevel = typeof COGNITIVE_LEVEL_ORDER[number];

/** Maximum remediation escalation steps before MARK_TARGET_NOT_REACHED fires. */
export const MAX_REMEDIATION_STEPS = 5;

/**
 * Maximum inter-turn interval credited as active learning time (seconds).
 * Gaps larger than this (e.g. idle browser) are capped at this value so
 * wall-clock idle time never inflates activeLearningSeconds.
 * Policy constant — do not scatter magic numbers through runtime code.
 */
export const ACTIVE_INTERVAL_CAP_SECONDS = 180;

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * One row from lesson_node_cognitive_levels, pre-fetched by the caller.
 * Must be sorted by sequence (ascending) when passed as cognitivePath.
 */
export interface CognitiveLevelRow {
  id: number;
  cognitiveLevel: string;          // 'remember' | 'understand' | 'apply' | …
  sequence: number;
  isTargetCeiling: boolean;
  isApplicable: boolean;
  minimumIndependentEvidence: number;  // default 3 in schema
  preferredInteractionTypes: string[];
  performanceObjective: string | null;
  successCriterion: string | null;
}

/**
 * Summarises the historical independent-correct evidence for a specific
 * (session × node × cognitiveLevel) combination.  Derived from evidence_events
 * by the caller and handed in so the engine stays pure.
 *
 * NOTE: This does NOT include the current turn's answer — the engine adds the
 * current turn's contribution based on the other input fields.
 */
export interface LevelEvidenceSummary {
  /** Independent-correct turns for this level (helpCount ≤ 1, assistance none/light, CORRECT). */
  independentCorrectCount: number;
  /** All CORRECT turns for this level (assisted included). */
  totalCorrectCount: number;
  /** Best quality among independent-correct turns (null if none). */
  bestQuality: "NONE" | "WEAK" | "MODERATE" | "STRONG" | "CONCLUSIVE" | null;
}

export interface PedagogicalDecisionInput {
  // ── MicroNode context ────────────────────────────────────────────────────
  lessonNodeId: number;
  lessonId: number;

  // ── Session state ────────────────────────────────────────────────────────
  sessionId: number;
  userId: number;
  nodeTeachingStage: string;        // THEORY | MICRO_CHECK | EXERCISE | VERIFIED
  remediationStep: number;          // current step (0 = initial)

  // ── Cognitive path (null if node has no confirmed cognitive path) ─────────
  activeCognitiveLevelId: number | null;
  activeCognitiveLevelRow: CognitiveLevelRow | null;
  /** All applicable levels for this node, ordered by sequence ascending. */
  cognitivePath: CognitiveLevelRow[];

  // ── Evaluated answer (null for non-ANSWER intents — engine returns NON_ANSWER) ──
  answerStatus: string | null;   // CORRECT | PARTIALLY_CORRECT | INCORRECT | …
  evidenceQuality: string | null; // NONE | WEAK | MODERATE | STRONG | CONCLUSIVE
  errorFamily: string | null;     // CONCEPTUAL | PREREQUISITE | …
  errorStability: string | null;  // FIRST_OCCURRENCE | PERSISTENT

  // ── Task independence (copied from session at answer time) ───────────────
  activeHelpCount: number;
  activeAssistanceLevel: string;   // none | light | moderate | guided | revealed
  activeAttemptSequence: number;
  activeTaskProvenance: string | null; // micro_check | source_exercise | null

  // ── Historical evidence for the current cognitive level ──────────────────
  /** null when there is no active cognitive level or no evidence yet. */
  levelEvidenceSummary: LevelEvidenceSummary | null;

  // ── Dependency / advance context ─────────────────────────────────────────
  /** null if the current node is the last node in the lesson. */
  nextNodeId: number | null;
  /**
   * true when a REQUIRED+CRITICAL dependency edge exists from the current node
   * to the next node AND the current node's demonstrated level has NOT yet
   * reached its target ceiling.
   * Determines whether REVISIT_LATER or MARK_TARGET_NOT_REACHED is the outcome.
   */
  nextNodeHasCriticalDependencyOnCurrentNode: boolean;

  // ── V2-R4A: Learning Budget signals (computed by chat.ts, never by AI) ───
  /**
   * true when activeLearningSeconds >= requiredSessionMinutes * 60.
   * false when requiredSessionMinutes is null (no budget configured).
   * The AI model NEVER sets this — backend deterministic code owns it.
   */
  sessionBudgetExhausted: boolean;
  /**
   * true when the local node effort budget is exhausted.
   * V1 policy: always false — policy not yet established (see computeLocalNodeBudget).
   * Future rounds will fill in the policy when safe to do so.
   * The AI model NEVER sets this.
   */
  localNodeBudgetExhausted: boolean;
}

export type PedagogicalMetaAction =
  | "NON_ANSWER"              // intent was not ANSWER — engine has no decision
  | "NO_COGNITIVE_PATH"       // node has no confirmed cognitive path → legacy flow
  | "CONTINUE_COGNITIVE_LEVEL" // stay at current level; use remediationAction
  | "REQUEST_INDEPENDENT_CHECK" // helped success → present new equivalent task
  | "MARK_LEVEL_CONFIRMED"    // current level is confirmed; advance path or MicroNode
  | "ADVANCE_COGNITIVE_LEVEL" // move activeCognitiveLevelId to next level in path
  | "MARK_TARGET_NOT_REACHED" // budget exhausted; can still advance (dep not critical)
  | "REVISIT_LATER"           // budget exhausted; critical dep blocks advancement
  | "COMPLETE_NODE"           // all levels through ceiling confirmed → advance MicroNode
  // ── V2-R4A additions ──────────────────────────────────────────────────────
  | "END_REQUIRED_SESSION"    // session time budget exhausted — stop without failure
  | "STOP_LEVEL_AND_REVISIT"; // local node effort budget exhausted — mark revisit

/** The 14-action enum from ai.ts reused by the decision engine for remediation actions. */
export type NodeDecisionAction =
  | "CONTINUE_SAME_NODE"
  | "COMPLETE_NODE"
  | "GUIDED_QUESTION"
  | "HINT"
  | "EXTRA_EXAMPLE"
  | "CONTRAST_EXAMPLE"
  | "CHANGE_REPRESENTATION"
  | "STEP_BY_STEP"
  | "SIMPLIFY_LANGUAGE"
  | "LOWER_DIFFICULTY"
  | "RAISE_DIFFICULTY"
  | "RETURN_TO_PREREQUISITE"
  | "VERIFY_SELECTION"
  | "REQUIRE_REASONING";

export interface PedagogicalDecision {
  // ── What to do at the pedagogical workflow level ─────────────────────────
  metaAction: PedagogicalMetaAction;

  /**
   * For CONTINUE_COGNITIVE_LEVEL: which remediation action to pass to the AI.
   * For all other metaActions: null (action is implicit in the metaAction).
   */
  remediationAction: NodeDecisionAction | null;

  // ── Explanation (for AI prompt injection and logging) ────────────────────
  reasonCode: string;

  // ── Cognitive state (for prompt context + logging) ───────────────────────
  currentCognitiveLevel: string | null;
  targetCognitiveLevel: string | null;

  // ── State updates the caller MUST apply ──────────────────────────────────
  newRemediationStep: number;
  /** Set to next-level row id when metaAction = ADVANCE_COGNITIVE_LEVEL. */
  newActiveCognitiveLevelId: number | null;
  /** true → caller must write demonstratedCognitiveLevel on knowledge_nodes. */
  levelConfirmed: boolean;
  /** The cognitive level string being confirmed (when levelConfirmed=true). */
  confirmedLevel: string | null;
  /** Derived: demonstratedCognitiveLevel === ceiling level's cognitiveLevel. */
  targetReached: boolean;
  /** true → caller must set knowledge_nodes.revisit_required = true. */
  revisitRequired: boolean;
  /**
   * Why the node needs revisiting. null when revisitRequired=false.
   * Typed at application layer. Allowed values:
   *   REMEDIATION_EXHAUSTED  — remediationStep hit MAX_REMEDIATION_STEPS
   *   LOCAL_BUDGET_EXHAUSTED — local node effort budget ran out
   *   SESSION_TIME_LIMIT     — session ended (set by R4A.3, not this round)
   */
  revisitReason: "REMEDIATION_EXHAUSTED" | "LOCAL_BUDGET_EXHAUSTED" | "SESSION_TIME_LIMIT" | null;

  // ── Invariant checks ─────────────────────────────────────────────────────
  preserveActiveTask: boolean;
  /**
   * true only when metaAction = COMPLETE_NODE.
   * Code calls advanceNodeInSession(); AI does NOT make this decision.
   */
  mayCompleteMicroNode: boolean;
  /** false whenever levelConfirmed=false or targetReached=false. */
  mayWriteMastery: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function qualityRank(q: string | null): number {
  switch (q) {
    case "CONCLUSIVE": return 5;
    case "STRONG":     return 4;
    case "MODERATE":   return 3;
    case "WEAK":       return 2;
    case "NONE":       return 1;
    default:           return 0;
  }
}

function betterQuality(
  a: string | null, b: string | null
): "NONE" | "WEAK" | "MODERATE" | "STRONG" | "CONCLUSIVE" | null {
  if (qualityRank(a) >= qualityRank(b)) return (a ?? null) as any;
  return (b ?? null) as any;
}

/** An answer is "independent" when the student needed minimal help. */
function isIndependent(input: PedagogicalDecisionInput): boolean {
  const { activeHelpCount, activeAssistanceLevel } = input;
  // Threshold: at most 1 help event AND assistance no deeper than 'light'
  return (
    activeHelpCount <= 1 &&
    (activeAssistanceLevel === "none" || activeAssistanceLevel === "light")
  );
}

/** The answer meets the quality bar for evidence confirmation. */
function qualityMeetsGate(q: string | null): boolean {
  return q === "MODERATE" || q === "STRONG" || q === "CONCLUSIVE";
}

/** Find the next applicable level in the path after the given id. */
function nextLevel(
  path: CognitiveLevelRow[],
  currentId: number | null
): CognitiveLevelRow | null {
  if (!currentId) return path.find((r) => r.isApplicable) ?? null;
  const idx = path.findIndex((r) => r.id === currentId);
  if (idx === -1) return null;
  for (let i = idx + 1; i < path.length; i++) {
    if (path[i].isApplicable) return path[i];
  }
  return null; // current is last applicable
}

/** Find the ceiling row in the path. */
function ceilingLevel(path: CognitiveLevelRow[]): CognitiveLevelRow | null {
  return path.find((r) => r.isTargetCeiling && r.isApplicable) ?? null;
}

/**
 * Map error family + remediation step to the best remediation action.
 * Mirrors the prompt guidance in ai.ts but now owned by code.
 */
function mapErrorFamilyToAction(
  errorFamily: string | null,
  remediationStep: number
): NodeDecisionAction {
  // After step 3, always offer guided support regardless of family
  if (remediationStep >= 3) {
    if (errorFamily === "PREREQUISITE") return "RETURN_TO_PREREQUISITE";
    if (errorFamily === "PROCEDURAL") return "STEP_BY_STEP";
    return "GUIDED_QUESTION";
  }

  // After step 4, prerequisite check / simplification
  if (remediationStep >= 4) {
    if (errorFamily === "PREREQUISITE") return "RETURN_TO_PREREQUISITE";
    return "LOWER_DIFFICULTY";
  }

  switch (errorFamily) {
    case "CONCEPTUAL":
      return remediationStep <= 1 ? "EXTRA_EXAMPLE" : "CONTRAST_EXAMPLE";
    case "PREREQUISITE":
      return "RETURN_TO_PREREQUISITE";
    case "PROCEDURAL":
      return "STEP_BY_STEP";
    case "CALCULATION_EXECUTION":
      return "VERIFY_SELECTION";
    case "READING_LANGUAGE":
      return "SIMPLIFY_LANGUAGE";
    case "ATTENTION_RESPONSE":
      return "VERIFY_SELECTION";
    case "GUESSING_CONFIDENCE":
      return "REQUIRE_REASONING";
    case "INCOMPLETE_COMMUNICATION":
      return "GUIDED_QUESTION";
    case "TRANSFER_BLOOM":
      return "CHANGE_REPRESENTATION";
    case "COGNITIVE_LOAD_PACE":
      return remediationStep >= 2 ? "LOWER_DIFFICULTY" : "RAISE_DIFFICULTY";
    default:
      // Null or unknown family — use generic escalation
      return remediationStep <= 1 ? "EXTRA_EXAMPLE" : "GUIDED_QUESTION";
  }
}

// ── R4A Helper functions ────────────────────────────────────────────────────

/**
 * Compute whether the session's required learning budget is exhausted.
 *
 * Pure function — takes direct values, no DB.
 * Returns false when requiredSessionMinutes is null (no budget configured).
 *
 * Invariant: a null budget preserves pre-R4A unlimited-session semantics.
 */
export function computeSessionBudgetExhausted(
  requiredSessionMinutes: number | null | undefined,
  activeLearningSeconds: number
): boolean {
  if (requiredSessionMinutes == null) return false;
  return activeLearningSeconds >= requiredSessionMinutes * 60;
}

/**
 * Compute whether the local MicroNode effort budget is exhausted.
 *
 * V1 POLICY GAP — always returns false.
 *
 * nodeStartedAt is wall-clock, not active learning time, so it cannot safely
 * proxy per-node active effort (see R4A design Part 16).  Until a dedicated
 * per-node active-seconds counter is added and a justified threshold is
 * approved, this function is a deterministic no-op.
 *
 * To enable this in a future round:
 *   1. Add nodeActiveLearningSeconds to lesson_sessions.
 *   2. Establish a justified N× multiplier of estimatedMinutes as threshold.
 *   3. Replace the body below and remove the policy-gap note.
 *
 * The caller always passes the inputs so the interface is stable.
 */
export function computeLocalNodeBudget(
  _nodeEstimatedMinutes: number,
  _nodeActiveLearningSeconds: number
): boolean {
  // V1: policy not yet established — never blocks remediation.
  return false;
}

// ── Main function ──────────────────────────────────────────────────────────

/**
 * Decide the next pedagogical action given the current learner state.
 *
 * Called by chat.ts after an ANSWER has been evaluated.
 * For non-ANSWER intents the caller must return early and NOT call this.
 *
 * Decision ordering (Part 12 contract):
 *  1. Validate evidence (Guards 1–2)
 *  2. Preserve confirmed level advances (Cases A confirmed, complete/advance)
 *  3. Session budget gate (fires only when evidence did NOT confirm)
 *  4. Local node effort gate (fires only when session is not exhausted)
 *  5. R3 remediation / MAX_REMEDIATION_STEPS ceiling
 */
export function decideNextPedagogicalAction(
  input: PedagogicalDecisionInput
): PedagogicalDecision {

  const {
    activeCognitiveLevelRow,
    cognitivePath,
    answerStatus,
    evidenceQuality,
    errorFamily,
    remediationStep,
    nextNodeHasCriticalDependencyOnCurrentNode,
    levelEvidenceSummary,
    sessionBudgetExhausted,
    localNodeBudgetExhausted,
  } = input;

  const currentLevel    = activeCognitiveLevelRow?.cognitiveLevel ?? null;
  const ceilingRow      = ceilingLevel(cognitivePath);
  const targetLevel     = ceilingRow?.cognitiveLevel ?? null;

  // ── Guard 1: non-ANSWER intent ───────────────────────────────────────────
  if (
    answerStatus === null ||
    answerStatus === "NOT_APPLICABLE" ||
    answerStatus === "OFF_TOPIC"
  ) {
    return {
      metaAction:              "NON_ANSWER",
      remediationAction:       null,
      reasonCode:              "NON_ANSWER_INTENT",
      currentCognitiveLevel:   currentLevel,
      targetCognitiveLevel:    targetLevel,
      newRemediationStep:      remediationStep, // unchanged
      newActiveCognitiveLevelId: null,
      levelConfirmed:          false,
      confirmedLevel:          null,
      targetReached:           false,
      revisitRequired:         false,
      revisitReason:           null,
      preserveActiveTask:      true,
      mayCompleteMicroNode:    false,
      mayWriteMastery:         false,
    };
  }

  // ── Guard 2: no confirmed cognitive path ─────────────────────────────────
  if (cognitivePath.length === 0 || !activeCognitiveLevelRow) {
    return {
      metaAction:              "NO_COGNITIVE_PATH",
      remediationAction:       null,
      reasonCode:              "NO_CONFIRMED_COGNITIVE_PATH",
      currentCognitiveLevel:   null,
      targetCognitiveLevel:    null,
      newRemediationStep:      remediationStep,
      newActiveCognitiveLevelId: null,
      levelConfirmed:          false,
      confirmedLevel:          null,
      targetReached:           false,
      revisitRequired:         false,
      revisitReason:           null,
      preserveActiveTask:      true,
      mayCompleteMicroNode:    false,
      mayWriteMastery:         false,
    };
  }

  const independent    = isIndependent(input);
  const isCorrect      = answerStatus === "CORRECT";
  const isPartial      = answerStatus === "PARTIALLY_CORRECT";
  const meetsQuality   = qualityMeetsGate(evidenceQuality);
  const minRequired    = activeCognitiveLevelRow.minimumIndependentEvidence;

  // ── Compute how many independent-correct turns exist for this level ───────
  // Include the CURRENT turn if it qualifies as independent-correct.
  const existingIndependentCorrect = levelEvidenceSummary?.independentCorrectCount ?? 0;
  const currentTurnAddsIndependent = isCorrect && independent && meetsQuality;
  const totalIndependentCorrect    = existingIndependentCorrect +
    (currentTurnAddsIndependent ? 1 : 0);
  const currentBestQuality = currentTurnAddsIndependent
    ? betterQuality(levelEvidenceSummary?.bestQuality ?? null, evidenceQuality)
    : levelEvidenceSummary?.bestQuality ?? null;

  // ── CASE A: Correct + independent + quality meets gate ───────────────────
  if (isCorrect && independent && meetsQuality) {
    if (totalIndependentCorrect >= minRequired) {
      // Level CONFIRMED ✅ — write evidence REGARDLESS of session budget.
      // Invariant (Part 12, step 2): confirmed evidence is always preserved.
      const nextLvl         = nextLevel(cognitivePath, activeCognitiveLevelRow.id);
      const isAtCeiling     = activeCognitiveLevelRow.isTargetCeiling;
      const targetNowReached = isAtCeiling; // ceiling just confirmed

      if (targetNowReached) {
        // All levels through ceiling confirmed → COMPLETE_NODE
        return {
          metaAction:              "COMPLETE_NODE",
          remediationAction:       null,
          reasonCode:              "TARGET_CEILING_CONFIRMED",
          currentCognitiveLevel:   currentLevel,
          targetCognitiveLevel:    targetLevel,
          newRemediationStep:      0,
          newActiveCognitiveLevelId: null,
          levelConfirmed:          true,
          confirmedLevel:          currentLevel,
          targetReached:           true,
          revisitRequired:         false,
          revisitReason:           null,
          preserveActiveTask:      false,
          mayCompleteMicroNode:    true,  // code will call advanceNodeInSession
          mayWriteMastery:         true,
        };
      }

      // Advance to next cognitive level
      return {
        metaAction:              "ADVANCE_COGNITIVE_LEVEL",
        remediationAction:       null,
        reasonCode:              "LEVEL_CONFIRMED_ADVANCE",
        currentCognitiveLevel:   currentLevel,
        targetCognitiveLevel:    targetLevel,
        newRemediationStep:      0,
        newActiveCognitiveLevelId: nextLvl?.id ?? null,
        levelConfirmed:          true,
        confirmedLevel:          currentLevel,
        targetReached:           false,
        revisitRequired:         false,
        revisitReason:           null,
        preserveActiveTask:      false, // new level → new task
        mayCompleteMicroNode:    false,
        mayWriteMastery:         false,
      };
    }

    // Correct but not enough independent evidence yet — need more turns.
    // ── R4A.2 Step 3: Session budget gate ───────────────────────────────────
    // No level was confirmed on this turn, so the budget check fires here.
    // TIME LIMIT ≠ FAILURE — no negative evidence written.
    if (sessionBudgetExhausted) {
      return {
        metaAction:              "END_REQUIRED_SESSION",
        remediationAction:       null,
        reasonCode:              "SESSION_BUDGET_EXHAUSTED_NEEDS_MORE_EVIDENCE",
        currentCognitiveLevel:   currentLevel,
        targetCognitiveLevel:    targetLevel,
        newRemediationStep:      remediationStep, // unchanged — no failure
        newActiveCognitiveLevelId: null,
        levelConfirmed:          false,
        confirmedLevel:          null,
        targetReached:           false,
        revisitRequired:         false, // not a failure — no revisit marker
        revisitReason:           null,
        preserveActiveTask:      true,
        mayCompleteMicroNode:    false,
        mayWriteMastery:         false,
      };
    }

    // Need more turns — continue same level
    return {
      metaAction:              "CONTINUE_COGNITIVE_LEVEL",
      remediationAction:       "CONTINUE_SAME_NODE",
      reasonCode:              "CORRECT_NEED_MORE_EVIDENCE",
      currentCognitiveLevel:   currentLevel,
      targetCognitiveLevel:    targetLevel,
      newRemediationStep:      0, // correct answer resets step
      newActiveCognitiveLevelId: null,
      levelConfirmed:          false,
      confirmedLevel:          null,
      targetReached:           false,
      revisitRequired:         false,
      revisitReason:           null,
      preserveActiveTask:      true, // stay on same task type
      mayCompleteMicroNode:    false,
      mayWriteMastery:         false,
    };
  }

  // ── CASE B: Correct but heavily assisted (supported success) ─────────────
  if ((isCorrect || isPartial) && !independent && meetsQuality) {
    // ── R4A.2 Step 3: Session budget gate ────────────────────────────────────
    if (sessionBudgetExhausted) {
      return {
        metaAction:              "END_REQUIRED_SESSION",
        remediationAction:       null,
        reasonCode:              "SESSION_BUDGET_EXHAUSTED_AFTER_HELPED_SUCCESS",
        currentCognitiveLevel:   currentLevel,
        targetCognitiveLevel:    targetLevel,
        newRemediationStep:      remediationStep, // unchanged
        newActiveCognitiveLevelId: null,
        levelConfirmed:          false,
        confirmedLevel:          null,
        targetReached:           false,
        revisitRequired:         false, // assisted success with time-out ≠ failure
        revisitReason:           null,
        preserveActiveTask:      true,
        mayCompleteMicroNode:    false,
        mayWriteMastery:         false,
      };
    }

    return {
      metaAction:              "REQUEST_INDEPENDENT_CHECK",
      remediationAction:       "CONTINUE_SAME_NODE",
      reasonCode:              "HELPED_SUCCESS_NEED_INDEPENDENT_VERIFICATION",
      currentCognitiveLevel:   currentLevel,
      targetCognitiveLevel:    targetLevel,
      newRemediationStep:      0, // supported success is positive — don't escalate
      newActiveCognitiveLevelId: null,
      levelConfirmed:          false,  // not confirmed until independent
      confirmedLevel:          null,
      targetReached:           false,
      revisitRequired:         false,
      revisitReason:           null,
      preserveActiveTask:      false, // new equivalent task needed
      mayCompleteMicroNode:    false,
      mayWriteMastery:         false,
    };
  }

  // ── CASE C: Incorrect / partial / poor quality → remediation ─────────────
  //
  // Steps 3–5 of the decision ordering apply here:
  //   3. Session budget gate
  //   4. Local node effort gate
  //   5. R3 MAX_REMEDIATION_STEPS ceiling, then remediation action

  // ── Step 3: Session budget gate ─────────────────────────────────────────
  // TIME LIMIT ≠ FAILURE — do NOT write incorrect-answer evidence, do NOT
  // increment fail count, do NOT lower demonstrated cognitive level.
  if (sessionBudgetExhausted) {
    return {
      metaAction:              "END_REQUIRED_SESSION",
      remediationAction:       null,
      reasonCode:              "SESSION_BUDGET_EXHAUSTED_INCORRECT",
      currentCognitiveLevel:   currentLevel,
      targetCognitiveLevel:    targetLevel,
      newRemediationStep:      remediationStep, // NOT incremented — time-out ≠ fail
      newActiveCognitiveLevelId: null,
      levelConfirmed:          false,
      confirmedLevel:          null,
      targetReached:           false,
      revisitRequired:         false, // unattempted/unconfirmed ≠ failed
      revisitReason:           null,
      preserveActiveTask:      true,
      mayCompleteMicroNode:    false,
      mayWriteMastery:         false,
    };
  }

  const nextRemediationStep = remediationStep + 1;

  // ── Step 4: Local node effort gate ──────────────────────────────────────
  // Can stop remediation BEFORE MAX_REMEDIATION_STEPS.
  // Currently always false (V1 policy gap — see computeLocalNodeBudget).
  if (localNodeBudgetExhausted) {
    const blocked = nextNodeHasCriticalDependencyOnCurrentNode;
    return {
      metaAction:              "STOP_LEVEL_AND_REVISIT",
      remediationAction:       null,
      reasonCode:              "LOCAL_BUDGET_EXHAUSTED",
      currentCognitiveLevel:   currentLevel,
      targetCognitiveLevel:    targetLevel,
      newRemediationStep:      0,  // reset for resumed teaching
      newActiveCognitiveLevelId: null,
      levelConfirmed:          false,
      confirmedLevel:          null,
      targetReached:           false,
      revisitRequired:         true,
      revisitReason:           "LOCAL_BUDGET_EXHAUSTED",
      preserveActiveTask:      blocked,
      mayCompleteMicroNode:    !blocked,
      mayWriteMastery:         false,
    };
  }

  // ── Step 5: R3 hard ceiling (MAX_REMEDIATION_STEPS) ────────────────────
  if (nextRemediationStep > MAX_REMEDIATION_STEPS) {
    // Learner actually attempted the level and bounded remediation failed.
    const blocked = nextNodeHasCriticalDependencyOnCurrentNode;
    return {
      metaAction:              blocked ? "REVISIT_LATER" : "MARK_TARGET_NOT_REACHED",
      remediationAction:       null,
      reasonCode:              blocked
        ? "BUDGET_EXHAUSTED_BLOCKED_BY_DEPENDENCY"
        : "BUDGET_EXHAUSTED_MAY_ADVANCE",
      currentCognitiveLevel:   currentLevel,
      targetCognitiveLevel:    targetLevel,
      newRemediationStep:      0,  // reset for any continued teaching
      newActiveCognitiveLevelId: null,
      levelConfirmed:          false,
      confirmedLevel:          null,
      targetReached:           false,
      revisitRequired:         true,  // write knowledge_nodes.revisit_required
      revisitReason:           "REMEDIATION_EXHAUSTED",
      preserveActiveTask:      blocked, // blocked: stay; can-advance: move on
      mayCompleteMicroNode:    !blocked, // can advance to next MicroNode safely
      mayWriteMastery:         false,
    };
  }

  // Budget not exhausted — apply error-family remediation.
  // Pass the CURRENT step (before incrementing) so the escalation table is
  // relative to "how many attempts have already happened", not "what step are
  // we about to write". Step 0 = first fail, step 1 = second fail, etc.
  const action = mapErrorFamilyToAction(errorFamily, remediationStep);

  return {
    metaAction:              "CONTINUE_COGNITIVE_LEVEL",
    remediationAction:       action,
    reasonCode:              `REMEDIATION_STEP_${nextRemediationStep}_${errorFamily ?? "UNKNOWN"}`,
    currentCognitiveLevel:   currentLevel,
    targetCognitiveLevel:    targetLevel,
    newRemediationStep:      nextRemediationStep,
    newActiveCognitiveLevelId: null,
    levelConfirmed:          false,
    confirmedLevel:          null,
    targetReached:           false,
    revisitRequired:         false,
    revisitReason:           null,
    preserveActiveTask:      true,
    mayCompleteMicroNode:    false,
    mayWriteMastery:         false,
  };
}
