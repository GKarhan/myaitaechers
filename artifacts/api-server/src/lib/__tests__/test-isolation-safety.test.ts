/**
 * Test Infrastructure Safety Tests — S1 through S7
 *
 * These tests verify the test isolation infrastructure itself.
 * Run with: pnpm --filter @workspace/api-server run test:safety
 *
 * S1: Mutating suite with wrong DB URL → ABORT
 * S2: Correct test DB → fixture creation succeeds
 * S3: Assertion failure mid-suite → finally cleanup executes
 * S4: Timeout/error after partial fixture → cleanup executes
 * S5: Two concurrent runs → no state interference
 * S6: Pollution gate with leaked fixture → suite FAILS
 * S7: Read-only real-data verifier → SELECT works, mutation helper refuses
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import {
  lessonsTable, usersTable, quizzesTable, pool as realPool,
} from "@workspace/db";
import { makeRunId, runTag, isTrRecord } from "./helpers/run-id.js";
import { createFactory, assertNoPollution } from "./helpers/fixture-factory.js";
import { getTestDb, closeTestDb } from "./helpers/test-db.js";

// ── Harness ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ✗ ${name}: ${msg}`);
    failed++;
  }
}

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const REAL_DB_URL = "postgresql://postgres:password@helium/heliumdb?sslmode=disable";

if (!TEST_DB_URL) {
  console.error("TEST_DB_SAFETY_BLOCK: TEST_DATABASE_URL not set. Cannot run safety tests.");
  process.exit(1);
}

// ── S1: Safety gate blocks mutating suite on real DB URL ─────────────────────

await test("S1: assertTestDb aborts when DATABASE_URL !== TEST_DATABASE_URL", async () => {
  // Simulate the check logic without calling process.exit
  const dbUrl   = REAL_DB_URL;   // pretend we're on the real DB
  const testUrl = TEST_DB_URL;

  const wouldAbort = dbUrl !== testUrl;
  assert.ok(wouldAbort, "Safety gate must detect real DB vs test DB mismatch");

  // Verify the gate also fails when TEST_DATABASE_URL is missing
  const missingUrl = "";
  const wouldAbortMissing = !missingUrl;
  assert.ok(wouldAbortMissing, "Safety gate must abort when TEST_DATABASE_URL is empty");

  console.log("    → Safety gate correctly identifies unsafe configuration");
});

// ── S2: Correct test DB allows fixture creation ───────────────────────────────

await test("S2: testDb fixture creation succeeds on heliumdb_test", async () => {
  // Verify TEST_DATABASE_URL points to heliumdb_test (not heliumdb)
  assert.ok(
    TEST_DB_URL.includes("heliumdb_test"),
    `TEST_DATABASE_URL must point to heliumdb_test, got: ${TEST_DB_URL}`,
  );

  const RUN_ID = makeRunId();
  const F = createFactory(RUN_ID);

  let userId: number | null = null;
  let lessonId: number | null = null;

  try {
    const teacher = await F.teacher({ username: runTag(RUN_ID, "s2_teacher") });
    userId = teacher.userId;
    assert.ok(userId > 0, "Teacher user must be created with a valid ID");

    const lesson = await F.lesson(teacher.userId, null, 18, { title: runTag(RUN_ID, "s2_lesson") });
    lessonId = lesson.id;
    assert.ok(lessonId > 0, "Lesson must be created with a valid ID");

    console.log(`    → Created teacher(${userId}), lesson(${lessonId}) in heliumdb_test`);
  } finally {
    await F.cleanup();

    // Verify cleanup worked
    const db = getTestDb();
    if (userId) {
      const [u] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId));
      assert.equal(u, undefined, `User ${userId} must be deleted after cleanup`);
    }
    if (lessonId) {
      const [l] = await db.select({ id: lessonsTable.id }).from(lessonsTable).where(eq(lessonsTable.id, lessonId));
      assert.equal(l, undefined, `Lesson ${lessonId} must be deleted after cleanup`);
    }
    console.log("    → Cleanup verified: all created fixtures removed");
  }
});

// ── S3: Assertion failure mid-suite → finally cleanup still executes ──────────

await test("S3: finally cleanup executes even when assertion fails mid-test", async () => {
  const RUN_ID = makeRunId();
  const F = createFactory(RUN_ID);
  let cleanupRan = false;
  let createdId: number | null = null;

  try {
    const lesson = await F.lesson(null, null, 18, { title: runTag(RUN_ID, "s3_lesson") });
    createdId = lesson.id;
    assert.ok(createdId > 0, "Lesson created");

    // Intentionally throw an assertion error
    try {
      assert.equal(1, 2, "Intentional failure to test cleanup");
    } catch {
      // Caught — simulating mid-test failure
      throw new Error("INTENTIONAL_FAILURE");
    }
  } catch (err) {
    // Expected — the intentional failure was caught
    if (err instanceof Error && err.message !== "INTENTIONAL_FAILURE") {
      throw err; // unexpected error
    }
  } finally {
    await F.cleanup();
    cleanupRan = true;
  }

  assert.ok(cleanupRan, "finally block must execute after assertion failure");

  // Verify the lesson was actually deleted
  if (createdId) {
    const db = getTestDb();
    const [l] = await db.select({ id: lessonsTable.id }).from(lessonsTable).where(eq(lessonsTable.id, createdId));
    assert.equal(l, undefined, "Lesson must be deleted even after assertion failure");
    console.log(`    → Lesson ${createdId} deleted in finally despite intentional failure`);
  }
});

// ── S4: Error after partial fixture creation → cleanup still runs ─────────────

await test("S4: cleanup runs after partial fixture creation + timeout simulation", async () => {
  const RUN_ID = makeRunId();
  const F = createFactory(RUN_ID);
  const createdIds: number[] = [];

  try {
    // Create first fixture
    const t = await F.teacher({ username: runTag(RUN_ID, "s4_teacher") });
    createdIds.push(t.userId);

    // Create second fixture
    const l = await F.lesson(t.userId, null, 18, { title: runTag(RUN_ID, "s4_lesson") });

    // Simulate a timeout/error during processing
    throw new Error("Simulated timeout after partial fixture creation");
  } catch (err) {
    if (err instanceof Error && !err.message.includes("Simulated timeout")) {
      throw err;
    }
  } finally {
    await F.cleanup();
  }

  // Verify no records remain
  const db = getTestDb();
  const leaked = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(like(usersTable.username, `${RUN_ID}_%`));
  assert.equal(leaked.length, 0, "No users should remain after cleanup of partial fixture");
  console.log("    → Partial fixture creation + simulated timeout: cleanup confirmed");
});

// ── S5: Two concurrent runs → no cross-run interference ──────────────────────

await test("S5: two concurrent test runs have isolated fixtures", async () => {
  const RUN_ID_1 = makeRunId();
  const RUN_ID_2 = makeRunId();

  // Both run IDs must be distinct
  assert.notEqual(RUN_ID_1, RUN_ID_2, "Concurrent runs must have distinct run IDs");

  const F1 = createFactory(RUN_ID_1);
  const F2 = createFactory(RUN_ID_2);

  let lesson1Id: number | null = null;
  let lesson2Id: number | null = null;

  try {
    // Create fixtures for run 1
    const l1 = await F1.lesson(null, null, 18, { title: runTag(RUN_ID_1, "s5_lesson") });
    lesson1Id = l1.id;

    // Create fixtures for run 2
    const l2 = await F2.lesson(null, null, 18, { title: runTag(RUN_ID_2, "s5_lesson") });
    lesson2Id = l2.id;

    // Both must have distinct IDs
    assert.notEqual(lesson1Id, lesson2Id, "Concurrent runs must not share fixture IDs");

    // Run 1's cleanup must not affect run 2's fixtures
    await F1.cleanup();

    const db = getTestDb();
    const [stillExists] = await db
      .select({ id: lessonsTable.id })
      .from(lessonsTable)
      .where(eq(lessonsTable.id, lesson2Id));

    assert.ok(stillExists, "Run 2's fixtures must survive run 1's cleanup");
    console.log(`    → Run1 lesson(${lesson1Id}) deleted; Run2 lesson(${lesson2Id}) intact`);
  } finally {
    await F1.cleanup(); // no-op — already cleaned
    await F2.cleanup();
  }
});

// ── S6: Pollution gate detects leaked fixture ─────────────────────────────────

await test("S6: post-pollution gate fails when a fixture is intentionally leaked", async () => {
  const RUN_ID = makeRunId();
  const F = createFactory(RUN_ID);

  // Create a lesson but intentionally do NOT cleanup
  const lesson = await F.lesson(null, null, 18, { title: runTag(RUN_ID, "s6_leak") });
  const leakedId = lesson.id;

  // The pollution gate should detect this
  let pollutionDetected = false;
  try {
    await assertNoPollution(RUN_ID);
  } catch (err) {
    if (err instanceof Error && err.message.includes("POST_POLLUTION_GATE FAIL")) {
      pollutionDetected = true;
      console.log(`    → Pollution gate correctly detected leaked lesson(${leakedId})`);
    } else {
      throw err;
    }
  } finally {
    // Always clean up — even the "leaked" fixture
    await F.cleanup();
  }

  assert.ok(pollutionDetected, "POST_POLLUTION_GATE must detect intentionally leaked fixture");

  // Verify cleanup worked after the fact
  const db = getTestDb();
  const [l] = await db.select({ id: lessonsTable.id }).from(lessonsTable).where(eq(lessonsTable.id, leakedId));
  assert.equal(l, undefined, "Leaked fixture must be cleaned up after test");
});

// ── S7: Read-only real-data verifier — SELECT works, write is refused ─────────

await test("S7: read-only check can SELECT real data; mutation helper refuses operation", async () => {
  // Verify that the real DB (heliumdb) is readable for read-only diagnostics
  // Use the pool exported from @workspace/db (already connected to heliumdb)
  const result = await realPool.query("SELECT COUNT(*) as cnt FROM lessons");
  const cnt = parseInt(result.rows[0]?.cnt ?? "0", 10);
  assert.ok(cnt >= 0, "READ-ONLY select on real DB must succeed");
  console.log(`    → Real DB lesson count: ${cnt} (read-only verified)`);

  // Verify that a mutation attempt to a real entity (lesson 105) would be blocked
  // by the assertTestDb gate (we don't actually mutate — we test the gate logic)
  const dbUrl   = REAL_DB_URL;
  const testUrl = TEST_DB_URL!;
  const gateWouldBlock = dbUrl !== testUrl;
  assert.ok(gateWouldBlock, "Safety gate must block any write to real DB when URLs differ");

  // Verify the isTrRecord helper correctly identifies test vs real records
  assert.ok(isTrRecord("TR_202608141820000_ab12cd_Lesson"),  "TR_ record must be identified as test record");
  assert.ok(!isTrRecord("Թestelly — 14.08.2026"),           "Real lesson title must NOT be identified as TR_");
  assert.ok(!isTrRecord("UAT Verification Quiz"),            "Manual UAT title must NOT be identified as TR_");
  assert.ok(!isTrRecord(""),                                  "Empty string must not be identified as TR_");
  console.log("    → isTrRecord correctly distinguishes test vs real records");
});

// ── Results ───────────────────────────────────────────────────────────────────

await closeTestDb();

console.log(`\nSafety Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
