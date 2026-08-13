---
name: Phase 2 Teaching Content Enrichment Fix
description: Root causes and fixes for Phase 2 generation being broken after mapping/remapping.
---

## Root Causes (all three were present)

**RC-1: Button never rendered**  
`GenerateTeachingContentButton` was defined in `teacher-dashboard.tsx` but had NO call site — never rendered in `LessonNodesPanel`. Teachers had no UI trigger.

**RC-2: Phase 2 skipped draft nodes**  
The route at `lessons.ts` (generate-teaching-content batch loop) had a guard that skipped nodes with `status === "draft"` or `status === "needs_review"`. Since remapping inserts all nodes as `draft`, Phase 2 was always skipped after remap.

**RC-3: Second run could degrade fields**  
The Phase 2 update logic overwrote fields unconditionally. If the AI returned `basicExamples: []` on a re-run (borderline-thin theory node), it would overwrite a valid array from the prior run, causing Final Approval to fail.

## Fixes Applied

**Backend (lessons.ts generate-teaching-content route):**
- Removed the `draft`/`needs_review` skip gate. The teacher's explicit click IS the review action; the real quality gate is `isWeakSource()` inside `generatePhase2Content()`.
- Changed Phase 2 field updates to "don't degrade" semantics: only overwrite a field if the new AI response is non-empty. `phase2Updates` object built conditionally, never overwrites non-null with null/empty.
- Dead code path `skipped_needs_review` preserved in the handler (no longer reachable but not harmful).

**Frontend (teacher-dashboard.tsx LessonNodesPanel):**
- Added `<GenerateTeachingContentButton lessonId={lessonId} hasNodes={nodes.length > 0} />` to the panel header between the delete-all button and the Final Approval button.
- Added Phase 2 status banner in the content area (IIFE): when `phase2Missing > 0`, shows how many nodes need teaching content generation with hint text.

## Two-Step Workflow Preserved
`Mapping → Teacher reviews/edits structure → [teacher clicks "Generate Teaching Content"] → Phase 2 → Final Approval`

Phase 2 does NOT auto-run after mapping. Generation and Final Approval remain separate operations.

## Lesson 105 Post-Fix State
- 9 nodes, all `status="approved"`, all 4 Phase 2 fields present
- 3 topics, 15 textbook exercises (all approved)
- Final Approval: `approved=true, errors=0, warnings=0`

## Test File
`artifacts/api-server/src/lib/__tests__/phase2-generation.test.ts` — 17 tests (G1–G10, H1–H7), all passing.

**Why:**  
Nodes after mapping have `status: "draft"`. The original code's draft-skip gate was written to prevent "unreviewed" nodes from getting Phase 2, but this made Phase 2 permanently broken after any remap. The teacher's explicit button click is sufficient review signal.

**How to apply:**  
If Phase 2 is broken again: check (1) whether the button renders in LessonNodesPanel header, (2) whether the route skips nodes by status, (3) whether the update is using conditional don't-degrade logic.
