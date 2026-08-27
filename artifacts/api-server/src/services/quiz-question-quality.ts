/**
 * T8.2B — Cognitive Question Quality Contract Foundation
 *
 * This module is intentionally pure. It owns the quality contract and
 * deterministic checks for a generated question candidate. Provider-backed
 * review and retry orchestration live in the generation service; this module
 * stays safe to use from tests and other non-provider code.
 */

export const COGNITIVE_LEVELS = [
  "remember",
  "understand",
  "apply",
  "analyze",
  "evaluate",
  "create",
] as const;
export type CognitiveLevel = (typeof COGNITIVE_LEVELS)[number];

export const QUIZ_INTERACTION_TYPES = [
  "multiple_choice",
  "multi_select",
  "true_false",
  "matching",
  "classification",
  "ordering",
  "numeric_answer",
  "short_answer",
  "constructed_response",
  "problem_solving",
] as const;
export type QuizInteractionType = (typeof QUIZ_INTERACTION_TYPES)[number];

export const CURRENT_GENERATED_INTERACTION_TYPES: readonly QuizInteractionType[] = [
  "multiple_choice",
];

export const QUIZ_DIFFICULTY_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export type QuizDifficultyLevel = (typeof QUIZ_DIFFICULTY_LEVELS)[number];

export type NormalizedQuestionCandidate = {
  questionText: string;
  options: readonly [string, string, string, string];
  correctOptionIndex: number;
  optionExplanations:
    | readonly [string | null, string | null, string | null, string | null]
    | null;
  difficultyLevel: QuizDifficultyLevel;
  nodeId: number | null;
  cognitiveLevelId: number | null;
};

export type QuestionQualityContext = {
  canonicalNodeId: number;
  canonicalCognitiveLevelId: number;
  cognitiveLevel: CognitiveLevel;
  microNodeTitle: string;
  instructionalContent: string;
  performanceObjective: string | null;
  successCriterion: string | null;
  preferredInteractionTypes: readonly string[];
  deliveryInteractionType?: QuizInteractionType;
};

export type OperationalCognitiveLevelContract = {
  requiredPerformance: string;
  validQuestionCharacteristics: readonly string[];
  rejectedLowerLevelSubstitutes: readonly string[];
  naturallyCompatibleInteractionTypes: readonly QuizInteractionType[];
};

export const COGNITIVE_LEVEL_OPERATIONAL_CONTRACTS: Readonly<
  Record<CognitiveLevel, OperationalCognitiveLevelContract>
> = {
  remember: {
    requiredPerformance:
      "Retrieve or recognize an explicitly taught fact, term, definition, relationship, rule, or step.",
    validQuestionCharacteristics: [
      "recall",
      "recognition",
      "direct identification",
    ],
    rejectedLowerLevelSubstitutes: [
      "unrelated trivia",
      "content outside the MicroNode",
      "answer-revealing or malformed questions",
    ],
    naturallyCompatibleInteractionTypes: [
      "multiple_choice",
      "true_false",
      "matching",
      "short_answer",
    ],
  },
  understand: {
    requiredPerformance:
      "Interpret meaning, explain, paraphrase, classify, connect an example to a concept, or distinguish an example from a non-example.",
    validQuestionCharacteristics: [
      "interpretation",
      "classification",
      "explanation selection",
      "example/non-example recognition",
      "conceptual relationship",
    ],
    rejectedLowerLevelSubstitutes: [
      "verbatim recall of a fact",
      "verbatim recall of a definition",
      "verbatim recall of a formula",
      "verbatim recall of an isolated statement",
    ],
    naturallyCompatibleInteractionTypes: [
      "multiple_choice",
      "multi_select",
      "matching",
      "classification",
      "short_answer",
      "constructed_response",
    ],
  },
  apply: {
    requiredPerformance:
      "Use a mapped rule, method, relationship, procedure, or concept in a concrete case.",
    validQuestionCharacteristics: [
      "calculation",
      "procedure execution",
      "scenario-based application",
      "problem solving",
      "applying a relationship to supplied values or conditions",
    ],
    rejectedLowerLevelSubstitutes: [
      "asking only for a formula",
      "asking only for a memorized unit relationship",
      "asking only for a definition",
      "asking for a worked answer copied from instructional content",
      "pure recognition without use",
    ],
    naturallyCompatibleInteractionTypes: [
      "multiple_choice",
      "numeric_answer",
      "short_answer",
      "constructed_response",
      "problem_solving",
    ],
  },
  analyze: {
    requiredPerformance:
      "Decompose information, identify relationships, compare components using evidence, distinguish structure or cause, infer relationships, or analyze an error.",
    validQuestionCharacteristics: [
      "relationship analysis",
      "evidence comparison",
      "error analysis",
      "decomposition",
      "structured classification",
      "determining why or where a solution or claim differs",
    ],
    rejectedLowerLevelSubstitutes: [
      "routine one-step application of a rule",
      "a task requiring no decomposition",
      "a task requiring no comparison",
      "a task requiring no relationship reasoning or structural analysis",
    ],
    naturallyCompatibleInteractionTypes: [
      "multiple_choice",
      "multi_select",
      "matching",
      "classification",
      "ordering",
      "constructed_response",
      "problem_solving",
    ],
  },
  evaluate: {
    requiredPerformance:
      "Make and justify a judgment using explicit criteria, evidence, correctness conditions, or competing approaches.",
    validQuestionCharacteristics: [
      "critique",
      "defensible choice",
      "evaluating a claim",
      "evaluating a method",
      "selecting a better solution and justifying why",
      "evidence-based judgment",
    ],
    rejectedLowerLevelSubstitutes: [
      "simple comparison",
      "identifying differences",
      "analysis without judgment",
      "selecting an answer without a defensible criterion",
    ],
    naturallyCompatibleInteractionTypes: [
      "short_answer",
      "constructed_response",
      "problem_solving",
    ],
  },
  create: {
    requiredPerformance:
      "Produce, design, construct, formulate, synthesize, or propose a new valid artifact, solution, plan, or model under constraints.",
    validQuestionCharacteristics: [
      "design",
      "compose",
      "construct",
      "formulate",
      "propose",
      "synthesize",
    ],
    rejectedLowerLevelSubstitutes: [
      "selecting among already completed answers",
      "merely judging an existing solution",
      "ordinary recognition-only multiple choice",
    ],
    naturallyCompatibleInteractionTypes: [
      "constructed_response",
      "problem_solving",
    ],
  },
};

export const QUALITY_REASON_CODES = [
  "INVALID_QUESTION_TEXT",
  "INVALID_OPTIONS",
  "DUPLICATE_OPTIONS",
  "INVALID_CORRECT_OPTION",
  "INVALID_OPTION_EXPLANATIONS",
  "INVALID_DIFFICULTY_LEVEL",
  "DIFFICULTY_DISTRIBUTION_MISMATCH",
  "NODE_ID_MISMATCH",
  "COGNITIVE_LEVEL_ID_MISMATCH",
  "UNSUPPORTED_INTERACTION_TYPE",
  "PREFERRED_INTERACTION_UNAVAILABLE",
  "TARGET_INTERACTION_INCOMPATIBLE",
  "DUPLICATE_QUESTION",
  "PLACEHOLDER_CONTENT",
  "MICRONODE_MISALIGNED",
  "COGNITIVE_DEMAND_TOO_LOW",
  "COGNITIVE_DEMAND_MISMATCH",
  "PERFORMANCE_OBJECTIVE_MISALIGNED",
  "SUCCESS_CRITERION_MISALIGNED",
  "SOURCE_GROUNDING_FAILED",
  "SEMANTIC_REVIEW_ERROR",
] as const;
export type QualityReasonCode = (typeof QUALITY_REASON_CODES)[number];

export type QuestionQualityResult = {
  passed: boolean;
  reasonCodes: QualityReasonCode[];
};

export class QuizQuestionQualityError extends Error {
  readonly code = "QUIZ_QUESTION_QUALITY_FAILED" as const;
  readonly nodeId: number;
  readonly reasonCodes: QualityReasonCode[];

  constructor(nodeId: number, reasonCodes: readonly QualityReasonCode[]) {
    super("QUIZ_QUESTION_QUALITY_FAILED");
    this.name = "QuizQuestionQualityError";
    this.nodeId = nodeId;
    this.reasonCodes = [...new Set(reasonCodes)].filter((reasonCode) =>
      QUALITY_REASON_CODES.includes(reasonCode),
    );
  }
}

export type SemanticQuestionReviewInput = {
  candidate: NormalizedQuestionCandidate;
  context: QuestionQualityContext;
  operationalContract: OperationalCognitiveLevelContract;
};

export type SemanticReviewVerdict = "PASS" | "FAIL" | "REVIEW_ERROR";

export type SemanticQuestionReviewResult = {
  verdict: SemanticReviewVerdict;
  reasonCodes: QualityReasonCode[];
  measuredCognitiveLevel?: CognitiveLevel;
  nodeAligned: boolean;
  objectiveAligned: boolean;
  criterionAligned: boolean;
  interactionCompatible: boolean;
  sourceGrounded: boolean;
};

const COGNITIVE_LEVEL_SET = new Set<string>(COGNITIVE_LEVELS);
const INTERACTION_TYPE_SET = new Set<string>(QUIZ_INTERACTION_TYPES);
const DIFFICULTY_LEVEL_SET = new Set<string>(QUIZ_DIFFICULTY_LEVELS);
const COGNITIVE_LEVEL_RANK: Record<CognitiveLevel, number> = {
  remember: 1,
  understand: 2,
  apply: 3,
  analyze: 4,
  evaluate: 5,
  create: 6,
};

function addReason(
  reasonCodes: QualityReasonCode[],
  reasonCode: QualityReasonCode,
): void {
  if (!reasonCodes.includes(reasonCode)) reasonCodes.push(reasonCode);
}

function isCognitiveLevel(value: unknown): value is CognitiveLevel {
  return typeof value === "string" && COGNITIVE_LEVEL_SET.has(value);
}

function isInteractionType(value: unknown): value is QuizInteractionType {
  return typeof value === "string" && INTERACTION_TYPE_SET.has(value);
}

function isDifficultyLevel(value: unknown): value is QuizDifficultyLevel {
  return typeof value === "string" && DIFFICULTY_LEVEL_SET.has(value);
}

function isUsableText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return normalized.length >= 2 && /\p{L}|\p{N}/u.test(normalized);
}

function isPlaceholderText(value: string): boolean {
  const normalized = normalizeQuestionText(value);
  return normalized === "placeholder"
    || normalized.startsWith("placeholder ")
    || normalized === "[placeholder]"
    || /^հարց \d+$/u.test(normalized)
    || /^հarц \d+$/u.test(normalized);
}

function hasPlaceholderOptions(options: readonly unknown[]): boolean {
  if (options.length !== 4 || !options.every((option) => typeof option === "string")) {
    return false;
  }
  return options.map((option) => normalizeQuestionText(option as string))
    .join("|") === "ա|բ|գ|դ";
}

/**
 * Normalize question text conservatively for exact, whitespace, and
 * punctuation-equivalent duplicate detection. This is intentionally not a
 * semantic similarity algorithm.
 */
export function normalizeQuestionText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("hy-AM")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function questionTextsEquivalent(left: string, right: string): boolean {
  return normalizeQuestionText(left) === normalizeQuestionText(right);
}

export function hasDuplicateQuestionText(
  questionText: string,
  acceptedQuestions: readonly Pick<NormalizedQuestionCandidate, "questionText">[],
): boolean {
  if (!isUsableText(questionText)) return false;
  return acceptedQuestions.some((question) =>
    typeof question.questionText === "string"
    && questionTextsEquivalent(questionText, question.questionText),
  );
}

function validatePreferredInteractions(
  context: QuestionQualityContext,
  reasonCodes: QualityReasonCode[],
): void {
  const deliveryType = context.deliveryInteractionType ?? "multiple_choice";
  if (!isInteractionType(deliveryType)) {
    addReason(reasonCodes, "UNSUPPORTED_INTERACTION_TYPE");
  } else if (!CURRENT_GENERATED_INTERACTION_TYPES.includes(deliveryType)) {
    addReason(reasonCodes, "PREFERRED_INTERACTION_UNAVAILABLE");
  } else if (
    !COGNITIVE_LEVEL_OPERATIONAL_CONTRACTS[
      context.cognitiveLevel
    ].naturallyCompatibleInteractionTypes.includes(deliveryType)
  ) {
    addReason(reasonCodes, "TARGET_INTERACTION_INCOMPATIBLE");
  }

  for (const preferred of context.preferredInteractionTypes) {
    if (!isInteractionType(preferred)) {
      addReason(reasonCodes, "UNSUPPORTED_INTERACTION_TYPE");
      continue;
    }
    if (!CURRENT_GENERATED_INTERACTION_TYPES.includes(preferred)) {
      addReason(reasonCodes, "PREFERRED_INTERACTION_UNAVAILABLE");
    }
  }
}

/**
 * Pure structural and compatibility validation for one generated candidate.
 *
 * It deliberately does not infer Bloom level from wording. Semantic demand
 * belongs to the independent reviewer contract defined below.
 */
export function validateGeneratedQuestionCandidate(
  candidate: NormalizedQuestionCandidate,
  context: QuestionQualityContext,
  acceptedQuestions: readonly Pick<NormalizedQuestionCandidate, "questionText">[] = [],
): QuestionQualityResult {
  const reasonCodes: QualityReasonCode[] = [];

  if (!isUsableText(candidate.questionText)) {
    addReason(reasonCodes, "INVALID_QUESTION_TEXT");
  } else if (isPlaceholderText(candidate.questionText)) {
    addReason(reasonCodes, "PLACEHOLDER_CONTENT");
  }

  const options = candidate.options as readonly unknown[];
  if (options.length !== 4 || !options.every(isUsableText)) {
    addReason(reasonCodes, "INVALID_OPTIONS");
  } else {
    const normalizedOptions = options.map((option) =>
      normalizeQuestionText(option as string),
    );
    if (new Set(normalizedOptions).size !== normalizedOptions.length) {
      addReason(reasonCodes, "DUPLICATE_OPTIONS");
    }
    if (hasPlaceholderOptions(options)) {
      addReason(reasonCodes, "PLACEHOLDER_CONTENT");
    }
  }

  if (
    !Number.isInteger(candidate.correctOptionIndex)
    || candidate.correctOptionIndex < 0
    || candidate.correctOptionIndex > 3
  ) {
    addReason(reasonCodes, "INVALID_CORRECT_OPTION");
  }

  if (candidate.optionExplanations !== null) {
    const explanations = candidate.optionExplanations as readonly unknown[];
    if (
      explanations.length !== 4
      || explanations.some((explanation) =>
        explanation !== null && !isUsableText(explanation),
      )
    ) {
      addReason(reasonCodes, "INVALID_OPTION_EXPLANATIONS");
    }
  }

  if (candidate.nodeId !== context.canonicalNodeId) {
    addReason(reasonCodes, "NODE_ID_MISMATCH");
  }
  if (candidate.cognitiveLevelId !== context.canonicalCognitiveLevelId) {
    addReason(reasonCodes, "COGNITIVE_LEVEL_ID_MISMATCH");
  }
  if (!isDifficultyLevel(candidate.difficultyLevel)) {
    addReason(reasonCodes, "INVALID_DIFFICULTY_LEVEL");
  }

  validatePreferredInteractions(context, reasonCodes);

  if (
    isUsableText(candidate.questionText)
    && hasDuplicateQuestionText(candidate.questionText, acceptedQuestions)
  ) {
    addReason(reasonCodes, "DUPLICATE_QUESTION");
  }

  return { passed: reasonCodes.length === 0, reasonCodes };
}

function boundedReasonCodes(values: readonly QualityReasonCode[]): QualityReasonCode[] {
  return values.filter((value, index) =>
    QUALITY_REASON_CODES.includes(value)
    && values.indexOf(value) === index,
  );
}

/**
 * Interpret a future independent semantic-review result without allowing it
 * to alter the canonical target. A reviewer PASS is accepted only when every
 * required alignment flag is true and its measured level equals the target.
 */
export function evaluateSemanticReviewResult(
  review: SemanticQuestionReviewResult,
  context: Pick<QuestionQualityContext, "cognitiveLevel">,
): QuestionQualityResult {
  if (review.verdict === "REVIEW_ERROR") {
    return { passed: false, reasonCodes: ["SEMANTIC_REVIEW_ERROR"] };
  }

  const reasonCodes = boundedReasonCodes(review.reasonCodes);
  if (!review.nodeAligned) addReason(reasonCodes, "MICRONODE_MISALIGNED");
  if (!review.objectiveAligned) {
    addReason(reasonCodes, "PERFORMANCE_OBJECTIVE_MISALIGNED");
  }
  if (!review.criterionAligned) {
    addReason(reasonCodes, "SUCCESS_CRITERION_MISALIGNED");
  }
  if (!review.interactionCompatible) {
    addReason(reasonCodes, "PREFERRED_INTERACTION_UNAVAILABLE");
  }
  if (!review.sourceGrounded) {
    addReason(reasonCodes, "SOURCE_GROUNDING_FAILED");
  }

  const measured = review.measuredCognitiveLevel;
  if (!isCognitiveLevel(measured)) {
    addReason(reasonCodes, "COGNITIVE_DEMAND_MISMATCH");
  } else if (measured !== context.cognitiveLevel) {
    const measuredRank = COGNITIVE_LEVEL_RANK[measured];
    const targetRank = COGNITIVE_LEVEL_RANK[context.cognitiveLevel];
    addReason(
      reasonCodes,
      measuredRank < targetRank
        ? "COGNITIVE_DEMAND_TOO_LOW"
        : "COGNITIVE_DEMAND_MISMATCH",
    );
  }

  if (review.verdict === "FAIL" && reasonCodes.length === 0) {
    addReason(reasonCodes, "COGNITIVE_DEMAND_MISMATCH");
  }

  return {
    passed: review.verdict === "PASS" && reasonCodes.length === 0,
    reasonCodes,
  };
}