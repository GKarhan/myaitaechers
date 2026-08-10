---
name: Phase 4 granularity review
description: Pass 2B semantic granularity review — architecture, gating strategy, and key design decisions.
---

## Architecture

`runGranularityReview(topics, blocks)` in `lesson-mapping.ts`:
- Called AFTER Step 2 (`organizeTopicMicroNodes`), BEFORE `validateSourceCoverage`
- Single AI call over all topics simultaneously (cross-topic OVER_SPLIT detection)
- Returns `GranularityFinding[]` (never throws; returns `[]` on any failure)
- Model: `PASS2B_REVIEW_MODEL = "deepseek/deepseek-chat"`

## Gating strategy (Option C, approved)

- Structural issues (missing/duplicate/invalid block indices) → hard fail (`coverage_failed`) — Phase 3, unchanged
- Semantic issues (MEGA_NODE / OVER_SPLIT / EXERCISE_MISMATCH) → advisory (`completed` + reviewItems) — Phase 4

`granularityFindings` are NEVER used to change `jobStatus`. Only `coverageValidation.valid` drives that.

## Key design decisions

**Why threshold 0.25 for Jaccard similarity:**
Tested against production finding L104 MN1193+MN1196 ("find unknown addend" / "rules for finding unknown addend").
"find" and "finding" are different tokens — stemming not implemented. 0.35 missed the case; 0.25 catches it.
The AI makes the final OVER_SPLIT determination; the heuristic is a pre-filter signal only.

**Why "AND alone ≠ MEGA_NODE":**
Armenian text frequently uses "և" to add method descriptions to a single procedure (e.g. "group digits from right to left"). The prompt's one-procedure exception is explicit with a counter-example to prevent false positives.

## Quality metrics in mappingReport.quality

- `coverageIssues`: count of Phase 3 review items (skipped pages + coverage gaps) — computed before Phase 4 items are appended
- `granularityIssues`: count of Phase 4 findings
- Both persisted in `mappingMetadata`; both exposed from `GET /teacher/courses/:id/lessons`

## Teacher dashboard badges (P4.13)

Orange `⚠️ Coverage` — Phase 3, shown when `coverageValid === false`
Yellow `⚠️ Granularity: N` — Phase 4, shown when `granularityIssues > 0`

**Why:**
Structural failures (coverage) require re-mapping; semantic findings (granularity) require teacher review only.
Different visual weight (orange vs yellow) communicates this distinction.
