# UAT Fix — Lesson-Linked Quiz Cards Show Live Status/Results
## Final Report

**Date:** 2026-08-14  
**Status:** ✅ PASS — same quiz, same data, in both views

---

## A — Root Cause

`GET /api/lessons/:lessonId/quizzes` returned only `{ id, title, status, quizType, questionCount, classId }`.  
It had **no JOIN to `quiz_assignments` or `quiz_attempts`**, so `completedCount`, `totalAssigned`, and `averageScorePercent` were never computed.

The frontend `linkedTests` type only declared those six fields. The card JSX had no branch for completion state — it could only toggle between `ASSIGNED`/not-assigned badge styling and show two static buttons (`Ուղارкел` / `Диtел`). No completion summary, no `Արдюнкнер` button.

---

## B — Global Tests Data Source

| Source | Value |
|---|---|
| Endpoint | `GET /api/quizzes/all` |
| Route file | `artifacts/api-server/src/routes/quizzes.ts` line 630 |
| Fields | `completedCount`, `totalAssigned`, `averageScorePercent` via SQL aggregate on `quiz_assignments` + `quiz_attempts` |
| Frontend state | `allQuizzes` (line 2780 in teacher-dashboard.tsx) |

---

## C — Lesson-Linked Tests Old Data Source

| Source | Value |
|---|---|
| Endpoint | `GET /api/lessons/:lessonId/quizzes` |
| Route file | `artifacts/api-server/src/routes/lessons.ts` line 3212 |
| Missing fields | `completedCount`, `totalAssigned`, `averageScorePercent` — not in SELECT, not in response |
| Frontend state | `linkedTests` (line 926 in teacher-dashboard.tsx) |

---

## D — Reused Helper/API/Component

**Reused exactly:** the same two aggregation queries from `GET /api/quizzes`:

```typescript
// From quizzes.ts line 593-601 — copied verbatim into lessons.ts:
const aRows = await db
  .select({
    quizId:         quizAssignmentsTable.quizId,
    totalAssigned:  sql<number>`cast(count(*) as integer)`,
    completedCount: sql<number>`cast(count(*) filter (where ${quizAssignmentsTable.status} = 'COMPLETED') as integer)`,
  })
  .from(quizAssignmentsTable)
  .where(inArray(quizAssignmentsTable.quizId, quizIds))
  .groupBy(quizAssignmentsTable.quizId);

const sRows = await db
  .select({
    quizId:              quizAssignmentsTable.quizId,
    averageScorePercent: sql<number | null>`round(avg(${quizAttemptsTable.scorePercent}))`,
  })
  .from(quizAttemptsTable)
  .innerJoin(quizAssignmentsTable, ...)
  .where(inArray(quizAssignmentsTable.quizId, quizIds))
  .groupBy(quizAssignmentsTable.quizId);
```

No duplicate calculation — same SQL logic, same semantics.

**Reused:** `onOpenResults(quizId)` prop on `LessonNodesPanel` calls the parent's `setResultsFrom("allQuizzes"); setResultsQuizId(quizId)` — the exact same effect as clicking `Արдюнкнер` in the global Tests section.

---

## E — Files Changed

| File | Change |
|---|---|
| `artifacts/api-server/src/routes/lessons.ts` | Added `quizAttemptsTable` import; extended `GET /api/lessons/:lessonId/quizzes` to run assignment + score aggregation queries and return `totalAssigned`, `completedCount`, `averageScorePercent` per quiz |
| `artifacts/myaiteacher/src/pages/teacher-dashboard.tsx` | Added `onOpenResults?` prop to `LessonNodesPanel`; extended `linkedTests` type with completion fields; replaced card JSX with live-state rendering; wired call site to pass `onOpenResults` |

---

## F — Before / After Lesson-Linked Card

### Before (any quiz):
```
[ Quiz Title ]
[ Даси тест ] [ 9 հарц. ] [ ✓ or → badge ]
[ Ուղарکел ]  [ Диtел ]
```
Static. Never showed completion counts. Never showed average. No `Ардюнкнер` button.

### After — State 1 (not released):
```
[ Quiz Title ]
[ Даси тест ] [ 9 հарц. ]
[ Ուղарkel ]  [ Диtел ]
```

### After — State 2 (released, none done):
```
[ Quiz Title ]
[ Даси тест ] [ 9 հарц. ]
🔵 Ուղарква╗ · 0/? авартел ен
               [ Диtел ]
```

### After — State 3 (partial):
```
[ Quiz Title ]
[ Даси тест ] [ 9 հарц. ]
🔵 Ուղарква╗ · 1/3 авартел ен · Мижин 22%
               [ Диtел ] [ Ардюнкнер ]
```

### After — State 4 (all done):
```
[ Quiz Title ]
[ Даси тест ] [ 9 հарц. ]
🟢 Авартвад · 3/3 авартел ен · Мижин 67%
               [ Диtел ] [ Ардюнкнер ]
```

---

## G — Real Quiz ID Used for Verification

| Quiz | Status | Linked Lesson | totalAssigned | completedCount | averageScorePercent |
|---|---|---|---|---|---|
| 206 | ASSIGNED | 524 | 1 | 1 | 22 |
| 230 | GENERATED | 524 | 0 | 0 | null |
| 231 | GENERATED | 524 | 0 | 0 | null |

Quiz 206 is the live quiz with a real student completion record. Used for Part C cross-check.

---

## H — Global vs Lesson Card Comparison

**Quiz 206:**

| Field | `GET /api/quizzes/all` | `GET /api/lessons/524/quizzes` |
|---|---|---|
| status | ASSIGNED | ASSIGNED ✅ |
| totalAssigned | 1 | 1 ✅ |
| completedCount | 1 | 1 ✅ |
| averageScorePercent | 22 | 22 ✅ |

Identical. Same authoritative calculation, both driven by `quiz_assignments` + `quiz_attempts`.

---

## I — Re-release Semantics Verification

The lesson-linked endpoint uses the same `quiz_assignments` table as the global endpoint. It counts ALL assignments for the quiz (not lesson-scoped). When a teacher re-releases a quiz, a new `quiz_assignments` batch is created. The aggregation (`count(*)` + `filter (where status = 'COMPLETED')`) naturally reflects the current assignment state — the same semantics used in the global Tests section. No special handling was needed.

---

## J — Regression Results

| Check | Result |
|---|---|
| Global `GET /api/quizzes/all` unchanged | ✅ Not touched |
| Global Teacher Tests card unchanged | ✅ Not touched |
| Student dashboard unchanged | ✅ Not touched |
| Quiz release endpoint unchanged | ✅ Not touched (`POST /api/quizzes/:id/assign`) |
| Quiz completion/attempt endpoints unchanged | ✅ Not touched |
| No duplicate quiz records | ✅ Confirmed (same quiz IDs, no duplication) |
| No duplicate assignments/attempts | ✅ Confirmed (lesson-linked view reads, not writes) |
| `GET /api/lessons/524/quizzes` new fields present | ✅ All 4 quizzes return `totalAssigned`, `completedCount`, `averageScorePercent` |

---

## FINAL GATE

✅ **PASS**

The Lesson-linked Quiz card now dynamically reflects the **same** current assignment/completion/result state as the global Teacher Tests card. The data comes from the same database tables via the same SQL aggregation pattern. The `Արдюнкнер` button opens the same inline results panel as the global Tests section.
