import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import QuickSwitch from "@/components/QuickSwitch";
import {
  useGetDashboard,
  useGetProgress,
  useGetHomework,
  useGetStudentSchedule,
  useGetStudentTeachers,
  useGetStudentHomeworkSummary,
  useSubmitHomework,
  getGetDashboardQueryKey,
  getGetProgressQueryKey,
  getGetHomeworkQueryKey,
  getGetStudentScheduleQueryKey,
  getGetStudentTeachersQueryKey,
  getGetStudentHomeworkSummaryQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type Tab = "overview" | "schedule" | "subjects" | "homework" | "teachers";

const DAYS = ["Երկուշաբթի", "Երեքշաբթի", "Չորեքշաբթի", "Հինգշաբթի", "Ուրբաթ", "Շաբաթ"];

export default function Dashboard() {
  const { user, token, logout, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("overview");
  const [submitHwId, setSubmitHwId] = useState<number | null>(null);
  const [answerText, setAnswerText] = useState("");
  const submitMutation = useSubmitHomework();

  useEffect(() => {
    if (!authLoading && !token) setLocation("/login");
  }, [token, authLoading, setLocation]);

  const { data: dashboard, isLoading: dashLoading } = useGetDashboard({ query: { queryKey: getGetDashboardQueryKey(), enabled: !!token } });
  const { data: progressData } = useGetProgress({ query: { queryKey: getGetProgressQueryKey(), enabled: !!token } });
  const { data: schedule = [] } = useGetStudentSchedule({ query: { queryKey: getGetStudentScheduleQueryKey(), enabled: !!token } });
  const { data: teachers = [] } = useGetStudentTeachers({ query: { queryKey: getGetStudentTeachersQueryKey(), enabled: !!token } });
  const { data: hwSummary } = useGetStudentHomeworkSummary({ query: { queryKey: getGetStudentHomeworkSummaryQueryKey(), enabled: !!token } });
  const { data: homeworkList = [] } = useGetHomework({ query: { queryKey: getGetHomeworkQueryKey(), enabled: !!token && tab === "homework" } });

  if (authLoading || dashLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!user) return null;

  // today's schedule — hy-AM locale weekday → Armenian day name
  const todayArm = new Date().toLocaleDateString("hy-AM", { weekday: "long" });
  // Normalise: drop trailing dot if any, lowercase compare
  const todayItems = schedule.filter((s) =>
    s.day.toLowerCase().replace(/[.]/g, "") === todayArm.toLowerCase().replace(/[.]/g, "")
  );

  // homework counts (prefer hwSummary if available, fallback to homeworkList)
  const notSubmitted = hwSummary?.notSubmitted ?? homeworkList.filter(h => h.status === "not_submitted").length;
  const pendingHw = hwSummary?.pending ?? homeworkList.filter(h => h.status === "pending").length;
  const gradedHw = hwSummary?.graded ?? homeworkList.filter(h => h.status === "graded").length;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!submitHwId) return;
    submitMutation.mutate({ homeworkId: submitHwId, data: { answer: answerText } }, {
      onSuccess: () => {
        setSubmitHwId(null);
        setAnswerText("");
        qc.invalidateQueries({ queryKey: getGetStudentHomeworkSummaryQueryKey() });
        qc.invalidateQueries({ queryKey: getGetHomeworkQueryKey() });
      },
    });
  };

  const inputCls = "w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50";

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "🏠 Ընդհանուր" },
    { key: "schedule", label: "📅 Դասացուցակ" },
    { key: "subjects", label: "📚 Առարկաներ" },
    { key: "homework", label: `📝 Տնային${notSubmitted > 0 ? ` (${notSubmitted})` : ""}` },
    { key: "teachers", label: "👨‍🏫 Ուսուցիչներ" },
  ];

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
          <p className="text-muted-foreground text-sm mt-1">Ահա քո ուսման ընթացիկ առաջընթացը</p>
        </div>

        {/* Quick stats always visible */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          {[
            { icon: "✅", label: "Ավարտված դասեր", value: dashboard?.stats.completedLessons ?? 0, color: "text-teal-400" },
            { icon: "⭐", label: "Միջին գնահատական", value: dashboard?.stats.averageScore ?? 0, color: "text-amber-400" },
            { icon: "📝", label: "Չներկայացված", value: notSubmitted, color: "text-red-400" },
            { icon: "📈", label: "Առաջընթաց", value: `${dashboard?.stats.overallProgress ?? 0}%`, color: "text-primary" },
          ].map((s) => (
            <div key={s.label} className="bg-card/60 border border-white/10 rounded-2xl p-4">
              <div className="text-2xl mb-1">{s.icon}</div>
              <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
              <div className="text-xs text-muted-foreground mt-1">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Today's schedule highlight */}
        {todayItems.length > 0 && (
          <div className="mb-6 bg-primary/10 border border-primary/20 rounded-2xl p-4">
            <h3 className="text-sm font-medium text-primary mb-3">📅 Այսօր իմ դասերը</h3>
            <div className="flex flex-wrap gap-2">
              {todayItems.sort((a, b) => a.time.localeCompare(b.time)).map((s) => (
                <div key={s.id} className="flex items-center gap-2 bg-background/50 border border-white/10 rounded-xl px-3 py-2">
                  <span className="text-teal-400 font-mono text-xs font-bold">{s.time}</span>
                  <span className="text-sm font-medium">{s.subject}</span>
                  <span className="text-xs text-muted-foreground">· {s.className}</span>
                </div>
              ))}
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
                  <h2 className="font-semibold">Առարկաներ</h2>
                  <button onClick={() => setTab("subjects")} className="text-xs text-primary hover:underline">Բոլոր →</button>
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
                        <span>{sub.completedLessons}/{sub.totalLessons} դաս</span>
                        <span>{Math.round(sub.progressPercent)}%</span>
                      </div>
                      <div className="h-1.5 w-full bg-background rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-primary to-secondary rounded-full" style={{ width: `${sub.progressPercent}%` }} />
                      </div>
                    </Link>
                  ))}
                  {(dashboard?.subjects ?? []).length === 0 && (
                    <p className="text-muted-foreground text-sm col-span-2">Առարկաներ չկան</p>
                  )}
                </div>
              </div>

              {/* Recent activity */}
              {(dashboard?.recentActivity ?? []).length > 0 && (
                <div>
                  <h2 className="font-semibold mb-4">Վերջին ակտիվություն</h2>
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
                <h3 className="font-semibold mb-4">🗺️ Գիտելիքի Քարտեզ</h3>
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
                    <p className="text-muted-foreground text-xs">Տվյալներ չկան</p>
                  )}
                </div>
                <Link href="/progress" className="mt-4 text-primary text-xs font-medium hover:underline block">Ամբողջական քարտեզ →</Link>
              </div>

              {/* Homework mini */}
              <div className="bg-card/60 border border-white/10 rounded-2xl p-5">
                <h3 className="font-semibold mb-4">📝 Տնային աշխատանք</h3>
                <div className="space-y-2 text-sm mb-4">
                  <div className="flex justify-between"><span className="text-red-400">Չներկայացված</span><span className="font-bold">{notSubmitted}</span></div>
                  <div className="flex justify-between"><span className="text-amber-400">Սպասում է</span><span className="font-bold">{pendingHw}</span></div>
                  <div className="flex justify-between"><span className="text-teal-400">Գնահատված</span><span className="font-bold">{gradedHw}</span></div>
                </div>
                <button onClick={() => setTab("homework")} className="text-primary text-xs font-medium hover:underline">Բոլոր տնայինները →</button>
              </div>

              {/* Teachers mini */}
              {teachers.length > 0 && (
                <div className="bg-card/60 border border-white/10 rounded-2xl p-5">
                  <h3 className="font-semibold mb-3">👨‍🏫 Իմ ուսուցիչները</h3>
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
                  {teachers.length > 3 && <button onClick={() => setTab("teachers")} className="mt-3 text-primary text-xs font-medium hover:underline">Բոլոր ({teachers.length}) →</button>}
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
                <p>Դասացուցակ չկա · Ադմինը կամ ուսուցիչը պետք է ավելացնի</p>
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
                          <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded-full">Այսօր</span>
                        )}
                      </h3>
                      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {items.sort((a, b) => a.time.localeCompare(b.time)).map((s) => (
                          <div key={s.id} className="bg-card/60 border border-white/10 rounded-xl p-4">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-teal-400 font-mono text-sm font-bold">{s.time}</span>
                              <span className="text-xs text-muted-foreground">{s.className}</span>
                            </div>
                            <div className="font-medium mb-1">{s.subject}</div>
                            <div className="text-xs text-muted-foreground">👨‍🏫 {s.teacherName}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {/* Fallback: show all if none match day names */}
                {!DAYS.some(day => schedule.some(s => s.day === day || s.day.startsWith(day.slice(0,5)))) && (
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {schedule.map((s) => (
                      <div key={s.id} className="bg-card/60 border border-white/10 rounded-xl p-4">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-teal-400 font-mono text-sm font-bold">{s.time}</span>
                          <span className="text-xs text-muted-foreground">{s.day}</span>
                        </div>
                        <div className="font-medium mb-1">{s.subject}</div>
                        <div className="text-xs text-muted-foreground">👨‍🏫 {s.teacherName} · {s.className}</div>
                      </div>
                    ))}
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
                <p>Առարկաներ չկան</p>
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
                          {level === "mastered" ? "🟢 Յուրացված" : level === "weak" ? "🟡 Թույլ" : "🔴 Չսկսած"}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm text-muted-foreground mb-2">
                        <span>{sub.completedLessons}/{sub.totalLessons} դաս</span>
                        <span className="font-medium text-white">{pct}%</span>
                      </div>
                      <div className="h-2 w-full bg-background rounded-full overflow-hidden mb-3">
                        <div className={`h-full rounded-full ${level === "mastered" ? "bg-teal-400" : level === "weak" ? "bg-amber-400" : "bg-red-500"}`}
                          style={{ width: `${pct}%` }} />
                      </div>
                      <div className="text-xs text-secondary font-medium">Միջ․ {Math.round(sub.averageScore)} մ.</div>
                      <div className="mt-3 text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity">Դիտել →</div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── HOMEWORK ── */}
        {tab === "homework" && (
          <div>
            {/* Submit modal */}
            {submitHwId !== null && (
              <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                <form onSubmit={handleSubmit} className="bg-card border border-white/10 rounded-2xl p-6 w-full max-w-md space-y-4">
                  <h3 className="font-semibold">Ներկայացնել պատասխան</h3>
                  <textarea value={answerText} onChange={e => setAnswerText(e.target.value)} required rows={5}
                    placeholder="Ձեր պատասխանը..." className={`${inputCls} resize-none`} />
                  <div className="flex gap-2">
                    <button type="submit" disabled={submitMutation.isPending} className="px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-medium disabled:opacity-50">
                      {submitMutation.isPending ? "..." : "Ուղարկել"}
                    </button>
                    <button type="button" onClick={() => { setSubmitHwId(null); setAnswerText(""); }}
                      className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white">Չեղարկել</button>
                  </div>
                </form>
              </div>
            )}

            {/* HW from hwSummary items */}
            {(() => {
              type HwRow = { id: number; title: string; task: string; status: string; score: number | null; feedback: string | null; lessonTitle: string; createdAt: string };
              const items = (hwSummary?.items ?? []) as HwRow[];
              const all: HwRow[] = items.length > 0 ? items : homeworkList.map(h => ({
                id: h.id, title: h.title, task: h.task, status: h.status,
                score: h.score ?? null, feedback: null, lessonTitle: h.lessonTitle ?? "", createdAt: h.createdAt,
              }));
              if (all.length === 0) return (
                <div className="text-center py-20 text-muted-foreground">
                  <div className="text-5xl mb-4">📝</div>
                  <p>Տնային չկա</p>
                </div>
              );
              const groups = { not_submitted: [] as typeof all, pending: [] as typeof all, graded: [] as typeof all };
              all.forEach(h => {
                if (h.status === "graded") groups.graded.push(h);
                else if (h.status === "submitted" || h.status === "pending") groups.pending.push(h);
                else groups.not_submitted.push(h);
              });
              return (
                <div className="space-y-6">
                  {groups.not_submitted.length > 0 && (
                    <div>
                      <h2 className="text-sm font-medium text-red-400 uppercase tracking-wide mb-3">🔴 Չներկայացված ({groups.not_submitted.length})</h2>
                      <div className="space-y-2">
                        {groups.not_submitted.map(h => (
                          <div key={h.id} className="bg-card/60 border border-red-500/20 rounded-xl px-4 py-3 flex items-start justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-sm">{h.title}</div>
                              <div className="text-xs text-muted-foreground truncate">{h.task}</div>
                              {h.lessonTitle && <div className="text-xs text-primary mt-1">📖 {h.lessonTitle}</div>}
                            </div>
                            <button onClick={() => setSubmitHwId(h.id)}
                              className="px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-medium shrink-0 hover:bg-primary/80 transition-colors">
                              Ներկայացնել
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {groups.pending.length > 0 && (
                    <div>
                      <h2 className="text-sm font-medium text-amber-400 uppercase tracking-wide mb-3">🟡 Սպասում է գնահատման ({groups.pending.length})</h2>
                      <div className="space-y-2">
                        {groups.pending.map(h => (
                          <div key={h.id} className="bg-card/60 border border-amber-500/20 rounded-xl px-4 py-3">
                            <div className="font-medium text-sm">{h.title}</div>
                            <div className="text-xs text-muted-foreground mt-1 truncate">{h.task}</div>
                            {h.lessonTitle && <div className="text-xs text-primary mt-1">📖 {h.lessonTitle}</div>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {groups.graded.length > 0 && (
                    <div>
                      <h2 className="text-sm font-medium text-teal-400 uppercase tracking-wide mb-3">🟢 Gnahatval ({groups.graded.length})</h2>
                      <div className="space-y-2">
                        {groups.graded.map(h => (
                          <div key={h.id} className="bg-card/60 border border-teal-500/20 rounded-xl px-4 py-3">
                            <div className="flex items-center justify-between mb-1">
                              <div className="font-medium text-sm">{h.title}</div>
                              {h.score !== null && <span className="text-teal-400 font-bold text-sm">{h.score}/100</span>}
                            </div>
                            {h.lessonTitle && <div className="text-xs text-primary">📖 {h.lessonTitle}</div>}
                            {h.feedback && <div className="text-xs text-muted-foreground mt-2 border-t border-white/10 pt-2">💬 {h.feedback}</div>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {/* ── TEACHERS ── */}
        {tab === "teachers" && (
          <div>
            {teachers.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground">
                <div className="text-5xl mb-4">👨‍🏫</div>
                <p>Ուսուցիչ չկա · Ադմինը պետք է նշանակի</p>
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

        {/* Bottom nav links */}
        <div className="mt-8 pt-6 border-t border-white/10 flex flex-wrap gap-3 justify-center text-sm">
          <Link href="/progress" className="text-muted-foreground hover:text-primary transition-colors">📊 Առաջընթաց</Link>
          <Link href="/homework" className="text-muted-foreground hover:text-primary transition-colors">📝 Բոլոր Տնայինը</Link>
          <Link href="/books" className="text-muted-foreground hover:text-primary transition-colors">📚 Գրքեր</Link>
          <Link href="/chat/0" className="text-muted-foreground hover:text-primary transition-colors">🤖 AI Chat</Link>
        </div>
      </div>
    </div>
  );
}
