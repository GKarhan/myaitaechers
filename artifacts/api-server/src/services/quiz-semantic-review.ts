import { openrouter } from "@workspace/integrations-openrouter-ai";
import {
  COGNITIVE_LEVELS,
  QUALITY_REASON_CODES,
  type QualityReasonCode,
  type SemanticQuestionReviewInput,
  type SemanticQuestionReviewResult,
} from "./quiz-question-quality.js";

const MODEL = "deepseek/deepseek-chat-v3-0324";
const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "verdict",
    "reasonCodes",
    "measuredCognitiveLevel",
    "nodeAligned",
    "objectiveAligned",
    "criterionAligned",
    "interactionCompatible",
    "sourceGrounded",
  ],
  properties: {
    verdict: { type: "string", enum: ["PASS", "FAIL", "REVIEW_ERROR"] },
    reasonCodes: {
      type: "array",
      items: { type: "string", enum: [...QUALITY_REASON_CODES] },
    },
    measuredCognitiveLevel: {
      type: ["string", "null"],
      enum: [...COGNITIVE_LEVELS, null],
    },
    nodeAligned: { type: "boolean" },
    objectiveAligned: { type: "boolean" },
    criterionAligned: { type: "boolean" },
    interactionCompatible: { type: "boolean" },
    sourceGrounded: { type: "boolean" },
  },
} as const;

const SYSTEM_PROMPT = [
  "Դու quiz-question-semantic-reviewer ծառայությունն ես։",
  "Դու անկախ ստուգող ես, ոչ թե հարցերի ստեղծող։ Ստուգիր մեկ արդեն գեներացված հարցը։",
  "Օգտագործիր միայն ներկայացված MicroNode-ի նյութը, նպատակը, չափանիշը և canonical cognitive target-ը։",
  "PASS տուր միայն այն դեպքում, երբ հարցը աղբյուրով հիմնավորված է, ճիշտ MicroNode-ին է վերաբերում,",
  "համապատասխանում է նպատակին ու հաջողության չափանիշին, multiple choice-ի համար բնական է,",
  "և պահանջում է հենց նշված cognitive level-ի գործառույթը։ Ցածր մակարդակի փոխարինողը FAIL է։",
  "Մի՛ փոխիր canonical target-ը և մի՛ առաջարկիր նոր հարց։",
  "Պատասխանիր միայն պահանջվող JSON օբյեկտով։ Մի՛ ներառիր բացատրություն կամ hidden reasoning։",
  "reasonCodes-ում օգտագործիր միայն allowlist-ի կոդերը։",
].join("\n");

function isQualityReasonCode(value: unknown): value is QualityReasonCode {
  return typeof value === "string"
    && (QUALITY_REASON_CODES as readonly string[]).includes(value);
}

function isCognitiveLevel(value: unknown): value is SemanticQuestionReviewResult["measuredCognitiveLevel"] {
  return value === null
    || (typeof value === "string" && (COGNITIVE_LEVELS as readonly string[]).includes(value));
}

function parseReview(value: unknown): SemanticQuestionReviewResult | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (!["PASS", "FAIL", "REVIEW_ERROR"].includes(String(candidate.verdict))) return null;
  if (!Array.isArray(candidate.reasonCodes) || !candidate.reasonCodes.every(isQualityReasonCode)) {
    return null;
  }
  if (!isCognitiveLevel(candidate.measuredCognitiveLevel)) return null;
  const flags = [
    candidate.nodeAligned,
    candidate.objectiveAligned,
    candidate.criterionAligned,
    candidate.interactionCompatible,
    candidate.sourceGrounded,
  ];
  if (!flags.every((flag) => typeof flag === "boolean")) return null;
  return {
    verdict: candidate.verdict as SemanticQuestionReviewResult["verdict"],
    reasonCodes: [...new Set(candidate.reasonCodes)],
    ...(candidate.measuredCognitiveLevel === null
      ? {}
      : {
        measuredCognitiveLevel:
          candidate.measuredCognitiveLevel as SemanticQuestionReviewResult["measuredCognitiveLevel"],
      }),
    nodeAligned: candidate.nodeAligned as boolean,
    objectiveAligned: candidate.objectiveAligned as boolean,
    criterionAligned: candidate.criterionAligned as boolean,
    interactionCompatible: candidate.interactionCompatible as boolean,
    sourceGrounded: candidate.sourceGrounded as boolean,
  };
}

function reviewError(): SemanticQuestionReviewResult {
  return {
    verdict: "REVIEW_ERROR",
    reasonCodes: ["SEMANTIC_REVIEW_ERROR"],
    nodeAligned: false,
    objectiveAligned: false,
    criterionAligned: false,
    interactionCompatible: false,
    sourceGrounded: false,
  };
}

/**
 * Independent semantic review. The raw provider response is deliberately
 * reduced to the bounded contract and is never returned to persistence or
 * callers. Any provider/schema/parse failure is a safe fail-closed verdict.
 */
export async function reviewGeneratedQuestion(
  input: SemanticQuestionReviewInput,
): Promise<SemanticQuestionReviewResult> {
  try {
    const response = await openrouter.chat.completions.create({
      model: MODEL,
      max_tokens: 8192,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "quiz_question_semantic_review",
          strict: true,
          schema: REVIEW_SCHEMA,
        },
      },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            canonicalTarget: {
              cognitiveLevel: input.context.cognitiveLevel,
              nodeId: input.context.canonicalNodeId,
              cognitiveLevelId: input.context.canonicalCognitiveLevelId,
              performanceObjective: input.context.performanceObjective,
              successCriterion: input.context.successCriterion,
              preferredInteractionTypes: input.context.preferredInteractionTypes,
            },
            operationalContract: input.operationalContract,
            microNode: {
              title: input.context.microNodeTitle,
              instructionalContent: input.context.instructionalContent,
            },
            candidate: input.candidate,
          }),
        },
      ],
    });
    const raw = response.choices?.[0]?.message?.content;
    if (!raw || !raw.trim()) return reviewError();
    const parsed = parseReview(JSON.parse(raw.replace(/```json|```/g, "").trim()));
    return parsed ?? reviewError();
  } catch {
    return reviewError();
  }
}