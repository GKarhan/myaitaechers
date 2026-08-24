---
name: Atomicity verification recovery
description: The hard persistence boundary for technical Pass 2B interruptions versus confirmed non-atomic mapping candidates.
---

Atomicity verification has three distinct terminal states: a completed atomic candidate may persist; an unresolved non-atomic candidate after the single repair pass must remain unpersisted; and a technical review interruption gets exactly one verification-only retry against the existing in-memory candidate. Technical failure is never evidence that content is non-atomic, and rejected provider repair actions are not themselves technical outages.

**Why:** A server-rejected repair was previously collapsed into a generic review-unavailable error, losing the real cause and preventing clear teacher guidance. Conversely, persisting a candidate whose unresolved findings prove it remains too broad would weaken the one-objective-per-MicroNode authority.

**How to apply:** Preserve the one repair-pass ceiling. Record request, response, parsing, repair, retry, validation, terminal failure, and persistence eligibility as separate diagnostics. Do not regenerate source extraction or initial MicroNodes for a technical verification retry, and do not expose internal diagnostic codes in the primary teacher message.