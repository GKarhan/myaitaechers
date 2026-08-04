---
name: DB declaration stale cache
description: lib/db is a composite TS project; api-server reads compiled .d.ts files from lib/db/dist, not source. Schema changes require rebuilding declarations before typechecking api-server.
---

## Rule
After ANY change to `lib/db/src/schema/**`, run:
```
cd lib/db && pnpm exec tsc --build
```
BEFORE running `pnpm exec tsc --noEmit` in `artifacts/api-server`.

**Why:** `lib/db/tsconfig.json` has `composite: true` and `emitDeclarationOnly: true`. The api-server `tsconfig.json` lists `lib/db` as a project reference and resolves types from `lib/db/dist/*.d.ts`, not the TS source. If the `.d.ts` files are stale, new columns/types won't be visible and the typecheck reports "Property X does not exist" even though the source is correct.

**How to apply:** Clear stale `.tsbuildinfo` with `rm -f lib/db/tsconfig.tsbuildinfo artifacts/api-server/.tsbuildinfo` if the incremental build doesn't pick up the change, then run `tsc --build` in lib/db.
