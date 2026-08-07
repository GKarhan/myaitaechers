/**
 * Phase 2 batch — generate teaching content for all 8 MicroNodes in lesson 68.
 * Applies two post-processing adjustments:
 *   A1: if analogy is present → contentSourceType = "mixed"
 *   A2: if contentSourceType === "mixed" → cap teachingContentConfidence at 90
 * Run: node scripts/phase2-batch.mjs
 */

import { writeFileSync } from "fs";

const BASE_URL = process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL;
const API_KEY  = process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY;
if (!BASE_URL || !API_KEY) throw new Error("OpenRouter env vars missing");

const MODEL = "deepseek/deepseek-v4-flash";

// ── All 8 nodes + linked exercises (verbatim from DB) ─────────────────────────
const nodes = [
  {
    id: 994,
    title: "Գոյական անուն",
    learningObjective: "Ուսանողը կարող է սահմանել գոյականը և բացահայտել գոյականները տեքստում։",
    theoryContent: `Գոյականը որպես խոսքի մաս

Առարկա ցույց տվող բառերը կոչվում են գոյական անուն կամ գոյական:

Քերականության մեջ առարկա ասելով հասկանում ենք ոչ միայն նյութական իրերը, այլև անձեր, կենդանիներ, բնության երևույթներ, զգացմունքներ, եղելություններ, գաղափարներ, օրինակ՝ պահարան, մարդ, խնդություն, կատու, հեղեղություն, փորձանք, որոտ:

Առարկա ցույց տվող բառերը պայմանականորեն բաժանվում են երկու խմբի՝ հատուկ և հասարակ:

Հատուկ անունները ցույց են տալիս առանձին անձերի, կենդանիների, տեղանունների, երկրների, քաղաքների, գետերի, լճերի, ծովերի, օվկիանոսների, լեռների, հրապարակների, փողոցների, գրքերի, թերթերի, ամսագրերի, կազմակերպությունների, հիմնարկների, տոների, աստղերի, համաստեղությունների, մոլորակների անուններ և այլն:`,
    exercises: [
      { id: "EX-68-1",  text: "1. Ընդհանուր իմաստը՝ առարկա" },
      { id: "EX-68-2",  text: "2. Ձևաբանական առանձնահատկությունը՝ բերվող (թիվ, հոլով, առում)" },
      { id: "EX-68-3",  text: "3. Տեսակները՝ հատուկ, հասարակ, անձնանիշ, իրանիշ" },
      { id: "EX-68-4",  text: "4. Շարահյուսական դերը՝ ենթակա, կոչական, ստորոգյալի մաս, գոյականական և բայական ածականի լրացում" },
      { id: "EX-68-5",  text: "7. Ի՞նչ են ցույց տալիս հետևյալ բառաշարքում ընդգծված բառերը: Մեր պապանությունն է այս գրքի մեջ, Դրանք մեր ոգու գանձերն են անշեջ. Հնձվորի ձեռն է մնում ես հոգնած, Մարտունին է հսկում անդորր երանգ: (Մ. Մ.)" },
      { id: "EX-68-6",  text: "8. Ստանձնագրու՝ առարկա՝ իր, անձ, կենդանի, բնության երևույթ, զգացմունք, եղելություն, գաղափար ցույց տվող գոյականները" },
    ],
    _flag: null,
  },
  {
    id: 995,
    title: "Գոյականի վարժություններ",
    learningObjective: "Ուսանողը կարող է կիրառել գոյականների վերաբերյալ իր գիտելիքները տարբեր վարժություններում և գործունեություններում։",
    theoryContent: `Շատ լրիվ տեղեկություններ կարող եք գտնել այս հասցեում (https://www.noticaballos.com), որտեղից՝ պարտադիր նյութեր ձիերի ցեղատեսակների մասին:`,
    exercises: [
      { id: "EX-68-7",  text: "բնություն, կրիա, ընկերուհի, կարծիք, բագրիր, ընթրիք, երազանք, ձմեռ, հերա, բարեկամություն, զվարճալիք, բանտ, ամբարձիչ, դերձակ, բարություն, արհեստավոր, հրավեր:" },
      { id: "EX-68-8",  text: "9. Անվանիր մեկ բառով՝ արտահայտված բնության ձի, ազնվագույն ձի. ձիու հանճարի վազք, ձիու պարանոց, բազմազգիքի գիշատիչ բոշուն, վայրի ոչխար, կրկնորդիքի ձի ցեղ, արու բոշուն, էգ բոշուն:" },
      { id: "EX-68-9",  text: "10. Օգտվելով համացանցից (https://www.noticaballos.com)՝ պարտադիր նյութեր ձիերի ցեղատեսակների մասին:" },
      { id: "EX-68-10", text: "Այցելե՛ք ձիարշավարան կամ շների հավաքատեղի՝ կատարելով դրումներ դրանց տեսակների, աճումների, գույների, պահման պայմանների, սննդի մասին:" },
      { id: "EX-68-11", text: "Գրե՛ք շարադրություն «Տպավորություններ ձիարշավարանից», «Ձիեր», «Թափառող շներ» թեմաներից մեկով:" },
      { id: "EX-68-12", text: "11. Ձի, շուն, արծիվ բառերով դարձվածքներ գրի՛ր:" },
      { id: "EX-68-13", text: "12. Տեսանյութը դիտելիս կատարե՛ք արագ գրառումներ:" },
    ],
    _flag: "⚠ WEAK SOURCE — theoryContent is only a horse-website URL (OCR noise). No actual grammar theory present. Generation will be near-entirely AI-invented; treat output as low-confidence placeholder.",
  },
  {
    id: 996,
    title: "Հատուկ անուններ",
    learningObjective: "Ուսանողը կարող է տարբերակել հատուկ և ընդհանուր անունները և բացատրել հատուկ անունների տեսակները։",
    theoryContent: `Հատուկ անուններ

Հատուկ անուններ են աշխարհագրական (գետեր, ծովեր, երկրներ, լեռներ) անունները, մարդկանց անուններն ու ազգանունները, հիվանդությունների, կազմակերպությունների անվանումները, գրական, գիտական և այլ ստեղծագործությունների անունները, կենդանիներին տրվող անունները և այլն։

Հատուկ անունները լինում են երկու տեսակ՝ պարզ և բաղադրյալ։
Պարզ հատուկ անուններ՝ Գառնի, Մարագա, Երևան, Տիգրան, Արագած, Ավետիք, Հրազդան։
Բաղադրյալ հատուկ անուններ կազմված են ավելի բառերից, ինչպես՝ Դավիթ Անհաղթ, Լեռնային Ղարաբաղ։

Բառի հնչյունական կազմը կարող է փոփոխվել, բայց իմաստը մնում է նույնը։

Օրինակ անձնանունների տարբերակներ՝ Մնացական, Մնացակ, Մնա, Մնաց, Ցական։
Օրինակ տեղանունների՝ Գեղարդ, Մարագա, Գրիգոր անուններն ունեն տարբեր ձևեր։`,
    exercises: [
      { id: "EX-68-14", text: "13. Տրված բանաստեղծության մեջ ի՞նչ հատուկ անուններ կան. դո՛ւրս գրիր առանձին սյունակներով՝ անձնանուն, ազգանուն, տեղանուն, մականուն։" },
      { id: "EX-68-15", text: "14. * Թվարկի՛ր հինգ արական և հինգ իգական անձնանուն, որոնք, ըստ քեզ, հայկական են։" },
      { id: "EX-68-16", text: "15. Ընդհանուր անուններից դո՛ւրս գրիր հինգական" },
      { id: "EX-68-17", text: "16. Նշե՛ք Գրիգոր, Հովհաննես, Դավիթ, Տրդատ, Խոսրով, Մարիամ անուններով պատմական նշանավոր անձանց ամբողջական անվանումները։" },
    ],
    _flag: null,
  },
  {
    id: 997,
    title: "Բաղադրյալ հատուկ անուններ",
    learningObjective: "Ուսանողը կարող է սահմանել բաղադրյալ հատուկ անունները և դրանք տարբերել տեքստում։",
    theoryContent: `Բաղադրյալ հատուկ անուններ

Բաղադրյալ հատուկ անունների բոլոր բաղադրիչները սկսվում են մեծատառով։

Բաղադրյալ հատուկ անունների տեսակները.
• Բաղադրիչներից յուրաքանչյուրն առանձին-առանձին հատուկ անուն է, օրինակ՝ Արփա-Սևան, Դեդի Ռուստամ, Դավիթ Անհաղթ։
• Հասարակ անուն լրացումը նախադաս է, օրինակ՝ Արևելյան Եփրատ, Բարձր Հայք, Նոր Արեշ, Հին Հունաստան, Հին Հռոմ:
• Երկու բաղադրիչներն էլ հասարակ անուններ են, բայց փոխաբերական գործածությամբ դառնում են հատուկ անվան բաղադրիչ և գրվում մեծատառ, օրինակ՝ Հեռավոր Արևելք (երկրամաս), Հայկական Պար (լեռնաշղթա), Ծիր Կաթին (աստղակույտ)։

Բաղադրյալ հատուկ անուններ կազմող բաղադրիչները գրվում են.
• Անհատնշիչ հատուկ անուններ (Պետությունների պաշտոնական անուններ)
• Կամ գծիկով (Արփա-Սևան)`,
    exercises: [
      { id: "EX-68-18", text: "Ա. Պետությունների պաշտոնական անուններ. Նիդերլանդների Թագավորություն, Լյուքսեմբուրգի Մեծ Դքսություն, Արաբական Միացյալ Էմիրություններ:" },
      { id: "EX-68-19", text: "Բ. Բաղադրյալ անձնանուններ ու ազգանուններ. Երկրորդ աշխարհամարտ, Լեռնային Ղարաբաղի Հանրապետություն, Միացյալ Նահանգներ, Լոս Անջելես:" },
      { id: "EX-68-20", text: "Գ. Բոլոր քաղաքային աշխարհագրական անուններ, որոնք մեծ են:" },
      { id: "EX-68-21", text: "17. Լրացրո՛ւ ցանկը դպրոցական դասագրքերից, համացանցից:" },
      { id: "EX-68-22", text: "18. Դասարանում պատմի՛ր Մայր Թերեզայի կենսագրությունը:" },
      { id: "EX-68-23", text: "19. Համեմատի՛ր հայկական անուններով երկնային մոլորակների և Մենդելեեւի քիմիական տարրերի պարբերական աղյուսակը:" },
    ],
    _flag: null,
  },
  {
    id: 998,
    title: "Բաղադրյալ հատուկ անունների ուղղագրություն",
    learningObjective: "Ուսանողը կարող է ճիշտ կիրառել մեծատառի կանոնները բաղադրյալ հատուկ անուններում։",
    theoryContent: `Բաղադրյալ հատուկ անունների ուղղագրություն

Բաղադրյալ հատուկ անունների միայն առաջին բառն է սկսվում մեծատառով հետևյալ դեպքերում.

1. Աշխարհագրական հատուկ անուններում, որոնց մեջ լրացյալն առանձին վերցրած հատուկ անուն չէ.
   օրինակ՝ Սև ծով, Բալկանյան թերակղզի, Սևանա լիճ, Հայկական բարձրավանդակ:

2. Պետությունների պատմական և վարչատարածքային անվանումներում, որոնց մեջ լրացյալը, առանձին վերցրած, հատուկ անուն չէ.
   օրինակ՝ Վանի նահանգ, Կիլիկիայի հայկական պետություն, Բյուզանդական կայսրություն, Հայաստանի առաջին հանրապետություն, Արարատի մարզ:

3. Չակերտների մեջ առնվող ստեղծագործությունների, լրագրերի բաղադրյալ հատուկ անուններում.
   օրինակ՝ «Հին օրհնություն», «Ամբոխները խելագարված», «Գրական թերթ», «Հայոց լեզու», «Ջուր ծախող տղան»:`,
    exercises: [
      { id: "EX-68-24", text: "Տարբերակի՛ր հատուկ անունները ըստ խմբերի՝ 1. անուն-ազգանուն, 2. անուն-մականուն, 3. կեղծանուն, 4. տոհմանուն. Դավիթ Անհաղթ, Բագրատունիներ, Իսահակ Նյուտոն, Կարլ Լիննեյ, Մխիթար Սեբաստացի, Սայաթ-Նովա, Կամսարականներ, Ալֆրեդ Նոբել, Հովհան Ոսկեբերան, Վահագն Վիշապաքաղ, Շիրվանզադե, Տորք Անգեղ, Վարդան Մամիկոնյան:" },
      { id: "EX-68-25", text: "Տրված բառերից ստացի՛ր հատուկ անուններ. ֆրանսիացի, լոսանջելեսյան, միջինասիական, շվեյցարացի, խաղաղօվկիանոսյան, տերյանական, կոմիտասյան, սանկտպետերբուրգցի, գյումրեցի:" },
      { id: "EX-68-26", text: "Կազմի՛ր նախադասություններ ՝ տրված բառերը գործածելով թե՛ որպես հասարակ, թե՛ որպես հատուկ անուններ. նվեր, ավետիս, մարտիրոս, անդրանիկ, բուրաստան, աշտարակ, ռազմիկ, պարգև, գոռ:" },
      { id: "EX-68-27", text: "Դասարանը բաժանելով երեք խմբի՝ թվարկե՛ք մայրցամաքների, օվկիանոսների, ծովերի անունները:" },
    ],
    _flag: null,
  },
  {
    id: 999,
    title: "Բաղադրյալ հատուկ անուններ (կազմակերպություններ)",
    learningObjective: "Ուսանողը կարող է ճանաչել և կիրառել բաղադրյալ հատուկ անունների ուղղագրական կանոնները տարբեր համատեքստերում։",
    theoryContent: `Բաղադրյալ հատուկ անունների ուղղագրություն (շարունակություն)

Բաղադրյալ հատուկ անունների առաջին բառն է մեծատառ գրվում հետևյալ դեպքերում.

1. Հիմնարկների, կուսակցությունների, կազմակերպությունների բաղադրյալ անուններում.
   օրինակ՝ «Հայկական ավիաուղիներ» ընկերություն, «Հանրապետություն» կուսակցություն:

2. Միջազգային կամ բարձրագույն պարգևավոր կոչման, շքանշանների և մեդալների բաղադրյալ անուններում.
   օրինակ՝ ՀՀ Պետական մրցանակ, Նոբելյան մրցանակ, «Մեսրոպ Մաշտոց» շքանշան, Ազգային հերոսի կոչում:

3. Համաշխարհային եզակի կազմակերպությունների բաղադրյալ անուններում.
   օրինակ՝ Միավորված ազգերի կազմակերպություն, Շախմատի համաշխարհային ֆեդերացիա, Համաշխարհային բանկ:

4. Պետական կառավարման բարձրագույն մարմինների բաղադրյալ անուններում.
   օրինակ՝ ՀՀ Ազգային ժողով, ԱՄՆ Ներկայացուցիչների պալատ, ՌԴ Պետական դումա, ՀՀ Սահմանադրական դատարան:`,
    exercises: [],
    _flag: null,
  },
  {
    id: 1000,
    title: "Ազգային հերոսների անուններ",
    learningObjective: "Ուսանողը կարող է թվարկել Ազգային հերոսների անուններ և ներկայացնել նրանց կենսագրությունից հատվածներ։",
    theoryContent: `Թվարկիր հինգ Ազգային հերոսի անուն՝ ներկայացնելով բանավոր խոսքից որևէ մեկի կենսագրությունից, մյուսի հերոսական մահը։`,
    exercises: [],
    _flag: "⚠ WEAK SOURCE — theoryContent is a student task prompt, not grammar theory. No definitions, rules, or examples present. Generation will be near-entirely AI-invented and NOT grounded in textbook content. This MicroNode may need a manual theory block before Phase 2 content is meaningful.",
  },
  {
    id: 1001,
    title: "Հայերը Թուրքիայում",
    learningObjective: "Ուսանողը կարող է նկարագրել հայերի պատմական ներկայությունը և մշակութային գործունեությունը Թուրքիայում։",
    theoryContent: `Հայերը Թուրքիայում

Հայերը ժամանակակից Թուրքիայում ապրել են շատ ավելի վաղ ժամանակներից, քան այնտեղ հաստատվել է թուրքական տարրը։ Փոքր Ասիայում թուրքերի հաստատվելուց հետո հայերն Արևմտյան Հայաստանի տարածքում կազմակերպել են ազգային կյանքը, ստեղծել իրենց սեփական և հասարակական կենցաղը։

Թուրք-հայկական մշակութային և հասարակական հարաբերությունների ընթացքում տեղի են ունեցել մշակույթների զգալի ներթափանցումներ։ Սակայն Օսմանյան կայսրության ստեղծումից հետո արևմտահայության վիճակը խիստ ծանրացավ։

Արևմտահայության գործում են 17 հայկական վարժարաններ, որտեղ ուսուցանվում են հայոց լեզու, կրոնի պատմություն, հայ ժողովրդի պատմություն:

Թուրքիայում առաջին հայերեն պարբերականը «Լոռի գիրքն» է:`,
    exercises: [],
    _flag: "⚠ NOTE — This node covers Armenian cultural/historical content (not grammar). theoryContent is partially OCR-garbled. Generation will be grounded in what's readable, but cultural-history content departs from the lesson's main grammar focus. Flag for teacher review.",
  },
];

// ── Prompt builders ───────────────────────────────────────────────────────────
const SYSTEM = `You are an expert Armenian language curriculum designer generating structured teaching content for a grade-7 Armenian textbook app.

STRICT GROUNDING RULES:
1. explanationSteps, beginnerExplanation, advancedExplanation, recallQuestions, understandingQuestions: derived ONLY from the provided theoryContent — rephrase/sequence/simplify; do NOT add facts not in the source.
2. commonErrors: build from linked exercises where possible; stay grounded in the theory.
3. applicationQuestions: reference actual linked exercises where possible.
4. analogy: the ONE field allowed to be freely creative.
5. If theoryContent is missing or clearly not real theory (just a URL, a task prompt, etc.), still generate the best you can but set teachingContentConfidence ≤ 40.

Return ONLY valid JSON. No markdown fences.`;

function buildUserPrompt(node) {
  const exList = node.exercises.length
    ? node.exercises.map(e => `[${e.id}] ${e.text}`).join("\n")
    : "(none)";
  return `Generate Phase 2 teaching content for this MicroNode.

--- MicroNode ---
id: ${node.id}
title: ${node.title}
learningObjective: ${node.learningObjective}
theoryContent:
${node.theoryContent}

--- Linked Exercises (${node.exercises.length}) ---
${exList}

--- Required Output Schema ---
{
  "explanationSteps": [{ "step": 1, "heading": "Armenian", "body": "Armenian" }],
  "beginnerExplanation": "Armenian",
  "advancedExplanation": "Armenian",
  "analogy": "Armenian — creative real-world analogy",
  "commonErrors": [{ "error": "Armenian", "correction": "Armenian", "sourceType": "exercise_based|ai_generated", "relatedExerciseId": "EX-68-X or null" }],
  "recallQuestions": [{ "question": "Armenian", "expectedAnswer": "Armenian" }],
  "understandingQuestions": [{ "question": "Armenian", "expectedAnswer": "Armenian" }],
  "applicationQuestions": [{ "question": "Armenian", "relatedExerciseId": "EX-68-X or null", "hint": "Armenian or null" }],
  "contentSourceType": "textbook",
  "teachingContentConfidence": 0-100
}`;
}

// ── Adjustments A1 + A2 ───────────────────────────────────────────────────────
function applyAdjustments(parsed) {
  // A1: if analogy is present and non-empty → "mixed"
  if (parsed.analogy && parsed.analogy.trim().length > 0) {
    parsed.contentSourceType = "mixed";
  }
  // A2: if mixed → cap confidence at 90
  if (parsed.contentSourceType === "mixed") {
    parsed.teachingContentConfidence = Math.min(parsed.teachingContentConfidence ?? 100, 90);
  }
  return parsed;
}

// ── Call OpenRouter ───────────────────────────────────────────────────────────
async function generate(node) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user",   content: buildUserPrompt(node) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const raw  = json.choices?.[0]?.message?.content ?? "";
  // strip fences, trailing commas before } or ], control chars
  let clean = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  // remove trailing commas before closing braces/brackets (common model error)
  clean = clean.replace(/,(\s*[}\]])/g, "$1");
  try {
    return { parsed: JSON.parse(clean), usage: json.usage ?? {}, rawOnError: null };
  } catch (e) {
    return { parsed: null, usage: json.usage ?? {}, rawOnError: clean, parseError: e.message };
  }
}

// ── Sample field selector ─────────────────────────────────────────────────────
function sampleField(parsed) {
  // Return beginnerExplanation, truncated to 180 chars for the compact report
  const text = parsed.beginnerExplanation ?? "(missing)";
  return text.length > 180 ? text.slice(0, 177) + "…" : text;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`Phase 2 batch — ${nodes.length} MicroNodes — lesson 68 (parallel, streaming results)\n`);

// Print summary + save file for each node as it completes
function printNodeSummary(node, parsed, error) {
  console.log(`\n── Node ${node.id}: ${node.title}`);
  if (node._flag) console.log(`   ${node._flag}`);
  if (error || !parsed) {
    console.log(`   ❌ Generation failed: ${error}`);
    return;
  }
  console.log(`   contentSourceType:         ${parsed.contentSourceType}`);
  console.log(`   teachingContentConfidence:  ${parsed.teachingContentConfidence}`);
  console.log(`   explanationSteps:           ${parsed.explanationSteps?.length ?? 0} steps`);
  console.log(`   recallQuestions:            ${parsed.recallQuestions?.length ?? 0}`);
  console.log(`   commonErrors:               ${parsed.commonErrors?.length ?? 0}`);
  console.log(`   applicationQuestions:       ${parsed.applicationQuestions?.length ?? 0}`);
  const sample = parsed.beginnerExplanation ?? "(missing)";
  console.log(`   sample (beginnerExplanation):`);
  console.log(`   "${sample.length > 200 ? sample.slice(0, 197) + "…" : sample}"`);
}

const results = await Promise.all(nodes.map(async (node) => {
  try {
    const { parsed, usage, rawOnError, parseError } = await generate(node);
    if (!parsed) {
      console.error(`[${node.id}] JSON parse error: ${parseError}\nRAW:\n${rawOnError?.slice(0, 300)}`);
      const r = { node, parsed: null, usage, error: `JSON parse error: ${parseError}` };
      printNodeSummary(node, null, r.error);
      writeFileSync(`/tmp/p2-node-${node.id}.json`, JSON.stringify({ error: r.error }));
      return r;
    }
    applyAdjustments(parsed);
    const r = { node, parsed, usage, error: null };
    printNodeSummary(node, parsed, null);
    writeFileSync(`/tmp/p2-node-${node.id}.json`, JSON.stringify({ nodeId: node.id, nodeTitle: node.title, generated: parsed }, null, 2));
    console.log(`   [saved /tmp/p2-node-${node.id}.json]`);
    return r;
  } catch (err) {
    const r = { node, parsed: null, usage: {}, error: err.message };
    printNodeSummary(node, null, err.message);
    return r;
  }
}));

// ── Final tally ───────────────────────────────────────────────────────────────
const ok  = results.filter(r => r.parsed).length;
const bad = results.filter(r => !r.parsed).length;
console.log(`\n════ Done: ${ok} succeeded, ${bad} failed ════`);
if (bad > 0) {
  results.filter(r => !r.parsed).forEach(r => console.log(`  ✗ ${r.node.id} ${r.node.title}: ${r.error}`));
}
