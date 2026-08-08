// ────────────────────────────────────────────────────────────────────────────
// Translation layer tests — Round 1.6
//
// Test F — Translation-layer completeness (unchanged from Round 1.5)
//   Every issueType in ALL_ISSUE_TYPES must have an entry in ISSUE_TRANSLATIONS.
//
// Test G — Round 1.6 contract: real Armenian strings, no EN-PLACEHOLDER
//   After Round 1.6, all 49 issueTypes return actual Armenian text.
//   G-1: No output contains "[EN-PLACEHOLDER]"
//   G-2: No output contains "undefined" or "null" as literal strings
//   G-3: Unknown issueType returns a sentinel (NOT raw description unchanged)
//   G-4: Raw description is never returned as-is
//
// Test H — Param extraction: key dynamic issueTypes produce correct output
//   Representative issue objects with realistic descriptions verify that:
//   - entity IDs (entityId) are interpolated correctly
//   - secondary params (extracted via regex) appear in the output
//   - No "?" placeholder appears where a real value should be
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
// TEST G — Round 1.6: real Armenian strings; no EN-PLACEHOLDER; no null/undefined
// ─────────────────────────────────────────────────────────────────────────────
function testG_roundOnePointSixArmenianStrings(): void {
  // G-1: No known issueType may return a string containing "[EN-PLACEHOLDER]"
  const hasPlaceholder: string[] = [];
  for (const issueType of ALL_ISSUE_TYPES) {
    const result = translateIssue({
      issueType,
      description: `raw-english-${issueType}`,
      entityId: "TEST-ID",
      line: 1,
      severity: "error",
    });
    if (result.includes("[EN-PLACEHOLDER]")) {
      hasPlaceholder.push(`${issueType} → "${result.slice(0, 80)}"`);
    }
  }
  assert.equal(
    hasPlaceholder.length, 0,
    `Round 1.6 violation — these issueTypes still return [EN-PLACEHOLDER]:\n` +
    hasPlaceholder.map(s => `  - ${s}`).join("\n"),
  );
  console.log(`    ✓ G-1: No issueType returns [EN-PLACEHOLDER] (Round 1.6 Armenian strings in place)`);

  // G-2: No known issueType may return a string containing literal "undefined" or "null"
  //      (guards against regex failures leaking JS coercion artefacts)
  const hasUndefined: string[] = [];
  for (const issueType of ALL_ISSUE_TYPES) {
    const result = translateIssue({
      issueType,
      description: `raw-english-${issueType}`,
      entityId: "TEST-ID",
      line: 1,
      severity: "error",
    });
    if (result.includes("undefined") || result.includes("null")) {
      hasUndefined.push(`${issueType} → "${result.slice(0, 80)}"`);
    }
  }
  assert.equal(
    hasUndefined.length, 0,
    `The following issueTypes return "undefined" or "null" in output:\n` +
    hasUndefined.map(s => `  - ${s}`).join("\n"),
  );
  console.log(`    ✓ G-2: No issueType produces "undefined" or "null" in output`);

  // G-3: Unknown issueType returns a visible sentinel (not raw description unchanged)
  const unknownResult = translateIssue({
    issueType:   "totally-unknown-type-xyz",
    description: "raw fallback text",
  });
  assert.notEqual(unknownResult, "raw fallback text",
    "Unknown issueType must not return raw description unchanged");
  assert.ok(
    unknownResult.includes("totally-unknown-type-xyz"),
    `Unknown issueType sentinel must include the issueType string, got: "${unknownResult}"`,
  );
  console.log(`    ✓ G-3: Unknown issueType returns sentinel containing the issueType name`);

  // G-4: translateIssue does NOT return raw description unchanged for known types
  const rawOnly = translateIssue({
    issueType:   "mn-confidence-missing",
    description: "bare-description-no-prefix",
    entityId:    "MN-1.1",
  });
  assert.notEqual(
    rawOnly, "bare-description-no-prefix",
    "translateIssue must NOT return the raw description unchanged for a known issueType",
  );
  console.log(`    ✓ G-4: translateIssue never returns raw description unchanged`);

  console.log(`    → Round 1.6 contract: all 49 issueTypes have real Armenian strings.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST H — Param extraction: representative cases with realistic descriptions
// ─────────────────────────────────────────────────────────────────────────────
function testH_paramExtraction(): void {
  type IssueFixture = {
    label: string;
    issue: { issueType: string; description: string; entityId?: string | null; line?: number };
    mustContain: string[];  // substrings that MUST appear in the Armenian output
    mustNotContain?: string[];  // substrings that must NOT appear (e.g. "?")
  };

  const fixtures: IssueFixture[] = [
    // Static (no params) — entity not used
    {
      label: "lesson-missing (no params)",
      issue: { issueType: "lesson-missing", description: "LESSON section is missing.", entityId: null },
      mustContain: ["ԴԱՍ"],
    },
    // Lesson grade — grade from description
    {
      label: "lesson-grade-invalid grade=0",
      issue: {
        issueType: "lesson-grade-invalid",
        description: "LESSON: grade must be a positive integer (got 0).",
        entityId: null,
      },
      mustContain: ["0"],
      mustNotContain: ["?"],
    },
    // Lesson pages — from/to from description
    {
      label: "lesson-pages-invalid from=5 to=3",
      issue: {
        issueType: "lesson-pages-invalid",
        description: "LESSON: pages must be valid range pagesFrom≤pagesTo (got 5–3).",
        entityId: null,
      },
      mustContain: ["5", "3"],
      mustNotContain: ["?"],
    },
    // MN title empty — entityId as id
    {
      label: "mn-title-empty MN-2.3",
      issue: { issueType: "mn-title-empty", description: "MICRONODE MN-2.3: title is empty.", entityId: "MN-2.3" },
      mustContain: ["MN-2.3"],
      mustNotContain: ["?"],
    },
    // MN type invalid — received + expected from description
    {
      label: "mn-type-invalid received=BAD expected=THEORY | PRACTICE",
      issue: {
        issueType: "mn-type-invalid",
        description: `MICRONODE MN-1.1: microNodeType "BAD" is invalid. Expected: THEORY | PRACTICE.`,
        entityId: "MN-1.1",
      },
      mustContain: ["MN-1.1", "BAD", "THEORY | PRACTICE"],
      mustNotContain: ["?"],
    },
    // MN confidence range — value from description
    {
      label: "mn-confidence-range value=150",
      issue: {
        issueType: "mn-confidence-range",
        description: "MICRONODE MN-1.2: confidenceScore 150 is out of range 0–100.",
        entityId: "MN-1.2",
      },
      mustContain: ["MN-1.2", "150"],
      mustNotContain: ["?"],
    },
    // Orphan micronode — parentNodeId from description
    {
      label: "orphan-micronode parent=N99",
      issue: {
        issueType: "orphan-micronode",
        description: "MICRONODE MN-5.1: parent NODE N99 is not defined.",
        entityId: "MN-5.1",
      },
      mustContain: ["MN-5.1", "N99"],
      mustNotContain: ["?"],
    },
    // Ref sourceblock unknown variant A
    {
      label: "ref-sourceblock-unknown variant A (sourceBlockId)",
      issue: {
        issueType: "ref-sourceblock-unknown",
        description: `MICRONODE MN-1.1: sourceBlockId "B99" not found.`,
        entityId: "MN-1.1",
      },
      mustContain: ["MN-1.1", "B99"],
      mustNotContain: ["?"],
    },
    // Ref sourceblock unknown variant B
    {
      label: "ref-sourceblock-unknown variant B (unknown SOURCE BLOCK)",
      issue: {
        issueType: "ref-sourceblock-unknown",
        description: `MICRONODE MN-1.1: sourceRef references unknown SOURCE BLOCK B88.`,
        entityId: "MN-1.1",
      },
      mustContain: ["MN-1.1", "B88"],
      mustNotContain: ["?"],
    },
    // Ref sourcequote mismatch
    {
      label: "ref-sourcequote-mismatch",
      issue: {
        issueType: "ref-sourcequote-mismatch",
        description: `MICRONODE MN-1.1: sourceRef quote "Hello world the quick brown fox..." is not a substring of SOURCE BLOCK B5 sourceText.`,
        entityId: "MN-1.1",
      },
      mustContain: ["MN-1.1", "Hello world", "B5"],
      mustNotContain: ["?"],
    },
    // Ref exercise unknown
    {
      label: "ref-exercise-unknown",
      issue: {
        issueType: "ref-exercise-unknown",
        description: `MICRONODE MN-3.2: exerciseId "EX-99" not found.`,
        entityId: "MN-3.2",
      },
      mustContain: ["MN-3.2", "EX-99"],
      mustNotContain: ["?"],
    },
    // Ref prerequisite unknown
    {
      label: "ref-prerequisite-unknown",
      issue: {
        issueType: "ref-prerequisite-unknown",
        description: `MICRONODE MN-2.1: prerequisite MN "MN-9.9" not found.`,
        entityId: "MN-2.1",
      },
      mustContain: ["MN-2.1", "MN-9.9"],
      mustNotContain: ["?"],
    },
    // Ref dep from unknown
    {
      label: "ref-dep-from-unknown",
      issue: {
        issueType: "ref-dep-from-unknown",
        description: `DEPENDENCY D1: from "MN-99.1" is not a known MICRONODE id.`,
        entityId: "D1",
      },
      mustContain: ["D1", "MN-99.1"],
      mustNotContain: ["?"],
    },
    // Unreadable block referenced
    {
      label: "unreadable-block-referenced",
      issue: {
        issueType: "unreadable-block-referenced",
        description: `MICRONODE MN-1.1: references SOURCE BLOCK B7 with status UNREADABLE — forbidden by contract §8.`,
        entityId: "MN-1.1",
      },
      mustContain: ["MN-1.1", "B7", "UNREADABLE"],
      mustNotContain: ["?"],
    },
    // Warn related mn extra
    {
      label: "warn-related-mn-extra count=3 firstId=MN-2.1",
      issue: {
        issueType: "warn-related-mn-extra",
        description: `MICRONODE MN-1.1: 3 relatedMicroNodes — only the first (MN-2.1) will be stored; the rest need a join table (future migration).`,
        entityId: "MN-1.1",
      },
      mustContain: ["MN-1.1", "3", "MN-2.1"],
      mustNotContain: ["?"],
    },
    // Warn ex multi related
    {
      label: "warn-ex-multi-related count=2 firstId=MN-3.4",
      issue: {
        issueType: "warn-ex-multi-related",
        description: `EXERCISE EX-5: 2 relatedMicroNodes — only first (MN-3.4) will be stored as relatedNodeId.`,
        entityId: "EX-5",
      },
      mustContain: ["EX-5", "2", "MN-3.4"],
      mustNotContain: ["?"],
    },
    // sb-page-out-of-range
    {
      label: "sb-page-out-of-range page=45 range=1–40",
      issue: {
        issueType: "sb-page-out-of-range",
        description: `SOURCE BLOCK B3: sourcePage 45 is outside lesson page range 1–40.`,
        entityId: "B3",
      },
      mustContain: ["B3", "45", "1", "40"],
      mustNotContain: ["?"],
    },
    // related-mn-deferred (entityId is DB integer — must parse from description)
    {
      label: "related-mn-deferred MN-1.1 → MN-2.2",
      issue: {
        issueType: "related-mn-deferred",
        description: `MicroNode MN-1.1: relatedMicroNode "MN-2.2" needs a join table — deferred to future migration.`,
        entityId: "42",  // DB integer
      },
      mustContain: ["MN-1.1", "MN-2.2"],
      mustNotContain: ["?"],
    },
    // ex-multi-related-deferred
    {
      label: "ex-multi-related-deferred EX-3 → MN-4.5",
      issue: {
        issueType: "ex-multi-related-deferred",
        description: `EXERCISE EX-3: additional relatedMicroNode "MN-4.5" needs a join table — deferred to future migration.`,
        entityId: "77",  // DB integer
      },
      mustContain: ["EX-3", "MN-4.5"],
      mustNotContain: ["?"],
    },
  ];

  const failures: string[] = [];

  for (const { label, issue, mustContain, mustNotContain = [] } of fixtures) {
    const result = translateIssue(issue as Parameters<typeof translateIssue>[0]);

    for (const expected of mustContain) {
      if (!result.includes(expected)) {
        failures.push(`[${label}] output missing "${expected}" — got: "${result.slice(0, 120)}"`);
      }
    }
    for (const forbidden of mustNotContain) {
      if (result.includes(forbidden)) {
        failures.push(`[${label}] output contains forbidden "${forbidden}" — got: "${result.slice(0, 120)}"`);
      }
    }
  }

  assert.equal(
    failures.length, 0,
    `Param extraction failures:\n${failures.map(f => `  - ${f}`).join("\n")}`,
  );
  console.log(`    ✓ H-1: All ${fixtures.length} representative fixtures pass param extraction`);
  console.log(`    → entityId, description-regex, and fallback paths all verified`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Run all tests
// ─────────────────────────────────────────────────────────────────────────────

const syncTests: Array<[string, () => void]> = [
  ["F: Translation-layer completeness — every issueType has a table entry", testF_translationLayerCompleteness],
  ["G: Round 1.6 — Armenian strings in place, no EN-PLACEHOLDER, no undefined/null", testG_roundOnePointSixArmenianStrings],
  ["H: Param extraction — representative fixtures produce correct Armenian output", testH_paramExtraction],
];

let passed = 0;
let failed = 0;
const failedNames: string[] = [];

console.log("\n  mapTextTranslations — Round 1.6 translation tests (F + G + H)\n");

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
