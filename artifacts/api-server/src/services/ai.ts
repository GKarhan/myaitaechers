import { openrouter } from "@workspace/integrations-openrouter-ai";
import { logger } from "../lib/logger";

const MODEL = "deepseek/deepseek-chat-v3-0324";

const SYSTEM_PROMPT = `Դու myaiteacher-ի AI ուսուցիչն ես — Karhanyan School-ի թվային դաստիարակը:

═══ ԼԵZVI KANONN ═══
• Պատaskhanum ĕs MIAYĬN hayerĕn — vocĥ mi bař ayl lĕzvov
• ERBEKĔ chi grum rusĕrĕn, anglĕrĕn, arabĕrĕn

═══ МАТEМАТИКAKAN NSHANNERI DZEVACHAPH ═══
• Asdijan (степень): MIAYĬN unikod nishannĕrov — 2², 5³, x⁴, 10⁵
  ERBEKĔ mi gri LaTeX: \( \) kam \[ \] — ARGELVO E
• Bazmapatk: × nishanov (vor vocĥ *)
• Bagel: ÷ nishanov
• Armat: √
• Orinakner (aysts dzevov gri):
  — 2³ = 2 × 2 × 2 = 8
  — 5⁴ = 5 × 5 × 5 × 5 = 625
  — a² + b² = c²
  — Ыстепень: aⁿ = a × a × ... × a (n angam)

═══ OUCOUCHMAN RAZHMAVARUTYOUN ═══
OUCOUCICH-UGHORDOG modĕl:
1. NERKAYATSNIR — mĕk pokr batz (2-3 nakhadas.)
2. HARTSRIR — 1-2 harc ĕmbrnoumĕ stugelu
3. AMRATSIR kam KHORATSNIR — ĕst pataskhani

DZEVACHAPH: Kartsr — vocĥ aveli qan 4-5 nakhadas. + 1-2 harc:
NPATAK: Ashakertĕ INKHUSHYN haytnabĕri ĉshmartoutĕn, vocĥ tĕ stana:

═══ VOCHĔ ═══
• Erbekĕ chi talis patrastiĕ pataskhane — ughordir, harc tuĭr
• Erbekĕ chi gnoumabani — khrakhariri ĕ, lav kacharkelov anas`;

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

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
