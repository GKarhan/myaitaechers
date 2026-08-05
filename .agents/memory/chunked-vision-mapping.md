---
name: Chunked vision mapping
description: Implementation details and known limitations of the 3-pages-per-call vision mapping path for ArmSCII PDFs.
---

## Rule
Use `VISION_CHUNK_PAGES = 3` pages per call with `max_tokens = 32000`.  
Do NOT send all pages in a single call — empirically confirmed to cause degenerate/repeated output.

**Why:** Sending all 8 pages of lesson 67 in one call caused the model to lose grounding on later pages, producing either fabricated singular/plural content (run 1) or repeated exercises (run 2). Chunking to 3 pages fixed that: 0 duplicates detected across 3 chunks, 26 distinct exercises.

**How to apply:** The constant `VISION_CHUNK_PAGES` in `lesson-mapping.ts` controls chunk size. Both the first and retry API calls use `max_tokens: 32000` (16 000 was not enough — chunk 1 with 3 pages and ~12 exercises exceeded it).

## Known limitations

- **Verbatim OCR diverges from ground truth** on exercises 17–20 (pages 26–27). The model reads the rendered ArmSCII glyphs but transcribes them differently than the source text. This is a font-rendering/OCR limitation, not a chunking defect.
- **Retry still needed on chunk 2** (pages 25–27): the model returns a JSON blob wrapped in ```json fences. The `extractJSON` helper strips fences, so the retry is a belt-and-suspenders path that succeeds. It happens because Gemini often wraps output in markdown even when instructed not to.
- **`exerciseNumber` field = 0** for all exercises in the DB. The model embeds exercise numbers as part of `exerciseTextVerbatim` (e.g. "17. Zug…") but doesn't set the JSON `exerciseNumber` integer field. Pre-existing issue — not introduced by chunking.

## Merge strategy
- Metadata (`lessonGoal`, `coreProblem`, `coreIdea`, `essentialQuestion`, `knowledgeBoundaries`): chunk 1 only.
- Textbook fields (`textbookAuthor`, `textbookTitle`, `chapterTitle`): first non-null across chunks.
- Nodes: union, deduplicated by `title.trim().toLowerCase()`, keep first occurrence.
- `practicalTasks`: union, deduplicated by `exerciseTextVerbatim.trim()`. Identical verbatim = degenerate hallucination signal → logged as WARN, excluded.
- `nodeDependencies`: chunk 1 only (cross-chunk refs would point to non-existent titles).
