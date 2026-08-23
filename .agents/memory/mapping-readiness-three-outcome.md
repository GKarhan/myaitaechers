---
name: Mapping readiness three-outcome policy
description: Safe review findings may continue through bounded generation; only source/grounding failures are hard blocks.
---

Use three canonical lesson-mapping outcomes: `READY`, `REVIEW_REQUIRED`, and `BLOCKED`. A readable, source-grounded C1/C2 candidate with a non-critical review finding may continue through missing-content generation as `REVIEW_REQUIRED`; unreadable, insufficient, contradictory, or structurally invalid source/grounding remains `BLOCKED`.

**Why:** Treating every review flag as a stop hid usable work and made teachers resolve administrative status before they could inspect a safe generated candidate, while allowing unsafe source through would weaken the final-approval authority.

**How to apply:** Keep final approval strict and preserve teacher edits. Limit AI self-repair to one regeneration of a fresh rejected candidate, revalidate it, and never overwrite persisted reviewed content. Present Armenian ready/review/blocked language in primary UI; keep diagnostic codes secondary.