---
name: React Query queryKey requirement
description: Generated useGetXxxById hooks require explicit queryKey in query options alongside enabled, not just enabled alone.
---

## Rule
When using generated `useGetXxxById(id, { query: { ... } })` hooks with only `enabled`,
TypeScript raises TS2741 because `queryKey` is required in the query options type.

**Why:** Orval generates hooks where the `queryKey` field is typed as required (not optional).
The root cause is that the query key type for parametrized hooks is `readonly unknown[]` and
the UseQueryOptions interface forces queryKey to be present.

**How to apply:** Always include both fields:
```ts
useGetHomeworkById(id, {
  query: {
    queryKey: getGetHomeworkByIdQueryKey(id),
    enabled: !!id,
  },
});
```

This pattern applies to all generated `useGetXxxById` hooks (useGetHomeworkById, useGetBook, etc.).
