---
name: Verified source subset continuation
description: Safe continuation policy when only part of Pass 1 provider output can be grounded in selected PDF pages.
---

When deterministic text binding leaves one or more provider-generated Pass 1 blocks without unambiguous server-backed physical-page provenance, quarantine those candidates instead of failing the whole mapping immediately. Pass 2 may receive only the verified subset; no quarantined text, source quote, exercise, or provider payload may be persisted as mapping source.

**Why:** A single ungrounded provider candidate must never become curriculum evidence, but rejecting all otherwise verified content prevents the existing coverage, direct-support, duplicate, and outcome gates from evaluating a usable source subset.

**How to apply:** Retain count-only quarantine diagnostics (counts, fixed reason codes, and structural ordinals/page context only). Fail before Pass 2 if zero blocks verify. Treat the verified subset as the Pass 2 index universe, and retain all existing downstream C1 persistence gates without relaxation.