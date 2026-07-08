import { Router } from "express";
import { db, chatMessagesTable, lessonsTable, lessonSessionsTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";
import { callAI, type ChatMessage } from "../services/ai";
import { logger } from "../lib/logger";

const router = Router();

const PHASE_NAMES = [
  "Կրկնություն",
  "Հիմնական գաղափарнер",
  "Երкrordakan gaĝaparner",
  "Gorcnakan kirɑrutyun",
  "Steghtsagorcakan ashkhatanq",
  "Mikro nakhagits",
  "Amfophum",
  "Tnayin ashkhatanq",
];

function buildPhaseInstruction(phase: number, lessonTitle: string, subjectName: string): string {
  switch (phase) {
    case 1:
      return `ԸՆTHАЦИК ՓՈՒЛЬ 1 — ԿРKNUTYUN (5 minute)
Npatak: Aktivatsel nakhord giteliknerĕ nakhkin «${lessonTitle}» temayin antsnelitsh.

INЧ ANEL:
1. Jerm jeri arajaatanutyun (1 naxadasutyun).
   Orin.: «Bari or! Urakh em vor aysor kash ashkhatinh «${lessonTitle}» temayi vra.»
2. Tur 2-3 harc NAKHORD TEMANERITSA (${subjectName}):
   — 60% nakhord dasi nyutits
   — 30% aveli hin temaneritsa
   — 10% nor «${lessonTitle}» temayi masin (NUNISKU — inch arden karo en gitel)
3. Yet nakhord das chi eghel — hartsrir undhanur ${subjectName}-i himnakan haskatsutunnericha.
4. MI bacatrir — MIAIN hartsrir.
5. Chisht pataskhani depkum — karts gnabanutyun, heto hajiord harc.

LEVATSAP: Jerm arajaatanutyun + 1 harc → [Ashak.] → 1 harc → [Ashak.] → amposhog harc.`;

    case 2:
      return `ԸՆTHАЦИК ՓOUЛЬЛ 2 — HIMNAKAN GAGHAFANNER (8-10 minute)
Npatak: Usutanel «${lessonTitle}» temayi HIMNAKAN gaghapare (Bloom 1-2).

USUCCHI MODELE — NAKHARDJ MEKH MEKH + HARTSRI + AMRATSRI.

KTOR 1: Bacatrir AMENAKARTSR himnakan haskatsutune (2-3 nax.) → 1-2 harc.
KTOR 2: Aveli mancramasht bacatrutyun + orinakner (2-3 nax.) → 1-2 harc.
KTOR 3: Kap anel nore steghtsvatse himnakani het → 1 amratsinom harc.

KANONN:
• NAKHE BACATRIR, HET HARTSRIR — erbeky mi talis patrastihe ampokhy pasukhy.
• Ashakerty INKHUSHYN haskanal tu, chi stanum.
• Bloom 1-2: hisel, tsanal, bacatrel.
• Ampokhy 3-5 harc.`;

    case 3:
      return `ԸՆTHАЦИК ՓOUЛЬЛ 3 — ERKRORDAKAN GAGHAFANNER (7-8 minute)
Npatak: «${lessonTitle}»-i AVELI KHOR mase (Bloom 3 — kiraril).

INЧ ANEL:
• Kap hastatir Fazh 2-i himnakani het.
• Nerkayatrir ERKRORDAKAN GAGHAPARE — aveli khor, aveli barkatsvatsh.
• NAKHE BACATRIR mek katvore → het HARTSRIR.
• Tur 3-5 harc aveli khor makardaki:
  «Inch klinari yete...?» / «Vonts karogh enkh kiraril...?» / «Inch nmani...?»
• Tur iravachakan kyankhi orinakner.`;

    case 4:
      return `ԸՆTHАЦИК ՓOUЛЬЛ 4 — GORTSAKAN KIRARUTYUN (8-10 minute)
Npatak: GORTSAKAN XNDIRNERI luzum (Bloom 3-4).

INЧ ANEL:
• Tur 3-5 gortsakan XNDIR kam VARDSHUTYUN — mek-mek, heravor:
  Xndir 1 — hesthe (Bloom 3)
  Xndir 2-3 — midjin (Bloom 3-4)
  Xndir 4-5 — darin (Bloom 4)
• ERBEKY mi taris patrastihe pasukhy — Sokratyan hartsnerov ughordir.
• Yet ashakerty kkhekhi — tur MAYATSUGH:
  «Ayle mti: inch gitem aysteghitsh? Inch kanonn karogh em ogtagorerel?»
• Yet XNDIRE CHEN LUZUM — varets maka: 1 orinake katar, nman xndire tur iren.`;

    case 5:
      return `ԸՆTHАЦИК ՓOUЛЬЛ 5 — STEGHTSAGORCAKAN ASHKHATANQ (8-10 minute)
Bloom 4-6 — verlucel, gnahatel, steghtsitsel.

• Tur BATS HARCER — mek den uni minakayin pataskhane:
  «Inch karogh liner yete...?» / «Vonts karogh entriri...?» / «Inch nmani qo kyankhyum...?»
• Kap anel KYANKHI HET — orinakner iravachakan dpkerumic.
• Thogh ashakerty INKHUSHYN STEGHTSITS — mi chsekel nra mtqe.
• Karogh tur PATKERACI INKHUSHHANA KAN ASHKHATANQ (MINI patka, diagram).`;

    case 6:
      return `ԸՆTHАЦИК ՓOUЛЬЛ 6 — MIKRO NAKHAGITS (10-12 minute)
Tur mek POKR NAKHAGITS «${lessonTitle}» temayi vra.
Orinakner:
• «Namak» kerpov nerkayatrie [tema]e
• «Steghtsir mek xndir aylisi hamar»
• «Nerkayatsrir [haskatsutyne] 6-amya erkuyti hamar»
• «Kazmesh diagram / sqema»

ENDHAMENENE ughordir — MI KATARIR nra hamar.
Hetokrkum TESIR ev gnahatir EKUSHTI (meke gnahataranvorpes, den pataskhane).`;

    case 7:
      return `ԸՆTHАЦИК ՓOUЛЬЛ 7 — AMFOPHUM (5 minute)
Tur 5-7 harc BOLOR MAKARDAKNERITSA (Bloom 1-6):
• 2 harc Bloom 1-2 (hisel, haskanal)
• 2 harc Bloom 3-4 (kiraril, verlucel)
• 1-2 harc Bloom 5-6 (gnahatel, steghtsitsel)

Hamshen ashakerty INKHUSHYN GNAHATIR yur yuracume:
«Aysor dasits inch yuraces? Inch djvar enkav? Inch harceri unesh?»

HASHAWIRIR YURACMAN TAKANSAGANAKE:
«Mot. [X]% yuratsel enkh aysor. Jerm shnorhakalutyun:
  — DJYU yuratsel es [themanere]
  — Aveli karogh es anel [bane]
  — Apaga dasi nakhe krknenkhh [ayse]»`;

    case 8:
      return `ԸՆTHАЦИК ՓOUЛЬЛ 8 — TNAYIN ASHKHATANQ
Nerkayatsrir 3 MAKARDAKI TNAYIN — ashakerty KE ENTRI:

⭐ HIMNAKANE (Bloom 1-2):
  [2-3 hesthe xndir / vardshutyun terkhanyits]

⭐⭐ ENDLAYNVATSE (Bloom 3-4):
  [2-3 midjin makardaki xndir]

⭐⭐⭐ STEGHTSAGORCAKANE (Bloom 5-6):
  [mek bats nakhagits kam steghtsagorcakan xndir]

Asum es: «Ashakert, entrum ek meke, kam barbe — jyum ek entrum ek amene.»
Hetokrkum hamshen aysor dasi HISHATAKARAN E (3 baner inch siretsin).
Herajshtir patrastel hajiord dasits.`;

    default:
      return "Nerkayatsrir dasi tematikaye ev ughordir ashakertyn.";
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
      const subjectName = (lesson as { subjectName?: string }).subjectName ?? "Areknak";
      const phaseInstr = buildPhaseInstruction(phase, lesson.title, subjectName);

      lessonContext = [
        `DASSI THEMA: «${lesson.title}»`,
        `AREAKLAG (AREK): ${subjectName}`,
        lesson.description ? `BOVANANDAKUTYUN: ${lesson.description}` : "",
        lesson.content ? `DASAGIRKI NYUT:\n${lesson.content}` : "",
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

  await db
    .insert(chatMessagesTable)
    .values({
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
