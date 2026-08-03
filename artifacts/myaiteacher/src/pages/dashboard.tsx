import { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import QuickSwitch from "@/components/QuickSwitch";
import {
  useGetDashboard,
  useGetStudentSchedule,
  useGetStudentHomeworkSummary,
  getGetDashboardQueryKey,
  getGetStudentScheduleQueryKey,
  getGetStudentHomeworkSummaryQueryKey,
} from "@workspace/api-client-react";

type Section =
  | "ai-teacher" | "home" | "tasks" | "subjects" | "homework"
  | "schedule" | "progress" | "library" | "profile" | "quizzes";

type AssignedLesson = {
  id: number; subject: string; teacherName: string; title: string;
  lessonNumber?: number | null; paragraphNumber?: string | null;
  textbookTitle?: string | null; textbookAuthor?: string | null;
  chapterTitle?: string | null; pagesFrom?: number | null;
  pagesTo?: number | null; status: string; mySessionStatus?: string | null;
  assignedAt?: string | null;
};

type AssignedQuiz = {
  assignmentId: number; quizId: number; title: string;
  subjectId: number; status: string;
  assignedAt: string; dueAt: string | null;
};

const NAV_ITEMS: { key: Section; emoji: string; label: string }[] = [
  { key: "ai-teacher", emoji: "🤖", label: "ԱԲ ուսուցիչ" },
  { key: "home",       emoji: "🏠", label: "Գլխավոր" },
  { key: "tasks",      emoji: "📝", label: "Իմ դասերը" },
  { key: "subjects",   emoji: "📚", label: "Իմ առարկաները" },
  { key: "homework",   emoji: "📋", label: "Իմ տնայինները" },
  { key: "quizzes",   emoji: "📋", label: "Իմ թեստերը" },
  { key: "schedule",   emoji: "📅", label: "Դասացուցակ" },
  { key: "progress",   emoji: "📈", label: "Իմ առաջընթացը" },
  { key: "library",    emoji: "📖", label: "Գրադարան" },
  { key: "profile",    emoji: "👤", label: "Իմ պրոֆիլը" },
];

function lessonStatusBadge(mySessionStatus: string | null | undefined): { text: string; cls: string } {
  if (mySessionStatus === "completed")
    return { text: "✅ Ավարտված", cls: "bg-teal-400/15 text-teal-400 border-teal-400/20" };
  if (mySessionStatus === "active")
    return { text: "🟢 Ընթացքի մեջ", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20" };
  return { text: "🟡 Սպասում է", cls: "bg-amber-400/15 text-amber-400 border-amber-400/20" };
}

export default function Dashboard() {
  const { user, token, logout, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [section, setSection] = useState<Section>("home");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [allLessons, setAllLessons] = useState<AssignedLesson[] | undefined>(undefined);
  const [assignedQuizzes, setAssignedQuizzes] = useState<AssignedQuiz[] | undefined>(undefined);
  const sidebarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!authLoading && !token) setLocation("/login");
  }, [token, authLoading, setLocation]);

  useEffect(() => {
    if (authLoading || !user) return;
    if (user.role === "admin") setLocation("/admin");
    else if (user.role === "teacher") setLocation("/teacher");
  }, [user, authLoading, setLocation]);

  const { data: dashboard, isLoading: dashLoading } = useGetDashboard({
    query: { queryKey: getGetDashboardQueryKey(), enabled: !!token },
  });
  const { data: schedule = [], isSuccess: scheduleLoaded } = useGetStudentSchedule({
    query: { queryKey: getGetStudentScheduleQueryKey(), enabled: !!token },
  });
  const { data: hwSummary } = useGetStudentHomeworkSummary({
    query: { queryKey: getGetStudentHomeworkSummaryQueryKey(), enabled: !!token },
  });

  useEffect(() => {
    if (!token || !dashboard) return;
    // Derive subjects from enrolled dashboard.subjects — NOT from the weekly
    // schedule — so lessons show up even when the schedule is empty.
    const subjects = (dashboard.subjects ?? []).map((s) => s.subject);
    if (subjects.length === 0) {
      setAllLessons([]);
      return;
    }
    let cancelled = false;
    Promise.all(
      subjects.map((subject) =>
        fetch(`/api/student/course-lessons?subject=${encodeURIComponent(subject)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
          .then((r) => (r.ok ? r.json() : []))
          .then((lessons: any[]) => {
            const entry = schedule.find(
              (s) => s.subject.toLowerCase() === subject.toLowerCase()
            );
            return lessons.map((l) => ({ ...l, subject, teacherName: entry?.teacherName ?? "" }));
          })
          .catch(() => [])
      )
    ).then((results) => {
      if (!cancelled) {
        const order: Record<string, number> = { active: 0, assigned: 1, completed: 2 };
        setAllLessons(
          results.flat().sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [token, dashboard]);


  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch("/api/quizzes/assigned", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((data: AssignedQuiz[]) => { if (!cancelled) setAssignedQuizzes(data); })
      .catch(() => { if (!cancelled) setAssignedQuizzes([]); });
    return () => { cancelled = true; };
  }, [token, section]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (sidebarOpen && sidebarRef.current && !sidebarRef.current.contains(e.target as Node))
        setSidebarOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [sidebarOpen]);

  if (authLoading || dashLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!user || user.role !== "student") return null;

  const subjects  = dashboard?.subjects ?? [];
  const stats     = dashboard?.stats ?? { completedLessons: 0, averageScore: 0, pendingHomework: 0 };
  const hwItems   = ((hwSummary as any)?.items ?? []) as any[];
  const hwTodo    = hwItems.filter((h) => h.status === "not_submitted");
  const hwInProg  = hwItems.filter((h) => h.status === "pending");
  const hwDone    = hwItems.filter((h) => h.status === "graded");

  const className  = (schedule as any[])[0]?.className ?? "";
  const todayDate  = new Date().toLocaleDateString("hy-AM", { day: "numeric", month: "long", year: "numeric" });
  const todayArm   = new Date().toLocaleDateString("hy-AM", { weekday: "long" });
  const todayItems = [...schedule]
    .filter((s) => s.day.toLowerCase().replace(/\./g, "") === todayArm.toLowerCase().replace(/\./g, ""))
    .sort((a, b) => a.time.localeCompare(b.time));

  const assignedLessons = (allLessons ?? []).filter((l) => l.mySessionStatus !== "completed");
  const todaySubjects   = new Set(todayItems.map((s) => s.subject.toLowerCase()));
  const completedToday  = (allLessons ?? []).filter(
    (l) =>
      l.mySessionStatus === "completed" &&
      (todaySubjects.size === 0 || todaySubjects.has(l.subject.toLowerCase()))
  ).length;
  const totalToday = (allLessons ?? []).filter(
    (l) => todaySubjects.size === 0 || todaySubjects.has(l.subject.toLowerCase())
  ).length;
  const allDoneToday =
    allLessons !== undefined && assignedLessons.length === 0 && allLessons.length > 0;
  const activeLesson = allLessons?.find((l) => l.status === "active") ?? null;

  /* ── NAV BUTTON ── */
  const NavBtn = ({ item }: { item: (typeof NAV_ITEMS)[0] }) => (
    <button
      onClick={() => {
        setSection(item.key);
        setSidebarOpen(false);
      }}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all text-left ${
        section === item.key
          ? "bg-primary/20 text-primary border border-primary/20"
          : "text-muted-foreground hover:text-white hover:bg-white/5"
      }`}
    >
      <span className="text-lg leading-none shrink-0">{item.emoji}</span>
      <span>{item.label}</span>
    </button>
  );

  /* ── AI TEACHER ── */
  const SectionAI = () => (
    <div>
      <h2 className="text-lg font-bold mb-6">🤖 ԱԲ ուսուցիչ</h2>
      {assignedLessons.length === 0 && hwTodo.length === 0 ? (
        <div className="flex flex-col items-center justify-center min-h-[50vh] text-center gap-6 py-16">
          <div className="text-7xl">🤖</div>
          <p className="text-muted-foreground max-w-xs leading-relaxed text-sm">Այս պահին հանձնարարված դաս չկա։</p>
        </div>
      ) : (
        <div className="space-y-6">
          {assignedLessons.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-3">Իմ դասերը</h3>
              <div className="space-y-3">
                {assignedLessons.map((lesson) => (
                  <div
                    key={`ai-${lesson.subject}-${lesson.id}`}
                    className="rounded-2xl border border-white/10 bg-card/60 p-4 flex items-center gap-4"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-muted-foreground mb-0.5">
                        {lesson.subject} · {lesson.teacherName}
                      </div>
                      <div className="font-medium text-sm truncate">{lesson.title}</div>
                    </div>
                    <Link
                      href={`/lessons/${lesson.id}`}
                      className="shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-xs font-bold hover:opacity-90 transition-all whitespace-nowrap"
                    >
                      {lesson.mySessionStatus === "active" ? "ՇԱՐՈՒՆԱԿԵԼ" : "ՍԿՍԵԼ"}
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          )}
          {hwTodo.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-3">Իմ տնայինները</h3>
              <div className="space-y-3">
                {hwTodo.map((hw: any) => (
                  <div
                    key={`ai-hw-${hw.id}`}
                    className="rounded-2xl border border-white/10 bg-card/60 p-4 flex items-center gap-4"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-muted-foreground mb-0.5">
                        {hw.subject ?? hw.lessonTitle}
                      </div>
                      <div className="font-medium text-sm truncate">{hw.title}</div>
                    </div>
                    <Link
                      href={`/chat/${hw.lessonId}?hw=${hw.id}`}
                      className="shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-400/15 text-amber-400 text-xs font-bold hover:bg-amber-400/25 transition-all border border-amber-400/20 whitespace-nowrap"
                    >
                      ՍԿՍԵԼ
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  /* ── HOME ── */
  const SectionHome = () => (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold mb-1.5">
          Բարի գալուստ, {user.fullName} 👋
        </h1>
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          {className && (
            <>
              <span className="px-2.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 text-xs font-medium">
                Դասարան՝ {className}
              </span>
              <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />
            </>
          )}
          <span>{todayDate}</span>
        </div>
      </div>

      {/* Today summary */}
      <div
        className={`rounded-2xl border p-4 flex items-center gap-4 ${
          allDoneToday ? "border-teal-400/30 bg-teal-400/5" : "border-white/10 bg-card/40"
        }`}
      >
        {allDoneToday ? (
          <p className="text-sm font-medium">🎉 🎉 Այսօրվա անելիքներն ավարտված են։</p>
        ) : allLessons === undefined ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <span>...</span>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Այսօր՝</span>
            <span className="text-lg font-bold text-primary">{completedToday}</span>
            <span className="text-muted-foreground">/</span>
            <span className="text-lg font-bold">{totalToday}</span>
            <span className="text-sm text-muted-foreground">✅ Ավարտված</span>
          </div>
        )}
      </div>

      {/* Active lesson hero */}
      <div>
        <h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-4">
          📝 Իմ դասերը
        </h2>
        {allLessons === undefined ? (
          <div className="rounded-2xl border border-white/10 bg-card/40 p-8 flex items-center justify-center gap-3 text-muted-foreground text-sm">
            <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : activeLesson ? (
          <div className="rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-background/60 to-secondary/5 p-6 sm:p-8">
            <div className="flex flex-col sm:flex-row sm:items-center gap-6">
              <div className="flex-1 space-y-3 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-primary/20 text-primary border border-primary/20">
                    {activeLesson.subject}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    👨‍🏫 {activeLesson.teacherName}
                  </span>
                </div>
                <h3 className="text-xl font-bold leading-snug">{activeLesson.title}</h3>
                <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                  {activeLesson.chapterTitle && <span>📂 {activeLesson.chapterTitle}</span>}
                  {activeLesson.paragraphNumber && <span>§{activeLesson.paragraphNumber}</span>}
                  {(activeLesson.pagesFrom || activeLesson.pagesTo) && (
                    <span>
                      Էջեր {activeLesson.pagesFrom ?? "?"}–{activeLesson.pagesTo ?? "?"}
                    </span>
                  )}
                </div>
              </div>
              <Link
                href={`/lessons/${activeLesson.id}`}
                className="flex items-center justify-center gap-2 px-8 py-4 rounded-2xl bg-gradient-to-r from-primary to-secondary text-white font-bold text-base hover:opacity-90 active:scale-[0.98] transition-all shadow-xl shadow-primary/25 whitespace-nowrap shrink-0"
              >
                ▶ ՍԿՍԵԼ ԴԱՍԸ
              </Link>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-white/10 bg-card/40 p-8 text-center text-muted-foreground">
            <div className="text-4xl mb-3">📭</div>
            <p className="text-sm">Այս պահին հանձնարարված դաս չկա։</p>
          </div>
        )}
      </div>


      {/* Assigned quizzes */}
      {(assignedQuizzes ?? []).filter((q) => q.status !== "COMPLETED").length > 0 && (
        <div>
          <h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-4">
            📋 թեստերը
          </h2>
          <div className="space-y-3">
            {(assignedQuizzes ?? [])
              .filter((q) => q.status !== "COMPLETED")
              .map((qz) => (
                <div
                  key={qz.assignmentId}
                  className="rounded-2xl border border-primary/20 bg-card/60 p-5 flex flex-col sm:flex-row sm:items-center gap-5 hover:border-white/20 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-base leading-snug">{qz.title}</h3>
                  </div>
                  <Link
                    href={`/quiz/${qz.quizId}/take`}
                    className="flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-gradient-to-r from-primary to-secondary text-white font-bold text-sm hover:opacity-90 active:scale-[0.98] transition-all shadow-lg shadow-primary/20 whitespace-nowrap shrink-0"
                  >
                    ▶ ՍԿՍԵԼ ԹԵՍՏԵՐ
                  </Link>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Stats */}
      <div>
        <h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-4">
          📊 Իմ առաջընթացը
        </h2>
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-2xl border border-white/10 bg-card/60 p-4 text-center">
            <div className="text-2xl font-bold text-primary mb-1">{stats.completedLessons}</div>
            <div className="text-xs text-muted-foreground leading-tight">Ավարտված դասեր</div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-card/60 p-4 text-center">
            <div className="text-2xl font-bold text-teal-400 mb-1">
              {stats.averageScore > 0 ? stats.averageScore : "—"}
            </div>
            <div className="text-xs text-muted-foreground leading-tight">Միջին արդյունք</div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-card/60 p-4 text-center">
            <div className="text-2xl font-bold text-amber-400 mb-1">
              {hwTodo.length + hwInProg.length}
            </div>
            <div className="text-xs text-muted-foreground leading-tight">Իմ տնայինները</div>
          </div>
        </div>
      </div>
    </div>
  );

  /* ── TASKS ── */
  const SectionTasks = () => (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-bold">📝 Իմ դասերը</h2>
        <span className="text-xs text-muted-foreground bg-white/5 px-2.5 py-1 rounded-full">
          {assignedLessons.length}
        </span>
      </div>

      {allLessons === undefined ? (
        <div className="flex items-center justify-center py-24 gap-3 text-muted-foreground">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : assignedLessons.length === 0 ? (
        <div className="text-center py-24 text-muted-foreground">
          <div className="text-5xl mb-4">📭</div>
          <p>Այս պահին հանձնարարված դաս չկա։</p>
        </div>
      ) : (
        <div className="space-y-4">
          {assignedLessons.map((lesson) => {
            const badge = lessonStatusBadge(lesson.mySessionStatus);
            return (
              <div
                key={`${lesson.subject}-${lesson.id}`}
                className="rounded-2xl border border-white/10 bg-card/60 p-5 flex flex-col sm:flex-row sm:items-center gap-5 hover:border-white/20 transition-colors"
              >
                <div className="flex-1 min-w-0 space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/15">
                      {lesson.subject}
                    </span>
                    <span className={`text-xs px-2.5 py-0.5 rounded-full border ${badge.cls}`}>
                      {badge.text}
                    </span>
                    <span className="text-xs text-muted-foreground bg-white/5 px-2 py-0.5 rounded-full">
                      🏫 Դասարանում
                    </span>
                  </div>
                  <h3 className="font-semibold text-base leading-snug">{lesson.title}</h3>
                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
                    <span>👨‍🏫 {lesson.teacherName}</span>
                    {lesson.chapterTitle && <span>📂 {lesson.chapterTitle}</span>}
                    {lesson.paragraphNumber && <span>§{lesson.paragraphNumber}</span>}
                    {(lesson.pagesFrom || lesson.pagesTo) && (
                      <span>Էջեր {lesson.pagesFrom ?? "?"}–{lesson.pagesTo ?? "?"}</span>
                    )}
                  </div>
                </div>
                <Link
                  href={`/lessons/${lesson.id}`}
                  className="flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-gradient-to-r from-primary to-secondary text-white font-bold text-sm hover:opacity-90 active:scale-[0.98] transition-all shadow-lg shadow-primary/20 whitespace-nowrap shrink-0"
                >
                  ▶ ՍԿՍԵԼ ԴԱՍԸ
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  /* ── SUBJECTS ── */
  const SectionSubjects = () => (
    <div>
      <h2 className="text-lg font-bold mb-6">📚 Իմ առարկաները</h2>
      {subjects.length === 0 ? (
        <div className="text-center py-24 text-muted-foreground">
          <div className="text-5xl mb-4">📚</div>
          <p>Առաջընթացի տվյալ դեռ չկա։</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {subjects.map((sub) => {
            const entry = schedule.find(
              (sc) => sc.subject.toLowerCase() === sub.subject.toLowerCase()
            );
            const pct   = Math.round(sub.progressPercent ?? 0);
            const done  = sub.completedLessons ?? 0;
            const total = sub.totalLessons ?? 0;
            return (
              <div
                key={sub.id}
                className="rounded-2xl border border-white/10 bg-card/60 p-6 flex flex-col gap-4 hover:border-white/20 transition-colors"
              >
                <div>
                  <h3 className="font-semibold text-base mb-1">{sub.subject}</h3>
                  {entry?.teacherName && (
                    <div className="text-xs text-muted-foreground">👨‍🏫 {entry.teacherName}</div>
                  )}
                </div>
                <div className="text-sm text-muted-foreground space-y-1">
                  <div>Ավարտված դասեր՝ {done} / {total}</div>
                  {total > 0 ? (
                    <div>Առաջընթաց՝ {pct}%</div>
                  ) : (
                    <div className="text-xs italic">Առաջընթացի տվյալ դեռ չկա։</div>
                  )}
                </div>
                {total > 0 && (
                  <div className="h-1.5 w-full bg-background rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-primary to-secondary"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
                <Link
                  href={`/subjects/${sub.id}`}
                  className="mt-auto flex items-center justify-center px-4 py-2.5 rounded-xl bg-primary/15 text-white text-sm font-medium hover:bg-primary/25 transition-all border border-white/10"
                >
                  ԲԱՑԵԼ
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  /* ── HOMEWORK ── */
  const SectionHomework = () => {
    const HwCard = ({ hw }: { hw: any }) => (
      <div className="rounded-2xl border border-white/10 bg-card/60 p-5 flex flex-col sm:flex-row sm:items-center gap-5 hover:border-white/20 transition-colors">
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {hw.subject && (
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/15">
                {hw.subject}
              </span>
            )}
          </div>
          <h3 className="font-semibold text-sm leading-snug">{hw.title}</h3>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {hw.teacherName && <span>👨‍🏫 {hw.teacherName}</span>}
            {hw.lessonTitle && <span>📖 {hw.lessonTitle}</span>}
          </div>
          {hw.task && (
            <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">{hw.task}</p>
          )}
        </div>
        {hw.status !== "graded" && (
          <Link
            href={`/chat/${hw.lessonId}?hw=${hw.id}`}
            className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-gradient-to-r from-primary to-secondary text-white font-bold text-xs hover:opacity-90 transition-all shadow-lg shadow-primary/20 whitespace-nowrap shrink-0"
          >
            ▶ ԿԱՏԱՐԵԼ ՏՆԱՅԻՆԸ
          </Link>
        )}
      </div>
    );
    return (
      <div>
        <h2 className="text-lg font-bold mb-6">📋 Իմ տնայինները</h2>
        {hwItems.length === 0 ? (
          <div className="text-center py-24 text-muted-foreground">
            <div className="text-5xl mb-4">✅</div>
            <p>Հաստատված տնային հանձնարարություն չկա։</p>
          </div>
        ) : (
          <div className="space-y-8">
            {hwTodo.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-4 flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
                  Պետք է կատարել
                </h3>
                <div className="space-y-3">
                  {hwTodo.map((hw: any) => <HwCard key={hw.id} hw={hw} />)}
                </div>
              </div>
            )}
            {hwInProg.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-4 flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
                  Ընթացքի մեջ
                </h3>
                <div className="space-y-3">
                  {hwInProg.map((hw: any) => <HwCard key={hw.id} hw={hw} />)}
                </div>
              </div>
            )}
            {hwDone.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-4 flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-teal-400" />
                  Ավարտված
                </h3>
                <div className="space-y-3">
                  {hwDone.map((hw: any) => <HwCard key={hw.id} hw={hw} />)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  /* ── SCHEDULE ── */
  const SectionSchedule = () => (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-bold">📅 Դասացուցակ</h2>
        <span className="text-xs text-muted-foreground">{todayDate}</span>
      </div>
      {todayItems.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <div className="text-4xl mb-3">📅</div>
          <p className="text-sm">Այսօրվա դասացուցակ չկա։</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-white/10 bg-card/60 overflow-hidden divide-y divide-white/8">
          {todayItems.map((sc, i) => {
            const sub = subjects.find(
              (x) => x.subject.toLowerCase() === sc.subject.toLowerCase()
            );
            return (
              <div
                key={sc.id}
                className="flex items-center gap-4 px-5 py-4 hover:bg-white/5 transition-colors"
              >
                <span className="text-xs text-muted-foreground w-5 shrink-0 text-center">{i + 1}</span>
                <span className="text-primary font-mono font-bold w-14 shrink-0">{sc.time}</span>
                <span className="flex-1 font-medium">{sc.subject}</span>
                <span className="text-xs text-muted-foreground hidden sm:block">👨‍🏫 {sc.teacherName}</span>
                {sub && (
                  <Link
                    href={`/subjects/${sub.id}`}
                    className="text-primary text-sm ml-2 shrink-0 hover:underline"
                  >
                    →
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  /* ── PROGRESS ── */
  const SectionProgress = () => (
    <div>
      <h2 className="text-lg font-bold mb-6">📈 Իմ առաջընթացը</h2>
      <div className="grid sm:grid-cols-2 gap-4 mb-8">
        <div className="rounded-2xl border border-white/10 bg-card/60 p-6">
          <div className="text-4xl font-bold text-primary mb-2">
            {stats.completedLessons || (
              <span className="text-muted-foreground text-2xl">Տվյալ դեռ չկա</span>
            )}
          </div>
          <div className="text-sm text-muted-foreground">Ավարտված դասեր</div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-card/60 p-6">
          <div className="text-4xl font-bold text-teal-400 mb-2">
            {hwDone.length || <span className="text-muted-foreground text-2xl">Տվյալ դեռ չկա</span>}
          </div>
          <div className="text-sm text-muted-foreground">Ստուգված աշխատանքներ</div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-card/60 p-6">
          <div className="text-4xl font-bold text-amber-400 mb-2">
            {stats.averageScore > 0 ? (
              stats.averageScore
            ) : (
              <span className="text-muted-foreground text-2xl">Տվյալ դեռ չկա</span>
            )}
          </div>
          <div className="text-sm text-muted-foreground">Միջին արդյունք</div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-card/60 p-6">
          <div className="text-4xl font-bold mb-2">
            <span className="text-muted-foreground text-2xl">Տվյալ դեռ չկա</span>
          </div>
          <div className="text-sm text-muted-foreground">ԱԲ-ի հետ սովորելու ժամանակ</div>
        </div>
      </div>
      {subjects.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4">Իմ առարկաները</h3>
          <div className="space-y-4">
            {subjects.map((sub) => {
              const pct = Math.round(sub.progressPercent ?? 0);
              return (
                <div key={sub.id} className="flex items-center gap-4">
                  <span className="w-36 text-sm truncate shrink-0">{sub.subject}</span>
                  <div className="flex-1 h-2 bg-background rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-primary to-secondary"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-sm font-bold w-10 text-right shrink-0">
                    {pct > 0 ? `${pct}%` : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );

  /* ── LIBRARY ── */
  const SectionLibrary = () => (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center gap-6 py-16">
      <div className="text-8xl">📖</div>
      <h2 className="text-2xl font-bold">Գրադարան</h2>
      <p className="text-muted-foreground max-w-xs leading-relaxed">Նյութերի գրադարանը հասանելի կլինի շուտով։</p>
      <span className="text-sm text-primary bg-primary/10 border border-primary/20 px-5 py-2 rounded-full">
        ՇՈՒՏՈՎ
      </span>
    </div>
  );

  /* ── PROFILE ── */
  const SectionProfile = () => (
    <div className="max-w-xl">
      <h2 className="text-lg font-bold mb-6">👤 Իմ պրոֆիլը</h2>
      <div className="bg-card/60 border border-white/10 rounded-2xl p-5 space-y-3 text-sm">
        <div className="flex gap-2">
          <span className="text-muted-foreground w-32 shrink-0">Օգտանուն:</span>
          <span className="font-medium">{user.username}</span>
        </div>
        <div className="flex gap-2">
          <span className="text-muted-foreground w-32 shrink-0">Անուն Ազգանուն:</span>
          <span className="font-medium">{user.fullName}</span>
        </div>
        {className && (
          <div className="flex gap-2">
            <span className="text-muted-foreground w-32 shrink-0">Դասարան՝</span>
            <span className="font-medium">{className}</span>
          </div>
        )}
        {(user as any).createdAt && (
          <div className="flex gap-2">
            <span className="text-muted-foreground w-32 shrink-0">Ands.:</span>
            <span className="font-medium">
              {new Date((user as any).createdAt).toLocaleDateString("hy-AM", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </span>
          </div>
        )}
      </div>
    </div>
  );

  /* ── QUIZZES ── */
  const SectionQuizzes = () => {
    const QUIZ_STATUS_LABEL: Record<string, string> = {
      ASSIGNED:    "Ուղարկված",
      IN_PROGRESS: "Ուղարկված",
      COMPLETED:   "✅",
    };
    const QUIZ_STATUS_CLS: Record<string, string> = {
      ASSIGNED:    "bg-primary/15 text-primary border-primary/15",
      IN_PROGRESS: "bg-amber-400/15 text-amber-400 border-amber-400/20",
      COMPLETED:   "bg-teal-400/15 text-teal-400 border-teal-400/20",
    };
    const quizzes = assignedQuizzes ?? [];
    const pending   = quizzes.filter((q) => q.status !== "COMPLETED");
    const completed = quizzes.filter((q) => q.status === "COMPLETED");
    return (
      <div>
        <h2 className="text-lg font-bold mb-6">📋 Իմ թեստերը</h2>
        {assignedQuizzes === undefined ? (
          <div className="flex items-center justify-center py-24 gap-3 text-muted-foreground">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : quizzes.length === 0 ? (
          <div className="text-center py-24 text-muted-foreground">
            <div className="text-5xl mb-4">📋</div>
            <p>Հանձնարարված չկա</p>
          </div>
        ) : (
          <div className="space-y-6">
            {pending.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-4 flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-primary" />
                  Кataрel
                </h3>
                <div className="space-y-3">
                  {pending.map((qz) => (
                    <div
                      key={qz.assignmentId}
                      className="rounded-2xl border border-white/10 bg-card/60 p-5 flex flex-col sm:flex-row sm:items-center gap-5 hover:border-white/20 transition-colors"
                    >
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`text-xs px-2.5 py-0.5 rounded-full border ${QUIZ_STATUS_CLS[qz.status] ?? QUIZ_STATUS_CLS.ASSIGNED}`}>
                            {QUIZ_STATUS_LABEL[qz.status] ?? qz.status}
                          </span>
                        </div>
                        <h3 className="font-semibold text-base leading-snug">{qz.title}</h3>
                        <div className="text-xs text-muted-foreground">
                          {new Date(qz.assignedAt).toLocaleDateString("hy-AM", { day: "numeric", month: "long" })}
                        </div>
                      </div>
                      <Link
                        href={`/quiz/${qz.quizId}/take`}
                        className="flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-gradient-to-r from-primary to-secondary text-white font-bold text-sm hover:opacity-90 active:scale-[0.98] transition-all shadow-lg shadow-primary/20 whitespace-nowrap shrink-0"
                      >
                        ▶ ՍԿՍԵԼ ԹԵՍՏԵՐ
                      </Link>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {completed.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-4 flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-teal-400" />
                  Авартред
                </h3>
                <div className="space-y-3">
                  {completed.map((qz) => (
                    <div
                      key={qz.assignmentId}
                      className="rounded-2xl border border-teal-400/20 bg-teal-400/5 p-5 flex flex-col sm:flex-row sm:items-center gap-4 opacity-80"
                    >
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-sm">{qz.title}</h3>
                      </div>
                      <span className="text-xs text-teal-400 font-semibold shrink-0">✅</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };


  const SECTIONS = {
    "ai-teacher": SectionAI,
    home:         SectionHome,
    tasks:        SectionTasks,
    subjects:     SectionSubjects,
    homework:     SectionHomework,
    schedule:     SectionSchedule,
    progress:     SectionProgress,
    library:      SectionLibrary,
    profile:      SectionProfile,
    quizzes:      SectionQuizzes,
  };
  const ActiveSection = SECTIONS[section] ?? SectionHome;

  return (
    <div className="min-h-[100dvh] bg-background text-white flex">
      <QuickSwitch />

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        ref={sidebarRef}
        className={`fixed top-0 left-0 h-full z-50 w-60 bg-card/95 backdrop-blur-xl border-r border-white/10 flex flex-col transition-transform duration-200 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        } lg:translate-x-0 lg:static lg:z-auto`}
      >
        <div className="px-5 py-5 border-b border-white/10">
          <div className="font-bold text-base bg-clip-text text-transparent bg-gradient-to-r from-primary to-secondary">
            myaiteacher
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 truncate">{user.fullName}</div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => (
            <NavBtn key={item.key} item={item} />
          ))}
        </nav>
        <div className="px-3 py-4 border-t border-white/10">
          <button
            onClick={logout}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm text-muted-foreground hover:text-white hover:bg-white/5 transition-all text-left"
          >
            <span className="text-lg">🚪</span>
            <span>Ելք</span>
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="lg:hidden border-b border-white/10 bg-card/50 backdrop-blur-lg sticky top-0 z-30">
          <div className="px-4 py-3.5 flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
              aria-label="Menu"
            >
              <div className="space-y-1.5 w-5">
                <span className="block w-full h-0.5 bg-white rounded" />
                <span className="block w-full h-0.5 bg-white rounded" />
                <span className="block w-full h-0.5 bg-white rounded" />
              </div>
            </button>
            <div className="font-bold text-sm bg-clip-text text-transparent bg-gradient-to-r from-primary to-secondary">
              myaiteacher
            </div>
            <div className="ml-auto text-xs text-muted-foreground truncate max-w-[120px]">
              {user.fullName}
            </div>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto px-5 sm:px-8 py-8">
            <ActiveSection />
          </div>
        </main>
      </div>
    </div>
  );
}
