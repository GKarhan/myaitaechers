export const TEACHING_CONTENT_GROUNDING_ISSUE = {
  EMPTY_FIELD: "empty-field",
  NOVEL_NUMERIC_CLAIM: "novel-numeric-claim",
  UNSUPPORTED_STRONG_CLAIM: "unsupported-strong-claim",
  LOW_SOURCE_ANCHOR: "low-source-anchor",
} as const;

export type TeachingContentGroundingIssueCode =
  typeof TEACHING_CONTENT_GROUNDING_ISSUE[keyof typeof TEACHING_CONTENT_GROUNDING_ISSUE];

export type TeachingContentGroundingAudit = {
  valid: boolean;
  checkedFieldCount: number;
  issueCounts: Partial<Record<TeachingContentGroundingIssueCode, number>>;
  fieldsWithIssues: string[];
};

export type TeachingContentCandidate = {
  childFriendlyExplanation: string;
  basicExamples: string[];
  commonMisconception: string;
  nonExamples: string[];
};

const STRONG_CLAIM = /(?:միշտ|երբեք|միայն|անպայման|պետք\s+է|չի\s+կարող|սխալ\s+է|արգելվում է|always|never|only|must|cannot|is wrong)/iu;

function normalizedComparableText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("hy-AM")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceAnchorTokens(value: string): Set<string> {
  return new Set(
    normalizedComparableText(value)
      .split(" ")
      .filter((token) => token.length >= 4),
  );
}

function numericTokens(value: string): string[] {
  return value.match(/\d+(?:[\/.,:]\d+)*/g) ?? [];
}

/**
 * A deterministic safety screen, not a claim of full semantic entailment. It
 * blocks facts the authoritative source cannot support and reports only field
 * names/counts, never textbook or generated content.
 */
export function validateTeachingContentGrounding(
  theoryContent: string | null | undefined,
  candidate: TeachingContentCandidate,
): TeachingContentGroundingAudit {
  const source = normalizedComparableText(theoryContent ?? "");
  const anchors = sourceAnchorTokens(source);
  const sourceNumbers = new Set(numericTokens(source));
  const values: Array<[string, string]> = [
    ["childFriendlyExplanation", candidate.childFriendlyExplanation],
    ...candidate.basicExamples.map((value, index) => [`basicExamples.${index}`, value] as [string, string]),
    ["commonMisconception", candidate.commonMisconception],
    ...candidate.nonExamples.map((value, index) => [`nonExamples.${index}`, value] as [string, string]),
  ];
  const issueCounts: TeachingContentGroundingAudit["issueCounts"] = {};
  const fieldsWithIssues = new Set<string>();
  const add = (field: string, code: TeachingContentGroundingIssueCode) => {
    fieldsWithIssues.add(field);
    issueCounts[code] = (issueCounts[code] ?? 0) + 1;
  };

  for (const [field, rawValue] of values) {
    const value = normalizedComparableText(rawValue);
    if (!value) {
      add(field, TEACHING_CONTENT_GROUNDING_ISSUE.EMPTY_FIELD);
      continue;
    }

    const candidateNumbers = numericTokens(value);
    if (candidateNumbers.some((number) => !sourceNumbers.has(number))) {
      add(field, TEACHING_CONTENT_GROUNDING_ISSUE.NOVEL_NUMERIC_CLAIM);
    }

    const overlap = [...sourceAnchorTokens(value)].filter((token) => anchors.has(token)).length;
    // Rephrasing is allowed, but a substantive generated statement needs a
    // concept anchor from the node's source. Short connective-only text is not
    // a teaching claim and is handled by the empty/strong checks instead.
    if (value.length >= 24 && overlap === 0) {
      add(field, TEACHING_CONTENT_GROUNDING_ISSUE.LOW_SOURCE_ANCHOR);
    }

    // Absolute, normative, or corrective claims need direct source wording.
    // This specifically rejects invented statements such as a new address form
    // being "wrong" when the source merely demonstrates one possible form.
    if (STRONG_CLAIM.test(value) && !source.includes(value)) {
      add(field, TEACHING_CONTENT_GROUNDING_ISSUE.UNSUPPORTED_STRONG_CLAIM);
    }
  }

  return {
    valid: fieldsWithIssues.size === 0,
    checkedFieldCount: values.length,
    issueCounts,
    fieldsWithIssues: [...fieldsWithIssues],
  };
}