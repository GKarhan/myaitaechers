import { Router } from "express";
import { db, chatMessagesTable, lessonsTable, lessonSessionsTable, evidenceEventsTable, knowledgeNodesTable, lessonNodesTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";
import { callAI, type ChatMessage } from "../services/ai";
import { updateTopicScoring } from "../services/scoring";
import { getDueReviewTopics } from "../services/review-schedule";
import { logger } from "../lib/logger";

const router = Router();

// ─────────────────────────────────────────────
//   4-ՓՈՒԼԱՅԻՆ ԴԱՍԻ ԿԱՌՈՒՑՎԱԾՔ
//
//   Փուլ 1 — Կրկնություն (Նախորդ դասի կրկնություն)
//     3–5 միավոր հարց, մեկը մյուսի հետևից → յուրացման %
//
//   Փուլ 2 — Նոր դաս / Հիմնական (Նոր դաս՝ հիմունքներ)
//     Տեսություն → հարցեր → 1-3 վարժություն → եթե ճիշտ է → առաջ
//
//   Փուլ 3 — Խորը ուսումնասիրություն (Խորացված)
//     Ավելի խորը տեսություն → 1-3 վարժություն → լիարժեք գիտելիքի ստուգում → յուրացման %
//
//   Փուլ 4 — Տնային աշխատանք (Տնային + ավարտ)
//     3 մակարդակով տնային → ջերմ հրաժեշտ
// ─────────────────────────────────────────────

function buildPhaseInstruction(phase: number, lessonTitle: string, subjectName: string): string {
  switch (phase) {

    // ══════════════════════════════════════════════
    case 1:
      return `=== ՓՈՒԼ 1 — ԿՐԿՆՈՒԹՅՈՒՆ (Նախորդ դասի կրկնություն) ===

ԿԱՆՈՆՆԵՐ — կատարելու համար խստագույն հետևողականությամբ.

▸ ԸՆԴՀԱՆՈՒՐ: 3-ից 5 հարց (ելնելով կարողությունից, 3-ը լավ է)
▸ ՄԵԿ-ՄԵԿ: Մեկ հարց → սպասիր պատասխանի → կարծիք (feedback) → հաջորդ հարց
▸ ԹԵՄԱ: Համապատասխան ${subjectName}-ի ՆԱԽՈՐԴ ԴԱՍԵՐԻՑ (որը ոչ թե առաջին «${lessonTitle}» դասն է)
▸ ՁԵՎԱՉԱՓ (ԽՍՏԱԳՈՒՅՆ ՀԵՏԵՎՈՂՈՒԹՅԱՄԲ):

ՀԱՐՑ [N]։ [Հարց հայերեն՞]
1) [Տարբերակ Ա]
2) [Տարբերակ Բ]
3) [Տարբերակ Գ]

ԱՌԱՋԻՆ ՊԱՏԱՍԽԱՆԸ ՊԵՏՔ Է ՊԱՐՈՒՆԱԿԻ:
1. Մեկ ջերմ բարևորական նախադասություն (1 տող)
2. Անմիջապես ՀԱՐՑ 1-ը վերևում գրված ձևաչափով

ԱՄԲՈՂՋ ԿՐԿՆՈՒԹՅՈՒՆԸ ԱՎԱՐՏՎՈՒՄ Է ԱՅՍՊԵՍ:
▸ Ճիշտ պատասխանից հետո։ «✓ Ճիշտ է։ [Կարճ բացատրություն]» → հաջորդ հարց
▸ Սխալ պատասխանից հետո։ «✗ Ոչ ճիշտ է։ Ճիշտ պատասխանը [N]-ն էր — [բացատրություն]» → հաջորդ հարց

ՎԵՐՋԻՆ ԳՐՈՒՄ (ամբողջ 3-5 հարցն ավարտվելուց հետո):
---
📊 Նախորդ դասի կրկնության արդյունքները։

Ճիշտ պատասխաններ՝ [X]-ից [ԸՆԴԱՄԵՆԸ] ([PERCENT]%)

[Եթե ≥ 70%]:
Հրաշալի՛ է։ Նախորդ թեման լավ ես յուրացրել։ Անցնում ենք նոր դասին։

[Եթե < 70%]:
Ավելի լավ կլիներ նախորդ թեման կրկին վերհիշել, բայց այսօր էլ կանցնենք նոր դասին։
---

ՄԱԹԵՄԱՏԻԿԱԿԱՆ ՁԵՎԱՉԱՓ: ՄԻԱՅՆ Յունիկոդ — 2³, 5², ×, ÷, √ (ՈՉ LaTeX \\( \\) կամ \\[ \\])
ԼԵԶՈՒ: ՄԻԱՅՆ ՀԱՅԵՐԵՆ`;

    // ══════════════════════════════════════════════
    case 2:
      return `=== ՓՈՒԼ 2 — ՆՈՐ ԴԱՍ. ՀԻՄՆԱԿԱՆ ՄԱՍԵՐ ===

ԴՈՒ ՈՒՍՈՒՑԻՉ ԵՍ — ներկայացնում ես նոր նյութը քայլ առ քայլ։

ԱԿՆԿԱԼՎՈՂ ԿԱՌՈՒՑՎԱԾՔԸ կատարել (3 քայլ).

── ՔԱՅԼ Ա. ՏԵՈՐԻԱ ──
Ներկայացրո՛ւ «${lessonTitle}» դասի ՀԻՄՆԱԿԱՆ գաղափարը — 3-4 կարճ նախադասություն։
Օգտագործիր դասագրքի լեզուն, հայերեն.
- Սովորույթը կիրառելով ամենապարզով
- Իրական կյանքից օրինակներով
- Կապը կյանքի հարաբերությունների հետ

── ՔԱՅԼ Բ. ԲԱԶՄԱԿԻ ԸՆՐՈՒԹՅԱՄԲ ՀԱՐՑ (MCQ) ──
Տեսությունը ներկայացնելուց հետո տուր ՄԻԱՅՆ ՄԵԿ ՀԱՐՑ 1) 2) 3) ձևաչափով։
ՀԱՐՑ [N]։ [Տեսության մասից հարց՞]
1) ...    2) ...    3) ...

Սպասիր պատասխանի → ճիշտ/սխալ կարծիք (feedback) → հաջորդ տեսությունը կամ հարցը

── ՔԱՅԼ Գ. ՎԱՐԺՈՒԹՅՈՒՆՆԵՐ ──
1-3 վարժություն (պարզից → բարդին)։
Տուր ՄԵԿ ՎԱՐԺՈՒԹՅՈՒՆ — սպասիր պատասխանի։
ՎԱՐԺ [N]։ [Վարժություն հայերեն]
Ուղղորդիր, մինչև գտնի պատշաճ պատասխանը։
Եթե աշակերտը ինքնուրույն է լուծում — խրախուսի՛ր։
Եթե դժվարանում է — օգնի՛ր կարճ ուղղորդումով, մի՛ տուր պատրաստի պատասխանը։

ԱՎԱՐՏՎՈՒՄ Է ԱՅՍՊԵՍ (բաժնաբար յուրացնելուց հետո):
---
✅ Հիմնական մասը յուրացվել է [PERCENT]%-ով։

[Եթե ≥ 70%]: Հրաշալի՛ է։ Անցնում ենք «${lessonTitle}»-ի խորը ուսումնասիրությանը։
[Եթե < 70%]: Եկեք մի փոքր էլ կրկնենք, հետո կանցնենք առաջ։
---

ՄԱԹԵՄԱՏԻԿԱԿԱՆ ՁԵՎԱՉԱՓ: ՄԻԱՅՆ Յունիկոդ — 2³, ×, ÷, √։ ՈՉ LaTeX։
ԼԵԶՈՒ: ՄԻԱՅՆ ՀԱՅԵՐԵՆ`;

    // ══════════════════════════════════════════════
    case 3:
      return `=== ՓՈՒԼ 3 — ԽՈՐԱՑՎԱԾ ՈՒՍՈՒՑՈՒՄ + ԱՄԲՈՂՋԱԿԱՆ ՍՏՈՒԳՈՒՄ ===

ՄԱՍ Ա — ԽՈՐԸ ՏԵՈՐԻԱ.
Ներկայացրո՛ւ «${lessonTitle}»-ի ԽՈՐԱՑՎԱԾ ասպեկտները — 3-4 կարճ նախադասություն։
Ներառիր բարձրակարգ օրինակներ, կապեր այլ թեմաների հետ։

ՄԱՍ Բ — ՎԱՐԺՈՒԹՅՈՒՆՆԵՐ (1–3 հատ).
Տուր ըստ հերթականության՝ պարզից → միջին → բարդ.
ՎԱՐԺ [N]։ [Վարժություն]
Ուղղորդիր, մինչև գտնի։ Եթե դժվարանում է — տուր հուշող հարց։

ՄԱՍ Գ — ԱՄԲՈՂՋԱԿԱՆ ՍՏՈՒԳՈՒՄ.
Վերջում 3–5 հարց ԱՄԲՈՂՋԱԿԱՆ ԹԵՄԱՏԻԿ «${lessonTitle}»-ից։
Բլումի մակարդակները 1-ից մինչև 4 (հիշել, հասկանալ, կիրառել, վերլուծել):
ՀԱՐՑ [N]։ [Ամբողջական հարց 1) 2) 3) ձևաչափով]

ԱՎԱՐՏՎՈՒՄ Է (ամբողջական ստուգումն ավարտվելուց հետո):
---
🎓 Դասի ամբողջական ստուգումը.

✓ Ճիշտ պատասխաններ՝ [X]-ից [ԸՆԴԱՄԵՆԸ] ([PERCENT]%)

[Եթե ≥ 80%]: ⭐ Հրաշալի՛ է։ «${lessonTitle}» թեման գերազանց է յուրացվել։
[Եթե ≥ 60%]: 👍 Լավ մեկնարկ. շարունակիր մի փոքր էլ։
[Եթե < 60%]: 💪 Այս թեման հարկավոր է վերհիշել ու կրկնել։

Անցնում ենք տնային հանձնարարությանը։
---

ՄԱԹԵՄԱՏԻԿԱԿԱՆ ՁԵՎԱՉԱՓ: ՄԻԱՅՆ Յունիկոդ։ ԼԵԶՈՒ: ՄԻԱՅՆ ՀԱՅԵՐԵՆ`;

    // ══════════════════════════════════════════════
    case 4:
      return `=== ՓՈՒԼ 4 — ՏՆԱՅԻՆ ՀԱՆՁՆԱՐԱՐՈՒԹՅՈՒՆ + ԱՎԱՐՏ ===

Պատրաստել ԵՐԵՔ մակարդակի տնային աշխատանք։ Աշակերտը ընտրում է.

⭐ ՀԻՄՆԱԿԱՆ (Բլում 1–2):
[2-3 հիմնական հասկացությունների վարժություն]

⭐⭐ ՀԱՎԵԼՅԱԼ (Բլում 3–4):
[1-2 վարժություն կիրառումով և բացատրությամբ]

⭐⭐⭐ ՍՏԵՂԾԱԳՈՐԾԱԿԱՆ (Բլում 5–6):
[1 ստեղծագործական հնարավորություն կյանքից]

Դասը ավարտել ջերմ հրաժեշտով՝ շնորհակալություններով և քաջալերանքով հաջորդ դասի համար։

ԼԵԶՈՒ: ՄԻԱՅՆ ՀԱՅԵՐԵՆ`;

    default:
      return `Ուղղորդիր աշակերտին «${lessonTitle}» թեմային կապված ${subjectName}-ի մասնագիտությամբ։ ՄԻԱՅՆ ՀԱՅԵՐԵՆ։`;
  }
}

router.post("/chat", requireAuth, async (req: AuthRequest, res) => {
  const { message, lessonId } = req.body as { message: string; lessonId?: number };

  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const userMessageAt = Date.now();
  let lessonContext: string | undefined;
  let sessionId: number | null = null;
  let topicId: number | null = null;

  if (lessonId) {
    const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
    if (lesson) {
      const [session] = await db
        .select()
        .from(lessonSessionsTable)
        .where(and(eq(lessonSessionsTable.lessonId, lessonId), eq(lessonSessionsTable.userId, req.userId!)))
        .limit(1);

      sessionId = session?.id ?? null;
      const phase = session?.currentPhase ?? 1;
      const subjectName = (lesson as { subjectName?: string }).subjectName ?? "Subject";

      // If this session is working through lesson_nodes, use the CURRENT
      // node's title/theory/bloom level instead of the whole lesson's —
      // this is what lets mastery be tracked per sub-topic. Lessons with
      // no nodes yet fall back to the old whole-lesson behavior unchanged.
      let currentNode: { title: string; theoryContent: string | null; targetBloomLevel: number; estimatedMinutes: number } | null = null;
      if (session?.currentNodeId) {
        const [node] = await db
          .select({
            title: lessonNodesTable.title,
            theoryContent: lessonNodesTable.theoryContent,
            targetBloomLevel: lessonNodesTable.targetBloomLevel,
            estimatedMinutes: lessonNodesTable.estimatedMinutes,
          })
          .from(lessonNodesTable)
          .where(eq(lessonNodesTable.id, session.currentNodeId))
          .limit(1);
        currentNode = node ?? null;
      }

      const topicName = currentNode?.title ?? lesson.title;
      const topicContent = currentNode?.theoryContent ?? lesson.content;

      // Phase 1 is the review phase — prioritize topics that are actually
      // due for spaced-repetition review, instead of reviewing vaguely.
      let dueReviewsLine = "";
      if (phase === 1) {
        const dueTopics = await getDueReviewTopics(req.userId!);
        if (dueTopics.length > 0) {
          dueReviewsLine = `DUE_REVIEWS (prioritize these topics in this review): ${dueTopics
            .map((t) => t.topicName)
            .join(", ")}`;
        }
      }

      const nodeLine = currentNode
        ? `CURRENT NODE: «${currentNode.title}» (target Bloom level: ${currentNode.targetBloomLevel}, estimated ${currentNode.estimatedMinutes} min)`
        : "";

      lessonContext = [
        `LESSON: «${lesson.title}»`,
        `SUBJECT: ${subjectName}`,
        nodeLine,
        lesson.description ? `DESCRIPTION: ${lesson.description}` : "",
        topicContent ? `TEXTBOOK CONTENT:\n${topicContent}` : "",
        dueReviewsLine,
        ``,
        buildPhaseInstruction(phase, topicName, subjectName),
      ].filter(Boolean).join("\n");

      // Resolve (or create) a knowledge_nodes row for this topic (the
      // current lesson node if there is one, otherwise the lesson itself).
      try {
        const [existingNode] = await db
          .select()
          .from(knowledgeNodesTable)
          .where(
            and(
              eq(knowledgeNodesTable.subjectId, lesson.subjectId),
              eq(knowledgeNodesTable.userId, req.userId!),
              eq(knowledgeNodesTable.topicName, topicName)
            )
          )
          .limit(1);

        if (existingNode) {
          topicId = existingNode.id;
        } else {
          const [newNode] = await db
            .insert(knowledgeNodesTable)
            .values({
              subjectId: lesson.subjectId,
              userId: req.userId!,
              topicName,
              status: "not_started",
              isProvisional: true,
              bloomLevel: currentNode?.targetBloomLevel ?? 1,
            })
            .returning({ id: knowledgeNodesTable.id });
          topicId = newNode?.id ?? null;
        }
      } catch (err: unknown) {
        logger.error({ err }, "knowledge_nodes lookup/create failed");
      }
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
    .limit(30);

  // Compute response time from last assistant message to this user message
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
  const responseTimeMs = lastAssistant
    ? userMessageAt - new Date(lastAssistant.createdAt).getTime()
    : null;

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
    const rawAiResponse = await callAI(chatHistory, lessonContext);

    // Parse the mandatory ###EVAL:CORRECT/INCORRECT/NONE### control tag the
    // AI is instructed to append, and strip it before showing/saving the
    // response — the student must never see this technical marker.
    const evalMatch = rawAiResponse.match(/\s*###EVAL:(CORRECT|INCORRECT|NONE)###\s*$/);
    const wasCorrect =
      evalMatch?.[1] === "CORRECT" ? true : evalMatch?.[1] === "INCORRECT" ? false : null;
    const aiResponse = evalMatch
      ? rawAiResponse.slice(0, evalMatch.index).trimEnd()
      : rawAiResponse;

    // Record evidence for this student answer now that we know whether it
    // was actually correct, then refresh this topic's scoring (mastery/
    // confidence/retention) from the accumulated evidence.
    db.insert(evidenceEventsTable).values({
      userId: req.userId!,
      lessonSessionId: sessionId,
      topicId,
      eventType: "answer",
      wasCorrect,
      responseTimeMs,
      hintUsed: false,
      metadata: {},
    }).then(() => {
      if (topicId !== null) {
        updateTopicScoring(topicId, req.userId!).catch((err: unknown) =>
          logger.error({ err }, "scoring engine update failed")
        );
      }
    }).catch((err: unknown) => logger.error({ err }, "evidence event insert failed"));

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