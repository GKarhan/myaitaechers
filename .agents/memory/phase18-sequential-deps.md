---
name: Phase 1.8 Sequential Dependencies Sync
description: Structural SEQUENTIAL dep sync with MicroNode order — bugs fixed, tests added
---

## What was done

Fixed two missing `refreshSequentialDependencies` calls (node create + node delete routes).

## Bug fixes

- **Node create** (`lessons.ts` ~line 635): wrapped max-seq query + insert + refresh in one `db.transaction`. Before: inserting a node left the SEQUENTIAL chain stale (new tail edge missing).
- **Node delete** (`lessons.ts` ~line 1059): wrapped delete + refresh in one `db.transaction`. Before: FK cascade removed edges touching the deleted node but did not rebuild the chain (gap between surviving neighbours).

**Why:** Both operations structurally change the lesson-wide sequence, so the SEQUENTIAL graph must be rebuilt atomically. Node reorder already had this; create and delete did not.

## Architecture facts

- `refreshSequentialDependencies` lives in `lib/sequential-deps.ts:104-158`
- Deletes ONLY `dependencyType = 'SEQUENTIAL'` — preserves REQUIRED, CONCEPTUAL
- Lesson-wide scope (no topic filter) — sorts by `lesson_nodes.sequence ASC`
- Accepts a Drizzle `tx` parameter; callers wrap in `db.transaction`
- Node reorder: already atomic (transaction at `lessons.ts:1021`)
- Topic reorder: updates only `lesson_topics.sequence` — does NOT touch node sequence → SEQUENTIAL graph unchanged (correct)
- Dependency types: SEQUENTIAL (structural), REQUIRED (semantic), CONCEPTUAL (semantic)

## AI Teacher progression

- Uses `lesson_nodes.sequence` directly for next-node selection (`chat.ts:advanceNodeInSession`)
- Queries `lesson_node_dependencies` only for REQUIRED type (diagnostic only — does not block advancement)
- SEQUENTIAL dep rows are NOT read by the AI Teacher

## Tests

File: `artifacts/api-server/src/lib/__tests__/sequential-deps-phase18.test.ts`
Command: `pnpm --filter @workspace/api-server run test:phase18-seq`
19/19 pass (9 pure-function, 6 DB integration with isolated lessons, 4 real Lesson 105 acceptance)

## Lesson 105 baseline (post-Phase 1.8)

- 10 nodes, sequences 1-10, lesson-wide SEQUENTIAL chain (9 edges)
- 0 REQUIRED deps
- authoringStatus = approved
