/**
 * Database-backed continuous-session durability/reporting regression.
 *
 * Run: pnpm --filter @workspace/api-server test:quiz-continuous-db
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  db,
  quizAnswersTable,
  quizAssignmentsTable,
  quizAttemptsTable,
  quizQuestionsTable,
  quizSessionsTable,
  quizzesTable,
  subjectsTable,
  usersTable,
} from "@workspace/db";
import { makeRunId, runTag } from "../../lib/__tests__/helpers/run-id.js";
import { getLatestCompletedQuizScoreStats } from "../quiz-reporting.js";
import { ensureQuizSession, getOrCreateActiveAttempt } from "../quiz-session.js";

const runId = makeRunId();
let teacherId: number | null = null;
let studentId: number | null = null;
let subjectId: number | null = null;
let quizId: number | null = null;

try {
  const [teacher] = await db.insert(usersTable).values({
    username: runTag(runId, "continuous_teacher"),
    passwordHash: "provider-free-test",
    fullName: "Continuous Teacher",
    role: "teacher",
  }).returning({ id: usersTable.id });
  teacherId = teacher.id;
  const [student] = await db.insert(usersTable).values({
    username: runTag(runId, "continuous_student"),
    passwordHash: "provider-free-test",
    fullName: "Continuous Student",
    role: "student",
  }).returning({ id: usersTable.id });
  studentId = student.id;
  const [subject] = await db.insert(subjectsTable).values({
    name: runTag(runId, "continuous_subject"),
  }).returning({ id: subjectsTable.id });
  subjectId = subject.id;
  const [quiz] = await db.insert(quizzesTable).values({
    teacherId,
    subjectId,
    title: runTag(runId, "continuous_quiz"),
    questionCount: 1,
    status: "GENERATED",
  }).returning({ id: quizzesTable.id });
  quizId = quiz.id;
  const [question] = await db.insert(quizQuestionsTable).values({
    quizId,
    questionText: "Durable completion?",
    options: ["Yes", "No"],
    correctOptionIndex: 0,
    difficultyLevel: "MEDIUM",
    sequence: 1,
  }).returning({ id: quizQuestionsTable.id });
  const [assignment] = await db.insert(quizAssignmentsTable).values({
    quizId,
    studentId,
    status: "COMPLETED",
  }).returning({ id: quizAssignmentsTable.id });
  const [legacyAttempt] = await db.insert(quizAttemptsTable).values({
    quizAssignmentId: assignment.id,
    completedAt: new Date(),
    totalCorrect: 0,
    totalQuestions: 1,
    scorePercent: 0,
  }).returning({ id: quizAttemptsTable.id });
  await db.insert(quizAnswersTable).values({
    attemptId: legacyAttempt.id,
    questionId: question.id,
    selectedOptionIndex: 1,
    isCorrect: false,
  });
  const session = await ensureQuizSession({
    rootQuizId: quizId,
    rootAssignmentId: assignment.id,
    learnerId: studentId,
  });
  const [adoptedLegacy] = await db.select().from(quizAttemptsTable)
    .where(eq(quizAttemptsTable.id, legacyAttempt.id));
  assert.equal(adoptedLegacy.quizSessionId, session.id);
  assert.equal(adoptedLegacy.attemptSequence, 1);
  console.log("PASS DB1 pre-migration completion is adopted as session history");

  await db.insert(quizAttemptsTable).values({
      quizAssignmentId: assignment.id,
      quizSessionId: session.id,
      attemptSequence: 2,
      completedAt: new Date(),
      totalCorrect: 1,
      totalQuestions: 1,
      scorePercent: 100,
    });
  const [active] = await db.insert(quizAttemptsTable).values({
    quizAssignmentId: assignment.id,
    quizSessionId: session.id,
    attemptSequence: 3,
    totalQuestions: 1,
  }).returning({ id: quizAttemptsTable.id });

  const stats = await getLatestCompletedQuizScoreStats([quizId]);
  assert.equal(Number(stats[0]?.averageScorePercent), 100);
  console.log("PASS DB2 latest reporting ignores the active retest and older completion");

  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.insert(quizAnswersTable).values({
        attemptId: active.id,
        questionId: question.id,
        selectedOptionIndex: 0,
        selectedPresentationIndex: 0,
        isCorrect: true,
      });
      throw new Error("INJECTED_EVIDENCE_FAILURE");
    }),
    /INJECTED_EVIDENCE_FAILURE/,
  );
  const [activeAfterRollback] = await db.select().from(quizAttemptsTable)
    .where(eq(quizAttemptsTable.id, active.id));
  const answersAfterRollback = await db.select().from(quizAnswersTable)
    .where(eq(quizAnswersTable.attemptId, active.id));
  assert.equal(activeAfterRollback.completedAt, null);
  assert.equal(answersAfterRollback.length, 0);
  console.log("PASS DB3 failed completion transaction leaves no partial answer set");

  const [rerelease] = await db.insert(quizAssignmentsTable).values({
    quizId,
    studentId,
    status: "ASSIGNED",
  }).returning({ id: quizAssignmentsTable.id });
  const rereleaseStart = await getOrCreateActiveAttempt({
    rootQuizId: quizId,
    assignmentId: rerelease.id,
    learnerId: studentId,
  });
  assert.notEqual(rereleaseStart.session.id, session.id);
  assert.equal(rereleaseStart.session.rootAssignmentId, rerelease.id);
  assert.equal(rereleaseStart.attempt?.quizAssignmentId, rerelease.id);
  assert.equal(rereleaseStart.attempt?.attemptSequence, 1);
  console.log("PASS DB4 quiz re-release starts an independent assignment-rooted session");
} finally {
  if (quizId !== null) {
    await db.delete(quizzesTable).where(eq(quizzesTable.id, quizId));
  }
  if (subjectId !== null) {
    await db.delete(subjectsTable).where(eq(subjectsTable.id, subjectId));
  }
  if (teacherId !== null || studentId !== null) {
    const ids = [teacherId, studentId].filter((id): id is number => id !== null);
    for (const id of ids) await db.delete(usersTable).where(eq(usersTable.id, id));
  }
  console.log("PASS DB5 continuous-session fixtures leave no pollution");
}