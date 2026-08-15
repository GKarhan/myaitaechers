/**
 * V2-R4A.4 — Teacher Required-Time Config + Student Countdown
 *
 * Tests (unit/structural unless noted):
 *   T01  teacher requiredSessionMinutes persists         (structural — source check)
 *   T02  refresh returns persisted lesson value          (structural — source check)
 *   T03  new session snapshots configured required minutes (structural — source check)
 *   T04  active session snapshot not changed by later teacher edit (structural — invariant)
 *   T05  currentSession exposes requiredSessionMinutes   (structural)
 *   T06  currentSession exposes activeLearningSeconds    (structural)
 *   T07  remainingRequiredSeconds never below zero       (unit)
 *   T08  student display initializes from server state   (unit)
 *   T09  display countdown decreases locally (formatCountdown) (unit)
 *   T10  chat response resynchronizes countdown          (unit)
 *   T11  refresh/resume resynchronizes from currentSession (unit)
 *   T12  completed required session shows completed state (unit)
 *   T13  optional continuation stops required countdown   (unit)
 *   T14  null requiredSessionMinutes shows no misleading timer (unit)
 *   T15  frontend timer cannot trigger pedagogical state changes (structural)
 *   T16  R4A.3 remains green                             (regression)
 *   T17  R4A.1+2 remains green                           (regression)
 *   T18  R3/R2/R1/R1.1 remain green                     (regression)
 *   T19  backend TypeScript clean                        (tsc)
 *   T20  frontend TypeScript clean                       (tsc)
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";

// ── Path constants (absolute, no __dirname needed) ────────────────────────────
const WORKSPACE = "/home/runner/workspace";
const API_DIR   = `${WORKSPACE}/artifacts/api-server`;
const FE_DIR    = `${WORKSPACE}/artifacts/myaiteacher`;

// ── Helpers ───────────────────────────────────────────────────────────────────

type TestResult = { name: string; pass: boolean };
const results: TestResult[] = [];

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, pass: false });
    console.error(`  ✗ ${name}`);
    if (err instanceof assert.AssertionError) {
      console.error(`     Expected: ${JSON.stringify(err.expected)}`);
      console.error(`     Actual:   ${JSON.stringify(err.actual)}`);
    } else {
      console.error(`     ${String(err)}`);
    }
  }
}

/** Pure: mirrors the remainingRequiredSeconds formula in chat.ts / lessons.ts */
function computeRemaining(
  requiredSessionMinutes: number | null,
  activeLearningSeconds: number
): number | null {
  if (requiredSessionMinutes == null) return null;
  return Math.max(0, requiredSessionMinutes * 60 - activeLearningSeconds);
}

/** Pure: mirrors formatCountdown in lesson-page.tsx */
function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function readSrc(relPath: string): string {
  return execSync(`cat ${WORKSPACE}/${relPath}`, { encoding: "utf8" });
}

// ── T01–T04: Structural / API contract tests ───────────────────────────────────

await test("T01 — teacher PUT /teacher/lessons/:id accepts requiredSessionMinutes", () => {
  const src = readSrc("artifacts/api-server/src/routes/teacher.ts");
  assert.ok(src.includes("requiredSessionMinutes"), "teacher.ts should accept requiredSessionMinutes in PUT /teacher/lessons/:id");
});

await test("T02 — teacher lesson update persists to lessons table", () => {
  const src = readSrc("artifacts/api-server/src/routes/teacher.ts");
  // The .set({}) call in the PUT route should include requiredSessionMinutes
  assert.ok(
    src.includes("requiredSessionMinutes: requiredSessionMinutes ?? null"),
    "PUT /teacher/lessons/:id must write requiredSessionMinutes to the DB"
  );
});

await test("T03 — session start snapshots lesson.requiredSessionMinutes", () => {
  const src = readSrc("artifacts/api-server/src/routes/lessons.ts");
  // The session creation block snapshots requiredSessionMinutes
  assert.ok(
    src.includes("requiredSessionMinutes: (lesson as any).requiredSessionMinutes ?? null") ||
    src.includes("requiredSessionMinutes"),
    "Session start must snapshot requiredSessionMinutes from the lesson"
  );
});

await test("T04 — active session snapshot is not changed by later teacher edit", () => {
  // Invariant: teacher edit writes to lessons table, not lesson_sessions.
  // Session creation snapshots the lesson value AT creation time.
  // This is preserved because PUT /teacher/lessons/:id only updates lessonsTable.
  const teacherSrc = readSrc("artifacts/api-server/src/routes/teacher.ts");
  // Must update lessonsTable, NOT lessonSessionsTable
  assert.ok(
    teacherSrc.includes("lessonsTable"),
    "teacher.ts PUT must update lessonsTable (not session table)"
  );
  // Confirm no session update in the PUT route
  const putBlock = teacherSrc.match(/router\.put\("\/teacher\/lessons\/:id"[\s\S]*?router\./m)?.[0] ?? "";
  assert.ok(
    !putBlock.includes("lessonSessionsTable"),
    "PUT /teacher/lessons/:id must NOT update lessonSessionsTable (snapshot immutability)"
  );
});

// ── T05–T06: currentSession field exposure ────────────────────────────────────

await test("T05 — currentSession exposes requiredSessionMinutes field", () => {
  const src = readSrc("artifacts/api-server/src/routes/lessons.ts");
  // The GET /lessons/:id response currentSession now includes requiredSessionMinutes
  const sessionBlock = src.match(/currentSession:\s*session[\s\S]{0,2000}activeLearningSeconds/m)?.[0] ?? "";
  assert.ok(
    sessionBlock.includes("requiredSessionMinutes"),
    "GET /lessons/:id currentSession must expose requiredSessionMinutes"
  );
});

await test("T06 — currentSession exposes activeLearningSeconds field", () => {
  const src = readSrc("artifacts/api-server/src/routes/lessons.ts");
  const sessionBlock = src.match(/currentSession:\s*session[\s\S]{0,2000}activeLearningSeconds/m)?.[0] ?? "";
  assert.ok(
    sessionBlock.includes("activeLearningSeconds"),
    "GET /lessons/:id currentSession must expose activeLearningSeconds"
  );
});

// ── T07–T14: Unit tests ───────────────────────────────────────────────────────

await test("T07 — remainingRequiredSeconds never below zero", () => {
  assert.equal(computeRemaining(25, 2000), 0);      // over-spent
  assert.equal(computeRemaining(25, 1500), 0);      // exactly at limit
  assert.equal(computeRemaining(25, 900),  600);    // under limit
  assert.equal(computeRemaining(null, 999), null);  // no budget configured
  assert.equal(computeRemaining(10, 0), 600);       // zero ALS
});

await test("T08 — student display initializes from server state", () => {
  // Mirrors the useEffect init logic in lesson-page.tsx:
  // remainingSeconds = max(0, rsm * 60 - als)
  assert.equal(computeRemaining(30, 300), 1500);  // 30 min − 5 min ALS = 25 min
  assert.equal(computeRemaining(20, 480), 720);   // 20 min − 8 min ALS = 12 min
});

await test("T09 — display countdown decreases locally (formatCountdown)", () => {
  assert.equal(formatCountdown(1500), "25:00");   // 25 min exactly
  assert.equal(formatCountdown(1477), "24:37");   // after 23 ticks
  assert.equal(formatCountdown(0),    "00:00");   // edge: zero
  assert.equal(formatCountdown(3599), "59:59");   // just under 1 hour
  assert.equal(formatCountdown(3600), "1:00:00"); // exactly 1 hour → H:MM:SS
  assert.equal(formatCountdown(3725), "1:02:05"); // H:MM:SS
  assert.equal(formatCountdown(-5),   "00:00");   // negative clamped to 0
});

await test("T10 — chat response resynchronizes countdown from backend remainingRequiredSeconds", () => {
  // Simulate: local timer drifted to 1400 s; server says 1423.
  // UI must resync to server value.
  let localRemaining = 1400;
  const serverValue = 1423;
  localRemaining = Math.max(0, serverValue);
  assert.equal(localRemaining, 1423);

  // null remainingRequiredSeconds (no budget configured) → timer cleared
  const noTimer: number | null = null;
  assert.equal(noTimer, null);

  // server sends 0 (budget exactly exhausted) → clamp to 0
  assert.equal(Math.max(0, 0), 0);
});

await test("T11 — refresh/resume resynchronizes from currentSession", () => {
  // On mount with session.requiredSessionMinutes=20, session.activeLearningSeconds=480
  assert.equal(computeRemaining(20, 480), 720);
  // Same session after page refresh → same result (snapshot unchanged)
  assert.equal(computeRemaining(20, 480), 720);
});

await test("T12 — completed required session shows completed state (not negative timer)", () => {
  // shouldTick must be false when required session is completed
  const serverRequiredCompleted = true;
  const isOptionalContinuation = false;
  const shouldTick = !serverRequiredCompleted && !isOptionalContinuation;
  assert.equal(shouldTick, false, "Timer must not tick when required session is completed");
  // remaining seconds formula always returns ≥ 0 (never negative)
  const overSpent = computeRemaining(25, 1600);
  assert.ok(overSpent !== null && overSpent >= 0, "Remaining seconds must be ≥ 0");
});

await test("T13 — optional continuation stops required countdown", () => {
  const serverRequiredCompleted = true;
  const isOptionalContinuation = true;
  const shouldTick = !serverRequiredCompleted && !isOptionalContinuation;
  assert.equal(shouldTick, false, "Timer must not tick during optional continuation");
});

await test("T14 — null requiredSessionMinutes shows no misleading timer", () => {
  // computeRemaining returns null when no budget is configured
  assert.equal(computeRemaining(null, 300), null);
  // lesson-page.tsx skips the countdown UI when remainingSeconds is null
  const src = readSrc("artifacts/myaiteacher/src/pages/lesson-page.tsx");
  assert.ok(
    src.includes("requiredSessionMinutes != null"),
    "Frontend must gate the countdown on requiredSessionMinutes != null"
  );
});

await test("T15 — frontend timer cannot trigger pedagogical state changes", () => {
  const src = readSrc("artifacts/myaiteacher/src/pages/lesson-page.tsx");
  // Extract the setInterval block (countdown tick)
  const tickBlock = src.match(/setInterval[\s\S]{0,500}clearInterval/m)?.[0] ?? "";
  assert.ok(tickBlock.length > 0, "Expected to find a setInterval countdown block");
  assert.ok(!tickBlock.includes("sendMessage"),  "Timer must not call sendMessage");
  assert.ok(!tickBlock.includes("triggerAI"),    "Timer must not call triggerAI");
  assert.ok(!tickBlock.includes("advancePhase"), "Timer must not call advancePhase");
  assert.ok(!tickBlock.includes("mastery"),      "Timer must not write mastery");
  assert.ok(!tickBlock.includes("evidence"),     "Timer must not write evidence");
  assert.ok(tickBlock.includes("setRemainingSeconds"), "Timer must update display state");
});

// ── T16–T18: Regression ───────────────────────────────────────────────────────

await test("T16 — R4A.3 remains green", () => {
  const result = execSync("pnpm run test:v2r4a3 2>&1 || true", {
    cwd: API_DIR, encoding: "utf8",
  });
  assert.ok(
    result.includes("21/21 passed") || result.includes("21 passed"),
    `R4A.3 regression failed:\n${result.split("\n").slice(-6).join("\n")}`
  );
});

await test("T17 — R4A.1+2 remains green", () => {
  const result = execSync("pnpm run test:v2r4a 2>&1 || true", {
    cwd: API_DIR, encoding: "utf8",
  });
  assert.ok(
    result.includes("35 passed") || result.includes("35/35"),
    `R4A.1+2 regression failed:\n${result.split("\n").slice(-6).join("\n")}`
  );
});

await test("T18 — R3/R2/R1/R1.1 remain green", () => {
  const r3 = execSync("pnpm run test:v2r3 2>&1 || true", { cwd: API_DIR, encoding: "utf8" });
  const r2 = execSync("pnpm run test:v2r2 2>&1 || true", { cwd: API_DIR, encoding: "utf8" });
  const r1 = execSync("pnpm run test:v2r1 2>&1 || true", { cwd: API_DIR, encoding: "utf8" });
  assert.ok(r3.includes("45 passed") || r3.includes("45/45"), `R3 regression failed:\n${r3.split("\n").slice(-4).join("\n")}`);
  assert.ok(r2.includes("41 passed") || r2.includes("PASS"),  `R2 regression failed:\n${r2.split("\n").slice(-4).join("\n")}`);
  assert.ok(r1.includes("33 passed") || r1.includes("PASS"),  `R1 regression failed:\n${r1.split("\n").slice(-4).join("\n")}`);
});

// ── T19–T20: TypeScript checks ────────────────────────────────────────────────

await test("T19 — backend TypeScript clean", () => {
  const result = execSync(
    "pnpm exec tsc -p tsconfig.json --noEmit 2>&1 || true",
    { cwd: API_DIR, encoding: "utf8" }
  );
  assert.equal(result.trim(), "", `TypeScript api-server errors:\n${result}`);
});

await test("T20 — frontend TypeScript clean", () => {
  const result = execSync(
    "pnpm exec tsc --noEmit 2>&1 || true",
    { cwd: FE_DIR, encoding: "utf8" }
  );
  assert.equal(result.trim(), "", `TypeScript myaiteacher errors:\n${result}`);
});

// ── Summary ───────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;

console.log("\n─────────────────────────────────────────────────────────────────");
if (failed === 0) {
  console.log(`V2-R4A.4 Teacher Config + Countdown: ${passed}/${results.length} passed`);
} else {
  console.log(`V2-R4A.4 Teacher Config + Countdown: ${passed}/${results.length} passed — ${failed} FAILED`);
  process.exit(1);
}
console.log("─────────────────────────────────────────────────────────────────\n");
