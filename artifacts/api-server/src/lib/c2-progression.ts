import {
  TARGET_DEMAND_LEVELS,
  type TargetDemandLevel,
  type TargetCognitiveDemand,
} from "./c2-target-demand.js";

export const C2_PROGRESSION_CONTRACT_VERSION = "c2-3.0";

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
  contractVersion: string;
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

function hasSemanticOverlap(left: CognitiveProgressionLevel, right: CognitiveProgressionLevel): boolean {
  const leftWords = new Set([...words(`${left.performanceObjective ?? ""} ${left.successCriterion ?? ""}`)]);
  const rightWords = new Set([...words(`${right.performanceObjective ?? ""} ${right.successCriterion ?? ""}`)]);
  if (leftWords.size === 0 || rightWords.size === 0) return false;
  const intersection = [...leftWords].filter((word) => rightWords.has(word)).length;
  return intersection / Math.min(leftWords.size, rightWords.size) >= 0.7;
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
    if (hasSemanticOverlap(current, previous)) reviewReasonCodes.push("REDUNDANT_LEVEL");
  }
  for (const level of levels) {
    const bloom = levelOrNull(level.cognitiveLevel);
    if (!bloom || !level.performanceObjective?.trim() || !level.successCriterion?.trim()) {
      reviewReasonCodes.push("LEVEL_OBJECTIVE_MISMATCH");
      continue;
    }
    if (actionDemandRank(normalize(`${level.performanceObjective} ${level.successCriterion}`)) > RANK[bloom]) {
      reviewReasonCodes.push("LEVEL_OBJECTIVE_MISMATCH");
    }
    if (!Array.isArray(level.preferredInteractionTypes) || level.preferredInteractionTypes.length === 0) {
      reviewReasonCodes.push("INTERACTION_TYPE_MISMATCH");
    }
    if (level.minimumIndependentEvidence !== undefined
      && level.minimumIndependentEvidence !== null
      && (!Number.isInteger(level.minimumIndependentEvidence)
        || level.minimumIndependentEvidence < 1
        || level.minimumIndependentEvidence > 5)) {
      reviewReasonCodes.push("SUCCESS_CRITERION_WEAK");
    }
    if (bloom && bloom !== target && !required.includes(bloom)) {
      reviewReasonCodes.push("REDUNDANT_LEVEL");
    }
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
    contractVersion: C2_PROGRESSION_CONTRACT_VERSION,
  };
}

export function progressionAllowsPersistence(decision: CognitiveProgressionDecision): boolean {
  return decision.progressionDecision === "MINIMAL"
    && decision.reviewReasonCodes.length === 0;
}