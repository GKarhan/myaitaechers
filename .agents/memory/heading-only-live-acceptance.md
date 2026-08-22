---
name: Heading-only live acceptance
description: Live C1 mappings can produce a structural-heading-only MicroNode despite earlier repairs.
---

Do not accept or retry a mapping when a final MicroNode owns only a structural heading. Preserve the existing mapping and report the source-safe alignment diagnostic (stable node identity, objective, source indices/pages, classifier reason, and repair disposition).

**Why:** A provider may label a heading as a definition or attach an otherwise plausible objective to it. That does not make the heading instructional evidence, and a second identical run can repeat the same unsupported ownership.

**How to apply:** Keep the `HEADING_ONLY` classifier fail-closed. Before any future correction, use the safe diagnostic to determine whether the correct action is removing the node, moving a verified same-topic direct source without breaking its donor, or changing the generation contract; never infer or fabricate supporting source text.