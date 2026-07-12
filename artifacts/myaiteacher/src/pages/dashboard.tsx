import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import QuickSwitch from "@/components/QuickSwitch";
import {
  useGetDashboard,
  useGetStudentSchedule,
  useGetStudentTeachers,
  useGetStudentHomeworkSummary,
  getGetDashboardQueryKey,
  getGetStudentScheduleQueryKey,
  getGetStudentTeachersQueryKey,
  getGetStudentHomeworkSummaryQueryKey,
} from "@workspace/api-client-react";

type ActiveLesson = {
  id: number;
  subject: string;
  teacherName: string;
  title: string;
  lessonNumber?: number | null;
  paragraphNumber?: string | null;
  textbookTitle?: string | null;
  chapterTitle?: string | null;
  pagesFrom?: number | null;
  pagesTo?: number | null;
};

type ProfileForm = { fullName: string; email: string; age: string; bio: string };

const DAY_ORDER: Record<string, number> = {
  "Երկuшabbti": 0,
  "Erekshabbti": 1,
  "Choreqshabbti": 2,
  "Hingshabbti": 3,
  "Urbat": 4,
  "Shabbat": 5,
};

export default function Dashboard() {
  const { user, token, logout, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [showProfile, setShowProfile] = useState(false);
  const [profileForm, setProfileForm] = useState<ProfileForm>({
    fullName: "", email: "", age: "", bio: "",
  });
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [activeLesson, setActiveLesson] = useState<ActiveLesson | null | undefined>(undefined);

  useEffect(() => {
    if (!authLoading && !token) setLocation("/login");
  }, [token, authLoading, setLocation]);

  const { data: dashboard, isLoading: dashLoading } = useGetDashboard({
    query: { queryKey: getGetDashboardQueryKey(), enabled: !!token },
  });
  const { data: schedule = [] } = useGetStudentSchedule({
    query: { queryKey: getGetStudentScheduleQueryKey(), enabled: !!token },
  });
  const { data: teachers = [] } = useGetStudentTeachers({
    query: { queryKey: getGetStudentTeachersQueryKey(), enabled: !!token },
  });
  const { data: hwSummary } = useGetStudentHomeworkSummary({
    query: { queryKey: getGetStudentHomeworkSummaryQueryKey(), enabled: !!token },
  });

  useEffect(() => {
    if (authLoading || !user) return;
    if (user.role === "admin") setLocation("/admin");
    else if (user.role === "teacher") setLocation("/teacher");
  }, [user, authLoading, setLocation]);

  // Sequentially search all enrolled subjects for an active teacher lesson
  useEffect(() => {
    if (!token || schedule.length === 0) return;
    const uniqueSubjects = [...new Set(schedule.map((s) => s.subject))];
    let cancelled = false;
    const tryNext = async (i: number) => {
      if (cancelled || i >= uniqueSubjects.length) {
        if (!cancelled) setActiveLesson(null);
        return;
      }
      try {
        const res = await fetch(
          `/api/student/course-lessons?subject=${encodeURIComponent(uniqueSubjects[i])}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) { tryNext(i + 1); return; }
        const lessons: any[] = await res.json();
        const active = lessons.find((l) => l.status === "active");
        if (active && !cancelled) {
          const entry = schedule.find(
            (s) => s.subject.toLowerCase() === uniqueSubjects[i].toLowerCase()
          );
          setActiveLesson({
            id: active.id,
            subject: uniqueSubjects[i],
            teacherName: entry?.teacherName ?? (teachers[0] as any)?.teacherName ?? "",
            title: active.title,
            lessonNumber: active.lessonNumber,
            paragraphNumber: active.paragraphNumber,
            textbookTitle: active.textbookTitle,
            chapterTitle: active.chapterTitle,
            pagesFrom: active.pagesFrom,
            pagesTo: active.pagesTo,
          });
        } else {
          tryNext(i + 1);
        }
      } catch {
        tryNext(i + 1);
      }
    };
    tryNext(0);
    return () => { cancelled = true; };
  }, [token, schedule, teachers]);

  if (authLoading || dashLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!user || user.role !== "student") return null;

  const todayArm = new Date().toLocaleDateString("hy-AM", { weekday: "long" });
  const todayDate = new Date().toLocaleDateString("hy-AM", {
    day: "numeric", month: "long", year: "numeric",
  });
  const todayItems = [...schedule]
    .filter(
      (s) =>
        s.day.toLowerCase().replace(/\./g, "") ===
        todayArm.toLowerCase().replace(/\./g, "")
    )
    .sort((a, b) => a.time.localeCompare(b.time));

  const subjects = dashboard?.subjects ?? [];
  const stats = dashboard?.stats ?? {
    completedLessons: 0, averageScore: 0, pendingHomework: 0, overallProgress: 0,
  };

  const hwItems: any[] = (hwSummary as any)?.items ?? [];
  const activeHw = hwItems.filter(
    (h) => h.status === "not_submitted" || h.status === "pending"
  );

  const inputCls =
    "w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50";

  const SectionTitle = ({ emoji, text }: { emoji: string; text: string }) => (
    <h2 className="flex items-center gap-2 text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-4">
      <span>{emoji}</span>
      {text}
    </h2>
  );

  return (
    <div className="min-h-[100dvh] bg-background text-white">
      <QuickSwitch />

      {/* ── Header ── */}
      <header className="border-b border-white/10 bg-card/50 backdrop-blur-lg sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-5 py-3.5 flex items-center justify-between">
          <div className="font-bold text-base bg-clip-text text-transparent bg-gradient-to-r from-primary to-secondary">
            myaiteacher
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => setShowProfile((v) => !v)}
              className="text-sm text-muted-foreground hover:text-white transition-colors flex items-center gap-1.5"
            >
              👤 <span className="hidden sm:inline">{user.fullName}</span>
            </button>
            <button
              onClick={logout}
              className="text-sm text-muted-foreground hover:text-white transition-colors"
            >
              Ելq
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-5 py-8 space-y-12">

        {/* ── SECTION 1: Welcome ── */}
        <section>
          <h1 className="text-2xl font-bold mb-1">
            Барі галust, {user.fullName} 👋
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>Дасаран՝ 7Ա</span>
            <span className="w-1 h-1 rounded-full bg-muted-foreground/40" />
            <span>{todayDate}</span>
          </div>
        </section>

        {/* ── SECTION 2: Today's active lesson ── */}
        <section>
          <SectionTitle emoji="📖" text="АЙSORВADA DASЫ" />

          {activeLesson === undefined ? (
            <div className="rounded-2xl border border-white/10 bg-card/40 p-8 flex items-center justify-center gap-3 text-muted-foreground text-sm">
              <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              Bayramnavoum e...
            </div>
          ) : activeLesson === null ? (
            <div className="rounded-2xl border border-white/10 bg-card/40 p-8 text-center text-muted-foreground">
              <div className="text-4xl mb-3">📭</div>
              <p className="text-sm">Айsord nor das chi nshanakvel։</p>
            </div>
          ) : (
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
                  {activeLesson.lessonNumber != null && (
                    <div className="text-xs text-muted-foreground">
                      Дас #{activeLesson.lessonNumber}
                    </div>
                  )}
                  <h3 className="text-xl font-bold leading-snug">{activeLesson.title}</h3>
                  <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                    {activeLesson.chapterTitle && (
                      <span>📂 {activeLesson.chapterTitle}</span>
                    )}
                    {activeLesson.paragraphNumber && (
                      <span>§{activeLesson.paragraphNumber}</span>
                    )}
                    {(activeLesson.pagesFrom || activeLesson.pagesTo) && (
                      <span>
                        Эj {activeLesson.pagesFrom ?? "?"}–{activeLesson.pagesTo ?? "?"}
                      </span>
                    )}
                  </div>
                </div>
                <Link
                  href={`/chat/${activeLesson.id}`}
                  className="flex items-center justify-center gap-2 px-8 py-4 rounded-2xl bg-gradient-to-r from-primary to-secondary text-white font-bold text-base hover:opacity-90 active:scale-[0.98] transition-all shadow-xl shadow-primary/25 whitespace-nowrap shrink-0"
                >
                  ▶ СKSEL DASЫ
                </Link>
              </div>
            </div>
          )}
        </section>

        {/* ── SECTION 3: Subjects ── */}
        <section>
          <SectionTitle emoji="📚" text="IM ARRAРAKNERЫ" />
          {subjects.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              Arraрakner chkan · Adminа kaм usuciche petq e aveli
            </p>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {subjects.map((sub) => {
                const entry = schedule.find(
                  (s) => s.subject.toLowerCase() === sub.subject.toLowerCase()
                );
                const pct = Math.round(sub.progressPercent ?? 0);
                return (
                  <Link
                    key={sub.id}
                    href={`/subjects/${sub.id}`}
                    className="block rounded-2xl border border-white/10 bg-card/60 p-5 hover:border-primary/30 hover:bg-card/80 transition-colors group"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="font-semibold group-hover:text-primary transition-colors">
                        {sub.subject}
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {sub.completedLessons}/{sub.totalLessons}
                      </span>
                    </div>
                    {entry?.teacherName && (
                      <div className="text-xs text-muted-foreground mb-3">
                        👨‍🏫 {entry.teacherName}
                      </div>
                    )}
                    <div className="h-1.5 w-full bg-background rounded-full overflow-hidden mt-auto">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-primary to-secondary transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="text-xs text-muted-foreground mt-1.5 text-right">{pct}%</div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        {/* ── SECTION 4: Homework ── */}
        <section>
          <SectionTitle emoji="📝" text="TNYIN ASHKHATANKNER" />
          {activeHw.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-card/40 p-5 text-center text-sm text-muted-foreground">
              Aktiv tnayin ashkhatank chka ✓
            </div>
          ) : (
            <div className="space-y-3">
              {activeHw.map((h: any) => (
                <div
                  key={h.id}
                  className="rounded-xl border border-white/10 bg-card/60 p-4 flex items-center gap-4"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-muted-foreground mb-0.5">
                      {h.lessonTitle ?? "Дас"}
                    </div>
                    <div className="font-medium text-sm truncate">{h.title}</div>
                    {h.createdAt && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {new Date(h.createdAt).toLocaleDateString("hy-AM")}
                      </div>
                    )}
                  </div>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                      h.status === "pending"
                        ? "bg-amber-400/15 text-amber-400"
                        : "bg-white/10 text-muted-foreground"
                    }`}
                  >
                    {h.status === "pending" ? "Ynthatsum" : "Chi nurarkvel"}
                  </span>
                  <Link
                    href={`/homework/${h.id}`}
                    className="shrink-0 px-3 py-1.5 text-xs rounded-lg bg-primary/15 text-primary hover:bg-primary/25 transition-colors border border-primary/20"
                  >
                    Bacel
                  </Link>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── SECTION 5: Today's schedule ── */}
        <section>
          <SectionTitle emoji="📅" text="АЙSORVADA DASATSУTSAK" />
          {todayItems.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-card/40 p-5 text-center text-sm text-muted-foreground">
              Айsord dasatsutsak chka
            </div>
          ) : (
            <div className="rounded-2xl border border-white/10 bg-card/60 divide-y divide-white/8 overflow-hidden">
              {todayItems.map((s) => {
                const sub = subjects.find(
                  (x) => x.subject.toLowerCase() === s.subject.toLowerCase()
                );
                return (
                  <div
                    key={s.id}
                    className="flex items-center gap-4 px-5 py-3.5 hover:bg-white/5 transition-colors"
                  >
                    <span className="text-primary font-mono text-sm font-bold w-14 shrink-0">
                      {s.time}
                    </span>
                    <span className="flex-1 font-medium text-sm">{s.subject}</span>
                    <span className="text-xs text-muted-foreground hidden sm:block">
                      👨‍🏫 {s.teacherName}
                    </span>
                    {sub ? (
                      <Link
                        href={`/subjects/${sub.id}`}
                        className="text-xs text-muted-foreground hover:text-primary transition-colors ml-2"
                      >
                        →
                      </Link>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── SECTION 6: Progress ── */}
        <section>
          <SectionTitle emoji="📈" text="IM ARRAJNTHACY" />
          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-2xl border border-white/10 bg-card/60 p-5 text-center">
              <div className="text-3xl font-bold text-primary mb-1">
                {stats.completedLessons}
              </div>
              <div className="text-xs text-muted-foreground leading-tight">
                Avartvatc дасеr
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-card/60 p-5 text-center">
              <div className="text-3xl font-bold text-teal-400 mb-1">
                {stats.averageScore > 0 ? stats.averageScore : "—"}
              </div>
              <div className="text-xs text-muted-foreground leading-tight">
                Mijnin gnahatakan
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-card/60 p-5 text-center">
              <div className="text-3xl font-bold text-amber-400 mb-1">
                {stats.pendingHomework}
              </div>
              <div className="text-xs text-muted-foreground leading-tight">
                Mnacel ashkhatank
              </div>
            </div>
          </div>
        </section>

        {/* ── Profile (toggled from header) ── */}
        {showProfile && (
          <section>
            <SectionTitle emoji="👤" text="ANDZNAКAN TVYALNER" />
            <div className="max-w-xl">
              <div className="bg-card/60 border border-white/10 rounded-2xl p-5 mb-4 space-y-1 text-sm">
                <div>
                  <span className="text-muted-foreground">Ogtanunn:</span>{" "}
                  <span className="ml-2">{user.username}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Anun:</span>{" "}
                  <span className="ml-2">{user.fullName}</span>
                </div>
                {(user as any).email && (
                  <div>
                    <span className="text-muted-foreground">Email:</span>{" "}
                    <span className="ml-2">{(user as any).email}</span>
                  </div>
                )}
              </div>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setProfileError("");
                  setProfileSaved(false);
                  try {
                    const res = await fetch("/api/student/profile", {
                      method: "PUT",
                      headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${token}`,
                      },
                      body: JSON.stringify({
                        fullName: profileForm.fullName || undefined,
                        email: profileForm.email || undefined,
                        age: profileForm.age ? parseInt(profileForm.age) : undefined,
                        bio: profileForm.bio || undefined,
                      }),
                    });
                    if (res.ok) setProfileSaved(true);
                    else setProfileError("Skhalt · Profayeq krkin");
                  } catch {
                    setProfileError("Skhalt · Profayeq krkin");
                  }
                }}
                className="bg-card/60 border border-white/10 rounded-2xl p-6 space-y-4"
              >
                {profileSaved && (
                  <p className="text-teal-400 text-sm">Pahpanvets ✓</p>
                )}
                {profileError && (
                  <p className="text-destructive text-sm">{profileError}</p>
                )}
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    Anun Azganun
                  </label>
                  <input
                    className={inputCls}
                    value={profileForm.fullName}
                    onChange={(e) =>
                      setProfileForm((f) => ({ ...f, fullName: e.target.value }))
                    }
                    placeholder={user.fullName}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    Email
                  </label>
                  <input
                    type="email"
                    className={inputCls}
                    value={profileForm.email}
                    onChange={(e) =>
                      setProfileForm((f) => ({ ...f, email: e.target.value }))
                    }
                    placeholder={(user as any).email || "example@mail.com"}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    Tarik
                  </label>
                  <input
                    type="number"
                    min="5"
                    max="25"
                    className={inputCls}
                    value={profileForm.age}
                    onChange={(e) =>
                      setProfileForm((f) => ({ ...f, age: e.target.value }))
                    }
                    placeholder={
                      (user as any).age ? String((user as any).age) : "14"
                    }
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    Nkaragrutyun
                  </label>
                  <textarea
                    rows={3}
                    className={`${inputCls} resize-none`}
                    value={profileForm.bio}
                    onChange={(e) =>
                      setProfileForm((f) => ({ ...f, bio: e.target.value }))
                    }
                    placeholder="..."
                  />
                </div>
                <button
                  type="submit"
                  className="px-6 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-medium hover:opacity-90 transition-all"
                >
                  Pahpanel
                </button>
              </form>
            </div>
          </section>
        )}

      </div>
    </div>
  );
}
