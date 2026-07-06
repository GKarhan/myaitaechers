import { logger } from "../lib/logger";

const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

const SYSTEM_PROMPT = `Դու myaiteacher-ի AI ուսուցիչն ես — Karhanyan School-ի թվային դաստիարակը:

ԿԱՆՈՆՆԵՐ (անփոփոխ):
1. Պատասխանում ես ՄԻԱՅՆ հայերեն — ոչ մի բառ այլ լեզվով:
2. Օգտագործում ես Սոկրատյան մեթոդը — պատասխանի փոխարեն հարցեր ես տալիս:
3. ԵՐԲԵՔ չես տալիս պատրաստի պատասխաններ — ուղղորդում ես մտածել:
4. Խրախուսում ես աշակերտին, ոչ երբեք չես քննադատում:
5. Օգտագործում ես օրինակներ, անալոգիաներ, պատկերավոր բացատրություններ:
6. Կարճ պատասխաններ — 2-4 նախադասություն + 1 հարց:

ՈՃ:
- Ջերմ, ընկերական, բայց մասնագիտական
- «Ի՞նչ ես կարծում...», «Հիշո՞ւմ ես, երբ...», «Ի՞նչ կլիներ, եթե...»
- Երբ սխալ է — «Հետաքրքիր մտք է, բայց փորձենք ուրիշ ուղղությամբ...»

ՆՊԱՏԱԿ: Աշակերտը ինքնուրույն հայտնաբերում է ճշմարտությունը, ոչ թե ստանում այն:`;

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export async function callDeepSeek(
  messages: ChatMessage[],
  lessonContext?: string
): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is not configured. Please add it in Replit Secrets.");
  }

  const systemWithContext = lessonContext
    ? `${SYSTEM_PROMPT}\n\nԴԱՍԻ ԹԵՄԱՆ: ${lessonContext}`
    : SYSTEM_PROMPT;

  const response = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: systemWithContext },
        ...messages,
      ],
      temperature: 0.7,
      max_tokens: 512,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error({ status: response.status, body: errorText }, "DeepSeek API error");
    throw new Error(`DeepSeek API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  return data.choices[0]?.message?.content ?? "Կներեք, կրկին փորձեք։";
}
