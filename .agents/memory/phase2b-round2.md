---
name: Phase 2B — Active-task and evidence invariants
description: Durable rules for task ownership, Phase-2 THEORY delivery, and conservative evidence.
---

## Help and task identity

The server is authoritative for the currently active task and any help attached to it. Help is supportive only: it must not advance teaching, generate learner evidence, or reveal the answer without an explicit confirmation step.

**Why:** Client-supplied task identities and automatic advancement can desynchronize the visible task, learner support, and mastery evidence.

**How to apply:** Preserve the active task through help; reset task-scoped state only when moving to a genuinely new learning node.

## Micro-check activation invariant

Only a response that has passed visible-task validation may create an active micro-check. Feedback-only evaluated answers must leave the session ready for a later teaching/check response, rather than manufacturing an active task from the previous stage.

**Why:** Activating an unseen task leaves the learner unable to answer the task the session claims is open.

**How to apply:** Use the anticipatory delivery path as the sole activation authority. Objective checks need visible choices; constructed responses need a clear answerable question or task.

## Server-owned Phase 2 THEORY envelope

For a Phase 2 session with a current node in THEORY, the server—not the model—owns the final teaching/micro-check envelope. That turn must be non-evaluative before it can deliver a new task.

**Why:** Providers can return structurally valid output with contradictory teaching metadata or answer evaluation before any learner answer exists.

**How to apply:** Canonicalize only the exact Phase 2/current-node/THEORY state after parsing, then keep every content validator active. Reject/retry any output that attempts to score the learner before delivering the task. Do not apply this rule to other phases or stages.

## Class-exercise context detection

Exercise-gated validators must use the same exact-header predicate for current and legacy exercise blocks; never infer exercise presence from generic prompt prose.

**Why:** Prompt instructions can mention exercises even when none exist, while a header mismatch can otherwise allow a required source exercise to be skipped.

**How to apply:** Centralize header detection for both no-exercise exceptions and premature-completion gates. Use the current production header shape in regression cases.

## Evidence cap rule

Micro-check evidence cannot be treated as fully independent when the learner has received heavy assistance.

**Why:** Micro-check tasks are formative; inflating assistance level distorts mastery signals.

**How to apply:** Keep formative evidence conservative whenever assistance is substantial.