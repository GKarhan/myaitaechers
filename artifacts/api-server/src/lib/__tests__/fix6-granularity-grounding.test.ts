import assert from "node:assert/strict";
import {
  classifyMicroNodeSourceAlignment,
  pedagogicalNearDuplicate,
} from "../micronode-source-alignment.js";
import { validateCognitivePathGrounding } from "../cognitive-path-grounding.js";
import {
  applyBoundedSourceReallocation,
  consolidateHighConfidenceOverSplits,
  reconcileSameTopicSourceAlignment,
  removeStructuralHeadingSourceOwnership,
  validatePass2SourceAlignment,
  type Pass2TopicResult,
} from "../../services/lesson-mapping.js";
import { validateSourceCoverage } from "../coverage-validator.js";

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

{
  const topics = [topic([{
    ...node("Թվերի կարգեր", "Բացատրում է 10 թվանշանով կարգերի կանոնը։", 0),
    candidateId: "t1:n0:split1",
  }])];
  const blocks = [{
    blockType: "RULE" as const,
    sourceText: "Թվերի կարգերը որոշում են թվի տեղը գրության մեջ։",
    sourcePage: 14,
    sourceParagraph: null,
    sourceBoundingBox: null,
  }];
  const alignment = validatePass2SourceAlignment(topics, blocks);
  const entry = alignment.nodes[0];
  assert.equal(entry.audit.status, "PARTIAL");
  assert.equal(entry.microNodeId, "t1:n0:split1");
  assert.equal(entry.microNodeTitle, "Թվերի կարգեր");
  assert.equal(entry.learningObjective, "Բացատրում է 10 թվանշանով կարգերի կանոնը։");
  assert.deepEqual(entry.sourceBlockIndices, [0]);
  assert.deepEqual(entry.sourcePages, [14]);
  assert.ok(entry.missingObjectiveConceptLabels.length > 0);
  assert.equal("sourceText" in entry, false);
  console.log("  ✓ non-sufficient audit exposes safe node/source metadata without textbook excerpts");
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
  const topics = [topic([{
    ...node("Կենտ և զույգ համարների կանոն", "Բացատրում է կենտ և զույգ համարների կանոնը։", 0),
    sourceBlockIndices: [0, 1],
    exercises: [{ blockIndex: 2, sourceParagraph: null }],
  }])];
  const blocks = sourceBlocks([
    { blockType: "OBJECTIVE", sourceText: "Շենքերի համարակալում" },
    { blockType: "RULE", sourceText: "Փողոցի ձախ կողմի շենքերը ստանում են կենտ, իսկ աջ կողմի շենքերը՝ զույգ համարներ։" },
    { blockType: "EXERCISE", sourceText: "Գտեք ճիշտ կողմը։" },
  ]);
  const repair = removeStructuralHeadingSourceOwnership(topics, blocks);
  assert.deepEqual(repair.movedHeadingIndices, [0]);
  assert.equal(repair.removedMicroNodeTitles.length, 0);
  assert.deepEqual(topics[0].microNodes[0].sourceBlockIndices, [1]);
  assert.deepEqual(topics[0].unmappedBlockIndices, [0]);
  assert.equal(topics[0].microNodes[0].exercises[0].blockIndex, 2);
  assert.equal(validatePass2SourceAlignment(topics, blocks).valid, true);
  assert.equal(validateSourceCoverage(blocks.length, topics).valid, true);
  console.log("  ✓ structural heading is unowned while the direct source and exercise stay intact");
}

{
  const topics = [topic([
    {
      ...node("Անվավեր heading node", "Բացատրում է համարակալման կանոնը։", 0),
      exercises: [{ blockIndex: 1, sourceParagraph: null }],
    },
    node("Կանոն", "Բացատրում է կենտ և զույգ համարների կանոնը։", 2),
  ])];
  const blocks = sourceBlocks([
    { blockType: "OBJECTIVE", sourceText: "Շենքերի համարակալում" },
    { blockType: "EXERCISE", sourceText: "Գտեք ճիշտ կողմը։" },
    { blockType: "RULE", sourceText: "Փողոցի ձախ կողմի շենքերը ստանում են կենտ, իսկ աջ կողմի շենքերը՝ զույգ համարներ։" },
  ]);
  const repair = removeStructuralHeadingSourceOwnership(topics, blocks);
  assert.deepEqual(repair.removedMicroNodeTitles, ["Անվավեր heading node"]);
  assert.deepEqual(repair.rescuedExerciseIndices, [1]);
  assert.equal(topics[0].microNodes.length, 1);
  assert.deepEqual(topics[0].unmappedBlockIndices, [0]);
  assert.equal(topics[0].additionalExercises[0].blockIndex, 1);
  assert.equal(validateSourceCoverage(blocks.length, topics).valid, true);
  console.log("  ✓ source-less heading node is removed without dropping its exercise");
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
  const broadObjective = "Բացատրում է 10 թվանշանով կարգերի կանոնը։";
  const revisedObjective = "Բացատրում է թվերի կարգերը գրության մեջ։";
  const topics = [topic([node("Թվերի կարգեր", broadObjective, 0)])];
  const blocks = sourceBlocks([
    { blockType: "RULE", sourceText: "Թվերի կարգերը որոշում են թվի տեղը գրության մեջ։" },
  ]);
  assert.equal(validatePass2SourceAlignment(topics, blocks).valid, false);
  const repair = applyBoundedSourceReallocation(topics, blocks, [{
    topicTitle: "Թեմա",
    microNodeTitle: "Թվերի կարգեր",
    action: "NARROW_OBJECTIVE",
    sourceBlockIndices: [],
    learningObjective: revisedObjective,
    reason: "Աղբյուրը բացատրում է միայն գրության մեջ կարգերի տեղը",
  }]);
  assert.equal(repair.appliedCount, 1);
  assert.equal(topics[0].microNodes[0].learningObjective, revisedObjective);
  assert.equal(validatePass2SourceAlignment(topics, blocks).valid, true);
  console.log("  ✓ objective is narrowed only when the retained source directly supports it");
}

{
  const originalObjective = "Բացատրում է 10 թվանշանով կարգերի կանոնը։";
  const topics = [topic([node("Թվերի կարգեր", originalObjective, 0)])];
  const blocks = sourceBlocks([
    { blockType: "RULE", sourceText: "Թվերի կարգերը որոշում են թվի տեղը գրության մեջ։" },
  ]);
  const repair = applyBoundedSourceReallocation(topics, blocks, [{
    topicTitle: "Թեմա",
    microNodeTitle: "Թվերի կարգեր",
    action: "NARROW_OBJECTIVE",
    sourceBlockIndices: [],
    learningObjective: "Կիրառում է միլիոնների կանոնը։",
    reason: "Չի թույլատրվում",
  }]);
  assert.equal(repair.appliedCount, 0);
  assert.equal(repair.rejectedDecisionCount, 1);
  assert.equal(topics[0].microNodes[0].learningObjective, originalObjective);
  console.log("  ✓ unsupported objective rewrite is rejected without mutating the MicroNode");
}

{
  const targetObjective = "Բացատրում է բնական թվերի շարքի հաջորդ թիվը։";
  const donorObjective = "Բացատրում է հաջորդ թիվը։";
  const topics = [topic([
    {
      ...node("Թվերի աճման կանոն", targetObjective, 0),
      exercises: [{ blockIndex: 3, sourceParagraph: null }],
    },
    {
      ...node("Հաջորդականության կանոն", donorObjective, 1),
      sourceBlockIndices: [1, 2],
    },
  ])];
  const blocks = sourceBlocks([
    { blockType: "NOTE", sourceText: "Բնական թվերի մասին կարճ նշում։" },
    { blockType: "RULE", sourceText: "Բնական թվերի շարքի յուրաքանչյուր հաջորդ թիվը մեկով մեծ է նախորդից։" },
    { blockType: "RULE", sourceText: "Յուրաքանչյուր հաջորդ թիվը գրվում է հերթով։" },
    { blockType: "EXERCISE", sourceText: "Շարունակեք բնական թվերի շարքը։" },
  ]);
  assert.equal(validatePass2SourceAlignment(topics, blocks).valid, false);
  const reconciliation = reconcileSameTopicSourceAlignment(topics, blocks);
  assert.equal(reconciliation.appliedCount, 1);
  assert.deepEqual(reconciliation.dispositions, [{
    topicSequence: 1,
    microNodeId: "t1:n0",
    microNodeTitle: "Թվերի աճման կանոն",
    status: "REPAIRED",
    sourceBlockIndices: [1],
  }]);
  assert.deepEqual(topics[0].microNodes[0].sourceBlockIndices, [0, 1]);
  assert.deepEqual(topics[0].microNodes[1].sourceBlockIndices, [2]);
  assert.equal(topics[0].microNodes[0].exercises[0].blockIndex, 3);
  assert.equal(validatePass2SourceAlignment(topics, blocks).valid, true);
  assert.equal(validateSourceCoverage(blocks.length, topics).valid, true);
  console.log("  ✓ one verified same-topic move repairs ownership while preserving donor and exercise evidence");
}

{
  const topics = [topic([
    node("Թվերի աճման կանոն", "Բացատրում է բնական թվերի շարքի հաջորդ թիվը։", 0),
    node("Հաջորդականության կանոն", "Բացատրում է հաջորդ թիվը։", 1),
  ])];
  const blocks = sourceBlocks([
    { blockType: "NOTE", sourceText: "Բնական թվերի մասին կարճ նշում։" },
    { blockType: "RULE", sourceText: "Բնական թվերի շարքի յուրաքանչյուր հաջորդ թիվը մեկով մեծ է նախորդից։" },
  ]);
  const reconciliation = reconcileSameTopicSourceAlignment(topics, blocks);
  assert.equal(reconciliation.appliedCount, 0);
  assert.equal(reconciliation.dispositions[0].status, "NO_SAFE_SAME_TOPIC_REALLOCATION");
  assert.deepEqual(topics[0].microNodes[1].sourceBlockIndices, [1]);
  assert.equal(validatePass2SourceAlignment(topics, blocks).valid, false);
  console.log("  ✓ move that would break the previous owner is rejected with an explicit disposition");
}

{
  const topics = [topic([
    node("Թվերի աճման կանոն", "Բացատրում է բնական թվերի շարքի հաջորդ թիվը։", 0),
    node("Այլ կանոն", "Բացատրում է հաջորդ թիվը։", 1),
  ])];
  topics[0].inputBlockIndices = [0, 1];
  const blocks = sourceBlocks([
    { blockType: "NOTE", sourceText: "Բնական թվերի մասին կարճ նշում։" },
    { blockType: "RULE", sourceText: "Այլ կանոն՝ թվերի հերթականության մասին։" },
    { blockType: "RULE", sourceText: "Բնական թվերի շարքի յուրաքանչյուր հաջորդ թիվը մեկով մեծ է նախորդից։" },
  ]);
  topics[0].microNodes[1].sourceBlockIndices = [2];
  const reconciliation = reconcileSameTopicSourceAlignment(topics, blocks);
  assert.equal(reconciliation.appliedCount, 0);
  assert.equal(reconciliation.dispositions[0].status, "NO_SAFE_SAME_TOPIC_REALLOCATION");
  assert.deepEqual(topics[0].microNodes[1].sourceBlockIndices, [2]);
  console.log("  ✓ out-of-topic source is never considered for reconciliation");
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

console.log("\nFix #6A granularity, grounding, and bounded reallocation: 17/17 passing");