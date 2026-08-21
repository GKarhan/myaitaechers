---
name: Instructional source coverage
description: The safety contract for accepting an AI-generated lesson map when source blocks are structurally placed but may not be taught.
---

Readable instructional source must be owned by a MicroNode. Generic placement coverage may count `unmapped` source blocks, but it is not proof that a student can be taught the material.

**Why:** A provider can return syntactically valid Topics while silently under-generating MicroNodes. Replacing the existing map in that state loses usable curriculum material and obscures the source omission.

**How to apply:** Classify every block using source-safe dispositions. Treat only structural headings, visual/supporting material, and unreadable blocks as legitimate non-instructional exceptions. After activity normalization, make at most one bounded repair call per affected Topic. If readable instruction remains unresolved, fail before destructive persistence; retain the prior map and expose only aggregate, source-safe audit data to the teacher. Automatic Outcome relations need a shared subject concept, not just an action verb or generic term, and must be teacher-reviewed before they count toward final approval.