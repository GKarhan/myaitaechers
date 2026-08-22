---
name: V2-R3 Pedagogical Decision Engine
description: Pure-function decision engine for session-local cognitive progression and remediation escalation in the Phase 2 AI teaching loop.
---

## Rule
`decideNextPedagogicalAction(input) → PedagogicalDecision` in `artifacts/api-server/src/services/pedagogicalDecisionEngine.ts`. Pure function, no DB writes. Called in `chat.ts` after V2-R2 intent router classifies ANSWER.

**Why:** Code owns the cognitive-level gate. AI's `COMPLETE_NODE` is advisory only (`modelSaysComplete`); `decisionSaysComplete` (`mayCompleteMicroNode`) drives the mastery gate.

## DB columns (applied to live DB)
- `lesson_sessions.remediation_step` INT DEFAULT 0 — resets on node advance or new level
- `knowledge_nodes.demonstrated_cognitive_level` TEXT nullable — compatibility snapshot; it is not a canonical C4 ceiling
- `knowledge_nodes.revisit_required` BOOL DEFAULT false — set when budget exhausted

## Key decisions
- `mapErrorFamilyToAction` receives **pre-increment** `remediationStep` (not nextStep). Escalation table is relative to how many attempts have already happened.
- `MAX_REMEDIATION_STEPS = 5`; budget exhausted when `nextStep = currentStep + 1 > 5`
- independence gate: `helpCount <= 1 AND assistanceLevel IN ['none','light']`
- quality gate: MODERATE/STRONG/CONCLUSIVE

## Durable-state boundary
The decision engine still supplies session-local `revisitRequired` guidance, including on quality=NONE turns. It must not independently promote a durable demonstrated ceiling: C4 evidence projection owns that state. Revisit requests must be serialized with C4 projection so target confirmation cannot be overwritten by a concurrent remediation or time-limit update.

**Why:** Session-local teaching flow may advance based on a current turn, but durable cognitive proof requires the separate C3/C2 contract. Concurrent state writers could otherwise restore a revisit marker after durable target confirmation.

## How to apply
- V2-R3 decision log: `INFO "V2-R3 pedagogical decision"` with `metaAction, remediationAction, reasonCode, newRemediationStep, levelConfirmed, revisitRequired`
- Tests: `pnpm --filter @workspace/api-server test:v2r3`
- All prior regression suites (V2-R1: 33, V2-R1.1: 21, V2-R2: 41) must stay green after changes here
