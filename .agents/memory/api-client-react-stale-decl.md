---
name: API client React stale declarations
description: lib/api-client-react is a composite TS project; myaiteacher reads compiled dist/*.d.ts, not source. Must rebuild after any changes to api.ts or api.schemas.ts.
---

## Rule
After adding hooks or types to `lib/api-client-react/src/generated/api.ts` or `api.schemas.ts`, run:
```
cd lib/api-client-react && pnpm exec tsc --build
```
before running `pnpm exec tsc --noEmit` in `artifacts/myaiteacher`.

**Why:** `lib/api-client-react/package.json` exports `"./src/index.ts"` for development, but the tsconfig uses `composite:true + emitDeclarationOnly + outDir:dist`. TypeScript in the consuming app resolves via the compiled `.d.ts` files in `dist/`, not the source. Stale `dist/` = "no exported member" errors in the app even though the source is correct.

**How to apply:** Any time you add new hooks (e.g. useCreateLessonTopic) or types (e.g. LessonTopic) to the api-client-react generated files, rebuild before typechecking downstream consumers.

**Important:** When adding a new type to `api.schemas.ts` that is used in `api.ts`, you MUST also add an explicit `import type { NewType }` in `api.ts` — the generated file's import block is not auto-updated.
