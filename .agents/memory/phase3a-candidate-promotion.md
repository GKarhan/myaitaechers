---
name: Phase 3A candidate promotion
description: The canonical boundary between transient knowledge candidates, promoted MicroNodes, and durable source preservation.
---

Phase 3A uses the existing `KnowledgeCandidate` contract and pure promotion decision at the final automatic-mapping boundary. A candidate must receive an explicit decision before it can remain a ready MicroNode.

**Why:** Source blocks and pedagogical units are not interchangeable. Directly persisting every model-proposed MicroNode caused duplicate and weak learning targets. At the same time, rejecting a candidate must never discard its verified source or its exercise.

**How to apply:** Keep only promoted candidates as MicroNodes. Keep `REVIEW_REQUIRED` candidates as source-only teacher-review records with machine-readable reasons; they are never learner-state targets. Move review-required, rejected, support-only, and unresolved candidate sources to explicit durable/review placement and preserve their activities as exercises. Do not add per-candidate provider calls; consume the existing bounded semantic review signals.