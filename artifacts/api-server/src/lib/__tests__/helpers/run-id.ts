/**
 * Unique Test Run ID
 *
 * Every mutating integration/E2E test suite must generate a runId at startup.
 * All test-created human-readable names/titles include this marker so that:
 *   - forensic traceability is possible
 *   - pre-cleanup can remove stale records from prior crashed runs
 *   - post-pollution gate can verify zero records remain
 *
 * Format: TR_YYYYMMDDTHHMMSS_XXXXXX  (TR = "Test Run")
 *
 * Usage:
 *   import { makeRunId, runTag } from "./helpers/run-id.js";
 *   const RUN_ID = makeRunId();               // "TR_20260814T182000_ab12cd"
 *   const name   = runTag(RUN_ID, "Lesson");  // "TR_20260814T182000_ab12cd_Lesson"
 */

import { randomBytes } from "node:crypto";

export function makeRunId(): string {
  const now  = new Date();
  const ts   = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 15); // YYYYMMDDTHHmmss → 15 chars
  const rand = randomBytes(3).toString("hex"); // 6 hex chars
  return `TR_${ts}_${rand}`;
}

/** Build a namespaced name for a test fixture entity. */
export function runTag(runId: string, label: string): string {
  return `${runId}_${label}`;
}

/**
 * Pattern to match any TR_ test record title.
 * Use with SQL: title LIKE 'TR_%'
 */
export const TR_PATTERN = "TR_%";

/**
 * Returns true if a string looks like a test-run-tagged record.
 * Use to guard pre-cleanup so it never touches real data.
 */
export function isTrRecord(title: string): boolean {
  return /^TR_\d{15}_[0-9a-f]{6}_/.test(title);
}
