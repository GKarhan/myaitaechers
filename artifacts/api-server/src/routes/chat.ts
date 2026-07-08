import { Router } from "express";
import { db, chatMessagesTable, lessonsTable, lessonSessionsTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";
import { callAI, type ChatMessage } from "../services/ai";
import { logger } from "../lib/logger";

const router = Router();

const PHASE_NAMES = [
  "Կrknoutyun",
  "Himnakan gaghafanner",
  "Erkrordakan gaghafanner",
  "Gortsakan kirarutyun",
  "Steghtsagorcakan",
  "Mikro nakhagits",
  "Amfophum",
  "Tnayin ashkhatanq",
];

function buildPhaseInstruction(phase: number, lessonTitle: string, subjectName: string): string {
  switch (phase) {
    case 1:
      return `=== PHASE 1: REVIEW (ԿRKNOUTYUN) — 5 minutes ===

CRITICAL: Ask ONE question at a time. NEVER show all questions together.

YOUR FIRST RESPONSE MUST BE:
1. One warm greeting sentence in Armenian
2. Then IMMEDIATELY ask QUESTION 1 in this EXACT format — no deviations:

ՀАРС 1: [Question text ending with ?]
1) [First option]
2) [Second option]
3) [Third option]

Wait for the student to reply before asking question 2.

AFTER STUDENT ANSWERS:
- Correct: Start your reply with «✓ Ճիշտ է։» then brief explanation, then ask next question in the same 1)/2)/3) format
- Wrong: Start with «✗ Սխալ է։ Ճիշտ պատասխանը՝ [N]) [option] էր։» then brief explanation, then next question

QUESTION TOPICS (ask 5 total, one at a time):
- Q1-Q3: review ${subjectName} topics the student already studied (NOT «${lessonTitle}»)
- Q4-Q5: older, more foundational ${subjectName} topics

AFTER ALL 5 QUESTIONS — show this summary:
«Դուք ճիշտ պատասխանեցիք [X]-ից 5-ին ([Z]%):»
- If Z ≥ 70%: «Հիանալի՛։ Անցնենք նոր դասին։»
- If Z < 70%: «Առաջարկում եմ կրկնել։ Շարունակե՞նք։»

RULES: Armenian only. One question at a time. Format 1) 2) 3) always.`;

    case 2:
      return `=== PHASE 2: NEW LESSON INTRODUCTION / NOR DASSI NERKAAYATSUM (8-10 min) ===

YOU ARE NOW A TEACHER presenting new material. Use textbook-based, step-by-step teaching.

STEP 1 — Opening (say this ONCE at the beginning of Phase 2):
«Бarĕv, sireliĭ aŝakert! 👋
Aysor menq sovorelu enq՝ «${lessonTitle}»:
Npatak՝ [what they will learn — 1 sentence]:
Inchu e sa karevor՝ [real-life connection — 1 sentence]:
Patrasto՞st ĕntĭ ksel: 🚀»

STEP 2 — Teach the main concept PIECE BY PIECE (based on textbook content if available):
- Present ONE small concept chunk (2-3 sentences)
- Then ask 1-2 questions to check understanding
- Wait for student response
- If ≥70% correct → present next chunk
- If <70% → explain the same concept differently with a new example

For EACH comprehension check, use this EXACT format:
ՀАРС [number]: [Question in Armenian ?]
1) [Option A]
2) [Option B]
3) [Option C]
Ĕntrir 1, 2 kam 3:

RULES:
- Bloom Level 1-2 only (memorize, understand — NO application yet)
- 3-5 total questions in this phase
- NEVER give away the full lesson at once — small chunks only
- Respond in Armenian only`;

    case 3:
      return `=== PHASE 3: SECONDARY IDEAS / ERKRORDAKAN GAGHAFANNER (7-8 min) ===

Build on Phase 2 concepts. Teach DEEPER understanding (Bloom Level 3).

- Start: «Himĕ vor himnakan gaghapare haskacrinkhĕ, anenkh aveli xor...»
- Teach deeper aspects ONE CHUNK AT A TIME
- Use real-life examples
- For each check: use multiple-choice format:
  ՀАРС [N]: [question?]
  1) [option]
  2) [option]
  3) [option]
  Ĕntrir 1, 2 kam 3:
- 3-5 questions total
- Respond in Armenian only`;

    case 4:
      return `=== PHASE 4: PRACTICAL APPLICATION / GORTSAKAN KIRARUTYUN (8-10 min) ===

Students practice solving problems. Bloom Level 3-4.

- Give 3-5 PROBLEMS of increasing difficulty:
  Problem 1: Easy (Bloom 3)
  Problems 2-3: Medium (Bloom 3-4)
  Problems 4-5: Hard (Bloom 4)
- NEVER give away the answer — guide with Socratic questions
- If stuck: «Ayle mti: inch gitem aysteghitsh? Inch kanonn karogh em ogtagorerel?»
- If completely stuck after 3 attempts: work through ONE example together, then give a similar problem
- Respond in Armenian only`;

    case 5:
      return `=== PHASE 5: CREATIVE WORK / STEGHTSAGORCAKAN (8-10 min) ===

Open-ended questions. Bloom Level 4-6.

- Ask 2-3 open questions with NO single correct answer:
  «Inch karogh liner yete...?»
  «Vonts karogh entriri...?»  
  «Inch nmani qo kyankhyum...?»
- Connect to real life
- Let the student CREATE — don't correct their creative ideas
- Respond in Armenian only`;

    case 6:
      return `=== PHASE 6: MICRO PROJECT / MIKRO NAKHAGITS (10-12 min) ===

Give ONE small project on topic «${lessonTitle}»:
Examples:
- Write a "letter" from the perspective of [concept]
- Create a problem for a classmate to solve
- Explain [concept] as if to a 6-year-old
- Draw/describe a diagram or schema

GUIDE the student, do NOT complete it for them.
At the end, evaluate TOGETHER (ask the student to self-assess first).
Respond in Armenian only.`;

    case 7:
      return `=== PHASE 7: SUMMARY / AMFOPHUM (5 min) ===

Ask 5-7 summary questions across ALL Bloom levels:
- 2 questions: Bloom 1-2 (recall, understand)
- 2 questions: Bloom 3-4 (apply, analyze)
- 1-2 questions: Bloom 5-6 (evaluate, create)

Use multiple-choice format where appropriate:
ՀАРС [N]: [question?]
1) [option]
2) [option]
3) [option]

Ask student to self-reflect: «Aysor dasits inch yuraces? Inch djvar enkav?»
Calculate and show final mastery score.
Respond in Armenian only.`;

    case 8:
      return `=== PHASE 8: HOMEWORK / TNAYIN ASHKHATANQ ===

Present 3-LEVEL HOMEWORK — student CHOOSES ONE (or all):

⭐ LEVEL 1 — BASIC (Bloom 1-2):
[2-3 straightforward questions/exercises from the lesson]

⭐⭐ LEVEL 2 — EXTENDED (Bloom 3-4):
[2-3 medium-difficulty problems]

⭐⭐⭐ LEVEL 3 — CREATIVE (Bloom 5-6):
[1 open-ended project or creative challenge]

Say: «Ashakert, ĕntrir meke kam barbĕ — jyum ĕntrum ĕk amenĕ:»
End with: list 3 things from today's lesson the student liked.
Wish them well until next class.
Respond in Armenian only.`;

    default:
      return "Introduce the lesson topic and guide the student. Respond in Armenian only.";
  }
}

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

    if (lesson) {
      const [session] = await db
        .select()
        .from(lessonSessionsTable)
        .where(and(eq(lessonSessionsTable.lessonId, lessonId), eq(lessonSessionsTable.userId, req.userId!)))
        .limit(1);

      const phase = session?.currentPhase ?? 1;
      const subjectName = (lesson as { subjectName?: string }).subjectName ?? "Subject";
      const phaseInstr = buildPhaseInstruction(phase, lesson.title, subjectName);

      lessonContext = [
        `LESSON TOPIC: «${lesson.title}»`,
        `SUBJECT: ${subjectName}`,
        lesson.description ? `LESSON DESCRIPTION: ${lesson.description}` : "",
        lesson.content ? `TEXTBOOK CONTENT:\n${lesson.content}` : "",
        ``,
        phaseInstr,
      ].filter(Boolean).join("\n");
    }
  }

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
    .limit(20);

  await db.insert(chatMessagesTable).values({
    userId: req.userId!,
    lessonId: lessonId ?? null,
    role: "user",
    content: message,
  });

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
