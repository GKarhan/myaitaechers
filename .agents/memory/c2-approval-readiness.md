---
name: C2 approval readiness
description: Rules for keeping approved MicroNodes aligned with confirmed C2 paths under concurrent authoring.
---

An approved MicroNode must have a canonically accepted, confirmed C2 path. Approval, confirmation, and any mutation that invalidates C2 must serialize on the same parent-MicroNode lock and evaluate the effective post-patch state while holding it. The legacy Bloom target copy is derived only when canonical confirmation succeeds.

**Why:** Pre-lock readiness checks permit both race orders: an edit can land after confirmation, or approval can land after invalidation. Either can leave published state paired with stale or review-required C2.

**How to apply:** Reuse the canonical C2 acceptance validator inside the lock for individual approval and authoring transitions. Invalidating edits must de-confirm C2 and demote already-approved authoring state before commit.