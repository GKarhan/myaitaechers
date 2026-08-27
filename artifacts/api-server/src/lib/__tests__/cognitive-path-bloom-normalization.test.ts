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
  deleteAuthoredCognitiveLevel,
  normalizeCognitivePathSequences,
} from "../cognitive-path-authoring.js";
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
} finally {
  await factory.cleanup();
  await closeTestDb();
  await pool.end();
}

const failed = results.filter((result) => !result.pass);
console.log(`\nCognitive Path Bloom normalization: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;