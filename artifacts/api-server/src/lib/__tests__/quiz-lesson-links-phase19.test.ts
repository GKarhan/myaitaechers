/**
 * Phase 1.9 — Quiz ↔ Lesson Relationship Tests
 * 12 required test cases from spec §18.
 * Uses real DB + real API. All test fixtures are cleaned up in finally blocks.
 *
 * Runner: pnpm --filter @workspace/api-server run test:phase19-quiz-links
 */

import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { db, quizzesTable, quizLessonLinksTable, lessonsTable, lessonNodesTable } from "@workspace/db";
import { eq, and, inArray, like } from "drizzle-orm";
import { makeRunId, runTag } from "./helpers/run-id.js";

// ── Run ID (unique per invocation — used to tag all fixtures) ──────────────────
const RUN_ID = makeRunId();

// ── harness ────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e: unknown) { console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`); failed++; }
}

// ── API helpers ────────────────────────────────────────────────────────────────
const BASE   = "http://localhost:8080/api";
const SECRET = process.env.SESSION_SECRET ?? "myaiteacher-secret";

function makeToken(userId: number, role: "teacher" | "student" = "teacher") {
  return jwt.sign({ userId, role }, SECRET, { expiresIn: "1h" });
}

const TEACHER_TOKEN = makeToken(161); // existing teacher (id=161, owns quiz 27)
const OTHER_TOKEN   = makeToken(999); // non-existent teacher — for auth rejection test

async function api(method: string, path: string, body?: unknown, token = TEACHER_TOKEN) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

// ── DB helpers ─────────────────────────────────────────────────────────────────
async function makeTestLesson(): Promise<number> {
  const [l] = await db.insert(lessonsTable).values({
    title: runTag(RUN_ID, "p19_lesson"),
    subjectId: 18,
    status: "draft",
  }).returning({ id: lessonsTable.id });
  // Add one node so quiz creation (lessonIds path) can resolve nodes
  await db.insert(lessonNodesTable).values({
    lessonId: l.id, sequence: 1, title: "Test node", createdBy: "teacher",
  });
  return l.id;
}

async function cleanLesson(lessonId: number) {
  await db.delete(lessonNodesTable).where(eq(lessonNodesTable.lessonId, lessonId));
  await db.delete(lessonsTable).where(eq(lessonsTable.id, lessonId));
}

async function cleanQuiz(quizId: number) {
  await db.delete(quizzesTable).where(eq(quizzesTable.id, quizId));
}

async function insertTestQuiz(opts: {
  teacherId: number; subjectId: number; quizType?: string | null;
}): Promise<number> {
  const [q] = await db.insert(quizzesTable).values({
    teacherId:     opts.teacherId,
    subjectId:     opts.subjectId,
    title:         runTag(RUN_ID, "p19_quiz"),
    questionCount: 5,
    status:        "GENERATED",
    nodeIds:       [],
    quizType:      opts.quizType ?? null,
  }).returning({ id: quizzesTable.id });
  return q.id;
}

async function getLinks(quizId: number) {
  return db.select().from(quizLessonLinksTable).where(eq(quizLessonLinksTable.quizId, quizId));
}

// ── Pre-cleanup: remove stale fixtures from prior crashed runs ─────────────────
console.log("\nPhase 1.9 — Quiz ↔ Lesson Relationship Model\n");
console.log(`[run-id] ${RUN_ID}`);

try {
  const prefix = `${RUN_ID}_`;
  const staleQuizzes = await db
    .select({ id: quizzesTable.id })
    .from(quizzesTable)
    .where(like(quizzesTable.title, `${prefix}%`));
  if (staleQuizzes.length > 0) {
    await db.delete(quizzesTable).where(inArray(quizzesTable.id, staleQuizzes.map(q => q.id)));
    console.log(`[pre-cleanup] Removed ${staleQuizzes.length} stale quiz(zes) from prior run`);
  }
  const staleLessons = await db
    .select({ id: lessonsTable.id })
    .from(lessonsTable)
    .where(like(lessonsTable.title, `${prefix}%`));
  if (staleLessons.length > 0) {
    for (const l of staleLessons) {
      await db.delete(lessonNodesTable).where(eq(lessonNodesTable.lessonId, l.id));
    }
    await db.delete(lessonsTable).where(inArray(lessonsTable.id, staleLessons.map(l => l.id)));
    console.log(`[pre-cleanup] Removed ${staleLessons.length} stale lesson(s) from prior run`);
  }
} catch {
  // pre-cleanup failure must not abort the test suite
}

// T01: Lesson Test links to exactly one lesson
await test("T01: lesson quiz links to exactly one Lesson", async () => {
  const lessonId = await makeTestLesson();
  const quizId   = await insertTestQuiz({ teacherId: 161, subjectId: 18, quizType: "lesson" });
  try {
    // Link to first lesson
    const r1 = await api("POST", `/quizzes/${quizId}/lessons/${lessonId}`);
    assert.equal(r1.status, 200);
    const links = await getLinks(quizId);
    assert.equal(links.length, 1);
    assert.equal(links[0].lessonId, lessonId);

    // Try to link to a second lesson → must fail (Lesson Test constraint)
    const secondLesson = await makeTestLesson();
    try {
      const r2 = await api("POST", `/quizzes/${quizId}/lessons/${secondLesson}`);
      assert.equal(r2.status, 400, "Linking Lesson Test to 2nd lesson must return 400");
    } finally {
      await cleanLesson(secondLesson);
    }
  } finally {
    await cleanQuiz(quizId);
    await cleanLesson(lessonId);
  }
});

// T02: Summary Test links to multiple lessons
await test("T02: summary quiz links to multiple Lessons", async () => {
  const la = await makeTestLesson();
  const lb = await makeTestLesson();
  const quizId = await insertTestQuiz({ teacherId: 161, subjectId: 18, quizType: "summary" });
  try {
    const r1 = await api("POST", `/quizzes/${quizId}/lessons/${la}`);
    assert.equal(r1.status, 200);
    const r2 = await api("POST", `/quizzes/${quizId}/lessons/${lb}`);
    assert.equal(r2.status, 200);

    const links = await getLinks(quizId);
    assert.equal(links.length, 2);
    const linked = new Set(links.map((l) => l.lessonId));
    assert.ok(linked.has(la) && linked.has(lb));
  } finally {
    await cleanQuiz(quizId);
    await cleanLesson(la);
    await cleanLesson(lb);
  }
});

// T03: Duplicate relationship prevented
await test("T03: duplicate (quizId, lessonId) relationship prevented", async () => {
  const lessonId = await makeTestLesson();
  const quizId   = await insertTestQuiz({ teacherId: 161, subjectId: 18, quizType: "summary" });
  try {
    await api("POST", `/quizzes/${quizId}/lessons/${lessonId}`);
    await api("POST", `/quizzes/${quizId}/lessons/${lessonId}`); // second identical call
    const links = await getLinks(quizId);
    assert.equal(links.length, 1, `Expected 1 link, got ${links.length}`);
  } finally {
    await cleanQuiz(quizId);
    await cleanLesson(lessonId);
  }
});

// T04: Same quiz ID appears from both lesson and global queries
await test("T04: same quiz ID from lesson view and global query", async () => {
  const lessonId = await makeTestLesson();
  const quizId   = await insertTestQuiz({ teacherId: 161, subjectId: 18, quizType: "lesson" });
  try {
    await api("POST", `/quizzes/${quizId}/lessons/${lessonId}`);

    // Lesson view
    const lessonR = await api("GET", `/lessons/${lessonId}/quizzes`);
    assert.equal(lessonR.status, 200);
    const lessonQuizzes = lessonR.json as Array<{ id: number }>;
    assert.ok(lessonQuizzes.some((q) => q.id === quizId), "Quiz not in lesson view");

    // Global view (GET /quizzes?subjectId=18 — teacher-owned)
    const globalR = await api("GET", `/quizzes?subjectId=18`);
    assert.equal(globalR.status, 200);
    const globalQuizzes = globalR.json as Array<{ id: number }>;
    assert.ok(globalQuizzes.some((q) => q.id === quizId), "Quiz not in global view");

    // IDs match
    const inLesson = lessonQuizzes.find((q) => q.id === quizId)!;
    const inGlobal = globalQuizzes.find((q) => q.id === quizId)!;
    assert.equal(inLesson.id, inGlobal.id, "ID mismatch between lesson and global views");
  } finally {
    await cleanQuiz(quizId);
    await cleanLesson(lessonId);
  }
});

// T05: Unlink does NOT delete the quiz
await test("T05: unlink removes relationship but quiz record remains", async () => {
  const lessonId = await makeTestLesson();
  const quizId   = await insertTestQuiz({ teacherId: 161, subjectId: 18, quizType: "lesson" });
  try {
    await api("POST",   `/quizzes/${quizId}/lessons/${lessonId}`);
    const beforeLinks = await getLinks(quizId);
    assert.equal(beforeLinks.length, 1);

    await api("DELETE", `/quizzes/${quizId}/lessons/${lessonId}`);
    const afterLinks = await getLinks(quizId);
    assert.equal(afterLinks.length, 0, "Link was not removed");

    // Quiz must still exist
    const [quiz] = await db.select({ id: quizzesTable.id }).from(quizzesTable).where(eq(quizzesTable.id, quizId));
    assert.ok(quiz, "Quiz was deleted when only the link should have been removed");
  } finally {
    await cleanQuiz(quizId);
    await cleanLesson(lessonId);
  }
});

// T06: Deleting a quiz removes its relationships (FK cascade)
await test("T06: deleting quiz cascades to remove lesson links", async () => {
  const lessonId = await makeTestLesson();
  const quizId   = await insertTestQuiz({ teacherId: 161, subjectId: 18, quizType: "summary" });
  try {
    await api("POST", `/quizzes/${quizId}/lessons/${lessonId}`);
    const before = await getLinks(quizId);
    assert.equal(before.length, 1);

    // Delete quiz via API
    const delR = await api("DELETE", `/quizzes/${quizId}`);
    assert.equal(delR.status, 204);

    // Links must be gone (cascade)
    const after = await getLinks(quizId);
    assert.equal(after.length, 0, "Links remain after quiz deletion");
  } finally {
    // Quiz already deleted; just clean lesson
    await cleanLesson(lessonId);
  }
});

// T07: Deleting one lesson does NOT delete a multi-lesson Summary quiz
await test("T07: deleting one lesson does not delete multi-lesson summary quiz", async () => {
  const la = await makeTestLesson();
  const lb = await makeTestLesson();
  const quizId = await insertTestQuiz({ teacherId: 161, subjectId: 18, quizType: "summary" });
  try {
    await db.insert(quizLessonLinksTable).values([
      { quizId, lessonId: la },
      { quizId, lessonId: lb },
    ]).onConflictDoNothing();

    // Delete lesson A (cascade removes its link only)
    await db.delete(lessonNodesTable).where(eq(lessonNodesTable.lessonId, la));
    await db.delete(lessonsTable).where(eq(lessonsTable.id, la));

    // Quiz must still exist
    const [quiz] = await db.select({ id: quizzesTable.id }).from(quizzesTable).where(eq(quizzesTable.id, quizId));
    assert.ok(quiz, "Quiz was deleted when lesson A was deleted — must not cascade to quiz");

    // Link to Lesson B must survive
    const remaining = await getLinks(quizId);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].lessonId, lb);
  } finally {
    await cleanQuiz(quizId);
    await cleanLesson(lb);
  }
});

// T08: Invalid lesson ID rejected
await test("T08: invalid lesson ID rejected", async () => {
  const quizId = await insertTestQuiz({ teacherId: 161, subjectId: 18 });
  try {
    const r = await api("POST", `/quizzes/${quizId}/lessons/999999`);
    assert.equal(r.status, 400, `Expected 400 for invalid lessonId, got ${r.status}`);
  } finally {
    await cleanQuiz(quizId);
  }
});

// T09: Unauthorized link rejected (other teacher cannot link)
await test("T09: teacher cannot link another teacher's quiz", async () => {
  const lessonId = await makeTestLesson();
  const quizId   = await insertTestQuiz({ teacherId: 161, subjectId: 18 });
  try {
    // OTHER_TOKEN uses userId=999 which doesn't own this quiz
    const r = await api("POST", `/quizzes/${quizId}/lessons/${lessonId}`, undefined, OTHER_TOKEN);
    assert.equal(r.status, 404, `Expected 404 for unauthorized link, got ${r.status}`);
  } finally {
    await cleanQuiz(quizId);
    await cleanLesson(lessonId);
  }
});

// T10: Node-scoped lesson quiz has exactly one Lesson relationship
await test("T10: node-scoped lesson quiz has exactly one Lesson relationship", async () => {
  const lessonId = await makeTestLesson();
  const quizId   = await insertTestQuiz({ teacherId: 161, subjectId: 18, quizType: "lesson" });
  try {
    await api("POST", `/quizzes/${quizId}/lessons/${lessonId}`);

    const links = await getLinks(quizId);
    assert.equal(links.length, 1);
    assert.equal(links[0].lessonId, lessonId);

    // GET /lessons/:id/quizzes returns it with correct type
    const r = await api("GET", `/lessons/${lessonId}/quizzes`);
    assert.equal(r.status, 200);
    const list = r.json as Array<{ id: number; quizType: string | null }>;
    const q = list.find((x) => x.id === quizId);
    assert.ok(q, "Quiz not found in lesson view");
    assert.equal(q!.quizType, "lesson");
  } finally {
    await cleanQuiz(quizId);
    await cleanLesson(lessonId);
  }
});

// T11: Relationship read returns correct type
await test("T11: GET /lessons/:id/quizzes returns correct quizType for each quiz", async () => {
  const lessonId = await makeTestLesson();
  const qLesson  = await insertTestQuiz({ teacherId: 161, subjectId: 18, quizType: "lesson"  });
  const qSummary = await insertTestQuiz({ teacherId: 161, subjectId: 18, quizType: "summary" });
  const qLegacy  = await insertTestQuiz({ teacherId: 161, subjectId: 18, quizType: null      }); // legacy
  try {
    await db.insert(quizLessonLinksTable).values([
      { quizId: qLesson,  lessonId },
      { quizId: qSummary, lessonId },
      { quizId: qLegacy,  lessonId },
    ]).onConflictDoNothing();

    const r = await api("GET", `/lessons/${lessonId}/quizzes`);
    assert.equal(r.status, 200);
    const list = r.json as Array<{ id: number; quizType: string | null }>;
    assert.equal(list.length, 3);

    const byId = new Map(list.map((q) => [q.id, q]));
    assert.equal(byId.get(qLesson)?.quizType,  "lesson");
    assert.equal(byId.get(qSummary)?.quizType, "summary");
    assert.equal(byId.get(qLegacy)?.quizType,  null);
  } finally {
    await cleanQuiz(qLesson);
    await cleanQuiz(qSummary);
    await cleanQuiz(qLegacy);
    await cleanLesson(lessonId);
  }
});

// T12: Global query does NOT duplicate summary quiz rows from multi-lesson joins
await test("T12: global quiz list does not duplicate summary quiz linked to multiple lessons", async () => {
  const la = await makeTestLesson();
  const lb = await makeTestLesson();
  const quizId = await insertTestQuiz({ teacherId: 161, subjectId: 18, quizType: "summary" });
  try {
    await db.insert(quizLessonLinksTable).values([
      { quizId, lessonId: la },
      { quizId, lessonId: lb },
    ]).onConflictDoNothing();

    const r = await api("GET", `/quizzes?subjectId=18`);
    assert.equal(r.status, 200);
    const list = r.json as Array<{ id: number }>;
    const occurrences = list.filter((q) => q.id === quizId).length;
    assert.equal(occurrences, 1, `Quiz appears ${occurrences} times in global list — must appear exactly once`);
  } finally {
    await cleanQuiz(quizId);
    await cleanLesson(la);
    await cleanLesson(lb);
  }
});

// ── Post-pollution gate ────────────────────────────────────────────────────────
// Verify that no quiz or lesson records tagged with this RUN_ID remain.
console.log("\n[post-pollution gate]");
{
  const prefix = `${RUN_ID}_`;
  const remainingQuizzes = await db
    .select({ id: quizzesTable.id, title: quizzesTable.title })
    .from(quizzesTable)
    .where(like(quizzesTable.title, `${prefix}%`));
  const remainingLessons = await db
    .select({ id: lessonsTable.id, title: lessonsTable.title })
    .from(lessonsTable)
    .where(like(lessonsTable.title, `${prefix}%`));

  if (remainingQuizzes.length > 0) {
    console.error(`  ✗ POLLUTION: ${remainingQuizzes.length} quiz(zes) not cleaned up:`, remainingQuizzes.map(q => q.id));
    failed++;
  } else {
    console.log("  ✓ No quiz pollution");
  }
  if (remainingLessons.length > 0) {
    console.error(`  ✗ POLLUTION: ${remainingLessons.length} lesson(s) not cleaned up:`, remainingLessons.map(l => l.id));
    failed++;
  } else {
    console.log("  ✓ No lesson pollution");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n  ${passed + failed} tests — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
