// Run against an isolated Neon branch only:
// TEST_DATABASE_URL=... tsx src/lib/__tests__/durable-uploads.test.ts
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import readline from "node:readline";

if (!process.env.TEST_DATABASE_URL || process.env.TEST_DATABASE_URL === process.env.PRODUCTION_DATABASE_URL) {
  throw new Error("An isolated TEST_DATABASE_URL is required");
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { pool } = await import("@workspace/db");
// Optional test-only connector transport when direct Postgres TCP is blocked.
let bridge: readline.Interface | undefined;
if (process.env.SQL_TEST_BRIDGE === "1") {
  bridge = readline.createInterface({ input: process.stdin });
  pool.query = (async (sql: string, params: unknown[] = []) => {
    console.log("SQL_RPC:" + JSON.stringify({ sql, params }));
    const response = await new Promise<string>((resolve) => bridge!.once("line", resolve));
    const result = JSON.parse(response);
    if (result.error) throw new Error(result.error);
    for (const row of result.rows) if (row.data?.type === "Buffer") row.data = Buffer.from(row.data.data);
    return result;
  }) as typeof pool.query;
}
const { persistUpload, readUpload, materializeUpload, uploadFilename, deleteUpload, UploadedFileMissingError } = await import("../durable-uploads.js");

if (process.argv[2] === "--read") {
  const file = await readUpload(process.argv[3]);
  assert.equal(file.sha256, process.argv[4]);
  await pool.end();
} else {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "durable-uploads-"));
  const originalCwd = process.cwd();
  const filename = `${randomUUID()}.pdf`;
  const legacyName = `${randomUUID()}.pdf`;
  const source = path.join(temp, "source.pdf");
  const data = Buffer.from("%PDF-1.7\nprivate test data\u0000\u00ff");
  const sha = createHash("sha256").update(data).digest("hex");
  try {
    process.chdir(temp);
    await fs.writeFile(source, data);
    await persistUpload(filename, source, "application/pdf");
    await persistUpload(filename, source, "application/pdf"); // idempotent
    const query = pool.query;
    pool.query = (async () => { throw new Error("storage offline"); }) as typeof pool.query;
    try { await assert.rejects(persistUpload(filename, source, "application/pdf"), /storage offline/); }
    finally { pool.query = query; }
    await fs.unlink(source); // original ephemeral file is lost
    assert.deepEqual((await readUpload(filename)).data, data);
    const target = await materializeUpload(`/api/teacher/documents/files/${filename}`);
    assert.deepEqual(await fs.readFile(target), data);
    await fs.rm(path.join(temp, "uploads"), { recursive: true });
    const restored = await materializeUpload(filename);
    assert.deepEqual(await fs.readFile(restored), data);
    if (!bridge) {
    const child = spawnSync(process.execPath, ["--import", "tsx", path.join(originalCwd, "src/lib/__tests__/durable-uploads.test.ts"), "--read", filename, sha], {
      cwd: originalCwd, env: process.env, encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    }
    await fs.writeFile(source, Buffer.from("different bytes"));
    await assert.rejects(persistUpload(filename, source, "application/pdf"), /conflict/);
    assert.deepEqual((await readUpload(filename)).data, data);
    await fs.mkdir(path.join(temp, "uploads"), { recursive: true });
    await fs.writeFile(path.join(temp, "uploads", legacyName), data);
    await readUpload(legacyName); // migrate legacy bytes before acknowledging use
    await fs.rm(path.join(temp, "uploads"), { recursive: true });
    assert.deepEqual((await readUpload(legacyName)).data, data);
    await assert.rejects(readUpload(`${randomUUID()}.pdf`), UploadedFileMissingError);
    for (const value of ["../secret", "x/secret", "", "..", "a\\b", "a?b"]) assert.throws(() => uploadFilename(value));
    await pool.query("UPDATE uploaded_files SET data = $1 WHERE filename = $2", [Buffer.from("corrupt"), filename]);
    await assert.rejects(readUpload(filename), /integrity/);
    await deleteUpload(legacyName);
    await assert.rejects(readUpload(legacyName), UploadedFileMissingError);

  } finally {
    await pool.query("DELETE FROM uploaded_files WHERE filename = ANY($1::text[])", [[filename, legacyName]]);
    await pool.end();
    bridge?.close();
    process.chdir(originalCwd);
    await fs.rm(temp, { recursive: true, force: true });
  }
  console.log("PASS: durable bytes, deleted cache, immutable source, legacy migration, missing file, traversal, integrity, deletion, storage failure");
}
