---
name: Pass 1 structured output
description: Durable contract for non-empty Pass 1 structured output and safe empty-page handling.
---

Text Pass 1 must use a strict response schema requiring a non-empty `blocks` array, and independently validate that contract locally before normalisation. A generic JSON-object mode is insufficient because it permits empty objects.

**Why:** Provider-side structured-output enforcement can vary by model and gateway. Local validation prevents malformed, unknown-field, or empty output from being silently coerced into valid-looking extraction state.

**How to apply:** Preserve the distinct malformed/schema/empty extraction diagnostics, immutable server page input, deterministic binding, quarantine rules, and one corrective retry. A deterministically empty/non-instructional physical page is a separate pre-Pass-2 outcome, not a provider failure.