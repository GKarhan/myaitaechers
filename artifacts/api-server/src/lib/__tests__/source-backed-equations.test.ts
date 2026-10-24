import assert from "node:assert/strict";
import {validateCognitivePathGrounding,getHighConfidenceLearningObjectiveFloor} from "../cognitive-path-grounding.js";
const source="Մարմնի երկարության չափման արդյունքը՝ l = (4,1 ± 0,05) սմ։ Չափման սխալը կախված է սանդղակի բաժանման արժեքից։";
const objective="Հաշվել չափման սխալը։";
const audit=(criterion:string)=>validateCognitivePathGrounding(source,objective,[{
 performanceObjective:objective,successCriterion:criterion,preferredInteractionTypes:["numeric_answer"],
}]);
assert.equal(audit("Ճիշտ արտահայտում է չափման արդյունքը՝ l = (4.1 ± 0.05) սմ։").status,"GROUNDED");
assert.ok(audit("Ճիշտ արտահայտում է չափման արդյունքը՝ x = (4.1 ± 0.05) սմ։").issueCounts.NON_ARMENIAN_REQUIRED_TEXT);
assert.ok(audit("Ճիշտ արտահայտում է չափման արդյունքը՝ l = (4.1 ± 0.25) սմ։").issueCounts.NON_ARMENIAN_REQUIRED_TEXT);
assert.ok(audit("Answer correctly՝ չափման արդյունքը l = (4.1 ± 0.05) սմ։").issueCounts.NON_ARMENIAN_REQUIRED_TEXT);
assert.ok(audit("Ճիշտ արտահայտում է չափման արդյունքը՝ ll = (4.1 ± 0.05) սմ։").issueCounts.NON_ARMENIAN_REQUIRED_TEXT);
assert.ok(audit("Ճիշտ արտահայտում է չափման արդյունքը՝ l = (9.1 ± 0.05) սմ։").issueCounts.NOVEL_NUMERIC_CLAIM);
console.log("PASS source-backed equations: decimal formatting accepted; invented variables, equations and non-Armenian prose remain blocked");

assert.equal(getHighConfidenceLearningObjectiveFloor("Բացատրել Միավորների միջազգային համակարգի ստեղծման նպատակը և կարևորությունը։"),null);
assert.equal(getHighConfidenceLearningObjectiveFloor("Ստեղծել սեփական խնդիր։"),"create");
assert.equal(getHighConfidenceLearningObjectiveFloor("Ստեղծում է սեփական խնդիր։"),"create");
assert.equal(getHighConfidenceLearningObjectiveFloor("Հաշվարկել չափման սխալը։"),"apply");
assert.equal(getHighConfidenceLearningObjectiveFloor("Բացատրել հաշվարկման կանոնը։"),null);
console.log("PASS objective verbs: creation/calculation nouns do not invent Create/Apply demands; explicit verbs still establish floors");
