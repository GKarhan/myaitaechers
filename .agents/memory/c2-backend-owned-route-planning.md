---
name: C2 backend-owned route planning
description: Canonical ownership and validation boundary for Cognitive Path route structure.
---

C2 route selection is deterministic and backend-owned: resolve the trusted target, infer only source-backed prerequisites, fix their order and omissions, and require the final target exactly once. The provider may produce pedagogical content only for that fixed route. Reject any response that changes route membership, declared level, order, sequence, or target position before content semantics or persistence.

**Why:** A content-generation provider cannot be trusted to own curricular route selection; otherwise it can introduce redundant or overreaching levels that downstream validators correctly hold for review.

**How to apply:** Freeze one route plan per generation attempt ledger and reuse it for every retry. Preserve existing grounding, target-demand, objective, progression, and persistence checks; diagnostics may record only bounded plan classifications and reason codes.