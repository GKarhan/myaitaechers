---
name: Quiz evidence pipeline
description: How quiz submit feeds knowledge_nodes scoring — schema FK, backfill script, fire-and-forget pattern, and key design choices.
---

## Rule
`knowledge_nodes` has a nullable `lessonNodeId FK → lesson_nodes.id (onDelete: set null)`.
Quiz submit fires `evidence_events` keyed by `lessonNodeId`, not `topicName`.
The fire-and-forget block in `POST /quizzes/:id/submit` runs AFTER `res.json()` and mirrors chat.ts exactly.

**Why:** Using `lessonNodeId` as the find-or-create key makes nodes stable across sessions and prevents
duplicate KN rows for the same topic under different generated names.

## How to apply
- Find-or-create `knowledge_nodes` WHERE `(subjectId, userId, lessonNodeId)` — never by topicName alone for quiz-sourced evidence.
- `metadata.source = "quiz"` is the marker distinguishing quiz events from chat events in evidence_events.
- `scripts` package must list `drizzle-orm: "catalog:"` as a direct dep if it uses any drizzle ORM helpers directly.

## Backfill note
`scripts/src/backfill-knowledge-node-ids.ts` matched 7/22 existing rows.
15 unmatched rows have topicNames generated dynamically by the AI tutor (not matching exact `lesson_nodes.title`).
Those rows remain with `lessonNodeId = null` and continue to work via the topicName-keyed chat.ts flow.

## API URL
Dev domain proxy path: `https://$REPLIT_DEV_DOMAIN/api` → maps to the api-server service.
Auth login: `POST /api/auth/login` (NOT `/api/api/auth/login`).
