---
name: Final approval readiness
description: The readiness policy that closes final approval to student-assignment flow without weakening source or outcome integrity.
---

Lesson assignment has three semantic outcomes: `READY` when no unresolved work remains, `CONFIRMATION_REQUIRED` when only review findings remain, and `BLOCKED` only when assignment is technically or structurally impossible. Strict mapping, source, C1, C2, and content validators keep reporting their own diagnostics, but those labels do not independently decide assignment.

**Why:** Validator diagnostics previously leaked directly into assignment `errors`, so readable unowned source fragments and similar quality findings regressed from teacher-confirmable warnings into hard blockers.

**How to apply:** Route every assignment-facing readiness path through the backend assignment resolver. Its bounded hard-block allowlist covers no usable MicroNodes, corrupt topic/node sequences, and lost source identity/count invariants. All other mapping/source/Cognitive Path/Teaching Content/review findings remain visible warnings requiring one explicit `overrideWarnings` decision. Override never bypasses hard blockers. Preflight remains read-only; accepted warnings are auditable and non-sticky, and bounded Outcome repair may only normalize an existing safe relation.