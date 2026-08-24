import assert from "node:assert/strict";
import {
  resolveTargetCognitiveDemand,
  targetDemandAllowsGeneration,
} from "../c2-target-demand.js";

type Test = [string, () => void];
const tests: Test[] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

const resolve = (input: Partial<Parameters<typeof resolveTargetCognitiveDemand>[0]>) =>
  resolveTargetCognitiveDemand({
    title: "Թվեր",
    learningObjective: null,
    theoryContent: null,
    exercises: [],
    ...input,
  });

test("1. pure recall resolves to REMEMBER", () => {
  const decision = resolve({
    learningObjective: "Սովորողը սահմանում է բնական թիվը։",
    theoryContent: "Բնական թիվ է կոչվում հաշվելու համար օգտագործվող թիվը։",
    targetBloomLevel: 1,
  });
  assert.equal(decision.targetLevel, "remember");
  assert.equal(decision.confidence, "HIGH");
  assert.equal(decision.c1Relation, "MATCHES_C1");
});

test("2. explanation resolves to UNDERSTAND", () => {
  const decision = resolve({
    learningObjective: "Սովորողը բացատրում է թվերի միջև կապը։",
    theoryContent: "Տեքստը բացատրում է թվերի միջև հարաբերությունը և դրա պատճառը։",
    targetBloomLevel: 2,
  });
  assert.equal(decision.targetLevel, "understand");
  assert.equal(decision.confidence, "HIGH");
});

test("3. known routine execution resolves to APPLY", () => {
  const decision = resolve({
    learningObjective: "Սովորողը կիրառում է գումարման կանոնը։",
    theoryContent: "Գումարման կանոնը կիրառելով՝ հաշվարկում են արդյունքը քայլ առ քայլ։",
    targetBloomLevel: 3,
  });
  assert.equal(decision.targetLevel, "apply");
  assert.equal(decision.confidence, "HIGH");
});

test("4. relationship decomposition resolves to ANALYZE", () => {
  const decision = resolve({
    learningObjective: "Սովորողը համեմատում է երկու ներկայացումների կառուցվածքը։",
    theoryContent: "Աղբյուրը վերլուծում և համեմատում է ներկայացումների միջև կապը։",
    targetBloomLevel: 4,
  });
  assert.equal(decision.targetLevel, "analyze");
});

test("5. judgment with criteria resolves to EVALUATE", () => {
  const decision = resolve({
    learningObjective: "Սովորողը գնահատում է լուծման ճշտությունը չափանիշներով։",
    theoryContent: "Լուծման որակը գնահատվում է ճշտության չափանիշով։",
    targetBloomLevel: 5,
  });
  assert.equal(decision.targetLevel, "evaluate");
});

test("6. novel construction resolves to CREATE", () => {
  const decision = resolve({
    learningObjective: "Սովորողը ստեղծում է սեփական նոր մոդել։",
    theoryContent: "Առաջադրանքը պահանջում է նախագծել սեփական նոր մոդել։",
    targetBloomLevel: 6,
  });
  assert.equal(decision.targetLevel, "create");
});

test("7. an ambiguous verb resolves differently in different evidence contexts", () => {
  const recall = resolve({
    learningObjective: "Սովորողը որոշում է հասկացության սահմանումը։",
    theoryContent: "Հասկացությունը սահմանվում է որպես հիմնական կանոն։",
    targetBloomLevel: 1,
  });
  const routine = resolve({
    learningObjective: "Սովորողը որոշում է գործողության արդյունքը։",
    theoryContent: "Գումարման գործողությունը կիրառելով՝ հաշվարկում են արդյունքը։",
    targetBloomLevel: 3,
  });
  assert.equal(recall.targetLevel, "remember");
  assert.equal(routine.targetLevel, "apply");
});

test("8. C1 REMEMBER does not force strong application evidence downward", () => {
  const decision = resolve({
    title: "Կոորդինատային առանցքի երկայնքով տեղաշարժ",
    learningObjective: "Աշակերտը կարող է թվաբանական գործողությունները վերափոխել կոորդինատային առանցքի երկայնքով տեղաշարժի։",
    theoryContent: "Գումարումը ներկայացվում է որպես աջ շարժում, հանումը՝ ձախ շարժում, և հաշվարկում են ստացված արժեքը։",
    exercises: [{ exerciseText: "Վերափոխել գործողությունը կոորդինատային առանցքի շարժման և հաշվարկել արդյունքը։" }],
    targetBloomLevel: 1,
  });
  assert.equal(decision.targetLevel, "apply");
  assert.equal(decision.c1Relation, "RAISED_ABOVE_C1");
  assert.equal(targetDemandAllowsGeneration(decision), true);
});

test("9. C1 ANALYZE does not retain a higher target without source support", () => {
  const decision = resolve({
    learningObjective: "Սովորողը բացատրում է հասկացության նշանակությունը։",
    theoryContent: "Աղբյուրը բացատրում է հասկացության նշանակությունը և պատճառը։",
    targetBloomLevel: 4,
  });
  assert.equal(decision.targetLevel, "understand");
  assert.equal(decision.c1Relation, "LOWERED_BELOW_C1");
  assert.ok(decision.reviewReasons.includes("C1_TARGET_DISCREPANCY"));
});

test("10. objective/source conflict is explicit and cannot auto-generate", () => {
  const decision = resolve({
    learningObjective: "Սովորողը կիրառում է կանոնը նոր օրինակում։",
    theoryContent: "Կանոն է կոչվում գործողության հակիրճ սահմանումը։",
    targetBloomLevel: 3,
  });
  assert.equal(decision.targetLevel, "remember");
  assert.equal(decision.confidence, "LOW");
  assert.ok(decision.reviewReasons.includes("OBJECTIVE_SOURCE_CONFLICT"));
  assert.equal(targetDemandAllowsGeneration(decision), false);
});

test("11. multiple choice format does not force an analysis task down", () => {
  const decision = resolve({
    learningObjective: "Սովորողը համեմատում է ներկայացումների կառուցվածքը։",
    theoryContent: "Աղբյուրը համեմատում է ներկայացումների միջև կապը։",
    exercises: [{ exerciseText: "Բազմակի ընտրությամբ համեմատել տվյալների կառուցվածքը և ընտրել ճիշտ կապը։" }],
    targetBloomLevel: 4,
  });
  assert.equal(decision.targetLevel, "analyze");
  assert.ok(decision.evidence.includes("SOURCE_EXERCISE_DEMAND"));
});

test("12. clear objective and source resolve without exercises", () => {
  const decision = resolve({
    learningObjective: "Սովորողը բացատրում է կանոնի պատճառը։",
    theoryContent: "Տեքստը բացատրում է կանոնի պատճառը և դրա նշանակությունը։",
    canonicalOutcomes: ["Բացատրում է կանոնի նշանակությունը։"],
    targetBloomLevel: 2,
  });
  assert.equal(decision.targetLevel, "understand");
  assert.equal(decision.confidence, "HIGH");
  assert.ok(decision.evidence.includes("OUTCOME_PERFORMANCE"));
});

test("13. source exercises strengthen an otherwise vague objective", () => {
  const decision = resolve({
    learningObjective: "Սովորողը աշխատում է թվերի հետ։",
    theoryContent: "Գումարման կանոնը ներկայացված է որպես հաշվարկի ընթացակարգ։",
    exercises: [
      { exerciseText: "Կիրառել գումարման կանոնը և հաշվարկել արդյունքը։" },
      { exerciseText: "Վերափոխել գործողությունը և լուծել օրինակը։" },
    ],
    targetBloomLevel: 1,
  });
  assert.equal(decision.targetLevel, "apply");
  assert.equal(decision.c1Relation, "RAISED_ABOVE_C1");
  assert.ok(decision.evidence.includes("SOURCE_EXERCISE_DEMAND"));
});

test("14. identical evidence always produces the same structured decision", () => {
  const input = {
    learningObjective: "Սովորողը կիրառում է կանոնը։",
    theoryContent: "Կանոնը կիրառելով՝ հաշվարկում են արդյունքը։",
    exercises: [{ exerciseText: "Կիրառել կանոնը և հաշվարկել արդյունքը։" }],
    targetBloomLevel: 1,
  };
  assert.deepEqual(resolve(input), resolve(input));
});

test("15. conflicting approved outcome evidence is review-required", () => {
  const decision = resolve({
    learningObjective: "Սովորողը բացատրում է կանոնի պատճառը։",
    theoryContent: "Տեքստը բացատրում է կանոնի պատճառը և դրա նշանակությունը։",
    canonicalOutcomes: ["Ստեղծում է սեփական նոր մոդել։"],
    targetBloomLevel: 2,
  });
  assert.equal(decision.confidence, "LOW");
  assert.equal(targetDemandAllowsGeneration(decision), false);
  assert.ok(decision.reviewReasons.includes("OBJECTIVE_SOURCE_CONFLICT"));
});

test("16. an unrelated lower-level exercise cannot corroborate a higher source conflict", () => {
  const decision = resolve({
    learningObjective: "Սովորողը բացատրում է կանոնի պատճառը։",
    theoryContent: "Աղբյուրը վերլուծում և համեմատում է ներկայացումների կառուցվածքը։",
    exercises: [{ exerciseText: "Կիրառել կանոնը և հաշվարկել արդյունքը։" }],
    targetBloomLevel: 2,
  });
  assert.equal(decision.targetLevel, "understand");
  assert.equal(decision.confidence, "LOW");
  assert.equal(targetDemandAllowsGeneration(decision), false);
});

test("17. every trusted outcome must agree with the single target", () => {
  const decision = resolve({
    learningObjective: "Սովորողը ստեղծում է սեփական նոր մոդել։",
    theoryContent: "Առաջադրանքը պահանջում է նախագծել սեփական նոր մոդել։",
    canonicalOutcomes: [
      "Ստեղծում է սեփական նոր մոդել։",
      "Բացատրում է կանոնի նշանակությունը։",
    ],
    targetBloomLevel: 6,
  });
  assert.equal(decision.confidence, "LOW");
  assert.ok(decision.reviewReasons.includes("TRUSTED_OUTCOME_CONFLICT"));
  assert.equal(targetDemandAllowsGeneration(decision), false);
});

test("18. routine Armenian division resolves to APPLY rather than ANALYZE", () => {
  const decision = resolve({
    learningObjective: "Սովորողը բաժանում է 36-ը 6-ի և հաշվարկում արդյունքը։",
    theoryContent: "Բաժանումը կատարում են քայլ առ քայլ՝ 36-ը բաժանելով 6-ի։",
    exercises: [{ exerciseText: "Բաժանել 48-ը 8-ի և հաշվարկել պատասխանը։" }],
    targetBloomLevel: 3,
  });
  assert.equal(decision.targetLevel, "apply");
  assert.equal(decision.confidence, "HIGH");
});

test("19. contextual decomposition still resolves to ANALYZE", () => {
  const decision = resolve({
    learningObjective: "Սովորողը բաժանում է համակարգը բաղադրիչների և վերլուծում կապերը։",
    theoryContent: "Տեքստը բաժանում է կառուցվածքը բաղադրիչների և վերլուծում դրանց կապը։",
    exercises: [{ exerciseText: "Բաժանել կառուցվածքը մասերի և համեմատել բաղադրիչները։" }],
    targetBloomLevel: 4,
  });
  assert.equal(decision.targetLevel, "analyze");
  assert.equal(decision.confidence, "HIGH");
});

let passed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}
console.log(`C2 target demand: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exitCode = 1;