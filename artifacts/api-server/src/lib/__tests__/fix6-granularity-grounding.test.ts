import assert from "node:assert/strict";
import {
  classifyMicroNodeSourceAlignment,
  pedagogicalNearDuplicate,
} from "../micronode-source-alignment.js";
import { validateCognitivePathGrounding } from "../cognitive-path-grounding.js";
import { consolidateHighConfidenceOverSplits, type Pass2TopicResult } from "../../services/lesson-mapping.js";

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

console.log("\nFix #6 granularity and grounding: 7/7 passing");