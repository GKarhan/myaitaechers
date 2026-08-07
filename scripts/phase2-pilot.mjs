/**
 * Phase 2 pilot — generate teaching content for ONE MicroNode (id=994)
 * grounded strictly in its own sourceText/theoryContent + linked exercises.
 * Run: node scripts/phase2-pilot.mjs
 * Uses fetch directly — no external package needed.
 */

const BASE_URL = process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL;
const API_KEY  = process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY;
if (!BASE_URL || !API_KEY) throw new Error("OpenRouter env vars missing: AI_INTEGRATIONS_OPENROUTER_BASE_URL / AI_INTEGRATIONS_OPENROUTER_API_KEY");

const MODEL = "deepseek/deepseek-v4-flash";

// ── Source data (verbatim from DB) ───────────────────────────────────────────
const node = {
  id: 994,
  title: "Գոյական անուն",
  learningObjective: "Ուսանողը կարող է սահմանել գոյականը և բացահայտել գոյականները տեքստում։",
  theoryContent: `ԳՈՅԱԿԱՆ ԱՆՈՒՆ

Գոյականը որպես խոսքի մաս

Առարկա ցույց տվող բառերը կոչվում են գոյական անուն կամ գոյական:

Քերականության մեջ առարկա ասելով հասկանում ենք ոչ միայն նյութական իրերը, այլև անձեր, կենդանիներ, բնության երևույթներ, զգացմունքներ, եղելություններ, գաղափարներ, օրինակ՝ պահարան, մարդ, խնդություն, կատու, հեղեղություն, փորձանք, որոտ:

Առարկա ցույց տվող բառերը պայմանականորեն բաժանվում են երկու խմբի՝ հատուկ և հասարակ:

Հատուկ անունները ցույց են տալիս առանձին անձերի, կենդանիների, տեղանունների, երկրների, քաղաքների, գետերի, լճերի, ծովերի, օվկիանոսների, լեռների, հրապարակների, փողոցների, գրքերի, թերթերի, ամսագրերի, կազմակերպությունների, հիմնարկների, տոների, աստղերի, համաստեղությունների, մոլորակների անուններ և այլն:`,
};

const exercises = [
  { id: "EX-68-1", text: "1. Ընդհանուր իմաստը՝ առարկա" },
  { id: "EX-68-2", text: "2. Ձևաբանական առանձնահատկությունը՝ բերվող (թիվ, հոլով, առում)" },
  { id: "EX-68-3", text: "3. Տեսակները՝ հատուկ, հասարակ, անձնանիշ, իրանիշ" },
  { id: "EX-68-4", text: "4. Շարահյուսական դերը՝ ենթակա, կոչական, ստորոգյալի մաս, գոյականական և բայական ածականի լրացում" },
  { id: "EX-68-5", text: "7. Ի՞նչ են ցույց տալիս հետևյալ բառաշարքում ընդգծված բառերը: Մեր պապանությունն է այս գրքի մեջ, Դրանք մեր ոգու գանձերն են անշեջ. Հնձվորի ձեռն է մնում ես հոգնած, Մարտունին է հսկում անդորր երանգ: (Մ. Մ.)" },
  { id: "EX-68-6", text: "8. Ստանձնագրու՝ առարկա՝ իր, անձ, կենդանի, բնության երևույթ, զգացմունք, եղելություն, գաղափար ցույց տվող գոյականները. հարբանական, փողոկա, բակային, գինվոր, պատերազմ, պատիվ, ցցվող, լուսան, կարկուտ, սյուք" },
];

const SYSTEM = `You are an expert Armenian language curriculum designer generating structured teaching content for a grade-7 Armenian textbook app.

STRICT GROUNDING RULES — violating these is worse than leaving a field empty:
1. explanationSteps, beginnerExplanation, advancedExplanation, recallQuestions, understandingQuestions: derived ONLY from the provided theoryContent — rephrase, sequence, or simplify what is already there; do NOT add facts not in the source.
2. commonErrors: build from the linked exercises (what wrong answers to those exercises look like). Stay grounded in the theory. Do NOT invent unrelated errors.
3. applicationQuestions: reference the actual linked exercises where possible (quote or paraphrase them).
4. analogy: the ONE field allowed to be freely creative. Mark contentSourceType="ai_generated" for analogy entries.
5. teachingContentConfidence (0–100): 85–100 = grounded in verbatim text; 60–84 = inferred; <60 = AI-generated creative content.

Return ONLY valid JSON. No markdown fences. No commentary outside the JSON.`;

const USER = `Generate Phase 2 teaching content for this MicroNode.

--- MicroNode ---
id: ${node.id}
title: ${node.title}
learningObjective: ${node.learningObjective}
theoryContent:
${node.theoryContent}

--- Linked Exercises (${exercises.length} total) ---
${exercises.map(e => `[${e.id}] ${e.text}`).join("\n")}

--- Required Output Schema ---
{
  "explanationSteps": [
    { "step": 1, "heading": "string (Armenian)", "body": "string (Armenian)" }
  ],
  "beginnerExplanation": "string (Armenian)",
  "advancedExplanation": "string (Armenian)",
  "analogy": "string (Armenian) — creative real-world analogy",
  "commonErrors": [
    {
      "error": "string (Armenian)",
      "correction": "string (Armenian)",
      "sourceType": "exercise_based | ai_generated",
      "relatedExerciseId": "EX-68-X or null"
    }
  ],
  "recallQuestions": [
    { "question": "string (Armenian)", "expectedAnswer": "string (Armenian)" }
  ],
  "understandingQuestions": [
    { "question": "string (Armenian)", "expectedAnswer": "string (Armenian)" }
  ],
  "applicationQuestions": [
    { "question": "string (Armenian)", "relatedExerciseId": "EX-68-X or null", "hint": "string (Armenian) or null" }
  ],
  "contentSourceType": "textbook | ai_generated | mixed",
  "teachingContentConfidence": 0-100
}`;

// ── Call ─────────────────────────────────────────────────────────────────────
console.log(`Calling ${MODEL} for MicroNode ${node.id} (${node.title})…\n`);

const res = await fetch(`${BASE_URL}/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${API_KEY}`,
  },
  body: JSON.stringify({
    model: MODEL,
    max_tokens: 8192,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user",   content: USER   },
    ],
  }),
});

if (!res.ok) {
  const err = await res.text();
  throw new Error(`OpenRouter error ${res.status}: ${err}`);
}

const json  = await res.json();
const raw   = json.choices?.[0]?.message?.content ?? "";
const usage = json.usage ?? {};

// ── Parse & display ──────────────────────────────────────────────────────────
let parsed;
try {
  const clean = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  parsed = JSON.parse(clean);
} catch {
  console.error("⚠ Model returned non-JSON. Raw output:\n", raw);
  process.exit(1);
}

console.log("══════════════════════════════════════════════════════");
console.log("BEFORE — source data fed to the model");
console.log("══════════════════════════════════════════════════════");
console.log("theoryContent:\n");
console.log(node.theoryContent);
console.log("\nLinked exercises:");
exercises.forEach(e => console.log(`  [${e.id}] ${e.text}`));

console.log("\n══════════════════════════════════════════════════════");
console.log("AFTER — generated Phase 2 fields");
console.log("══════════════════════════════════════════════════════\n");
console.log(JSON.stringify(parsed, null, 2));

console.log(`\ntokens — prompt: ${usage.prompt_tokens ?? "?"}, completion: ${usage.completion_tokens ?? "?"}`);
