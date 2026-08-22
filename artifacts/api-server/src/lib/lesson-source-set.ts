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

export type TextPageBindingAudit = {
  verificationMode: "TEXT_CONTENT";
  selectedPhysicalPages: number[];
  blockCount: number;
  providerBlockCount: number;
  verifiedBlockCount: number;
  quarantinedBlockCount: number;
  exactOrNormalizedMatchCount: number;
  contextResolvedAmbiguousCount: number;
  correctedProviderPageLabelCount: number;
  ambiguousProvenanceCount: number;
  unverifiedProvenanceCount: number;
  quarantinedBlockIndices: number[];
  quarantinedBlocks: Array<{
    providerBlockIndex: number;
    physicalPageContext: number | null;
    reason: "SOURCE_TEXT_NOT_CONTAINED" | "AMBIGUOUS_SOURCE_PROVENANCE";
  }>;
  quarantineReasonCounts: {
    SOURCE_TEXT_NOT_CONTAINED: number;
    AMBIGUOUS_SOURCE_PROVENANCE: number;
  };
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
    // pdf-parse and providers may disagree only about a visual line-wrap or
    // Armenian ligature. Remove those presentation differences before checking
    // the original server-extracted text; do not apply semantic stemming here.
    // A soft hyphen at a PDF line end is a visual wrap marker, not a word
    // boundary. Join it before stripping format characters; otherwise
    // "բացթողում­\nների" becomes the different text "բացթողում ների".
    .replace(/([\p{L}\p{N}])[-\u00AD\u2010-\u2015]\s*\r?\n\s*([\p{L}\p{N}])/gu, "$1$2")
    .replace(/\u0565\u0582/gu, "\u0587")
    .replace(/[\u00AD\u200B\u200C\u200D\u2060]/gu, "")
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
 * physical PDF page(s) extracted by the server, requiring one unambiguous
 * whole-fragment match. This prevents printed textbook footer numbers from
 * becoming provenance and prevents short repeated headings from being guessed.
 */
export function bindTextBlocksToPhysicalPages<T extends SourceBlock>(
  extractedPages: ReadonlyArray<ExtractedLessonPage>,
  blocks: ReadonlyArray<T>,
): { blocks: T[]; audit: TextPageBindingAudit } {
  const pageTexts = extractedPages.map((page) => ({
    pageNumber: page.pageNumber,
    text: comparableText(page.text),
  }));
  let exactOrNormalizedMatchCount = 0;
  let contextResolvedAmbiguousCount = 0;
  let correctedProviderPageLabelCount = 0;
  let ambiguousProvenanceCount = 0;
  let unverifiedProvenanceCount = 0;
  const quarantinedBlockIndices: number[] = [];
  const quarantinedBlocks: TextPageBindingAudit["quarantinedBlocks"] = [];
  const quarantineReasonCounts = {
    SOURCE_TEXT_NOT_CONTAINED: 0,
    AMBIGUOUS_SOURCE_PROVENANCE: 0,
  };

  const candidates = blocks.map((block) => {
    const sourceText = comparableText(block.sourceText);
    return sourceText
      ? pageTexts.filter((page) => page.text.includes(sourceText)).map((page) => page.pageNumber)
      : [];
  });
  const physicalPages = candidates.map((matches) => matches.length === 1 ? matches[0] : 0);

  // A short heading may appear on two selected pages. The provider's label is
  // never used to break that tie. We can, however, prove ownership when the
  // immediately surrounding server-verifiable blocks are both on the same
  // candidate page in the source's reading order.
  for (let index = 0; index < candidates.length; index++) {
    if (physicalPages[index] !== 0 || candidates[index].length < 2) continue;
    let previousPage = 0;
    let nextPage = 0;
    for (let previous = index - 1; previous >= 0; previous--) {
      if (physicalPages[previous] !== 0) {
        previousPage = physicalPages[previous];
        break;
      }
    }
    for (let next = index + 1; next < physicalPages.length; next++) {
      if (physicalPages[next] !== 0) {
        nextPage = physicalPages[next];
        break;
      }
    }
    if (
      previousPage > 0 &&
      previousPage === nextPage &&
      candidates[index].includes(previousPage)
    ) {
      physicalPages[index] = previousPage;
      contextResolvedAmbiguousCount++;
    }
  }

  const boundBlocks = blocks.map((block, index) => {
    const matches = candidates[index];
    const physicalPage = physicalPages[index];
    if (matches.length === 1) {
      exactOrNormalizedMatchCount++;
      if (Number.isInteger(block.sourcePage) && block.sourcePage > 0 && block.sourcePage !== physicalPage) {
        correctedProviderPageLabelCount++;
      }
    } else if (physicalPage > 0) {
      if (Number.isInteger(block.sourcePage) && block.sourcePage > 0 && block.sourcePage !== physicalPage) {
        correctedProviderPageLabelCount++;
      }
    } else if (matches.length > 1) {
      ambiguousProvenanceCount++;
      quarantinedBlockIndices.push(index);
      quarantinedBlocks.push({
        providerBlockIndex: index,
        physicalPageContext: pageTexts.length === 1 ? pageTexts[0].pageNumber : null,
        reason: "AMBIGUOUS_SOURCE_PROVENANCE",
      });
      quarantineReasonCounts.AMBIGUOUS_SOURCE_PROVENANCE++;
    } else {
      unverifiedProvenanceCount++;
      quarantinedBlockIndices.push(index);
      quarantinedBlocks.push({
        providerBlockIndex: index,
        physicalPageContext: pageTexts.length === 1 ? pageTexts[0].pageNumber : null,
        reason: "SOURCE_TEXT_NOT_CONTAINED",
      });
      quarantineReasonCounts.SOURCE_TEXT_NOT_CONTAINED++;
    }

    return { ...block, sourcePage: physicalPage };
  });

  return {
    blocks: boundBlocks,
    audit: {
      verificationMode: "TEXT_CONTENT",
      selectedPhysicalPages: pageTexts.map((page) => page.pageNumber),
      blockCount: blocks.length,
      providerBlockCount: blocks.length,
      verifiedBlockCount: blocks.length - quarantinedBlockIndices.length,
      quarantinedBlockCount: quarantinedBlockIndices.length,
      exactOrNormalizedMatchCount,
      contextResolvedAmbiguousCount,
      correctedProviderPageLabelCount,
      ambiguousProvenanceCount,
      unverifiedProvenanceCount,
      quarantinedBlockIndices,
      quarantinedBlocks,
      quarantineReasonCounts,
    },
  };
}

/**
 * Only blocks with server-proven physical-page ownership may enter Pass 2.
 * Blocks with sourcePage=0 remain available to count-only quarantine diagnostics
 * but are not part of the canonical Pass 1 source universe.
 */
export function filterVerifiedTextBlocks<T extends SourceBlock>(
  boundBlocks: ReadonlyArray<T>,
): T[] {
  return boundBlocks.filter((block) =>
    Number.isInteger(block.sourcePage) && block.sourcePage > 0,
  );
}

/** Backward-compatible block-only view for pure callers. */
export function assignTextBlocksToPhysicalPages<T extends SourceBlock>(
  extractedPages: ReadonlyArray<ExtractedLessonPage>,
  blocks: ReadonlyArray<T>,
): T[] {
  return bindTextBlocksToPhysicalPages(extractedPages, blocks).blocks;
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