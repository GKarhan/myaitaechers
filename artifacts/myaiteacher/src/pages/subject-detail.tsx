import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "wouter";
import { useAuth } from "@/lib/auth";
import StudentLayout from "@/components/StudentLayout";
import StudentLessonCard from "@/components/StudentLessonCard";
import StudentQuizCard, { type StudentQuizCardQuiz } from "@/components/StudentQuizCard";
import {
  useGetSubjectDetail,
  getGetSubjectDetailQueryKey,
  useGetStudentCourseLessons,
  getGetStudentCourseLessonsQueryKey,
  useGetStudentSchedule,
  getGetStudentScheduleQueryKey,
} from "@workspace/api-client-react";

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

type AssignedQuiz = {
  assignmentId: number;
  quizId: number;
  title: string;
  subjectId: number;
  status: string;
  assignedAt: string;
  dueAt: string | null;
  totalCorrect?: number | null;
  totalQuestions?: number | null;
  scorePercent?: number | null;
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

  // Student's real class name from schedule
  const { data: schedule = [] } = useGetStudentSchedule({
    query: {
      queryKey: getGetStudentScheduleQueryKey(),
      enabled: !!token,
    },
  });
  const className = (schedule as any[])[0]?.className ?? "";

  // Teacher-created lessons for this subject
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

  // Assigned quizzes — include token in queryKey so it refetches after auth loads
  const { data: assignedQuizzes = [] } = useQuery<AssignedQuiz[]>({
    queryKey: ["quizzes", "assigned", token],
    queryFn: async () => {
      const r = await fetch("/api/quizzes/assigned", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!token,
  });

  // Show the most relevant quiz for this subject:
  // prefer pending (ASSIGNED / IN_PROGRESS) → fall back to latest COMPLETED
  const pendingQuiz = (assignedQuizzes as AssignedQuiz[]).find(
    (q) => q.subjectId === subjectId && q.status !== "COMPLETED"
  ) ?? null;
  const completedQuiz = (assignedQuizzes as AssignedQuiz[]).find(
    (q) => q.subjectId === subjectId && q.status === "COMPLETED"
  ) ?? null;
  const displayQuiz = pendingQuiz ?? completedQuiz;

  // ── Quiz creation state (teacher-only) ─────────────────────────────────────
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
    fetch(`/api/books`, { headers: { Authorization: `Bearer ${token}` } })
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
      const resp = await fetch(`/api/quizzes`, {
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

  function toggleLesson(lessonId: number) {
    setQuizLessonIds((prev) =>
      prev.includes(lessonId) ? prev.filter((x) => x !== lessonId) : [...prev, lessonId]
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
  const total     = subject.totalLessons ?? 0;

  const activeLesson = (teacherLessons as StudentLesson[]).find((l) => l.status === "active");

  const sortedLessons = [...(teacherLessons as StudentLesson[])].sort((a, b) => {
    const ta = (a.textbookTitle ?? "").localeCompare(b.textbookTitle ?? "", "hy");
    if (ta !== 0) return ta;
    const ca = (a.chapterTitle ?? "").localeCompare(b.chapterTitle ?? "", "hy");
    if (ca !== 0) return ca;
    const la = (a.lessonNumber ?? 9999) - (b.lessonNumber ?? 9999);
    if (la !== 0) return la;
    return (a.paragraphNumber ?? "").localeCompare(b.paragraphNumber ?? "");
  });

  return (
    <StudentLayout>
      {/* Subject header */}
      <div className="mb-10">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <h1 className="text-3xl font-bold">{subject.name}</h1>
          {className && (
            <span className="px-3 py-1 bg-card border border-white/10 rounded-full text-sm text-secondary">
              {className}
            </span>
          )}
          {isTeacher && (
            <button
              onClick={() => { setQuizModalOpen(true); setQuizError(null); }}
              className="ml-auto flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold hover:opacity-90 transition-opacity shadow-lg shadow-primary/20"
            >
              ✦ Sts'el test
            </button>
          )}
        </div>
        {subject.description && (
          <p className="text-muted-foreground mb-3">{subject.description}</p>
        )}
          <Link
            href={`/knowledge-tree/${subjectId}`}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-white/5 border border-white/10 rounded-xl text-sm text-secondary hover:bg-white/10 transition-colors"
          >
            🌳 Գիտելիքի ծառ →
          </Link>
        </div>

      {/* ── ԱՅՍՕՐՎԱ ԴԱՍԸ ── */}
      {activeLesson && (
        <div className="mb-12">
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            ԱՅՍՕՐՎԱ ԴԱՍԸ
          </h2>
          <StudentLessonCard lesson={{
            ...activeLesson,
            subject: subjectName,
          }} showSubject={false} />
        </div>
      )}

      {/* ── ԸՆԹԱՑԻԿ ԹԵՍՏԸ ── */}
      <div className="mb-12">
        <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-secondary" />
          ԸՆԹԱՑԻԿ ԹԵՍՏԸ
        </h2>
        {displayQuiz ? (
          <StudentQuizCard quiz={displayQuiz as StudentQuizCardQuiz} />
        ) : (
          <div className="rounded-2xl border border-white/10 bg-card/30 p-6 text-center">
            <div className="text-2xl mb-2 text-muted-foreground">📋</div>
            <p className="text-sm text-muted-foreground">Ընթացիկ թեստ չկա</p>
          </div>
        )}
      </div>

      {/* Book section */}
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

      {/* ── Create Quiz Modal ── */}
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
    </StudentLayout>
  );
}
