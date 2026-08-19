export const EXERCISE_CONTENT_ISSUE = {
  EMPTY_LEARNER_TEXT: "empty-learner-text",
  EXPLICIT_ANSWER_KEY: "explicit-answer-key",
  EXPECTED_ANSWER_GUIDANCE: "expected-answer-guidance",
  EVALUATOR_RUBRIC_GUIDANCE: "evaluator-rubric-guidance",
  SUCCESS_CRITERIA_EXPOSED: "success-criteria-exposed",
  DETERMINISTIC_ANSWER_EXPOSED: "deterministic-answer-exposed",
} as const;

export type ExerciseContentIssueCode =
  typeof EXERCISE_CONTENT_ISSUE[keyof typeof EXERCISE_CONTENT_ISSUE];

export type ExerciseContentIssue = {
  code: ExerciseContentIssueCode;
  message: string;
};

export type ExerciseContentBoundaryInput = {
  exerciseTextVerbatim: unknown;
  exerciseTextEdited?: unknown;
  successCriteria?: unknown;
  correctAnswer?: unknown;
};

export type LearnerExerciseContentResolution =
  | {
      ok: true;
      learnerText: string;
      source: "edited" | "validated_verbatim_fallback";
      issues: [];
      reviewWarnings: string[];
    }
  | {
      ok: false;
      learnerText: null;
      source: "edited" | "validated_verbatim_fallback";
      issues: ExerciseContentIssue[];
      reviewWarnings: string[];
    };

const EXPLICIT_ANSWER_KEY =
  /(?:ճիշտ\s+պատասխան(?:ը|ները|ն)?|պատասխանի\s+բանալին|correct\s+answer|answer\s+key|правильн(?:ый|ого)\s+ответ)\s*[:՝․.-]/iu;
const EXPECTED_ANSWER_GUIDANCE =
  /(?:սպասվող\s+պատասխան(?:ի|ը|ը՝)?|պատասխանի\s+հիմնական\s+միտքը|expected\s+answer|model\s+answer|sample\s+answer)\s*[:՝․.-]/iu;
const EVALUATOR_RUBRIC_GUIDANCE =
  /(?:հաջող\s+պատասխանը\s+պետք\s+է\s+ներառի|գնահատման\s+(?:չափանիշ|ուղեցույց)|գնահատող(?:ի|ին)\s+ուղեցույց|evaluation\s+criteria|grading\s+rubric|scoring\s+rubric)\s*[:՝․.-]?/iu;

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizedComparableText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesSubstantialHiddenText(
  learnerText: string,
  hiddenText: string | null,
): boolean {
  if (!hiddenText) return false;
  const normalizedLearner = normalizedComparableText(learnerText);
  const normalizedHidden = normalizedComparableText(hiddenText);
  return normalizedHidden.length >= 24 && normalizedLearner.includes(normalizedHidden);
}

export function validateLearnerExerciseText(input: {
  learnerText: unknown;
  successCriteria?: unknown;
  correctAnswer?: unknown;
}): { ok: boolean; issues: ExerciseContentIssue[] } {
  const learnerText = textOrNull(input.learnerText);
  const issues: ExerciseContentIssue[] = [];

  if (!learnerText) {
    issues.push({
      code: EXERCISE_CONTENT_ISSUE.EMPTY_LEARNER_TEXT,
      message: "Learner-facing exercise text is required.",
    });
    return { ok: false, issues };
  }

  if (EXPLICIT_ANSWER_KEY.test(learnerText)) {
    issues.push({
      code: EXERCISE_CONTENT_ISSUE.EXPLICIT_ANSWER_KEY,
      message: "Learner-facing text contains an explicit answer key.",
    });
  }
  if (EXPECTED_ANSWER_GUIDANCE.test(learnerText)) {
    issues.push({
      code: EXERCISE_CONTENT_ISSUE.EXPECTED_ANSWER_GUIDANCE,
      message: "Learner-facing text contains expected-answer guidance.",
    });
  }
  if (EVALUATOR_RUBRIC_GUIDANCE.test(learnerText)) {
    issues.push({
      code: EXERCISE_CONTENT_ISSUE.EVALUATOR_RUBRIC_GUIDANCE,
      message: "Learner-facing text contains evaluator-only rubric guidance.",
    });
  }

  const successCriteria = textOrNull(input.successCriteria);
  if (includesSubstantialHiddenText(learnerText, successCriteria)) {
    issues.push({
      code: EXERCISE_CONTENT_ISSUE.SUCCESS_CRITERIA_EXPOSED,
      message: "Learner-facing text repeats hidden success criteria.",
    });
  }

  const correctAnswer = textOrNull(input.correctAnswer);
  if (
    correctAnswer &&
    normalizedComparableText(correctAnswer).length >= 12 &&
    includesSubstantialHiddenText(learnerText, correctAnswer)
  ) {
    issues.push({
      code: EXERCISE_CONTENT_ISSUE.DETERMINISTIC_ANSWER_EXPOSED,
      message: "Learner-facing text repeats the deterministic answer.",
    });
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Resolves the only text that may cross a learner boundary.
 *
 * New authoring stores validated learner text in exerciseTextEdited. Historical
 * rows may fall back to verbatim only when that exact text independently passes
 * the same validation; verbatim is never assumed safe merely because it exists.
 */
export function resolveLearnerExerciseContent(
  input: ExerciseContentBoundaryInput,
): LearnerExerciseContentResolution {
  const edited = textOrNull(input.exerciseTextEdited);
  const verbatim = textOrNull(input.exerciseTextVerbatim);
  const source = edited ? "edited" : "validated_verbatim_fallback";
  const candidate = edited ?? verbatim;
  const validation = validateLearnerExerciseText({
    learnerText: candidate,
    successCriteria: input.successCriteria,
    correctAnswer: input.correctAnswer,
  });
  const reviewWarnings = edited ? [] : ["learner-text-not-persisted"];

  if (!validation.ok || !candidate) {
    return {
      ok: false,
      learnerText: null,
      source,
      issues: validation.issues,
      reviewWarnings,
    };
  }

  return {
    ok: true,
    learnerText: candidate,
    source,
    issues: [],
    reviewWarnings,
  };
}

/**
 * A mechanically safe legacy fallback is still authoring-review content, not a
 * learner-deliverable task. Student-facing paths must require a persisted
 * learner representation.
 */
export function isLearnerDeliveryEligible(
  resolution: LearnerExerciseContentResolution,
): resolution is Extract<LearnerExerciseContentResolution, { ok: true }> & { source: "edited" } {
  return resolution.ok && resolution.source === "edited";
}

export function assertLearnerExerciseContent(
  input: ExerciseContentBoundaryInput,
): Extract<LearnerExerciseContentResolution, { ok: true }> {
  const resolution = resolveLearnerExerciseContent(input);
  if (!resolution.ok) {
    const error = new Error(
      `Unsafe learner exercise content: ${resolution.issues.map((issue) => issue.code).join(", ")}`,
    );
    Object.assign(error, { code: "UNSAFE_LEARNER_EXERCISE_CONTENT", resolution });
    throw error;
  }
  return resolution;
}

export function containsHiddenExerciseContent(
  learnerFacingText: string,
  hiddenContents: readonly (string | null | undefined)[],
): boolean {
  return hiddenContents.some((hidden) =>
    includesSubstantialHiddenText(learnerFacingText, textOrNull(hidden)),
  );
}