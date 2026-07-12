---
name: API route vs OpenAPI generated hook URL
description: How to verify what URL a generated Orval hook actually calls before adding Express routes
---

Orval generates a `get<OperationId>Url()` helper alongside every API function. Always check this helper to confirm the actual URL before writing new Express routes.

**Example:** `useCreateTeacherLesson` → `getCreateTeacherLessonUrl()` returns `/api/teacher/lessons` (body has courseId), NOT `/api/teacher/courses/{id}/lessons` even though that path also exists in the OpenAPI spec.

**How to apply:** Run `grep -n "getCreate.*Url\|getUpdate.*Url" lib/api-client-react/src/generated/api.ts` then read the matching function bodies to confirm the URL before assuming path params.

**Why:** The OpenAPI spec can have multiple paths for the same resource. Orval assigns operationIds to specific paths; which path wins depends on where the operationId appears in the spec, not which path looks most REST-ful.
