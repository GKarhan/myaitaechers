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

## KT-1.4A Final Closure (completed)

**Part 1 — Label fixes:**
- Replaced `Սovоrelу ardyounavetoutyoun` (learning effectiveness — WRONG) in kt-subject-select.tsx
- Replaced `Ususumnasirvac` placeholder in knowledge-tree.tsx subject header
- Correct Armenian label: `Ouusuomnasirvats` (= "Ousumnasirvats" = "Studied/Researched")
- Format in subject header: `· Ousumnasirvats' {studiedCount} / {totalUnits} · {coveragePercent}%`
- Format in subject card: `Ousumnasirvats': {studiedCount} · {coveragePercent}%`
- Reserve `Сovоrelу ardyounavetoutyoun` for the future K=P×L×R Efficiency Engine

**Part 2 — Acceptance tests:**
- File: `artifacts/api-server/src/lib/__tests__/kt-1-4a-coverage.test.ts`
- Script: `pnpm --filter @workspace/api-server run test:kt14a`
- 9/9 tests pass (Tests A, B, C, D, D2, E, F, G, G2) — pure unit tests, no DB

**Part 3 — Unsafe cast removal:**
- Both queries now `useQuery<KTData>` (student + teacher views)
- Removed both `as unknown as KTData` double casts (lines 346 and 379)
- Teacher view also typed: `return resp.json() as Promise<KTData>`
- `const treeData = rawData;` is valid after TypeScript narrowing from null guard
