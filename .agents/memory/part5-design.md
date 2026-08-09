---
name: PART 5 design decisions
description: PART 4 audit results and PART 5 architecture design — open questions and confirmed bugs
---

## Confirmed bugs (from PART 4 + PART 5)

**Bug 1 — Frontend type mismatch**: `quiz-result.tsx` line 7 had Armenian string literal "Լիarжеq covupel" instead of "LEARN_FULL" in PersonalizedAction union. **FIXED**.

**Bug 2 — status column diverges from getMasteryLevelFromScores**: `scoring.ts` THREE_Q_TIERS: 0/3→"not_started" should be "in_progress"; 1/3→"not_started" should be "weak". General path ignores confidenceScore in status formula. Only consumer: `student-profile.ts` (aggregated counts wrong).

## Architectural gaps

- `lesson_node_dependencies` table: 5 rows, `from_node_id` = PREREQUISITE (confirmed from reason text). Nodes 1161-1164 have NO rows. Recommendation engine does NOT query it.
- `computeR()` always null. `review_schedule` IS populated (scheduleReview called on every scoring). `getDueReviewTopics()` called from lessons.ts. Missing: session type distinction (review vs new-learning).
- Two getMasteryLevel functions: `mastery.ts` (4 states) for quiz result; `knowledge-tree.ts` (5 states, adds needs_review, reads dueAt). Quiz result ignores overdue status.
- `status` column written by scoring but only read by `student-profile.ts`. Never read by quiz personalization pipeline.

## Open decisions for implementation (Q1/Q2/Q3)

- **Q1 (D3 prerequisites)**: prerequisiteBlocked flag in API? Direct vs transitive hop?
- **Q2 (E1 provisional)**: Option A (review_count≥2), Option B (time gap N days), or Option C (always provisional)?
- **Q3 (E3 unify)**: What priority for needs_review in quiz recommendations?

## Proposed tasks

- Task #46: Fix status column alignment (scoring.ts THREE_Q_TIERS + general path)
- Task #47: Prerequisite-aware recommendations (lesson_node_dependencies in buildStudentResultAnalysis)
- Task #48: is_provisional in API + UI (pending Q2 decision)

## Localization

- quiz-result.tsx lines 239 and 241: Cyrillic chars fixed to pure Armenian. BAD=[] confirmed.
- Line 7: "Լiarжеq covupel" → "LEARN_FULL" fixed.
