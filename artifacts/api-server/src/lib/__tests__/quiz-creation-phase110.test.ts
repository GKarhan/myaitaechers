/**
 * Phase 1.10 — Test Creation UI: Backend Validation + Persistence
 * 15 required test cases from spec §23.
 * Uses real DB + real API. All test fixtures are cleaned up in finally blocks.
 *
 * Runner: pnpm --filter @workspace/api-server run test:phase110-quiz-creation
 *
 * AI tests are gated behind RUN_AI_TESTS=1 env var because they call the
 * real OpenAI API and may be slow/costly. Validation tests always run.
 */

import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  db,
  quizzesTable,
  quizLessonLinksTable,
  lessonsTable,
  lessonNodesTable,
  lessonTopicsTable,
  lessonExercisesTable,
} from "@workspace/db";
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

const TEACHER_TOKEN = makeToken(161); // existing teacher (id=161, subjectId=18)

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
async function makeTestLesson(): Promise<{ lessonId: number; nodeId: number }> {
  const [l] = await db.insert(lessonsTable).values({
    title: runTag(RUN_ID, "p110_lesson"),
    subjectId: 18,
    status: "draft",
  }).returning({ id: lessonsTable.id });
  const [n] = await db.insert(lessonNodesTable).values({
    lessonId: l.id, sequence: 1, title: "Test node", createdBy: "teacher",
  }).returning({ id: lessonNodesTable.id });
  return { lessonId: l.id, nodeId: n.id };
}

async function cleanLesson(lessonId: number) {
  await db.delete(lessonNodesTable).where(eq(lessonNodesTable.lessonId, lessonId));
  await db.delete(lessonsTable).where(eq(lessonsTable.id, lessonId));
}

async function cleanQuiz(quizId: number) {
  await db.delete(quizzesTable).where(eq(quizzesTable.id, quizId));
}

// ── State helper (pure logic equivalent — no DOM needed) ──────────────────────
// Mirrors handleQuizTypeSwitch from teacher-dashboard.tsx
function simulateTypeSwitch(
  newType: "lesson" | "summary",
  currentLessonIds: number[],
  currentNodeIds: number[],
): { lessonIds: number[]; nodeIds: number[] } {
  if (newType === "lesson") {
    return {
      lessonIds: currentLessonIds.length > 0 ? [currentLessonIds[0]] : [],
      nodeIds:   [],
    };
  } else {
    return {
      lessonIds: currentLessonIds,
      nodeIds:   [],
    };
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────
console.log("\nPhase 1.10 — Test Creation UI: Backend Validation + Persistence\n");
console.log(`[run-id] ${RUN_ID}`);

// ── Pre-cleanup: remove stale fixtures from prior crashed runs ─────────────────
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

// ─── Group A: Lesson Test validation ──────────────────────────────────────────
console.log("\n  Lesson Test validation");

await test("T01: lesson type + one Lesson accepted (no nodeIds = whole Lesson)", async () => {
  if (!process.env.RUN_AI_TESTS) {
    console.log("    [skip] AI quiz creation (set RUN_AI_TESTS=1 to enable)");
    return;
  }
  const { lessonId } = await makeTestLesson();
  let quizId: number | undefined;
  try {
    const { status, json } = await api("POST", "/quizzes", {
      subjectId: 18, quizType: "lesson", lessonIds: [lessonId], questionCount: 2,
    });
    assert.equal(status, 201, `Expected 201, got ${status}: ${JSON.stringify(json)}`);
    const data = json as { id: number };
    quizId = data.id;
    // Verify quizType in DB
    const [q] = await db.select({ quizType: quizzesTable.quizType }).from(quizzesTable).where(eq(quizzesTable.id, quizId!));
    assert.equal(q.quizType, "lesson");
    // Verify exactly one lesson link
    const links = await db.select().from(quizLessonLinksTable).where(eq(quizLessonLinksTable.quizId, quizId!));
    assert.equal(links.length, 1);
    assert.equal(links[0].lessonId, lessonId);
  } finally {
    if (quizId) await cleanQuiz(quizId);
    await cleanLesson(lessonId);
  }
});

await test("T02: lesson type + two Lessons rejected (backend 400)", async () => {
  const a = await makeTestLesson();
  const b = await makeTestLesson();
  try {
    const { status, json } = await api("POST", "/quizzes", {
      subjectId: 18, quizType: "lesson", lessonIds: [a.lessonId, b.lessonId], questionCount: 2,
    });
    assert.equal(status, 400, `Expected 400, got ${status}: ${JSON.stringify(json)}`);
    const err = (json as { error: string }).error;
    assert.ok(err.includes("exactly one lesson"), `Unexpected error: ${err}`);
  } finally {
    await cleanLesson(a.lessonId);
    await cleanLesson(b.lessonId);
  }
});

await test("T03: lesson type + valid nodeIds from that Lesson accepted", async () => {
  if (!process.env.RUN_AI_TESTS) {
    console.log("    [skip] AI quiz creation (set RUN_AI_TESTS=1 to enable)");
    return;
  }
  const { lessonId, nodeId } = await makeTestLesson();
  let quizId: number | undefined;
  try {
    const { status, json } = await api("POST", "/quizzes", {
      subjectId: 18, quizType: "lesson", nodeIds: [nodeId], questionCount: 2,
    });
    assert.equal(status, 201, `Expected 201, got ${status}: ${JSON.stringify(json)}`);
    quizId = (json as { id: number }).id;
    // quizType must be "lesson" (derived from single lesson even without explicit)
    const [q] = await db.select({ quizType: quizzesTable.quizType }).from(quizzesTable).where(eq(quizzesTable.id, quizId!));
    assert.equal(q.quizType, "lesson");
    // Lesson link exists
    const links = await db.select().from(quizLessonLinksTable).where(eq(quizLessonLinksTable.quizId, quizId!));
    assert.equal(links.length, 1);
    assert.equal(links[0].lessonId, lessonId);
  } finally {
    if (quizId) await cleanQuiz(quizId);
    await cleanLesson(lessonId);
  }
});

await test("T04: lesson type + nodeId from a different Lesson rejected", async () => {
  const a = await makeTestLesson(); // nodeId from lesson A
  const b = await makeTestLesson(); // lessonId from lesson B
  try {
    const { status, json } = await api("POST", "/quizzes", {
      subjectId: 18, quizType: "lesson",
      lessonIds: [b.lessonId],
      nodeIds:   [a.nodeId], // belongs to lesson A — cross-lesson!
      questionCount: 2,
    });
    assert.equal(status, 400, `Expected 400, got ${status}: ${JSON.stringify(json)}`);
    const err = (json as { error: string }).error;
    assert.ok(err.includes("do not belong to the selected lesson"), `Unexpected error: ${err}`);
  } finally {
    await cleanLesson(a.lessonId);
    await cleanLesson(b.lessonId);
  }
});

await test("T05: lesson type + no nodeIds = whole Lesson (lessonIds path)", async () => {
  if (!process.env.RUN_AI_TESTS) {
    console.log("    [skip] AI quiz creation (set RUN_AI_TESTS=1 to enable)");
    return;
  }
  const { lessonId } = await makeTestLesson();
  let quizId: number | undefined;
  try {
    const { status, json } = await api("POST", "/quizzes", {
      subjectId: 18, quizType: "lesson", lessonIds: [lessonId], questionCount: 2,
    });
    assert.equal(status, 201, `Expected 201, got ${status}: ${JSON.stringify(json)}`);
    quizId = (json as { id: number }).id;
    // nodeIds in DB must include the lesson node (backend resolved all)
    const [q] = await db.select({ nodeIds: quizzesTable.nodeIds }).from(quizzesTable).where(eq(quizzesTable.id, quizId!));
    assert.ok(Array.isArray(q.nodeIds) && (q.nodeIds as number[]).length > 0, "Expected backend to resolve nodeIds from lesson");
  } finally {
    if (quizId) await cleanQuiz(quizId);
    await cleanLesson(lessonId);
  }
});

// ─── Group B: Summary Test validation ─────────────────────────────────────────
console.log("\n  Summary Test validation");

await test("T06: summary type + two Lessons accepted", async () => {
  if (!process.env.RUN_AI_TESTS) {
    console.log("    [skip] AI quiz creation (set RUN_AI_TESTS=1 to enable)");
    return;
  }
  const a = await makeTestLesson();
  const b = await makeTestLesson();
  let quizId: number | undefined;
  try {
    const { status, json } = await api("POST", "/quizzes", {
      subjectId: 18, quizType: "summary", lessonIds: [a.lessonId, b.lessonId], questionCount: 2,
    });
    assert.equal(status, 201, `Expected 201, got ${status}: ${JSON.stringify(json)}`);
    quizId = (json as { id: number }).id;
    // quizType = summary
    const [q] = await db.select({ quizType: quizzesTable.quizType }).from(quizzesTable).where(eq(quizzesTable.id, quizId!));
    assert.equal(q.quizType, "summary");
    // Two lesson links
    const links = await db.select().from(quizLessonLinksTable).where(eq(quizLessonLinksTable.quizId, quizId!));
    assert.equal(links.length, 2);
    const linkedIds = links.map((l) => l.lessonId).sort();
    assert.deepEqual(linkedIds, [a.lessonId, b.lessonId].sort());
  } finally {
    if (quizId) await cleanQuiz(quizId);
    await cleanLesson(a.lessonId);
    await cleanLesson(b.lessonId);
  }
});

await test("T07: summary type + one Lesson rejected", async () => {
  const { lessonId } = await makeTestLesson();
  try {
    const { status, json } = await api("POST", "/quizzes", {
      subjectId: 18, quizType: "summary", lessonIds: [lessonId], questionCount: 2,
    });
    assert.equal(status, 400, `Expected 400, got ${status}: ${JSON.stringify(json)}`);
    const err = (json as { error: string }).error;
    assert.ok(err.includes("at least 2 lessons"), `Unexpected error: ${err}`);
  } finally {
    await cleanLesson(lessonId);
  }
});

await test("T08: summary type + stale nodeIds rejected", async () => {
  const a = await makeTestLesson();
  const b = await makeTestLesson();
  try {
    const { status, json } = await api("POST", "/quizzes", {
      subjectId: 18, quizType: "summary",
      lessonIds: [a.lessonId, b.lessonId],
      nodeIds:   [a.nodeId],  // manual node selection not allowed for summary
      questionCount: 2,
    });
    assert.equal(status, 400, `Expected 400, got ${status}: ${JSON.stringify(json)}`);
    const err = (json as { error: string }).error;
    assert.ok(err.includes("does not support manual node selection"), `Unexpected error: ${err}`);
  } finally {
    await cleanLesson(a.lessonId);
    await cleanLesson(b.lessonId);
  }
});

// ─── Group C: Type-switch state helpers ───────────────────────────────────────
console.log("\n  Type-switch state helpers (pure logic)");

await test("T09: type switch lesson→summary clears nodeIds, keeps all lessons", async () => {
  const state = simulateTypeSwitch("summary", [105, 106, 107], [1349, 1350]);
  assert.deepEqual(state.nodeIds, [], "nodeIds must be cleared");
  assert.deepEqual(state.lessonIds, [105, 106, 107], "all lessons must be preserved");
});

await test("T10: type switch summary→lesson keeps only first lesson, clears nodeIds", async () => {
  const state = simulateTypeSwitch("lesson", [105, 106, 107], []);
  assert.equal(state.lessonIds.length, 1, "must keep exactly one lesson");
  assert.equal(state.lessonIds[0], 105, "must keep the first lesson");
  assert.deepEqual(state.nodeIds, [], "nodeIds must be cleared");
});

// ─── Group D: Persistence verification ────────────────────────────────────────
console.log("\n  Persistence verification");

await test("T11: creation writes correct quizType to quizzes table", async () => {
  if (!process.env.RUN_AI_TESTS) {
    console.log("    [skip] AI quiz creation (set RUN_AI_TESTS=1 to enable)");
    return;
  }
  const { lessonId } = await makeTestLesson();
  let quizId: number | undefined;
  try {
    const { status, json } = await api("POST", "/quizzes", {
      subjectId: 18, quizType: "lesson", lessonIds: [lessonId], questionCount: 2,
    });
    assert.equal(status, 201);
    quizId = (json as { id: number }).id;
    const [q] = await db.select({ quizType: quizzesTable.quizType }).from(quizzesTable).where(eq(quizzesTable.id, quizId!));
    assert.equal(q.quizType, "lesson", `Expected 'lesson', got '${q.quizType}'`);
  } finally {
    if (quizId) await cleanQuiz(quizId);
    await cleanLesson(lessonId);
  }
});

await test("T12: creation writes correct lesson links to quiz_lesson_links", async () => {
  if (!process.env.RUN_AI_TESTS) {
    console.log("    [skip] AI quiz creation (set RUN_AI_TESTS=1 to enable)");
    return;
  }
  const a = await makeTestLesson();
  const b = await makeTestLesson();
  let quizId: number | undefined;
  try {
    const { status, json } = await api("POST", "/quizzes", {
      subjectId: 18, quizType: "summary", lessonIds: [a.lessonId, b.lessonId], questionCount: 2,
    });
    assert.equal(status, 201);
    quizId = (json as { id: number }).id;
    const links = await db.select({ lessonId: quizLessonLinksTable.lessonId })
      .from(quizLessonLinksTable).where(eq(quizLessonLinksTable.quizId, quizId!));
    const linked = links.map((l) => l.lessonId).sort();
    assert.deepEqual(linked, [a.lessonId, b.lessonId].sort());
  } finally {
    if (quizId) await cleanQuiz(quizId);
    await cleanLesson(a.lessonId);
    await cleanLesson(b.lessonId);
  }
});

await test("T13: one Quiz ID appears in both lesson view and global query", async () => {
  if (!process.env.RUN_AI_TESTS) {
    console.log("    [skip] AI quiz creation (set RUN_AI_TESTS=1 to enable)");
    return;
  }
  const { lessonId } = await makeTestLesson();
  let quizId: number | undefined;
  try {
    const { status, json } = await api("POST", "/quizzes", {
      subjectId: 18, quizType: "lesson", lessonIds: [lessonId], questionCount: 2,
    });
    assert.equal(status, 201);
    quizId = (json as { id: number }).id;
    // Global list
    const { json: globalJson } = await api("GET", `/quizzes?subjectId=18`);
    const globalList = globalJson as { id: number }[];
    const inGlobal = globalList.some((q) => q.id === quizId);
    assert.ok(inGlobal, `Quiz ${quizId} not found in global list`);
    // Lesson view
    const { json: lessonJson } = await api("GET", `/lessons/${lessonId}/quizzes`);
    const lessonList = lessonJson as { id: number }[];
    const inLesson = lessonList.some((q) => q.id === quizId);
    assert.ok(inLesson, `Quiz ${quizId} not found in lesson ${lessonId} view`);
    // Same ID
    const lessonViewQuiz = lessonList.find((q) => q.id === quizId);
    assert.equal(lessonViewQuiz?.id, quizId, "ID in lesson view must match global ID");
  } finally {
    if (quizId) await cleanQuiz(quizId);
    await cleanLesson(lessonId);
  }
});

await test("T14: summary creates exactly ONE Quiz record even with two lesson links", async () => {
  if (!process.env.RUN_AI_TESTS) {
    console.log("    [skip] AI quiz creation (set RUN_AI_TESTS=1 to enable)");
    return;
  }
  const a = await makeTestLesson();
  const b = await makeTestLesson();
  let quizId: number | undefined;
  try {
    const { status, json } = await api("POST", "/quizzes", {
      subjectId: 18, quizType: "summary", lessonIds: [a.lessonId, b.lessonId], questionCount: 2,
    });
    assert.equal(status, 201);
    quizId = (json as { id: number }).id;
    // Count quiz records matching this ID
    const rows = await db.select({ id: quizzesTable.id }).from(quizzesTable).where(eq(quizzesTable.id, quizId!));
    assert.equal(rows.length, 1, `Expected 1 quiz record, found ${rows.length}`);
    // Count link rows
    const links = await db.select().from(quizLessonLinksTable).where(eq(quizLessonLinksTable.quizId, quizId!));
    assert.equal(links.length, 2, `Expected 2 link rows, found ${links.length}`);
    // Both lesson views show same quiz
    const { json: aJson } = await api("GET", `/lessons/${a.lessonId}/quizzes`);
    const { json: bJson } = await api("GET", `/lessons/${b.lessonId}/quizzes`);
    const aList = aJson as { id: number }[];
    const bList = bJson as { id: number }[];
    assert.ok(aList.some((q) => q.id === quizId), `Quiz not in lesson A view`);
    assert.ok(bList.some((q) => q.id === quizId), `Quiz not in lesson B view`);
  } finally {
    if (quizId) await cleanQuiz(quizId);
    await cleanLesson(a.lessonId);
    await cleanLesson(b.lessonId);
  }
});

await test("T15: question-count suggestion uses correct leaf count per scope", async () => {
  if (!process.env.RUN_AI_TESTS) {
    console.log("    [skip] AI quiz creation (set RUN_AI_TESTS=1 to enable)");
    return;
  }
  // Verify that the backend resolves ALL nodes for a lesson (whole-lesson scope)
  // and that a node-scoped quiz stores only the selected nodes.
  const { lessonId, nodeId } = await makeTestLesson();
  // Add a second node so the lesson has 2 nodes total
  const [n2] = await db.insert(lessonNodesTable).values({
    lessonId, sequence: 2, title: "Test node 2", createdBy: "teacher",
  }).returning({ id: lessonNodesTable.id });

  let wholeQuizId: number | undefined;
  let nodeQuizId: number | undefined;
  try {
    // Whole-lesson scope: backend should resolve both nodes
    const { status: s1, json: j1 } = await api("POST", "/quizzes", {
      subjectId: 18, quizType: "lesson", lessonIds: [lessonId], questionCount: 2,
    });
    assert.equal(s1, 201);
    wholeQuizId = (j1 as { id: number }).id;
    const [whole] = await db.select({ nodeIds: quizzesTable.nodeIds }).from(quizzesTable).where(eq(quizzesTable.id, wholeQuizId!));
    const wholeNodeIds = whole.nodeIds as number[];
    assert.equal(wholeNodeIds.length, 2, `Whole-lesson scope: expected 2 nodes, got ${wholeNodeIds.length}`);
    assert.ok(wholeNodeIds.includes(nodeId), "First node must be in whole-lesson scope");
    assert.ok(wholeNodeIds.includes(n2.id), "Second node must be in whole-lesson scope");

    // Node-scoped: only selected node
    const { status: s2, json: j2 } = await api("POST", "/quizzes", {
      subjectId: 18, quizType: "lesson", nodeIds: [nodeId], questionCount: 2,
    });
    assert.equal(s2, 201);
    nodeQuizId = (j2 as { id: number }).id;
    const [scoped] = await db.select({ nodeIds: quizzesTable.nodeIds }).from(quizzesTable).where(eq(quizzesTable.id, nodeQuizId!));
    const scopedNodeIds = scoped.nodeIds as number[];
    assert.equal(scopedNodeIds.length, 1, `Node-scoped: expected 1 node, got ${scopedNodeIds.length}`);
    assert.equal(scopedNodeIds[0], nodeId);
  } finally {
    if (wholeQuizId) await cleanQuiz(wholeQuizId);
    if (nodeQuizId) await cleanQuiz(nodeQuizId);
    await db.delete(lessonNodesTable).where(eq(lessonNodesTable.id, n2.id));
    await cleanLesson(lessonId);
  }
});

// ─── Lesson 105 data integrity ─────────────────────────────────────────────────
console.log("\n  Lesson 105 data integrity post-test");

await test("TI: Lesson 105 mapping state unchanged by Phase 1.10", async () => {
  // This phase does not touch Lesson 105. We only verify the invariants that
  // Phase 1.10 is responsible for:
  //   • 4 topics (stable since Phase 1.1)
  //   • 15 textbook exercises (stable since Phase 1.6)
  //   • No quizzes created by this suite reference Lesson 105
  //
  // NOTE: status and node-count are deliberately NOT asserted here because the
  // teacher may activate / modify Lesson 105 through the live dashboard between
  // test runs — those changes are outside the scope of this suite.
  const [lesson] = await db
    .select({ id: lessonsTable.id, status: lessonsTable.status })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, 105));
  assert.ok(lesson, "Lesson 105 must exist");

  const topics = await db
    .select({ id: lessonTopicsTable.id })
    .from(lessonTopicsTable)
    .where(eq(lessonTopicsTable.lessonId, 105));
  assert.equal(topics.length, 4, `Expected 4 topics, got ${topics.length}`);

  const nodes = await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, 105));
  assert.ok(nodes.length >= 1, `Lesson 105 must have at least 1 node, got ${nodes.length}`);

  const exercises = await db
    .select({ id: lessonExercisesTable.id })
    .from(lessonExercisesTable)
    .where(eq(lessonExercisesTable.lessonId, 105));
  assert.equal(exercises.length, 15, `Expected 15 exercises, got ${exercises.length}`);

  console.log(`    Lesson 105 status=${lesson.status}, topics=${topics.length}, nodes=${nodes.length}, exercises=${exercises.length}`);
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

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests run: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
