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
  status: z.enum([
    "CORRECT", "PARTIALLY_CORRECT", "INCORRECT",
    "UNCLEAR", "NO_RESPONSE", "OFF_TOPIC", "NOT_APPLICABLE",
  ]),
  evidence_quality: z.enum(["NONE", "WEAK", "MODERATE", "STRONG", "CONCLUSIVE"]),
  error_family: z.enum([
    "CONCEPTUAL", "PREREQUISITE", "PROCEDURAL", "CALCULATION_EXECUTION",
    "READING_LANGUAGE", "ATTENTION_RESPONSE", "GUESSING_CONFIDENCE",
    "INCOMPLETE_COMMUNICATION", "TRANSFER_BLOOM", "COGNITIVE_LOAD_PACE",
  ]).nullable(),
  error_stability: z.enum(["FIRST_OCCURRENCE", "PERSISTENT"]).nullable(),
});

export const nodeDecisionSchema = z.object({
  action: z.enum([
    "CONTINUE_SAME_NODE",   // session node stays the same
    "COMPLETE_NODE",        // P5 canonical — mastery gate checks this
    "GUIDED_QUESTION",
    "HINT",
    "EXTRA_EXAMPLE",
    "CONTRAST_EXAMPLE",
    "CHANGE_REPRESENTATION",
    "STEP_BY_STEP",
    "SIMPLIFY_LANGUAGE",
    "LOWER_DIFFICULTY",
    "RAISE_DIFFICULTY",
    "RETURN_TO_PREREQUISITE",
    "VERIFY_SELECTION",
    "REQUIRE_REASONING",
  ]),
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
5. NEVER enumerate long numeric/item sequences literally in student_message
   (e.g. never write out "1, 2, 3, 4, 5... 500" or list every element of a
   large set). If a sequence needs illustration, show at most 5-6
   representative values followed by "..." (e.g. "1, 2, 3, 4, 5, ..."). If
   asked to demonstrate a long list, describe the PATTERN in words instead
   of enumerating it.
6. ALWAYS return the complete required JSON object structure below — NEVER
   return a bare array, a bare string, or any partial/truncated JSON as the
   entire response.

TEACHING CYCLE (P4 §11):
- TEACH: Present ONE concept (2-3 sentences) then ask ONE MICRO_CHECK question (≤25 words) in the same message.
- MICRO_CHECK: Standalone check question only (no new theory).
- FEEDBACK: Evaluate student answer → correct/guide → ask next MICRO_CHECK or proceed.
- TRANSITION: Signal moving to next concept/phase.

EVIDENCE QUALITY (P5 §17.13) — STRICT:
- Student answers MICRO_CHECK correctly → evidence_quality = "MODERATE" (NEVER "STRONG" from MICRO_CHECK alone)
- Student solves a practical exercise successfully → evidence_quality = "STRONG"
- node_decision.action = "COMPLETE_NODE" requires at least 1 STRONG evidence event on this node. Never recommend COMPLETE_NODE based only on a MICRO_CHECK.

ERROR FAMILY → ACTION MAP (P4 §9 / P5 §9 / P7 §8) — pick ONE family per incorrect/partial answer, then use its action. Each line: FAMILY — when to use it — ACTION — what the action means in practice.
- CONCEPTUAL — core idea not formed/confused — EXTRA_EXAMPLE (one more worked example, different framing) or CONTRAST_EXAMPLE (show a similar-but-different case to sharpen the boundary)
- PREREQUISITE — missing earlier-topic knowledge — RETURN_TO_PREREQUISITE (briefly re-teach ONLY the missing piece, not the whole prior lesson)
- PROCEDURAL — right idea, wrong step order — STEP_BY_STEP (give ONLY the next step, never the full sequence, never the final answer — see PRIORITY RULE below)
- CALCULATION_EXECUTION — right approach, arithmetic slip — VERIFY_SELECTION (ask them to recheck only the calculation, don't say if right/wrong)
- READING_LANGUAGE — misread the question — SIMPLIFY_LANGUAGE (rephrase shorter, never give the answer)
- ATTENTION_RESPONSE — careless slip — VERIFY_SELECTION
- GUESSING_CONFIDENCE — looks like a guess, no reasoning shown — REQUIRE_REASONING (ask "why" before accepting)
- INCOMPLETE_COMMUNICATION — partial/"I don't know" — GUIDED_QUESTION (ask only for the missing part)
- TRANSFER_BLOOM — understands base concept, fails to apply at required level — CHANGE_REPRESENTATION or APPLICATION context shift
- COGNITIVE_LOAD_PACE — overload signs — LOWER_DIFFICULTY/STEP_BY_STEP; underchallenge — RAISE_DIFFICULTY

Other actions (used outside error-repair, e.g. after correct answers or for pacing): CONTINUE_SAME_NODE (proceed within node), COMPLETE_NODE (backend-gated, only propose after STRONG/CONCLUSIVE real-exercise evidence), HINT (short low-content nudge).

PRIORITY RULE (resolves the most common internal conflict) — CRITICAL:
"Never give direct answers" ALWAYS outranks "give the next step."
When using STEP_BY_STEP or GUIDED_QUESTION on a multi-step problem, give the student the NEXT SUB-QUESTION to answer themselves — never state the final numeric/verbal answer yourself, even partially, even as a "let's see if..." aside. If you catch yourself about to state the answer, stop and turn it into a question instead.

error_stability RULE (P5 §10.2) — CRITICAL, never violate:
- A MICRO_CHECK incorrect answer is ALWAYS error_stability = "FIRST_OCCURRENCE" on its first occurrence, NEVER "PERSISTENT".
- Only set error_stability = "PERSISTENT" if the SAME error_family has already occurred on THIS node in a PREVIOUS turn (visible in chat history above) — never from a single incorrect answer alone.

MICRO_CHECK EVIDENCE TABLE (P5 §17.13.1-17.13.5) — apply exactly when is_micro_check was true on the PREVIOUS assistant turn and this turn is the student's answer to it:
- Student answer is CORRECT → evidence_quality="MODERATE" (never STRONG), node_decision.action="CONTINUE_SAME_NODE". Do NOT use HINT/EXTRA_EXAMPLE/CHANGE_REPRESENTATION/COMPLETE_NODE this turn.
- Student answer is INCORRECT → evidence_quality="NONE", error_family="CONCEPTUAL" (unless a different family clearly fits), error_stability="FIRST_OCCURRENCE", node_decision.action="CHANGE_REPRESENTATION". Do NOT use CONTINUE_SAME_NODE/COMPLETE_NODE this turn.
- Student answer is PARTIALLY_CORRECT → evidence_quality="WEAK", error_family="CONCEPTUAL", node_decision.action="GUIDED_QUESTION". Do NOT use CONTINUE_SAME_NODE/COMPLETE_NODE this turn.
- Student gave NO_RESPONSE ("չգիտեմ" or empty/off-topic) → evidence_quality="NONE", node_decision.action="HINT" or "LOWER_DIFFICULTY". Do NOT use CONTINUE_SAME_NODE/COMPLETE_NODE this turn.
- Student answer is UNCLEAR (can't tell what they mean) → evidence_quality="NONE", node_decision.action="GUIDED_QUESTION". Do NOT use CONTINUE_SAME_NODE/COMPLETE_NODE this turn.

EXERCISE VERBATIM RULE:
- If exerciseTextVerbatim is listed for an exercise: reproduce it WORD FOR WORD in student_message (no changes to any number, variable, or word).
- Append "(Էջ {sourcePage}, Վ. {exerciseId})" immediately after the verbatim exercise text.

OUTPUT FORMAT: Return VALID JSON ONLY. No markdown, no \`\`\`json fences, no explanatory text outside the JSON.

IMPORTANT — teaching_mode and node_decision.action are TWO SEPARATE fields with COMPLETELY DIFFERENT allowed values. Do not confuse them.
- teaching_mode is ALWAYS exactly one of: TEACH, MICRO_CHECK, FEEDBACK, TRANSITION.
- node_decision.action is the pedagogical action and is one of the 14 values in the ERROR FAMILY → ACTION MAP above (CONTINUE_SAME_NODE, COMPLETE_NODE, GUIDED_QUESTION, HINT, EXTRA_EXAMPLE, CONTRAST_EXAMPLE, CHANGE_REPRESENTATION, STEP_BY_STEP, SIMPLIFY_LANGUAGE, LOWER_DIFFICULTY, RAISE_DIFFICULTY, RETURN_TO_PREREQUISITE, VERIFY_SELECTION, REQUIRE_REASONING).
NEVER put a node_decision.action value (e.g. "GUIDED_QUESTION") into the teaching_mode field. If you are asking a guiding question after an incorrect answer, teaching_mode should be "FEEDBACK" and node_decision.action should be "GUIDED_QUESTION" — these are independent.

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
    "status": "CORRECT" | "PARTIALLY_CORRECT" | "INCORRECT" | "UNCLEAR" | "NO_RESPONSE" | "OFF_TOPIC" | "NOT_APPLICABLE",
    "evidence_quality": "NONE" | "WEAK" | "MODERATE" | "STRONG" | "CONCLUSIVE",
    "error_family": "CONCEPTUAL" | "PREREQUISITE" | "PROCEDURAL" | "CALCULATION_EXECUTION" | "READING_LANGUAGE" | "ATTENTION_RESPONSE" | "GUESSING_CONFIDENCE" | "INCOMPLETE_COMMUNICATION" | "TRANSFER_BLOOM" | "COGNITIVE_LOAD_PACE" | null,
    "error_stability": "FIRST_OCCURRENCE" | "PERSISTENT" | null
  },
  "node_decision": {
    "action": "CONTINUE_SAME_NODE" | "COMPLETE_NODE" | "GUIDED_QUESTION" | "HINT" | "EXTRA_EXAMPLE" | "CONTRAST_EXAMPLE" | "CHANGE_REPRESENTATION" | "STEP_BY_STEP" | "SIMPLIFY_LANGUAGE" | "LOWER_DIFFICULTY" | "RAISE_DIFFICULTY" | "RETURN_TO_PREREQUISITE" | "VERIFY_SELECTION" | "REQUIRE_REASONING",
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
      frequency_penalty: 0.3,
    });

    if (!response.choices || response.choices.length === 0) {
      logger.error(
        { response },
        "callAI: API response has no choices (possible rate-limit, moderation block, or malformed API response)"
      );
      throw new Error("AI API returned no choices");
    }
    return response.choices[0]?.message?.content ?? "Կներեք, կրկին փորձեք։";
  } catch (err) {
    logger.error({ err }, "OpenRouter AI error");
    throw err;
  }
}

// ── Structured response validation (post-Zod semantic checks) ────────────────

function validateStructuredResponse(response: AIStructuredResponse): void {
  const msg = response.student_message;

  // A) Language check — English words and Cyrillic text are forbidden.
  //
  // Allowed Latin: single-letter math variables (x, y, a, b, n, …) standing
  //   alone or adjacent only to digits/superscripts/operators/spaces.
  //   i.e. a Latin letter is OK iff it is NOT immediately preceded OR followed
  //   by another Latin letter → regex: two or more consecutive Latin letters =
  //   a word → reject.
  // Allowed always: Armenian (U+0531–U+058F), digits, math symbols (×÷√),
  //   Unicode superscripts, punctuation, whitespace.
  //
  // Examples:
  //   "x⁴ + 2"    → OK   (single Latin letter, no consecutive pair)
  //   "a × b"     → OK
  //   "hello world" → FAIL ([A-Za-z]{2,} matches "hello" and "world")
  //   "привет"    → FAIL (Cyrillic)

  const latinWord = /[A-Za-z]{2,}/u;   // two or more consecutive Latin letters
  const cyrillic  = /[\u0400-\u04FF]/u; // any Cyrillic character

  if (latinWord.test(msg)) {
    const words = msg.match(/[A-Za-z]{2,}/gu) ?? [];
    throw new Error(
      `validateStructuredResponse: student_message contains Latin word(s): ${words.slice(0, 5).join(", ")}`
    );
  }
  if (cyrillic.test(msg)) {
    const sample = msg.match(/[\u0400-\u04FF]+/gu)?.[0] ?? "";
    throw new Error(
      `validateStructuredResponse: student_message contains Cyrillic text: "${sample}"`
    );
  }

  logger.debug(
    {
      "x⁴ + 2":    !/[A-Za-z]{2,}/u.test("x⁴ + 2")    && !/[\u0400-\u04FF]/u.test("x⁴ + 2"),    // true
      "hello world": !/[A-Za-z]{2,}/u.test("hello world"),                                          // false
      "привет":    !/[\u0400-\u04FF]/u.test("привет"),                                              // false
    },
    "validateStructuredResponse lang-check examples (all should be true/false/false)"
  );

  // B) Length check — more than 5 sentences or more than 700 characters
  // Sentence split on Armenian/common sentence-ending punctuation (։ . ! ?)
  const sentences = msg
    .split(/[։.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length > 5) {
    throw new Error(
      `validateStructuredResponse: student_message has ${sentences.length} sentences (max 5)`
    );
  }
  if (msg.length > 700) {
    throw new Error(
      `validateStructuredResponse: student_message is ${msg.length} chars (max 700)`
    );
  }

  // C) Node lock — AI self-reported that it mentioned an out-of-scope topic
  if (response.mentions_out_of_scope_topic === true) {
    logger.warn(
      { student_message_preview: msg.slice(0, 120) },
      "validateStructuredResponse: mentions_out_of_scope_topic=true — AI deviated from node lock"
    );
    throw new Error(
      "validateStructuredResponse: AI mentioned out-of-scope topic (mentions_out_of_scope_topic=true)"
    );
  }

  // D) redirect_needed — allowed through without modification (no-op check)
}

// ── callAIStructured inner attempt (single API call + parse + validate) ───────

async function _attemptStructured(
  systemPrompt: string,
  messages: ChatMessage[]
): Promise<AIStructuredResponse> {
  const response = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 1500,
    temperature: 0.5,
    frequency_penalty: 0.3,
    response_format: { type: "json_object" } as { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      ...messages,
    ],
  });

  if (!response.choices || response.choices.length === 0) {
    logger.error(
      { response },
      "callAIStructured: API response has no choices (possible rate-limit, moderation block, or malformed API response)"
    );
    throw new Error("AI API returned no choices");
  }

  const raw = response.choices[0]?.message?.content ?? "{}";
  const trimmedRaw = raw.trim();

  if (trimmedRaw.length === 0) {
    throw new Error("AI structured response was empty");
  }

  if (!trimmedRaw.startsWith("{")) {
    logger.warn(
      { rawPreview: trimmedRaw.slice(0, 200), rawLength: trimmedRaw.length },
      "callAIStructured: model returned non-JSON-object response (likely a bare array/list) — failing fast"
    );
    throw new Error("AI structured response did not start with '{' — model deviated from JSON schema");
  }

  const cleaned = raw.replace(/```json|```/g, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.error({ err, raw }, "callAIStructured: JSON parse failed");
    throw new Error(`AI structured response was not valid JSON: ${String(err)}`);
  }

  let validated: AIStructuredResponse;
  try {
    validated = aiStructuredResponseSchema.parse(parsed);
  } catch (err) {
    logger.error({ err, parsed }, "callAIStructured: Zod validation failed");
    throw new Error(`AI structured response failed schema validation: ${String(err)}`);
  }

  validateStructuredResponse(validated);
  return validated;
}

// ── callAIStructured (max 2 attempts, 1 retry on schema/parse/empty/deviation) ─

const RETRY_CORRECTION =
  "\n\nPrevious response failed schema validation. Return ONLY valid JSON matching the required schema.";

export async function callAIStructured(
  messages: ChatMessage[],
  lessonContext: string
): Promise<AIStructuredResponse> {
  const baseSystem = `${STRUCTURED_SYSTEM_PROMPT}\n\n══════════════════\n${lessonContext}\n══════════════════`;

  // ── Debug: lesson context diagnostics ────────────────────────────────────
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  logger.debug(
    {
      contextLength:    lessonContext.length,
      contextHead:      lessonContext.slice(0, 500),
      contextTail:      lessonContext.slice(-500),
      hasCurrentNode:   lessonContext.includes("CURRENT_NODE"),
      hasAllowedNodes:  lessonContext.includes("ALLOWED_NODES"),
      hasLesson:        lessonContext.includes("LESSON"),
      hasNode:          lessonContext.includes("NODE"),
      hasExercise:      lessonContext.includes("exercise"),
      hasEssentialQ:    lessonContext.includes("essentialQuestion"),
      messageCount:     messages.length,
      lastUserPreview:  lastUserMsg?.content.slice(0, 200) ?? "(none)",
    },
    "callAIStructured: context diagnostics"
  );

  // ── Attempt 1 ────────────────────────────────────────────────────────────
  let firstError: Error;
  try {
    const result = await _attemptStructured(baseSystem, messages);
    logger.debug("callAIStructured: attempt 1 succeeded");
    return result;
  } catch (err) {
    firstError = err instanceof Error ? err : new Error(String(err));
    logger.warn(
      { err: firstError.message },
      "callAIStructured: attempt 1 failed — will retry once"
    );
  }

  // ── Attempt 2 (retry) ─────────────────────────────────────────────────────
  logger.info("callAIStructured: retrying (attempt 2/2)");
  const retrySystem = baseSystem + RETRY_CORRECTION;
  try {
    const result = await _attemptStructured(retrySystem, messages);
    logger.info("callAIStructured: retry (attempt 2) succeeded");
    return result;
  } catch (err) {
    const retryError = err instanceof Error ? err : new Error(String(err));
    logger.error(
      { firstError: firstError.message, retryError: retryError.message },
      "callAIStructured: retry (attempt 2) also failed — throwing final error"
    );
    throw retryError;
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

  if (!response.choices || response.choices.length === 0) {
    logger.error(
      { response },
      "callAIP6: API response has no choices (possible rate-limit, moderation block, or malformed API response)"
    );
    throw new Error("AI API returned no choices");
  }
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
