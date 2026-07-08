import { Router } from "express";
import { db, chatMessagesTable, lessonsTable, lessonSessionsTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";
import { callAI, type ChatMessage } from "../services/ai";
import { logger } from "../lib/logger";

const router = Router();

router.post("/chat", requireAuth, async (req: AuthRequest, res) => {
  const { message, lessonId } = req.body as {
    message: string;
    lessonId?: number;
  };

  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const PHASE_NAMES = [
    "Կրկնություն", "Հիմնական գաղափարներ", "Երկրորդական գաղափարներ",
    "Գործնական կիրառություն", "Ստեղծագործական աշխատանք",
    "Միկրո նախագիծ", "Ամփոփում", "Տնային աշխատանք",
  ];
  const PHASE_INSTRUCTIONS: Record<number, string> = {
    1: "Ակտիվացրու նախկին գիտելիքները: Տուր հարցեր նախորդ դասի, ավելի հին դասերի ու նոր թեմայի մասին (60/30/10%): Մի՛ բացատրիր, հարցրու:",
    2: "Ներկայացրու դասի ՀԻՄՆԱԿԱՆ գաղափարը Բլում 1-2 մակարդակով: Բացատրիր, տուր 3-5 հարց:",
    3: "Ուսուցանիր ավելի խոր մասը՝ Բլум 3 մակարդակ: Կապ հաստատիր հիմնականի հետ, տուր 3-5 հարց:",
    4: "Տուր 3-5 գործնական վարժություն կամ խնդիր (Բլում 3-4): Ուղղորդիր լուծման ընթացքը՝ Սոկրատյան հարցերով:",
    5: "Բաց հարցեր, կյանքի հետ կապ, ստեղծագործական մտածողություն (Բլում 4-6): Թող աշակերտն ինքն ստեղծի:",
    6: "Տուր մի փոքր նախագիծ (օր. «Նամակ», «Ստեղծիր խնդիր», «Ներկայացրու»): Ուղղորդիր, մի՛ կատարիր:",
    7: "Ամփոփիր ամբողջ դասը: Տուր 5-7 հարց բոլոր մակարդակներից: Հաշվիր յուրացման մոտ տոկոսը:",
    8: "Տուր 3 մակարդակի տնային (Հիմնական / Ընդլայնված / Ստեղծագործական): Թող աշակերտն ընտրի:",
  };

  let lessonContext: string | undefined;
  if (lessonId) {
    const [lesson] = await db
      .select()
      .from(lessonsTable)
      .where(eq(lessonsTable.id, lessonId))
      .limit(1);
    if (lesson) {
      const [session] = await db
        .select()
        .from(lessonSessionsTable)
        .where(and(eq(lessonSessionsTable.lessonId, lessonId), eq(lessonSessionsTable.userId, req.userId!)))
        .limit(1);

      const phase = session?.currentPhase ?? 1;
      const phaseName = PHASE_NAMES[phase - 1] ?? "Անհայտ";
      const phaseInstr = PHASE_INSTRUCTIONS[phase] ?? "";

      lessonContext = [
        `ԴԱՍԻ ԹԵՄԱՆ: ${lesson.title}`,
        lesson.description ? `ԲՈՎԱՆԴԱԿՈՒԹՅՈՒՆ: ${lesson.description}` : "",
        lesson.content ? `ԴԱՍԻ ՆՅՈՒԹ: ${lesson.content}` : "",
        `ԸՆTHԱՑԻԿ ՓՈՒԼ: ${phase} — ${phaseName}`,
        `ՓՈՒԼԻ ՀՐԱՀԱՆԳ: ${phaseInstr}`,
      ].filter(Boolean).join("\n");
    }
  }

  // Load last 10 messages for context
  const history = await db
    .select()
    .from(chatMessagesTable)
    .where(
      lessonId
        ? and(
            eq(chatMessagesTable.userId, req.userId!),
            eq(chatMessagesTable.lessonId, lessonId)
          )
        : eq(chatMessagesTable.userId, req.userId!)
    )
    .orderBy(asc(chatMessagesTable.createdAt))
    .limit(10);

  // Save user message
  const [userMsg] = await db
    .insert(chatMessagesTable)
    .values({
      userId: req.userId!,
      lessonId: lessonId ?? null,
      role: "user",
      content: message,
    })
    .returning();

  const chatHistory: ChatMessage[] = history.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));
  chatHistory.push({ role: "user", content: message });

  try {
    const aiResponse = await callAI(chatHistory, lessonContext);

    const [assistantMsg] = await db
      .insert(chatMessagesTable)
      .values({
        userId: req.userId!,
        lessonId: lessonId ?? null,
        role: "assistant",
        content: aiResponse,
      })
      .returning();

    res.json({ response: aiResponse, messageId: assistantMsg.id });
  } catch (err) {
    logger.error({ err }, "AI chat error");
    const errorMessage =
      err instanceof Error ? err.message : "AI service unavailable";
    res.status(503).json({ error: errorMessage });
  }
});

router.get("/chat/history", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = req.query.lessonId
    ? parseInt(String(req.query.lessonId), 10)
    : undefined;

  const messages = await db
    .select()
    .from(chatMessagesTable)
    .where(
      lessonId && !isNaN(lessonId)
        ? and(
            eq(chatMessagesTable.userId, req.userId!),
            eq(chatMessagesTable.lessonId, lessonId)
          )
        : eq(chatMessagesTable.userId, req.userId!)
    )
    .orderBy(asc(chatMessagesTable.createdAt))
    .limit(50);

  res.json(
    messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    }))
  );
});

export default router;
