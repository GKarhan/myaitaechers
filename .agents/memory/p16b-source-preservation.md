---
name: P1.6B source preservation
description: Phase 1.6B textbook provenance immutability — exerciseTextEdited column, effectiveExerciseText helper, immutability gate.
---

## Rule
`exerciseTextVerbatim` and `sourcePage` are IMMUTABLE for `sourceType='textbook'` exercises.
Teacher adaptations write to `exerciseTextEdited` (nullable). Blank/null = reset → effective text falls back to verbatim.

**Effective text formula:** `exerciseTextEdited?.trim() || exerciseTextVerbatim`

## Implementation locations
- DB column: `lesson_exercises.exercise_text_edited` (nullable text)
- Helper: `effectiveExerciseText(verbatim, edited)` in `artifacts/api-server/src/lib/exercise-delivery.ts`
- Backend gate (returns 400 `IMMUTABLE_TEXTBOOK_PROVENANCE`): `artifacts/api-server/src/routes/lessons.ts` exercise update route
- Frontend: `effectiveText(ex)` helper + `resetExEdit(exId)` + `startEditEx` populates `exerciseTextEdited` not `exerciseTextVerbatim`
- Unit tests: `artifacts/api-server/src/lib/__tests__/source-preservation.test.ts` (15 assertions, all pass)

**Why:** Textbook exercises are scanned from a physical textbook. Mutating the scanned text would break audit trails and pedagogical integrity. The edited layer lets teachers adapt wording while keeping the original source provenance intact.

**How to apply:**
- Any new code that displays exercise text to learners or teachers: use the helper, never `exerciseTextVerbatim` directly
- The exercise update route is `POST /lessons/:lessonId/exercises/:exerciseId/update` (not PATCH/PUT)
- Teacher-created exercises get `sourceType='manual'` at creation time — verbatim IS mutable for manual exercises
- Gate 1.6B: PASS (all 7 live acceptance test groups + 15 unit tests passing)
