---
name: Phase 1.1+1.2 Teacher Review CRUD
description: Topic CRUD + reorder (drag-and-drop), MicroNode reorder (▲▼ buttons), topicId + learningObjective on node create/edit.
---

## What was implemented
- **Backend** (`artifacts/api-server/src/routes/lessons.ts`):
  - `POST /lessons/:lessonId/topics` — create topic (auto-sequence)
  - `POST /lessons/:lessonId/topics/:topicId/delete` — delete topic (nodes become standalone via FK SET NULL)
  - `POST /lessons/:lessonId/topics/reorder` — bulk reorder all topics, normalized 1,2,3,… transactionally
  - `POST /lessons/:lessonId/nodes/reorder` — bulk reorder all nodes, normalized 1,2,3,… transactionally, then calls `refreshSequentialDependencies`
  - Updated node create to accept `topicId` and `learningObjective`
  - Updated node update to accept `topicId`

- **API client** (`lib/api-client-react/src/generated/`):
  - New types in `api.schemas.ts`: `LessonTopic`, `CreateLessonTopicInput`, `UpdateLessonTopicInput`, `ReorderTopicsInput`, `ReorderNodesInput`
  - New hooks in `api.ts`: `useCreateLessonTopic`, `useDeleteLessonTopic`, `useReorderLessonTopics`, `useReorderLessonNodes`
  - Must rebuild: `cd lib/api-client-react && pnpm exec tsc --build`

- **Frontend** (`artifacts/myaiteacher/src/pages/teacher-dashboard.tsx`):
  - `SortableTopicItem` component (above `LessonNodesPanel`) — wraps topic group for @dnd-kit drag handle
  - `renderNodeCard` function defined before `return` in `LessonNodesPanel` — avoids JSX duplication
  - Topic header now has drag handle (⠿), edit (✏️), delete (🗑️) buttons; delete triggers AlertDialog
  - Node cards now have ▲▼ buttons (call `moveNode`) for reordering within lesson
  - Add Node form now includes learningObjective textarea and topicId select dropdown

## Key architecture facts
- `lesson_nodes.sequence` is lesson-wide (not topic-scoped); node reorder sends ALL node IDs
- `lesson_topics.sequence` is separate per-lesson
- `refreshSequentialDependencies` called after node reorder — rebuilds SEQUENTIAL edges, preserves REQUIRED/other
- Topic delete: `lesson_nodes.topic_id` FK is ON DELETE SET NULL — nodes become standalone safely
- `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` installed in myaiteacher

**Why:** DnD requires SortableContext to receive the full ordered ID list; drag handle must be on a separate `<span>` with `{...listeners}` so topic header buttons remain clickable.
