---
name: Canonical quiz retest authority
description: Authoritative state and scope rules for future Test 2.0 retest stages.
---

Retest eligibility must use the learner's current canonical C5 state, limited to unique valid MicroNodes snapshotted in the selected completed attempt's persisted answers. Results-page fallbacks, raw quiz percentages, current quiz-question rows, and asynchronous materialized mastery state are display/supporting data only.

**Why:** Quiz results and materialized scores can temporarily or semantically differ from the C3 → C4 → C5 Knowledge Tree projection. Allowing either to select retest content would create two competing learner-state authorities.

**How to apply:** Retest UI and generation may send only a completed attempt identity plus a bounded strategy. The server derives node scope from answer-time node snapshots, resolves current C5, excludes MASTERED/NOT_STUDIED/unresolved nodes, and never accepts client-selected eligibility IDs. Results must fail closed without canonical counts. Creation produces an immutable child quiz and learner assignment with source-attempt/strategy lineage, persists atomically, reuses the existing quiz engine/configuration, and must converge duplicate requests on one committed retest. Empty recomputed eligibility is a normal no-creation outcome. Adaptive multi-round behavior remains a separate phase.