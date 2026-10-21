import assert from "node:assert/strict";
import { collapseToLatestCompletedAttempt } from "../quiz-reporting.js";

const now = new Date();
const rows = [
  { assignmentId: 1, attemptSequence: 1, completedAt: now, score: 60 },
  { assignmentId: 1, attemptSequence: 2, completedAt: now, score: 90 },
  { assignmentId: 1, attemptSequence: 3, completedAt: null, score: null },
  { assignmentId: 2, attemptSequence: null, completedAt: null, score: null },
];

const collapsed = collapseToLatestCompletedAttempt(rows);
assert.equal(collapsed.length, 2);
assert.deepEqual(
  collapsed.map((row) => [row.assignmentId, row.attemptSequence, row.score]),
  [[1, 2, 90], [2, null, null]],
);
assert.equal(collapsed.some((row) => row.attemptSequence === 3), false);
console.log("PASS teacher reporting selects the latest completed attempt and excludes active retests");
const { summarizePracticeProgress } = await import("../quiz-reporting.js");
const question = (questionId: number, isCorrect: boolean) => ({ questionId, isCorrect });
const progress = summarizePracticeProgress([
  { attemptId: 57, attemptSequence: 1, questions: [question(1, false), question(2, false), question(3, true), question(4, false)] },
  { attemptId: 58, attemptSequence: 2, questions: [question(1, true), question(2, true), question(4, false)] },
  { attemptId: 59, attemptSequence: 3, questions: [question(4, true)] },
]);
assert.deepEqual(progress.attempts.map(a => a.scorePercent), [25, 67, 100]);
assert.deepEqual(progress.attempts.map(a => a.cumulativePercent), [25, 75, 100]);
assert.deepEqual(progress.attempts.map(a => a.remainingIncorrect), [3, 1, 0]);
assert.equal(progress.totalQuestions, 4);
assert.equal(progress.totalCorrect, 4);
assert.equal(progress.scorePercent, 100);
assert.equal(progress.latestQuestions.length, 4);
const regression = summarizePracticeProgress([
  { attemptId: 1, attemptSequence: 1, questions: [question(1, true), question(2, true)] },
  { attemptId: 2, attemptSequence: 2, questions: [question(1, false)] },
]);
assert.equal(regression.scorePercent, 50);
assert.equal(summarizePracticeProgress([]).scorePercent, 0);
console.log("PASS 25 → 75 → 100 cumulative progress, independent round scores, no duplicate questions, latest-answer regression");
