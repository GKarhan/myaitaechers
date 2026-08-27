import assert from "node:assert/strict";
import {
  db,
  lessonNodeCognitiveLevelsTable,
  lessonNodesTable,
  pool,
} from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import {
  createTeacherCognitiveLevel,
  updateTeacherCognitiveLevel,
} from "../cognitive-level-crud.js";
import {
  confirmAuthoredCognitivePath,
  deleteAuthoredCognitiveLevel,
  normalizeCognitivePathSequences,
} from "../cognitive-path-authoring.js";
import { resolveCanonicalQuizTarget } from "../cognitive-path-grounding.js";
import { assertTestDb, closeTestDb } from "./helpers/test-db.js";
import { createFactory } from "./helpers/fixture-factory.js";
import { makeRunId } from "./helpers/run-id.js";

assertTestDb();

const factory = createFactory(makeRunId());
const results: Array<{ name: string; pass: boolean }> = [];

async function test(name: string, run: () => Promise<void>) {
  try {
    await run();
    results.push({ name, pass: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, pass: false });
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}

async function getLevels(nodeId: number) {
  return db
    .select()
    .from(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId))
    .orderBy(
      asc(lessonNodeCognitiveLevelsTable.sequence),
      asc(lessonNodeCognitiveLevelsTable.id),
    );
}

function assertOrder(
  levels: Awaited<ReturnType<typeof getLevels>>,
  expected: string[],
) {
  assert.deepEqual(levels.map((level) => level.cognitiveLevel), expected);
  assert.deepEqual(levels.map((level) => level.sequence), expected.map((_, index) => index + 1));
}

try {
  const lesson = await factory.lesson(null, null, 18);

  await test("A: creating Understand after Apply persists Understand then Apply", async () => {
    const node = await factory.node(lesson.id, { title: "Create insertion order", sequence: 1 });
    const apply = await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "apply" });
    const understand = await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "understand" });
    assert.ok(apply && understand);
    assert.equal(understand.sequence, 1, "create response uses normalized persisted sequence");
    assertOrder(await getLevels(node.id), ["understand", "apply"]);
  });

  await test("B: creating Remember before Apply does not invent Understand", async () => {
    const node = await factory.node(lesson.id, { title: "No gap filling", sequence: 2 });
    await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "apply" });
    const remember = await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "remember" });
    assert.ok(remember);
    const levels = await getLevels(node.id);
    assertOrder(levels, ["remember", "apply"]);
    assert.equal(levels.some((level) => level.cognitiveLevel === "understand"), false);
  });

  await test("C: reusable normalizer canonicalizes legacy AI rows contiguously", async () => {
    const node = await factory.node(lesson.id, { title: "Legacy AI ordering", sequence: 3 });
    await db.insert(lessonNodeCognitiveLevelsTable).values([
      { lessonNodeId: node.id, cognitiveLevel: "evaluate", sequence: 1, provenance: "ai_generated" },
      { lessonNodeId: node.id, cognitiveLevel: "remember", sequence: 2, provenance: "ai_generated" },
      { lessonNodeId: node.id, cognitiveLevel: "apply", sequence: 3, provenance: "ai_generated" },
    ]);
    await db.transaction((tx) => normalizeCognitivePathSequences(tx, node.id));
    assertOrder(await getLevels(node.id), ["remember", "apply", "evaluate"]);
  });

  await test("D: changing Understand to Analyze repositions the same row after Apply", async () => {
    const node = await factory.node(lesson.id, { title: "Edit ordering", sequence: 4 });
    const understand = await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "understand" });
    await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "apply" });
    assert.ok(understand);
    const updated = await updateTeacherCognitiveLevel(node.id, understand, {
      cognitiveLevel: "analyze",
    });
    assert.ok(updated);
    assert.equal(updated.id, understand.id);
    assert.equal(updated.sequence, 2, "update response uses normalized persisted sequence");
    assertOrder(await getLevels(node.id), ["apply", "analyze"]);
  });

  await test("E: deleting Understand closes the sequence without filling the gap", async () => {
    const node = await factory.node(lesson.id, { title: "Delete ordering", sequence: 5 });
    const remember = await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "remember" });
    const understand = await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "understand" });
    const apply = await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "apply" });
    assert.ok(remember && understand && apply);
    assert.deepEqual(
      await deleteAuthoredCognitiveLevel(lesson.id, node.id, understand.id),
      { found: true, deleted: true },
    );
    assertOrder(await getLevels(node.id), ["remember", "apply"]);
  });

  await test("F: normalization preserves target ceiling on its existing row", async () => {
    const node = await factory.node(lesson.id, { title: "Target preservation", sequence: 6 });
    const apply = await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "apply" });
    assert.ok(apply);
    const targetedApply = await updateTeacherCognitiveLevel(node.id, apply, {
      isTargetCeiling: true,
    });
    assert.ok(targetedApply);
    await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "understand" });
    const levels = await getLevels(node.id);
    assertOrder(levels, ["understand", "apply"]);
    assert.equal(levels[0].isTargetCeiling, false);
    assert.equal(levels[1].id, apply.id);
    assert.equal(levels[1].isTargetCeiling, true);
  });

  await test("G: mutation plus normalization never auto-confirms", async () => {
    const node = await factory.node(lesson.id, { title: "No auto confirmation", sequence: 7 });
    await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "apply" });
    await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "understand" });
    const [currentNode] = await db
      .select({ cogPathStatus: lessonNodesTable.cogPathStatus })
      .from(lessonNodesTable)
      .where(eq(lessonNodesTable.id, node.id));
    assert.equal(currentNode.cogPathStatus, "needs_review");
  });

  await test("H: normalization changes only sequence and preserves pedagogical data", async () => {
    const node = await factory.node(lesson.id, { title: "Content preservation", sequence: 8 });
    const apply = await createTeacherCognitiveLevel(node.id, {
      cognitiveLevel: "apply",
      performanceObjective: "Կիրառել կանոնը նոր իրավիճակում։",
      successCriterion: "Ճիշտ լուծել նոր խնդիրը։",
      minimumIndependentEvidence: 5,
      preferredInteractionTypes: ["problem_solving", "constructed_response"],
    });
    assert.ok(apply);
    const before = (await getLevels(node.id))[0];
    await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "remember" });
    const after = (await getLevels(node.id)).find((level) => level.id === apply.id);
    assert.ok(after);
    const { sequence: _beforeSequence, ...beforeContent } = before;
    const { sequence: _afterSequence, ...afterContent } = after;
    assert.deepEqual(afterContent, beforeContent);
  });

  await test("I: duplicate Bloom-level protection remains fail-closed", async () => {
    const node = await factory.node(lesson.id, { title: "Duplicate protection", sequence: 9 });
    await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "apply" });
    const duplicate = await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "apply" });
    assert.equal(duplicate, null);
    assertOrder(await getLevels(node.id), ["apply"]);
  });

  await test("J: AI Apply plus manual Understand persists one canonical mixed-origin path", async () => {
    const node = await factory.node(lesson.id, { title: "Mixed-origin ordering", sequence: 10 });
    const [aiApply] = await db.insert(lessonNodeCognitiveLevelsTable).values({
      lessonNodeId: node.id,
      cognitiveLevel: "apply",
      sequence: 1,
      isTargetCeiling: true,
      provenance: "ai_generated",
    }).returning();
    const manualUnderstand = await createTeacherCognitiveLevel(node.id, {
      cognitiveLevel: "understand",
    });
    assert.ok(manualUnderstand);
    const levels = await getLevels(node.id);
    assertOrder(levels, ["understand", "apply"]);
    assert.equal(levels[0].provenance, "teacher_authored");
    assert.equal(levels[0].isTargetCeiling, false);
    assert.equal(levels[1].id, aiApply.id);
    assert.equal(levels[1].provenance, "ai_generated");
    assert.equal(levels[1].isTargetCeiling, true);
  });

  await test("K: manual Apply plus later manual Understand uses the same canonical order", async () => {
    const node = await factory.node(lesson.id, { title: "Manual-origin ordering", sequence: 11 });
    await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "apply" });
    await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "understand" });
    const levels = await getLevels(node.id);
    assertOrder(levels, ["understand", "apply"]);
    assert.deepEqual(levels.map((level) => level.provenance), [
      "teacher_authored",
      "teacher_authored",
    ]);
  });

  await test("L: target changes preserve origin and unrelated target flags", async () => {
    const node = await factory.node(lesson.id, { title: "Target-origin independence", sequence: 12 });
    const understand = await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "understand" });
    const apply = await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "apply" });
    assert.ok(understand && apply);
    const targeted = await updateTeacherCognitiveLevel(node.id, apply, {
      isTargetCeiling: true,
    });
    assert.ok(targeted);
    const levels = await getLevels(node.id);
    assert.equal(levels.find((level) => level.id === understand.id)?.isTargetCeiling, false);
    assert.equal(levels.find((level) => level.id === understand.id)?.provenance, "teacher_authored");
    assert.equal(levels.find((level) => level.id === apply.id)?.isTargetCeiling, true);
    assert.equal(levels.find((level) => level.id === apply.id)?.provenance, "teacher_authored");
  });

  await test("M: teacher editing an AI level records teacher authorship without changing its target role", async () => {
    const node = await factory.node(lesson.id, { title: "AI edit provenance", sequence: 13 });
    const [aiLevel] = await db.insert(lessonNodeCognitiveLevelsTable).values({
      lessonNodeId: node.id,
      cognitiveLevel: "apply",
      sequence: 1,
      isTargetCeiling: true,
      provenance: "ai_generated",
      performanceObjective: "Սովորողը կիրառում է կանոնը նոր իրավիճակում։",
    }).returning();
    const updated = await updateTeacherCognitiveLevel(node.id, aiLevel, {
      performanceObjective: "Սովորողը ինքնուրույն կիրառում է կանոնը նոր իրավիճակում։",
    });
    assert.ok(updated);
    assert.equal(updated.provenance, "teacher_authored");
    assert.equal(updated.isTargetCeiling, true);
  });

  await test("N: path confirmation changes path state without rewriting level provenance", async () => {
    const node = await factory.node(lesson.id, {
      title: "Confirmation provenance independence",
      sequence: 14,
      theoryContent: "Ջուրը կարևոր է կյանքի համար և անհրաժեշտ է բույսերի աճի համար։",
      learningObjective: "Սովորողը բացատրում է ջրի կարևորությունը կյանքի համար։",
    });
    await db.insert(lessonNodeCognitiveLevelsTable).values({
      lessonNodeId: node.id,
      cognitiveLevel: "understand",
      sequence: 1,
      isTargetCeiling: true,
      provenance: "ai_generated",
      performanceObjective: "Սովորողը բացատրում է ջրի կարևորությունը կյանքի համար։",
      successCriterion: "Ճիշտ է նշում ջրի կարևորությունը կյանքի համար։",
      preferredInteractionTypes: ["multiple_choice"],
    });
    await db.update(lessonNodesTable)
      .set({ cogPathStatus: "needs_review" })
      .where(eq(lessonNodesTable.id, node.id));
    const result = await confirmAuthoredCognitivePath(lesson.id, node.id);
    assert.equal(result.found, true);
    assert.equal("confirmed" in result && result.confirmed, true);
    assert.equal((await getLevels(node.id))[0].provenance, "ai_generated");
  });

  await test("O: equivalent confirmed AI and manual paths resolve identically", async () => {
    const nodes = await Promise.all([
      factory.node(lesson.id, {
        title: "AI resolver parity",
        sequence: 15,
        theoryContent: "Ջուրը կարևոր է կյանքի համար և անհրաժեշտ է բույսերի աճի համար։",
        learningObjective: "Սովորողը բացատրում է ջրի կարևորությունը կյանքի համար։",
      }),
      factory.node(lesson.id, {
        title: "Manual resolver parity",
        sequence: 16,
        theoryContent: "Ջուրը կարևոր է կյանքի համար և անհրաժեշտ է բույսերի աճի համար։",
        learningObjective: "Սովորողը բացատրում է ջրի կարևորությունը կյանքի համար։",
      }),
    ]);
    for (const [index, node] of nodes.entries()) {
      await db.insert(lessonNodeCognitiveLevelsTable).values({
        lessonNodeId: node.id,
        cognitiveLevel: "understand",
        sequence: 1,
        isTargetCeiling: true,
        provenance: index === 0 ? "ai_generated" : "teacher_authored",
        performanceObjective: "Սովորողը բացատրում է ջրի կարևորությունը կյանքի համար։",
        successCriterion: "Ճիշտ է նշում ջրի կարևորությունը կյանքի համար։",
        preferredInteractionTypes: ["multiple_choice"],
      });
      await db.update(lessonNodesTable)
        .set({ cogPathStatus: "needs_review" })
        .where(eq(lessonNodesTable.id, node.id));
    }
    for (const node of nodes) {
      const [currentNode] = await db.select()
        .from(lessonNodesTable)
        .where(eq(lessonNodesTable.id, node.id));
      const unconfirmed = resolveCanonicalQuizTarget(currentNode, await getLevels(node.id));
      assert.equal(unconfirmed.valid, false);
      if (!unconfirmed.valid) assert.equal(unconfirmed.reason, "PATH_NOT_CONFIRMED");
      const confirmation = await confirmAuthoredCognitivePath(lesson.id, node.id);
      assert.equal(confirmation.found, true);
      assert.equal("confirmed" in confirmation && confirmation.confirmed, true);
    }
    const resolutions = await Promise.all(nodes.map(async (node) => {
      const [currentNode] = await db.select()
        .from(lessonNodesTable)
        .where(eq(lessonNodesTable.id, node.id));
      return resolveCanonicalQuizTarget(currentNode, await getLevels(node.id));
    }));
    assert.deepEqual(
      resolutions.map((resolution) => (
        resolution.valid
          ? { valid: true, cognitiveLevel: resolution.cognitiveLevel }
          : resolution
      )),
      [
        { valid: true, cognitiveLevel: "understand" },
        { valid: true, cognitiveLevel: "understand" },
      ],
    );
  });

  await test("P: repeated persisted reads preserve normalized sequence without client reconstruction", async () => {
    const node = await factory.node(lesson.id, { title: "Read-model sequence authority", sequence: 17 });
    await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "apply" });
    await createTeacherCognitiveLevel(node.id, { cognitiveLevel: "understand" });
    const firstRead = await getLevels(node.id);
    const secondRead = await getLevels(node.id);
    assertOrder(firstRead, ["understand", "apply"]);
    assert.deepEqual(
      secondRead.map(({ id, cognitiveLevel, sequence, provenance, isTargetCeiling }) => ({
        id,
        cognitiveLevel,
        sequence,
        provenance,
        isTargetCeiling,
      })),
      firstRead.map(({ id, cognitiveLevel, sequence, provenance, isTargetCeiling }) => ({
        id,
        cognitiveLevel,
        sequence,
        provenance,
        isTargetCeiling,
      })),
    );
  });
} finally {
  await factory.cleanup();
  await closeTestDb();
  await pool.end();
}

const failed = results.filter((result) => !result.pass);
console.log(`\nCognitive Path Bloom normalization: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;