import { openrouter } from "@workspace/integrations-openrouter-ai";
import {
  db,
  lessonNodesTable,
  lessonNodeCognitiveLevelsTable,
} from "@workspace/db";
import { asc, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { assessAcceptedCognitivePath } from "../lib/cognitive-path-grounding.js";

const MODEL = "deepseek/deepseek-chat-v3-0324";

export interface GeneratedQuestion {
  nodeId: number | null;
  cognitiveLevelId: number | null;
  questionText: string;
  options: [string, string, string, string];
  correctOptionIndex: number; // 0-3
  difficultyLevel: "LOW" | "MEDIUM" | "HIGH";
  // One explanation per option, index-aligned with options[].
  // null element = insufficient source material for that slot (no fabrication).
  // null array  = explanations could not be generated at all.
  optionExplanations: ([string | null, string | null, string | null, string | null]) | null;
}

export interface GenerateQuizInput {
  nodeIds: number[];
  questionCount: number;
  difficultyMode: "SIMPLE" | "MEDIUM" | "HARD" | "MIXED";
}

/**
 * Compute the LOW / MEDIUM / HIGH split so that the three counts sum
 * exactly to questionCount (rounding artefacts absorbed into MEDIUM).
 */
function computeSplit(count: number, mode: string): { LOW: number; MEDIUM: number; HIGH: number } {
  if (mode === "SIMPLE") return { LOW: count, MEDIUM: 0, HIGH: 0 };
  if (mode === "MEDIUM") return { LOW: 0, MEDIUM: count, HIGH: 0 };
  if (mode === "HARD")   return { LOW: 0, MEDIUM: 0, HIGH: count };
  // MIXED: 20 % LOW · 60 % MEDIUM · 20 % HIGH
  const low    = Math.round(count * 0.2);
  const high   = Math.round(count * 0.2);
  const medium = count - low - high; // absorbs rounding so sum === count
  return { LOW: low, MEDIUM: medium, HIGH: high };
}

const SYSTEM_PROMPT = `You are a quiz generator for an Armenian school AI teacher system.
Generate questions EXCLUSIVELY from the node content provided. Do NOT invent numbers,
rules, or concepts not explicitly present in the given NODE sections.
This is the TEXTBOOK FIDELITY rule — every question AND explanation must be traceable to the source material.

Return VALID JSON ONLY — a root object with a "questions" key containing an array.
No markdown, no code fences, no explanatory text outside the JSON.

Each question object schema:
{
  "nodeId": <integer — the id= value of the node this question tests>,
  "cognitiveLevelId": <integer from the node's COGNITIVE_LEVEL_OPTIONS, or null only when no options are supplied>,
  "questionText": "<question in Armenian հայատառ — 1 sentence>",
  "options": ["<option A>", "<option B>", "<option C>", "<option D>"],
  "correctOptionIndex": <0|1|2|3>,
  "optionExplanations": [
    "<explanation for option A>",
    "<explanation for option B>",
    "<explanation for option C>",
    "<explanation for option D>"
  ],
  "difficultyLevel": "LOW" | "MEDIUM" | "HIGH"
}

Rules for questions:
- ALL Armenian: question and all four options must be in Armenian script (Ա-Ֆ, ա-ֆ).
- Exactly 4 options per question. Exactly one correct answer per question.
- correctOptionIndex: 0=A, 1=B, 2=C, 3=D.
- Do NOT repeat the same question pattern twice.
- LOW = direct recall from text (definition, fact). MEDIUM = comprehension or simple application. HIGH = comparison, analysis, or multi-step reasoning.
- Distribute difficulty levels exactly as specified in the user message counts.
- Use each node's id as nodeId. Never hallucinate a nodeId not present in the source.
- When a node lists COGNITIVE_LEVEL_OPTIONS, choose exactly one listed level ID
  that the question is designed to assess. Never invent or infer a level ID.

Rules for optionExplanations (CRITICAL — read carefully):
- optionExplanations MUST be an array of exactly 4 strings, index-aligned with options[].
- optionExplanations[correctOptionIndex]: explain WHY this option is correct, citing the specific rule or fact from the source material. Example: "Ճիշտ է, որovheteev ..."-style explanation in Armenian.
- optionExplanations[wrongIndex] for each wrong option: explain WHY that specific option is wrong and what misconception it represents, based solely on the source. Example: "Սخал є, որovheteev ..."-style in Armenian. Each wrong option's explanation MUST be distinct — do not copy the same text across wrong options.
- TEXTBOOK FIDELITY: every explanation must be grounded in the provided NODE content. Do not invent rules, numbers, or facts not present in the source.
- If the source material is insufficient to write a reliable explanation for a specific option, set that slot to null. Do NOT write a generic explanation like "Ays pahastany sxal e." — that is forbidden.
- All explanation strings must be in Armenian script (հայատառ).`;

export async function generateQuizQuestions(
  input: GenerateQuizInput
): Promise<GeneratedQuestion[]> {
  if (input.nodeIds.length === 0) {
    throw new Error("nodeIds must not be empty");
  }

  // Pull source material
  const nodes = await db
    .select({
      id:                       lessonNodesTable.id,
      title:                    lessonNodesTable.title,
      theoryContent:            lessonNodesTable.theoryContent,
      childFriendlyExplanation: lessonNodesTable.childFriendlyExplanation,
      basicExamples:            lessonNodesTable.basicExamples,
      learningObjective:        lessonNodesTable.learningObjective,
      cogPathStatus:            lessonNodesTable.cogPathStatus,
    })
    .from(lessonNodesTable)
    .where(inArray(lessonNodesTable.id, input.nodeIds));

  if (nodes.length === 0) {
    throw new Error("No nodes found for the provided nodeIds");
  }

  const cognitiveRows = await db
    .select({
      id: lessonNodeCognitiveLevelsTable.id,
      lessonNodeId: lessonNodeCognitiveLevelsTable.lessonNodeId,
      cognitiveLevel: lessonNodeCognitiveLevelsTable.cognitiveLevel,
      sequence: lessonNodeCognitiveLevelsTable.sequence,
      isApplicable: lessonNodeCognitiveLevelsTable.isApplicable,
      isTargetCeiling: lessonNodeCognitiveLevelsTable.isTargetCeiling,
      performanceObjective: lessonNodeCognitiveLevelsTable.performanceObjective,
      successCriterion: lessonNodeCognitiveLevelsTable.successCriterion,
      preferredInteractionTypes: lessonNodeCognitiveLevelsTable.preferredInteractionTypes,
    })
    .from(lessonNodeCognitiveLevelsTable)
    .where(inArray(lessonNodeCognitiveLevelsTable.lessonNodeId, input.nodeIds))
    .orderBy(
      asc(lessonNodeCognitiveLevelsTable.lessonNodeId),
      asc(lessonNodeCognitiveLevelsTable.sequence),
      asc(lessonNodeCognitiveLevelsTable.id),
    );

  const levelsByNode = new Map<number, typeof cognitiveRows>();
  for (const level of cognitiveRows) {
    const current = levelsByNode.get(level.lessonNodeId) ?? [];
    current.push(level);
    levelsByNode.set(level.lessonNodeId, current);
  }

  const allowedLevelIdsByNode = new Map<number, Set<number>>();
  for (const node of nodes) {
    const levels = levelsByNode.get(node.id) ?? [];
    const accepted = assessAcceptedCognitivePath({
      cogPathStatus: node.cogPathStatus,
      theoryContent: node.theoryContent,
      learningObjective: node.learningObjective,
      levels,
    }).accepted;
    if (accepted) {
      allowedLevelIdsByNode.set(node.id, new Set(levels
        .filter((level) => level.isApplicable)
        .map((level) => level.id)));
    }
  }

  const split = computeSplit(input.questionCount, input.difficultyMode);

  const nodeBlocks = nodes.map((n) =>
    [
      `--- NODE id=${n.id}: ${n.title} ---`,
      n.theoryContent            ? `THEORY: ${n.theoryContent}`               : "",
      n.childFriendlyExplanation ? `EXPLANATION: ${n.childFriendlyExplanation}` : "",
      Array.isArray(n.basicExamples) && (n.basicExamples as string[]).length > 0
        ? `EXAMPLES: ${(n.basicExamples as string[]).join(" | ")}`
        : "",
      allowedLevelIdsByNode.has(n.id)
        ? `COGNITIVE_LEVEL_OPTIONS: ${(levelsByNode.get(n.id) ?? [])
          .filter((level) => allowedLevelIdsByNode.get(n.id)?.has(level.id))
          .map((level) =>
            `id=${level.id}, bloom=${level.cognitiveLevel}, objective=${level.performanceObjective ?? ""}`,
          )
          .join(" | ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n")
  ).join("\n\n");

  const userPrompt = [
    `Generate exactly ${input.questionCount} questions with the following difficulty counts:`,
    `  LOW: ${split.LOW}`,
    `  MEDIUM: ${split.MEDIUM}`,
    `  HIGH: ${split.HIGH}`,
    ``,
    `NODE CONTENT (use ONLY this material — never invent outside it):`,
    nodeBlocks,
  ].join("\n");

  // ── Helper: normalise a raw option explanations value from the model ────────
  function normaliseOptionExplanations(
    raw: unknown,
    optionCount: number
  ): ([string | null, string | null, string | null, string | null]) | null {
    if (!Array.isArray(raw)) return null;
    // Length must match option count — if not, discard entirely (never shift indexes)
    if (raw.length !== optionCount) return null;
    const slots = raw.map((slot) =>
      typeof slot === "string" && slot.trim().length > 0 ? slot.trim() : null
    );
    // Must be exactly 4 slots (system always generates 4 options)
    if (slots.length !== 4) return null;
    return slots as [string | null, string | null, string | null, string | null];
  }

  // ── Helper: extract the questions array from raw model output ──────────────
  function extractQuestions(raw: string): GeneratedQuestion[] | null {
    const stripped = raw.replace(/```json\s*|```/g, "").trim();
    // Try direct parse — model should return { "questions": [...] }
    try {
      const obj = JSON.parse(stripped);
      if (obj && Array.isArray(obj.questions)) return obj.questions;
      if (Array.isArray(obj)) return obj; // fallback: bare array
    } catch { /* fall through */ }
    // Try to find any object block
    const arrMatch = stripped.match(/\{[\s\S]*\}/);
    if (arrMatch) {
      try {
        const obj = JSON.parse(arrMatch[0]);
        if (obj && Array.isArray(obj.questions)) return obj.questions;
      } catch { /* fall through */ }
    }
    return null;
  }

  // ── First attempt ──────────────────────────────────────────────────────────
  const firstResp = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 6000,
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: userPrompt },
    ],
  });

  const firstRaw = firstResp.choices[0]?.message?.content ?? "";
  let questions = extractQuestions(firstRaw);

  // ── Retry once if parse failed ─────────────────────────────────────────────
  if (!questions) {
    logger.warn({ raw: firstRaw.slice(0, 200) }, "quiz-generation: first attempt not valid JSON — retrying");
    const retryResp = await openrouter.chat.completions.create({
      model: MODEL,
      max_tokens: 6000,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system",    content: SYSTEM_PROMPT },
        { role: "user",      content: userPrompt },
        { role: "assistant", content: firstRaw },
        { role: "user",      content: 'Return ONLY valid JSON: { "questions": [ ... ] }. No other text.' },
      ],
    });
    const retryRaw = retryResp.choices[0]?.message?.content ?? "";
    questions = extractQuestions(retryRaw);
    if (!questions) {
      logger.error({ raw: retryRaw.slice(0, 300) }, "quiz-generation: failed to parse JSON after retry");
      throw new Error("Quiz generation failed to produce valid JSON after retry");
    }
  }

  // ── Defensive normalisation ────────────────────────────────────────────────
  return questions.slice(0, input.questionCount).map((q, i): GeneratedQuestion => {
    const opts: [string, string, string, string] =
      Array.isArray(q.options) && q.options.length === 4
        ? (q.options as [string, string, string, string])
        : ["Ա", "Բ", "Գ", "Դ"];

    return {
      nodeId: typeof q.nodeId === "number" ? q.nodeId : null,
      cognitiveLevelId:
        typeof q.nodeId === "number" &&
        typeof q.cognitiveLevelId === "number" &&
        allowedLevelIdsByNode.get(q.nodeId)?.has(q.cognitiveLevelId)
          ? q.cognitiveLevelId
          : null,
      questionText: typeof q.questionText === "string" ? q.questionText : `Հarц ${i + 1}`,
      options: opts,
      correctOptionIndex:
        typeof q.correctOptionIndex === "number" &&
        q.correctOptionIndex >= 0 &&
        q.correctOptionIndex <= 3
          ? q.correctOptionIndex
          : 0,
      difficultyLevel: (["LOW", "MEDIUM", "HIGH"].includes(q.difficultyLevel)
        ? q.difficultyLevel
        : "MEDIUM") as "LOW" | "MEDIUM" | "HIGH",
      // Validate and normalise option explanations.
      // Length must exactly match options count; bad arrays are dropped (never shifted).
      optionExplanations: normaliseOptionExplanations(q.optionExplanations, opts.length),
    };
  });
}
