---
name: KT-1.4 Roll-Up Contract
description: Authoritative mastery roll-up formula, API shape, and filter invariance rule for the Knowledge Tree hierarchy.
---

## Rule
`computeRollup()` in `artifacts/api-server/src/lib/mastery.ts` is the ONE shared roll-up function used by both `/knowledge-tree/subjects` and `/knowledge-tree/:subjectId`.

**Formula:** coverage-aware arithmetic mean  
`effectiveMastery_i = masteryScore_i` (null → 0 for not_started)  
`masteryPercent = Math.round(Σ(effectiveMastery) / totalUnits)`  
`masteryPercent = null` when `totalUnits === 0` (zero-unit edge case — NOT 0%)

**needs_review** folds to `mastered` before passing to `computeRollup`.

## Response shape added in KT-1.4
All levels (Subject, Lesson, Topic) now carry:
```
{ masteryPercent: number|null, totalUnits, masteredCount, weakCount, inProgressCount, notStartedCount }
```
Lessons also carry `ungroupedRollup` (same shape) for the "Առanc khmbi" display group.

## Filter invariance (critical)
UI filter (`Բolory / Գиtи / ...`) is a VIEW filter only.  
Frontend renders `visibleLessons` for the node list, but mastery % on each object comes from the full-curriculum API value (spread by `filterLesson()`).  
**Never recompute mastery % from filtered node lists.**

**Why:** A student filtering to "Գиtи" should still see the true subject mastery (e.g. 22%), not a misleading 100% from only the mastered subset.

## Consistency invariant
`/kt-subjects` Physics `masteryPercent` == `/knowledge-tree/18` `masteryPercent`  
Both use `computeRollup` from the same approved+active node set. Verified by T15/T16 each release.
