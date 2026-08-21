---
name: Canonical outcome alignment
description: Compatibility and lifecycle rules for C1 Lesson Outcomes and Outcome-to-MicroNode alignment.
---

Canonical Lesson Outcomes are separate, normalized curriculum authoring data. Their MicroNode relations are many-to-many and store a canonical Bloom depth value rather than the identifier of a Cognitive Path level row.

**Why:** Cognitive Paths belong to MicroNodes and may be edited, deleted, or regenerated. A relation to a transient Cognitive Path row would either break or silently change the curriculum contract. Existing `lessons.lessonOutcomes` JSON also has legacy content that cannot safely imply reviewed MicroNode relations.

**How to apply:** When assessing an alignment, resolve the MicroNode’s current target ceiling and compare ranks to the stored depth. Treat an unconfirmed/missing Cognitive Path as a review signal; do not alter learner delivery, session state, evidence, mastery, Knowledge Tree, or lesson approval. Preserve the legacy JSON field, and only copy legacy strings into draft canonical outcomes through an explicit teacher action without inferring relations.