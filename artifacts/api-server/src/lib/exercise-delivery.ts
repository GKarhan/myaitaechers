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
