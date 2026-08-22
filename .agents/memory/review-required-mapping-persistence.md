---
name: Review-required mapping persistence
description: Persistence and approval policy for MicroNodes with non-sufficient verified-source alignment.
---

Valid portions of a replacement mapping may persist even when some MicroNodes have `PARTIAL`, `INSUFFICIENT`, or `UNREADABLE` verified-source alignment. Those nodes must remain `needs_review` with a source-alignment reason; the original classifier audit is retained, and only an explicit individual teacher approval may mark the audit entry resolved.

**Why:** A lesson-level all-or-nothing alignment failure discarded otherwise safe, source-verified curriculum work. Treating non-sufficient source support as approval allows that work to be reviewed without inventing evidence or allowing the questionable node to become trusted content.

**How to apply:** Keep provenance, placement, instructional coverage, duplicate, and atomicity checks as hard pre-persistence failures. Filter automatic Outcome relations to sufficient nodes. Block teaching-package enrichment and final approval for unresolved current review nodes, but ignore deleted nodes and teacher-resolved audit entries. Bulk approval must not bypass source-alignment review.