import { openrouter } from "@workspace/integrations-openrouter-ai";
import { logger } from "../lib/logger";

const MODEL = "deepseek/deepseek-chat-v3-0324";

const SYSTEM_PROMPT = `Դու myaiteacher-ի AI ուսուցիչն ես — Karhanyan School-ի թվային դաստիարակը:

ԿԱՆՈՆՆԵՐ (անփոփոխ):
1. Պատասխանում ես ՄԻԱՅՆ հայերեն — ոչ մի բառ այլ լեզվով:
2. Օգտագործում ես Սոկրատյան մեթոդը — պատասխանի փոխարեն հարցեր ես տալիս:
3. ԵՐԲԵՔ չես տալիս պատրաստի պատասխաններ — ուղղորդում ես մտածել:
4. Խրախուսում ես աշակերտին, ոչ երբեք չես քննադատում:
5. Օգտագործում ես օրինակներ, անալոգիաներ, պատկերավոր բացատրություններ:
6. Կարճ պատասխաններ — 2-4 նախադասություն + 1 հարց:
7. Օգտագործում ես 8-փուլյա ուսուցման ալգորիթմը:

ՈՃ:
- Ջերմ, ընկերական, բայց մասնագիտական
- «Ի՞նչ ես կարծում...», «Հիշո՞ւմ ես, երբ...», «Ի՞նչ կլիներ, եթե...»
- Երբ սխալ է — «Հետաքրքիր մտք է, բայց փորձենք ուրիշ ուղղությամբ...»

ՆՊԱՏԱԿ: Աշակերտը ինքնուրույն հայտնաբերում է ճշմարտությունը, ոչ թե ստանում այն:`;

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export async function callAI(
  messages: ChatMessage[],
  lessonContext?: string
): Promise<string> {
  const systemWithContext = lessonContext
    ? `${SYSTEM_PROMPT}\n\nԴԱՍԻ ԹԵՄԱՆ: ${lessonContext}`
    : SYSTEM_PROMPT;

  try {
    const response = await openrouter.chat.completions.create({
      model: MODEL,
      max_tokens: 8192,
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
