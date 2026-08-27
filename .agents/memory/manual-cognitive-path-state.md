---
name: Manual Cognitive Path state
description: Canonical tri-state and refresh rules after teacher-authored Cognitive Path changes.
---

Cognitive Path presentation has three states: zero Cognitive Level rows is missing; one or more rows without canonical confirmation is review-required; only the existing canonical confirmation operation may set confirmed. Every successful level create, edit, delete, reorder, or target change must synchronize the node status from current persisted rows and invalidate confirmation without repairing or auto-confirming the path.

**Why:** Nullable legacy status can lag behind real teacher-authored rows, causing existing paths to be counted as missing. Sorting levels cosmetically by Bloom order can also hide an invalid persisted sequence and make an unconfirmable path appear valid.

**How to apply:** Derive read-model existence from current Cognitive Level rows plus persisted canonical confirmation. Refresh path detail, lesson-node summaries/warnings, and approval readiness after mutations. Display persisted sequence in authoring/review surfaces; keep Bloom ordering only for selectors.