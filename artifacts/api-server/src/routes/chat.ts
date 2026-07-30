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
//   Փուլ 2 — Նոր դաս / Հիմնական (Նոր դաս՝ հիմunqner)
//     Տեսություն → հarcer → 1-3 varzhutuin → ete chist e → araj
//
//   Փուլ 3 — Խorh usumnasiruthun (Xoracvats)
//     Avar xs xorh tesuthun → 1-3 varzhutuin → liarjek gitelighi stugum → yuracman %
//
//   Փouul 4 — Tnain ashxataank (Tnain + avart)
//     3 makaradakov tnain → jerm hrajeshtiov
// ─────────────────────────────────────────────

type PracticalTask = {
  task: string;
  purpose?: string | null;
  sourcePage?: string | null;
  difficultyLevel?: "LOW" | "MEDIUM" | "HIGH" | null;
  successCriteria?: string | null;
  relatedNodeTitle?: string | null;
  assignment?: "CLASS" | "HOMEWORK" | null;
};

type RichNode = {
  title: string;
  theoryContent: string | null;
  targetBloomLevel: number;
  estimatedMinutes: number;
  childFriendlyExplanation: string | null;
  basicExamples: unknown;
  realLifeExamples: unknown;
  commonMisconception: string | null;
  prerequisiteNodes: unknown;
};

interface PhaseInstructionOptions {
  phase: number;
  lessonTitle: string;
  subjectName: string;
  coreProblem: string | null;
  coreIdea: string | null;
  node: RichNode | null;
  classTasks: PracticalTask[];
  homeworkTasks: PracticalTask[];
}

function toStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((x): x is string => typeof x === "string");
}

function buildPhaseInstruction(opts: PhaseInstructionOptions): string {
  const { phase, lessonTitle, subjectName, coreProblem, coreIdea, node, classTasks, homeworkTasks } = opts;

  const cfeBlock = node?.childFriendlyExplanation
    ? `\nPROVIDED EXPLANATION (use near-verbatim as your core theory — do not invent a different one):\n${node.childFriendlyExplanation}`
    : "";

  const basicExamplesArr = toStringArray(node?.basicExamples);
  const basicExBlock = basicExamplesArr.length > 0
    ? `\nPROVIDED EXAMPLES (present these as illustrative examples):\n${basicExamplesArr.map((e, i) => `${i + 1}. ${e}`).join("\n")}`
    : "";

  const misconceptionBlock = node?.commonMisconception
    ? `\nKNOWN MISCONCEPTION (design at least one MCQ distractor option specifically targeting this misconception — do NOT invent a generic wrong answer instead):\n${node.commonMisconception}`
    : "";

  const realLifeArr = toStringArray(node?.realLifeExamples);
  const realLifeBlock = realLifeArr.length > 0
    ? `\nREAL-LIFE EXAMPLES FOR DEEP FRAMING (use these for richer real-world context in Phase 3):\n${realLifeArr.map((e, i) => `${i + 1}. ${e}`).join("\n")}`
    : "";

  const classTasksBlock = classTasks.length > 0
    ? `\nCLASS EXERCISES — present each task text as-is (do NOT invent new exercises):\n${classTasks.map((t, i) => {
        let line = `${i + 1}. ${t.task}`;
        if (t.successCriteria) line += `\n   [GRADING CRITERIA — for your internal use only, do NOT show to student]: ${t.successCriteria}`;
        return line;
      }).join("\n")}`
    : "";

  const homeworkBlock = homeworkTasks.length > 0
    ? `\nHOMEWORK TASKS — present each task text as-is in a friendly closing message:\n${homeworkTasks.map((t, i) => {
        let line = `${i + 1}. ${t.task}`;
        if (t.difficultyLevel) line += ` [${t.difficultyLevel}]`;
        return line;
      }).join("\n")}`
    : "";

  switch (phase) {

    // ══════════════════════════════════════════════
    case 1:
      return `=== ՓՈՒԼ 1 — ԿՐԿՆՈՒԹՅՈՒՆ (Նախորդ դասի կրկնություն) ===
${coreIdea ? `\nLESSON MASTERY GOAL (use to frame what "mastering this lesson" means if needed): ${coreIdea}` : ""}

ԿԱՆՈՆՆԵՐ — կատարելու համար խստագույն հետողականությամբ.

▸ ԸՆDHANUR: 3-ից 5 հarcer (eluneliv karoughutunits, 3-ë lav e)
▸ MEK-MEK: Mek harc → spacir pataskhanits → karcik (feedback) → hajordë harc
▸ TEMA: Hamapatasxan ${subjectName}-i NAXORDATS DASERIT` + ` (vorn vor chë arrach "«${lessonTitle}»" dasn e)
▸ DZEVACHAP (XSTRAGUYNS HETEVOLUTHIAMB):

HARC [N]։ [Harc hayerën?]
1) [Tarberakat A]
2) [Tarberakat B]
3) [Tarberakat G]

ARRACH PATASKHANË PETK E PARUNAKI:
1. Mek jerm barevortskakan naxadasouthun (1 togh)
2. Anmijabarar HARC 1-ë verevum gratz dzevachapov

AMBOGJ KRKNOUTUNE AVARTVOUM E AYSPEC:
▸ Chist pataskhanits het. "✓ Chist e. [Karch batsatroutun]" → hajord harc
▸ Sxal pataskhanits het. "✗ Voch chist e. Chist pataskhanë [N]-n er — [batsatroutun]" → hajord harc

VERJIN GROUM (ambogj 3-5 harc avartveluts het):
---
📊 Naxordats dasi krknouthyan ardunknerë.

Chist pataskhannerë: [X]-its [YNDAMENE] ([PERCENT]%)

[Ete ≥ 70%]:
Hrashali e. Naxordats temayë lav es yuracrel. Ancnoum enk nor dasi.

[Ete < 70%]:
Avar lav kliner naxordats temayë krkin verhetel, bayc aysor el kanqcnenk nor dasi.
---

MATIMATIKAL DZEVACHA: MIAYNS Yunilod — 2³, 5², ×, ÷, √ (VOCH LaTeX \\( \\) kam \\[ \\])
LEZOU: MIAYNS HAYEREN`;

    // ══════════════════════════════════════════════
    case 2:
      return `=== ՓOUUL 2 — NOR DAS. HIMNAKAN MASER ===${cfeBlock}${basicExBlock}${misconceptionBlock}

DOU OUCUCHICH ES — nerkayacnoum es nor nyute qayl arr qayl.

AKNKALVATS KARUCVACTSE katarel (3 qayl).

── QAYL A. TEORIA ──
Nerkayacru «${lessonTitle}» dasi HIMNAKAN gacapare — 3-4 karch naxadasouthun.
${node?.childFriendlyExplanation
  ? `USE THE PROVIDED EXPLANATION above near-verbatim as your core theory — this is the approved child-friendly explanation for this node.`
  : `Ogtagorcer dasagrkits lezoun, hayerën:\n- Sovorouthunë kirarrelits amenaparsov\n- Irakanoum kyanqits orinakerits\n- Kapë kyanqi haraberutunnerit het`}
${basicExamplesArr.length > 0
  ? `Present the PROVIDED EXAMPLES above as your illustrative examples — do not invent different ones.`
  : `Ogtagorcer irakan kyanqits orinakerits (hayerën)`}

── QAYL B. BAZMAKIN YNRUTOUTIAM HARC (MCQ) ──
Teorian nerkayacneluts het tur MIAYNS MEK HARC 1) 2) 3) dzevacha.${misconceptionBlock ? `\nIMPORTANT: Design at least one distractor option that targets the KNOWN MISCONCEPTION listed above — this makes wrong-answer feedback meaningful.` : ""}
HARC [N]։ [Teoriayi masits harc?]
1) ...    2) ...    3) ...

Spacir pataskhanis → chist/sxal karcik (feedback) → hajord teorian kam harce

── QAYL G. VARZHOUTIUNNER ──
${classTasks.length > 0
  ? `Use the CLASS EXERCISES listed above. Present them one at a time. Do NOT invent new exercises.
VARZH [N]։ [Task text from CLASS EXERCISES]
When evaluating the student's answer, use the GRADING CRITERIA (if provided for that task) as ground truth — do not show it to the student.`
  : `1-3 varzhoutun (parsits → bardin).
Tur MEK VARZHOUTUN — spacir pataskhanis.
VARZH [N]։ [Varzhoutun hayerën]
Oughghordir, minchev gtni patasxan.
Ete ashakerte inknourinoum e luzum — xrahasuri.
Ete dzhvaranoum e — oghni karch oughghordumov, mi tur patrastë pataskhanë.`}

AVARTVOUM E AYSPEC (bazhin bayc yuracneluts het):
---
✅ Himnakan masë yuracvel e [PERCENT]%-ov.

[Ete ≥ 70%]: Hrashali e. Ancnoum enk «${lessonTitle}»-i xorë usumnasiruthian.
[Ete < 70%]: Ekek mi pokr el krnkenk, heto kanqcnenk arrach.
---

MATIMATIKAL DZEVACHA: MIAYNS Yunilod — 2³, ×, ÷, √. VOCH LaTeX.
LEZOU: MIAYNS HAYEREN`;

    // ══════════════════════════════════════════════
    case 3:
      return `=== PHUL 3 — XORACVATS OUCUCUM + AMBOGJ STUGUM ===${realLifeBlock}${classTasksBlock}

MAS A — XORË TEORIA.
Nerkayacru «${lessonTitle}»-i XORACVATS aspektnerë — 3-4 karch naxadasouthun.
${realLifeArr.length > 0
  ? `Use the REAL-LIFE EXAMPLES above to anchor the deeper theory in real-world context — build the "deeper" framing around them.`
  : `Nerarel bardzrakarg orinakerits, kaperi ayl temanerits het.`}

MAS B — VARZHOUTIUNNER (1–3 hat).
${classTasks.length > 0
  ? `Use the CLASS EXERCISES listed in CLASS EXERCISES above. Present them one at a time, in order (simple → complex). Do NOT invent new exercises.
VARZH [N]։ [Task text from CLASS EXERCISES]
When checking the student's answer compare it against the GRADING CRITERIA (if provided) as ground truth — do NOT show criteria to the student. Guide with hints if struggling.`
  : `Tur ëst herrakanoutiun parsits → midjin → bard.
VARZH [N]։ [Varzhoutun]
Oughghordir, minchev gtni. Ete dzhvaranoum e — tur hushov harc.`}

MAS G — AMBOGJ STUGUM.
Verjum 3–5 harc AMBOGJ TEMATIKAL «${lessonTitle}»-its.
Blumi makaradaknerë 1-its minchev 4 (hishtarrel, haskarnel, kirarrrel, verlucel):
HARC [N]։ [Ambogj harc 1) 2) 3) dzevacha]

AVARTVOUM E (ambogj stugumë avartveluts het):
---
🎓 Dasi ambogj stugumë.

✓ Chist pataskhannerë: [X]-its [YNDAMENE] ([PERCENT]%)

[Ete ≥ 80%]: ⭐ Hrashali e. «${lessonTitle}» temayë gerazanch e yuracvel.
[Ete ≥ 60%]: 👍 Lav meknark. Sharounakarir mi pokr el.
[Ete < 60%]: 💪 Ays temayë harkavor e verhetel u krnkel.

Ancnoum enk tnain handnararoutian.
---

MATIMATIKAL DZEVACHA: MIAYNS Yunilod. LEZOU: MIAYNS HAYEREN`;

    // ══════════════════════════════════════════════
    case 4:
      return `=== PHUL 4 — TNAIN HANDNARARAROUTUN + AVART ===${homeworkBlock}

${homeworkTasks.length > 0
  ? `Present the HOMEWORK TASKS listed above as the actual homework in a friendly closing message — do NOT invent different exercises.
For each task, present its text clearly and warmly. You may add a brief encouraging note before or after each task if appropriate.
After presenting all tasks, close with a warm farewell, thanks, and encouragement for the next lesson.`
  : `Patrastrel EREK makaradaki tnain ashxataank. Ashakertë yntroum e.

⭐ HIMNAKAN (Blum 1–2):
[2-3 himnakan haskacoutiunneris varzhoutun]

⭐⭐ HAVELIAL (Blum 3–4):
[1-2 varzhoutun kirarroumov u batsatroutambë]

⭐⭐⭐ STEGHCAGORTSKAKAN (Blum 5–6):
[1 steghcagortskakan hnaravorouthun kyanqits]

Dasë avartel jerm hrajeshtov, shnorhakalonutiunnerov u qajalerankits hajord dasi hamar.`}

LEZOU: MIAYNS HAYEREN`;

    default:
      return `Oughghordiru ashakertine «${lessonTitle}» temain kapvats ${subjectName}-i masnagitoambë. MIAYNS HAYEREN.`;
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

      // Extract lesson-level enrichment fields
      const coreProblem = (lesson as { coreProblem?: string | null }).coreProblem ?? null;
      const coreIdea   = (lesson as { coreIdea?: string | null }).coreIdea ?? null;
      const rawTasks   = (lesson as { practicalTasks?: unknown }).practicalTasks;
      const allTasks: PracticalTask[] = Array.isArray(rawTasks) ? (rawTasks as PracticalTask[]) : [];

      // Split tasks: CLASS (default) vs HOMEWORK
      const classTasks    = allTasks.filter((t) => t.assignment !== "HOMEWORK");
      const homeworkTasks = allTasks.filter((t) => t.assignment === "HOMEWORK");

      // If this session is working through lesson_nodes, use the CURRENT
      // node's title/theory/bloom level instead of the whole lesson's —
      // this is what lets mastery be tracked per sub-topic. Lessons with
      // no nodes yet fall back to the old whole-lesson behavior unchanged.
      let currentNode: RichNode | null = null;
      if (session?.currentNodeId) {
        const [node] = await db
          .select({
            title:                    lessonNodesTable.title,
            theoryContent:            lessonNodesTable.theoryContent,
            targetBloomLevel:         lessonNodesTable.targetBloomLevel,
            estimatedMinutes:         lessonNodesTable.estimatedMinutes,
            childFriendlyExplanation: lessonNodesTable.childFriendlyExplanation,
            basicExamples:            lessonNodesTable.basicExamples,
            realLifeExamples:         lessonNodesTable.realLifeExamples,
            commonMisconception:      lessonNodesTable.commonMisconception,
            prerequisiteNodes:        lessonNodesTable.prerequisiteNodes,
          })
          .from(lessonNodesTable)
          .where(eq(lessonNodesTable.id, session.currentNodeId))
          .limit(1);
        currentNode = node ?? null;
      }

      const topicName    = currentNode?.title ?? lesson.title;
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
        coreProblem       ? `CORE_PROBLEM: ${coreProblem}`          : "",
        coreIdea          ? `CORE_IDEA: ${coreIdea}`                : "",
        topicContent      ? `TEXTBOOK CONTENT:\n${topicContent}`    : "",
        dueReviewsLine,
        ``,
        buildPhaseInstruction({
          phase,
          lessonTitle:  topicName,
          subjectName,
          coreProblem,
          coreIdea,
          node:         currentNode,
          classTasks,
          homeworkTasks,
        }),
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
