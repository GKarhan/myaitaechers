import assert from "node:assert/strict";
import {
  db,
  lessonNodeCognitiveLevelsTable,
  lessonNodesTable,
  pool,
} from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import { Client } from "pg";
import {
  confirmAuthoredCognitivePath,
  deleteAuthoredCognitiveLevel,
  deriveCognitivePathReadState,
  reorderAuthoredCognitiveLevels,
  updateAuthoredNodeAtCognitivePathBoundary,
} from "../cognitive-path-authoring.js";
import {
  assessCognitivePathForConfirmation,
  resolveCanonicalQuizTarget,
} from "../cognitive-path-grounding.js";
import {
  createTeacherCognitiveLevel,
  updateTeacherCognitiveLevel,
} from "../cognitive-level-crud.js";
import { assertTestDb, closeTestDb } from "./helpers/test-db.js";
import { createFactory } from "./helpers/fixture-factory.js";
import { makeRunId } from "./helpers/run-id.js";

assertTestDb();

const results: Array<{ name: string; pass: boolean; error?: unknown }> = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, pass: false, error });
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}

const factory = createFactory(makeRunId());
const lesson = await factory.lesson(null, null, 18);
const node = await factory.node(lesson.id, {
  title: "Cognitive Path authoring integrity",
  sequence: 1,
  theoryContent: "Ջուրը կարևոր է կյանքի համար և անհրաժեշտ է բույսերի աճի համար։",
  learningObjective: "Սովորողը բացատրում է ջրի կարևորությունը կյանքի համար։",
});

type LevelSpec = {
  cognitiveLevel: string;
  isTargetCeiling?: boolean;
  isApplicable?: boolean;
  provenance?: "ai_generated" | "teacher_authored";
  performanceObjective?: string | null;
  successCriterion?: string | null;
  minimumIndependentEvidence?: number;
  preferredInteractionTypes?: unknown;
};

const performanceObjective = "Սովորողը բացատրում է ջրի կարևորությունը կյանքի համար։";
const successCriterion = "Ճիշտ է նշում ջրի կարևորությունը կյանքի համար։";

async function setPath(
  specs: readonly LevelSpec[],
  options: { cogPathStatus?: string; targetBloomLevel?: number } = {},
) {
  await db.delete(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, node.id));
  await db.update(lessonNodesTable)
    .set({
      cogPathStatus: options.cogPathStatus ?? "needs_review",
      targetBloomLevel: options.targetBloomLevel ?? 1,
      teachingContentStale: false,
    })
    .where(eq(lessonNodesTable.id, node.id));
  if (specs.length === 0) return [];
  return db.insert(lessonNodeCognitiveLevelsTable)
    .values(specs.map((spec, index) => ({
      lessonNodeId: node.id,
      cognitiveLevel: spec.cognitiveLevel,
      sequence: index + 1,
      isApplicable: spec.isApplicable ?? true,
      isTargetCeiling: spec.isTargetCeiling ?? false,
      provenance: spec.provenance ?? "teacher_authored",
      performanceObjective: spec.performanceObjective === undefined
        ? performanceObjective
        : spec.performanceObjective,
      successCriterion: spec.successCriterion === undefined
        ? successCriterion
        : spec.successCriterion,
      minimumIndependentEvidence: spec.minimumIndependentEvidence ?? 3,
      preferredInteractionTypes: spec.preferredInteractionTypes === undefined
        ? ["multiple_choice"]
        : spec.preferredInteractionTypes,
    })))
    .returning();
}

async function getNodeAndLevels() {
  const [currentNode] = await db.select()
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, node.id))
    .limit(1);
  const levels = await db.select()
    .from(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, node.id))
    .orderBy(
      asc(lessonNodeCognitiveLevelsTable.sequence),
      asc(lessonNodeCognitiveLevelsTable.id),
    );
  return { currentNode, levels };
}

async function assertConfirmedTarget(expectedLevel: string, expectedBloom: number) {
  const result = await confirmAuthoredCognitivePath(lesson.id, node.id);
  assert.equal(result.found, true);
  assert.equal("confirmed" in result && result.confirmed, true);
  const { currentNode, levels } = await getNodeAndLevels();
  assert.equal(currentNode.cogPathStatus, "confirmed");
  assert.equal(currentNode.targetBloomLevel, expectedBloom);
  const resolution = resolveCanonicalQuizTarget(currentNode, levels);
  assert.equal(resolution.valid, true);
  if (resolution.valid) assert.equal(resolution.cognitiveLevel, expectedLevel);
}

try {
  await test("A: single Understand target confirms and resolves deterministically", async () => {
    await setPath([{ cognitiveLevel: "understand", isTargetCeiling: true }]);
    await assertConfirmedTarget("understand", 2);
  });

  await test("B: Understand to Apply target confirms and resolves Apply", async () => {
    await setPath([
      { cognitiveLevel: "understand" },
      { cognitiveLevel: "apply", isTargetCeiling: true },
    ]);
    await assertConfirmedTarget("apply", 3);
  });

  await test("C: Remember to Understand to Apply target confirms", async () => {
    await setPath([
      { cognitiveLevel: "remember" },
      { cognitiveLevel: "understand" },
      { cognitiveLevel: "apply", isTargetCeiling: true },
    ]);
    await assertConfirmedTarget("apply", 3);
  });

  await test("D: decreasing cognitive order cannot be confirmed", async () => {
    await setPath([
      { cognitiveLevel: "apply", isTargetCeiling: true },
      { cognitiveLevel: "understand" },
    ]);
    const result = await confirmAuthoredCognitivePath(lesson.id, node.id);
    assert.equal(result.found, true);
    assert.equal("confirmed" in result && result.confirmed, false);
    if (result.found && !result.confirmed) {
      assert.ok(result.assessment.reasons.includes("INVALID_COGNITIVE_ORDER"));
    }
    assert.equal((await getNodeAndLevels()).currentNode.cogPathStatus, "needs_review");
  });

  await test("E: path without a target cannot be confirmed", async () => {
    await setPath([
      { cognitiveLevel: "understand" },
      { cognitiveLevel: "apply" },
    ]);
    const result = await confirmAuthoredCognitivePath(lesson.id, node.id);
    assert.equal(result.found, true);
    assert.equal("confirmed" in result && result.confirmed, false);
    if (result.found && !result.confirmed) {
      assert.equal(result.assessment.reason, "TARGET_MISSING");
    }
  });

  await test("F: non-final target cannot be confirmed", async () => {
    await setPath([
      { cognitiveLevel: "understand", isTargetCeiling: true },
      { cognitiveLevel: "apply" },
    ]);
    const result = await confirmAuthoredCognitivePath(lesson.id, node.id);
    assert.equal(result.found, true);
    assert.equal("confirmed" in result && result.confirmed, false);
    if (result.found && !result.confirmed) {
      assert.equal(result.assessment.reason, "TARGET_NOT_FINAL");
    }
  });

  await test("G: non-applicable target cannot be confirmed", async () => {
    await setPath([
      { cognitiveLevel: "understand", isTargetCeiling: true, isApplicable: false },
      { cognitiveLevel: "apply" },
    ]);
    const result = await confirmAuthoredCognitivePath(lesson.id, node.id);
    assert.equal(result.found, true);
    assert.equal("confirmed" in result && result.confirmed, false);
    if (result.found && !result.confirmed) {
      assert.equal(result.assessment.reason, "TARGET_NOT_APPLICABLE");
    }
  });

  await test("H: adding a level atomically invalidates a confirmed path", async () => {
    await setPath([
      { cognitiveLevel: "understand", isTargetCeiling: true },
    ]);
    await assertConfirmedTarget("understand", 2);
    const inserted = await createTeacherCognitiveLevel(node.id, {
      cognitiveLevel: "apply",
      performanceObjective,
      successCriterion,
      minimumIndependentEvidence: 3,
      preferredInteractionTypes: ["multiple_choice"],
    });
    assert.ok(inserted);
    assert.equal((await getNodeAndLevels()).currentNode.cogPathStatus, "needs_review");
  });

  await test("I: semantic field edits invalidate stale confirmation", async () => {
    const levels = await setPath([
      { cognitiveLevel: "understand", isTargetCeiling: true },
    ]);
    await assertConfirmedTarget("understand", 2);
    const updated = await updateTeacherCognitiveLevel(node.id, levels[0], {
      performanceObjective: "Սովորողը նկարագրում է ջրի կարևորությունը կյանքի համար։",
      successCriterion: "Ճիշտ է բացատրում ջրի կարևորությունը կյանքի համար։",
      minimumIndependentEvidence: 4,
      preferredInteractionTypes: ["short_answer"],
    });
    assert.ok(updated);
    assert.equal((await getNodeAndLevels()).currentNode.cogPathStatus, "needs_review");
  });

  await test("J: reconfirmation refreshes targetBloomLevel from canonical target", async () => {
    await setPath([
      { cognitiveLevel: "understand" },
      { cognitiveLevel: "apply", isTargetCeiling: true },
    ], { targetBloomLevel: 1 });
    await assertConfirmedTarget("apply", 3);
  });

  await test("K: deleting a target deconfirms and normalizes remaining sequences", async () => {
    const levels = await setPath([
      { cognitiveLevel: "remember" },
      { cognitiveLevel: "understand" },
      { cognitiveLevel: "apply", isTargetCeiling: true },
    ]);
    await assertConfirmedTarget("apply", 3);
    const result = await deleteAuthoredCognitiveLevel(lesson.id, node.id, levels[2].id);
    assert.deepEqual(result, { found: true, deleted: true });
    const after = await getNodeAndLevels();
    assert.equal(after.currentNode.cogPathStatus, "needs_review");
    assert.deepEqual(after.levels.map((level) => level.sequence), [1, 2]);
    assert.equal(after.levels.some((level) => level.isTargetCeiling), false);
  });

  await test("L: reordering a confirmed path deconfirms and preserves requested order", async () => {
    const levels = await setPath([
      { cognitiveLevel: "understand" },
      { cognitiveLevel: "apply", isTargetCeiling: true },
    ]);
    await assertConfirmedTarget("apply", 3);
    const result = await reorderAuthoredCognitiveLevels(
      lesson.id,
      node.id,
      [levels[1].id, levels[0].id],
    );
    assert.deepEqual(result, { found: true, valid: true, reordered: 2 });
    const after = await getNodeAndLevels();
    assert.equal(after.currentNode.cogPathStatus, "needs_review");
    assert.deepEqual(after.levels.map((level) => level.id), [levels[1].id, levels[0].id]);
    assert.deepEqual(after.levels.map((level) => level.sequence), [1, 2]);
    const assessment = assessCognitivePathForConfirmation(after.currentNode, after.levels);
    assert.equal(assessment.valid, false);
    if (!assessment.valid) {
      assert.ok(assessment.reasons.includes("INVALID_COGNITIVE_ORDER"));
    }
  });

  await test("M: AI-generated and manual paths use identical confirmation rules", async () => {
    await setPath([
      { cognitiveLevel: "understand", isTargetCeiling: true, provenance: "ai_generated" },
    ]);
    await assertConfirmedTarget("understand", 2);
    await setPath([
      { cognitiveLevel: "understand", isTargetCeiling: true, provenance: "teacher_authored" },
    ]);
    await assertConfirmedTarget("understand", 2);
  });

  await test("N: invalid path remains editable in review but cannot become confirmed", async () => {
    await setPath([
      { cognitiveLevel: "understand", performanceObjective: null },
    ]);
    const before = await getNodeAndLevels();
    assert.equal(before.currentNode.cogPathStatus, "needs_review");
    assert.equal(before.levels.length, 1);
    const result = await confirmAuthoredCognitivePath(lesson.id, node.id);
    assert.equal(result.found, true);
    assert.equal("confirmed" in result && result.confirmed, false);
    assert.equal((await getNodeAndLevels()).currentNode.cogPathStatus, "needs_review");
  });

  await test("O: confirmation exposes detailed machine-readable field failures", async () => {
    const levels = await setPath([
      {
        cognitiveLevel: "understand",
        isTargetCeiling: true,
        performanceObjective: null,
        successCriterion: null,
        preferredInteractionTypes: ["not_supported"],
      },
    ]);
    const assessment = assessCognitivePathForConfirmation(
      (await getNodeAndLevels()).currentNode,
      levels,
    );
    assert.equal(assessment.valid, false);
    if (!assessment.valid) {
      assert.ok(assessment.reasons.includes("MISSING_PERFORMANCE_OBJECTIVE"));
      assert.ok(assessment.reasons.includes("MISSING_SUCCESS_CRITERION"));
      assert.ok(assessment.reasons.includes("INVALID_INTERACTION_TYPES"));
      assert.ok(assessment.reasons.includes("PATH_GROUNDING_FAILED"));
    }
  });

  await test("P: invalid evidence budget has a specific confirmation reason", async () => {
    const levels = await setPath([
      {
        cognitiveLevel: "understand",
        isTargetCeiling: true,
        minimumIndependentEvidence: 6,
      },
    ]);
    const assessment = assessCognitivePathForConfirmation(
      (await getNodeAndLevels()).currentNode,
      levels,
    );
    assert.equal(assessment.valid, false);
    if (!assessment.valid) {
      assert.equal(assessment.reason, "INVALID_EVIDENCE_BUDGET");
    }
  });

  await test("Q: concurrent confirmation cannot race past a stale node-edit read", async () => {
    await setPath([
      { cognitiveLevel: "understand", isTargetCeiling: true },
    ]);
    const staleRead = (await getNodeAndLevels()).currentNode;
    assert.equal(staleRead.cogPathStatus, "needs_review");

    const confirmer = new Client({ connectionString: process.env.DATABASE_URL });
    await confirmer.connect();
    try {
      await confirmer.query("BEGIN");
      await confirmer.query("SELECT id FROM lesson_nodes WHERE id = $1 FOR UPDATE", [node.id]);
      await confirmer.query(
        "UPDATE lesson_nodes SET cog_path_status = 'confirmed', target_bloom_level = 2 WHERE id = $1",
        [node.id],
      );

      let editSettled = false;
      const editPromise = updateAuthoredNodeAtCognitivePathBoundary({
        lessonId: lesson.id,
        nodeId: node.id,
        patch: {
          learningObjective: "Սովորողը նկարագրում է ջրի կարևորությունը կյանքի համար։",
        },
        invalidatesCognitivePath: true,
        invalidatesTeachingContent: true,
        requiresAcceptedCognitivePath: false,
      }).finally(() => {
        editSettled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(editSettled, false, "node edit must wait for the confirmation lock");
      await confirmer.query("COMMIT");
      await editPromise;
    } catch (error) {
      await confirmer.query("ROLLBACK");
      throw error;
    } finally {
      await confirmer.end();
    }

    const after = await getNodeAndLevels();
    assert.equal(after.currentNode.cogPathStatus, "needs_review");
    const resolution = resolveCanonicalQuizTarget(after.currentNode, after.levels);
    assert.equal(resolution.valid, false);
    if (!resolution.valid) assert.equal(resolution.reason, "PATH_NOT_CONFIRMED");
  });

  await test("R: approval and direct Bloom-copy edit cannot succeed together", async () => {
    await setPath([
      { cognitiveLevel: "understand", isTargetCeiling: true },
    ]);
    await assertConfirmedTarget("understand", 2);
    const result = await updateAuthoredNodeAtCognitivePathBoundary({
      lessonId: lesson.id,
      nodeId: node.id,
      patch: {
        status: "approved",
        targetBloomLevel: 1,
      },
      invalidatesCognitivePath: true,
      invalidatesTeachingContent: false,
      requiresAcceptedCognitivePath: true,
    });
    assert.equal(result.found, true);
    assert.equal("updated" in result && result.updated, false);
    if (result.found && !result.updated) {
      assert.equal(result.acceptance.reason, "PATH_NOT_CONFIRMED");
    }
    const after = await getNodeAndLevels();
    assert.equal(after.currentNode.cogPathStatus, "confirmed");
    assert.notEqual(after.currentNode.status, "approved");
    assert.equal(after.currentNode.targetBloomLevel, 2);
  });

  await test("S: approval waiting behind a path mutation rechecks readiness under lock", async () => {
    await setPath([
      { cognitiveLevel: "understand", isTargetCeiling: true },
    ]);
    await assertConfirmedTarget("understand", 2);

    const mutator = new Client({ connectionString: process.env.DATABASE_URL });
    await mutator.connect();
    try {
      await mutator.query("BEGIN");
      await mutator.query("SELECT id FROM lesson_nodes WHERE id = $1 FOR UPDATE", [node.id]);
      await mutator.query(
        "UPDATE lesson_nodes SET cog_path_status = 'needs_review' WHERE id = $1",
        [node.id],
      );

      let approvalSettled = false;
      const approvalPromise = updateAuthoredNodeAtCognitivePathBoundary({
        lessonId: lesson.id,
        nodeId: node.id,
        patch: { status: "approved" },
        invalidatesCognitivePath: false,
        invalidatesTeachingContent: false,
        requiresAcceptedCognitivePath: true,
      }).finally(() => {
        approvalSettled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(approvalSettled, false, "approval must wait for the path-mutation lock");
      await mutator.query("COMMIT");
      const approval = await approvalPromise;
      assert.equal(approval.found, true);
      assert.equal("updated" in approval && approval.updated, false);
      if (approval.found && !approval.updated) {
        assert.equal(approval.acceptance.reason, "PATH_NOT_CONFIRMED");
      }
    } catch (error) {
      await mutator.query("ROLLBACK");
      throw error;
    } finally {
      await mutator.end();
    }

    const after = await getNodeAndLevels();
    assert.equal(after.currentNode.cogPathStatus, "needs_review");
    assert.notEqual(after.currentNode.status, "approved");
  });

  await test("T: mutation waiting behind approval demotes both published statuses", async () => {
    await setPath([
      { cognitiveLevel: "understand", isTargetCeiling: true },
    ]);
    await db.update(lessonNodesTable)
      .set({ status: "draft" })
      .where(eq(lessonNodesTable.id, node.id));
    await assertConfirmedTarget("understand", 2);
    const staleRead = (await getNodeAndLevels()).currentNode;
    assert.equal(staleRead.status, "draft");

    const approver = new Client({ connectionString: process.env.DATABASE_URL });
    await approver.connect();
    try {
      await approver.query("BEGIN");
      await approver.query("SELECT id FROM lesson_nodes WHERE id = $1 FOR UPDATE", [node.id]);
      await approver.query(
        "UPDATE lesson_nodes SET status = 'approved' WHERE id = $1",
        [node.id],
      );

      let mutationSettled = false;
      const mutationPromise = updateAuthoredNodeAtCognitivePathBoundary({
        lessonId: lesson.id,
        nodeId: node.id,
        patch: {
          theoryContent: "Ջուրը կարևոր է կյանքի և բույսերի բնական աճի համար։",
        },
        invalidatesCognitivePath: true,
        invalidatesTeachingContent: true,
        requiresAcceptedCognitivePath: false,
      }).finally(() => {
        mutationSettled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(mutationSettled, false, "mutation must wait for the approval lock");
      await approver.query("COMMIT");
      const mutation = await mutationPromise;
      assert.equal(mutation.found, true);
      assert.equal("updated" in mutation && mutation.updated, true);
    } catch (error) {
      await approver.query("ROLLBACK");
      throw error;
    } finally {
      await approver.end();
    }

    const after = await getNodeAndLevels();
    assert.equal(after.currentNode.status, "needs_review");
    assert.equal(after.currentNode.cogPathStatus, "needs_review");
  });

  await test("U: zero Cognitive Levels is the missing-path state", async () => {
    await setPath([]);
    await db.update(lessonNodesTable)
      .set({ cogPathStatus: null })
      .where(eq(lessonNodesTable.id, node.id));
    const current = await getNodeAndLevels();
    assert.equal(current.levels.length, 0);
    assert.equal(deriveCognitivePathReadState(current.currentNode.cogPathStatus, 0), "missing");
  });

  await test("V: first and additional manual levels synchronize null status to review-required", async () => {
    await setPath([]);
    await db.update(lessonNodesTable)
      .set({ cogPathStatus: null })
      .where(eq(lessonNodesTable.id, node.id));

    const first = await createTeacherCognitiveLevel(node.id, {
      cognitiveLevel: "understand",
      performanceObjective,
      successCriterion,
      minimumIndependentEvidence: 3,
      preferredInteractionTypes: ["multiple_choice"],
    });
    assert.ok(first);
    let current = await getNodeAndLevels();
    assert.equal(current.currentNode.cogPathStatus, "needs_review");
    assert.equal(deriveCognitivePathReadState(current.currentNode.cogPathStatus, current.levels.length), "review_required");

    const additional = await createTeacherCognitiveLevel(node.id, {
      cognitiveLevel: "apply",
      performanceObjective,
      successCriterion,
      minimumIndependentEvidence: 3,
      preferredInteractionTypes: ["short_answer"],
    });
    assert.ok(additional);
    current = await getNodeAndLevels();
    assert.equal(current.currentNode.cogPathStatus, "needs_review");
    assert.equal(current.levels.length, 2);
    assert.notEqual(current.currentNode.cogPathStatus, "confirmed");
  });

  await test("W: editing an unconfirmed path preserves synchronized review state", async () => {
    const [level] = await setPath([
      { cognitiveLevel: "understand", isTargetCeiling: true },
    ]);
    const updated = await updateTeacherCognitiveLevel(node.id, level, {
      successCriterion: "Սովորողը ճիշտ է բացատրում ջրի դերը կյանքի համար։",
    });
    assert.ok(updated);
    const current = await getNodeAndLevels();
    assert.equal(current.currentNode.cogPathStatus, "needs_review");
    assert.equal(deriveCognitivePathReadState(current.currentNode.cogPathStatus, current.levels.length), "review_required");
  });

  await test("X: deletion synchronizes review while rows remain and missing after the final row", async () => {
    const levels = await setPath([
      { cognitiveLevel: "understand" },
      { cognitiveLevel: "apply", isTargetCeiling: true },
    ], { cogPathStatus: "confirmed", targetBloomLevel: 3 });

    assert.deepEqual(
      await deleteAuthoredCognitiveLevel(lesson.id, node.id, levels[1].id),
      { found: true, deleted: true },
    );
    let current = await getNodeAndLevels();
    assert.equal(current.currentNode.cogPathStatus, "needs_review");
    assert.equal(deriveCognitivePathReadState(current.currentNode.cogPathStatus, current.levels.length), "review_required");

    assert.deepEqual(
      await deleteAuthoredCognitiveLevel(lesson.id, node.id, levels[0].id),
      { found: true, deleted: true },
    );
    current = await getNodeAndLevels();
    assert.equal(current.currentNode.cogPathStatus, null);
    assert.equal(deriveCognitivePathReadState(current.currentNode.cogPathStatus, current.levels.length), "missing");
  });

  await test("Y: lesson summary semantics use row existence plus confirmation state", async () => {
    const states = [
      deriveCognitivePathReadState(null, 0),
      deriveCognitivePathReadState(null, 1),
      deriveCognitivePathReadState("needs_review", 2),
      deriveCognitivePathReadState("confirmed", 1),
    ];
    assert.deepEqual(states, ["missing", "review_required", "review_required", "confirmed"]);
    assert.equal(states.filter((state) => state !== "missing").length, 3);
    assert.equal(states.filter((state) => state === "missing").length, 1);
    assert.equal(states.filter((state) => state === "review_required").length, 2);
    assert.equal(states.filter((state) => state === "confirmed").length, 1);
  });

  await test("Z: target-ceiling change invalidates confirmation without auto-confirming", async () => {
    const levels = await setPath([
      { cognitiveLevel: "understand" },
      { cognitiveLevel: "apply", isTargetCeiling: true },
    ]);
    await assertConfirmedTarget("apply", 3);
    const updated = await updateTeacherCognitiveLevel(node.id, levels[0], {
      isTargetCeiling: true,
    });
    assert.ok(updated);
    const current = await getNodeAndLevels();
    assert.equal(current.currentNode.cogPathStatus, "needs_review");
    assert.equal(current.levels.find((level) => level.id === levels[0].id)?.isTargetCeiling, true);
    assert.equal(current.levels.find((level) => level.id === levels[1].id)?.isTargetCeiling, false);
    const resolution = resolveCanonicalQuizTarget(current.currentNode, current.levels);
    assert.equal(resolution.valid, false);
    if (!resolution.valid) assert.equal(resolution.reason, "PATH_NOT_CONFIRMED");
  });
} finally {
  await factory.cleanup();
  await closeTestDb();
  await pool.end();
}

const failed = results.filter((result) => !result.pass);
console.log(`\nCognitive Path Authoring Integrity: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;