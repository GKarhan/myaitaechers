import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import {
  useGetTeacherClasses,
  useGetClassStudents,
  useAddStudentToClass,
  useRemoveStudentFromClass,
  useGetClassLessons,
  useGetTeacherLessons,
  useCreateTeacherLesson,
  useUpdateTeacherLesson,
  useDeleteTeacherLesson,
  useGenerateLessonsAI,
  useGetClassHomework,
  useCreateHomework,
  useGradeHomework,
  useGetTeacherSchedule,
  useGetStudentDetail,
  useGetSubjects,
  getGetTeacherClassesQueryKey,
  getGetClassStudentsQueryKey,
  getGetClassLessonsQueryKey,
  getGetTeacherScheduleQueryKey,
  getGetClassHomeworkQueryKey,
  getGetStudentDetailQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type MainView = "dashboard" | "class" | "student";
type ClassTab = "students" | "lessons" | "homework";

const BLOOM = ["", "Հіshel", "Haskanal", "Kirarkel", "Verlucel", "Gnahatel", "Stexcel"];

export default function TeacherDashboard() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();

  const [mainView, setMainView] = useState<MainView>("dashboard");
  const [activeTab, setActiveTab] = useState<"schedule" | "classes">("schedule");
  const [selectedClass, setSelectedClass] = useState<{ id: number; name: string; grade: string } | null>(null);
  const [classTab, setClassTab] = useState<ClassTab>("students");
  const [selectedStudentId, setSelectedStudentId] = useState<number | null>(null);

  // ── data ──────────────────────────────────────────────────────────────────
  const { data: schedule = [] } = useGetTeacherSchedule({ query: { queryKey: getGetTeacherScheduleQueryKey() } });
  const { data: classes = [] } = useGetTeacherClasses({ query: { queryKey: getGetTeacherClassesQueryKey() } });
  const { data: subjects = [] } = useGetSubjects();

  const { data: students = [] } = useGetClassStudents(
    selectedClass?.id ?? 0,
    { query: { enabled: !!selectedClass, queryKey: getGetClassStudentsQueryKey(selectedClass?.id ?? 0) } }
  );
  const { data: classLessons = [] } = useGetClassLessons(
    selectedClass?.id ?? 0,
    { query: { enabled: !!selectedClass, queryKey: getGetClassLessonsQueryKey(selectedClass?.id ?? 0) } }
  );
  const { data: classHomework = [] } = useGetClassHomework(
    selectedClass?.id ?? 0,
    { query: { enabled: !!selectedClass, queryKey: getGetClassHomeworkQueryKey(selectedClass?.id ?? 0) } }
  );
  const { data: studentDetail } = useGetStudentDetail(
    selectedStudentId ?? 0,
    { query: { enabled: !!selectedStudentId, queryKey: getGetStudentDetailQueryKey(selectedStudentId ?? 0) } }
  );

  // ── mutations ─────────────────────────────────────────────────────────────
  const addStudent = useAddStudentToClass();
  const removeStudent = useRemoveStudentFromClass();
  const createLesson = useCreateTeacherLesson();
  const updateLesson = useUpdateTeacherLesson();
  const deleteLesson = useDeleteTeacherLesson();
  const generateLessons = useGenerateLessonsAI();
  const createHomework = useCreateHomework();
  const gradeHomework = useGradeHomework();

  // ── student form ──────────────────────────────────────────────────────────
  const [studentForm, setStudentForm] = useState({ username: "", password: "", fullName: "" });
  const [showStudentForm, setShowStudentForm] = useState(false);
  const [studentError, setStudentError] = useState("");

  const handleAddStudent = (e: React.FormEvent) => {
    e.preventDefault(); if (!selectedClass) return; setStudentError("");
    addStudent.mutate({ classId: selectedClass.id, data: { username: studentForm.username, password: studentForm.password, fullName: studentForm.fullName } }, {
      onSuccess: () => { setShowStudentForm(false); setStudentForm({ username: "", password: "", fullName: "" }); qc.invalidateQueries({ queryKey: getGetClassStudentsQueryKey(selectedClass.id) }); },
      onError: () => setStudentError("Skhal"),
    });
  };

  // ── lesson form ───────────────────────────────────────────────────────────
  const emptyLesson = { subjectId: "", title: "", description: "", bloomLevel: "1", content: "" };
  const [lessonForm, setLessonForm] = useState(emptyLesson);
  const [showLessonForm, setShowLessonForm] = useState(false);
  const [lessonError, setLessonError] = useState("");
  const [editLesson, setEditLesson] = useState<{ id: number; title: string; description: string; bloomLevel: number; content: string } | null>(null);
  const [aiSubject, setAiSubject] = useState("");
  const [aiCount, setAiCount] = useState("10");
  const [showAiForm, setShowAiForm] = useState(false);
  const [aiStatus, setAiStatus] = useState("");

  const handleCreateLesson = (e: React.FormEvent) => {
    e.preventDefault(); if (!selectedClass) return; setLessonError("");
    createLesson.mutate({ data: { subjectId: parseInt(lessonForm.subjectId), classId: selectedClass.id, title: lessonForm.title, description: lessonForm.description, bloomLevel: parseInt(lessonForm.bloomLevel), content: lessonForm.content } }, {
      onSuccess: () => { setShowLessonForm(false); setLessonForm(emptyLesson); qc.invalidateQueries({ queryKey: getGetClassLessonsQueryKey(selectedClass.id) }); },
      onError: () => setLessonError("Skhal"),
    });
  };

  const handleUpdateLesson = (e: React.FormEvent) => {
    e.preventDefault(); if (!editLesson) return;
    updateLesson.mutate({ id: editLesson.id, data: { title: editLesson.title, description: editLesson.description, bloomLevel: editLesson.bloomLevel, content: editLesson.content } }, {
      onSuccess: () => { setEditLesson(null); if (selectedClass) qc.invalidateQueries({ queryKey: getGetClassLessonsQueryKey(selectedClass.id) }); },
    });
  };

  const handleGenerateAI = () => {
    if (!selectedClass || !aiSubject) return;
    setAiStatus("Generating...");
    generateLessons.mutate({ data: { classId: selectedClass.id, subject: aiSubject, totalLessons: parseInt(aiCount) } }, {
      onSuccess: (d: any) => { setAiStatus(`✅ ${d.generated} das stexcvec!`); setShowAiForm(false); qc.invalidateQueries({ queryKey: getGetClassLessonsQueryKey(selectedClass.id) }); },
      onError: () => setAiStatus("❌ Skhal. Karkni"),
    });
  };

  // ── homework form ─────────────────────────────────────────────────────────
  const [hwForm, setHwForm] = useState({ lessonId: "", title: "", task: "" });
  const [showHwForm, setShowHwForm] = useState(false);
  const [hwError, setHwError] = useState("");
  const [gradingHw, setGradingHw] = useState<{ id: number; score: string; feedback: string } | null>(null);

  const handleCreateHw = (e: React.FormEvent) => {
    e.preventDefault(); if (!selectedClass) return; setHwError("");
    createHomework.mutate({ data: { lessonId: parseInt(hwForm.lessonId), classId: selectedClass.id, title: hwForm.title, task: hwForm.task } }, {
      onSuccess: () => { setShowHwForm(false); setHwForm({ lessonId: "", title: "", task: "" }); qc.invalidateQueries({ queryKey: getGetClassHomeworkQueryKey(selectedClass.id) }); },
      onError: () => setHwError("Skhal"),
    });
  };

  const handleGrade = (e: React.FormEvent) => {
    e.preventDefault(); if (!gradingHw) return;
    gradeHomework.mutate({ id: gradingHw.id, data: { score: parseInt(gradingHw.score), feedback: gradingHw.feedback } }, {
      onSuccess: () => { setGradingHw(null); if (selectedClass) qc.invalidateQueries({ queryKey: getGetClassHomeworkQueryKey(selectedClass.id) }); },
    });
  };

  // ── guard ─────────────────────────────────────────────────────────────────
  if (user?.role !== "teacher" && user?.role !== "admin") { setLocation("/login"); return null; }

  const inputCls = "w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50";
  const btnPrimary = "px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-medium disabled:opacity-50 transition-all";
  const btnGhost = "px-3 py-1 rounded-lg text-xs text-muted-foreground hover:text-white border border-transparent hover:border-white/10 transition-colors";
  const btnDanger = "px-3 py-1 rounded-lg text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors";

  const DAYS_ORDER = ["Երկuшabti", "Yerekшabti", "Chorekшabti", "Hingшabti", "Urbat", "Шabat"];

  // ── STUDENT DETAIL VIEW ───────────────────────────────────────────────────
  if (mainView === "student" && selectedStudentId) {
    const hw = (studentDetail?.homework ?? []) as Array<{
      id: number; title: string; task: string; status: string; score: number | null; feedback: string | null; submittedAt: string | null;
    }>;
    return (
      <div className="min-h-[100dvh] bg-background text-white">
        <header className="border-b border-white/10 px-6 py-4 flex items-center gap-4">
          <button onClick={() => setMainView("class")} className="text-muted-foreground hover:text-white text-sm">← Veradardal</button>
          <h1 className="text-lg font-bold">👨‍🎓 {studentDetail?.fullName}</h1>
          {studentDetail?.avgScore !== null && studentDetail?.avgScore !== undefined && (
            <span className="ml-auto px-3 py-1 rounded-full text-sm bg-primary/20 text-primary">Miyin: {studentDetail.avgScore}/100</span>
          )}
        </header>
        <div className="max-w-4xl mx-auto px-6 py-6">
          <h2 className="font-semibold mb-4">Tnain ashkhatankner ({hw.length})</h2>
          {hw.length === 0 && <p className="text-muted-foreground text-sm">Tnain chka</p>}
          <div className="space-y-3">
            {hw.map((h) => (
              <div key={h.id} className="bg-card/50 border border-white/10 rounded-xl p-4">
                <div className="flex items-start justify-between mb-2">
                  <div className="font-medium">{h.title}</div>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${h.status === "graded" ? "bg-teal-400/20 text-teal-400" : h.status === "submitted" ? "bg-amber-400/20 text-amber-400" : "bg-white/10 text-muted-foreground"}`}>
                    {h.status === "graded" ? `✓ ${h.score}/100` : h.status === "submitted" ? "Nerkayacved" : "Скасума"}
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

  // ── CLASS DETAIL VIEW ─────────────────────────────────────────────────────
  if (mainView === "class" && selectedClass) {
    return (
      <div className="min-h-[100dvh] bg-background text-white">
        <header className="border-b border-white/10 px-6 py-4 flex items-center gap-4">
          <button onClick={() => setMainView("dashboard")} className="text-muted-foreground hover:text-white text-sm">← Dashboard</button>
          <div>
            <h1 className="text-lg font-bold">📚 {selectedClass.name}</h1>
            {selectedClass.grade && <p className="text-xs text-muted-foreground">{selectedClass.grade} das</p>}
          </div>
          <span className="ml-auto text-sm text-muted-foreground">{user?.fullName}</span>
        </header>

        <div className="max-w-5xl mx-auto px-6 py-6">
          {/* Class tabs */}
          <div className="flex gap-1 mb-6 border-b border-white/10">
            {(["students", "lessons", "homework"] as const).map((t) => (
              <button key={t} onClick={() => setClassTab(t)}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${classTab === t ? "border-primary text-white" : "border-transparent text-muted-foreground hover:text-white"}`}>
                {t === "students" ? "👨‍🎓 Ashakertner" : t === "lessons" ? "📖 Dasner" : "📝 Tnain"}
              </button>
            ))}
          </div>

          {/* ── STUDENTS TAB ── */}
          {classTab === "students" && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold">Ashakertner ({students.length})</h2>
                <button onClick={() => setShowStudentForm(!showStudentForm)} className={btnPrimary}>+ Avelacel</button>
              </div>
              {showStudentForm && (
                <form onSubmit={handleAddStudent} className="mb-5 bg-card/50 border border-white/10 rounded-2xl p-5 space-y-3">
                  {studentError && <p className="text-destructive text-xs">{studentError}</p>}
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className="text-xs text-muted-foreground">Anun Azganun *</label><input value={studentForm.fullName} onChange={e => setStudentForm(f => ({ ...f, fullName: e.target.value }))} required className={inputCls} /></div>
                    <div><label className="text-xs text-muted-foreground">Ogtanun *</label><input value={studentForm.username} onChange={e => setStudentForm(f => ({ ...f, username: e.target.value }))} required className={inputCls} /></div>
                    <div className="col-span-2"><label className="text-xs text-muted-foreground">Gajtnabar *</label><input type="password" value={studentForm.password} onChange={e => setStudentForm(f => ({ ...f, password: e.target.value }))} required className={inputCls} /></div>
                  </div>
                  <div className="flex gap-2">
                    <button type="submit" disabled={addStudent.isPending} className={btnPrimary}>{addStudent.isPending ? "..." : "Avelacel"}</button>
                    <button type="button" onClick={() => setShowStudentForm(false)} className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white">Chegarkel</button>
                  </div>
                </form>
              )}
              <div className="space-y-2">
                {students.length === 0 && <p className="text-muted-foreground text-sm py-6 text-center">Ashakert chka</p>}
                {students.map((s) => (
                  <div key={s.id} className="bg-card/50 border border-white/10 rounded-xl px-4 py-3 flex items-center justify-between">
                    <div>
                      <div className="font-medium">{s.fullName}</div>
                      <div className="text-xs text-muted-foreground">{s.username}</div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => { setSelectedStudentId(s.id); setMainView("student"); }} className={btnGhost}>🔍 Manramasnern</button>
                      <button onClick={() => { if (confirm("Heracnel?")) removeStudent.mutate({ classId: selectedClass.id, studentId: s.id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getGetClassStudentsQueryKey(selectedClass.id) }) }); }} className={btnDanger}>Heracnel</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── LESSONS TAB ── */}
          {classTab === "lessons" && (
            <div>
              <div className="flex flex-wrap items-center gap-3 mb-5">
                <h2 className="font-semibold">Dasner ({classLessons.length})</h2>
                <button onClick={() => setShowAiForm(!showAiForm)} className="px-3 py-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 text-white text-sm font-medium">🤖 AI-ov Generacel</button>
                <button onClick={() => setShowLessonForm(!showLessonForm)} className={btnPrimary}>✏️ Jerkov Stexcel</button>
              </div>

              {/* AI Generate form */}
              {showAiForm && (
                <div className="mb-5 bg-violet-500/10 border border-violet-500/30 rounded-2xl p-5 space-y-3">
                  <h3 className="font-medium text-violet-300">🤖 AI-i oknutyamb das generacel</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-muted-foreground">Aratka *</label>
                      <input value={aiSubject} onChange={e => setAiSubject(e.target.value)} placeholder="orin Matemarika" className={inputCls} />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">Daseri kanaky</label>
                      <select value={aiCount} onChange={e => setAiCount(e.target.value)} className={inputCls}>
                        {[5, 10, 15, 20].map(n => <option key={n} value={n}>{n} das</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="flex gap-2 items-center">
                    <button onClick={handleGenerateAI} disabled={generateLessons.isPending || !aiSubject} className="px-4 py-2 rounded-xl bg-violet-600 text-white text-sm disabled:opacity-50">
                      {generateLessons.isPending ? "Generacvum e..." : "🚀 Generacel"}
                    </button>
                    <button onClick={() => setShowAiForm(false)} className="px-3 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white">Chegarkel</button>
                    {aiStatus && <span className="text-sm text-teal-400">{aiStatus}</span>}
                  </div>
                </div>
              )}

              {/* Manual lesson form */}
              {showLessonForm && (
                <form onSubmit={handleCreateLesson} className="mb-5 bg-card/50 border border-white/10 rounded-2xl p-5 space-y-3">
                  <h3 className="font-medium">Nor das</h3>
                  {lessonError && <p className="text-destructive text-xs">{lessonError}</p>}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-muted-foreground">Aratka *</label>
                      <select value={lessonForm.subjectId} onChange={e => setLessonForm(f => ({ ...f, subjectId: e.target.value }))} required className={inputCls}>
                        <option value="">Yntreq</option>
                        {subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">Bloom</label>
                      <select value={lessonForm.bloomLevel} onChange={e => setLessonForm(f => ({ ...f, bloomLevel: e.target.value }))} className={inputCls}>
                        {[1,2,3,4,5,6].map(n => <option key={n} value={n}>{n} - {BLOOM[n]}</option>)}
                      </select>
                    </div>
                    <div className="col-span-2"><label className="text-xs text-muted-foreground">Vernagir *</label><input value={lessonForm.title} onChange={e => setLessonForm(f => ({ ...f, title: e.target.value }))} required className={inputCls} /></div>
                    <div className="col-span-2"><label className="text-xs text-muted-foreground">Nkaragrutyun</label><input value={lessonForm.description} onChange={e => setLessonForm(f => ({ ...f, description: e.target.value }))} className={inputCls} /></div>
                    <div className="col-span-2"><label className="text-xs text-muted-foreground">Bovamdakutyun</label><textarea value={lessonForm.content} onChange={e => setLessonForm(f => ({ ...f, content: e.target.value }))} rows={3} className={`${inputCls} resize-none`} /></div>
                  </div>
                  <div className="flex gap-2">
                    <button type="submit" disabled={createLesson.isPending} className={btnPrimary}>{createLesson.isPending ? "..." : "Pahpanel"}</button>
                    <button type="button" onClick={() => setShowLessonForm(false)} className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white">Chegarkel</button>
                  </div>
                </form>
              )}

              {/* Edit lesson form */}
              {editLesson && (
                <form onSubmit={handleUpdateLesson} className="mb-5 bg-primary/5 border border-primary/20 rounded-2xl p-5 space-y-3">
                  <h3 className="font-medium">Khmbagrelu das</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2"><label className="text-xs text-muted-foreground">Vernagir</label><input value={editLesson.title} onChange={e => setEditLesson(l => l && ({ ...l, title: e.target.value }))} className={inputCls} /></div>
                    <div><label className="text-xs text-muted-foreground">Nkaragrutyun</label><input value={editLesson.description} onChange={e => setEditLesson(l => l && ({ ...l, description: e.target.value }))} className={inputCls} /></div>
                    <div><label className="text-xs text-muted-foreground">Bloom</label><select value={editLesson.bloomLevel} onChange={e => setEditLesson(l => l && ({ ...l, bloomLevel: parseInt(e.target.value) }))} className={inputCls}>{[1,2,3,4,5,6].map(n => <option key={n} value={n}>{n} - {BLOOM[n]}</option>)}</select></div>
                  </div>
                  <div className="flex gap-2">
                    <button type="submit" className={btnPrimary}>Pahpanel</button>
                    <button type="button" onClick={() => setEditLesson(null)} className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white">Chegarkel</button>
                  </div>
                </form>
              )}

              <div className="space-y-2">
                {classLessons.length === 0 && <p className="text-muted-foreground text-sm py-6 text-center">Das chka — stexcek manual kam AI-i oknutyamb</p>}
                {classLessons.map((l, idx) => (
                  <div key={l.id} className="bg-card/50 border border-white/10 rounded-xl px-4 py-3 flex items-center gap-4">
                    <span className="text-xs text-muted-foreground w-6">{idx + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{l.title}</div>
                      {l.description && <div className="text-xs text-muted-foreground truncate">{l.description}</div>}
                    </div>
                    <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded-full shrink-0">B{l.bloomLevel}</span>
                    <div className="flex gap-1">
                      <button onClick={() => setEditLesson({ id: l.id, title: l.title, description: l.description ?? "", bloomLevel: l.bloomLevel, content: l.content ?? "" })} className={btnGhost}>✏️</button>
                      <button onClick={() => { if (confirm("Djnjel?")) deleteLesson.mutate({ id: l.id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getGetClassLessonsQueryKey(selectedClass.id) }) }); }} className={btnDanger}>🗑</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── HOMEWORK TAB ── */}
          {classTab === "homework" && (
            <div>
              <div className="flex items-center justify-between mb-5">
                <h2 className="font-semibold">Tnain ashkhataнk ({classHomework.length})</h2>
                <button onClick={() => setShowHwForm(!showHwForm)} className={btnPrimary}>+ Tal tnain</button>
              </div>

              {showHwForm && (
                <form onSubmit={handleCreateHw} className="mb-5 bg-card/50 border border-white/10 rounded-2xl p-5 space-y-3">
                  <h3 className="font-medium">Nor tnain</h3>
                  {hwError && <p className="text-destructive text-xs">{hwError}</p>}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-muted-foreground">Das *</label>
                      <select value={hwForm.lessonId} onChange={e => setHwForm(f => ({ ...f, lessonId: e.target.value }))} required className={inputCls}>
                        <option value="">Yntreq das</option>
                        {classLessons.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
                      </select>
                    </div>
                    <div><label className="text-xs text-muted-foreground">Anvanumov *</label><input value={hwForm.title} onChange={e => setHwForm(f => ({ ...f, title: e.target.value }))} required className={inputCls} /></div>
                    <div className="col-span-2"><label className="text-xs text-muted-foreground">Aradjadrank *</label><textarea value={hwForm.task} onChange={e => setHwForm(f => ({ ...f, task: e.target.value }))} required rows={3} className={`${inputCls} resize-none`} /></div>
                  </div>
                  <div className="flex gap-2">
                    <button type="submit" disabled={createHomework.isPending} className={btnPrimary}>{createHomework.isPending ? "..." : "Urakel"}</button>
                    <button type="button" onClick={() => setShowHwForm(false)} className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white">Chegarkel</button>
                  </div>
                </form>
              )}

              {gradingHw && (
                <form onSubmit={handleGrade} className="mb-5 bg-amber-500/10 border border-amber-500/30 rounded-2xl p-5 space-y-3">
                  <h3 className="font-medium text-amber-300">Gnahatel</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className="text-xs text-muted-foreground">Gnahatakan (0-100) *</label><input type="number" min="0" max="100" value={gradingHw.score} onChange={e => setGradingHw(g => g && ({ ...g, score: e.target.value }))} required className={inputCls} /></div>
                    <div><label className="text-xs text-muted-foreground">Arzagank</label><input value={gradingHw.feedback} onChange={e => setGradingHw(g => g && ({ ...g, feedback: e.target.value }))} className={inputCls} /></div>
                  </div>
                  <div className="flex gap-2">
                    <button type="submit" className="px-4 py-2 rounded-xl bg-amber-500 text-white text-sm">Pahpanel</button>
                    <button type="button" onClick={() => setGradingHw(null)} className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white">Chegarkel</button>
                  </div>
                </form>
              )}

              <div className="space-y-2">
                {classHomework.length === 0 && <p className="text-muted-foreground text-sm py-6 text-center">Tnain chka</p>}
                {classHomework.map((h) => (
                  <div key={h.id} className="bg-card/50 border border-white/10 rounded-xl px-4 py-3">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0 mr-4">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-medium text-sm">{h.title}</span>
                          <span className="text-xs text-muted-foreground">· {(h as any).studentName}</span>
                        </div>
                        <p className="text-xs text-muted-foreground truncate">{(h as any).lessonTitle}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${h.status === "graded" ? "bg-teal-400/20 text-teal-400" : h.status === "submitted" ? "bg-amber-400/20 text-amber-400" : "bg-white/10 text-muted-foreground"}`}>
                          {h.status === "graded" ? `${h.score}/100` : h.status === "submitted" ? "Nerkayacved" : "Skасuma"}
                        </span>
                        {h.status === "submitted" && (
                          <button onClick={() => setGradingHw({ id: h.id, score: "", feedback: "" })} className="px-2 py-1 rounded-lg text-xs bg-amber-500/20 text-amber-400 hover:bg-amber-500/30">Gnahatel</button>
                        )}
                      </div>
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
      <header className="border-b border-white/10 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">👨‍🏫 Usnuchi Vahanak</h1>
          <p className="text-xs text-muted-foreground">Karhanyan School · myaiteacher</p>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">{user?.fullName}</span>
          <button onClick={logout} className="text-sm text-destructive hover:text-white transition-colors">Ełq</button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-6">
        <div className="flex gap-1 mb-8 border-b border-white/10">
          {(["schedule", "classes"] as const).map((t) => (
            <button key={t} onClick={() => setActiveTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${activeTab === t ? "border-primary text-white" : "border-transparent text-muted-foreground hover:text-white"}`}>
              {t === "schedule" ? "📅 Im Dasacucaky" : "📚 Im Dasarannery"}
            </button>
          ))}
        </div>

        {/* ── SCHEDULE TAB ── */}
        {activeTab === "schedule" && (
          <div>
            {schedule.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <div className="text-5xl mb-4">📅</div>
                <p>Dasacucak chka · Admin-e petk e avelacel</p>
              </div>
            ) : (
              <div className="space-y-6">
                {["Երkuшabti","Yerekшabti","Chorekшabti","Hingшabti","Urbat","Шabat"].map((day) => {
                  const dayItems = schedule.filter((s) => s.day === day || s.day.startsWith(day.slice(0,4)));
                  return dayItems.length > 0 ? (
                    <div key={day}>
                      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">{day}</h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {dayItems.sort((a, b) => a.time.localeCompare(b.time)).map((s) => (
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
                {/* If no matches by day order, show all */}
                {!["Երkuшabti","Yerekшabti","Chorekшabti","Hingшabti","Urbat","Шabat"].some(day => schedule.some(s => s.day === day || s.day.startsWith(day.slice(0,4)))) && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {schedule.map((s) => (
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

        {/* ── CLASSES TAB ── */}
        {activeTab === "classes" && (
          <div>
            {classes.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <div className="text-5xl mb-4">📚</div>
                <p>Dasaran chka · Admin-e petk e kargin nshanakel</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {classes.map((c) => (
                  <button key={c.id} onClick={() => { setSelectedClass({ id: c.id, name: c.name, grade: c.grade }); setClassTab("students"); setMainView("class"); }}
                    className="bg-card/60 border border-white/10 rounded-2xl p-6 text-left hover:border-primary/40 hover:bg-primary/5 transition-all group">
                    <div className="text-3xl mb-3">📚</div>
                    <div className="font-semibold text-lg mb-1 group-hover:text-primary transition-colors">{c.name}</div>
                    {c.grade && <div className="text-sm text-muted-foreground mb-3">{c.grade} das</div>}
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>👨‍🎓 {(c as any).studentCount ?? 0} ashakert</span>
                    </div>
                    <div className="mt-4 text-xs text-primary font-medium opacity-0 group-hover:opacity-100 transition-opacity">Ditel →</div>
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
