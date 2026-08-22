import { isUnreadableSource } from "./micronode-source-alignment.js";

export type CognitivePathGroundingStatus = "GROUNDED" | "REVIEW_REQUIRED" | "INVALID";
export type CognitivePathGroundingAudit = {
  status: CognitivePathGroundingStatus;
  valid: boolean;
  issueCounts: Record<string, number>;
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