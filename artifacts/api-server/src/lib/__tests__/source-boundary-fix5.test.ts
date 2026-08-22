import assert from "node:assert/strict";
import {
  buildLessonSourceSet,
  applyVisionTitleAnchor,
  assignTextBlocksToPhysicalPages,
  bindTextBlocksToPhysicalPages,
  formatExtractedPagesForPass1,
  validateBlocksAgainstLessonSourceSet,
} from "../lesson-source-set.js";
import { validateTeachingContentGrounding } from "../teaching-content-grounding.js";
import { consolidateHighConfidenceOverSplits, normalisePass1, type Pass2TopicResult } from "../../services/lesson-mapping.js";

const lessonPages = [{
  pageNumber: 11,
  text: "1.1 Շենքերի համարակալումը։ Փողոցի մի կողմի շենքերը համարակալվում են զույգ թվերով։",
}];

{
  const sourceSet = buildLessonSourceSet({
    resourceId: 19,
    resourceFileUrl: "/uploads/book.pdf",
    pagesFrom: 11,
    pagesTo: 11,
    lessonTitle: "Շենքերի համարակալումը",
    extractedPages: lessonPages,
  });
  assert.equal(sourceSet.titleMatch.valid, true);
  const audit = validateBlocksAgainstLessonSourceSet(sourceSet, lessonPages, [{
    sourcePage: 11,
    sourceText: "Փողոցի մի կողմի շենքերը համարակալվում են զույգ թվերով։",
  }]);
  assert.equal(audit.valid, true);
  console.log("  ✓ source-set accepts a block verbatim from a selected lesson page");
}

{
  const pages = [
    {
      pageNumber: 10,
      text: "Բովանդակություն\nԴաս 1.1 Շենքերի համարակալումը\nԴաս 1.2 Բնական թվերի շարքը\nԴաս 1.3 Թվանշաններ",
    },
    ...lessonPages,
  ];
  const sourceSet = buildLessonSourceSet({
    resourceId: 19,
    resourceFileUrl: "/uploads/book.pdf",
    pagesFrom: 10,
    pagesTo: 11,
    lessonTitle: "Շենքերի համարակալումը",
    extractedPages: pages,
  });
  assert.equal(sourceSet.titleMatch.valid, false);
  assert.equal(sourceSet.titleMatch.tableOfContentsPageCount, 1);
  console.log("  ✓ a range containing table-of-contents material is rejected before Pass 1");
}

{
  const sourceSet = buildLessonSourceSet({
    resourceId: 19,
    resourceFileUrl: "/uploads/book.pdf",
    pagesFrom: 11,
    pagesTo: 11,
    lessonTitle: "Շենքերի համարակալումը",
    extractedPages: lessonPages,
  });
  const audit = validateBlocksAgainstLessonSourceSet(sourceSet, lessonPages, [{
    sourcePage: 12,
    sourceText: "Այլ դասի նյութ",
  }]);
  assert.equal(audit.valid, false);
  assert.deepEqual(audit.invalidBlockIndices, [0]);
  assert.equal(audit.invalidPageCount, 1);
  console.log("  ✓ out-of-range model page provenance cannot enter Pass 2");
}

{
  const physicalPages = [{ pageNumber: 11, text: "Տպագիր էջ 37։ Շենքերի համարակալումը սկսվում է այստեղ։" }];
  const bound = bindTextBlocksToPhysicalPages(physicalPages, [{
    sourcePage: 37,
    sourceText: "Շենքերի համարակալումը սկսվում է այստեղ։",
  }]);
  assert.equal(bound.blocks[0].sourcePage, 11);
  assert.equal(bound.audit.correctedProviderPageLabelCount, 1);
  console.log("  ✓ wrong provider and printed textbook labels are corrected to the physical PDF page");
}

{
  const physicalPages = [
    { pageNumber: 11, text: "Տպագիր էջ 10։ Առաջին կանոնը գրված է այստեղ։" },
    { pageNumber: 12, text: "Երկրորդ կանոնը գրված է այստեղ։" },
  ];
  const bound = bindTextBlocksToPhysicalPages(physicalPages, [
    { sourcePage: 12, sourceText: "Առաջին կանոնը գրված է այստեղ։" },
    { sourcePage: 11, sourceText: "Երկրորդ կանոնը գրված է այստեղ։" },
  ]);
  assert.deepEqual(bound.blocks.map((block) => block.sourcePage), [11, 12]);
  assert.equal(bound.audit.correctedProviderPageLabelCount, 2);
  console.log("  ✓ multi-page text blocks bind from server text, not swapped provider labels");
}

{
  const physicalPages = [{ pageNumber: 11, text: "Համարա-\nկալման կանոնը գրված է այստեղ։" }];
  const bound = bindTextBlocksToPhysicalPages(physicalPages, [{
    sourcePage: 10,
    sourceText: "Համարակալման կանոնը գրված է այստեղ։",
  }]);
  assert.equal(bound.blocks[0].sourcePage, 11);
  assert.equal(bound.audit.correctedProviderPageLabelCount, 1);
  console.log("  ✓ visual PDF line wraps cannot prevent a deterministic physical-page binding");
}

{
  const physicalPages = [{
    pageNumber: 14,
    text: "եւ\u00ad\nթվային\u200b ճառագայթը սկսվում է զրոյից։",
  }];
  const bound = bindTextBlocksToPhysicalPages(physicalPages, [{
    sourcePage: 14,
    sourceText: "ևթվային ճառագայթը սկսվում է զրոյից։",
  }]);
  assert.equal(bound.blocks[0].sourcePage, 14);
  console.log("  ✓ Armenian ligature, soft hyphen, and zero-width PDF artifacts retain identity-only binding");
}

{
  const physicalPages = [{ pageNumber: 14, text: "Բնական թվերը օգտագործվում են առարկաները հաշվելու համար։" }];
  const bound = bindTextBlocksToPhysicalPages(physicalPages, [{
    sourcePage: 14,
    sourceText: "Առարկաները բնական թվերով են հաշվում։",
  }]);
  assert.equal(bound.blocks[0].sourcePage, 0);
  assert.equal(bound.audit.quarantineReasonCounts.SOURCE_TEXT_NOT_CONTAINED, 1);
  console.log("  ✓ provider paraphrase remains unbound despite the same topic");
}

{
  const selectedPage = [{ pageNumber: 14, text: "Բնական թվերի շարքը սկսվում է մեկից։" }];
  const bound = bindTextBlocksToPhysicalPages(selectedPage, [{
    sourcePage: 15,
    sourceText: "Հաջորդ էջի վարժությունը այստեղ չէ։",
  }]);
  assert.equal(bound.blocks[0].sourcePage, 0);
  console.log("  ✓ neighboring-page text outside the selected range remains unbound");
}

{
  const continuationPages = [
    { pageNumber: 14, text: "1.2 Բնական թվերի շարքը։ Բնական թվերը հաշվում են առարկաները։" },
    { pageNumber: 15, text: "ՎԱՐԺՈՒԹՅՈՒՆՆԵՐ։ Հաջորդող թիվը որոշիր։" },
  ];
  const sourceSet = buildLessonSourceSet({
    resourceId: 19,
    resourceFileUrl: "/uploads/math5.pdf",
    pagesFrom: 14,
    pagesTo: 15,
    lessonTitle: "Բնական թվերի շարքը",
    extractedPages: continuationPages,
  });
  assert.equal(sourceSet.titleMatch.valid, true);
  console.log("  ✓ title anchor remains valid when a continuation page does not repeat it");
}

{
  const physicalPages = [
    { pageNumber: 11, text: "Կրկնվող վերնագիր։ Առաջին եզակի բացատրություն։" },
    { pageNumber: 12, text: "Կրկնվող վերնագիր։ Երկրորդ եզակի բացատրություն։" },
  ];
  const bound = bindTextBlocksToPhysicalPages(physicalPages, [{
    sourcePage: 12,
    sourceText: "Կրկնվող վերնագիր։",
  }]);
  assert.equal(bound.blocks[0].sourcePage, 0);
  assert.equal(bound.audit.ambiguousProvenanceCount, 1);
  console.log("  ✓ repeated short headings remain unverified instead of being guessed");
}

{
  const physicalPages = [
    { pageNumber: 11, text: "Առաջին եզակի նախադասություն։ Կրկնվող վերնագիր։ Վերջին եզակի նախադասություն։" },
    { pageNumber: 12, text: "Կրկնվող վերնագիր։ Այլ նյութ։" },
  ];
  const bound = bindTextBlocksToPhysicalPages(physicalPages, [
    { sourcePage: 12, sourceText: "Առաջին եզակի նախադասություն։" },
    { sourcePage: 12, sourceText: "Կրկնվող վերնագիր։" },
    { sourcePage: 12, sourceText: "Վերջին եզակի նախադասություն։" },
  ]);
  assert.deepEqual(bound.blocks.map((block) => block.sourcePage), [11, 11, 11]);
  assert.equal(bound.audit.contextResolvedAmbiguousCount, 1);
  console.log("  ✓ a repeated heading may use same-page server-verified structural neighbors");
}

{
  const physicalPages = [{ pageNumber: 11, text: "Միայն ընտրված էջի ստուգելի նյութ։" }];
  const bound = bindTextBlocksToPhysicalPages(physicalPages, [{
    sourcePage: 10,
    sourceText: "Կեղծված և չգոյություն ունեցող աղբյուր։",
  }]);
  assert.equal(bound.blocks[0].sourcePage, 0);
  assert.equal(bound.audit.unverifiedProvenanceCount, 1);
  console.log("  ✓ fabricated out-of-scope text is quarantined before the source-set gate");
}

{
  const formatted = formatExtractedPagesForPass1([
    { pageNumber: 11, text: "Առաջին էջ" },
    { pageNumber: 12, text: "Երկրորդ էջ" },
  ]);
  assert.match(formatted, /^\[PDF PAGE 11\]/u);
  assert.match(formatted, /\[PDF PAGE 12\]/u);
  console.log("  ✓ text retries reuse immutable server physical-page markers");
}

{
  const vision = normalisePass1({
    blocks: [{
      blockType: "RULE",
      sourceText: "Պատկերի վրա գրված կանոն",
      sourcePage: 10,
      sourceParagraph: null,
      sourceBoundingBox: null,
    }],
  }, 11);
  assert.equal(vision.blocks[0].sourcePage, 11);
  console.log("  ✓ one-page vision extraction always inherits the server physical page");
}

{
  const scannedPages = [{ pageNumber: 31, text: "□□□ unreadable PDF text □□□" }];
  let sourceSet = buildLessonSourceSet({
    resourceId: 20,
    resourceFileUrl: "/uploads/scanned.pdf",
    pagesFrom: 31,
    pagesTo: 31,
    lessonTitle: "Շենքերի համարակալումը",
    extractedPages: scannedPages,
  });
  assert.equal(sourceSet.titleMatch.valid, false);
  sourceSet = applyVisionTitleAnchor(sourceSet, "Շենքերի համարակալումը", [{
    sourcePage: 31,
    sourceText: "Շենքերի համարակալումը",
  }]);
  const audit = validateBlocksAgainstLessonSourceSet(sourceSet, scannedPages, [{
    sourcePage: 31,
    sourceText: "OCR text is not expected in parser output",
  }], { verifyTextContent: false });
  assert.equal(audit.valid, true);
  assert.equal(audit.verificationMode, "VISION_PAGE");
  console.log("  ✓ scanned pages use server-assigned vision provenance without parser-text containment");
}

{
  const source = "Շենքի հասցեն կարող է գրվել 5/1 ձևով։ Սա տվյալ շենքի հասցեի օրինակ է։";
  const supported = validateTeachingContentGrounding(source, {
    childFriendlyExplanation: "Շենքի հասցեն գրվում է տրված համարով։",
    basicExamples: ["Շենքի հասցեն կարող է գրվել 5/1 ձևով։"],
    commonMisconception: "Պետք չէ շփոթել հասցեի գրառումը տրված օրինակի հետ։",
    nonExamples: ["Այս նյութում այլ հասցեի օրինակ չի տրվում։"],
  });
  assert.equal(supported.valid, true, "source-anchored conditional guidance may be drafted for review");

  const unsupported = validateTeachingContentGrounding(source, {
    childFriendlyExplanation: "Շենքի հասցեն գրվում է տրված համարով։",
    basicExamples: ["Շենքի հասցեն կարող է գրվել 5/1 ձևով։"],
    commonMisconception: "5/2 սխալ է։",
    nonExamples: ["5/2 սխալ է։"],
  });
  assert.equal(unsupported.valid, false);
  assert.ok((unsupported.issueCounts["novel-numeric-claim"] ?? 0) > 0);
  assert.ok((unsupported.issueCounts["unsupported-strong-claim"] ?? 0) > 0);
  console.log("  ✓ novel numeric and universal corrective claims are rejected");
}

{
  const topics: Pass2TopicResult[] = [{
    sequence: 1,
    title: "Համարակալում",
    topicType: "math",
    inputBlockIndices: [0, 1],
    microNodes: [
      {
        title: "Համարակալման կանոն",
        learningObjective: "Կբացատրի համարակալման կանոնը։",
        microNodeType: "knowledge",
        sourceBlockIndices: [0],
        exercises: [],
        supportingMaterialIndices: [],
      },
      {
        title: "Կանոնի կիրառություն",
        learningObjective: "Կկիրառի համարակալման կանոնը։",
        microNodeType: "skill",
        sourceBlockIndices: [1],
        exercises: [],
        supportingMaterialIndices: [],
      },
    ],
    unmappedBlockIndices: [],
    additionalExercises: [],
  }];
  const summary = consolidateHighConfidenceOverSplits(topics, [{
    topicTitle: "Համարակալում",
    microNodeTitle: "Կանոնի կիրառություն",
    mergeIntoMicroNodeTitle: "Համարակալման կանոն",
    issue: "OVER_SPLIT",
    confidence: "HIGH",
    reason: "Նույն նպատակն են ներկայացնում։",
  }]);
  assert.equal(summary.beforeMicroNodeCount, 2);
  assert.equal(summary.afterMicroNodeCount, 1);
  assert.deepEqual(topics[0].microNodes[0].sourceBlockIndices, [0, 1]);
  console.log("  ✓ only explicit HIGH same-topic over-splits consolidate without losing sources");
}

console.log("\nFix #5/Fix #7 source boundary: 18/18 passing");