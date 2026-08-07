/**
 * Final retry for nodes 997 and 1001 — ultra-compact schema to avoid truncation.
 */
import { writeFileSync } from "fs";

const BASE_URL = process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL;
const API_KEY  = process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY;
if (!BASE_URL || !API_KEY) throw new Error("OpenRouter env vars missing");
const MODEL = "deepseek/deepseek-v4-flash";

const nodes = [
  {
    id: 997,
    title: "Բաղադրյալ հատուկ անուններ",
    theoryContent: `Բաղադրյալ հատուկ անունների բոլոր բաղադրիչները սկսվում են մեծատառով։ Կան 3 տեսակ. (1) Բաղադրիչներից յուրաքանչյուրն առանձին հատուկ անուն է, օրինակ Արփա-Սևան, Դավիթ Անհաղթ: (2) Հասարակ անուն լրացումը նախադաս է, օրինակ Արևելյան Եփրատ, Բարձր Հայք: (3) Հասարակ անուններ, բայց փոխաբերականորեն մեծատառ, օրինակ Հեռավոր Արևելք, Ծիր Կաթին:`,
    exercises: [
      { id: "EX-68-18", text: "Ա. Պետությունների պաշտոնական անուններ. Նիդերլանդների Թագավորություն:" },
      { id: "EX-68-22", text: "18. Պատմի՛ր Մայր Թերեզայի կենսագրությունը:" },
    ],
    _flag: null,
  },
  {
    id: 1001,
    title: "Հայերը Թուրքիայում",
    theoryContent: `Հայերը Թուրքիայի տարածքում ապրել են թուրքերի հաստատվելուց վաղ։ Արևմտյան Հայաստանում հայերն ունեին ազգային կյանք։ Օսմանյան կայսրության ստեղծումից հետո արևմտահայության վիճակը ծանրացավ։ Գործում են 17 հայկական վարժարաններ, ուր ուսուցանվում են հայոց լեզու, կրոն, հայ պատմություն:`,
    exercises: [],
    _flag: "⚠ NOTE — Cultural/historical content, not core grammar. Flag for teacher review.",
  },
];

const SYSTEM = `Armenian curriculum designer. STRICT RULE: base explanationSteps/beginnerExplanation/advancedExplanation/recallQuestions/understandingQuestions ONLY on the provided theoryContent text. analogy = freely creative. Return ONLY valid compact JSON, no fences, no trailing commas. Keep entire response under 1500 characters.`;

function prompt(node) {
  const exStr = node.exercises.map(e => `[${e.id}] ${e.text}`).join("; ") || "none";
  return `id=${node.id} title="${node.title}"
theory: ${node.theoryContent}
exercises: ${exStr}

JSON schema (ALL strings in Armenian, max 1 sentence each):
{"explanationSteps":[{"step":1,"heading":"str","body":"str"},{"step":2,"heading":"str","body":"str"}],"beginnerExplanation":"str","advancedExplanation":"str","analogy":"str","commonErrors":[{"error":"str","correction":"str","sourceType":"exercise_based","relatedExerciseId":"EX-68-X or null"}],"recallQuestions":[{"question":"str","expectedAnswer":"str"},{"question":"str","expectedAnswer":"str"}],"understandingQuestions":[{"question":"str","expectedAnswer":"str"}],"applicationQuestions":[{"question":"str","relatedExerciseId":"EX-68-X or null","hint":null}],"contentSourceType":"textbook","teachingContentConfidence":85}`;
}

function applyAdjustments(p) {
  if (p.analogy?.trim()) p.contentSourceType = "mixed";
  if (p.contentSourceType === "mixed")
    p.teachingContentConfidence = Math.min(p.teachingContentConfidence ?? 100, 90);
  return p;
}

for (const node of nodes) {
  console.log(`\nGenerating node ${node.id}: ${node.title}…`);
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user",   content: prompt(node) },
      ],
    }),
  });
  if (!res.ok) { console.error(`HTTP ${res.status}`); continue; }
  const json = await res.json();
  const raw  = json.choices?.[0]?.message?.content ?? "";
  let clean = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  clean = clean.replace(/,(\s*[}\]])/g, "$1");

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    console.error(`JSON parse error: ${e.message}`);
    console.error("Raw (first 600):", clean.slice(0, 600));
    continue;
  }

  applyAdjustments(parsed);
  const out = { nodeId: node.id, nodeTitle: node.title, flag: node._flag ?? null, generated: parsed };
  writeFileSync(`/tmp/p2-node-${node.id}.json`, JSON.stringify(out, null, 2));
  console.log(`✓ saved /tmp/p2-node-${node.id}.json  (${json.usage?.completion_tokens} tok)`);
  if (node._flag) console.log(`   ${node._flag}`);
  console.log(`   contentSourceType: ${parsed.contentSourceType}, confidence: ${parsed.teachingContentConfidence}`);
  const s = parsed.beginnerExplanation ?? "";
  console.log(`   sample: "${s.slice(0, 200)}"`);
}
