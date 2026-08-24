/**
 * Semantic scope is intentionally separate from physical source verification.
 * A block can be verified, persisted, and auditable while being ineligible to
 * define canonical knowledge for the selected lesson.
 */
export type LessonSemanticScope =
  | "IN_SCOPE"
  | "ADJACENT_NEXT_SECTION"
  | "STRUCTURAL"
  | "REVIEW_REQUIRED";

export type SemanticScopeReasonCode =
  | "IN_SCOPE_DEFAULT"
  | "STRUCTURAL_HEADING"
  | "NEXT_SECTION_HEADING"
  | "NEXT_SECTION_CONTEXT"
  | "ADJACENT_EXERCISE_MATCH"
  | "TERMINAL_HEADING_REQUIRES_REVIEW";

export type SemanticScopeBlock = {
  blockType: string;
  sourceText: string;
  sourcePage: number;
};

export type LessonSemanticScopeRecord = {
  blockIndex: number;
  scope: LessonSemanticScope;
  reasonCodes: SemanticScopeReasonCode[];
};

export type LessonSemanticScopeAudit = {
  records: LessonSemanticScopeRecord[];
  inScopeBlockIndices: number[];
  excludedCandidateBlockIndices: number[];
  adjacentBlockIndices: number[];
  structuralBlockIndices: number[];
  reviewRequiredBlockIndices: number[];
};

const ACTIVITY_TYPES = new Set(["EXERCISE", "ACTIVITY", "HOMEWORK"]);
const HEADING_TYPES = new Set(["OBJECTIVE", "NOTE"]);
const GENERIC_TOKENS = new Set([
  "lesson", "section", "chapter", "topic", "exercise", "example",
  "դաս", "բաժին", "գլուխ", "թեմա", "վարժություն", "օրինակ",
]);

function semanticTokens(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase("hy-AM")
      .split(/[^\p{L}\p{N}]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !GENERIC_TOKENS.has(token)),
  );
}

function looksLikeHeading(block: SemanticScopeBlock): boolean {
  if (!HEADING_TYPES.has(block.blockType)) return false;
  const text = block.sourceText.trim();
  if (!text || text.length > 140) return false;
  if (/^(?:§\s*)?\d+(?:\.\d+)+/u.test(text)) return true;
  if (/[.!?։]/u.test(text)) return false;
  const letters = [...text].filter((character) => /\p{L}/u.test(character));
  if (letters.length < 4) return false;
  const uppercaseLetters = letters.filter((character) => character === character.toLocaleUpperCase("hy-AM"));
  const titleCase = /^\p{Lu}/u.test(text) && semanticTokens(text).size <= 8;
  return uppercaseLetters.length / letters.length >= 0.7 || titleCase;
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...left].some((token) => right.has(token));
}

/**
 * A conservative, deterministic lesson-range boundary detector. It only
 * excludes material when a terminal-page heading is clearly unrelated to the
 * selected title and has nearby supporting context. Ambiguous headings remain
 * review-required instead of being discarded.
 */
export function deriveLessonSemanticScope(input: {
  blocks: ReadonlyArray<SemanticScopeBlock>;
  lessonTitle: string;
  pagesTo?: number | null;
}): LessonSemanticScopeAudit {
  const records = input.blocks.map((_, blockIndex): LessonSemanticScopeRecord => ({
    blockIndex,
    scope: "IN_SCOPE",
    reasonCodes: ["IN_SCOPE_DEFAULT"],
  }));
  const titleTokens = semanticTokens(input.lessonTitle);
  const terminalPage = input.pagesTo ?? Math.max(...input.blocks.map((block) => block.sourcePage), 0);
  const headingIndex = input.blocks.findIndex((block, blockIndex) => {
    if (blockIndex === 0 || block.sourcePage !== terminalPage || !looksLikeHeading(block)) return false;
    const headingTokens = semanticTokens(block.sourceText);
    // Shared subject nouns ("function", "graph", etc.) do not establish
    // same-section continuity. A terminal heading can stay in scope only when
    // its meaningful title tokens are wholly contained in the selected lesson
    // title; otherwise preserve it as adjacent material until a teacher says
    // it belongs to this lesson.
    const clearlySameSection = headingTokens.size > 0
      && [...headingTokens].every((token) => titleTokens.has(token));
    const hasAdjacentContext = input.blocks
      .slice(blockIndex + 1)
      .some((following) => following.sourcePage === terminalPage);
    const hasExplicitNextSectionNumber = /^(?:§\s*)?\d+(?:\.\d+)+/u.test(block.sourceText.trim());
    return hasExplicitNextSectionNumber && hasAdjacentContext && !clearlySameSection;
  });

  if (headingIndex >= 0) {
    const heading = input.blocks[headingIndex];
    const headingTokens = semanticTokens(heading.sourceText);
    records[headingIndex] = {
      blockIndex: headingIndex,
      scope: "ADJACENT_NEXT_SECTION",
      reasonCodes: ["NEXT_SECTION_HEADING"],
    };
    for (let index = headingIndex + 1; index < input.blocks.length; index++) {
      const block = input.blocks[index];
      if (block.sourcePage !== terminalPage) continue;
      records[index] = {
        blockIndex: index,
        scope: "ADJACENT_NEXT_SECTION",
        reasonCodes: ["NEXT_SECTION_CONTEXT"],
      };
    }
    for (let index = headingIndex - 1; index >= 0; index--) {
      const block = input.blocks[index];
      if (block.sourcePage !== terminalPage || !ACTIVITY_TYPES.has(block.blockType)) break;
      if (!intersects(semanticTokens(block.sourceText), headingTokens)) break;
      records[index] = {
        blockIndex: index,
        scope: "ADJACENT_NEXT_SECTION",
        reasonCodes: ["ADJACENT_EXERCISE_MATCH"],
      };
    }
  } else {
    input.blocks.forEach((block, blockIndex) => {
      if (block.sourcePage !== terminalPage || !looksLikeHeading(block)) return;
      const headingTokens = semanticTokens(block.sourceText);
      const clearlySameSection = headingTokens.size > 0
        && [...headingTokens].every((token) => titleTokens.has(token));
      if (headingTokens.size === 0 || clearlySameSection) return;
      input.blocks.forEach((following, followingIndex) => {
        if (followingIndex < blockIndex || following.sourcePage !== terminalPage) return;
        records[followingIndex] = {
          blockIndex: followingIndex,
          scope: "REVIEW_REQUIRED",
          reasonCodes: ["TERMINAL_HEADING_REQUIRES_REVIEW"],
        };
      });
    });
  }

  input.blocks.forEach((block, blockIndex) => {
    if (records[blockIndex].scope !== "IN_SCOPE") return;
    if (looksLikeHeading(block)) {
      records[blockIndex] = {
        blockIndex,
        scope: "STRUCTURAL",
        reasonCodes: ["STRUCTURAL_HEADING"],
      };
    }
  });

  const byScope = (scope: LessonSemanticScope) => records
    .filter((record) => record.scope === scope)
    .map((record) => record.blockIndex);
  return {
    records,
    inScopeBlockIndices: byScope("IN_SCOPE"),
    excludedCandidateBlockIndices: records
      .filter((record) => record.scope !== "IN_SCOPE")
      .map((record) => record.blockIndex),
    adjacentBlockIndices: byScope("ADJACENT_NEXT_SECTION"),
    structuralBlockIndices: byScope("STRUCTURAL"),
    reviewRequiredBlockIndices: byScope("REVIEW_REQUIRED"),
  };
}