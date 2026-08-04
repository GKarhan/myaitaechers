import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "wouter";
import { useAuth } from "@/lib/auth";
import {
  useGetSubjectDetail,
  getGetSubjectDetailQueryKey,
  useGetStudentCourseLessons,
  getGetStudentCourseLessonsQueryKey,
} from "@workspace/api-client-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

type StudentLesson = {
  id: number;
  courseId: number | null | undefined;
  title: string;
  lessonNumber?: number | null;
  pagesFrom?: number | null;
  pagesTo?: number | null;
  textbookAuthor?: string | null;
  textbookTitle?: string | null;
  chapterTitle?: string | null;
  paragraphNumber?: string | null;
  status: string;
  mySessionStatus?: string | null;
  assignedAt?: string | null;
  completedAt?: string | null;
};

export default function SubjectDetail() {
  const { user, token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { id } = useParams<{ id: string }>();
  const subjectId = parseInt(id || "", 10);

  useEffect(() => {
    if (!authLoading && !token) setLocation("/login");
  }, [token, authLoading, setLocation]);

  const { data: subject, isLoading: subjectLoading } = useGetSubjectDetail(subjectId, {
    query: {
      queryKey: getGetSubjectDetailQueryKey(subjectId),
      enabled: !!token && !isNaN(subjectId),
    },
  });

  // Fetch teacher-created course lessons for this subject
  const subjectName = subject?.name ?? "";
  const { data: teacherLessons = [], isLoading: lessonsLoading } = useGetStudentCourseLessons(
    { subject: subjectName },
    {
      query: {
        queryKey: getGetStudentCourseLessonsQueryKey({ subject: subjectName }),
        enabled: !!token && !!subjectName,
      },
    }
  );

  const isTeacher = (user as { role?: string })?.role === "teacher";

  // ── Assigned quizzes for "Ընթացիկ թեստը" ────────────────────────────────────
  type AssignedQuiz = {
    assignmentId: number;
    quizId: number;
    title: string;
    subjectId: number;
    status: string;
    assignedAt: string;
    dueAt: string | null;
  };
  const { data: assignedQuizzes = [] } = useQuery<AssignedQuiz[]>({
    queryKey: ["quizzes", "assigned"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/quizzes/assigned`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return r.json();
    },
    enabled: !!token,
  });
  const currentQuiz = (assignedQuizzes as AssignedQuiz[]).find(
    (q) => q.subjectId === subjectId && q.status !== "COMPLETED"
  ) ?? null;

  // ── Quiz creation state ──────────────────────────────────────────────────
  const [quizModalOpen, setQuizModalOpen]     = useState(false);
  const [quizTitle,     setQuizTitle]         = useState("");
  const [quizLessonIds, setQuizLessonIds]     = useState<number[]>([]);
  const [quizBookId,    setQuizBookId]        = useState<number | null>(null);
  const [quizCount,     setQuizCount]         = useState(10);
  const [quizMode,      setQuizMode]          = useState<"SIMPLE"|"MEDIUM"|"HARD"|"MIXED">("MIXED");
  const [quizBooks,     setQuizBooks]         = useState<{id:number;name:string}[]>([]);
  const [quizCreating,  setQuizCreating]      = useState(false);
  const [quizError,     setQuizError]         = useState<string|null>(null);

  // Load books when modal opens
  useEffect(() => {
    if (!quizModalOpen || !token) return;
    fetch(`${BASE}/api/books`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) {
          const subjectBooks = data.filter((b: {subjectId?: number}) => b.subjectId === subjectId || !b.subjectId);
          setQuizBooks(subjectBooks);
        }
      })
      .catch(() => {});
  }, [quizModalOpen, token, subjectId]);

  async function handleCreateQuiz() {
    if (!token || quizLessonIds.length === 0) return;
    setQuizCreating(true);
    setQuizError(null);
    try {
      const resp = await fetch(`${BASE}/api/quizzes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          subjectId,
          sourceBookId:   quizBookId ?? undefined,
          lessonIds:      quizLessonIds,
          questionCount:  quizCount,
          difficultyMode: quizMode,
          title:          quizTitle.trim() || undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error ?? "Ձախողվeց");
      setQuizModalOpen(false);
      setLocation(`/quiz/${data.id}/review`);
    } catch (e) {
      setQuizError(e instanceof Error ? e.message : "Թestы stvarel chi hajogvec");
    } finally {
      setQuizCreating(false);
    }
  }

  function toggleLesson(id: number) {
    setQuizLessonIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  const getFileIcon = (mimeType: string) => {
    if (!mimeType) return "📄";
    if (mimeType.includes("pdf")) return "📄";
    if (mimeType.includes("word") || mimeType.includes("doc")) return "📝";
    return "📃";
  };

  const formatFileSize = (bytes: number) => {
    if (!bytes) return "0 B";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  };

  if (authLoading || subjectLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user || !subject) return null;

  const completed = subject.completedLessons ?? 0;
  const total = subject.totalLessons ?? 0;
  const pct = subject.progressPercent ?? 0;

  // Active lesson (from teacher) for "ԱՅՍՕՐՎԱ ԴԱՍԸ" section
  const activeLesson = (teacherLessons as StudentLesson[]).find((l) => l.status === "active");

  // Status display helpers — completed uses per-student session status, not global lesson status
  const statusLabel = (l: StudentLesson) => {
    if (l.mySessionStatus === "completed") return { text: "Ավարտված",       cls: "text-teal-400 border-teal-400/30 bg-teal-400/10" };
    if (l.status === "active")             return { text: "Այսօրվա դասը",   cls: "text-primary border-primary/30 bg-primary/10" };
    if (l.status === "assigned")           return { text: "Հանձնարարված",   cls: "text-amber-400 border-amber-400/30 bg-amber-400/10" };
    return                                        { text: "Նախապատրաստված",cls: "text-muted-foreground border-white/10 bg-white/5" };
  };

  // Hierarchical grouping for the "all lessons" section
  const sortedLessons = [...(teacherLessons as StudentLesson[])].sort((a, b) => {
    const ta = (a.textbookTitle ?? "").localeCompare(b.textbookTitle ?? "", "hy");
    if (ta !== 0) return ta;
    const ca = (a.chapterTitle ?? "").localeCompare(b.chapterTitle ?? "", "hy");
    if (ca !== 0) return ca;
    const la = (a.lessonNumber ?? 9999) - (b.lessonNumber ?? 9999);
    if (la !== 0) return la;
    return (a.paragraphNumber ?? "").localeCompare(b.paragraphNumber ?? "");
  });

  const textbookGroups: Map<string, StudentLesson[]> = new Map();
  for (const l of sortedLessons) {
    const tb = l.textbookTitle ?? "";
    if (!textbookGroups.has(tb)) textbookGroups.set(tb, []);
    textbookGroups.get(tb)!.push(l);
  }

  return (
    <div className="min-h-[100dvh] w-full bg-background text-white pb-20">
      <header className="border-b border-white/10 bg-card/50 backdrop-blur-lg sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <Link href="/dashboard" className="text-muted-foreground hover:text-white transition-colors">
              ← Հետ
            </Link>
            <div className="font-bold text-xl bg-clip-text text-transparent bg-gradient-to-r from-primary to-secondary">
              myaiteacher
            </div>
          </div>
          {isTeacher && (
            <button
              onClick={() => { setQuizModalOpen(true); setQuizError(null); }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold hover:opacity-90 transition-opacity shadow-lg shadow-primary/20"
            >
              ✦ Ստեղծել թեստ
            </button>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 pt-10">

        {/* Subject header */}
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-bold">{subject.name}</h1>
            <span className="px-3 py-1 bg-card border border-white/10 rounded-full text-sm text-secondary">
              {subject.grade}
            </span>
          </div>
          {subject.description && (
            <p className="text-muted-foreground">{subject.description}</p>
          )}
        </div>


        {/* ── ԱՅՍՕՐՎԱ ԴԱՍԸ (active lesson) ── */}
        {activeLesson && (
          <div className="mb-12">
            <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              ԱՅՍՕՐՎԱ ԴԱՍԸ
            </h2>
            <div className="rounded-2xl border border-primary/40 bg-primary/5 p-6 shadow-lg shadow-primary/10">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-4">
                <div className="space-y-1">
                  {activeLesson.textbookTitle && (
                    <div className="text-xs text-muted-foreground">
                      Դասագիրք· {activeLesson.textbookTitle}
                      {activeLesson.textbookAuthor && ` (${activeLesson.textbookAuthor})`}
                    </div>
                  )}
                  {activeLesson.chapterTitle && (
                    <div className="text-xs text-secondary/80">Թեմա · {activeLesson.chapterTitle}</div>
                  )}
                  <div className="flex items-center gap-2 mt-1">
                    {activeLesson.lessonNumber && (
                      <span className="text-xs font-mono text-primary/70">Դաս #{activeLesson.lessonNumber}</span>
                    )}
                    {activeLesson.paragraphNumber && (
                      <span className="text-xs text-muted-foreground">§{activeLesson.paragraphNumber}</span>
                    )}
                  </div>
                  <h3 className="text-lg font-bold text-white mt-1">{activeLesson.title}</h3>
                  {(activeLesson.pagesFrom || activeLesson.pagesTo) && (
                    <div className="text-sm text-muted-foreground">
                      Էջ' {activeLesson.pagesFrom ?? "?"}–{activeLesson.pagesTo ?? "?"}
                    </div>
                  )}
                </div>
                <span className="shrink-0 self-start px-3 py-1 rounded-full text-xs font-semibold bg-primary/20 text-primary border border-primary/30">
                  Այսօրվա դասը
                </span>
              </div>
              <Link
                href={`/lessons/${activeLesson.id}`}
                className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-2xl bg-gradient-to-r from-primary to-secondary text-white font-bold text-sm hover:opacity-90 transition-opacity shadow-lg shadow-primary/30"
              >
                🚀 ՍԿՍԵԼ ՍՈՎՈՐԵԼ AI ՈՒՍՈՒՑՉԻ ՀԵՏ
              </Link>
            </div>
          </div>
        )}

        {/* ── ԸՆԹԱՑԻԿ ԹԵՍՏԸ ── */}
        <div className="mb-12">
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-secondary" />
            ԸՆԹԱՑԻԿ ԹԵՍՏԸ
          </h2>
          {currentQuiz ? (
            <div className="rounded-2xl border border-secondary/30 bg-secondary/5 p-6 shadow-lg shadow-secondary/10">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h3 className="text-base font-bold text-white">{currentQuiz.title}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${
                      currentQuiz.status === "IN_PROGRESS"
                        ? "text-amber-400 border-amber-400/30 bg-amber-400/10"
                        : "text-primary border-primary/30 bg-primary/10"
                    }`}>
                      {currentQuiz.status === "IN_PROGRESS" ? "Ընթացքի մեջ" : "Հանձնարարված"}
                    </span>
                    {currentQuiz.dueAt && (
                      <span className="text-xs text-muted-foreground">
                        Վերջնաժամ· {new Date(currentQuiz.dueAt).toLocaleDateString("hy-AM")}
                      </span>
                    )}
                  </div>
                </div>
                <Link
                  href={`/quiz/${currentQuiz.quizId}/start`}
                  className="shrink-0 inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-secondary to-primary text-white font-bold text-sm hover:opacity-90 transition-opacity shadow-lg shadow-secondary/20"
                >
                  ✏️ Սկսել թեստը
                </Link>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-white/10 bg-card/30 p-6 text-center">
              <div className="text-2xl mb-2 text-muted-foreground">📋</div>
              <p className="text-sm text-muted-foreground">Ընթացիկ թեստ չկա</p>
            </div>
          )}
        </div>

        {/* Book section */}
        <div className="pt-8 border-t border-white/10">
          <h2 className="text-xl font-bold mb-5">📚 Գիրքը</h2>
          {(subject as any).book ? (
            <div className="p-5 rounded-2xl bg-card/60 border border-white/10 max-w-xl flex items-start gap-4">
              <div className="text-3xl bg-background/60 p-3 rounded-xl border border-white/10 shrink-0">
                {getFileIcon((subject as any).book.mimeType)}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-base">{(subject as any).book.name}</h3>
                <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
                  <span>{formatFileSize((subject as any).book.fileSize)}</span>
                  <span>·</span>
                  <span>{new Date((subject as any).book.uploadedAt).toLocaleDateString("hy-AM")}</span>
                </div>
                {(subject as any).book.fileUrl && (
                  <a
                    href={(subject as any).book.fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 mt-3 px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold hover:opacity-90 transition-opacity"
                  >
                    Ներբեռնել գիրքը
                  </a>
                )}
              </div>
            </div>
          ) : (
            <div className="p-6 rounded-2xl bg-card/30 border border-white/10 max-w-xl text-center">
              <div className="text-3xl mb-3 text-muted-foreground">📂</div>
              <p className="text-muted-foreground text-sm">Այս առարկայի համար գիրք չկա</p>
            </div>
          )}
        </div>

      </main>

      {/* ── Create Quiz Modal ── */}
      {quizModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setQuizModalOpen(false); }}
        >
          <div className="bg-card border border-white/15 rounded-2xl w-full max-w-lg p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-1">Sts'el test</h2>
            <p className="text-sm text-muted-foreground mb-6">
              AI-n karotagrer harc'er nshvac daser'i node-er'ic
            </p>

            {/* Title */}
            <div className="mb-4">
              <label className="block text-sm text-muted-foreground mb-1.5">
                Testi anvanumě (ket'akan)
              </label>
              <input
                value={quizTitle}
                onChange={(e) => setQuizTitle(e.target.value)}
                placeholder={`Test — ${subject.name}`}
                className="w-full bg-background/60 border border-white/15 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-primary/60"
              />
            </div>

            {/* Book select */}
            {quizBooks.length > 0 && (
              <div className="mb-4">
                <label className="block text-sm text-muted-foreground mb-1.5">
                  Dasagirk' (ket'akan)
                </label>
                <select
                  value={quizBookId ?? ""}
                  onChange={(e) => setQuizBookId(e.target.value ? parseInt(e.target.value) : null)}
                  className="w-full bg-background/60 border border-white/15 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-primary/60"
                >
                  <option value="">— Ch'ondrarel —</option>
                  {quizBooks.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Lesson multi-select */}
            <div className="mb-4">
              <label className="block text-sm text-muted-foreground mb-1.5">
                Daser (nshel minch'ev 1) *
              </label>
              {sortedLessons.length === 0 ? (
                <p className="text-sm text-muted-foreground/60 italic">
                  Dasotsutsakum daser ch'ka
                </p>
              ) : (
                <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                  {sortedLessons.map((l) => (
                    <label
                      key={l.id}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border cursor-pointer transition-colors ${
                        quizLessonIds.includes(l.id)
                          ? "border-primary/60 bg-primary/10"
                          : "border-white/8 hover:border-white/20 hover:bg-white/5"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={quizLessonIds.includes(l.id)}
                        onChange={() => toggleLesson(l.id)}
                        className="accent-primary shrink-0"
                      />
                      <span className="text-sm text-white truncate">{l.title}</span>
                      {l.pagesFrom && (
                        <span className="text-xs text-muted-foreground shrink-0 ml-auto">
                          {l.pagesFrom}–{l.pagesTo}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Question count */}
            <div className="mb-4">
              <label className="block text-sm text-muted-foreground mb-1.5">
                Harc'eri qanaké (1–50)
              </label>
              <input
                type="number"
                min={1}
                max={50}
                value={quizCount}
                onChange={(e) => setQuizCount(Math.min(50, Math.max(1, parseInt(e.target.value) || 10)))}
                className="w-32 bg-background/60 border border-white/15 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-primary/60"
              />
            </div>

            {/* Difficulty mode */}
            <div className="mb-6">
              <label className="block text-sm text-muted-foreground mb-2">
                Djvarowthowtyan mart'
              </label>
              <div className="grid grid-cols-2 gap-2">
                {([["SIMPLE","Pazd"],["MEDIUM","Mjin"],["HARD","Bard"],["MIXED","Xarr"]] as const).map(([val, label]) => (
                  <label
                    key={val}
                    className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border cursor-pointer transition-colors ${
                      quizMode === val
                        ? "border-primary/60 bg-primary/10 text-white"
                        : "border-white/8 text-muted-foreground hover:border-white/20 hover:bg-white/5"
                    }`}
                  >
                    <input
                      type="radio"
                      name="quizMode"
                      value={val}
                      checked={quizMode === val}
                      onChange={() => setQuizMode(val)}
                      className="accent-primary shrink-0"
                    />
                    <span className="text-sm font-medium">{label}</span>
                  </label>
                ))}
              </div>
            </div>

            {quizError && (
              <p className="text-sm text-red-400 mb-4 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-3">
                {quizError}
              </p>
            )}

            <div className="flex gap-3">
              <button
                onClick={handleCreateQuiz}
                disabled={quizCreating || quizLessonIds.length === 0}
                className="flex-1 py-3 rounded-xl bg-gradient-to-r from-primary to-secondary text-white font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center justify-center gap-2"
              >
                {quizCreating ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    AI-n storagetsnum e...
                  </>
                ) : (
                  "✦ Sts'el test"
                )}
              </button>
              <button
                onClick={() => setQuizModalOpen(false)}
                disabled={quizCreating}
                className="px-5 py-3 rounded-xl border border-white/10 text-sm hover:bg-white/5 transition-colors disabled:opacity-40"
              >
                Matarel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
