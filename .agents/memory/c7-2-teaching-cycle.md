---
name: C7.2 teaching-cycle persistence
description: Durable ordering and recovery rules for the server-owned TEACH → MICRO_CHECK → FEEDBACK → TRANSITION cycle.
---

`TEACH` and `FEEDBACK` are learner-visible persisted boundaries, not incidental
strings that may be skipped by internal continuation. A state release to
`TASK_REQUIRED` is allowed only after its corresponding assistant message has
been persisted. If that release fails, the safe result is a repeatable boundary,
never a silently created next task.

**Why:** Provider and persistence failures must not let an evaluation or theory
message disappear while the session advances. Feedback retries must preserve
the canonical C3 evaluation rather than infer correctness from untrusted chat
history.

**How to apply:** Record the evaluated turn's canonical status/error facts in
immutable evidence before clearing mutable active-task state. Use that evidence
and the evaluated-task snapshot for any feedback retry or pedagogical decision.
Keep C3 → C4 → C6 authorization intact; only defer C7's actual session
transition until the feedback message exists.