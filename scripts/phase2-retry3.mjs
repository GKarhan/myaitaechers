/**
 * Retry Phase 2 for nodes 996, 997, 1001 — kept failing due to truncation.
 * Uses a more concise output schema to avoid mid-string cutoffs.
 */
import { writeFileSync } from "fs";

const BASE_URL = process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL;
const API_KEY  = process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY;
if (!BASE_URL || !API_KEY) throw new Error("OpenRouter env vars missing");

const MODEL = "deepseek/deepseek-v4-flash";

const nodes = [
  {
    id: 996,
    title: "Հատուկ անուններ",
    learningObjective: "Ուսանողը կարող է տարբերակել հատուկ և ընդհանուր անունները և բացատրել հատուկ անունների տեսակները։",
    theoryContent: `Հատուկ անուններ են աշխարհագրական (գետեր, ծովեր, երկրներ, լեռներ) անունները, մարդկանց անուններն ու ազգանունները, հիվանդությունների, կազմակերպությունների անվանումները, գրական, գիտական ստեղծագործությունների անունները, կենդանիներին տրվող անունները և այլն։

Հատուկ անունները լինում են երկու տեսակ՝ պարզ և բաղադրյալ։
Պարզ հատուկ անուններ՝ Գառնի, Երևան, Տիգրան, Արագած, Ավետիք, Հրազդան։
Բաղադրյալ հատուկ անուններ՝ Դավիթ Անհաղթ, Լեռնային Ղարաբաղ։

Բառի հնչյունական կազմը կարող է փոփոխվել, բայց իմաստը մնում է նույնը։
Անձնանունների տարբերակներ՝ Մնացական, Մնացակ, Մնա, Ցական։`,
    exercises: [
      { id: "EX-68-14", text: "13. Տրված բանաստեղծության մեջ ի՞նչ հատուկ անուններ կան. դո՛ւրս գրիր առանձին սյունակներով՝ անձնանուն, ազգանուն, տեղանուն, մականուն։" },
      { id: "EX-68-15", text: "14. Թվարկի՛ր հինգ արական և հինգ իգական անձնանուն, որոնք, ըստ քեզ, հայկական են։" },
      { id: "EX-68-16", text: "15. Ընդհանուր անուններից դո՛ւրս գրիր հինգական" },
      { id: "EX-68-17", text: "16. Նշե՛ք Գրիգոր, Հովհաննես, Դավիթ, Տրդատ, Խոսրով, Մարիամ անուններով պատմական անձանց ամբողջական անվանումները։" },
    ],
    _flag: null,
  },
  {
    id: 997,
    title: "Բաղադրյալ հատուկ անուններ",
    learningObjective: "Ուսանողը կարող է սահմանել բաղադրյալ հատուկ անունները և դրանք տարբերել տեքստում։",
    theoryContent: `Բաղադրյալ հատուկ անուններ

Բաղադրյալ հատուկ անունների բոլոր բաղադրիչները սկսվում են մեծատառով։

Տեսակներ.
1. Բաղադրիչներից յուրաքանչյուրն առանձին հատուկ անուն է. Արփա-Սևան, Դավիթ Անհաղթ։
2. Հասարակ անուն լրացումը նախադաս է. Արևելյան Եփրատ, Բարձր Հայք, Հին Հռոմ:
3. Երկու բաղադրիչներն էլ հասարակ անուններ են, բայց փոխաբերական գործածությամբ մեծատառ. Հեռավոր Արևելք, Հայկական Պար, Ծիր Կաթին:`,
    exercises: [
      { id: "EX-68-18", text: "Ա. Պետությունների պաշտոնական անուններ. Նիդերլանդների Թագավորություն, Լյուքսեմբուրգի Մեծ Դքսություն:" },
      { id: "EX-68-19", text: "Բ. Բաղադրյալ անձնանուններ. Լեռնային Ղարաբաղի Հանրապետություն, Լոս Անջելես:" },
      { id: "EX-68-22", text: "18. Պատմի՛ր Մայր Թերեզայի կենսագրությունը:" },
      { id: "EX-68-23", text: "19. Համեմատի՛ր հայկական անուններով մոլորակների ցանկը:" },
    ],
    _flag: null,
  },
  {
    id: 1001,
    title: "Հայերը Թուրքիայում",
    learningObjective: "Ուսանողը կարող է նկարագրել հայերի պատմական ներկայությունը և մշակութային գործունեությունը Թուրքիայում։",
    theoryContent: `Հայերը Թուրքիայում

Հայերը ժամանակակից Թուրքիայի տարածքում ապրել են թուրքերի հաստատվելուց շատ ավելի վաղ։ Արևմտյան Հայաստանում հայերը կազմակերպել են ազգային կյանքը, ստեղծել հասարակական կենցաղ։

Օսմանյան կայսրության ստեղծումից հետո արևմտահայության վիճակը ծանրացավ։ Արևմտյան Հայաստանը հաճախ դառնում էր ռազմական գործողությունների թատերաբեմ, որի հետևանքով տուժում էր հայ բնակչությունը։

Արևմտահայության գործում են 17 հայկական վարժարաններ, ուր ուսուցանվում են հայոց լեզու, կրոնի պատմություն, հայ ժողովրդի պատմություն:

Թուրքիայում առաջին հայերեն պարբերականը «Լոռի գիրքն» է:`,
    exercises: [],
    _flag: "⚠ NOTE — Cultural/historical content, partially OCR-garbled. Not core grammar.",
  },
];

const SYSTEM = `You are an expert Armenian language curriculum designer for grade-7.

STRICT GROUNDING: explanationSteps, beginnerExplanation, advancedExplanation, recallQuestions, understandingQuestions must derive ONLY from the provided theoryContent.
analogy: freely creative.
commonErrors: grounded in exercises or theory.
applicationQuestions: reference actual exercise IDs.

IMPORTANT: Keep each text field concise (max 2 sentences each). Keep the full JSON under 3000 characters total.
Return ONLY valid JSON. No markdown fences. No trailing commas.`;

function buildPrompt(node) {
  const exList = node.exercises.length
    ? node.exercises.map(e => `[${e.id}] ${e.text}`).join("\n")
    : "(none)";
  return `MicroNode id=${node.id}, title="${node.title}"
learningObjective: ${node.learningObjective}

theoryContent:
${node.theoryContent}

Exercises:
${exList}

Return JSON:
{
  "explanationSteps": [{"step":1,"heading":"Armenian","body":"Armenian (1 sentence)"},{"step":2,"heading":"Armenian","body":"Armenian (1 sentence)"}],
  "beginnerExplanation": "Armenian (2 sentences max)",
  "advancedExplanation": "Armenian (2 sentences max)",
  "analogy": "Armenian (1 sentence)",
  "commonErrors": [{"error":"Armenian","correction":"Armenian","sourceType":"exercise_based|ai_generated","relatedExerciseId":"EX-68-X or null"},{"error":"Armenian","correction":"Armenian","sourceType":"exercise_based|ai_generated","relatedExerciseId":null}],
  "recallQuestions": [{"question":"Armenian","expectedAnswer":"Armenian (1 sentence)"},{"question":"Armenian","expectedAnswer":"Armenian (1 sentence)"}],
  "understandingQuestions": [{"question":"Armenian","expectedAnswer":"Armenian (1 sentence)"}],
  "applicationQuestions": [{"question":"Armenian","relatedExerciseId":"EX-68-X or null","hint":"Armenian or null"}],
  "contentSourceType": "textbook",
  "teachingContentConfidence": 0-100
}`;
}

function applyAdjustments(p) {
  if (p.analogy?.trim()) p.contentSourceType = "mixed";
  if (p.contentSourceType === "mixed")
    p.teachingContentConfidence = Math.min(p.teachingContentConfidence ?? 100, 90);
  return p;
}

async function generate(node) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user",   content: buildPrompt(node) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const raw  = json.choices?.[0]?.message?.content ?? "";
  let clean = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  clean = clean.replace(/,(\s*[}\]])/g, "$1");
  try {
    return { parsed: JSON.parse(clean), usage: json.usage ?? {} };
  } catch (e) {
    return { parsed: null, usage: json.usage ?? {}, rawOnError: clean.slice(0, 500), parseError: e.message };
  }
}

console.log("Retrying nodes 996, 997, 1001…\n");

const results = await Promise.all(nodes.map(async (node) => {
  try {
    const { parsed, usage, rawOnError, parseError } = await generate(node);
    if (!parsed) {
      console.error(`[${node.id}] JSON parse error: ${parseError}\n${rawOnError}`);
      return { node, parsed: null, error: `JSON parse: ${parseError}` };
    }
    applyAdjustments(parsed);
    const out = { nodeId: node.id, nodeTitle: node.title, flag: node._flag ?? null, generated: parsed };
    writeFileSync(`/tmp/p2-node-${node.id}.json`, JSON.stringify(out, null, 2));
    console.log(`[${node.id}] ✓ ${node.title} (${usage.completion_tokens ?? "?"} tok) → saved`);
    return { node, parsed, error: null };
  } catch (err) {
    console.error(`[${node.id}] ✗ ${err.message}`);
    return { node, parsed: null, error: err.message };
  }
}));

console.log("\n=== Compact summary ===");
for (const { node, parsed, error } of results) {
  console.log(`\n── ${node.id}: ${node.title}`);
  if (node._flag) console.log(`   ${node._flag}`);
  if (!parsed) { console.log(`   ❌ ${error}`); continue; }
  console.log(`   contentSourceType: ${parsed.contentSourceType}`);
  console.log(`   teachingContentConfidence: ${parsed.teachingContentConfidence}`);
  console.log(`   steps: ${parsed.explanationSteps?.length}, recall: ${parsed.recallQuestions?.length}, errors: ${parsed.commonErrors?.length}, appQ: ${parsed.applicationQuestions?.length}`);
  const s = parsed.beginnerExplanation ?? "";
  console.log(`   sample: "${s.slice(0, 200)}"`);
}
