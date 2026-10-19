# Durable uploads: pilot deployment and recovery

The Render uploads directory is ephemeral. Course resources, class documents and book uploads now save their bytes to private PostgreSQL `uploaded_files` before reporting success. Existing resource URLs remain unchanged. PDF text and vision mapping materialize an integrity-checked copy from durable storage; local files are only a cache. No textbook contents belong in Git.

## Rollout

1. Apply `lib/db/migrations/0014_durable_uploaded_files.sql` on an isolated database branch first. Run the durable upload test with its `TEST_DATABASE_URL` and build both apps.
2. Obtain approval for the additive production schema change if the active session restricts production DB writes. Apply this exact migration before deploying the backend. It creates one table and does not alter lessons, outcomes or maps. There is no automatic startup DDL.
3. Deploy the backend and frontend together. Older surviving local files migrate on first read. Files already lost cannot be reconstructed from metadata.
4. In the existing course resource, click download. If missing, use **Restore original file** to select the exact originally uploaded PDF. The endpoint requires the owner, matching saved filename and size, and a missing original. It preserves resource ID, URL, lesson links and all lesson data. It refuses to overwrite surviving files. For pre-checksum uploads, name and size cannot prove byte identity; the teacher must supply the original source.
5. Download and compare SHA-256 to the original. Redeploy the backend, download again and verify the same SHA-256. Only then retry mapping once. This verifies persistence, not mapping quality or AI authentication.

## Verification

From `artifacts/api-server`: `TEST_DATABASE_URL=... node --import tsx src/lib/__tests__/durable-uploads.test.ts`.
The test writes UUID-named fixtures only and removes them. It checks durable bytes after original/cache deletion, a fresh process read (direct DB mode), immutable filenames, legacy migration, missing-file errors, traversal, SHA-256 corruption detection, deletion and storage failure. `SQL_TEST_BRIDGE=1` provides a test-only transport for connector-based SQL execution where TCP is unavailable; it omits the fresh-process test. It is not used by the application.

Production snapshot on 2026-10-19: lesson 816 references resource 26, URL `/api/teacher/documents/files/1792410414342-469419948.pdf`, original PDF size 14,290,789 bytes. The privately supplied Physics 7 PDF has the same size. No historical hash exists, so this is not cryptographic identity proof.

## Limits and rollback

This is a bounded pilot storage backend, retaining the existing 100 MB maximum. Large concurrent uploads and repeated large reads use database storage, egress and application memory. Move the storage adapter to private object storage before scaling; do not promise zero infrastructure cost. No new paid service is provisioned by this patch.

Explicit resource/document deletion removes durable bytes. Deleting an entire parent course/class or a book may leave unreferenced private blobs; a retention/garbage-collection policy remains open. Materialized hash-named files are disposable and not public. Teacher download access is checked against the owning resource/document. Student file-sharing policy is outside this patch.

Rollback code without dropping the new table. The previous code cannot recover files from the durable table, so rollback does not itself preserve download functionality after a restart. Do not delete the table or re-create resources as a recovery technique.
