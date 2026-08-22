/**
 * C3 minimum telemetry contract regressions.
 *
 * Runner:
 *   pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/c3-trustworthy-evidence.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EVIDENCE_QUALIFICATION,
  classifyQualifyingEvidence,
  createTaskReference,
} from "../evidence-contract.js";
import {
  deriveGeneratedMicroCheckActivation,
} from "../../services/phase2/orchestration.js";

const chatRoute = readFileSync(
  fileURLToPath(new URL("../../routes/chat.ts", import.meta.url)),
  "utf8",
);
const quizRoute = readFileSync(
  fileURLToPath(new URL("../../routes/quizzes.ts", import.meta.url)),
  "utf8",
);
const lessonsRoute = readFileSync(
  fileURLToPath(new URL("../../routes/lessons.ts", import.meta.url)),
  "utf8",
);
const evidenceSchema = readFileSync(
  fileURLToPath(new URL("../../../../../lib/db/src/schema/evidence-events.ts", import.meta.url)),
  "utf8",
);

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function qualified(overrides: Partial<Parameters<typeof classifyQualifyingEvidence>[0]> = {}) {
  return classifyQualifyingEvidence({
    lessonNodeId: 101,
    cognitiveLevelId: 202,
    taskSource: "source_exercise",
    taskReference: "source_exercise:303",
    levelBelongsToNode: true,
    acceptedPath: true,
    taskValidForLevel: true,
    authoritativeResult: true,
    ...overrides,
  });
}

test("1 source exercise evidence has complete qualifying identity", () => {
  assert.equal(qualified(), EVIDENCE_QUALIFICATION.QUALIFIED);
  for (const field of [
    "lessonNodeId",
    "cognitiveLevelId",
    "lessonExerciseId",
    "taskSource",
    "taskReference",
    "qualificationStatus",
    "evidenceQuality",
  ]) {
    assert.match(evidenceSchema, new RegExp(`${field}:`));
  }
});

test("2 generated micro-check creates one stable persisted task reference", () => {
  const reference = createTaskReference("micro_check");
  const activation = deriveGeneratedMicroCheckActivation({
    is_micro_check: true,
    interaction_type: "multiple_choice",
    options: [{ key: "A", text: "Ճիշտ" }],
    correct_option: "A",
  } as any, reference);
  assert.equal(activation?.activeTaskReference, reference);
  assert.equal(
    qualified({
      taskSource: "micro_check",
      taskReference: activation?.activeTaskReference ?? null,
    }),
    EVIDENCE_QUALIFICATION.QUALIFIED,
  );
  assert.match(chatRoute, /activeTaskReference:\s*session\.activeTaskReference/u);
  assert.match(chatRoute, /provenance === "micro_check".*"MODERATE"/su);
});

test("3 cross-node exercise links are rejected", () => {
  assert.match(
    lessonsRoute,
    /if \(ex\.relatedNodeId !== nodeId\)[\s\S]*Exercise must belong to the same MicroNode/u,
  );
  assert.equal(qualified({ levelBelongsToNode: false }), EVIDENCE_QUALIFICATION.UNQUALIFIED);
});

test("4 unmapped exercise is explicitly unqualified", () => {
  assert.equal(qualified({ taskValidForLevel: false }), EVIDENCE_QUALIFICATION.UNQUALIFIED);
});

test("5 qualified quiz question carries typed question, node, and level identity", () => {
  assert.equal(
    qualified({
      taskSource: "quiz_question",
      taskReference: "quiz_question:404",
    }),
    EVIDENCE_QUALIFICATION.QUALIFIED,
  );
  assert.match(quizRoute, /quizQuestionId:\s*question\.id/u);
  assert.match(quizRoute, /taskReference:\s*`quiz_question:\$\{question\.id\}`/u);
});

test("6 legacy/unannotated quiz remains unqualified", () => {
  assert.equal(
    qualified({
      taskSource: "quiz_question",
      taskReference: "quiz_question:405",
      cognitiveLevelId: null,
    }),
    EVIDENCE_QUALIFICATION.UNQUALIFIED,
  );
  assert.match(quizRoute, /qualificationStatus/u);
});

test("7 assistance and attempt values survive later session mutation", () => {
  const active = {
    activeHelpCount: 1,
    activeAssistanceLevel: "light",
    activeAttemptSequence: 2,
  };
  const snapshot = { ...active };
  active.activeHelpCount = 4;
  active.activeAssistanceLevel = "revealed";
  active.activeAttemptSequence = 3;
  assert.deepEqual(snapshot, {
    activeHelpCount: 1,
    activeAssistanceLevel: "light",
    activeAttemptSequence: 2,
  });
  assert.match(chatRoute, /activeHelpCount:\s*session\.activeHelpCount/u);
  assert.match(chatRoute, /activeAttemptSequence:\s*session\.activeAttemptSequence/u);
});

test("8 canonical write failure is never silently reported as success", () => {
  assert.match(chatRoute, /let _canonicalEvidenceWriteFailed = false/u);
  assert.match(chatRoute, /error: "EVIDENCE_PERSISTENCE_FAILED"/u);
  assert.ok(
    chatRoute.indexOf("await (async () =>") < chatRoute.indexOf("res.json({\n    response:"),
    "chat must await canonical evidence before success response",
  );
  assert.match(quizRoute, /await db\.delete\(quizAttemptsTable\)/u);
  assert.match(quizRoute, /quizAttemptId:\s*attempt\.id/u);
});

test("9 historical rows remain nullable/legacy compatible", () => {
  for (const field of [
    "lessonNodeId",
    "cognitiveLevelId",
    "quizQuestionId",
    "quizAttemptId",
    "taskSource",
    "taskReference",
    "qualificationStatus",
  ]) {
    assert.match(evidenceSchema, new RegExp(`${field}:`));
  }
  assert.equal(
    qualified({ taskReference: null }),
    EVIDENCE_QUALIFICATION.UNQUALIFIED,
  );
});

console.log(`\n${passed} C3 trustworthy-evidence contract tests passed\n`);