/**
 * Package 1B / C1 MicroNode Teaching Package — focused persistence + policy tests.
 *
 * Run with:
 * DATABASE_URL=$TEST_DATABASE_URL pnpm --filter @workspace/api-server run test:c1-teaching-package
 */
import assert from "node:assert/strict";
import { and, asc, eq } from "drizzle-orm";
import {
  lessonNodeCognitiveLevelsTable,
  lessonNodeTeachingPackageItemsTable,
  lessonNodesTable,
  lessonsTable,
  subjectsTable,
  TEACHING_PACKAGE_ITEM_TYPES,
} from "@workspace/db";
import { buildTemporarySequencePlan } from "../lesson-outcome-validation.js";
import {
  getDeterministicTeachingPackageSeedCandidates,
  isServerControlledTeachingPackageProvenance,
  provenanceAfterExplicitTeachingPackageApproval,
  requiresExplicitTeachingPackageApproval,
} from "../teaching-package.js";
import { assertTestDb, closeTestDb, getTestDb } from "./helpers/test-db.js";

assertTestDb();
const db = getTestDb();
const runId = `c1-teaching-${Date.now()}`;
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
let otherLessonId = 0;
let otherNodeId = 0;
let mainExplanationId = 0;

try {
  const [subject] = await db.insert(subjectsTable).values({ name: `${runId}-subject` })
    .returning({ id: subjectsTable.id });
  subjectId = subject.id;
  const [lesson] = await db.insert(lessonsTable).values({
    subjectId,
    title: `${runId}-lesson`,
    knowledgeBoundaries: ["Միայն հաստատված սահմանների ներսում"],
  }).returning({ id: lessonsTable.id });
  lessonId = lesson.id;
  const [node] = await db.insert(lessonNodesTable).values({
    lessonId,
    sequence: 1,
    title: `${runId}-node`,
    theoryContent: "Աղբյուրային բացատրություն",
    childFriendlyExplanation: "Պարզ բացատրություն",
    basicExamples: ["Օրինակ 1"],
    realLifeExamples: ["Կյանքից օրինակ"],
    commonMisconception: "Սխալ ըմբռնում",
    nonExamples: ["Հակաօրինակ"],
    contentSourceType: "textbook",
    status: "approved",
  }).returning({ id: lessonNodesTable.id });
  nodeId = node.id;
  const [otherLesson] = await db.insert(lessonsTable).values({
    subjectId,
    title: `${runId}-other-lesson`,
  }).returning({ id: lessonsTable.id });
  otherLessonId = otherLesson.id;
  const [otherNode] = await db.insert(lessonNodesTable).values({
    lessonId: otherLessonId,
    sequence: 1,
    title: `${runId}-other-node`,
    status: "approved",
  }).returning({ id: lessonNodesTable.id });
  otherNodeId = otherNode.id;
  await db.insert(lessonNodeCognitiveLevelsTable).values({
    lessonNodeId: nodeId,
    cognitiveLevel: "apply",
    sequence: 1,
    isApplicable: true,
    isTargetCeiling: true,
    provenance: "teacher_authored",
  });

  await test("all ten canonical item types persist independently", async () => {
    for (const itemType of TEACHING_PACKAGE_ITEM_TYPES) {
      const [item] = await db.insert(lessonNodeTeachingPackageItemsTable).values({
        lessonId,
        lessonNodeId: nodeId,
        itemType,
        content: `${itemType} նյութ`,
        sequence: 1,
        status: "draft",
        provenance: "teacher_created",
      }).returning();
      if (itemType === "MAIN_EXPLANATION") mainExplanationId = item.id;
    }
    const items = await db.select().from(lessonNodeTeachingPackageItemsTable)
      .where(eq(lessonNodeTeachingPackageItemsTable.lessonNodeId, nodeId));
    assert.equal(items.length, TEACHING_PACKAGE_ITEM_TYPES.length);
    assert.deepEqual(new Set(items.map((item) => item.itemType)), new Set(TEACHING_PACKAGE_ITEM_TYPES));
  });

  await test("database rejects a node paired with a different lesson", async () => {
    await assert.rejects(
      db.insert(lessonNodeTeachingPackageItemsTable).values({
        lessonId,
        lessonNodeId: otherNodeId,
        itemType: "KEY_FACT",
        content: "Խաչաձև սեփականության ստուգում",
        sequence: 1,
        status: "draft",
        provenance: "teacher_created",
      }),
    );
  });

  await test("MicroNode-wide and cognitive-level-specific items are distinct", async () => {
    await db.update(lessonNodeTeachingPackageItemsTable)
      .set({ cognitiveLevel: "apply" })
      .where(and(
        eq(lessonNodeTeachingPackageItemsTable.lessonNodeId, nodeId),
        eq(lessonNodeTeachingPackageItemsTable.itemType, "HINT"),
      ));
    const [hint] = await db.select().from(lessonNodeTeachingPackageItemsTable)
      .where(and(
        eq(lessonNodeTeachingPackageItemsTable.lessonNodeId, nodeId),
        eq(lessonNodeTeachingPackageItemsTable.itemType, "HINT"),
      ));
    const [fact] = await db.select().from(lessonNodeTeachingPackageItemsTable)
      .where(and(
        eq(lessonNodeTeachingPackageItemsTable.lessonNodeId, nodeId),
        eq(lessonNodeTeachingPackageItemsTable.itemType, "KEY_FACT"),
      ));
    assert.equal(hint.cognitiveLevel, "apply");
    assert.equal(fact.cognitiveLevel, null);
  });

  await test("only one approved primary MAIN_EXPLANATION is allowed", async () => {
    await db.update(lessonNodeTeachingPackageItemsTable)
      .set({ status: "approved", isPrimary: true })
      .where(eq(lessonNodeTeachingPackageItemsTable.id, mainExplanationId));
    await assert.rejects(
      db.insert(lessonNodeTeachingPackageItemsTable).values({
        lessonId,
        lessonNodeId: nodeId,
        itemType: "MAIN_EXPLANATION",
        content: "Երկրորդ բացատրություն",
        status: "approved",
        provenance: "teacher_created",
        isPrimary: true,
        sequence: 2,
      }),
    );
  });

  await test("AI-generated content requires explicit approval provenance", async () => {
    assert.equal(isServerControlledTeachingPackageProvenance("ai_generated_teacher_approved"), true);
    assert.equal(isServerControlledTeachingPackageProvenance("ai_generated"), false);
    assert.equal(requiresExplicitTeachingPackageApproval("ai_generated", "approved"), true);
    assert.equal(requiresExplicitTeachingPackageApproval("ai_generated", "draft"), false);
    assert.equal(
      provenanceAfterExplicitTeachingPackageApproval("ai_generated"),
      "ai_generated_teacher_approved",
    );
  });

  await test("same-type hint reorder has normalized collision-safe persistence", async () => {
    const [secondHint] = await db.insert(lessonNodeTeachingPackageItemsTable).values({
      lessonId,
      lessonNodeId: nodeId,
      itemType: "HINT",
      content: "Երկրորդ հուշում",
      sequence: 2,
      status: "draft",
      provenance: "teacher_created",
    }).returning();
    const [firstHint] = await db.select({ id: lessonNodeTeachingPackageItemsTable.id })
      .from(lessonNodeTeachingPackageItemsTable)
      .where(and(
        eq(lessonNodeTeachingPackageItemsTable.lessonNodeId, nodeId),
        eq(lessonNodeTeachingPackageItemsTable.itemType, "HINT"),
        eq(lessonNodeTeachingPackageItemsTable.sequence, 1),
      ));
    const plan = buildTemporarySequencePlan([1, 2], [secondHint.id, firstHint.id]);
    await db.transaction(async (tx) => {
      for (const step of plan) {
        await tx.update(lessonNodeTeachingPackageItemsTable)
          .set({ sequence: step.temporarySequence })
          .where(eq(lessonNodeTeachingPackageItemsTable.id, step.id));
      }
      for (const step of plan) {
        await tx.update(lessonNodeTeachingPackageItemsTable)
          .set({ sequence: step.finalSequence })
          .where(eq(lessonNodeTeachingPackageItemsTable.id, step.id));
      }
    });
    const hints = await db.select({
      id: lessonNodeTeachingPackageItemsTable.id,
      sequence: lessonNodeTeachingPackageItemsTable.sequence,
    }).from(lessonNodeTeachingPackageItemsTable)
      .where(and(
        eq(lessonNodeTeachingPackageItemsTable.lessonNodeId, nodeId),
        eq(lessonNodeTeachingPackageItemsTable.itemType, "HINT"),
      ))
      .orderBy(asc(lessonNodeTeachingPackageItemsTable.sequence));
    assert.deepEqual(hints.map((hint) => hint.id), [secondHint.id, firstHint.id]);
    assert.deepEqual(hints.map((hint) => hint.sequence), [1, 2]);
  });

  await test("deterministic existing fields seed draft items without changing the source node", async () => {
    const candidates = getDeterministicTeachingPackageSeedCandidates({
      id: nodeId,
      theoryContent: "Աղբյուրային բացատրություն",
      childFriendlyExplanation: "Պարզ բացատրություն",
      basicExamples: ["Օրինակ 1"],
      realLifeExamples: ["Կյանքից օրինակ"],
      commonMisconception: "Սխալ ըմբռնում",
      nonExamples: ["Հակաօրինակ"],
      contentSourceType: "textbook",
      createdBy: "ai",
    });
    assert.equal(candidates.every((candidate) => candidate.provenance === "source_material"), true);
    assert.equal(candidates.some((candidate) => candidate.itemType === "MAIN_EXPLANATION"), true);
    assert.equal(candidates.some((candidate) => candidate.itemType === "MISCONCEPTION"), true);
    const [sourceNode] = await db.select({ theoryContent: lessonNodesTable.theoryContent })
      .from(lessonNodesTable).where(eq(lessonNodesTable.id, nodeId));
    assert.equal(sourceNode.theoryContent, "Աղբյուրային բացատրություն");
  });

  await test("deleting an item leaves its MicroNode and Package 1A-independent data intact", async () => {
    await db.delete(lessonNodeTeachingPackageItemsTable)
      .where(eq(lessonNodeTeachingPackageItemsTable.id, mainExplanationId));
    const [node] = await db.select({ id: lessonNodesTable.id, theoryContent: lessonNodesTable.theoryContent })
      .from(lessonNodesTable).where(eq(lessonNodesTable.id, nodeId));
    assert.equal(node.id, nodeId);
    assert.equal(node.theoryContent, "Աղբյուրային բացատրություն");
  });
} finally {
  if (otherLessonId) await db.delete(lessonsTable).where(eq(lessonsTable.id, otherLessonId)).catch(() => {});
  if (lessonId) await db.delete(lessonsTable).where(eq(lessonsTable.id, lessonId)).catch(() => {});
  if (subjectId) await db.delete(subjectsTable).where(eq(subjectsTable.id, subjectId)).catch(() => {});
  await closeTestDb();
}

const failures = results.filter((result) => result.error);
console.log(`\nC1 MicroNode Teaching Package: ${results.length - failures.length}/${results.length} passing`);
if (failures.length > 0) process.exitCode = 1;