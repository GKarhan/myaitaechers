---
name: C6 canonical personalization
description: Boundary and safety rules for learner next-target selection.
---

C6 is the single backend owner of **what** a learner should work on next:
MicroNode, C2 Cognitive Level, action (`START`, `CONTINUE`, `REMEDIATE`,
`REVIEW`, or `ADVANCE`), prerequisite redirect, and reason code. It consumes
accepted C2 paths, C5 state (which already incorporates the trusted C4 ceiling),
and persisted `REQUIRED` dependencies. C7/pedagogical orchestration continues
to own **how** the selected target is taught.

**Why:** Numeric Bloom ordering, legacy first-node selection, and optimistic
dependency checks can silently select an invalid or already-demonstrated target.
One deterministic service keeps lesson entry, Knowledge Tree handoff, chat
rehydration, and node advancement aligned.

**How to apply:** Use the C6 resolver for new or inactive session targets and
node completion. Preserve authoritative active tasks. Only an `ADVANCE` decision
with no eligible MicroNode may move a Phase 2 session into wrap-up; invalid C2
paths or invalid REQUIRED graphs must block delivery rather than falling back to
legacy targeting. Do not add a competing Bloom fallback or a separate
personalization snapshot without a new explicit contract.