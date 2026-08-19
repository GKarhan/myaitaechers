import assert from "node:assert/strict";
import {
  enforceActiveSourceExercise,
  resolveEligibleSourceExercise,
  shouldDeliverStandaloneSourceExercise,
} from "../exercise-delivery";

type Exercise = {
  id: number;
  exerciseId: string;
  exerciseTextVerbatim: string;
  sourcePage: number;
};

const eligibleExercises: Exercise[] = [
  {
    id: 940,
    exerciseId: "EX-579-1",
    exerciseTextVerbatim: "Առաջադրանք 1",
    sourcePage: 12,
  },
  {
    id: 941,
    exerciseId: "EX-579-2",
    exerciseTextVerbatim: "Առաջադրանք 2",
    sourcePage: 12,
  },
];

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error: any) {
    console.error(`  ✗ ${name}: ${error.message}`);
    failed++;
  }
}

console.log("\nsource-exercise activation:");

test("A — requested eligible EX-579-1 resolves to internal id 940", () => {
  const resolution = resolveEligibleSourceExercise(eligibleExercises, "EX-579-1");
  assert.equal(resolution.selected?.id, 940);
  assert.equal(resolution.resolution, "requested_eligible");
});

test("B — requested eligible EX-579-2 resolves to internal id 941", () => {
  const resolution = resolveEligibleSourceExercise(eligibleExercises, "EX-579-2");
  assert.equal(resolution.selected?.id, 941);
  assert.equal(resolution.selected?.exerciseId, "EX-579-2");
  assert.equal(resolution.resolution, "requested_eligible");
});

test("C — ineligible request falls back to an actual eligible row, never the requested identity", () => {
  const resolution = resolveEligibleSourceExercise(eligibleExercises, "EX-NOT-ELIGIBLE");
  assert.equal(resolution.selected?.id, 940);
  assert.equal(resolution.selected?.exerciseId, "EX-579-1");
  assert.notEqual(resolution.selected?.exerciseId, resolution.requestedExerciseId);
  assert.equal(resolution.resolution, "requested_not_eligible_fallback");
});

test("D — persisted id 940 selects EX-579-1 only for delivery", () => {
  const activeId = 940;
  const delivered = eligibleExercises.find((exercise) => exercise.id === activeId) ?? null;
  assert.equal(delivered?.exerciseId, "EX-579-1");
  assert.notEqual(delivered?.exerciseId, "EX-579-2");
});

test("E — persisted id 941 selects EX-579-2 only for delivery", () => {
  const activeId = 941;
  const delivered = eligibleExercises.find((exercise) => exercise.id === activeId) ?? null;
  assert.equal(delivered?.exerciseId, "EX-579-2");
  assert.notEqual(delivered?.exerciseId, "EX-579-1");
});

test("F — P11.1 delivery suppresses V2-R1.1 duplicate standalone delivery", () => {
  assert.equal(
    shouldDeliverStandaloneSourceExercise(true, 941, true),
    false,
    "P11.1 already delivered the active exercise in the primary assistant message",
  );
  assert.equal(
    shouldDeliverStandaloneSourceExercise(true, 941, false),
    true,
    "V2-R1.1 remains available only when P11.1 did not deliver it",
  );
});

test("G — requested EX-579-2 with EX-579-1 first renders only EX-579-2", () => {
  const selection = resolveEligibleSourceExercise(eligibleExercises, "EX-579-2");
  const activeExercise = selection.selected;
  assert.equal(activeExercise?.id, 941, "activation must persist EX-579-2's internal ID");

  // Simulates a stale model response that ignored the directive and printed the
  // first eligible exercise. P11.1 must remove it before backend delivery.
  const delivery = enforceActiveSourceExercise(
    `Շարունակենք։\n${eligibleExercises[0].exerciseTextVerbatim}`,
    activeExercise?.exerciseTextVerbatim,
    eligibleExercises
      .filter((exercise) => exercise.id !== activeExercise?.id)
      .map((exercise) => exercise.exerciseTextVerbatim),
  );

  assert.ok(!delivery.includes(eligibleExercises[0].exerciseTextVerbatim));
  assert.equal(
    delivery.split(eligibleExercises[1].exerciseTextVerbatim).length - 1,
    1,
    "exactly one active EX-579-2 delivery must remain",
  );
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);