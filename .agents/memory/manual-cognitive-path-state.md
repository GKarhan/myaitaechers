---
name: Manual Cognitive Path state
description: Canonical tri-state and refresh rules after teacher-authored Cognitive Path changes.
---

Cognitive Path presentation has three states: zero Cognitive Level rows is missing; one or more rows without canonical confirmation is review-required; only the existing canonical confirmation operation may set confirmed. Every successful level create, edit, delete, reorder, or target change must synchronize the node status from current persisted rows and invalidate confirmation without auto-confirming the path.

Persisted Cognitive Level order is backend-owned revised Bloom order: remember, understand, apply, analyze, evaluate, create. Normalize only rows that exist into contiguous sequence values; never fill missing intermediate levels or move/invent the target ceiling. Manual and AI persistence share this authority.

**Why:** Nullable legacy status can lag behind real teacher-authored rows, causing existing paths to be counted as missing. Creation-order persistence also allowed equivalent paths to carry different or structurally invalid sequences.

**How to apply:** Derive read-model existence from current rows plus canonical confirmation. Normalize sequences transactionally after mutations, refresh all affected UI, and display backend-returned order without independent frontend sorting.