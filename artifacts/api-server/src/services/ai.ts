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
  // Required when status="PARTIALLY_CORRECT" — short English phrases, ≥1 array must be non-empty
  correct_parts: z.array(z.string()).default([]),
  incorrect_parts: z.array(z.string()).default([]),
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
- You are FORBIDDEN from introducing any concept, definition, or skill not present in ALLOWED_NODES — even if it is mathematically adjacent or would "naturally follow".
- You are FORBIDDEN from declaring the lesson or node finished — that decision belongs ONLY to the backend.
- If the student asks to skip, change topic, or move to another lesson, set redirect_needed: true, and in student_message give a short, warm redirection back to the current unanswered question — NO new content.
- Set mentions_out_of_scope_topic: true if your own student_message mentions any concept outside the current node list (self-audit).
- FORBIDDEN TRANSITION PHRASES — NEVER write these in student_message while STUDENT_STATE shows node_stage ≠ VERIFIED:
  «անցնենք հաջորդ թեմային», «անցնենք հաջորդ դասին», «շարունակենք հաջորդ բաժինը», «անցնենք առաջ».
  The backend controls ALL node transitions. Continue teaching the current node until node_stage=VERIFIED.

ALL-NODES-DONE STATE — when context shows CURRENT_NODE: (none) or LESSON BOUNDARY block:
- ALL nodes for this lesson have been completed. Do NOT introduce any new mathematical concept, topic, chapter, or skill.
- Work ONLY with concepts from the COMPLETED_NODES list provided in context.
- Your only permitted actions: (1) summarize what was learned from COMPLETED_NODES, (2) present DEEP_DIVE_EXERCISES or HOMEWORK_TASKS listed in context verbatim, (3) close the session warmly.
- Do NOT invent exercises. If no exercises are provided, go straight to a warm closing summary.

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

ANSWER-MATCHES-QUESTION RULE — CRITICAL, check this BEFORE scoring any answer:
The student's response must directly answer the SPECIFIC item requested in PREVIOUS_MICRO_CHECK.
A true mathematical statement about the topic is NOT sufficient if it does not answer the requested item.
- First ask: "What exact value or fact did the question ask for?"
- Then ask: "Did the student's response provide that specific value or fact?"
- If NO: the answer does NOT match the question → status="INCORRECT", error_family="READING_LANGUAGE" (student answered a different question), node_decision.action="SIMPLIFY_LANGUAGE" (re-ask the specific question more clearly).
- Example violation: Question asks "How many units are in rank I of 7324?" → correct answer is "4". Student writes "7000+300+20+4". This is a true decomposition of 7324 but does NOT answer "how many units in rank I". → status="INCORRECT".
- Example OK: Question asks "What is the rank-I value of 7324?" → student writes "4" or "4 units" or "rank I has 4". → status="CORRECT".
- Do NOT give credit for demonstrating broader concept knowledge when the question asked for one specific fact.

MICRO_CHECK EVIDENCE TABLE (P5 §17.13.1-17.13.5) — apply exactly when is_micro_check was true on the PREVIOUS assistant turn and this turn is the student's answer to it:
- Student answer is CORRECT → evidence_quality="MODERATE" (never STRONG), node_decision.action="CONTINUE_SAME_NODE". Do NOT use HINT/EXTRA_EXAMPLE/CHANGE_REPRESENTATION/COMPLETE_NODE this turn.
- Student answer is INCORRECT → evidence_quality="NONE", error_family="CONCEPTUAL" (unless a different family clearly fits), error_stability="FIRST_OCCURRENCE", node_decision.action="CHANGE_REPRESENTATION". Do NOT use CONTINUE_SAME_NODE/COMPLETE_NODE this turn.
- Student answer is PARTIALLY_CORRECT → evidence_quality="WEAK", error_family="CONCEPTUAL", node_decision.action="GUIDED_QUESTION". Do NOT use CONTINUE_SAME_NODE/COMPLETE_NODE this turn.
- Student gave NO_RESPONSE ("չգիտեմ" or empty/off-topic) → evidence_quality="NONE", node_decision.action="HINT" or "LOWER_DIFFICULTY". Do NOT use CONTINUE_SAME_NODE/COMPLETE_NODE this turn.
- Student answer is UNCLEAR (can't tell what they mean) → evidence_quality="NONE", node_decision.action="GUIDED_QUESTION". Do NOT use CONTINUE_SAME_NODE/COMPLETE_NODE this turn.

PARTIALLY_CORRECT RULE — mandatory when part of the answer is right and part is wrong:
- Use status="PARTIALLY_CORRECT" when the student demonstrates the correct concept but makes a detail or calculation mistake.
  Example: student says "the place value is hundreds" ✓ but "the value is 403" ✗ → status="PARTIALLY_CORRECT",
  correct_parts=["identified hundreds place"], incorrect_parts=["stated value as 403 instead of 400"].
- correct_parts and incorrect_parts MUST each contain at least one short English phrase (5-15 words) when status="PARTIALLY_CORRECT".
- Do NOT use PARTIALLY_CORRECT if nothing is right (use INCORRECT). Do NOT use CORRECT if anything significant is wrong.
- In student_message: acknowledge the correct part FIRST ("Ճիշտ մասը..."), then explain ONLY the mistake briefly. Never state the full correct answer.

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
    "error_stability": "FIRST_OCCURRENCE" | "PERSISTENT" | null,
    "correct_parts": ["<short English phrase: what the student got right, e.g. 'identified the hundreds place'>"],
    "incorrect_parts": ["<short English phrase: what was wrong, e.g. 'stated value as 403 instead of 400'>"]
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

  // Roman numeral exemption (uppercase only, case-sensitive).
  // Pattern matches well-formed values I–XXXIX and the same family beyond
  // (e.g. XLII is NOT matched, which is intentional: the spec pattern covers
  // only the X{0,3} + ones sub-pattern, rejecting malformed runs like IIII).
  const ROMAN_NUMERAL = /^(X{0,3})(IX|IV|V?I{0,3})$/;   // e.g. I II III IV IX XI XIV XXXIX

  if (latinWord.test(msg)) {
    const allMatches = msg.match(/[A-Za-z]{2,}/gu) ?? [];
    const nonRoman   = allMatches.filter((w) => !ROMAN_NUMERAL.test(w));

    if (nonRoman.length > 0) {
      throw new Error(
        `validateStructuredResponse: student_message contains Latin word(s): ${nonRoman.slice(0, 5).join(", ")}`
      );
    }

    // All multi-letter Latin sequences are valid Roman numerals — allow through.
    logger.debug(
      { romanNumerals: allMatches },
      "validateStructuredResponse: allowed Roman numeral(s)"
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

  // E) PARTIALLY_CORRECT must include at least one documented part
  if (response.answer_evaluation.status === "PARTIALLY_CORRECT") {
    const hasParts =
      response.answer_evaluation.correct_parts.length > 0 ||
      response.answer_evaluation.incorrect_parts.length > 0;
    if (!hasParts) {
      throw new Error(
        "validateStructuredResponse: PARTIALLY_CORRECT requires non-empty correct_parts or incorrect_parts"
      );
    }
  }
}

// ── Node Lock consistency check ──────────────────────────────────────────────
//
// Parses CURRENT_NODE and ALLOWED_NODES from lessonContext (both injected by
// the route layer as structured text) and verifies the response is consistent.
//
// Checks performed (keyword-based, no extra API call):
//   1. progress_indicator.current_node_name must appear in the ALLOWED_NODES list.
//   2. progress_indicator.current_node_name must loosely match CURRENT_NODE.
//   3. student_message must contain ≥1 keyword (≥4 chars) from CURRENT_NODE title
//      or the student_message is ≤80 chars (trivially short messages are skipped).
//      Violation here → warn only (too noisy to throw on free Armenian text).

function validateNodeLock(
  response: AIStructuredResponse,
  lessonContext: string
): void {
  // ── Parse CURRENT_NODE ───────────────────────────────────────────────────
  const currentNodeMatch = lessonContext.match(/CURRENT_NODE:\s*«([^»]+)»/);
  const currentNodeTitle = currentNodeMatch?.[1]?.trim() ?? null;

  // ── Parse ALLOWED_NODES list ─────────────────────────────────────────────
  const allowedNodesLine = lessonContext.match(/ALLOWED_NODES \(full list\):\s*([^\n]+)/);
  const allowedNodeTitles: string[] = allowedNodesLine
    ? [...allowedNodesLine[1].matchAll(/«([^»]+)»/g)].map((m) => m[1].trim())
    : [];

  // If context carries no node data skip all checks (no-node lesson).
  if (!currentNodeTitle && allowedNodeTitles.length === 0) {
    logger.debug("validateNodeLock: no node data in context — skipping");
    return;
  }

  const reportedNode = response.progress_indicator.current_node_name.trim();

  // ── Check 1: reported node must be in ALLOWED_NODES ─────────────────────
  if (allowedNodeTitles.length > 0) {
    const inAllowed = allowedNodeTitles.some(
      (t) => t.toLowerCase() === reportedNode.toLowerCase()
    );
    if (!inAllowed) {
      logger.warn(
        { reportedNode, allowedNodeTitles },
        "validateNodeLock: progress_indicator.current_node_name not in ALLOWED_NODES"
      );
      throw new Error(
        `Node lock violation: reported node «${reportedNode}» is not in ALLOWED_NODES`
      );
    }
  }

  // ── Check 2: reported node must match CURRENT_NODE ───────────────────────
  if (currentNodeTitle) {
    const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    if (normalise(reportedNode) !== normalise(currentNodeTitle)) {
      logger.warn(
        { reportedNode, currentNodeTitle },
        "validateNodeLock: progress_indicator.current_node_name does not match CURRENT_NODE"
      );
      throw new Error(
        `Node lock violation: reported node «${reportedNode}» ≠ CURRENT_NODE «${currentNodeTitle}»`
      );
    }
  }

  // ── Check 3: student_message should reference CURRENT_NODE keywords ──────
  // Warn-only — free Armenian text is too noisy for a hard throw.
  if (currentNodeTitle) {
    const keywords = currentNodeTitle
      .split(/[\s,;:«»()]+/)
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w.length >= 4);

    const msgLower = response.student_message.toLowerCase();
    const hasKeyword = keywords.some((kw) => msgLower.includes(kw));

    if (!hasKeyword && response.student_message.length > 80) {
      logger.warn(
        { currentNodeTitle, keywords, msgPreview: response.student_message.slice(0, 120) },
        "validateNodeLock: student_message contains no keyword from CURRENT_NODE title (possible topic drift)"
      );
      // warn only — do not throw (Armenian morphology causes false positives)
    }
  }
}

// ── Premature transition guard ────────────────────────────────────────────────
//
// Detects two classes of premature transition:
//   (A) Text-based: forbidden Armenian phrases in student_message while the node
//       is not yet complete (node_stage ≠ VERIFIED and not on the no-exercise
//       early-complete path).
//   (B) Decision-based: node_decision.action="COMPLETE_NODE" during THEORY stage
//       or during MICRO_CHECK stage when exercises exist (must go through EXERCISE).
//
// "Node complete" is defined by STUDENT_STATE in lessonContext:
//   node_stage=VERIFIED                 → complete (transition allowed)
//   no node_stage in context            → no active node (no-op)
//   node_stage=MICRO_CHECK + no exercises + node_attempts ≥ 2 → early-complete path (allowed)
//   everything else                     → incomplete → guard fires

const PREMATURE_TRANSITION_PHRASES: string[] = [
  // full spec phrases
  "\u0561\u0576\u0581\u0576\u0565\u0576\u0584 \u0570\u0561\u057b\u0578\u0580\u0564 \u0569\u0565\u0574\u0561\u0575\u056b\u0576", // անcнenq hajoRд themayin
  "\u0561\u0576\u0581\u0576\u0565\u0576\u0584 \u0570\u0561\u057b\u0578\u0580\u0564 \u0564\u0561\u057d\u056b\u0576",               // անcнenq hajoRд dassin
  "\u0577\u0561\u0580\u0578\u0582\u0576\u0561\u056f\u0565\u0576\u0584 \u0570\u0561\u057b\u0578\u0580\u0564 \u0562\u0561\u056a\u056b\u0576\u0568", // sharunakenq hajoRд bazhine
  "\u0561\u0576\u0581\u0576\u0565\u0576\u0584 \u0561\u057c\u0561\u057b",                                                          // anctnenq arraj
  // shorter sub-phrases (broad catch)
  "\u0561\u0576\u0581\u0576\u0565\u0576\u0584 \u0570\u0561\u057b\u0578\u0580\u0564",  // anctnenq hajoRд (let's move to next X)
  "\u0577\u0561\u0580\u0578\u0582\u0576\u0561\u056f\u0565\u0576\u0584 \u0570\u0561\u057b\u0578\u0580\u0564", // sharunakenq hajoRд
  "\u0570\u0561\u057b\u0578\u0580\u0564 \u0569\u0565\u0574\u0561",  // hajoRд thema (next topic)
  "\u0570\u0561\u057b\u0578\u0580\u0564 \u0564\u0561\u057d",        // hajoRд das   (next lesson)
  "\u0576\u0578\u0580 \u0564\u0561\u057d",                          // nor das      (new lesson)
];

function validatePrematureTransition(
  response: AIStructuredResponse,
  lessonContext: string
): void {
  // ── Parse STUDENT_STATE ──────────────────────────────────────────────────
  const stateMatch = lessonContext.match(/STUDENT_STATE:\s*([^\n]+)/);
  const stateStr   = stateMatch?.[1] ?? "";

  // No STUDENT_STATE in context → no active teaching phase → skip
  if (!stateStr) return;

  const nodeStageMatch = stateStr.match(/node_stage=(\w+)/);
  const nodeStage      = nodeStageMatch?.[1] ?? null;

  // No node_stage → lesson has no nodes or we're in phase 1/3 → skip
  if (!nodeStage) return;

  const attemptsMatch = stateStr.match(/node_attempts=(\d+)/);
  const nodeAttempts  = attemptsMatch ? parseInt(attemptsMatch[1], 10) : 0;

  // ── Parse CURRENT_NODE title for logging ─────────────────────────────────
  const currentNodeMatch = lessonContext.match(/CURRENT_NODE:\s*«([^»]+)»/);
  const currentNodeTitle = currentNodeMatch?.[1]?.trim() ?? "(unknown)";

  // ── Determine whether transition is already permitted ────────────────────
  const isVerified  = nodeStage === "VERIFIED";

  // No-exercise early-complete path: MICRO_CHECK stage + 2+ attempts + no exercises
  // Use the injected block header ("CLASS_EXERCISES (use verbatim") not the bare token —
  // the phase-2 guidance prose contains "CLASS_EXERCISES" even when no exercises are present.
  const hasExercisesInContext = lessonContext.includes("CLASS_EXERCISES (use verbatim");
  const noExerciseEarlyComplete =
    nodeStage === "MICRO_CHECK" && nodeAttempts >= 2 && !hasExercisesInContext;

  const transitionAllowed = isVerified || noExerciseEarlyComplete;
  if (transitionAllowed) return;

  // ── (A) Text-based check: forbidden phrases in student_message ───────────
  const msgLower    = response.student_message.toLowerCase();
  const foundPhrase = PREMATURE_TRANSITION_PHRASES.find((p) => msgLower.includes(p));

  if (foundPhrase) {
    logger.warn(
      {
        currentNode:        currentNodeTitle,
        foundPhrase,
        nodeStage,
        nodeAttempts,
        nodeDecisionAction: response.node_decision.action,
        msgPreview:         response.student_message.slice(0, 150),
      },
      "validatePrematureTransition: transition phrase found while node is incomplete"
    );
    throw new Error(
      `Premature transition: phrase found in student_message while «${currentNodeTitle}» is not complete (node_stage=${nodeStage})`
    );
  }

  // ── (B) Decision-based check: COMPLETE_NODE against stage ────────────────
  if (response.node_decision.action === "COMPLETE_NODE") {
    if (nodeStage === "THEORY") {
      logger.warn(
        { currentNode: currentNodeTitle, nodeStage, nodeAttempts },
        "validatePrematureTransition: COMPLETE_NODE during THEORY — must teach and check first"
      );
      throw new Error(
        `Premature COMPLETE_NODE: node_stage is THEORY for «${currentNodeTitle}» — must present content and ask MICRO_CHECK first`
      );
    }
    // Has exercises but AI skips to COMPLETE_NODE from MICRO_CHECK stage (before EXERCISE stage)
    if (nodeStage === "MICRO_CHECK" && hasExercisesInContext) {
      logger.warn(
        { currentNode: currentNodeTitle, nodeStage, nodeAttempts, hasExercisesInContext },
        "validatePrematureTransition: COMPLETE_NODE skips EXERCISE stage when exercises exist"
      );
      throw new Error(
        `Premature COMPLETE_NODE: «${currentNodeTitle}» has class exercises but node_stage=${nodeStage} — must go through EXERCISE stage first`
      );
    }
  }
}

// ── Teaching cycle enforcement ────────────────────────────────────────────────
//
// Validates that the AI's response is consistent with the expected teaching
// cycle (P4 §11).  All violations throw so the existing retry wrapper fires.
//
// Rule 1 — After a MICRO_CHECK turn the response MUST be FEEDBACK, not TEACH.
//   Detection: lessonContext contains "PREVIOUS_MICRO_CHECK: <text>" (not "(none)").
//   (Messages are plain text; is_micro_check cannot be extracted from them.)
//
// Rule 2 — TEACH must have is_micro_check=true (concept + check in one turn).
//
// Rule 3 — MICRO_CHECK student_message must contain a question (? or ՞).
//
// Rule 4 — FEEDBACK must reflect the student's answer
//   (answer_evaluation.status ≠ NOT_APPLICABLE), unless redirect_needed=true.
//
// Rule 5 — COMPLETE_NODE requires evidence_quality STRONG or CONCLUSIVE.

function validateTeachingCycle(
  response: AIStructuredResponse,
  _messages: ChatMessage[],
  lessonContext: string
): void {
  const mode   = response.teaching_mode;
  const action = response.node_decision.action;
  const quality = response.answer_evaluation.evidence_quality;
  const status  = response.answer_evaluation.status;
  const msg     = response.student_message;

  // ── Rule 1: after MICRO_CHECK → must be FEEDBACK, not TEACH ───────────────
  // PREVIOUS_MICRO_CHECK is "(none)" when no prior micro_check exists.
  const prevMicroCheckLine = lessonContext.match(/PREVIOUS_MICRO_CHECK:\s*(.+)/);
  const prevMicroCheckText = prevMicroCheckLine?.[1]?.trim() ?? "";
  const hadMicroCheck =
    prevMicroCheckText.length > 0 && prevMicroCheckText !== "(none)";

  if (hadMicroCheck && mode === "TEACH") {
    logger.warn(
      { prevMicroCheckPreview: prevMicroCheckText.slice(0, 80), teaching_mode: mode },
      "validateTeachingCycle [R1]: TEACH after MICRO_CHECK — must be FEEDBACK"
    );
    throw new Error(
      "Teaching cycle violation [R1]: previous turn had MICRO_CHECK but response is TEACH — must be FEEDBACK"
    );
  }

  // ── Rule 2: TEACH must have is_micro_check=true ────────────────────────────
  if (mode === "TEACH" && response.is_micro_check !== true) {
    logger.warn(
      { teaching_mode: mode, is_micro_check: response.is_micro_check },
      "validateTeachingCycle [R2]: TEACH response missing is_micro_check=true"
    );
    throw new Error(
      "Teaching cycle violation [R2]: teaching_mode=TEACH but is_micro_check is not true"
    );
  }

  // ── Rule 3: MICRO_CHECK student_message must contain a question ───────────
  // Accepts standard "?" or Armenian question mark "՞" (U+055E).
  if (mode === "MICRO_CHECK") {
    const hasQuestion = /[?՞]/u.test(msg);
    if (!hasQuestion) {
      logger.warn(
        { msgPreview: msg.slice(0, 120) },
        "validateTeachingCycle [R3]: MICRO_CHECK student_message contains no question mark"
      );
      throw new Error(
        "Teaching cycle violation [R3]: teaching_mode=MICRO_CHECK but student_message has no question"
      );
    }
  }

  // ── Rule 4: FEEDBACK must reflect student answer ───────────────────────────
  // status=NOT_APPLICABLE is only valid when redirect_needed=true.
  if (mode === "FEEDBACK" && status === "NOT_APPLICABLE" && !response.redirect_needed) {
    logger.warn(
      { teaching_mode: mode, status, redirect_needed: response.redirect_needed },
      "validateTeachingCycle [R4]: FEEDBACK with NOT_APPLICABLE status and no redirect"
    );
    throw new Error(
      "Teaching cycle violation [R4]: teaching_mode=FEEDBACK but answer_evaluation.status=NOT_APPLICABLE without redirect_needed"
    );
  }

  // ── Rule 5: COMPLETE_NODE requires STRONG or CONCLUSIVE evidence ───────────
  if (action === "COMPLETE_NODE" && quality !== "STRONG" && quality !== "CONCLUSIVE") {
    // Exception: no-exercise path allows MODERATE (validated more precisely in validatePrematureTransition)
    // Use the injected block header — the phase-2 guidance prose also contains "CLASS_EXERCISES"
    // so a bare includes() always returns true in phase 2, killing the exemption.
    const hasExercisesR5 = lessonContext.includes("CLASS_EXERCISES (use verbatim");
    const stateR5 = lessonContext.match(/STUDENT_STATE:\s*([^\n]+)/)?.[1] ?? "";
    const nodeStageR5 = stateR5.match(/node_stage=(\w+)/)?.[1] ?? null;
    const attemptsR5 = parseInt(stateR5.match(/node_attempts=(\d+)/)?.[1] ?? "0", 10);
    const noExerciseEarlyOk = !hasExercisesR5 && nodeStageR5 === "MICRO_CHECK" && attemptsR5 >= 2 && quality === "MODERATE";
    if (!noExerciseEarlyOk) {
      logger.warn(
        { action, evidence_quality: quality },
        "validateTeachingCycle [R5]: COMPLETE_NODE with insufficient evidence"
      );
      throw new Error(
        `Teaching cycle violation [R5]: COMPLETE_NODE requires evidence_quality STRONG/CONCLUSIVE — got "${quality}"`
      );
    }
  }

  // ── Rule 6: COMPLETE_NODE is blocked in THEORY stage ─────────────────────
  // Full stage-gate is enforced by validatePrematureTransition; R6 provides a
  // cheap early fail specifically for THEORY (the most common incorrect case).
  if (action === "COMPLETE_NODE") {
    const stateR6   = lessonContext.match(/STUDENT_STATE:\s*([^\n]+)/)?.[1] ?? "";
    const stageR6   = stateR6.match(/node_stage=(\w+)/)?.[1] ?? null;
    if (stageR6 === "THEORY") {
      logger.warn(
        { action, nodeStage: stageR6 },
        "validateTeachingCycle [R6]: COMPLETE_NODE during THEORY stage"
      );
      throw new Error(
        "Teaching cycle violation [R6]: COMPLETE_NODE during THEORY stage — must present content and ask MICRO_CHECK first"
      );
    }
  }
}

// ── callAIStructured inner attempt (single API call + parse + validate) ───────

async function _attemptStructured(
  systemPrompt: string,
  messages: ChatMessage[],
  lessonContext: string
): Promise<AIStructuredResponse> {
  const response = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 2200,
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

  logger.info(
    {
      teaching_mode:   validated.teaching_mode,
      is_micro_check:  validated.is_micro_check,
      student_message: validated.student_message.slice(0, 200),
      node_decision:   validated.node_decision.action,
    },
    "AI STRUCTURED RESULT DEBUG"
  );

  validateStructuredResponse(validated);
  validateNodeLock(validated, lessonContext);
  validateTeachingCycle(validated, messages, lessonContext);
  validatePrematureTransition(validated, lessonContext);
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
    const result = await _attemptStructured(baseSystem, messages, lessonContext);
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
    const result = await _attemptStructured(retrySystem, messages, lessonContext);
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
