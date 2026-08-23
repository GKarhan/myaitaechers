---
name: Phase 2A R3 Cognitive Path
description: Cognitive path review workflow, confirmation gate, TC staleness, add/reorder levels, routes, and test coverage.
---

## Cognitive Path Status Machine

`lesson_nodes` has two new columns (added via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`):
- `cog_path_status TEXT` — null → 'needs_review' → 'confirmed'
- `teaching_content_stale BOOLEAN NOT NULL DEFAULT false`

**Must apply to BOTH databases when schema changes:**
- Main DB: `psql "$DATABASE_URL"`
- Test DB: `psql "$TEST_DATABASE_URL"`

## Routes (all under `/lessons/:lessonId/nodes/:nodeId/`)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `generate-cognitive-path` | Generate or force-regenerate; sets `cogPathStatus='needs_review'` |
| POST | `confirm-cognitive-path` | Teacher confirm; validates ≥1 level and exactly 1 ceiling |
| GET  | `cognitive-path` | Returns levels + `cogPathStatus` from node row |
| POST | `cognitive-levels` | Add a single level (teacher_authored) |
| POST | `cognitive-levels/reorder` | Reorder all levels (two-pass to avoid unique constraint) |
| POST | `cognitive-levels/:id/update` | Edit level fields; calls `invalidateCogPathConfirmation` |
| DELETE | `cognitive-levels/:id` | Remove level; calls `invalidateCogPathConfirmation` |

## Force-Regeneration Guard (generate-cognitive-path route)

Before the teacher-edits check:
1. Query `priorStatusRow` → get `cogPathStatus` and `childFriendlyExplanation` (for TC detection)
2. `priorIsConfirmed = cogPathStatus === 'confirmed'`
3. `priorHasTc = !!childFriendlyExplanation`
4. Block (409) if `(hasTeacherEdits || priorIsConfirmed) && !force`
5. Response includes `isConfirmed` flag so frontend can differentiate dialog text

## invalidateCogPathConfirmation helper

Located before the router in `lessons.ts`. Called by update/delete level routes.
```
if priorIsConfirmed && priorHasTc → sets cogPathStatus='needs_review' + teachingContentStale=true
if priorIsConfirmed && !priorHasTc → sets cogPathStatus='needs_review' only (no stale)
if not confirmed → no-op
```

## Teaching Content Gate

`POST /lessons/:lessonId/nodes/:nodeId/enrich` is gated by `cogPathStatus === 'confirmed'`.
- Returns 403 `COG_PATH_NOT_CONFIRMED` if not confirmed.
- On success, fetches confirmed levels and passes as `cogPath` to `buildPhase2Prompt`.
- On success, clears `teachingContentStale = false`.

## Phase2Input / buildPhase2Prompt

`ConfirmedCogLevel` interface exported from `lesson-mapping.ts`.
`Phase2Input.cogPath?: ConfirmedCogLevel[]` — optional; passed only when gate is open.
`buildPhase2Prompt` adds `COGNITIVE CALIBRATION` section when `cogPath` is present.
`PHASE2_SYSTEM` rule 6: must align TC with the target ceiling cognitive level.

## Frontend (teacher-dashboard.tsx) UI States

**Cog path header toggle button:**
- Shows `✓ Hastatvel` (emerald badge) when `cogPathStatus === 'confirmed'`
- Shows `⏳ Gashmvum e` (amber badge) when `cogPathStatus === 'needs_review'`

**Cog path panel:**
- Generate/Regenerate button always visible (when not loading)
- **Confirm button** (`✓ Hastatsel channachogakan ughiny`): emerald, visible when `cogPathStatus === 'needs_review'` + levels exist
- `confirmCogPath(nodeId)` handler calls `POST /confirm-cognitive-path`
- **Force-confirm dialog**: differentiates confirmed path vs teacher-edit-only wording based on `cogPathStatus`
- **Reorder buttons**: ↑/↓ on each level card header; calls `reorderCogLevel(nodeId, levelId, dir, levels)`
- **Add-level form**: `+ Avel channachogakan macardak` → inline form with Bloom level select + optional PO/SC fields

## Lesson-level teacher workflow

Keep lesson-level generation behind the same authority boundaries as its detailed controls: C2 never force-replaces teacher decisions, and Teaching Content requires resolved C1 plus a confirmed C2 path. Lesson final approval remains deterministic and never auto-approves prerequisites.

**Why:** A compact workflow removes duplicate entry points without weakening the C1/C2 confirmation, teacher-edit, or final-approval authority boundaries.

**How to apply:** Any future bulk or UI shortcut must preserve the per-node preflight, confirmed-path calibration, and teacher-edit guard rather than treating a lesson-wide click as review authority.

## New state vars in teacher-dashboard.tsx

- `cogPathConfirming: Record<number, boolean>` — per-node confirming spinner
- `addLevelOpen: Record<number, boolean>` — inline form visibility
- `addLevelForm: Record<number, { cognitiveLevel: string; performanceObjective: string; successCriterion: string }>` 
- `addLevelSaving: Record<number, boolean>` — add-level save spinner

## Test Coverage

File: `artifacts/api-server/src/lib/__tests__/phase2a-r3-closure.test.ts`
Runner: `pnpm run test:phase2a-r3-closure`
Result: 30/30 passing (T01–T30)

Tests cover:
- T01–T04: cogPathStatus + teachingContentStale column basics
- T05–T07: Confirmation validation preconditions (zero levels, no ceiling, one ceiling)
- T08–T10: Level management (add teacher_authored, delete, reorder two-pass)
- T11–T13: Level field updates (ceiling, MIE, interaction types)
- T14–T15: Task link and cascade delete
- T16–T18: TC gate states (A=null, B=needs_review, C=confirmed)
- T19: Confirmed context (PO+SC) queryable for prompt
- T20–T22: Staleness lifecycle (set, TC preserved, cleared on regen)
- T23–T24: Regeneration safety (priorIsConfirmed blocks, force sets needs_review)
- T25–T29: Other subsystems unaffected (title, sequence, LO, bloomLevel, authoring status)
- T30: Zero test pollution (Beta node untouched)

**Why:** Keep test DB migrations in sync — the `cog_path_status` + `teaching_content_stale` columns must be applied to `heliumdb_test` independently.
