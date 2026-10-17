import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { mountMappingPilotUi } from "./mapping-pilot-ui.js";

test("pilot serves teacher deep links and assets without swallowing APIs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mapping-ui-"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><div id='root'></div>");
  writeFileSync(path.join(dir, "app.js"), "window.pilot = true;");
  const app = express();
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  mountMappingPilotUi(app, dir);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const route of ["/", "/login", "/teacher"]) {
      const response = await fetch(base + route, { headers: { Accept: "text/html" } });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /id='root'/);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.deepEqual(await (await fetch(base + "/api/health")).json(), { status: "ok" });
    const missing = await fetch(base + "/api/missing", { headers: { Accept: "text/html" } });
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("content-type")!, /application\/json/);
    assert.equal((await fetch(base + "/app.js")).status, 200);
    assert.equal((await fetch(base + "/missing.js")).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
