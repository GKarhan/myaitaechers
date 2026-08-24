---
name: Instructional source coverage
description: The safety contract for accepting an AI-generated lesson map when source blocks are structurally placed but may not be taught.
---

Readable instructional source should be owned by a MicroNode. If one remains unassigned after its single targeted repair, preserve it as an unmapped, review-required source block rather than fabricating ownership or discarding safe sibling nodes.

**Why:** A provider can return syntactically valid Topics while silently under-generating MicroNodes. Whole-map rejection loses usable curriculum material, while pretending the source was taught would weaken source fidelity.

**How to apply:** Classify every block using source-safe dispositions. After activity normalization, make at most one bounded repair call per affected Topic. A remaining readable or unreadable unassigned source block stays in the unmapped review audit; it never gains a fabricated MicroNode relation. Invalid/duplicate placement, unresolved activity ownership, unavailable/structurally unusable source, and zero safe mapping candidates still fail before destructive replacement. Automatic Outcome relations require sufficient owned-source support.