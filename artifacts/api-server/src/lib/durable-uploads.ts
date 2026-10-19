import { pool } from "@workspace/db";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 100 * 1024 * 1024;
export function uploadFilename(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) || value.includes("..")) {
    throw new Error("Invalid upload filename");
  }
  return value;
}
export class UploadedFileMissingError extends Error {
  readonly code = "UPLOADED_FILE_MISSING";
  constructor() { super("Textbook file is missing. Restore the original file in course resources before mapping."); }
}
export async function persistUpload(filename: string, filePath: string, mimeType: string): Promise<void> {
  uploadFilename(filename);
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_BYTES || stat.size === 0) throw new Error("Invalid upload size");
  const data = await fs.readFile(filePath);
  const sha = createHash("sha256").update(data).digest("hex");
  // Immutable names: a retry is safe, but different bytes must never replace a source.
  const result = await pool.query(`INSERT INTO uploaded_files (filename, data, mime_type, sha256)
    VALUES ($1, $2, $3, $4) ON CONFLICT (filename) DO UPDATE
    SET filename = EXCLUDED.filename WHERE uploaded_files.sha256 = EXCLUDED.sha256
    RETURNING filename`, [filename, data, mimeType, sha]);
  if (!result.rowCount) throw new Error("Upload source conflict");
}
export async function readUpload(filename: string): Promise<{ data: Buffer; mimeType: string; sha256: string }> {
  uploadFilename(filename);
  const result = await pool.query<{ data: Buffer; mime_type: string; sha256: string }>(
    "SELECT data, mime_type, sha256 FROM uploaded_files WHERE filename = $1", [filename]);
  const row = result.rows[0];
  if (row) {
    if (createHash("sha256").update(row.data).digest("hex") !== row.sha256) throw new Error("Upload integrity check failed");
    return { data: row.data, mimeType: row.mime_type, sha256: row.sha256 };
  }
  // Migrate surviving legacy uploads on first use; never report success until durable.
  const legacy = path.join(process.cwd(), "uploads", filename);
  try { await fs.access(legacy); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new UploadedFileMissingError();
    throw err;
  }
  await persistUpload(filename, legacy, filename.endsWith(".pdf") ? "application/pdf" : "application/octet-stream");
  return readUpload(filename);
}
export async function materializeUpload(fileUrl: string): Promise<string> {
  const filename = uploadFilename(fileUrl.split("/").pop() ?? "");
  const file = await readUpload(filename);
  const dir = path.join(process.cwd(), "uploads", ".durable-cache");
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${file.sha256}${path.extname(filename)}`);
  // Each materialization is atomic; mapping can safely share an immutable source.
  const temp = `${target}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, file.data, { mode: 0o600 }); await fs.rename(temp, target); }
  finally { await fs.unlink(temp).catch(() => {}); }
  return target;
}

export async function deleteUpload(filename: string): Promise<void> {
  uploadFilename(filename);
  await pool.query("DELETE FROM uploaded_files WHERE filename = $1", [filename]);
  await fs.unlink(path.join(process.cwd(), "uploads", filename)).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  });
}
