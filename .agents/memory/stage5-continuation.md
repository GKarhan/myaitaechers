---
name: Stage 5 continuation
description: Server-owned continuation must stop exactly at a learner-answerable task while retaining bounded AI jobs.
---

Phase 2 continuation is server-owned and may execute only no-input actions until an active, learner-visible task is persisted. THEORY, TASK, EVALUATION, and FEEDBACK remain separate bounded jobs and distinct chat messages; a continuation must never manufacture a learner acknowledgement.

**Why:** Client acknowledgement posts make progression appear learner-driven even when the backend already owns the next action. Combining jobs or advancing past a task risks losing task identity, evidence boundaries, and Stage 4 delivery safety.

**How to apply:** When adding a Phase 2 transition, derive learner-input requirement from authoritative action plus active-task state, reload server state between internal actions, enforce the deterministic cap, and preserve validation/activation before task visibility.