---
name: Phase 2 pipeline
description: Two-step AI pipeline (Pass 1 block extraction → Pass 2 MicroNode org → Phase 2 teaching content); background job architecture; lesson-centric status endpoints; merge-pass; weak-source guard.
---

## Pass 1 — verbatim block extraction
- Text path: `extractBlocksWithAI` (deepseek model). Garbled ArmSCII detected by `isGarbledText()` → switches to vision path `extractBlocksWithVision`.
- Vision path: 1–3 pages/chunk, rasterised via `rasterizePdfPages`, max 32k tokens/chunk.
- **`isGarbledText()` has edge-case sensitivity** — misses some ArmSCII artifacts. If Pass 1 text extraction silently produces garbled blocks, broaden the garbled-text regex.

## Pass 2 — topic grouping + MicroNode organisation
`runPass2Pipeline(blocks, lessonInfo)` → `Pass2Result`:
- Step 1a: AI groups blocks into topic buckets
- Step 1b: size-cap (max 20 blocks/group)
- **Step 1c: `hasRealTheory` merge-pass** — hollow groups (no DEFINITION/RULE/NOTE/EXAMPLE/OBJECTIVE block > 50 chars) are merged into the nearest real-theory neighbour. If no neighbour has real theory, kept as-is.
- Step 2: AI organises each group into MicroNodes with exercises

## Phase 2 — teaching content generation
`generatePhase2Content(input, exercises)` → `Phase2GenerationResult`:
- Model: `deepseek/deepseek-v4-flash` (via OpenRouter), 4096 max_tokens, 1 JSON-parse retry
- Weak-source guard (`isWeakSource()`): null/empty/< 50 chars/URL-pattern → skip, write `status='needs_source_content'`
- Adjustments A1 (analogy present → contentSourceType='mixed') and A2 (mixed → confidence capped at 90)

## Background job architecture (mapping_jobs table)
Both long-running endpoints return immediately:
- `POST /lessons/:id/map` → creates job, responds `{ jobId, status:'pending' }` in ~67ms, fires `setImmediate` for actual processing
- `POST /lessons/:id/generate-teaching-content` → same pattern

DB schema: `lib/db/src/schema/mapping-jobs.ts` (exported from index.ts)
Table columns: `id, lessonId, jobType, status, progress(text), result(jsonb), error, createdAt, updatedAt`

Job lifecycle: pending → running (setImmediate start) → completed | failed
Progress column updated at: "Pass 1 starting...", "Pass 2 starting (N blocks)...", "Saving...", "Generating teaching content (N/M MicroNodes)..."

## Lesson-centric status endpoints (navigation-away safe)
- `GET /lessons/:lessonId/map-status` — returns latest 'map' job for this lesson (status + progress + result + error). Returns `{ jobId: null, status: 'none' }` if no jobs exist.
- `GET /lessons/:lessonId/generate-status` — same for 'generate_teaching_content' jobs.
Both ordered by `desc(mappingJobsTable.id)` LIMIT 1.

**Why lesson-centric (not job-ID-centric):** Frontend components mount fresh after navigation. Lesson-centric status means the button can detect and resume an in-progress or completed job without the client storing a jobId across navigation.

## Frontend polling pattern (teacher-dashboard.tsx)
Both `LessonMapButton` and `GenerateTeachingContentButton` use the same pattern:
1. `useQuery` on `['lesson-map-status', lessonId]` / `['lesson-generate-status', lessonId]` with `staleTime: 0`
2. `refetchInterval`: 3000ms while status ∈ {pending, running}, false otherwise
3. `useRef<string>` tracks previous status to fire `useEffect` only on transitions (completed → invalidate queries; failed → show error)
4. `postPending` state handles the window between POST submit and first poll response

Progress label rendered as `text-[10px] animate-pulse max-w-[200px] truncate` with the `progress` field from the job record.

## ArmSCII gap (lesson 69 nodes 1002–1004)
Node **titles** for all 10 nodes (1002–1011) are correct Armenian Unicode. However, `theory_content` for nodes 1002–1004 contains garbled ArmSCII text from the PDF. Phase 2 runs on these (passes `isWeakSource()`), but gets garbled input.

**Fix if needed:** Broaden `isGarbledText()` to catch ArmSCII ligature artifacts, or add a post-Pass-1 block-level garbled check before inserting into lesson_nodes.
