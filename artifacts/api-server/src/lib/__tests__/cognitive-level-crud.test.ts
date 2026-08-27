import assert from "node:assert/strict";
import { validateCognitiveLevelFields } from "../cognitive-level-crud.js";

const validFullForm = {
  cognitiveLevel: "apply",
  performanceObjective: "Կիրառել կանոնը նոր օրինակում։",
  successCriterion: "Ճիշտ լուծել առնվազն երեք անկախ առաջադրանք։",
  minimumIndependentEvidence: 3,
  preferredInteractionTypes: ["numeric_answer", "problem_solving"],
};

assert.equal(
  validateCognitiveLevelFields(validFullForm, { requireCognitiveLevel: true }),
  null,
  "manual create accepts the complete canonical field set",
);

assert.equal(
  validateCognitiveLevelFields(
    { ...validFullForm, cognitiveLevel: "analyze" },
    { requireCognitiveLevel: false },
  ),
  null,
  "edit accepts Bloom-level changes with the same field contract",
);

assert.equal(
  validateCognitiveLevelFields(
    { minimumIndependentEvidence: 0 },
    { requireCognitiveLevel: false },
  ),
  "minimumIndependentEvidence must be an integer >= 1",
);

assert.equal(
  validateCognitiveLevelFields(
    { minimumIndependentEvidence: 1.5 },
    { requireCognitiveLevel: false },
  ),
  "minimumIndependentEvidence must be an integer >= 1",
);

assert.equal(
  validateCognitiveLevelFields(
    { cognitiveLevel: "memorize" },
    { requireCognitiveLevel: false },
  ),
  "Invalid cognitive level",
);

assert.equal(
  validateCognitiveLevelFields(
    { preferredInteractionTypes: ["multiple_choice", "essay"] },
    { requireCognitiveLevel: false },
  ),
  "Invalid preferred interaction type",
);

assert.equal(
  validateCognitiveLevelFields(
    { performanceObjective: 42 },
    { requireCognitiveLevel: false },
  ),
  "performanceObjective must be a string or null",
);

assert.equal(
  validateCognitiveLevelFields({}, { requireCognitiveLevel: true }),
  "cognitiveLevel required",
);

assert.equal(
  validateCognitiveLevelFields({}, { requireCognitiveLevel: false }),
  null,
  "partial edits do not erase omitted fields",
);

console.log("Cognitive Level CRUD field-contract tests passed");