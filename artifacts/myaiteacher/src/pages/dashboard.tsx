import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import QuickSwitch from "@/components/QuickSwitch";
import {
  useGetDashboard,
  useGetProgress,
  useGetStudentSchedule,
  useGetStudentTeachers,
  useUpdateStudentProfile,
  getGetDashboardQueryKey,
  getGetProgressQueryKey,
  getGetStudentScheduleQueryKey,
  getGetStudentTeachersQueryKey,
} from "@workspace/api-client-react";

type Tab = "overview" | "schedule" | "subjects" | "teachers" | "profile";

// Armenian weekday order — keys must match what admin stores in DB
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
  const { data: progressData } = useGetProgress({
    query: { queryKey: getGetProgressQueryKey(), enabled: !!token },
  });
  const { data: schedule = [] } = useGetStudentSchedule({
    query: { queryKey: getGetStudentScheduleQueryKey(), enabled: !!token },
  });
  const { data: teachers = [] } = useGetStudentTeachers({
    query: { queryKey: getGetStudentTeachersQueryKey(), enabled: !!token },
  });

  if (authLoading || dashLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!user) return null;

  const todayArm = new Date().toLocaleDateString("hy-AM", { weekday: "long" });
  const todayItems = schedule.filter(
    (s) => s.day.toLowerCase().replace(/[.]/g, "") === todayArm.toLowerCase().replace(/[.]/g, "")
  );

  // Group schedule by its own day field (whatever the admin stored)
  const grouped: Record<string, typeof schedule> = {};
  for (const item of schedule) {
    if (!grouped[item.day]) grouped[item.day] = [];
    grouped[item.day].push(item);
  }
  const sortedDays = Object.keys(grouped).sort(
    (a, b) => (DAY_ORDER[a] ?? 99) - (DAY_ORDER[b] ?? 99)
  );

  // Match schedule subject name → subject id from dashboard data
  const findSubjectId = (subjectName: string): number | null => {
    const match = (dashboard?.subjects ?? []).find(
      (s) => s.subject.toLowerCase() === subjectName.toLowerCase()
    );
    return match?.id ?? null;
  };

  // Knowledge map: use dashboard subjects as source of truth (shows 0% if not started)
  const knowledgeSubjects = (dashboard?.subjects ?? []).map((sub) => {
    const pData = (progressData?.subjects ?? []).find((p) => p.id === sub.id);
    const pct = Math.round(pData?.progressPercent ?? sub.progressPercent ?? 0);
    const level = pct >= 80 ? "mastered" : pct >= 50 ? "review" : "not_started";
    return { id: sub.id, name: sub.subject, pct, level };
  });

  const inputCls =
    "w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50";

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview",  label: "Ենդհանուր 🏠" },
    { key: "schedule",  label: "Դասացուցակ 📅" },
    { key: "subjects",  label: "Ա՜արկաներ 📚" },
    { key: "teachers",  label: "Ուսուցիչներ 👨‍🏫" },
    { key: "profile",   label: "Անձնական 📋" },
  ];

  const badge = (pct: number) => {
    if (pct >= 80) return { cls: "bg-teal-400/20 text-teal-400", label: "🟢 Յուրացվաց" };
    if (pct >= 50) return { cls: "bg-amber-400/20 text-amber-400", label: "🟡 Թույլ" };
    return { cls: "bg-red-500/20 text-red-400", label: "🔴 Չսկսած" };
  };

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
            <Link href="/chat/0"
              className="px-3 py-1.5 bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 rounded-lg text-sm font-medium transition-colors">
              🤖 AI Ուսուցիչ
            </Link>
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
          <p className="text-muted-foreground text-sm mt-1">Ահա քո ուսման ընթհացիկ արաջնթհացը</p>
        </div>

        {/* Today highlight */}
        {todayItems.length > 0 && (
          <div className="mb-6 bg-primary/10 border border-primary/20 rounded-2xl p-4">
            <h3 className="text-sm font-medium text-primary mb-3">📅 Այսորի իմ Դասերը</h3>
            <div className="flex flex-wrap gap-2">
              {todayItems.sort((a, b) => a.time.localeCompare(b.time)).map((s) => {
                const sid = findSubjectId(s.subject);
                return (
                  <div key={s.id} className="flex items-center gap-2 bg-background/50 border border-white/10 rounded-xl px-3 py-2">
                    <span className="text-teal-400 font-mono text-xs font-bold">{s.time}</span>
                    <span className="text-sm font-medium">{s.subject}</span>
                    <span className="text-xs text-muted-foreground">· {s.className}</span>
                    {sid && (
                      <Link href={`/subjects/${sid}`}
                        className="px-2 py-0.5 bg-primary text-white text-xs font-semibold rounded-md hover:bg-primary/80 transition-colors">
                        Սովորել
                      </Link>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

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

        {/* ── OVERVIEW ── */}
        {tab === "overview" && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">

              {/* Subjects card */}
              <div className="bg-card/60 border border-white/10 rounded-2xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-semibold">📚 Ա՜արկաներ</h2>
                  <button onClick={() => setTab("subjects")} className="text-xs text-primary hover:underline">
                    Բոլորը →
                  </button>
                </div>
                <div className="space-y-3">
                  {(dashboard?.subjects ?? []).slice(0, 5).map((sub) => {
                    const pct = Math.round(sub.progressPercent);
                    const { cls, label } = badge(pct);
                    return (
                      <Link key={sub.id} href={`/subjects/${sub.id}`} className="block group">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium group-hover:text-primary transition-colors">{sub.subject}</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded-full ${cls}`}>{label}</span>
                        </div>
                        <div className="flex justify-between text-xs text-muted-foreground mb-1">
                          <span>{sub.completedLessons}/{sub.totalLessons} Դասեր</span>
                          <span>{pct}%</span>
                        </div>
                        <div className="h-1.5 w-full bg-background rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${pct >= 80 ? "bg-teal-400" : pct >= 50 ? "bg-amber-400" : "bg-red-500"}`}
                            style={{ width: `${pct}%` }} />
                        </div>
                      </Link>
                    );
                  })}
                  {(dashboard?.subjects ?? []).length === 0 && (
                    <p className="text-muted-foreground text-sm">Ա՜արկաներ չկան</p>
                  )}
                  {(dashboard?.subjects ?? []).length > 0 && (
                    <Link href={`/subjects/${dashboard!.subjects[0].id}`}
                      className="mt-2 flex items-center justify-center gap-1.5 px-4 py-2 bg-gradient-to-r from-primary to-secondary text-white text-xs font-semibold rounded-xl hover:opacity-90 transition-opacity">
                      📖 Սովորել
                    </Link>
                  )}
                </div>
              </div>

              {/* Knowledge Map card */}
              <div className="bg-card/60 border border-white/10 rounded-2xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-semibold">🗺️ Գիտելիքի Քարտեզ</h2>
                  <Link href="/progress" className="text-xs text-primary hover:underline">Բոլորը →</Link>
                </div>
                <div className="space-y-4">
                  {knowledgeSubjects.slice(0, 5).map((sub) => {
                    const color = sub.level === "mastered" ? "bg-teal-400" : sub.level === "review" ? "bg-amber-400" : "bg-red-500";
                    const textColor = sub.level === "mastered" ? "text-teal-400" : sub.level === "review" ? "text-amber-400" : "text-red-400";
                    const statusLabel = sub.level === "mastered" ? "🟢 Յուրացվաց" : sub.level === "review" ? "🟡 Թույլ" : "🔴 Չսկսած";
                    return (
                      <div key={sub.id}>
                        <div className="flex justify-between text-xs mb-1.5">
                          <span className="text-white font-medium truncate pr-2">{sub.name}</span>
                          <span className={`${textColor} font-semibold shrink-0`}>{sub.pct}%</span>
                        </div>
                        <div className="h-2 w-full bg-background rounded-full overflow-hidden mb-1">
                          <div className={`h-full rounded-full ${color}`} style={{ width: `${sub.pct}%` }} />
                        </div>
                        <div className="text-xs text-muted-foreground">{statusLabel}</div>
                      </div>
                    );
                  })}
                  {knowledgeSubjects.length === 0 && (
                    <p className="text-muted-foreground text-xs">տվյալներ չկան</p>
                  )}
                </div>
              </div>

              {/* Teachers + Today's schedule card */}
              <div className="bg-card/60 border border-white/10 rounded-2xl p-5 flex flex-col gap-5">
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="font-semibold">👨‍🏫 Ուսուցիչներ</h2>
                    {teachers.length > 3 && (
                      <button onClick={() => setTab("teachers")} className="text-xs text-primary hover:underline">
                        Բոլորը →
                      </button>
                    )}
                  </div>
                  {teachers.length === 0 ? (
                    <p className="text-muted-foreground text-sm">Ուսուցիչ չկան</p>
                  ) : (
                    <div className="space-y-2.5">
                      {teachers.slice(0, 4).map((t) => (
                        <div key={t.teacherId} className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary/30 to-secondary/30 flex items-center justify-center text-xs font-bold text-primary shrink-0">
                            {t.teacherName.slice(0, 1)}
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">{t.teacherName}</div>
                            <div className="text-xs text-muted-foreground truncate">
                              {t.subject && `📚 ${t.subject}`}{t.className && ` · ${t.className}`}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {schedule.length > 0 && (
                  <div className="border-t border-white/10 pt-4">
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      📅 Այսորի իմ Դասերը
                    </h3>
                    {todayItems.length === 0 ? (
                      <p className="text-xs text-muted-foreground">Այսոր Դասեր չկան</p>
                    ) : (
                      <div className="space-y-1.5">
                        {todayItems.sort((a, b) => a.time.localeCompare(b.time)).map((s) => (
                          <div key={s.id} className="flex items-center gap-2 text-xs">
                            <span className="text-teal-400 font-mono font-bold">{s.time}</span>
                            <span>{s.subject}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Recent activity */}
            {(dashboard?.recentActivity ?? []).length > 0 && (
              <div>
                <h2 className="font-semibold mb-3">Վերջին ակտիվություն</h2>
                <div className="grid sm:grid-cols-2 gap-2">
                  {dashboard?.recentActivity.map((a) => (
                    <div key={a.id} className="flex items-center gap-3 bg-card/40 border border-white/10 rounded-xl px-4 py-3">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${a.status === "completed" ? "bg-teal-400" : "bg-amber-400"}`} />
                      <div className="flex-1 min-w-0">
                        <span className="text-xs text-primary">{a.subject}</span>
                        <div className="text-sm font-medium truncate">{a.lesson}</div>
                      </div>
                      {a.score > 0 && <span className="text-xs font-bold text-secondary shrink-0">{a.score}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── SCHEDULE ── */}
        {tab === "schedule" && (
          <div>
            {schedule.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground">
                <div className="text-5xl mb-4">📅</div>
                <p>Դասացուցակ չկան · Ադմինը կամ Ուսուցիչը Պետք ե Ավելացնել</p>
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
                            Այսոր
                          </span>
                        )}
                      </h3>
                      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        {items.slice().sort((a, b) => a.time.localeCompare(b.time)).map((s) => {
                          const sid = findSubjectId(s.subject);
                          return (
                            <div key={s.id} className="bg-card/60 border border-white/10 rounded-2xl p-5 flex flex-col gap-3">
                              <div className="flex items-center justify-between">
                                <span className="text-teal-400 font-mono text-base font-bold">{s.time}</span>
                                <span className="text-xs text-muted-foreground bg-white/5 px-2 py-0.5 rounded-full">{s.className}</span>
                              </div>
                              <div className="font-semibold text-lg">{s.subject}</div>
                              <div className="text-xs text-muted-foreground">👨‍🏫 {s.teacherName}</div>
                              {sid ? (
                                <Link href={`/subjects/${sid}`}
                                  className="mt-auto flex items-center justify-center gap-1.5 px-4 py-2 bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity">
                                  📖 Սովորել
                                </Link>
                              ) : (
                                <span className="text-xs text-muted-foreground">Դաս չկան</span>
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
            {(dashboard?.subjects ?? []).length === 0 ? (
              <div className="text-center py-20 text-muted-foreground">
                <div className="text-5xl mb-4">📚</div>
                <p>Ա՜արկաներ չկան</p>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {(dashboard?.subjects ?? []).map((sub) => {
                  const pct = Math.round(sub.progressPercent);
                  const { cls, label } = badge(pct);
                  return (
                    <div key={sub.id} className="bg-card/60 border border-white/10 rounded-2xl p-6 flex flex-col gap-4">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="font-semibold text-lg">{sub.subject}</h3>
                        <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${cls}`}>{label}</span>
                      </div>
                      <div className="flex justify-between text-sm text-muted-foreground">
                        <span>{sub.completedLessons}/{sub.totalLessons} Դասեր</span>
                        <span className="font-bold text-white">{pct}%</span>
                      </div>
                      <div className="h-2 w-full bg-background rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${pct >= 80 ? "bg-teal-400" : pct >= 50 ? "bg-amber-400" : "bg-red-500"}`}
                          style={{ width: `${pct}%` }} />
                      </div>
                      <div className="text-xs text-secondary">Բազային գնահաթական: {Math.round(sub.averageScore)}</div>
                      <Link href={`/subjects/${sub.id}`}
                        className="mt-auto flex items-center justify-center gap-1.5 px-4 py-2.5 bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity">
                        📖 Սովորել
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
                <p>Ուսուցիչ չկան · Ադմինը Պետք ե Նշանակի</p>
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
                  onError: () => setProfileError("սխալ · Պորդզեկ կրկին"),
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
                <label className="text-xs text-muted-foreground block mb-1">Նկարագրություն (կամային)</label>
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
              <h3 className="text-sm font-medium mb-2 text-muted-foreground">Լրական տվյալներ</h3>
              <div className="text-sm space-y-1">
                <div><span className="text-muted-foreground">Ոգտանուն:</span> <span className="ml-2">{user.username}</span></div>
                {(user as any).email && <div><span className="text-muted-foreground">Email:</span> <span className="ml-2">{(user as any).email}</span></div>}
                {(user as any).age && <div><span className="text-muted-foreground">Տարիք:</span> <span className="ml-2">{(user as any).age}</span></div>}
                {(user as any).bio && <div><span className="text-muted-foreground">Նկարագր:</span> <span className="ml-2 text-muted-foreground">{(user as any).bio}</span></div>}
              </div>
            </div>
          </div>
        )}

        {/* Bottom nav */}
        <div className="mt-8 pt-6 border-t border-white/10 flex flex-wrap gap-3 justify-center text-sm">
          <Link href="/progress" className="text-muted-foreground hover:text-primary transition-colors">📊 Արաջնթհաց</Link>
          <Link href="/books" className="text-muted-foreground hover:text-primary transition-colors">📚 Գրքեր</Link>
          <Link href="/chat/0" className="text-muted-foreground hover:text-primary transition-colors">🤖 AI Chat</Link>
        </div>
      </div>
    </div>
  );
}
