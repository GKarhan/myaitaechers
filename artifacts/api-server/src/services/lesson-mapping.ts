import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
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
  const collected: string[] = [];

  await pdfParse(dataBuffer, {
    pagerender: async (pageData: {
      pageNumber: number;
      getTextContent: () => Promise<{ items: { str: string }[] }>;
    }) => {
      if (pageData.pageNumber >= pagesFrom && pageData.pageNumber <= pagesTo) {
        const textContent = await pageData.getTextContent();
        collected.push(textContent.items.map((item) => item.str).join(" "));
      }
      return "";
    },
  });

  return collected.join("\n\n").trim();
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
}

export interface LessonMappingResult {
  lessonGoal: string;
  lessonOutcomes: string[];
  coreIdea: string;
  nodes: {
    title: string;
    theoryContent: string;
    targetBloomLevel: number;
    estimatedMinutes: number;
  }[];
}

const SYSTEM_PROMPT = `Դու կրթական բովանդակության վերլուծաբան ես (հիմնված P1 — Lesson Knowledge Package Generator սկզբունքների վրա)։ Քո խնդիրն է վերլուծել դասագրքի կոնկրետ դասի իրական տեքստը և կառուցել դասի քարտեզագրում։

ԿԱՐԵՎՈՐ ՍԿԶԲՈՒՆՔ. Node-երը (ենթաթեմաները) չեն կարող լինել պատահական ենթաբաժանումներ։ Նախ պիտի որոշես դասի ԿԵՆՏՐՈՆԱԿԱՆ ԳԱՂԱՓԱՐԸ/ՀԻՄՆԱԽՆԴԻՐԸ (core idea), և ամեն node պիտի հստակորեն ծառայի այդ գաղափարին։

Պատասխանիր ԲԱՑԱՌԱՊԵՍ վավեր JSON-ով, ոչինչ ավելին (ոչ մեկնաբանություն, ոչ markdown code fence), ուղիղ այս կառուցվածքով.

{
  "lessonGoal": "Դասի նպատակը, 1-2 նախադասությամբ",
  "lessonOutcomes": ["Վերջնարդյունք 1", "Վերջնարդյունք 2", "..."],
  "coreIdea": "Դասի կենտրոնական գաղափարը/հիմնախնդիրը, հստակ ձևակերպված",
  "nodes": [
    {
      "title": "Ենթաթեմայի կարճ վերնագիր",
      "theoryContent": "Այս ենթաթեմայի տեսական բովանդակությունը՝ բխեցված իրական դասագրքի տեքստից, և բացատրություն, թե ինչպես է այն ծառայում coreIdea-ին",
      "targetBloomLevel": 1,
      "estimatedMinutes": 5
    }
  ]
}

Կանոններ.
- Ամեն ինչ գրիր ՄԻԱՅՆ իրական հայերենով (հայատառ), ոչ մի տառադարձություն, ոչ մի կիրիլիցա
- targetBloomLevel՝ 1-ից 6 (1=Հիշել, 2=Հասկանալ, 3=Կիրառել, 4=Վերլուծել, 5=Գնահատել, 6=Ստեղծել)
- node-երի քանակը թող համապատասխանի իրական տեքստի ծավալին ու բարդությանը (սովորաբար 3-8 node), ոչ մի կանխորոշված թիվ
- theoryContent-ը պիտի հիմնված լինի տրված իրական տեքստի վրա, ոչ հորինված նյութի վրա
- estimatedMinutes-ը ամեն node-ի հարաբերական ժամանակի կշիռն է (ոչ ճշգրիտ երաշխիք)`;

export async function mapLessonWithAI(
  input: LessonMappingInput
): Promise<LessonMappingResult> {
  const userPrompt = [
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
  ]
    .filter(Boolean)
    .join("\n");

  const response = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 3000,
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

  return parsed;
}