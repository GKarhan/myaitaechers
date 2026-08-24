---
name: Pass 2 block-survival invariant
description: Prevent verified source blocks from disappearing between topic grouping and concrete Pass 2 placement.
---

Every verified block must have exactly one provisional Topic membership before Step 2, and every Step 2 input must have one concrete placement afterwards. Missing model output is retained as topic-scoped unmapped/review material, not forced into a MicroNode.

**Why:** Topic-group prompts can still omit an index. If that loss is not repaired before organization, later review-safe preservation cannot locate a Topic home and the protected final source validator rejects the map.

**How to apply:** Normalize topic membership deterministically after every Step 1 group transformation, then compare all concrete source/support/activity/unmapped references after Step 2. Rescue only unreferenced blocks with an existing Topic home; do not move existing references or alter the final coverage validator.