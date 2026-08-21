---
name: Pass 2 structural diagnostics
description: How to diagnose a Topic-only or zero-MicroNode detailed map without retaining source or provider content.
---

## The rule

When a Pass 2 detailed map has too few or zero MicroNodes, record only structural response metadata at each Topic boundary: allowlisted expected-key presence flags, an unexpected-key count, known array lengths, finish state, retry flag, candidate/accepted/rejected counts, categorized rejection counts, and the post-normalization count. Block persistence if the complete map has zero valid MicroNodes, before deleting the prior map.

**Why:** An empty `microNodes` array can originate from the provider, parsing, safety-net validation, or activity normalization. Raw textbook and provider content is not needed to distinguish those boundaries and must not be retained solely for diagnosis. Source coverage alone can be valid when every block is marked unmapped, so it cannot authorize a detailed map with zero teachable units.

**How to apply:** Keep diagnostics count-only in mapping-job results and mapping reports. First inspect `parserStatus`: `FAILED` identifies the parser boundary; only a `PARSED` response with `candidate=0`, `accepted=0`, and `post-normalization=0` identifies a provider-side empty candidate array. Add a normalizer fix only when that final count drops. Preserve an existing mapping whenever parsing fails or the complete new result has no valid MicroNodes.