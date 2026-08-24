---
name: Manual Map Contract v1.2
description: TEXT-format deterministic lesson mapping pipeline — parser, validator, inserter, route, UI
---

## Architecture

POST /api/lessons/:lessonId/manual-map now routes on `format` field:
- `format: "text"` (or auto-detect: body starts with "LESSON") → `handleTextImport` → parseMappingText → validateParsedMapping → dryRun? preview JSON : insertParsedMapping in db.transaction()
- `format: "json"` or auto-detect fallback → `handleLegacyJsonImport` (LEGACY, do not add features)

**Why:** Contract v1.2 replaces the "paste AI JSON" flow with a fully deterministic TEXT format. Zero AI in the new path.

## Key implementation files
- `artifacts/api-server/src/mapping/mapTextTypes.ts` — interfaces, enums, BLOCK_TYPES const
- `artifacts/api-server/src/mapping/mapTextParser.ts` — `parseMappingText(text)` state-machine parser
- `artifacts/api-server/src/mapping/mapTextValidator.ts` — `validateParsedMapping(parsed, pagesFrom, pagesTo)`
- `artifacts/api-server/src/mapping/mapTextInserter.ts` — `insertParsedMapping(...)` db.transaction REPLACE
- `artifacts/api-server/src/mapping/mapTextErrors.ts` — error/warning code constants
- Tests: `src/mapping/__tests__/mapTextParser.test.ts` — 22 cases, run with `pnpm run test`

## dryRun contract
- `dryRun=true`: parse + validate + return preview JSON (counts, errors, warnings). Zero DB writes.
- `dryRun=false`: re-parse + re-validate + db.transaction REPLACE (delete all existing mapping data for lesson, insert fresh). Stale preview cannot be committed — always re-validates.

## Visual authoring policy
The normal teacher-facing manual flow is an incremental visual editor over the
canonical Topic → MicroNode → exercise → Cognitive Path → Teaching Content
records. It saves the individual records through their existing CRUD routes,
so incomplete drafts remain valid and never trigger mapping replacement, AI
generation, or atomicity repair.

**Why:** Teachers need a safe fallback for Automatic Mapping without learning
the text contract or overwriting an existing map. The text contract remains
valuable for controlled bulk imports, but `dryRun=false` deliberately replaces
the mapping and is not the everyday authoring interface.

**How to apply:** Keep the visual editor on canonical CRUD endpoints. Retain
`POST /api/lessons/:lessonId/manual-map` and its TEXT pipeline as a
compatibility/bulk-import backend path; do not route normal editor saves
through it.

## UNREADABLE rule
Any MICRONODE referencing a source block where `readable: false` → validation ERROR. No UNREADABLE content may enter the KB.

## relatedMicroNodes routing
- MICRONODE `relatedMicroNodes[]` → `mapping_review_items` (no `relatedNodeId` column on `lesson_nodes`)
- Exercise `relatedMicroNodes[0]` → `lesson_exercises.relatedNodeId` FK (that column exists)

## How to apply
When adding features to manual mapping, ONLY touch `handleTextImport` and the mapping/ modules. `handleLegacyJsonImport` is frozen.
