---
name: Normal quiz target provenance
description: Authority and concurrency rules for normal-quiz MicroNode and Cognitive Level provenance.
---

Normal quiz generation must resolve every selected MicroNode through the canonical target authority before any provider call. Question allocation is server-owned and per-node; providers never choose or relabel the MicroNode or Cognitive Level. Difficulty is only secondary complexity within the fixed cognitive operation. Question quality is a separate acceptance authority: the mapped path decides what must be assessed, while deterministic and independent semantic review may only pass or fail whether a candidate assesses it.

**Why:** A multi-node provider request lets model-returned IDs misattribute content, and resolving only before a slow provider call lets concurrent authoring persist stale target provenance. A weak Remember question must never be persisted as Apply merely because Apply is the canonical target, but detecting that mismatch must not rewrite or downgrade the curriculum target.

**How to apply:** Generate each normal-quiz node as a single-node/single-target batch. Run deterministic checks before semantic review, retry a transient review once on the same candidate, then regenerate only failed slots with a bounded budget while preserving accepted slots. Require exact counts and target identity again at persistence. Before commit, lock parent MicroNodes, re-resolve targets, and compare the complete snapshot. Fail closed with bounded codes; never relabel. Retest and continuous-session authorities remain separate.