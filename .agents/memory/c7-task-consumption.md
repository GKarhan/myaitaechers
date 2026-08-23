---
name: C7 task consumption
description: Evidence-safe rule for consuming evaluated Phase 2 tasks and retaining legacy compatibility.
---

Every answerable Phase 2 task must have a durable task reference and attempt identity, and must be compare-and-swap reserved before its C3 evidence is recorded. A competing submission that loses the reservation must not write evidence or alter remediation state. If evidence persistence fails, restore the task; if evidence committed before finalization, recover the feedback boundary idempotently. Legacy task records without those identities must fail closed and require restart rather than use compatibility scoring.

**Why:** A model-evaluated or concurrent duplicate submission can otherwise turn partial work into incorrect positive evidence, write duplicate evidence events, or overwrite a terminal remediation outcome.

**How to apply:** When adding a task provenance or evaluation route, ensure activation persists a reference and attempt sequence, route evaluation reserves both atomically, and only then lets C3/C4 processing continue. Make evidence writes idempotent by task identity and do not create an identity-free evaluation fallback.