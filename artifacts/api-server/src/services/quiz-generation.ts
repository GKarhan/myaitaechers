import { openrouter } from "@workspace/integrations-openrouter-ai";
import { db, lessonNodesTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { logger } from "../lib/logger";

const MODEL = "deepseek/deepseek-chat-v3-0324";

export interface GeneratedQuestion {
  nodeId: number | null;
  questionText: string;
  options: [string, string, string, string];
  correctOptionIndex: number; // 0-3
  difficultyLevel: "LOW" | "MEDIUM" | "HIGH";
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
This is the TEXTBOOK FIDELITY rule — every question must be traceable to the source material.

Return VALID JSON ONLY — a root object with a "questions" key containing an array.
No markdown, no code fences, no explanatory text outside the JSON.

Each question object schema:
{
  "nodeId": <integer — the id= value of the node this question tests>,
  "questionText": "<question in Armenian հայատառ — 1 sentence>",
  "options": ["<option A>", "<option B>", "<option C>", "<option D>"],
  "correctOptionIndex": <0|1|2|3>,
  "difficultyLevel": "LOW" | "MEDIUM" | "HIGH"
}

Rules:
- ALL Armenian: question and all four options must be in Armenian script (Ա-Ֆ, ա-ֆ).
- Exactly 4 options per question. Exactly one correct answer per question.
- correctOptionIndex: 0=A, 1=B, 2=C, 3=D.
- Do NOT repeat the same question pattern twice.
- LOW = direct recall from text (definition, fact). MEDIUM = comprehension or simple application. HIGH = comparison, analysis, or multi-step reasoning.
- Distribute difficulty levels exactly as specified in the user message counts.
- Use each node's id as nodeId. Never hallucinate a nodeId not present in the source.`;

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
    })
    .from(lessonNodesTable)
    .where(inArray(lessonNodesTable.id, input.nodeIds));

  if (nodes.length === 0) {
    throw new Error("No nodes found for the provided nodeIds");
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

  // ── Helper: extract the questions array from raw model output ──────────────
  function extractQuestions(raw: string): GeneratedQuestion[] | null {
    const stripped = raw.replace(/```json\s*|```/g, "").trim();
    // Try direct parse — model should return { "questions": [...] }
    try {
      const obj = JSON.parse(stripped);
      if (obj && Array.isArray(obj.questions)) return obj.questions;
      if (Array.isArray(obj)) return obj; // fallback: bare array
    } catch { /* fall through */ }
    // Try to find any array or object block
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
    max_tokens: 4000,
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
      max_tokens: 4000,
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
  return questions.slice(0, input.questionCount).map((q, i): GeneratedQuestion => ({
    nodeId: typeof q.nodeId === "number" ? q.nodeId : null,
    questionText: typeof q.questionText === "string" ? q.questionText : `Հարց ${i + 1}`,
    options:
      Array.isArray(q.options) && q.options.length === 4
        ? (q.options as [string, string, string, string])
        : ["Ա", "Բ", "Գ", "Դ"],
    correctOptionIndex:
      typeof q.correctOptionIndex === "number" &&
      q.correctOptionIndex >= 0 &&
      q.correctOptionIndex <= 3
        ? q.correctOptionIndex
        : 0,
    difficultyLevel: (["LOW", "MEDIUM", "HIGH"].includes(q.difficultyLevel)
      ? q.difficultyLevel
      : "MEDIUM") as "LOW" | "MEDIUM" | "HIGH",
  }));
}
