---
name: Bounded Phase 2 orchestration
description: Durable contract for the server-owned four-job Phase 2 teaching flow.
---

Normal Phase 2 is a bounded, server-owned flow: THEORY explains only and persists
`TASK_REQUIRED`; the next turn delivers an eligible backend source exercise or one
validated TASK; EVALUATION is used only where deterministic scoring is unavailable;
FEEDBACK is generated after the authoritative Decision Engine result and must not
introduce another task. Legacy structured AI remains isolated to legacy MICRO_CHECK
sessions with no authoritative objective payload.

**Why:** Educational AI may phrase explanations, tasks, semantic evaluations, and
feedback, but must never become the authority for task identity, scoring,
progression, evidence, or completion.

**How to apply:** Preserve the four boundaries when extending Phase 2. New bounded
tasks must not use a provenance shape that can fall through to legacy compatibility.
Reject task-shaped THEORY/FEEDBACK and non-answerable TASK output before route side
effects; non-deterministic source exercises use bounded EVALUATION before the
Decision Engine.