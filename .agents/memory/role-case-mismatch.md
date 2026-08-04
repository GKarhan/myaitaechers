---
name: Role case mismatch
description: DB and profile API return roles as lowercase; uppercase comparisons always fail silently.
---

The `users` table stores role as a plain text column with values `"teacher"`, `"student"`, `"admin"` (all lowercase). The `/api/auth/profile` endpoint returns exactly those values.

**Rule:** All role comparisons in frontend code must use lowercase:
- ✅ `user?.role === "teacher"`
- ✅ `user?.role === "student"`
- ❌ `user?.role === "TEACHER"` — always false, silently wrong

**Why:** quiz-result.tsx had `user?.role === "TEACHER"` which made `isTeacherView` always false. The teacher's session fetched `/my-result` (the student endpoint) instead of `/results/:studentId`, got a 404, and showed the empty state. This bug survived two previous "fix" attempts because the race-condition hypothesis was wrong — the actual cause was the uppercase comparison.

**How to apply:** Before writing any role check, grep the rest of the codebase (`teacher-dashboard.tsx`, `dashboard.tsx`, `login.tsx`) to confirm the casing used there. They all use lowercase.
