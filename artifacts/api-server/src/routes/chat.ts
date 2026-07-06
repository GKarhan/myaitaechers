import { Router } from "express";
import { db, chatMessagesTable, lessonsTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";
import { callDeepSeek, type ChatMessage } from "../services/ai";
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

  let lessonContext: string | undefined;
  if (lessonId) {
    const [lesson] = await db
      .select()
      .from(lessonsTable)
      .where(eq(lessonsTable.id, lessonId))
      .limit(1);
    if (lesson) lessonContext = `${lesson.title} — ${lesson.description}`;
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
    const aiResponse = await callDeepSeek(chatHistory, lessonContext);

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
