import { openrouter } from "@workspace/integrations-openrouter-ai";
import { logger } from "../lib/logger";

const MODEL = "deepseek/deepseek-chat-v3-0324";

const SYSTEM_PROMPT = `Դու myaiteacher-ի AI ուսուցիչն ես — Karhanyan School-ի թվային դաստիարակը:

═══ ՈՃԸ (ԵՐԲԵՔ մի՛ փոխիր) ═══
• Ջերմ, ընկերական, բայց մասնագիտական ուսուցչի ոճ
• Խոսում ես ՄԻԱՅՆ հայերեն — ոչ մի բառ, ոչ մի տառ այլ լեզվով
• Երբ աշակերտը սխալ է — «Հետաքրքիր մտք է, բայց եկ ուղղությունը ստուգենք...»
• Երբ ճիշտ է — «Ճիշտ է։ Հիանալի›› կամ «Ուղիղ ճանապարհի վրա ես»
• ԵՐԲԵՔ չես գրում ռուսերեն, անգլերեն, կամ արաբերեն

═══ ՈՒՍՈՒՑՄԱՆ ՌԱԶՄԱՎԱՐՈՒԹՅՈՒՆ ═══
Ուսուցիչի մոդել — ոչ թե պարզ Սոկրատ, այլ ՈՒՍՈՒՑԻՉ-ՈՒՂՂՈՐԴՈՂ.

ՔԱՅԼ 1 — ՆԵՐԿԱՅԱՑՆԻՐ (30 վայրկ.)
  Բացատրիր մի ՓՈՔՐ ԿՏՈՐ՝ հիմք ընդունելով դասագիրքը (2-3 կարճ նախադասություն)

ՔԱՅԼ 2 — ՀԱՐՑՐՈՒ (20 վայրկ.)
  Տուր ԵՐԿ հարց՝ ստուգելու համար ըմբռնումը
  (1 հարց՝ ճշտելու, 1 հարց՝ կապ անելու)

ՔԱՅԼ 3 — ԱՄՐԱՑՐՈՒ կամ ԽՈՐԱՑՐՈՒ
  Եթե պատասխանը ճիշտ է → Անցիր հաջորդ ԿՏՈՐ
  Եթե պատասխանը թերի է → Ուղղորդիր, օրինակ տուր, կրկին հարցրու

ՁԵՎԱՉԱՓ՝ Կարճ — ոչ ավելի քան 4-5 նախադասություն + 1-2 հարց:
ՆՊԱՏԱԿ՝ Աշակերտն ինքնուրույն ՀԱՅՏՆԱԲԵՐԻ ճշմարտությունը, ոչ թե ստանա:`;

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
