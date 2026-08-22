---
name: C4 trustworthy learner ceiling
description: Boundary between auditable C3 evidence, the canonical learner cognitive ceiling, and the session-local teaching engine.
---

## Rule
The durable learner cognitive ceiling is a canonical Cognitive Level ID, calculated as the highest contiguous accepted C2 path prefix supported by C3-qualified, correct, permitted-quality, independent evidence with distinct stable task references. It is monotonic: later failure, remediation, or lower-level evidence cannot lower it.

The legacy Bloom text snapshot remains compatibility data only. It must never establish, order, block, or be emitted as a C4 ceiling without the canonical ID.

**Why:** Historical and null-annotated evidence was kept for compatibility and legacy scoring, but it is not trustworthy enough to prove a demonstrated cognitive level. C4 must stay auditable and avoid inferred promotion from stale text.

**How to apply:** Route every durable Chat and Quiz projection through the one shared projector after canonical evidence persistence. Any revisit-state request that can race a projection must go through that same locked operation; target confirmation clears revisit state, while session-time-limit requests preserve an already-set remediation reason. Keep mastery, Knowledge Tree, personalization, and AI prompt behavior out of this boundary.