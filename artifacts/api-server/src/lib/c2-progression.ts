import {
  TARGET_DEMAND_LEVELS,
  type TargetDemandLevel,
  type TargetCognitiveDemand,
} from "./c2-target-demand.js";

export const C2_PROGRESSION_CONTRACT_VERSION = "c2-4.0";

export type ProgressionConfidence = "HIGH" | "MEDIUM" | "LOW";
export type ProgressionDecision = "MINIMAL" | "REVIEW_REQUIRED";

export type ProgressionReasonCode =
  | "TARGET_ONLY_SUFFICIENT"
  | "CONCEPTUAL_PREREQUISITE_REQUIRED"
  | "FACTUAL_PREREQUISITE_REQUIRED"
  | "PROCEDURAL_PREREQUISITE_REQUIRED"
  | "ANALYTIC_PREREQUISITE_REQUIRED"
  | "EVALUATIVE_PREREQUISITE_REQUIRED"
  | "NON_CONTIGUOUS_LEVEL_JUSTIFIED"
  | "TARGET_LEVEL_IS_FINAL";

export type ProgressionReviewReason =
  | "PROGRESSION_UNCERTAIN"
  | "REDUNDANT_LEVEL"
  | "MISSING_PREREQUISITE_LEVEL"
  | "LEVEL_OBJECTIVE_MISMATCH"
  | "TARGET_LEVEL_MISMATCH"
  | "SOURCE_GROUNDING_WEAK"
  | "SUCCESS_CRITERION_WEAK"
  | "INTERACTION_TYPE_MISMATCH";

export type CognitiveProgressionDecision = {
  targetLevel: TargetDemandLevel;
  selectedLevels: TargetDemandLevel[];
  omittedLowerLevels: TargetDemandLevel[];
  generatedLevelSequence: number[];
  levelCount: number;
  progressionDecision: ProgressionDecision;
  progressionConfidence: ProgressionConfidence;
  progressionReasonCodes: ProgressionReasonCode[];
  reviewReasonCodes: ProgressionReviewReason[];
  levelDiagnostics: CognitiveLevelDiagnostic[];
  contractVersion: string;
};

/**
 * Provider-free canonical route selection. The planner is the sole authority
 * for the levels, their order, and the target-ceiling position; a provider may
 * only fill pedagogical content inside this route.
 */
export type CognitiveProgressionPlan = {
  targetLevel: TargetDemandLevel;
  orderedLevels: TargetDemandLevel[];
  omittedLowerLevels: TargetDemandLevel[];
  plannerDecision: "PLANNED" | "REVIEW_REQUIRED";
  plannerConfidence: ProgressionConfidence;
  plannerReasonCodes: ProgressionReasonCode[];
  plannerReviewReasonCodes: Extract<ProgressionReviewReason, "PROGRESSION_UNCERTAIN">[];
  contractVersion: string;
};

export type CognitivePathPlanConformanceCode =
  | "MISSING_PLANNED_LEVEL"
  | "EXTRA_UNPLANNED_LEVEL"
  | "DUPLICATE_LEVEL"
  | "REORDERED_ROUTE"
  | "WRONG_DECLARED_LEVEL"
  | "TARGET_MISSING"
  | "TARGET_DUPLICATED"
  | "TARGET_NOT_FINAL";

export type CognitivePathPlanConformance = {
  conforms: boolean;
  firstMismatch: CognitivePathPlanConformanceCode | null;
};

export type CognitiveProgressionInput = {
  targetDemand: TargetCognitiveDemand;
  learningObjective: string | null | undefined;
  title: string;
  theoryContent: string | null | undefined;
  exercises: ReadonlyArray<{ exerciseText: string }>;
};

export type CognitiveProgressionLevel = {
  cognitiveLevel: string;
  sequence: number;
  isTargetCeiling: boolean;
  performanceObjective: string | null;
  successCriterion: string | null;
  preferredInteractionTypes?: unknown;
  minimumIndependentEvidence?: number | null;
};

export type CognitiveLevelDiagnostic = {
  ordinal: number;
  sequence: number;
  declaredLevel: TargetDemandLevel | null;
  isTargetCeiling: boolean;
  objectiveDemandLevel: TargetDemandLevel | null;
  criterionDemandLevel: TargetDemandLevel | null;
  combinedDemandLevel: TargetDemandLevel | null;
  demandRelation:
    | "NOT_CLASSIFIED"
    | "AT_OR_BELOW_DECLARED_LEVEL"
    | "ABOVE_DECLARED_LEVEL";
  comparedWithPreviousOrdinal: number | null;
  semanticOverlapWithPrevious: boolean;
  semanticOverlapClassification: "NOT_APPLICABLE" | "BELOW_THRESHOLD" | "REDUNDANT";
  redundancyDecision: "NOT_EVALUATED" | "NOT_REDUNDANT" | "REDUNDANT";
  redundancyReasonCodes: Extract<ProgressionReviewReason, "REDUNDANT_LEVEL">[];
  objectiveMatchesDeclaredLevel: boolean;
  criterionMatchesDeclaredLevel: boolean;
  levelDecision: "ACCEPTED" | "REVIEW_REQUIRED";
  levelReviewReasonCodes: ProgressionReviewReason[];
};

const RANK: Record<TargetDemandLevel, number> = {
  remember: 1,
  understand: 2,
  apply: 3,
  analyze: 4,
  evaluate: 5,
  create: 6,
};

const STOP_WORDS = new Set([
  "սովորողը", "աշակերտը", "կարող", "է", "և", "ու", "թե", "the", "a", "an", "to", "of",
]);

const normalize = (value: string | null | undefined): string =>
  (value ?? "").normalize("NFKC").toLocaleLowerCase("hy-AM")
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();

const words = (value: string): Set<string> =>
  new Set(normalize(value).split(" ").filter((word) => word.length >= 3 && !STOP_WORDS.has(word)));

const contains = (text: string, pattern: RegExp): boolean => pattern.test(text);

const FACTUAL = /(?:սահման\p{L}*|կոչվում է|անվանում\p{L}*|բանաձև\p{L}*|կանոն\p{L}*|հիշ\p{L}*|թվարկ\p{L}*|definition|formula|rule|recall|fact)/iu;
const EXPLICIT_FACTUAL_PREREQUISITE = /(?:նախ\s+(?:հիշ\p{L}*|իման\p{L}*|սահման\p{L}*)|անհրաժեշտ է\s+(?:հիշ\p{L}*|իման\p{L}*)|before\s+(?:recall|knowing)|requires?\s+(?:the\s+)?(?:definition|formula|rule))/iu;
const CONCEPTUAL = /(?:բացատր\p{L}*|մեկնաբան\p{L}*|իմաստ\p{L}*|պատճառ\p{L}*|ինչու|հարաբեր\p{L}*|կապ\p{L}*|նշանակ\p{L}*|ներկայաց\p{L}*|համապատասխանում|explain|meaning|why|relationship|interpret|represent|correspond)/iu;
const PROCEDURAL = /(?:կիրառ\p{L}*|օգտագործ\p{L}*|հաշվարկ\p{L}*|գումար\p{L}*|հան\p{L}*|բաժան\p{L}*|բազմապատկ\p{L}*|լուծ\p{L}*|վերափոխ\p{L}*|կատար\p{L}*|քայլ|ընթացակարգ|calculate|apply|use|solve|transform|procedure)/iu;
const PROCEDURAL_ACTION = /(?:կիրառ\p{L}*|օգտագործ\p{L}*|հաշվել|հաշվարկել|գումարել|հանել|բաժանել|բազմապատկել|լուծ(?:ել|իր|եք)(?:\s|$)|վերափոխ\p{L}*|կատար\p{L}*|calculate|apply|use|solve|transform)/iu;
const EXPLICIT_PROCEDURAL_PREREQUISITE = /(?:նախ\s+(?:կիրառ\p{L}*|օգտագործ\p{L}*|լուծ\p{L}*)|անհրաժեշտ է\s+(?:կիրառ\p{L}*|օգտագործ\p{L}*)|before\s+(?:applying|using|solving)|requires?\s+(?:the\s+)?(?:procedure|algorithm))/iu;
const ANALYTIC = /(?:վերլուծ\p{L}*|համեմատ\p{L}*|տարբերակ\p{L}*|դասակարգ\p{L}*|կառուցվածք|analy[sz]|compare|classif|structure|decompose)/iu;
const ANALYTIC_ACTION = /(?:վերլուծ\p{L}*|համեմատ\p{L}*|տարբերակ\p{L}*|դասակարգ\p{L}*|analy[sz]|compare|classif|decompose)/iu;
const EXPLICIT_ANALYTIC_PREREQUISITE = /(?:նախ\s+(?:վերլուծ\p{L}*|համեմատ\p{L}*|տարբերակ\p{L}*|դասակարգ\p{L}*)|before\s+(?:analy[sz]ing|compar(?:ing|ison)|classif)|first\s+(?:analy[sz]|compare|classif))/iu;
const EVALUATIVE = /(?:գնահատ\p{L}*|հիմնավոր\p{L}*|քննադատ\p{L}*|չափանիշ|criteria|evaluate|justify|critique)/iu;
const EVALUATIVE_ACTION = /(?:գնահատ\p{L}*|հիմնավոր\p{L}*|քննադատ\p{L}*|evaluate|justify|critique)/iu;
const EXPLICIT_EVALUATIVE_PREREQUISITE = /(?:նախ\s+(?:գնահատ\p{L}*|հիմնավոր\p{L}*|քննադատ\p{L}*)|before\s+(?:evaluat|justify|critique)|first\s+(?:evaluat|justify|critique))/iu;
const CREATIVE = /(?:ստեղծ\p{L}*|նախագծ\p{L}*|մշակ\p{L}*|կազմ(?:ել|իր|եք)(?:\s|$)|create|design|compose|develop|construct)/iu;

function levelOrNull(value: string): TargetDemandLevel | null {
  return (TARGET_DEMAND_LEVELS as readonly string[]).includes(value)
    ? value as TargetDemandLevel
    : null;
}

function semanticOverlapRatio(left: CognitiveProgressionLevel, right: CognitiveProgressionLevel): number | null {
  const leftWords = new Set([...words(`${left.performanceObjective ?? ""} ${left.successCriterion ?? ""}`)]);
  const rightWords = new Set([...words(`${right.performanceObjective ?? ""} ${right.successCriterion ?? ""}`)]);
  if (leftWords.size === 0 || rightWords.size === 0) return null;
  const intersection = [...leftWords].filter((word) => rightWords.has(word)).length;
  return intersection / Math.min(leftWords.size, rightWords.size);
}

function actionDemandRank(text: string): number {
  if (contains(text, CREATIVE)) return RANK.create;
  if (contains(text, EVALUATIVE_ACTION)) return RANK.evaluate;
  if (contains(text, ANALYTIC_ACTION)) return RANK.analyze;
  if (contains(text, PROCEDURAL_ACTION)) return RANK.apply;
  if (contains(text, CONCEPTUAL)) return RANK.understand;
  if (contains(text, FACTUAL)) return RANK.remember;
  return 0;
}

function levelForRank(rank: number): TargetDemandLevel | null {
  return rank > 0 ? TARGET_DEMAND_LEVELS[rank - 1] ?? null : null;
}

function demandRelation(
  declaredLevel: TargetDemandLevel | null,
  combinedDemandLevel: TargetDemandLevel | null,
): CognitiveLevelDiagnostic["demandRelation"] {
  if (!combinedDemandLevel) return "NOT_CLASSIFIED";
  if (!declaredLevel || RANK[combinedDemandLevel] > RANK[declaredLevel]) {
    return "ABOVE_DECLARED_LEVEL";
  }
  return "AT_OR_BELOW_DECLARED_LEVEL";
}

/**
 * This is deliberately a projection of the validator's existing classifiers.
 * It contains no generated text, source text, prompts, or provider messages.
 */
export function buildCognitiveLevelDiagnostics(
  levels: ReadonlyArray<CognitiveProgressionLevel>,
): CognitiveLevelDiagnostic[] {
  return levels.map((level, ordinal) => {
    const declaredLevel = levelOrNull(level.cognitiveLevel);
    const objectiveDemandLevel = levelForRank(actionDemandRank(normalize(level.performanceObjective)));
    const criterionDemandLevel = levelForRank(actionDemandRank(normalize(level.successCriterion)));
    const combinedDemandLevel = levelForRank(actionDemandRank(
      normalize(`${level.performanceObjective ?? ""} ${level.successCriterion ?? ""}`),
    ));
    const previous = ordinal > 0 ? levels[ordinal - 1] : null;
    const overlapRatio = previous ? semanticOverlapRatio(level, previous) : null;
    const semanticOverlapWithPrevious = overlapRatio !== null && overlapRatio >= 0.7;
    const semanticOverlapClassification = !previous || overlapRatio === null
      ? "NOT_APPLICABLE" as const
      : semanticOverlapWithPrevious
        ? "REDUNDANT" as const
        : "BELOW_THRESHOLD" as const;
    const redundancyDecision = !previous
      ? "NOT_EVALUATED" as const
      : semanticOverlapWithPrevious
        ? "REDUNDANT" as const
        : "NOT_REDUNDANT" as const;
    const levelReviewReasonCodes: ProgressionReviewReason[] = [];
    if (!declaredLevel || !level.performanceObjective?.trim() || !level.successCriterion?.trim()) {
      levelReviewReasonCodes.push("LEVEL_OBJECTIVE_MISMATCH");
    } else if (
      combinedDemandLevel
      && RANK[combinedDemandLevel] > RANK[declaredLevel]
    ) {
      levelReviewReasonCodes.push("LEVEL_OBJECTIVE_MISMATCH");
    }
    if (semanticOverlapWithPrevious) levelReviewReasonCodes.push("REDUNDANT_LEVEL");
    return {
      ordinal,
      sequence: level.sequence,
      declaredLevel,
      isTargetCeiling: level.isTargetCeiling,
      objectiveDemandLevel,
      criterionDemandLevel,
      combinedDemandLevel,
      demandRelation: demandRelation(declaredLevel, combinedDemandLevel),
      comparedWithPreviousOrdinal: previous ? ordinal - 1 : null,
      semanticOverlapWithPrevious,
      semanticOverlapClassification,
      redundancyDecision,
      redundancyReasonCodes: semanticOverlapWithPrevious ? ["REDUNDANT_LEVEL"] : [],
      objectiveMatchesDeclaredLevel: !!declaredLevel
        && (!objectiveDemandLevel || RANK[objectiveDemandLevel] <= RANK[declaredLevel]),
      criterionMatchesDeclaredLevel: !!declaredLevel
        && (!criterionDemandLevel || RANK[criterionDemandLevel] <= RANK[declaredLevel]),
      levelDecision: levelReviewReasonCodes.length > 0 ? "REVIEW_REQUIRED" : "ACCEPTED",
      levelReviewReasonCodes,
    };
  });
}

function sharesSpecificSourceEvidence(source: string, learnerEvidence: string): boolean {
  const sourceWords = [...words(source)];
  const learnerWords = [...words(learnerEvidence)];
  return learnerWords.some((learnerWord) => learnerWord.length >= 5 && sourceWords.some((sourceWord) =>
    sourceWord.length >= 5
      && (sourceWord.startsWith(learnerWord.slice(0, 5)) || learnerWord.startsWith(sourceWord.slice(0, 5))),
  ));
}

function levelSupportsPrerequisite(
  level: CognitiveProgressionLevel,
  reason: ProgressionReasonCode | undefined,
  sourceEvidence: string,
): boolean {
  const evidence = normalize(`${level.performanceObjective ?? ""} ${level.successCriterion ?? ""}`);
  if (!reason) return false;
  if (!sharesSpecificSourceEvidence(sourceEvidence, evidence)) return false;
  if (reason === "FACTUAL_PREREQUISITE_REQUIRED") return contains(evidence, FACTUAL);
  if (reason === "CONCEPTUAL_PREREQUISITE_REQUIRED") return contains(evidence, CONCEPTUAL);
  if (reason === "PROCEDURAL_PREREQUISITE_REQUIRED") return contains(evidence, PROCEDURAL);
  if (reason === "ANALYTIC_PREREQUISITE_REQUIRED") return contains(evidence, ANALYTIC);
  if (reason === "EVALUATIVE_PREREQUISITE_REQUIRED") return contains(evidence, EVALUATIVE_ACTION);
  return false;
}

function inferRequiredPrerequisites(input: CognitiveProgressionInput): {
  levels: TargetDemandLevel[];
  reasons: ProgressionReasonCode[];
  reasonByLevel: Map<TargetDemandLevel, ProgressionReasonCode>;
} {
  const dependencyEvidence = normalize([
    input.theoryContent,
    ...input.exercises.map((exercise) => exercise.exerciseText),
  ].join(" "));
  const target = input.targetDemand.targetLevel;
  const factual = contains(dependencyEvidence, EXPLICIT_FACTUAL_PREREQUISITE);
  const conceptual = contains(dependencyEvidence, CONCEPTUAL);
  const procedural = contains(dependencyEvidence, EXPLICIT_PROCEDURAL_PREREQUISITE);
  const analytic = contains(dependencyEvidence, EXPLICIT_ANALYTIC_PREREQUISITE);
  const evaluative = contains(dependencyEvidence, EXPLICIT_EVALUATIVE_PREREQUISITE);
  const levels: TargetDemandLevel[] = [];
  const reasons: ProgressionReasonCode[] = [];
  const reasonByLevel = new Map<TargetDemandLevel, ProgressionReasonCode>();
  const add = (level: TargetDemandLevel, reason: ProgressionReasonCode) => {
    if (RANK[level] < RANK[target] && !levels.includes(level)) {
      levels.push(level);
      reasons.push(reason);
      reasonByLevel.set(level, reason);
    }
  };

  if (target === "understand" && factual) add("remember", "FACTUAL_PREREQUISITE_REQUIRED");
  if (target === "apply") {
    if (factual) add("remember", "FACTUAL_PREREQUISITE_REQUIRED");
    if (conceptual || procedural) add("understand", "CONCEPTUAL_PREREQUISITE_REQUIRED");
  }
  if (target === "analyze") {
    if (conceptual) add("understand", "CONCEPTUAL_PREREQUISITE_REQUIRED");
    if (procedural) add("apply", "PROCEDURAL_PREREQUISITE_REQUIRED");
  }
  if (target === "evaluate") {
    if (conceptual) add("understand", "CONCEPTUAL_PREREQUISITE_REQUIRED");
    if (analytic) add("analyze", "ANALYTIC_PREREQUISITE_REQUIRED");
    if (procedural) add("apply", "PROCEDURAL_PREREQUISITE_REQUIRED");
  }
  if (target === "create") {
    if (conceptual) add("understand", "CONCEPTUAL_PREREQUISITE_REQUIRED");
    if (analytic) add("analyze", "ANALYTIC_PREREQUISITE_REQUIRED");
    if (procedural) add("apply", "PROCEDURAL_PREREQUISITE_REQUIRED");
    if (evaluative) {
      add("evaluate", "EVALUATIVE_PREREQUISITE_REQUIRED");
    }
  }

  return {
    levels: levels.sort((left, right) => RANK[left] - RANK[right]),
    reasons: [...new Set(reasons)],
    reasonByLevel,
  };
}

export function inferCognitivePrerequisites(input: CognitiveProgressionInput): TargetDemandLevel[] {
  return inferRequiredPrerequisites(input).levels;
}

/**
 * Build the canonical minimal C2 route from trusted server-side evidence only.
 * It deliberately does not inspect provider output or generate content.
 */
export function planCognitiveProgression(input: CognitiveProgressionInput): CognitiveProgressionPlan {
  const target = input.targetDemand.targetLevel;
  const prerequisiteAnalysis = inferRequiredPrerequisites(input);
  const targetEvidenceIsUncertain = input.targetDemand.confidence === "LOW"
    || input.targetDemand.reviewReasons.includes("OBJECTIVE_SOURCE_CONFLICT")
    || input.targetDemand.reviewReasons.includes("INSUFFICIENT_CURRICULUM_EVIDENCE");
  const orderedLevels = targetEvidenceIsUncertain
    ? []
    : [...prerequisiteAnalysis.levels, target];
  const omittedLowerLevels = TARGET_DEMAND_LEVELS
    .filter((level) => RANK[level] < RANK[target] && !orderedLevels.includes(level));
  const plannerReasonCodes = [...new Set(prerequisiteAnalysis.reasons)];
  if (!targetEvidenceIsUncertain && prerequisiteAnalysis.levels.length === 0) {
    plannerReasonCodes.push("TARGET_ONLY_SUFFICIENT");
  }
  if (!targetEvidenceIsUncertain && omittedLowerLevels.some(
    (level) => !prerequisiteAnalysis.levels.includes(level),
  )) {
    plannerReasonCodes.push("NON_CONTIGUOUS_LEVEL_JUSTIFIED");
  }
  if (!targetEvidenceIsUncertain) plannerReasonCodes.push("TARGET_LEVEL_IS_FINAL");

  return {
    targetLevel: target,
    orderedLevels,
    omittedLowerLevels,
    plannerDecision: targetEvidenceIsUncertain ? "REVIEW_REQUIRED" : "PLANNED",
    plannerConfidence: targetEvidenceIsUncertain
      ? "LOW"
      : input.targetDemand.confidence === "HIGH" ? "HIGH" : "MEDIUM",
    plannerReasonCodes,
    plannerReviewReasonCodes: targetEvidenceIsUncertain ? ["PROGRESSION_UNCERTAIN"] : [],
    contractVersion: C2_PROGRESSION_CONTRACT_VERSION,
  };
}

/**
 * Verifies that a provider echoed the canonical route exactly. Content fields
 * are intentionally excluded here and remain the responsibility of the
 * existing semantic/content validators that run after this gate.
 */
export function assessCognitivePathPlanConformance(
  plan: CognitiveProgressionPlan,
  levels: ReadonlyArray<Pick<CognitiveProgressionLevel, "cognitiveLevel" | "sequence" | "isTargetCeiling">>,
): CognitivePathPlanConformance {
  if (plan.plannerDecision !== "PLANNED") {
    return { conforms: false, firstMismatch: "MISSING_PLANNED_LEVEL" };
  }

  const expected = plan.orderedLevels;
  const candidateLevels = levels.map((level) => levelOrNull(level.cognitiveLevel));
  const targetCount = levels.filter((level) => level.cognitiveLevel === plan.targetLevel).length;
  if (targetCount === 0) return { conforms: false, firstMismatch: "TARGET_MISSING" };
  if (targetCount > 1) return { conforms: false, firstMismatch: "TARGET_DUPLICATED" };
  if (levels.at(-1)?.cognitiveLevel !== plan.targetLevel || !levels.at(-1)?.isTargetCeiling) {
    return { conforms: false, firstMismatch: "TARGET_NOT_FINAL" };
  }
  if (levels.filter((level) => level.isTargetCeiling).length !== 1) {
    return { conforms: false, firstMismatch: "TARGET_DUPLICATED" };
  }
  if (new Set(candidateLevels).size !== candidateLevels.length) {
    return { conforms: false, firstMismatch: "DUPLICATE_LEVEL" };
  }

  const hasMissingPlannedLevel = expected.some((level) => !candidateLevels.includes(level));
  const hasExtraUnplannedLevel = candidateLevels.some((level) => !level || !expected.includes(level));
  if (!hasMissingPlannedLevel && !hasExtraUnplannedLevel && levels.length === expected.length
    && candidateLevels.some((level, index) => level !== expected[index])) {
    return { conforms: false, firstMismatch: "REORDERED_ROUTE" };
  }
  const expectedBySequence = new Map(expected.map((level, index) => [index + 1, level]));
  for (const level of levels) {
    const expectedAtSequence = expectedBySequence.get(level.sequence);
    if (expectedAtSequence && level.cognitiveLevel !== expectedAtSequence) {
      return { conforms: false, firstMismatch: "WRONG_DECLARED_LEVEL" };
    }
  }
  if (hasMissingPlannedLevel) {
    return { conforms: false, firstMismatch: "MISSING_PLANNED_LEVEL" };
  }
  if (hasExtraUnplannedLevel) {
    return { conforms: false, firstMismatch: "EXTRA_UNPLANNED_LEVEL" };
  }
  if (
    levels.length !== expected.length
    || levels.some((level, index) =>
      level.sequence !== index + 1 || level.cognitiveLevel !== expected[index],
    )
  ) {
    return { conforms: false, firstMismatch: "REORDERED_ROUTE" };
  }
  return { conforms: true, firstMismatch: null };
}

export function assessCognitivePathProgression(
  input: CognitiveProgressionInput,
  levels: ReadonlyArray<CognitiveProgressionLevel>,
): CognitiveProgressionDecision {
  const target = input.targetDemand.targetLevel;
  const selectedLevels = levels
    .slice()
    .sort((left, right) => left.sequence - right.sequence)
    .map((level) => levelOrNull(level.cognitiveLevel))
    .filter((level): level is TargetDemandLevel => level !== null);
  const omittedLowerLevels = TARGET_DEMAND_LEVELS
    .filter((level) => RANK[level] < RANK[target] && !selectedLevels.includes(level));
  const { levels: required, reasons, reasonByLevel } = inferRequiredPrerequisites(input);
  const sourceEvidence = [input.theoryContent, ...input.exercises.map((exercise) => exercise.exerciseText)].join(" ");
  const reviewReasonCodes: ProgressionReviewReason[] = [];
  const levelDiagnostics = buildCognitiveLevelDiagnostics(levels);
  const selectedTargetCount = levels.filter((level) => level.isTargetCeiling).length;
  const finalLevel = levels.slice().sort((left, right) => left.sequence - right.sequence).at(-1);

  if (selectedTargetCount !== 1 || !finalLevel || !finalLevel.isTargetCeiling) {
    reviewReasonCodes.push("TARGET_LEVEL_MISMATCH");
  }
  if (finalLevel && levelOrNull(finalLevel.cognitiveLevel) !== target) {
    reviewReasonCodes.push("TARGET_LEVEL_MISMATCH");
  }
  if (required.some((requiredLevel) => {
    const candidate = levels.find((level) => level.cognitiveLevel === requiredLevel);
    return !candidate || !levelSupportsPrerequisite(candidate, reasonByLevel.get(requiredLevel), sourceEvidence);
  })) {
    reviewReasonCodes.push("MISSING_PREREQUISITE_LEVEL");
  }
  for (let index = 1; index < levels.length; index += 1) {
    const current = levels[index];
    const previous = levels[index - 1];
    if (levelDiagnostics[index]?.semanticOverlapWithPrevious) reviewReasonCodes.push("REDUNDANT_LEVEL");
  }
  for (const level of levels) {
    const levelIndex = levels.indexOf(level);
    const levelDiagnostic = levelDiagnostics[levelIndex];
    const bloom = levelOrNull(level.cognitiveLevel);
    if (!bloom || !level.performanceObjective?.trim() || !level.successCriterion?.trim()) {
      reviewReasonCodes.push("LEVEL_OBJECTIVE_MISMATCH");
      levelDiagnostic?.levelReviewReasonCodes.push("LEVEL_OBJECTIVE_MISMATCH");
      continue;
    }
    if (levelDiagnostic?.combinedDemandLevel
      && RANK[levelDiagnostic.combinedDemandLevel] > RANK[bloom]) {
      reviewReasonCodes.push("LEVEL_OBJECTIVE_MISMATCH");
      levelDiagnostic.levelReviewReasonCodes.push("LEVEL_OBJECTIVE_MISMATCH");
    }
    if (!Array.isArray(level.preferredInteractionTypes) || level.preferredInteractionTypes.length === 0) {
      reviewReasonCodes.push("INTERACTION_TYPE_MISMATCH");
      levelDiagnostic?.levelReviewReasonCodes.push("INTERACTION_TYPE_MISMATCH");
    }
    if (level.minimumIndependentEvidence !== undefined
      && level.minimumIndependentEvidence !== null
      && (!Number.isInteger(level.minimumIndependentEvidence)
        || level.minimumIndependentEvidence < 1
        || level.minimumIndependentEvidence > 5)) {
      reviewReasonCodes.push("SUCCESS_CRITERION_WEAK");
      levelDiagnostic?.levelReviewReasonCodes.push("SUCCESS_CRITERION_WEAK");
    }
    if (bloom && bloom !== target && !required.includes(bloom)) {
      reviewReasonCodes.push("REDUNDANT_LEVEL");
      levelDiagnostic?.levelReviewReasonCodes.push("REDUNDANT_LEVEL");
      if (levelDiagnostic) {
        levelDiagnostic.redundancyDecision = "REDUNDANT";
        levelDiagnostic.redundancyReasonCodes = ["REDUNDANT_LEVEL"];
      }
    }
    if (levelDiagnostic) {
      levelDiagnostic.levelDecision = levelDiagnostic.levelReviewReasonCodes.length > 0
        ? "REVIEW_REQUIRED"
        : "ACCEPTED";
    }
  }
  for (const levelDiagnostic of levelDiagnostics) {
    levelDiagnostic.levelReviewReasonCodes = [...new Set(levelDiagnostic.levelReviewReasonCodes)];
    levelDiagnostic.levelDecision = levelDiagnostic.levelReviewReasonCodes.length > 0
      ? "REVIEW_REQUIRED"
      : "ACCEPTED";
  }

  const uniqueReviews = [...new Set(reviewReasonCodes)];
  const uniqueReasons = [...new Set(reasons)];
  if (required.length === 0 && omittedLowerLevels.length === TARGET_DEMAND_LEVELS.filter((level) => RANK[level] < RANK[target]).length) {
    uniqueReasons.push("TARGET_ONLY_SUFFICIENT");
  }
  if (omittedLowerLevels.some((level) => !required.includes(level))) {
    uniqueReasons.push("NON_CONTIGUOUS_LEVEL_JUSTIFIED");
  }
  uniqueReasons.push("TARGET_LEVEL_IS_FINAL");

  const progressionDecision: ProgressionDecision = uniqueReviews.length > 0 ? "REVIEW_REQUIRED" : "MINIMAL";
  const progressionConfidence: ProgressionConfidence = progressionDecision === "REVIEW_REQUIRED"
    ? "LOW"
    : required.length === 0 || required.every((level) => selectedLevels.includes(level))
      ? "HIGH"
      : "MEDIUM";

  return {
    targetLevel: target,
    selectedLevels,
    omittedLowerLevels,
    generatedLevelSequence: levels.slice().sort((left, right) => left.sequence - right.sequence).map((level) => level.sequence),
    levelCount: levels.length,
    progressionDecision,
    progressionConfidence,
    progressionReasonCodes: uniqueReasons,
    reviewReasonCodes: uniqueReviews,
    levelDiagnostics,
    contractVersion: C2_PROGRESSION_CONTRACT_VERSION,
  };
}

export function progressionAllowsPersistence(decision: CognitiveProgressionDecision): boolean {
  return decision.progressionDecision === "MINIMAL"
    && decision.reviewReasonCodes.length === 0;
}