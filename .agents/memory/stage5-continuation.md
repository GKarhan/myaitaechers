---
name: Stage 5 continuation
description: Server-owned continuation must stop exactly at a learner-answerable task while retaining bounded AI jobs.
---

Phase 2 continuation is server-owned and may execute only no-input actions until an active, learner-visible task is persisted. THEORY, TASK, EVALUATION, and FEEDBACK remain separate bounded jobs and distinct chat messages; a continuation must never manufacture a learner acknowledgement.

**Why:** Client acknowledgement posts make progression appear learner-driven even when the backend already owns the next action. Combining jobs or advancing past a task risks losing task identity, evidence boundaries, and Stage 4 delivery safety.

**How to apply:** When adding a Phase 2 transition, derive learner-input requirement from authoritative action plus active-task state, reload server state between internal actions, enforce the deterministic cap, and preserve validation/activation before task visibility.

For a correct evaluated task whose Decision Engine outcome is `CONTINUE_COGNITIVE_LEVEL`, a legacy `VERIFIED` result with no active task is invalid: move only that state to `TASK_REQUIRED`, persist FEEDBACK once, then derive and execute the next server-owned task action. Exclude the just-answered source exercise from that immediate selection; if it was the only source row, use bounded generated-task delivery rather than repeating it or failing.

**Why:** Same-level evidence requirements are not completion. Leaving a cleared task at `VERIFIED` strands the learner, while redelivering the answered source task creates duplicate evidence attempts.

**How to apply:** Keep FEEDBACK/REMEDIATE learner-gated by default. Apply post-feedback continuation only to the explicit no-task same-level state. The learner-visible correctness acknowledgement is server-controlled; validate AI explanation text against authoritative polarity and use a safe server fallback on contradiction without weakening evaluator-only-content checks.