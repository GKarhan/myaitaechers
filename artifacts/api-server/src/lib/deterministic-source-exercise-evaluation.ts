import {
  normalizeMultipleChoiceAnswer,
  normalizeSourceExerciseAnswerContract,
  normalizeTrueFalseAnswer,
} from "./source-exercise-answer.js";

export type DeterministicSourceExerciseEvaluationInput = {
  learnerIntent: string;
  activeTaskProvenance: string | null;
  activeLessonExerciseId: number | null;
  exerciseId: string | null;
  interactionType: unknown;
  correctAnswer: unknown;
  studentAnswer: string;
};

export type DeterministicSourceExerciseEvaluation = {
  lessonExerciseId: number;
  exerciseId: string | null;
  interactionType: "multiple_choice" | "true_false";
  normalizedAnswer: "A" | "B" | "C" | "D" | "TRUE" | "FALSE";
  canonicalCorrectAnswer: "A" | "B" | "C" | "D" | "TRUE" | "FALSE";
  status: "CORRECT" | "INCORRECT";
  evidenceQuality: "STRONG" | "NONE";
};

type CanonicalTypedAnswer = "A" | "B" | "C" | "D" | "TRUE" | "FALSE";

export function canEvaluateSourceExerciseDeterministically(input: {
  interactionType: unknown;
  correctAnswer: unknown;
}): boolean {
  const contract = normalizeSourceExerciseAnswerContract(input);
  return (
    contract.ok &&
    (contract.interactionType === "multiple_choice" ||
      contract.interactionType === "true_false") &&
    contract.correctAnswer !== null
  );
}

/**
 * Deterministically evaluates only an active, typed source exercise.
 *
 * A null result is intentional for non-answer intents, other task provenances,
 * missing IDs, invalid metadata, constructed responses, legacy exercises, or
 * non-canonical learner tokens. Those cases remain on the existing AI path.
 */
export function evaluateDeterministicSourceExerciseAnswer(
  input: DeterministicSourceExerciseEvaluationInput,
): DeterministicSourceExerciseEvaluation | null {
  if (
    input.learnerIntent !== "ANSWER" ||
    input.activeTaskProvenance !== "source_exercise" ||
    input.activeLessonExerciseId == null
  ) {
    return null;
  }

  const contract = normalizeSourceExerciseAnswerContract({
    interactionType: input.interactionType,
    correctAnswer: input.correctAnswer,
  });
  if (!contract.ok) {
    return null;
  }
  if (!canEvaluateSourceExerciseDeterministically({
    interactionType: input.interactionType,
    correctAnswer: input.correctAnswer,
  })) {
    return null;
  }
  if (
    (contract.interactionType !== "multiple_choice" &&
      contract.interactionType !== "true_false") ||
    contract.correctAnswer === null
  ) {
    return null;
  }

  const normalizedAnswer =
    contract.interactionType === "multiple_choice"
      ? normalizeMultipleChoiceAnswer(input.studentAnswer)
      : normalizeTrueFalseAnswer(input.studentAnswer);
  if (normalizedAnswer === null) return null;

  // The validated Task 82 contract has already canonicalized these values to
  // the supported option / true-false token set.
  const canonicalCorrectAnswer = contract.correctAnswer as CanonicalTypedAnswer;
  const status = normalizedAnswer === canonicalCorrectAnswer
    ? "CORRECT"
    : "INCORRECT";

  return {
    lessonExerciseId: input.activeLessonExerciseId,
    exerciseId: input.exerciseId,
    interactionType: contract.interactionType,
    normalizedAnswer,
    canonicalCorrectAnswer,
    status,
    evidenceQuality: status === "CORRECT" ? "STRONG" : "NONE",
  };
}