---
name: Exercise content boundary
description: Durable policy separating source material, learner task text, evaluator criteria, and deterministic answer metadata.
---

Only persisted, validated learner text may reach student APIs, source-task activation/delivery, HELP, or constructed-response evaluation. A historical verbatim fallback may be validated for teacher review but is not learner-deliverable until a teacher-approved learner representation exists. Never expose success criteria, rubrics, or deterministic answer keys in learner projections or feedback.

**Why:** Existing exercise rows mixed learner instructions with explicit answers and evaluator guidance. Source preservation alone does not make source text safe for learner delivery, and rewriting historical rows automatically would destroy provenance.

**How to apply:** Keep source/verbatim, learner-facing, evaluator-criteria, and deterministic-answer fields independent. Validate before activation or approval, require persisted learner text at every delivery boundary, preserve deterministic objective scoring, and classify legacy rows for human review instead of blindly rewriting them.

For existing rows, allow automatic remediation only when an exact, independently persisted hidden field is an unambiguous labeled segment of the learner text. Restrict the operation to the audited row and field, use one transaction with post-write validation, and leave all missing evaluation/provenance judgments to human review.

**Why:** A generic split or sanitization can silently destroy source fidelity or invent an editorial decision; exact field-level evidence can safely repair a disclosure without either risk.

**How to apply:** Generate and preserve a dry-run before writes. Do not turn a safe legacy fallback into persisted learner text merely because it passes a mechanical check—teacher approval is still required.