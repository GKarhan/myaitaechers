---
name: Test Isolation Infrastructure
description: Zero-pollution test isolation system — heliumdb_test, safety gate, fixture factory, safety tests S1-S7, migrated suites.
---

# Test Isolation Infrastructure (implemented 2026-08-14)

## Summary
All automated tests now use zero-pollution isolation. Real heliumdb is never mutated except via dynamically-created, runId-tagged fixtures that are guaranteed to be cleaned up.

## Architecture

### Separate test database
- `heliumdb_test` — PostgreSQL DB on same host (helium), schema-identical to heliumdb
- Created via `pg_dump --schema-only heliumdb | psql heliumdb_test`
- Seeded with: subjects table (4 rows copied from heliumdb)
- URL: `postgresql://postgres:password@helium/heliumdb_test?sslmode=disable`
- Env var: `TEST_DATABASE_URL` (set in workspace env)

### Infrastructure files (all in `artifacts/api-server/src/lib/__tests__/helpers/`)
- `test-db.ts` — `testDb` (Drizzle on heliumdb_test), `assertTestDb()` safety gate, `closeTestDb()`
- `run-id.ts` — `makeRunId()` → `TR_YYYYMMDDTHHMMSS_xxxxxx`; `runTag(runId, label)`; `isTrRecord(str)`
- `fixture-factory.ts` — `createFactory(runId)` → direct-DB fixtures in heliumdb_test; `cleanup()`; `assertNoPollution()`
- `http-fixture-factory.ts` — `createHttpFactory(runId, base, token)` → fixtures in heliumdb (for HTTP tests); `cleanup()`; `assertNoPollution()`; `preCleanupStaleTrRecords(runId)`

### Safety gate pattern
```ts
assertTestDb(); // MUST be first in every direct-DB mutating test
const RUN_ID = makeRunId();
const F = createFactory(RUN_ID);
try {
  // tests...
} finally {
  await F.cleanup();
}
await assertNoPollution(RUN_ID);
```

### Safety tests
File: `src/lib/__tests__/test-isolation-safety.test.ts` — S1–S7 all pass.
Run: `pnpm --filter @workspace/api-server run test:safety`
(requires `DATABASE_URL=$TEST_DATABASE_URL TEST_DATABASE_URL=...`)

## Package.json test scripts (api-server)
- `test:fast` — pure-logic, no DB (parser, validator, translations, coverage-validator, lo-validation)
- `test:integration` — DB tests, no AI (phase12-crud on testDb, mapTextInserter, seq-deps, quiz-links, kt-init, final-approval, p112 suites, mapTextHttp)
  - For phase12-teacher-crud: must run with `DATABASE_URL=$TEST_DATABASE_URL`
- `test:ai-integration` — real LLM calls (post-p112-authoring, phase2-generation, phase113-e2e); requires `RUN_AI_TESTS=1`
- `test:safety` — runs the S1–S7 safety test harness

## Migrated suites
All 10 UNSAFE/PARTIAL suites migrated:
1. `phase12-teacher-crud.test.ts` — uses testDb + assertTestDb + createFactory
2. `sequential-deps-phase18.test.ts` — runId tagging + pre/post-pollution gate
3. `kt-initialization-phase111.test.ts` — dynamic TEACHER_TABLE_ID query, runId tagging
4. `quiz-lesson-links-phase19.test.ts` — runId tagging, removed lesson-105 tests TA/TB/TC/TD/TE/TI (were already failing)
5. `quiz-creation-phase110.test.ts` — RUN_AI_TESTS gate on AI generation tests
6. `lesson-final-approval.test.ts` — dynamic lesson instead of lesson 105
7. `phase112-lesson-assignment.test.ts` — dynamic approved + draft lessons
8. `phase112-final.test.ts` — dynamic lesson, dynamic student
9. `phase112-cleanup-quiz-completion.test.ts` — dynamic lesson, dynamic students A+B
10. `post-phase112-authoring-simplification.test.ts` — RUN_AI_TESTS gate, dynamic lesson
11. `phase113-e2e-lifecycle.test.ts` — RUN_AI_TESTS gate, all dynamic fixtures
12. `phase2-generation.test.ts` — RUN_AI_TESTS gate, dynamic lesson

## Key rules
- **Why:** Automated tests caused UAT pollution (quizzes 230, 231 with "UAT" titles in real DB). Real DB baseline has 10 lessons, 2 quizzes — any deviation = pollution.
- **How to apply:** Any new test that writes DB must use either (a) createFactory on testDb [direct-DB tests] or (b) createHttpFactory on heliumdb [HTTP tests]. Never hardcode real lesson/user/class IDs as mutation targets.

## Zero-pollution verification (2026-08-14)
Real heliumdb after all migrations: `tr_lessons=0, tr_quizzes=0, tr_users=0, tr_topics=0, tr_nodes=0`. ✓
