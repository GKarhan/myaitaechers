// ────────────────────────────────────────────────────────────────────────────
// Translation layer tests (Round 1.5 finalization)
//
// Test F — Translation-layer completeness
//   Every issueType in ALL_ISSUE_TYPES must have an entry in ISSUE_TRANSLATIONS.
//   If any issueType is missing from the table, this test FAILS.
//   If any issueType appears twice in ALL_ISSUE_TYPES, this test FAILS.
//
// Test G — Translation function returns [EN-PLACEHOLDER] sentinel
//   translateIssue() must return a string starting with "[EN-PLACEHOLDER]"
//   for every known issueType. This proves the rendering path goes through
//   the lookup table and does NOT pass through the raw description unchanged.
//
// Run: pnpm --filter @workspace/api-server exec tsx src/mapping/__tests__/mapTextTranslations.test.ts
// ────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import { ALL_ISSUE_TYPES, ISSUE_TRANSLATIONS, translateIssue } from "../mapTextTranslations.js";

// ─────────────────────────────────────────────────────────────────────────────
// TEST F — Every issueType in ALL_ISSUE_TYPES has a translation-layer entry
// ─────────────────────────────────────────────────────────────────────────────
function testF_translationLayerCompleteness(): void {
  // F-1: No duplicates in ALL_ISSUE_TYPES inventory
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const t of ALL_ISSUE_TYPES) {
    if (seen.has(t)) duplicates.push(t);
    seen.add(t);
  }
  assert.equal(
    duplicates.length, 0,
    `ALL_ISSUE_TYPES contains duplicate entries: ${duplicates.join(", ")}`,
  );
  console.log(`    ✓ F-1: ALL_ISSUE_TYPES has no duplicates (${ALL_ISSUE_TYPES.length} unique entries)`);

  // F-2: Every entry in ALL_ISSUE_TYPES has a function in ISSUE_TRANSLATIONS
  const missing: string[] = [];
  for (const issueType of ALL_ISSUE_TYPES) {
    if (typeof ISSUE_TRANSLATIONS[issueType] !== "function") {
      missing.push(issueType);
    }
  }
  assert.equal(
    missing.length, 0,
    `The following issueTypes are in ALL_ISSUE_TYPES but have NO entry in ISSUE_TRANSLATIONS:\n` +
    missing.map(t => `  - ${t}`).join("\n"),
  );
  console.log(`    ✓ F-2: All ${ALL_ISSUE_TYPES.length} issueTypes have a function in ISSUE_TRANSLATIONS`);

  // F-3: ISSUE_TRANSLATIONS has no EXTRA entries not in ALL_ISSUE_TYPES
  //      (detects stale entries after an issueType is renamed/removed)
  const allSet = new Set(ALL_ISSUE_TYPES);
  const extra: string[] = [];
  for (const key of Object.keys(ISSUE_TRANSLATIONS)) {
    if (!allSet.has(key)) extra.push(key);
  }
  assert.equal(
    extra.length, 0,
    `ISSUE_TRANSLATIONS contains keys NOT in ALL_ISSUE_TYPES (stale entries):\n` +
    extra.map(t => `  - ${t}`).join("\n"),
  );
  console.log(`    ✓ F-3: ISSUE_TRANSLATIONS has no stale/extra entries`);
  console.log(`    → ${ALL_ISSUE_TYPES.length} issueTypes: ${Object.keys(ISSUE_TRANSLATIONS).length} translation entries.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST G — translateIssue() uses the lookup and returns [EN-PLACEHOLDER]
// ─────────────────────────────────────────────────────────────────────────────
function testG_translationFunctionReturnsSentinel(): void {
  // G-1: All known issueTypes return [EN-PLACEHOLDER] prefix
  const notSentinel: string[] = [];
  for (const issueType of ALL_ISSUE_TYPES) {
    const result = translateIssue({
      issueType,
      description: `raw-english-${issueType}`,
      entityId:    "TEST-ENTITY",
      line:        1,
      severity:    "error",
    });
    if (!result.startsWith("[EN-PLACEHOLDER]")) {
      notSentinel.push(`${issueType} → "${result.slice(0, 80)}"`);
    }
  }
  assert.equal(
    notSentinel.length, 0,
    `The following issueTypes do NOT return [EN-PLACEHOLDER] prefix:\n` +
    notSentinel.map(s => `  - ${s}`).join("\n"),
  );
  console.log(`    ✓ G-1: All ${ALL_ISSUE_TYPES.length} translateIssue() calls return "[EN-PLACEHOLDER]..." prefix`);

  // G-2: The translated string must CONTAIN the original description (passthrough for this round)
  //      This proves the raw description is preserved inside the placeholder.
  const missing: string[] = [];
  for (const issueType of ALL_ISSUE_TYPES) {
    const rawDescription = `sample-description-for-${issueType}`;
    const result = translateIssue({ issueType, description: rawDescription });
    if (!result.includes(rawDescription)) {
      missing.push(`${issueType} → "${result.slice(0, 80)}"`);
    }
  }
  assert.equal(
    missing.length, 0,
    `The following issueTypes do NOT include the raw description in the output (unexpected stripping):\n` +
    missing.map(s => `  - ${s}`).join("\n"),
  );
  console.log(`    ✓ G-2: All translated strings include the raw description (pass-through confirmed)`);

  // G-3: An UNKNOWN issueType returns a sentinel with "UNKNOWN-TYPE" marker
  //      (proves the fallback path does NOT silently pass raw English)
  const unknownResult = translateIssue({
    issueType:   "totally-unknown-type-xyz",
    description: "raw fallback text",
  });
  assert.ok(
    unknownResult.startsWith("[EN-PLACEHOLDER:UNKNOWN-TYPE:"),
    `Unknown issueType fallback must start with [EN-PLACEHOLDER:UNKNOWN-TYPE:...], got: "${unknownResult}"`,
  );
  console.log(`    ✓ G-3: Unknown issueType fallback returns "[EN-PLACEHOLDER:UNKNOWN-TYPE:...]" sentinel`);

  // G-4: translateIssue does NOT just return issue.description unchanged
  //      i.e. the lookup table IS being used, not bypassed
  const rawOnly = translateIssue({
    issueType:   "mn-confidence-missing",
    description: "bare-description-no-prefix",
  });
  assert.notEqual(
    rawOnly,
    "bare-description-no-prefix",
    "translateIssue must NOT return the raw description unchanged — the lookup must always add the prefix",
  );
  console.log(`    ✓ G-4: translateIssue always adds prefix — raw description is never returned as-is`);

  console.log(`    → Rendering path verified: issueType → ISSUE_TRANSLATIONS[key] → "[EN-PLACEHOLDER] ..."`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Run all tests
// ─────────────────────────────────────────────────────────────────────────────

const syncTests: Array<[string, () => void]> = [
  ["F: Translation-layer completeness — every issueType has a table entry", testF_translationLayerCompleteness],
  ["G: translateIssue() returns [EN-PLACEHOLDER] sentinel for all issueTypes", testG_translationFunctionReturnsSentinel],
];

let passed = 0;
let failed = 0;
const failedNames: string[] = [];

console.log("\n  mapTextTranslations — translation-layer tests (F + G)\n");

for (const [name, fn] of syncTests) {
  try {
    fn();
    passed++;
    process.stdout.write(`  \u001b[32m\u2713\u001b[0m ${name}\n`);
  } catch (err) {
    failed++;
    failedNames.push(name);
    process.stdout.write(`  \u001b[31m\u2717\u001b[0m ${name}\n`);
    if (err instanceof Error) {
      console.error(`      ${err.message}`);
      if (err.stack) {
        const lines = err.stack.split("\n").slice(1, 4);
        for (const l of lines) console.error(`      ${l.trim()}`);
      }
    }
  }
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.error(`  Failed: ${failedNames.join(", ")}\n`);
  process.exit(1);
}
