import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import QuickSwitch from "@/components/QuickSwitch";
import {
  useGetDashboard,
  useGetStudentSchedule,
  useGetStudentTeachers,
  useGetStudentTodayLessons,
  useUpdateStudentProfile,
  getGetDashboardQueryKey,
  getGetStudentScheduleQueryKey,
  getGetStudentTeachersQueryKey,
  getGetStudentTodayLessonsQueryKey,
} from "@workspace/api-client-react";

type Tab = "overview" | "schedule" | "subjects" | "teachers" | "profile";

const DAY_ORDER: Record<string, number> = {
  "Երկուշաբթի": 0,
  "Երեքշաբթի": 1,
  "Չորեքշաբթի": 2,
  "Հինգշաբթի": 3,
  "Ուրբաթ": 4,
  "Շաբաթ": 5,
};

export default function Dashboard() {
  const { user, token, logout, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<Tab>("overview");
  const [profileForm, setProfileForm] = useState({ fullName: "", email: "", age: "", bio: "" });
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState("");
  const updateProfile = useUpdateStudentProfile();

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
  const { data: todayLessons = [] } = useGetStudentTodayLessons({
    query: { queryKey: getGetStudentTodayLessonsQueryKey(), enabled: !!token },
  });

  // Redirect non-students — wait until profile is fully loaded to avoid stale-cache race
  useEffect(() => {
    if (authLoading || !user) return;
    if (user.role === "admin") setLocation("/admin");
    else if (user.role === "teacher") setLocation("/teacher");
  }, [user, authLoading, setLocation]);

  if (authLoading || dashLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!user || user.role !== "student") return null;

  const todayArm = new Date().toLocaleDateString("hy-AM", { weekday: "long" });
  const todayItems = schedule.filter(
    (s) => s.day.toLowerCase().replace(/[.]/g, "") === todayArm.toLowerCase().replace(/[.]/g, "")
  );

  const grouped: Record<string, typeof schedule> = {};
  for (const item of schedule) {
    if (!grouped[item.day]) grouped[item.day] = [];
    grouped[item.day].push(item);
  }
  const sortedDays = Object.keys(grouped).sort(
    (a, b) => (DAY_ORDER[a] ?? 99) - (DAY_ORDER[b] ?? 99)
  );

  const subjects = dashboard?.subjects ?? [];

  const pctColor = (pct: number) =>
    pct >= 80 ? "bg-teal-400" : pct >= 50 ? "bg-amber-400" : "bg-primary";

  const pctBadge = (pct: number) =>
    pct >= 80
      ? { cls: "bg-teal-400/20 text-teal-400", text: "Յուրացված" }
      : pct >= 50
      ? { cls: "bg-amber-400/20 text-amber-400", text: "Ընթացքում" }
      : { cls: "bg-white/10 text-muted-foreground", text: "Չսկսած" };

  const inputCls =
    "w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50";

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview",  label: "Ընդհանուր" },
    { key: "schedule",  label: "Դասացուցակ 📅" },
    { key: "subjects",  label: "Առարկաներ 📚" },
    { key: "teachers",  label: "Ուսուցիչներ 👨‍🏫" },
    { key: "profile",   label: "Անձնական 📋" },
  ];

  const findSubject = (subjectName: string) =>
    subjects.find((x) => x.subject.toLowerCase() === subjectName.toLowerCase());

  // Next upcoming lesson: sorted by DAY_ORDER then time; wrap to start of week if nothing later today
  const todayOrder = DAY_ORDER[Object.keys(DAY_ORDER).find(
    (k) => k.toLowerCase().replace(/[.]/g, "") === todayArm.toLowerCase().replace(/[.]/g, "")
  ) ?? ""] ?? -1;
  const sortedSchedule = [...schedule].sort((a, b) => {
    const da = DAY_ORDER[a.day] ?? 99;
    const db = DAY_ORDER[b.day] ?? 99;
    return da !== db ? da - db : a.time.localeCompare(b.time);
  });
  const nextLesson =
    sortedSchedule.find((s) => (DAY_ORDER[s.day] ?? 99) > todayOrder) ??
    sortedSchedule[0] ??
    null;

  return (
    <div className="min-h-[100dvh] bg-background text-white">
      <QuickSwitch />

      {/* Header */}
      <header className="border-b border-white/10 bg-card/50 backdrop-blur-lg sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="font-bold text-lg bg-clip-text text-transparent bg-gradient-to-r from-primary to-secondary">
            myaiteacher
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground hidden sm:block">{user.fullName}</span>
            <button onClick={logout} className="text-sm text-muted-foreground hover:text-white transition-colors">
              Ելք
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-6">

        {/* Greeting */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Բարի գալուստ, {user.fullName} 👋</h1>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-white/10 overflow-x-auto mb-6">
          {tabs.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
                tab === t.key ? "border-primary text-white" : "border-transparent text-muted-foreground hover:text-white"
              }`}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── OVERVIEW — today's lessons (API-driven, linked to lesson content) ── */}
        {tab === "overview" && (
          <div className="max-w-lg">
            <div className="bg-card/60 border border-white/10 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold">
                  {todayLessons.length > 0 ? "📅 Այsörva im dasery" : "📅 Հаджорд das"}
                </h2>
                <button onClick={() => setTab("schedule")} className="text-xs text-primary hover:underline">
                  Բolory →
                </button>
              </div>

              {/* Today's lessons with lesson number + direct link */}
              {todayLessons.length > 0 && (
                <div className="space-y-3">
                  {todayLessons.map((s) => (
                    <div key={s.scheduleId} className="bg-background/40 border border-white/10 rounded-xl p-4 flex flex-col gap-3">
                      <div className="flex items-center justify-between">
                        <span className="text-teal-400 font-mono text-sm font-bold">{s.time}</span>
                        <span className="text-xs text-muted-foreground">{s.className}</span>
                      </div>
                      <div className="font-semibold text-base">
                        {s.subject}
                        {s.lessonNumber != null && (
                          <span className="ml-2 text-sm font-normal text-muted-foreground">
                            — Դաs {s.lessonNumber}
                          </span>
                        )}
                      </div>
                      {s.lessonTitle && (
                        <div className="text-xs text-white/70 italic">{s.lessonTitle}</div>
                      )}
                      <div className="text-xs text-muted-foreground">👨‍🏫 {s.teacherName}</div>
                      {s.lessonId != null ? (
                        <Link href={`/lessons/${s.lessonId}`}
                          className="flex items-center justify-center gap-1.5 px-4 py-2 bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity">
                          📖 Սovoreq
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground italic">Ուusucichë das chë stexcel</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* No lessons today → show next upcoming from schedule */}
              {todayLessons.length === 0 && nextLesson && (
                <div>
                  <p className="text-xs text-muted-foreground mb-3">
                    Айsör das chka · Наджорд das՝{" "}
                    <span className="text-primary font-medium">{nextLesson.day}</span>
                  </p>
                  <div className="bg-background/40 border border-white/10 rounded-xl p-4 flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <span className="text-teal-400 font-mono text-sm font-bold">{nextLesson.time}</span>
                      <span className="text-xs text-muted-foreground">{nextLesson.className}</span>
                    </div>
                    <div className="font-semibold text-base">{nextLesson.subject}</div>
                    <div className="text-xs text-muted-foreground">👨‍🏫 {nextLesson.teacherName}</div>
                  </div>
                </div>
              )}

              {/* No schedule at all */}
              {todayLessons.length === 0 && !nextLesson && (
                <p className="text-muted-foreground text-sm">Аysör das chka</p>
              )}
            </div>
          </div>
        )}

        {/* ── SCHEDULE ── */}
        {tab === "schedule" && (
          <div>
            {schedule.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground">
                <div className="text-5xl mb-4">📅</div>
                <p>Դասացուցակ չկա · Ադմինը կամ ուսուցիչը պետք է ավելացնի</p>
              </div>
            ) : (
              <div className="space-y-8">
                {sortedDays.map((day) => {
                  const items = grouped[day];
                  const isToday = day.toLowerCase().replace(/[.]/g, "") === todayArm.toLowerCase().replace(/[.]/g, "");
                  return (
                    <div key={day}>
                      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-widest mb-4 flex items-center gap-2">
                        {day}
                        {isToday && (
                          <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded-full normal-case tracking-normal">
                            Այսօր
                          </span>
                        )}
                      </h3>
                      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        {items.slice().sort((a, b) => a.time.localeCompare(b.time)).map((s) => {
                          const sub = findSubject(s.subject);
                          return (
                            <div key={s.id} className="bg-card/60 border border-white/10 rounded-2xl p-5 flex flex-col gap-3">
                              <div className="flex items-center justify-between">
                                <span className="text-teal-400 font-mono text-base font-bold">{s.time}</span>
                                <span className="text-xs text-muted-foreground bg-white/5 px-2 py-0.5 rounded-full">{s.className}</span>
                              </div>
                              <div className="font-semibold text-lg">{s.subject}</div>
                              <div className="text-xs text-muted-foreground">👨‍🏫 {s.teacherName}</div>
                              {sub ? (
                                <Link href={`/subjects/${sub.id}`}
                                  className="mt-auto flex items-center justify-center gap-1.5 px-4 py-2 bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity">
                                  📖 Սովորել
                                </Link>
                              ) : (
                                <span className="text-xs text-muted-foreground">Առարկայի կապ չկա</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── SUBJECTS ── */}
        {tab === "subjects" && (
          <div>
            {subjects.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground">
                <div className="text-5xl mb-4">📚</div>
                <p>Առարկաներ չկան</p>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {subjects.map((sub) => {
                  const pct = Math.round(sub.progressPercent);
                  const { cls, text } = pctBadge(pct);
                  return (
                    <div key={sub.id} className="bg-card/60 border border-white/10 rounded-2xl p-6 flex flex-col gap-4">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="font-semibold text-lg">{sub.subject}</h3>
                        <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${cls}`}>{text}</span>
                      </div>
                      <div className="flex justify-between text-sm text-muted-foreground">
                        <span>{sub.completedLessons}/{sub.totalLessons} դաս</span>
                        <span className="font-bold text-white">{pct}%</span>
                      </div>
                      <div className="h-2 w-full bg-background rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${pctColor(pct)}`} style={{ width: `${pct}%` }} />
                      </div>
                      <Link href={`/subjects/${sub.id}`}
                        className="mt-auto flex items-center justify-center gap-1.5 px-4 py-2.5 bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity">
                        📖 Դիտել
                      </Link>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── TEACHERS ── */}
        {tab === "teachers" && (
          <div>
            {teachers.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground">
                <div className="text-5xl mb-4">👨‍🏫</div>
                <p>Ուսուցիչ չկան · Ադմինը պետք է նշանակի</p>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {teachers.map((t) => (
                  <div key={t.teacherId} className="bg-card/60 border border-white/10 rounded-2xl p-6">
                    <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary/30 to-secondary/30 flex items-center justify-center text-lg font-bold text-primary mb-4">
                      {t.teacherName.slice(0, 1)}
                    </div>
                    <div className="font-semibold text-lg mb-1">{t.teacherName}</div>
                    {t.subject && <div className="text-sm text-secondary mb-1">📚 {t.subject}</div>}
                    <div className="text-xs text-muted-foreground">📋 {t.className}</div>
                    {t.school && <div className="text-xs text-muted-foreground mt-1">🏫 {t.school}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── PROFILE ── */}
        {tab === "profile" && (
          <div className="max-w-xl">
            <h2 className="font-semibold text-lg mb-5">📋 Անձնական տվյալներ</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setProfileError("");
                setProfileSaved(false);
                updateProfile.mutate({ data: {
                  fullName: profileForm.fullName || undefined,
                  email: profileForm.email || undefined,
                  age: profileForm.age ? parseInt(profileForm.age) : undefined,
                  bio: profileForm.bio || undefined,
                } }, {
                  onSuccess: () => setProfileSaved(true),
                  onError: () => setProfileError("Սխալ · Փորձեք կրկին"),
                });
              }}
              className="bg-card/60 border border-white/10 rounded-2xl p-6 space-y-4"
            >
              {profileSaved && <p className="text-teal-400 text-sm">Պահպանվեց ✓</p>}
              {profileError && <p className="text-destructive text-sm">{profileError}</p>}
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Անուն Ազգանուն</label>
                <input className={inputCls} value={profileForm.fullName}
                  onChange={(e) => setProfileForm((f) => ({ ...f, fullName: e.target.value }))}
                  placeholder={user.fullName} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Email</label>
                <input type="email" className={inputCls} value={profileForm.email}
                  onChange={(e) => setProfileForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder={(user as any).email || "example@mail.com"} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Տարիք (ամիք)</label>
                <input type="number" min="5" max="25" className={inputCls} value={profileForm.age}
                  onChange={(e) => setProfileForm((f) => ({ ...f, age: e.target.value }))}
                  placeholder={(user as any).age ? String((user as any).age) : "14"} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Նկարագրություն (կամայական)</label>
                <textarea rows={3} className={`${inputCls} resize-none`} value={profileForm.bio}
                  onChange={(e) => setProfileForm((f) => ({ ...f, bio: e.target.value }))}
                  placeholder="..." />
              </div>
              <button type="submit" disabled={updateProfile.isPending}
                className="px-6 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-medium disabled:opacity-50 transition-all">
                {updateProfile.isPending ? "..." : "Պահպանել"}
              </button>
            </form>

            <div className="mt-4 bg-card/30 border border-white/10 rounded-2xl p-4">
              <h3 className="text-sm font-medium mb-2 text-muted-foreground">Լրացուցիչ տվյալներ</h3>
              <div className="text-sm space-y-1">
                <div><span className="text-muted-foreground">Օգտանուն:</span> <span className="ml-2">{user.username}</span></div>
                {(user as any).email && <div><span className="text-muted-foreground">Email:</span> <span className="ml-2">{(user as any).email}</span></div>}
                {(user as any).age && <div><span className="text-muted-foreground">Տարիք:</span> <span className="ml-2">{(user as any).age}</span></div>}
                {(user as any).bio && <div><span className="text-muted-foreground">Նկարագր:</span> <span className="ml-2 text-muted-foreground">{(user as any).bio}</span></div>}
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
