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