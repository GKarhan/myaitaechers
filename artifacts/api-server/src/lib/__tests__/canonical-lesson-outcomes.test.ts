/**
 * Package 1A / C1 canonical lesson outcomes — focused persistence + validation tests.
 *
 * Run with:
 *   DATABASE_URL=$TEST_DATABASE_URL pnpm --filter @workspace/api-server run test:c1-outcomes
 */
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import {
  lessonNodeCognitiveLevelsTable,
  lessonNodesTable,
  lessonOutcomeNodeAlignmentsTable,
  lessonOutcomesTable,
  lessonsTable,
  subjectsTable,
} from "@workspace/db";
import {
  buildTemporarySequencePlan,
  deriveNodeCognitiveCapacity,
  getAlignmentWarnings,
  isDepthWithinCapacity,
} from "../lesson-outcome-validation.js";
import { assertTestDb, closeTestDb, getTestDb } from "./helpers/test-db.js";

assertTestDb();
const db = getTestDb();
const runId = `c1-outcomes-${Date.now()}`;
const results: Array<{ name: string; error?: unknown }> = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, error });
    console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let subjectId = 0;
let lessonId = 0;
let nodeId = 0;
let outcomeId = 0;

try {
  const [subject] = await db.insert(subjectsTable).values({ name: `${runId}-subject` })
    .returning({ id: subjectsTable.id });
  subjectId = subject.id;
  const [lesson] = await db.insert(lessonsTable).values({
    subjectId,
    title: `${runId}-lesson`,
    lessonOutcomes: ["Հին վերջնարդյունք"],
  }).returning({ id: lessonsTable.id });
  lessonId = lesson.id;
  const [node] = await db.insert(lessonNodesTable).values({
    lessonId,
    sequence: 1,
    title: `${runId}-node`,
    status: "approved",
    targetBloomLevel: 3,
    cogPathStatus: "confirmed",
  }).returning({ id: lessonNodesTable.id });
  nodeId = node.id;
  await db.insert(lessonNodeCognitiveLevelsTable).values([
    { lessonNodeId: nodeId, cognitiveLevel: "remember", sequence: 1, isTargetCeiling: false, provenance: "teacher_authored" },
    { lessonNodeId: nodeId, cognitiveLevel: "understand", sequence: 2, isTargetCeiling: false, provenance: "teacher_authored" },
    { lessonNodeId: nodeId, cognitiveLevel: "apply", sequence: 3, isTargetCeiling: true, provenance: "teacher_authored" },
  ]);

  await test("canonical outcome preserves legacy JSON compatibility data", async () => {
    const [outcome] = await db.insert(lessonOutcomesTable).values({
      lessonId,
      outcomeText: "Սովորողը կարող է կիրառել կանոնը նոր առաջադրանքում։",
      sequence: 1,
      status: "draft",
      provenance: "teacher_authored",
    }).returning({ id: lessonOutcomesTable.id });
    outcomeId = outcome.id;

    const [lessonRow] = await db.select({ legacy: lessonsTable.lessonOutcomes })
      .from(lessonsTable).where(eq(lessonsTable.id, lessonId));
    assert.deepEqual(lessonRow.legacy, ["Հին վերջնարդյունք"]);
  });

  await test("required alignment persists against a confirmed current target ceiling", async () => {
    const [alignment] = await db.insert(lessonOutcomeNodeAlignmentsTable).values({
      lessonId,
      lessonOutcomeId: outcomeId,
      lessonNodeId: nodeId,
      role: "REQUIRED",
      requiredCognitiveDepth: "apply",
    }).returning();
    assert.equal(alignment.role, "REQUIRED");
    assert.equal(alignment.requiredCognitiveDepth, "apply");
  });

  await test("validated depth cannot exceed the MicroNode target ceiling", async () => {
    const capacity = deriveNodeCognitiveCapacity({
      targetBloomLevel: 3,
      cogPathStatus: "confirmed",
      levels: [
        { cognitiveLevel: "apply", isApplicable: true, isTargetCeiling: true },
      ],
    });
    assert.equal(capacity.depth, "apply");
    assert.equal(isDepthWithinCapacity("apply", capacity), true);
    assert.equal(isDepthWithinCapacity("analyze", capacity), false);
  });

  await test("unconfirmed required paths produce an explicit review warning", async () => {
    const capacity = deriveNodeCognitiveCapacity({
      targetBloomLevel: 3,
      cogPathStatus: "needs_review",
      levels: [
        { cognitiveLevel: "apply", isApplicable: true, isTargetCeiling: true },
      ],
    });
    assert.deepEqual(
      getAlignmentWarnings("REQUIRED", "apply", capacity).sort(),
      ["COGNITIVE_PATH_NOT_CONFIRMED", "REQUIRED_DEPTH_NEEDS_CONFIRMED_PATH"].sort(),
    );
  });

  await test("the same outcome-to-MicroNode relation cannot be duplicated", async () => {
    await assert.rejects(
      db.insert(lessonOutcomeNodeAlignmentsTable).values({
        lessonId,
        lessonOutcomeId: outcomeId,
        lessonNodeId: nodeId,
        role: "SUPPORTING",
        requiredCognitiveDepth: "understand",
      }),
    );
  });

  await test("adjacent outcome swaps have a collision-safe temporary sequence plan", async () => {
    const [secondOutcome] = await db.insert(lessonOutcomesTable).values({
      lessonId,
      outcomeText: "Երկրորդ վերջնարդյունք",
      sequence: 2,
      status: "draft",
      provenance: "teacher_authored",
    }).returning();
    const plan = buildTemporarySequencePlan([1, 2], [secondOutcome.id, outcomeId]);
    assert.equal(new Set(plan.map((step) => step.temporarySequence)).size, 2);
    assert.equal(plan.every((step) => step.temporarySequence > 2), true);

    // This reproduces the route's two-phase update. A direct [2,1] update
    // would violate the immediate unique index; moving both rows first must not.
    await db.transaction(async (tx) => {
      for (const step of plan) {
        await tx.update(lessonOutcomesTable)
          .set({ sequence: step.temporarySequence })
          .where(eq(lessonOutcomesTable.id, step.id));
      }
      for (const step of plan) {
        await tx.update(lessonOutcomesTable)
          .set({ sequence: step.finalSequence })
          .where(eq(lessonOutcomesTable.id, step.id));
      }
    });
    const reordered = await db.select({
      id: lessonOutcomesTable.id,
      sequence: lessonOutcomesTable.sequence,
    }).from(lessonOutcomesTable)
      .where(eq(lessonOutcomesTable.lessonId, lessonId))
      .orderBy(lessonOutcomesTable.sequence);
    assert.deepEqual(reordered.map((outcome) => outcome.id), [secondOutcome.id, outcomeId]);
    assert.deepEqual(reordered.map((outcome) => outcome.sequence), [1, 2]);
  });

  await test("deleting an outcome cascades only its own authoring relations", async () => {
    await db.delete(lessonOutcomesTable).where(eq(lessonOutcomesTable.id, outcomeId));
    const rows = await db.select().from(lessonOutcomeNodeAlignmentsTable)
      .where(and(
        eq(lessonOutcomeNodeAlignmentsTable.lessonId, lessonId),
        eq(lessonOutcomeNodeAlignmentsTable.lessonNodeId, nodeId),
      ));
    assert.equal(rows.length, 0);
  });
} finally {
  if (lessonId) await db.delete(lessonsTable).where(eq(lessonsTable.id, lessonId)).catch(() => {});
  if (subjectId) await db.delete(subjectsTable).where(eq(subjectsTable.id, subjectId)).catch(() => {});
  await closeTestDb();
}

const failures = results.filter((result) => result.error);
console.log(`\nC1 canonical lesson outcomes: ${results.length - failures.length}/${results.length} passing`);
if (failures.length > 0) process.exitCode = 1;