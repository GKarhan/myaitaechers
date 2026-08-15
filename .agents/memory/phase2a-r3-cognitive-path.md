---
name: Phase 2A R3 Cognitive Path
description: Architecture and contracts for the cognitive path generation + teacher review system built in Phase 2A Round 3.
---

## What was built
- `generateCognitivePath(input: CogPathInput): Promise<CogPathGenerationResult>` in `lesson-mapping.ts`
  - Model: `deepseek/deepseek-v4-flash`, `response_format: json_object`, retry-once
  - Returns `{ nodeId, skipped, skipReason?, levels }` — no `ok` or `error` fields
  - Enforces exactly-one ceiling internally (doesn't throw on bad AI output)
- 6 routes on `POST/GET /lessons/:lessonId/nodes/:nodeId/...`:
  - `GET cognitive-path` — fetch + join tasks + exercise details
  - `POST generate-cognitive-path` — 409 `TEACHER_EDITS_EXIST` if teacher_authored rows present and `force` not set; deletes old, inserts new, syncs `targetBloomLevel`
  - `POST cognitive-levels/:levelId/update` — partial update, clears old ceiling before setting new one, marks `teacher_authored`
  - `DELETE cognitive-levels/:levelId` — cascades tasks
  - `POST cognitive-tasks` — 201 on link
  - `DELETE cognitive-tasks/:taskId` — unlink only

## CogPathInput shape (required fields)
```typescript
{ nodeId, title, learningObjective, theoryContent, blockType,
  subjectName, lessonTitle, topicTitle,
  exercises: Array<{ exerciseId: string; exerciseText: string }>,  // ← exerciseText not exerciseTextVerbatim
  childFriendlyExplanation?, basicExamples?, existingLevels? }
```

## Frontend (teacher-dashboard.tsx / LessonNodesPanel)
- State: `cogPathOpen`, `cogPathData`, `cogPathLoading`, `cogPathGenerating`, `cogPathError`, `cogPathForceNode`, `cogLevelEditId`, `cogLevelEditForm`, `cogLevelSaving`
- Local types `CogTask`, `CogLevel`, `CogPathData` defined inside component (not exported)
- Handlers: `toggleCogPath`, `generateCogPath`, `startEditCogLevel`, `saveCogLevel`, `setCogCeiling`, `deleteCogLevel`, `linkExercise`, `unlinkTask`
- Block inserted after "Add exercise" section in `renderNodeCard`, gated by `cogPathOpen[n.id]`

## Test patterns
- `test:phase2a-r3` uses same mini-runner as R2 (no Node.js built-in test runner)
- AI tests guarded by `RUN_AI_TESTS=1`; 26/30 run unconditionally
- Fixtures: create subject → lesson → 2 nodes → 1 exercise in `setup()`, teardown deletes lesson (cascades)
- R2 T22/T23 are pre-existing test-DB data gaps (test DB lacks physics knowledge_nodes / evidence rows)

## Real-data pilot results (3 nodes)
- Node 1293 (Grammar, 596 chars): remember→understand→🎯apply (3 levels)
- Node 1291 (Grammar, 432 chars): remember→understand→🎯apply (3 levels)
- Node 2021 (Molecules, 168 chars): remember→🎯understand (2 levels) — correctly fewer for thin content

**Why:** Definition/concept nodes with short theory correctly get 2–3 levels, not all 6. The AI respects pedagogical density.
