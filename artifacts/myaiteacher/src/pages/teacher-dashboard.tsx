import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import QuickSwitch from "@/components/QuickSwitch";
import {
  useGetTeacherClasses,
  useGetClassStudents,
  useAddStudentToClass,
  useRemoveStudentFromClass,
  useGetClassCourses,
  useCreateCourse,
  useDeleteCourse,
  useGetCourseResources,
  useDeleteCourseResource,
  useGetCourseLessons,
  useCreateTeacherLesson,
  useUpdateTeacherLesson,
  useDeleteTeacherLesson,
  useGetTeacherSchedule,
  useGetStudentDetail,
  getGetTeacherClassesQueryKey,
  getGetClassStudentsQueryKey,
  getGetClassCoursesQueryKey,
  getGetCourseResourcesQueryKey,
  getGetCourseLessonsQueryKey,
  getGetTeacherScheduleQueryKey,
  getGetStudentDetailQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type MainView = "dashboard" | "class" | "course" | "student";
type ClassTab = "courses" | "students";

const RESOURCE_TYPES = [
  { key: "textbook",      icon: "📚", label: "Կցել գիրք" },
  { key: "curriculum",    icon: "📋", label: "Կցել ծրագիր" },
  { key: "thematic_plan", icon: "📑", label: "Կցել թեմատիկ պլան" },
  { key: "other",         icon: "📎", label: "Կցել այլ նյութեր" },
] as const;

const MONTHS_HY = ["Հունվ.", "Փետր.", "Մարտ", "Ապր.", "Մայիս", "Հունիս", "Հուլ.", "Օգոստ.", "Սեպտ.", "Հոկտ.", "Նոյ.", "Դեկտ."];

async function uploadResource(courseId: number, form: { type: string; title: string; description: string; file: File | null }) {
  const fd = new FormData();
  fd.append("type", form.type);
  fd.append("title", form.title);
  fd.append("description", form.description);
  if (form.file) fd.append("file", form.file);
  const token = localStorage.getItem("myaiteacher_token") ?? "";
  const res = await fetch(`/api/teacher/courses/${courseId}/resources`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export default function TeacherDashboard() {
  const { user, logout, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();

  const [mainView, setMainView] = useState<MainView>("dashboard");
  const [activeTab, setActiveTab] = useState<"schedule" | "classes">("schedule");
  const [classTab, setClassTab] = useState<ClassTab>("courses");

  const [selectedClass, setSelectedClass] = useState<{ id: number; name: string; grade: string } | null>(null);
  const [selectedCourse, setSelectedCourse] = useState<{ id: number; name: string } | null>(null);
  const [selectedStudentId, setSelectedStudentId] = useState<number | null>(null);

  const { data: schedule = [] } = useGetTeacherSchedule({ query: { queryKey: getGetTeacherScheduleQueryKey() } });
  const { data: classes = [] } = useGetTeacherClasses({ query: { queryKey: getGetTeacherClassesQueryKey() } });

  const { data: students = [] } = useGetClassStudents(
    selectedClass?.id ?? 0,
    { query: { enabled: !!selectedClass, queryKey: getGetClassStudentsQueryKey(selectedClass?.id ?? 0) } }
  );
  const { data: classCourses = [] } = useGetClassCourses(
    selectedClass?.id ?? 0,
    { query: { enabled: !!selectedClass && mainView === "class", queryKey: getGetClassCoursesQueryKey(selectedClass?.id ?? 0) } }
  );
  const { data: courseResources = [] } = useGetCourseResources(
    selectedCourse?.id ?? 0,
    { query: { enabled: !!selectedCourse, queryKey: getGetCourseResourcesQueryKey(selectedCourse?.id ?? 0) } }
  );
  const { data: courseLessons = [] } = useGetCourseLessons(
    selectedCourse?.id ?? 0,
    { query: { enabled: !!selectedCourse, queryKey: getGetCourseLessonsQueryKey(selectedCourse?.id ?? 0) } }
  );
  const { data: studentDetail } = useGetStudentDetail(
    selectedStudentId ?? 0,
    { query: { enabled: !!selectedStudentId, queryKey: getGetStudentDetailQueryKey(selectedStudentId ?? 0) } }
  );

  const addStudent = useAddStudentToClass();
  const removeStudent = useRemoveStudentFromClass();
  const createCourse = useCreateCourse();
  const deleteCourse = useDeleteCourse();
  const deleteResource = useDeleteCourseResource();
  const createLesson = useCreateTeacherLesson();
  const updateLesson = useUpdateTeacherLesson();
  const deleteLesson = useDeleteTeacherLesson();

  const [studentForm, setStudentForm] = useState({ fullName: "", email: "", age: "" });
  const [showStudentForm, setShowStudentForm] = useState(false);

  const handleAddStudent = (e: React.FormEvent) => {
    e.preventDefault(); if (!selectedClass) return;
    addStudent.mutate({ classId: selectedClass.id, data: {
      fullName: studentForm.fullName,
      email: (studentForm as any).email || undefined,
      age: (studentForm as any).age ? parseInt((studentForm as any).age) : undefined,
    } as any }, {
      onSuccess: () => { setShowStudentForm(false); setStudentForm({ fullName: "", email: "", age: "" }); qc.invalidateQueries({ queryKey: getGetClassStudentsQueryKey(selectedClass.id) }); },
    });
  };

  const [courseForm, setCourseForm] = useState({ name: "", description: "" });
  const [showCourseForm, setShowCourseForm] = useState(false);

  const handleCreateCourse = (e: React.FormEvent) => {
    e.preventDefault(); if (!selectedClass) return;
    createCourse.mutate({ classId: selectedClass.id, data: { name: courseForm.name, description: courseForm.description } }, {
      onSuccess: () => { setShowCourseForm(false); setCourseForm({ name: "", description: "" }); qc.invalidateQueries({ queryKey: getGetClassCoursesQueryKey(selectedClass.id) }); },
    });
  };

  const emptyResForm = { type: "textbook", title: "", description: "", file: null as File | null };
  const [resForm, setResForm] = useState(emptyResForm);
  const [showResForm, setShowResForm] = useState<string | null>(null);
  const [resUploading, setResUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleAddResource = async (e: React.FormEvent) => {
    e.preventDefault(); if (!selectedCourse || !resForm.title) return;
    setResUploading(true);
    try {
      await uploadResource(selectedCourse.id, resForm);
      setShowResForm(null); setResForm(emptyResForm); if (fileRef.current) fileRef.current.value = "";
      qc.invalidateQueries({ queryKey: getGetCourseResourcesQueryKey(selectedCourse.id) });
    } catch { /* ignore */ }
    finally { setResUploading(false); }
  };

  const emptyLesson = { title: "", lessonNumber: "", pagesFrom: "", pagesTo: "", month: "", day: "" };
  const [lessonForm, setLessonForm] = useState(emptyLesson);
  const [showLessonForm, setShowLessonForm] = useState(false);
  const [editLesson, setEditLesson] = useState<{ id: number } & typeof emptyLesson | null>(null);

  const handleCreateLesson = (e: React.FormEvent) => {
    e.preventDefault(); if (!selectedCourse) return;
    createLesson.mutate({ data: {
      courseId: selectedCourse.id,
      title: lessonForm.title,
      lessonNumber: lessonForm.lessonNumber ? parseInt(lessonForm.lessonNumber) : undefined,
      pagesFrom: lessonForm.pagesFrom ? parseInt(lessonForm.pagesFrom) : undefined,
      pagesTo: lessonForm.pagesTo ? parseInt(lessonForm.pagesTo) : undefined,
      month: lessonForm.month ? parseInt(lessonForm.month) : undefined,
      day: lessonForm.day ? parseInt(lessonForm.day) : undefined,
    } }, {
      onSuccess: () => { setShowLessonForm(false); setLessonForm(emptyLesson); qc.invalidateQueries({ queryKey: getGetCourseLessonsQueryKey(selectedCourse.id) }); },
    });
  };

  const handleUpdateLesson = (e: React.FormEvent) => {
    e.preventDefault(); if (!editLesson) return;
    updateLesson.mutate({ id: editLesson.id, data: {
      title: editLesson.title,
      lessonNumber: editLesson.lessonNumber ? parseInt(editLesson.lessonNumber) : undefined,
      pagesFrom: editLesson.pagesFrom ? parseInt(editLesson.pagesFrom) : undefined,
      pagesTo: editLesson.pagesTo ? parseInt(editLesson.pagesTo) : undefined,
      month: editLesson.month ? parseInt(editLesson.month) : undefined,
      day: editLesson.day ? parseInt(editLesson.day) : undefined,
    } }, {
      onSuccess: () => { setEditLesson(null); if (selectedCourse) qc.invalidateQueries({ queryKey: getGetCourseLessonsQueryKey(selectedCourse.id) }); },
    });
  };

  if (authLoading) return <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background"><div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  if (user?.role !== "teacher" && user?.role !== "admin") { setLocation("/login"); return null; }

  const inputCls = "w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50";
  const btnPrimary = "px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-medium disabled:opacity-50 transition-all hover:opacity-90";
  const btnOutline = "px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white hover:border-white/20 transition-colors";
  const btnGhost = "px-3 py-1 rounded-lg text-xs text-muted-foreground hover:text-white border border-transparent hover:border-white/10 transition-colors";
  const btnDanger = "px-3 py-1 rounded-lg text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors";

  // ── STUDENT DETAIL ────────────────────────────────────────────────────────
  if (mainView === "student" && selectedStudentId) {
    const hw = (studentDetail?.homework ?? []) as Array<{ id: number; title: string; task: string; status: string; score: number | null; feedback: string | null }>;
    return (
      <div className="min-h-[100dvh] bg-background text-white">
        <QuickSwitch />
        <header className="border-b border-white/10 px-6 py-4 flex items-center gap-3">
          <button onClick={() => setMainView("class")} className="text-muted-foreground hover:text-white text-sm transition-colors">← Վերադառնալ</button>
          <h1 className="text-lg font-bold">👨‍🎓 {studentDetail?.fullName}</h1>
          {studentDetail?.avgScore != null && (
            <span className="ml-auto px-3 py-1 rounded-full text-sm bg-primary/20 text-primary">Միջ. {studentDetail.avgScore}/100</span>
          )}
        </header>
        <div className="max-w-4xl mx-auto px-6 py-6">
          <h2 className="font-semibold mb-4">Տնային աշխատանքներ ({hw.length})</h2>
          {hw.length === 0 && <p className="text-muted-foreground text-sm">Տնային չկա</p>}
          <div className="space-y-3">
            {hw.map((h) => (
              <div key={h.id} className="bg-card/50 border border-white/10 rounded-xl p-4">
                <div className="flex items-start justify-between mb-2">
                  <div className="font-medium">{h.title}</div>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${h.status === "graded" ? "bg-teal-400/20 text-teal-400" : h.status === "submitted" ? "bg-amber-400/20 text-amber-400" : "bg-white/10 text-muted-foreground"}`}>
                    {h.status === "graded" ? `✓ ${h.score}/100` : h.status === "submitted" ? "Ներկայացված" : "Սպասում"}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{h.task}</p>
                {h.feedback && <p className="text-sm text-primary mt-2">💬 {h.feedback}</p>}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── COURSE PAGE ───────────────────────────────────────────────────────────
  if (mainView === "course" && selectedCourse) {
    const grouped = Object.fromEntries(RESOURCE_TYPES.map(t => [t.key, courseResources.filter(r => r.type === t.key)]));

    return (
      <div className="min-h-[100dvh] bg-background text-white">
        <QuickSwitch />
        <header className="border-b border-white/10 px-6 py-4 flex items-center gap-3">
          <button onClick={() => setMainView("class")} className="text-muted-foreground hover:text-white text-sm transition-colors">← {selectedClass?.name}</button>
          <div>
            <h1 className="text-lg font-bold">📖 {selectedCourse.name}</h1>
          </div>
          <span className="ml-auto text-sm text-muted-foreground">{user?.fullName}</span>
        </header>

        <div className="max-w-4xl mx-auto px-6 py-8 space-y-10">

          {/* ── RESOURCES ── */}
          <section>
            <h2 className="text-base font-semibold mb-5 text-white/90">📎 Կցված նյութեր</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {RESOURCE_TYPES.map(({ key, icon, label }) => {
                const docs = grouped[key] ?? [];
                const isOpen = showResForm === key;
                return (
                  <div key={key} className="bg-card/50 border border-white/10 rounded-2xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <span className="font-medium text-sm">{icon} {label.split(" ").slice(1).join(" ")}</span>
                      <button onClick={() => { setShowResForm(isOpen ? null : key); setResForm({ ...emptyResForm, type: key }); if (fileRef.current) fileRef.current.value = ""; }} className="text-xs px-2 py-1 rounded-lg bg-primary/20 text-primary hover:bg-primary/30 transition-colors">
                        {isOpen ? "Փակել" : "+ Կցել"}
                      </button>
                    </div>

                    {isOpen && (
                      <form onSubmit={handleAddResource} className="mb-3 space-y-2 border-t border-white/10 pt-3">
                        <input value={resForm.title} onChange={e => setResForm(f => ({ ...f, title: e.target.value }))} required className={inputCls} placeholder="Անվանումը *" />
                        <input value={resForm.description} onChange={e => setResForm(f => ({ ...f, description: e.target.value }))} className={inputCls} placeholder="Նկարագրություն (ըստ ցանկության)" />
                        <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.mp4,.mov" onChange={e => setResForm(f => ({ ...f, file: e.target.files?.[0] ?? null }))}
                          className="w-full text-xs text-muted-foreground file:mr-2 file:py-1 file:px-2 file:rounded-lg file:border-0 file:bg-primary/20 file:text-primary hover:file:bg-primary/30 cursor-pointer" />
                        <div className="flex gap-2">
                          <button type="submit" disabled={resUploading} className={btnPrimary + " text-xs py-1"}>{resUploading ? "Բեռնվում..." : "Ավելացնել"}</button>
                          <button type="button" onClick={() => { setShowResForm(null); if (fileRef.current) fileRef.current.value = ""; }} className={btnOutline + " text-xs py-1"}>Չեղարկել</button>
                        </div>
                      </form>
                    )}

                    {docs.length === 0 && !isOpen && <p className="text-xs text-muted-foreground/60">Նյութ չկա</p>}
                    <div className="space-y-1.5">
                      {docs.map(d => (
                        <div key={d.id} className="flex items-center gap-2 bg-background/40 rounded-lg px-2 py-1.5">
                          <span className="text-xs flex-1 truncate">{d.title}</span>
                          {d.fileUrl && <a href={d.fileUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-teal-400 hover:underline shrink-0">⬇</a>}
                          <button onClick={() => { if (!selectedCourse || !confirm("Ջնջե՞լ?")) return; deleteResource.mutate({ courseId: selectedCourse.id, resourceId: d.id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getGetCourseResourcesQueryKey(selectedCourse.id) }) }); }} className="text-xs text-muted-foreground hover:text-destructive shrink-0">🗑</button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ── LESSONS ── */}
          <section>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold text-white/90">📝 Դասեր ({courseLessons.length})</h2>
              <button onClick={() => { setShowLessonForm(f => !f); setEditLesson(null); }} className={btnPrimary}>+ Ավելացնել դաս</button>
            </div>

            {showLessonForm && (
              <form onSubmit={handleCreateLesson} className="mb-5 bg-card/50 border border-white/10 rounded-2xl p-5 space-y-3">
                <h3 className="font-medium text-sm">Նոր դաս</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Դ. #</label>
                    <input type="number" min="1" value={lessonForm.lessonNumber} onChange={e => setLessonForm(f => ({ ...f, lessonNumber: e.target.value }))} className={inputCls} placeholder="1" />
                  </div>
                  <div className="col-span-3">
                    <label className="text-xs text-muted-foreground mb-1 block">Վերնագիր *</label>
                    <input value={lessonForm.title} onChange={e => setLessonForm(f => ({ ...f, title: e.target.value }))} required className={inputCls} placeholder="օր. Թվաբանություն" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Էջ (այսին)</label>
                    <input type="number" min="1" value={lessonForm.pagesFrom} onChange={e => setLessonForm(f => ({ ...f, pagesFrom: e.target.value }))} className={inputCls} placeholder="5" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Էջ (մինչև)</label>
                    <input type="number" min="1" value={lessonForm.pagesTo} onChange={e => setLessonForm(f => ({ ...f, pagesTo: e.target.value }))} className={inputCls} placeholder="15" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Ամիս</label>
                    <select value={lessonForm.month} onChange={e => setLessonForm(f => ({ ...f, month: e.target.value }))} className={inputCls}>
                      <option value="">—</option>
                      {MONTHS_HY.map((m, i) => <option key={i+1} value={i+1}>{m}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Ամսաթիվ</label>
                    <input type="number" min="1" max="31" value={lessonForm.day} onChange={e => setLessonForm(f => ({ ...f, day: e.target.value }))} className={inputCls} placeholder="12" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button type="submit" disabled={createLesson.isPending} className={btnPrimary}>{createLesson.isPending ? "..." : "Պահպանել"}</button>
                  <button type="button" onClick={() => setShowLessonForm(false)} className={btnOutline}>Չեղարկել</button>
                </div>
              </form>
            )}

            {editLesson && (
              <form onSubmit={handleUpdateLesson} className="mb-5 bg-primary/5 border border-primary/20 rounded-2xl p-5 space-y-3">
                <h3 className="font-medium text-sm">Խմբագրել դաս</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Դ. #</label>
                    <input type="number" value={editLesson.lessonNumber} onChange={e => setEditLesson(l => l && ({ ...l, lessonNumber: e.target.value }))} className={inputCls} />
                  </div>
                  <div className="col-span-3">
                    <label className="text-xs text-muted-foreground mb-1 block">Վերնագիր *</label>
                    <input value={editLesson.title} onChange={e => setEditLesson(l => l && ({ ...l, title: e.target.value }))} required className={inputCls} />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Էջ (այsин)</label>
                    <input type="number" value={editLesson.pagesFrom} onChange={e => setEditLesson(l => l && ({ ...l, pagesFrom: e.target.value }))} className={inputCls} />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Էջ (мінchev)</label>
                    <input type="number" value={editLesson.pagesTo} onChange={e => setEditLesson(l => l && ({ ...l, pagesTo: e.target.value }))} className={inputCls} />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Ամիս</label>
                    <select value={editLesson.month} onChange={e => setEditLesson(l => l && ({ ...l, month: e.target.value }))} className={inputCls}>
                      <option value="">—</option>
                      {MONTHS_HY.map((m, i) => <option key={i+1} value={i+1}>{m}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Ամsаthiv</label>
                    <input type="number" min="1" max="31" value={editLesson.day} onChange={e => setEditLesson(l => l && ({ ...l, day: e.target.value }))} className={inputCls} />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button type="submit" className={btnPrimary}>Պахрapanel</button>
                  <button type="button" onClick={() => setEditLesson(null)} className={btnOutline}>Чeghаrkel</button>
                </div>
              </form>
            )}

            {courseLessons.length === 0 && !showLessonForm && (
              <div className="text-center py-10 text-muted-foreground">
                <div className="text-4xl mb-3">📝</div>
                <p className="text-sm">Դաս չկա · Ստեղծեք առաջին դասը</p>
              </div>
            )}
            <div className="space-y-2">
              {[...courseLessons]
                .sort((a, b) => ((a as any).lessonNumber ?? 9999) - ((b as any).lessonNumber ?? 9999))
                .map((l) => {
                  const month = (l as any).month as number | null;
                  const day = (l as any).day as number | null;
                  const dateStr = month && day ? `${day} ${MONTHS_HY[month - 1]}` : month ? MONTHS_HY[month - 1] : null;
                  return (
                    <div key={l.id} className="bg-card/50 border border-white/10 rounded-xl px-4 py-3 flex items-center gap-3">
                      <span className="text-xs font-mono text-primary/70 w-8 shrink-0 text-center">
                        {(l as any).lessonNumber ? `${(l as any).lessonNumber}` : "—"}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">{l.title}</div>
                        <div className="flex gap-3 mt-0.5">
                          {((l as any).pagesFrom || (l as any).pagesTo) && (
                            <span className="text-xs text-muted-foreground">📄 {(l as any).pagesFrom ?? "?"}–{(l as any).pagesTo ?? "?"} էջ</span>
                          )}
                          {dateStr && <span className="text-xs text-teal-400/80">📅 {dateStr}</span>}
                        </div>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <button onClick={() => { setEditLesson({ id: l.id, title: l.title, lessonNumber: String((l as any).lessonNumber ?? ""), pagesFrom: String((l as any).pagesFrom ?? ""), pagesTo: String((l as any).pagesTo ?? ""), month: String((l as any).month ?? ""), day: String((l as any).day ?? "") }); setShowLessonForm(false); }} className={btnGhost}>✏️</button>
                        <button onClick={() => { if (!selectedCourse || !confirm("Ջнջе՞l?")) return; deleteLesson.mutate({ id: l.id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getGetCourseLessonsQueryKey(selectedCourse.id) }) }); }} className={btnDanger}>🗑</button>
                      </div>
                    </div>
                  );
                })}
            </div>
          </section>
        </div>
      </div>
    );
  }

  // ── CLASS PAGE ────────────────────────────────────────────────────────────
  if (mainView === "class" && selectedClass) {
    return (
      <div className="min-h-[100dvh] bg-background text-white">
        <QuickSwitch />
        <header className="border-b border-white/10 px-6 py-4 flex items-center gap-3">
          <button onClick={() => setMainView("dashboard")} className="text-muted-foreground hover:text-white text-sm transition-colors">← Վահանակ</button>
          <div>
            <h1 className="text-lg font-bold">📚 {selectedClass.name}</h1>
            {selectedClass.grade && <p className="text-xs text-muted-foreground">{selectedClass.grade}</p>}
          </div>
          <span className="ml-auto text-sm text-muted-foreground">{user?.fullName}</span>
        </header>

        <div className="max-w-5xl mx-auto px-6 py-6">
          <div className="flex gap-1 mb-6 border-b border-white/10">
            {(["courses", "students"] as const).map(t => (
              <button key={t} onClick={() => setClassTab(t)}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${classTab === t ? "border-primary text-white" : "border-transparent text-muted-foreground hover:text-white"}`}>
                {t === "courses" ? "📖 Դասընթացներ" : "👨‍🎓 Աշակerter"}
              </button>
            ))}
          </div>

          {/* COURSES TAB */}
          {classTab === "courses" && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold">Դasyntatsner ({classCourses.length})</h2>
                <button onClick={() => setShowCourseForm(f => !f)} className={btnPrimary}>+ Avaelacnel</button>
              </div>

              {showCourseForm && (
                <form onSubmit={handleCreateCourse} className="mb-5 bg-card/50 border border-white/10 rounded-2xl p-5 space-y-3">
                  <h3 className="font-medium text-sm">Դասընթաց Դասընթաց</h3>
                  <input value={courseForm.name} onChange={e => setCourseForm(f => ({ ...f, name: e.target.value }))} required className={inputCls} placeholder="oр. Գрагируtyun..." />
                  <input value={courseForm.description} onChange={e => setCourseForm(f => ({ ...f, description: e.target.value }))} className={inputCls} placeholder="Нkarаgrutyun" />
                  <div className="flex gap-2">
                    <button type="submit" disabled={createCourse.isPending} className={btnPrimary}>{createCourse.isPending ? "..." : "Պահպանել"}</button>
                    <button type="button" onClick={() => setShowCourseForm(false)} className={btnOutline}>Չեղարկել</button>
                  </div>
                </form>
              )}

              {classCourses.length === 0 && !showCourseForm && (
                <div className="text-center py-16 text-muted-foreground">
                  <div className="text-5xl mb-4">📖</div>
                  <p>Դասընթաց չka</p>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {classCourses.map(c => (
                  <div key={c.id} className="bg-card/60 border border-white/10 rounded-2xl p-5 hover:border-primary/40 hover:bg-primary/5 transition-all group">
                    <div className="flex items-start justify-between mb-3">
                      <div className="text-2xl">📖</div>
                      <button onClick={() => { if (!confirm("Ջնջել " + c.name + "?")) return; deleteCourse.mutate({ courseId: c.id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getGetClassCoursesQueryKey(selectedClass.id) }) }); }} className="opacity-0 group-hover:opacity-100 text-xs text-muted-foreground hover:text-destructive transition-all">🗑</button>
                    </div>
                    <div className="font-semibold mb-1">{c.name}</div>
                    {c.description && <div className="text-xs text-muted-foreground mb-3">{c.description}</div>}
                    <button onClick={() => { setSelectedCourse({ id: c.id, name: c.name }); setMainView("course"); }} className="mt-2 w-full text-xs text-primary font-medium py-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 transition-colors">
                      Mtnel →
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STUDENTS TAB */}
          {classTab === "students" && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold">Աշակերտներ ({students.length})</h2>
                <button onClick={() => setShowStudentForm(f => !f)} className={btnPrimary}>+ Аvelacel</button>
              </div>
              {showStudentForm && (
                <form onSubmit={handleAddStudent} className="mb-5 bg-card/50 border border-white/10 rounded-2xl p-5 space-y-3">
                  <h3 className="font-medium text-sm">Nor аshаkert</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2"><label className="text-xs text-muted-foreground">Аnun Аzgаnun *</label><input value={studentForm.fullName} onChange={e => setStudentForm(f => ({ ...f, fullName: e.target.value }))} required className={inputCls} placeholder="Аshakerti аnuny" /></div>
                    <div><label className="text-xs text-muted-foreground">Email</label><input type="email" value={(studentForm as any).email} onChange={e => setStudentForm(f => ({ ...f, email: e.target.value } as any))} className={inputCls} placeholder="example@mail.com" /></div>
                    <div><label className="text-xs text-muted-foreground">Таriq</label><input type="number" min="5" max="25" value={(studentForm as any).age} onChange={e => setStudentForm(f => ({ ...f, age: e.target.value } as any))} className={inputCls} placeholder="14" /></div>
                  </div>
                  <p className="text-xs text-muted-foreground/60">Аlginаbаry klini "student123"</p>
                  <div className="flex gap-2">
                    <button type="submit" disabled={addStudent.isPending} className={btnPrimary}>{addStudent.isPending ? "..." : "Պահպանել"}</button>
                    <button type="button" onClick={() => setShowStudentForm(false)} className={btnOutline}>Չեղարկել</button>
                  </div>
                </form>
              )}
              <div className="space-y-2">
                {students.length === 0 && <p className="text-muted-foreground text-sm py-6 text-center">Аshаkert chkа</p>}
                {students.map(s => (
                  <div key={s.id} className="bg-card/50 border border-white/10 rounded-xl px-4 py-3 flex items-center justify-between">
                    <div>
                      <div className="font-medium">{s.fullName}</div>
                      <div className="text-xs text-muted-foreground">{(s as any).email || s.username}</div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => { setSelectedStudentId(s.id); setMainView("student"); }} className={btnGhost}>🔍 Мanramans</button>
                      <button onClick={() => { if (!confirm("Нeracel Dasaranits?")) return; removeStudent.mutate({ classId: selectedClass.id, studentId: s.id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getGetClassStudentsQueryKey(selectedClass.id) }) }); }} className={btnDanger}>Нeracel</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── MAIN DASHBOARD ────────────────────────────────────────────────────────
  return (
    <div className="min-h-[100dvh] bg-background text-white">
      <QuickSwitch />
      <header className="border-b border-white/10 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">👨‍🏫 Ուսուցիչ Вahаnak</h1>
          <p className="text-xs text-muted-foreground">Karhanyan School · myaiteacher</p>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">{user?.fullName}</span>
          <button onClick={logout} className="text-sm text-destructive hover:text-white transition-colors">Ելք</button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-6">
        <div className="flex gap-1 mb-8 border-b border-white/10">
          {(["schedule", "classes"] as const).map(t => (
            <button key={t} onClick={() => setActiveTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${activeTab === t ? "border-primary text-white" : "border-transparent text-muted-foreground hover:text-white"}`}>
              {t === "schedule" ? "📅 Իմ Դասացուցակը" : "📚 Իմ Դասարանները"}
            </button>
          ))}
        </div>

        {activeTab === "schedule" && (
          <div>
            {schedule.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <div className="text-5xl mb-4">📅</div>
                <p>Իմ Դասացուցակը չka</p>
              </div>
            ) : (
              <div className="space-y-6">
                {["Երկuшаbti","Еreqshаbti","Chorеqshаbti","Нingshаbti","Urbаt","Shаbаt"].map(day => {
                  const items = schedule.filter(s => s.day === day || s.day.startsWith(day.slice(0,4)));
                  return items.length > 0 ? (
                    <div key={day}>
                      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">{day}</h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {items.sort((a, b) => a.time.localeCompare(b.time)).map(s => (
                          <div key={s.id} className="bg-card/60 border border-white/10 rounded-xl p-4">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-teal-400 font-mono text-sm font-bold">{s.time}</span>
                              <span className="text-xs text-muted-foreground">{s.className}</span>
                            </div>
                            <div className="font-medium">{s.subject}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null;
                })}
                {!["Երkushаbti","Еreqshаbti","Chorеqshаbti","Нingshаbti","Urbаt","Shаbаt"].some(d => schedule.some(s => s.day === d || s.day.startsWith(d.slice(0,4)))) && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {schedule.map(s => (
                      <div key={s.id} className="bg-card/60 border border-white/10 rounded-xl p-4">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-teal-400 font-mono text-sm font-bold">{s.time}</span>
                          <span className="text-xs text-muted-foreground">{s.className}</span>
                        </div>
                        <div className="font-medium">{s.subject}</div>
                        <div className="text-xs text-muted-foreground mt-1">{s.day}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === "classes" && (
          <div>
            {classes.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <div className="text-5xl mb-4">📚</div>
                <p>Դասընթացներ чka</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {classes.map(c => (
                  <button key={c.id} onClick={() => { setSelectedClass({ id: c.id, name: c.name, grade: c.grade }); setClassTab("courses"); setMainView("class"); }}
                    className="bg-card/60 border border-white/10 rounded-2xl p-6 text-left hover:border-primary/40 hover:bg-primary/5 transition-all group">
                    <div className="text-3xl mb-3">📚</div>
                    <div className="font-semibold text-lg mb-1 group-hover:text-primary transition-colors">{c.name}</div>
                    {c.grade && <div className="text-sm text-muted-foreground mb-3">{c.grade}</div>}
                    <div className="text-xs text-muted-foreground">
                      👨‍🎓 {(c as any).studentCount ?? 0} {((c as any).studentCount === 1) ? "Աշակերտ" : "Աշակերտ"}
                    </div>
                    <div className="mt-4 text-xs text-primary font-medium opacity-0 group-hover:opacity-100 transition-opacity">Бacel →</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
