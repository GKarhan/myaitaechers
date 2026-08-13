---
name: Knowledge Tree Approved Lesson Gate
description: Phase 1.11 change — KT API only surfaces zero-evidence nodes from approved lessons; historical KN rows preserved regardless of lesson status.
---

## Rule
`GET /api/knowledge-tree/:subjectId` WHERE clause now includes:
`AND (lessons.status = 'approved' OR knowledge_nodes.id IS NOT NULL)`

## Why
Non-approved lessons (draft/needs_review) were previously showing up in every student's Knowledge Tree for zero-evidence nodes. Phase 1.11 gates them: only approved lessons produce `not_started` entries. Students who already have a `knowledge_nodes` row (historical evidence from when the lesson was approved) continue to see their node even if authoring status regresses.

## How to apply
- Any query that reads the KT must respect this gate — don't remove the `OR isNotNull(knowledgeNodesTable.id)` branch.
- The `or` import from drizzle-orm is needed alongside `and`, `eq`, `inArray`, `isNotNull`.
- Zero-evidence state is derived lazily via LEFT JOIN NULL scores → `getMasteryLevelFromScores(null, null, null)` → `"not_started"`. No `knowledge_nodes` row is ever created by initialization — lazy creation only on quiz evidence submission.
