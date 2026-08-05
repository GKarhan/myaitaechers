---
name: Pass 1 vision token budget
description: Armenian language textbook exercises produce verbatim JSON that exceeds token limits even at 2 pages/chunk with 32k max_tokens
---

## Observation

Հայoц Лezu 7, pages 22–29 (lesson 68):

- `PASS1_CHUNK_PAGES = 2`, `PASS1_MAX_TOKENS = 32000`
- Chunks 1 (pp22-23) and 3 (pp26-27) still hit max_tokens
- Truncation recovery salvaged 11/~15 and 12/14 blocks respectively
- Missing blocks: exercises №5–6 on p22; some mid-page rules on pp26-27

**Why:** Armenian language textbooks have exercises that are long multi-item lists (e.g. exercise 8: lists 20+ word categories). Each block's verbatim sourceText can be 400–800 chars. 2 pages × ~15 blocks × 600 chars avg ≈ 18,000 chars ≈ 18,000+ tokens for content alone, not counting JSON overhead.

## How to apply

For Pass 1 vision path, implement a **1-page retry fallback** when `finish_reason === "length"`:

1. Run 2-page chunk normally (fast path)
2. If truncated AND recovery found < expected blocks: retry as two separate 1-page calls and merge
3. This guarantees lossless extraction at the cost of 2× API calls for dense pages

The `PASS1_CHUNK_PAGES = 2` default is still correct for most pages — only ≈2/4 chunks of this textbook hit the limit.
