---
name: Phase 1.13 E2E lifecycle test findings
description: Route response formats, pre-test cleanup patterns, and bug fixes discovered during Phase 1.13 E2E acceptance test
---

# Phase 1.13 E2E Lifecycle Findings

## Route Response Formats (not derivable from route names)

- `GET /lessons/:id` → returns `authoringStatus` (= DB `lessons.status`), NOT a `status` field
- `GET /lessons/:id/nodes` → returns a **plain JSON array**, NOT `{ nodes: [...] }`
- `GET /lessons/:id/exercises` → returns a **plain JSON array**, NOT `{ exercises: [...] }`
- `POST /lessons/:id/nodes/reorder` → body key is `orderedNodeIds` (not `nodeIds` or `orderedIds`)

**Why:** These were discovered by reading route implementation vs. test assumptions. Trust the route code, not the resource name.

## Pre-Test Cleanup Pattern (phase113 E2E)

E2E tests on lesson 105 require pre-test cleanup in `main()` before running:
1. `UPDATE lessons SET status='active' WHERE id=105` (regression suites call final-approve → sets to "approved")
2. Cancel stale `pending`/`running` Phase 2 jobs: `UPDATE mapping_jobs SET status='failed' WHERE lesson_id=105 AND job_type='generate_teaching_content' AND status NOT IN ('completed','failed')`
3. Delete stale `ASSIGNED` quiz assignments for the student under test (L8 re-release from a crashed prior run leaves ASSIGNED rows)

**Why:** Without cleanup, G5 (generate-status) sees "running" from stale jobs, L1 pre-condition fails on ASSIGNED row.

## Bugs Fixed

- `alreadyAssigned.size` in `artifacts/api-server/src/routes/quizzes.ts` line ~1047 was a ReferenceError (variable is `alreadyActiveAssigned`). Caused 500 on second quiz re-release. Fixed → `alreadyActiveAssigned.size`.

**How to apply:** If you see 500 on `POST /quizzes/:id/assign`, check the `alreadyAssigned` vs `alreadyActiveAssigned` variable name.

## Final-Approve Status Transition

`POST /lessons/:id/final-approve` sets `lessons.status` → `"approved"` even if the lesson was `"active"`. Student routes require `"active"`. Pattern for E2E tests: restore to `"active"` before student-facing sections (K0 step in phase113 test).

## Test Count

Phase 1.13 test suite: 75 tests covering sections A–Q (lifecycle: Mapping→Authoring→Enrichment→Approval→Assignment→Student→Quizzes→Evidence→KT→Session).
