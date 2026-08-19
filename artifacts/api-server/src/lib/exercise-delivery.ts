/**
 * P1.6B — Authoring-view exercise text resolver.
 *
 * Single authoritative rule:
 *   exerciseTextEdited (trimmed, non-empty) → learner-facing text
 *   otherwise                               → exerciseTextVerbatim
 *
 * Learner delivery must use resolveLearnerExerciseContent() from
 * exercise-content-boundary.ts. This legacy helper remains for teacher review
 * and non-learner compatibility paths only.
 */
export function effectiveExerciseText(
  exerciseTextVerbatim: string,
  exerciseTextEdited: string | null | undefined,
): string {
  const edited = exerciseTextEdited?.trim();
  return edited ? edited : exerciseTextVerbatim;
}

/**
 * A source exercise is selected only from the caller's already-eligible set.
 * `exerciseId` is the external textbook identifier; `id` is the persisted
 * lesson_exercises primary key stored on the active lesson session.
 */
export type EligibleSourceExercise = {
  id: number;
  exerciseId: string | null;
};

export type SourceExerciseResolution<T extends EligibleSourceExercise> = {
  selected: T | null;
  requestedExerciseId: string | null;
  resolution:
    | "requested_eligible"
    | "requested_not_eligible_fallback"
    | "first_eligible_fallback"
    | "no_eligible_exercise";
};

/**
 * Resolve an AI-requested external exercise ID within the current eligible
 * CLASS exercise set. The model never gets to activate a row outside that set.
 *
 * A missing or ineligible request preserves the existing safe behavior by
 * falling back to the first actual eligible row. The returned row—not the
 * requested string—is the only identity callers may persist or deliver.
 */
export function resolveEligibleSourceExercise<T extends EligibleSourceExercise>(
  eligibleExercises: readonly T[],
  requestedExerciseId: string | null | undefined,
): SourceExerciseResolution<T> {
  const requested = requestedExerciseId?.trim() || null;
  if (requested) {
    const requestedEligibleExercise = eligibleExercises.find(
      (exercise) => exercise.exerciseId?.trim() === requested,
    );
    if (requestedEligibleExercise) {
      return {
        selected: requestedEligibleExercise,
        requestedExerciseId: requested,
        resolution: "requested_eligible",
      };
    }
    return {
      selected: eligibleExercises[0] ?? null,
      requestedExerciseId: requested,
      resolution: eligibleExercises.length > 0
        ? "requested_not_eligible_fallback"
        : "no_eligible_exercise",
    };
  }

  return {
    selected: eligibleExercises[0] ?? null,
    requestedExerciseId: null,
    resolution: eligibleExercises.length > 0
      ? "first_eligible_fallback"
      : "no_eligible_exercise",
  };
}

/**
 * V2-R1.1 may deliver a standalone exercise only when P11.1 has not already
 * placed the same active source exercise in the primary assistant message.
 */
export function shouldDeliverStandaloneSourceExercise(
  hasAutoContinue: boolean,
  activeLessonExerciseId: number | null | undefined,
  sourceExerciseAlreadyDeliveredThisTurn: boolean,
): boolean {
  return hasAutoContinue
    && activeLessonExerciseId != null
    && !sourceExerciseAlreadyDeliveredThisTurn;
}

/**
 * Phase 11.1 — Exercise Delivery Enforcement
 *
 * Backend authority over verbatim textbook exercise delivery.
 *
 * Invariant: when the current teaching turn is a CLASS exercise delivery turn
 * (phase=2, stage=MICRO_CHECK, classExercises present), the final
 * student-visible message MUST contain the exact exerciseTextVerbatim from the
 * DB row — regardless of what the AI model returned in student_message.
 *
 * Enforcement is keyed on backend state (phase + nodeTeachingStage + exercises),
 * NOT on the model's teaching_mode.  The model may return TEACH, FEEDBACK,
 * MICRO_CHECK, or any other mode; the invariant still holds.
 *
 * This module is pure and side-effect-free.
 * It must NOT advance state, change nodeId, touch mastery, or modify the KB.
 */

/**
 * Ensure `studentMessage` contains the verbatim exercise text.
 *
 * If `verbatimEx` is empty/null → returns `studentMessage` unchanged (no-op).
 * If `studentMessage` already contains `verbatimEx` → returns unchanged (no dup).
 * Otherwise → appends verbatimEx after a blank line separator.
 *
 * The function never modifies `verbatimEx` itself; it is always byte-for-byte.
 */
export function enforceVerbatimExercise(
  studentMessage: string,
  verbatimEx: string | null | undefined,
): string {
  const v = verbatimEx?.trim();
  if (!v) return studentMessage;
  if (studentMessage.includes(v)) return studentMessage;
  return studentMessage.trimEnd() + "\n\n" + v;
}

/**
 * Produce one backend-owned source-exercise delivery.
 *
 * Before placing the active text in the learner-visible response, remove any
 * exact verbatim text belonging to the other currently eligible exercises.
 * This is defense in depth for an AI response that ignored the directive not
 * to render a source exercise itself.
 */
export function enforceActiveSourceExercise(
  studentMessage: string,
  activeExerciseText: string | null | undefined,
  otherEligibleExerciseTexts: readonly (string | null | undefined)[],
): string {
  const active = activeExerciseText?.trim();
  const otherTexts = [...new Set(
    otherEligibleExerciseTexts
      .map((text) => text?.trim())
      .filter((text): text is string => Boolean(text) && text !== active),
  )].sort((a, b) => b.length - a.length);

  const withoutOtherEligibleExercises = otherTexts.reduce(
    (message, otherText) => message.split(otherText).join(""),
    studentMessage,
  );

  return enforceVerbatimExercise(withoutOtherEligibleExercises, active);
}

/**
 * Returns true when the current turn is an exercise delivery turn requiring
 * verbatim enforcement.
 *
 * Enforcement fires on backend state alone — independent of the AI model's
 * teaching_mode output.  When all three conditions hold, the backend is
 * authoritative over what the student sees.
 *
 * Conditions (all must hold):
 *   - Phase 2 teaching session
 *   - Current nodeTeachingStage is "MICRO_CHECK" (the exercise presentation turn)
 *   - At least one CLASS exercise exists for the current node
 */
export function isExerciseDeliveryTurn(
  phase: number,
  nodeTeachingStage: string,
  classExerciseCount: number,
): boolean {
  return (
    phase === 2 &&
    nodeTeachingStage === "MICRO_CHECK" &&
    classExerciseCount > 0
  );
}
