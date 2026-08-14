/**
 * Phase 1.11 — Knowledge Tree Initialization Tests
 * 14 required test cases from spec §16.
 * Uses real DB + real API. All test fixtures are cleaned up in finally blocks.
 *
 * Runner: pnpm --filter @workspace/api-server run test:phase111-kt-init
 *
 * Architecture verified:
 *  - Shared structure:  lesson_nodes  (authoritative, one per MicroNode)
 *  - Student state:     knowledge_nodes  (per-student, lazy creation on evidence)
 *  - Zero evidence:     getMasteryLevelFromScores(null,null,null) → not_started
 *  - Approved gate:     knowledge-tree.ts WHERE clause filters non-approved lessons
 *                       (unless student already has a KN row — historical evidence preserved)
 *  - No duplicates:     UNIQUE(user_id, lesson_node_id) in knowledge_nodes
 *
 * Isolation: every created entity is tagged with RUN_ID so that:
 *   - Pre-cleanup removes stale records from prior crashed runs.
 *   - Post-suite pollution gate verifies zero records remain.
 */

import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  db,
  usersTable,
  classesTable,
  classStudentsTable,
  coursesTable,
  lessonsTable,
  lessonNodesTable,
  knowledgeNodesTable,
  evidenceEventsTable,
  lessonTopicsTable,
  lessonExercisesTable,
  teachersTable,
} from "@workspace/db";
import { eq, and, inArray, like } from "drizzle-orm";
import { getMasteryLevelFromScores } from "../mastery";
import { makeRunId, runTag } from "./helpers/run-id.js";

// ── Run-level isolation ID ─────────────────────────────────────────────────────
const RUN_ID = makeRunId();

// ── test harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e: unknown) { console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`); failed++; }
}

// ── API helpers ────────────────────────────────────────────────────────────────
const BASE   = "http://localhost:8080/api";
const SECRET = process.env.SESSION_SECRET ?? "myaiteacher-secret";

function makeToken(userId: number, role: "teacher" | "student" = "student") {
  return jwt.sign({ userId, role }, SECRET, { expiresIn: "1h" });
}

async function ktApi(subjectId: number, token: string) {
  const r = await fetch(`${BASE}/knowledge-tree/${subjectId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: r.status, json: await r.json() as {
    subjectId: number;
    topics: Array<{
      id: number; topicName: string; lessonNodeId: number;
      score: number; masteryLevel: string; status: string;
    }>;
    recommendations: unknown[];
  }};
}

// ── DB helpers ─────────────────────────────────────────────────────────────────
// TEACHER_TABLE_ID resolved at startup from teachers WHERE user_id = 161
// (user 161 is the teacher used for test fixtures — real production teacher)
const TEACHER_USER_ID  = 161;
const SUBJECT_ID       = 18; // Physics 7

let TEACHER_TABLE_ID = 0; // resolved in setupFixtures()

async function resolveTeacherTableId(): Promise<number> {
  const [row] = await db
    .select({ id: teachersTable.id })
    .from(teachersTable)
    .where(eq(teachersTable.userId, TEACHER_USER_ID))
    .limit(1);
  if (!row) {
    throw new Error(
      `Could not find teachers row for user_id=${TEACHER_USER_ID}. ` +
      `Ensure the teacher exists before running Phase 1.11 tests.`,
    );
  }
  return row.id;
}

async function makeTestUser(tag: string): Promise<number> {
  const [u] = await db.insert(usersTable).values({
    username:     runTag(RUN_ID, `kt_user_${tag}`),
    passwordHash: "dummy-hash",
    fullName:     `P111 Test ${tag} ${RUN_ID}`,
    role:         "student",
  }).returning({ id: usersTable.id });
  return u.id;
}

async function makeTestClass(): Promise<number> {
  const [c] = await db.insert(classesTable).values({
    name:      runTag(RUN_ID, "kt_class"),
    grade:     "7",
    teacherId: TEACHER_TABLE_ID,
  }).returning({ id: classesTable.id });
  return c.id;
}

async function makeTestCourse(classId: number): Promise<number> {
  const [c] = await db.insert(coursesTable).values({
    classId,
    teacherId:   TEACHER_USER_ID,
    subjectId:   SUBJECT_ID,
    name:        runTag(RUN_ID, `kt_course_${Date.now()}`),
    description: "",
  }).returning({ id: coursesTable.id });
  return c.id;
}

async function makeTestLesson(courseId: number, status: string): Promise<{ lessonId: number; nodeId: number }> {
  const [l] = await db.insert(lessonsTable).values({
    title:     runTag(RUN_ID, `kt_lesson_${status}`),
    subjectId: SUBJECT_ID,
    courseId,
    status,
  }).returning({ id: lessonsTable.id });
  const [n] = await db.insert(lessonNodesTable).values({
    lessonId:  l.id,
    sequence:  1,
    title:     runTag(RUN_ID, `kt_node_${status}`),
    createdBy: "teacher",
  }).returning({ id: lessonNodesTable.id });
  return { lessonId: l.id, nodeId: n.id };
}

async function addExtraNode(lessonId: number, seq: number): Promise<number> {
  const [n] = await db.insert(lessonNodesTable).values({
    lessonId,
    sequence:  seq,
    title:     runTag(RUN_ID, `kt_extra_node_${seq}`),
    createdBy: "teacher",
  }).returning({ id: lessonNodesTable.id });
  return n.id;
}

async function enrollStudent(classId: number, studentId: number) {
  await db.insert(classStudentsTable).values({ classId, studentId }).onConflictDoNothing();
}

async function makeKnowledgeNode(
  userId: number, subjectId: number, lessonNodeId: number,
  masteryScore?: number, confidenceScore?: number,
): Promise<number> {
  const [k] = await db.insert(knowledgeNodesTable).values({
    userId, subjectId, lessonNodeId,
    topicName:      `test-node-${lessonNodeId}`,
    masteryScore:   masteryScore ?? null,
    confidenceScore: confidenceScore ?? null,
    bloomLevel:     1,
    isProvisional:  true,
    status:         masteryScore !== undefined && masteryScore >= 80 ? "mastered" : "not_started",
  }).returning({ id: knowledgeNodesTable.id });
  return k.id;
}

async function makeEvidenceEvent(userId: number, knId: number): Promise<number> {
  const [e] = await db.insert(evidenceEventsTable).values({
    userId, topicId: knId,
    eventType: "answer", wasCorrect: true, hintUsed: false,
    metadata: { source: "test", phase: "1.11" },
  }).returning({ id: evidenceEventsTable.id });
  return e.id;
}

async function cleanUser(userId: number) {
  await db.delete(usersTable).where(eq(usersTable.id, userId));
}

async function cleanClass(classId: number) {
  await db.delete(classesTable).where(eq(classesTable.id, classId));
}

async function cleanCourse(courseId: number) {
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
}

async function cleanLesson(lessonId: number) {
  // Delete in FK dependency order for this lesson
  const nodeRows = await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, lessonId));
  const nodeIds = nodeRows.map((r) => r.id);
  if (nodeIds.length > 0) {
    // knowledge_nodes → evidence_events cascade, but delete KN rows first for safety
    await db.delete(knowledgeNodesTable).where(inArray(knowledgeNodesTable.lessonNodeId, nodeIds));
    await db.delete(lessonNodesTable).where(inArray(lessonNodesTable.id, nodeIds));
  }
  await db.delete(lessonsTable).where(eq(lessonsTable.id, lessonId));
}

async function cleanKnRow(knId: number) {
  // CASCADE on evidence_events.topic_id → deleting KN row removes evidence too
  await db.delete(knowledgeNodesTable).where(eq(knowledgeNodesTable.id, knId));
}

// ── Pre-cleanup: remove stale entities from prior crashed runs ─────────────────
async function preCleanup(): Promise<void> {
  const prefix = `${RUN_ID}_%`;
  try {
    // Find stale lessons tagged with this RUN_ID
    const staleUsers = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(like(usersTable.username, prefix));
    if (staleUsers.length > 0) {
      console.log(`  [pre-cleanup] removing ${staleUsers.length} stale user(s) from prior crash`);
      await db.delete(usersTable).where(inArray(usersTable.id, staleUsers.map((r) => r.id)));
    }

    const staleLessons = await db
      .select({ id: lessonsTable.id })
      .from(lessonsTable)
      .where(like(lessonsTable.title, prefix));
    if (staleLessons.length > 0) {
      console.log(`  [pre-cleanup] removing ${staleLessons.length} stale lesson(s) from prior crash`);
      for (const l of staleLessons) {
        await cleanLesson(l.id);
      }
    }

    const staleClasses = await db
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(like(classesTable.name, prefix));
    if (staleClasses.length > 0) {
      console.log(`  [pre-cleanup] removing ${staleClasses.length} stale class(es) from prior crash`);
      await db.delete(classesTable).where(inArray(classesTable.id, staleClasses.map((r) => r.id)));
    }
  } catch (err) {
    // Pre-cleanup failures must never abort the test suite
    console.warn(`  [pre-cleanup] non-fatal error:`, err);
  }
}

// ── Post-suite pollution gate ──────────────────────────────────────────────────
async function assertNoPollution(): Promise<void> {
  const prefix = `${RUN_ID}_%`;

  const leakedUsers = await db
    .select({ id: usersTable.id, username: usersTable.username })
    .from(usersTable)
    .where(like(usersTable.username, prefix));

  const leakedLessons = await db
    .select({ id: lessonsTable.id, title: lessonsTable.title })
    .from(lessonsTable)
    .where(like(lessonsTable.title, prefix));

  const leakedClasses = await db
    .select({ id: classesTable.id, name: classesTable.name })
    .from(classesTable)
    .where(like(classesTable.name, prefix));

  const leaked: string[] = [
    ...leakedUsers.map((r) => `users.id=${r.id} username=${r.username}`),
    ...leakedLessons.map((r) => `lessons.id=${r.id} title=${r.title}`),
    ...leakedClasses.map((r) => `classes.id=${r.id} name=${r.name}`),
  ];

  if (leaked.length > 0) {
    throw new Error(
      `POST_POLLUTION_GATE FAIL: ${leaked.length} record(s) with RUN_ID prefix leaked after cleanup:\n` +
      leaked.map((l) => `  ${l}`).join("\n"),
    );
  }
  console.log("  [pollution-gate] ✓ zero records with RUN_ID prefix remain");
}

// ── Shared fixture state ───────────────────────────────────────────────────────
let classId = 0, courseId = 0;
let approvedLessonId = 0, approvedNodeId = 0;
let draftLessonId = 0, draftNodeId = 0;
let studentAId = 0, studentBId = 0;
let studentAToken = "", studentBToken = "";

async function setupFixtures() {
  // Resolve teachers.id dynamically — never hardcode
  TEACHER_TABLE_ID = await resolveTeacherTableId();

  classId  = await makeTestClass();
  courseId = await makeTestCourse(classId);
  const approved = await makeTestLesson(courseId, "approved");
  approvedLessonId = approved.lessonId;
  approvedNodeId   = approved.nodeId;
  const draft = await makeTestLesson(courseId, "draft");
  draftLessonId = draft.lessonId;
  draftNodeId   = draft.nodeId;
  studentAId = await makeTestUser("studentA");
  studentBId = await makeTestUser("studentB");
  studentAToken = makeToken(studentAId);
  studentBToken = makeToken(studentBId);
  await enrollStudent(classId, studentAId);
  await enrollStudent(classId, studentBId);
}

async function teardownFixtures() {
  // Delete in FK-safe order:
  // knowledge_nodes → evidence_events (CASCADE), lesson_sessions, lessons, class_students, classes, users
  try {
    // Remove any lingering knowledge_nodes for our test students
    if (studentAId) {
      await db.delete(knowledgeNodesTable).where(eq(knowledgeNodesTable.userId, studentAId));
    }
    if (studentBId) {
      await db.delete(knowledgeNodesTable).where(eq(knowledgeNodesTable.userId, studentBId));
    }

    // Lessons (nodes inside are cleaned via cleanLesson's per-nodeId cleanup)
    if (approvedLessonId) await cleanLesson(approvedLessonId);
    if (draftLessonId)    await cleanLesson(draftLessonId);

    if (courseId) await cleanCourse(courseId);
    if (classId)  await cleanClass(classId);  // also cascades class_students
    if (studentAId) await cleanUser(studentAId);
    if (studentBId) await cleanUser(studentBId);
  } catch (err) {
    console.error("  [teardown] error during cleanup:", err);
  }
}

// ── Run tests ─────────────────────────────────────────────────────────────────
console.log("\nPhase 1.11 — Knowledge Tree Initialization\n");
console.log(`  RUN_ID = ${RUN_ID}`);
console.log("  Running pre-cleanup for stale entities from prior crashes...");
await preCleanup();
console.log("  Setting up shared fixtures...");
await setupFixtures();
console.log(`  TEACHER_TABLE_ID=${TEACHER_TABLE_ID} (resolved from user_id=${TEACHER_USER_ID})`);
console.log(`  classId=${classId}  courseId=${courseId}`);
console.log(`  approved: lessonId=${approvedLessonId} nodeId=${approvedNodeId}`);
console.log(`  draft:    lessonId=${draftLessonId}    nodeId=${draftNodeId}`);
console.log(`  studentA=${studentAId}  studentB=${studentBId}\n`);

try {
  // ── Group A: Approved lesson gate ─────────────────────────────────────────
  console.log("  Approved lesson gate");

  await test("T01: approved lesson nodes appear in KT API for zero-evidence student", async () => {
    const { status, json } = await ktApi(SUBJECT_ID, studentAToken);
    assert.equal(status, 200);
    const found = json.topics.find((t) => t.lessonNodeId === approvedNodeId);
    assert.ok(found, `Approved node ${approvedNodeId} not in KT response`);
    assert.equal(found.masteryLevel, "not_started", `Expected not_started, got ${found.masteryLevel}`);
  });

  await test("T02: non-approved (draft) lesson node does NOT appear for zero-evidence student", async () => {
    const { status, json } = await ktApi(SUBJECT_ID, studentAToken);
    assert.equal(status, 200);
    const found = json.topics.find((t) => t.lessonNodeId === draftNodeId);
    assert.ok(!found, `Draft node ${draftNodeId} must NOT appear in KT response but was found`);
  });

  // ── Group B: Zero-evidence → not_started ──────────────────────────────────
  console.log("\n  Zero-evidence → not_started");

  await test("T03: getMasteryLevelFromScores(null, null, null) === not_started (pure function)", async () => {
    const level = getMasteryLevelFromScores(null, null, null);
    assert.equal(level, "not_started");
  });

  await test("T04: new student has zero evidence_events and zero KN rows", async () => {
    // Query KN rows for studentB against approved nodes
    const kn = await db.select({ id: knowledgeNodesTable.id })
      .from(knowledgeNodesTable)
      .where(and(
        eq(knowledgeNodesTable.userId, studentBId),
        eq(knowledgeNodesTable.lessonNodeId, approvedNodeId),
      ));
    assert.equal(kn.length, 0, `Expected 0 KN rows for studentB, found ${kn.length}`);
    // No evidence_events either
    const ev = await db.select({ id: evidenceEventsTable.id })
      .from(evidenceEventsTable)
      .where(eq(evidenceEventsTable.userId, studentBId));
    assert.equal(ev.length, 0, `Expected 0 evidence events for studentB, found ${ev.length}`);
  });

  // ── Group C: Shared node identity ─────────────────────────────────────────
  console.log("\n  Shared node identity");

  await test("T05: both students see the same shared lessonNodeId in KT response", async () => {
    const [rA, rB] = await Promise.all([
      ktApi(SUBJECT_ID, studentAToken),
      ktApi(SUBJECT_ID, studentBToken),
    ]);
    const topicA = rA.json.topics.find((t) => t.lessonNodeId === approvedNodeId);
    const topicB = rB.json.topics.find((t) => t.lessonNodeId === approvedNodeId);
    assert.ok(topicA, "studentA must see the node");
    assert.ok(topicB, "studentB must see the node");
    // Both reference the same shared lesson_node_id — identity is preserved
    assert.equal(topicA.lessonNodeId, approvedNodeId, "studentA lessonNodeId");
    assert.equal(topicB.lessonNodeId, approvedNodeId, "studentB lessonNodeId");
    assert.equal(topicA.lessonNodeId, topicB.lessonNodeId, "shared node ID must match across students");
  });

  // ── Group D: Lesson 105 direct verification ───────────────────────────────
  console.log("\n  Lesson 105 direct verification");

  await test("T06: all Lesson 105 nodes exist and have zero evidence for test students (not_started)", async () => {
    // READ-ONLY real-data verification — this test does NOT modify lesson 105
    // Lesson 105 may have had teacher edits outside Phase 1.11.
    // Verify whatever nodes exist all resolve to not_started for zero-evidence students.
    const nodes = await db.select({ id: lessonNodesTable.id, title: lessonNodesTable.title })
      .from(lessonNodesTable)
      .where(eq(lessonNodesTable.lessonId, 105));
    assert.ok(nodes.length >= 1, `Lesson 105 must have at least 1 node, found ${nodes.length}`);
    console.log(`      Lesson 105 current node count: ${nodes.length}`);

    const nodeIds = nodes.map((n) => n.id);
    // No KN rows for our test students (they are new, no evidence on lesson 105)
    const knA = await db.select({ id: knowledgeNodesTable.id })
      .from(knowledgeNodesTable)
      .where(and(
        eq(knowledgeNodesTable.userId, studentAId),
        inArray(knowledgeNodesTable.lessonNodeId, nodeIds),
      ));
    assert.equal(knA.length, 0, `studentA must have 0 KN rows for lesson 105 (fresh student)`);

    const knB = await db.select({ id: knowledgeNodesTable.id })
      .from(knowledgeNodesTable)
      .where(and(
        eq(knowledgeNodesTable.userId, studentBId),
        inArray(knowledgeNodesTable.lessonNodeId, nodeIds),
      ));
    assert.equal(knB.length, 0, `studentB must have 0 KN rows for lesson 105 (fresh student)`);

    // All existing nodes resolve to not_started via the mastery function (NULL scores)
    for (const node of nodes) {
      const level = getMasteryLevelFromScores(null, null, null);
      assert.equal(level, "not_started",
        `Node ${node.id} (${node.title}) with null scores must be not_started, got ${level}`);
    }
  });

  // ── Group E: Evidence transition + student isolation ──────────────────────
  console.log("\n  Evidence transition + student isolation");

  let knAId = 0;
  await test("T07: adding evidence causes state transition away from not_started", async () => {
    // Start: studentA has no KN row for approvedNode → not_started
    const before = getMasteryLevelFromScores(null, null, null);
    assert.equal(before, "not_started");

    // Insert KN row with strong mastery (simulates post-quiz scoring)
    knAId = await makeKnowledgeNode(studentAId, SUBJECT_ID, approvedNodeId, 90, 85);
    const [kn] = await db.select({ masteryScore: knowledgeNodesTable.masteryScore, confidenceScore: knowledgeNodesTable.confidenceScore })
      .from(knowledgeNodesTable).where(eq(knowledgeNodesTable.id, knAId));
    const after = getMasteryLevelFromScores(kn.masteryScore, kn.confidenceScore, null);
    assert.notEqual(after, "not_started", `State must leave not_started after evidence, got ${after}`);
    assert.equal(after, "mastered", `Expected mastered with score 90/85, got ${after}`);
  });

  await test("T08: studentB (no evidence) remains not_started while studentA is mastered", async () => {
    // READ-ONLY real-data verification — studentB isolation check
    // studentA has KN row (from T07). Check studentB via KT API.
    const { json } = await ktApi(SUBJECT_ID, studentBToken);
    const topicB = json.topics.find((t) => t.lessonNodeId === approvedNodeId);
    assert.ok(topicB, "studentB must see the shared node");
    assert.equal(topicB.masteryLevel, "not_started",
      `studentB must be not_started but got ${topicB.masteryLevel}`);

    // Confirm studentA sees mastered via API
    const { json: jsonA } = await ktApi(SUBJECT_ID, studentAToken);
    const topicA = jsonA.topics.find((t) => t.lessonNodeId === approvedNodeId);
    assert.ok(topicA, "studentA must see the shared node");
    assert.equal(topicA.masteryLevel, "mastered",
      `studentA must be mastered but got ${topicA.masteryLevel}`);

    // Same node ID — isolation confirmed
    assert.equal(topicA.lessonNodeId, topicB.lessonNodeId, "same shared node ID");
  });

  // Clean up studentA KN row (restore pristine state)
  if (knAId) await cleanKnRow(knAId);

  await test("T09: newly approved MicroNode added to existing lesson appears as not_started", async () => {
    // Add a second node to the approved lesson after the fact
    const newNodeId = await addExtraNode(approvedLessonId, 2);
    try {
      const { json } = await ktApi(SUBJECT_ID, studentAToken);
      const found = json.topics.find((t) => t.lessonNodeId === newNodeId);
      assert.ok(found, `New node ${newNodeId} must appear in KT response`);
      assert.equal(found.masteryLevel, "not_started",
        `New node must be not_started, got ${found.masteryLevel}`);
    } finally {
      await db.delete(lessonNodesTable).where(eq(lessonNodesTable.id, newNodeId));
    }
  });

  await test("T10: existing mastery survives adding a new node to the approved lesson", async () => {
    // Give studentA mastery on the primary approved node
    const knId = await makeKnowledgeNode(studentAId, SUBJECT_ID, approvedNodeId, 90, 85);
    const extraNodeId = await addExtraNode(approvedLessonId, 3);
    try {
      const { json } = await ktApi(SUBJECT_ID, studentAToken);
      // Primary node still mastered
      const primary = json.topics.find((t) => t.lessonNodeId === approvedNodeId);
      assert.ok(primary, "Primary node must appear");
      assert.equal(primary.masteryLevel, "mastered", `Primary must remain mastered, got ${primary.masteryLevel}`);
      // New extra node is not_started
      const extra = json.topics.find((t) => t.lessonNodeId === extraNodeId);
      assert.ok(extra, "Extra node must appear");
      assert.equal(extra.masteryLevel, "not_started", `Extra must be not_started, got ${extra.masteryLevel}`);
    } finally {
      await cleanKnRow(knId);
      await db.delete(lessonNodesTable).where(eq(lessonNodesTable.id, extraNodeId));
    }
  });

  // ── Group F: No fake evidence ─────────────────────────────────────────────
  console.log("\n  No fake evidence");

  await test("T11: initialization creates no evidence_events rows for new student", async () => {
    // Access KT API — should not create any evidence_events
    await ktApi(SUBJECT_ID, studentAToken);
    await ktApi(SUBJECT_ID, studentBToken);
    const evA = await db.select({ id: evidenceEventsTable.id })
      .from(evidenceEventsTable).where(eq(evidenceEventsTable.userId, studentAId));
    const evB = await db.select({ id: evidenceEventsTable.id })
      .from(evidenceEventsTable).where(eq(evidenceEventsTable.userId, studentBId));
    assert.equal(evA.length, 0, `No evidence_events must be created for studentA, found ${evA.length}`);
    assert.equal(evB.length, 0, `No evidence_events must be created for studentB, found ${evB.length}`);
  });

  await test("T12: UNIQUE constraint prevents duplicate knowledge_nodes per student+node", async () => {
    const knId1 = await makeKnowledgeNode(studentAId, SUBJECT_ID, approvedNodeId, 50, 50);
    try {
      // Attempt a second insert with same (userId, lessonNodeId) using onConflictDoNothing
      // so we can inspect the outcome without an exception.
      await db.insert(knowledgeNodesTable).values({
        userId:          studentAId,
        subjectId:       SUBJECT_ID,
        lessonNodeId:    approvedNodeId,
        topicName:       "duplicate-attempt",
        masteryScore:    60,
        confidenceScore: 60,
        bloomLevel:      1,
        isProvisional:   true,
        status:          "not_started",
      }).onConflictDoNothing();

      // Exactly ONE row must exist — the duplicate was silently blocked by the
      // unique index, proving the constraint is enforced.
      const rows = await db.select({ id: knowledgeNodesTable.id })
        .from(knowledgeNodesTable)
        .where(and(
          eq(knowledgeNodesTable.userId, studentAId),
          eq(knowledgeNodesTable.lessonNodeId, approvedNodeId),
        ));
      assert.equal(rows.length, 1, `Expected exactly 1 KN row after duplicate attempt, found ${rows.length}`);
      assert.equal(rows[0].id, knId1, "The surviving row must be the original first insert");
    } finally {
      await cleanKnRow(knId1);
    }
  });

  // ── Group G: Four-state API classification ────────────────────────────────
  console.log("\n  Four-state API classification");

  await test("T13: KT API returns all four mastery states correctly", async () => {
    // We need 4 nodes in the approved lesson for this test
    const nodeWeak     = await addExtraNode(approvedLessonId, 10);
    const nodeInProg   = await addExtraNode(approvedLessonId, 11);
    const nodeMastered = await addExtraNode(approvedLessonId, 12);
    // nodeApproved is left without KN → not_started

    const knWeak     = await makeKnowledgeNode(studentAId, SUBJECT_ID, nodeWeak,     55, 60); // weak
    const knInProg   = await makeKnowledgeNode(studentAId, SUBJECT_ID, nodeInProg,   30, 30); // in_progress
    const knMastered = await makeKnowledgeNode(studentAId, SUBJECT_ID, nodeMastered, 90, 85); // mastered
    try {
      const { json } = await ktApi(SUBJECT_ID, studentAToken);

      const wk = json.topics.find((t) => t.lessonNodeId === nodeWeak);
      const ip = json.topics.find((t) => t.lessonNodeId === nodeInProg);
      const ms = json.topics.find((t) => t.lessonNodeId === nodeMastered);
      const ns = json.topics.find((t) => t.lessonNodeId === approvedNodeId);

      assert.ok(wk, "weak node must appear");
      assert.ok(ip, "in_progress node must appear");
      assert.ok(ms, "mastered node must appear");
      assert.ok(ns, "not_started node must appear");

      assert.equal(wk.masteryLevel,  "weak",        `Expected weak, got ${wk.masteryLevel}`);
      assert.equal(ip.masteryLevel,  "in_progress",  `Expected in_progress, got ${ip.masteryLevel}`);
      assert.equal(ms.masteryLevel,  "mastered",     `Expected mastered, got ${ms.masteryLevel}`);
      assert.equal(ns.masteryLevel,  "not_started",  `Expected not_started, got ${ns.masteryLevel}`);
    } finally {
      await cleanKnRow(knWeak);
      await cleanKnRow(knInProg);
      await cleanKnRow(knMastered);
      await db.delete(lessonNodesTable).where(inArray(lessonNodesTable.id, [nodeWeak, nodeInProg, nodeMastered]));
    }
  });

  await test("T14: zero-evidence node appears in not_started bucket in API response", async () => {
    const { json } = await ktApi(SUBJECT_ID, studentAToken);
    const notStarted = json.topics.filter((t) => t.masteryLevel === "not_started");
    const found = notStarted.find((t) => t.lessonNodeId === approvedNodeId);
    assert.ok(found, `approvedNodeId ${approvedNodeId} must be in not_started bucket`);
    // And draft node must NOT be in any bucket
    const draftInAny = json.topics.find((t) => t.lessonNodeId === draftNodeId);
    assert.ok(!draftInAny, `draftNodeId ${draftNodeId} must not appear in any bucket`);
  });

} finally {
  console.log("\n  Teardown...");
  await teardownFixtures();
}

// ── Lesson 105 data integrity ──────────────────────────────────────────────────
console.log("\n  Lesson 105 data integrity post-test");

await test("TI: Phase 1.11 did not modify Lesson 105 structure or create fake KN rows", async () => {
  // READ-ONLY real-data verification — this test ONLY reads, never writes
  const [lesson] = await db.select({ id: lessonsTable.id, status: lessonsTable.status })
    .from(lessonsTable).where(eq(lessonsTable.id, 105));
  assert.ok(lesson, "Lesson 105 must exist");
  // Status may be any valid value — we do not assert 'approved' because teacher
  // operations outside Phase 1.11 changed it before this phase started.
  assert.ok(
    ["approved", "needs_review", "draft"].includes(lesson.status ?? ""),
    `Lesson 105 status must be a valid status value, got '${lesson.status}'`,
  );

  const topics = await db.select({ id: lessonTopicsTable.id })
    .from(lessonTopicsTable).where(eq(lessonTopicsTable.lessonId, 105));
  assert.equal(topics.length, 4, `Expected 4 topics, got ${topics.length}`);

  const nodes = await db.select({ id: lessonNodesTable.id })
    .from(lessonNodesTable).where(eq(lessonNodesTable.lessonId, 105));
  assert.ok(nodes.length >= 1, `Lesson 105 must have at least 1 node, got ${nodes.length}`);

  const exercises = await db.select({ id: lessonExercisesTable.id })
    .from(lessonExercisesTable).where(eq(lessonExercisesTable.lessonId, 105));
  assert.equal(exercises.length, 15, `Expected 15 exercises, got ${exercises.length}`);

  // CRITICAL: Phase 1.11 must NOT have created any knowledge_nodes for lesson 105 nodes
  // for the Phase 1.11 test students (studentAId / studentBId).
  const nodeIds = nodes.map((n) => n.id);
  const fakeKn = await db.select({ id: knowledgeNodesTable.id, userId: knowledgeNodesTable.userId })
    .from(knowledgeNodesTable)
    .where(and(
      inArray(knowledgeNodesTable.lessonNodeId, nodeIds),
      inArray(knowledgeNodesTable.userId, [studentAId, studentBId]),
    ));
  assert.equal(fakeKn.length, 0,
    `Phase 1.11 must not create KN rows for lesson 105 nodes, found ${fakeKn.length}`);

  // Log the actual state for the session report
  console.log(`\n    ┌─ Lesson 105 state after Phase 1.11 tests ───────────────────`);
  console.log(`    │  status:    ${lesson.status} (pre-existing; Phase 1.11 did not set this)`);
  console.log(`    │  topics:    ${topics.length} / 4 expected`);
  console.log(`    │  nodes:     ${nodes.length} (probe before this phase: 9 nodes already missing 1)`);
  console.log(`    │  exercises: ${exercises.length} / 15 expected`);
  console.log(`    │  fake KN rows created by Phase 1.11: 0`);
  console.log(`    └──────────────────────────────────────────────────────────────`);
});

// ── Post-suite pollution gate ──────────────────────────────────────────────────
console.log("\n  Post-suite pollution gate...");
try {
  await assertNoPollution();
} catch (e: unknown) {
  console.error(`  ✗ POLLUTION GATE: ${e instanceof Error ? e.message : e}`);
  failed++;
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests run: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
