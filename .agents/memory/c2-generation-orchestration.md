---
name: C2 generation orchestration
description: Durable C2 attempt records, concurrency claims, and safe per-node replacement without a schema migration.
---

Use the existing lesson mapping-job result JSON as the durable C2 attempt ledger instead of adding a new attempt table. A lesson-wide run must record every selected MicroNode once, reserve only nodes that are not already claimed by another active C2 job, and retain conflicting nodes as visible in-progress entries while continuing unrelated work.

**Why:** C2 provider calls are independent per MicroNode. A same-node guard must stop duplicate calls without turning one in-progress node into a failure for the rest of a lesson. New C2 output must also never overwrite a path a teacher changed while the provider was running.

**How to apply:** Keep path replacement inside a node-row transaction. Re-read the confirmation state and a stable path fingerprint after acquiring the lock; normal fills must preserve any newly present path, while forced replacement must reject a path changed since its explicit request. Store safe reason codes and counts, never raw provider responses or reasoning.