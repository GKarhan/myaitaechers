---
name: Phase 1.9 Quiz ↔ Lesson Relationship Model
description: One-quiz-record relationship architecture linking quizzes to lessons via join table
---

## What was built

Added authoritative Quiz ↔ Lesson relationship without duplicating quiz records.

## Schema additions

- `quizzes.quiz_type` — nullable text column: 'lesson' (1 lesson) | 'summary' (≥1 lessons) | null (legacy/unclassified)
- `quiz_lesson_links` table: `id`, `quiz_id` FK→quizzes.id CASCADE, `lesson_id` FK→lessons.id CASCADE, `created_at`, UNIQUE(quiz_id, lesson_id)

**Why:** Previous schema had `quizzes.node_ids` (JSONB) with no lesson FK. `lessonIds` sent at creation were discarded after node resolution — nothing persisted the lesson linkage.

## API endpoints added

- `POST /api/quizzes/:id/lessons/:lessonId` — link (idempotent, type='lesson' enforces ≤1 lesson constraint)
- `DELETE /api/quizzes/:id/lessons/:lessonId` — unlink (removes link only, quiz preserved)
- `GET /api/lessons/:lessonId/quizzes` — returns quizzes linked to lesson (in lessons.ts route file)
- `GET /api/quizzes/:id` — updated to include `quizType` and `lessonIds[]` in response

## Creation auto-populates links

`POST /api/quizzes`: after insert, if `lessonIds` OR `nodeIds` provided, resolves lesson IDs from nodes, validates they exist, derives `quizType` (1 lesson→'lesson', >1→'summary'), inserts quiz_lesson_links, sets `quizType` on quiz row. `onConflictDoNothing` ensures idempotency.

## Frontend

- `LessonNodesPanel` in `teacher-dashboard.tsx` has linked-tests section below the mapping content
- Fetches `GET /api/lessons/:lessonId/quizzes` with auth token on mount
- Shows: `📝 Թеստер (N)` collapsible; each quiz: title, type label, question count, status badge
- Empty state: `Թеստеr չкаn`

## Legacy quiz

- 1 existing quiz (id=27) is `quizType=null` (LEGACY UNCLASSIFIED) — has `node_ids` but no lesson link. Safe — not migrated.

## Integrity rules enforced

- Lesson Test (type='lesson'): link endpoint blocks 2nd lesson via HTTP 400
- FK cascade: quiz delete → link rows deleted; lesson delete → link row deleted (quiz preserved)
- UNIQUE(quiz_id, lesson_id): no duplicate rows via onConflictDoNothing

## Tests

File: `artifacts/api-server/src/lib/__tests__/quiz-lesson-links-phase19.test.ts`
Command: `pnpm --filter @workspace/api-server run test:phase19-quiz-links`
18/18 pass (12 core + 5 real L105 acceptance + 1 integrity check)
