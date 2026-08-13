---
name: Phase 1.12 lesson assignment gate
description: Approved-only lesson assignment, quiz release control, lesson-card test action parity.
---

## Rules

- `PUT /teacher/lessons/:id/status → active` is gated: lesson must be `status="approved"` first; returns `400 { error: "LESSON_NOT_APPROVED" }` otherwise. Route also checks `teacherId = req.userId` (returns 404 for other teachers' lessons).
- `POST /lessons/start` is gated for students/non-teachers: returns `403 { error: "LESSON_NOT_ACTIVE" }` when `lesson.status !== "active"`. Teachers and admins bypass the gate.
- `GET /api/lessons/:lessonId/quizzes` now includes `classId` in each row (used by lesson-card Ucharel button).
- Linked ≠ Released: quiz linked to lesson does NOT auto-release on lesson activation; teacher must explicitly call `POST /api/quizzes/:id/assign`.

## Frontend (LessonNodesPanel)

- Accepts `lessonClassId` and `lessonSubjectId` props (passed from call site via `(l as any).classId` and `selectedCourse.subjectId`).
- Assignment button gate: `isMapped && (l as any).status === "approved"` → active button; `isMapped` without approved → grey `cursor-help` span.
- Linked tests section now has two action buttons per quiz row: "Ucharel" (`POST /quizzes/:id/assign`) and "Ditcel" (navigate to `/quiz/:id/review?...`). effectiveClassId = `q.classId ?? lessonClassId`.
- `setLocation` from `useLocation()` is declared inside `LessonNodesPanel` itself (not inherited).

**Why:** The spec mandates that only approved, teacher-reviewed lessons reach students, and that quiz release is always a deliberate teacher action (never automatic).

**How to apply:** When adding new lesson-status transitions, always check against this gate. When the linked tests section needs new actions, use `q.classId ?? lessonClassId` for classId resolution.
