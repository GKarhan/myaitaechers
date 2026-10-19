import assert from "node:assert/strict";
import {
  assertSemanticReviewAvailabilityBeforePersistence,
  getSemanticReviewOutputBudget,
  getTeacherFacingMappingFailure,
  MappingSemanticReviewUnavailablePrePersistenceError,
  runGranularityReview,
  runBoundedAtomicityVerification,
  runGranularityReviewOnce,
  validatePass2SourceAlignment,
  type M32CompletionResponse,
  type Pass1Block,
  type Pass2TopicResult,
} from "../../services/lesson-mapping.js";

const blocks: Pass1Block[] = [{
  blockType: "RULE",
  sourceText: "A verified source rule supports one atomic learning objective.",
  sourcePage: 1,
  sourceParagraph: null,
  sourceBoundingBox: null,
}];

function topics(): Pass2TopicResult[] {
  return [{
    sequence: 1,
    title: "Topic",
    topicType: "knowledge",
    inputBlockIndices: [0],
    unmappedBlockIndices: [],
    additionalExercises: [],
    microNodes: [{
      candidateId: "t1:n0",
      title: "Atomic rule",
      learningObjective: "Explain the verified rule.",
      microNodeType: "knowledge",
      sourceBlockIndices: [0],
      supportingMaterialIndices: [],
      exercises: [],
    }],
  }];
}

const validContent = JSON.stringify({
  findings: [],
  sourceReallocations: [],
  atomicityRepairs: [],
  duplicateResolutions: [],
  semanticDecisions: [{
    candidateId: "t1:n0",
    decision: "KEEP_ATOMIC",
    reason: "The source supports one independently assessable rule.",
    evidenceSourceIndices: [0],
    exerciseReferences: [],
    confidence: "HIGH",
  }],
});

function completion(content: string | null | undefined, finishReason: string | null = "stop"): M32CompletionResponse {
  return {
    choices: [{
      message: { content },
      finish_reason: finishReason,
    }],
  };
}

async function reviewWith(request: () => Promise<M32CompletionResponse>) {
  const input = topics();
  return runGranularityReviewOnce(
    input,
    blocks,
    validatePass2SourceAlignment(input, blocks),
    [],
    request,
  );
}

{
  const error = Object.assign(
    new Error("Authorization=Bearer should-never-be-persisted"),
    { status: 429, code: "rate_limit_exceeded" },
  );
  const review = await reviewWith(async () => { throw error; });
  const metadata = review.providerAttemptMetadata!;
  assert.equal(review.unavailableReason, "REQUEST_FAILED");
  assert.equal(metadata.failureClassification, "REQUEST_FAILED");
  assert.equal(metadata.responseReceived, false);
  assert.equal(metadata.responseContentLength, null);
  assert.equal(metadata.httpStatus, 429);
  assert.equal(metadata.providerErrorCode, "rate_limit_exceeded");
  assert.equal(metadata.parseState, "NOT_RUN");
  assert.equal(metadata.validationState, "NOT_RUN");
  assert.doesNotMatch(metadata.sanitizedExceptionMessage ?? "", /should-never-be-persisted/);
  console.log("  ✓ request failures retain safe transport diagnostics without a response");
}

{
  const review = await reviewWith(async () => {
    throw {
      status: 500,
      code: "PROMPT_SECRET_LEAK",
      name: "Source exercise prompt marker",
      message: "SOURCE_TEXT_MARKER EXERCISE_TEXT_MARKER API_KEY_MARKER",
    };
  });
  const metadata = review.providerAttemptMetadata!;
  const serialized = JSON.stringify(metadata);
  assert.equal(metadata.httpStatus, 500);
  assert.equal(metadata.providerErrorCode, undefined);
  assert.equal(metadata.exceptionClass, "UnknownError");
  assert.equal(metadata.sanitizedExceptionMessage, "Provider request failed");
  assert.doesNotMatch(serialized, /SOURCE_TEXT_MARKER|EXERCISE_TEXT_MARKER|API_KEY_MARKER|PROMPT_SECRET_LEAK/i);
  console.log("  ✓ arbitrary provider error text never reaches persisted attempt diagnostics");
}

{
  const review = await reviewWith(async () => completion(""));
  const metadata = review.providerAttemptMetadata!;
  assert.equal(review.unavailableReason, "EMPTY_RESPONSE");
  assert.equal(metadata.failureClassification, "EMPTY_RESPONSE");
  assert.equal(metadata.responseReceived, false);
  assert.equal(metadata.responseContentLength, 0);
  assert.equal(metadata.parseState, "EMPTY_RESPONSE");
  assert.equal(metadata.validationState, "NOT_RUN");
  console.log("  ✓ empty provider content remains distinct from request failure");
}

{
  const malformed = '{"findings":["unterminated';
  const review = await reviewWith(async () => completion(malformed, "length"));
  const metadata = review.providerAttemptMetadata!;
  assert.equal(review.unavailableReason, "INVALID_JSON");
  assert.equal(metadata.failureClassification, "INVALID_JSON");
  assert.equal(metadata.responseReceived, true);
  assert.equal(metadata.responseContentLength, malformed.length);
  assert.equal(metadata.finishReason, "length");
  assert.equal(metadata.parseState, "INVALID_JSON");
  assert.equal(metadata.validationState, "NOT_RUN");
  assert.equal(metadata.model, "deepseek/deepseek-chat");
  assert.match(metadata.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(metadata.endedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(metadata.durationMs >= 0);
  assert.equal(JSON.stringify(metadata).includes(malformed), false);
  console.log("  ✓ malformed JSON records a received response without persisting its content");
}

{
  const review = await reviewWith(async () => completion(JSON.stringify({
    findings: [],
    sourceReallocations: [],
    atomicityRepairs: [],
    duplicateResolutions: [],
    semanticDecisions: [],
  })));
  const metadata = review.providerAttemptMetadata!;
  assert.equal(review.unavailableReason, "SCHEMA_INVALID");
  assert.equal(metadata.failureClassification, "SCHEMA_INVALID");
  assert.equal(metadata.responseReceived, true);
  assert.equal(metadata.parseState, "SCHEMA_INVALID");
  assert.equal(metadata.validationState, "FAILED");
  console.log("  ✓ schema-invalid JSON remains distinct from malformed JSON");
}

{
  const review = await reviewWith(async () => completion(validContent));
  const metadata = review.providerAttemptMetadata!;
  assert.equal(review.status, "COMPLETE");
  assert.equal(metadata.failureClassification, "SUCCESS");
  assert.equal(metadata.responseReceived, true);
  assert.equal(metadata.parseState, "SUCCEEDED");
  assert.equal(metadata.validationState, "PASSED");
  console.log("  ✓ valid M3-2 contract records successful provider diagnostics");
}

{
  let calls = 0;
  const result = await runBoundedAtomicityVerification(
    () => reviewWith(async () => {
      calls++;
      return completion(calls === 1 ? '{"findings":["unterminated' : validContent);
    }),
    1,
  );
  assert.equal(calls, 2);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.verificationDiagnostics.retryAttempted, true);
  assert.equal(result.verificationDiagnostics.retrySucceeded, true);
  assert.deepEqual(
    result.verificationDiagnostics.attempts.map((attempt) => attempt.failureClassification),
    ["INVALID_JSON", "SUCCESS"],
  );
  assert.equal(result.verificationDiagnostics.attempts[0].responseReceived, true);
  console.log("  ✓ one malformed response retries once and records the successful second attempt");
}

{
  const malformed = '{"findings":["unterminated';
  let calls = 0;
  const result = await runBoundedAtomicityVerification(
    () => reviewWith(async () => {
      calls++;
      return completion(malformed);
    }),
    1,
  );
  assert.equal(calls, 2);
  assert.equal(result.unavailableReason, "INVALID_JSON");
  assert.equal(result.verificationDiagnostics.failureClassification, "INVALID_JSON");
  assert.equal(result.verificationDiagnostics.responseReceived, true);
  assert.deepEqual(
    result.verificationDiagnostics.attempts.map((attempt) => attempt.failureClassification),
    ["INVALID_JSON", "INVALID_JSON"],
  );
  const priorCanonicalMap = { topics: [11], nodes: [22], exercises: [33] };
  const priorSnapshot = structuredClone(priorCanonicalMap);
  assert.throws(() => {
    assertSemanticReviewAvailabilityBeforePersistence({
      candidatePromotion: {
        candidateCount: 1,
        promotedMicroNodeCount: 0,
        semanticDecisionDiagnostics: {
          providedByReview: true,
          decisionCount: 0,
          missingCandidateIds: ["t1:n0"],
          invalidCandidateIds: [],
          decisions: [{
            candidateId: "t1:n0",
            decision: "MISSING",
            valid: false,
            reasonCode: "MISSING_DECISION",
          }],
        },
        decisions: [{
          candidateId: "t1:n0",
          topicSequence: 1,
          state: "REVIEW_REQUIRED",
          reasonCodes: [],
        }],
      },
      atomicityReviewUnavailableReason: result.unavailableReason,
      canonicalMicroNodeCount: 0,
    });
    priorCanonicalMap.topics = [];
    priorCanonicalMap.nodes = [];
    priorCanonicalMap.exercises = [];
  });
  assert.deepEqual(priorCanonicalMap, priorSnapshot);
  console.log("  ✓ two malformed responses preserve the existing-map safety gate");
}

{
  let calls = 0;
  const result = await runBoundedAtomicityVerification(
    () => reviewWith(async () => {
      calls++;
      if (calls === 1) throw new Error("network unavailable");
      return completion('{"findings":["unterminated');
    }),
    1,
  );
  assert.equal(calls, 2);
  assert.equal(result.unavailableReason, "INVALID_JSON");
  assert.deepEqual(
    result.verificationDiagnostics.attempts.map((attempt) => attempt.failureClassification),
    ["REQUEST_FAILED", "INVALID_JSON"],
  );
  assert.equal(result.verificationDiagnostics.attempts[0].responseReceived, false);
  assert.equal(result.verificationDiagnostics.attempts[1].responseReceived, true);
  console.log("  ✓ transport and malformed-response attempts retain distinct classifications");
}

console.log("\nM3-2 provider response diagnostics: 8 requested cases + safety regression passing");

{
  const input = topics();
  const original = input[0].microNodes[0];
  input[0].microNodes = Array.from({ length: 12 }, (_, index) => ({
    ...structuredClone(original), candidateId: `t1:n${index}`,
  }));
  const before = structuredClone(input);
  const budgets: number[] = [];
  const content = JSON.stringify({
    findings: [], sourceReallocations: [], atomicityRepairs: [], duplicateResolutions: [],
    semanticDecisions: input[0].microNodes.map((node) => ({
      candidateId: node.candidateId, decision: "KEEP_ATOMIC",
      reason: "The source supports the objective.", evidenceSourceIndices: [0],
      exerciseReferences: [], confidence: "HIGH",
    })),
  });
  const review = await runGranularityReview(input, blocks, validatePass2SourceAlignment(input, blocks), [], async (request) => {
    budgets.push(request.max_tokens!);
    return completion(content, budgets.length === 1 ? "length" : "stop");
  });
  assert.equal(review.status, "COMPLETE");
  assert.equal(review.semanticDecisions.length, 12);
  assert.equal(budgets.length, 2);
  assert.ok(budgets[0] > 2000);
  assert.ok(budgets[1] > budgets[0]);
  assert.ok(budgets.every((budget) => budget <= 16000));
  assert.deepEqual(input, before);
  assert.equal(getSemanticReviewOutputBudget(1000, 1000, true), 16000);
  assert.equal(getSemanticReviewOutputBudget(0, 0), 4096);
  console.log("  ✓ twelve-node review rejects truncated JSON, retries once with a larger bounded budget, and preserves candidates");
}

{
  const unavailable = await reviewWith(async () => completion(validContent, "length"));
  assert.equal(unavailable.status, "UNAVAILABLE");
  assert.equal(unavailable.providerAttemptMetadata?.validationState, "NOT_RUN");
  assert.equal(unavailable.semanticDecisions.length, 0);
  assert.equal(unavailable.providerAttemptMetadata?.finishReason, "length");
  const error = new MappingSemanticReviewUnavailablePrePersistenceError({} as never);
  assert.equal(getTeacherFacingMappingFailure(error), error.teacherMessage);
  console.log("  ✓ truncated responses never authorize promotion and semantic-review errors keep the specific teacher message");
}
