// ─────────────────────────────────────────────────────────────────────────────
// Phase 1.12 Cleanup — Student Lesson Linked-Quiz Visibility After Completion
// Q1–Q12 acceptance tests.
//
// Run: pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/phase112-cleanup-quiz-completion.test.ts
//
// Fixtures strategy:
//   - Teacher: userId=1
//   - Student A: dynamically discovered (first student in DB)
//   - Student B: freshly created temp user (isolated completion)
//   - Quiz: a temp quiz created and linked to Lesson 105 for each test
//   - All temp data cleaned up in CLEANUP step
// ─────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  db, usersTable, lessonsTable, lessonNodesTable,
  quizzesTable, quizLessonLinksTable, quizAssignmentsTable,
  quizAttemptsTable, quizQuestionsTable, lessonNodesTable as lessonNodesTbl,
} from "@workspace/db";
import { eq, and, ne, inArray, desc } from "drizzle-orm";

const SECRET    = process.env.SESSION_SECRET ?? "myaiteacher-secret";
const BASE      = "http://localhost:8080/api";
const LESSON_ID = 105;

function headers(tok: string) {
  return { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
}
function tok(userId: number, role = "student", username = "u", fullName = "FN") {
  return jwt.sign({ userId, role, username, fullName }, SECRET, { expiresIn: "1h" });
}

// ── State ─────────────────────────────────────────────────────────────────────
let studentAId  = 0;
let studentBId  = 0;
let quizSubjectId = 0;   // resolved from Lesson 105 at setup time
let quizTeacherId = 0;   // resolved from Lesson 105 at setup time
const teacherTok = tok(1, "teacher", "t", "T");

const tempStudentIds:  number[] = [];
const tempQuizIds:     number[] = [];
const tempLinkIds:     number[] = []; // quizIds linked to Lesson 105 (for cleanup)
const tempAssignIds:   number[] = [];
const tempAttemptIds:  number[] = [];

// ── Test registry ──────────────────────────────────────────────────────────────
type Test = [string, () => Promise<void>];
const tests: Test[] = [];
function it(name: string, fn: () => Promise<void>) { tests.push([name, fn]); }

// ── Helpers ────────────────────────────────────────────────────────────────────

async function createTempQuiz(title: string): Promise<number> {
  if (!quizSubjectId || !quizTeacherId) throw new Error("SETUP-1 must run first to resolve subjectId/teacherId");
  const [q] = await db.insert(quizzesTable).values({
    teacherId: quizTeacherId,
    subjectId: quizSubjectId,
    title,
    status: "GENERATED",
    difficultyMode: "MIXED",
  } as any).returning({ id: quizzesTable.id });
  tempQuizIds.push(q.id);

  // Link to lesson 105
  await db.insert(quizLessonLinksTable).values({ quizId: q.id, lessonId: LESSON_ID });
  tempLinkIds.push(q.id);

  // Add one dummy question (needed for the take endpoint)
  await db.insert(quizQuestionsTable).values({
    quizId: q.id,
    questionText: "Test question?",
    options: JSON.stringify(["A","B","C","D"]),
    correctOptionIndex: 0,
    difficultyLevel: "MEDIUM",
    sequence: 1,
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
  const t = tok(studentId);
  const r = await fetch(`${BASE}/lessons/${LESSON_ID}/student-package`, { headers: headers(t) });
  if (!r.ok) return [];
  const pkg = await r.json() as any;
  return pkg.quizzes ?? [];
}

// ══════════════════════════════════════════════════════════════════════════════
// SETUP
// ══════════════════════════════════════════════════════════════════════════════

it("SETUP-1: Lesson 105 must be active + resolve subjectId/teacherId", async () => {
  const [l] = await db.select({ status: lessonsTable.status, subjectId: lessonsTable.subjectId, teacherId: lessonsTable.teacherId })
    .from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
  assert.ok(l, "Lesson 105 must exist");
  quizSubjectId = l.subjectId!;
  quizTeacherId = l.teacherId!;

  // Force "active" via direct DB update — resilient to concurrent test runs that
  // may leave lesson 105 in approved/needs_review/draft state, and to teacher
  // ownership (lesson 105 is owned by teacher 161, not teacher 1).
  if (l.status !== "active") {
    await db.update(lessonsTable)
      .set({ status: "active" } as any)
      .where(eq(lessonsTable.id, LESSON_ID));
    console.log(`  [INFO] Lesson 105 was '${l.status}' — force-set to 'active' for this test run`);
  }
  const [check] = await db.select({ status: lessonsTable.status })
    .from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
  assert.equal(check.status, "active", "Lesson 105 must be active");
  console.log(`  [INFO] Lesson 105: subjectId=${quizSubjectId}, teacherId=${quizTeacherId}, status=${check.status} ✓`);
});

it("SETUP-2: Resolve Student A", async () => {
  const [s] = await db.select({ id: usersTable.id, username: usersTable.username, fullName: usersTable.fullName })
    .from(usersTable).where(eq(usersTable.role, "student")).limit(1);
  assert.ok(s, "At least one student must exist in DB");
  studentAId = s.id;
  console.log(`  [INFO] Student A: userId=${studentAId}`);
});

it("SETUP-3: Create temp Student B", async () => {
  const [u] = await db.insert(usersTable)
    .values({ username: `__cleanup_B_${Date.now()}`, passwordHash: "x", role: "student", fullName: "Cleanup Student B" })
    .returning({ id: usersTable.id, username: usersTable.username, fullName: usersTable.fullName });
  studentBId = u.id;
  tempStudentIds.push(u.id);
  console.log(`  [INFO] Student B: userId=${studentBId}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// Q1: unreleased quiz → "Դеռ հасaneli chе" / not actionable
// ══════════════════════════════════════════════════════════════════════════════

it("Q1: unreleased quiz — appears in package with isReleased=false, isCompleted=false", async () => {
  const qid = await createTempQuiz(`__Q1_unreleased_${Date.now()}`);
  const qs = await getPackageQuizzes(studentAId);
  const q = qs.find((x: any) => x.id === qid);
  assert.ok(q, "Quiz must appear in student package");
  assert.equal(q.isReleased,  false, "isReleased must be false");
  assert.equal(q.isCompleted, false, "isCompleted must be false");
  // Start must be blocked (403)
  const r = await fetch(`${BASE}/quizzes/${qid}/take`, { headers: headers(tok(studentAId)) });
  assert.equal(r.status, 403, `Expected 403 for unreleased quiz, got ${r.status}`);
  console.log(`  ✓ Q1: unreleased quiz isReleased=false, 403 on take`);
});

// ══════════════════════════════════════════════════════════════════════════════
// Q2: released + not completed → "▶ Sksеl thesty"
// ══════════════════════════════════════════════════════════════════════════════

it("Q2: released + not completed — isReleased=true, isCompleted=false, take allowed (200)", async () => {
  const qid = await createTempQuiz(`__Q2_released_${Date.now()}`);
  await assignQuizToStudent(qid, studentAId);

  const qs = await getPackageQuizzes(studentAId);
  const q = qs.find((x: any) => x.id === qid);
  assert.ok(q, "Quiz must appear in student package");
  assert.equal(q.isReleased,  true,  "isReleased must be true");
  assert.equal(q.isCompleted, false, "isCompleted must be false");

  // Take must succeed
  const r = await fetch(`${BASE}/quizzes/${qid}/take`, { headers: headers(tok(studentAId)) });
  assert.equal(r.status, 200, `Expected 200 on take, got ${r.status}`);
  console.log(`  ✓ Q2: released quiz isReleased=true, 200 on take`);
});

// ══════════════════════════════════════════════════════════════════════════════
// Q3: student completes quiz → isCompleted=true in student-package
// ══════════════════════════════════════════════════════════════════════════════

it("Q3: student completes quiz → isCompleted=true, quiz not actionable from lesson", async () => {
  const qid = await createTempQuiz(`__Q3_completed_${Date.now()}`);
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
// Q4: completed quiz still appears in "Іm thestere" (/quizzes/assigned)
// ══════════════════════════════════════════════════════════════════════════════

it("Q4: completed quiz remains in /quizzes/assigned with status=COMPLETED", async () => {
  // Find completed assignment from Q3
  const r = await fetch(`${BASE}/quizzes/assigned`, { headers: headers(tok(studentAId)) });
  assert.equal(r.status, 200);
  const assigned = await r.json() as any[];
  // Find a COMPLETED entry for the quiz created in Q3 (title pattern)
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
  // Use a quiz that was completed in Q3 (latest assignment is COMPLETED)
  const completedQuizId = tempQuizIds[tempQuizIds.length - 1];
  // Verify: latest assignment for studentAId × completedQuizId is COMPLETED
  const [a] = await db.select({ status: quizAssignmentsTable.status })
    .from(quizAssignmentsTable)
    .where(and(eq(quizAssignmentsTable.quizId, completedQuizId), eq(quizAssignmentsTable.studentId, studentAId)))
    .orderBy(desc(quizAssignmentsTable.assignedAt))
    .limit(1);
  assert.equal(a?.status, "COMPLETED", "Precondition: latest assignment must be COMPLETED");

  const r = await fetch(`${BASE}/quizzes/${completedQuizId}/take`, { headers: headers(tok(studentAId)) });
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

  // Take must succeed
  const r = await fetch(`${BASE}/quizzes/${completedQuizId}/take`, { headers: headers(tok(studentAId)) });
  assert.equal(r.status, 200, `Expected 200 on take after re-release, got ${r.status}`);
  console.log(`  ✓ Q6: re-released quiz isCompleted=false, 200 on take`);
});

// ══════════════════════════════════════════════════════════════════════════════
// Q7: previous attempt/result preserved after re-release
// ══════════════════════════════════════════════════════════════════════════════

it("Q7: historical attempt preserved after re-release", async () => {
  const completedQuizId = tempQuizIds[tempQuizIds.length - 1];

  // Find the original completed assignment (the one with status=COMPLETED)
  const completedAssignments = await db
    .select({ id: quizAssignmentsTable.id, status: quizAssignmentsTable.status })
    .from(quizAssignmentsTable)
    .where(and(
      eq(quizAssignmentsTable.quizId, completedQuizId),
      eq(quizAssignmentsTable.studentId, studentAId),
      eq(quizAssignmentsTable.status, "COMPLETED"),
    ));
  assert.ok(completedAssignments.length >= 1, "Must have at least 1 completed assignment row");

  // Their attempt rows must still exist with score
  for (const ca of completedAssignments) {
    const [att] = await db.select().from(quizAttemptsTable)
      .where(eq(quizAttemptsTable.quizAssignmentId, ca.id)).limit(1);
    assert.ok(att, `Attempt for assignment ${ca.id} must exist`);
    assert.equal(att.totalCorrect,   3,  "Historical totalCorrect must be preserved");
    assert.equal(att.totalQuestions, 10, "Historical totalQuestions must be preserved");
    assert.equal(att.scorePercent,   30, "Historical scorePercent must be preserved");
  }

  // /quizzes/assigned still shows completed row
  const r = await fetch(`${BASE}/quizzes/assigned`, { headers: headers(tok(studentAId)) });
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

  // Find the latest non-completed assignment (created in Q6)
  const [newAssignment] = await db.select({ id: quizAssignmentsTable.id })
    .from(quizAssignmentsTable)
    .where(and(
      eq(quizAssignmentsTable.quizId,   completedQuizId),
      eq(quizAssignmentsTable.studentId, studentAId),
      ne(quizAssignmentsTable.status,   "COMPLETED"),
    ))
    .orderBy(desc(quizAssignmentsTable.assignedAt))
    .limit(1);
  assert.ok(newAssignment, "New (non-completed) assignment must exist from Q6");

  // Simulate second completion
  const attemptId = await markCompleted(newAssignment.id);

  // Both assignments must now have attempt rows
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
  const qid = await createTempQuiz(`__Q9_unaffected_${Date.now()}`);
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
  const qid = await createTempQuiz(`__Q10_two_students_${Date.now()}`);

  // Assign to both
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

  // Check student package for the lesson: no duplicate IDs in quiz array
  const qs = await getPackageQuizzes(studentAId);
  const ids = qs.map((q: any) => q.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, `Duplicate quizzes in student-package: ${ids.join(",")}`);
  console.log(`  ✓ Q11: ${rows.length} temp quizzes, all unique — no duplicates`);
});

// ══════════════════════════════════════════════════════════════════════════════
// Q12: no duplicate lesson nodes/exercises/evidence created
// ══════════════════════════════════════════════════════════════════════════════

it("Q12: lesson 105 nodes count unchanged (no duplicate nodes/exercises created)", async () => {
  const nodes = await db.select({ id: lessonNodesTbl.id })
    .from(lessonNodesTbl).where(eq(lessonNodesTbl.lessonId, LESSON_ID));
  const nodeIds = nodes.map((n) => n.id);
  const unique = new Set(nodeIds);
  assert.equal(unique.size, 9, `Expected exactly 9 unique nodes, got ${unique.size}`);
  assert.equal(nodes.length, 9, `Expected exactly 9 node rows, got ${nodes.length}`);
  console.log(`  ✓ Q12: Lesson 105 has exactly 9 unique nodes — no duplication`);
});

// ══════════════════════════════════════════════════════════════════════════════
// CLEANUP
// ══════════════════════════════════════════════════════════════════════════════

it("CLEANUP: remove all temp data", async () => {
  if (tempAttemptIds.length) {
    // attempts cascade from assignments but delete explicitly to be safe
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
  if (studentBId) {
    await db.delete(usersTable).where(eq(usersTable.id, studentBId)).catch(() => {});
    console.log(`  [INFO] Deleted temp Student B (userId=${studentBId})`);
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
console.log(`\nPhase 1.12 Cleanup: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
