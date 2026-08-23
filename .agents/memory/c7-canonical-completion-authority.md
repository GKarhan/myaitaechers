---
name: C7 canonical completion authority
description: The progression ordering and transition boundary for C7 learner-session advances.
---

Node and cognitive-level changes are authorized only after the existing C3 classifier records a qualified answer, C4 projects persisted learner state, and C6 resolves the resulting target. Pedagogical-engine outcomes remain candidates and never directly write a target.

**Why:** A model candidate, counters, or an unlinked/fallback task can look successful without being valid independent evidence. Letting any of those mutate the session would bypass C3/C4 and make C6 read stale learner state.

**How to apply:** Any new automatic, manual, or resume transition must use the shared C7 completion gate and target-transition reset path. Reset task-local/session-local state only; never clear durable evidence or the C4 ceiling.