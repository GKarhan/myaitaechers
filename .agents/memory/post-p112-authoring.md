---
name: Post-P1.12 authoring simplification
description: everApproved flag, invalidation guard, per-node Phase 2 enrich route, NodeViewModal, GenerateTeachingContentButton safety guard.
---

## everApproved column
- Added `everApproved: boolean("ever_approved").notNull().default(false)` to `lessonsTable` in `lib/db/src/schema/lessons.ts`
- Migration: `artifacts/api-server/src/migrations/add-ever-approved.ts` — adds column + backfills `approved/active/assigned/completed` lessons to `true`
- Set to `true` by `final-approve` route at first approval; NEVER reverted

## invalidateLessonApproval gate
- WHERE clause: `status='approved' AND everApproved=false` — permanent no-op once `everApproved=true`
- Lesson-final-approval test I1 updated: now asserts lesson STAYS approved when `everApproved=true`
- Lesson-final-approval test I2 updated: tests the `everApproved=false` backward-compat path

## Per-node Phase 2 enrich route
- `POST /lessons/:lessonId/nodes/:nodeId/enrich` added in `lessons.ts` (before delete route)
- Validates node ownership (returns 404 for cross-lesson nodeId or missing node)
- Calls `generatePhase2Content` synchronously — can take 25-45 seconds in production
- Uses don't-degrade semantics (only writes non-empty AI fields)
- Returns updated node JSON on success; `{error: "SKIP", skipReason}` on 422

## Frontend (teacher-dashboard.tsx)
- `NodeViewModal` component: read-only overlay, fixed-position, `onClose → Փакел` only, zero DB writes
- `GenerateTeachingContentButton` now accepts `hasExistingPhase2: boolean` — shows `window.confirm()` before whole-lesson regen if true; renders 🔄 when enrichment already exists
- `renderNodeCard` buttons: 👁 (view) + 🧠 (per-node enrich) + ✏️ (edit) + 🗑️ (delete)
- `enrichNode(nodeId)` async function in `LessonNodesPanel`; state: `enrichingNodeId`, `enrichNodeErrors`, `enrichNodeDone`
- Modal mounted inside root div of LessonNodesPanel (not outside — would break JSX single-root rule)

## Node update route path
- **Correct**: `POST /lessons/:lessonId/nodes/:nodeId/update` (not PUT, not without /update suffix)
- Tests must use this path — PUT returns 404

## Tests
- New: `post-phase112-authoring-simplification.test.ts`, 24 cases A1–E4, all pass
- Script: `pnpm run test:post-p112-authoring`
- Regression: `lesson-final-approval.test.ts` 12/12 pass (I1/I2 updated for new semantics)

**Why:** Spec requirement — after first Final Approval, ordinary teacher edits must not trigger re-approval workflow; teacher is final authority over their own lesson content.
