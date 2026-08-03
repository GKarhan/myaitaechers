import { useEffect, useState } from "react";
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

        {/* Stats bar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-12 p-6 rounded-2xl bg-card/60 border border-white/10 shadow-lg">
          <div className="flex gap-8">
            <div>
              <div className="text-muted-foreground text-sm mb-1">Ավարտված / Ընդհանուր</div>
              <div className="text-2xl font-bold text-white">{completed} / {total}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-sm mb-1">Միջին գնահատական</div>
              <div className="text-2xl font-bold text-secondary">{subject.averageScore}</div>
            </div>
          </div>
          <div className="flex-1 md:max-w-md">
            <div className="text-muted-foreground text-sm mb-2 flex justify-between">
              <span>Ընդհանուր առաջընթաց</span>
              <span>{pct}%</span>
            </div>
            <div className="h-2 w-full bg-background rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-primary to-secondary rounded-full transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
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

        {/* ── ԲՈԼՈՐ ԴԱՍԵՐԸ (full teacher lesson list) ── */}
        {!lessonsLoading && sortedLessons.length > 0 && (
          <div className="mb-12">
            <h2 className="text-2xl font-bold mb-5">ԲՈԼՈՐ ԴԱՍԵՐԸ</h2>
            <div className="space-y-6">
              {Array.from(textbookGroups.entries()).map(([tbTitle, tbLessons]) => {
                const tbAuthor = tbLessons[0]?.textbookAuthor;
                const chapterGroups: Map<string, StudentLesson[]> = new Map();
                for (const l of tbLessons) {
                  const ch = l.chapterTitle ?? "";
                  if (!chapterGroups.has(ch)) chapterGroups.set(ch, []);
                  chapterGroups.get(ch)!.push(l);
                }
                return (
                  <div key={tbTitle} className="bg-card/40 border border-white/10 rounded-2xl overflow-hidden">
                    <div className="px-5 py-4 border-b border-white/10 bg-card/60">
                      <div className="text-xs uppercase tracking-widest text-muted-foreground font-semibold mb-1">ԴԱՍԱԳԻՐՔ</div>
                      <div className="font-semibold text-base text-white">{tbTitle || "(Դասագիրք նշված չի)"}</div>
                      {tbAuthor && <div className="text-xs text-muted-foreground mt-0.5">Հեղինակ
                        ' {tbAuthor}</div>}
                    </div>
                    <div className="divide-y divide-white/5">
                      {Array.from(chapterGroups.entries()).map(([chTitle, chLessons]) => (
                        <div key={chTitle} className="px-5 py-4">
                          {chTitle && (
                            <div className="text-xs font-semibold text-secondary/80 uppercase tracking-wide mb-3">
                              ԹԵՄԱ · {chTitle}
                            </div>
                          )}
                          <div className="space-y-2">
                            {chLessons.map((l) => {
                              const sl = statusLabel(l);
                              const isActive = l.status === "active";
                              return (
                                <div
                                  key={l.id}
                                  className={`rounded-xl p-4 border flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-colors ${isActive ? "border-primary/30 bg-primary/5" : "border-white/8 bg-background/40"}`}
                                >
                                  <div className="flex items-start gap-3">
                                    <span className="text-xs font-mono text-primary/60 w-6 shrink-0 mt-0.5">
                                      {l.lessonNumber ?? "—"}
                                    </span>
                                    <div>
                                      <div className="font-medium text-sm">{l.title}</div>
                                      <div className="flex flex-wrap gap-2 mt-1 items-center">
                                        {l.paragraphNumber && (
                                          <span className="text-xs text-muted-foreground">§{l.paragraphNumber}</span>
                                        )}
                                        {(l.pagesFrom || l.pagesTo) && (
                                          <span className="text-xs text-muted-foreground">
                                            Էջ' {l.pagesFrom ?? "?"}–{l.pagesTo ?? "?"}
                                          </span>
                                        )}
                                        <span className={`text-xs px-2 py-0.5 rounded-full border ${sl.cls}`}>
                                          {sl.text}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                  {(isActive && l.mySessionStatus !== "completed") ? (
                                    <Link
                                      href={`/lessons/${l.id}`}
                                      className="shrink-0 flex items-center justify-center gap-1.5 px-4 py-2 bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity"
                                    >
                                      📖 Սովորել
                                    </Link>
                                  ) : l.mySessionStatus !== "completed" ? (
                                    <span className="shrink-0 text-xs text-muted-foreground/50 px-3 py-2 rounded-xl border border-white/5 select-none">
                                      Դեռ հանձնարարված չէ
                                    </span>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Progress-based lessons (original) */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-bold">Դասերի ցուցակ</h2>
          <Link
            href={`/knowledge-tree/${subjectId}`}
            className="px-4 py-2 bg-white/5 border border-white/10 rounded-xl text-sm text-secondary hover:bg-white/10 transition-colors"
          >
            Գիտելիքի քարտեզ →
          </Link>
        </div>

        <div className="space-y-3 mb-12">
          {subject.lessons && subject.lessons.length > 0 ? (
            subject.lessons.map((lesson, idx) => {
              const st = lesson.status === "completed"
                ? { text: "Ավարտված", cls: "text-teal-400" }
                : lesson.status === "pending"
                ? { text: "Ընթացքւմ", cls: "text-amber-400" }
                : { text: "Չսկսված", cls: "text-muted-foreground" };
              return (
                <div
                  key={lesson.id}
                  className="bg-card/60 border border-white/10 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 shrink-0 rounded-full bg-background/60 flex items-center justify-center text-muted-foreground font-medium border border-white/10">
                      {lesson.lessonNumber ?? idx + 1}
                    </div>
                    <div>
                      <h3 className="font-semibold text-base">{lesson.lesson}</h3>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className={`text-xs flex items-center gap-1.5 ${st.cls}`}>
                          <span className="w-1.5 h-1.5 rounded-full bg-current" />
                          {st.text}
                        </span>
                        {lesson.status === "completed" && (lesson as { score?: number }).score !== undefined && (
                          <span className="text-xs text-white/60 border-l border-white/10 pl-3">
                            {(lesson as { score?: number }).score} միավոր
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  {lesson.status === "pending" ? (
                    <Link
                      href={`/lessons/${lesson.id}`}
                      className="shrink-0 flex items-center justify-center gap-1.5 px-5 py-2.5 bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity"
                    >
                      📖 Սովորել
                    </Link>
                  ) : lesson.status !== "completed" ? (
                    <span className="shrink-0 text-xs text-muted-foreground/50 px-3 py-2 rounded-xl border border-white/5 select-none">
                      Դեռ հանձնարարված չէ
                    </span>
                  ) : null}
                </div>
              );
            })
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <div className="text-4xl mb-3">📚</div>
              <p>Դասեր չկան · ուսուցիչը կավելացնի</p>
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
