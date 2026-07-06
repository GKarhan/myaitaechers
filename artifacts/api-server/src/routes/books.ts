import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import { db, booksTable, lessonsTable, subjectsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { logger } from "../lib/logger";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_TEXT_CHARS = 8000;

const GENERATION_SYSTEM_PROMPT = `Դու myaiteacher-ի AI օգնականն ես:
- Վերլուծում ես տրված գրքի/տեքստի բովանդակությունը
- Բաժանում ես թեմաների (ըստ գլուխների կամ բաժինների)
- Յուրաքանչյուր թեմայի համար ստեղծում ես դաս
- Դասերը ստեղծում ես հայերեն
- Յուրաքանչյուր դասի bloomLevel-ը սահմանում ես 1-6 (Բլումի տաքսոնոմիա)
- Պատասխանում ես ԲԱՑԱՌԱՊԵՍ վավեր JSON ձևաչափով — ոչ մի բացատրական տեքստ

JSON ձևաչափ (պարտադիր):
{
  "lessons": [
    {
      "title": "Դասի վերնագիր հայերեն",
      "description": "Կարճ նկարագրություն (1-2 նախ.)",
      "bloomLevel": 2
    }
  ]
}`;

async function ensureUploadsDir() {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    await ensureUploadsDir();
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Թույլատրված են միայն PDF, Word, TXT ֆայլեր"));
    }
  },
});

async function extractText(filePath: string, mimeType: string): Promise<string> {
  const buffer = await fs.readFile(filePath);

  if (mimeType === "text/plain") {
    return buffer.toString("utf8").slice(0, MAX_TEXT_CHARS);
  }

  const gRequire = (globalThis as { require?: NodeRequire }).require;
  if (!gRequire) throw new Error("require not available in this runtime");

  if (
    mimeType === "application/msword" ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const mammoth = gRequire("mammoth") as {
      extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }>;
    };
    const result = await mammoth.extractRawText({ buffer });
    return result.value.slice(0, MAX_TEXT_CHARS);
  }

  if (mimeType === "application/pdf") {
    const pdfParse = gRequire("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
    const result = await pdfParse(buffer);
    return result.text.slice(0, MAX_TEXT_CHARS);
  }

  return "";
}

const router = Router();

// POST /api/books/upload — multipart/form-data: file, subjectId?, name?
router.post(
  "/books/upload",
  requireAuth,
  upload.single("file"),
  async (req: AuthRequest, res) => {
    if (!req.file) {
      res.status(400).json({ error: "Ֆայլ չի կցվել" });
      return;
    }

    const subjectId = req.body.subjectId ? parseInt(String(req.body.subjectId), 10) : null;
    const name = String(req.body.name || req.file.originalname);

    const [book] = await db
      .insert(booksTable)
      .values({
        userId: req.userId!,
        subjectId: subjectId && !isNaN(subjectId) ? subjectId : null,
        name,
        filePath: req.file.path,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
      })
      .returning();

    res.status(201).json({
      id: book.id,
      subjectId: book.subjectId,
      name: book.name,
      fileSize: book.fileSize,
      mimeType: book.mimeType,
      uploadedAt: book.uploadedAt.toISOString(),
    });
  }
);

// GET /api/books
router.get("/books", requireAuth, async (req: AuthRequest, res) => {
  const books = await db
    .select()
    .from(booksTable)
    .where(eq(booksTable.userId, req.userId!));

  res.json(
    books.map((b) => ({
      id: b.id,
      subjectId: b.subjectId,
      name: b.name,
      fileSize: b.fileSize,
      mimeType: b.mimeType,
      uploadedAt: b.uploadedAt.toISOString(),
    }))
  );
});

// GET /api/books/:bookId
router.get("/books/:bookId", requireAuth, async (req: AuthRequest, res) => {
  const bookId = parseInt(String(req.params.bookId), 10);

  const [book] = await db
    .select()
    .from(booksTable)
    .where(and(eq(booksTable.id, bookId), eq(booksTable.userId, req.userId!)))
    .limit(1);

  if (!book) {
    res.status(404).json({ error: "Գիրք չի գտնվել" });
    return;
  }

  res.json({
    id: book.id,
    subjectId: book.subjectId,
    name: book.name,
    fileSize: book.fileSize,
    mimeType: book.mimeType,
    uploadedAt: book.uploadedAt.toISOString(),
  });
});

// POST /api/books/:bookId/generate-lessons
router.post(
  "/books/:bookId/generate-lessons",
  requireAuth,
  async (req: AuthRequest, res) => {
    const bookId = parseInt(String(req.params.bookId), 10);

    const [book] = await db
      .select()
      .from(booksTable)
      .where(and(eq(booksTable.id, bookId), eq(booksTable.userId, req.userId!)))
      .limit(1);

    if (!book) {
      res.status(404).json({ error: "Գիրք չի գտնվել" });
      return;
    }

    if (!book.subjectId) {
      res.status(400).json({ error: "Գիրքը կապված չէ առարկայի հետ" });
      return;
    }

    const [subject] = await db
      .select()
      .from(subjectsTable)
      .where(eq(subjectsTable.id, book.subjectId))
      .limit(1);

    let text = "";
    try {
      text = await extractText(book.filePath, book.mimeType);
    } catch (err) {
      logger.error({ err }, "File text extraction failed");
      res.status(500).json({ error: "Ֆայլի մշակումն անհնար է" });
      return;
    }

    if (!text.trim()) {
      res.status(400).json({ error: "Ֆայլից տեքստ հնարավոր չեղավ հանել" });
      return;
    }

    const subjectName = subject?.name ?? "Անհայտ";
    const userMessage = `Առարկա: ${subjectName}\n\nԳրքի տեքստ:\n${text}\n\nԳեներացրու 5-8 դաս JSON ձևաչափով:`;

    let aiRaw = "";
    try {
      const completion = await openrouter.chat.completions.create({
        model: "deepseek/deepseek-chat-v3-0324",
        max_tokens: 8192,
        temperature: 0.4,
        messages: [
          { role: "system", content: GENERATION_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      });
      aiRaw = completion.choices[0]?.message?.content ?? "";
    } catch (err) {
      logger.error({ err }, "AI lesson generation failed");
      res.status(503).json({ error: "AI ծառայությունը հասանելի չէ" });
      return;
    }

    // Parse JSON from AI response (strip markdown code fences if present)
    let generated: { lessons: Array<{ title: string; description: string; bloomLevel: number }> };
    try {
      const jsonStr = aiRaw
        .replace(/^```(?:json)?\s*/m, "")
        .replace(/\s*```\s*$/m, "")
        .trim();
      generated = JSON.parse(jsonStr) as typeof generated;
    } catch (err) {
      logger.error({ err, aiRaw }, "Failed to parse AI JSON response");
      res.status(500).json({ error: "AI-ի պատասխանը JSON ձևաչափով չէ" });
      return;
    }

    if (!Array.isArray(generated.lessons) || generated.lessons.length === 0) {
      res.status(500).json({ error: "AI-ն չի գեներացրել դասեր" });
      return;
    }

    // Insert into lessons table
    const inserted = await db
      .insert(lessonsTable)
      .values(
        generated.lessons.map((l) => ({
          subjectId: book.subjectId!,
          title: l.title,
          description: l.description,
          bloomLevel: Math.min(6, Math.max(1, l.bloomLevel || 1)),
          phases: [],
        }))
      )
      .returning();

    res.json({
      lessons: inserted.map((l) => ({
        id: l.id,
        title: l.title,
        description: l.description,
        bloomLevel: l.bloomLevel,
      })),
      count: inserted.length,
    });
  }
);

export default router;
