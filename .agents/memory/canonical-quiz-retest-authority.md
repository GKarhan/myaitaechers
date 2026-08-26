---
name: Canonical quiz retest authority
description: Authoritative state and scope rules for future Test 2.0 retest stages.
---

Retest eligibility must use the learner's current canonical C5 state, limited to unique valid MicroNodes snapshotted in the selected completed attempt's persisted answers. Results-page fallbacks, raw quiz percentages, current quiz-question rows, and asynchronous materialized mastery state are display/supporting data only.

**Why:** Quiz results and materialized scores can temporarily or semantically differ from the C3 → C4 → C5 Knowledge Tree projection. Allowing either to select retest content would create two competing learner-state authorities.

**How to apply:** Future retest UI and quiz-generation stages should send only a completed attempt identity plus a bounded strategy. The server derives node scope from answer-time node snapshots, resolves current C5, excludes MASTERED/NOT_STUDIED/unresolved nodes, and never accepts client-selected eligibility IDs. Results UI must wait for both allowlisted strategy responses, fail closed without Results-derived counts, and keep strategy selection local/non-destructive until a separate generation stage exists.