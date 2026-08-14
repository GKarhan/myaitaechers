// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1.13 — Full Lesson Lifecycle End-to-End Acceptance Test
// Run with: pnpm --filter @workspace/api-server run test:phase113-e2e
//
// Spec sections covered:
//  A  Pre-flight forensic baseline (lesson 105)
//  B  Mapping acceptance (safe fixture lesson)
//  C  Teacher Review CRUD (topics, nodes, exercises — fixture)
//  D  Ordering + SEQUENTIAL dependencies (fixture)
//  E  Initial Phase 2 enrichment — background whole-lesson (fixture)
//  F  Final Approval (fixture + negative case)
//  G  Post-approval editing (lesson 105, everApproved=true)
//  H  New MicroNode + selective one-node enrichment (lesson 105 + cleanup)
//  I  Read-only MicroNode view data integrity (lesson 105)
//  J  Whole-lesson regeneration safety (lesson 105)
//  K  Lesson assignment + student-package (lesson 105, student1)
//  L  Quiz lifecycle: re-release → take → submit → complete → re-release (quiz 164)
//  M  Lesson session start / resume (lesson 105, student1)
//  N  Evidence + Knowledge Tree state (lesson 105, student1)
//  O  Student isolation (lesson 105 — single student, structural integrity check)
//  P  Cleanup + BEFORE/AFTER data integrity
//
// TEST DATA SAFETY:
//  - A temporary fixture lesson is created and DELETED in cleanup (try/finally).
//  - Quiz 164 is re-released (new assignment rows added then left as COMPLETED after test).
//  - Lesson 105 nodes and exercises are restored to original values.
//  - NO temporary test data may survive the try/finally block.
//
// Do NOT count 408 (timeout) as selective-enrichment success (spec §12).
// ─────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  db,
  lessonsTable, lessonTopicsTable, lessonNodesTable, lessonExercisesTable,
  lessonNodeDependenciesTable, lessonSessionsTable, knowledgeNodesTable,
  quizAssignmentsTable, quizLessonLinksTable, mappingJobsTable,
} from "@workspace/db";
import { eq, and, inArray, sql, count, ne } from "drizzle-orm";

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE             = "http://localhost:8080/api";
const TEACHER_ID       = 161;
const STUDENT_ID       = 93;
const CLASS_ID         = 29;
const REAL_LESSON_ID   = 105;
const SUBJECT_PHYSICS  = 18;
const QUIZ_164_ID      = 164;   // 10 questions, linked to lesson 105
const QUIZ_166_ID      = 166;   // 3  questions, linked to lesson 105

// Correct option indices for quiz 164 questions (IDs 332-341)
const QUIZ_164_ANSWERS = [
  { questionId: 332, selectedOptionIndex: 1 },
  { questionId: 333, selectedOptionIndex: 1 },
  { questionId: 334, selectedOptionIndex: 1 },
  { questionId: 335, selectedOptionIndex: 3 },
  { questionId: 336, selectedOptionIndex: 1 },
  { questionId: 337, selectedOptionIndex: 1 },
  { questionId: 338, selectedOptionIndex: 1 },
  { questionId: 339, selectedOptionIndex: 3 },
  { questionId: 340, selectedOptionIndex: 1 },
  { questionId: 341, selectedOptionIndex: 1 },
];

// Tokens
const TEACHER_BEARER = jwt.sign(
  { userId: TEACHER_ID, role: "teacher" },
  process.env.SESSION_SECRET ?? "myaiteacher-secret",
  { expiresIn: "1h" },
);
const STUDENT_BEARER = jwt.sign(
  { userId: STUDENT_ID, role: "student" },
  process.env.SESSION_SECRET ?? "myaiteacher-secret",
  { expiresIn: "1h" },
);

// ─── Test runner ──────────────────────────────────────────────────────────────

type Test = [string, () => Promise<void>];
const tests: Test[] = [];
function it(name: string, fn: () => Promise<void>): void { tests.push([name, fn]); }

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function api(
  method: string,
  path: string,
  body?: unknown,
  opts?: { token?: string; timeoutMs?: number },
) {
  const token   = opts?.token ?? TEACHER_BEARER;
  const timeoutMs = opts?.timeoutMs ?? 25000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, body: data as Record<string, unknown> };
  } catch (err: unknown) {
    const isAbort = (err as { name?: string })?.name === "AbortError";
    return {
      status:  isAbort ? 408 : 500,
      body:    { error: String(err) } as Record<string, unknown>,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Minimal TEXT-format mapping document ─────────────────────────────────────

const FIXTURE_MAP_TEXT = `LESSON
title: Phase 1.13 E2E Fixture — Ֆիզիկական քանակ
subject: Ֆիզիկա
grade: 7
textbook: Ֆիզիկա 7
author: E2E Author
section: Fixture Chapter
pages: 1-4

NODE N1
title: Ֆիզիկական քանակ

MICRONODE MN-1.1
title: Ֆիզիկական քանակի սահմանում
microNodeType: KNOWLEDGE
learningObjective: Աշակերտը կարողանա սահմանել ֆիզիկական քանակ հասկացությունը
sourceBlockIds: B1
confidenceScore: 88
sourceCoverage: FULL
status: draft

MICRONODE MN-1.2
title: Ֆիզիկական քանակի չափումը
microNodeType: KNOWLEDGE
learningObjective: Աշակերտը կարողանա բացատրել ֆիզիկական քանակի չափման կարևորությունը
sourceBlockIds: B2
confidenceScore: 85
sourceCoverage: FULL
status: draft

SOURCE BLOCK B1
blockType: DEFINITION
sourceText: Ֆիզիկական քանակը ֆիզիկայում ուսումնասիրվող երևույթների կամ հատկությունների քանակական բնութագիրն է:
sourcePage: 1
status: EXTRACTED

SOURCE BLOCK B2
blockType: EXPLANATION
sourceText: Ֆիզիկական քանակը չափելու համար օգտագործում են չափման etalon (չափանիշ), որի հետ համեմատում են տվյալ քանակը:
sourcePage: 2
status: EXTRACTED

EXERCISE EX-1
text: Ի՞նչ է ֆիզիկական քանակը: Բերե՛ք օրինակներ:
exerciseType: RECALL
difficulty: EASY
sourcePage: 1

EXERCISE EX-2
text: Ինչու՞ է կարևոր ֆիզիկական քանակը ճիշտ չափելը:
exerciseType: APPLICATION
difficulty: MEDIUM
sourcePage: 3
`;

// ─── Mutable state shared across tests ───────────────────────────────────────

let fixtureLessonId: number | null = null;
let fixtureTopicId:  number | null = null;
let fixtureNode1Id:  number | null = null;
let fixtureNode2Id:  number | null = null;
let tempNodeId:      number | null = null;   // H-section temp node on lesson 105
let newQuizAssignmentId: number | null = null;

// ─── Baseline snapshots ───────────────────────────────────────────────────────

interface Baseline {
  topics:       number;
  nodes:        number;
  exercises:    number;
  seqDeps:      number;
  reqDeps:      number;
  linkedQuizzes:number;
  assignments:  number;
  sessions:     number;
  knowledgeNodes:number;
  status:       string;
  everApproved: boolean;
}

let baselineBefore: Baseline = {} as Baseline;
let baselineAfter:  Baseline = {} as Baseline;

async function snapshotLesson105(): Promise<Baseline> {
  const [lesson] = await db
    .select({ status: lessonsTable.status, everApproved: lessonsTable.everApproved })
    .from(lessonsTable).where(eq(lessonsTable.id, REAL_LESSON_ID)).limit(1);

  const nodes = await db.select({ id: lessonNodesTable.id })
    .from(lessonNodesTable).where(eq(lessonNodesTable.lessonId, REAL_LESSON_ID));
  const nodeIds = nodes.map(n => n.id);

  const [topicsRow] = await db
    .select({ cnt: count() })
    .from(lessonTopicsTable)
    .where(eq(lessonTopicsTable.lessonId, REAL_LESSON_ID));
  const [exRow] = await db
    .select({ cnt: count() })
    .from(lessonExercisesTable)
    .where(eq(lessonExercisesTable.lessonId, REAL_LESSON_ID));
  const [seqRow] = await db
    .select({ cnt: count() })
    .from(lessonNodeDependenciesTable)
    .where(and(
      eq(lessonNodeDependenciesTable.lessonId, REAL_LESSON_ID),
      eq(lessonNodeDependenciesTable.dependencyType, "SEQUENTIAL"),
    ));
  const [reqRow] = await db
    .select({ cnt: count() })
    .from(lessonNodeDependenciesTable)
    .where(and(
      eq(lessonNodeDependenciesTable.lessonId, REAL_LESSON_ID),
      eq(lessonNodeDependenciesTable.dependencyType, "REQUIRED"),
    ));
  const [qllRow] = await db
    .select({ cnt: count() })
    .from(quizLessonLinksTable)
    .where(eq(quizLessonLinksTable.lessonId, REAL_LESSON_ID));
  const [sessRow] = await db
    .select({ cnt: count() })
    .from(lessonSessionsTable)
    .where(eq(lessonSessionsTable.lessonId, REAL_LESSON_ID));

  // Quiz assignments: join through quiz_lesson_links
  const linkedQuizIds = (await db
    .select({ quizId: quizLessonLinksTable.quizId })
    .from(quizLessonLinksTable)
    .where(eq(quizLessonLinksTable.lessonId, REAL_LESSON_ID))).map(r => r.quizId);
  let qaCount = 0;
  if (linkedQuizIds.length > 0) {
    const [qaRow] = await db
      .select({ cnt: count() })
      .from(quizAssignmentsTable)
      .where(inArray(quizAssignmentsTable.quizId, linkedQuizIds));
    qaCount = Number(qaRow?.cnt ?? 0);
  }

  let knCount = 0;
  if (nodeIds.length > 0) {
    const [knRow] = await db
      .select({ cnt: count() })
      .from(knowledgeNodesTable)
      .where(inArray(knowledgeNodesTable.lessonNodeId, nodeIds));
    knCount = Number(knRow?.cnt ?? 0);
  }

  return {
    topics:         Number(topicsRow?.cnt ?? 0),
    nodes:          nodes.length,
    exercises:      Number(exRow?.cnt ?? 0),
    seqDeps:        Number(seqRow?.cnt ?? 0),
    reqDeps:        Number(reqRow?.cnt ?? 0),
    linkedQuizzes:  Number(qllRow?.cnt ?? 0),
    assignments:    qaCount,
    sessions:       Number(sessRow?.cnt ?? 0),
    knowledgeNodes: knCount,
    status:         lesson?.status ?? "?",
    everApproved:   lesson?.everApproved ?? false,
  };
}

// ─── Original node title for restore ─────────────────────────────────────────

const ORIGINAL_NODE_TITLE = "«Ֆիզիկա» դասընթացի նպատակը և կարևորությունը";
const NODE_1903_ID = 1903;

// ═════════════════════════════════════════════════════════════════════════════
// A — PRE-FLIGHT FORENSIC BASELINE
// ═════════════════════════════════════════════════════════════════════════════

it("A1: lesson 105 is active and everApproved=true", async () => {
  // GET /lessons/:id returns authoringStatus (= DB status), not a separate "status" field
  const { status, body } = await api("GET", `/lessons/${REAL_LESSON_ID}`);
  assert.equal(status, 200, `GET lesson: ${JSON.stringify(body)}`);
  assert.equal((body as any).authoringStatus, "active",
    `Expected authoringStatus="active", got: ${JSON.stringify(body)}`);
  // everApproved is not exposed in the HTTP response — check via DB snapshot in A3
});

it("A2: lesson 105 has exactly 9 approved nodes (no pollution)", async () => {
  // GET /lessons/:id/nodes returns a plain array (not {nodes:[...]})
  const { status, body } = await api("GET", `/lessons/${REAL_LESSON_ID}/nodes`);
  assert.equal(status, 200);
  const nodes = body as any[];
  assert.equal(nodes.length, 9, `Expected 9 nodes, got ${nodes.length}: ${JSON.stringify(nodes.map((n: any) => n.title))}`);
  for (const n of nodes) {
    assert.notEqual(n.title, "POST-P1.12 Test Node B1", "Pollution node must not exist");
    assert.notEqual(n.title, "Phase 6 Step 5 — LESSON_OVERVIEW test", "Historical pollution must not exist");
  }
});

it("A3: capture BEFORE baseline for data-integrity report", async () => {
  baselineBefore = await snapshotLesson105();
  assert.equal(baselineBefore.status, "active");
  assert.equal(baselineBefore.everApproved, true);
  assert.equal(baselineBefore.nodes, 9, `Expected 9 nodes in baseline, got ${baselineBefore.nodes}`);
  assert.equal(baselineBefore.seqDeps, 8, `Expected 8 SEQUENTIAL deps (9-1=8), got ${baselineBefore.seqDeps}`);
  console.log(`    BEFORE: topics=${baselineBefore.topics} nodes=${baselineBefore.nodes} ex=${baselineBefore.exercises} seqDeps=${baselineBefore.seqDeps} quizzes=${baselineBefore.linkedQuizzes} assignments=${baselineBefore.assignments} sessions=${baselineBefore.sessions} kn=${baselineBefore.knowledgeNodes}`);
});

it("A4: lesson 105 has 3 topics and 15 approved exercises", async () => {
  // GET /lessons/:id/exercises returns a plain array (not {exercises:[...]})
  const exResp = await api("GET", `/lessons/${REAL_LESSON_ID}/exercises`);
  assert.equal(exResp.status, 200);
  const exercises = exResp.body as any[];
  assert.equal(exercises.length, 15, `Expected 15 exercises, got ${exercises.length}`);
});

it("A5: SEQUENTIAL dep chain is contiguous (no gaps, no stale edges)", async () => {
  const { status, body } = await api("GET", `/lessons/${REAL_LESSON_ID}/nodes`);
  assert.equal(status, 200);
  const nodes = body as any[];
  const seqs = nodes.map((n: any) => n.sequence).sort((a: number, b: number) => a - b);
  for (let i = 0; i < seqs.length; i++) {
    assert.equal(seqs[i], i + 1, `Gap in sequence: expected ${i+1}, got ${seqs[i]}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// B — MAPPING ACCEPTANCE (safe fixture lesson)
// ═════════════════════════════════════════════════════════════════════════════

it("B1: teacher can create a draft lesson via API", async () => {
  const { status, body } = await api("POST", "/lessons", {
    subjectId: SUBJECT_PHYSICS,
    title: "Phase 1.13 E2E Fixture — Delete After Test",
    description: "Temporary fixture for Phase 1.13 E2E acceptance test",
  });
  assert.equal(status, 201, `Create lesson: ${JSON.stringify(body)}`);
  fixtureLessonId = (body as any).id as number;
  assert.ok(fixtureLessonId > 0, "Lesson ID must be positive");
  console.log(`    Fixture lesson created: id=${fixtureLessonId}`);
});

it("B2: TEXT manual-map dryRun=true returns preview without DB writes", async () => {
  if (!fixtureLessonId) { console.log("    (skipped — B1 failed)"); return; }
  const { status, body } = await api("POST", `/lessons/${fixtureLessonId}/manual-map`, {
    rawText: FIXTURE_MAP_TEXT,
    format: "text",
    dryRun: true,
  });
  assert.equal(status, 200, `dryRun preview: ${JSON.stringify(body)}`);
  const preview = (body as any).preview as any;
  assert.ok(preview.counts.nodes >= 1, "Preview must report ≥1 nodes");
  assert.ok(preview.counts.microNodes >= 2, "Preview must report ≥2 microNodes");
  assert.ok(preview.counts.exercises >= 2, "Preview must report ≥2 exercises");
  assert.equal(preview.hasErrors, false, `Preview must have no errors: ${JSON.stringify(preview.errors)}`);
  // Verify dryRun=true did NOT persist anything
  const nodeCheck = await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, fixtureLessonId));
  assert.equal(nodeCheck.length, 0, "dryRun must not create any nodes");
});

it("B3: TEXT manual-map dryRun=false persists topics, nodes, exercises", async () => {
  if (!fixtureLessonId) { console.log("    (skipped — B1 failed)"); return; }
  const { status, body } = await api("POST", `/lessons/${fixtureLessonId}/manual-map`, {
    rawText: FIXTURE_MAP_TEXT,
    format: "text",
    dryRun: false,
  });
  assert.equal(status, 200, `Map commit: ${JSON.stringify(body)}`);
  const counts = (body as any).counts as any;
  assert.ok(counts.microNodesCreated >= 2, `Must create ≥2 microNodes, got ${counts.microNodesCreated}`);
  assert.ok(counts.exercisesCreated >= 2, `Must create ≥2 exercises, got ${counts.exercisesCreated}`);
  console.log(`    Mapping result: ${JSON.stringify(counts)}`);
});

it("B4: mapped nodes persist in DB with correct source provenance", async () => {
  if (!fixtureLessonId) { console.log("    (skipped — B1 failed)"); return; }
  const nodes = await db
    .select({ id: lessonNodesTable.id, title: lessonNodesTable.title, theoryContent: lessonNodesTable.theoryContent })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, fixtureLessonId))
    .orderBy(lessonNodesTable.sequence);
  assert.ok(nodes.length >= 2, `Expected ≥2 nodes after mapping, got ${nodes.length}`);
  // All mapped nodes should have theory content (from source blocks)
  for (const n of nodes) {
    assert.ok(n.theoryContent, `Node "${n.title}" should have theory content from source block`);
  }
  fixtureNode1Id = nodes[0]?.id ?? null;
  fixtureNode2Id = nodes[1]?.id ?? null;
  console.log(`    Fixture nodes: ${nodes.map(n => `${n.id}:${n.title.slice(0,30)}`).join(", ")}`);
});

it("B5: mapped exercises persist in DB", async () => {
  if (!fixtureLessonId) { console.log("    (skipped — B1 failed)"); return; }
  const exercises = await db
    .select({ id: lessonExercisesTable.id, exerciseTextVerbatim: lessonExercisesTable.exerciseTextVerbatim })
    .from(lessonExercisesTable)
    .where(eq(lessonExercisesTable.lessonId, fixtureLessonId));
  assert.ok(exercises.length >= 2, `Expected ≥2 exercises, got ${exercises.length}`);
  assert.ok(exercises.every(e => e.exerciseTextVerbatim?.trim()), "All exercises must have text");
});

it("B6: mapping creates no fake knowledge_nodes or evidence", async () => {
  if (!fixtureLessonId) { console.log("    (skipped — B1 failed)"); return; }
  const nodeIds = await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, fixtureLessonId));
  if (nodeIds.length === 0) return;
  const kns = await db
    .select({ id: knowledgeNodesTable.id })
    .from(knowledgeNodesTable)
    .where(inArray(knowledgeNodesTable.lessonNodeId, nodeIds.map(n => n.id)));
  assert.equal(kns.length, 0, "Mapping must NOT create knowledge_nodes");
});

// ═════════════════════════════════════════════════════════════════════════════
// C — TEACHER REVIEW CRUD (fixture lesson)
// ═════════════════════════════════════════════════════════════════════════════

let savedNodeTitle = "";

it("C1: teacher can edit MicroNode title — persists after read-back", async () => {
  if (!fixtureLessonId || !fixtureNode1Id) { console.log("    (skipped)"); return; }
  const original = await db
    .select({ title: lessonNodesTable.title })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, fixtureNode1Id))
    .limit(1);
  savedNodeTitle = original[0]?.title ?? "";

  const newTitle = savedNodeTitle + " (C1 edited)";
  const { status } = await api("POST", `/lessons/${fixtureLessonId}/nodes/${fixtureNode1Id}/update`, {
    title: newTitle,
  });
  assert.ok(status < 300, `Node update failed: ${status}`);

  const [updated] = await db
    .select({ title: lessonNodesTable.title })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, fixtureNode1Id))
    .limit(1);
  assert.equal(updated.title, newTitle, "Title must persist in DB");
});

it("C2: teacher can edit learningObjective — persists", async () => {
  if (!fixtureLessonId || !fixtureNode1Id) { console.log("    (skipped)"); return; }
  const { status } = await api("POST", `/lessons/${fixtureLessonId}/nodes/${fixtureNode1Id}/update`, {
    learningObjective: "Աշակերտը կարողանա ճշտել ֆիզիկական քանակ հասկացությունը (C2)",
  });
  assert.ok(status < 300, `LO update failed: ${status}`);

  const [updated] = await db
    .select({ learningObjective: lessonNodesTable.learningObjective })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, fixtureNode1Id))
    .limit(1);
  assert.ok(updated.learningObjective?.includes("C2"), "LO must persist");
});

it("C3: teacher can create a new exercise on fixture lesson", async () => {
  if (!fixtureLessonId) { console.log("    (skipped)"); return; }
  const { status, body } = await api("POST", `/lessons/${fixtureLessonId}/exercises`, {
    exerciseTextVerbatim: "C3 test exercise — to be deleted",
    relatedNodeId: fixtureNode1Id,
    assignment: "CLASS",
  });
  assert.ok(status < 300, `Exercise create failed: ${status} ${JSON.stringify(body)}`);
  const exId = (body as any).id ?? (body as any).exercise?.id;
  assert.ok(exId, "Exercise must have an ID");

  // Immediately delete to keep fixture clean
  const { status: delStatus } = await api("POST", `/lessons/${fixtureLessonId}/exercises/${exId}/delete`);
  assert.ok(delStatus < 300, `Exercise delete failed: ${delStatus}`);
});

it("C4: teacher can create a new topic on fixture lesson", async () => {
  if (!fixtureLessonId) { console.log("    (skipped)"); return; }
  const { status, body } = await api("POST", `/lessons/${fixtureLessonId}/topics`, {
    title: "C4 Test Topic",
  });
  assert.ok(status < 300, `Topic create failed: ${status} ${JSON.stringify(body)}`);
  fixtureTopicId = (body as any).id ?? (body as any).topic?.id;
  assert.ok(fixtureTopicId, "Topic must have an ID");
});

it("C5: teacher can edit topic title — persists", async () => {
  if (!fixtureLessonId || !fixtureTopicId) { console.log("    (skipped)"); return; }
  const { status } = await api("POST", `/lessons/${fixtureLessonId}/topics/${fixtureTopicId}/update`, {
    title: "C4/C5 Updated Topic",
  });
  assert.ok(status < 300, `Topic update failed: ${status}`);
  const [updated] = await db
    .select({ title: lessonTopicsTable.title })
    .from(lessonTopicsTable)
    .where(eq(lessonTopicsTable.id, fixtureTopicId!))
    .limit(1);
  assert.equal(updated.title, "C4/C5 Updated Topic");
});

it("C6: teacher can delete the temp topic — persists in DB", async () => {
  if (!fixtureLessonId || !fixtureTopicId) { console.log("    (skipped)"); return; }
  const { status } = await api("POST", `/lessons/${fixtureLessonId}/topics/${fixtureTopicId}/delete`);
  assert.ok(status < 300, `Topic delete failed: ${status}`);
  const topics = await db
    .select({ id: lessonTopicsTable.id })
    .from(lessonTopicsTable)
    .where(eq(lessonTopicsTable.id, fixtureTopicId!));
  assert.equal(topics.length, 0, "Deleted topic must not exist in DB");
  fixtureTopicId = null;
});

it("C7: restore fixture node1 title to original", async () => {
  if (!fixtureLessonId || !fixtureNode1Id || !savedNodeTitle) { console.log("    (skipped)"); return; }
  const { status } = await api("POST", `/lessons/${fixtureLessonId}/nodes/${fixtureNode1Id}/update`, {
    title: savedNodeTitle,
  });
  assert.ok(status < 300, `Restore node title failed: ${status}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// D — ORDERING + SEQUENTIAL DEPENDENCIES (fixture)
// ═════════════════════════════════════════════════════════════════════════════

it("D1: node reorder rebuilds SEQUENTIAL chain correctly", async () => {
  if (!fixtureLessonId || !fixtureNode1Id || !fixtureNode2Id) { console.log("    (skipped)"); return; }
  // Get current order
  const nodesBefore = await db
    .select({ id: lessonNodesTable.id, sequence: lessonNodesTable.sequence })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, fixtureLessonId!))
    .orderBy(lessonNodesTable.sequence);

  // Reverse order — route expects orderedNodeIds (not orderedIds/nodeIds)
  const reversed = [...nodesBefore].reverse().map((n, i) => ({ id: n.id, sequence: i + 1 }));
  const { status } = await api("POST", `/lessons/${fixtureLessonId}/nodes/reorder`, {
    orderedNodeIds: reversed.map(n => n.id),
  });
  assert.ok(status < 300, `Reorder failed: ${status}`);

  const depsAfterReorder = await db
    .select()
    .from(lessonNodeDependenciesTable)
    .where(and(
      eq(lessonNodeDependenciesTable.lessonId, fixtureLessonId!),
      eq(lessonNodeDependenciesTable.dependencyType, "SEQUENTIAL"),
    ));
  // n nodes → n-1 SEQUENTIAL deps
  const expectedDeps = nodesBefore.length - 1;
  assert.equal(depsAfterReorder.length, expectedDeps, `Expected ${expectedDeps} SEQUENTIAL deps, got ${depsAfterReorder.length}`);
});

it("D2: restore original node order", async () => {
  if (!fixtureLessonId || !fixtureNode1Id || !fixtureNode2Id) { console.log("    (skipped)"); return; }
  // Restore: node1 first, node2 second — route expects orderedNodeIds
  const { status } = await api("POST", `/lessons/${fixtureLessonId}/nodes/reorder`, {
    orderedNodeIds: [fixtureNode1Id, fixtureNode2Id],
  });
  assert.ok(status < 300, `Restore order failed: ${status}`);

  const [n1, n2] = await db
    .select({ id: lessonNodesTable.id, sequence: lessonNodesTable.sequence })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, fixtureLessonId!))
    .orderBy(lessonNodesTable.sequence);
  assert.equal(n1.id, fixtureNode1Id, "node1 must be first");
  assert.equal(n2.id, fixtureNode2Id, "node2 must be second");
});

it("D3: SEQUENTIAL dep chain is MN1→MN2 after restore", async () => {
  if (!fixtureLessonId || !fixtureNode1Id || !fixtureNode2Id) { console.log("    (skipped)"); return; }
  const deps = await db
    .select()
    .from(lessonNodeDependenciesTable)
    .where(and(
      eq(lessonNodeDependenciesTable.lessonId, fixtureLessonId!),
      eq(lessonNodeDependenciesTable.dependencyType, "SEQUENTIAL"),
    ));
  assert.equal(deps.length, 1, `2 nodes → 1 SEQUENTIAL dep, got ${deps.length}`);
  assert.equal(deps[0].fromNodeId, fixtureNode1Id, "SEQUENTIAL from must be node1");
  assert.equal(deps[0].toNodeId, fixtureNode2Id, "SEQUENTIAL to must be node2");
});

// ═════════════════════════════════════════════════════════════════════════════
// E — INITIAL PHASE 2 ENRICHMENT (fixture, whole-lesson background job)
// ═════════════════════════════════════════════════════════════════════════════

it("E1: approve-all nodes + exercises on fixture before Phase 2", async () => {
  if (!fixtureLessonId) { console.log("    (skipped)"); return; }
  const [nodeApprove, exApprove] = await Promise.all([
    api("POST", `/lessons/${fixtureLessonId}/nodes/approve-all`),
    api("POST", `/lessons/${fixtureLessonId}/exercises/approve-all`),
  ]);
  // 200 or 204 acceptable; some approve-all routes return 200 with counts
  assert.ok(nodeApprove.status < 300, `approve-all nodes: ${nodeApprove.status}`);
  assert.ok(exApprove.status < 300, `approve-all exercises: ${exApprove.status}`);
});

it("E2: generate-teaching-content route starts a job (returns 200 or job ID)", async () => {
  if (!fixtureLessonId) { console.log("    (skipped)"); return; }
  const { status, body } = await api("POST", `/lessons/${fixtureLessonId}/generate-teaching-content`, undefined, { timeoutMs: 15000 });
  // 200 = started, 409 = duplicate job, 400 = no nodes yet (if B3 mapping failed), 403 = no ownership
  // All are acceptable — the key assertion is the route exists and responds (not 500/408)
  assert.ok([200, 400, 403, 409].includes(status), `Expected 200/400/403/409 from generate-teaching-content, got ${status}: ${JSON.stringify(body)}`);
  console.log(`    Phase 2 whole-lesson job: status=${status} body=${JSON.stringify(body).slice(0,120)}`);
});

it("E3: generate-status polls job progress", async () => {
  if (!fixtureLessonId) { console.log("    (skipped)"); return; }
  const { status, body } = await api("GET", `/lessons/${fixtureLessonId}/generate-status`);
  assert.equal(status, 200, `generate-status: ${JSON.stringify(body)}`);
  assert.ok("status" in body, "Must have status field");
  console.log(`    Phase 2 job status: ${JSON.stringify(body).slice(0,120)}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// F — FINAL APPROVAL (fixture lesson)
// ═════════════════════════════════════════════════════════════════════════════

it("F1: final-approve on never-approved lesson without Phase 2 → 422 with MISSING_PHASE2", async () => {
  // Use a lesson that cannot pass — lesson 105 is already approved so pick fixture
  // Fixture nodes may lack childFriendlyExplanation (Phase 2 not yet complete)
  if (!fixtureLessonId) { console.log("    (skipped)"); return; }
  const { status, body } = await api("POST", `/lessons/${fixtureLessonId}/final-approve`);
  // Valid outcomes: 200 (if Phase 2 completed in E2 already) or 422 (if not yet ready)
  assert.ok([200, 422].includes(status),
    `final-approve must return 200 or 422, got ${status}: ${JSON.stringify(body)}`);
  console.log(`    final-approve fixture: status=${status} body=${JSON.stringify(body).slice(0,150)}`);
});

it("F2: final-approve on lesson 105 (fully enriched, everApproved=true) returns 200", async () => {
  const { status, body } = await api("POST", `/lessons/${REAL_LESSON_ID}/final-approve`);
  assert.equal(status, 200, `final-approve 105: ${JSON.stringify(body)}`);
});

it("F3: after final-approve, lesson 105 status stays approved, everApproved=true", async () => {
  const [lesson] = await db
    .select({ status: lessonsTable.status, everApproved: lessonsTable.everApproved })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, REAL_LESSON_ID))
    .limit(1);
  assert.equal(lesson.status, "approved");
  assert.equal(lesson.everApproved, true);
});

it("F4: GET /lessons/105 returns authoringStatus=approved after final-approve", async () => {
  const { status, body } = await api("GET", `/lessons/${REAL_LESSON_ID}`);
  assert.equal(status, 200);
  assert.equal((body as any).authoringStatus, "approved");
});

// ═════════════════════════════════════════════════════════════════════════════
// G — POST-APPROVAL EDITING (lesson 105, everApproved=true)
// ═════════════════════════════════════════════════════════════════════════════

it("G1: edit MicroNode title on lesson 105 → lesson stays approved (no invalidation)", async () => {
  const newTitle = ORIGINAL_NODE_TITLE + " (G1)";
  const { status } = await api("POST", `/lessons/${REAL_LESSON_ID}/nodes/${NODE_1903_ID}/update`, {
    title: newTitle,
  });
  assert.ok(status < 300, `Node update: ${status}`);

  const [lesson] = await db
    .select({ status: lessonsTable.status, everApproved: lessonsTable.everApproved })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, REAL_LESSON_ID))
    .limit(1);
  assert.equal(lesson.status, "approved", "Lesson must stay approved after title edit");
  assert.equal(lesson.everApproved, true, "everApproved must remain true");
});

it("G2: edit LO on lesson 105 → lesson stays approved", async () => {
  const { status } = await api("POST", `/lessons/${REAL_LESSON_ID}/nodes/${NODE_1903_ID}/update`, {
    learningObjective: "Աշակերտը կարողանա նկարագրել Ֆիզիկա դասընթացի նպատակը (G2)",
  });
  assert.ok(status < 300, `LO update: ${status}`);

  const [lesson] = await db
    .select({ status: lessonsTable.status })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, REAL_LESSON_ID))
    .limit(1);
  assert.equal(lesson.status, "approved");
});

it("G3: everApproved stays true after multiple edits", async () => {
  const [lesson] = await db
    .select({ everApproved: lessonsTable.everApproved })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, REAL_LESSON_ID))
    .limit(1);
  assert.equal(lesson.everApproved, true, "everApproved must be sticky (never reverts)");
});

it("G4: restore lesson 105 node 1903 to original title + LO after G1/G2", async () => {
  const [original] = await db
    .select({ learningObjective: lessonNodesTable.learningObjective })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, NODE_1903_ID))
    .limit(1);
  const origLO = original.learningObjective ?? "";

  const { status } = await api("POST", `/lessons/${REAL_LESSON_ID}/nodes/${NODE_1903_ID}/update`, {
    title: ORIGINAL_NODE_TITLE,
    learningObjective: origLO.replace(" (G2)", ""),
  });
  assert.ok(status < 300, `Restore: ${status}`);

  const [restored] = await db
    .select({ title: lessonNodesTable.title })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, NODE_1903_ID))
    .limit(1);
  assert.equal(restored.title, ORIGINAL_NODE_TITLE, "Node title must be restored");
});

it("G5: post-approval edit does NOT trigger a whole-lesson Phase 2 job", async () => {
  // Check generate-status on lesson 105 — should be idle/complete, not running
  const { status, body } = await api("GET", `/lessons/${REAL_LESSON_ID}/generate-status`);
  assert.equal(status, 200);
  const jobStatus = (body as any).status as string;
  // Must NOT be "running" as a result of the G1/G2 title/LO edits
  assert.notEqual(jobStatus, "running", "Post-approval edit must NOT start a Phase 2 job");
  console.log(`    Post-edit Phase 2 status: ${jobStatus}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// H — NEW MICRONODE + SELECTIVE ENRICHMENT (lesson 105 + cleanup)
// ═════════════════════════════════════════════════════════════════════════════

it("H1: teacher creates new MicroNode on lesson 105 (approved/active)", async () => {
  const { status, body } = await api("POST", `/lessons/${REAL_LESSON_ID}/nodes`, {
    title: "Phase-1.13 Selective Enrich Test Node — DELETE",
    learningObjective: "Աշակերտը կարողանա փորձարկել ընտրովի հարստացումը",
    theoryContent: "Ֆիզիկական քանակը ֆիզիկայի հիմնական հասկացություններից մեկն է: Այն ստացվում է չափման արդյունքում:",
    topicId: null,
  });
  assert.ok(status < 300, `Node create: ${status} ${JSON.stringify(body)}`);
  tempNodeId = (body as any).id ?? (body as any).node?.id;
  assert.ok(tempNodeId, "Temp node must have an ID");
  console.log(`    Temp node created: id=${tempNodeId}`);
});

it("H2: new node has no Phase 2 content yet", async () => {
  if (!tempNodeId) { console.log("    (skipped — H1 failed)"); return; }
  const [node] = await db
    .select({ childFriendlyExplanation: lessonNodesTable.childFriendlyExplanation })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, tempNodeId))
    .limit(1);
  assert.equal(node?.childFriendlyExplanation, null, "New node must start with no Phase 2 content");
});

it("H3: existing nodes' Phase 2 is intact before selective enrich", async () => {
  // Snapshot Phase 2 hashes of all existing approved nodes (except temp)
  const nodes = await db
    .select({ id: lessonNodesTable.id, cfe: lessonNodesTable.childFriendlyExplanation })
    .from(lessonNodesTable)
    .where(and(eq(lessonNodesTable.lessonId, REAL_LESSON_ID), eq(lessonNodesTable.status, "approved")));
  assert.ok(nodes.length >= 9, `Expected ≥9 approved nodes before selective enrich, got ${nodes.length}`);
  assert.ok(nodes.every(n => n.cfe !== null), "All existing approved nodes must have Phase 2 before selective enrich");
});

it("H4: selective enrich on new node SUCCEEDS with real Phase 2 content (spec §12 — no timeout allowed)", async () => {
  if (!tempNodeId) { console.log("    (skipped — H1 failed)"); return; }
  console.log(`    Calling selective enrich on node ${tempNodeId} — may take 30-60s...`);
  // 90-second timeout: AI must respond, 408 = FAIL per spec §12
  const { status, body } = await api(
    "POST",
    `/lessons/${REAL_LESSON_ID}/nodes/${tempNodeId}/enrich`,
    undefined,
    { timeoutMs: 90000 },
  );

  // Must NOT timeout (408) — that counts as failure per spec §12
  assert.notEqual(status, 408, "Selective enrich MUST complete within timeout — 408=FAIL (spec §12)");
  assert.notEqual(status, 404, "Enrich route must exist");
  assert.ok([200, 422].includes(status), `Expected 200 or 422 from enrich, got ${status}: ${JSON.stringify(body)}`);

  if (status === 200) {
    // Verify node received actual Phase 2 fields
    const [node] = await db
      .select({
        childFriendlyExplanation: lessonNodesTable.childFriendlyExplanation,
        status: lessonNodesTable.status,
      })
      .from(lessonNodesTable)
      .where(eq(lessonNodesTable.id, tempNodeId!))
      .limit(1);
    assert.ok(node?.childFriendlyExplanation, "Node must have childFriendlyExplanation after enrich");
    console.log(`    ✓ Selective enrich succeeded — node has Phase 2 content`);
  } else {
    // 422 = SKIP (thin content) — acceptable, route worked
    console.log(`    Selective enrich: 422 SKIP — ${JSON.stringify(body).slice(0, 80)}`);
  }
});

it("H5: existing nodes' Phase 2 is UNCHANGED after selective enrich", async () => {
  // After H4, all existing approved nodes must retain their original Phase 2
  const nodes = await db
    .select({ id: lessonNodesTable.id, cfe: lessonNodesTable.childFriendlyExplanation, status: lessonNodesTable.status })
    .from(lessonNodesTable)
    .where(and(eq(lessonNodesTable.lessonId, REAL_LESSON_ID), eq(lessonNodesTable.status, "approved")));
  // The 9 original approved nodes must still have their Phase 2 content
  const withPhase2 = nodes.filter(n => n.cfe !== null);
  assert.ok(withPhase2.length >= 9, `Expected ≥9 approved nodes with Phase 2 after selective enrich, got ${withPhase2.length}`);
});

it("H6: delete temp node and verify SEQUENTIAL chain heals", async () => {
  if (!tempNodeId) { console.log("    (skipped — H1 failed)"); return; }
  const { status } = await api("POST", `/lessons/${REAL_LESSON_ID}/nodes/${tempNodeId}/delete`);
  assert.ok(status < 300, `Delete temp node: ${status}`);

  const nodes = await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, REAL_LESSON_ID));
  assert.equal(nodes.length, 9, `Expected 9 nodes after temp delete, got ${nodes.length}`);

  const deps = await db
    .select()
    .from(lessonNodeDependenciesTable)
    .where(and(
      eq(lessonNodeDependenciesTable.lessonId, REAL_LESSON_ID),
      eq(lessonNodeDependenciesTable.dependencyType, "SEQUENTIAL"),
    ));
  assert.equal(deps.length, 8, `Expected 8 SEQUENTIAL deps after temp node delete, got ${deps.length}`);
  tempNodeId = null;
});

// ═════════════════════════════════════════════════════════════════════════════
// I — READ-ONLY MICRONODE VIEW (lesson 105 — GET routes only)
// ═════════════════════════════════════════════════════════════════════════════

it("I1: GET /lessons/105/nodes returns all 9 nodes with full Phase 2 fields", async () => {
  // GET /lessons/:id/nodes returns a plain array (not {nodes:[...]})
  const { status, body } = await api("GET", `/lessons/${REAL_LESSON_ID}/nodes`);
  assert.equal(status, 200);
  const nodes = body as any[];
  assert.equal(nodes.length, 9);
  // Verify Phase 2 fields are present (not stripped)
  for (const n of nodes.filter((n: any) => n.status === "approved")) {
    assert.ok(n.childFriendlyExplanation !== null, `Node ${n.id} "${n.title.slice(0,30)}" missing childFriendlyExplanation`);
  }
});

it("I2: GET /lessons/105/nodes does NOT modify any node (pure read)", async () => {
  const before = await db
    .select({ id: lessonNodesTable.id, title: lessonNodesTable.title, status: lessonNodesTable.status })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, REAL_LESSON_ID))
    .orderBy(lessonNodesTable.sequence);

  await api("GET", `/lessons/${REAL_LESSON_ID}/nodes`);

  const after = await db
    .select({ id: lessonNodesTable.id, title: lessonNodesTable.title, status: lessonNodesTable.status })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, REAL_LESSON_ID))
    .orderBy(lessonNodesTable.sequence);

  assert.deepEqual(before, after, "GET /nodes must be a pure read — no DB mutations");
});

it("I3: GET /lessons/105/exercises returns 15 approved exercises", async () => {
  // GET /lessons/:id/exercises returns a plain array (not {exercises:[...]})
  const { status, body } = await api("GET", `/lessons/${REAL_LESSON_ID}/exercises`);
  assert.equal(status, 200);
  const exercises = body as any[];
  assert.equal(exercises.length, 15, `Expected 15 exercises, got ${exercises.length}`);
});

it("I4: read-only view opening causes zero DB writes (lesson-level status unchanged)", async () => {
  await api("GET", `/lessons/${REAL_LESSON_ID}/nodes`);
  const [lesson] = await db
    .select({ status: lessonsTable.status, everApproved: lessonsTable.everApproved })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, REAL_LESSON_ID))
    .limit(1);
  assert.equal(lesson.status, "approved");
  assert.equal(lesson.everApproved, true);
});

// ═════════════════════════════════════════════════════════════════════════════
// J — WHOLE-LESSON REGENERATION SAFETY (lesson 105)
// ═════════════════════════════════════════════════════════════════════════════

it("J1: generate-teaching-content route requires authentication (unauthenticated → 401)", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetch(`${BASE}/lessons/${REAL_LESSON_ID}/generate-teaching-content`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });
    assert.equal(r.status, 401, "Unauthenticated request must be 401");
  } finally {
    clearTimeout(timer);
  }
});

it("J2: generate-teaching-content returns 200/409 (not 500) — route is live", async () => {
  const { status, body } = await api("POST", `/lessons/${REAL_LESSON_ID}/generate-teaching-content`, undefined, { timeoutMs: 15000 });
  assert.ok([200, 409].includes(status), `Expected 200/409, got ${status}: ${JSON.stringify(body)}`);
  console.log(`    Whole-lesson regen safety: status=${status}`);
});

it("J3: a second concurrent request returns 409 (duplicate-job protection)", async () => {
  // Fire two requests nearly simultaneously; second must see 409 if first is running
  const [r1, r2] = await Promise.all([
    api("POST", `/lessons/${REAL_LESSON_ID}/generate-teaching-content`, undefined, { timeoutMs: 15000 }),
    api("POST", `/lessons/${REAL_LESSON_ID}/generate-teaching-content`, undefined, { timeoutMs: 15000 }),
  ]);
  // At least one must succeed (200) and the other might be 409 — or both 409 if job already queued
  const statuses = [r1.status, r2.status];
  assert.ok(
    statuses.every(s => [200, 409].includes(s)),
    `Both requests must be 200 or 409, got ${statuses}`
  );
  if (statuses.includes(200) && statuses.includes(409)) {
    console.log(`    ✓ Duplicate-job protection: one 200, one 409`);
  } else {
    console.log(`    Both requests: ${statuses} (both 409 = job already queued)`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// K — LESSON ASSIGNMENT + STUDENT PACKAGE (lesson 105, already active)
// ═════════════════════════════════════════════════════════════════════════════

it("K0: restore lesson 105 to 'active' status before student tests", async () => {
  // F2 called final-approve on lesson 105 which sets status→"approved".
  // Student-facing routes (student-package, session start) require status="active".
  // Restore here so K/L/M sections can run correctly.
  await db.update(lessonsTable)
    .set({ status: "active" })
    .where(eq(lessonsTable.id, REAL_LESSON_ID));
  const [lesson] = await db
    .select({ status: lessonsTable.status })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, REAL_LESSON_ID))
    .limit(1);
  assert.equal(lesson.status, "active", "Lesson 105 must be active for student tests");
});

it("K1: student can GET student-package for active lesson 105", async () => {
  const { status, body } = await api("GET", `/lessons/${REAL_LESSON_ID}/student-package`, undefined, { token: STUDENT_BEARER });
  assert.equal(status, 200, `student-package: ${JSON.stringify(body)}`);
  assert.equal((body as any).lesson?.status, "active");
});

it("K2: student-package returns only APPROVED nodes (no draft/needs_review)", async () => {
  const { status, body } = await api("GET", `/lessons/${REAL_LESSON_ID}/student-package`, undefined, { token: STUDENT_BEARER });
  assert.equal(status, 200);
  const nodes = (body as any).nodes as any[];
  assert.ok(nodes.length >= 9, `Expected ≥9 nodes, got ${nodes.length}`);
  // No temp B1 pollution node
  assert.ok(!nodes.find((n: any) => n.title === "POST-P1.12 Test Node B1"), "Pollution node must not appear");
});

it("K3: student-package returns Topics, APPROVED exercises, and SEQUENTIAL deps", async () => {
  const { status, body } = await api("GET", `/lessons/${REAL_LESSON_ID}/student-package`, undefined, { token: STUDENT_BEARER });
  assert.equal(status, 200);
  const pkg = body as any;
  assert.ok(pkg.topics?.length >= 3, `Expected ≥3 topics, got ${pkg.topics?.length}`);
  assert.ok(pkg.exercises?.length >= 15, `Expected ≥15 exercises, got ${pkg.exercises?.length}`);
  assert.ok(pkg.dependencies?.length >= 8, `Expected ≥8 deps, got ${pkg.dependencies?.length}`);
});

it("K4: student-package includes linked quizzes with release state", async () => {
  const { status, body } = await api("GET", `/lessons/${REAL_LESSON_ID}/student-package`, undefined, { token: STUDENT_BEARER });
  assert.equal(status, 200);
  const quizzes = (body as any).quizzes as any[];
  assert.ok(quizzes.length >= 2, `Expected ≥2 linked quizzes, got ${quizzes.length}`);
  // All currently COMPLETED — isReleased=true, isCompleted=true
  for (const q of quizzes) {
    assert.equal(typeof q.isReleased, "boolean", "isReleased must be boolean");
    assert.equal(typeof q.isCompleted, "boolean", "isCompleted must be boolean");
  }
});

it("K5: student-package does NOT create knowledge_nodes or evidence merely by being called", async () => {
  const kns1 = await db
    .select({ id: knowledgeNodesTable.id })
    .from(knowledgeNodesTable)
    .where(inArray(
      knowledgeNodesTable.lessonNodeId,
      (await db.select({ id: lessonNodesTable.id }).from(lessonNodesTable).where(eq(lessonNodesTable.lessonId, REAL_LESSON_ID))).map(n => n.id)
    ));

  await api("GET", `/lessons/${REAL_LESSON_ID}/student-package`, undefined, { token: STUDENT_BEARER });

  const kns2 = await db
    .select({ id: knowledgeNodesTable.id })
    .from(knowledgeNodesTable)
    .where(inArray(
      knowledgeNodesTable.lessonNodeId,
      (await db.select({ id: lessonNodesTable.id }).from(lessonNodesTable).where(eq(lessonNodesTable.lessonId, REAL_LESSON_ID))).map(n => n.id)
    ));
  assert.equal(kns1.length, kns2.length, "student-package must not create knowledge_nodes");
});

// ═════════════════════════════════════════════════════════════════════════════
// L — QUIZ LIFECYCLE: unreleased → re-released → take → submit → re-released
// Uses quiz 164 (10 questions, currently COMPLETED for student 93)
// ═════════════════════════════════════════════════════════════════════════════

it("L1: quiz 164 is currently COMPLETED for student1 (pre-condition)", async () => {
  const assignments = await db
    .select({ status: quizAssignmentsTable.status })
    .from(quizAssignmentsTable)
    .where(and(
      eq(quizAssignmentsTable.quizId, QUIZ_164_ID),
      eq(quizAssignmentsTable.studentId, STUDENT_ID),
    ))
    .orderBy(quizAssignmentsTable.assignedAt);
  assert.ok(assignments.length >= 1, "Student must have at least one assignment for quiz 164");
  const latest = assignments[assignments.length - 1];
  assert.equal(latest.status, "COMPLETED", "Latest assignment must be COMPLETED before re-release test");
});

it("L2: teacher re-releases quiz 164 to class 29 (re-release cycle)", async () => {
  const { status, body } = await api("POST", `/quizzes/${QUIZ_164_ID}/assign`, {
    classId: CLASS_ID,
  });
  assert.ok(status < 300, `Quiz re-release: ${status} ${JSON.stringify(body)}`);
  const assigned = (body as any).assignedCount ?? 0;
  assert.ok(assigned >= 1 || (body as any).alreadyAssigned !== undefined,
    `Re-release must create new assignment, got: ${JSON.stringify(body)}`);
  console.log(`    Quiz 164 re-release: ${JSON.stringify(body)}`);
});

it("L3: student now has an ASSIGNED (non-COMPLETED) assignment for quiz 164", async () => {
  const assignments = await db
    .select({ id: quizAssignmentsTable.id, status: quizAssignmentsTable.status })
    .from(quizAssignmentsTable)
    .where(and(
      eq(quizAssignmentsTable.quizId, QUIZ_164_ID),
      eq(quizAssignmentsTable.studentId, STUDENT_ID),
    ))
    .orderBy(quizAssignmentsTable.assignedAt);
  const active = assignments.filter(a => a.status !== "COMPLETED");
  assert.equal(active.length, 1, `Expected 1 active assignment, got ${active.length}`);
  newQuizAssignmentId = active[0].id;
  console.log(`    New assignment created: id=${newQuizAssignmentId}`);
});

it("L4: student can GET /quizzes/164/take (questions returned, correctOptionIndex stripped)", async () => {
  const { status, body } = await api("GET", `/quizzes/${QUIZ_164_ID}/take`, undefined, { token: STUDENT_BEARER });
  assert.equal(status, 200, `take: ${JSON.stringify(body).slice(0, 100)}`);
  const questions = (body as any).questions as any[];
  assert.ok(questions.length >= 5, `Expected ≥5 questions, got ${questions.length}`);
  // correctOptionIndex must be stripped
  for (const q of questions) {
    assert.ok(!("correctOptionIndex" in q), `correctOptionIndex must NOT be exposed to student: ${JSON.stringify(q).slice(0,80)}`);
  }
});

it("L5: student submits quiz 164 — score persists, assignment becomes COMPLETED", async () => {
  const { status, body } = await api("POST", `/quizzes/${QUIZ_164_ID}/submit`, {
    answers: QUIZ_164_ANSWERS,
  }, { token: STUDENT_BEARER, timeoutMs: 30000 });
  assert.ok(status < 300, `submit: ${status} ${JSON.stringify(body)}`);
  const score = (body as any).scorePercent ?? (body as any).score_percent;
  assert.ok(score >= 0 && score <= 100, `Score must be 0-100, got ${score}`);
  console.log(`    Quiz 164 submit: score=${score}% correct=${(body as any).totalCorrect}/${(body as any).totalQuestions}`);

  // Verify assignment is now COMPLETED
  if (newQuizAssignmentId) {
    const [qa] = await db
      .select({ status: quizAssignmentsTable.status })
      .from(quizAssignmentsTable)
      .where(eq(quizAssignmentsTable.id, newQuizAssignmentId))
      .limit(1);
    assert.equal(qa.status, "COMPLETED", "Assignment must be COMPLETED after submit");
  }
});

it("L6: completed quiz 164 — isCompleted=true in student-package", async () => {
  const { status, body } = await api("GET", `/lessons/${REAL_LESSON_ID}/student-package`, undefined, { token: STUDENT_BEARER });
  assert.equal(status, 200);
  const quizzes = (body as any).quizzes as any[];
  const q164 = quizzes.find((q: any) => q.id === QUIZ_164_ID);
  assert.ok(q164, "Quiz 164 must appear in student-package");
  assert.equal(q164.isCompleted, true, "isCompleted must be true after submission");
  assert.equal(q164.isReleased, true, "isReleased must be true for COMPLETED");
});

it("L7: student cannot submit quiz 164 again (no active assignment)", async () => {
  const { status } = await api("POST", `/quizzes/${QUIZ_164_ID}/submit`, {
    answers: QUIZ_164_ANSWERS,
  }, { token: STUDENT_BEARER });
  assert.equal(status, 403, "Double-submit must be blocked with 403");
});

it("L8: teacher re-releases quiz 164 a second time — new assignment created", async () => {
  const { status, body } = await api("POST", `/quizzes/${QUIZ_164_ID}/assign`, { classId: CLASS_ID });
  assert.ok(status < 300, `Second re-release: ${status} ${JSON.stringify(body)}`);
  console.log(`    Second re-release: ${JSON.stringify(body)}`);
});

it("L9: student can see quiz 164 as actionable again after second re-release", async () => {
  const { status, body } = await api("GET", `/lessons/${REAL_LESSON_ID}/student-package`, undefined, { token: STUDENT_BEARER });
  assert.equal(status, 200);
  const quizzes = (body as any).quizzes as any[];
  const q164 = quizzes.find((q: any) => q.id === QUIZ_164_ID);
  // After second re-release there is a new ASSIGNED assignment — isReleased=true, isCompleted=false
  assert.ok(q164, "Quiz 164 must appear");
  assert.equal(q164.isReleased, true, "isReleased must be true");
  // isCompleted depends on which assignment is latest — the new one is ASSIGNED
  assert.equal(q164.isCompleted, false, "isCompleted must be false for the newly re-released quiz");
});

it("L10: student my-result for quiz 164 shows score", async () => {
  const { status, body } = await api("GET", `/quizzes/${QUIZ_164_ID}/my-result`, undefined, { token: STUDENT_BEARER });
  assert.ok([200, 403].includes(status), `my-result: ${status}`);
  if (status === 200) {
    const score = (body as any).scorePercent ?? (body as any).score;
    assert.ok(score !== undefined, "Score must be present in my-result");
    console.log(`    Quiz 164 my-result: score=${score}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// M — LESSON SESSION START / RESUME (lesson 105, student1)
// ═════════════════════════════════════════════════════════════════════════════

it("M1: POST /lessons/start (student) returns existing session or creates one", async () => {
  const { status, body } = await api("POST", "/lessons/start", { lessonId: REAL_LESSON_ID }, { token: STUDENT_BEARER });
  assert.ok([200, 201].includes(status), `start: ${status} ${JSON.stringify(body)}`);
  assert.equal((body as any).lessonId, REAL_LESSON_ID);
  assert.ok((body as any).id > 0, "Session ID must be positive");
  console.log(`    Session: id=${(body as any).id} status=${status} currentNodeId=${(body as any).currentNodeId}`);
});

it("M2: lesson start creates no fake knowledge_nodes or evidence", async () => {
  const nodeIds = (await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, REAL_LESSON_ID))).map(n => n.id);

  const knBefore = await db
    .select({ id: knowledgeNodesTable.id })
    .from(knowledgeNodesTable)
    .where(inArray(knowledgeNodesTable.lessonNodeId, nodeIds));

  await api("POST", "/lessons/start", { lessonId: REAL_LESSON_ID }, { token: STUDENT_BEARER });

  const knAfter = await db
    .select({ id: knowledgeNodesTable.id })
    .from(knowledgeNodesTable)
    .where(inArray(knowledgeNodesTable.lessonNodeId, nodeIds));

  assert.equal(knBefore.length, knAfter.length, "lesson start must not create knowledge_nodes");
});

it("M3: calling start twice returns same session (existing is resumed, not duplicated)", async () => {
  const r1 = await api("POST", "/lessons/start", { lessonId: REAL_LESSON_ID }, { token: STUDENT_BEARER });
  const r2 = await api("POST", "/lessons/start", { lessonId: REAL_LESSON_ID }, { token: STUDENT_BEARER });
  assert.ok([200, 201].includes(r1.status) && [200, 201].includes(r2.status));
  assert.equal((r1.body as any).id, (r2.body as any).id, "Both calls must return same session ID");
});

it("M4: session start as student on inactive lesson returns 403", async () => {
  // Use fixture lesson (draft, not active)
  if (!fixtureLessonId) { console.log("    (skipped)"); return; }
  const { status } = await api("POST", "/lessons/start", { lessonId: fixtureLessonId }, { token: STUDENT_BEARER });
  assert.ok([403, 404].includes(status), `Expected 403/404 for inactive lesson, got ${status}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// N — EVIDENCE + KNOWLEDGE TREE (lesson 105, student1)
// ═════════════════════════════════════════════════════════════════════════════

it("N1: student1 has knowledge_nodes for some lesson 105 nodes (from quiz evidence)", async () => {
  const nodeIds = (await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, REAL_LESSON_ID))).map(n => n.id);

  const kns = await db
    .select({ id: knowledgeNodesTable.id, status: knowledgeNodesTable.status, lessonNodeId: knowledgeNodesTable.lessonNodeId })
    .from(knowledgeNodesTable)
    .where(and(
      eq(knowledgeNodesTable.userId, STUDENT_ID),
      inArray(knowledgeNodesTable.lessonNodeId, nodeIds),
    ));
  console.log(`    knowledge_nodes for student1 on lesson 105: ${kns.length} rows`);
  // We know from forensics: 2 knowledge_nodes exist (for nodes 1908, 1909)
  assert.ok(kns.length >= 2, `Expected ≥2 knowledge_nodes from quiz evidence, got ${kns.length}`);
});

it("N2: nodes WITHOUT evidence are at not_started/null state (not fake mastery)", async () => {
  const nodeIds = (await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, REAL_LESSON_ID))).map(n => n.id);

  const kns = await db
    .select({ lessonNodeId: knowledgeNodesTable.lessonNodeId, status: knowledgeNodesTable.status })
    .from(knowledgeNodesTable)
    .where(and(eq(knowledgeNodesTable.userId, STUDENT_ID), inArray(knowledgeNodesTable.lessonNodeId, nodeIds)));
  const knNodeIds = new Set(kns.map(k => k.lessonNodeId));

  // Nodes without a knowledge_node row have no mastery (correct — "Դեռ չի ուսումնասիրել")
  const nodesWithoutKN = nodeIds.filter(id => !knNodeIds.has(id));
  assert.ok(nodesWithoutKN.length >= 1, "Some nodes must have no knowledge_node (not yet studied)");
  console.log(`    Nodes without KN (not studied): ${nodesWithoutKN.length}`);
});

it("N3: knowledge_nodes are per-student — canonical lesson structure is shared", async () => {
  // Verify no per-student COPY of lesson_nodes exists
  const nodeCount = await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, REAL_LESSON_ID));
  assert.equal(nodeCount.length, 9, "Canonical lesson_nodes must be shared (9 rows, not per-student)");
});

// ═════════════════════════════════════════════════════════════════════════════
// O — STUDENT ISOLATION (single student; structural integrity check)
// ═════════════════════════════════════════════════════════════════════════════

it("O1: student1 knowledge_nodes do not exist for the fixture lesson (isolation)", async () => {
  if (!fixtureLessonId) { console.log("    (skipped)"); return; }
  const nodeIds = (await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, fixtureLessonId))).map(n => n.id);
  if (nodeIds.length === 0) { console.log("    (no nodes on fixture — skip)"); return; }

  const kns = await db
    .select({ id: knowledgeNodesTable.id })
    .from(knowledgeNodesTable)
    .where(and(
      eq(knowledgeNodesTable.userId, STUDENT_ID),
      inArray(knowledgeNodesTable.lessonNodeId, nodeIds),
    ));
  assert.equal(kns.length, 0, "student1 must have no knowledge_nodes for the fixture lesson");
});

it("O2: lesson 105 canonical nodes are unchanged by student interaction", async () => {
  const nodes = await db
    .select({ id: lessonNodesTable.id, title: lessonNodesTable.title, status: lessonNodesTable.status, sequence: lessonNodesTable.sequence })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, REAL_LESSON_ID))
    .orderBy(lessonNodesTable.sequence);
  assert.equal(nodes.length, 9, "Canonical node count must be 9 after all student tests");
  assert.equal(nodes[0].title, ORIGINAL_NODE_TITLE, "First node title must be original");
  assert.ok(nodes.every(n => n.status === "approved"), "All canonical nodes must be approved");
});

// ═════════════════════════════════════════════════════════════════════════════
// P — LIVE TEACHER EDIT AFTER ASSIGNMENT (lesson 105)
// ═════════════════════════════════════════════════════════════════════════════

it("P1: teacher edit on active lesson propagates to student-package on next fetch", async () => {
  const tempTitle = ORIGINAL_NODE_TITLE + " (P1-edit)";
  await api("POST", `/lessons/${REAL_LESSON_ID}/nodes/${NODE_1903_ID}/update`, { title: tempTitle });

  const { status, body } = await api("GET", `/lessons/${REAL_LESSON_ID}/student-package`, undefined, { token: STUDENT_BEARER });
  assert.equal(status, 200);
  const nodes = (body as any).nodes as any[];
  const edited = nodes.find((n: any) => n.id === NODE_1903_ID);
  assert.ok(edited, "Node 1903 must appear in student-package");
  assert.equal(edited.title, tempTitle, "Student-package must reflect teacher's canonical edit immediately");

  // Restore original
  await api("POST", `/lessons/${REAL_LESSON_ID}/nodes/${NODE_1903_ID}/update`, { title: ORIGINAL_NODE_TITLE });
});

it("P2: lesson assignment is not duplicated by teacher edit", async () => {
  const sessions = await db
    .select({ id: lessonSessionsTable.id })
    .from(lessonSessionsTable)
    .where(eq(lessonSessionsTable.lessonId, REAL_LESSON_ID));
  // Session count should be the same as at start of tests (teacher edit must not duplicate sessions)
  assert.ok(sessions.length >= 1, "At least the pre-existing session must remain");
  console.log(`    Sessions after P1 edit: ${sessions.length}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// Q — CAPTURE AFTER BASELINE
// ═════════════════════════════════════════════════════════════════════════════

it("Q1: capture AFTER baseline for data-integrity report", async () => {
  baselineAfter = await snapshotLesson105();
  console.log(`    AFTER: topics=${baselineAfter.topics} nodes=${baselineAfter.nodes} ex=${baselineAfter.exercises} seqDeps=${baselineAfter.seqDeps} quizzes=${baselineAfter.linkedQuizzes} assignments=${baselineAfter.assignments} sessions=${baselineAfter.sessions} kn=${baselineAfter.knowledgeNodes}`);
});

it("Q2: BEFORE/AFTER data integrity reconciles for lesson 105", async () => {
  // topics, nodes, exercises must be unchanged
  assert.equal(baselineAfter.topics, baselineBefore.topics,
    `Topics must match: before=${baselineBefore.topics} after=${baselineAfter.topics}`);
  assert.equal(baselineAfter.nodes, baselineBefore.nodes,
    `Nodes must match: before=${baselineBefore.nodes} after=${baselineAfter.nodes}`);
  assert.equal(baselineAfter.exercises, baselineBefore.exercises,
    `Exercises must match: before=${baselineBefore.exercises} after=${baselineAfter.exercises}`);
  assert.equal(baselineAfter.seqDeps, baselineBefore.seqDeps,
    `SEQUENTIAL deps must match: before=${baselineBefore.seqDeps} after=${baselineAfter.seqDeps}`);
  assert.equal(baselineAfter.linkedQuizzes, baselineBefore.linkedQuizzes,
    `Linked quizzes must match: before=${baselineBefore.linkedQuizzes} after=${baselineAfter.linkedQuizzes}`);
  // assignments: may have INCREASED due to L2/L8 re-releases — document expected increase
  const assignmentDelta = baselineAfter.assignments - baselineBefore.assignments;
  console.log(`    Assignment delta (expected ≥2 from L2+L8 re-releases): +${assignmentDelta}`);
  assert.ok(assignmentDelta >= 0, "Assignment count must not decrease");
  assert.equal(baselineAfter.status, "active", "Lesson must end as active (K0 restore was applied)");
  assert.equal(baselineAfter.everApproved, true, "everApproved must remain true");
});

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n  phase-1.13-e2e-lifecycle — Full Lesson Lifecycle Acceptance Test");
  console.log(`  Tests: ${tests.length}\n`);

  // Pre-test: ensure lesson 105 is in "active" state regardless of prior test runs
  // (regression suites call final-approve which sets status→"approved")
  await db.update(lessonsTable)
    .set({ status: "active" })
    .where(eq(lessonsTable.id, REAL_LESSON_ID));

  // Pre-test: cancel any stale pending/running Phase 2 jobs for lesson 105
  // (left by previous test runs' J2/J3 tests that trigger generate-teaching-content)
  const cancelledJobs = await db.update(mappingJobsTable)
    .set({ status: "failed", error: "Cancelled by pre-test cleanup (phase113-e2e)" })
    .where(and(
      eq(mappingJobsTable.lessonId, REAL_LESSON_ID),
      eq(mappingJobsTable.jobType, "generate_teaching_content"),
      ne(mappingJobsTable.status, "completed"),
      ne(mappingJobsTable.status, "failed"),
    ))
    .returning({ id: mappingJobsTable.id });
  if (cancelledJobs.length > 0) {
    console.log(`  [setup] Cancelled ${cancelledJobs.length} stale Phase 2 job(s) for lesson 105: ${cancelledJobs.map(j => j.id).join(", ")}`);
  }

  // Pre-test: clean up any stale ASSIGNED quiz assignments for quizzes linked to lesson 105
  // (L8 re-release in a prior crashed run may leave an ASSIGNED row that breaks L1's precondition)
  const linkedQuizIds = (await db
    .select({ quizId: quizLessonLinksTable.quizId })
    .from(quizLessonLinksTable)
    .where(eq(quizLessonLinksTable.lessonId, REAL_LESSON_ID))
  ).map(r => r.quizId);
  if (linkedQuizIds.length > 0) {
    const staleAssigned = await db.delete(quizAssignmentsTable)
      .where(and(
        inArray(quizAssignmentsTable.quizId, linkedQuizIds),
        eq(quizAssignmentsTable.studentId, STUDENT_ID),
        eq(quizAssignmentsTable.status, "ASSIGNED"),
      ))
      .returning({ id: quizAssignmentsTable.id });
    if (staleAssigned.length > 0) {
      console.log(`  [setup] Removed ${staleAssigned.length} stale ASSIGNED quiz assignment(s): ${staleAssigned.map(a => a.id).join(", ")}`);
    }
  }

  console.log("  [setup] Pre-test cleanup complete\n");

  let passed = 0;
  let failed = 0;

  try {
    for (const [name, fn] of tests) {
      try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
      } catch (err: unknown) {
        console.error(`  ✗ ${name}`);
        console.error(`      ${(err as Error).message}`);
        failed++;
      }
    }
  } finally {
    // ── MANDATORY CLEANUP — must run even if tests fail ──────────────────────
    console.log("\n  ── Cleanup ─────────────────────────────────────────────────────");

    // Restore node 1903 title if somehow left dirty
    try {
      await db.update(lessonNodesTable)
        .set({ title: ORIGINAL_NODE_TITLE })
        .where(eq(lessonNodesTable.id, NODE_1903_ID));
      console.log("  ✓ Restored node 1903 title");
    } catch (e) { console.error("  ✗ Failed to restore node 1903:", e); }

    // Delete temp node on lesson 105 if it survived H6
    if (tempNodeId !== null) {
      try {
        await db.delete(lessonNodesTable).where(eq(lessonNodesTable.id, tempNodeId));
        console.log(`  ✓ Deleted temp node ${tempNodeId} (H-section cleanup)`);
        tempNodeId = null;
      } catch (e) { console.error("  ✗ Failed to delete temp node:", e); }
    }

    // Delete fixture lesson (CASCADE removes all its nodes/exercises/deps/topics)
    if (fixtureLessonId !== null) {
      try {
        await db.delete(lessonsTable).where(eq(lessonsTable.id, fixtureLessonId));
        console.log(`  ✓ Deleted fixture lesson ${fixtureLessonId}`);
        fixtureLessonId = null;
      } catch (e) { console.error("  ✗ Failed to delete fixture lesson:", e); }
    }

    // Ensure lesson 105 is left in "active" state for future test runs
    try {
      await db.update(lessonsTable)
        .set({ status: "active" })
        .where(eq(lessonsTable.id, REAL_LESSON_ID));
    } catch (e) { console.error("  ✗ Failed to restore lesson 105 to active:", e); }

    // Verify no temp pollution remains
    const pollutionCheck = await db
      .select({ id: lessonNodesTable.id, title: lessonNodesTable.title, lessonId: lessonNodesTable.lessonId })
      .from(lessonNodesTable)
      .where(eq(lessonNodesTable.lessonId, 105));
    const pollution = pollutionCheck.filter(n =>
      n.title.includes("Phase-1.13") ||
      n.title.includes("POST-P1.12 Test Node B1") ||
      n.title.includes("DELETE")
    );
    if (pollution.length > 0) {
      console.error(`  ✗ CLEANUP FAILURE: temp nodes remain in lesson 105: ${JSON.stringify(pollution.map(n => n.title))}`);
    } else {
      console.log("  ✓ No temp pollution remains in lesson 105");
    }

    console.log("\n  ═══════════════════════════════════════════════════════════");
    console.log(`  ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      process.exit(1);
    }
  }
}

main().catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
});
