---
name: Quiz interaction preferences
description: Distinguishes advisory authored format preferences from hard quiz-delivery compatibility checks.
---

`preferredInteractionTypes` expresses authoring preference, not a required allowlist. An unavailable preferred format must not reject a candidate when the actual delivery format is platform-supported and naturally compatible with the canonical Cognitive Level.

**Why:** Current quiz delivery may support fewer formats than Cognitive Path metadata can recommend. Treating preferences as requirements caused every valid multiple-choice candidate to fail and waste bounded provider retries.

**How to apply:** Validate the actual delivery interaction against platform support and the target’s operational contract. Keep canonical identity, deterministic quality, semantic review, and hard target-format incompatibility fail-closed.