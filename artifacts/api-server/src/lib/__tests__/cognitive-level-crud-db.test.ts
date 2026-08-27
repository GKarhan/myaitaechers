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
import { assertTestDb, closeTestDb } from "./helpers/test-db.js";
import { createFactory } from "./helpers/fixture-factory.js";
import { makeRunId } from "./helpers/run-id.js";

assertTestDb();

const factory = createFactory(makeRunId());

try {
  const lesson = await factory.lesson(null, null, 18);
  const primaryNode = await factory.node(lesson.id, { title: "CRUD parity primary", sequence: 1 });
  const unrelatedNode = await factory.node(lesson.id, { title: "CRUD parity unrelated", sequence: 2 });

  const first = await createTeacherCognitiveLevel(primaryNode.id, {
    cognitiveLevel: "remember",
    performanceObjective: "Հիշել սահմանումը։",
    successCriterion: "Ճիշտ նշել սահմանումը։",
    minimumIndependentEvidence: 2,
    preferredInteractionTypes: ["multiple_choice", "short_answer"],
  });
  const second = await createTeacherCognitiveLevel(primaryNode.id, {
    cognitiveLevel: "apply",
    performanceObjective: "Կիրառել սահմանումը։",
    successCriterion: "Ճիշտ լուծել խնդիրը։",
    minimumIndependentEvidence: 3,
    preferredInteractionTypes: ["problem_solving"],
  });
  const unrelated = await createTeacherCognitiveLevel(unrelatedNode.id, {
    cognitiveLevel: "evaluate",
    minimumIndependentEvidence: 4,
    preferredInteractionTypes: ["constructed_response"],
  });

  assert.ok(first && second && unrelated);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.deepEqual(first.preferredInteractionTypes, ["multiple_choice", "short_answer"]);

  const [nodeBeforeDraftEdit] = await db.select({ targetBloomLevel: lessonNodesTable.targetBloomLevel })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, primaryNode.id));
  const targeted = await updateTeacherCognitiveLevel(primaryNode.id, first, { isTargetCeiling: true });
  assert.ok(targeted);
  const edited = await updateTeacherCognitiveLevel(primaryNode.id, targeted, {
    cognitiveLevel: "understand",
    performanceObjective: "Բացատրել սահմանումը սեփական բառերով։",
    successCriterion: "Բացատրությունը ներառում է երկու հիմնական հատկանիշները։",
    minimumIndependentEvidence: 5,
    preferredInteractionTypes: ["short_answer", "constructed_response"],
  });
  assert.ok(edited);

  assert.equal(edited.id, first.id, "edit updates the same row");
  assert.equal(edited.sequence, 1, "Bloom edit preserves sequence");
  assert.equal(edited.isTargetCeiling, true, "Bloom edit preserves target status");
  assert.equal(edited.cognitiveLevel, "understand");
  assert.equal(edited.minimumIndependentEvidence, 5);
  assert.deepEqual(edited.preferredInteractionTypes, ["short_answer", "constructed_response"]);
  assert.equal(edited.provenance, "teacher_authored");

  const [nodeAfterEdit] = await db.select({ targetBloomLevel: lessonNodesTable.targetBloomLevel })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, primaryNode.id));
  assert.equal(
    nodeAfterEdit.targetBloomLevel,
    nodeBeforeDraftEdit.targetBloomLevel,
    "draft target edits preserve the legacy copy until canonical confirmation",
  );

  const primaryLevels = await db.select()
    .from(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, primaryNode.id))
    .orderBy(asc(lessonNodeCognitiveLevelsTable.sequence));
  assert.deepEqual(
    primaryLevels.map((level) => level.cognitiveLevel),
    ["understand", "apply"],
    "read projection retains the path count and sequence after edit",
  );
  assert.equal(primaryLevels[1].id, second.id, "unrelated level in the same path is unchanged");
  assert.equal(primaryLevels[1].isTargetCeiling, false);

  const [unrelatedAfterEdit] = await db.select()
    .from(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.id, unrelated.id));
  assert.equal(unrelatedAfterEdit.cognitiveLevel, "evaluate");
  assert.equal(unrelatedAfterEdit.minimumIndependentEvidence, 4);
  assert.deepEqual(unrelatedAfterEdit.preferredInteractionTypes, ["constructed_response"]);

  const duplicate = await updateTeacherCognitiveLevel(primaryNode.id, edited, { cognitiveLevel: "apply" });
  assert.equal(duplicate, null, "duplicate Bloom levels are rejected without changing either row");

  const concurrentDistinctNode = await factory.node(lesson.id, { title: "Concurrent distinct", sequence: 3 });
  const [distinctA, distinctB] = await Promise.all([
    createTeacherCognitiveLevel(concurrentDistinctNode.id, { cognitiveLevel: "analyze" }),
    createTeacherCognitiveLevel(concurrentDistinctNode.id, { cognitiveLevel: "create" }),
  ]);
  assert.ok(distinctA && distinctB, "concurrent distinct levels both persist");
  const distinctRows = await db.select()
    .from(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, concurrentDistinctNode.id))
    .orderBy(asc(lessonNodeCognitiveLevelsTable.sequence));
  assert.deepEqual(distinctRows.map((row) => row.sequence), [1, 2], "concurrent creates receive unique contiguous sequences");

  const concurrentDuplicateNode = await factory.node(lesson.id, { title: "Concurrent duplicate", sequence: 4 });
  const duplicateResults = await Promise.all([
    createTeacherCognitiveLevel(concurrentDuplicateNode.id, { cognitiveLevel: "remember" }),
    createTeacherCognitiveLevel(concurrentDuplicateNode.id, { cognitiveLevel: "remember" }),
  ]);
  assert.equal(duplicateResults.filter(Boolean).length, 1, "one concurrent duplicate create succeeds");
  assert.equal(duplicateResults.filter((result) => result === null).length, 1, "one concurrent duplicate create returns a conflict");

  console.log("Cognitive Level CRUD persistence tests passed");
} finally {
  await factory.cleanup();
  await closeTestDb();
  await pool.end();
}