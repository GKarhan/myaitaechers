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
    | "INTERACTION_TYPES_INVALID"
    | "GROUNDING_NOT_ACCEPTED";
  grounding: CognitivePathGroundingAudit | null;
};

const ALLOWED_INTERACTIONS = new Set([
  "multiple_choice", "multi_select", "true_false", "matching", "classification",
  "ordering", "numeric_answer", "short_answer", "constructed_response", "problem_solving",
]);
const strongClaim = /(?:միշտ|երբեք|միայն|անպայման|սխալ\s+է|always|never|only|must|wrong)/iu;
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("hy-AM")
  .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
const numbers = (value: string) => value.match(/\d+(?:[\/.,:]\d+)*/g) ?? [];
const anchors = (value: string) => new Set(normalize(value).split(" ").filter((token) => token.length >= 4));

export function validateCognitivePathGrounding(
  theoryContent: string | null | undefined,
  learningObjective: string | null | undefined,
  levels: ReadonlyArray<{ performanceObjective: string | null; successCriterion: string | null; preferredInteractionTypes: string[] | null }>,
): CognitivePathGroundingAudit {
  const source = normalize(theoryContent ?? "");
  const sourceNumbers = new Set(numbers(source));
  const sourceAnchors = anchors(`${source} ${learningObjective ?? ""}`);
  const issueCounts: Record<string, number> = {};
  const add = (code: string) => { issueCounts[code] = (issueCounts[code] ?? 0) + 1; };
  if (isUnreadableSource(theoryContent ?? "")) add("UNREADABLE_SOURCE");
  for (const level of levels) {
    for (const value of [level.performanceObjective ?? "", level.successCriterion ?? ""]) {
      const text = normalize(value);
      if (!text) { add("EMPTY_REQUIRED_FIELD"); continue; }
      if (numbers(text).some((number) => !sourceNumbers.has(number))) add("NOVEL_NUMERIC_CLAIM");
      const overlap = [...anchors(text)].filter((token) => sourceAnchors.has(token)).length;
      if (text.length >= 24 && overlap === 0) add("LOW_SOURCE_ANCHOR");
      if (strongClaim.test(text) && !source.includes(text)) add("UNSUPPORTED_STRONG_CLAIM");
    }
    if ((level.preferredInteractionTypes ?? []).some((kind) => !ALLOWED_INTERACTIONS.has(kind))) add("INVALID_INTERACTION_TYPE");
  }
  const invalid = ["UNREADABLE_SOURCE", "EMPTY_REQUIRED_FIELD", "NOVEL_NUMERIC_CLAIM", "UNSUPPORTED_STRONG_CLAIM", "INVALID_INTERACTION_TYPE"]
    .some((code) => issueCounts[code]);
  const review = !!issueCounts.LOW_SOURCE_ANCHOR;
  return { status: invalid ? "INVALID" : review ? "REVIEW_REQUIRED" : "GROUNDED", valid: !invalid, issueCounts };
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

  const applicableLevels = input.levels.filter((level) => level.isApplicable);
  if (applicableLevels.length === 0) {
    return { accepted: false, reason: "NO_APPLICABLE_LEVELS", grounding: null };
  }
  if (applicableLevels.filter((level) => level.isTargetCeiling).length !== 1) {
    return { accepted: false, reason: "TARGET_CEILING_INVALID", grounding: null };
  }
  if (applicableLevels.some((level, index) =>
    index > 0 && level.sequence <= applicableLevels[index - 1].sequence,
  )) {
    return { accepted: false, reason: "LEVEL_ORDER_INVALID", grounding: null };
  }
  if (applicableLevels.some((level) =>
    !Array.isArray(level.preferredInteractionTypes) ||
    level.preferredInteractionTypes.some((kind) => typeof kind !== "string"),
  )) {
    return { accepted: false, reason: "INTERACTION_TYPES_INVALID", grounding: null };
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