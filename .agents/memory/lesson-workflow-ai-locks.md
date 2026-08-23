---
name: Lesson workflow AI locks
description: Rules for presenting lesson-level Cognitive Path and Teaching Content generation safely.
---

Lesson workflow AI controls must be driven by persisted MicroNode state, not a completed job's summary counts. A completed job may contain candidates requiring review or blocked items rather than usable Teaching Content.

**Why:** A success-looking job result can otherwise invite a teacher to overwrite or rerun AI content by mistake, while obscuring the remaining review work.

**How to apply:** When generated Teaching Content exists, render a non-actionable completion/review state instead of a normal generation shortcut. For partial outcomes, show the real generated/review/blocked distinction and make blocked MicroNodes inspectable through the existing review surface. Final approval locks automatic generation only; it must not disable manual authoring or change C1–C7 authority.