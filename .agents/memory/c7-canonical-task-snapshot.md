---
name: C7 canonical task snapshot
description: Rules for preserving the exact displayed task and its evidence identity across mutable sessions, retries, edits, and generated variants.
---

The answer evaluator must use a task snapshot persisted before learner display, not re-read mutable authoring rows. The snapshot carries the exact rendered learner prompt, locked MicroNode/Cognitive Level, task provenance, interaction type, source identity, source-specific success criteria, evaluation contract, attempt identity, and assistance baseline. Evidence may copy only the learner-safe snapshot fields; backend answer keys and source grading criteria remain evaluator-only.

**Why:** teacher edits, generated-task ambiguity, and concurrent retries can otherwise detach C3 evidence from the exact task the learner answered.

**How to apply:** every new answerable source, generated, or micro-check task must create a new reference and snapshot before delivery; constructed-response tasks with `is_micro_check=true` remain `generated_task`, while source verbatim text takes precedence and is preserved byte-for-byte when safe. A retry is a new attempt: replace the reference and snapshot, increment its attempt sequence, reset task-local help state, and link generated retries to their parent task. Any C6-authorized node or level transition must compare the persisted target before updating and clear every active-task field, including the snapshot, so a stale task cannot cross targets.