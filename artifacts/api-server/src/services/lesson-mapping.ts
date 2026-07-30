import fs from "fs";
import path from "path";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const { PDFParse } = _require("pdf-parse") as {
  PDFParse: new (opts: { data: Buffer }) => {
    getText(opts?: { partial?: number[] }): Promise<{ text: string }>;
    destroy(): Promise<void>;
  };
};
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { logger } from "../lib/logger";

const MODEL = "deepseek/deepseek-chat-v3-0324";

/**
 * Extracts the real textbook text for a specific page range from a PDF
 * already stored on disk (uploaded via the course resources mechanism).
 * Returns an empty string if the range yields nothing (e.g. bad page numbers).
 */
export async function extractPdfPageRange(
  filePath: string,
  pagesFrom: number,
  pagesTo: number
): Promise<string> {
  const dataBuffer = fs.readFileSync(filePath);
  const pageNumbers: number[] = [];
  for (let p = pagesFrom; p <= pagesTo; p++) pageNumbers.push(p);

  const parser = new PDFParse({ data: dataBuffer });
  try {
    const result = await parser.getText({ partial: pageNumbers });
    return result.text.trim();
  } finally {
    await parser.destroy();
  }
}

/** Resolves a resources-table fileUrl (e.g. /api/teacher/documents/files/xyz.pdf) to its real path on disk. */
export function resolveUploadedFilePath(fileUrl: string): string {
  const filename = fileUrl.split("/").pop() ?? "";
  return path.join(process.cwd(), "uploads", filename);
}

export interface LessonMappingInput {
  subjectName: string;
  lessonTitle: string;
  chapterTitle: string | null;
  textbookTitle: string | null;
  textbookAuthor: string | null;
  pagesFrom: number | null;
  pagesTo: number | null;
  lessonText: string; // the real extracted textbook text for this lesson's pages
  teacherGoal?: string | null;       // teacher's draft goal — refine against text, don't silently overwrite
  teacherOutcomes?: string[] | null; // teacher's draft outcomes — refine if present, derive if absent
}

export interface LessonMappingResult {
  lessonGoal: string;
  lessonOutcomes: string[];
  coreProblem: string;
  coreIdea: string;
  nodes: {
    title: string;
    theoryContent: string;
    targetBloomLevel: number;
    estimatedMinutes: number;
    childFriendlyExplanation: string;
    basicExamples: string[];
    realLifeExamples: string[];
    commonMisconception: string;
    prerequisiteNodes: string[];
  }[];
  essentialQuestion: string;
  nodeDependencies: {
    fromNodeTitle: string;        // prerequisite node — must be taught BEFORE toNodeTitle
    toNodeTitle: string;          // node that depends on fromNodeTitle
    dependencyType: "REQUIRED" | "SEQUENTIAL" | "CONCEPTUAL";
    requiredLevel: "CRITICAL" | "SUPPORTING";
    reason: string;
  }[];
  practicalTasks: {
    task: string;
    purpose: string;
    // P1 STEP 17 — verbatim textbook exercise text and purpose enum
    exerciseTextVerbatim: string;   // word-for-word from textbook, or "" if AI-invented
    exercisePurpose: string;        // CONCEPT_DISCOVERY | RULE_DISCOVERY | WORKED_EXAMPLE | GUIDED_PRACTICE | INDEPENDENT_PRACTICE | PROBLEM_SOLVING | REVIEW | ASSESSMENT | AI_ADAPTED
    sourcePage: string | null;
    difficultyLevel: "LOW" | "MEDIUM" | "HIGH";
    successCriteria: string;
    relatedNodeTitle: string;
    assignment: "CLASS" | "HOMEWORK";
  }[];
}

const SYSTEM_PROMPT = `Դու կրթական բովանդակության վերլուծաբան ես (հիմնված P1 — Lesson Knowledge Package Generator սկզբունքների վրա)։ Քո խնդիրն է վերլուծել դասագրքի կոնկրետ դասի իրական տեքստը և կառուցել դասի քարտեզագրում։

ԱՇԽԱՏԱՆQԻ ՀԱJОРДАKАNUTIUNA.
(1) NPATAК / VERJNАRDIUNKNЕR — if the user message contains a teacher draft (see labels below), refine those against the real textbook text rather than inventing from scratch; if absent, derive from the text.
(2) coreProblem — identify the essential question or problem this lesson answers (one sentence).
(3) coreIdea — formulate ONE central idea that directly answers coreProblem.
(3.5) essentialQuestion — one question that the ENTIRE lesson answers, addressed directly to the student (NOT a definition question like «Ինչիր՞ e X-ը»). Use style: «ԻնչՊևս՞ karely e...?» / «Ինչու՞?» / «ԻնչՊևս՞ karogh enk?»
(4) nodes — break coreIdea into knowledge nodes as described below; each node must serve coreIdea.
(5) practicalTasks — propose 2-5 tasks reinforcing the theory; prefer real textbook exercises over invented ones.

Пataskhanir BАCАRRАРES vaver JSON-ov, vochinch avaelin (voch meknabanutiun, voch markdown code fence), ughin ays karrucvackov.

{
  "lessonGoal": "Dasi npatakë, 1-2 nakhadas.",
  "lessonOutcomes": ["Verjnardiunq 1", "Verjnardiunq 2", "..."],
  "coreProblem": "The essential question this lesson answers (one sentence in Armenian)",
  "coreIdea": "Dasi kentronakan gaghaparë, hstakats jevakerpvac",
  "nodes": [
    {
      "title": "Enthathemayi karrc vernagiR",
      "theoryContent": "Ays enthathemayi tesakank bovandasthanotyunë",
      "targetBloomLevel": 1,
      "estimatedMinutes": 5,
      "childFriendlyExplanation": "How the AI teacher should explain this node to the student in plain language (in Armenian, 1-3 sentences, direct address)",
      "basicExamples": ["Short concrete example 1 (in Armenian)", "Short concrete example 2 (in Armenian)"],
      "realLifeExamples": ["Real-life context example (in Armenian, 0-2 items)"],
      "commonMisconception": "The single most likely wrong answer or confusion a student will have (in Armenian, 1 sentence)",
      "prerequisiteNodes": ["Short phrase: prior knowledge needed 1", "Short phrase: prior knowledge needed 2"]
    }
  ],
  "essentialQuestion": "Mek hartsadzev baytzatsvats harts, vorin ambogj dashը pataskhanom e (Armenian, direct address to student, NOT \"Ինչիր՞ e X?\").",
  "nodeDependencies": [
    {
      "fromNodeTitle": "Exact title of prerequisite node (must match a node title above)",
      "toNodeTitle": "Exact title of dependent node (must match a node title above)",
      "dependencyType": "REQUIRED",
      "requiredLevel": "CRITICAL",
      "reason": "Brief reason why (Armenian, 1 sentence)"
    }
  ],
  "practicalTasks": [
    {
      "task": "A concrete exercise or problem from/inspired by the textbook (in Armenian)",
      "purpose": "How this task reinforces the core idea (in Armenian, 1 sentence)",
      "exerciseTextVerbatim": "WORD-FOR-WORD textbook text (copy exactly — no changes to any number, sign, or formula). Empty string '' if this is an AI-invented task.",
      "exercisePurpose": "GUIDED_PRACTICE",
      "sourcePage": "10",
      "difficultyLevel": "MEDIUM",
      "successCriteria": "The correct answer or what counts as a correct student response (in Armenian)",
      "relatedNodeTitle": "Exact title of the node this task reinforces (must match a node title above)",
      "assignment": "CLASS"
    }
  ]
}

KANOНNER.
- Amen inch grir МИЯNS irakank hayerënov (hayatarr), voch mek tarradarzutiun, voch mek kiriliqa
- targetBloomLevel: 1-ic 6 (1=Hishtarrel, 2=Haskarnel, 3=Kirarrel, 4=Verluczel, 5=Gnahatel, 6=Stepghcel)
- node-eri qanakë thogh hamapataskhani iraкank teksti cvаlini (sovorаbar 3-8 node)
- theoryContent-ë piti himnvat lini trvats iraкan teksti vra
- practicalTasks: 2-5 tasks; prefer real textbook exercises/examples over invented ones
- exerciseTextVerbatim ПРАВИЛО (ШАТРАБАГОВАН):
    * Ete varjhutiunë dasagrkis e → grir BARR ARR BARR (mek tiv, mek barr, mek nshan mi khojafkhes).
      exercisePurpose-ë inchknavor e ayn enum-ic: CONCEPT_DISCOVERY, RULE_DISCOVERY, WORKED_EXAMPLE, GUIDED_PRACTICE, INDEPENDENT_PRACTICE, PROBLEM_SOLVING, REVIEW, ASSESSMENT
    * Ete varjhutiunë AI-i stehcagortsakanë e (voch dasagrkis) → exerciseTextVerbatim = "" (datark texaragir), exercisePurpose = "AI_ADAPTED"
    * sourcePage = SHTKIT ej hamare (1-10 nman), kam null ete AI-i
- exercisePurpose valid values: CONCEPT_DISCOVERY | RULE_DISCOVERY | WORKED_EXAMPLE | GUIDED_PRACTICE | INDEPENDENT_PRACTICE | PROBLEM_SOLVING | REVIEW | ASSESSMENT | AI_ADAPTED
- nodeDependencies RULE: ONLY deps between nodes OF THIS LESSON. REQUIRED=toNode incomprehensible without fromNode (requiredLevel=CRITICAL); SEQUENTIAL=natural order, not strictly blocking (SUPPORTING); CONCEPTUAL=related, not sequential (SUPPORTING). Do NOT invent deps just to mirror the node list order. If nodes are independent, set nodeDependencies=[].
- relatedNodeTitle = piti hstakores hamnapataskhani verin node-eri vernagir-eri mekic
- assignment: after proposing all tasks, estimate total node time. Mark tasks that fit in class as "CLASS"; extras as "HOMEWORK". Ensure at least 1-2 are "CLASS". Exact value: "CLASS" or "HOMEWORK".
- glkhchi/bazhneri vernagirner (GLUKH 1, BAZHINN 2 ev nman) — antel drank vorpis aghbyur
- Node-erë, coreProblem-ë, coreIdea-n ev practicalTasks-ë piti bacарrapёs hamапataskhani dasi seфhakan teksti ev vernagiRi
`;


/**
 * Kahn's algorithm topological sort.
 * Only REQUIRED and SEQUENTIAL dependency types participate in the sort order;
 * CONCEPTUAL edges are informational only and do not affect sequence.
 * On cycle detection: logs a warning and falls back to the original order.
 */
export function topologicalSortNodes(
  nodeTitles: string[],
  dependencies: { fromNodeTitle: string; toNodeTitle: string; dependencyType: string }[]
): string[] {
  // Filter to ordering edges only
  const orderingDeps = dependencies.filter(
    (d) => d.dependencyType === "REQUIRED" || d.dependencyType === "SEQUENTIAL"
  );

  // Build adjacency and in-degree maps
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const t of nodeTitles) {
    inDegree.set(t, 0);
    adj.set(t, []);
  }
  for (const dep of orderingDeps) {
    const { fromNodeTitle: from, toNodeTitle: to } = dep;
    // Only include edges where both endpoints exist in this node set
    if (!inDegree.has(from) || !inDegree.has(to)) continue;
    adj.get(from)!.push(to);
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  }

  // Kahn's BFS
  const queue: string[] = [];
  for (const [title, deg] of inDegree) {
    if (deg === 0) queue.push(title);
  }
  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== nodeTitles.length) {
    // Cycle detected — warn and fall back to original order
    console.warn(
      "[lesson-mapping] topologicalSortNodes: cycle detected in node dependencies. " +
      "Falling back to original model order."
    );
    return [...nodeTitles];
  }

  return sorted;
}

export async function mapLessonWithAI(
  input: LessonMappingInput
): Promise<LessonMappingResult> {
  const userPromptParts: string[] = [

    `ARRARKA: ${input.subjectName}`,
    `DASI VERNAGIR: ${input.lessonTitle}`,
    input.chapterTitle ? `TEMA/GLUKH: ${input.chapterTitle}` : "",
    input.textbookTitle ? `DASAGIRK: ${input.textbookTitle}` : "",
    input.textbookAuthor ? `HEGHINAR: ${input.textbookAuthor}` : "",
    input.pagesFrom && input.pagesTo
      ? `EJER: ${input.pagesFrom}-${input.pagesTo}`
      : "",
    ``,
    `DASAGRKIS IRAКAN TEKSTË АYS EJERIC.`,
    input.lessonText || "(tekst chi hajoghhel hanelm ays ejerics)",
  
  ];
  if (input.teacherGoal) {
    userPromptParts.push("", `OUCUKCHOGH SEVAGIR NAРATAК: ${input.teacherGoal}`);
  }
  if (input.teacherOutcomes && input.teacherOutcomes.length > 0) {
    userPromptParts.push(`OUCUKCHOGH SEVAGIR VERJNARDIUNKNЕР: ${input.teacherOutcomes.join("; ")}`);
  }
  const userPrompt = userPromptParts.filter(Boolean).join("\n");

  const response = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 5000,
    temperature: 0.4,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "";

  // Defensive parsing: strip ```json fences if the model added them anyway.
  const cleaned = raw.replace(/```json|```/g, "").trim();

  let parsed: LessonMappingResult;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.error({ err, raw }, "lesson mapping: failed to parse AI JSON response");
    throw new Error("AI mapping response was not valid JSON");
  }

  if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
    throw new Error("AI mapping response contained no nodes");
  }

  // Defensive defaults for node fields
  parsed.nodes = parsed.nodes.map((n) => ({
    ...n,
    childFriendlyExplanation: n.childFriendlyExplanation ?? "",
    basicExamples: Array.isArray(n.basicExamples) ? n.basicExamples : [],
    realLifeExamples: Array.isArray(n.realLifeExamples) ? n.realLifeExamples : [],
    commonMisconception: n.commonMisconception ?? "",
    prerequisiteNodes: Array.isArray(n.prerequisiteNodes) ? n.prerequisiteNodes : [],
  }));

  if (!Array.isArray(parsed.practicalTasks)) {
    parsed.practicalTasks = [];
  }

  parsed.essentialQuestion = typeof parsed.essentialQuestion === "string" ? parsed.essentialQuestion : "";
  if (!Array.isArray(parsed.nodeDependencies)) {
    parsed.nodeDependencies = [];
  }
  parsed.nodeDependencies = parsed.nodeDependencies.filter(
    (d: { fromNodeTitle: string; toNodeTitle: string; dependencyType: string; requiredLevel: string; reason: string }) =>
      d.fromNodeTitle && d.toNodeTitle &&
      ["REQUIRED", "SEQUENTIAL", "CONCEPTUAL"].includes(d.dependencyType) &&
      ["CRITICAL", "SUPPORTING"].includes(d.requiredLevel)
  );

  // Defensive defaults for practicalTask fields (including new P1 STEP 17 fields)
  parsed.practicalTasks = parsed.practicalTasks.map((t, i) => ({
    ...t,
    task: t.task ?? "",
    purpose: t.purpose ?? "",
    exerciseTextVerbatim: typeof t.exerciseTextVerbatim === "string" ? t.exerciseTextVerbatim : "",
    exercisePurpose: typeof t.exercisePurpose === "string" ? t.exercisePurpose : "AI_ADAPTED",
    sourcePage: t.sourcePage ?? null,
    difficultyLevel: (["LOW", "MEDIUM", "HIGH"].includes(t.difficultyLevel)
      ? t.difficultyLevel
      : "MEDIUM") as "LOW" | "MEDIUM" | "HIGH",
    successCriteria: t.successCriteria ?? "",
    relatedNodeTitle: t.relatedNodeTitle ?? "",
    assignment: (["CLASS", "HOMEWORK"].includes(t.assignment)
      ? t.assignment
      : "CLASS") as "CLASS" | "HOMEWORK",
  }));

  return parsed;
}
