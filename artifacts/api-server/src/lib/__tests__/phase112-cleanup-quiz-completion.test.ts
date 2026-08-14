// ─────────────────────────────────────────────────────────────────────────────
// Phase 1.12 Cleanup — Student Lesson Linked-Quiz Visibility After Completion
// Q1–Q12 acceptance tests.
//
// Run: pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/phase112-cleanup-quiz-completion.test.ts
//
// Fixtures strategy (zero-pollution isolation):
//   - RUN_ID: unique per invocation, embedded in all fixture names.
//   - Teacher: userId=1 (hardcoded, not mutated).
//   - Dynamic lesson: created at setup, tagged with RUN_ID, status=approved.
//   - Student A: dynamically created + tagged with RUN_ID.
//   - Student B: dynamically created + tagged with RUN_ID.
//   - Quiz: temp quizzes linked to the dynamic lesson.
//   - All temp data cleaned up in finally blocks.
// ─────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  db, usersTable, lessonsTable, lessonNodesTable, lessonTopicsTable,
  quizzesTable, quizLessonLinksTable, quizAssignmentsTable,
  quizAttemptsTable, quizQuestionsTable,
} from "@workspace/db";
import { eq, and, ne, inArray, desc, like } from "drizzle-orm";
import { makeRunId, runTag } from "./helpers/run-id.js";

// ── Run ID (unique per invocation) ────────────────────────────────────────────
const RUN_ID = makeRunId();

const SECRET = process.env.SESSION_SECRET ?? "myaiteacher-secret";
const BASE   = "http://localhost:8080/api";

function headers(tok: string) {
  return { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
}
function makeTok(userId: number, role = "student", username = "u", fullName = "FN") {
  return jwt.sign({ userId, role, username, fullName }, SECRET, { expiresIn: "1h" });
}

// ── State ─────────────────────────────────────────────────────────────────────
let studentAId    = 0;
let studentBId    = 0;
let dynamicLessonId = 0;
let quizSubjectId = 0;  // resolved from dynamic lesson at setup time
let quizTeacherId = 0;  // resolved from dynamic lesson at setup time

const teacherTok = makeTok(1, "teacher", "t", "T");

const tempStudentIds:  number[] = [];
const tempQuizIds:     number[] = [];
const tempLinkIds:     number[] = [];
const tempAssignIds:   number[] = [];
const tempAttemptIds:  number[] = [];
let   lessonCleaned    = false;

// ── Test registry ──────────────────────────────────────────────────────────────
type Test = [string, () => Promise<void>];
const tests: Test[] = [];
function it(name: string, fn: () => Promise<void>) { tests.push([name, fn]); }

// ── Helpers ────────────────────────────────────────────────────────────────────

async function createTempQuiz(title: string): Promise<number> {
  if (!quizSubjectId || !quizTeacherId) throw new Error("SETUP-1 must run first to resolve subjectId/teacherId");
  const [q] = await db.insert(quizzesTable).values({
    teacherId:     quizTeacherId,
    subjectId:     quizSubjectId,
    title:         runTag(RUN_ID, title),
    status:        "GENERATED",
    questionCount: 5,
    nodeIds:       [],
  } as any).returning({ id: quizzesTable.id });
  tempQuizIds.push(q.id);

  // Link to dynamic lesson
  await db.insert(quizLessonLinksTable).values({ quizId: q.id, lessonId: dynamicLessonId })
    .onConflictDoNothing();
  tempLinkIds.push(q.id);

  // Add one dummy question (needed for the take endpoint)
  await db.insert(quizQuestionsTable).values({
    quizId:             q.id,
    questionText:       runTag(RUN_ID, "Q?"),
    options:            JSON.stringify(["A", "B", "C", "D"]),
    correctOptionIndex: 0,
    difficultyLevel:    "MEDIUM",
    sequence:           1,
  } as any);

  return q.id;
}

async function assignQuizToStudent(quizId: number, studentId: number): Promise<number> {
  const [a] = await db.insert(quizAssignmentsTable).values({
    quizId,
    studentId,
    status: "ASSIGNED",
  } as any).returning({ id: quizAssignmentsTable.id });
  tempAssignIds.push(a.id);
  return a.id;
}

async function markCompleted(assignmentId: number): Promise<number> {
  await db.update(quizAssignmentsTable)
    .set({ status: "COMPLETED" } as any)
    .where(eq(quizAssignmentsTable.id, assignmentId));
  const [att] = await db.insert(quizAttemptsTable).values({
    quizAssignmentId: assignmentId,
    completedAt:      new Date(),
    totalCorrect:     3,
    totalQuestions:   10,
    scorePercent:     30,
  } as any).returning({ id: quizAttemptsTable.id });
  tempAttemptIds.push(att.id);
  return att.id;
}

async function getPackageQuizzes(studentId: number): Promise<any[]> {
  const t = makeTok(studentId);
  const r = await fetch(`${BASE}/lessons/${dynamicLessonId}/student-package`, { headers: headers(t) });
  if (!r.ok) return [];
  const pkg = await r.json() as any;
  return pkg.quizzes ?? [];
}

// ══════════════════════════════════════════════════════════════════════════════
// PRE-CLEANUP: remove stale fixtures from prior crashed runs
// ══════════════════════════════════════════════════════════════════════════════

console.log(`\nPhase 1.12 Cleanup — Quiz Completion\n[run-id] ${RUN_ID}`);

try {
  const prefix = `${RUN_ID}_`;
  const staleQuizzes = await db
    .select({ id: quizzesTable.id })
    .from(quizzesTable)
    .where(like(quizzesTable.title, `${prefix}%`));
  if (staleQuizzes.length > 0) {
    await db.delete(quizzesTable).where(inArray(quizzesTable.id, staleQuizzes.map((q) => q.id)));
    console.log(`[pre-cleanup] Removed ${staleQuizzes.length} stale quiz(zes)`);
  }
  const staleLessons = await db
    .select({ id: lessonsTable.id })
    .from(lessonsTable)
    .where(like(lessonsTable.title, `${prefix}%`));
  if (staleLessons.length > 0) {
    for (const l of staleLessons) {
      await db.delete(lessonNodesTable).where(eq(lessonNodesTable.lessonId, l.id)).catch(() => {});
    }
    await db.delete(lessonsTable).where(inArray(lessonsTable.id, staleLessons.map((l) => l.id)));
    console.log(`[pre-cleanup] Removed ${staleLessons.length} stale lesson(s)`);
  }
  const staleUsers = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(like(usersTable.username, `${prefix}%`));
  if (staleUsers.length > 0) {
    await db.delete(usersTable).where(inArray(usersTable.id, staleUsers.map((u) => u.id)));
    console.log(`[pre-cleanup] Removed ${staleUsers.length} stale user(s)`);
  }
} catch {
  // pre-cleanup failures must never abort the test suite
}

// ══════════════════════════════════════════════════════════════════════════════
// SETUP
// ══════════════════════════════════════════════════════════════════════════════

it("SETUP-1: Create dynamic lesson with approved status + resolve subjectId/teacherId", async () => {
  // Insert a dynamic lesson tagged with RUN_ID, status=approved
  const [lesson] = await db.insert(lessonsTable).values({
    title:     runTag(RUN_ID, "p112comp_lesson"),
    subjectId: 18,
    teacherId: 1,
    status:    "approved",
  } as any).returning({ id: lessonsTable.id, subjectId: lessonsTable.subjectId, teacherId: lessonsTable.teacherId });

  dynamicLessonId = lesson.id;
  quizSubjectId   = lesson.subjectId!;
  quizTeacherId   = lesson.teacherId!;

  // Create one topic and one node (needed for student-package endpoint)
  const [topic] = await db.insert(lessonTopicsTable).values({
    lessonId: dynamicLessonId,
    title:    runTag(RUN_ID, "Topic1"),
    sequence: 1,
  }).returning({ id: lessonTopicsTable.id });

  await db.insert(lessonNodesTable).values({
    lessonId:          dynamicLessonId,
    topicId:           topic.id,
    sequence:          1,
    title:             runTag(RUN_ID, "Node1"),
    status:            "approved",
    learningObjective: "Test learning objective",
    theoryContent:     "Test theory content for isolation test node.",
    createdBy:         "teacher",
  } as any);

  console.log(`  [INFO] Dynamic lesson: id=${dynamicLessonId}, subjectId=${quizSubjectId}, teacherId=${quizTeacherId}, status=approved ✓`);
});

it("SETUP-2: Create dynamic Student A (tagged)", async () => {
  const username = runTag(RUN_ID, "p112comp_studentA");
  const [s] = await db.insert(usersTable)
    .values({ username, passwordHash: "x", role: "student", fullName: runTag(RUN_ID, "Student A") })
    .returning({ id: usersTable.id });
  studentAId = s.id;
  tempStudentIds.push(s.id);
  console.log(`  [INFO] Student A: userId=${studentAId}`);
});

it("SETUP-3: Create dynamic Student B (tagged)", async () => {
  const username = runTag(RUN_ID, "p112comp_studentB");
  const [u] = await db.insert(usersTable)
    .values({ username, passwordHash: "x", role: "student", fullName: runTag(RUN_ID, "Student B") })
    .returning({ id: usersTable.id });
  studentBId = u.id;
  tempStudentIds.push(u.id);
  console.log(`  [INFO] Student B: userId=${studentBId}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// Q1: unreleased quiz → not actionable
// ══════════════════════════════════════════════════════════════════════════════

it("Q1: unreleased quiz — appears in package with isReleased=false, isCompleted=false", async () => {
  const qid = await createTempQuiz(`Q1_unreleased_${Date.now()}`);
  const qs = await getPackageQuizzes(studentAId);
  const q = qs.find((x: any) => x.id === qid);
  assert.ok(q, "Quiz must appear in student package");
  assert.equal(q.isReleased,  false, "isReleased must be false");
  assert.equal(q.isCompleted, false, "isCompleted must be false");
  // Start must be blocked (403)
  const r = await fetch(`${BASE}/quizzes/${qid}/take`, { headers: headers(makeTok(studentAId)) });
  assert.equal(r.status, 403, `Expected 403 for unreleased quiz, got ${r.status}`);
  console.log(`  ✓ Q1: unreleased quiz isReleased=false, 403 on take`);
});

// ══════════════════════════════════════════════════════════════════════════════
// Q2: released + not completed → take allowed (200)
// ══════════════════════════════════════════════════════════════════════════════

it("Q2: released + not completed — isReleased=true, isCompleted=false, take allowed (200)", async () => {
  const qid = await createTempQuiz(`Q2_released_${Date.now()}`);
  await assignQuizToStudent(qid, studentAId);

  const qs = await getPackageQuizzes(studentAId);
  const q = qs.find((x: any) => x.id === qid);
  assert.ok(q, "Quiz must appear in student package");
  assert.equal(q.isReleased,  true,  "isReleased must be true");
  assert.equal(q.isCompleted, false, "isCompleted must be false");

  const r = await fetch(`${BASE}/quizzes/${qid}/take`, { headers: headers(makeTok(studentAId)) });
  assert.equal(r.status, 200, `Expected 200 on take, got ${r.status}`);
  console.log(`  ✓ Q2: released quiz isReleased=true, 200 on take`);
});

// ══════════════════════════════════════════════════════════════════════════════
// Q3: student completes quiz → isCompleted=true in student-package
// ══════════════════════════════════════════════════════════════════════════════

it("Q3: student completes quiz → isCompleted=true, quiz not actionable from lesson", async () => {
  const qid = await createTempQuiz(`Q3_completed_${Date.now()}`);
  const aid = await assignQuizToStudent(qid, studentAId);
  await markCompleted(aid);

  const qs = await getPackageQuizzes(studentAId);
  const q = qs.find((x: any) => x.id === qid);
  assert.ok(q, "Quiz must still appear in raw package data");
  assert.equal(q.isReleased,  true, "isReleased must remain true");
  assert.equal(q.isCompleted, true, "isCompleted must be true");
  console.log(`  ✓ Q3: after completion isCompleted=true`);
});

// ══════════════════════════════════════════════════════════════════════════════
// Q4: completed quiz still appears in /quizzes/assigned
// ══════════════════════════════════════════════════════════════════════════════

it("Q4: completed quiz remains in /quizzes/assigned with status=COMPLETED", async () => {
  const r = await fetch(`${BASE}/quizzes/assigned`, { headers: headers(makeTok(studentAId)) });
  assert.equal(r.status, 200);
  const assigned = await r.json() as any[];
  const completed = assigned.filter((a: any) => a.status === "COMPLETED");
  assert.ok(completed.length > 0, "Must have at least one COMPLETED assignment in /quizzes/assigned");
  const found = completed.find((a: any) => tempQuizIds.includes(a.quizId));
  assert.ok(found, "The completed quiz from Q3 must appear in /quizzes/assigned");
  assert.ok(found.totalQuestions !== null, "Completed quiz must have totalQuestions");
  console.log(`  ✓ Q4: completed quiz in /quizzes/assigned quizId=${found.quizId} score=${found.scorePercent}%`);
});

// ══════════════════════════════════════════════════════════════════════════════
// Q5: completed quiz cannot be started again (take returns 403)
// ══════════════════════════════════════════════════════════════════════════════

it("Q5: completed quiz — take returns 403 (no active assignment)", async () => {
  const completedQuizId = tempQuizIds[tempQuizIds.length - 1];
  const [a] = await db.select({ status: quizAssignmentsTable.status })
    .from(quizAssignmentsTable)
    .where(and(eq(quizAssignmentsTable.quizId, completedQuizId), eq(quizAssignmentsTable.studentId, studentAId)))
    .orderBy(desc(quizAssignmentsTable.assignedAt))
    .limit(1);
  assert.equal(a?.status, "COMPLETED", "Precondition: latest assignment must be COMPLETED");

  const r = await fetch(`${BASE}/quizzes/${completedQuizId}/take`, { headers: headers(makeTok(studentAId)) });
  assert.equal(r.status, 403, `Expected 403, got ${r.status}`);
  console.log(`  ✓ Q5: completed quiz take → 403`);
});

// ══════════════════════════════════════════════════════════════════════════════
// Q6: teacher re-releases same quiz → quiz reappears (isCompleted=false)
// ══════════════════════════════════════════════════════════════════════════════

it("Q6: teacher re-releases completed quiz → new assignment, isCompleted=false", async () => {
  const completedQuizId = tempQuizIds[tempQuizIds.length - 1];

  // Direct DB insert of new assignment (simulates teacher re-release)
  const aid = await assignQuizToStudent(completedQuizId, studentAId);

  const qs = await getPackageQuizzes(studentAId);
  const q = qs.find((x: any) => x.id === completedQuizId);
  assert.ok(q, "Re-released quiz must appear in student package");
  assert.equal(q.isReleased,  true,  "isReleased must be true after re-release");
  assert.equal(q.isCompleted, false, "isCompleted must be false (new ASSIGNED row is latest)");

  const r = await fetch(`${BASE}/quizzes/${completedQuizId}/take`, { headers: headers(makeTok(studentAId)) });
  assert.equal(r.status, 200, `Expected 200 on take after re-release, got ${r.status}`);
  console.log(`  ✓ Q6: re-released quiz isCompleted=false, 200 on take`);
});

// ══════════════════════════════════════════════════════════════════════════════
// Q7: previous attempt/result preserved after re-release
// ══════════════════════════════════════════════════════════════════════════════

it("Q7: historical attempt preserved after re-release", async () => {
  const completedQuizId = tempQuizIds[tempQuizIds.length - 1];

  const completedAssignments = await db
    .select({ id: quizAssignmentsTable.id, status: quizAssignmentsTable.status })
    .from(quizAssignmentsTable)
    .where(and(
      eq(quizAssignmentsTable.quizId, completedQuizId),
      eq(quizAssignmentsTable.studentId, studentAId),
      eq(quizAssignmentsTable.status, "COMPLETED"),
    ));
  assert.ok(completedAssignments.length >= 1, "Must have at least 1 completed assignment row");

  for (const ca of completedAssignments) {
    const [att] = await db.select().from(quizAttemptsTable)
      .where(eq(quizAttemptsTable.quizAssignmentId, ca.id)).limit(1);
    assert.ok(att, `Attempt for assignment ${ca.id} must exist`);
    assert.equal(att.totalCorrect,   3,  "Historical totalCorrect must be preserved");
    assert.equal(att.totalQuestions, 10, "Historical totalQuestions must be preserved");
    assert.equal(att.scorePercent,   30, "Historical scorePercent must be preserved");
  }

  const r = await fetch(`${BASE}/quizzes/assigned`, { headers: headers(makeTok(studentAId)) });
  const assigned = await r.json() as any[];
  const completed = assigned.filter((a: any) => a.quizId === completedQuizId && a.status === "COMPLETED");
  assert.ok(completed.length >= 1, "Completed assignment must still appear in /quizzes/assigned");
  console.log(`  ✓ Q7: ${completedAssignments.length} completed assignment(s) preserved, attempts intact`);
});

// ══════════════════════════════════════════════════════════════════════════════
// Q8: completing second release creates a separate attempt row (history preserved)
// ══════════════════════════════════════════════════════════════════════════════

it("Q8: second release completion creates separate attempt / preserves history", async () => {
  const completedQuizId = tempQuizIds[tempQuizIds.length - 1];

  const [newAssignment] = await db.select({ id: quizAssignmentsTable.id })
    .from(quizAssignmentsTable)
    .where(and(
      eq(quizAssignmentsTable.quizId,    completedQuizId),
      eq(quizAssignmentsTable.studentId, studentAId),
      ne(quizAssignmentsTable.status,    "COMPLETED"),
    ))
    .orderBy(desc(quizAssignmentsTable.assignedAt))
    .limit(1);
  assert.ok(newAssignment, "New (non-completed) assignment must exist from Q6");

  await markCompleted(newAssignment.id);

  const allAssignments = await db.select({ id: quizAssignmentsTable.id, status: quizAssignmentsTable.status })
    .from(quizAssignmentsTable)
    .where(and(
      eq(quizAssignmentsTable.quizId,    completedQuizId),
      eq(quizAssignmentsTable.studentId, studentAId),
    ));
  for (const ca of allAssignments) {
    const [att] = await db.select({ id: quizAttemptsTable.id })
      .from(quizAttemptsTable)
      .where(eq(quizAttemptsTable.quizAssignmentId, ca.id))
      .limit(1);
    assert.ok(att, `Assignment ${ca.id} (status=${ca.status}) must have an attempt row`);
  }
  assert.ok(allAssignments.length >= 2, "Must have ≥2 assignment rows (two release cycles)");
  console.log(`  ✓ Q8: ${allAssignments.length} total assignment rows, all have attempts`);
});

// ══════════════════════════════════════════════════════════════════════════════
// Q9: another linked quiz not yet completed is unaffected
// ══════════════════════════════════════════════════════════════════════════════

it("Q9: another linked quiz (released, not completed) is unaffected by Q3–Q8 completions", async () => {
  const qid = await createTempQuiz(`Q9_unaffected_${Date.now()}`);
  await assignQuizToStudent(qid, studentAId);

  const qs = await getPackageQuizzes(studentAId);
  const q = qs.find((x: any) => x.id === qid);
  assert.ok(q, "Unaffected quiz must appear in student package");
  assert.equal(q.isReleased,  true,  "isReleased must be true");
  assert.equal(q.isCompleted, false, "isCompleted must be false");
  console.log(`  ✓ Q9: unaffected quiz quizId=${qid} isCompleted=false`);
});

// ══════════════════════════════════════════════════════════════════════════════
// Q10: one student's completion does NOT hide quiz for another student
// ══════════════════════════════════════════════════════════════════════════════

it("Q10: Student A completion does not affect Student B", async () => {
  const qid = await createTempQuiz(`Q10_two_students_${Date.now()}`);

  const aidA = await assignQuizToStudent(qid, studentAId);
  const aidB = await assignQuizToStudent(qid, studentBId);

  // Complete for Student A only
  await markCompleted(aidA);

  // Student A: should see isCompleted=true
  const qsA = await getPackageQuizzes(studentAId);
  const qA = qsA.find((x: any) => x.id === qid);
  assert.ok(qA, "Quiz must appear for Student A");
  assert.equal(qA.isCompleted, true, "Student A should see isCompleted=true");

  // Student B: should see isCompleted=false (not completed for them)
  const qsB = await getPackageQuizzes(studentBId);
  const qB = qsB.find((x: any) => x.id === qid);
  assert.ok(qB, "Quiz must appear for Student B");
  assert.equal(qB.isCompleted, false, "Student B must NOT be affected by Student A's completion");
  console.log(`  ✓ Q10: Student A isCompleted=true, Student B isCompleted=false (isolated)`);
});

// ══════════════════════════════════════════════════════════════════════════════
// Q11: no duplicate Quiz rows
// ══════════════════════════════════════════════════════════════════════════════

it("Q11: no duplicate Quiz records created during test lifecycle", async () => {
  const quizIds = [...new Set(tempQuizIds)];
  const rows = await db.select({ id: quizzesTable.id }).from(quizzesTable)
    .where(inArray(quizzesTable.id, quizIds));
  assert.equal(rows.length, quizIds.length, "Each temp quiz must exist exactly once");

  const qs = await getPackageQuizzes(studentAId);
  const ids = qs.map((q: any) => q.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, `Duplicate quizzes in student-package: ${ids.join(",")}`);
  console.log(`  ✓ Q11: ${rows.length} temp quizzes, all unique — no duplicates`);
});

// ══════════════════════════════════════════════════════════════════════════════
// Q12: no duplicate lesson nodes/exercises created
// ══════════════════════════════════════════════════════════════════════════════

it("Q12: dynamic lesson node count unchanged (no duplicate nodes created)", async () => {
  const nodes = await db.select({ id: lessonNodesTable.id })
    .from(lessonNodesTable).where(eq(lessonNodesTable.lessonId, dynamicLessonId));
  const nodeIds = nodes.map((n) => n.id);
  const unique = new Set(nodeIds);
  assert.equal(unique.size, nodes.length, `Node IDs are not unique — duplication detected: ${nodeIds.join(",")}`);
  assert.equal(nodes.length, 1, `Expected exactly 1 node in dynamic lesson, got ${nodes.length}`);
  console.log(`  ✓ Q12: Dynamic lesson has exactly ${nodes.length} unique node(s) — no duplication`);
});

// ══════════════════════════════════════════════════════════════════════════════
// CLEANUP
// ══════════════════════════════════════════════════════════════════════════════

it("CLEANUP: remove all temp data", async () => {
  if (tempAttemptIds.length) {
    await db.delete(quizAttemptsTable).where(inArray(quizAttemptsTable.id, tempAttemptIds)).catch(() => {});
  }
  if (tempAssignIds.length) {
    await db.delete(quizAssignmentsTable).where(inArray(quizAssignmentsTable.id, tempAssignIds)).catch(() => {});
  }
  if (tempLinkIds.length) {
    await db.delete(quizLessonLinksTable).where(inArray(quizLessonLinksTable.quizId, tempLinkIds)).catch(() => {});
  }
  if (tempQuizIds.length) {
    await db.delete(quizzesTable).where(inArray(quizzesTable.id, tempQuizIds)).catch(() => {});
    console.log(`  [INFO] Deleted ${tempQuizIds.length} temp quizzes`);
  }
  // Delete dynamic lesson (cascades nodes, topics)
  if (dynamicLessonId) {
    await db.delete(lessonsTable).where(eq(lessonsTable.id, dynamicLessonId)).catch(() => {});
    lessonCleaned = true;
    console.log(`  [INFO] Deleted dynamic lesson id=${dynamicLessonId}`);
  }
  // Delete temp student users
  if (tempStudentIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, tempStudentIds)).catch(() => {});
    console.log(`  [INFO] Deleted temp students: ${tempStudentIds.join(",")}`);
  }
});

// ── Runner ────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message}`);
    failed++;
  }
}

// ── Post-pollution gate ────────────────────────────────────────────────────────
console.log("\n[post-pollution gate]");
{
  const prefix = `${RUN_ID}_`;
  const remainingLessons = await db
    .select({ id: lessonsTable.id, title: lessonsTable.title })
    .from(lessonsTable)
    .where(like(lessonsTable.title, `${prefix}%`));
  const remainingQuizzes = await db
    .select({ id: quizzesTable.id, title: quizzesTable.title })
    .from(quizzesTable)
    .where(like(quizzesTable.title, `${prefix}%`));
  const remainingUsers = await db
    .select({ id: usersTable.id, username: usersTable.username })
    .from(usersTable)
    .where(like(usersTable.username, `${prefix}%`));

  if (remainingLessons.length > 0) {
    console.error(`  ✗ POLLUTION: ${remainingLessons.length} lesson(s) not cleaned up:`, remainingLessons.map((l) => l.id));
    failed++;
  } else {
    console.log("  ✓ No lesson pollution");
  }
  if (remainingQuizzes.length > 0) {
    console.error(`  ✗ POLLUTION: ${remainingQuizzes.length} quiz(zes) not cleaned up:`, remainingQuizzes.map((q) => q.id));
    failed++;
  } else {
    console.log("  ✓ No quiz pollution");
  }
  if (remainingUsers.length > 0) {
    console.error(`  ✗ POLLUTION: ${remainingUsers.length} user(s) not cleaned up:`, remainingUsers.map((u) => u.id));
    failed++;
  } else {
    console.log("  ✓ No user pollution");
  }
}

console.log(`\nPhase 1.12 Cleanup: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
