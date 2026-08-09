---
name: PART 5 mastery overhaul
description: Unified mastery logic, prerequisite blocking, provisional mastery, needs_review state, D2 status alignment — all implemented and regression-audited.
---

## What changed (PART 5 implementation)

### mastery.ts (rewritten, single source of truth)
- `MasteryLevel` now has 5 states: `mastered | needs_review | weak | in_progress | not_started`
- `getMasteryLevelFromScores(m, c, dueAt?)` — 3rd param (dueAt) triggers `needs_review` when mastered+overdue
- `getPersonalizedNextAction` handles `needs_review` → state="needs_review", action="REVIEW"
- `recommendationPriority`: 1=in_progress, 2=needs_review, 3=weak≤50, 4=not_started/weak>50, 5=mastered

### knowledge-tree.ts
- Removed local `getMasteryLevel` function, imported `getMasteryLevelFromScores` from `mastery.ts`
- KT still folds `needs_review → mastered` visually (4 blocks only)

### scoring.ts (D2 + E1)
- THREE_Q_TIERS: 0/3→`in_progress`, 1/3→`weak` (was `not_started`)
- General path status: confidence gate first (`c<50 → in_progress`; else mastery gate)
- `isProvisional`: computed from distinct quizIds in evidence_events metadata (`< 2 sessions → true`)

### quizzes.ts (D3, E1, E2, E3 in buildStudentResultAnalysis)
- `knRows` query: LEFT JOIN `reviewScheduleTable` for `dueAt` + includes `id`, `isProvisional`
- `getMasteryLevelFromScores` called with `dueAt` for needs_review detection
- `isProvisional` in nodeBreakdown
- Transitive prereq blocking (BFS over all lesson_node_dependencies rows)
- External prereq KN fetch (batch query for prereqs not in current quiz)
- `prerequisiteBlocked`, `blockedBy[]` in recommendations
- `confidenceScore` in recommendations
- Sort: unblocked before blocked; within each group by priority then nodeId

### quiz-result.tsx
- `MasteryLevel` type: added `"needs_review"`
- `PersonalizedNextAction.state`: added `"needs_review"`
- `NodeBreakdown`: added `isProvisional: boolean`
- `Recommendation`: added `isProvisional`, `prerequisiteBlocked`, `blockedBy[]`, `confidenceScore`
- `MASTERY_LABEL.needs_review`: "Գиtи (Կrrknел)" (mastered + review)
- `MASTERY_BADGE.needs_review`: violet
- Provisional ⚡ badge in node breakdown and recommendations
- Prereq-blocked 🔒 note in recommendations (replaces action label when blocked)

## DB backfills applied
- `knowledge_nodes.status` backfilled using confidence-gate formula (4 rows fixed: not_started→weak/in_progress)
- `knowledge_nodes.is_provisional` backfilled from distinct quizIds in evidence_events (3 rows: false, 1 node: true for 1 session)

## Regression audit results (all pass)
- 17/17 pure logic tests
- API: nodeBreakdown isProvisional correct, confidenceScore present
- API: KT and QR show same state for all 4 nodes (lessonNodes 1161-1164)
- API: prereq blocking — node 77 blocked by 76 (direct), node 78 blocked by [77,76] (transitive A→B→C chain)
- API: external prereq lookup — node 76 not in quiz 26, fetched from knowledgeNodes correctly

**Why:**
- PART 5 spec required unified mastery logic, needs_review state, provisional evidence threshold, transitive prereq blocking, and status alignment.
