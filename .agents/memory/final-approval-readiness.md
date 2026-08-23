---
name: Final approval readiness
description: The readiness policy that closes final approval to student-assignment flow without weakening source or outcome integrity.
---

Final approval has three semantic outcomes: `READY` when no unresolved work remains, `REVIEW_REQUIRED` when only safe advisory findings or an explicit missing-Teaching-Content decision remains, and `BLOCKED` when a real integrity, source, grounding, or canonical Outcome coverage error remains.

**Why:** A historical automatic-review marker or a per-MicroNode UI state must not force redundant approval work, but accepting an ungrounded Outcome relation would make the later student-assignment state untrustworthy.

**How to apply:** Treat persisted current Outcome relationships as canonical regardless of a child node's UI approval label. A bounded repair may promote exactly one already-persisted, source-safe, cognitively capable `SUPPORTING` relationship to `REQUIRED`; it must never infer or create a new relationship. Revalidate after that committed repair. Keep missing Teaching Content behind the explicit non-sticky override policy, and leave all other missing required relationships blocked for teacher authoring.