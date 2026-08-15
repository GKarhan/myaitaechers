---
name: V2-R3 Pedagogical Decision Engine
description: Pure-function decision engine for cognitive-level progression, remediation escalation, and mastery write-through in Phase 2 AI teaching loop.
---

## Rule
`decideNextPedagogicalAction(input) → PedagogicalDecision` in `artifacts/api-server/src/services/pedagogicalDecisionEngine.ts`. Pure function, no DB writes. Called in `chat.ts` after V2-R2 intent router classifies ANSWER.

**Why:** Code owns the cognitive-level gate. AI's `COMPLETE_NODE` is advisory only (`modelSaysComplete`); `decisionSaysComplete` (`mayCompleteMicroNode`) drives the mastery gate.

## DB columns (applied to live DB)
- `lesson_sessions.remediation_step` INT DEFAULT 0 — resets on node advance or new level
- `knowledge_nodes.demonstrated_cognitive_level` TEXT nullable — write-through cache of highest confirmed Bloom level
- `knowledge_nodes.revisit_required` BOOL DEFAULT false — set when budget exhausted

## Key decisions
- `mapErrorFamilyToAction` receives **pre-increment** `remediationStep` (not nextStep). Escalation table is relative to how many attempts have already happened.
- `MAX_REMEDIATION_STEPS = 5`; budget exhausted when `nextStep = currentStep + 1 > 5`
- independence gate: `helpCount <= 1 AND assistanceLevel IN ['none','light']`
- quality gate: MODERATE/STRONG/CONCLUSIVE

## Fire-and-forget gate fix (critical)
knowledge_nodes update is gated on `evtWasEval && (evtQuality !== "NONE" || _decisionHasKNState)` where `_decisionHasKNState = decision.levelConfirmed || decision.revisitRequired`. Without this, `revisit_required` would never write on wrong answers (which always have quality=NONE).

**Why:** Wrong answers always produce quality=NONE. Budget exhaustion fires on wrong answer. The `revisitRequired=true` write must not be gated on evidence quality.

## How to apply
- V2-R3 decision log: `INFO "V2-R3 pedagogical decision"` with `metaAction, remediationAction, reasonCode, newRemediationStep, levelConfirmed, revisitRequired`
- Tests: `pnpm --filter @workspace/api-server test:v2r3` (45 tests T01–T45)
- All prior regression suites (V2-R1: 33, V2-R1.1: 21, V2-R2: 41) must stay green after changes here
