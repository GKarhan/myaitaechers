/**
 * Database-backed, provider-free attempt-scope regression.
 *
 * Run: pnpm --filter @workspace/api-server test:retest-authority-db
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  db,
  quizAnswersTable,
  quizAssignmentsTable,
  quizAttemptsTable,
  quizQuestionsTable,
  quizzesTable,
  subjectsTable,
  usersTable,
} from "@workspace/db";
import { makeRunId, runTag } from "../../lib/__tests__/helpers/run-id.js";
import { resolveAttemptScopedNodeIds } from "../quiz-retest-authority.js";

const runId = makeRunId();
const teacherUsername = runTag(runId, "retest_teacher");
const studentUsername = runTag(runId, "retest_student");
const subjectName = runTag(runId, "retest_subject");
const quizTitle = runTag(runId, "retest_quiz");

let teacherId: number | null = null;
let studentId: number | null = null;
let subjectId: number | null = null;
let quizId: number | null = null;
let movedQuestionQuizId: number | null = null;

try {
  const [teacher] = await db
    .insert(usersTable)
    .values({
      username: teacherUsername,
      passwordHash: "provider-free-test",
      fullName: "Retest Teacher",
      role: "teacher",
    })
    .returning({ id: usersTable.id });
  teacherId = teacher.id;

  const [student] = await db
    .insert(usersTable)
    .values({
      username: studentUsername,
      passwordHash: "provider-free-test",
      fullName: "Retest Student",
      role: "student",
    })
    .returning({ id: usersTable.id });
  studentId = student.id;

  const [subject] = await db
    .insert(subjectsTable)
    .values({ name: subjectName })
    .returning({ id: subjectsTable.id });
  subjectId = subject.id;

  const [quiz] = await db
    .insert(quizzesTable)
    .values({
      teacherId,
      subjectId,
      title: quizTitle,
      questionCount: 4,
      status: "GENERATED",
    })
    .returning({ id: quizzesTable.id });
  quizId = quiz.id;

  const questions = await db
    .insert(quizQuestionsTable)
    .values([
      {
        quizId,
        questionText: "Attempted A",
        options: ["A", "B", "C", "D"],
        correctOptionIndex: 0,
        difficultyLevel: "MEDIUM",
        sequence: 1,
        nodeId: null,
      },
      {
        quizId,
        questionText: "Attempted B",
        options: ["A", "B", "C", "D"],
        correctOptionIndex: 0,
        difficultyLevel: "MEDIUM",
        sequence: 2,
        nodeId: null,
      },
      {
        quizId,
        questionText: "Submitted without a node",
        options: ["A", "B", "C", "D"],
        correctOptionIndex: 0,
        difficultyLevel: "MEDIUM",
        sequence: 3,
        nodeId: null,
      },
    ])
    .returning({ id: quizQuestionsTable.id });

  const [assignment] = await db
    .insert(quizAssignmentsTable)
    .values({
      quizId,
      studentId,
      status: "COMPLETED",
    })
    .returning({ id: quizAssignmentsTable.id });

  const [attempt] = await db
    .insert(quizAttemptsTable)
    .values({
      quizAssignmentId: assignment.id,
      completedAt: new Date(),
      totalCorrect: 1,
      totalQuestions: 3,
      scorePercent: 33,
    })
    .returning({ id: quizAttemptsTable.id });

  await db.insert(quizAnswersTable).values([
    {
      attemptId: attempt.id,
      questionId: questions[0].id,
      selectedOptionIndex: 0,
      isCorrect: true,
      nodeId: 50101,
    },
    {
      attemptId: attempt.id,
      questionId: questions[1].id,
      selectedOptionIndex: 1,
      isCorrect: false,
      nodeId: 50102,
    },
    {
      attemptId: attempt.id,
      questionId: questions[2].id,
      selectedOptionIndex: 1,
      isCorrect: false,
      nodeId: null,
    },
    {
      attemptId: attempt.id,
      questionId: questions[1].id,
      selectedOptionIndex: 1,
      isCorrect: false,
      nodeId: 50102,
    },
  ]);

  assert.deepEqual(
    await resolveAttemptScopedNodeIds({ attemptId: attempt.id }),
    [50101, 50102],
    "scope must use answer-time node snapshots, ignore nulls, and deduplicate",
  );

  await db.insert(quizQuestionsTable).values({
    quizId,
    questionText: "Added after completion",
    options: ["A", "B", "C", "D"],
    correctOptionIndex: 0,
    difficultyLevel: "MEDIUM",
    sequence: 0,
    nodeId: null,
  });

  assert.deepEqual(
    await resolveAttemptScopedNodeIds({ attemptId: attempt.id }),
    [50101, 50102],
    "later unanswered quiz questions must not expand historical attempt scope",
  );

  const [movedQuestionQuiz] = await db
    .insert(quizzesTable)
    .values({
      teacherId,
      subjectId,
      title: runTag(runId, "moved_question_quiz"),
      questionCount: 1,
      status: "GENERATED",
    })
    .returning({ id: quizzesTable.id });
  movedQuestionQuizId = movedQuestionQuiz.id;

  await db
    .update(quizQuestionsTable)
    .set({ quizId: movedQuestionQuizId, sequence: 99 })
    .where(eq(quizQuestionsTable.id, questions[0].id));

  assert.deepEqual(
    await resolveAttemptScopedNodeIds({ attemptId: attempt.id }),
    [50101, 50102],
    "moving/reordering a current question must not alter answer-snapshot scope",
  );

  console.log("PASS DB1 — completed-attempt scope uses persisted answered-question nodes");
  console.log("PASS DB2 — later unanswered quiz questions do not expand attempt scope");
  console.log("PASS DB3 — current question moves/reordering do not alter attempt scope");
} finally {
  if (quizId !== null) {
    await db.delete(quizzesTable).where(eq(quizzesTable.id, quizId));
  }
  if (movedQuestionQuizId !== null) {
    await db.delete(quizzesTable).where(eq(quizzesTable.id, movedQuestionQuizId));
  }
  if (subjectId !== null) {
    await db.delete(subjectsTable).where(eq(subjectsTable.id, subjectId));
  }
  if (studentId !== null) {
    await db.delete(usersTable).where(eq(usersTable.id, studentId));
  }
  if (teacherId !== null) {
    await db.delete(usersTable).where(eq(usersTable.id, teacherId));
  }
}

const remainingQuiz = await db
  .select({ id: quizzesTable.id })
  .from(quizzesTable)
  .where(eq(quizzesTable.title, quizTitle));
const remainingSubject = await db
  .select({ id: subjectsTable.id })
  .from(subjectsTable)
  .where(eq(subjectsTable.name, subjectName));
const remainingUsers = await db
  .select({ id: usersTable.id })
  .from(usersTable)
  .where(eq(usersTable.username, teacherUsername));
const remainingStudent = await db
  .select({ id: usersTable.id })
  .from(usersTable)
  .where(eq(usersTable.username, studentUsername));

const remainingMovedQuiz = await db
  .select({ id: quizzesTable.id })
  .from(quizzesTable)
  .where(eq(quizzesTable.title, runTag(runId, "moved_question_quiz")));

assert.equal(remainingQuiz.length, 0);
assert.equal(remainingMovedQuiz.length, 0);
assert.equal(remainingSubject.length, 0);
assert.equal(remainingUsers.length, 0);
assert.equal(remainingStudent.length, 0);
console.log("PASS DB4 — retest-authority fixtures leave no pollution");