---
name: C2 approval readiness
description: Rules for keeping approved MicroNodes aligned with confirmed C2 paths and explicit C1 ceilings.
---

An approved MicroNode must have a canonically accepted, confirmed C2 path. When C1 already specifies a target ceiling, C2 generation must preserve that ceiling exactly and fail closed on drift; it must not invent higher levels.

**Why:** C6 and downstream learning authority depend on accepted C2 provenance, while historical approval could previously outpace C2 generation.

**How to apply:** Reuse the canonical C2 acceptance validator for individual and bulk approval gates. Treat C1 target-ceiling preservation as a generator constraint, not as permission to rewrite or elevate the curriculum target.