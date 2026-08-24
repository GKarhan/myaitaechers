import assert from "node:assert/strict";
import test from "node:test";
import {
  C2_PROGRESSION_CONTRACT_VERSION,
  assessCognitivePathProgression,
  inferCognitivePrerequisites,
} from "../c2-progression.js";
import type { TargetCognitiveDemand, TargetDemandLevel } from "../c2-target-demand.js";

const demand = (targetLevel: TargetDemandLevel): TargetCognitiveDemand => ({
  targetLevel,
  confidence: "HIGH",
  evidence: ["OBJECTIVE_PERFORMANCE", "SOURCE_PROCEDURE"],
  c1Relation: "MATCHES_C1",
  reviewReasons: [],
  resolverVersion: "c2-2.0",
});

const input = (
  targetLevel: TargetDemandLevel,
  theoryContent: string,
  learningObjective = `Learner can ${targetLevel}`,
) => ({
  targetDemand: demand(targetLevel),
  title: "Test MicroNode",
  learningObjective,
  theoryContent,
  exercises: [],
});

const level = (
  cognitiveLevel: TargetDemandLevel,
  sequence: number,
  target = false,
  objective = cognitiveLevel === "remember" ? "Recall source facts" : `Explain ${cognitiveLevel} evidence`,
  criterion = cognitiveLevel === "remember" ? "State source facts accurately" : `Correctly demonstrate ${cognitiveLevel} evidence`,
  interactionTypes = ["short_answer"],
) => ({
  cognitiveLevel,
  sequence,
  isTargetCeiling: target,
  performanceObjective: objective,
  successCriterion: criterion,
  minimumIndependentEvidence: 2,
  preferredInteractionTypes: interactionTypes,
});

test("C2P-1: REMEMBER target can remain target-only", () => {
  const decision = assessCognitivePathProgression(
    input("remember", "Սովորողը ճանաչում է թվային առանցքի նշանները։"),
    [level("remember", 1, true)],
  );
  assert.equal(decision.progressionDecision, "MINIMAL");
  assert.deepEqual(decision.selectedLevels, ["remember"]);
  assert.equal(decision.contractVersion, C2_PROGRESSION_CONTRACT_VERSION);
});

test("C2P-2: UNDERSTAND target includes factual recall only when explicitly required", () => {
  const result = assessCognitivePathProgression(
    input("understand", "Նախ հիշիր սահմանումը, ապա բացատրի՛ր դրա իմաստը։"),
    [
      level("remember", 1, false, "Հիշել սահմանումը", "Ճիշտ գրել սահմանումը"),
      level("understand", 2, true, "Բացատրել սահմանման իմաստը", "Բացատրել նշված իմաստը"),
    ],
  );
  assert.equal(result.progressionDecision, "MINIMAL");
  assert.deepEqual(result.selectedLevels, ["remember", "understand"]);
});

test("C2P-3: APPLY detects a conceptual prerequisite without mechanically adding REMEMBER", () => {
  const fixture = input(
    "apply",
    "Գումարումը համապատասխանում է աջ շարժմանը, իսկ հանումը՝ ձախ շարժմանը թվային առանցքի վրա։",
    "Սովորողը կկիրառի գործողությունը թվային առանցքի վրա։",
  );
  assert.deepEqual(inferCognitivePrerequisites(fixture), ["understand"]);
  const result = assessCognitivePathProgression(fixture, [
    level("understand", 1, false, "Բացատրել շարժման և գործողության կապը", "Նշել ճիշտ կապը"),
    level("apply", 2, true, "Կիրառել գործողությունը թվային առանցքի վրա", "Նշել ճիշտ ուղղությունը"),
  ]);
  assert.equal(result.progressionDecision, "MINIMAL");
  assert.deepEqual(result.selectedLevels, ["understand", "apply"]);
  assert.ok(result.progressionReasonCodes.includes("NON_CONTIGUOUS_LEVEL_JUSTIFIED"));
});

test("C2P-4: APPLY accepts an independently evidenced factual prerequisite", () => {
  const fixture = input("apply", "Նախ հիշիր բանաձևը, ապա կիրառիր այն հաշվարկում։");
  assert.deepEqual(inferCognitivePrerequisites(fixture), ["remember"]);
  const result = assessCognitivePathProgression(fixture, [
    level("remember", 1, false, "Հիշել բանաձևը", "Գրել ճիշտ բանաձևը"),
    level("apply", 2, true, "Կիրառել բանաձևը հաշվարկում", "Ստանալ ճիշտ արդյունքը"),
  ]);
  assert.equal(result.progressionDecision, "MINIMAL");
});

test("C2P-5: ANALYZE permits a non-contiguous UNDERSTAND → ANALYZE path", () => {
  const result = assessCognitivePathProgression(
    input("analyze", "Վերլուծիր ներկայացման մասերի հարաբերությունները և համեմատի՛ր դրանք։"),
    [
      level("understand", 1, false, "Բացատրել մասերի հարաբերությունը", "Նկարագրել հարաբերությունը"),
      level("analyze", 2, true, "Վերլուծել մասերի հարաբերությունները", "Տարբերել նշված հարաբերությունները"),
    ],
  );
  assert.equal(result.progressionDecision, "MINIMAL");
  assert.deepEqual(result.selectedLevels, ["understand", "analyze"]);
});

test("C2P-6: EVALUATE requires only the evidenced analytic checkpoint", () => {
  const result = assessCognitivePathProgression(
    input("evaluate", "Նախ վերլուծիր լուծումը, ապա գնահատիր այն տրված չափանիշներով։"),
    [
      level("analyze", 1, false, "Վերլուծել լուծումը", "Տարբերել լուծման մասերը"),
      level("evaluate", 2, true, "Գնահատել լուծումը", "Հիմնավորել որոշումը չափանիշներով"),
    ],
  );
  assert.equal(result.progressionDecision, "MINIMAL");
});

test("C2P-7: CREATE allows a direct target-only progression when no lower checkpoint is evidenced", () => {
  const result = assessCognitivePathProgression(
    input("create", "Ստեղծիր սեփական պատկերային մոդելը տրված գաղափարի համար։"),
    [level("create", 1, true, "Ստեղծել սեփական պատկերային մոդել", "Ներկայացնել աղբյուրին համապատասխան մոդել")],
  );
  assert.equal(result.progressionDecision, "MINIMAL");
  assert.deepEqual(result.selectedLevels, ["create"]);
});

test("C2P-8: redundant lower objectives are held for review", () => {
  const result = assessCognitivePathProgression(
    input("apply", "The learner applies a coordinate movement."),
    [
      level("understand", 1, false, "Explain coordinate movement", "Demonstrate coordinate movement"),
      level("apply", 2, true, "Apply coordinate movement", "Demonstrate coordinate movement"),
    ],
  );
  assert.equal(result.progressionDecision, "REVIEW_REQUIRED");
  assert.ok(result.reviewReasonCodes.includes("REDUNDANT_LEVEL"));
});

test("C2P-9: missing evidence-backed prerequisite prevents a target-only APPLY path", () => {
  const result = assessCognitivePathProgression(
    input("apply", "Գումարումը համապատասխանում է աջ շարժմանը թվային առանցքի վրա։"),
    [level("apply", 1, true, "Կիրառել գործողությունը", "Նշել ճիշտ ուղղությունը")],
  );
  assert.equal(result.progressionDecision, "REVIEW_REQUIRED");
  assert.ok(result.reviewReasonCodes.includes("MISSING_PREREQUISITE_LEVEL"));
});

test("C2P-10: target mismatch is review-required", () => {
  const result = assessCognitivePathProgression(
    input("apply", "Կիրառիր կանոնը հաշվարկում։"),
    [level("understand", 1, true)],
  );
  assert.ok(result.reviewReasonCodes.includes("TARGET_LEVEL_MISMATCH"));
});

test("C2P-11: lower-level overreach is rejected independent of interaction format", () => {
  const result = assessCognitivePathProgression(
    input("apply", "Գումարումը համապատասխանում է աջ շարժմանը թվային առանցքի վրա։"),
    [
      level("understand", 1, false, "Հաշվարկել շարժումը", "Լուծել շարժման քայլը", ["multiple_choice"]),
      level("apply", 2, true, "Կիրառել գործողությունը", "Նշել ճիշտ ուղղությունը", ["multiple_choice"]),
    ],
  );
  assert.ok(result.reviewReasonCodes.includes("LEVEL_OBJECTIVE_MISMATCH"));
});

test("C2P-12: interaction formats do not alter a valid minimal progression", () => {
  const fixture = input("apply", "Գումարումը համապատասխանում է աջ շարժմանը թվային առանցքի վրա։");
  const result = assessCognitivePathProgression(fixture, [
    level("understand", 1, false, "Բացատրել գործողության իմաստը", "Նշել ճիշտ համապատասխանությունը", ["multiple_choice"]),
    level("apply", 2, true, "Կիրառել գործողությունը", "Նշել ճիշտ ուղղությունը", ["multiple_choice"]),
  ]);
  assert.equal(result.progressionDecision, "MINIMAL");
});

test("C2P-13: progression assessment is deterministic for the node 2429 coordinate-axis fixture", () => {
  const fixture = input(
    "apply",
    "Թվային առանցքի վրա գումարումը համապատասխանում է աջ շարժմանը, իսկ հանումը՝ ձախ շարժմանը։",
    "Սովորողը կկիրառի գումարումն ու հանումը թվային առանցքի վրա։",
  );
  const levels = [
    level("understand", 1, false, "Բացատրել գործողության և շարժման համապատասխանությունը", "Ճիշտ կապել գործողությունն ու ուղղությունը"),
    level("apply", 2, true, "Կիրառել գործողությունը թվային առանցքի վրա", "Ճիշտ որոշել ստացված դիրքը"),
  ];
  assert.deepEqual(
    assessCognitivePathProgression(fixture, levels),
    assessCognitivePathProgression(fixture, levels),
  );
});

test("C2P-14: an unrelated conceptual checkpoint cannot satisfy a required prerequisite", () => {
  const result = assessCognitivePathProgression(
    input("apply", "The coordinate operation corresponds to movement along an axis."),
    [
      level("understand", 1, false, "Explain a geometric figure", "Describe a geometric figure"),
      level("apply", 2, true, "Apply the coordinate operation", "Determine the correct movement"),
    ],
  );
  assert.ok(result.reviewReasonCodes.includes("MISSING_PREREQUISITE_LEVEL"));
});

test("C2P-15: every lower level is bounded by its own Bloom demand", () => {
  const analyzeResult = assessCognitivePathProgression(
    input("analyze", "Analyze the source structure."),
    [
      level("apply", 1, false, "Evaluate the source structure", "Justify the evaluation"),
      level("analyze", 2, true, "Analyze the source structure", "Separate source components"),
    ],
  );
  const createResult = assessCognitivePathProgression(
    input("create", "Analyze the source structure before creating a model."),
    [
      level("analyze", 1, false, "Create a source model", "Design the source model"),
      level("create", 2, true, "Create a source model", "Present a source model"),
    ],
  );
  assert.ok(analyzeResult.reviewReasonCodes.includes("LEVEL_OBJECTIVE_MISMATCH"));
  assert.ok(createResult.reviewReasonCodes.includes("LEVEL_OBJECTIVE_MISMATCH"));
});

test("C2P-16: Armenian compose work cannot be hidden in an ANALYZE checkpoint", () => {
  const result = assessCognitivePathProgression(
    input("create", "Վերլուծիր կառուցվածքը և ստեղծիր մոդել։"),
    [
      level("analyze", 1, false, "Կազմել նոր մոդել", "Նախագծել մոդելը"),
      level("create", 2, true, "Ստեղծել մոդել", "Ներկայացնել մոդելը"),
    ],
  );
  assert.ok(result.reviewReasonCodes.includes("LEVEL_OBJECTIVE_MISMATCH"));
});

test("C2P-17: CREATE accepts a source-backed EVALUATE prerequisite when criteria demand it", () => {
  const result = assessCognitivePathProgression(
    input("create", "Նախ վերլուծիր մոդելը, նախ գնահատիր այն չափանիշներով, ապա ստեղծիր նոր մոդել։"),
    [
      level("analyze", 1, false, "Վերլուծել մոդելը", "Տարբերել մոդելի մասերը"),
      level("evaluate", 2, false, "Գնահատել մոդելը", "Հիմնավորել գնահատումը չափանիշներով"),
      level("create", 3, true, "Ստեղծել նոր մոդել", "Ներկայացնել նոր մոդել"),
    ],
  );
  assert.equal(result.progressionDecision, "MINIMAL");
});

test("C2P-18: Armenian composition references remain valid ANALYZE work", () => {
  const result = assessCognitivePathProgression(
    input("analyze", "Վերլուծիր բջջի կազմը և բացատրի՛ր դրա մասերի կապը։"),
    [
      level("understand", 1, false, "Բացատրել բջջի կազմը", "Նշել բջջի մասերը"),
      level("analyze", 2, true, "Վերլուծել բջջի կազմը", "Համեմատել բջջի մասերը"),
    ],
  );
  assert.equal(result.progressionDecision, "MINIMAL");
});

test("C2P-19: an explicit procedure is required before an EVALUATE target", () => {
  const fixture = input(
    "evaluate",
    "Նախ կիրառիր բանաձևը, ապա գնահատիր արդյունքը տրված չափանիշներով։",
  );
  assert.ok(inferCognitivePrerequisites(fixture).includes("apply"));
  const result = assessCognitivePathProgression(fixture, [
    level("evaluate", 1, true, "Գնահատել արդյունքը", "Հիմնավորել գնահատումը չափանիշներով"),
  ]);
  assert.ok(result.reviewReasonCodes.includes("MISSING_PREREQUISITE_LEVEL"));
});

test("C2P-20: an explicit procedure is required before a CREATE target", () => {
  const fixture = input(
    "create",
    "Նախ կիրառիր ընթացակարգը, ապա ստեղծիր նոր մոդել։",
  );
  assert.deepEqual(inferCognitivePrerequisites(fixture), ["apply"]);
  const result = assessCognitivePathProgression(fixture, [
    level("create", 1, true, "Ստեղծել նոր մոդել", "Ներկայացնել նոր մոդել"),
  ]);
  assert.ok(result.reviewReasonCodes.includes("MISSING_PREREQUISITE_LEVEL"));
});

test("C2P-21: a routine APPLY target can remain target-only", () => {
  const result = assessCognitivePathProgression(
    input("apply", "Կիրառիր կանոնը հաշվարկում։"),
    [level("apply", 1, true, "Կիրառել կանոնը", "Ստանալ ճիշտ արդյունքը")],
  );
  assert.equal(result.progressionDecision, "MINIMAL");
});

test("C2P-22: an EVALUATE target can remain target-only without an earlier dependency", () => {
  const result = assessCognitivePathProgression(
    input("evaluate", "Գնահատիր արդյունքը տրված չափանիշներով։"),
    [level("evaluate", 1, true, "Գնահատել արդյունքը", "Հիմնավորել գնահատումը չափանիշներով")],
  );
  assert.equal(result.progressionDecision, "MINIMAL");
});

test("C2P-23: standalone criteria language does not force a lower CREATE checkpoint", () => {
  const result = assessCognitivePathProgression(
    input("create", "Ստեղծիր նոր մոդել տրված չափանիշներով։"),
    [level("create", 1, true, "Ստեղծել նոր մոդել", "Ներկայացնել մոդել չափանիշներով")],
  );
  assert.equal(result.progressionDecision, "MINIMAL");
});

test("C2P-24: objective-only dependency wording cannot force an unsupported lower checkpoint", () => {
  const result = assessCognitivePathProgression(
    input("apply", "Կիրառիր կանոնը հաշվարկում։", "Նախ բացատրի՛ր կանոնը, ապա կիրառիր այն։"),
    [level("apply", 1, true, "Կիրառել կանոնը", "Ստանալ ճիշտ արդյունքը")],
  );
  assert.equal(result.progressionDecision, "MINIMAL");
});