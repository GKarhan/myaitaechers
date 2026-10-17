import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

// Deliberately no fallback to DATABASE_URL. This suite creates only an isolated
// schema on the dedicated, local CI PostgreSQL service.
const testUrl = process.env.MAPPING_TEST_DATABASE_URL;
if (!testUrl) throw new Error("MAPPING_TEST_DATABASE_URL is required");
const parsed = new URL(testUrl);
if (
  !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
  parsed.pathname !== "/mapping_integration"
)
  throw new Error("Use the disposable local mapping_integration database only");
const schemaName = "mapping_test_" + process.pid;
const admin = new pg.Pool({ connectionString: testUrl });
const scoped = new URL(testUrl);
scoped.searchParams.set("options", "-c search_path=" + schemaName);
process.env.DATABASE_URL = scoped.toString();
const workspace = await import("@workspace/db");
const { claimMappingStage } = await import("../unified-mapping-job-claim.js");
const {
  retireInterruptedMapping,
  assertActiveMappingWriter,
  activeMappingJob,
} = await import("../unified-mapping-recovery.js");
const schema = await import("@workspace/db/schema");
const poolA = new pg.Pool({ connectionString: scoped.toString() });
const poolB = new pg.Pool({ connectionString: scoped.toString() });
const apiA = drizzle(poolA, { schema });
const apiB = drizzle(poolB, { schema });

before(async () => {
  await admin.query("CREATE SCHEMA " + schemaName);
  await poolA.query(`
    CREATE TABLE lessons (id serial PRIMARY KEY);
    CREATE TABLE lesson_nodes (id serial PRIMARY KEY, lesson_id integer NOT NULL REFERENCES lessons(id), title text);
    CREATE TABLE mapping_jobs (
      id serial PRIMARY KEY, lesson_id integer NOT NULL REFERENCES lessons(id),
      job_type text NOT NULL, status text NOT NULL DEFAULT 'pending',
      progress text, result jsonb, error text,
      created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX mapping_jobs_one_active_c1_per_lesson ON mapping_jobs(lesson_id)
      WHERE job_type = 'map' AND status IN ('pending', 'running');
  `);
});
beforeEach(async () => {
  await poolA.query(
    "TRUNCATE mapping_jobs, lesson_nodes, lessons RESTART IDENTITY CASCADE",
  );
  await poolA.query("INSERT INTO lessons(id) VALUES (1), (2)");
});
after(async () => {
  await Promise.all([poolA.end(), poolB.end(), workspace.pool.end()]);
  await admin.query("DROP SCHEMA " + schemaName + " CASCADE");
  await admin.end();
});
async function staleClaim(kind: "map" | "generate_teaching_content" = "map") {
  const claim = await claimMappingStage(1, kind, apiA);
  assert.ok(claim.job);
  const result = await poolA.query(
    "UPDATE mapping_jobs SET updated_at = now() - interval '31 minutes' WHERE id=$1 RETURNING updated_at",
    [claim.job.id],
  );
  return {
    id: claim.job.id,
    stamp: result.rows[0].updated_at.toISOString() as string,
  };
}

describe(
  "PostgreSQL mapping concurrency and fenced recovery",
  { concurrency: false },
  () => {
    it("accepts one of twelve concurrent C1 claims across separate API pools", async () => {
      const claims = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          claimMappingStage(1, "map", i % 2 ? apiA : apiB),
        ),
      );
      assert.equal(claims.filter((c) => "job" in c).length, 1);
      assert.equal(
        claims.filter(
          (c) => "error" in c && c.error === "MAPPING_ALREADY_IN_PROGRESS",
        ).length,
        11,
      );
      assert.equal(
        Number(
          (await poolA.query("SELECT count(*) FROM mapping_jobs")).rows[0]
            .count,
        ),
        1,
      );
    });
    it("does not require the optional unique index for the transactional claim", async () => {
      await poolA.query("DROP INDEX mapping_jobs_one_active_c1_per_lesson");
      try {
        const claims = await Promise.all([
          claimMappingStage(1, "map", apiA),
          claimMappingStage(1, "map", apiB),
        ]);
        assert.equal(claims.filter((c) => "job" in c).length, 1);
      } finally {
        await poolA.query(
          "CREATE UNIQUE INDEX mapping_jobs_one_active_c1_per_lesson ON mapping_jobs(lesson_id) WHERE job_type='map' AND status IN ('pending','running')",
        );
      }
    });
    it("serializes teaching jobs and allows different lessons independently", async () => {
      const claims = await Promise.all([
        claimMappingStage(1, "generate_teaching_content", apiA),
        claimMappingStage(1, "generate_teaching_content", apiB),
      ]);
      assert.equal(claims.filter((c) => "job" in c).length, 1);
      assert.ok("job" in (await claimMappingStage(2, "map", apiB)));
    });
    it("protects a canonical map after the old job is terminal", async () => {
      await poolA.query(
        "INSERT INTO lesson_nodes(lesson_id,title) VALUES(1,'teacher content')",
      );
      const claim = await claimMappingStage(1, "map", apiB);
      assert.ok("error" in claim);
      assert.equal(claim.error, "EXISTING_MAP_REQUIRES_EXPLICIT_REPLACEMENT");
    });
    it("requires explicit confirmation and rejects a changed heartbeat", async () => {
      const old = await staleClaim();
      assert.deepEqual(
        await retireInterruptedMapping(1, old.id, old.stamp, false, apiB),
        { error: "RECOVERY_CONFIRMATION_REQUIRED" },
      );
      await poolA.query(
        "UPDATE mapping_jobs SET updated_at=now() WHERE id=$1",
        [old.id],
      );
      assert.deepEqual(
        await retireInterruptedMapping(1, old.id, old.stamp, true, apiB),
        { error: "JOB_UPDATED_OR_NOT_STALE" },
      );
    });
    it("refuses automatic takeover of workers from before fencing was introduced", async () => {
      const old = await staleClaim();
      await poolA.query("UPDATE mapping_jobs SET result=null WHERE id=$1", [
        old.id,
      ]);
      assert.deepEqual(
        await retireInterruptedMapping(1, old.id, old.stamp, true, apiB),
        { error: "LEGACY_WORKER_REQUIRES_OPERATOR_REVIEW" },
      );
    });
    it("retires a lost worker, preserves data, and fences its late provider response", async () => {
      await poolA.query(
        "INSERT INTO lesson_nodes(lesson_id,title) VALUES(1,'teacher content')",
      );
      const old = await staleClaim("generate_teaching_content");
      assert.deepEqual(
        await retireInterruptedMapping(1, old.id, old.stamp, true, apiB),
        { retiredJobId: old.id },
      );
      const replacement = await claimMappingStage(
        1,
        "generate_teaching_content",
        apiB,
      );
      assert.ok(replacement.job);
      await assert.rejects(
        apiA.transaction(async (tx) => {
          await assertActiveMappingWriter(tx, 1, old.id);
          await poolA.query(
            "UPDATE lesson_nodes SET title='late obsolete result' WHERE lesson_id=1",
          );
        }),
        /MAPPING_WORKER_RETIRED/,
      );
      const resurrected = await apiA
        .update(workspace.mappingJobsTable)
        .set({ status: "completed" })
        .where(activeMappingJob(old.id))
        .returning();
      assert.equal(resurrected.length, 0);
      assert.equal(
        (await poolA.query("SELECT title FROM lesson_nodes")).rows[0].title,
        "teacher content",
      );
      await apiB.transaction(async (tx) =>
        assertActiveMappingWriter(tx, 1, replacement.job.id),
      );
    });
    it("rejects cross-lesson recovery without touching the original job", async () => {
      const old = await staleClaim();
      assert.deepEqual(
        await retireInterruptedMapping(2, old.id, old.stamp, true, apiB),
        { error: "MAPPING_JOB_NOT_FOUND" },
      );
      assert.equal(
        (await poolA.query("SELECT status FROM mapping_jobs")).rows[0].status,
        "pending",
      );
    });
  },
);
