---
name: Pass 1 empty provider output
description: Observed provider behavior and the fail-closed handling required for empty structured Pass 1 responses.
---

For text Pass 1, a provider response with no usable `blocks` is an extraction failure, even when its JSON syntax is valid. It must not be reclassified as a PDF source-scope or title-anchor failure, and it must never continue into Pass 2.

**Why:** During acceptance against a short, server-extracted physical PDF page, the configured DeepSeek provider returned an empty JSON object on the initial request and on the one bounded schema-completion retry. The server source text and context budget were valid. Treating that result as source-scope failure would falsely implicate verified PDF provenance.

**How to apply:** Preserve the distinct `PASS1_EMPTY_EXTRACTION_PRE_VERIFICATION` diagnostic. A future remediation may change the provider's structured-output contract, but must keep immutable server page input, deterministic binding, quarantine rules, and the bounded/no-until-match retry policy.