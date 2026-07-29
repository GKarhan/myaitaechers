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
  practicalTasks: {
    task: string;
    purpose: string;
    sourcePage: string | null;
    difficultyLevel: "LOW" | "MEDIUM" | "HIGH";
    successCriteria: string;
    relatedNodeTitle: string;
  }[];
}

const SYSTEM_PROMPT = `Դու կրթական բովանդակության վերլուծաբան ես (հիմնված P1 — Lesson Knowledge Package Generator սկզբունքների վրա)։ Քո խնդիրն է վերլուծել դասագրքի կոնկրետ դասի իրական տեքստը և կառուցել դասի քարտեզագրում։

ԱՇԽԱՏԱՆՔԻ ՀԱՋՈՐԴԱԿԱՆՈՒԹՅՈՒՆԸ.
(1) ՆПАТАК / ВЕРДЖNАРDUYNKНЕР — if the user message contains a teacher draft (see labels below), refine those against the real textbook text rather than inventing from scratch; if absent, derive from the text.
(2) coreProblem — identify the essential question or problem this lesson answers (one sentence).
(3) coreIdea — formulate ONE central idea that directly answers coreProblem.
(4) nodes — break coreIdea into knowledge nodes as described below; each node must serve coreIdea.
(5) practicalTasks — propose 2-5 tasks reinforcing the theory; prefer real textbook exercises over invented ones.

ԿARЕWWOR СКЗБUNKERY. Node-ery (enthathemanerr) chen karog liner patahakan enthababazhanumnner. Amen node piti hstakores tsarayutsi coreIdea-in.

Պատասխանիր ԲԱՑԱՌԱՊԵՍ վավեր JSON-ով, ոչինչ ավելին (ոչ մեկնաբանություն, ոչ markdown code fence), ուղիղ այս կառուցվածքով.

{
  "lessonGoal": "Դասի նպատակը, 1-2 նախադասությամբ",
  "lessonOutcomes": ["Վերջնարդյունք 1", "Վերջնարդյունք 2", "..."],
  "coreProblem": "The essential question this lesson answers (one sentence in Armenian)",
  "coreIdea": "Դասի կենտրոնական գաղափարը/հիմնախնդիրը, հստակ ձևակերպված",
  "nodes": [
    {
      "title": "Ենթաթեմայի կարճ վերնագիր",
      "theoryContent": "Այս ենթաթեմայի տեսական բովանդակությունը՝ բխեցված իրական դասագրքի տեքստից, և բացատրություն, թե ինչպես է այն ծառայում coreIdea-ին",
      "targetBloomLevel": 1,
      "estimatedMinutes": 5,
      "childFriendlyExplanation": "How the AI teacher should explain this node to the student in plain language (in Armenian, 1-3 sentences, direct address)",
      "basicExamples": ["Short concrete example 1 (in Armenian)", "Short concrete example 2 (in Armenian)"],
      "realLifeExamples": ["Real-life context example (in Armenian, 0-2 items)"],
      "commonMisconception": "The single most likely wrong answer or confusion a student will have (in Armenian, 1 sentence)",
      "prerequisiteNodes": ["Short phrase: prior knowledge needed 1", "Short phrase: prior knowledge needed 2"]
    }
  ],
  "practicalTasks": [
    {
      "task": "A concrete exercise or problem from/inspired by the textbook (in Armenian)",
      "purpose": "How this task reinforces the core idea (in Armenian)",
      "sourcePage": "10",
      "difficultyLevel": "MEDIUM",
      "successCriteria": "The correct answer or what counts as a correct student response (in Armenian)",
      "relatedNodeTitle": "Exact title of the node this task reinforces (must match a node title)"
    }
  ]
}

Կանոններ.
- Ամեն ինչ գրիր ՄԻԱՅՆ իրական հայերենով (հայատառ), ոչ մի տառադարձություն, ոչ մի կիրիլիցա
- targetBloomLevel՝ 1-ից 6 (1=Հիշել, 2=Հասկանալ, 3=Կիրառել, 4=Վերլուծել, 5=Գնահատել, 6=Ստեղծել)
- node-երի քանակը թող համապատասխանի իրական տեքստի ծավալին ու բարդությանը (սովորաբար 3-8 node), ոչ մի կանխորոշված թիվ
- theoryContent-ը պիտի հիմնված լինի տրված իրական տեքստի վրա, ոչ հորինված նյութի վրա
- estimatedMinutes-ը ամեն node-ի հարաբերական ժամանակի կշիռն է (ոչ ճշգրիտ երաշխիք)
- practicalTasks: 2-5 tasks; prefer real textbook exercises/examples over invented ones
- գլխի/բաժնի վնագիրներ (օրինակները։ «ԳԼՈՒԽ 1», «ԲԱԺԻՆ 2» ev ախնկալ) ախնկալ վնագիրներ են — անտել դրանք որպես աղբյուր node-ի, coreProblem-ի, coreIdea-ի և practicalTasks-ի համար
- Node-երը, coreProblem-ը, coreIdea-ն և practicalTasks-ը պիտի բացառապես համապատասխանեն դասի սեփական տեքստում և վերնագրի — այլ դասերի վնագիրներ և forward-reference-ները անտել վորպես աղբյուր
- Եթե դասի վերնագրը չի համապատասխանում գլխի ախնկալ վերնագրին, վստահել դասի վերնագրը որպես բովանդակության սահմանը
- childFriendlyExplanation: 1-3 նախադասություն plain language, direct address to student; basicExamples: 1-2 short items; realLifeExamples: 0-2 items; commonMisconception: 1 sentence; prerequisiteNodes: 1-4 short phrases
- practicalTasks: sourcePage = exact page number as string, or null if AI-proposed; difficultyLevel = LOW/MEDIUM/HIGH; successCriteria = իրական իսկական correct answer (Armenian); relatedNodeTitle = must exactly match one of the node titles in this response
`;

export async function mapLessonWithAI(
  input: LessonMappingInput
): Promise<LessonMappingResult> {
  const userPromptParts: string[] = [

    `ԱՌԱՐԿԱ: ${input.subjectName}`,
    `ԴԱՍԻ ՎԵՐՆԱԳԻՐ: ${input.lessonTitle}`,
    input.chapterTitle ? `ԹԵՄԱ/ԳԼՈՒԽ: ${input.chapterTitle}` : "",
    input.textbookTitle ? `ԴԱՍԱԳԻՐՔ: ${input.textbookTitle}` : "",
    input.textbookAuthor ? `ՀԵՂԻՆԱԿ: ${input.textbookAuthor}` : "",
    input.pagesFrom && input.pagesTo
      ? `ԷՋԵՐ: ${input.pagesFrom}-${input.pagesTo}`
      : "",
    ``,
    `ԴԱՍԱԳՐՔԻ ԻՐԱԿԱՆ ՏԵՔՍՏԸ ԱՅՍ ԷՋԵՐԻՑ.`,
    input.lessonText || "(տեքստ չի հաջողվել հանել այս էջերից)",
  
  ];
  if (input.teacherGoal) {
    userPromptParts.push("", `ՈՒՍՈՒՑՉԻ ՍԵՎԱԳԻՐ ՆՊԱՏԱԿ: ${input.teacherGoal}`);
  }
  if (input.teacherOutcomes && input.teacherOutcomes.length > 0) {
    userPromptParts.push(`ՈՒՍՈՒՑՉԻ ՍԵՎԱԳԻՐ ՎԵՐՋՆԱՐԴՅՈՒՆՔՆԵՐ: ${input.teacherOutcomes.join("; ")}`);
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

  // Defensive defaults for new node fields
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

  // Defensive defaults for new practicalTask fields
  parsed.practicalTasks = parsed.practicalTasks.map((t) => ({
    ...t,
    sourcePage: t.sourcePage ?? null,
    difficultyLevel: (["LOW", "MEDIUM", "HIGH"].includes(t.difficultyLevel)
      ? t.difficultyLevel
      : "MEDIUM") as "LOW" | "MEDIUM" | "HIGH",
    successCriteria: t.successCriteria ?? "",
    relatedNodeTitle: t.relatedNodeTitle ?? "",
  }));

  return parsed;
}