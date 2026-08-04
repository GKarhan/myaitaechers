---
name: Knowledge tree 4-category mastery
description: getMasteryLevel uses both masteryScore and confidenceScore; teacher-view needs auth + class membership check; generated hook can't take extra query params.
---

## Rule
`getMasteryLevel(masteryScore, confidenceScore)` → 4 categories:
- both null → "not_started"
- confidenceScore < 50 → "in_progress"
- masteryScore >= 80 → "mastered"
- otherwise → "weak"

Teacher-view: `GET /knowledge-tree/:subjectId?studentId=X` verifies:
1. `req.userRole === "teacher"`
2. Teacher's `teachersTable` record exists
3. Student is in one of the teacher's classes (classesTable.teacherId → classStudentsTable)

**Why:** The generated `useGetKnowledgeTree` hook doesn't support extra query params (it builds the URL as `/api/knowledge-tree/${subjectId}` with no query string). For teacher-view, use a raw `useQuery` with a direct `fetch` call that appends `?studentId=X`.

**How to apply:** `knowledge-tree.tsx` uses `isTeacherView = !!studentId && user?.role === "teacher"` to branch between the two query paths. Back navigation in teacher-view uses `window.history.back()` (no need to thread classId/subjectId through the URL since the teacher always arrives from a known page).
