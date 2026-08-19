---
name: Source exercise activation
description: Durable identity, delivery, and typed-answer scoring rule for mapped textbook source exercises.
---

Source exercises have one backend-owned identity: the `lesson_exercises` row selected from the current eligible CLASS exercise set. Persist its internal ID as the active lesson exercise before exposing it as the learner's answerable source task; later delivery must resolve that exact persisted ID.

**Why:** An AI-provided external exercise ID can be invalid or can identify a different eligible exercise than the first list item. Rendering independently from `classExercises[0]` can make the visible exercise and stored answer target diverge.

**How to apply:** Treat `source_fidelity.exercise_id` as an untrusted requested external ID, validate it only within the current eligible set, then use the resolved row for activation and delivery. A missing or ineligible request may fall back only to an actual eligible row; never persist or render the requested ID itself. Keep one visible delivery per activation.

## Deterministic typed-answer scoring

For an active source-exercise task, deterministic scoring may only use the exact persisted lesson-exercise row and its explicit typed-answer metadata. It runs after the structured AI response is available but before session counters, evidence, the decision engine, and progression consume correctness.

**Why:** The model may still supply helpful feedback but cannot be the correctness authority for an objective exercise. Using a model-selected ID, first list item, exercise text, or inferred subject knowledge would recreate the identity mismatch or fabricate an answer key.

**How to apply:** Only compare canonical multiple-choice and true/false tokens when the learner intent is ANSWER, the task provenance is `source_exercise`, and the active ID resolves to valid explicit metadata. Correct typed answers use source-exercise STRONG evidence; mismatches use NONE. Constructed-response, legacy/invalid metadata, and non-canonical learner tokens remain on the existing AI-assisted path.