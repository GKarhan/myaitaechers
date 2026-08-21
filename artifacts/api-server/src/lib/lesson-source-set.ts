import { createHash } from "node:crypto";

export type ExtractedLessonPage = {
  pageNumber: number;
  text: string;
};

export type LessonSourceSet = {
  version: 1;
  resourceId: number;
  resourceFileUrl: string;
  pagesFrom: number;
  pagesTo: number;
  extractedAt: string;
  contentHash: string;
  pages: Array<{
    pageNumber: number;
    contentHash: string;
    characterCount: number;
  }>;
  titleMatch: {
    valid: boolean;
    matchedTokenCount: number;
    requiredTokenCount: number;
    tableOfContentsPageCount: number;
  };
};

export type SourceScopeAudit = {
  valid: boolean;
  verificationMode: "TEXT_CONTENT" | "VISION_PAGE";
  checkedBlockCount: number;
  invalidBlockIndices: number[];
  invalidPageCount: number;
  unverifiableTextCount: number;
  reasonCodes: Array<"SOURCE_PAGE_OUT_OF_SCOPE" | "SOURCE_TEXT_NOT_IN_SELECTED_PAGE">;
};

type SourceBlock = {
  sourcePage: number;
  sourceText: string;
};

const GENERIC_TITLE_TOKENS = new Set([
  "դաս", "թեմ", "գլուխ", "վարժ", "առաջադր", "օրինակ", "մաս", "նյութ",
]);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizedWords(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("hy-AM")
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      for (const suffix of ["ություններ", "ության", "ումներից", "ումներին", "ումների", "ումը", "ման", "ումով", "ում", "ների", "երը", "ները", "երի", "ներ", "ը"]) {
        if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
          return token.slice(0, -suffix.length);
        }
      }
      return token;
    });
}

function comparableText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("hy-AM")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleTokens(lessonTitle: string): string[] {
  return [...new Set(
    normalizedWords(lessonTitle).filter((token) =>
      token.length >= 4 && !GENERIC_TITLE_TOKENS.has(token),
    ),
  )];
}

function isLikelyTableOfContentsPage(text: string): boolean {
  const lessonEntryCount = (text.match(/(?:^|\n)\s*Դաս\s+\d+\.\d+/gu) ?? []).length;
  return lessonEntryCount >= 3 || /(?:^|\n)\s*Բովանդակություն(?:\s|$)/u.test(text);
}

/**
 * Builds a persisted, source-safe identity for the exact resource pages used by
 * one mapping run. Raw textbook text is intentionally never included.
 */
export function buildLessonSourceSet(input: {
  resourceId: number;
  resourceFileUrl: string;
  pagesFrom: number;
  pagesTo: number;
  lessonTitle: string;
  extractedPages: ReadonlyArray<ExtractedLessonPage>;
}): LessonSourceSet {
  const requestedPages = new Set<number>();
  for (let page = input.pagesFrom; page <= input.pagesTo; page++) requestedPages.add(page);
  const requiredTitleTokens = titleTokens(input.lessonTitle);
  const contentPages = input.extractedPages.filter((page) => !isLikelyTableOfContentsPage(page.text));
  const contentPageWordSet = new Set(contentPages.flatMap((page) => normalizedWords(page.text)));
  const matchedTokenCount = requiredTitleTokens.filter((token) => contentPageWordSet.has(token)).length;
  const tableOfContentsPageCount = input.extractedPages.length - contentPages.length;

  return {
    version: 1,
    resourceId: input.resourceId,
    resourceFileUrl: input.resourceFileUrl,
    pagesFrom: input.pagesFrom,
    pagesTo: input.pagesTo,
    extractedAt: new Date().toISOString(),
    contentHash: sha256(input.extractedPages.map((page) => `${page.pageNumber}\n${page.text}`).join("\n\f\n")),
    pages: input.extractedPages
      .filter((page) => requestedPages.has(page.pageNumber))
      .map((page) => ({
        pageNumber: page.pageNumber,
        contentHash: sha256(page.text),
        characterCount: page.text.length,
      })),
    titleMatch: {
      // An entry in a table of contents is not lesson material. A selected
      // range containing any contents page is rejected instead of allowing
      // unrelated lesson titles into Pass 1 beside the intended lesson.
      valid: requiredTitleTokens.length > 0 &&
        matchedTokenCount === requiredTitleTokens.length &&
        tableOfContentsPageCount === 0,
      matchedTokenCount,
      requiredTokenCount: requiredTitleTokens.length,
      tableOfContentsPageCount,
    },
  };
}

/**
 * Validates model-produced Pass 1 blocks against server-extracted selected
 * pages. The audit deliberately contains indexes and counts only.
 */
export function validateBlocksAgainstLessonSourceSet(
  sourceSet: LessonSourceSet,
  extractedPages: ReadonlyArray<ExtractedLessonPage>,
  blocks: ReadonlyArray<SourceBlock>,
  options: { verifyTextContent?: boolean } = {},
): SourceScopeAudit {
  const verifyTextContent = options.verifyTextContent ?? true;
  const pageTextByNumber = new Map(
    extractedPages.map((page) => [page.pageNumber, comparableText(page.text)]),
  );
  const invalidBlockIndices: number[] = [];
  let invalidPageCount = 0;
  let unverifiableTextCount = 0;

  blocks.forEach((block, index) => {
    const pageText = pageTextByNumber.get(block.sourcePage);
    if (
      !Number.isInteger(block.sourcePage) ||
      block.sourcePage < sourceSet.pagesFrom ||
      block.sourcePage > sourceSet.pagesTo ||
      !pageText
    ) {
      invalidBlockIndices.push(index);
      invalidPageCount++;
      return;
    }

    const sourceText = comparableText(block.sourceText);
    if (verifyTextContent && (!sourceText || !pageText.includes(sourceText))) {
      invalidBlockIndices.push(index);
      unverifiableTextCount++;
    }
  });

  const reasonCodes: SourceScopeAudit["reasonCodes"] = [];
  if (invalidPageCount > 0) reasonCodes.push("SOURCE_PAGE_OUT_OF_SCOPE");
  if (unverifiableTextCount > 0) reasonCodes.push("SOURCE_TEXT_NOT_IN_SELECTED_PAGE");
  return {
    valid: sourceSet.titleMatch.valid && invalidBlockIndices.length === 0,
    verificationMode: verifyTextContent ? "TEXT_CONTENT" : "VISION_PAGE",
    checkedBlockCount: blocks.length,
    invalidBlockIndices,
    invalidPageCount,
    unverifiableTextCount,
    reasonCodes,
  };
}

/**
 * Text-model page labels are advisory only. Bind a verbatim block to the
 * physical PDF page(s) extracted by the server, preferring an unambiguous text
 * match. This prevents printed textbook footer numbers from becoming provenance.
 */
export function assignTextBlocksToPhysicalPages<T extends SourceBlock>(
  extractedPages: ReadonlyArray<ExtractedLessonPage>,
  blocks: ReadonlyArray<T>,
): T[] {
  const pageTexts = extractedPages.map((page) => ({
    pageNumber: page.pageNumber,
    text: comparableText(page.text),
  }));
  return blocks.map((block) => {
    const sourceText = comparableText(block.sourceText);
    const matches = sourceText
      ? pageTexts.filter((page) => page.text.includes(sourceText)).map((page) => page.pageNumber)
      : [];
    const physicalPage = matches.length === 1
      ? matches[0]
      : matches.includes(block.sourcePage)
        ? block.sourcePage
        : 0;
    return { ...block, sourcePage: physicalPage };
  });
}

/**
 * Vision extraction is intentionally one physical page per request. For scanned
 * PDFs, parser text cannot validate OCR output, so source text containment is
 * replaced by server-assigned page identity plus a title anchor from the
 * model's extraction. This is never used for text-extractable PDFs.
 */
export function applyVisionTitleAnchor(
  sourceSet: LessonSourceSet,
  lessonTitle: string,
  blocks: ReadonlyArray<SourceBlock>,
): LessonSourceSet {
  const requiredTokens = titleTokens(lessonTitle);
  const blockTokens = new Set(blocks.flatMap((block) => normalizedWords(block.sourceText)));
  const matchedTokenCount = requiredTokens.filter((token) => blockTokens.has(token)).length;
  return {
    ...sourceSet,
    titleMatch: {
      valid: requiredTokens.length > 0 &&
        matchedTokenCount === requiredTokens.length &&
        sourceSet.titleMatch.tableOfContentsPageCount === 0,
      matchedTokenCount,
      requiredTokenCount: requiredTokens.length,
      tableOfContentsPageCount: sourceSet.titleMatch.tableOfContentsPageCount,
    },
  };
}

export function formatExtractedPagesForPass1(
  pages: ReadonlyArray<ExtractedLessonPage>,
): string {
  return pages.map((page) => `[PDF PAGE ${page.pageNumber}]\n${page.text}`).join("\n\n");
}