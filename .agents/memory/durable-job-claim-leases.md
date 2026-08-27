---
name: Durable job claim leases
description: Safety rule for recovering background jobs that may outlive an API process.
---

Any durable job that performs slow external work must persist a fresh claim lease for each attempt. Recovery must invalidate the old lease, and progress, failure, and finalization writes must compare against the active lease.

**Why:** A stale worker can remain alive during a restart or overlapping deployment. Status-only checks let that worker fail or finalize a replacement attempt after the job has been reclaimed.

**How to apply:** Rotate the lease when claiming, clear it when re-queuing or reaching a terminal state, and include it in every compare-and-swap update. Keep durable provider errors allowlisted rather than persisting exception text.