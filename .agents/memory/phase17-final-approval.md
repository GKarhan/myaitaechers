---
name: Phase 1.7 Final Lesson Approval
description: Lesson-level final approval gate — validator, route, invalidation, UI, tests
---

## What was built

`POST /lessons/:lessonId/final-approve` — deterministic validation gate (no AI). Returns `{ approved, lessonId, errors[], warnings[], summary }`. 422 on errors, 200 on pass.

## Key files

- `artifacts/api-server/src/lib/lesson-final-approval.ts` — `validateLessonForFinalApproval(lessonId)` — 7 rules (A-G)
- `artifacts/api-server/src/lib/lesson-approval-invalidation.ts` — `invalidateLessonApproval(lessonId)` — silent no-op unless status='approved'
- `lib/api-client-react/src/generated/api.schemas.ts` — `FinalApproveResponse`, `LessonApprovalIssue`, `LessonApprovalSummary` types added
- Test: `artifacts/api-server/src/lib/__tests__/lesson-final-approval.test.ts` — 12 tests, run with `pnpm --filter @workspace/api-server run test:final-approval`

## Validation rules

- **A**: all approved nodes must have non-blank LO → `MISSING_LO`
- **B**: approved nodes must have theoryContent or verbatimTheoryAnchor → `EMPTY_NODE`
- **C**: topic + node sequences must be contiguous 1..N (no gaps/duplicates) → `INVALID_TOPIC_SEQUENCE_*` / `INVALID_NODE_SEQUENCE_*`
- **D/E**: all textbook exercises must have sourceBlockIndex; if `mappingMetadata.sourceExerciseCount` is set, current count must match → `LOST_SOURCE_IDENTITY` / `LOST_SOURCE_EXERCISES`
- **F**: all textbook exercises must be status='approved' → `DRAFT_SOURCE_EXERCISES`
- **G**: all approved nodes must have childFriendlyExplanation, commonMisconception, basicExamples≥1, nonExamples≥1 → `MISSING_PHASE2`
- **Warnings** (advisory): `COMPOUND_LO`, `MEGA_NODE` from granularity heuristics

## Invalidation pattern

Call `await invalidateLessonApproval(lessonId)` after every meaningful authoring write. Added to: node CRUD+reorder, topic CRUD+reorder, exercise CRUD+approve-all, lesson overview PUT (teacher.ts). Silent no-op if lesson is not 'approved'.

## Status lifecycle

`lessons.status` extended with authoring values: `approved` (all checks passed) and `needs_review` (was approved but since modified). Assignment values (draft/assigned/active/completed) coexist.

## GET /lessons/:lessonId now returns authoringStatus

`authoringStatus` = `lesson.status` — returned alongside the existing response fields.

## Frontend

`LessonNodesPanel` has `authoringStatus` prop + `handleFinalApprove()` handler + ✅/🔄 badges + error panel showing Armenian error codes inline.

## Lesson 105 baseline

`mappingMetadata.sourceExerciseCount = 15` set in DB. All 10 nodes approved + full Phase 2. All 15 source exercises approved. Lesson 105 is the canonical acceptance test fixture.

**Why:** Knowing the expected source count at mapping time lets the validator detect accidental exercise deletion, even after the fact.
