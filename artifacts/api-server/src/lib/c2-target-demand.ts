export const TARGET_DEMAND_RESOLVER_VERSION = "c2-2.0";

export const TARGET_DEMAND_LEVELS = [
  "remember",
  "understand",
  "apply",
  "analyze",
  "evaluate",
  "create",
] as const;

export type TargetDemandLevel = (typeof TARGET_DEMAND_LEVELS)[number];
export type TargetDemandConfidence = "HIGH" | "MEDIUM" | "LOW";
export type C1TargetRelation =
  | "MATCHES_C1"
  | "RAISED_ABOVE_C1"
  | "LOWERED_BELOW_C1"
  | "UNCERTAIN_CONFLICT";

export type TargetDemandEvidenceCode =
  | "OBJECTIVE_PERFORMANCE"
  | "SOURCE_DEFINITION"
  | "SOURCE_EXPLANATION"
  | "SOURCE_PROCEDURE"
  | "SOURCE_RELATIONSHIP"
  | "SOURCE_CRITERIA"
  | "SOURCE_CREATION"
  | "SOURCE_EXERCISE_DEMAND"
  | "OUTCOME_PERFORMANCE"
  | "TITLE_CONTEXT"
  | "C1_PRIOR";

export type TargetDemandReviewReason =
  | "INSUFFICIENT_CURRICULUM_EVIDENCE"
  | "OBJECTIVE_SOURCE_CONFLICT"
  | "TRUSTED_OUTCOME_CONFLICT"
  | "C1_TARGET_DISCREPANCY"
  | "TARGET_DEMAND_LOW_CONFIDENCE";

export type TargetCognitiveDemand = {
  targetLevel: TargetDemandLevel;
  confidence: TargetDemandConfidence;
  evidence: TargetDemandEvidenceCode[];
  c1Relation: C1TargetRelation;
  reviewReasons: TargetDemandReviewReason[];
  resolverVersion: string;
};

export type TargetDemandResolverInput = {
  learningObjective: string | null | undefined;
  title: string;
  theoryContent: string | null | undefined;
  exercises: ReadonlyArray<{ exerciseText: string }>;
  canonicalOutcomes?: ReadonlyArray<string>;
  targetBloomLevel?: number | null;
};

type Signal = {
  level: TargetDemandLevel;
  strength: 1 | 2 | 3;
  evidence: TargetDemandEvidenceCode;
};

const LEVEL_RANK: Record<TargetDemandLevel, number> = {
  remember: 1,
  understand: 2,
  apply: 3,
  analyze: 4,
  evaluate: 5,
  create: 6,
};

const normalize = (value: string | null | undefined): string =>
  (value ?? "").normalize("NFKC").toLocaleLowerCase("hy-AM").replace(/\s+/g, " ").trim();

const has = (value: string, pattern: RegExp): boolean => pattern.test(value);

const CREATION = /(?:ստեղծ\p{L}*|նախագծ\p{L}*|կազմ\p{L}*|մշակ\p{L}*|create|design|compose|develop|construct)/iu;
const NOVELTY = /(?:նոր|սեփական|ինքնուրույն|մոդել|նախագիծ|օրիգինալ|novel|original|own)/iu;
const EVALUATION = /(?:գնահատ\p{L}*|հիմնավոր\p{L}*|քննադատ\p{L}*|assess|evaluate|justify|critique)/iu;
const CRITERIA = /(?:չափանիշ|ճշտ|սխալ|կանոն|criteria|correct|incorrect|quality)/iu;
const ANALYSIS = /(?:վերլուծ\p{L}*|համեմատ\p{L}*|տարբերակ\p{L}*|դասակարգ\p{L}*|եզրակաց\p{L}*|կառուցվածք|analy[sz]|compare|differentiate|classif|decompose|infer)/iu;
const CONTEXTUAL_DECOMPOSITION = /(?:բաժան\p{L}*\s+(?:մասերի|բաղադրիչների|խմբերի|տարրերի)|(?:մասերի|բաղադրիչների|խմբերի|տարրերի)\s+բաժան\p{L}*)/iu;
const PROCEDURE = /(?:կիրառ\p{L}*|օգտագործ\p{L}*|հաշվ\p{L}*|գումար\p{L}*|հան\p{L}*|բազմապատկ\p{L}*|բաժան\p{L}*|լուծ\p{L}*|կատար\p{L}*|վերափոխ\p{L}*|քայլ|ընթացակարգ|procedure|calculate|use|apply|solve|transform|step)/iu;
const EXPLICIT_PROCEDURE_ACTION = /(?:կիրառ\p{L}*|հաշվարկ\p{L}*|գումար\p{L}*|հան\p{L}*|բազմապատկ\p{L}*|բաժան\p{L}*|լուծ\p{L}*|կատար\p{L}*|վերափոխ\p{L}*|ընթացակարգ|procedure|calculate|apply|solve|transform)/iu;
const EXPLANATION = /(?:բացատր\p{L}*|մեկնաբան\p{L}*|նկարագր\p{L}*|ինչու|պատճառ|կախված|explain|describe|interpret|why|relationship)/iu;
const DEFINITION = /(?:սահման\p{L}*|կոչվում է|է կոչվում|անվանում\p{L}*|ճանաչ\p{L}*|հիշ\p{L}*|թվարկ\p{L}*|definition|define|recall|recognize|list|name)/iu;
const AMBIGUOUS_VERB = /(?:որոշ\p{L}*|նշ\p{L}*|identify|determine|state|describe)/iu;

function highestSignal(signals: Signal[]): Signal | null {
  return signals
    .slice()
    .sort((left, right) => right.strength - left.strength || LEVEL_RANK[right.level] - LEVEL_RANK[left.level])[0] ?? null;
}

function classifyObjective(text: string): Signal | null {
  if (!text) return null;
  if (has(text, CREATION) && has(text, NOVELTY)) return { level: "create", strength: 3, evidence: "OBJECTIVE_PERFORMANCE" };
  if (has(text, EVALUATION) && has(text, CRITERIA)) return { level: "evaluate", strength: 3, evidence: "OBJECTIVE_PERFORMANCE" };
  if (has(text, ANALYSIS)) return { level: "analyze", strength: 3, evidence: "OBJECTIVE_PERFORMANCE" };
  if (has(text, PROCEDURE)) return { level: "apply", strength: 3, evidence: "OBJECTIVE_PERFORMANCE" };
  if (has(text, EXPLANATION)) return { level: "understand", strength: 3, evidence: "OBJECTIVE_PERFORMANCE" };
  if (has(text, DEFINITION) && !has(text, AMBIGUOUS_VERB)) return { level: "remember", strength: 2, evidence: "OBJECTIVE_PERFORMANCE" };
  return null;
}

function classifyCurriculumText(text: string, exercise = false): Signal | null {
  if (!text) return null;
  if (has(text, CREATION) && has(text, NOVELTY)) {
    return { level: "create", strength: exercise ? 3 : 2, evidence: exercise ? "SOURCE_EXERCISE_DEMAND" : "SOURCE_CREATION" };
  }
  if (has(text, EVALUATION) && has(text, CRITERIA)) {
    return { level: "evaluate", strength: exercise ? 3 : 2, evidence: exercise ? "SOURCE_EXERCISE_DEMAND" : "SOURCE_CRITERIA" };
  }
  if (has(text, ANALYSIS) || has(text, CONTEXTUAL_DECOMPOSITION)) {
    return { level: "analyze", strength: exercise ? 3 : 2, evidence: exercise ? "SOURCE_EXERCISE_DEMAND" : "SOURCE_RELATIONSHIP" };
  }
  if (has(text, DEFINITION) && !has(text, EXPLICIT_PROCEDURE_ACTION)) {
    return { level: "remember", strength: exercise ? 2 : 2, evidence: exercise ? "SOURCE_EXERCISE_DEMAND" : "SOURCE_DEFINITION" };
  }
  if (has(text, PROCEDURE)) {
    return { level: "apply", strength: exercise ? 3 : 2, evidence: exercise ? "SOURCE_EXERCISE_DEMAND" : "SOURCE_PROCEDURE" };
  }
  if (has(text, EXPLANATION)) return { level: "understand", strength: exercise ? 2 : 2, evidence: exercise ? "SOURCE_EXERCISE_DEMAND" : "SOURCE_EXPLANATION" };
  if (has(text, DEFINITION)) return { level: "remember", strength: exercise ? 2 : 2, evidence: exercise ? "SOURCE_EXERCISE_DEMAND" : "SOURCE_DEFINITION" };
  return null;
}

function c1Level(targetBloomLevel: number | null | undefined): TargetDemandLevel | null {
  return targetBloomLevel && targetBloomLevel >= 1 && targetBloomLevel <= 6
    ? TARGET_DEMAND_LEVELS[targetBloomLevel - 1]
    : null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function resolveTargetCognitiveDemand(input: TargetDemandResolverInput): TargetCognitiveDemand {
  const objectiveText = normalize(input.learningObjective);
  const sourceText = normalize(input.theoryContent);
  const titleText = normalize(input.title);
  const objectiveSignal = classifyObjective(objectiveText);
  const sourceSignal = classifyCurriculumText(sourceText);
  const exerciseSignals = input.exercises
    .map((exercise) => classifyCurriculumText(normalize(exercise.exerciseText), true))
    .filter((signal): signal is Signal => signal !== null);
  const outcomeSignals = (input.canonicalOutcomes ?? [])
    .map((outcome) => classifyObjective(normalize(outcome)))
    .filter((signal): signal is Signal => signal !== null)
    .map((signal) => ({ ...signal, strength: 2 as const, evidence: "OUTCOME_PERFORMANCE" as const }));
  const titleSignal = classifyCurriculumText(titleText);

  const exerciseLevel = highestSignal(exerciseSignals)?.level ?? null;
  const sourceLevel = sourceSignal?.level ?? null;
  const objectiveLevel = objectiveSignal?.level ?? null;
  const outcomeLevel = highestSignal(outcomeSignals)?.level ?? null;
  const sourceOrExerciseLevel = exerciseLevel && sourceLevel
    ? (LEVEL_RANK[exerciseLevel] >= LEVEL_RANK[sourceLevel] ? exerciseLevel : sourceLevel)
    : exerciseLevel ?? sourceLevel;

  let targetLevel: TargetDemandLevel;
  let conflict = false;
  if (objectiveLevel && sourceOrExerciseLevel) {
    const objectiveRank = LEVEL_RANK[objectiveLevel];
    const evidenceRank = LEVEL_RANK[sourceOrExerciseLevel];
    const hasStrongExerciseSupportAtEvidenceLevel = exerciseSignals.some(
      (signal) => signal.strength === 3 && signal.level === sourceOrExerciseLevel,
    );
    if (objectiveRank > evidenceRank) {
      conflict = true;
      targetLevel = sourceOrExerciseLevel;
    } else if (evidenceRank > objectiveRank && !hasStrongExerciseSupportAtEvidenceLevel && sourceSignal?.strength === 2) {
      conflict = true;
      targetLevel = objectiveLevel;
    } else {
      targetLevel = sourceOrExerciseLevel;
    }
  } else {
    targetLevel = objectiveLevel ?? sourceOrExerciseLevel ?? outcomeLevel ?? titleSignal?.level ?? c1Level(input.targetBloomLevel) ?? "remember";
  }
  const outcomeConflict = outcomeSignals.some((signal) => signal.level !== targetLevel);
  if (outcomeConflict) conflict = true;

  const evidence: TargetDemandEvidenceCode[] = [];
  if (objectiveSignal && objectiveSignal.level === targetLevel) evidence.push(objectiveSignal.evidence);
  if (sourceSignal && sourceSignal.level === targetLevel) evidence.push(sourceSignal.evidence);
  if (exerciseSignals.some((signal) => signal.level === targetLevel)) evidence.push("SOURCE_EXERCISE_DEMAND");
  if (outcomeSignals.some((signal) => signal.level === targetLevel)) evidence.push("OUTCOME_PERFORMANCE");
  if (titleSignal?.level === targetLevel) evidence.push("TITLE_CONTEXT");
  if (evidence.length === 0 && c1Level(input.targetBloomLevel) === targetLevel) evidence.push("C1_PRIOR");

  const sourceBacked = sourceSignal?.level === targetLevel || exerciseSignals.some((signal) => signal.level === targetLevel);
  const objectiveBacked = objectiveSignal?.level === targetLevel;
  const confidence: TargetDemandConfidence = conflict
    ? "LOW"
    : sourceBacked && objectiveBacked
      ? "HIGH"
      : sourceBacked || objectiveBacked
        ? "MEDIUM"
        : "LOW";

  const c1 = c1Level(input.targetBloomLevel);
  const c1Relation: C1TargetRelation = !c1
    ? "UNCERTAIN_CONFLICT"
    : c1 === targetLevel
      ? "MATCHES_C1"
      : LEVEL_RANK[targetLevel] > LEVEL_RANK[c1]
        ? "RAISED_ABOVE_C1"
        : "LOWERED_BELOW_C1";
  const reviewReasons: TargetDemandReviewReason[] = [];
  if (conflict) reviewReasons.push("OBJECTIVE_SOURCE_CONFLICT");
  if (outcomeConflict) reviewReasons.push("TRUSTED_OUTCOME_CONFLICT");
  if (!sourceBacked && !objectiveBacked) reviewReasons.push("INSUFFICIENT_CURRICULUM_EVIDENCE");
  if (c1 && c1Relation !== "MATCHES_C1") reviewReasons.push("C1_TARGET_DISCREPANCY");
  if (confidence === "LOW") reviewReasons.push("TARGET_DEMAND_LOW_CONFIDENCE");

  return {
    targetLevel,
    confidence,
    evidence: unique(evidence),
    c1Relation,
    reviewReasons: unique(reviewReasons),
    resolverVersion: TARGET_DEMAND_RESOLVER_VERSION,
  };
}

export function targetDemandAllowsGeneration(decision: TargetCognitiveDemand): boolean {
  return decision.confidence !== "LOW"
    && !decision.reviewReasons.includes("OBJECTIVE_SOURCE_CONFLICT")
    && !decision.reviewReasons.includes("INSUFFICIENT_CURRICULUM_EVIDENCE");
}

export function matchesTargetCognitiveDemand(
  decision: TargetCognitiveDemand,
  levels: ReadonlyArray<{ cognitiveLevel: string; isTargetCeiling: boolean }>,
): boolean {
  return levels.find((level) => level.isTargetCeiling)?.cognitiveLevel === decision.targetLevel;
}