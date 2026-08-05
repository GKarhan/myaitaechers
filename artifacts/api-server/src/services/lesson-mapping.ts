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
  // Extracted from textbook page content when teacher left these fields null
  textbookAuthor?: string | null;
  textbookTitle?: string | null;
  chapterTitle?: string | null;
  coreProblem: string;
  coreIdea: string;
  // NEW: what this lesson deliberately does NOT cover (prevents scope creep in chat.ts / AI teacher)
  knowledgeBoundaries: string[];
  nodes: {
    title: string;
    theoryContent: string;
    // NEW: word-for-word textbook paragraph(s) this node's theory is grounded in.
    // Empty string "" if there is no single clean matching passage (AI-synthesized theory).
    verbatimTheoryAnchor: string;
    targetBloomLevel: number;
    estimatedMinutes: number;
    childFriendlyExplanation: string;
    basicExamples: string[];
    realLifeExamples: string[];
    commonMisconception: string;
    // NEW: 1-2 short "this is NOT X" contrasts to sharpen the concept boundary
    nonExamples: string[];
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

ԱՇԽԱՏԱՆՔԻ ՀԱՋՈՐԴԱԿԱՆՈՒԹՅՈՒՆԸ.
(1) ՆՊԱՏԱԿ / ՎԵՐՋՆԱՐԴՅՈՒՆՔՆԵՐ — եթե ուսուցչի սևագիրը (տես label-երը ներքևում) տրված է, ճշգրտիր այն ըստ իրական դասագրքային տեքստի, ոչ թե հորինիր զրոյից. եթե բացակայում է, բխեցրու տեքստից։
(2) coreProblem — բացահայտիր այն էական հարցը/խնդիրը, որին այս դասը պատասխանում է (մեկ նախադասությամբ)։
(3) coreIdea — ձևակերպիր ՄԵԿ կենտրոնական գաղափար, որն ուղիղ պատասխանում է coreProblem-ին։
(3.5) essentialQuestion — մեկ հարց, որին ամբողջ դասը պատասխանում է, ուղղակիորեն ուղղված աշակերտին (ՈՉ սահմանման հարց՝ ինչպես «Ի՞նչ է X-ը»)։ Ոճը՝ «Ինչպե՞ս կարելի է...», «Ինչու՞...», «Ինչպե՞ս կարող ենք...»
(3.6) knowledgeBoundaries — 1-3 կարճ նշում, թե ինչ ԴԻՏԱՎՈՐՅԱԼ ՉԻ ընդգրկված այս դասում (հաջորդ դասերի կամ ավելի բարձր դասարանի նյութ), որ ուսուցումը չշեղվի սահմաններից դուրս։
(4) nodes — բաժանիր coreIdea-ն գիտելիքի node-երի, ինչպես նկարագրված է ներքևում. ամեն node պիտի ծառայի coreIdea-ին։ **IMPORTANT:** Identify EVERY distinct sub-topic boundary in the source pages (marked by a new section title/header in the textbook) and create ONE node per distinct sub-topic. Do NOT compress multiple distinct sub-topics into one node. Do NOT create one node per page.
(5) practicalTasks — Extract EVERY numbered exercise found in the page range into practicalTasks. Do NOT sample or select only a few. If the range has 18 exercises, produce 18 rows. Preference real verbatim textbook exercises over invented ones.
(5.5) textbook metadata — If the textbook pages contain the author name, textbook title, or chapter/section title, populate textbookAuthor, textbookTitle, and chapterTitle in the output. Never leave these null when the information is visible on the page.

Պատասխանիր ԲԱՑԱՌԱՊԵՍ վավեր JSON-ով, ոչինչ ավելին (ոչ մեկնաբանություն, ոչ markdown code fence), ուղիղ այս կառուցվածքով.

{
  "lessonGoal": "Դասի նպատակը, 1-2 նախադասություն.",
  "lessonOutcomes": ["Վերջնարդյունք 1", "Վերջնարդյունք 2", "..."],
  "textbookAuthor": "Author name extracted from page (null if not visible on the page)",
  "textbookTitle": "Textbook title extracted from page (null if not visible on the page)",
  "chapterTitle": "Chapter/section title (null if not visible on the page)",
  "coreProblem": "Այս դասի պատասխանած էական հարցը (մեկ նախադասությամբ, հայերեն)",
  "coreIdea": "Դասի կենտրոնական գաղափարը, հստակեցված ձևակերպումով",
  "knowledgeBoundaries": ["Ինչ դիտավորյալ դուրս է այս դասից 1", "Ինչ դիտավորյալ դուրս է այս դասից 2"],
  "nodes": [
    {
      "title": "Ենթաթեմայի կարճ վերնագիր",
      "theoryContent": "Այս ենթաթեմայի տեսական բովանդակությունը",
      "verbatimTheoryAnchor": "ԲԱՌ ԱՌ ԲԱՌ դասագրքի պարբերությունը, որի վրա հիմնված է այս node-ը (կամ դատարկ տող '' եթե չկա մեկ հստակ համապատասխան պարբերություն)",
      "targetBloomLevel": 1,
      "estimatedMinutes": 5,
      "childFriendlyExplanation": "Ինչպես AI ուսուցիչը պիտի բացատրի այս node-ը աշակերտին պարզ լեզվով (հայերեն, 1-3 նախադասություն, ուղիղ դիմելով)",
      "basicExamples": ["Կարճ կոնկրետ օրինակ 1 (հայերեն)", "Կարճ կոնկրետ օրինակ 2 (հայերեն)"],
      "realLifeExamples": ["Կյանքից օրինակ (հայերեն, 0-2 հատ)"],
      "commonMisconception": "Ամենահավանական սխալ պատասխանը կամ շփոթը, որ աշակերտը կունենա (հայերեն, 1 նախադասություն)",
      "nonExamples": ["Կարճ հակադրություն. սա ՉԷ այս հասկացությունը, քանի որ... (հայերեն)"],
      "prerequisiteNodes": ["Կարճ արտահայտություն. պահանջվող նախնական գիտելիք 1", "Կարճ արտահայտություն. պահանջվող նախնական գիտելիք 2"]
    }
  ],
  "essentialQuestion": "Մեկ հարցաձև ձևակերպված հարց, որին ամբողջ դասը պատասխանում է (հայերեն, ուղիղ դիմելով աշակերտին, ՈՉ 'Ի՞նչ է X-ը' ոճով).",
  "nodeDependencies": [
    {
      "fromNodeTitle": "Նախապայման node-ի ճշգրիտ վերնագիրը (պիտի համընկնի վերևի node-երից մեկի հետ)",
      "toNodeTitle": "Կախված node-ի ճշգրիտ վերնագիրը (պիտի համընկնի վերևի node-երից մեկի հետ)",
      "dependencyType": "REQUIRED",
      "requiredLevel": "CRITICAL",
      "reason": "Կարճ պատճառաբանություն (հայերեն, 1 նախադասություն)"
    }
  ],
  "practicalTasks": [
    {
      "task": "Կոնկրետ վարժություն կամ խնդիր՝ դասագրքից կամ ոգեշնչված դասագրքից (հայերեն)",
      "purpose": "Ինչպես է այս վարժությունն ամրապնդում կենտրոնական գաղափարը (հայերեն, 1 նախադասություն)",
      "exerciseTextVerbatim": "ԲԱՌ ԱՌ ԲԱՌ դասագրքի տեքստ (պատճենիր ուղիղ, ոչ մի փոփոխություն թվին, նշանին, կամ բանաձևին). Դատարկ '' եթե սա AI-ի հորինած վարժություն է.",
      "exercisePurpose": "GUIDED_PRACTICE",
      "sourcePage": "10",
      "difficultyLevel": "MEDIUM",
      "successCriteria": "Ճիշտ պատասխանը կամ ինչն է հաշվվում ճիշտ պատասխան (հայերեն)",
      "relatedNodeTitle": "Այս վարժությունն ամրապնդող node-ի ճշգրիտ վերնագիրը (պիտի համընկնի վերևի node-երից մեկի հետ)",
      "assignment": "CLASS"
    }
  ]
}

ԿԱՆՈՆՆԵՐ.
- Ամեն ինչ գրիր ՄԻԱՅՆ իրական հայերենով (հայատառ), ոչ մի տառադարձություն, ոչ մի կիրիլիցա
- targetBloomLevel: 1-ից 6 (1=Հիշտարել, 2=Հասկանալ, 3=Կիրառել, 4=Վերլուծել, 5=Գնահատել, 6=Ստեղծել)
- node-երի քանակը թող համապատասխանի իրական տեքստի ծավալին (սովորաբար 3-8 node)
- theoryContent-ը պիտի հիմնված լինի տրված իրական տեքստի վրա
- verbatimTheoryAnchor-ի ՊԱՀԱՆՋ. եթե node-ի հիմքում կոնկրետ, հստակ առանձնացվող դասագրքային պարբերություն/կանոն կա, մեջբերիր այն ուղիղ, բառ առ բառ (ոչ մի փոփոխություն). եթե տեքստը ցրված է կամ ուղիղ մեջբերում հնարավոր չէ, թող '' (դատարկ) — մի հորինիր կեղծ մեջբերում
- practicalTasks: 2-5 վարժություն; նախապատվությունը իրական դասագրքային վարժություններին/օրինակներին, ոչ հորինվածներին
- exerciseTextVerbatim ԿԱՆՈՆ (ԽԻՍՏ).
    * Եթե վարժությունը դասագրքից է → գրիր ԲԱՌ ԱՌ ԲԱՌ (մեկ թիվ, մեկ բառ, մեկ նշան մի փոփոխես).
      exercisePurpose-ը ընտրիր այս enum-ից. CONCEPT_DISCOVERY, RULE_DISCOVERY, WORKED_EXAMPLE, GUIDED_PRACTICE, INDEPENDENT_PRACTICE, PROBLEM_SOLVING, REVIEW, ASSESSMENT
    * Եթե վարժությունը AI-ի ստեղծագործականն է (ոչ դասագրքից) → exerciseTextVerbatim = "" (դատարկ տեքստադաշտ), exercisePurpose = "AI_ADAPTED"
    * sourcePage = ճշգրիտ էջի համարը (1-10 նման), կամ null եթե AI-ինն է
- exercisePurpose-ի վավեր արժեքներ. CONCEPT_DISCOVERY | RULE_DISCOVERY | WORKED_EXAMPLE | GUIDED_PRACTICE | INDEPENDENT_PRACTICE | PROBLEM_SOLVING | REVIEW | ASSESSMENT | AI_ADAPTED
- nodeDependencies ԿԱՆՈՆ. ՄԻԱՅՆ այս դասի node-երի միջև կախվածություններ։ REQUIRED=toNode-ը անհասկանալի է առանց fromNode-ի (requiredLevel=CRITICAL); SEQUENTIAL=բնական հերթականություն, բայց ոչ խիստ արգելափակող (SUPPORTING); CONCEPTUAL=կապված, բայց ոչ հաջորդական (SUPPORTING)։ Մի հորինիր կախվածություն միայն node-երի ցանկի կարգն արտացոլելու համար։ Եթե node-երն անկախ են միմյանցից, դիր nodeDependencies=[]:
- knowledgeBoundaries-ը պիտի իրապես կապված լինի այս դասին հարակից թեմաների հետ (հաջորդ դաս, ավելի բարձր դասարան), ոչ ընդհանուր/անորոշ նշում
- nonExamples-ը պիտի հստակ հակադրի node-ի հասկացությունը մի նման, բայց տարբեր բանի հետ (ոչ պարզապես «սա սխալ է» ընդհանուր նշում)
- relatedNodeTitle-ը պիտի ճշգրիտ համընկնի վերևի node-երից մեկի վերնագրի հետ
- assignment. բոլոր tasks-երն առաջարկելուց հետո, գնահատիր ընդհանուր node-ի ժամանակը. class-ում տեղավորվողները նշիր "CLASS", հավելյալները՝ "HOMEWORK": Ապահովիր առնվազն 1-2 "CLASS" tasks: Ճշգրիտ արժեք. "CLASS" կամ "HOMEWORK"
- գլխի/բաժինների վերնագրեր (ԳԼՈՒԽ 1, ԲԱԺԻՆ 2 և նման) — մի ընդունիր դրանք որպես աղբյուր
- NODE GRANULARITY (STRICT): Each distinct sub-topic with its own heading/title in the source text → ONE node. Never compress multiple distinct sub-topics into one node. Never create a node per page. The node count must reflect how many clearly delineated sub-topics exist in the textbook passage.
- EXHAUSTIVE EXERCISES (STRICT): Extract EVERY numbered exercise from the page range — do not sample or skip any. If there are 18 exercises, produce 18 practicalTask entries. exerciseTextVerbatim MUST NOT be blank when the textbook clearly shows exercise text.
- TEXTBOOK METADATA (STRICT): If the author name, textbook title, or chapter/section title appears anywhere in the page text or headers, populate textbookAuthor, textbookTitle, chapterTitle. Never output null for these when the information is present on the page.
- verbatimTheoryAnchor REINFORCE: If a node is grounded in a specific, clearly separable textbook paragraph or rule → quote it word-for-word (no changes). A blank verbatimTheoryAnchor is only acceptable when the textbook has no single clean matching passage.
- Node-երը, coreProblem-ը, coreIdea-ն և practicalTasks-ը պիտի բացառապես համապատասխանեն դասի սեփական տեքստին ու վերնագրին
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
    userPromptParts.push("", `ՈՒՍՈՒՑՉԻ ՍևԱԳԻՐ ՆՊԱՏԱԿ: ${input.teacherGoal}`);
  }
  if (input.teacherOutcomes && input.teacherOutcomes.length > 0) {
    userPromptParts.push(`ՈՒՍՈՒՑՉԻ ՍևԱԳԻՐ ՎԵՐՋՆԱՐԴՅՈՒՆՔՆԵՐ: ${input.teacherOutcomes.join("; ")}`);
  }
  const userPrompt = userPromptParts.filter(Boolean).join("\n");

  // ── Helper: attempt to extract valid JSON from raw model output ─────────
  function extractJSON(raw: string): LessonMappingResult | null {
    // 1. Strip markdown fences
    const stripped = raw.replace(/```json\s*|```/g, "").trim();
    // 2. Try direct parse
    try { return JSON.parse(stripped); } catch { /* fall through */ }
    // 3. Find the first {...} block — model sometimes wraps JSON in prose
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return null;
  }

  // ── First attempt ────────────────────────────────────────────────────────
  const firstResponse = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 8000,
    temperature: 0.4,
    // Force JSON output at the model level (supported by DeepSeek v3 via OpenRouter)
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const firstRaw = firstResponse.choices[0]?.message?.content ?? "";
  let parsed: LessonMappingResult | null = extractJSON(firstRaw);

  // ── Retry once if first attempt did not return valid JSON ────────────────
  if (!parsed) {
    logger.warn({ raw: firstRaw.slice(0, 200) }, "lesson mapping: first attempt not valid JSON — retrying");
    const retryResponse = await openrouter.chat.completions.create({
      model: MODEL,
      max_tokens: 8000,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
        { role: "assistant", content: firstRaw },
        {
          role: "user",
          content:
            "Պատասխանդ վավեր JSON չէ։ Վերադարձրու ԲԱՑԱՌԱՊԵՍ վավեր JSON օբյեկտ` առանց որևէ լրացուցիչ տեքստի, բացատրության կամ markdown-ի։",
        },
      ],
    });
    const retryRaw = retryResponse.choices[0]?.message?.content ?? "";
    parsed = extractJSON(retryRaw);
    if (!parsed) {
      logger.error({ raw: retryRaw.slice(0, 300) }, "lesson mapping: failed to parse AI JSON response after retry");
      throw new Error("AI mapping response was not valid JSON");
    }
  }

  const raw = firstRaw; // kept for downstream compat in error messages

  if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
    throw new Error("AI mapping response contained no nodes");
  }

  // Defensive defaults for node fields
  parsed.nodes = parsed.nodes.map((n) => ({
    ...n,
    verbatimTheoryAnchor: typeof n.verbatimTheoryAnchor === "string" ? n.verbatimTheoryAnchor : "",
    childFriendlyExplanation: n.childFriendlyExplanation ?? "",
    basicExamples: Array.isArray(n.basicExamples) ? n.basicExamples : [],
    realLifeExamples: Array.isArray(n.realLifeExamples) ? n.realLifeExamples : [],
    commonMisconception: n.commonMisconception ?? "",
    nonExamples: Array.isArray(n.nonExamples) ? n.nonExamples : [],
    prerequisiteNodes: Array.isArray(n.prerequisiteNodes) ? n.prerequisiteNodes : [],
  }));

  parsed.knowledgeBoundaries = Array.isArray(parsed.knowledgeBoundaries) ? parsed.knowledgeBoundaries : [];

  // Defensive defaults for extracted textbook metadata fields
  parsed.textbookAuthor = typeof parsed.textbookAuthor === "string" && parsed.textbookAuthor.trim()
    ? parsed.textbookAuthor.trim() : null;
  parsed.textbookTitle = typeof parsed.textbookTitle === "string" && parsed.textbookTitle.trim()
    ? parsed.textbookTitle.trim() : null;
  parsed.chapterTitle = typeof parsed.chapterTitle === "string" && parsed.chapterTitle.trim()
    ? parsed.chapterTitle.trim() : null;

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