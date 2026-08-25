---
name: Provider diagnostic safety
description: Safety boundary for provider metadata that is persisted with lesson mapping jobs and review artifacts
---

Persisted provider diagnostics must be an explicit safe schema: bounded status and timing values, fixed model identifiers, allowlisted provider codes and finish reasons, fixed exception categories, and fixed human-readable diagnostic messages. Provider-controlled error messages, response bodies, prompts, source text, exercise text, credentials, and headers must never be persisted.

**Why:** Provider SDK errors and response metadata can contain request bodies or arbitrary upstream text. Regex redaction is not a reliable persistence boundary.

**How to apply:** When adding diagnostics around an external model call, prefer omission or a fixed classification over copying any provider-controlled string; add adversarial tests with prompt/source/exercise and credential markers.