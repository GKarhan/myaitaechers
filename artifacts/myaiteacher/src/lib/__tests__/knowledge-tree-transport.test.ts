import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { customFetch, setBaseUrl } from "@workspace/api-client-react";
import { QueryClient } from "@tanstack/react-query";
import { invalidateKnowledgeTreeQueries } from "../knowledge-tree-cache";

const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; authorization: string | null; credentials: RequestCredentials | undefined }> = [];
globalThis.fetch = (async (input, init) => {
  calls.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization"), credentials: init?.credentials });
  return new Response(JSON.stringify({ subjects: [] }), { headers: { "Content-Type": "application/json" } });
}) as typeof fetch;
try {
  setBaseUrl("https://myaitaechers-api.onrender.com");
  for (const path of ["/api/knowledge-tree/subjects", "/api/knowledge-tree/18", "/api/knowledge-tree/nodes/1"]) {
    await customFetch(path, { headers: { Authorization: "Bearer test-token" }, credentials: "omit" });
  }
  assert.deepEqual(calls.map(c => c.url), [
    "https://myaitaechers-api.onrender.com/api/knowledge-tree/subjects",
    "https://myaitaechers-api.onrender.com/api/knowledge-tree/18",
    "https://myaitaechers-api.onrender.com/api/knowledge-tree/nodes/1",
  ]);
  assert.ok(calls.every(c => c.authorization === "Bearer test-token"));
  assert.ok(calls.every(c => c.credentials === "omit"));
  // Check the real call sites too: a transport-only mock cannot reproduce
  // browser CORS enforcement against the API's wildcard origin policy.
  for (const page of ["knowledge-tree", "kt-subject-select", "node-detail-panel"]) {
    const source = readFileSync(new URL(`../../pages/${page}.tsx`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /credentials:\s*["']include["']/);
    assert.match(source, /credentials:\s*["']omit["']/);
  }
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
