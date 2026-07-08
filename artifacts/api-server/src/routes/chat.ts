import { Router } from "express";
import { db, chatMessagesTable, lessonsTable, lessonSessionsTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";
import { callAI, type ChatMessage } from "../services/ai";
import { logger } from "../lib/logger";

const router = Router();

function buildPhaseInstruction(phase: number, lessonTitle: string, subjectName: string): string {
  switch (phase) {
    case 1:
      return `=== ՓՈՒLL 1: ԿРКNУTYUN (REVIEW) — 5 minute ===

CRITICAL RULES — follow exactly:
1. ONE question at a time. Ask question → wait for answer → give feedback → ask next question.
2. NEVER show multiple questions together.
3. Total questions: 5 to 8 (you decide based on student performance).
4. Always use this format for questions:

ՀАРС [N]։ [Question in Armenian ending with ?]
1) [Option in Armenian]
2) [Option in Armenian]
3) [Option in Armenian]

QUESTION TOPICS:
- ~60%: topics from ${subjectName} that the student studied before (NOT «${lessonTitle}»)
- ~30%: older foundational ${subjectName} topics
- ~10%: a gentle hint toward «${lessonTitle}» (what they might already intuitively know)

FIRST RESPONSE — must include:
• One warm personal greeting in Armenian (1 sentence)
• Then immediately ask ՀАРС 1 in the format above

AFTER EACH STUDENT ANSWER:
• If CORRECT → respond with a specific encouraging phrase like «✓ Ճիշտ է։ Հiانalĭ!» + 1-sentence explanation + then ask next question
• If WRONG → respond with «✗ Ոcht ĉisht, bats mi anbaymanun:» + kind encouragement + correct answer with brief explanation + then ask next question
• After 3 consecutive wrong answers: suggest a short 2-minute break kindly

AFTER ALL QUESTIONS (5-8 total) — Summary:
«Ĉisht patakhaneciket [X]-its [TOTAL]-in ([PERCENT]%):
[If ≥70%]: Հianalĭ! Antsnenk nor dasĭn: ▶
[If <70%]: Arajarkoum em krknel. Sharakhanarekĕ?»

MATH FORMAT: Use Unicode — 2³, 5², × (not LaTeX \\( \\) or *).
LANGUAGE: Armenian ONLY.`;

    case 2:
      return `=== ՓOUЛL 2: НОR DASSI NERKAAYATSUM — Core Ideas (8-10 min) ===

YOU ARE A TEACHER presenting new material step-by-step.

OPENING (say ONCE at start of Phase 2):
«Ƃarĕv, sireliĭ aŝakert! 👋
Aysor menq sovorelu enq՝ «${lessonTitle}»:
Npatak՝ [what they will learn]:
Inchu e sa karevor՝ [real-life connection]:
Patrasto՞st ĕntĭ ksel: 🚀»

TEACHING METHOD — piece by piece:
1. Present ONE small concept chunk (2-3 sentences from textbook)
2. Ask 1-2 comprehension questions using this format:
   ՀАРС [N]։ [Question in Armenian?]
   1) [Option]
   2) [Option]
   3) [Option]
3. Wait for answer:
   - Correct (≥70%) → praise + move to next chunk
   - Wrong (<70%) → explain same concept differently with new example, then re-ask

Bloom Level: 1-2 only (recall, understand — no application yet).
Total questions: 3-5.
MATH FORMAT: Use Unicode — 2³, 5², × (not LaTeX).
LANGUAGE: Armenian ONLY.`;

    case 3:
      return `=== PHASE 3: SECONDARY IDEAS — Deeper Understanding (7-8 min) ===
Bloom Level 3 (apply).
Build on Phase 2. Teach DEEPER aspects one chunk at a time.
Use same format: explain → ask (1)/2)/3) format) → wait → feedback.
3-5 questions total.
MATH FORMAT: Unicode only (²³⁴×÷√). LANGUAGE: Armenian ONLY.`;

    case 4:
      return `=== PHASE 4: PRACTICAL APPLICATION (8-10 min) ===
Bloom Level 3-4. Give 3-5 problems of increasing difficulty.
Guide with Socratic questions — NEVER give the answer directly.
If completely stuck after 3 tries: solve ONE example together, then give a similar problem.
MATH FORMAT: Unicode only (²³⁴×÷√). LANGUAGE: Armenian ONLY.`;

    case 5:
      return `=== PHASE 5: CREATIVE WORK (8-10 min) ===
Bloom Level 4-6. Open-ended questions, real-life connections.
No single correct answer — encourage creative thinking.
LANGUAGE: Armenian ONLY.`;

    case 6:
      return `=== PHASE 6: MICRO PROJECT (10-12 min) ===
Give ONE small project on «${lessonTitle}».
Guide, don't solve. Student self-assesses at the end.
LANGUAGE: Armenian ONLY.`;

    case 7:
      return `=== PHASE 7: SUMMARY (5 min) ===
Ask 5-7 questions across all Bloom levels using 1)/2)/3) format.
Student self-reflects. Show final mastery score.
LANGUAGE: Armenian ONLY.`;

    case 8:
      return `=== PHASE 8: HOMEWORK ===
Present 3-level homework (student chooses):
⭐ Basic (Bloom 1-2) ⭐⭐ Extended (Bloom 3-4) ⭐⭐⭐ Creative (Bloom 5-6).
End warmly. LANGUAGE: Armenian ONLY.`;

    default:
      return "Guide the student on the lesson topic. Armenian only.";
  }
}

router.post("/chat", requireAuth, async (req: AuthRequest, res) => {
  const { message, lessonId } = req.body as { message: string; lessonId?: number };

  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  let lessonContext: string | undefined;
  if (lessonId) {
    const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
    if (lesson) {
      const [session] = await db
        .select()
        .from(lessonSessionsTable)
        .where(and(eq(lessonSessionsTable.lessonId, lessonId), eq(lessonSessionsTable.userId, req.userId!)))
        .limit(1);

      const phase = session?.currentPhase ?? 1;
      const subjectName = (lesson as { subjectName?: string }).subjectName ?? "Subject";

      lessonContext = [
        `LESSON: «${lesson.title}»`,
        `SUBJECT: ${subjectName}`,
        lesson.description ? `DESCRIPTION: ${lesson.description}` : "",
        lesson.content ? `TEXTBOOK:\n${lesson.content}` : "",
        ``,
        buildPhaseInstruction(phase, lesson.title, subjectName),
      ].filter(Boolean).join("\n");
    }
  }

  const history = await db
    .select()
    .from(chatMessagesTable)
    .where(
      lessonId
        ? and(eq(chatMessagesTable.userId, req.userId!), eq(chatMessagesTable.lessonId, lessonId))
        : eq(chatMessagesTable.userId, req.userId!)
    )
    .orderBy(asc(chatMessagesTable.createdAt))
    .limit(20);

  await db.insert(chatMessagesTable).values({
    userId: req.userId!,
    lessonId: lessonId ?? null,
    role: "user",
    content: message,
  });

  const chatHistory: ChatMessage[] = [
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user", content: message },
  ];

  try {
    const aiResponse = await callAI(chatHistory, lessonContext);
    const [assistantMsg] = await db
      .insert(chatMessagesTable)
      .values({ userId: req.userId!, lessonId: lessonId ?? null, role: "assistant", content: aiResponse })
      .returning();

    res.json({ response: aiResponse, messageId: assistantMsg.id });
  } catch (err) {
    logger.error({ err }, "AI chat error");
    res.status(503).json({ error: err instanceof Error ? err.message : "AI service unavailable" });
  }
});

router.get("/chat/history", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = req.query.lessonId ? parseInt(String(req.query.lessonId), 10) : undefined;

  const messages = await db
    .select()
    .from(chatMessagesTable)
    .where(
      lessonId && !isNaN(lessonId)
        ? and(eq(chatMessagesTable.userId, req.userId!), eq(chatMessagesTable.lessonId, lessonId))
        : eq(chatMessagesTable.userId, req.userId!)
    )
    .orderBy(asc(chatMessagesTable.createdAt))
    .limit(50);

  res.json(messages.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt.toISOString() })));
});

export default router;
