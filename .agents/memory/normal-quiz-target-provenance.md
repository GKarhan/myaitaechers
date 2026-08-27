---
name: Normal quiz target provenance
description: Authority and concurrency rules for normal-quiz MicroNode and Cognitive Level provenance.
---

Normal quiz generation must resolve every selected MicroNode through the canonical target authority before any provider call. Question allocation is server-owned and per-node; providers never choose or relabel the MicroNode or Cognitive Level. Difficulty is only secondary complexity within the fixed cognitive operation.

**Why:** A multi-node provider request lets model-returned IDs misattribute content, and resolving only before a slow provider call lets concurrent authoring persist stale target provenance.

**How to apply:** Generate each normal-quiz node as a single-node/single-target batch. Before persistence, lock selected parent MicroNodes in stable order, re-resolve targets, and compare the complete target snapshot. Retest and continuous-session authorities remain separate.