---
name: Issue translation layer
description: Architecture for translating validator/inserter issueTypes to user-facing strings; 49 issueTypes; [EN-PLACEHOLDER] stubs until Round 1.6.
---

## Rule
The frontend (teacher-dashboard.tsx) MUST call `translateIssue(issue)` — never render `issue.description` directly.

## Architecture
- **Server**: `artifacts/api-server/src/mapping/mapTextTranslations.ts`
  - Exports `ALL_ISSUE_TYPES` (49 strings), `ISSUE_TRANSLATIONS` (Record<string, IssueTranslationFn>), `translateIssue()`
- **Frontend**: `artifacts/myaiteacher/src/lib/issueTranslations.ts`
  - Same shape; imported as `{ translateIssue }` in teacher-dashboard.tsx
- **Rendering path**: `structured error → issueType → ISSUE_TRANSLATIONS[key] → "[EN-PLACEHOLDER] <description>"`
- **Unknown-type fallback**: `"[EN-PLACEHOLDER:UNKNOWN-TYPE:<issueType>] <description>"`

## Round 1.5 state
All 49 templates return `[EN-PLACEHOLDER] ${issue.description}` — the English description is passed through.

## Round 1.6 task
For each issueType, replace the stub body with the exact Armenian string.
Use `issue.entityId`, `issue.line`, and structured params embedded in description for dynamic values.
Do NOT change issueType key strings or function signatures between rounds.

## Test coverage
- **Test F** (`mapTextTranslations.test.ts`): every issueType in ALL_ISSUE_TYPES has a function; no duplicates; no stale entries.
- **Test G** (`mapTextTranslations.test.ts`): translateIssue() returns `[EN-PLACEHOLDER]` prefix for every issueType; unknown type returns UNKNOWN-TYPE sentinel; raw description is never returned as-is.

**Why:** Contract §25 requires Armenian user-facing errors. The layer is the interception point so Round 1.6 only touches the lookup table bodies, not the route or rendering code.

**How to apply:** When adding a new validator issueType: (1) add constant to mapTextErrors.ts, (2) add to ALL_ISSUE_TYPES array, (3) add to ISSUE_TRANSLATIONS with [EN-PLACEHOLDER] stub, (4) add to frontend issueTranslations.ts. Test F will catch any omission.
