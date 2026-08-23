// ─────────────────────────────────────────────────────────────────────────────
// P1.7 — Final Lesson Approval Validation — deterministic tests (zero-pollution)
// Run with: pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/lesson-final-approval.test.ts
// No external test framework — uses node:assert/strict + exit code.
// Creates a fully dynamic lesson per run; cleans up in a top-level finally.
// ─────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  db,
  lessonsTable,
  lessonNodesTable,
  lessonNodeCognitiveLevelsTable,
  lessonNodeTeachingPackageItemsTable,
  lessonExercisesTable,
  lessonOutcomesTable,
  lessonOutcomeNodeAlignmentsTable,
  subjectsTable,
  usersTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { validateLessonForFinalApproval } from "../lesson-final-approval.js";
import { makeRunId, runTag } from "./helpers/run-id.js";

// ── Run ID ─────────────────────────────────────────────────────────────────────
const RUN_ID = makeRunId();

let BEARER = "";
let OTHER_TEACHER_BEARER = "";

const BASE = "http://localhost:8080/api";

type Test = [string, () => Promise<void>];
const tests: Test[] = [];
function it(name: string, fn: () => Promise<void>): void { tests.push([name, fn]); }

async function apiPost(path: string) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" },
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

async function apiPostJson(path: string, body: Record<string, unknown>) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

// ── Types ─────────────────────────────────────────────────────────────────────
type NodeRow = typeof lessonNodesTable.$inferSelect;
type ExRow = typeof lessonExercisesTable.$inferSelect;

async function getNode(nodeId: number): Promise<NodeRow | undefined> {
  const [n] = await db.select().from(lessonNodesTable).where(eq(lessonNodesTable.id, nodeId)).limit(1);
  return n;
}

async function restoreNode(snap: NodeRow): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await db.update(lessonNodesTable).set(snap as any).where(eq(lessonNodesTable.id, snap.id));
}

async function getExercise(exId: number): Promise<ExRow | undefined> {
  const [e] = await db.select().from(lessonExercisesTable).where(eq(lessonExercisesTable.id, exId)).limit(1);
  return e;
}

async function restoreExercise(snap: ExRow): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await db.update(lessonExercisesTable).set(snap as any).where(eq(lessonExercisesTable.id, snap.id));
}

// ── Dynamic fixture setup ──────────────────────────────────────────────────────

const [testTeacher] = await db.insert(usersTable).values({
  username: runTag(RUN_ID, "approval_teacher"),
  passwordHash: "test-only-password-hash",
  fullName: "Final approval test teacher",
  role: "teacher",
}).returning({ id: usersTable.id });
const [testSubject] = await db.insert(subjectsTable).values({
  name: runTag(RUN_ID, "approval_subject"),
}).returning({ id: subjectsTable.id });
const [otherTeacher] = await db.insert(usersTable).values({
  username: runTag(RUN_ID, "other_teacher"),
  passwordHash: "test-only-password-hash",
  fullName: "Unrelated test teacher",
  role: "teacher",
}).returning({ id: usersTable.id });
const TEST_TEACHER_ID = testTeacher.id;
const OTHER_TEACHER_ID = otherTeacher.id;
const SUBJECT_ID = testSubject.id;
BEARER = jwt.sign(
  { userId: TEST_TEACHER_ID, role: "teacher" },
  process.env.SESSION_SECRET ?? "myaiteacher-secret",
  { expiresIn: "1h" },
) as string;
OTHER_TEACHER_BEARER = jwt.sign(
  { userId: OTHER_TEACHER_ID, role: "teacher" },
  process.env.SESSION_SECRET ?? "myaiteacher-secret",
  { expiresIn: "1h" },
) as string;

// Create the dynamic lesson
const [dynLesson] = await db.insert(lessonsTable).values({
  title: runTag(RUN_ID, "approval_lesson"),
  subjectId: SUBJECT_ID,
  teacherId: TEST_TEACHER_ID,
  status: "draft",
  lessonOutcomes: ["Legacy outcome for Package 1C confirmation regression"],
  mappingMetadata: {
    sourceExerciseCount: 2,
    quality: {
      sourceAudit: {
        sourceSet: { titleMatch: { valid: true } },
        sourceScope: { valid: true },
      },
    },
  },
}).returning({
  id: lessonsTable.id,
  mappingMetadata: lessonsTable.mappingMetadata,
});

const LESSON_ID = dynLesson.id;
const BASE_MAPPING_METADATA = dynLesson.mappingMetadata;

async function resetFinalReadinessFixture(): Promise<void> {
  await db.delete(lessonOutcomeNodeAlignmentsTable)
    .where(eq(lessonOutcomeNodeAlignmentsTable.lessonId, LESSON_ID));
  await db.delete(lessonOutcomesTable)
    .where(eq(lessonOutcomesTable.lessonId, LESSON_ID));
  await db.update(lessonsTable).set({
    status: "needs_review",
    everApproved: false,
    goalOutcomeReviewStatus: "legacy",
    mappingMetadata: BASE_MAPPING_METADATA,
  } as never).where(eq(lessonsTable.id, LESSON_ID));
}

// Create 2 approved nodes with all required Phase 2 fields
const insertedNodes = await db.insert(lessonNodesTable).values([
  {
    lessonId: LESSON_ID,
    sequence: 1,
    title: runTag(RUN_ID, "node_1"),
    status: "approved",
    learningObjective: "Understand concept A",
    theoryContent: "Theory content for node 1",
    childFriendlyExplanation: "Simple explanation for kids",
    commonMisconception: "Common wrong idea",
    basicExamples: [{ example: "Example 1" }],
    nonExamples: [{ nonExample: "Non-example 1" }],
    createdBy: "teacher",
  },
  {
    lessonId: LESSON_ID,
    sequence: 2,
    title: runTag(RUN_ID, "node_2"),
    status: "approved",
    learningObjective: "Understand concept B",
    theoryContent: "Theory content for node 2",
    childFriendlyExplanation: "Simple explanation for kids 2",
    commonMisconception: "Another common wrong idea",
    basicExamples: [{ example: "Example 2" }],
    nonExamples: [{ nonExample: "Non-example 2" }],
    createdBy: "teacher",
  },
]).returning({ id: lessonNodesTable.id });

// Create 2 approved textbook exercises
await db.insert(lessonExercisesTable).values([
  {
    lessonId: LESSON_ID,
    exerciseId: `EX-${RUN_ID}-1`,
    exerciseTextVerbatim: "Exercise text 1",
    sourceType: "textbook",
    sourceBlockIndex: 0,
    status: "approved",
    sequence: 1,
  },
  {
    lessonId: LESSON_ID,
    exerciseId: `EX-${RUN_ID}-2`,
    exerciseTextVerbatim: "Exercise text 2",
    sourceType: "textbook",
    sourceBlockIndex: 1,
    status: "approved",
    sequence: 2,
  },
]);

// Fetch created fixtures
const allNodes = await db.select().from(lessonNodesTable)
  .where(and(eq(lessonNodesTable.lessonId, LESSON_ID), eq(lessonNodesTable.status, "approved")));
const allExercises = await db.select().from(lessonExercisesTable)
  .where(eq(lessonExercisesTable.lessonId, LESSON_ID));
const sourceExercises = allExercises.filter((e) => e.sourceType === "textbook");

const NODE = allNodes[0];
const EX = sourceExercises[0];

if (!NODE) throw new Error(`No approved node for lesson ${LESSON_ID} — cannot run tests`);
if (!EX) throw new Error(`No textbook exercise for lesson ${LESSON_ID} — cannot run tests`);

// ── A: Learning Objective gate ────────────────────────────────────────────────

it("A1: blank LO on approved node → MISSING_LO error", async () => {
  const snap = await getNode(NODE.id);
  assert.ok(snap, "Node snap must exist");
  try {
    await db.update(lessonNodesTable).set({ learningObjective: "" }).where(eq(lessonNodesTable.id, NODE.id));
    const result = await validateLessonForFinalApproval(LESSON_ID);
    const err = result.errors.find((e) => e.code === "MISSING_LO");
    assert.ok(err, "Expected MISSING_LO error");
    assert.equal(err?.nodeId, NODE.id, "Error must reference the modified node");
  } finally {
    await restoreNode(snap!);
  }
});

it("A2: MISSING_LO blocks POST final-approve → 422", async () => {
  const snap = await getNode(NODE.id);
  assert.ok(snap);
  try {
    await db.update(lessonNodesTable).set({ learningObjective: "   " }).where(eq(lessonNodesTable.id, NODE.id));
    const { status, body } = await apiPost(`/lessons/${LESSON_ID}/final-approve`);
    assert.equal(status, 422, `Expected 422, got ${status}`);
    assert.equal(body.approved, false);
    assert.ok(
      (body.errors as Array<{ code: string }>).some((e) => e.code === "MISSING_LO"),
      "Expected MISSING_LO in errors",
    );
  } finally {
    await restoreNode(snap!);
  }
});

// ── B: Empty MicroNode gate ───────────────────────────────────────────────────

it("B1: approved node with no theory + no anchor → EMPTY_NODE error", async () => {
  const snap = await getNode(NODE.id);
  assert.ok(snap);
  try {
    await db.update(lessonNodesTable)
      .set({ theoryContent: null, verbatimTheoryAnchor: null })
      .where(eq(lessonNodesTable.id, NODE.id));
    const result = await validateLessonForFinalApproval(LESSON_ID);
    const err = result.errors.find((e) => e.code === "EMPTY_NODE");
    assert.ok(err, "Expected EMPTY_NODE error");
    assert.equal(err?.nodeId, NODE.id);
  } finally {
    await restoreNode(snap!);
  }
});

// ── D/E: Lost source exercises ─────────────────────────────────────────────────

it("D1: inflated sourceExerciseCount in meta → LOST_SOURCE_EXERCISES error", async () => {
  const [lesson] = await db.select({ mm: lessonsTable.mappingMetadata })
    .from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
  const origMeta = (lesson?.mm ?? {}) as Record<string, unknown>;
  try {
    await db.update(lessonsTable)
      .set({ mappingMetadata: { ...origMeta, sourceExerciseCount: 99999 } })
      .where(eq(lessonsTable.id, LESSON_ID));
    const result = await validateLessonForFinalApproval(LESSON_ID);
    const err = result.errors.find((e) => e.code === "LOST_SOURCE_EXERCISES");
    assert.ok(err, "Expected LOST_SOURCE_EXERCISES error");
    assert.ok((err?.count ?? 0) > 0, "Lost count must be > 0");
  } finally {
    await db.update(lessonsTable)
      .set({ mappingMetadata: origMeta })
      .where(eq(lessonsTable.id, LESSON_ID));
  }
});

// ── F: Exercise approval states ───────────────────────────────────────────────

it("F1: draft textbook exercise → review warning, not final-approval blocker", async () => {
  const snap = await getExercise(EX.id);
  assert.ok(snap);
  try {
    await db.update(lessonExercisesTable)
      .set({ status: "draft" })
      .where(eq(lessonExercisesTable.id, EX.id));
    const result = await validateLessonForFinalApproval(LESSON_ID);
    const warning = result.warnings.find((e) => e.code === "DRAFT_SOURCE_EXERCISES_REVIEW_REQUIRED");
    assert.ok(warning, "Expected review warning");
    assert.ok((warning?.count ?? 0) >= 1, "Count must be ≥ 1");
  } finally {
    await restoreExercise(snap!);
  }
});

it("F2: draft source exercise does not block the one lesson-level approval", async () => {
  const snap = await getExercise(EX.id);
  assert.ok(snap);
  try {
    await db.update(lessonExercisesTable)
      .set({ status: "draft" })
      .where(eq(lessonExercisesTable.id, EX.id));
    const { status, body } = await apiPost(`/lessons/${LESSON_ID}/final-approve`);
    assert.equal(status, 200);
    assert.equal(body.approved, true);
  } finally {
    await restoreExercise(snap!);
  }
});

// ── G: Phase 2 enrichment ─────────────────────────────────────────────────────

it("G1: approved node missing childFriendlyExplanation → MISSING_PHASE2 requires explicit override", async () => {
  const snap = await getNode(NODE.id);
  assert.ok(snap);
  try {
    await db.update(lessonNodesTable)
      .set({ childFriendlyExplanation: null })
      .where(eq(lessonNodesTable.id, NODE.id));
    const result = await validateLessonForFinalApproval(LESSON_ID);
    const issue = result.overrideable.find((e) => e.code === "MISSING_PHASE2");
    assert.ok(issue, "Expected overrideable MISSING_PHASE2 issue");
    assert.equal(issue?.nodeId, NODE.id);
    assert.equal(result.errors.some((e) => e.code === "MISSING_PHASE2"), false);
  } finally {
    await restoreNode(snap!);
  }
});

it("G2: missing Teaching Content without explicit confirmation → 409 and lesson stays unapproved", async () => {
  const snap = await getNode(NODE.id);
  assert.ok(snap);
  try {
    await db.update(lessonNodesTable)
      .set({ commonMisconception: null })
      .where(eq(lessonNodesTable.id, NODE.id));
    await db.update(lessonsTable)
      .set({ status: "needs_review", everApproved: false } as never)
      .where(eq(lessonsTable.id, LESSON_ID));
    const { status, body } = await apiPost(`/lessons/${LESSON_ID}/final-approve`);
    assert.equal(status, 409);
    assert.equal(body.approved, false);
    assert.equal(body.confirmationRequired, true);
    assert.ok((body.overrideable as Array<{ code: string }>).some((e) => e.code === "MISSING_PHASE2"));
    const [lesson] = await db.select({ status: lessonsTable.status })
      .from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
    assert.equal(lesson?.status, "needs_review");
  } finally {
    await restoreNode(snap!);
  }
});

it("G3: explicit missing-content override persists audit but never fabricates content", async () => {
  const snap = await getNode(NODE.id);
  assert.ok(snap);
  try {
    await db.update(lessonNodesTable)
      .set({ childFriendlyExplanation: null })
      .where(eq(lessonNodesTable.id, NODE.id));
    await db.update(lessonsTable)
      .set({ status: "needs_review", everApproved: false } as never)
      .where(eq(lessonsTable.id, LESSON_ID));
    const { status, body } = await apiPostJson(`/lessons/${LESSON_ID}/final-approve`, {
      confirmMissingTeachingContent: true,
    });
    assert.equal(status, 200);
    assert.equal(body.approved, true);
    assert.equal(body.approvalMode, "missing_teaching_content_override");
    const [lesson] = await db.select({
      status: lessonsTable.status,
      everApproved: lessonsTable.everApproved,
      metadata: lessonsTable.mappingMetadata,
    }).from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
    assert.equal(lesson?.status, "approved");
    assert.equal(lesson?.everApproved, false, "Override approval must remain re-reviewable after edits");
    const audit = (lesson?.metadata as any)?.finalApproval;
    assert.equal(audit?.mode, "missing_teaching_content_override");
    assert.equal(audit?.missingNodeCount, 1);
    assert.ok(Array.isArray(audit?.missingNodeIds) && audit.missingNodeIds.includes(NODE.id));
    const after = await getNode(NODE.id);
    assert.equal(after?.childFriendlyExplanation, null, "Override must not fabricate missing Teaching Content");

    // The existing send-to-student action accepts persisted approval. This
    // checks the same activation gate used by teacher delivery, not a duplicate
    // eligibility rule.
    const activation = await fetch(`${BASE}/teacher/lessons/${LESSON_ID}/status`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    assert.equal(activation.status, 200, "Override-approved lesson must be eligible for existing activation");

    // An edit after activation must still reopen review instead of leaving this
    // override-approved lesson visible to students.
    const edit = await fetch(`${BASE}/lessons/${LESSON_ID}/nodes/${NODE.id}/update`, {
      method: "POST",
      headers: { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: runTag(RUN_ID, "override approval must re-review after edit") }),
    });
    assert.equal(edit.status, 200);
    const [afterEdit] = await db.select({ status: lessonsTable.status })
      .from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
    assert.equal(afterEdit?.status, "needs_review");
  } finally {
    await restoreNode(snap!);
  }
});

it("G4: explicit override cannot bypass a true validation error", async () => {
  const snap = await getNode(NODE.id);
  assert.ok(snap);
  try {
    await db.update(lessonNodesTable).set({
      childFriendlyExplanation: null,
      learningObjective: "",
    }).where(eq(lessonNodesTable.id, NODE.id));
    await db.update(lessonsTable)
      .set({ status: "needs_review", everApproved: false } as never)
      .where(eq(lessonsTable.id, LESSON_ID));
    const { status, body } = await apiPostJson(`/lessons/${LESSON_ID}/final-approve`, {
      confirmMissingTeachingContent: true,
    });
    assert.equal(status, 422);
    assert.equal(body.approved, false);
    assert.ok((body.errors as Array<{ code: string }>).some((e) => e.code === "MISSING_LO"));
    assert.ok((body.overrideable as Array<{ code: string }>).some((e) => e.code === "MISSING_PHASE2"));
  } finally {
    await restoreNode(snap!);
  }
});

it("G5: an Outcome edit invalidates an active override-approved lesson", async () => {
  try {
    // G3 persisted the override audit. Recreate its active, non-sticky delivery
    // state to prove Outcome authoring takes the same route back to review.
    await db.update(lessonsTable)
      .set({ status: "approved", everApproved: false } as never)
      .where(eq(lessonsTable.id, LESSON_ID));
    const activation = await fetch(`${BASE}/teacher/lessons/${LESSON_ID}/status`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    assert.equal(activation.status, 200);

    const outcome = await apiPostJson(`/lessons/${LESSON_ID}/outcomes`, {
      outcomeText: runTag(RUN_ID, "override outcome edit"),
    });
    assert.equal(outcome.status, 201);
    const [lesson] = await db.select({ status: lessonsTable.status })
      .from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
    assert.equal(lesson?.status, "needs_review");
  } finally {
    await db.delete(lessonOutcomesTable).where(eq(lessonOutcomesTable.lessonId, LESSON_ID));
    await db.update(lessonsTable).set({
      status: "needs_review",
      everApproved: false,
      goalOutcomeReviewStatus: "legacy",
      goalOutcomeConfirmedAt: null,
      goalOutcomeConfirmedBy: null,
    } as never).where(eq(lessonsTable.id, LESSON_ID));
  }
});

it("G6: applying a Goal/Outcome proposal invalidates an active override-approved lesson", async () => {
  try {
    await db.update(lessonsTable).set({
      status: "approved",
      everApproved: false,
      lessonGoal: null,
      goalOutcomeReviewStatus: "proposed",
      goalOutcomeProposal: {
        lessonGoal: runTag(RUN_ID, "override proposal goal"),
        outcomes: [runTag(RUN_ID, "override proposal outcome")],
      },
    } as never).where(eq(lessonsTable.id, LESSON_ID));
    const activation = await fetch(`${BASE}/teacher/lessons/${LESSON_ID}/status`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    assert.equal(activation.status, 200);

    const applied = await apiPostJson(`/lessons/${LESSON_ID}/goal-outcome-review/apply-proposal`, {});
    assert.equal(applied.status, 200);
    const [lesson] = await db.select({ status: lessonsTable.status })
      .from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
    assert.equal(lesson?.status, "needs_review");
  } finally {
    await db.delete(lessonOutcomesTable).where(eq(lessonOutcomesTable.lessonId, LESSON_ID));
    await db.update(lessonsTable).set({
      status: "needs_review",
      everApproved: false,
      lessonGoal: null,
      goalOutcomeReviewStatus: "legacy",
      goalOutcomeProposal: null,
      goalOutcomeConfirmedAt: null,
      goalOutcomeConfirmedBy: null,
    } as never).where(eq(lessonsTable.id, LESSON_ID));
  }
});

it("G7: Teaching Package creation invalidates an active override-approved lesson", async () => {
  try {
    await db.update(lessonsTable)
      .set({ status: "approved", everApproved: false } as never)
      .where(eq(lessonsTable.id, LESSON_ID));
    const activation = await fetch(`${BASE}/teacher/lessons/${LESSON_ID}/status`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    assert.equal(activation.status, 200);

    const created = await apiPostJson(`/lessons/${LESSON_ID}/nodes/${NODE.id}/teaching-package`, {
      itemType: "HINT",
      content: runTag(RUN_ID, "override teaching package edit"),
      provenance: "teacher_created",
      status: "draft",
    });
    assert.equal(created.status, 201);
    const [lesson] = await db.select({ status: lessonsTable.status })
      .from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
    assert.equal(lesson?.status, "needs_review");
  } finally {
    await db.delete(lessonNodeTeachingPackageItemsTable)
      .where(eq(lessonNodeTeachingPackageItemsTable.lessonId, LESSON_ID));
    await db.update(lessonsTable)
      .set({ status: "needs_review", everApproved: false } as never)
      .where(eq(lessonsTable.id, LESSON_ID));
  }
});

it("R1: stale automatic Outcome-review metadata is review-only, not a final-approval blocker", async () => {
  try {
    const [outcome] = await db.insert(lessonOutcomesTable).values({
      lessonId: LESSON_ID,
      outcomeText: runTag(RUN_ID, "stale automatic relation"),
      sequence: 1,
      status: "approved",
      provenance: "teacher_authored",
    }).returning({ id: lessonOutcomesTable.id });
    await db.insert(lessonOutcomeNodeAlignmentsTable).values({
      lessonId: LESSON_ID,
      lessonOutcomeId: outcome.id,
      lessonNodeId: NODE.id,
      role: "REQUIRED",
      requiredCognitiveDepth: "remember",
    });
    await db.update(lessonsTable).set({
      goalOutcomeReviewStatus: "confirmed",
      mappingMetadata: {
        ...((BASE_MAPPING_METADATA ?? {}) as Record<string, unknown>),
        quality: {
          sourceAudit: {
            sourceSet: { titleMatch: { valid: true } },
            sourceScope: { valid: true },
          },
          outcomeAlignmentAudit: {
            persistedAlignments: 1,
            requiresTeacherReview: true,
            reviewedAt: null,
          },
        },
      },
    } as never).where(eq(lessonsTable.id, LESSON_ID));
    const result = await validateLessonForFinalApproval(LESSON_ID);
    assert.equal(result.errors.some((issue) => issue.code === "AUTOMATIC_OUTCOME_ALIGNMENT_REVIEW_REQUIRED"), false);
    assert.equal(result.warnings.some((issue) => issue.code === "AUTOMATIC_OUTCOME_ALIGNMENT_REVIEW_REQUIRED"), true);
    assert.equal(result.readiness, "REVIEW_REQUIRED");
  } finally {
    await resetFinalReadinessFixture();
  }
});

it("R2/R10: one bounded repair promotes one valid persisted SUPPORTING relation", async () => {
  try {
    const [outcome] = await db.insert(lessonOutcomesTable).values({
      lessonId: LESSON_ID,
      outcomeText: runTag(RUN_ID, "promote existing relation"),
      sequence: 1,
      status: "approved",
      provenance: "teacher_authored",
    }).returning({ id: lessonOutcomesTable.id });
    const [supporting] = await db.insert(lessonOutcomeNodeAlignmentsTable).values({
      lessonId: LESSON_ID,
      lessonOutcomeId: outcome.id,
      lessonNodeId: NODE.id,
      role: "SUPPORTING",
      requiredCognitiveDepth: "remember",
    }).returning({ id: lessonOutcomeNodeAlignmentsTable.id });
    await db.update(lessonsTable).set({ goalOutcomeReviewStatus: "confirmed" } as never)
      .where(eq(lessonsTable.id, LESSON_ID));

    const first = await apiPost(`/lessons/${LESSON_ID}/final-approve`);
    assert.equal(first.status, 200);
    assert.equal(first.body.approved, true);
    assert.deepEqual(first.body.repairedAlignmentIds, [supporting.id]);
    const [promoted] = await db.select({ role: lessonOutcomeNodeAlignmentsTable.role })
      .from(lessonOutcomeNodeAlignmentsTable)
      .where(eq(lessonOutcomeNodeAlignmentsTable.id, supporting.id));
    assert.equal(promoted?.role, "REQUIRED");

    await db.update(lessonsTable).set({ status: "needs_review", everApproved: false } as never)
      .where(eq(lessonsTable.id, LESSON_ID));
    const second = await apiPost(`/lessons/${LESSON_ID}/final-approve`);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.repairedAlignmentIds, [], "repair must not repeat after the single promotion");
  } finally {
    await resetFinalReadinessFixture();
  }
});

it("R3: an Outcome without a safe existing relation remains blocked and no link is fabricated", async () => {
  try {
    await db.insert(lessonOutcomesTable).values({
      lessonId: LESSON_ID,
      outcomeText: runTag(RUN_ID, "no relationship may be invented"),
      sequence: 1,
      status: "approved",
      provenance: "teacher_authored",
    });
    await db.update(lessonsTable).set({ goalOutcomeReviewStatus: "confirmed" } as never)
      .where(eq(lessonsTable.id, LESSON_ID));
    const response = await apiPost(`/lessons/${LESSON_ID}/final-approve`);
    assert.equal(response.status, 422);
    assert.equal((response.body.errors as Array<{ code: string }>)
      .some((issue) => issue.code === "OUTCOME_WITHOUT_REQUIRED_NODE"), true);
    const alignments = await db.select({ id: lessonOutcomeNodeAlignmentsTable.id })
      .from(lessonOutcomeNodeAlignmentsTable)
      .where(eq(lessonOutcomeNodeAlignmentsTable.lessonId, LESSON_ID));
    assert.equal(alignments.length, 0);
  } finally {
    await resetFinalReadinessFixture();
  }
});

it("R4: review-only readiness still permits canonical final approval", async () => {
  try {
    await db.update(lessonsTable).set({
      mappingMetadata: {
        ...((BASE_MAPPING_METADATA ?? {}) as Record<string, unknown>),
        quality: {
          sourceAudit: {
            sourceSet: { titleMatch: { valid: true } },
            sourceScope: { valid: true },
          },
          outcomeAlignmentAudit: {
            persistedAlignments: 1,
            requiresTeacherReview: true,
            reviewedAt: null,
          },
        },
      },
    } as never).where(eq(lessonsTable.id, LESSON_ID));
    const response = await apiPost(`/lessons/${LESSON_ID}/final-approve`);
    assert.equal(response.status, 200);
    assert.equal(response.body.approved, true);
    assert.equal(response.body.readiness, "REVIEW_REQUIRED");
    const [persisted] = await db.select({ status: lessonsTable.status })
      .from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID));
    assert.equal(persisted?.status, "approved");
  } finally {
    await resetFinalReadinessFixture();
  }
});

it("H1: safe needs_review node does not require redundant per-node approval", async () => {
  const snap = await getNode(NODE.id);
  assert.ok(snap);
  try {
    await db.update(lessonNodesTable)
      .set({ status: "needs_review" })
      .where(eq(lessonNodesTable.id, NODE.id));
    const { status, body } = await apiPost(`/lessons/${LESSON_ID}/final-approve`);
    assert.equal(status, 200);
    assert.equal(body.approved, true);
  } finally {
    await restoreNode(snap!);
  }
});

it("H2: persisted non-sufficient source alignment blocks final approval even if node is approved", async () => {
  const [lesson] = await db.select({ metadata: lessonsTable.mappingMetadata })
    .from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
  const nodeSnap = await getNode(NODE.id);
  assert.ok(nodeSnap);
  const originalMetadata = (lesson?.metadata ?? {}) as Record<string, unknown>;
  try {
    await db.update(lessonNodesTable).set({
      status: "approved",
      changeReason: "SOURCE_ALIGNMENT:INSUFFICIENT:HEADING_ONLY",
    }).where(eq(lessonNodesTable.id, NODE.id));
    await db.update(lessonsTable).set({
      mappingMetadata: {
        ...originalMetadata,
        quality: {
          ...((originalMetadata.quality as Record<string, unknown>) ?? {}),
          sourceAlignment: {
            valid: false,
            sufficientCount: 1,
            partialCount: 0,
            insufficientCount: 1,
            unreadableCount: 0,
            nodes: [{ nodeId: NODE.id, status: "INSUFFICIENT", reasonCode: "HEADING_ONLY" }],
          },
        },
      },
    }).where(eq(lessonsTable.id, LESSON_ID));
    const result = await validateLessonForFinalApproval(LESSON_ID);
    assert.ok(result.errors.some((error) => error.code === "MICRONODE_SOURCE_ALIGNMENT_REQUIRED"));
  } finally {
    await restoreNode(nodeSnap!);
    await db.update(lessonsTable).set({ mappingMetadata: originalMetadata })
      .where(eq(lessonsTable.id, LESSON_ID));
  }
});

it("H3: explicit node approval records teacher resolution without erasing the original alignment audit", async () => {
  const [lesson] = await db.select({ metadata: lessonsTable.mappingMetadata })
    .from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
  const nodeSnap = await getNode(NODE.id);
  assert.ok(nodeSnap);
  const originalMetadata = (lesson?.metadata ?? {}) as Record<string, unknown>;
  try {
    await db.update(lessonNodesTable).set({
      status: "needs_review",
      changeReason: "SOURCE_ALIGNMENT:INSUFFICIENT:HEADING_ONLY",
      cogPathStatus: "confirmed",
      theoryContent: "Ջուրը կարևոր է կյանքի համար և անհրաժեշտ է բույսերի աճի համար։",
      learningObjective: "Սովորողը բացատրում է ջրի կարևորությունը կյանքի համար։",
    }).where(eq(lessonNodesTable.id, NODE.id));
    await db.insert(lessonNodeCognitiveLevelsTable).values({
      lessonNodeId: NODE.id,
      cognitiveLevel: "understand",
      sequence: 1,
      isApplicable: true,
      isTargetCeiling: true,
      performanceObjective: "Սովորողը բացատրում է ջրի կարևորությունը կյանքի համար։",
      successCriterion: "Ճիշտ է նշում ջրի կարևորությունը կյանքի համար։",
      provenance: "teacher_authored",
      minimumIndependentEvidence: 1,
      preferredInteractionTypes: ["multiple_choice"],
    });
    await db.update(lessonsTable).set({
      mappingMetadata: {
        ...originalMetadata,
        quality: {
          ...((originalMetadata.quality as Record<string, unknown>) ?? {}),
          sourceAlignment: {
            valid: false,
            sufficientCount: 1,
            partialCount: 0,
            insufficientCount: 1,
            unreadableCount: 0,
            nodes: [{ nodeId: NODE.id, status: "INSUFFICIENT", reasonCode: "HEADING_ONLY" }],
          },
        },
      },
    }).where(eq(lessonsTable.id, LESSON_ID));
    const response = await apiPostJson(`/lessons/${LESSON_ID}/nodes/${NODE.id}/update`, { status: "approved" });
    assert.equal(response.status, 200);
    const [updatedLesson] = await db.select({ metadata: lessonsTable.mappingMetadata })
      .from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
    const auditNode = ((updatedLesson?.metadata as any)?.quality?.sourceAlignment?.nodes ?? [])[0];
    assert.equal(auditNode.status, "INSUFFICIENT", "Original classifier status must remain auditable");
    assert.equal(auditNode.reviewStatus, "RESOLVED_BY_TEACHER");
    const updatedNode = await getNode(NODE.id);
    assert.equal(updatedNode?.changeReason, "SOURCE_ALIGNMENT_REVIEWED_BY_TEACHER");
    const validation = await validateLessonForFinalApproval(LESSON_ID);
    assert.ok(!validation.errors.some((error) => error.code === "MICRONODE_SOURCE_ALIGNMENT_REQUIRED"));
  } finally {
    await restoreNode(nodeSnap!);
    await db.update(lessonsTable).set({ mappingMetadata: originalMetadata })
      .where(eq(lessonsTable.id, LESSON_ID));
  }
});

// ── P: Positive path ─────────────────────────────────────────────────────────

it("P1: dynamic lesson clean → approved: true (200)", async () => {
  const { status, body } = await apiPost(`/lessons/${LESSON_ID}/final-approve`);
  assert.equal(status, 200, `Expected 200, got ${status} body: ${JSON.stringify(body)}`);
  assert.equal(body.approved, true);
  assert.equal((body.errors as unknown[]).length, 0, "Expected 0 errors");
  const summary = body.summary as Record<string, number>;
  assert.ok(summary.approvedNodes > 0, "Must have approved nodes");
  assert.ok(summary.phase2CompleteNodes > 0, "Must have Phase 2 complete nodes");

  const [lesson] = await db.select({
    status: lessonsTable.status,
    everApproved: lessonsTable.everApproved,
    metadata: lessonsTable.mappingMetadata,
  })
    .from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
  assert.equal(lesson?.status, "approved", "DB lesson.status must be 'approved'");
  assert.equal(lesson?.everApproved, true, "Normal approval retains the existing sticky semantics");
  const audit = (lesson?.metadata as any)?.finalApproval;
  assert.equal(audit?.mode, "normal");
});

it("P2: GET /lessons/:id returns authoringStatus: 'approved'", async () => {
  const r = await fetch(`${BASE}/lessons/${LESSON_ID}`, {
    headers: { Authorization: `Bearer ${BEARER}` },
  });
  const body = await r.json() as Record<string, unknown>;
  assert.equal(body.authoringStatus, "approved", `Expected 'approved', got '${body.authoringStatus}'`);
});

// ── I: Invalidation (POST-P1.12 semantics) ───────────────────────────────────

it("I1: node update while approved + everApproved=true → lesson STAYS approved (not reverted)", async () => {
  // POST-P1.12 AUTHORING SIMPLIFICATION:
  // Once a lesson has ever been approved (everApproved=true), ordinary teacher
  // edits must NOT revert the lesson to needs_review.

  // Ensure lesson is approved first
  await db.update(lessonsTable).set({ status: "approved" } as never).where(eq(lessonsTable.id, LESSON_ID));

  const snap = await getNode(NODE.id);
  assert.ok(snap);

  // Node update via the POST .../update route
  const r = await fetch(`${BASE}/lessons/${LESSON_ID}/nodes/${NODE.id}/update`, {
    method: "POST",
    headers: { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title: runTag(RUN_ID, "P1.7 invalidation test — new semantics") }),
  });
  assert.equal(r.status, 200, "Node update must succeed");

  // With everApproved=true the lesson must NOT revert to needs_review.
  const [lesson] = await db.select({ status: lessonsTable.status })
    .from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
  assert.equal(lesson?.status, "approved", "Lesson must remain approved when everApproved=true");
  await restoreNode(snap!);
});

it("I2: invalidateLessonApproval DID revert when everApproved=false (backward-compat guard)", async () => {
  // Manually set everApproved=false to test the OLD code path still works
  // for lessons that have never been approved.
  await db.update(lessonsTable)
    .set({ status: "approved", everApproved: false } as never)
    .where(eq(lessonsTable.id, LESSON_ID));

  const snap = await getNode(NODE.id);
  assert.ok(snap);
  try {
    const r = await fetch(`${BASE}/lessons/${LESSON_ID}/nodes/${NODE.id}/update`, {
      method: "POST",
      headers: { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: runTag(RUN_ID, "P1.7 invalidation test — everApproved=false path") }),
    });
    assert.equal(r.status, 200, "Node update must succeed");

    const [lesson] = await db.select({ status: lessonsTable.status })
      .from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
    assert.equal(lesson?.status, "needs_review", "Lesson must revert when everApproved=false");
  } finally {
    await restoreNode(snap!);
    // Restore everApproved=true so final cleanup state is consistent
    await db.update(lessonsTable)
      .set({ everApproved: true } as never)
      .where(eq(lessonsTable.id, LESSON_ID));
  }
});

it("C1: a different teacher cannot mutate this lesson's MicroNodes", async () => {
  const r = await fetch(`${BASE}/lessons/${LESSON_ID}/nodes/${NODE.id}/update`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OTHER_TEACHER_BEARER}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Unauthorized update" }),
  });
  assert.equal(r.status, 403, "Unrelated teachers must be denied before an authoring mutation");
});

it("C2: legacy Outcome backfill invalidates a confirmed Goal/Outcome review", async () => {
  await db.update(lessonsTable).set({
    goalOutcomeReviewStatus: "confirmed",
    goalOutcomeConfirmedAt: new Date(),
  } as never).where(eq(lessonsTable.id, LESSON_ID));

  const r = await apiPost(`/lessons/${LESSON_ID}/outcomes/backfill-legacy`);
  assert.equal(r.status, 201, "Legacy backfill should create its missing draft Outcome");
  assert.equal(r.body.createdCount, 1);
  const [lesson] = await db.select({
    reviewStatus: lessonsTable.goalOutcomeReviewStatus,
    confirmedAt: lessonsTable.goalOutcomeConfirmedAt,
  }).from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
  assert.equal(lesson?.reviewStatus, "needs_review");
  assert.equal(lesson?.confirmedAt, null);
});

// ── Runner ─────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

const total = tests.length;
console.log(`\n  lesson-final-approval [${RUN_ID}] — ${total} test cases\n`);

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
  // Cascade delete removes nodes and exercises automatically (FK onDelete: "cascade")
  await db.delete(lessonsTable).where(eq(lessonsTable.id, LESSON_ID));
  await db.delete(subjectsTable).where(eq(subjectsTable.id, SUBJECT_ID));
  await db.delete(usersTable).where(eq(usersTable.id, TEST_TEACHER_ID));
  await db.delete(usersTable).where(eq(usersTable.id, OTHER_TEACHER_ID));
  console.log(`  [cleanup] Dynamic lesson ${LESSON_ID} (${RUN_ID}) deleted.`);
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
