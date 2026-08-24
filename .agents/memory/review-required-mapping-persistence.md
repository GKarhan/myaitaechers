---
name: Review-required mapping persistence
description: Persistence and approval policy for structurally safe MicroNodes with source, duplicate, or atomicity review findings.
---

Valid portions of a replacement mapping may persist even when some MicroNodes have `PARTIAL`, `INSUFFICIENT`, or `UNREADABLE` verified-source alignment; a completed bounded atomicity repair leaves a node non-atomic; duplicate review remains unresolved/rejected; or bounded semantic review is unavailable. Affected nodes must remain `needs_review` with a machine-readable reason; the original audit is retained, and only an explicit individual teacher approval may mark the review resolved.

**Why:** Lesson-wide all-or-nothing review failures discarded otherwise safe, source-verified curriculum work. Persisting a clearly marked draft enables review without inventing evidence or allowing the questionable node to become trusted content.

**How to apply:** Keep provenance, placement, instructional coverage, malformed Pass 2 structure, zero valid nodes, invalid references, and transaction failures as hard pre-persistence failures. A completed non-atomic finding, rejected/unresolved duplicate review, or semantic-review interruption is node-scoped review—not a lesson-level failure—after hard gates pass. Filter automatic Outcome relations to sufficient/atomic nodes. Block teaching-package enrichment and final approval for unresolved current review nodes, but ignore deleted nodes and teacher-resolved audit entries. Bulk approval must not bypass source-alignment or atomicity review.