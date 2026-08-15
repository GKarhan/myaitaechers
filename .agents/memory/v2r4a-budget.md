---
name: V2-R4A Learning Budget Foundation
description: R4A.1+R4A.2 — session budget snapshot, active-time accounting, decision engine budget integration, revisitReason typed enum
---

## Fields added in R4A.1+R4A.2

**lessons:** `required_session_minutes` (INT nullable) — teacher-configured default.

**lesson_sessions:** `required_session_minutes` (INT nullable) — snapshot at creation; **frozen** once session exists. `active_learning_seconds` (INT NOT NULL DEFAULT 0) — atomic SQL increment. `last_activity_at` (TIMESTAMPTZ nullable) — null = no qualifying event yet.

**knowledge_nodes:** `revisit_reason` (TEXT nullable) — typed at app level: `REMEDIATION_EXHAUSTED | LOCAL_BUDGET_EXHAUSTED | SESSION_TIME_LIMIT`.

**Deferred to R4A.3:** `required_session_completed_at`, `optional_continuation`.

## Active-time accounting contract (V1)

- Qualifying event: POST /api/chat only (GET routes, polling, /chat/help NEVER qualify).
- First-activity semantics: `lastActivityAt IS NULL` → credit 0s, set anchor.
- Cap: `ACTIVE_INTERVAL_CAP_SECONDS = 180` (exported from pedagogicalDecisionEngine.ts).
- Atomic update: `active_learning_seconds = active_learning_seconds + $credit` prevents race.
- Code location: immediately after session loads in `router.post("/chat", ...)` in chat.ts.

## Local node budget (V1 policy gap)

`computeLocalNodeBudget()` always returns false. `nodeStartedAt` is wall-clock, not active time. Per-node active counter not yet added. Engine input plumbing is in place for R4A.3+.

## Decision engine budget ordering (Part 12 contract)

1. Guard 1: NON_ANSWER (unchanged)
2. Guard 2: NO_COGNITIVE_PATH (unchanged)
3. Cases A (confirmed) + B (helped): confirmed evidence fires regardless of budget
4. When evidence NOT confirmed: session budget gate → END_REQUIRED_SESSION
5. Incorrect path: session budget → local budget → MAX_REMEDIATION_STEPS → continue

## Critical invariant: TIME ≠ FAILURE

END_REQUIRED_SESSION: `revisitRequired=false`, `revisitReason=null`, `newRemediationStep` unchanged (NOT incremented).

## revisitReason reset rules

Confirmation of level → `revisitRequired=false`, `revisitReason=null` (cleared together).
REMEDIATION_EXHAUSTED set by MARK_TARGET_NOT_REACHED / REVISIT_LATER.
LOCAL_BUDGET_EXHAUSTED set by STOP_LEVEL_AND_REVISIT.
SESSION_TIME_LIMIT deferred to R4A.3.

## API response additions (chat.ts res.json)

`requiredSessionMinutes`, `activeLearningSeconds`, `remainingRequiredSeconds` (derived), `sessionBudgetExhausted` (derived), `sessionDecision` (engine metaAction).

## Migration

`lib/db/migrations/0003_v2r4a_learning_budget.sql` — applied to dev + test DBs.

## R4A.3 additions

**Schema**: `lesson_sessions.required_session_completed_at` (TIMESTAMPTZ nullable), `lesson_sessions.optional_continuation` (BOOLEAN NOT NULL DEFAULT false). Migration: `0004_v2r4a3_session_completion.sql`.

**Effective budget gate**: `effectiveSessionBudgetExhausted = sessionBudgetExhausted && !session.optionalContinuation` — computed in chat.ts before engine call. This is what gets passed as `sessionBudgetExhausted` to the engine.

**Completion write**: When END_REQUIRED_SESSION fires AND `session.requiredSessionCompletedAt === null` → write `requiredSessionCompletedAt = now` synchronously (before res.json). Idempotent — once only.

**SESSION_TIME_LIMIT KN write**: Separate fire-and-forget block (after evidence block). Fires when END_REQUIRED_SESSION + nodeAttemptCount > 0 + KN exists + revisitRequired is currently false. Does NOT overwrite REMEDIATION_EXHAUSTED or LOCAL_BUDGET_EXHAUSTED.

**New routes**: POST `/lessons/:lessonId/session/finish` (returns state, no DB write), POST `/lessons/:lessonId/session/continue` (sets optionalContinuation=true).

**Frontend (lesson-page.tsx)**: `showCompletionCard = serverRequiredCompleted && !isOptionalContinuation && !isCompleted`. Local optimistic state `localOptContinuation` for instant feedback. Synced from server on refresh. Input disabled when card showing. Card shows "Այսօրվա պարտադիր ուսուցումն ավարտված է։" with [Ավարտել] (→ navigate away) and [Շարունակել կամավոր] (→ set optionalContinuation=true, resume).

## R4A.4 additions

**Teacher config**: `PUT /teacher/lessons/:id` now accepts `requiredSessionMinutes` (positive integer or null). Validated server-side. Uses existing teacher lesson update route — no new route.

**Session exposure**: GET /lessons/:id `currentSession` now includes `requiredSessionMinutes` (session snapshot) and `activeLearningSeconds`. Combined with existing `requiredSessionCompletedAt` and `optionalContinuation`, the student has all fields needed for countdown init.

**Countdown formula (frontend)**: `remainingSeconds = max(0, rsm * 60 - als)`. Initialized from `currentSession` on mount (useEffect on `session?.id`). Decrements by 1/s via `setInterval` only when `shouldTick = remainingSeconds > 0 && !serverRequiredCompleted && !isOptionalContinuation`. Resynced from `d.remainingRequiredSeconds` on every chat response.

**formatCountdown**: `MM:SS`; if seconds ≥ 3600, `H:MM:SS`. Located at top of lesson-page.tsx before the PHASES constant.

**Display states** (in lesson-page.tsx header):
- `requiredSessionMinutes == null` → nothing rendered (backward compat)
- `isOptionalContinuation` → "✓ Partadir zhamanak avartvac · kamavorshararunakutyun"
- `serverRequiredCompleted && !isOptionalContinuation` → "✓ Partadir usustsyan zhamanaknаvartvacel"
- else → "⏱ ... [countdown]"

**Teacher dashboard**: `LessonNodesPanel` gains `requiredSessionMinutes?: number | null` prop + `rsmEditing/rsmValue/rsmSaving/rsmError` state + inline edit panel. Saves via direct `fetch PUT /api/teacher/lessons/:id`. Call site passes `(l as any).requiredSessionMinutes ?? null`.

**Test pattern**: Use absolute paths (`/home/runner/workspace/...`) + `execSync("cat ...")` — avoid `__dirname` (not available in ESM). Regression T16-T18 use `execSync("pnpm run test:xxx 2>&1 || true")` and assert on pass-count string.

## Known pre-existing failure

`test:phase2a-r3` T27 was failing before R4A — confirmed by git stash check. Unrelated to budget work.
