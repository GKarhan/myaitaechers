import { isUnreadableSource } from "./micronode-source-alignment.js";

export type CognitivePathGroundingStatus = "GROUNDED" | "REVIEW_REQUIRED" | "INVALID";
export type CognitivePathGroundingAudit = {
  status: CognitivePathGroundingStatus;
  valid: boolean;
  issueCounts: Record<string, number>;
};

export type CognitivePathAcceptanceLevel = {
  cognitiveLevel: string;
  sequence: number;
  isApplicable: boolean;
  isTargetCeiling: boolean;
  performanceObjective: string | null;
  successCriterion: string | null;
  minimumIndependentEvidence?: number | null;
  preferredInteractionTypes: unknown;
};

export type CognitivePathAcceptance = {
  accepted: boolean;
  reason:
    | "ACCEPTED"
    | "PATH_NOT_CONFIRMED"
    | "NO_APPLICABLE_LEVELS"
    | "TARGET_CEILING_INVALID"
    | "LEVEL_ORDER_INVALID"
    | "COGNITIVE_LEVEL_ORDER_INVALID"
    | "LEARNING_OBJECTIVE_COGNITIVE_FLOOR_VIOLATION"
    | "INTERACTION_TYPES_INVALID"
    | "EVIDENCE_BUDGET_INVALID"
    | "GROUNDING_NOT_ACCEPTED";
  grounding: CognitivePathGroundingAudit | null;
};

const ALLOWED_INTERACTIONS = new Set([
  "multiple_choice", "multi_select", "true_false", "matching", "classification",
  "ordering", "numeric_answer", "short_answer", "constructed_response", "problem_solving",
]);
const COGNITIVE_LEVEL_RANK: Record<string, number> = {
  remember: 1,
  understand: 2,
  apply: 3,
  analyze: 4,
  evaluate: 5,
  create: 6,
};
type CognitiveLevel = keyof typeof COGNITIVE_LEVEL_RANK;
const strongClaim = /(?:միշտ|երբեք|միայն|անպայման|սխալ\s+է|always|never|only|must|wrong)/iu;
const armenianLetter = /\p{Script=Armenian}/u;
const latinLetter = /\p{Script=Latin}/u;
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("hy-AM")
  .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
const numbers = (value: string) => value.match(/\d+(?:[\/.,:]\d+)*/g) ?? [];
const anchors = (value: string) => new Set(normalize(value).split(" ").filter((token) => token.length >= 4));

/** Allow a scientific variable only inside an equation actually present in source.
 * Decimal commas/dots and whitespace are presentation differences; prose and
 * invented equations remain subject to the Armenian-only check.
 */
function withoutSourceBackedEquations(value: string, source: string): string {
  const equationKey = (text: string) => text.normalize("NFKC")
    .replace(/,/g, ".").replace(/\s+/gu, "");
  const equationPattern = /(?<![\p{L}\p{N}_])[A-Za-z]\s*=\s*(?:\([0-9.,\s+\-−±*/×÷:]+\)|[+\-]?\d+(?:[.,]\d+)?)/gu;
  const sourceEquations = new Set([...source.matchAll(equationPattern)].map(match => equationKey(match[0])));
  return value.replace(equationPattern,
    equation => sourceEquations.has(equationKey(equation)) ? " " : equation);
}

/**
 * Deliberately conservative objective classifier. Only unambiguous observable
 * verbs establish a floor. Vague verbs such as "explain", "identify", or
 * "determine" retain legacy compatibility unless C1 explicitly sets a higher
 * ceiling; the classifier must never manufacture a stricter objective.
 */
export function getHighConfidenceLearningObjectiveFloor(
  learningObjective: string | null | undefined,
): CognitiveLevel | null {
  const objective = normalize(learningObjective ?? "");
  if (!objective) return null;
  const createVerb = /(?:^|\s)(?:create|design|compose|develop|construct|ստեղծ(?:ել|ալ|ում|իր|եք|ի|են|ես|ենք|եմ)|նախագծ(?:ել|ալ|ում|իր|եք|ի|են|ես|ենք|եմ)|կազմ(?:ել|ալ|ում|իր|եք|ի|են|ես|ենք|եմ)|մշակ(?:ել|ալ|ում|իր|եք|ի|են|ես|ենք|եմ))(?:\s|$)/iu;
  const evaluateVerb = /(?:^|\s)(?:evaluate|justify|critique|assess|գնահատ(?:ել|ալ|ում|իր|եք|ի|են|ես|ենք|եմ)|հիմնավոր(?:ել|ալ|ում|իր|եք|ի|են|ես|ենք|եմ)|քննադատ(?:ել|ալ|ում|իր|եք|ի|են|ես|ենք|եմ))(?:\s|$)/iu;
  const explicitAnalyzeVerb = /(?:^|\s)(?:analyze|differentiate|classify|վերլուծ(?:ել|ալ|ում|իր|եք|ի|են|ես|ենք|եմ)|դասակարգ(?:ել|ալ|ում|իր|եք|ի|են|ես|ենք|եմ))(?:\s|$)/iu;
  // Comparison wording is not analytical by itself. Require an observable
  // analytical object or basis (parts, alternatives, evidence, relationships,
  // causes, errors, or structure) before it establishes an Analyze floor.
  const analyticalComparison = /(?:^|\s)(?:compare|համեմատ\p{L}*)(?:\s+\p{L}+){0,6}\s+(?:alternative\p{L}*|part\p{L}*|evidence|relationship\p{L}*|cause\p{L}*|error\p{L}*|structure\p{L}*|այլընտր\p{L}*|մաս\p{L}*|ապացույց\p{L}*|կապ\p{L}*|պատճառ\p{L}*|սխալ\p{L}*|կառուցվածք\p{L}*|հիմնավոր(?:ել|ալ|ում|իր|եք|ի|են|ես|ենք|եմ))(?:\s|$)/iu;
  const applyVerb = /(?:^|\s)(?:calculate|use|apply|solve|հաշվ(?:արկ)?(?:ել|ում|իր|եք|ի|են|ես|ենք|եմ)|օգտագործ(?:ել|ալ|ում|իր|եք|ի|են|ես|ենք|եմ)|կիրառ(?:ել|ալ|ում|իր|եք|ի|են|ես|ենք|եմ)|լուծ(?:ել|ալ|ում|իր|եք|ի|են|ես|ենք|եմ))(?:\s|$)/iu;
  if (createVerb.test(objective)) return "create";
  if (evaluateVerb.test(objective)) return "evaluate";
  if (explicitAnalyzeVerb.test(objective) || analyticalComparison.test(objective)) return "analyze";
  return applyVerb.test(objective) ? "apply" : null;
}

/** True when the path's explicitly selected target meets an unambiguous LO floor. */
export function satisfiesLearningObjectiveCognitiveFloor(
  learningObjective: string | null | undefined,
  levels: ReadonlyArray<Pick<CognitivePathAcceptanceLevel, "cognitiveLevel" | "isTargetCeiling">>,
): boolean {
  const floor = getHighConfidenceLearningObjectiveFloor(learningObjective);
  if (!floor) return true;
  const target = levels.find((level) => level.isTargetCeiling)?.cognitiveLevel;
  return !!target && (COGNITIVE_LEVEL_RANK[target] ?? 0) >= COGNITIVE_LEVEL_RANK[floor];
}

export function validateCognitivePathGrounding(
  theoryContent: string | null | undefined,
  learningObjective: string | null | undefined,
  levels: ReadonlyArray<{ performanceObjective: string | null; successCriterion: string | null; preferredInteractionTypes: string[] | null }>,
): CognitivePathGroundingAudit {
  const source = normalize(theoryContent ?? "");
  const sourceNumbers = new Set(numbers(source));
  // C1 validates whether the objective belongs to this source. C2 grounding
  // must independently prove every generated claim from textbook source only.
  const sourceAnchors = anchors(source);
  // The learning objective supplies local context for otherwise generic criteria
  // (e.g. «երկու հասկացությունների սահմանումները»); it must itself share
  // a substantive topic anchor with the source before it can assist grounding.
  const objectiveAnchors = anchors(learningObjective ?? "");
  const hasObjectiveSourceAnchor = [...objectiveAnchors].some((token) => [...sourceAnchors].some((src) => token === src || (token.length >= 6 && src.length >= 6 && token.slice(0, 5) === src.slice(0, 5))));
  const groundedAnchors = hasObjectiveSourceAnchor ? [...sourceAnchors, ...objectiveAnchors] : [...sourceAnchors];
  const sharesTopicAnchor = (word: string) => groundedAnchors.some((anchor) => word === anchor || (word.length >= 6 && anchor.length >= 6 && word.slice(0, 5) === anchor.slice(0, 5)));
  const issueCounts: Record<string, number> = {};
  const add = (code: string) => { issueCounts[code] = (issueCounts[code] ?? 0) + 1; };
  if (isUnreadableSource(theoryContent ?? "")) add("UNREADABLE_SOURCE");
  for (const level of levels) {
    for (const value of [level.performanceObjective ?? "", level.successCriterion ?? ""]) {
      const text = normalize(value);
      if (!text) { add("EMPTY_REQUIRED_FIELD"); continue; }
      if (!armenianLetter.test(value) || latinLetter.test(withoutSourceBackedEquations(value, theoryContent ?? ""))) add("NON_ARMENIAN_REQUIRED_TEXT");
      if (numbers(text).some((number) => !sourceNumbers.has(number))) add("NOVEL_NUMERIC_CLAIM");
      const overlap = [...anchors(text)].filter(sharesTopicAnchor).length;
      if (overlap === 0) add("LOW_SOURCE_ANCHOR");
      if (strongClaim.test(text) && !source.includes(text)) add("UNSUPPORTED_STRONG_CLAIM");
    }
    if ((level.preferredInteractionTypes ?? []).some((kind) => !ALLOWED_INTERACTIONS.has(kind))) add("INVALID_INTERACTION_TYPE");
  }
  const invalid = ["UNREADABLE_SOURCE", "EMPTY_REQUIRED_FIELD", "NON_ARMENIAN_REQUIRED_TEXT", "NOVEL_NUMERIC_CLAIM", "UNSUPPORTED_STRONG_CLAIM", "INVALID_INTERACTION_TYPE"]
    .some((code) => issueCounts[code]);
  const review = !!issueCounts.LOW_SOURCE_ANCHOR;
  return { status: invalid ? "INVALID" : review ? "REVIEW_REQUIRED" : "GROUNDED", valid: !invalid, issueCounts };
}

/** Sort persisted levels before a runtime consumer evaluates the path contract. */
export function orderCognitivePathLevels<T extends { sequence: number; id?: number }>(
  levels: readonly T[],
): T[] {
  return [...levels].sort((left, right) =>
    left.sequence - right.sequence || (left.id ?? 0) - (right.id ?? 0),
  );
}

/**
 * Structural invariants for every usable Cognitive Path. Do not infer omitted
 * lower levels: a path may begin at any supported level, but listed levels
 * must strictly advance in Bloom rank and the sole target must be the last one.
 */
export function assessCognitivePathStructure(
  levels: ReadonlyArray<Pick<CognitivePathAcceptanceLevel, "cognitiveLevel" | "sequence" | "isTargetCeiling">>,
): Exclude<CognitivePathAcceptance["reason"], "ACCEPTED" | "PATH_NOT_CONFIRMED" | "NO_APPLICABLE_LEVELS" | "LEARNING_OBJECTIVE_COGNITIVE_FLOOR_VIOLATION" | "INTERACTION_TYPES_INVALID" | "GROUNDING_NOT_ACCEPTED"> | null {
  if (levels.filter((level) => level.isTargetCeiling).length !== 1) {
    return "TARGET_CEILING_INVALID";
  }
  if (levels.some((level, index) =>
    level.sequence !== index + 1
    || (index > 0 && level.sequence <= levels[index - 1].sequence),
  )) {
    return "LEVEL_ORDER_INVALID";
  }
  if (levels.some((level, index) =>
    !COGNITIVE_LEVEL_RANK[level.cognitiveLevel]
    || (index > 0 && COGNITIVE_LEVEL_RANK[level.cognitiveLevel] <= COGNITIVE_LEVEL_RANK[levels[index - 1].cognitiveLevel]),
  )) {
    return "COGNITIVE_LEVEL_ORDER_INVALID";
  }
  if (!levels[levels.length - 1]?.isTargetCeiling) {
    return "TARGET_CEILING_INVALID";
  }
  return null;
}

/**
 * Single runtime acceptance contract for a modern Cognitive Path.
 *
 * A path may influence learner delivery only after the teacher confirms it and
 * its current persisted fields still pass strict GROUNDED validation. Keeping
 * this check pure makes every consumer fail closed in the same way.
 */
export function assessAcceptedCognitivePath(input: {
  cogPathStatus: string | null | undefined;
  theoryContent: string | null | undefined;
  learningObjective: string | null | undefined;
  levels: ReadonlyArray<CognitivePathAcceptanceLevel>;
}): CognitivePathAcceptance {
  if (input.cogPathStatus !== "confirmed") {
    return { accepted: false, reason: "PATH_NOT_CONFIRMED", grounding: null };
  }

  // Persisted rows can arrive in any SQL order. Their authored sequence—not
  // retrieval order—is the canonical path order for all runtime consumers.
  const applicableLevels = orderCognitivePathLevels(
    input.levels.filter((level) => level.isApplicable),
  );
  if (applicableLevels.length === 0) {
    return { accepted: false, reason: "NO_APPLICABLE_LEVELS", grounding: null };
  }
  const structuralReason = assessCognitivePathStructure(applicableLevels);
  if (structuralReason) {
    return { accepted: false, reason: structuralReason, grounding: null };
  }
  if (!satisfiesLearningObjectiveCognitiveFloor(input.learningObjective, applicableLevels)) {
    return {
      accepted: false,
      reason: "LEARNING_OBJECTIVE_COGNITIVE_FLOOR_VIOLATION",
      grounding: null,
    };
  }
  if (applicableLevels.some((level) =>
    !Array.isArray(level.preferredInteractionTypes) ||
    level.preferredInteractionTypes.some((kind) => typeof kind !== "string"),
  )) {
    return { accepted: false, reason: "INTERACTION_TYPES_INVALID", grounding: null };
  }
  if (applicableLevels.some((level) =>
    level.minimumIndependentEvidence !== undefined
    && level.minimumIndependentEvidence !== null
    && (!Number.isInteger(level.minimumIndependentEvidence)
      || level.minimumIndependentEvidence < 1
      || level.minimumIndependentEvidence > 5),
  )) {
    return { accepted: false, reason: "EVIDENCE_BUDGET_INVALID", grounding: null };
  }

  const grounding = validateCognitivePathGrounding(
    input.theoryContent,
    input.learningObjective,
    applicableLevels.map((level) => ({
      performanceObjective: level.performanceObjective,
      successCriterion: level.successCriterion,
      preferredInteractionTypes: level.preferredInteractionTypes as string[],
    })),
  );
  if (grounding.status !== "GROUNDED") {
    return { accepted: false, reason: "GROUNDING_NOT_ACCEPTED", grounding };
  }
  return { accepted: true, reason: "ACCEPTED", grounding };
}

export type CanonicalQuizTargetFailureReason =
  | "PATH_NOT_CONFIRMED"
  | "NO_APPLICABLE_LEVELS"
  | "TARGET_MISSING"
  | "MULTIPLE_TARGETS"
  | "TARGET_NOT_APPLICABLE"
  | "TARGET_NOT_FINAL"
  | "INVALID_SEQUENCE"
  | "INVALID_COGNITIVE_ORDER"
  | "PATH_GROUNDING_FAILED"
  | "TARGET_BLOOM_COPY_MISMATCH"
  | "PATH_NOT_ACCEPTED";

export type CanonicalQuizTargetNode = {
  id: number;
  cogPathStatus: string | null | undefined;
  theoryContent: string | null | undefined;
  learningObjective: string | null | undefined;
  targetBloomLevel?: number | null;
};

export type CanonicalQuizTargetLevel = CognitivePathAcceptanceLevel & {
  id: number;
  lessonNodeId?: number;
};

export type CanonicalQuizTarget = {
  nodeId: number;
  cognitiveLevelId: number;
  cognitiveLevel: string;
  sequence: number;
  performanceObjective: string | null;
  successCriterion: string | null;
  preferredInteractionTypes: string[];
  minimumIndependentEvidence: number | null;
  isApplicable: true;
  isTargetCeiling: true;
  isCanonicalTarget: true;
};

export type CanonicalQuizTargetResolution =
  | {
      valid: true;
      target: CanonicalQuizTarget;
      acceptance: CognitivePathAcceptance;
      nodeId: number;
      cognitiveLevelId: number;
      cognitiveLevel: string;
      sequence: number;
      performanceObjective: string | null;
      successCriterion: string | null;
      preferredInteractionTypes: string[];
      minimumIndependentEvidence: number | null;
      isCanonicalTarget: true;
    }
  | {
      valid: false;
      nodeId: number;
      reason: CanonicalQuizTargetFailureReason;
      reasons: CanonicalQuizTargetFailureReason[];
      acceptance?: CognitivePathAcceptance;
      acceptanceReason?: CognitivePathAcceptance["reason"];
      grounding?: CognitivePathGroundingAudit | null;
      expectedTargetBloomLevel?: number;
      actualTargetBloomLevel?: number | null;
    };

function canonicalQuizTargetFailure(
  nodeId: number,
  reason: CanonicalQuizTargetFailureReason,
  details: Partial<Extract<CanonicalQuizTargetResolution, { valid: false }>> = {},
): Extract<CanonicalQuizTargetResolution, { valid: false }> {
  return {
    valid: false,
    nodeId,
    reason,
    reasons: [reason],
    ...details,
  };
}

/**
 * Resolve the only Cognitive Level that a normal assessment may test for a
 * MicroNode. Lower levels remain instructional/remediation steps; they are not
 * additional normal-quiz targets.
 *
 * This is deliberately fail-closed. The resolver does not infer a target from
 * targetBloomLevel, sequence, Bloom rank, difficulty, or provider output.
 */
export function resolveCanonicalQuizTarget(
  node: CanonicalQuizTargetNode,
  cognitiveLevels: readonly CanonicalQuizTargetLevel[],
): CanonicalQuizTargetResolution {
  if (node.cogPathStatus !== "confirmed") {
    return canonicalQuizTargetFailure(node.id, "PATH_NOT_CONFIRMED");
  }

  const applicableLevels = orderCognitivePathLevels(
    cognitiveLevels.filter((level) => level.isApplicable),
  );
  if (applicableLevels.length === 0) {
    return canonicalQuizTargetFailure(node.id, "NO_APPLICABLE_LEVELS");
  }

  const targetLevels = cognitiveLevels.filter((level) => level.isTargetCeiling);
  if (targetLevels.length === 0) {
    return canonicalQuizTargetFailure(node.id, "TARGET_MISSING");
  }
  if (targetLevels.length > 1) {
    return canonicalQuizTargetFailure(node.id, "MULTIPLE_TARGETS");
  }

  const target = targetLevels[0];
  if (!target.isApplicable) {
    return canonicalQuizTargetFailure(node.id, "TARGET_NOT_APPLICABLE");
  }

  // Use the existing structural authority. The resolver only translates its
  // established reasons into the more precise assessment-facing vocabulary.
  const structuralReason = assessCognitivePathStructure(applicableLevels);
  if (structuralReason === "LEVEL_ORDER_INVALID") {
    return canonicalQuizTargetFailure(node.id, "INVALID_SEQUENCE");
  }
  if (structuralReason === "COGNITIVE_LEVEL_ORDER_INVALID") {
    return canonicalQuizTargetFailure(node.id, "INVALID_COGNITIVE_ORDER");
  }
  if (structuralReason === "TARGET_CEILING_INVALID") {
    return canonicalQuizTargetFailure(node.id, "TARGET_NOT_FINAL");
  }

  const finalLevel = applicableLevels[applicableLevels.length - 1];
  if (finalLevel.id !== target.id) {
    return canonicalQuizTargetFailure(node.id, "TARGET_NOT_FINAL");
  }

  const acceptance = assessAcceptedCognitivePath({
    cogPathStatus: node.cogPathStatus,
    theoryContent: node.theoryContent,
    learningObjective: node.learningObjective,
    levels: cognitiveLevels,
  });
  if (!acceptance.accepted) {
    return canonicalQuizTargetFailure(node.id,
      acceptance.reason === "GROUNDING_NOT_ACCEPTED"
        ? "PATH_GROUNDING_FAILED"
        : "PATH_NOT_ACCEPTED",
      {
        acceptance,
        acceptanceReason: acceptance.reason,
        grounding: acceptance.grounding,
      });
  }

  const expectedTargetBloomLevel = COGNITIVE_LEVEL_RANK[target.cognitiveLevel];
  if (node.targetBloomLevel !== undefined
    && node.targetBloomLevel !== null
    && node.targetBloomLevel !== expectedTargetBloomLevel) {
    return canonicalQuizTargetFailure(node.id, "TARGET_BLOOM_COPY_MISMATCH", {
      acceptance,
      acceptanceReason: acceptance.reason,
      grounding: acceptance.grounding,
      expectedTargetBloomLevel,
      actualTargetBloomLevel: node.targetBloomLevel,
    });
  }

  const preferredInteractionTypes = target.preferredInteractionTypes as string[];
  const resolvedTarget: CanonicalQuizTarget = {
    nodeId: node.id,
    cognitiveLevelId: target.id,
    cognitiveLevel: target.cognitiveLevel,
    sequence: target.sequence,
    performanceObjective: target.performanceObjective,
    successCriterion: target.successCriterion,
    preferredInteractionTypes,
    minimumIndependentEvidence: target.minimumIndependentEvidence ?? null,
    isApplicable: true,
    isTargetCeiling: true,
    isCanonicalTarget: true,
  };
  return {
    valid: true,
    target: resolvedTarget,
    acceptance,
    ...resolvedTarget,
  };
}

export type CognitivePathConfirmationFailureReason =
  | Exclude<
      CanonicalQuizTargetFailureReason,
      "PATH_NOT_CONFIRMED" | "TARGET_BLOOM_COPY_MISMATCH"
    >
  | "MISSING_PERFORMANCE_OBJECTIVE"
  | "MISSING_SUCCESS_CRITERION"
  | "INVALID_EVIDENCE_BUDGET"
  | "INVALID_INTERACTION_TYPES"
  | "LEARNING_OBJECTIVE_COGNITIVE_FLOOR_VIOLATION";

export type CognitivePathConfirmationAssessment =
  | {
      valid: true;
      target: CanonicalQuizTarget;
      acceptance: CognitivePathAcceptance;
    }
  | {
      valid: false;
      reason: CognitivePathConfirmationFailureReason;
      reasons: CognitivePathConfirmationFailureReason[];
      acceptance?: CognitivePathAcceptance;
      acceptanceReason?: CognitivePathAcceptance["reason"];
      grounding?: CognitivePathGroundingAudit | null;
    };

/**
 * Authoring confirmation delegates to the same canonical runtime resolver while
 * deliberately ignoring the legacy targetBloomLevel copy. That copy is derived
 * from the returned target only after this assessment succeeds.
 */
export function assessCognitivePathForConfirmation(
  node: Omit<CanonicalQuizTargetNode, "cogPathStatus" | "targetBloomLevel">,
  cognitiveLevels: readonly CanonicalQuizTargetLevel[],
): CognitivePathConfirmationAssessment {
  const resolution = resolveCanonicalQuizTarget(
    {
      ...node,
      cogPathStatus: "confirmed",
      targetBloomLevel: undefined,
    },
    cognitiveLevels,
  );
  if (resolution.valid) {
    return {
      valid: true,
      target: resolution.target,
      acceptance: resolution.acceptance,
    };
  }

  const reasons: CognitivePathConfirmationFailureReason[] = [];
  const addReason = (reason: CognitivePathConfirmationFailureReason): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (resolution.reason === "PATH_NOT_CONFIRMED"
    || resolution.reason === "TARGET_BLOOM_COPY_MISMATCH") {
    addReason("PATH_NOT_ACCEPTED");
  } else if (resolution.reason === "PATH_NOT_ACCEPTED") {
    if (resolution.acceptanceReason === "EVIDENCE_BUDGET_INVALID") {
      addReason("INVALID_EVIDENCE_BUDGET");
    } else if (resolution.acceptanceReason === "INTERACTION_TYPES_INVALID") {
      addReason("INVALID_INTERACTION_TYPES");
    } else if (resolution.acceptanceReason === "LEARNING_OBJECTIVE_COGNITIVE_FLOOR_VIOLATION") {
      addReason("LEARNING_OBJECTIVE_COGNITIVE_FLOOR_VIOLATION");
    } else {
      addReason("PATH_NOT_ACCEPTED");
    }
  } else if (resolution.reason === "PATH_GROUNDING_FAILED") {
    const applicableLevels = cognitiveLevels.filter((level) => level.isApplicable);
    if (applicableLevels.some((level) => !(level.performanceObjective ?? "").trim())) {
      addReason("MISSING_PERFORMANCE_OBJECTIVE");
    }
    if (applicableLevels.some((level) => !(level.successCriterion ?? "").trim())) {
      addReason("MISSING_SUCCESS_CRITERION");
    }
    if ((resolution.grounding?.issueCounts.INVALID_INTERACTION_TYPE ?? 0) > 0) {
      addReason("INVALID_INTERACTION_TYPES");
    }
    addReason("PATH_GROUNDING_FAILED");
  } else {
    addReason(resolution.reason);
  }

  return {
    valid: false,
    reason: reasons[0],
    reasons,
    acceptance: resolution.acceptance,
    acceptanceReason: resolution.acceptanceReason,
    grounding: resolution.grounding,
  };
}

/**
 * C2 coverage is intentionally limited to approved MicroNodes. Review-state
 * nodes remain visible as excluded; they are never counted as accepted.
 */
export function assessApprovedNodeC2Coverage(input: {
  nodeStatus: string | null | undefined;
  path: CognitivePathAcceptance;
}): { included: boolean; accepted: boolean; reason: string } {
  if (input.nodeStatus !== "approved") {
    return {
      included: false,
      accepted: false,
      reason: "EXCLUDED_NON_APPROVED_NODE",
    };
  }
  return {
    included: true,
    accepted: input.path.accepted,
    reason: input.path.reason,
  };
}