---
name: Knowledge Tree 4-category + Coverage model
description: KT display model — KT-1.4A coverage aggregation, 4-state names, auth patterns, teacher-view raw useQuery pattern.
---

## KT-1.4A Coverage Model (active, supersedes KT-1.4)

**Backend** (`lib/mastery.ts` → `aggregateKnowledgeCoverage`):
- Input: `{ masteryLevel: MasteryLevel4 }[]` — score not needed
- Returns `CoverageResult`: `totalUnits, studiedCount, notStudiedCount, coveragePercent, masteredCount, partialCount, doesNotKnowCount, notStartedCount`
- "Studied" = masteryLevel ∈ {mastered, weak, in_progress} (KN row with actual scores)
- `coveragePercent = round(studiedCount / totalUnits * 100)`, null when totalUnits === 0
- Internal "weak" maps to `partialCount`; internal "in_progress" maps to `doesNotKnowCount`

**`knowledge-tree.ts` routes**:
- Both `/subjects` and `/:subjectId` use `aggregateKnowledgeCoverage` everywhere
- Response field: `ungroupedCoverage` (not `ungroupedRollup`)
- Old `masteryPercent`/`weakCount`/`inProgressCount`/`computeRollup` all removed

**Frontend** (`knowledge-tree.tsx`, `kt-subject-select.tsx`):
- Interface `KTCoverage` replaces old `KTRollup`
- Helpers: `formatCoverage` / `coverageColour` (replace `formatMastery`/`masteryColour`)
- UI label: "Ususumnasirvac" (coverage), not "Юracum" (mastery)
- Filter invariance preserved: filterLesson spreads `...lesson` so API values never recalculate

## Teacher view
Requires `?studentId=X` + teacher owns a class containing that student.
Generated hook `useGetKnowledgeTree` doesn't support extra params → use raw `useQuery`.

## Auth for testing
- Login endpoint: `POST /api/auth/login` with `{"username":"student1","password":"student123"}`
- Bearer token in `Authorization` header
- Token length ~167 chars (JWT)

## Live data (student1, Physics subject 18)
- 3 nodes, all studied (have KN rows with scores)
- `coveragePercent=100%` (all 3 studied), `partialCount=1`, `doesNotKnowCount=2`
- Math/Hayereni: `totalUnits=0`, `coveragePercent=null`
