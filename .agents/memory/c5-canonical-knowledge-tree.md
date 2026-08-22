---
name: C5 canonical Knowledge Tree
description: Durable classification and provenance rule for learner-facing Knowledge Tree states.
---

The Knowledge Tree's learner-facing state is a backend C5 projection with exactly four values: `MASTERED`, `PARTIAL`, `NOT_KNOWN`, and `NOT_STUDIED`. It uses accepted C2 path sequence order, not Bloom labels or numeric IDs. A persisted C4 level is usable only when current accepted-path C3 evidence validates its reference and contiguous threshold; otherwise C5 must fail closed to attempt-based state.

**Why:** A stale or directly written level ID can otherwise make an untouched or under-evidenced MicroNode appear learned.

**How to apply:** Keep scoring/mastery compatibility metrics separate; all Knowledge Tree aggregation and filters should consume the backend C5 state rather than recreate classification in a client.