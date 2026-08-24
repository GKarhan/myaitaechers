---
name: Goal/Outcome working drafts
description: Canonical persistence and lifecycle boundary for lesson Goals and Outcomes.
---

A saved lesson Goal plus canonical Outcome set is the teacher’s current working draft. Import must atomically persist the complete proposed set and verify the canonical read-back before reporting success; retries must not duplicate Outcomes.

**Why:** The primary teacher UI previously showed a saved Goal without its canonical Outcomes, obscuring whether the intended working draft actually existed.

**How to apply:** Keep the main Goal/Outcome view bound to canonical Outcome records, not a legacy JSON compatibility field or count-only response. Treat a Goal without Outcomes (or vice versa) as an explicit incomplete state rather than a completed draft.

Teachers do not need a separate Goal/Outcome approval action to keep mapping available. Deleting a working draft clears only its Goal, canonical Outcomes, stored proposal, and Outcome-to-MicroNode relations.

**Why:** Goal/Outcome authoring is a draft lifecycle; deletion must permit recreation without remapping or damaging other lesson content.

**How to apply:** Preserve Topics, MicroNodes, Cognitive Paths, Teaching Content, exercises, quizzes, learner data, and legacy compatibility data when deleting a Goal/Outcome draft. Reuse the normal lesson-approval invalidation mechanism after authoring changes.