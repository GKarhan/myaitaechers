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

## Pass2 prompt — exercise→MicroNode assignment strengthening

`PASS2_STEP2_SYSTEM` (lesson-mapping.ts) has been strengthened with 4 explicit rules:
1. Always inspect existing MicroNode LOs FIRST before creating new ones
2. Exercise FORMAT (word problem, multi-step, interpretation) does NOT determine MN ownership
3. Multi-skill exercises: find primary LO, assign to best-match existing MN
4. NEVER create exercise-only MicroNodes (explicit prohibited titles list)
additionalExercises[] is now framed as LAST RESORT with 3 explicit qualifying conditions.
Includes a concrete Lesson 104 worked example embedded in the prompt.

**Why:** Before this fix, AI created exercise-only MicroNodes (no sourceBlockIndices) → safety-net stripped them → all exercises fell to additionalExercises (relatedNodeId=NULL). After fix: 8/9 exercises get relatedNodeId assigned in typical runs.

## Activity normalization note (normalizeActivityPlacements)

Replaces Steps A+B+C. Runs BEFORE validateSourceCoverage. Enforces ∀ activity block N → exactly ONE canonical placement.

Canonical priority: exercises[] > additionalExercises[]. Phases:
1. Evict EXERCISE/ACTIVITY/HOMEWORK from sourceBlockIndices (ACTIVITY_IN_THEORY fix).
1b. Strip MNs whose sourceBlockIndices became empty after eviction; rescue exercises to additionalExercises.
2. Dedup exercises[] (first occurrence wins; invalid → drop).
3. Dedup additionalExercises[] (exercises[] wins; invalid → drop; first per blockIndex wins).
4. Rescue from unmappedBlockIndices (Step B).
5. Rescue evicted-from-source blocks not yet placed.
6. Rescue completely missing activity blocks (Step C).

**Why Phase 1b is required:** If a MN had ONLY activity blocks in sourceBlockIndices, Phase 1 eviction leaves it empty → coverage validator's emptyMicroNodeTitles → coverage_failed. Phase 1b strips those empty MNs BEFORE coverage runs.

## Pass1 block count non-determinism note

Lesson 104 produces 18-28 blocks across different AI OCR runs. This is now handled correctly — all runs since the fix produce coverage_valid=true regardless of block count.
