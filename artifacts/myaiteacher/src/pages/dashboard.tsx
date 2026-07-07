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

const DAYS = ["Երկuшаbti", "Erекshаbti", "Chorекshаbti", "Hingshаbti", "Оurбаt", "Shаbаt"];

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

  const { data: dashboard, isLoading: dashLoading } = useGetDashboard({ query: { queryKey: getGetDashboardQueryKey(), enabled: !!token } });
  const { data: progressData } = useGetProgress({ query: { queryKey: getGetProgressQueryKey(), enabled: !!token } });
  const { data: schedule = [] } = useGetStudentSchedule({ query: { queryKey: getGetStudentScheduleQueryKey(), enabled: !!token } });
  const { data: teachers = [] } = useGetStudentTeachers({ query: { queryKey: getGetStudentTeachersQueryKey(), enabled: !!token } });

  if (authLoading || dashLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!user) return null;

  const todayArm = new Date().toLocaleDateString("hy-AM", { weekday: "long" });
  const todayItems = schedule.filter((s) =>
    s.day.toLowerCase().replace(/[.]/g, "") === todayArm.toLowerCase().replace(/[.]/g, "")
  );

  const inputCls = "w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50";

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview",  label: "🏠 Ընդհանուր" },
    { key: "schedule",  label: "📅 Դասացուցակ" },
    { key: "subjects",  label: "📚 Առարկաներ" },
    { key: "teachers",  label: "👨‍🏫 Ուսուցիչներ" },
    { key: "profile",   label: "📋 Անձնական տվյալներ" },
  ];

  // Match a schedule item's subject name to a subject id from dashboard data
  const findSubjectId = (subjectName: string): number | null => {
    const match = (dashboard?.subjects ?? []).find(
      (s) => s.subject.toLowerCase() === subjectName.toLowerCase()
    );
    return match?.id ?? null;
  };

  return (
    <div className="min-h-[100dvh] bg-background text-white">
      <QuickSwitch />

      {/* Header */}
      <header className="border-b border-white/10 bg-card/50 backdrop-blur-lg sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="font-bold text-lg bg-clip-text text-transparent bg-gradient-to-r from-primary to-secondary">myaiteacher</div>
          <div className="flex items-center gap-4">
            <Link href="/chat/0" className="px-3 py-1.5 bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 rounded-lg text-sm font-medium transition-colors">🤖 AI Ուսուցիչ</Link>
            <span className="text-sm text-muted-foreground hidden sm:block">{user.fullName}</span>
            <button onClick={logout} className="text-sm text-muted-foreground hover:text-white transition-colors">Ելք</button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-6">

        {/* Greeting */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Բարի գալուստ, {user.fullName} 👋</h1>
          <p className="text-muted-foreground text-sm mt-1">Aha qo ousmann Արաջնթհաց</p>
        </div>

        {/* Today's schedule highlight */}
        {todayItems.length > 0 && (
          <div className="mb-6 bg-primary/10 border border-primary/20 rounded-2xl p-4">
            <h3 className="text-sm font-medium text-primary mb-3">📅 Այսորor իմ դասերը</h3>
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
                        className="px-2 py-0.5 bg-primary text-white text-xs font-medium rounded-lg hover:bg-primary/80 transition-colors">
                        Սovoreq
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
              className={`px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${tab === t.key ? "border-primary text-white" : "border-transparent text-muted-foreground hover:text-white"}`}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── OVERVIEW ── */}
        {tab === "overview" && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">

              {/* Subjects progress */}
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-semibold">Առarkaners</h2>
                  <button onClick={() => setTab("subjects")} className="text-xs text-primary hover:underline">Բոլորը →</button>
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  {(dashboard?.subjects ?? []).slice(0, 4).map((sub) => (
                    <Link key={sub.id} href={`/subjects/${sub.id}`}
                      className="bg-card/60 border border-white/10 rounded-xl p-4 hover:border-primary/40 transition-colors block">
                      <div className="flex justify-between items-center mb-2">
                        <span className="font-medium text-sm">{sub.subject}</span>
                        <span className="text-xs text-secondary">{Math.round(sub.averageScore)} մ.</span>
                      </div>
                      <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
                        <span>{sub.completedLessons}/{sub.totalLessons} դաs</span>
                        <span>{Math.round(sub.progressPercent)}%</span>
                      </div>
                      <div className="h-1.5 w-full bg-background rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-primary to-secondary rounded-full" style={{ width: `${sub.progressPercent}%` }} />
                      </div>
                    </Link>
                  ))}
                  {(dashboard?.subjects ?? []).length === 0 && (
                    <p className="text-muted-foreground text-sm col-span-2">Առarkaners chkan</p>
                  )}
                </div>
              </div>

              {/* Recent activity */}
              {(dashboard?.recentActivity ?? []).length > 0 && (
                <div>
                  <h2 className="font-semibold mb-4">Verji aktiveness</h2>
                  <div className="space-y-2">
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

            {/* Sidebar */}
            <div className="space-y-4">

              {/* Knowledge map mini */}
              <div className="bg-card/60 border border-white/10 rounded-2xl p-5">
                <h3 className="font-semibold mb-4">🗺️ Գiteligy Qartez</h3>
                <div className="space-y-3">
                  {(progressData?.subjects ?? []).slice(0, 4).map((sub) => (
                    <div key={sub.id}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-muted-foreground truncate pr-2">{sub.name}</span>
                        <span className={sub.masteryLevel === "mastered" ? "text-teal-400" : sub.masteryLevel === "review" ? "text-amber-400" : "text-red-400"}>
                          {sub.progressPercent}%
                        </span>
                      </div>
                      <div className="h-1.5 w-full bg-background rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${sub.masteryLevel === "mastered" ? "bg-teal-400" : sub.masteryLevel === "review" ? "bg-amber-400" : "bg-red-500"}`}
                          style={{ width: `${sub.progressPercent}%` }} />
                      </div>
                    </div>
                  ))}
                  {(!progressData?.subjects || progressData.subjects.length === 0) && (
                    <p className="text-muted-foreground text-xs">Tvyalner chkan</p>
                  )}
                </div>
                <Link href="/progress" className="mt-4 text-primary text-xs font-medium hover:underline block">Amboghakan qartez →</Link>
              </div>

              {/* Teachers mini */}
              {teachers.length > 0 && (
                <div className="bg-card/60 border border-white/10 rounded-2xl p-5">
                  <h3 className="font-semibold mb-3">👨‍🏫 իմ Ուսուցիչnerе</h3>
                  <div className="space-y-2">
                    {teachers.slice(0, 3).map((t) => (
                      <div key={t.teacherId} className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold text-primary">{t.teacherName.slice(0, 1)}</div>
                        <div>
                          <div className="text-sm font-medium">{t.teacherName}</div>
                          <div className="text-xs text-muted-foreground">{t.subject} · {t.className}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {teachers.length > 3 && <button onClick={() => setTab("teachers")} className="mt-3 text-primary text-xs font-medium hover:underline">Բոլորը ({teachers.length}) →</button>}
                </div>
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
                <p>Դասացուցակ չկան · Ադմինy կամ Ուսուցիչը Պետք e Ավելացնել</p>
              </div>
            ) : (
              <div className="space-y-6">
                {DAYS.map((day) => {
                  const items = schedule.filter(s => s.day === day);
                  if (items.length === 0) return null;
                  return (
                    <div key={day}>
                      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
                        {day}
                        {day.toLowerCase().replace(/[.]/g, "") === todayArm.toLowerCase().replace(/[.]/g, "") && (
                          <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded-full">Այsоr</span>
                        )}
                      </h3>
                      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {items.sort((a, b) => a.time.localeCompare(b.time)).map((s) => {
                          const sid = findSubjectId(s.subject);
                          return (
                            <div key={s.id} className="bg-card/60 border border-white/10 rounded-xl p-4">
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-teal-400 font-mono text-sm font-bold">{s.time}</span>
                                <span className="text-xs text-muted-foreground">{s.className}</span>
                              </div>
                              <div className="font-medium mb-1">{s.subject}</div>
                              <div className="text-xs text-muted-foreground mb-3">👨‍🏫 {s.teacherName}</div>
                              {sid ? (
                                <Link href={`/subjects/${sid}`}
                                  className="inline-block px-4 py-1.5 bg-gradient-to-r from-primary to-secondary text-white text-xs font-semibold rounded-lg hover:opacity-90 transition-opacity">
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
                {/* Fallback */}
                {!DAYS.some(day => schedule.some(s => s.day === day)) && (
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {schedule.map((s) => {
                      const sid = findSubjectId(s.subject);
                      return (
                        <div key={s.id} className="bg-card/60 border border-white/10 rounded-xl p-4">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-teal-400 font-mono text-sm font-bold">{s.time}</span>
                            <span className="text-xs text-muted-foreground">{s.day}</span>
                          </div>
                          <div className="font-medium mb-1">{s.subject}</div>
                          <div className="text-xs text-muted-foreground mb-3">👨‍🏫 {s.teacherName} · {s.className}</div>
                          {sid ? (
                            <Link href={`/subjects/${sid}`}
                              className="inline-block px-4 py-1.5 bg-gradient-to-r from-primary to-secondary text-white text-xs font-semibold rounded-lg hover:opacity-90 transition-opacity">
                              📖 Սովորել
                            </Link>
                          ) : (
                            <span className="text-xs text-muted-foreground">Դաս չկան</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
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
                <p>Առarkaners chkan</p>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {(dashboard?.subjects ?? []).map((sub) => {
                  const pct = Math.round(sub.progressPercent);
                  const level = pct >= 80 ? "mastered" : pct >= 50 ? "weak" : "not_started";
                  return (
                    <Link key={sub.id} href={`/subjects/${sub.id}`}
                      className="bg-card/60 border border-white/10 rounded-2xl p-5 hover:border-primary/40 hover:bg-primary/5 transition-all block group">
                      <div className="flex items-start justify-between mb-4">
                        <h3 className="font-semibold text-lg">{sub.subject}</h3>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${level === "mastered" ? "bg-teal-400/20 text-teal-400" : level === "weak" ? "bg-amber-400/20 text-amber-400" : "bg-red-500/20 text-red-400"}`}>
                          {level === "mastered" ? "🟢 Յuracvac" : level === "weak" ? "🟡 Thuyel" : "🔴 Chsksac"}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm text-muted-foreground mb-2">
                        <span>{sub.completedLessons}/{sub.totalLessons} das</span>
                        <span className="font-medium text-white">{pct}%</span>
                      </div>
                      <div className="h-2 w-full bg-background rounded-full overflow-hidden mb-3">
                        <div className={`h-full rounded-full ${level === "mastered" ? "bg-teal-400" : level === "weak" ? "bg-amber-400" : "bg-red-500"}`}
                          style={{ width: `${pct}%` }} />
                      </div>
                      <div className="text-xs text-secondary font-medium">Midj. {Math.round(sub.averageScore)} m.</div>
                      <div className="mt-3 text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity">Ditel →</div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── KNOWLEDGE MAP ── */}
        {tab === ("knowledge" as Tab) && null}

        {/* ── TEACHERS ── */}
        {tab === "teachers" && (
          <div>
            {teachers.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground">
                <div className="text-5xl mb-4">👨‍🏫</div>
                <p>Ուսուցիչ չկան · Ադմինy Պետք e nshanaki</p>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
            <h2 className="font-semibold text-lg mb-5">📋 Անձնական տվյalner</h2>
            <form
              onSubmit={e => {
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
                  onError: () => setProfileError("Սkhаl · Pordzek krkin"),
                });
              }}
              className="bg-card/60 border border-white/10 rounded-2xl p-6 space-y-4"
            >
              {profileSaved && <p className="text-teal-400 text-sm">Պahpanvec ✓</p>}
              {profileError && <p className="text-destructive text-sm">{profileError}</p>}
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Անunn Аzganunn</label>
                <input className={inputCls} value={profileForm.fullName}
                  onChange={e => setProfileForm(f => ({ ...f, fullName: e.target.value }))}
                  placeholder={user.fullName} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Email</label>
                <input type="email" className={inputCls} value={profileForm.email}
                  onChange={e => setProfileForm(f => ({ ...f, email: e.target.value }))}
                  placeholder={(user as any).email || "example@mail.com"} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Тariq (amiq)</label>
                <input type="number" min="5" max="25" className={inputCls} value={profileForm.age}
                  onChange={e => setProfileForm(f => ({ ...f, age: e.target.value }))}
                  placeholder={(user as any).age ? String((user as any).age) : "14"} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Nkaragrutyun (kamaygin)</label>
                <textarea rows={3} className={`${inputCls} resize-none`} value={profileForm.bio}
                  onChange={e => setProfileForm(f => ({ ...f, bio: e.target.value }))}
                  placeholder="Linel inchqez ..." />
              </div>
              <button type="submit" disabled={updateProfile.isPending}
                className="px-6 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-medium disabled:opacity-50 transition-all">
                {updateProfile.isPending ? "..." : "Պահպանել"}
              </button>
            </form>

            <div className="mt-4 bg-card/30 border border-white/10 rounded-2xl p-4">
              <h3 className="text-sm font-medium mb-2 text-muted-foreground">Linr tvyalner</h3>
              <div className="text-sm space-y-1">
                <div><span className="text-muted-foreground">Оgtanunum:</span> <span className="ml-2">{user.username}</span></div>
                {(user as any).email && <div><span className="text-muted-foreground">Email:</span> <span className="ml-2">{(user as any).email}</span></div>}
                {(user as any).age && <div><span className="text-muted-foreground">Тariq:</span> <span className="ml-2">{(user as any).age}</span></div>}
                {(user as any).bio && <div><span className="text-muted-foreground">Nkar:</span> <span className="ml-2 text-muted-foreground">{(user as any).bio}</span></div>}
              </div>
            </div>
          </div>
        )}

        {/* Bottom nav */}
        <div className="mt-8 pt-6 border-t border-white/10 flex flex-wrap gap-3 justify-center text-sm">
          <Link href="/progress" className="text-muted-foreground hover:text-primary transition-colors">📊 Արաջնթհաց</Link>
          <Link href="/books" className="text-muted-foreground hover:text-primary transition-colors">📚 գրքեր</Link>
          <Link href="/chat/0" className="text-muted-foreground hover:text-primary transition-colors">🤖 AI Chat</Link>
        </div>

      </div>
    </div>
  );
}
