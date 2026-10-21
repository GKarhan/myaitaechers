import assert from "node:assert/strict";
import { customFetch, setBaseUrl } from "@workspace/api-client-react";
import { QueryClient } from "@tanstack/react-query";
import { invalidateKnowledgeTreeQueries } from "../knowledge-tree-cache";

const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; authorization: string | null }> = [];
globalThis.fetch = (async (input, init) => {
  calls.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") });
  return new Response(JSON.stringify({ subjects: [] }), { headers: { "Content-Type": "application/json" } });
}) as typeof fetch;
try {
  setBaseUrl("https://myaitaechers-api.onrender.com");
  for (const path of ["/api/knowledge-tree/subjects", "/api/knowledge-tree/18", "/api/knowledge-tree/nodes/1"]) {
    await customFetch(path, { headers: { Authorization: "Bearer test-token" } });
  }
  assert.deepEqual(calls.map(c => c.url), [
    "https://myaitaechers-api.onrender.com/api/knowledge-tree/subjects",
    "https://myaitaechers-api.onrender.com/api/knowledge-tree/18",
    "https://myaitaechers-api.onrender.com/api/knowledge-tree/nodes/1",
  ]);
  assert.ok(calls.every(c => c.authorization === "Bearer test-token"));
} finally {
  globalThis.fetch = originalFetch;
  setBaseUrl(null);
}
const client = new QueryClient();
const keys = [["kt-subjects"], ["/api/knowledge-tree/18"], ["knowledge-tree-teacher", 18, 93], ["node-detail", 1]];
for (const key of keys) client.setQueryData(key, {});
client.setQueryData(["unrelated"], {});
await invalidateKnowledgeTreeQueries(client);
assert.ok(keys.every(key => client.getQueryState(key)?.isInvalidated));
assert.equal(client.getQueryState(["unrelated"])?.isInvalidated, false);
client.clear();
console.log("PASS all tree surfaces use Render with bearer auth; quiz/chat invalidation refreshes every tree surface");
