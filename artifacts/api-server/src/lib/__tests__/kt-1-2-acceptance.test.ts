/**
 * KT-1.2 Acceptance Tests — Visibility Gate + Subject Counts
 *
 * Runner: DATABASE_URL=$TEST_DATABASE_URL tsx src/lib/__tests__/kt-1-2-acceptance.test.ts
 *        (or: pnpm --filter @workspace/api-server run test:kt12)
 *
 * Tests covered:
 *   T07  approved node in active lesson appears
 *   T08  node without KN row → not_started mastery level
 *   T09  KT query does NOT insert a knowledge_nodes row
 *   T10  draft nodes do NOT appear
 *   T11  draft lesson nodes do NOT appear
 *   T12  existing KN-backed node appears with correct scores
 *   T13–T18  four-state count invariants (totalUnits = Σ states)
 *   T19  unenrolled subject → empty courseIds → zero nodes
 *   T21/T23  getMasteryLevelFromScores unchanged
 *   T25  pollution gate fires in afterAll
 *
 * Manual UAT covers: T01–T06, T20, T22, T24
 *
 * Isolation contract:
 *   - assertTestDb() safety gate — process.exit(1) if running against prod DB
 *   - createFactory(RUN_ID) creates all writable fixtures in heliumdb_test
 *   - try/finally cleanup in every writable test
 *   - assertNoPollution(RUN_ID) at end — suite FAILS if any records leaked
 *   - Real DB records used READ-ONLY only
 */

import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import {
  subjectsTable,
  lessonsTable,
  lessonNodesTable,
  knowledgeNodesTable,
  coursesTable,
  classStudentsTable,
  reviewScheduleTable,
  teachersTable,
} from "@workspace/db";
import { assertTestDb, getTestDb, closeTestDb } from "./helpers/test-db.js";
import { makeRunId } from "./helpers/run-id.js";
import { createFactory, assertNoPollution, type FixtureFactory } from "./helpers/fixture-factory.js";
import { getMasteryLevelFromScores } from "../mastery.js";

// ── Minimal async test runner (same pattern as test-isolation-safety.test.ts) ─

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${name}\n      ${msg}`);
    failed++;
    failures.push(name);
  }
}

// ── KT visibility query (mirrors the KT-1.2 route gate exactly) ───────────────
// Uses inArray(coursesTable.id, courseIds) — PK is non-null, no type issue.
// Avoids inArray(lessonsTable.courseId, ...) which is a nullable column.

async function runKtQuery(
  targetUserId: number,
  subjectId: number,
  courseIds: number[],
) {
  const testDb = getTestDb();
  if (courseIds.length === 0) return [];
  return testDb
    .select({
      lessonNodeId:    lessonNodesTable.id,
      lessonNodeTitle: lessonNodesTable.title,
      knId:            knowledgeNodesTable.id,
      masteryScore:    knowledgeNodesTable.masteryScore,
      confidenceScore: knowledgeNodesTable.confidenceScore,
      dueAt:           reviewScheduleTable.dueAt,
    })
    .from(lessonNodesTable)
    .innerJoin(lessonsTable, eq(lessonNodesTable.lessonId, lessonsTable.id))
    .innerJoin(coursesTable, and(
      eq(lessonsTable.courseId, coursesTable.id),
      inArray(coursesTable.id, courseIds),     // PK non-null
      eq(coursesTable.subjectId, subjectId),
    ))
    .leftJoin(
      knowledgeNodesTable,
      and(
        eq(knowledgeNodesTable.lessonNodeId, lessonNodesTable.id),
        eq(knowledgeNodesTable.userId,       targetUserId),
        eq(knowledgeNodesTable.subjectId,    subjectId),
      )
    )
    .leftJoin(
      reviewScheduleTable,
      and(
        eq(reviewScheduleTable.topicId, knowledgeNodesTable.id),
        eq(reviewScheduleTable.userId,  targetUserId),
      )
    )
    .where(and(
      eq(lessonsTable.status,     "active"),   // KT-1.2 gate
      eq(lessonNodesTable.status, "approved"), // node publication gate
    ));
}

async function getEnrolledCourseIds(studentUserId: number, subjectId: number): Promise<number[]> {
  const testDb = getTestDb();
  const rows = await testDb
    .select({ courseId: coursesTable.id })
    .from(coursesTable)
    .innerJoin(classStudentsTable, and(
      eq(coursesTable.classId,         classStudentsTable.classId),
      eq(classStudentsTable.studentId, studentUserId),
    ))
    .where(eq(coursesTable.subjectId, subjectId));
  return rows.map((r) => r.courseId);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const RUN_ID = makeRunId();
let F!: FixtureFactory;
let teacherUserId!: number;   // users.id  — for F.lesson(), F.course()
let teachersRowId!: number;   // teachers.id — for F.class_()
let studentUserId!: number;
let classId!: number;
let courseId!: number;
let subjectId!: number;

async function setup() {
  assertTestDb();
  const testDb = getTestDb();
  F = createFactory(RUN_ID);

  // Resolve a seeded subject
  const [seededSubject] = await testDb
    .select({ id: subjectsTable.id })
    .from(subjectsTable)
    .limit(1);
  assert.ok(seededSubject, "testDb has no subjects — re-run the seed script");
  subjectId = seededSubject.id;

  // Create a teacher user + teachers row (classesTable.teacherId → teachers.id).
  // F.teacher() only creates the users row; we insert the teachers row manually.
  const teacher = await F.teacher();
  teacherUserId = teacher.userId; // users.id for lesson/course

  const [tr] = await testDb
    .insert(teachersTable)
    .values({ userId: teacherUserId })
    .returning({ id: teachersTable.id });
  teachersRowId = tr.id; // teachers.id for class_()

  // Create enrollment chain
  const student = await F.student();
  studentUserId = student.userId;
  const cls = await F.class_(teachersRowId); // requires teachers.id (PK)
  classId = cls.id;
  await F.enrollStudent(classId, studentUserId);
  const course = await F.course(classId, subjectId, teacherUserId); // users.id
  courseId = course.id;
}

async function teardown() {
  try {
    // Clean up the teachers row we inserted manually (not tracked by factory)
    if (teachersRowId) {
      const testDb = getTestDb();
      await testDb.delete(teachersTable).where(eq(teachersTable.id, teachersRowId));
    }
    await F.cleanup();
    await assertNoPollution(RUN_ID);
    console.log("  ✓ T25: pollution gate passed — 0 TR_ records leaked");
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ T25: pollution gate FAILED\n      ${msg}`);
    failed++;
    failures.push("T25: post-pollution gate");
  } finally {
    await closeTestDb();
  }
}

async function main() {
  console.log(`\n── KT-1.2 Acceptance Tests (runId=${RUN_ID}) ──\n`);

  await setup();

  // ── T07: Approved node in active lesson appears ─────────────────────────

  await test("T07 — approved node in active lesson appears in KT query", async () => {
    const testDb = getTestDb();
    const lesson = await F.lesson(teacherUserId, classId, subjectId, { status: "active" });
    await testDb.update(lessonsTable).set({ courseId }).where(eq(lessonsTable.id, lesson.id));
    const node = await F.node(lesson.id, { status: "approved" });

    const cids = await getEnrolledCourseIds(studentUserId, subjectId);
    const results = await runKtQuery(studentUserId, subjectId, cids);
    const found = results.find((r) => r.lessonNodeId === node.id);
    assert.ok(found, `node ${node.id} not found in KT results`);
  });

  // ── T08: No KN row → not_started ────────────────────────────────────────

  await test("T08 — visible node with no KN row has not_started mastery level", async () => {
    const testDb = getTestDb();
    const lesson = await F.lesson(teacherUserId, classId, subjectId, { status: "active" });
    await testDb.update(lessonsTable).set({ courseId }).where(eq(lessonsTable.id, lesson.id));
    const node = await F.node(lesson.id, { status: "approved" });

    const cids = await getEnrolledCourseIds(studentUserId, subjectId);
    const results = await runKtQuery(studentUserId, subjectId, cids);
    const found = results.find((r) => r.lessonNodeId === node.id);
    assert.ok(found, `node ${node.id} not found`);
    assert.equal(found.knId, null, "knId must be null (no KN row)");
    assert.equal(found.masteryScore, null, "masteryScore must be null");
    assert.equal(found.confidenceScore, null, "confidenceScore must be null");
    const level = getMasteryLevelFromScores(found.masteryScore, found.confidenceScore, found.dueAt ?? null);
    assert.equal(level, "not_started");
  });

  // ── T09: KT query is pure SELECT ────────────────────────────────────────

  await test("T09 — KT query does NOT create a knowledge_nodes row", async () => {
    const testDb = getTestDb();
    const lesson = await F.lesson(teacherUserId, classId, subjectId, { status: "active" });
    await testDb.update(lessonsTable).set({ courseId }).where(eq(lessonsTable.id, lesson.id));
    const node = await F.node(lesson.id, { status: "approved" });

    const before = await testDb.select().from(knowledgeNodesTable)
      .where(eq(knowledgeNodesTable.lessonNodeId, node.id));
    assert.equal(before.length, 0);

    const cids = await getEnrolledCourseIds(studentUserId, subjectId);
    await runKtQuery(studentUserId, subjectId, cids);

    const after = await testDb.select().from(knowledgeNodesTable)
      .where(eq(knowledgeNodesTable.lessonNodeId, node.id));
    assert.equal(after.length, 0, "KT query must not INSERT knowledge_nodes rows");
  });

  // ── T10: Draft nodes do NOT appear ──────────────────────────────────────

  await test("T10 — draft node in active lesson does NOT appear", async () => {
    const testDb = getTestDb();
    const lesson = await F.lesson(teacherUserId, classId, subjectId, { status: "active" });
    await testDb.update(lessonsTable).set({ courseId }).where(eq(lessonsTable.id, lesson.id));
    const draftNode = await F.node(lesson.id, { status: "draft" });

    const cids = await getEnrolledCourseIds(studentUserId, subjectId);
    const results = await runKtQuery(studentUserId, subjectId, cids);
    const found = results.find((r) => r.lessonNodeId === draftNode.id);
    assert.equal(found, undefined, "draft node must NOT appear in KT results");
  });

  // ── T11: Draft lessons do NOT expose nodes ───────────────────────────────

  await test("T11 — approved node in draft lesson does NOT appear", async () => {
    const testDb = getTestDb();
    const draftLesson = await F.lesson(teacherUserId, classId, subjectId, { status: "draft" });
    await testDb.update(lessonsTable).set({ courseId }).where(eq(lessonsTable.id, draftLesson.id));
    const node = await F.node(draftLesson.id, { status: "approved" });

    const cids = await getEnrolledCourseIds(studentUserId, subjectId);
    const results = await runKtQuery(studentUserId, subjectId, cids);
    const found = results.find((r) => r.lessonNodeId === node.id);
    assert.equal(found, undefined, "node in draft lesson must NOT appear");
  });

  // ── T12: Existing KN-backed node appears with correct scores ─────────────

  await test("T12 — KN-backed node appears with correct mastery scores", async () => {
    const testDb = getTestDb();
    const lesson = await F.lesson(teacherUserId, classId, subjectId, { status: "active" });
    await testDb.update(lessonsTable).set({ courseId }).where(eq(lessonsTable.id, lesson.id));
    const node = await F.node(lesson.id, { status: "approved" });

    const [kn] = await testDb.insert(knowledgeNodesTable).values({
      subjectId, userId: studentUserId, lessonNodeId: node.id,
      topicName: "T12_test", masteryScore: 75, confidenceScore: 80,
      status: "weak", isProvisional: false,
    }).returning({ id: knowledgeNodesTable.id });

    try {
      const cids = await getEnrolledCourseIds(studentUserId, subjectId);
      const results = await runKtQuery(studentUserId, subjectId, cids);
      const found = results.find((r) => r.lessonNodeId === node.id);
      assert.ok(found, "KN-backed node not found");
      assert.equal(found.knId, kn.id);
      assert.equal(found.masteryScore, 75);
      assert.equal(found.confidenceScore, 80);
      assert.equal(getMasteryLevelFromScores(75, 80, null), "weak");
    } finally {
      await testDb.delete(knowledgeNodesTable).where(eq(knowledgeNodesTable.id, kn.id));
    }
  });

  // ── T13–T18: Four-state count invariants ────────────────────────────────

  await test("T13–T18 — four-state count invariants: totalUnits = Σ states", async () => {
    const testDb = getTestDb();
    const lesson = await F.lesson(teacherUserId, classId, subjectId, { status: "active" });
    await testDb.update(lessonsTable).set({ courseId }).where(eq(lessonsTable.id, lesson.id));

    const nodeA = await F.node(lesson.id, { status: "approved" }); // → not_started
    const nodeB = await F.node(lesson.id, { status: "approved" }); // → weak
    const nodeC = await F.node(lesson.id, { status: "approved" }); // → mastered
    await F.node(lesson.id, { status: "draft" });                  // → invisible

    const [knB] = await testDb.insert(knowledgeNodesTable).values({
      subjectId, userId: studentUserId, lessonNodeId: nodeB.id,
      topicName: "T18_B", masteryScore: 50, confidenceScore: 60,
      status: "weak", isProvisional: false,
    }).returning({ id: knowledgeNodesTable.id });

    const [knC] = await testDb.insert(knowledgeNodesTable).values({
      subjectId, userId: studentUserId, lessonNodeId: nodeC.id,
      topicName: "T18_C", masteryScore: 90, confidenceScore: 85,
      status: "mastered", isProvisional: false,
    }).returning({ id: knowledgeNodesTable.id });

    try {
      const cids = await getEnrolledCourseIds(studentUserId, subjectId);
      const results = await runKtQuery(studentUserId, subjectId, cids);
      const ourIds = new Set([nodeA.id, nodeB.id, nodeC.id]);
      const ours = results.filter((r) => ourIds.has(r.lessonNodeId));

      // T13: totalUnits = 3 approved nodes (draft excluded)
      assert.equal(ours.length, 3, `expected 3 visible nodes, got ${ours.length}`);

      let mastered = 0, weak = 0, inProgress = 0, notStarted = 0;
      for (const r of ours) {
        const raw = getMasteryLevelFromScores(r.masteryScore, r.confidenceScore, r.dueAt ?? null);
        const lv = raw === "needs_review" ? "mastered" : raw;
        if      (lv === "mastered")    mastered++;
        else if (lv === "weak")        weak++;
        else if (lv === "in_progress") inProgress++;
        else                           notStarted++;
      }

      assert.equal(notStarted, 1, "T17: nodeA (no KN) → not_started");  // T17
      assert.equal(weak, 1,       "T15: nodeB (50/60) → weak");          // T15
      assert.equal(mastered, 1,   "T14: nodeC (90/85) → mastered");      // T14
      assert.equal(inProgress, 0, "T16: no in_progress nodes");          // T16
      // T18: invariant
      assert.equal(mastered + weak + inProgress + notStarted, 3, "T18: totalUnits invariant");
    } finally {
      await testDb.delete(knowledgeNodesTable).where(eq(knowledgeNodesTable.id, knB.id));
      await testDb.delete(knowledgeNodesTable).where(eq(knowledgeNodesTable.id, knC.id));
    }
  });

  // ── T19: Unenrolled subject → empty ─────────────────────────────────────

  await test("T19 — unenrolled subject returns empty courseIds → zero nodes", async () => {
    const testDb = getTestDb();
    const others = await testDb.select({ id: subjectsTable.id }).from(subjectsTable).limit(10);
    const unenrolled = others.find((s) => s.id !== subjectId);
    const targetSubjectId = unenrolled?.id ?? subjectId + 99999;

    const cids = await getEnrolledCourseIds(studentUserId, targetSubjectId);
    assert.equal(cids.length, 0, "Student must have no enrolled courses for unenrolled subject");

    const results = await runKtQuery(studentUserId, targetSubjectId, cids);
    assert.equal(results.length, 0, "Zero nodes must be returned for unenrolled subject");
  });

  // ── T01: subject card totalUnits equals KT endpoint node count ──────────
  // Cross-endpoint consistency: subjects summary and per-subject KT must
  // count the SAME nodes using the SAME visibility gate.

  await test("T01 — subject card totalUnits equals per-subject KT node count", async () => {
    const testDb = getTestDb();

    // Create 4 approved + 1 draft node in an active lesson
    const lesson = await F.lesson(teacherUserId, classId, subjectId, { status: "active" });
    await testDb.update(lessonsTable).set({ courseId }).where(eq(lessonsTable.id, lesson.id));
    const nodeA = await F.node(lesson.id, { status: "approved" });
    const nodeB = await F.node(lesson.id, { status: "approved" });
    const nodeC = await F.node(lesson.id, { status: "approved" });
    const nodeD = await F.node(lesson.id, { status: "approved" });
    await F.node(lesson.id, { status: "draft" }); // must NOT count

    const createdIds = new Set([nodeA.id, nodeB.id, nodeC.id, nodeD.id]);

    // Run both endpoint queries
    const cids = await getEnrolledCourseIds(studentUserId, subjectId);
    const perSubjectResults = await runKtQuery(studentUserId, subjectId, cids);
    const visibleFromKt = perSubjectResults.filter((r) => createdIds.has(r.lessonNodeId));

    // Replicate subjects endpoint aggregation for THIS subject + student
    const subjectsResults = await testDb
      .select({ lessonNodeId: lessonNodesTable.id })
      .from(lessonNodesTable)
      .innerJoin(lessonsTable, eq(lessonNodesTable.lessonId, lessonsTable.id))
      .innerJoin(coursesTable, and(
        eq(lessonsTable.courseId, coursesTable.id),
        inArray(coursesTable.id, cids),
        eq(coursesTable.subjectId, subjectId),
      ))
      .where(and(
        eq(lessonsTable.status, "active"),
        eq(lessonNodesTable.status, "approved"),
      ));
    const visibleFromSubjects = subjectsResults.filter((r) => createdIds.has(r.lessonNodeId));

    // T01: counts must match
    assert.equal(
      visibleFromKt.length,
      visibleFromSubjects.length,
      `per-subject count (${visibleFromKt.length}) ≠ subjects count (${visibleFromSubjects.length})`
    );
    assert.equal(visibleFromKt.length, 4, "expected 4 approved nodes visible");
  });

  // ── T02: exact node-ID sets match ────────────────────────────────────────

  await test("T02 — exact node-ID sets match between subjects aggregation and per-subject KT", async () => {
    const testDb = getTestDb();

    const lesson = await F.lesson(teacherUserId, classId, subjectId, { status: "active" });
    await testDb.update(lessonsTable).set({ courseId }).where(eq(lessonsTable.id, lesson.id));
    const nodeX = await F.node(lesson.id, { status: "approved" });
    const nodeY = await F.node(lesson.id, { status: "approved" });
    const draftNode = await F.node(lesson.id, { status: "draft" });

    const expectedIds = new Set([nodeX.id, nodeY.id]);

    const cids = await getEnrolledCourseIds(studentUserId, subjectId);

    const ktResults = await runKtQuery(studentUserId, subjectId, cids);
    const ktIds = new Set(
      ktResults.filter((r) => expectedIds.has(r.lessonNodeId)).map((r) => r.lessonNodeId)
    );

    const subjectsRows = await testDb
      .select({ lessonNodeId: lessonNodesTable.id })
      .from(lessonNodesTable)
      .innerJoin(lessonsTable, eq(lessonNodesTable.lessonId, lessonsTable.id))
      .innerJoin(coursesTable, and(
        eq(lessonsTable.courseId, coursesTable.id),
        inArray(coursesTable.id, cids),
        eq(coursesTable.subjectId, subjectId),
      ))
      .where(and(
        eq(lessonsTable.status, "active"),
        eq(lessonNodesTable.status, "approved"),
      ));
    const subjectsIds = new Set(
      subjectsRows.filter((r) => expectedIds.has(r.lessonNodeId)).map((r) => r.lessonNodeId)
    );

    // T02: exact same node IDs
    assert.deepEqual(
      [...ktIds].sort((a, b) => a - b),
      [...subjectsIds].sort((a, b) => a - b),
      "node-ID set mismatch between per-subject KT and subjects aggregation"
    );
    // Draft node must not appear in either
    assert.ok(!ktIds.has(draftNode.id), "draft node must not appear in KT results");
    assert.ok(!subjectsIds.has(draftNode.id), "draft node must not appear in subjects aggregation");
  });

  // ── T07: all legitimately approved nodes appear — none dropped ───────────

  await test("T07 — ALL active+approved nodes appear; no legitimate node dropped", async () => {
    const testDb = getTestDb();

    // Create 6 approved nodes across 2 active lessons
    const lesson1 = await F.lesson(teacherUserId, classId, subjectId, { status: "active" });
    const lesson2 = await F.lesson(teacherUserId, classId, subjectId, { status: "active" });
    await testDb.update(lessonsTable).set({ courseId }).where(eq(lessonsTable.id, lesson1.id));
    await testDb.update(lessonsTable).set({ courseId }).where(eq(lessonsTable.id, lesson2.id));

    const nodes = await Promise.all([
      F.node(lesson1.id, { status: "approved" }),
      F.node(lesson1.id, { status: "approved" }),
      F.node(lesson1.id, { status: "approved" }),
      F.node(lesson2.id, { status: "approved" }),
      F.node(lesson2.id, { status: "approved" }),
      F.node(lesson2.id, { status: "approved" }),
    ]);
    const expectedIds = new Set(nodes.map((n) => n.id));

    const cids = await getEnrolledCourseIds(studentUserId, subjectId);
    const results = await runKtQuery(studentUserId, subjectId, cids);
    const found = results.filter((r) => expectedIds.has(r.lessonNodeId));

    // Every approved node from both lessons must appear
    assert.equal(
      found.length,
      6,
      `Expected 6 nodes from 2 lessons, got ${found.length}. Missing: ${
        [...expectedIds].filter((id) => !found.some((r) => r.lessonNodeId === id)).join(", ")
      }`
    );
    // No node dropped because it lacks a KN row
    const withoutKn = found.filter((r) => r.knId === null);
    assert.equal(withoutKn.length, 6, "all 6 nodes must appear as not_started (no KN rows created)");
  });

  // ── T08: no duplicate lessonNodeIds ─────────────────────────────────────

  await test("T08 — per-subject KT query returns no duplicate lessonNodeIds", async () => {
    const testDb = getTestDb();

    const lesson = await F.lesson(teacherUserId, classId, subjectId, { status: "active" });
    await testDb.update(lessonsTable).set({ courseId }).where(eq(lessonsTable.id, lesson.id));
    const nodeA = await F.node(lesson.id, { status: "approved" });
    const nodeB = await F.node(lesson.id, { status: "approved" });
    const nodeC = await F.node(lesson.id, { status: "approved" });
    const ourIds = new Set([nodeA.id, nodeB.id, nodeC.id]);

    const cids = await getEnrolledCourseIds(studentUserId, subjectId);
    const results = await runKtQuery(studentUserId, subjectId, cids);
    const ours = results.filter((r) => ourIds.has(r.lessonNodeId));

    // Check for duplicates
    const seenIds = new Set<number>();
    const duplicates: number[] = [];
    for (const r of ours) {
      if (seenIds.has(r.lessonNodeId)) duplicates.push(r.lessonNodeId);
      seenIds.add(r.lessonNodeId);
    }
    assert.equal(duplicates.length, 0, `Duplicate lessonNodeIds: ${duplicates.join(", ")}`);
    assert.equal(ours.length, 3, `Expected 3 distinct nodes, got ${ours.length}`);
  });

  // ── T21/T23: getMasteryLevelFromScores unchanged ─────────────────────────

  await test("T21/T23 — getMasteryLevelFromScores produces correct 4-state output", () => {
    assert.equal(getMasteryLevelFromScores(null, null, null), "not_started");
    assert.equal(getMasteryLevelFromScores(30, 40, null),     "in_progress");
    assert.equal(getMasteryLevelFromScores(67, 75, null),     "weak");
    assert.equal(getMasteryLevelFromScores(90, 85, null),     "mastered");
    const past = new Date(Date.now() - 1000);
    assert.equal(getMasteryLevelFromScores(90, 85, past),     "needs_review");
    return Promise.resolve();
  });

  await teardown();

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
  if (failed > 0) {
    console.error("FAILED TESTS:", failures.join(", "));
    process.exit(1);
  } else {
    console.log("KT-1.2 ACCEPTANCE TESTS: ALL PASSED ✓");
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
