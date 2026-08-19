---
name: Exercise content boundary
description: Durable policy separating source material, learner task text, evaluator criteria, and deterministic answer metadata.
---

Only text resolved by the learner-content boundary may reach student APIs, source-task activation/delivery, or constructed-response evaluation. Prefer reviewed learner text; historical verbatim text is a compatibility fallback only after it independently passes the same validation. Never expose success criteria, rubrics, or deterministic answer keys in learner projections or feedback.

**Why:** Existing exercise rows mixed learner instructions with explicit answers and evaluator guidance. Source preservation alone does not make source text safe for learner delivery, and rewriting historical rows automatically would destroy provenance.

**How to apply:** Keep source/verbatim, learner-facing, evaluator-criteria, and deterministic-answer fields independent. Validate before activation or approval, fail closed on leaks, preserve deterministic objective scoring, and classify legacy rows for human review instead of blindly rewriting them.