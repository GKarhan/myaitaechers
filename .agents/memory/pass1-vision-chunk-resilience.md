---
name: Pass1 vision chunk resilience
description: Rules for handling JSON-parse failures inside extractBlocksWithVision to prevent error strings from leaking into node titles.
---

## The rule
Inside the `extractBlocksWithVision` chunk loop, **never throw for a single chunk's failure**.  
All chunk-level failures must go through the 1-page fallback → `skippedPageRanges` → `continue` path.  
Only throw AFTER the loop when `allBlocks.length === 0` (every chunk failed).

## Error paths and their correct response

| Failure type | Wrong response | Correct response |
|---|---|---|
| `finish_reason === "length"` (truncated) | throw | run1PageFallback("truncated response") |
| JSON parse fails on first attempt + retry | throw | run1PageFallback("JSON parse failed after retry") |
| 1-page fallback: one page fails | throw | skippedPageRanges.push(page); continue |
| 1-page fallback: ALL pages fail | throw | skippedPageRanges.push(chunk range); continue outer |

## Why
Throwing mid-loop propagates out of `extractBlocksWithVision` before the DB clear (lesson_nodes DELETE) runs.  
If old nodes exist from a prior mapping run, they are left untouched — any error message string stored there as a node title persists and is surfaced to users.  
The `skippedPageRanges` array flows into `Pass1Result` and is turned into `reviewItems` entries in the mapping report, giving the teacher visibility without corrupting output.

## How to apply
- `run1PageFallback` is a closure inside `extractBlocksWithVision`; it captures `skippedPageRanges` from the outer scope.
- Truncation path AND retry-failure path both call `run1PageFallback(reason: string)`.
- `Pass1Result.skippedPageRanges?: {from,to,reason}[]` carries ranges to the route.
- In `lessons.ts`, fold `pass1.skippedPageRanges ?? []` into `reviewItems` before building `mappingReport`.

## Verification (lesson 71, pages 58–72, 8 chunks)
- Chunk 5/8 (pages 66–67) failed JSON parse → 1-page fallback recovered 26 blocks
- Final result: 159 blocks, 6 topics, 13 nodes, 49 exercises, 97% coverage
- 0 error-string nodes in DB; all review items were legitimate quality flags
