---
name: Lesson exercise CRUD
description: Exercise CRUD routes, API client hooks, and frontend edit/add UI for lesson_exercises table
---

## Routes (artifacts/api-server/src/routes/lessons.ts)
Added after node delete route, before the LESSON MAPPING section:
- `GET /lessons/:lessonId/exercises` — list all exercises ordered by sequence
- `POST /lessons/:lessonId/exercises` — create; auto-computes exerciseId = `EX-${lessonId}-${nextSeq}`
- `POST /lessons/:lessonId/exercises/:exerciseId/update` — partial patch
- `POST /lessons/:lessonId/exercises/:exerciseId/delete`

All use `requireAuth` (not `requireTeacher`) — consistent with node routes.

## API client (lib/api-client-react/src/generated/api.ts)
Hooks added manually (not via orval generation) after the delete-node hook:
- `useGetLessonExercises`, `useCreateLessonExercise`, `useUpdateLessonExercise`, `useDeleteLessonExercise`
- `getGetLessonExercisesQueryKey(lessonId)`

New types added to `api.schemas.ts`: `LessonExercise`, `CreateLessonExerciseInput`, `UpdateLessonExerciseInput`.
Import block in `api.ts` must include these 3 types.

**Why:** The schemas file is the single source of truth for types shared between api.ts and the frontend. Any new types added to api.schemas.ts must also be added to the import block in api.ts.

## Node update route expansion
`POST /lessons/:lessonId/nodes/:nodeId/update` now accepts and returns these additional fields:
- `verbatimTheoryAnchor`, `commonMisconception`, `childFriendlyExplanation`, `basicExamples`

`GET /lessons/:lessonId/nodes` also returns these 4 extra fields now.
`UpdateLessonNodeInput` in api.schemas.ts was expanded to match.

## Frontend (teacher-dashboard.tsx — LessonNodesPanel)
Replaced the old read-only panel. Now:
- Fetches both nodes AND exercises when the panel is opened
- Shows textbook metadata (textbookTitle/Author/chapterTitle) at the top from lesson props
- Each node is a card with inline edit form (toggled by ✏️)
- Exercises grouped under their node (by relatedNodeId)
- Per-node "add exercise" form
- Global "add node" form at bottom
- Props removed: `practicalTasks` (no longer used); added: `textbookAuthor`, `textbookTitle`, `chapterTitle`

## Verification (2026-08-05)
- Edit node 99 theoryContent → DB confirmed changed
- Add node manually → id=103 persisted
- Add exercise manually → EX-67-4 (id=59) persisted, relatedNodeId=99
