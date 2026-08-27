import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
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
import app from "../../app.js";
import { makeRunId, runTag } from "./helpers/run-id.js";
import { assertTestDb } from "./helpers/test-db.js";

assertTestDb();

const runId = makeRunId();
const secret = process.env.SESSION_SECRET ?? "myaiteacher-secret";
const server = app.listen(0);
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

let teacherId: number | null = null;
let studentId: number | null = null;
let subjectId: number | null = null;
let quizId: number | null = null;
let raceQuizId: number | null = null;

try {
  const [teacher] = await db.insert(usersTable).values({
    username: runTag(runId, "feedback_teacher"),
    passwordHash: "provider-free-test",
    fullName: "Feedback Teacher",
    role: "teacher",
  }).returning({ id: usersTable.id });
  teacherId = teacher.id;
  const [student] = await db.insert(usersTable).values({
    username: runTag(runId, "feedback_student"),
    passwordHash: "provider-free-test",
    fullName: "Feedback Student",
    role: "student",
  }).returning({ id: usersTable.id });
  studentId = student.id;
  const [subject] = await db.insert(subjectsTable).values({
    name: runTag(runId, "feedback_subject"),
    grade: "test",
  }).returning({ id: subjectsTable.id });
  subjectId = subject.id;
  const [quiz] = await db.insert(quizzesTable).values({
    teacherId,
    subjectId,
    title: runTag(runId, "feedback_quiz"),
    questionCount: 2,
    status: "GENERATED",
  }).returning({ id: quizzesTable.id });
  quizId = quiz.id;
  const questions = await db.insert(quizQuestionsTable).values([
    {
      quizId,
      questionText: "Choose the correct explained answer.",
      options: ["Correct answer", "Wrong answer"],
      correctOptionIndex: 0,
      optionExplanations: ["This is correct.", "This is why the choice is wrong."],
      solutionExplanation: "The stored solution confirms the correct answer.",
      difficultyLevel: "MEDIUM",
      interactionType: "multiple_choice",
      sequence: 1,
    },
    {
      quizId,
      questionText: "Choose the correct legacy answer.",
      options: ["Legacy correct", "Legacy wrong"],
      correctOptionIndex: 0,
      optionExplanations: null,
      solutionExplanation: null,
      difficultyLevel: "MEDIUM",
      interactionType: "multiple_choice",
      sequence: 2,
    },
  ]).returning({ id: quizQuestionsTable.id });
  await db.insert(quizAssignmentsTable).values({
    quizId,
    studentId,
    status: "ASSIGNED",
  });

  const studentToken = jwt.sign(
    { userId: studentId, role: "student", username: runTag(runId, "feedback_student") },
    secret,
    { expiresIn: "5m" },
  );
  const teacherToken = jwt.sign(
    { userId: teacherId, role: "teacher", username: runTag(runId, "feedback_teacher") },
    secret,
    { expiresIn: "5m" },
  );
  const studentHeaders = { Authorization: `Bearer ${studentToken}` };

  const initialResponse = await fetch(`${baseUrl}/quizzes/${quizId}/take`, {
    headers: studentHeaders,
  });
  assert.equal(initialResponse.status, 200);
  const initial = await initialResponse.json() as {
    attemptId: number;
    questions: Array<{
      id: number;
      options: string[];
      correctOptionIndex?: number;
      optionExplanations?: string[];
      solutionExplanation?: string;
    }>;
    finalizedAnswers: unknown[];
  };
  assert.equal(initial.finalizedAnswers.length, 0);
  for (const question of initial.questions) {
    assert.equal("correctOptionIndex" in question, false);
    assert.equal("optionExplanations" in question, false);
    assert.equal("solutionExplanation" in question, false);
  }

  const first = initial.questions.find((question) => question.id === questions[0]!.id)!;
  const wrongPresentationIndex = first.options.indexOf("Wrong answer");
  const correctPresentationIndex = first.options.indexOf("Correct answer");
  assert.notEqual(wrongPresentationIndex, -1);
  assert.notEqual(correctPresentationIndex, -1);

  const wrongResponse = await fetch(
    `${baseUrl}/quizzes/${quizId}/attempts/${initial.attemptId}/feedback`,
    {
      method: "POST",
      headers: { ...studentHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        questionId: first.id,
        selectedOptionIndex: wrongPresentationIndex,
      }),
    },
  );
  assert.equal(wrongResponse.status, 200);
  const wrongFeedback = await wrongResponse.json() as {
    isCorrect: boolean;
    selectedOptionIndex: number;
    correctOptionIndex: number;
    selectedAnswer: string;
    correctAnswer: string;
    feedback: {
      whyCorrect: string | null;
      whyWrong: string | null;
      solutionExplanation: string | null;
    };
  };
  assert.equal(wrongFeedback.isCorrect, false);
  assert.equal(wrongFeedback.selectedOptionIndex, wrongPresentationIndex);
  assert.equal(wrongFeedback.correctOptionIndex, correctPresentationIndex);
  assert.equal(wrongFeedback.selectedAnswer, "Wrong answer");
  assert.equal(wrongFeedback.correctAnswer, "Correct answer");
  assert.equal(wrongFeedback.feedback.whyWrong, "This is why the choice is wrong.");
  assert.equal(wrongFeedback.feedback.whyCorrect, "This is correct.");

  const persistedAfterFeedback = await db.select().from(quizAnswersTable)
    .where(eq(quizAnswersTable.attemptId, initial.attemptId));
  assert.equal(persistedAfterFeedback.length, 1);
  assert.equal(persistedAfterFeedback[0]!.selectedPresentationIndex, wrongPresentationIndex);
  await db.update(quizAnswersTable)
    .set({ selectedPresentationIndex: null })
    .where(eq(quizAnswersTable.id, persistedAfterFeedback[0]!.id));

  const replayResponse = await fetch(
    `${baseUrl}/quizzes/${quizId}/attempts/${initial.attemptId}/feedback`,
    {
      method: "POST",
      headers: { ...studentHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        questionId: first.id,
        selectedOptionIndex: wrongPresentationIndex,
      }),
    },
  );
  assert.equal(replayResponse.status, 200);

  const changeResponse = await fetch(
    `${baseUrl}/quizzes/${quizId}/attempts/${initial.attemptId}/feedback`,
    {
      method: "POST",
      headers: { ...studentHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        questionId: first.id,
        selectedOptionIndex: correctPresentationIndex,
      }),
    },
  );
  assert.equal(changeResponse.status, 409);

  const reloadResponse = await fetch(`${baseUrl}/quizzes/${quizId}/take`, {
    headers: studentHeaders,
  });
  assert.equal(reloadResponse.status, 200);
  const reloaded = await reloadResponse.json() as {
    finalizedAnswers: Array<{
      questionId: number;
      selectedAnswer: string;
      correctAnswer: string;
      isCorrect: boolean;
    }>;
  };
  assert.deepEqual(reloaded.finalizedAnswers.map((answer) => ({
    questionId: answer.questionId,
    selectedAnswer: answer.selectedAnswer,
    correctAnswer: answer.correctAnswer,
    isCorrect: answer.isCorrect,
  })), [{
    questionId: first.id,
    selectedAnswer: "Wrong answer",
    correctAnswer: "Correct answer",
    isCorrect: false,
  }]);

  const second = initial.questions.find((question) => question.id === questions[1]!.id)!;
  const secondCorrectIndex = second.options.indexOf("Legacy correct");
  const secondResponse = await fetch(
    `${baseUrl}/quizzes/${quizId}/attempts/${initial.attemptId}/feedback`,
    {
      method: "POST",
      headers: { ...studentHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        questionId: second.id,
        selectedOptionIndex: secondCorrectIndex,
      }),
    },
  );
  assert.equal(secondResponse.status, 200);
  const secondFeedback = await secondResponse.json() as {
    isCorrect: boolean;
    correctAnswer: string;
    feedback: Record<string, string | null>;
  };
  assert.equal(secondFeedback.isCorrect, true);
  assert.equal(secondFeedback.correctAnswer, "Legacy correct");
  assert.deepEqual(secondFeedback.feedback, {
    whyCorrect: null,
    whyWrong: null,
    solutionExplanation: null,
  });

  const submitResponse = await fetch(`${baseUrl}/quizzes/${quizId}/submit`, {
    method: "POST",
    headers: { ...studentHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      attemptId: initial.attemptId,
      answers: [
        { questionId: first.id, selectedOptionIndex: wrongPresentationIndex },
        { questionId: second.id, selectedOptionIndex: secondCorrectIndex },
      ],
    }),
  });
  assert.equal(submitResponse.status, 200);
  const result = await submitResponse.json() as { totalCorrect: number; totalQuestions: number };
  assert.deepEqual(
    { totalCorrect: result.totalCorrect, totalQuestions: result.totalQuestions },
    { totalCorrect: 1, totalQuestions: 2 },
  );
  const persistedAfterSubmit = await db.select().from(quizAnswersTable)
    .where(eq(quizAnswersTable.attemptId, initial.attemptId));
  assert.equal(persistedAfterSubmit.length, 2);

  const teacherResponse = await fetch(`${baseUrl}/quizzes/${quizId}`, {
    headers: { Authorization: `Bearer ${teacherToken}` },
  });
  assert.equal(teacherResponse.status, 200);
  const teacherView = await teacherResponse.json() as {
    questions: Array<{
      correctOptionIndex: number;
      optionExplanations: string[] | null;
      solutionExplanation: string | null;
    }>;
  };
  assert.equal(teacherView.questions[0]!.correctOptionIndex, 0);
  assert.deepEqual(
    teacherView.questions[0]!.optionExplanations,
    ["This is correct.", "This is why the choice is wrong."],
  );
  assert.equal(
    teacherView.questions[0]!.solutionExplanation,
    "The stored solution confirms the correct answer.",
  );

  const [raceQuiz] = await db.insert(quizzesTable).values({
    teacherId,
    subjectId,
    title: runTag(runId, "feedback_race_quiz"),
    questionCount: 1,
    status: "GENERATED",
  }).returning({ id: quizzesTable.id });
  raceQuizId = raceQuiz.id;
  const [raceQuestion] = await db.insert(quizQuestionsTable).values({
    quizId: raceQuiz.id,
    questionText: "Concurrent finalization?",
    options: ["Race correct", "Race wrong"],
    correctOptionIndex: 0,
    difficultyLevel: "MEDIUM",
    interactionType: "multiple_choice",
    sequence: 1,
  }).returning({ id: quizQuestionsTable.id });
  await db.insert(quizAssignmentsTable).values({
    quizId: raceQuiz.id,
    studentId: student.id,
    status: "ASSIGNED",
  });
  const raceTakeResponse = await fetch(`${baseUrl}/quizzes/${raceQuiz.id}/take`, {
    headers: studentHeaders,
  });
  assert.equal(raceTakeResponse.status, 200);
  const raceTake = await raceTakeResponse.json() as {
    attemptId: number;
    questions: Array<{ id: number; options: string[] }>;
  };
  const racePresented = raceTake.questions[0]!;
  const raceCorrectIndex = racePresented.options.indexOf("Race correct");
  const raceWrongIndex = racePresented.options.indexOf("Race wrong");
  const [raceFeedbackResponse, raceSubmitResponse] = await Promise.all([
    fetch(`${baseUrl}/quizzes/${raceQuiz.id}/attempts/${raceTake.attemptId}/feedback`, {
      method: "POST",
      headers: { ...studentHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        questionId: raceQuestion.id,
        selectedOptionIndex: raceWrongIndex,
      }),
    }),
    fetch(`${baseUrl}/quizzes/${raceQuiz.id}/submit`, {
      method: "POST",
      headers: { ...studentHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        attemptId: raceTake.attemptId,
        answers: [{
          questionId: raceQuestion.id,
          selectedOptionIndex: raceCorrectIndex,
        }],
      }),
    }),
  ]);
  const [raceAttempt] = await db.select().from(quizAttemptsTable)
    .where(eq(quizAttemptsTable.id, raceTake.attemptId));
  const [raceAnswer] = await db.select().from(quizAnswersTable)
    .where(eq(quizAnswersTable.attemptId, raceTake.attemptId));
  assert.ok(raceAnswer);
  if (raceAttempt!.completedAt) {
    assert.equal(raceSubmitResponse.status, 200);
    assert.equal(raceFeedbackResponse.status, 409);
    assert.equal(raceAttempt!.totalCorrect, 1);
    assert.equal(raceAnswer.selectedPresentationIndex, raceCorrectIndex);
    assert.equal(raceAnswer.isCorrect, true);
  } else {
    assert.equal(raceFeedbackResponse.status, 200);
    assert.equal(raceSubmitResponse.status, 409);
    assert.equal(raceAnswer.selectedPresentationIndex, raceWrongIndex);
    assert.equal(raceAnswer.isCorrect, false);
  }

  console.log("Quiz immediate feedback: all acceptance and concurrency checks passed");
} finally {
  if (raceQuizId !== null) await db.delete(quizzesTable).where(eq(quizzesTable.id, raceQuizId));
  if (quizId !== null) await db.delete(quizzesTable).where(eq(quizzesTable.id, quizId));
  if (subjectId !== null) await db.delete(subjectsTable).where(eq(subjectsTable.id, subjectId));
  if (studentId !== null) await db.delete(usersTable).where(eq(usersTable.id, studentId));
  if (teacherId !== null) await db.delete(usersTable).where(eq(usersTable.id, teacherId));
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
}