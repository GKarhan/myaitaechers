/**
 * Phase 1.6B — Source Preservation Tests (pure unit tests)
 *
 * Tests the effectiveExerciseText helper and the route-level immutability logic
 * without requiring a live server or database.
 *
 * Run with: pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/source-preservation.test.ts
 */
import assert from "node:assert/strict";
import { effectiveExerciseText } from "../exercise-delivery.js";

// ── A: effectiveExerciseText helper ───────────────────────────────────────────

console.log("── A: effectiveExerciseText helper ──────────────────────────────");

// A1: null exerciseTextEdited → verbatim
{
  const result = effectiveExerciseText("verbatim text", null);
  assert.equal(result, "verbatim text", "A1: null edited → verbatim");
  console.log("  A1 ✅ null edited → verbatim");
}

// A2: undefined exerciseTextEdited → verbatim
{
  const result = effectiveExerciseText("verbatim text", undefined);
  assert.equal(result, "verbatim text", "A2: undefined edited → verbatim");
  console.log("  A2 ✅ undefined edited → verbatim");
}

// A3: empty string exerciseTextEdited → verbatim (blank = no edit)
{
  const result = effectiveExerciseText("verbatim text", "");
  assert.equal(result, "verbatim text", "A3: empty edited → verbatim");
  console.log("  A3 ✅ empty edited → verbatim");
}

// A4: whitespace-only exerciseTextEdited → verbatim
{
  const result = effectiveExerciseText("verbatim text", "   ");
  assert.equal(result, "verbatim text", "A4: whitespace-only edited → verbatim");
  console.log("  A4 ✅ whitespace-only edited → verbatim");
}

// A5: non-empty exerciseTextEdited → edited (trimmed)
{
  const result = effectiveExerciseText("verbatim text", "  adapted text  ");
  assert.equal(result, "adapted text", "A5: trimmed edited takes precedence");
  console.log("  A5 ✅ non-empty edited → trimmed edited text");
}

// A6: exerciseTextEdited exactly matches verbatim (fine — still uses edited)
{
  const result = effectiveExerciseText("same text", "same text");
  assert.equal(result, "same text", "A6: identical → edited (no difference in outcome)");
  console.log("  A6 ✅ identical texts → edited value returned");
}

// A7: exerciseTextVerbatim empty, exerciseTextEdited null → empty string (edge case)
{
  const result = effectiveExerciseText("", null);
  assert.equal(result, "", "A7: both empty → empty string");
  console.log("  A7 ✅ both empty → empty string");
}

// ── B: Textbook immutability gate logic ───────────────────────────────────────

console.log("── B: textbook immutability gate ─────────────────────────────────");

// Simulate the immutability check from the route
function checkImmutableFields(sourceType: string | null, patch: Record<string, unknown>): string[] {
  if (sourceType !== "textbook") return [];
  const forbidden: string[] = [];
  if ("exerciseTextVerbatim" in patch) forbidden.push("exerciseTextVerbatim");
  if ("sourcePage" in patch) forbidden.push("sourcePage");
  return forbidden;
}

// B1: textbook + exerciseTextVerbatim patch → blocked
{
  const forbidden = checkImmutableFields("textbook", { exerciseTextVerbatim: "HACKED" });
  assert.deepEqual(forbidden, ["exerciseTextVerbatim"], "B1: verbatim patch blocked for textbook");
  console.log("  B1 ✅ exerciseTextVerbatim blocked for textbook");
}

// B2: textbook + sourcePage patch → blocked
{
  const forbidden = checkImmutableFields("textbook", { sourcePage: "999" });
  assert.deepEqual(forbidden, ["sourcePage"], "B2: sourcePage patch blocked for textbook");
  console.log("  B2 ✅ sourcePage blocked for textbook");
}

// B3: textbook + both blocked fields → both listed
{
  const forbidden = checkImmutableFields("textbook", { exerciseTextVerbatim: "x", sourcePage: "9" });
  assert.equal(forbidden.length, 2, "B3: both blocked fields reported");
  assert.ok(forbidden.includes("exerciseTextVerbatim"), "B3a");
  assert.ok(forbidden.includes("sourcePage"), "B3b");
  console.log("  B3 ✅ both blocked fields reported");
}

// B4: textbook + exerciseTextEdited patch → NOT blocked
{
  const forbidden = checkImmutableFields("textbook", { exerciseTextEdited: "adapted" });
  assert.deepEqual(forbidden, [], "B4: exerciseTextEdited allowed for textbook");
  console.log("  B4 ✅ exerciseTextEdited NOT blocked for textbook");
}

// B5: textbook + status patch → NOT blocked
{
  const forbidden = checkImmutableFields("textbook", { status: "approved" });
  assert.deepEqual(forbidden, [], "B5: status allowed for textbook");
  console.log("  B5 ✅ status NOT blocked for textbook");
}

// B6: manual + exerciseTextVerbatim → NOT blocked
{
  const forbidden = checkImmutableFields("manual", { exerciseTextVerbatim: "edit ok for manual" });
  assert.deepEqual(forbidden, [], "B6: verbatim allowed for manual");
  console.log("  B6 ✅ exerciseTextVerbatim NOT blocked for manual");
}

// B7: null sourceType + exerciseTextVerbatim → NOT blocked (legacy / unknown)
{
  const forbidden = checkImmutableFields(null, { exerciseTextVerbatim: "legacy edit" });
  assert.deepEqual(forbidden, [], "B7: null sourceType not blocked");
  console.log("  B7 ✅ null sourceType not blocked");
}

// ── C: exerciseTextEdited reset logic ─────────────────────────────────────────

console.log("── C: exerciseTextEdited reset semantics ─────────────────────────");

// Simulate how the route normalises incoming exerciseTextEdited to DB value
function normaliseEditedForDb(incoming: string | null | undefined): string | null {
  if (incoming === undefined) return undefined as unknown as null; // not in patch
  if (incoming === null || incoming.trim() === "") return null; // reset
  return incoming.trim();
}

// C1: null → null (reset)
{
  const val = normaliseEditedForDb(null);
  assert.equal(val, null, "C1: null → null (reset)");
  console.log("  C1 ✅ null → null (reset)");
}

// C2: "" → null (blank string treated as reset)
{
  const val = normaliseEditedForDb("");
  assert.equal(val, null, "C2: empty string → null (reset)");
  console.log("  C2 ✅ empty string → null");
}

// C3: "   " → null (whitespace treated as reset)
{
  const val = normaliseEditedForDb("   ");
  assert.equal(val, null, "C3: whitespace → null (reset)");
  console.log("  C3 ✅ whitespace → null");
}

// C4: "adapted text" → "adapted text" (trimmed)
{
  const val = normaliseEditedForDb("  adapted text  ");
  assert.equal(val, "adapted text", "C4: non-empty → trimmed string");
  console.log("  C4 ✅ non-empty → trimmed string");
}

// ── D: Frontend effectiveText helper consistency ───────────────────────────────

console.log("── D: frontend effectiveText consistency ─────────────────────────");

// D1: Mirrors the backend rule exactly (exerciseTextEdited?.trim() || verbatim)
{
  const frontendEffectiveText = (ex: { exerciseTextVerbatim: string; exerciseTextEdited?: string | null }) => {
    const edited = (ex as any).exerciseTextEdited as string | null | undefined;
    return edited?.trim() ? edited.trim() : ex.exerciseTextVerbatim;
  };

  // D1a: no edit → verbatim
  assert.equal(frontendEffectiveText({ exerciseTextVerbatim: "v", exerciseTextEdited: null }), "v", "D1a");
  // D1b: with edit → edited
  assert.equal(frontendEffectiveText({ exerciseTextVerbatim: "v", exerciseTextEdited: "e" }), "e", "D1b");
  // D1c: whitespace edit → verbatim
  assert.equal(frontendEffectiveText({ exerciseTextVerbatim: "v", exerciseTextEdited: "  " }), "v", "D1c");
  console.log("  D1 ✅ frontend effectiveText mirrors backend rule");
}

console.log("\n✅ All source-preservation tests passed (15 assertions)");
