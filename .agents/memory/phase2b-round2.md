---
name: Phase 2B Round 2 — Cognitive Evidence Model
description: Help endpoint contract, active task tracking rules, evidence cap rule, and Unicode fix pattern for this project.
---

## Help Endpoint Contract (`POST /api/chat/help`)

- All task identity is derived from the **server-side session** — no client-supplied task IDs are trusted.
- `helpLevel` is 1-based (1=light, 2=moderate, 3=guided, 4=reveal).
- Level 1–3 never reveal the answer; level 4 requires `{ revealAnswer: true }` in the request body AND the server enforcing `nextHelpLevel === 4` check.
- When `revealAnswer` is false but `nextHelpLevel` would be 4, server returns `409 REVEAL_REQUIRES_CONFIRMATION` — client must show a confirmation bar and re-POST with `revealAnswer: true`.
- Help **never** advances teaching stage or creates `evidence_events`. It only inserts a `help_events` row and increments `activeHelpCount` + `activeAssistanceLevel` on `lesson_sessions`.

## Active Task Tracking Fields (on `lesson_sessions`)

Fields reset to null/0/"none" whenever `advanceNodeInSession()` fires:
- `activeLessonExerciseId` — FK to `lesson_exercises`, null if micro-check task
- `activeCognitiveLevelId` — FK to `lesson_node_cognitive_levels`
- `activeTaskProvenance` — `'micro_check'` | `'source_exercise'` | null
- `activeAttemptSequence` — increments each same-stage same-task answer
- `activeHelpCount` — increments each help call; capped at 4 on `nextHelpLevel`
- `activeAssistanceLevel` — `'none'` | `'light'` | `'moderate'` | `'guided'` | `'revealed'`

## Micro-check activation invariant

Only a response explicitly marked as a micro-check may create a new active micro-check state. Feedback-only evaluated answers must leave the session ready for a later teaching/check response, rather than manufacturing an active task from the previous stage.

**Why:** A generic THEORY-to-MICRO_CHECK transition after feedback can persist `activeTaskProvenance='micro_check'` without a learner-visible question, leaving the learner unable to answer the claimed active task.

**How to apply:** Use the anticipatory Phase 2 path (`is_micro_check=true`) as the sole activation authority. Validate every marked micro-check has a visible answerable task; objective checks need visible choices, while constructed responses need a clear question or task marker. Do not let evaluated FEEDBACK create a task.

## Evidence Cap Rule

MICRO_CHECK-sourced evidence (`activeTaskProvenance === 'micro_check'`) is capped at `assistanceLevel = 'moderate'` in the evidence write block — even if the student requested higher help.

**Why:** Micro-check tasks are formative; inflating assistance level distorts mastery signals.

## `help_events` Table

Columns: `id`, `user_id` (NOT NULL FK), `lesson_session_id` (nullable FK), `lesson_node_id` (NOT NULL FK), `lesson_exercise_id` (nullable FK), `quiz_question_id` (nullable FK), `cognitive_level_id` (nullable FK), `help_level` (NOT NULL), `is_answer_reveal` (default false), `hint_content` (nullable text), `created_at` (default now()).

## New Columns on `evidence_events`

`lesson_exercise_id` (nullable FK → lesson_exercises, ON DELETE SET NULL), `interaction_type` (nullable text), `attempt_sequence` (nullable int), `help_count` (NOT NULL default 0), `assistance_level` (nullable text).

## New Columns on `quiz_questions`

`source_exercise_id` (nullable FK → lesson_exercises), `cognitive_level_id` (nullable FK → lesson_node_cognitive_levels), `interaction_type` (nullable text, default 'multiple_choice').

## FK Check Query Pattern

`information_schema.referential_constraints` JOIN with `key_column_usage` is unreliable in heliumdb_test. Use `pg_constraint` catalog instead:

```sql
SELECT c.conname FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
WHERE t.relname = '<table>' AND a.attname = '<column>' AND c.contype = 'f'
LIMIT 1
```

## Unicode in Frontend (chat.tsx)

- Never write `\uXXXX` escape sequences into TSX files via the Edit/WriteFile tools — they may end up as literal 3-digit `\uXXX` sequences that break Babel.
- **Rule:** Armenian UI strings in the frontend must be written as actual UTF-8 characters (e.g. "Հուշ") directly in JSX, OR fix using a Node.js script with `String.fromCharCode(0x0540, ...)`.
- For error strings that come from the API (e.g. `data.message`), prefer `data.message ?? "fallback"` over duplicating Armenian strings in the frontend.

## Help Button Visibility — Fixed Runtime Bug

**Root cause A — Anticipatory advances didn't write active task fields.**
The `THEORY → MICRO_CHECK` and `MICRO_CHECK → EXERCISE` anticipatory advances (lines ~968, ~984 in chat.ts) only set `nodeTeachingStage`. They did NOT set `activeTaskProvenance`/`activeHelpCount`/etc. Fix: both advances now write all active task identity fields. Same fix applied to P11.1 callAI fallback path.

**Root cause B — `res.json()` didn't include `hasActiveTask`.**
Frontend had no way to know if the current session has an active task. Fix: `hasActiveTask` variable (bool) declared at handler scope, initialized from session state inside `if (aiResult && ...)` block, updated by every anticipatory advance and `newTeachingStage` branch. Included in `res.json()`.

**Root cause C — Frontend `showHelpButton` condition was wrong.**
Old: `!!lessonId && helpLevel < 4` (shows always during a lesson).
New: `!!lessonId && hasActiveTask && helpLevel < 4`.

**Backward compat:** Sessions created before Phase 2B have `activeTaskProvenance = null` even if `nodeTeachingStage = 'MICRO_CHECK'`. Both the initialization in `chat.ts` and the GET `/chat/session-state` endpoint treat MICRO_CHECK/EXERCISE stage as `hasActiveTask = true` even when provenance is null.

## GET `/chat/session-state` Endpoint

Returns `{ hasActiveTask, activeHelpCount, activeAssistanceLevel, nodeTeachingStage, status, currentPhase }`.
Used by frontend `useEffect` on mount to hydrate `hasActiveTask` + `helpLevel` without waiting for the next chat message. Auth required (`requireAuth`).

## Test File

`artifacts/api-server/src/lib/__tests__/phase2b-round2.test.ts` — T01–T42, 42/42 passing.
Run: `pnpm --filter @workspace/api-server run test:phase2b-round2`
