---
name: Pass 1 structured output
description: Durable contract for non-empty Pass 1 structured output and safe empty-page handling.
---

Text Pass 1 must use a strict response schema requiring a non-empty `blocks` array, and independently validate that contract locally before normalisation. A generic JSON-object mode is insufficient because it permits empty objects.

**Why:** Provider-side structured-output enforcement can vary by model and gateway. Local validation prevents malformed, unknown-field, or empty output from being silently coerced into valid-looking extraction state.

**How to apply:** Preserve the distinct malformed/schema/empty extraction diagnostics, immutable server page input, deterministic binding, quarantine rules, and one corrective retry. A deterministically empty/non-instructional physical page is a separate pre-Pass-2 outcome, not a provider failure.

**Model boundary:** Text Pass 1 uses the dedicated OpenRouter model `openai/gpt-5.4-mini`; do not share that selection with unrelated mapping, AI-teacher, quiz, or Phase 2 stages.

**Why:** Textbook extraction needs reliable strict-schema adherence. The previous Pass 1 model produced malformed responses for a readable real page despite a strict schema and bounded retry, while the dedicated model passed the same production synthetic gate and real Pass 1 pages.

**How to apply:** Keep the strict schema and local validator authoritative regardless of model. Any future model change must be isolated to text Pass 1 and pass the bounded production-function synthetic gate before a real mapping run.