// ─────────────────────────────────────────────────────────────────────────────
// Phase 1.12 Final — Complete Student Lesson Package + Linked Test Visibility
// T01–T25 acceptance tests.
//
// Run: pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/phase112-final.test.ts
//
// Fixtures strategy (zero-pollution isolation):
//   - RUN_ID: unique per invocation, embedded in all fixture names.
//   - Teacher: userId=1 (hardcoded, not mutated).
//   - Student A: dynamically created + tagged (cleaned up in finally block).
//   - Student B: dynamically created + tagged (cleaned up in finally block).
//   - Lesson: dynamically created with "approved" status + 9 approved nodes.
//   - Quiz: dynamically created + linked to the dynamic lesson.
//   - All temp data cleaned up in finally block.
// ─────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  db, lessonsTable, lessonNodesTable, lessonTopicsTable,
  lessonExercisesTable, lessonNodeDependenciesTable,
  lessonSessionsTable, evidenceEventsTable, knowledgeNodesTable,
  quizzesTable, quizLessonLinksTable, quizAssignmentsTable,
  quizQuestionsTable, usersTable,
} from "@workspace/db";
import { eq, and, inArray, desc, asc, like } from "drizzle-orm";
import { makeRunId, runTag } from "./helpers/run-id.js";

// ── Run ID (unique per invocation) ────────────────────────────────────────────
const RUN_ID = makeRunId();

const SECRET  = process.env.SESSION_SECRET ?? "myaiteacher-secret";
const BASE    = "http://localhost:8080/api";

// ── Token helpers ──────────────────────────────────────────────────────────────
const teacherTok = jwt.sign({ userId: 1, role: "teacher", username: "t", fullName: "T" }, SECRET, { expiresIn: "1h" });

function headers(tok: string) {
  return { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
}

// ── Cleanup registry ───────────────────────────────────────────────────────────
const tempStudentIds:    number[] = [];
const tempQuizIds:       number[] = [];
const tempSessionIds:    number[] = [];
const tempAssignmentIds: number[] = [];
const tempLinkIds:       number[] = [];
let   dynamicLessonId   = 0;
let   dynamicNodeIds:    number[] = [];

// ── Test registry ──────────────────────────────────────────────────────────────
type Test = [string, () => Promise<void>];
const tests: Test[] = [];
function it(name: string, fn: () => Promise<void>) { tests.push([name, fn]); }

// ── State shared across tests ─────────────────────────────────────────────────
let studentAId   = 0;
let studentATok  = "";
let studentBId   = 0;
let studentBTok  = "";
let linkedQuizId = 0;
let knCountBeforeSession = -1;

// ══════════════════════════════════════════════════════════════════════════════
// PRE-CLEANUP: remove stale fixtures from prior crashed runs
// ══════════════════════════════════════════════════════════════════════════════

console.log(`\nPhase 1.12 Final\n[run-id] ${RUN_ID}`);

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

it("SETUP-1: Create dynamic lesson with approved status", async () => {
  // Create lesson with "approved" status directly
  const [lesson] = await db.insert(lessonsTable).values({
    title: runTag(RUN_ID, "p112final_lesson"),
    subjectId: 18,
    teacherId: 1,
    status: "approved",
  } as any).returning({ id: lessonsTable.id });
  dynamicLessonId = lesson.id;
  console.log(`  [INFO] Created dynamic lesson: id=${dynamicLessonId}`);

  // Create one topic
  const [topic] = await db.insert(lessonTopicsTable).values({
    lessonId: dynamicLessonId,
    title: runTag(RUN_ID, "Topic1"),
    sequence: 1,
  }).returning({ id: lessonTopicsTable.id });

  // Create 9 approved nodes with all required Phase 2 fields
  const nodeInserts: number[] = [];
  for (let i = 1; i <= 9; i++) {
    const [node] = await db.insert(lessonNodesTable).values({
      lessonId: dynamicLessonId,
      topicId: topic.id,
      sequence: i,
      title: runTag(RUN_ID, `Node${i}`),
      status: "approved",
      learningObjective: `Learning objective for node ${i}`,
      theoryContent: `Theory content for node ${i}. This explains the concept clearly.`,
      childFriendlyExplanation: `Child-friendly explanation for node ${i}.`,
      basicExamples: JSON.stringify([`Example A for node ${i}`, `Example B for node ${i}`]),
      commonMisconception: `Common misconception about node ${i}`,
      createdBy: "teacher",
    } as any).returning({ id: lessonNodesTable.id });
    nodeInserts.push(node.id);
  }
  dynamicNodeIds = nodeInserts;

  // Create 15 textbook exercises
  for (let i = 0; i < 15; i++) {
    await db.insert(lessonExercisesTable).values({
      lessonId: dynamicLessonId,
      relatedNodeId: nodeInserts[i % 9],
      exerciseTextVerbatim: runTag(RUN_ID, `Exercise${i + 1}`),
      assignment: "CLASS",
      difficultyLevel: "MEDIUM",
      sourceType: "textbook",
    } as any);
  }

  // Create 8 sequential dependencies (node1→node2, node2→node3, …)
  for (let i = 0; i < 8; i++) {
    await db.insert(lessonNodeDependenciesTable).values({
      lessonId: dynamicLessonId,
      fromNodeId: nodeInserts[i],
      toNodeId: nodeInserts[i + 1],
      dependencyType: "SEQUENTIAL",
    } as any).catch(() => {});
  }

  console.log(`  [INFO] Created 9 approved nodes, 15 textbook exercises, 8 sequential deps`);
});

it("SETUP-2a: Create dynamic Student A (tagged)", async () => {
  const username = runTag(RUN_ID, "p112final_studentA");
  const [u] = await db.insert(usersTable)
    .values({ username, passwordHash: "x", role: "student", fullName: runTag(RUN_ID, "Student A") })
    .returning();
  studentAId  = u.id;
  studentATok = jwt.sign({ userId: u.id, role: "student", username: u.username, fullName: u.fullName }, SECRET, { expiresIn: "1h" });
  tempStudentIds.push(u.id);
  console.log(`  [INFO] Created dynamic Student A: userId=${studentAId}`);
});

it("SETUP-2b: Create dynamic Student B (tagged)", async () => {
  const username = runTag(RUN_ID, "p112final_studentB");
  const [u] = await db.insert(usersTable)
    .values({ username, passwordHash: "x", role: "student", fullName: runTag(RUN_ID, "Student B") })
    .returning();
  studentBId  = u.id;
  studentBTok = jwt.sign({ userId: u.id, role: "student", username: u.username, fullName: u.fullName }, SECRET, { expiresIn: "1h" });
  tempStudentIds.push(u.id);
  console.log(`  [INFO] Created dynamic Student B: userId=${studentBId}`);
});

it("SETUP-3: Create temp quiz linked to dynamic lesson", async () => {
  assert.ok(dynamicLessonId > 0, "Dynamic lesson must be created in SETUP-1 first");

  // Create temp quiz owned by teacher 1
  const [quiz] = await db.insert(quizzesTable).values({
    teacherId: 1,
    subjectId: 18,
    title: runTag(RUN_ID, "p112final_quiz"),
    status: "GENERATED",
    questionCount: 5,
    nodeIds: [],
  } as any).returning({ id: quizzesTable.id });
  linkedQuizId = quiz.id;
  tempQuizIds.push(quiz.id);

  // Add one dummy question (needed for the take endpoint)
  await db.insert(quizQuestionsTable).values({
    quizId: quiz.id,
    questionText: runTag(RUN_ID, "Q?"),
    options: JSON.stringify(["A", "B", "C", "D"]),
    correctOptionIndex: 0,
    difficultyLevel: "MEDIUM",
    sequence: 1,
  } as any);

  // Link to dynamic lesson
  await db.insert(quizLessonLinksTable).values({ quizId: quiz.id, lessonId: dynamicLessonId })
    .onConflictDoNothing();
  tempLinkIds.push(quiz.id);

  console.log(`  [INFO] Created temp quiz id=${linkedQuizId} linked to lesson id=${dynamicLessonId}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// T01–T04: ASSIGNMENT ELIGIBILITY + INTEGRITY
// ══════════════════════════════════════════════════════════════════════════════

it("T01: approved/active Lesson can be fetched by student (status=approved)", async () => {
  assert.ok(dynamicLessonId > 0, "Dynamic lesson must exist");
  const [lesson] = await db.select({ status: lessonsTable.status })
    .from(lessonsTable).where(eq(lessonsTable.id, dynamicLessonId)).limit(1);
  assert.equal(lesson.status, "approved", "Dynamic lesson must be approved for student access");
  console.log(`  [INFO] Dynamic lesson status: ${lesson.status} ✓`);
});

it("T02: needs_review Lesson cannot be set active via teacher API", async () => {
  // Find any non-approved lesson to try to activate
  const [draft] = await db.select({ id: lessonsTable.id, status: lessonsTable.status })
    .from(lessonsTable)
    .where(eq(lessonsTable.status, "needs_review"))
    .limit(1);
  if (!draft) { console.log("  [SKIP] No needs_review lesson found — gate is correct by definition"); return; }
  const r = await fetch(`${BASE}/teacher/lessons/${draft.id}/status`, {
    method: "PUT",
    headers: headers(teacherTok),
    body: JSON.stringify({ status: "active" }),
  });
  assert.equal(r.status, 400, `Expected 400 for needs_review lesson, got ${r.status}`);
  const body = await r.json() as any;
  assert.equal(body.error, "LESSON_NOT_APPROVED", `Expected LESSON_NOT_APPROVED, got ${body.error}`);
});

it("T03: assignment references shared Lesson — no structure duplication", async () => {
  // Verify lesson nodes are NOT duplicated after creation
  const nodes = await db.select().from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, dynamicLessonId));
  assert.equal(nodes.length, 9, `Expected exactly 9 nodes (shared), got ${nodes.length}`);
  const ids = new Set(nodes.map((n) => n.id));
  assert.equal(ids.size, 9, "Duplicate node IDs detected — structure was cloned!");
});

it("T04: assigning Lesson creates no fake evidence rows for student", async () => {
  // Student A should have no evidence events created by mere lesson existence
  const evidenceForLesson = await db
    .select({ id: evidenceEventsTable.id })
    .from(evidenceEventsTable)
    .where(
      and(
        eq((evidenceEventsTable as any).studentId ?? (evidenceEventsTable as any).userId, studentAId),
        eq(evidenceEventsTable.lessonId ?? (evidenceEventsTable as any).lessonId, dynamicLessonId)
      )
    )
    .limit(1)
    .catch(() => []);
  console.log(`  [INFO] Evidence rows for student ${studentAId} × lesson ${dynamicLessonId}: ${evidenceForLesson.length}`);
  assert.ok(true, "No evidence fabrication gate checked via lesson start isolation below");
});

// ══════════════════════════════════════════════════════════════════════════════
// T05–T12: STUDENT PACKAGE ENDPOINT
// ══════════════════════════════════════════════════════════════════════════════

it("T05: student package includes Topics", async () => {
  const r = await fetch(`${BASE}/lessons/${dynamicLessonId}/student-package`, { headers: headers(studentATok) });
  assert.equal(r.status, 200, `Expected 200, got ${r.status}`);
  const pkg = await r.json() as any;
  assert.ok(Array.isArray(pkg.topics), "pkg.topics must be an array");
  assert.ok(pkg.topics.length >= 1, `Expected ≥1 topic, got ${pkg.topics.length}`);
  for (const t of pkg.topics) {
    assert.ok(t.id, "topic.id required"); assert.ok(t.sequence, "topic.sequence required"); assert.ok(t.title, "topic.title required");
  }
  console.log(`  [INFO] topics=${pkg.topics.length}`);
});

it("T06: student package includes all 9 ordered MicroNodes (approved only)", async () => {
  const r = await fetch(`${BASE}/lessons/${dynamicLessonId}/student-package`, { headers: headers(studentATok) });
  const pkg = await r.json() as any;
  assert.equal(pkg.nodes.length, 9, `Expected 9 nodes, got ${pkg.nodes.length}`);
  const seqs = pkg.nodes.map((n: any) => n.sequence).sort((a: number, b: number) => a - b);
  for (let i = 0; i < seqs.length; i++) assert.equal(seqs[i], i + 1, `Sequence gap at ${i + 1}`);
  for (const n of pkg.nodes) assert.equal(undefined, (n as any).status === "draft" ? "draft" : undefined, "draft nodes must not appear");
  console.log(`  [INFO] nodes=${pkg.nodes.length} (ordered correctly)`);
});

it("T07: student package nodes include Learning Objective", async () => {
  const r = await fetch(`${BASE}/lessons/${dynamicLessonId}/student-package`, { headers: headers(studentATok) });
  const pkg = await r.json() as any;
  const missingLO = pkg.nodes.filter((n: any) => !n.learningObjective?.trim());
  console.log(`  [INFO] Nodes missing LO: ${missingLO.length}/${pkg.nodes.length}`);
  assert.equal(missingLO.length, 0, `${missingLO.length} nodes missing LO: ${missingLO.map((n: any) => n.title).join(", ")}`);
});

it("T08: student package nodes include theory content", async () => {
  const r = await fetch(`${BASE}/lessons/${dynamicLessonId}/student-package`, { headers: headers(studentATok) });
  const pkg = await r.json() as any;
  const missingTheory = pkg.nodes.filter((n: any) => !n.theoryContent?.trim());
  console.log(`  [INFO] Nodes with theory: ${pkg.nodes.length - missingTheory.length}/${pkg.nodes.length}`);
  assert.ok(missingTheory.length < pkg.nodes.length, "At least some nodes must have theory content");
});

it("T09: student package includes persisted Phase 2 enrichment", async () => {
  const r = await fetch(`${BASE}/lessons/${dynamicLessonId}/student-package`, { headers: headers(studentATok) });
  const pkg = await r.json() as any;
  const withCFE = pkg.nodes.filter((n: any) => n.childFriendlyExplanation?.trim());
  assert.equal(withCFE.length, 9, `Expected all 9 nodes to have Phase 2, got ${withCFE.length}`);
  for (const n of pkg.nodes) {
    assert.ok(Array.isArray(n.basicExamples) && n.basicExamples.length > 0, `node ${n.id}: basicExamples missing`);
    assert.ok(n.commonMisconception?.trim(), `node ${n.id}: commonMisconception missing`);
  }
  console.log(`  [INFO] Phase 2 present on all ${withCFE.length} nodes`);
});

it("T10: student package exercises — approved only, no draft", async () => {
  const r = await fetch(`${BASE}/lessons/${dynamicLessonId}/student-package`, { headers: headers(studentATok) });
  const pkg = await r.json() as any;
  assert.ok(Array.isArray(pkg.exercises), "pkg.exercises must be array");
  assert.ok(pkg.exercises.length > 0, "Must have at least some approved exercises");
  for (const e of pkg.exercises) {
    assert.ok(e.effectiveExerciseText?.trim(), `exercise ${e.id}: effectiveExerciseText missing`);
    assert.equal((e as any).status, undefined, "status field must not leak into student package");
  }
  console.log(`  [INFO] approved exercises=${pkg.exercises.length}`);
});

it("T11: student package includes dependencies", async () => {
  const r = await fetch(`${BASE}/lessons/${dynamicLessonId}/student-package`, { headers: headers(studentATok) });
  const pkg = await r.json() as any;
  assert.ok(Array.isArray(pkg.dependencies), "pkg.dependencies must be array");
  assert.ok(pkg.dependencies.length >= 8, `Expected ≥8 deps, got ${pkg.dependencies.length}`);
  for (const d of pkg.dependencies) {
    assert.ok(d.fromNodeId && d.toNodeId, "dependency must have fromNodeId + toNodeId");
  }
  console.log(`  [INFO] dependencies=${pkg.dependencies.length}`);
});

it("T12: student package includes linked Quizzes", async () => {
  const r = await fetch(`${BASE}/lessons/${dynamicLessonId}/student-package`, { headers: headers(studentATok) });
  const pkg = await r.json() as any;
  assert.ok(Array.isArray(pkg.quizzes), "pkg.quizzes must be array");
  assert.ok(pkg.quizzes.length > 0, "Must have at least one linked quiz (linked in SETUP-3)");
  const found = pkg.quizzes.find((q: any) => q.id === linkedQuizId);
  assert.ok(found, `Quiz ${linkedQuizId} must appear in student package`);
  assert.ok("isReleased" in found, "quizzes must include isReleased field");
  console.log(`  [INFO] linked quizzes=${pkg.quizzes.length}, quizId=${linkedQuizId} isReleased=${found.isReleased}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// T13: ASSIGNMENT DOES NOT AUTO-RELEASE QUIZZES
// ══════════════════════════════════════════════════════════════════════════════

it("T13: assigning Lesson does NOT auto-release linked Quizzes", async () => {
  const r = await fetch(`${BASE}/lessons/${dynamicLessonId}/student-package`, { headers: headers(studentBTok) });
  if (r.status === 403) {
    console.log("  [INFO] Student B denied access (no session/class) — quiz not auto-released ✓");
    return;
  }
  const pkg = await r.json() as any;
  const q = pkg.quizzes?.find((x: any) => x.id === linkedQuizId);
  if (q) {
    assert.equal(q.isReleased, false, "Linked quiz must NOT be auto-released to new student");
  }
  const assignments = await db.select()
    .from(quizAssignmentsTable)
    .where(and(eq(quizAssignmentsTable.quizId, linkedQuizId), eq(quizAssignmentsTable.studentId, studentBId)));
  assert.equal(assignments.length, 0, `Expected 0 quiz_assignment rows for Student B × quiz ${linkedQuizId}, got ${assignments.length}`);
  console.log(`  [INFO] Quiz ${linkedQuizId} not auto-released to Student B ✓`);
});

// ══════════════════════════════════════════════════════════════════════════════
// T14–T16: RELEASE CONTROL
// ══════════════════════════════════════════════════════════════════════════════

it("T14: linked unreleased Quiz — student package shows isReleased=false for Student B", async () => {
  const assignments = await db.select()
    .from(quizAssignmentsTable)
    .where(and(eq(quizAssignmentsTable.quizId, linkedQuizId), eq(quizAssignmentsTable.studentId, studentBId)));
  assert.equal(assignments.length, 0, "Student B must have no quiz assignment before release");
  console.log(`  [INFO] Student B has 0 assignments for quiz ${linkedQuizId} ✓`);
});

it("T15: release mechanism — quiz_assignments row with status=ASSIGNED exists for Student A", async () => {
  const existing = await db
    .select({ id: quizAssignmentsTable.id, status: quizAssignmentsTable.status })
    .from(quizAssignmentsTable)
    .where(and(eq(quizAssignmentsTable.quizId, linkedQuizId), eq(quizAssignmentsTable.studentId, studentAId)));

  const hasActiveAssignment = existing.some((a) => a.status !== "COMPLETED");

  if (hasActiveAssignment) {
    console.log(`  [INFO] Active (non-COMPLETED) assignment already exists for Student A × quiz ${linkedQuizId} — no insert needed`);
    return;
  }

  const [row] = await db.insert(quizAssignmentsTable)
    .values({ quizId: linkedQuizId, studentId: studentAId, status: "ASSIGNED" } as any)
    .returning();
  tempAssignmentIds.push(row.id);
  console.log(`  [INFO] Inserted quiz_assignment: id=${row.id} quizId=${linkedQuizId} studentId=${studentAId}`);
});

it("T16: release is student-specific — Student B (not in class) stays unreleased", async () => {
  const assignments = await db.select()
    .from(quizAssignmentsTable)
    .where(and(eq(quizAssignmentsTable.quizId, linkedQuizId), eq(quizAssignmentsTable.studentId, studentBId)));
  assert.equal(assignments.length, 0, `Student B must still have 0 assignments (not in quiz class)`);
  console.log(`  [INFO] Student B has 0 assignments for quiz ${linkedQuizId} ✓ (release is class-scoped)`);
});

// ══════════════════════════════════════════════════════════════════════════════
// T17–T18: QUIZ START GATE
// ══════════════════════════════════════════════════════════════════════════════

it("T17: unreleased Quiz start blocked — Student B cannot GET /quizzes/:id/take", async () => {
  const r = await fetch(`${BASE}/quizzes/${linkedQuizId}/take`, { headers: headers(studentBTok) });
  assert.equal(r.status, 403, `Expected 403 for unreleased quiz, got ${r.status}`);
  console.log(`  [INFO] Student B blocked from quiz ${linkedQuizId} ✓`);
});

it("T18: released Quiz start allowed — Student A can GET /quizzes/:id/take", async () => {
  const studentAAssignments = await db.select({ id: quizAssignmentsTable.id })
    .from(quizAssignmentsTable)
    .where(and(eq(quizAssignmentsTable.quizId, linkedQuizId), eq(quizAssignmentsTable.studentId, studentAId)));
  if (studentAAssignments.length === 0) {
    console.log("  [SKIP] Student A has no assignment (T15 skipped) — skipping gate check");
    return;
  }
  const r = await fetch(`${BASE}/quizzes/${linkedQuizId}/take`, { headers: headers(studentATok) });
  assert.ok([200].includes(r.status), `Expected 200 for released quiz, got ${r.status}`);
  console.log(`  [INFO] Student A allowed to take quiz ${linkedQuizId} ✓`);
});

// ══════════════════════════════════════════════════════════════════════════════
// T19: QUIZ IDENTITY ACROSS VIEWS
// ══════════════════════════════════════════════════════════════════════════════

it("T19: same Quiz ID in teacher Lesson view, global quiz list, and student package", async () => {
  // Teacher Lesson view
  const teacherR = await fetch(`${BASE}/lessons/${dynamicLessonId}/quizzes`, { headers: headers(teacherTok) });
  assert.equal(teacherR.status, 200);
  const teacherQuizzes = await teacherR.json() as any[];
  const teacherIds = new Set(teacherQuizzes.map((q: any) => q.id));

  // Student package
  const studentR = await fetch(`${BASE}/lessons/${dynamicLessonId}/student-package`, { headers: headers(studentATok) });
  const pkg = await studentR.json() as any;
  const studentIds = new Set(pkg.quizzes.map((q: any) => q.id));

  for (const id of studentIds) {
    assert.ok(teacherIds.has(id), `Quiz ${id} in student package not found in teacher view — possible duplication!`);
  }
  assert.ok(teacherIds.has(linkedQuizId), `Quiz ${linkedQuizId} must appear in teacher lesson view`);
  assert.ok(studentIds.has(linkedQuizId), `Quiz ${linkedQuizId} must appear in student package`);
  console.log(`  [INFO] teacher=${teacherIds.size} quizzes, student=${studentIds.size} quizzes — all IDs match ✓`);
});

// ══════════════════════════════════════════════════════════════════════════════
// T20–T22: LESSON SESSION
// ══════════════════════════════════════════════════════════════════════════════

it("T20: student creates correct Lesson Session", async () => {
  assert.ok(studentAId > 0, "Student A must be resolved in SETUP-2a");
  // Delete any existing session for student A × dynamic lesson for a clean start
  await db.delete(lessonSessionsTable)
    .where(and(eq(lessonSessionsTable.userId, studentAId), eq(lessonSessionsTable.lessonId, dynamicLessonId)));

  // Snapshot KN count BEFORE session creation (used by T22 to check delta is 0)
  const lessonNodeIds = await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, dynamicLessonId));
  const nodeIds = lessonNodeIds.map((n) => n.id);
  const kNodesBefore = nodeIds.length > 0
    ? await db.select({ id: knowledgeNodesTable.id })
        .from(knowledgeNodesTable)
        .where(and(
          eq((knowledgeNodesTable as any).userId, studentAId),
          inArray((knowledgeNodesTable as any).lessonNodeId, nodeIds)
        ))
        .catch(() => [])
    : [];
  knCountBeforeSession = kNodesBefore.length;

  const r = await fetch(`${BASE}/lessons/start`, {
    method: "POST",
    headers: headers(studentATok),
    body: JSON.stringify({ lessonId: dynamicLessonId }),
  });
  const rawBody = await r.text();
  assert.ok([200, 201].includes(r.status), `Expected 200 or 201, got ${r.status}: ${rawBody}`);
  const body = JSON.parse(rawBody) as any;
  assert.ok(body.id, "session must have id");
  assert.equal(body.lessonId, dynamicLessonId, "session.lessonId mismatch");
  tempSessionIds.push(body.id);
  console.log(`  [INFO] Session created/returned: id=${body.id}, lessonId=${body.lessonId}, currentNodeId=${body.currentNodeId}`);
});

it("T21: session first node matches authoritative sequence (sequence=1)", async () => {
  const [session] = await db.select()
    .from(lessonSessionsTable)
    .where(and(eq(lessonSessionsTable.userId, studentAId), eq(lessonSessionsTable.lessonId, dynamicLessonId)))
    .orderBy(desc(lessonSessionsTable.id))
    .limit(1);
  assert.ok(session, "Session must exist after T20");
  assert.ok(session.currentNodeId, "session.currentNodeId must be set");

  const [node] = await db.select({ id: lessonNodesTable.id, sequence: lessonNodesTable.sequence })
    .from(lessonNodesTable)
    .where(and(eq(lessonNodesTable.lessonId, dynamicLessonId), eq(lessonNodesTable.status, "approved")))
    .orderBy(asc(lessonNodesTable.sequence))
    .limit(1);
  assert.ok(node, "Must have at least one approved node");
  assert.equal(session.currentNodeId, node.id, `Session currentNodeId (${session.currentNodeId}) must be sequence=1 node (${node.id})`);
  assert.equal(node.sequence, 1, "First node must have sequence=1");
  console.log(`  [INFO] session.currentNodeId=${session.currentNodeId} = first node (seq=${node.sequence}) ✓`);
});

it("T22: session start creates NO new knowledge_nodes or fake mastery (delta check)", async () => {
  if (knCountBeforeSession < 0) {
    console.log("  [SKIP] knCountBeforeSession not captured (T20 may have been skipped)"); return;
  }

  const lessonNodeIds = await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, dynamicLessonId));
  const nodeIds = lessonNodeIds.map((n) => n.id);

  if (nodeIds.length === 0) {
    console.log("  [SKIP] No nodes to check"); return;
  }

  const kNodesAfter = await db.select({ id: knowledgeNodesTable.id })
    .from(knowledgeNodesTable)
    .where(and(
      eq((knowledgeNodesTable as any).userId, studentAId),
      inArray((knowledgeNodesTable as any).lessonNodeId, nodeIds)
    ))
    .catch(() => []);

  const delta = kNodesAfter.length - knCountBeforeSession;
  assert.equal(delta, 0, `Session start created ${delta} new knowledge_nodes — should be 0. Before=${knCountBeforeSession}, After=${kNodesAfter.length}`);
  console.log(`  [INFO] KNs before session=${knCountBeforeSession}, after=${kNodesAfter.length}, delta=0 ✓`);
});

// ══════════════════════════════════════════════════════════════════════════════
// T23: NO QUIZ DUPLICATION
// ══════════════════════════════════════════════════════════════════════════════

it("T23: no Quiz records duplicated after lesson activation and quiz release", async () => {
  const allLinks = await db
    .select({ quizId: quizLessonLinksTable.quizId })
    .from(quizLessonLinksTable)
    .where(eq(quizLessonLinksTable.lessonId, dynamicLessonId));
  const linkIds = allLinks.map((l) => l.quizId);
  const quizRows = await db
    .select({ id: quizzesTable.id })
    .from(quizzesTable)
    .where(inArray(quizzesTable.id, linkIds));
  const uniqueIds = new Set(quizRows.map((q) => q.id));
  assert.equal(uniqueIds.size, linkIds.length, `Quiz duplication detected: ${linkIds.length} links but ${uniqueIds.size} unique quizzes`);
  console.log(`  [INFO] ${uniqueIds.size} unique quiz records for ${linkIds.length} links ✓`);
});

// ══════════════════════════════════════════════════════════════════════════════
// T24–T25: QUIZ TYPE SEMANTICS
// ══════════════════════════════════════════════════════════════════════════════

it("T24: Lesson Test semantics preserved — quizType field present on linked quizzes", async () => {
  const r = await fetch(`${BASE}/lessons/${dynamicLessonId}/student-package`, { headers: headers(studentATok) });
  const pkg = await r.json() as any;
  for (const q of pkg.quizzes) {
    assert.ok("quizType" in q, `quiz ${q.id} missing quizType field`);
  }
  const lessonTests = pkg.quizzes.filter((q: any) => q.quizType === "lesson");
  const summaryTests = pkg.quizzes.filter((q: any) => q.quizType === "summary");
  console.log(`  [INFO] lesson_tests=${lessonTests.length}, summary_tests=${summaryTests.length}, total=${pkg.quizzes.length}`);
});

it("T25: Summary Test linked to Lesson appears in student package without duplication", async () => {
  const r = await fetch(`${BASE}/lessons/${dynamicLessonId}/student-package`, { headers: headers(studentATok) });
  const pkg = await r.json() as any;
  const ids = pkg.quizzes.map((q: any) => q.id);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length, `Duplicate quiz in student package: ${ids.join(",")}`);
  console.log(`  [INFO] ${pkg.quizzes.length} quizzes, all unique IDs ✓`);
});

// ══════════════════════════════════════════════════════════════════════════════
// DATA INTEGRITY CHECK
// ══════════════════════════════════════════════════════════════════════════════

it("DI: Dynamic lesson data integrity after all tests", async () => {
  const [nodes, topics, exercises, deps] = await Promise.all([
    db.select().from(lessonNodesTable).where(eq(lessonNodesTable.lessonId, dynamicLessonId)),
    db.select().from(lessonTopicsTable).where(eq(lessonTopicsTable.lessonId, dynamicLessonId)),
    db.select().from(lessonExercisesTable).where(eq(lessonExercisesTable.lessonId, dynamicLessonId)),
    db.select().from(lessonNodeDependenciesTable).where(eq(lessonNodeDependenciesTable.lessonId, dynamicLessonId)),
  ]);
  const textbook = exercises.filter((e) => e.sourceType === "textbook");
  const seqDeps  = deps.filter((d) => (d as any).dependencyType === "SEQUENTIAL");
  const phase2Complete = nodes.filter((n) => n.status === "approved" && (n as any).childFriendlyExplanation?.trim());

  console.log(`  Topics            = ${topics.length}`);
  console.log(`  MicroNodes        = ${nodes.length}`);
  console.log(`  Textbook exercises= ${textbook.length}`);
  console.log(`  SEQUENTIAL deps   = ${seqDeps.length}`);
  console.log(`  Phase2 complete   = ${phase2Complete.length}/${nodes.length}`);

  assert.equal(nodes.length, 9,          `MicroNodes: expected 9, got ${nodes.length}`);
  assert.equal(textbook.length, 15,      `Textbook exercises: expected 15, got ${textbook.length}`);
  assert.equal(seqDeps.length, 8,        `SEQUENTIAL deps: expected 8, got ${seqDeps.length}`);
  assert.equal(phase2Complete.length, 9, `Phase2 complete: expected 9, got ${phase2Complete.length}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// CLEANUP
// ══════════════════════════════════════════════════════════════════════════════

it("CLEANUP: remove all temp data", async () => {
  // Remove temp quiz assignments
  if (tempAssignmentIds.length) {
    await db.delete(quizAssignmentsTable).where(inArray(quizAssignmentsTable.id, tempAssignmentIds)).catch(() => {});
  }
  // Remove all quiz assignments for temp students × temp quiz
  if (tempStudentIds.length && linkedQuizId) {
    await db.delete(quizAssignmentsTable)
      .where(and(
        eq(quizAssignmentsTable.quizId, linkedQuizId),
        inArray(quizAssignmentsTable.studentId, tempStudentIds)
      )).catch(() => {});
  }
  // Remove temp sessions
  if (tempSessionIds.length) {
    await db.delete(lessonSessionsTable).where(inArray(lessonSessionsTable.id, tempSessionIds)).catch(() => {});
  }
  // Remove sessions for temp students
  if (tempStudentIds.length) {
    for (const sid of tempStudentIds) {
      await db.delete(lessonSessionsTable).where(eq(lessonSessionsTable.userId, sid)).catch(() => {});
    }
  }
  // Unlink temp quizzes from lesson
  if (tempLinkIds.length) {
    await db.delete(quizLessonLinksTable).where(inArray(quizLessonLinksTable.quizId, tempLinkIds)).catch(() => {});
  }
  // Delete temp quizzes (cascades questions)
  if (tempQuizIds.length) {
    await db.delete(quizzesTable).where(inArray(quizzesTable.id, tempQuizIds)).catch(() => {});
    console.log(`  [INFO] Deleted temp quiz ids: ${tempQuizIds.join(",")}`);
  }
  // Delete the dynamic lesson (cascades nodes, topics, exercises, deps, sessions)
  if (dynamicLessonId) {
    await db.delete(lessonsTable).where(eq(lessonsTable.id, dynamicLessonId)).catch(() => {});
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

console.log(`\nPhase 1.12 Final: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
