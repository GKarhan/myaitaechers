---
name: Independent lesson enrichment
description: Safety boundary between Teaching Content generation, Cognitive Paths, and concurrent teacher edits.
---

Teaching Content generation must be independent of Cognitive Path creation or confirmation. It may use an already confirmed Cognitive Path only as optional prompt calibration; C1/source preflight and all final-approval delivery gates remain mandatory.

**Why:** Teachers need to create source-grounded teaching support without being forced through an unrelated C2 authoring sequence, while C2 remains authoritative for canonical learner delivery.

**How to apply:** Do not add a C2 generation prerequisite to Teaching Content routes or UI. Keep source/C1 failures as hard blocks and do not allow generated content alone to approve a MicroNode or lesson.

Normal Teaching Content generation is fill-only against the row state at persistence time, not a job-start snapshot.

**Why:** A teacher can edit a partially complete node while an AI job is running; stale model output must never overwrite that teacher work.

**How to apply:** Lock and re-read the persisted Teaching Content fields inside the write transaction, then update only fields still blank. Complete fields must make normal generation a no-op.