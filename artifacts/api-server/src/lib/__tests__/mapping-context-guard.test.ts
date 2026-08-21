import assert from "node:assert/strict";
import {
  assertPass1ContextBudget,
  assertPass1ResponseComplete,
  assertVisionContextBudget,
  buildPass1RetryDiagnostics,
  buildPass1TextRequest,
  buildPass2CurriculumConstraints,
  buildVisionContextDiagnostics,
  extractPdfPageRange,
  getTeacherFacingMappingFailure,
  MappingContextBudgetError,
  MappingSourceTruncatedError,
} from "../../services/lesson-mapping.js";
import {
  PAGE_RANGE_ERROR_MESSAGE,
  validateOptionalLessonPageRange,
  validateRequiredLessonPageRange,
} from "../lesson-page-range.js";

function mappingInput(lessonText: string) {
  return {
    subjectName: "Մաթեմատիկա",
    lessonTitle: "Շենքերի համարակալումը",
    chapterTitle: "Բնական թվերը և կոորդինատային ճառագայթը",
    textbookTitle: "Մաթեմատիկա 5",
    textbookAuthor: "Սմբատ Գոգյան",
    pagesFrom: 10,
    pagesTo: 11,
    lessonText,
    teacherGoal: "Սա Pass 1-ի մուտք չէ",
    teacherOutcomes: ["Սա Pass 2-ի մուտք է"],
  };
}

{
  const valid = validateRequiredLessonPageRange(10, 11);
  assert.deepEqual(valid, { valid: true, pagesFrom: 10, pagesTo: 11 });
  assert.equal(validateRequiredLessonPageRange(10, 1).valid, false);
  assert.equal(validateOptionalLessonPageRange(null, null).valid, true);
  assert.equal(validateOptionalLessonPageRange(10, null).valid, false);
  assert.equal(validateOptionalLessonPageRange(0, 1).valid, false);
  console.log("  ✓ page ranges require one ordered pair of positive page numbers");
}

{
  await assert.rejects(
    () => extractPdfPageRange("/path/that-must-not-be-read.pdf", 10, 1),
    new RegExp(PAGE_RANGE_ERROR_MESSAGE),
  );
  console.log("  ✓ reversed ranges fail before PDF parsing can fall back to full-book text");
}

{
  const source = "Ամբողջական դասի աղբյուրը։\nԵրկրորդ տող։";
  const { userPrompt, diagnostics } = buildPass1TextRequest(mappingInput(source));
  assert.equal(userPrompt.split(source).length - 1, 1, "lesson source appears exactly once");
  assert.equal(diagnostics.components.lessonSourceChars, source.length);
  assert.equal(diagnostics.components.confirmedGoalChars, 0);
  assert.equal(diagnostics.components.confirmedOutcomeChars, 0);
  assert.equal(diagnostics.components.existingMappingChars, 0);
  assert.equal(diagnostics.components.teachingPackageChars, 0);
  assert.equal(diagnostics.components.cognitivePathChars, 0);
  assert.doesNotThrow(() => assertPass1ContextBudget(diagnostics));
  const retryDiagnostics = buildPass1RetryDiagnostics(
    diagnostics,
    'Your previous response was not valid JSON. Return only a valid JSON object.',
  );
  assert.equal(retryDiagnostics.components.lessonSourceChars, source.length);
  assert.ok(retryDiagnostics.estimatedInputTokens > diagnostics.estimatedInputTokens);
  assert.doesNotThrow(() => assertPass1ContextBudget(retryDiagnostics));
  console.log("  ✓ Pass 1 contains the scoped source once and excludes runtime/downstream state");
}

{
  const { diagnostics } = buildPass1TextRequest(mappingInput("ա".repeat(231_261)));
  assert.throws(
    () => assertPass1ContextBudget(diagnostics),
    MappingContextBudgetError,
  );
  assert.ok(diagnostics.estimatedTotalTokens > diagnostics.contextWindowTokens);
  console.log("  ✓ oversized text is intercepted before a provider request");
}

{
  const twoPageVision = buildVisionContextDiagnostics(
    "google/gemini-2.5-flash",
    "LESSON TITLE: Շենքերի համարակալումը\nPAGES IN THIS BATCH: 10–11",
    2,
    32_000,
  );
  assert.doesNotThrow(() => assertVisionContextBudget(twoPageVision));
  const oversizedVision = buildVisionContextDiagnostics(
    "google/gemini-2.5-flash",
    "too many images",
    20,
    32_000,
  );
  assert.throws(() => assertVisionContextBudget(oversizedVision), MappingContextBudgetError);
  console.log("  ✓ every vision chunk/fallback has a bounded preflight reservation");
}

{
  const constraints = buildPass2CurriculumConstraints({
    lessonTitle: "Շենքերի համարակալումը",
    teacherGoal: "Սովորողը կբացատրի համարակալման կանոնը։",
    teacherOutcomes: [
      "Սովորողը կորոշի շենքի համարը։",
      "Սովորողը կկիրառի ձախ և աջ կողմերի կանոնը։",
    ],
  });
  assert.equal((constraints.match(/Սովորողը կբացատրի համարակալման կանոնը։/g) ?? []).length, 1);
  assert.equal((constraints.match(/Սովորողը կորոշի շենքի համարը։/g) ?? []).length, 1);
  assert.equal((constraints.match(/Սովորողը կկիրառի ձախ և աջ կողմերի կանոնը։/g) ?? []).length, 1);
  console.log("  ✓ confirmed Goal and Outcomes enter Pass 2 once as curriculum constraints");
}

{
  const rawProviderError =
    "400 This endpoint's maximum context length is 163840 tokens. However, you requested about 184160 tokens.";
  const teacherError = getTeacherFacingMappingFailure(new Error(rawProviderError));
  assert.match(teacherError, /Քարտեզագրման/);
  assert.doesNotMatch(teacherError, /163840|184160|maximum context/i);
  console.log("  ✓ raw provider context-limit details are not shown to teachers");
}

{
  assert.doesNotThrow(() => assertPass1ResponseComplete("stop"));
  assert.throws(() => assertPass1ResponseComplete("length"), MappingSourceTruncatedError);
  console.log("  ✓ valid-looking output is rejected when the provider marks it truncated");
}

console.log("\nMapping context guard: 8/8 passing");