---
name: Phase 2 pipeline
description: Two-step AI pipeline (Pass 1 block extraction → Pass 2 MicroNode org → Phase 2 teaching content); background job architecture; merge-pass; weak-source guard.
---

## Pass 1 — verbatim block extraction
- Text path: `extractBlocksWithAI` (deepseek model). Garbled ArmSCII detected by `isGarbledText()` → switches to vision path `extractBlocksWithVision`.
- Vision path: 1–3 pages/chunk, rasterised via `rasterizePdfPages`, max 32k tokens/chunk.
- **`isGarbledText()` has edge-case sensitivity** — misses some ArmSCII artifacts (patterns like `"ö. Ø º Ú Â Æ"`). If Pass 1 text extraction silently produces garbled blocks, the fix is to broaden the garbled-text regex.

## Pass 2 — topic grouping + MicroNode organisation
`runPass2Pipeline(blocks, lessonInfo)` → `Pass2Result`:
- Step 1a: AI groups blocks into topic buckets
- Step 1b: size-cap (max 20 blocks/group)
- **Step 1c: `hasRealTheory` merge-pass** — hollow groups (no DEFINITION/RULE/NOTE/EXAMPLE/OBJECTIVE block > 50 chars) are merged into the nearest real-theory neighbour (backward-first, then forward). If no neighbour has real theory, kept as-is.
- Step 2: AI organises each group into MicroNodes with exercises

**Why the merge-pass:** AI occasionally creates standalone exercise-only groups ("Exercises and Activities on X") that become hollow MicroNodes (zero theory content). Step 1c eliminates these before Step 2 runs.

## Phase 2 — teaching content generation
`generatePhase2Content(input, exercises)` → `Phase2GenerationResult`:
- Model: `deepseek/deepseek-v4-flash` (via OpenRouter), 4096 max_tokens, 1 JSON-parse retry
- Weak-source guard (`isWeakSource()`): null/empty/< 50 chars/URL-pattern → skip, write `status='needs_source_content'`
- Adjustments A1 (analogy present → contentSourceType='mixed') and A2 (mixed → confidence capped at 90)

**Why 4096 tokens:** 2048 truncates Armenian text; 4096 reliably captures full structured output.

## Background job architecture (mapping_jobs table)
Both long-running endpoints now return immediately:
- `POST /lessons/:id/map` → creates `mapping_jobs` record, responds `{ jobId, status:'pending' }`, fires `setImmediate` for actual processing
- `POST /lessons/:id/generate-teaching-content` → same pattern
- `GET /lessons/jobs/:jobId` → poll endpoint (teacher-only); returns `{ status, result, error }`

DB schema: `lib/db/src/schema/mapping-jobs.ts` (exported from index.ts)
Table columns: `id, lessonId, jobType('map'|'generate_teaching_content'), status('pending'|'running'|'completed'|'failed'), result(jsonb), error, createdAt, updatedAt`

**How to apply:** Job lifecycle: pending → running (at setImmediate start) → completed (full result stored in result jsonb) | failed (error string stored). Frontend polls every 3s using `useQuery` with `refetchInterval` that stops when status ∉ {pending, running}.

## Frontend polling (teacher-dashboard.tsx)
`LessonMapButton` now:
1. On mutate success: receives `{ jobId }`, stores in state
2. `useQuery` polls `/api/lessons/jobs/:jobId` every 3s (enabled when jobId set)
3. `useEffect` on `jobStatus.status`: on 'completed' → invalidate node/topic/exercise queries + clear jobId; on 'failed' → show error + clear jobId

`GenerateTeachingContentButton` — new component alongside LessonMapButton:
- Manual `fetch` POST (not via generated mutation), same job-poll pattern
- Mounted next to `<LessonMapButton>` in the lesson card at line ~2599 of teacher-dashboard.tsx

## ArmSCII gap (lesson 69 nodes 1002–1004)
Node titles for lessons 68 & 69 are correct Armenian Unicode. However, `theory_content` for nodes 1002–1004 contains garbled ArmSCII text — that was the actual content extracted from the PDF (Pass 1 text path silently passed garbled ArmSCII). Phase 2 still runs on these nodes because the garbled text has > 50 chars (passes `isWeakSource()`), but the teaching content AI received garbled input.

**Fix if needed:** Broaden `isGarbledText()` to catch ArmSCII ligature artifacts, or add a post-Pass-1 block-level garbled check before inserting into lesson_nodes.
