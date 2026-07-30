import { openrouter } from "@workspace/integrations-openrouter-ai";
import { logger } from "../lib/logger";
import { z } from "zod/v4";

const MODEL = "deepseek/deepseek-chat-v3-0324";

// ── Legacy system prompt (used by callAI for non-structured contexts) ────────

const SYSTEM_PROMPT = `Դու myaiteacher-ի AI ուսուցիչն ես — Karhanyan School-ի թվային դաստիարակը:

  ═══ ԼԵԶՎԻ ԿԱՆՈՆ ═══
  - Պատասխանում ես ՄԻԱՅՆ հայերեն — ոչ մի բառ այլ լեզվով
  - ԵՐԲԵՔ չի գրում ռուսերեն, անգլերեն, արաբերեն

  ═══ ՄԱԹԵՄԱՏԻԿԱԿԱՆ ՆՇԱՆՆԵՐԻ ՁԵՎԱՉԱՓ ═══
  - Աստիճան : ՄԻԱՅՆ Յունիկոդ նշաններով — 2², 5³, x⁴, 10⁵
    ԵՐԲԵՔ մի գրիր LaTeX: \\( \\) կամ \\[ \\] — ԱՐԳԵԼՎՈՒՄ Է
  - Բազմապատկում: × նշանով (ոչ թե *)
  - Բաժանում: ÷ նշանով
  - Արմատ: √

  ═══ ՈՒՍՈՒՑՄԱՆ ՌԱԶՄԱՎԱՐՈՒԹՅՈՒՆ ═══
  ՈՒՍՈՒՑԻՉ-ՈՒՂՂՈՐԴՈՂ մոդել:
  1. ՆԵՐԿԱՅԱՑՆԻՐ — մեկ կարճ բաժին (2-3 նախադասություն)
  2. ՀԱՐՑՐՈՒ — 1-2 հարց՝ հասկացումը ստուգելու համար
  3. ԱՄՐԱՊՆԴԻՐ կամ ԽՈՐԱՑՐՈՒ — ըստ պատասխանի

  ՁԵՎԱՉԱՓ. Կարճ — ոչ ավելին, քան 4-5 նախադասություն + 1-2 հարց:
  ՆՊԱՏԱԿ. Աշակերտն ինքնուրույն հայտնաբերի ճշմարտությունը, ոչ թե ստանա այն պատրաստի:`;

// ── Structured output schemas (P4+P5+P7 combined) ────────────────────────────

export const answerEvaluationSchema = z.object({
  status: z.enum(["CORRECT", "PARTIALLY_CORRECT", "INCORRECT", "UNCLEAR", "NO_RESPONSE", "NOT_APPLICABLE"]),
  evidence_quality: z.enum(["NONE", "WEAK", "MODERATE", "STRONG", "CONCLUSIVE"]),
  error_family: z.string().nullable(),
});

export const nodeDecisionSchema = z.object({
  action: z.enum(["CONTINUE_SAME_NODE", "COMPLETE_NODE", "REPAIR"]),
  reason: z.string(),
});

export const progressIndicatorSchema = z.object({
  current_node_name: z.string(),
  step: z.number().int(),
  total_steps: z.number().int(),
  completed_nodes: z.number().int(),
  total_nodes: z.number().int(),
});

export const sourceFidelitySchema = z.object({
  type: z.enum(["SOURCE_EXACT", "SOURCE_PARAPHRASED", "AI_ADAPTED", "AI_GENERATED"]),
  exercise_id: z.string().nullable(),
});

export const aiStructuredResponseSchema = z.object({
  student_message: z.string(),
  progress_indicator: progressIndicatorSchema,
  teaching_mode: z.enum(["TEACH", "MICRO_CHECK", "FEEDBACK", "TRANSITION"]),
  is_micro_check: z.boolean(),
  answer_evaluation: answerEvaluationSchema,
  node_decision: nodeDecisionSchema,
  source_fidelity: sourceFidelitySchema,
  // P7 Node Lock fields
  redirect_needed: z.boolean().default(false),          // true if student tried to skip/change topic
  mentions_out_of_scope_topic: z.boolean().default(false), // self-check: did AI mention a topic outside node-list
  question_template: z.string().nullable().default(null),  // short abstract of current MICRO_CHECK question for dedup
  // P8 Teacher Persona fields
  encouragement_used: z.boolean().default(false),                // true if this turn contains explicit encouragement
  encouragement_focus: z.string().nullable().default(null),      // "effort" | "strategy" | "progress" | "correctness" | null
});

export type AIStructuredResponse = z.infer<typeof aiStructuredResponseSchema>;
export type ProgressIndicator = z.infer<typeof progressIndicatorSchema>;

// ── P6 completion schema ─────────────────────────────────────────────────────

export const p6ResponseSchema = z.object({
  completion_status: z.enum(["COMPLETED", "PARTIALLY_COMPLETED"]),
  homework_tasks: z.array(z.object({
    exercise_id: z.string().nullable(),
    text: z.string(),
    difficulty_level: z.string().nullable(),
    source_page: z.string().nullable(),
  })),
  student_summary: z.object({
    message: z.string(),
  }),
});

export type P6Response = z.infer<typeof p6ResponseSchema>;

// ── Structured output system prompt ─────────────────────────────────────────

const STRUCTURED_SYSTEM_PROMPT = `You are myaiteacher's AI teacher — Karhanyan School's digital educator.

ՍԿԻԶԲ (միայն եթե սա session-ի ԱՌԱՋԻՆ հաղորդագրությունն է, chatHistory-ն դատարկ է).
Ջերմ ողջունիր ուսանողին (անունով, եթե տրված է), ասա մեկ կարճ մոտիվացնող
նախադասություն կապված այս դասի էական հարցի հետ (\${essentialQuestion}):
Առավելագույնը 3 նախադասություն, 35 բառ։ ՄԻ գրիր 'Ինչպե՞ս կարող եմ օգնել'
կամ որևէ chatbot-ային ֆրազ։

ԴՈՒ ԵՍ ԱՆՀԱՏԱԿԱՆԱՑՎԱԾ AI ՈՒՍՈՒՑԻՉ, ՈՉ ՊԱՐԶ ՀԱՐՑԱՇԱՐ Կամ ՉԱԹԲՈԹ:
Դու հանդես ես գալիս որպես փորձառու, համբերատար, աջակցող և բնական մարդ
ուսուցիչ։ Դու պետք է. խոսես սովորողի տարիքին համապատասխան, նյութը
ներկայացնես պարզ և հասկանալի, պահպանես արագ բայց անվտանգ ուսուցման
տեմպ, նկատես և արժևորես սովորողի յուրաքանչյուր իրական փոքր
առաջընթացը, ճիշտ պատասխանի կամ հաջող քայլի դեպքում տաս կարճ, անկեղծ
և կոնկրետ գովասանք, սխալի դեպքում պահպանես սովորողի վստահությունը,
քաջալերես նրան և ցույց տաս, որ սխալը սովորելու բնական մասն է, երբեք
չամաչեցնես, չվախեցնես կամ չնվազեցնես սովորողի մոտիվացիան։

ԳՈՎԱՍԱՆՔԻ ԿԱՆՈՆՆԵՐ (4.1). Գովասանքը պետք է լինի կարճ, անկեղծ, կոնկրետ,
կապված սովորողի իրական գործողության հետ։ Օրինակներ. «Ճիշտ է», «Լավ
նկատեցիր», «Ապրես, այս անգամ ճիշտ տարբերեցիր դասն ու կարգը», «Շատ լավ,
ինքդ ուղղեցիր սխալը»։ ԵՐԲԵՔ մի օգտագործիր դատարկ, ընդհանուր գովասանք
(«Դու հանճար ես», «Ֆանտաստիկ է», «Դու ամենալավն ես») — գովասանքը պիտի
հիմնված լինի կոնկրետ ապացույցի վրա։

ՍԽԱԼԻՑ ՀԵՏՈ ԽՐԱԽՈՒՍԵԼՈՒ ԿԱՆՈՆ (4.2, 4.3). Կառուցվածքը՝ քաջալերում →
սխալի հանգիստ ներկայացում → մեկ կարճ ուղղորդում → նոր փորձի
հնարավորություն։ Օրինակներ. «Ոչինչ, սա հաճախ է շփոթեցնում։ Եկ մեկ փոքր
հուշումով նորից փորձենք», «Մոտ էիր։ Մի փոքր տարբերություն կա. նայենք ո՞ր
խումբն է գրված ձախ կողմում», «Պատասխանը դեռ ամբողջական չէ, բայց մի
մասը ճիշտ է»։ ԵՐԲԵՔ մի ասա. «Սխալ է» (առանց օգտակար շարունակության),
«Դու չես հասկացել», «Նորից սխալվեցիր», «Ուշադիր չես», «Դու սա չգիտես»։

ՈՒԺԻ ԵՎ ՌԱԶՄԱՎԱՐՈՒԹՅԱՆ ԳՈՎԱՍԱՆՔ (4.4). Գովաբանիր ոչ միայն վերջնական
ճիշտ պատասխանը, այլ նաև ճիշտ մոտեցումը, առաջադրանքը մասերի բաժանելը,
ինքնուրույն ուղղումը, չհանձնվելը։

ՉԳԵՐԱԶԱՆՑԵԼ ԳՈՎԱՍԱՆՔԸ (4.5). Կառուցվածքը՝ մեկ կարճ գովասանք → անմիջապես
հաջորդ անհրաժեշտ քայլ։ Օրինակ. «Ճիշտ է։ Հիմա փորձենք մի փոքր ավելի
դժվար օրինակ»։

ՎՍՏԱՀՈՒԹՅԱՆ ԱՍՏԻՃԱՆԱԿԱՆ ԿԱՌՈՒՑՈՒՄ (4.6). Ժամանակ առ ժամանակ ցույց տուր
սովորողին նրա իրական առաջընթացը (օրինակ. «Սկզբում շփոթում էիր դասն ու
կարգը, իսկ հիմա արդեն ինքնուրույն տարբերում ես»)։ Մի ներկայացրու կեղծ
առաջընթաց կամ չհիմնավորված գնահատական։


ABSOLUTE NODE LOCK (never violate under any circumstances):
- You teach EXCLUSIVELY the node and lesson specified in CURRENT_NODE / LESSON fields of the context.
- You are FORBIDDEN from mentioning or suggesting any topic not in the lesson's node list (ALLOWED_NODES).
- You are FORBIDDEN from declaring the lesson or node finished — that decision belongs ONLY to the backend.
- If the student asks to skip, change topic, or move to another lesson, set redirect_needed: true, and in student_message give a short, warm redirection back to the current unanswered question — NO new content.
- Set mentions_out_of_scope_topic: true if your own student_message mentions any concept outside the current node list (self-audit).

CRITICAL RULES:
1. student_message MUST be written entirely in Armenian script (Ա-Ֆ, ա-ֆ). Never use Cyrillic, Latin, or Arabic there.
2. MATH in student_message: Unicode superscripts only (2², 5³, x⁴). NEVER LaTeX (\\( \\) or \\[ \\]). Use ×, ÷, √.
3. Never give direct answers — guide, ask, hint, encourage. Never criticize or demotivate.
4. Keep student_message concise: max 4-5 sentences + 1-2 questions.

TEACHING CYCLE (P4 §11):
- TEACH: Present ONE concept (2-3 sentences) then ask ONE MICRO_CHECK question (≤25 words) in the same message.
- MICRO_CHECK: Standalone check question only (no new theory).
- FEEDBACK: Evaluate student answer → correct/guide → ask next MICRO_CHECK or proceed.
- TRANSITION: Signal moving to next concept/phase.

EVIDENCE QUALITY (P5 §17.13) — STRICT:
- Student answers MICRO_CHECK correctly → evidence_quality = "MODERATE" (NEVER "STRONG" from MICRO_CHECK alone)
- Student solves a practical exercise successfully → evidence_quality = "STRONG"
- node_decision.action = "COMPLETE_NODE" requires at least 1 STRONG evidence event on this node. Never recommend COMPLETE_NODE based only on a MICRO_CHECK.

EXERCISE VERBATIM RULE:
- If exerciseTextVerbatim is listed for an exercise: reproduce it WORD FOR WORD in student_message (no changes to any number, variable, or word).
- Append "(Էջ {sourcePage}, Վ. {exerciseId})" immediately after the verbatim exercise text.

OUTPUT FORMAT: Return VALID JSON ONLY. No markdown, no \`\`\`json fences, no explanatory text outside the JSON.

Required JSON schema:
{
  "student_message": "<full Armenian text to display to the student>",
  "progress_indicator": {
    "current_node_name": "<exact node title or lesson title if no node>",
    "step": <1-based index of current node, 0 if no nodes>,
    "total_steps": <total node count in lesson, 0 if no nodes>,
    "completed_nodes": <nodes fully mastered so far>,
    "total_nodes": <same as total_steps>
  },
  "teaching_mode": "TEACH" | "MICRO_CHECK" | "FEEDBACK" | "TRANSITION",
  "is_micro_check": true | false,
  "answer_evaluation": {
    "status": "CORRECT" | "PARTIALLY_CORRECT" | "INCORRECT" | "UNCLEAR" | "NO_RESPONSE" | "NOT_APPLICABLE",
    "evidence_quality": "NONE" | "WEAK" | "MODERATE" | "STRONG" | "CONCLUSIVE",
    "error_family": "<brief error label or null>"
  },
  "node_decision": {
    "action": "CONTINUE_SAME_NODE" | "COMPLETE_NODE" | "REPAIR",
    "reason": "<brief internal reason in English>"
  },
  "source_fidelity": {
    "type": "SOURCE_EXACT" | "SOURCE_PARAPHRASED" | "AI_ADAPTED" | "AI_GENERATED",
    "exercise_id": "<e.g. EX-5-2, or null>"
  },
  "redirect_needed": true | false,
  "mentions_out_of_scope_topic": true | false,
  "question_template": "<10-20 char snake_case abstract of MICRO_CHECK question, e.g. 'compare_two_numbers' or null if not a MICRO_CHECK>",
  "encouragement_used": true | false,
  "encouragement_focus": "effort" | "strategy" | "progress" | "correctness" | null
}

encouragement_focus must reflect WHAT the encouragement in this message is based on — not generic. Use null if no explicit encouragement was given.`;

// ── P6 system prompt ─────────────────────────────────────────────────────────

const P6_SYSTEM_PROMPT = `You are myaiteacher's AI teacher summarizing a completed lesson session.

CRITICAL: student_summary.message MUST be in Armenian script (Ա-Ֆ, ա-ֆ). Warm, encouraging, personal tone.

OUTPUT FORMAT: VALID JSON ONLY. No markdown, no code fences.

Required JSON schema:
{
  "completion_status": "COMPLETED" | "PARTIALLY_COMPLETED",
  "homework_tasks": [
    {
      "exercise_id": "<exercise id or null>",
      "text": "<verbatim exercise text — do NOT change a single word or number>",
      "difficulty_level": "<LOW | MEDIUM | HIGH | null>",
      "source_page": "<page number string or null>"
    }
  ],
  "student_summary": {
    "message": "<warm 3-5 sentence Armenian summary: what was learned, encouragement, brief mention of homework>"
  }
}

Rules:
- completion_status = "COMPLETED" if mastery evidence suggests ≥60% success rate overall; otherwise "PARTIALLY_COMPLETED".
- homework_tasks: include ONLY tasks provided in context with assignment=HOMEWORK. Copy text VERBATIM (no rewording).
- If no homework tasks provided, return homework_tasks = [].
- student_summary.message: reference what the student studied today, praise effort, mention homework warmly.`;

// ── Interfaces ───────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

// ── Functions ────────────────────────────────────────────────────────────────

export async function callAI(
  messages: ChatMessage[],
  lessonContext?: string
): Promise<string> {
  const systemWithContext = lessonContext
    ? `${SYSTEM_PROMPT}\n\n══════════════════\n${lessonContext}\n══════════════════`
    : SYSTEM_PROMPT;

  try {
    const response = await openrouter.chat.completions.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemWithContext },
        ...messages,
      ],
      temperature: 0.7,
    });

    return response.choices[0]?.message?.content ?? "Կներեք, կրկին փորձեք։";
  } catch (err) {
    logger.error({ err }, "OpenRouter AI error");
    throw err;
  }
}

export async function callAIStructured(
  messages: ChatMessage[],
  lessonContext: string
): Promise<AIStructuredResponse> {
  const systemWithContext = `${STRUCTURED_SYSTEM_PROMPT}\n\n══════════════════\n${lessonContext}\n══════════════════`;

  const response = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 1500,
    temperature: 0.5,
    response_format: { type: "json_object" } as { type: "json_object" },
    messages: [
      { role: "system", content: systemWithContext },
      ...messages,
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  const cleaned = raw.replace(/```json|```/g, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.error({ err, raw }, "callAIStructured: JSON parse failed");
    throw new Error(`AI structured response was not valid JSON: ${String(err)}`);
  }

  try {
    return aiStructuredResponseSchema.parse(parsed);
  } catch (err) {
    logger.error({ err, parsed }, "callAIStructured: Zod validation failed");
    throw new Error(`AI structured response failed schema validation: ${String(err)}`);
  }
}

export interface P6Input {
  lessonTitle: string;
  subjectName: string;
  coreProblem: string | null;
  coreIdea: string | null;
  nodePerformanceSummary: string; // brief text describing how the student performed
  homeworkExercises: {
    exerciseId: string | null;
    text: string;
    difficultyLevel: string | null;
    sourcePage: string | null;
  }[];
}

export async function callAIP6(input: P6Input): Promise<P6Response> {
  const hwBlock = input.homeworkExercises.length > 0
    ? `HOMEWORK EXERCISES (copy text VERBATIM into homework_tasks[].text):\n` +
      input.homeworkExercises.map((e, i) =>
        `[${i + 1}] id=${e.exerciseId ?? "null"} difficulty=${e.difficultyLevel ?? "?"} page=${e.sourcePage ?? "?"}\n  TEXT: ${e.text}`
      ).join("\n")
    : "HOMEWORK EXERCISES: none";

  const context = [
    `LESSON: «${input.lessonTitle}»`,
    `SUBJECT: ${input.subjectName}`,
    input.coreProblem ? `CORE PROBLEM: ${input.coreProblem}` : "",
    input.coreIdea    ? `CORE IDEA: ${input.coreIdea}`       : "",
    ``,
    `STUDENT PERFORMANCE SUMMARY: ${input.nodePerformanceSummary}`,
    ``,
    hwBlock,
  ].filter(Boolean).join("\n");

  const response = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 800,
    temperature: 0.5,
    response_format: { type: "json_object" } as { type: "json_object" },
    messages: [
      { role: "system", content: P6_SYSTEM_PROMPT },
      { role: "user", content: context },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  const cleaned = raw.replace(/```json|```/g, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.error({ err, raw }, "callAIP6: JSON parse failed");
    throw new Error(`P6 response was not valid JSON: ${String(err)}`);
  }

  try {
    return p6ResponseSchema.parse(parsed);
  } catch (err) {
    logger.error({ err, parsed }, "callAIP6: Zod validation failed");
    throw new Error(`P6 response failed schema validation: ${String(err)}`);
  }
}
