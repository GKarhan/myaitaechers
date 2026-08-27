/**
 * Topic deletion and sequence normalization regression tests.
 *
 * All writes are isolated to heliumdb_test by assertTestDb().
 */

import assert from "node:assert/strict";
import { and, asc, eq } from "drizzle-orm";
import { db, lessonTopicsTable } from "@workspace/db";
import { validateLessonForFinalApproval } from "../lesson-final-approval.js";
import { normalizeTopicSequences } from "../topic-sequence.js";
import { createFactory } from "./helpers/fixture-factory.js";
import { assertTestDb, closeTestDb, testDb } from "./helpers/test-db.js";
import { makeRunId, runTag } from "./helpers/run-id.js";

assertTestDb();

const F = createFactory(makeRunId());
let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ✗ ${name}: ${message}`);
    failures.push(`${name}: ${message}`);
    failed++;
  }
}

async function createTopicSet(label: string, sequences: number[] = [1, 2, 3]) {
  const lesson = await F.lesson(null, null, 18, { title: runTag(makeRunId(), label) });
  const topics = [];
  for (let i = 0; i < sequences.length; i++) {
    topics.push(await F.topic(lesson.id, {
      title: `${label}_${i}`,
      sequence: sequences[i],
    }));
  }
  return { lessonId: lesson.id, topicIds: topics.map((topic) => topic.id) };
}

async function deleteAndNormalize(lessonId: number, topicId: number) {
  await testDb.transaction(async (tx) => {
    await tx.delete(lessonTopicsTable).where(and(
      eq(lessonTopicsTable.id, topicId),
      eq(lessonTopicsTable.lessonId, lessonId),
    ));
    await normalizeTopicSequences(lessonId, tx as unknown as typeof db);
  });
}

async function readTopics(lessonId: number) {
  return testDb
    .select({ id: lessonTopicsTable.id, sequence: lessonTopicsTable.sequence })
    .from(lessonTopicsTable)
    .where(eq(lessonTopicsTable.lessonId, lessonId))
    .orderBy(asc(lessonTopicsTable.sequence), asc(lessonTopicsTable.id));
}

try {
  await test("A: deleting the middle topic normalizes [1,2,3] to [1,2]", async () => {
    const fixture = await createTopicSet("middle");
    await deleteAndNormalize(fixture.lessonId, fixture.topicIds[1]);
    assert.deepEqual((await readTopics(fixture.lessonId)).map((topic) => topic.sequence), [1, 2]);
  });

  await test("B: deleting the first topic normalizes [1,2,3] to [1,2]", async () => {
    const fixture = await createTopicSet("first");
    await deleteAndNormalize(fixture.lessonId, fixture.topicIds[0]);
    assert.deepEqual((await readTopics(fixture.lessonId)).map((topic) => topic.sequence), [1, 2]);
  });

  await test("C: deleting the last topic normalizes [1,2,3] to [1,2]", async () => {
    const fixture = await createTopicSet("last");
    await deleteAndNormalize(fixture.lessonId, fixture.topicIds[2]);
    assert.deepEqual((await readTopics(fixture.lessonId)).map((topic) => topic.sequence), [1, 2]);
  });

  await test("D: a legacy single topic at sequence 2 normalizes to [1]", async () => {
    const fixture = await createTopicSet("legacy", [2]);
    await testDb.transaction(async (tx) => {
      await normalizeTopicSequences(fixture.lessonId, tx as unknown as typeof db);
    });
    assert.deepEqual((await readTopics(fixture.lessonId)).map((topic) => topic.sequence), [1]);
  });

  await test("E: final approval has no sequence-gap error after delete/resequence", async () => {
    const fixture = await createTopicSet("approval");
    await deleteAndNormalize(fixture.lessonId, fixture.topicIds[1]);
    const validation = await validateLessonForFinalApproval(fixture.lessonId);
    assert.equal(
      validation.errors.some((issue) => issue.code === "INVALID_TOPIC_SEQUENCE_GAP"),
      false,
    );
  });

  await test("F: equal-sequence topics retain deterministic ID order", async () => {
    const fixture = await createTopicSet("ties", [2, 1, 2]);
    const originalIds = fixture.topicIds;
    await testDb.transaction(async (tx) => {
      await normalizeTopicSequences(fixture.lessonId, tx as unknown as typeof db);
    });
    const rows = await readTopics(fixture.lessonId);
    assert.deepEqual(rows.map((topic) => topic.id), [originalIds[1], originalIds[0], originalIds[2]]);
    assert.deepEqual(rows.map((topic) => topic.sequence), [1, 2, 3]);
  });
} finally {
  await F.cleanup();
  await closeTestDb();
}

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);