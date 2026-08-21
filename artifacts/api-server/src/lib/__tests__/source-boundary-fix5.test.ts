import assert from "node:assert/strict";
import {
  buildLessonSourceSet,
  applyVisionTitleAnchor,
  assignTextBlocksToPhysicalPages,
  validateBlocksAgainstLessonSourceSet,
} from "../lesson-source-set.js";
import { validateTeachingContentGrounding } from "../teaching-content-grounding.js";
import { consolidateHighConfidenceOverSplits, type Pass2TopicResult } from "../../services/lesson-mapping.js";

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
  const bound = assignTextBlocksToPhysicalPages(physicalPages, [{
    sourcePage: 37,
    sourceText: "Շենքերի համարակալումը սկսվում է այստեղ։",
  }]);
  assert.equal(bound[0].sourcePage, 11);
  console.log("  ✓ printed textbook page labels cannot replace physical PDF provenance");
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

console.log("\nFix #5 source boundary: 7/7 passing");