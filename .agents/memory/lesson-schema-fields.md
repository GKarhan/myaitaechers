---
name: Lesson schema new fields (added 2026-07)
description: Fields added to lessonsTable for the teacher course page feature
---

Added to `lib/db/src/schema/lessons.ts`:
- `textbookAuthor` (text, nullable) — author of the textbook
- `textbookTitle` (text, nullable) — title of the textbook  
- `chapterTitle` (text, nullable) — chapter/topic heading
- `paragraphNumber` (text, nullable) — paragraph/section reference (e.g. "1.1")
- `status` (text, default 'draft') — lesson status: draft → assigned → active → completed
- `assignedAt` (timestamp, nullable)
- `completedAt` (timestamp, nullable)

Status flow: draft → assigned → active (only one active per course; setting active demotes previous active→assigned) → completed. Students see only assigned/active/completed lessons.

Both `CreateTeacherLessonInput` and `UpdateLessonInput` schemas in openapi.yaml include all four new textbook fields.
