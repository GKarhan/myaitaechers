/**
 * Test Database Connection + Safety Gate
 *
 * All DB-mutating tests MUST call assertTestDb() before any write.
 * This prevents accidental mutation of the real manual-UAT database.
 *
 * Usage:
 *   import { testDb, assertTestDb } from "./helpers/test-db.js";
 *   assertTestDb(); // call at top of every mutating test file
 */

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@workspace/db";

const { Pool } = pg;

// ── Safety gate ───────────────────────────────────────────────────────────────

/**
 * Abort if we are not connected to the test database.
 *
 * Two independent checks must BOTH pass:
 *   1. DATABASE_URL must equal TEST_DATABASE_URL (same connection string)
 *   2. TEST_DATABASE_URL must explicitly be set (not absent/empty)
 *
 * A wrong NODE_ENV alone must not be enough to allow mutations on the real DB.
 */
export function assertTestDb(): void {
  const dbUrl   = process.env.DATABASE_URL   ?? "";
  const testUrl = process.env.TEST_DATABASE_URL ?? "";

  if (!testUrl) {
    console.error(
      "\nTEST_DB_SAFETY_BLOCK: TEST_DATABASE_URL is not set.\n" +
      "Set TEST_DATABASE_URL=postgresql://postgres:password@helium/heliumdb_test?sslmode=disable\n" +
      "Refusing to mutate any database without an explicit test DB URL.",
    );
    process.exit(1);
  }

  if (dbUrl !== testUrl) {
    console.error(
      "\nTEST_DB_SAFETY_BLOCK: Refusing to mutate non-test database.\n" +
      `  DATABASE_URL     : ${dbUrl}\n` +
      `  TEST_DATABASE_URL: ${testUrl}\n` +
      "These must be identical to run mutating tests.\n" +
      "Run tests with: TEST_DATABASE_URL=... DATABASE_URL=$TEST_DATABASE_URL tsx <test-file>",
    );
    process.exit(1);
  }
}

// ── Test DB connection ─────────────────────────────────────────────────────────

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

let _testPool: pg.Pool | null = null;
let _testDb: ReturnType<typeof drizzle<typeof schema>> | null = null;

/**
 * Lazy testDb — only created when accessed, so importing this module in a
 * read-only context (no assertTestDb call) does not fail if TEST_DATABASE_URL
 * is not set.
 */
function getTestPool(): pg.Pool {
  if (!TEST_DATABASE_URL) {
    throw new Error(
      "TEST_DB_SAFETY_BLOCK: TEST_DATABASE_URL not set. Cannot create test DB connection.",
    );
  }
  if (!_testPool) {
    _testPool = new Pool({ connectionString: TEST_DATABASE_URL });
  }
  return _testPool;
}

export function getTestDb() {
  if (!_testDb) {
    _testDb = drizzle(getTestPool(), { schema });
  }
  return _testDb;
}

/** Alias for ergonomics — accessed via getter so module-level is safe. */
export const testDb = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop) {
    return (getTestDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export async function closeTestDb(): Promise<void> {
  if (_testPool) {
    await _testPool.end();
    _testPool = null;
    _testDb   = null;
  }
}
