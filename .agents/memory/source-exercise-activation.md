---
name: Source exercise activation
description: Durable identity and delivery rule for mapped textbook source exercises.
---

Source exercises have one backend-owned identity: the `lesson_exercises` row selected from the current eligible CLASS exercise set. Persist its internal ID as the active lesson exercise before exposing it as the learner's answerable source task; later delivery must resolve that exact persisted ID.

**Why:** An AI-provided external exercise ID can be invalid or can identify a different eligible exercise than the first list item. Rendering independently from `classExercises[0]` can make the visible exercise and stored answer target diverge.

**How to apply:** Treat `source_fidelity.exercise_id` as an untrusted requested external ID, validate it only within the current eligible set, then use the resolved row for activation and delivery. A missing or ineligible request may fall back only to an actual eligible row; never persist or render the requested ID itself. Keep one visible delivery per activation.