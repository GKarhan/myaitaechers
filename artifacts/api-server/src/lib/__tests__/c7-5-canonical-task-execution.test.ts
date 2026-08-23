import assert from "node:assert/strict";
import {
  buildCanonicalTaskSnapshot,
  createCanonicalTaskRetrySnapshot,
  isCanonicalTaskSnapshot,
  snapshotCanQualifyC3,
  snapshotMatchesExecutionTarget,
  sourceTaskText,
  taskSnapshotForEvidence,
} from "../../services/phase2/canonical-task-snapshot.js";
import { createC7ExecutionTarget } from "../../services/phase2/c7-execution-target.js";
import { deriveGeneratedMicroCheckActivation } from "../../services/phase2/orchestration.js";

type Test = { name: string; run: () => void };
const tests: Test[] = [];
const test = (name: string, run: () => void) => tests.push({ name, run });

const target = createC7ExecutionTarget({
  lessonId: 42,
  currentNodeId: 7,
  activeCognitiveLevelId: 11,
  node: { id: 7, title: "Արմատ" },
  acceptedPath: [{
    id: 11,
    cognitiveLevel: "UNDERSTAND",
    successCriterion: "ճիշտ բացատրի",
  }],
});

function source(overrides: Partial<Parameters<typeof buildCanonicalTaskSnapshot>[0]> = {}) {
  return buildCanonicalTaskSnapshot({
    taskReference: "source_exercise:attempt-a",
    taskSource: "source_exercise",
    taskKind: "source",
    renderedPrompt: "Բացատրի՛ր կանոնը։\n(Էջ 5, Վ. EX-1)",
    executionTarget: target,
    interactionType: "short_answer",
    lessonExerciseId: 88,
    sourceExerciseId: "EX-1",
    sourcePage: "5",
    learnerTextSource: "verbatim",
    sourceAnswer: { interactionType: "short_answer", correctAnswer: "ճիշտ" },
    sourceSuccessCriteria: "բացատրի կանոնի իմաստը",
    targetCompatibleAtActivation: true,
    ...overrides,
  });
}

function micro(overrides: Partial<Parameters<typeof buildCanonicalTaskSnapshot>[0]> = {}) {
  return buildCanonicalTaskSnapshot({
    taskReference: "micro_check:attempt-a",
    taskSource: "micro_check",
    taskKind: "micro_check",
    renderedPrompt: "Ընտրի՛ր ճիշտ պատասխանը։\nA) այո\nB) ոչ",
    executionTarget: target,
    interactionType: "multiple_choice",
    learnerTextSource: "generated",
    objectivePayload: {
      interactionType: "multiple_choice",
      options: [{ key: "A", text: "այո" }, { key: "B", text: "ոչ" }],
      correctOption: "A",
    },
    questionTemplate: "choose-rule",
    targetCompatibleAtActivation: true,
    ...overrides,
  });
}

test("01 source snapshot has canonical version", () => assert.equal(source().version, 1));
test("02 source snapshot keeps opaque identity", () => assert.equal(source().taskReference, "source_exercise:attempt-a"));
test("03 source snapshot stores locked node", () => assert.equal(source().lessonNodeId, 7));
test("04 source snapshot stores locked level", () => assert.equal(source().cognitiveLevelId, 11));
test("05 source prompt is preserved verbatim", () => assert.ok(source().renderedPrompt.startsWith("Բացատրի՛ր կանոնը։")));
test("06 source snapshot retains source exercise identity", () => assert.equal(source().sourceExerciseId, "EX-1"));
test("07 source snapshot retains source page", () => assert.equal(source().sourcePage, "5"));
test("08 source snapshot retains success criterion", () => assert.equal(source().successCriterion, "ճիշտ բացատրի"));
test("09 source snapshot retains evaluation contract", () => assert.equal(source().sourceAnswer?.correctAnswer, "ճիշտ"));
test("10 source snapshot retains source success criteria", () => assert.equal(source().sourceSuccessCriteria, "բացատրի կանոնի իմաստը"));
test("11 source snapshot is frozen", () => assert.equal(Object.isFrozen(source()), true));
test("12 snapshot target matches its locked target", () => assert.equal(snapshotMatchesExecutionTarget(source(), target), true));
test("13 wrong-node snapshot cannot match target", () => assert.equal(snapshotMatchesExecutionTarget(source({ executionTarget: createC7ExecutionTarget({ lessonId: 42, currentNodeId: 8, activeCognitiveLevelId: 11, node: { id: 8, title: "այլ" }, acceptedPath: [{ id: 11, cognitiveLevel: "UNDERSTAND" }] }) }), target), false));
test("14 wrong-level snapshot cannot match target", () => assert.equal(snapshotMatchesExecutionTarget(source({ executionTarget: createC7ExecutionTarget({ lessonId: 42, currentNodeId: 7, activeCognitiveLevelId: 12, node: { id: 7, title: "Արմատ" }, acceptedPath: [{ id: 12, cognitiveLevel: "APPLY" }] }) }), target), false));
test("15 target-compatible source can qualify", () => assert.equal(snapshotCanQualifyC3(source()), true));
test("16 unlinked source cannot qualify", () => assert.equal(snapshotCanQualifyC3(source({ targetCompatibleAtActivation: false })), false));
test("17 generated objective has a new micro-check identity", () => assert.equal(micro().taskReference, "micro_check:attempt-a"));
test("18 generated objective retains visible options", () => assert.equal(micro().renderedPrompt.includes("A) այո"), true));
test("19 generated objective retains backend answer key", () => assert.equal(micro().objectivePayload?.correctOption, "A"));
test("20 generated objective retains template provenance", () => assert.equal(micro().generated?.questionTemplate, "choose-rule"));
test("21 generated objective can qualify only when target-compatible", () => assert.equal(snapshotCanQualifyC3(micro()), true));
test("22 generated constructed response remains unqualified", () => assert.equal(snapshotCanQualifyC3(buildCanonicalTaskSnapshot({ taskReference: "generated_task:1", taskSource: "generated_task", taskKind: "generated", renderedPrompt: "Բացատրի՛ր։", executionTarget: target, interactionType: "constructed_response", learnerTextSource: "generated", targetCompatibleAtActivation: true })), false));
test("23 independent re-check has distinct reference", () => assert.notEqual(micro().taskReference, micro({ taskReference: "micro_check:attempt-b" }).taskReference));
test("24 independent re-check can retain parent trace", () => assert.equal(micro({ parentTaskReference: "micro_check:attempt-a" }).generated?.parentTaskReference, "micro_check:attempt-a"));
test("25 evidence snapshot omits objective answer key", () => assert.equal("objectivePayload" in taskSnapshotForEvidence(micro()), false));
test("26 evidence snapshot omits source answer key", () => assert.equal("sourceAnswer" in taskSnapshotForEvidence(source()), false));
test("27 evidence snapshot omits source evaluation criteria", () => assert.equal("sourceSuccessCriteria" in taskSnapshotForEvidence(source()), false));
test("28 canonical shape guard accepts frozen snapshot", () => assert.equal(isCanonicalTaskSnapshot(source()), true));
test("29 canonical shape guard rejects incomplete value", () => assert.equal(isCanonicalTaskSnapshot({ taskReference: "x" }), false));
test("30 textbook text wins over teacher edit for a source task", () => assert.equal(sourceTaskText({ exerciseTextVerbatim: "Տեքստ", exerciseTextEdited: "Փոփոխված", sourcePage: "2", exerciseId: "EX-2" }).prompt, "Տեքստ\n(Էջ 2, Վ. EX-2)"));
test("31 verbatim source whitespace is preserved exactly", () => assert.equal(sourceTaskText({ exerciseTextVerbatim: "  Տեքստ  ", exerciseTextEdited: "Փոփոխված", sourcePage: null, exerciseId: "EX-2" }).prompt, "  Տեքստ  \n(Էջ ?, Վ. EX-2)"));
test("32 edited text is only used when no verbatim source exists", () => assert.equal(sourceTaskText({ exerciseTextVerbatim: "", exerciseTextEdited: "Փոփոխված", sourcePage: null, exerciseId: "EX-2" }).learnerTextSource, "edited"));
test("33 source task without visible text fails closed", () => assert.throws(() => sourceTaskText({ exerciseTextVerbatim: "", exerciseTextEdited: "", sourcePage: null, exerciseId: "EX-2" })));
test("34 anticipatory constructed response is generated-task provenance", () => {
  const response = {
    is_micro_check: true,
    interaction_type: "constructed_response",
    student_message: "Բացատրի՛ր։",
    options: null,
  } as any;
  assert.equal(deriveGeneratedMicroCheckActivation(response, "generated_task:1")?.activeTaskProvenance, "constructed_response");
});
test("35 retry gets a new reference and matching attempt sequence", () => {
  const retry = createCanonicalTaskRetrySnapshot(micro(), {
    taskReference: "micro_check:attempt-b",
    attemptSequence: 2,
  });
  assert.equal(retry.taskReference, "micro_check:attempt-b");
  assert.equal(retry.attemptSequence, 2);
  assert.equal(retry.renderedPrompt, micro().renderedPrompt);
});
test("36 generated retry links to its immediate parent task", () => {
  const retry = createCanonicalTaskRetrySnapshot(micro(), {
    taskReference: "micro_check:attempt-b",
    attemptSequence: 2,
  });
  assert.equal(retry.generated?.parentTaskReference, "micro_check:attempt-a");
});
test("37 retry restores the fresh no-assistance baseline", () => {
  const retry = createCanonicalTaskRetrySnapshot(micro(), {
    taskReference: "micro_check:attempt-b",
    attemptSequence: 2,
  });
  assert.deepEqual(retry.assistanceBaseline, { helpCount: 0, assistanceLevel: "none" });
});
test("38 retry refuses to reuse an existing attempt sequence", () => {
  assert.throws(() => createCanonicalTaskRetrySnapshot(micro(), {
    taskReference: "micro_check:attempt-b",
    attemptSequence: 1,
  }));
});

let failed = 0;
for (const { name, run } of tests) {
  try {
    run();
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failed) process.exit(1);