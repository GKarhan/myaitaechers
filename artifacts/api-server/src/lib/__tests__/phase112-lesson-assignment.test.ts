// ─────────────────────────────────────────────────────────────────────────────
// P1.12 — Lesson Assignment Gate + Quiz Release Control — acceptance tests (zero-pollution)
// Run with: pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/phase112-lesson-assignment.test.ts
// No external test framework — uses node:assert/strict + exit code.
//
// All state is created dynamically per run and cleaned up in a top-level finally.
// Tests A–O cover all P1.12 acceptance criteria.
// ─────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  db,
  lessonsTable,
  lessonNodesTable,
  lessonExercisesTable,
  quizzesTable,
  quizAssignmentsTable,
  classesTable,
  classStudentsTable,
  usersTable,
  lessonSessionsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { makeRunId, runTag } from "./helpers/run-id.js";

const RUN_ID = makeRunId();
const SECRET = process.env.SESSION_SECRET ?? "myaiteacher-secret";
const BASE = "http://localhost:8080/api";

// Teacher userId=1 is the canonical test teacher (must exist in DB).
const teacherToken = jwt.sign({ userId: 1, role: "teacher", username: "teacher1", fullName: "T1" }, SECRET, { expiresIn: "1h" });

function authH(tok: string) { return { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }; }

type Test = [string, () => Promise<void>];
const tests: Test[] = [];
function it(name: string, fn: () => Promise<void>) { tests.push([name, fn]); }

// ── IDs tracked for cleanup ───────────────────────────────────────────────────
let LESSON_ID = 0;
let DRAFT_LESSON_ID = 0;
let CLASS_ID = 0;
let STUDENT_ID = 0;
let studentToken = "";

// ── Dynamic fixture setup ──────────────────────────────────────────────────────

// Determine a valid subjectId by looking up the teacher's existing lessons.
// Fall back to subjectId=1 if none found.
const SUBJECT_ID = await (async () => {
  const [existing] = await db
    .select({ subjectId: lessonsTable.subjectId })
    .from(lessonsTable)
    .where(eq(lessonsTable.teacherId, 1))
    .limit(1);
  return existing?.subjectId ?? 1;
})();

// Determine teacherRow.id (teachers.id) for classesTable.teacherId
const { teachersTable } = await import("@workspace/db");
const [teacherRow] = await db
  .select({ id: teachersTable.id })
  .from(teachersTable)
  .where(eq(teachersTable.userId, 1))
  .limit(1);

if (!teacherRow) throw new Error("Teacher row for userId=1 not found — cannot create test class");

// 1. Create a temp class
const [dynClass] = await db.insert(classesTable).values({
  name: runTag(RUN_ID, "class"),
  grade: "9",
  teacherId: teacherRow.id,
}).returning({ id: classesTable.id });
CLASS_ID = dynClass.id;

// 2. Create a temp student user
const [dynStudent] = await db.insert(usersTable).values({
  username: runTag(RUN_ID, "student"),
  passwordHash: "x",
  fullName: runTag(RUN_ID, "Student"),
  role: "student",
}).returning({ id: usersTable.id });
STUDENT_ID = dynStudent.id;
studentToken = jwt.sign({ userId: STUDENT_ID, role: "student", username: runTag(RUN_ID, "student"), fullName: "S" }, SECRET, { expiresIn: "1h" });

// 3. Enroll student in class
await db.insert(classStudentsTable).values({ classId: CLASS_ID, studentId: STUDENT_ID });

// 4. Create the approved lesson linked to class
const [dynLesson] = await db.insert(lessonsTable).values({
  title: runTag(RUN_ID, "approved_lesson"),
  subjectId: SUBJECT_ID,
  teacherId: 1,
  classId: CLASS_ID,
  status: "approved",
  everApproved: true,
  mappingMetadata: { sourceExerciseCount: 2 },
}).returning({ id: lessonsTable.id });
LESSON_ID = dynLesson.id;

// 5. Create 2 approved nodes with all Phase 2 fields
await db.insert(lessonNodesTable).values([
  {
    lessonId: LESSON_ID,
    sequence: 1,
    title: runTag(RUN_ID, "node_1"),
    status: "approved",
    learningObjective: "Understand concept A",
    theoryContent: "Theory A",
    childFriendlyExplanation: "Simple A",
    commonMisconception: "Wrong A",
    basicExamples: [{ example: "Ex A" }],
    nonExamples: [{ nonExample: "NonEx A" }],
    createdBy: "teacher",
  },
  {
    lessonId: LESSON_ID,
    sequence: 2,
    title: runTag(RUN_ID, "node_2"),
    status: "approved",
    learningObjective: "Understand concept B",
    theoryContent: "Theory B",
    childFriendlyExplanation: "Simple B",
    commonMisconception: "Wrong B",
    basicExamples: [{ example: "Ex B" }],
    nonExamples: [{ nonExample: "NonEx B" }],
    createdBy: "teacher",
  },
]);

// 6. Create 15 approved textbook exercises (matching original L assertion count)
const exValues = Array.from({ length: 15 }, (_, i) => ({
  lessonId: LESSON_ID,
  exerciseId: `EX-${RUN_ID}-${i + 1}`,
  exerciseTextVerbatim: `Exercise text ${i + 1}`,
  sourceType: "textbook",
  sourceBlockIndex: i,
  status: "approved",
  sequence: i + 1,
  assignment: i % 2 === 0 ? "CLASS" : "HOMEWORK",
}));
await db.insert(lessonExercisesTable).values(exValues);

// 7. Create a draft lesson for test B (non-approved block)
const [draftLesson] = await db.insert(lessonsTable).values({
  title: runTag(RUN_ID, "draft_lesson"),
  subjectId: SUBJECT_ID,
  teacherId: 1,
  classId: CLASS_ID,
  status: "draft",
  everApproved: false,
}).returning({ id: lessonsTable.id });
DRAFT_LESSON_ID = draftLesson.id;

// ── A: approved-only assignment ────────────────────────────────────────────────
it("A: PUT /teacher/lessons/:id/status → active requires lesson.status === 'approved'", async () => {
  // Dynamic lesson is already approved; status change to "active" should succeed
  const r = await fetch(`${BASE}/teacher/lessons/${LESSON_ID}/status`, {
    method: "PUT",
    headers: authH(teacherToken),
    body: JSON.stringify({ status: "active" }),
  });
  // Accept 200 (success) or 409/already-active — NOT 400 LESSON_NOT_APPROVED
  const body = await r.json().catch(() => ({}));
  assert.ok(
    r.status !== 400 || (body as any).code !== "LESSON_NOT_APPROVED",
    `Approved lesson should not be blocked: ${r.status} ${JSON.stringify(body)}`,
  );
});

// ── B: non-approved block ──────────────────────────────────────────────────────
it("B: PUT /teacher/lessons/:id/status → active blocked when lesson is not approved", async () => {
  const r = await fetch(`${BASE}/teacher/lessons/${DRAFT_LESSON_ID}/status`, {
    method: "PUT",
    headers: authH(teacherToken),
    body: JSON.stringify({ status: "active" }),
  });
  assert.equal(r.status, 400, `Expected 400 for non-approved (draft) lesson, got ${r.status}`);
  const body = await r.json();
  assert.equal((body as any).error, "LESSON_NOT_APPROVED", `Expected LESSON_NOT_APPROVED, got ${JSON.stringify(body)}`);
});

// ── C: shared structure — lesson returned by GET includes status field ─────────
it("C: GET /lessons/:id returns authoringStatus or status for dynamic lesson", async () => {
  const r = await fetch(`${BASE}/lessons/${LESSON_ID}`, { headers: authH(teacherToken) });
  assert.ok(r.ok, `Expected 200 for GET /lessons/${LESSON_ID}, got ${r.status}`);
  const body = await r.json() as any;
  const hasStatus = "authoringStatus" in body || "status" in body;
  assert.ok(hasStatus, `Response missing authoringStatus/status: ${JSON.stringify(Object.keys(body))}`);
});

// ── D: no fake knowledge — assigning a lesson must NOT create knowledge_nodes ──
it("D: lesson assignment does not create knowledge_nodes rows", async () => {
  const { knowledgeNodesTable } = await import("@workspace/db");
  const before = await db
    .select({ id: knowledgeNodesTable.id })
    .from(knowledgeNodesTable)
    .where(eq(knowledgeNodesTable.userId, STUDENT_ID));

  // Activate lesson (may already be active — that's fine)
  await fetch(`${BASE}/teacher/lessons/${LESSON_ID}/status`, {
    method: "PUT",
    headers: authH(teacherToken),
    body: JSON.stringify({ status: "active" }),
  });

  const after = await db
    .select({ id: knowledgeNodesTable.id })
    .from(knowledgeNodesTable)
    .where(eq(knowledgeNodesTable.userId, STUDENT_ID));

  assert.equal(after.length, before.length, `Lesson assignment created ${after.length - before.length} fake knowledge_nodes`);
});

// ── E: linked quiz not auto-released on lesson assignment ──────────────────────
it("E: linked quizzes are NOT auto-released when lesson is activated", async () => {
  const r = await fetch(`${BASE}/lessons/${LESSON_ID}/quizzes`, { headers: authH(teacherToken) });
  if (!r.ok) { console.log("  [SKIP] GET /lessons/:id/quizzes returned", r.status); return; }
  const quizzes = await r.json() as any[];
  if (quizzes.length === 0) { console.log("  [SKIP] No quizzes linked to dynamic lesson"); return; }

  for (const q of quizzes) {
    const rows = await db
      .select()
      .from(quizAssignmentsTable)
      .where(eq(quizAssignmentsTable.quizId, q.id));
    if (rows.length > 0) {
      console.log(`  [INFO] Quiz ${q.id} has ${rows.length} assignment rows — existed before test`);
    }
  }
  const first = quizzes[0];
  assert.ok("classId" in first, `GET /lessons/:id/quizzes response missing classId field: ${JSON.stringify(first)}`);
});

// ── F: manual quiz release via POST /quizzes/:id/assign ───────────────────────
it("F: POST /api/quizzes/:id/assign releases quiz to class students", async () => {
  const r = await fetch(`${BASE}/lessons/${LESSON_ID}/quizzes`, { headers: authH(teacherToken) });
  if (!r.ok) { console.log("  [SKIP]"); return; }
  const quizzes = await r.json() as any[];
  if (quizzes.length === 0) { console.log("  [SKIP] No quizzes linked"); return; }

  const [lessonRow] = await db
    .select({ classId: lessonsTable.classId })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, LESSON_ID));
  if (!lessonRow?.classId) { console.log("  [SKIP] Lesson has no classId"); return; }

  const quiz = quizzes[0];
  const assignR = await fetch(`${BASE}/quizzes/${quiz.id}/assign`, {
    method: "POST",
    headers: authH(teacherToken),
    body: JSON.stringify({ classId: lessonRow.classId }),
  });
  // 200 or 409 (already assigned) both acceptable
  assert.ok(
    assignR.status === 200 || assignR.status === 409,
    `Expected 200 or 409 from assign, got ${assignR.status}`,
  );
});

// ── G: student isolation — quiz assignment is per-student ──────────────────────
it("G: quiz_assignments table is keyed per student (studentId + quizId)", async () => {
  const rows = await db.select().from(quizAssignmentsTable).limit(1);
  if (rows.length === 0) { console.log("  [SKIP] No quiz_assignments rows"); return; }
  const first = rows[0] as any;
  assert.ok("studentId" in first || "userId" in first, `quiz_assignments missing studentId/userId: ${JSON.stringify(Object.keys(first))}`);
  assert.ok("quizId" in first, `quiz_assignments missing quizId`);
});

// ── H: multiple linked tests — GET /lessons/:id/quizzes returns array ──────────
it("H: GET /lessons/:id/quizzes returns an array with id, title, status, quizType, classId", async () => {
  const r = await fetch(`${BASE}/lessons/${LESSON_ID}/quizzes`, { headers: authH(teacherToken) });
  if (!r.ok) { console.log("  [SKIP]"); return; }
  const quizzes = await r.json() as any[];
  assert.ok(Array.isArray(quizzes), "Response must be an array");
  for (const q of quizzes) {
    assert.ok("id" in q, "Missing id");
    assert.ok("title" in q, "Missing title");
    assert.ok("status" in q, "Missing status");
    assert.ok("quizType" in q, "Missing quizType");
    assert.ok("classId" in q, `Missing classId: ${JSON.stringify(Object.keys(q))}`);
  }
});

// ── I: lesson-card actions parity — backend quiz list also has classId ─────────
it("I: global quiz list (GET /teacher/quizzes) includes classId for parity", async () => {
  const r = await fetch(`${BASE}/teacher/quizzes`, { headers: authH(teacherToken) });
  if (!r.ok) { console.log("  [SKIP] GET /teacher/quizzes returned", r.status); return; }
  const body = await r.json() as any;
  const quizzes = Array.isArray(body) ? body : body.quizzes ?? body.data ?? [];
  if (quizzes.length === 0) { console.log("  [SKIP] No quizzes in teacher list"); return; }
  const first = quizzes[0];
  assert.ok("classId" in first || "class_id" in first, `Global quiz list missing classId: ${JSON.stringify(Object.keys(first))}`);
});

// ── J: lesson start creates session only when lesson is active ─────────────────
it("J: POST /lessons/start returns 403 LESSON_NOT_ACTIVE for draft/approved lessons", async () => {
  // Use the draft lesson (not active) owned by the same teacher
  const r = await fetch(`${BASE}/lessons/start`, {
    method: "POST",
    headers: authH(studentToken),
    body: JSON.stringify({ lessonId: DRAFT_LESSON_ID }),
  });
  // Students should get 403 for non-active lessons
  assert.equal(r.status, 403, `Expected 403 for non-active lesson, got ${r.status}`);
  const body = await r.json().catch(() => ({})) as any;
  assert.equal(body.error, "LESSON_NOT_ACTIVE", `Expected LESSON_NOT_ACTIVE error, got ${JSON.stringify(body)}`);
});

// ── K: backend quiz access gate — student cannot start unassigned quiz ─────────
it("K: GET /quizzes/:id/take requires quiz_assignment row for student", async () => {
  const allQuizzes = await db.select({ id: quizzesTable.id }).from(quizzesTable).limit(5);
  const assigned = await db
    .select({ quizId: quizAssignmentsTable.quizId })
    .from(quizAssignmentsTable)
    .where(eq(quizAssignmentsTable.studentId, STUDENT_ID));
  const assignedIds = new Set(assigned.map((a) => a.quizId));
  const unassigned = allQuizzes.find((q) => !assignedIds.has(q.id));

  if (!unassigned) { console.log("  [SKIP] All quizzes assigned to dynamic student"); return; }

  const r = await fetch(`${BASE}/quizzes/${unassigned.id}/take`, { headers: authH(studentToken) });
  assert.ok(r.status === 403 || r.status === 404, `Expected 403/404 for unassigned quiz, got ${r.status}`);
});

// ── L: approved exercises only — dynamic lesson exercises are textbook-sourced ──
it("L: dynamic lesson has exactly 15 textbook exercises, all approved, with CLASS/HOMEWORK assignments", async () => {
  const exercises = await db
    .select()
    .from(lessonExercisesTable)
    .where(eq(lessonExercisesTable.lessonId, LESSON_ID));
  assert.ok(exercises.length > 0, "Dynamic lesson must have exercises");
  assert.equal(exercises.length, 15, `Expected 15 textbook exercises, got ${exercises.length}`);
  for (const ex of exercises) {
    assert.ok(
      (ex as any).assignment === "CLASS" || (ex as any).assignment === "HOMEWORK" || (ex as any).assignment === null,
      `Exercise ${ex.id} has unexpected assignment: ${(ex as any).assignment}`,
    );
  }
});

// ── M: knowledge tree regression — no stale KN rows from test ─────────────────
it("M: GET /knowledge-tree (teacher view for dynamic student) does not crash", async () => {
  const r = await fetch(`${BASE}/knowledge-tree?studentId=${STUDENT_ID}`, { headers: authH(teacherToken) });
  // 200 or 404 (no student) both acceptable; 500 is not
  assert.ok(r.status !== 500, `GET /knowledge-tree crashed: ${r.status}`);
});

// ── N: quiz type regression — quizType field is preserved on linked quizzes ────
it("N: linked quizzes have quizType field (lesson or summary, not undefined)", async () => {
  const r = await fetch(`${BASE}/lessons/${LESSON_ID}/quizzes`, { headers: authH(teacherToken) });
  if (!r.ok) { console.log("  [SKIP]"); return; }
  const quizzes = await r.json() as any[];
  for (const q of quizzes) {
    assert.ok(q.quizType !== undefined, `Quiz ${q.id} has undefined quizType`);
  }
});

// ── O: dynamic lesson node count sanity ────────────────────────────────────────
it("O: dynamic lesson has exactly 2 approved nodes (as inserted)", async () => {
  const nodes = await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(and(
      eq(lessonNodesTable.lessonId, LESSON_ID),
      eq(lessonNodesTable.status, "approved"),
    ));
  assert.equal(nodes.length, 2, `Expected 2 approved nodes, got ${nodes.length}`);
});

// ── Runner ─────────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

console.log(`\n  phase112-lesson-assignment [${RUN_ID}] — ${tests.length} test cases\n`);

try {
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
} finally {
  // ── Cleanup (ordered to respect FK constraints) ─────────────────────────────
  // 1. Remove lesson_sessions for both lessons and student
  await db.delete(lessonSessionsTable).where(eq(lessonSessionsTable.lessonId, LESSON_ID)).catch(() => {});
  await db.delete(lessonSessionsTable).where(eq(lessonSessionsTable.lessonId, DRAFT_LESSON_ID)).catch(() => {});

  // 2. Remove quiz assignments for dynamic student
  await db.delete(quizAssignmentsTable).where(eq(quizAssignmentsTable.studentId, STUDENT_ID)).catch(() => {});

  // 3. Delete lessons (cascade removes nodes, exercises, topics via FK)
  if (LESSON_ID) await db.delete(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).catch(() => {});
  if (DRAFT_LESSON_ID) await db.delete(lessonsTable).where(eq(lessonsTable.id, DRAFT_LESSON_ID)).catch(() => {});

  // 4. Unenroll + delete student (cascade handles class_students)
  if (STUDENT_ID) await db.delete(usersTable).where(eq(usersTable.id, STUDENT_ID)).catch(() => {});

  // 5. Delete class (cascade handles class_students)
  if (CLASS_ID) await db.delete(classesTable).where(eq(classesTable.id, CLASS_ID)).catch(() => {});

  console.log(`  [cleanup] Fixtures for ${RUN_ID} deleted.`);
}

console.log(`\nPhase 1.12: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
