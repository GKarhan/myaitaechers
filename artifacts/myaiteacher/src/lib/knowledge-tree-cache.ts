import type { QueryClient } from "@tanstack/react-query";

/**
 * C5 has three related read surfaces: subject cards, a subject tree, and a
 * lazy node detail panel. Chat and quiz writes can change any of them.
 */
export function invalidateKnowledgeTreeQueries(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: ({ queryKey }) => {
      const first = queryKey[0];
      return (
        first === "kt-subjects" ||
        first === "node-detail" ||
        first === "knowledge-tree-teacher" ||
        (typeof first === "string" && first.startsWith("/api/knowledge-tree/"))
      );
    },
  });
}