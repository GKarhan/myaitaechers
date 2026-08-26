/**
 * Test 2.0 T3 database-backed, provider-free creation contract.
 *
 * Run:
 * DATABASE_URL=$TEST_DATABASE_URL pnpm --filter @workspace/api-server test:retest-creation-db
 */
import assert from "node:assert/strict";
import { asc, eq, inArray } from "drizzle-orm";
import {
  db,
  quizAnswersTable,
  quizAssignmentsTable,
  quizAttemptsTable,
  quizLessonLinksTable,
  quizQuestionsTable,
  quizzesTable,
  subjectsTable,
} from "@workspace/db";
import { assertTestDb } from "../../lib/__tests__/helpers/test-db.js";
import { createFactory } from "../../lib/__tests__/helpers/fixture-factory.js";
import { makeRunId, runTag } from "../../lib/__tests__/helpers/run-id.js";
import {
  createTargetedRetest,
  TargetedRetestError,
} from "../quiz-retest-creation.js";
import type {
  RetestAuthorityResult,
  RetestStrategy,
} from "../quiz-retest-authority.js";

assertTestDb();

const runId = makeRunId();
const fixture = createFactory(runId);
let subjectId: number | null = null;
const retestQuizIds: number[] = [];

const authority = (
  attemptId: number,
  strategy: RetestStrategy,
  nodeIds: number[],
): RetestAuthorityResult => ({
  attemptId,
  strategy,
  eligibleNodes: nodeIds.map((nodeId, index) => ({
    nodeId,
    canonicalState:
      strategy === "NOT_KNOWN_ONLY" || index > 0 ? "NOT_KNOWN" : "PARTIAL",
  })),
  counts: {
    partial: strategy === "PARTIAL_AND_NOT_KNOWN" && nodeIds.length > 0 ? 1 : 0,
    notKnown:
      strategy === "PARTIAL_AND_NOT_KNOWN"
        ? Math.max(0, nodeIds.length - 1)
        : nodeIds.length,
    eligible: nodeIds.length,
  },
});

try {
  const [subject] = await db
    .insert(subjectsTable)
    .values({ name: runTag(runId, "t3_subject") })
    .returning({ id: subjectsTable.id });
  subjectId = subject.id;

  const teacher = await fixture.teacher();
  const student = await fixture.student();
  const lesson = await fixture.lesson(teacher.userId, null, subjectId, {
    title: runTag(runId, "t3_lesson"),
    status: "approved",
  });
  const partialNode = await fixture.node(lesson.id, {
    title: runTag(runId, "partial_node"),
    status: "approved",
  });
  const notKnownNode = await fixture.node(lesson.id, {
    title: runTag(runId, "not_known_node"),
    status: "approved",
  });
  const sourceQuiz = await fixture.quiz(teacher.userId, subjectId, {
    title: runTag(runId, "source_quiz"),
    questionCount: 2,
    status: "GENERATED",
  });
  await db
    .update(quizzesTable)
    .set({
      nodeIds: [partialNode.id, notKnownNode.id],
      difficultyMode: "HARD",
      quizType: "lesson",
    })
    .where(eq(quizzesTable.id, sourceQuiz.id));
  await fixture.linkQuizLesson(sourceQuiz.id, lesson.id);

  const [sourceQuestion] = await db
    .insert(quizQuestionsTable)
    .values({
      quizId: sourceQuiz.id,
      nodeId: partialNode.id,
      questionText: "Աղբյուր հարց",
      options: ["Ա", "Բ", "Գ", "Դ"],
      correctOptionIndex: 0,
      difficultyLevel: "MEDIUM",
      sequence: 1,
    })
    .returning({ id: quizQuestionsTable.id });
  const sourceAssignment = await fixture.assignQuiz(sourceQuiz.id, student.userId);
  await db
    .update(quizAssignmentsTable)
    .set({ status: "COMPLETED" })
    .where(eq(quizAssignmentsTable.id, sourceAssignment.assignmentId));
  const [sourceAttempt] = await db
    .insert(quizAttemptsTable)
    .values({
      quizAssignmentId: sourceAssignment.assignmentId,
      completedAt: new Date(),
      totalCorrect: 0,
      totalQuestions: 1,
      scorePercent: 0,
    })
    .returning({ id: quizAttemptsTable.id });
  await db.insert(quizAnswersTable).values({
    attemptId: sourceAttempt.id,
    questionId: sourceQuestion.id,
    selectedOptionIndex: 1,
    isCorrect: false,
    nodeId: partialNode.id,
  });

  const [sourceQuizBefore] = await db
    .select()
    .from(quizzesTable)
    .where(eq(quizzesTable.id, sourceQuiz.id));
  const [sourceAttemptBefore] = await db
    .select()
    .from(quizAttemptsTable)
    .where(eq(quizAttemptsTable.id, sourceAttempt.id));
  const sourceAnswersBefore = await db
    .select()
    .from(quizAnswersTable)
    .where(eq(quizAnswersTable.attemptId, sourceAttempt.id))
    .orderBy(asc(quizAnswersTable.id));

  const empty = await createTargetedRetest({
    learnerId: student.userId,
    sourceAttemptId: sourceAttempt.id,
    strategy: "PARTIAL_AND_NOT_KNOWN",
    resolveEligibility: async () =>
      authority(sourceAttempt.id, "PARTIAL_AND_NOT_KNOWN", []),
    generateQuestions: async () => {
      throw new Error("empty eligibility must not generate");
    },
  });
  assert.deepEqual(empty, {
    created: false,
    reason: "NO_ELIGIBLE_NODES",
    sourceAttemptId: sourceAttempt.id,
    strategy: "PARTIAL_AND_NOT_KNOWN",
  });
  assert.equal(
    (await db
      .select({ id: quizzesTable.id })
      .from(quizzesTable)
      .where(eq(quizzesTable.retestSourceAttemptId, sourceAttempt.id))).length,
    0,
  );
  console.log("PASS T3-DB1 — empty canonical eligibility creates nothing");

  await assert.rejects(
    createTargetedRetest({
      learnerId: student.userId,
      sourceAttemptId: sourceAttempt.id,
      strategy: "PARTIAL_AND_NOT_KNOWN",
      resolveEligibility: async () =>
        authority(
          sourceAttempt.id,
          "PARTIAL_AND_NOT_KNOWN",
          [partialNode.id, notKnownNode.id],
        ),
      generateQuestions: async () => {
        throw new Error("provider unavailable");
      },
    }),
    (error: unknown) =>
      error instanceof TargetedRetestError &&
      error.code === "GENERATION_FAILED",
  );
  assert.equal(
    (await db
      .select({ id: quizzesTable.id })
      .from(quizzesTable)
      .where(eq(quizzesTable.retestSourceAttemptId, sourceAttempt.id))).length,
    0,
  );
  console.log("PASS T3-DB2 — generation failure leaves no partial retest");

  let generatorCalls = 0;
  let releaseFirstGenerator: (() => void) | null = null;
  const secondGeneratorStarted = new Promise<void>((resolve) => {
    releaseFirstGenerator = resolve;
  });
  const generateQuestions = async (input: {
    nodeIds: number[];
    questionCount: number;
    difficultyMode: "SIMPLE" | "MEDIUM" | "HARD" | "MIXED";
  }) => {
    generatorCalls++;
    if (generatorCalls === 1) {
      await secondGeneratorStarted;
    } else if (generatorCalls === 2) {
      releaseFirstGenerator?.();
    }
    assert.equal(input.questionCount, 2);
    assert.equal(input.difficultyMode, "HARD");
    return input.nodeIds.map((nodeId, index) => ({
      nodeId,
      cognitiveLevelId: null,
      questionText: `Թիրախային հարց ${index + 1}`,
      options: ["Ա", "Բ", "Գ", "Դ"] as [string, string, string, string],
      correctOptionIndex: 0,
      difficultyLevel: "HIGH" as const,
      optionExplanations: null,
    }));
  };

  const combinedInput = {
    learnerId: student.userId,
    sourceAttemptId: sourceAttempt.id,
    strategy: "PARTIAL_AND_NOT_KNOWN" as const,
    resolveEligibility: async () =>
      authority(
        sourceAttempt.id,
        "PARTIAL_AND_NOT_KNOWN",
        [partialNode.id, notKnownNode.id],
      ),
    generateQuestions,
  };
  const [firstConcurrent, secondConcurrent] = await Promise.all([
    createTargetedRetest(combinedInput),
    createTargetedRetest(combinedInput),
  ]);
  assert.equal(firstConcurrent.created, true);
  assert.equal(secondConcurrent.created, true);
  if (!firstConcurrent.created || !secondConcurrent.created) {
    throw new Error("expected concurrent retests");
  }
  assert.equal(firstConcurrent.quizId, secondConcurrent.quizId);
  assert.equal(firstConcurrent.assignmentId, secondConcurrent.assignmentId);
  assert.deepEqual(
    [firstConcurrent.reused, secondConcurrent.reused].sort(),
    [false, true],
  );
  const combined = firstConcurrent.reused ? secondConcurrent : firstConcurrent;
  assert.equal(combined.created, true);
  assert.equal(combined.reused, false);
  retestQuizIds.push(combined.quizId);

  const [combinedQuiz] = await db
    .select()
    .from(quizzesTable)
    .where(eq(quizzesTable.id, combined.quizId));
  assert.deepEqual(combinedQuiz.nodeIds, [partialNode.id, notKnownNode.id]);
  assert.equal(combinedQuiz.retestSourceAttemptId, sourceAttempt.id);
  assert.equal(combinedQuiz.retestStrategy, "PARTIAL_AND_NOT_KNOWN");
  assert.equal(combinedQuiz.status, "ASSIGNED");
  assert.equal(combinedQuiz.questionCount, 2);
  assert.equal(combinedQuiz.difficultyMode, "HARD");

  const combinedQuestions = await db
    .select({ nodeId: quizQuestionsTable.nodeId })
    .from(quizQuestionsTable)
    .where(eq(quizQuestionsTable.quizId, combined.quizId))
    .orderBy(asc(quizQuestionsTable.sequence));
  assert.deepEqual(
    combinedQuestions.map((question) => question.nodeId),
    [partialNode.id, notKnownNode.id],
  );
  const [combinedAssignment] = await db
    .select()
    .from(quizAssignmentsTable)
    .where(eq(quizAssignmentsTable.id, combined.assignmentId));
  assert.equal(combinedAssignment.studentId, student.userId);
  assert.equal(combinedAssignment.status, "ASSIGNED");
  assert.deepEqual(
    await db
      .select({ lessonId: quizLessonLinksTable.lessonId })
      .from(quizLessonLinksTable)
      .where(eq(quizLessonLinksTable.quizId, combined.quizId)),
    [{ lessonId: lesson.id }],
  );
  console.log("PASS T3-DB3 — canonical nodes create a new startable quiz with lineage");

  const replay = await createTargetedRetest(combinedInput);
  assert.equal(replay.created, true);
  assert.equal(replay.reused, true);
  if (!replay.created) throw new Error("expected replayed retest");
  assert.equal(replay.quizId, combined.quizId);
  assert.equal(replay.assignmentId, combined.assignmentId);
  assert.equal(generatorCalls, 2);
  assert.equal(
    (await db
      .select({ id: quizzesTable.id })
      .from(quizzesTable)
      .where(eq(quizzesTable.retestSourceAttemptId, sourceAttempt.id))).length,
    1,
  );
  console.log("PASS T3-DB4 — concurrent and replayed creation safely reuse one retest");

  const notKnownOnly = await createTargetedRetest({
    learnerId: student.userId,
    sourceAttemptId: sourceAttempt.id,
    strategy: "NOT_KNOWN_ONLY",
    resolveEligibility: async () =>
      authority(sourceAttempt.id, "NOT_KNOWN_ONLY", [notKnownNode.id]),
    generateQuestions,
  });
  assert.equal(notKnownOnly.created, true);
  if (!notKnownOnly.created) throw new Error("expected not-known retest");
  retestQuizIds.push(notKnownOnly.quizId);
  const [notKnownQuiz] = await db
    .select()
    .from(quizzesTable)
    .where(eq(quizzesTable.id, notKnownOnly.quizId));
  assert.deepEqual(notKnownQuiz.nodeIds, [notKnownNode.id]);
  assert.equal(notKnownQuiz.retestStrategy, "NOT_KNOWN_ONLY");
  assert.equal(generatorCalls, 3);
  console.log("PASS T3-DB5 — both allowlisted strategies persist distinct canonical scopes");

  const [sourceQuizAfter] = await db
    .select()
    .from(quizzesTable)
    .where(eq(quizzesTable.id, sourceQuiz.id));
  const [sourceAttemptAfter] = await db
    .select()
    .from(quizAttemptsTable)
    .where(eq(quizAttemptsTable.id, sourceAttempt.id));
  const sourceAnswersAfter = await db
    .select()
    .from(quizAnswersTable)
    .where(eq(quizAnswersTable.attemptId, sourceAttempt.id))
    .orderBy(asc(quizAnswersTable.id));
  assert.deepEqual(sourceQuizAfter, sourceQuizBefore);
  assert.deepEqual(sourceAttemptAfter, sourceAttemptBefore);
  assert.deepEqual(sourceAnswersAfter, sourceAnswersBefore);
  console.log("PASS T3-DB6 — source quiz, attempt, and answers remain immutable");
} finally {
  if (retestQuizIds.length > 0) {
    await db
      .delete(quizzesTable)
      .where(inArray(quizzesTable.id, retestQuizIds));
  }
  await fixture.cleanup();
  if (subjectId !== null) {
    await db.delete(subjectsTable).where(eq(subjectsTable.id, subjectId));
  }
}

console.log("T3 targeted-retest DB suite passed (6/6)");