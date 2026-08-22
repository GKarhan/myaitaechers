import assert from "node:assert/strict";
import {
  classifyMicroNodeSourceAlignment,
  pedagogicalNearDuplicate,
} from "../micronode-source-alignment.js";
import { validateCognitivePathGrounding } from "../cognitive-path-grounding.js";
import {
  applyBoundedSourceReallocation,
  consolidateHighConfidenceOverSplits,
  validatePass2SourceAlignment,
  type Pass2TopicResult,
} from "../../services/lesson-mapping.js";

function topic(nodes: Pass2TopicResult["microNodes"]): Pass2TopicResult {
  return {
    sequence: 1, title: "Թեմա", topicType: "knowledge", inputBlockIndices: [0, 1, 2],
    microNodes: nodes, unmappedBlockIndices: [], additionalExercises: [],
  };
}
function node(title: string, learningObjective: string, index: number) {
  return {
    title, learningObjective, microNodeType: "knowledge" as const,
    sourceBlockIndices: [index], exercises: [], supportingMaterialIndices: [],
  };
}

for (const [left, right] of [
  ["Շենքերի համարակալման սկզբունքները", "Շենքերի հասցեներ և համարակալման սկզբունքներ"],
  ["Կենտ և զույգ համարների տարբերակումը", "Կենտ և զույգ համարներով շենքերի դասավորություն"],
  ["Հասցեի որոշումը շենքերի միջև", "Նոր շենքի հասցեի որոշում"],
]) {
  assert.equal(
    pedagogicalNearDuplicate(
      { title: left, learningObjective: left },
      { title: right, learningObjective: right },
    ),
    true,
  );
}
console.log("  ✓ Armenian near-duplicate objectives are semantic consolidation candidates");

{
  const topics = [topic([
    node("Կանոն", "Բացատրում է շենքերի համարակալման կանոնը։", 0),
    node("Կանոնի ներկայացում", "Բացատրում է շենքերի համարակալման կանոնը։", 1),
  ])];
  const result = consolidateHighConfidenceOverSplits(topics, [{
    topicTitle: "Թեմա",
    microNodeTitle: "Կանոնի ներկայացում",
    mergeIntoMicroNodeTitle: "Կանոն",
    issue: "OVER_SPLIT",
    confidence: "HIGH",
    reason: "Նույն նպատակի բառային տարբերակ։",
  }]);
  assert.equal(result.mergedMicroNodeCount, 1);
  assert.deepEqual(topics[0].microNodes[0].sourceBlockIndices, [0, 1]);
  console.log("  ✓ one bounded semantic merge preserves all source ownership");
}

{
  assert.equal(
    classifyMicroNodeSourceAlignment("Կիրառում է կենտ և զույգ համարների կանոնը։", [
      { blockType: "OBJECTIVE", sourceText: "Կենտ և զույգ համարներ" },
    ]).status,
    "INSUFFICIENT",
  );
  assert.notEqual(
    classifyMicroNodeSourceAlignment("Որոշում է նոր շենքի հասցեն։", [
      { blockType: "NOTE", sourceText: "Մոկին կարևոր էր իր հասցեի թուղթը ծննդյան օրվա համար։" },
    ]).status,
    "SUFFICIENT",
  );
  assert.equal(
    classifyMicroNodeSourceAlignment("Բացատրում է նոր շենքի հասցեի գրառումը։", [
      { blockType: "RULE", sourceText: "Նոր շենքի հասցեի գրառումը կարող է լինել 5/1 ձևով՝ առանց հին համարները փոխելու։" },
    ]).status,
    "SUFFICIENT",
  );
  assert.equal(
    classifyMicroNodeSourceAlignment("Բացատրում է կանոնը։", [
      { blockType: "RULE", sourceText: "?հարց ?հարց ?հարց" },
    ]).status,
    "UNREADABLE",
  );
  console.log("  ✓ headings, unrelated narrative, and malformed text cannot ground an objective");
}

const addressSource = "Նոր շենքի հասցեի գրառումը կարող է լինել 5/1 ձևով՝ առանց հին համարները փոխելու։";
const grounded = validateCognitivePathGrounding(addressSource, "Բացատրում է նոր շենքի հասցեի գրառումը։", [{
  performanceObjective: "Բացատրում է նոր շենքի 5/1 հասցեի գրառումը։",
  successCriterion: "Ճիշտ է բացատրում 5/1 հասցեի գրառումը։",
  preferredInteractionTypes: ["short_answer"],
}]);
assert.equal(grounded.status, "GROUNDED");
console.log("  ✓ source-backed Cognitive Path paraphrase passes");

for (const bad of ["24 և 28 թվերի միջև որոշում է 26 հասցեն։", "Կիրառում է 7/2 հասցեի կանոնը։"]) {
  const audit = validateCognitivePathGrounding(addressSource, "Բացատրում է նոր շենքի հասցեի գրառումը։", [{
    performanceObjective: bad,
    successCriterion: bad,
    preferredInteractionTypes: ["problem_solving"],
  }]);
  assert.equal(audit.status, "INVALID");
}
console.log("  ✓ unsupported numeric addressing rules are rejected");

{
  const audit = validateCognitivePathGrounding(addressSource, "Բացատրում է նոր շենքի հասցեի գրառումը։", [{
    performanceObjective: "Վերլուծում է լրիվ այլ քաղաքային իրավիճակ։",
    successCriterion: "Հիմնավորում է իր եզրակացությունը։",
    preferredInteractionTypes: ["constructed_response"],
  }]);
  assert.equal(audit.status, "REVIEW_REQUIRED");
  console.log("  ✓ uncertain inference requires review rather than auto-approval");
}

const sourceBlocks = (rows: Array<{ blockType: string; sourceText: string }>) => rows.map((row, index) => ({
  ...row, sourcePage: 11 + index, sourceParagraph: null, sourceBoundingBox: null,
})) as any;

{
  const objective = "Բացատրում է փողոցի ձախ կողմի կենտ և աջ կողմի զույգ համարակալման կանոնը։";
  const topics = [topic([{
    ...node("Կենտ և զույգ համարների կանոն", objective, 0),
    exercises: [{ blockIndex: 2, sourceParagraph: null }],
  }])];
  const blocks = sourceBlocks([
    { blockType: "OBJECTIVE", sourceText: "Շենքերի համարակալում" },
    { blockType: "RULE", sourceText: "Փողոցի ձախ կողմի շենքերը ստանում են կենտ, իսկ աջ կողմի շենքերը՝ զույգ համարներ։" },
    { blockType: "EXERCISE", sourceText: "Գտեք ճիշտ կողմը։" },
  ]);
  assert.equal(validatePass2SourceAlignment(topics, blocks).valid, false);
  const repair = applyBoundedSourceReallocation(topics, blocks, [{
    topicTitle: "Թեմա", microNodeTitle: "Կենտ և զույգ համարների կանոն",
    action: "ADD_SUPPORTING_BLOCKS", sourceBlockIndices: [1], reason: "Ուղղակի կանոնային բացատրություն",
  }]);
  assert.equal(repair.appliedCount, 1);
  assert.deepEqual(topics[0].microNodes[0].sourceBlockIndices, [0, 1]);
  assert.equal(topics[0].microNodes[0].exercises.length, 1);
  assert.equal(validatePass2SourceAlignment(topics, blocks).valid, true);
  console.log("  ✓ heading-only ownership is repaired from a same-lesson rule without losing exercises");
}

{
  const objective = "Որոշում է նոր շենքի հասցեն 5/1 կանոնով։";
  const topics = [topic([node("Նոր շենքի հասցե", objective, 0)])];
  const blocks = sourceBlocks([
    { blockType: "NOTE", sourceText: "Մոկին ծննդյան օրվա համար կարևոր էր հասցեի թուղթը։" },
    { blockType: "RULE", sourceText: "Նոր շենքի հասցեն գրվում է 5/1 ձևով, երբ այն գտնվում է հինգերորդ շենքից հետո։" },
  ]);
  const repair = applyBoundedSourceReallocation(topics, blocks, [{
    topicTitle: "Թեմա", microNodeTitle: "Նոր շենքի հասցե",
    action: "ADD_SUPPORTING_BLOCKS", sourceBlockIndices: [1], reason: "Պատմությունը կանոն չի բացատրում",
  }]);
  assert.equal(repair.appliedCount, 1);
  assert.equal(validatePass2SourceAlignment(topics, blocks).valid, true);
  console.log("  ✓ narrative mismatch is repaired only with the direct same-lesson rule");
}

{
  const topics = [topic([node("Չգոյություն ունեցող կանոն", "Կիրառում է չգրված գաղտնի կանոնը։", 0)])];
  const blocks = sourceBlocks([{ blockType: "NOTE", sourceText: "Սա հասցեի կարևորության մասին պատմություն է։" }]);
  const repair = applyBoundedSourceReallocation(topics, blocks, [{
    topicTitle: "Թեմա", microNodeTitle: "Չգոյություն ունեցող կանոն",
    action: "NO_VALID_SUPPORT_FOUND", sourceBlockIndices: [], reason: "Դասում այդ կանոնը չկա",
  }]);
  assert.equal(repair.appliedCount, 0);
  assert.equal(validatePass2SourceAlignment(topics, blocks).valid, false);
  console.log("  ✓ no-support result remains unresolved and does not fabricate a source");
}

{
  const topics = [topic([node("Կանոն", "Բացատրում է հասցեի կանոնը։", 1)])];
  const blocks = sourceBlocks([
    { blockType: "RULE", sourceText: "?հարց ?հարց ?հարց" },
    { blockType: "OBJECTIVE", sourceText: "Հասցե" },
  ]);
  const repair = applyBoundedSourceReallocation(topics, blocks, [{
    topicTitle: "Թեմա", microNodeTitle: "Կանոն",
    action: "ADD_SUPPORTING_BLOCKS", sourceBlockIndices: [0], reason: "Անթույլատրելի աղավաղված աղբյուր",
  }]);
  assert.equal(repair.appliedCount, 0);
  assert.equal(repair.rejectedDecisionCount, 1);
  console.log("  ✓ malformed blocks can never become semantic repair authority");
}

console.log("\nFix #6A granularity, grounding, and bounded reallocation: 11/11 passing");