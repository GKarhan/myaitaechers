---
name: Pass 1 vision token budget
description: Dense Armenian textbook pages can exceed vision output limits even in two-page chunks; incomplete output must never enter source mapping
---

## Observation

Հայoц Лezu 7, pages 22–29 (lesson 68):

- `PASS1_CHUNK_PAGES = 2`, `PASS1_MAX_TOKENS = 32000`
- Chunks 1 (pp22-23) and 3 (pp26-27) still hit max_tokens
- Earlier partial recovery appeared to salvage blocks but still missed exercises №5–6
  on p22 and some mid-page rules on pp26-27.

**Why:** Armenian language textbooks have exercises that are long multi-item lists (e.g. exercise 8: lists 20+ word categories). Each block's verbatim sourceText can be 400–800 chars. 2 pages × ~15 blocks × 600 chars avg ≈ 18,000 chars ≈ 18,000+ tokens for content alone, not counting JSON overhead.

## How to apply

For Pass 1 vision path, use a **1-page retry fallback** when `finish_reason === "length"`:

1. Run 2-page chunk normally (fast path)
2. Discard every truncated response; never salvage or persist partial blocks.
3. Retry each page separately. If a one-page response also truncates, mark that page
   for manual review rather than mapping incomplete source.

**Why:** A syntactically recoverable prefix cannot show that all source content was
extracted, so using it silently loses textbook evidence.

The two-page default remains efficient for ordinary pages; dense pages incur the
one-page fallback cost.
