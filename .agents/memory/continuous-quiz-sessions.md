---
name: Continuous quiz sessions
description: Durable authority and persistence rules for learner quiz retests.
---

Retests must remain child attempts of the original teacher-assigned quiz session. Never create a second learner quiz or assignment for continuation.

**Why:** Separate retest entities fragment the dashboard, history, and authority. A continuous root preserves the teacher’s assignment while allowing repeated learning-only attempts.

**How to apply:** Derive current session scope from canonical C5 only: `MASTERED` projects to `Գիտի`; every other or unresolved state projects to `Սովորելու`. Freeze each attempt’s displayed options and evidence identity before delivery. Commit answers, C3 evidence, attempt completion, and root-assignment completion atomically; run C4 only after durable evidence commits.

Per-question immediate feedback may persist a finalized answer before whole-attempt completion, but feedback finalization and final submit must serialize on the same attempt lock. Final submit must consume the exact persisted selection or reject a conflict.

**Why:** Without a shared attempt lock, overlapping feedback and submit requests can leave the answer row disagreeing with the completed score and evidence.

**How to apply:** Recheck attempt completion and answer identity while holding the attempt lock. Replays of the same displayed answer are idempotent; a different displayed answer fails closed. Legacy canonical-only rows map through the frozen option order.