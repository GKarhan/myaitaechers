---
name: Review-required mapping persistence
description: Persistence and approval policy for MicroNodes with verified-source or completed atomicity review findings.
---

Valid portions of a replacement mapping may persist even when some MicroNodes have `PARTIAL`, `INSUFFICIENT`, or `UNREADABLE` verified-source alignment, or when a completed bounded atomicity repair leaves a node non-atomic. Those nodes must remain `needs_review` with a machine-readable reason; the original audit is retained, and only an explicit individual teacher approval may mark the review resolved.

**Why:** Lesson-wide all-or-nothing review failures discarded otherwise safe, source-verified curriculum work. Persisting a clearly marked draft enables review without inventing evidence or allowing the questionable node to become trusted content.

**How to apply:** Keep provenance, placement, instructional coverage, malformed structural decisions, unresolved duplicate decisions, and technical verification interruption as hard pre-persistence failures. A completed non-atomic finding is node-scoped review, not a lesson-level failure. Filter automatic Outcome relations to sufficient/atomic nodes. Block teaching-package enrichment and final approval for unresolved current review nodes, but ignore deleted nodes and teacher-resolved audit entries. Bulk approval must not bypass source-alignment or atomicity review.