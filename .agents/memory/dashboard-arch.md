---
name: Dashboard architecture
description: Key decisions for the student dashboard structure and data flow
---

## Navigation
9 sidebar items (type Section): ai-teacher | home | tasks | subjects | homework | schedule | progress | library | profile

## Data
- `allLessons`: parallel-fetched per schedule subject via `/api/student/course-lessons?subject=...`
- `assignedLessons`: `allLessons.filter(l => l.status !== "completed")` — shown in Tasks and AI Teacher
- `hwItems`: from `useGetStudentHomeworkSummary()` — the backend now returns `subject` and `teacherName` via JOIN chain: homeworkTable → lessonsTable → coursesTable → classesTable → teachersTable → usersTable
- `className`: derived from `schedule[0]?.className` (scheduleTable already joins classesTable)

## JWT payload
User object from JWT contains ONLY: `{ id, username, role, fullName }` — no `createdAt`, no `email`.

## Armenian labels
All Armenian strings extracted from spec files using Python — see the confirmed proper Unicode extraction pattern.

**Why:** bcryptjs used (not bcrypt); lessons API uses status values: draft/active/assigned/completed/archived.
