---
name: Exercise assignment visibility (P5.2)
description: Auto-mapped exercises must have assignment='CLASS'/'HOMEWORK' written at insertion time; chat.ts Phase 3 must include relatedNodeId IS NULL exercises.
---

## Rule

Two insertion sites in `lessons.ts` (MicroNode exercises and additionalExercises) MUST write the `assignment` field:
- `mn.exercises` → `assignment: "CLASS"`
- `additionalExercises`, blockType HOMEWORK → `assignment: "HOMEWORK"`; else → `assignment: "CLASS"`

`chat.ts` Phase 3 query MUST include `lessonId` scope guard + `OR relatedNodeId IS NULL` to reach unassigned exercises.

**Why:** `chat.ts` filters CLASS exercises with `assignment = 'CLASS'`. If `assignment` is NULL (which is the default when the field is omitted), SQL `NULL = 'CLASS'` evaluates to NULL/false → 0 exercises visible to AI Teacher. Phase 3 also needs `IS NULL` branch because unassigned textbook exercises (rescued by Step C) have `relatedNodeId = null`.

**How to apply:** Any future insertion into `lessonExercisesTable` from the mapping pipeline must set `assignment`. The CRUD API already defaults correctly (`assignment ?? "CLASS"`). Do not rely on the DB default.

## Phase 2 vs Phase 3 invariant

- Phase 2: `WHERE relatedNodeId = currentNodeId AND assignment = 'CLASS'` — node-specific only. NULL relatedNodeId exercises must NOT appear here.
- Phase 3: `WHERE lessonId = X AND assignment = 'CLASS' AND (relatedNodeId IN nodes OR relatedNodeId IS NULL)` — full DEEP_DIVE set.
- Homework: `WHERE lessonId = X AND assignment = 'HOMEWORK'` — unchanged.

## Pass1 block count non-determinism note

Lesson 104 produces 18, 20, or 26 blocks depending on AI OCR run — causing different coverage outcomes per remap. Job 28 (20 blocks) → completed. Jobs 29/30 (18 blocks) → coverage_failed due to duplicate index 13. This is pre-existing, not caused by P5.2.
