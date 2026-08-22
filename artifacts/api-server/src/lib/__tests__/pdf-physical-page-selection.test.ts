import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  extractPdfPages,
  getTeacherFacingMappingFailure,
  MappingPdfPageExtractionError,
  MappingPdfPageRangeError,
  normalisePass1,
  rasterizePdfPages,
  teacherVisiblePdfPageToParserPage,
} from "../../services/lesson-mapping.js";
import { validateBlocksAgainstLessonSourceSet, buildLessonSourceSet } from "../lesson-source-set.js";

const math5Pdf = path.resolve(process.cwd(), "uploads/1787341612912-617346969.pdf");
assert.ok(fs.existsSync(math5Pdf), "verified Math 5 PDF fixture must be present");

{
  assert.equal(teacherVisiblePdfPageToParserPage(13), 13);
  assert.equal(teacherVisiblePdfPageToParserPage(14), 14);
  const pages = await extractPdfPages(math5Pdf, 13, 14);
  assert.deepEqual(pages.map((page) => page.pageNumber), [13, 14]);
  assert.match(pages[0].text, /Առաջին փողոցում/u);
  assert.match(pages[1].text, /Փողոցի շենքերը համարակալելիս/u);
  console.log("  ✓ teacher-visible 13–14 selects exactly PDF pages 13–14 without an offset");
}

{
  const range = await rasterizePdfPages(math5Pdf, 13, 14, 30);
  const page13 = await rasterizePdfPages(math5Pdf, 13, 13, 30);
  const page14 = await rasterizePdfPages(math5Pdf, 14, 14, 30);
  assert.equal(range.length, 2);
  assert.equal(range[0], page13[0]);
  assert.equal(range[1], page14[0]);
  console.log("  ✓ pdftoppm preserves the same physical 13–14 page selection");
}

{
  for (const [from, to] of [[0, 1], [14, 13]]) {
    await assert.rejects(
      () => extractPdfPages(math5Pdf, from, to),
      MappingPdfPageRangeError,
    );
  }
  await assert.rejects(
    () => extractPdfPages(math5Pdf, 174, 175),
    MappingPdfPageRangeError,
  );
  assert.equal(
    getTeacherFacingMappingFailure(new MappingPdfPageRangeError(174, 175, 174)),
    "Նշված PDF էջերը չեն գտնվում վերբեռնված ֆայլի էջերի սահմաններում։",
  );
  console.log("  ✓ invalid or out-of-document PDF page ranges fail before Pass 1");
}

{
  await assert.rejects(
    () => extractPdfPages(path.join(path.dirname(math5Pdf), "missing-source.pdf"), 1, 1),
    MappingPdfPageExtractionError,
  );
  console.log("  ✓ missing or unreadable PDFs return the safe extraction failure category");
}

{
  const wrongClaim = normalisePass1({
    blocks: [{ blockType: "RULE", sourceText: "Ստուգելի կանոն", sourcePage: 999 }],
  }, 13);
  const omittedClaim = normalisePass1({
    blocks: [{ blockType: "RULE", sourceText: "Ստուգելի կանոն" }],
  }, 14);
  assert.equal(wrongClaim.blocks[0].sourcePage, 13);
  assert.equal(wrongClaim.providerPageLabelCorrectionCount, 1);
  assert.equal(omittedClaim.blocks[0].sourcePage, 14);
  console.log("  ✓ wrong or omitted provider page claims cannot replace server provenance");
}

{
  const pages = [{ pageNumber: 13, text: "Վավեր աղբյուրային կանոն" }];
  const sourceSet = buildLessonSourceSet({
    resourceId: 19,
    resourceFileUrl: "/uploads/math5.pdf",
    pagesFrom: 13,
    pagesTo: 13,
    lessonTitle: "Աղբյուրային կանոն",
    extractedPages: pages,
  });
  const fabricated = validateBlocksAgainstLessonSourceSet(sourceSet, pages, [{
    sourcePage: 13,
    sourceText: "Չգոյություն ունեցող տեքստ",
  }]);
  const outsideRange = validateBlocksAgainstLessonSourceSet(sourceSet, pages, [{
    sourcePage: 14,
    sourceText: "Վավեր աղբյուրային կանոն",
  }]);
  assert.equal(fabricated.valid, false);
  assert.equal(outsideRange.valid, false);
  console.log("  ✓ server page identity does not bypass containment or selected-range validation");
}

console.log("PDF physical page selection: provider-free checks passing");