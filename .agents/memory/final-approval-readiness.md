---
name: Final approval readiness
description: The readiness policy that closes final approval to student-assignment flow without weakening source or outcome integrity.
---

Final approval has three semantic outcomes: `READY` when no unresolved work remains, `REVIEW_REQUIRED` when only safe findings remain, and `BLOCKED` when a real integrity, source, grounding, or unresolved per-MicroNode pedagogical review remains. `REVIEW_REQUIRED` needs one explicit teacher acceptance at assignment time; it is not silently approved.

**Why:** Teachers need one understandable delivery decision without hiding known gaps. A missing `REQUIRED` Outcome relation may be accepted as a visible review finding, but it must never be fabricated; integrity and source failures still cannot reach learners.

**How to apply:** Treat persisted current Outcome relationships as canonical regardless of a child node's UI approval label. A bounded repair may promote exactly one already-persisted, source-safe, cognitively capable `SUPPORTING` relationship to `REQUIRED`; it must never infer or create a new relationship. Revalidate after that committed repair. Present missing Teaching Content, incomplete or unconfirmed Cognitive Paths, missing `REQUIRED` Outcome coverage, Goal/Outcome review, and other safe warnings together for explicit non-sticky acceptance. Source-alignment, duplicate/atomicity, or unavailable-semantic-review markers require an individual node review before final approval; leave only true failures blocked.