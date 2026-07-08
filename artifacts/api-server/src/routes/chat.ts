import { Router } from "express";
import { db, chatMessagesTable, lessonsTable, lessonSessionsTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";
import { callAI, type ChatMessage } from "../services/ai";
import { logger } from "../lib/logger";

const router = Router();

// ─────────────────────────────────────────────
//  4-PHASE LESSON STRUCTURE
//
//  Phase 1 — Կrknoutyun (Review of previous lesson)
//    3–5 MC questions, one at a time → mastery %
//
//  Phase 2 — Nor das / Himnakan (New lesson – basics)
//    Theory → MC questions → 1-3 exercises → if ok → advance
//
//  Phase 3 — Khor ousumnasirum (Deep study)
//    Deeper theory → 1-3 exercises → full knowledge check → mastery %
//
//  Phase 4 — Tnayin (Homework + end)
//    3-level HW → warm goodbye
// ─────────────────────────────────────────────

function buildPhaseInstruction(phase: number, lessonTitle: string, subjectName: string): string {
  switch (phase) {

    // ══════════════════════════════════════════════
    case 1:
      return `=== ՓՈՒLL 1 — ԿRKNOUTYUN (Նախord dassi krknutyun) ===

ԿARGOR KANONNNER — katarelou hamar khstaguyn hamataragoutyoumb:

▸ ТОTAL: 3-ից 5 harc (ĉer voroshes storoghoutyoun-ic, 3 lav e)
▸ MEK MEK: Мек harc → spasir pataskhani → feedback → haĵord harc
▸ ТEMA: Namanakavor ${subjectName}-i NAXORD DASERIC (vorĕ nochin arajin "${lessonTitle}" dasĕ cĕ)
▸ DZEVACHAPH (KHSTAGOUYN HAVAROUTYOUMB HANDARTSI):

ՀАРЦ [N]։ [Harc hayerĕn?]
1) [Ĉanaparh A]
2) [Ĉanaparh B]
3) [Ĉanaparh G]

ARACHĬN PATASKHANE PETQ E PARVATSNI:
1. Mek ĵerm barevorakan nakhadas (1 banak)
2. Anmijayapes ՀАРЦ 1-ĕ verevagirts dzevachaphov

AMBOGĴ KRKNUTYOUNY AVARTVOUM E AYSPIS:
▸ Ĉisht pataskhanic heto: «✓ Ĉisht e! [Kaŕts bacatroutyoun]» → haĵord harc
▸ Skhal pataskhanic heto: «✗ Oche ĉisht: Ĉisht pataskhane [N]-n er — [bacatroutyoun]» → haĵord harc

VERJIN GROUM (ambogh 3-5 harc avartvoum e heto):
---
📊 Нախord dasi krknutyouni ardyunknerĕ.

Ĉisht patakhanner: [X]-ic [YNDAMENE] ([PERCENT]%)

[Eke ≥ 70%]:
Ĉarĭ! Naxord theman lav ĕ yuratsrel: Sharchakareri kĕ gnas nor dassi:

[Eke < 70%]:
Mot naxord theman mĕknabar krnĕr krknel, bayts aysor el sharchakareri kĕ gnas nor dassi:
---

MATH FORMAT: MIAYĬN Unicode — 2³, 5², ×, ÷, √ (VOĈ LaTeX \\( \\) kam \\[ \\])
LEZOU: MIAYĬN HAYEREN`;

    // ══════════════════════════════════════════════
    case 2:
      return `=== ՓOUЛL 2 — НОR DAS: HIMNAKAN MASER ===

DOU OUCOUCICH ES — nerkayatsroum es nor nywth kaŕ-kaŕ.

АKĴORD PATTERN-ĕ kataril (3 qayl):

── QAYL A: TEORIA ──
Nerkayas "«${lessonTitle}»" dassi HIMNAKAN gaghaparĕ — 3-4 kaŕts nakhadas.
Oktagortse dasagirqi lezoun, hayeren:
• Sovoroutyounĕ ĝkelĕ amenaporov
• Iravounakavor ornakoumner
• Iraskanali kyanki haraberoutyoun

── QAYL B: MC ՀАРCOUK ──
Teoria nerkaycnoum e heto MEC-MIAYN MEK HARC tuĵr 1) 2) 3) dzevachaphov:
ՀАРЦ [N]։ [Teoria masic harc?]
1) ...   2) ...   3) ...

Spasir pataskhani → ĉisht/skhal feedback → haĵord teorian kam harc

── QAYL G: VARZHOUTYOUNNNER ──
1-3 varzhoutyoun (parzic → baroguin).
Tuĵr MEK VARZHOUTYOUN — spasir pataskhani:
ВАРज [N]։ [Varzhoutyoun hayerĕn]
Ughordir, min cĝel patĥasty patrasty pataskhane.
Eke ashakertn inkouroujov luzum er → govabanil.
Eke kaŕ er → ogjanel kaŕts ughordomov, mer mek varzhoutyoun tuĵr.

AVARTVOUM AYSPIS (bazhakabar yuratsnel heto):
---
✅ Himnakan masĕ yuratsvel e [PERCENT]%-ov.

[Eke ≥ 70%]: Ĉarĭ! Sharchakareri kĕ gnas "${lessonTitle}"-i khkhoran ousumnasirumy.
[Eke < 70%]: Menak mi harc kaŕts krknenq, heto sharchakareri kĕ gnas.
---

MATH FORMAT: Unicode only — 2³, ×, ÷, √. VOĈ LaTeX.
LEZOU: MIAYĬN HAYEREN`;

    // ══════════════════════════════════════════════
    case 3:
      return `=== ՓOUЛL 3 — KHOR OUSUMNASIRUM + AMBOGH STUGUM ===

MASER A — KHOR TEORIA:
Nerkayas "${lessonTitle}"-i KHKHOR aspektnerĕ — 3-4 kaŕts nakhadas.
Mej mтĕv barzrakarg orinakner, kapmoutyounner ayl themanerĕ.

MASER B — VARZHOUTYOUNNNER (1–3 hath):
Tuĵr AMM-ic MEKĜ khŗndir parzic → miĵin → barouguin:
ВАРज [N]։ [Varzhoutyoun]
Ughordir, min cĝel. Eke kaŕ er → khnayakan harc tuĵr.

MASER G — AMBOGH STUGUM:
Verchin 3–5 harc AMBOGH THEMATIC "${lessonTitle}"-ic:
Bloom makardaknerĕ 1-ic minchev 4 (hisel, haskanal, kiraril, verlucel):
ՀАРЦ [N]։ [Ambogh harc 1) 2) 3) dzevachaphov]

AVARTVOUM (ambogh stugoumy avartvoum e heto):
---
🎓 Dasi amboxĥ stougoumy:

✓ Ĉisht patakhanner: [X]-ic [YNDAMENE] ([PERCENT]%)

[Eke ≥ 80%]: ⭐ Gĉhejn! "${lessonTitle}" theman pudjapĝs yuratsvel e: 
[Eke ≥ 60%]: 👍 Lav mekнarkoum: Mĭ kaŕts sharoujnakel.
[Eke < 60%]: 💪 Ays theman krknoum en haskanal: Chabampknel.

Шarchakareri kĕ gnas tnayin handnaraŕoutyoun:
---

MATH FORMAT: Unicode only. LEZOU: MIAYĬN HAYEREN`;

    // ══════════════════════════════════════════════
    case 4:
      return `=== ՓOUЛL 4 — TNAYIN HANDNARAŔOUTYOUN + AVART ===

Patarastel ԵՐΕQ makardaki tnayin. Ashakertn ĕntroum e:

⭐ HIMNAKAN (Bloom 1–2):
[2-3 hanel varzhoutyoun himnakan haskacoutyounit]

⭐⭐ KHORHRDATAKAN (Bloom 3–4):
[1-2 varzhoutyoun kiraroumov ev bacatroutyoumb]

⭐⭐⭐ STEGHTSAGORTSAKAН (Bloom 5–6):
[1 steghtsagortsakaн hnarcavoroutyoun kyanquic]

Dasĕ avartel ĵerm avartabanakoumov — shnorhakalerov ev qaджalararoutyoumb haĵord dassi hamar.

LEZOU: MIAYĬN HAYEREN`;

    default:
      return `Ughordir aŝakertĕn "${lessonTitle}" themayin kapa ${subjectName}-i masnahatoroutyoumb. MIAYĬN HAYEREN.`;
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
        lesson.content ? `TEXTBOOK CONTENT:\n${lesson.content}` : "",
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
    .limit(30);

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
