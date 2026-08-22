import assert from "node:assert/strict";
import {
  assertPass1ContextBudget,
  assertPass1AggregateHasBlocks,
  assertPass1HasBlocks,
  assertPass1ResponseComplete,
  assertVisionContextBudget,
  buildPass1RetryDiagnostics,
  buildPass1TextRequest,
  buildPass2CurriculumConstraints,
  buildVisionContextDiagnostics,
  extractBlocksWithAI,
  extractPdfPageRange,
  getTeacherFacingMappingFailure,
  hasSubstantialReadablePass1Source,
  inspectPass1StructuredResponse,
  MappingContextBudgetError,
  MappingPass1EmptyExtractionError,
  MappingPass1SchemaValidationError,
  MappingSourceTruncatedError,
  type Pass1CompletionClient,
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

const VALID_PASS1_RESPONSE = JSON.stringify({
  blocks: [{
    blockType: "EXERCISE",
    sourceText: "Արամն ունի 3 մատիտ։",
    sourcePage: 14,
    sourceParagraph: null,
    sourceBoundingBox: null,
  }],
});

function fakePass1Client(contents: string[]): { client: Pass1CompletionClient; getCallCount: () => number } {
  let calls = 0;
  return {
    client: {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: { content: contents[calls++] ?? "" },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          }),
        },
      },
    },
    getCallCount: () => calls,
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

{
  assert.doesNotThrow(() => assertPass1HasBlocks([{
    blockType: "RULE",
    sourceText: "Ստուգելի կանոն",
    sourcePage: 14,
    sourceParagraph: null,
    sourceBoundingBox: null,
  }]));
  assert.throws(() => assertPass1HasBlocks([]), MappingPass1EmptyExtractionError);
  const teacherError = getTeacherFacingMappingFailure(new MappingPass1EmptyExtractionError());
  assert.match(teacherError, /բլոկներ/u);
  assert.doesNotMatch(teacherError, /PDF էջերի բովանդակությունը/u);
  console.log("  ✓ empty Pass 1 output is explicit and never misclassified as source scope");
}

{
  const valid = inspectPass1StructuredResponse(VALID_PASS1_RESPONSE, 14);
  assert.equal(valid.state, "VALID_NONEMPTY_EXTRACTION");
  assert.equal(valid.result?.blocks.length, 1);
  assert.deepEqual(valid.topLevelKeys, ["blocks"]);
  assert.equal(valid.blocksCount, 1);

  const emptyObject = inspectPass1StructuredResponse("{}", 14);
  assert.equal(emptyObject.state, "EMPTY_PROVIDER_RESPONSE");
  assert.deepEqual(emptyObject.issueCodes, ["EMPTY_OBJECT"]);

  const emptyBlocks = inspectPass1StructuredResponse('{"blocks":[]}', 14);
  assert.equal(emptyBlocks.state, "EMPTY_PROVIDER_RESPONSE");
  assert.deepEqual(emptyBlocks.issueCodes, ["BLOCKS_MIN_ITEMS"]);

  const missingBlocks = inspectPass1StructuredResponse('{"items":[]}', 14);
  assert.equal(missingBlocks.state, "SCHEMA_VALIDATION_FAILED");
  assert.deepEqual(missingBlocks.issueCodes, ["BLOCKS_ARRAY_REQUIRED"]);

  const malformed = inspectPass1StructuredResponse('{"blocks":', 14);
  assert.equal(malformed.state, "MALFORMED_PROVIDER_RESPONSE");

  const usefulButInvalid = inspectPass1StructuredResponse(JSON.stringify({
    blocks: [{ ...JSON.parse(VALID_PASS1_RESPONSE).blocks[0], sourceText: "" }],
  }), 14);
  assert.equal(usefulButInvalid.state, "SCHEMA_VALIDATION_FAILED");
  assert.ok(usefulButInvalid.issueCodes.includes("BLOCK_0_SOURCE_TEXT"));

  const unexpectedTopLevel = inspectPass1StructuredResponse(JSON.stringify({
    ...JSON.parse(VALID_PASS1_RESPONSE),
    extra: true,
  }), 14);
  assert.equal(unexpectedTopLevel.state, "SCHEMA_VALIDATION_FAILED");
  assert.ok(unexpectedTopLevel.issueCodes.includes("UNEXPECTED_TOP_LEVEL_PROPERTY"));

  const unexpectedBlockField = inspectPass1StructuredResponse(JSON.stringify({
    blocks: [{ ...JSON.parse(VALID_PASS1_RESPONSE).blocks[0], invented: "not permitted" }],
  }), 14);
  assert.equal(unexpectedBlockField.state, "SCHEMA_VALIDATION_FAILED");
  assert.ok(unexpectedBlockField.issueCodes.includes("BLOCK_0_UNEXPECTED_PROPERTY"));

  const unexpectedBoxField = inspectPass1StructuredResponse(JSON.stringify({
    blocks: [{
      ...JSON.parse(VALID_PASS1_RESPONSE).blocks[0],
      sourceBoundingBox: { x: 1, y: 2, w: 3, h: 4, extra: 5 },
    }],
  }), 14);
  assert.equal(unexpectedBoxField.state, "SCHEMA_VALIDATION_FAILED");
  assert.ok(unexpectedBoxField.issueCodes.includes("BLOCK_0_BOUNDING_BOX_UNEXPECTED_PROPERTY"));
  console.log("  ✓ parser distinguishes valid, empty, malformed, and schema-invalid provider output");
}

{
  const source = "[PDF PAGE 14]\nԱրամն ունի 3 մատիտ։ Նա ստացավ ևս 2 մատիտ։";
  assert.equal(hasSubstantialReadablePass1Source(source), true);
  assert.equal(hasSubstantialReadablePass1Source("[PDF PAGE 14]\nՎերնագիր"), true);
  assert.equal(hasSubstantialReadablePass1Source("[PDF PAGE 14]\n2 + 2 = 4"), true);
  assert.equal(hasSubstantialReadablePass1Source("[PDF PAGE 14]\nԼուծի՛ր։"), true);
  assert.equal(hasSubstantialReadablePass1Source("[PDF PAGE 14]"), false);
  assert.equal(hasSubstantialReadablePass1Source("[PDF PAGE 14]\n  \t\n"), false);
  assert.throws(
    () => assertPass1AggregateHasBlocks([], [14, 15], 2),
    (error: unknown) => error instanceof MappingPass1EmptyExtractionError
      && error.sourceState === "EMPTY_OR_NONINSTRUCTIONAL_PAGE",
  );
  assert.throws(
    () => assertPass1AggregateHasBlocks([], [14], 2),
    (error: unknown) => error instanceof MappingPass1EmptyExtractionError
      && error.sourceState === "SUBSTANTIAL_SOURCE",
  );
  assert.doesNotThrow(() => assertPass1AggregateHasBlocks([{
    blockType: "RULE",
    sourceText: "Պահպանված բլոկ",
    sourcePage: 15,
    sourceParagraph: null,
    sourceBoundingBox: null,
  }], [14], 2));
  console.log("  ✓ substantial server text is distinguishable from an empty physical page");
}

{
  const fake = fakePass1Client(["{}", VALID_PASS1_RESPONSE]);
  const result = await extractBlocksWithAI(mappingInput("[PDF PAGE 14]\nԱրամն ունի 3 մատիտ։ Նա ստացավ ևս 2 մատիտ։"), {
    sourcePageOverride: 14,
    completionClient: fake.client,
  });
  assert.equal(fake.getCallCount(), 2);
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].sourcePage, 14);
  console.log("  ✓ first empty response plus one valid corrective retry succeeds");
}

{
  const fake = fakePass1Client(["{}", '{"blocks":[]}']);
  await assert.rejects(
    () => extractBlocksWithAI(mappingInput("[PDF PAGE 14]\nԱրամն ունի 3 մատիտ։ Նա ստացավ ևս 2 մատիտ։"), {
      sourcePageOverride: 14,
      completionClient: fake.client,
    }),
    MappingPass1EmptyExtractionError,
  );
  assert.equal(fake.getCallCount(), 2);

  const schemaFake = fakePass1Client(['{"items":[]}', '{"items":[]}']);
  await assert.rejects(
    () => extractBlocksWithAI(mappingInput("[PDF PAGE 14]\nԱրամն ունի 3 մատիտ։ Նա ստացավ ևս 2 մատիտ։"), {
      sourcePageOverride: 14,
      completionClient: schemaFake.client,
    }),
    MappingPass1SchemaValidationError,
  );
  assert.equal(schemaFake.getCallCount(), 2);
  console.log("  ✓ two failed structured responses stop after exactly one retry");
}

console.log("\nMapping context guard: 13/13 passing");