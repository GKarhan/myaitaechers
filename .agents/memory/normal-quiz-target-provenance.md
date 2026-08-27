---
name: Normal quiz target provenance
description: Authority and concurrency rules for normal-quiz MicroNode and Cognitive Level provenance.
---

Normal quiz generation must resolve every selected MicroNode through the canonical target authority before any provider call. Question allocation is server-owned and per-node; providers never choose or relabel the MicroNode or Cognitive Level. Difficulty is only secondary complexity within the fixed cognitive operation. Question quality is a separate acceptance authority: the mapped path decides what must be assessed, while a quality review may only pass or fail whether a candidate assesses it.

**Why:** A multi-node provider request lets model-returned IDs misattribute content, and resolving only before a slow provider call lets concurrent authoring persist stale target provenance. A weak Remember question must never be persisted as Apply merely because Apply is the canonical target, but detecting that mismatch must not rewrite or downgrade the curriculum target.

**How to apply:** Generate each normal-quiz node as a single-node/single-target batch. Before persistence, lock selected parent MicroNodes in stable order, re-resolve targets, and compare the complete target snapshot. A future quality gate belongs after provider-output normalization and before persistence; structural and semantic failures must fail closed with bounded codes, never relabel the target. Retest and continuous-session authorities remain separate.