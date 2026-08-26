---
name: Continuous quiz sessions
description: Durable authority and persistence rules for learner quiz retests.
---

Retests must remain child attempts of the original teacher-assigned quiz session. Never create a second learner quiz or assignment for continuation.

**Why:** Separate retest entities fragment the dashboard, history, and authority. A continuous root preserves the teacher’s assignment while allowing repeated learning-only attempts.

**How to apply:** Derive current session scope from canonical C5 only: `MASTERED` projects to `Գիտի`; every other or unresolved state projects to `Սովորելու`. Freeze each attempt’s displayed options and evidence identity before delivery. Commit answers, C3 evidence, attempt completion, and root-assignment completion atomically; run C4 only after durable evidence commits.