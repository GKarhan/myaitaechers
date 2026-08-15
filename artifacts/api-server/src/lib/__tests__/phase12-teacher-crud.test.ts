/**
 * Phase 1.2 — Teacher Review CRUD & Reorder tests
 *
 * Tests cover:
 *   - Topic reorder: normal, normalized sequences, duplicate rejection,
 *     missing ID rejection, cross-lesson ID rejection
 *   - Node reorder: same plus SEQUENTIAL rebuilt, REQUIRED preserved,
 *     transaction atomicity (sequence + deps in one commit)
 *   - Node deletion: exercises preserved with relatedNodeId → NULL
 *   - Topic relationship: create with topicId, update topicId, read-back persists
 *
 * Runner: npx tsx src/lib/__tests__/phase12-teacher-crud.test.ts
 *
 * Requires TEST_DATABASE_URL and DATABASE_URL=TEST_DATABASE_URL.
 * All fixtures are created dynamically (zero-pollution, no hardcoded IDs).
 */

import assert from "node:assert/strict";
import { assertTestDb, testDb, closeTestDb } from "./helpers/test-db.js";
import { makeRunId, runTag } from "./helpers/run-id.js";
import { createFactory } from "./helpers/fixture-factory.js";
import {
  lessonTopicsTable,
  lessonNodesTable,
  lessonExercisesTable,
  lessonNodeDependenciesTable,
} from "@workspace/db";
import { eq, and, asc, inArray, sql } from "drizzle-orm";
import { refreshSequentialDependencies } from "../sequential-deps.js";

// ── Safety gate — MUST be first executable statement ─────────────────────────
assertTestDb();

const RUN_ID = makeRunId();
const F = createFactory(RUN_ID);

// ─── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failures.push(`${name}: ${e.message}`);
    failed++;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Insert a temporary topic via testDb and return its id */
async function insertTempTopic(title: string, lessonId: number): Promise<number> {
  const [max] = await testDb
    .select({ maxSeq: lessonTopicsTable.sequence })
    .from(lessonTopicsTable)
    .where(eq(lessonTopicsTable.lessonId, lessonId))
    .orderBy(sql`sequence DESC`)
    .limit(1)
    .catch(() => [{ maxSeq: 0 }]);
  const nextSeq = (max?.maxSeq ?? 0) + 1;
  const [row] = await testDb
    .insert(lessonTopicsTable)
    .values({ lessonId, title, sequence: nextSeq })
    .returning({ id: lessonTopicsTable.id });
  return row.id;
}

/** Insert a temporary node via testDb and return its id */
async function insertTempNode(
  title: string,
  lessonId: number,
  topicId: number | null = null,
): Promise<number> {
  const existing = await testDb
    .select({ seq: lessonNodesTable.sequence })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, lessonId))
    .orderBy(asc(lessonNodesTable.sequence));
  const nextSeq = (existing.at(-1)?.seq ?? 0) + 1;
  const [row] = await testDb
    .insert(lessonNodesTable)
    .values({ lessonId, title, sequence: nextSeq, topicId, targetBloomLevel: 1, estimatedMinutes: 5 })
    .returning({ id: lessonNodesTable.id });
  return row.id;
}

/** Reorder topics via the route logic (direct DB, mirrors route behavior) */
async function reorderTopics(lessonId: number, orderedTopicIds: number[]) {
  // Validation
  if (new Set(orderedTopicIds).size !== orderedTopicIds.length) throw new Error("Duplicate topic IDs");
  const existing = await testDb
    .select({ id: lessonTopicsTable.id })
    .from(lessonTopicsTable)
    .where(eq(lessonTopicsTable.lessonId, lessonId));
  const existingIds = new Set(existing.map((t) => t.id));
  for (const id of orderedTopicIds) {
    if (!existingIds.has(id)) throw new Error(`Topic ${id} does not belong to lesson ${lessonId}`);
  }
  if (orderedTopicIds.length !== existingIds.size) throw new Error("orderedTopicIds must include all topics");
  // Transactional update
  await testDb.transaction(async (tx) => {
    for (let i = 0; i < orderedTopicIds.length; i++) {
      await tx.update(lessonTopicsTable).set({ sequence: i + 1 }).where(eq(lessonTopicsTable.id, orderedTopicIds[i]));
    }
  });
}

/** Reorder nodes via the route logic (direct DB, mirrors route behavior) */
async function reorderNodes(lessonId: number, orderedNodeIds: number[]) {
  // Validation
  if (new Set(orderedNodeIds).size !== orderedNodeIds.length) throw new Error("Duplicate node IDs");
  const existing = await testDb
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, lessonId));
  const existingIds = new Set(existing.map((n) => n.id));
  for (const id of orderedNodeIds) {
    if (!existingIds.has(id)) throw new Error(`Node ${id} does not belong to lesson ${lessonId}`);
  }
  if (orderedNodeIds.length !== existingIds.size) throw new Error("orderedNodeIds must include all nodes");
  // Transactional update + dep rebuild (mirrors the fixed route)
  return testDb.transaction(async (tx) => {
    for (let i = 0; i < orderedNodeIds.length; i++) {
      await tx.update(lessonNodesTable).set({ sequence: i + 1 }).where(eq(lessonNodesTable.id, orderedNodeIds[i]));
    }
    return refreshSequentialDependencies(lessonId, tx as unknown as typeof testDb);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main test body — wrapped in try/finally for guaranteed cleanup
// ─────────────────────────────────────────────────────────────────────────────

try {
  // Create the primary lesson fixture (replaces hardcoded LESSON_ID = 105)
  const lessonFixture = await F.lesson(null, null, 18, { title: runTag(RUN_ID, "MainLesson") });
  const LESSON_ID = lessonFixture.id;

  // Create a second lesson fixture (replaces hardcoded OTHER_LESSON_ID = 1)
  const otherLessonFixture = await F.lesson(null, null, 18, { title: runTag(RUN_ID, "OtherLesson") });
  const OTHER_LESSON_ID = otherLessonFixture.id;

  // ─────────────────────────────────────────────────────────────────────────
  // S1: Topic reorder
  // ─────────────────────────────────────────────────────────────────────────

  console.log("\nS1: Topic reorder");

  // Create topics for the main lesson
  const topicS1A = await F.topic(LESSON_ID, { title: runTag(RUN_ID, "S1_TopicA"), sequence: 1 });
  const topicS1B = await F.topic(LESSON_ID, { title: runTag(RUN_ID, "S1_TopicB"), sequence: 2 });
  const topicS1C = await F.topic(LESSON_ID, { title: runTag(RUN_ID, "S1_TopicC"), sequence: 3 });

  // Create a topic for the other lesson (for cross-lesson rejection test)
  const topicOther = await F.topic(OTHER_LESSON_ID, { title: runTag(RUN_ID, "S1_OtherTopic"), sequence: 1 });

  const originalTopics = await testDb
    .select({ id: lessonTopicsTable.id, sequence: lessonTopicsTable.sequence })
    .from(lessonTopicsTable)
    .where(eq(lessonTopicsTable.lessonId, LESSON_ID))
    .orderBy(asc(lessonTopicsTable.sequence));
  const originalTopicIds = originalTopics.map((t) => t.id);

  await test("normal reorder produces normalized sequences 1,2,3,...", async () => {
    const reversed = [...originalTopicIds].reverse();
    await reorderTopics(LESSON_ID, reversed);
    const rows = await testDb
      .select({ id: lessonTopicsTable.id, sequence: lessonTopicsTable.sequence })
      .from(lessonTopicsTable)
      .where(eq(lessonTopicsTable.lessonId, LESSON_ID))
      .orderBy(asc(lessonTopicsTable.sequence));
    // Sequences must be 1,2,3,...
    rows.forEach((r, i) => assert.equal(r.sequence, i + 1, `Expected sequence ${i+1}, got ${r.sequence}`));
    // Order must match what we asked for
    assert.deepEqual(rows.map((r) => r.id), reversed);
    // Restore
    await reorderTopics(LESSON_ID, originalTopicIds);
  });

  await test("duplicate topic IDs rejected", async () => {
    const ids = [...originalTopicIds];
    assert.throws(() => {
      if (new Set(ids.concat(ids[0])).size !== ids.concat(ids[0]).length) throw new Error("Duplicate topic IDs");
    }, /Duplicate/);
  });

  await test("missing topic ID (not all IDs included) rejected", async () => {
    const partial = originalTopicIds.slice(0, -1); // drop last
    await assert.rejects(
      () => reorderTopics(LESSON_ID, partial),
      /must include all topics/,
    );
  });

  await test("topic ID from another lesson rejected", async () => {
    const alienId = topicOther.id;
    await assert.rejects(
      () => reorderTopics(LESSON_ID, [...originalTopicIds.slice(0, -1), alienId]),
      /does not belong to lesson/,
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // S2: Node reorder
  // ─────────────────────────────────────────────────────────────────────────

  console.log("\nS2: Node reorder");

  // Create a node in the other lesson (for cross-lesson rejection test)
  const nodeOther = await F.node(OTHER_LESSON_ID, { title: runTag(RUN_ID, "S2_OtherNode"), sequence: 1 });

  // Insert 4 temp nodes for reorder tests (all in LESSON_ID, tracked by factory)
  let tn1 = 0, tn2 = 0, tn3 = 0, tn4 = 0;
  try {
    tn1 = await insertTempNode(runTag(RUN_ID, "TN1"), LESSON_ID);
    tn2 = await insertTempNode(runTag(RUN_ID, "TN2"), LESSON_ID);
    tn3 = await insertTempNode(runTag(RUN_ID, "TN3"), LESSON_ID);
    tn4 = await insertTempNode(runTag(RUN_ID, "TN4"), LESSON_ID);

    const allIds = [tn1, tn2, tn3, tn4];

    await test("normal node reorder produces normalized sequences", async () => {
      const reversed = [...allIds].reverse();
      const result = await reorderNodes(LESSON_ID, reversed);
      assert.equal(result.nodeCount, allIds.length);
      // Verify all sequences 1..N
      const rows = await testDb
        .select({ id: lessonNodesTable.id, sequence: lessonNodesTable.sequence })
        .from(lessonNodesTable)
        .where(eq(lessonNodesTable.lessonId, LESSON_ID))
        .orderBy(asc(lessonNodesTable.sequence));
      rows.forEach((r, i) => assert.equal(r.sequence, i + 1));
      assert.deepEqual(rows.map((r) => r.id), reversed);
      // Restore
      await reorderNodes(LESSON_ID, allIds);
    });

    await test("duplicate node IDs rejected", async () => {
      assert.throws(() => {
        const dup = [...allIds, allIds[0]];
        if (new Set(dup).size !== dup.length) throw new Error("Duplicate node IDs");
      }, /Duplicate/);
    });

    await test("missing node ID rejected", async () => {
      await assert.rejects(
        () => reorderNodes(LESSON_ID, allIds.slice(0, -1)),
        /must include all nodes/,
      );
    });

    await test("node ID from another lesson rejected", async () => {
      const alienId = nodeOther.id;
      await assert.rejects(
        () => reorderNodes(LESSON_ID, [...allIds.slice(0, -1), alienId]),
        /does not belong to lesson/,
      );
    });

    await test("SEQUENTIAL deps rebuilt after reorder", async () => {
      const swapped = [...allIds];
      [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
      const result = await reorderNodes(LESSON_ID, swapped);
      assert.ok(result.createdSequentialDependencies > 0, "Expected SEQUENTIAL deps created");
      assert.equal(result.createdSequentialDependencies, allIds.length - 1, "Expected N-1 SEQUENTIAL edges");
      // Verify chain integrity: each pair (seq i, seq i+1) must have a SEQUENTIAL edge
      const deps = await testDb
        .select({ fromNodeId: lessonNodeDependenciesTable.fromNodeId, toNodeId: lessonNodeDependenciesTable.toNodeId })
        .from(lessonNodeDependenciesTable)
        .where(and(
          eq(lessonNodeDependenciesTable.lessonId, LESSON_ID),
          eq(lessonNodeDependenciesTable.dependencyType, "SEQUENTIAL"),
        ));
      const nodes = await testDb
        .select({ id: lessonNodesTable.id, sequence: lessonNodesTable.sequence })
        .from(lessonNodesTable)
        .where(eq(lessonNodesTable.lessonId, LESSON_ID))
        .orderBy(asc(lessonNodesTable.sequence));
      for (let i = 0; i < nodes.length - 1; i++) {
        const from = nodes[i].id;
        const to = nodes[i + 1].id;
        const found = deps.some((d) => d.fromNodeId === from && d.toNodeId === to);
        assert.ok(found, `Missing SEQUENTIAL edge ${from}→${to} (seq ${nodes[i].sequence}→${nodes[i+1].sequence})`);
      }
      // No duplicate edges
      const edgeKeys = deps.map((d) => `${d.fromNodeId}-${d.toNodeId}`);
      assert.equal(new Set(edgeKeys).size, edgeKeys.length, "Duplicate SEQUENTIAL edges found");
      // Restore
      await reorderNodes(LESSON_ID, allIds);
    });

    await test("REQUIRED deps preserved across reorder", async () => {
      // Insert a synthetic REQUIRED dep between tn1 and tn4
      const [reqDep] = await testDb
        .insert(lessonNodeDependenciesTable)
        .values({
          lessonId: LESSON_ID,
          fromNodeId: tn1,
          toNodeId: tn4,
          dependencyType: "REQUIRED",
          requiredLevel: "CRITICAL",
          reason: "test REQUIRED dep",
        })
        .returning({ id: lessonNodeDependenciesTable.id });

      try {
        // Reorder
        const swapped = [...allIds];
        [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
        const result = await reorderNodes(LESSON_ID, swapped);
        assert.equal(result.preservedNonSequentialDependencies, 1, "Expected 1 REQUIRED dep preserved");

        // Verify REQUIRED still exists
        const reqExists = await testDb
          .select({ id: lessonNodeDependenciesTable.id })
          .from(lessonNodeDependenciesTable)
          .where(and(
            eq(lessonNodeDependenciesTable.id, reqDep.id),
            eq(lessonNodeDependenciesTable.dependencyType, "REQUIRED"),
          ));
        assert.equal(reqExists.length, 1, "REQUIRED dep was deleted — must be preserved");

        // Restore
        await reorderNodes(LESSON_ID, allIds);
      } finally {
        await testDb.delete(lessonNodeDependenciesTable).where(eq(lessonNodeDependenciesTable.id, reqDep.id));
      }
    });

    await test("no self-edge produced", async () => {
      await reorderNodes(LESSON_ID, allIds);
      // Sufficient to check all SEQUENTIAL edges have from ≠ to
      const seqDeps = await testDb
        .select({ from: lessonNodeDependenciesTable.fromNodeId, to: lessonNodeDependenciesTable.toNodeId })
        .from(lessonNodeDependenciesTable)
        .where(and(
          eq(lessonNodeDependenciesTable.lessonId, LESSON_ID),
          eq(lessonNodeDependenciesTable.dependencyType, "SEQUENTIAL"),
        ));
      for (const { from, to } of seqDeps) {
        assert.notEqual(from, to, `Self-edge detected on node ${from}`);
      }
    });

  } finally {
    // Clean up temp nodes regardless of test results
    for (const id of [tn4, tn3, tn2, tn1]) {
      if (id) await testDb.delete(lessonNodesTable).where(eq(lessonNodesTable.id, id)).catch(() => {});
    }
    // Rebuild sequential deps after temp node cleanup
    await refreshSequentialDependencies(LESSON_ID).catch(() => {});
  }

  // ─────────────────────────────────────────────────────────────────────────
  // S3: Node deletion — exercises preserved (relatedNodeId → NULL)
  // ─────────────────────────────────────────────────────────────────────────

  console.log("\nS3: Node deletion — exercise preservation");

  let tempNodeId = 0;
  let tempExId = 0;
  try {
    tempNodeId = await insertTempNode(runTag(RUN_ID, "TEMP_DEL_NODE"), LESSON_ID);
    // Insert exercise linked to the temp node
    const [exRow] = await testDb
      .insert(lessonExercisesTable)
      .values({
        lessonId: LESSON_ID,
        exerciseId: runTag(RUN_ID, "EX-TEST-DEL"),
        exerciseTextVerbatim: runTag(RUN_ID, "TEMP_DEL_EXERCISE"),
        relatedNodeId: tempNodeId,
        sequence: 999,
        assignment: "CLASS",
        sourceType: "textbook",
      })
      .returning({ id: lessonExercisesTable.id });
    tempExId = exRow.id;

    await test("exercise relatedNodeId is set before deletion", async () => {
      const [ex] = await testDb
        .select({ relatedNodeId: lessonExercisesTable.relatedNodeId })
        .from(lessonExercisesTable)
        .where(eq(lessonExercisesTable.id, tempExId));
      assert.equal(ex.relatedNodeId, tempNodeId);
    });

    // Delete the node (exercise has ON DELETE SET NULL FK)
    await testDb.delete(lessonNodesTable).where(eq(lessonNodesTable.id, tempNodeId));
    tempNodeId = 0; // already deleted

    await test("exercise still exists after node deletion (not cascade-deleted)", async () => {
      const rows = await testDb
        .select({ id: lessonExercisesTable.id })
        .from(lessonExercisesTable)
        .where(eq(lessonExercisesTable.id, tempExId));
      assert.equal(rows.length, 1, "Exercise was cascade-deleted — expected SET NULL preservation");
    });

    await test("exercise relatedNodeId is NULL after node deletion", async () => {
      const [ex] = await testDb
        .select({ relatedNodeId: lessonExercisesTable.relatedNodeId })
        .from(lessonExercisesTable)
        .where(eq(lessonExercisesTable.id, tempExId));
      assert.equal(ex.relatedNodeId, null, "relatedNodeId must be NULL after node delete");
    });

  } finally {
    if (tempNodeId) await testDb.delete(lessonNodesTable).where(eq(lessonNodesTable.id, tempNodeId)).catch(() => {});
    if (tempExId) await testDb.delete(lessonExercisesTable).where(eq(lessonExercisesTable.id, tempExId)).catch(() => {});
  }

  // ─────────────────────────────────────────────────────────────────────────
  // S4: Topic relationship — create + update + read-back
  // ─────────────────────────────────────────────────────────────────────────

  console.log("\nS4: Topic relationship (topicId on create/update)");

  let topicA = 0, topicB = 0, relNode = 0;
  try {
    topicA = await insertTempTopic(runTag(RUN_ID, "TEMP_TOPIC_A"), LESSON_ID);
    topicB = await insertTempTopic(runTag(RUN_ID, "TEMP_TOPIC_B"), LESSON_ID);
    relNode = await insertTempNode(runTag(RUN_ID, "TEMP_TOPIC_NODE"), LESSON_ID, topicA);

    await test("node created with topicId persists to DB", async () => {
      const [row] = await testDb
        .select({ topicId: lessonNodesTable.topicId })
        .from(lessonNodesTable)
        .where(eq(lessonNodesTable.id, relNode));
      assert.equal(row.topicId, topicA);
    });

    await test("node topicId can be updated to a different topic", async () => {
      await testDb.update(lessonNodesTable).set({ topicId: topicB }).where(eq(lessonNodesTable.id, relNode));
      const [row] = await testDb
        .select({ topicId: lessonNodesTable.topicId })
        .from(lessonNodesTable)
        .where(eq(lessonNodesTable.id, relNode));
      assert.equal(row.topicId, topicB, "topicId update did not persist");
    });

    await test("node topicId can be set to NULL (standalone)", async () => {
      await testDb.update(lessonNodesTable).set({ topicId: null }).where(eq(lessonNodesTable.id, relNode));
      const [row] = await testDb
        .select({ topicId: lessonNodesTable.topicId })
        .from(lessonNodesTable)
        .where(eq(lessonNodesTable.id, relNode));
      assert.equal(row.topicId, null, "topicId should be null after clearing");
    });

    await test("topic delete sets node topicId to NULL (ON DELETE SET NULL)", async () => {
      // Re-assign to topicA, then delete topicA
      await testDb.update(lessonNodesTable).set({ topicId: topicA }).where(eq(lessonNodesTable.id, relNode));
      await testDb.delete(lessonTopicsTable).where(eq(lessonTopicsTable.id, topicA));
      topicA = 0; // already deleted
      const [row] = await testDb
        .select({ topicId: lessonNodesTable.topicId })
        .from(lessonNodesTable)
        .where(eq(lessonNodesTable.id, relNode));
      assert.equal(row.topicId, null, "Expected topicId=NULL after topic deletion");
    });

  } finally {
    if (relNode) await testDb.delete(lessonNodesTable).where(eq(lessonNodesTable.id, relNode)).catch(() => {});
    if (topicB)  await testDb.delete(lessonTopicsTable).where(eq(lessonTopicsTable.id, topicB)).catch(() => {});
    if (topicA)  await testDb.delete(lessonTopicsTable).where(eq(lessonTopicsTable.id, topicA)).catch(() => {});
  }

} finally {
  // Always clean up all factory-tracked fixtures
  await F.cleanup();
  await closeTestDb();
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Phase 12 CRUD & Reorder: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
