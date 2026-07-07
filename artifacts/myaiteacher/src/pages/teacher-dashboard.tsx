import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import QuickSwitch from "@/components/QuickSwitch";
import {
  useGetTeacherClasses,
  useGetClassStudents,
  useAddStudentToClass,
  useRemoveStudentFromClass,
  useGetClassLessons,
  useCreateTeacherLesson,
  useUpdateTeacherLesson,
  useDeleteTeacherLesson,
  useGetClassDocuments,
  useDeleteClassDocument,
  useGetTeacherSchedule,
  useGetStudentDetail,
  getGetTeacherClassesQueryKey,
  getGetClassStudentsQueryKey,
  getGetClassLessonsQueryKey,
  getGetTeacherScheduleQueryKey,
  getGetClassDocumentsQueryKey,
  getGetStudentDetailQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type MainView = "dashboard" | "class" | "student";
type ClassTab = "students" | "lessons";

const DOC_TYPES = [
  { key: "textbook",      label: "📚 Դասագիրք",      desc: "Учебник" },
  { key: "curriculum",    label: "📋 Ծրագիր",         desc: "Ծрагир" },
  { key: "thematic_plan", label: "📑 Թեմատիկ Պլան",  desc: "Tematik Plan" },
] as const;

async function uploadDocument(
  classId: number,
  token: string,
  form: { type: string; title: string; description: string; file: File | null }
) {
  const fd = new FormData();
  fd.append("type", form.type);
  fd.append("title", form.title);
  fd.append("description", form.description);
  if (form.file) fd.append("file", form.file);
  const res = await fetch(`/api/teacher/classes/${classId}/documents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${localStorage.getItem("myaiteacher_token") ?? ""}` },
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
  const [selectedClass, setSelectedClass] = useState<{ id: number; name: string; grade: string } | null>(null);
  const [classTab, setClassTab] = useState<ClassTab>("students");
  const [selectedStudentId, setSelectedStudentId] = useState<number | null>(null);

  const { data: schedule = [] } = useGetTeacherSchedule({ query: { queryKey: getGetTeacherScheduleQueryKey() } });
  const { data: classes = [] } = useGetTeacherClasses({ query: { queryKey: getGetTeacherClassesQueryKey() } });

  const { data: students = [] } = useGetClassStudents(
    selectedClass?.id ?? 0,
    { query: { enabled: !!selectedClass, queryKey: getGetClassStudentsQueryKey(selectedClass?.id ?? 0) } }
  );
  const { data: classLessons = [] } = useGetClassLessons(
    selectedClass?.id ?? 0,
    { query: { enabled: !!selectedClass, queryKey: getGetClassLessonsQueryKey(selectedClass?.id ?? 0) } }
  );
  const { data: classDocs = [] } = useGetClassDocuments(
    selectedClass?.id ?? 0,
    { query: { enabled: !!selectedClass && classTab === "lessons", queryKey: getGetClassDocumentsQueryKey(selectedClass?.id ?? 0) } }
  );
  const { data: studentDetail } = useGetStudentDetail(
    selectedStudentId ?? 0,
    { query: { enabled: !!selectedStudentId, queryKey: getGetStudentDetailQueryKey(selectedStudentId ?? 0) } }
  );

  const addStudent = useAddStudentToClass();
  const removeStudent = useRemoveStudentFromClass();
  const createLesson = useCreateTeacherLesson();
  const updateLesson = useUpdateTeacherLesson();
  const deleteLesson = useDeleteTeacherLesson();
  const deleteDoc = useDeleteClassDocument();

  const [studentForm, setStudentForm] = useState({ fullName: "", email: "", age: "" });
  const [showStudentForm, setShowStudentForm] = useState(false);
  const [studentError, setStudentError] = useState("");

  const handleAddStudent = (e: React.FormEvent) => {
    e.preventDefault(); if (!selectedClass) return; setStudentError("");
    addStudent.mutate({ classId: selectedClass.id, data: {
      fullName: studentForm.fullName,
      email: (studentForm as any).email || undefined,
      age: (studentForm as any).age ? parseInt((studentForm as any).age) : undefined,
    } as any }, {
      onSuccess: () => { setShowStudentForm(false); setStudentForm({ fullName: "", email: "", age: "" }); qc.invalidateQueries({ queryKey: getGetClassStudentsQueryKey(selectedClass.id) }); },
      onError: () => setStudentError("Սkhаl"),
    });
  };

  const emptyLesson = { title: "", lessonNumber: "", pagesFrom: "", pagesTo: "" };
  const [lessonForm, setLessonForm] = useState(emptyLesson);
  const [showLessonForm, setShowLessonForm] = useState(false);
  const [lessonError, setLessonError] = useState("");
  const [editLesson, setEditLesson] = useState<{ id: number; title: string; lessonNumber: string; pagesFrom: string; pagesTo: string } | null>(null);

  const handleCreateLesson = (e: React.FormEvent) => {
    e.preventDefault(); if (!selectedClass) return; setLessonError("");
    createLesson.mutate({ data: {
      classId: selectedClass.id,
      title: lessonForm.title,
      lessonNumber: lessonForm.lessonNumber ? parseInt(lessonForm.lessonNumber) : undefined,
      pagesFrom: lessonForm.pagesFrom ? parseInt(lessonForm.pagesFrom) : undefined,
      pagesTo: lessonForm.pagesTo ? parseInt(lessonForm.pagesTo) : undefined,
    } }, {
      onSuccess: () => { setShowLessonForm(false); setLessonForm(emptyLesson); qc.invalidateQueries({ queryKey: getGetClassLessonsQueryKey(selectedClass.id) }); },
      onError: () => setLessonError("Սkhаl"),
    });
  };

  const handleUpdateLesson = (e: React.FormEvent) => {
    e.preventDefault(); if (!editLesson) return;
    updateLesson.mutate({ id: editLesson.id, data: {
      title: editLesson.title,
      lessonNumber: editLesson.lessonNumber ? parseInt(editLesson.lessonNumber) : undefined,
      pagesFrom: editLesson.pagesFrom ? parseInt(editLesson.pagesFrom) : undefined,
      pagesTo: editLesson.pagesTo ? parseInt(editLesson.pagesTo) : undefined,
    } }, {
      onSuccess: () => { setEditLesson(null); if (selectedClass) qc.invalidateQueries({ queryKey: getGetClassLessonsQueryKey(selectedClass.id) }); },
    });
  };

  const emptyDocForm = { type: "textbook", title: "", description: "", file: null as File | null };
  const [docForm, setDocForm] = useState(emptyDocForm);
  const [showDocForm, setShowDocForm] = useState(false);
  const [docError, setDocError] = useState("");
  const [docUploading, setDocUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleAddDoc = async (e: React.FormEvent) => {
    e.preventDefault(); if (!selectedClass) return; setDocError("");
    if (!docForm.title) { setDocError("Аnvanumы partadir е"); return; }
    setDocUploading(true);
    try {
      await uploadDocument(selectedClass.id, "", docForm);
      setShowDocForm(false); setDocForm(emptyDocForm); if (fileRef.current) fileRef.current.value = "";
      qc.invalidateQueries({ queryKey: getGetClassDocumentsQueryKey(selectedClass.id) });
    } catch { setDocError("Нерberumy chhajoghacav"); }
    finally { setDocUploading(false); }
  };

  const handleDeleteDoc = (docId: number) => {
    if (!selectedClass || !confirm("Njje՞l?")) return;
    deleteDoc.mutate({ classId: selectedClass.id, docId }, {
      onSuccess: () => qc.invalidateQueries({ queryKey: getGetClassDocumentsQueryKey(selectedClass.id) }),
    });
  };

  if (authLoading) return <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background"><div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  if (user?.role !== "teacher" && user?.role !== "admin") { setLocation("/login"); return null; }

  const inputCls = "w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50";
  const btnPrimary = "px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-medium disabled:opacity-50 transition-all";
  const btnGhost = "px-3 py-1 rounded-lg text-xs text-muted-foreground hover:text-white border border-transparent hover:border-white/10 transition-colors";
  const btnDanger = "px-3 py-1 rounded-lg text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors";

  // ── STUDENT DETAIL VIEW ───────────────────────────────────────────────────
  if (mainView === "student" && selectedStudentId) {
    const hw = (studentDetail?.homework ?? []) as Array<{
      id: number; title: string; task: string; status: string; score: number | null; feedback: string | null;
    }>;
    return (
      <div className="min-h-[100dvh] bg-background text-white">
        <QuickSwitch />
        <header className="border-b border-white/10 px-6 py-4 flex items-center gap-4">
          <button onClick={() => setMainView("class")} className="text-muted-foreground hover:text-white text-sm">← Վеrаdаrnаl</button>
          <h1 className="text-lg font-bold">👨‍🎓 {studentDetail?.fullName}</h1>
          {studentDetail?.avgScore !== null && studentDetail?.avgScore !== undefined && (
            <span className="ml-auto px-3 py-1 rounded-full text-sm bg-primary/20 text-primary">Мidj. {studentDetail.avgScore}/100</span>
          )}
        </header>
        <div className="max-w-4xl mx-auto px-6 py-6">
          <h2 className="font-semibold mb-4">Тnayin аshkhаtаnqner ({hw.length})</h2>
          {hw.length === 0 && <p className="text-muted-foreground text-sm">Тnayin chkа</p>}
          <div className="space-y-3">
            {hw.map((h) => (
              <div key={h.id} className="bg-card/50 border border-white/10 rounded-xl p-4">
                <div className="flex items-start justify-between mb-2">
                  <div className="font-medium">{h.title}</div>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${h.status === "graded" ? "bg-teal-400/20 text-teal-400" : h.status === "submitted" ? "bg-amber-400/20 text-amber-400" : "bg-white/10 text-muted-foreground"}`}>
                    {h.status === "graded" ? `✓ ${h.score}/100` : h.status === "submitted" ? "Нerkaуacvаd" : "Spаsum е"}
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
        <QuickSwitch />
        <header className="border-b border-white/10 px-6 py-4 flex items-center gap-4">
          <button onClick={() => setMainView("dashboard")} className="text-muted-foreground hover:text-white text-sm">← Ваhаnаk</button>
          <div>
            <h1 className="text-lg font-bold">📚 {selectedClass.name}</h1>
            {selectedClass.grade && <p className="text-xs text-muted-foreground">{selectedClass.grade}</p>}
          </div>
          <span className="ml-auto text-sm text-muted-foreground">{user?.fullName}</span>
        </header>

        <div className="max-w-5xl mx-auto px-6 py-6">
          <div className="flex gap-1 mb-6 border-b border-white/10">
            {(["students", "lessons"] as const).map((t) => (
              <button key={t} onClick={() => setClassTab(t)}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${classTab === t ? "border-primary text-white" : "border-transparent text-muted-foreground hover:text-white"}`}>
                {t === "students" ? "👨‍🎓 Аshаkertner" : "📖 Dаser"}
              </button>
            ))}
          </div>

          {/* ── STUDENTS TAB ── */}
          {classTab === "students" && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold">Аshаkertner ({students.length})</h2>
                <button onClick={() => setShowStudentForm(!showStudentForm)} className={btnPrimary}>+ Аvelacel</button>
              </div>
              {showStudentForm && (
                <form onSubmit={handleAddStudent} className="mb-5 bg-card/50 border border-white/10 rounded-2xl p-5 space-y-3">
                  {studentError && <p className="text-destructive text-xs">{studentError}</p>}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2"><label className="text-xs text-muted-foreground">Аnuн Аzganun *</label><input value={studentForm.fullName} onChange={e => setStudentForm(f => ({ ...f, fullName: e.target.value }))} required className={inputCls} placeholder="Аshаkerti Аnunы" /></div>
                    <div><label className="text-xs text-muted-foreground">Email</label><input type="email" value={(studentForm as any).email} onChange={e => setStudentForm(f => ({ ...f, email: e.target.value } as any))} className={inputCls} placeholder="example@mail.com" /></div>
                    <div><label className="text-xs text-muted-foreground">Тariq (аmixin)</label><input type="number" min="5" max="25" value={(studentForm as any).age} onChange={e => setStudentForm(f => ({ ...f, age: e.target.value } as any))} className={inputCls} placeholder="14" /></div>
                  </div>
                  <p className="text-xs text-muted-foreground/70">Аlginаbаry klini "student123" · Оgтanuny аvtоmаt kerp klini</p>
                  <div className="flex gap-2">
                    <button type="submit" disabled={addStudent.isPending} className={btnPrimary}>{addStudent.isPending ? "..." : "Аvelacel"}</button>
                    <button type="button" onClick={() => setShowStudentForm(false)} className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white">Chegharkel</button>
                  </div>
                </form>
              )}
              <div className="space-y-2">
                {students.length === 0 && <p className="text-muted-foreground text-sm py-6 text-center">Аshаkert chkа</p>}
                {students.map((s) => (
                  <div key={s.id} className="bg-card/50 border border-white/10 rounded-xl px-4 py-3 flex items-center justify-between">
                    <div>
                      <div className="font-medium">{s.fullName}</div>
                      <div className="text-xs text-muted-foreground">{(s as any).email || s.username}{(s as any).age ? ` · ${(s as any).age} t.` : ""}</div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => { setSelectedStudentId(s.id); setMainView("student"); }} className={btnGhost}>🔍 Mаnrаmаsn</button>
                      <button onClick={() => { if (confirm("Herrаtsnе՞l?")) removeStudent.mutate({ classId: selectedClass.id, studentId: s.id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getGetClassStudentsQueryKey(selectedClass.id) }) }); }} className={btnDanger}>Herrаtsnеl</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── LESSONS TAB ── */}
          {classTab === "lessons" && (
            <div className="space-y-8">

              {/* ── DOCUMENTS SECTION ── */}
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-semibold text-base">📎 Нerbermаner</h2>
                  <button onClick={() => { setShowDocForm(!showDocForm); setDocError(""); }} className={btnPrimary}>+ Аvelacel</button>
                </div>

                {showDocForm && (
                  <form onSubmit={handleAddDoc} className="mb-5 bg-card/50 border border-white/10 rounded-2xl p-5 space-y-3">
                    <h3 className="font-medium text-sm">Nor njerberum</h3>
                    {docError && <p className="text-destructive text-xs">{docError}</p>}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-muted-foreground">Тesаk *</label>
                        <select value={docForm.type} onChange={e => setDocForm(f => ({ ...f, type: e.target.value }))} className={inputCls}>
                          {DOC_TYPES.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">Аnvanumы *</label>
                        <input value={docForm.title} onChange={e => setDocForm(f => ({ ...f, title: e.target.value }))} required className={inputCls} placeholder="оr. Аlgаritmneri dаsagirq" />
                      </div>
                      <div className="col-span-2">
                        <label className="text-xs text-muted-foreground">Нишаgrkutyon</label>
                        <input value={docForm.description} onChange={e => setDocForm(f => ({ ...f, description: e.target.value }))} className={inputCls} placeholder="Аmbuljutyon, hеghinak..." />
                      </div>
                      <div className="col-span-2">
                        <label className="text-xs text-muted-foreground">Fаjl (PDF, DOC, DOCX — kаmаyinы 20  МB)</label>
                        <input
                          ref={fileRef}
                          type="file"
                          accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
                          onChange={e => setDocForm(f => ({ ...f, file: e.target.files?.[0] ?? null }))}
                          className="w-full text-sm text-muted-foreground file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-primary/20 file:text-primary file:text-xs hover:file:bg-primary/30 cursor-pointer"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button type="submit" disabled={docUploading} className={btnPrimary}>{docUploading ? "Нerbervum е..." : "Аvelacel"}</button>
                      <button type="button" onClick={() => { setShowDocForm(false); setDocForm(emptyDocForm); if (fileRef.current) fileRef.current.value = ""; }} className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white">Chegharkel</button>
                    </div>
                  </form>
                )}

                {DOC_TYPES.map(({ key, label }) => {
                  const docs = classDocs.filter(d => d.type === key);
                  if (docs.length === 0) return null;
                  return (
                    <div key={key} className="mb-4">
                      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">{label}</h3>
                      <div className="space-y-2">
                        {docs.map(d => (
                          <div key={d.id} className="bg-card/50 border border-white/10 rounded-xl px-4 py-3 flex items-center gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-sm truncate">{d.title}</div>
                              {d.description && <div className="text-xs text-muted-foreground truncate">{d.description}</div>}
                              {d.fileName && <div className="text-xs text-teal-400/80 truncate">📎 {d.fileName}</div>}
                            </div>
                            <div className="flex gap-1 shrink-0">
                              {d.fileUrl && (
                                <a href={d.fileUrl} target="_blank" rel="noopener noreferrer" className={btnGhost}>⬇ Нerbel</a>
                              )}
                              <button onClick={() => handleDeleteDoc(d.id)} className={btnDanger}>🗑</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}

                {classDocs.length === 0 && !showDocForm && (
                  <p className="text-muted-foreground text-sm py-4 text-center">Njerberum chkа · Аvelacel дасagirq, tsrаgir, kаm temаtik plаn</p>
                )}
              </div>

              {/* ── DIVIDER ── */}
              <div className="border-t border-white/10" />

              {/* ── LESSONS SECTION ── */}
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-semibold text-base">📖 Dаser ({classLessons.length})</h2>
                  <button onClick={() => { setShowLessonForm(!showLessonForm); setLessonError(""); }} className={btnPrimary}>✏️ Аvelacel Dаs</button>
                </div>

                {showLessonForm && (
                  <form onSubmit={handleCreateLesson} className="mb-5 bg-card/50 border border-white/10 rounded-2xl p-5 space-y-3">
                    <h3 className="font-medium text-sm">Nor dаs</h3>
                    {lessonError && <p className="text-destructive text-xs">{lessonError}</p>}
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="text-xs text-muted-foreground">Dаsi # (аmirin)</label>
                        <input type="number" min="1" value={lessonForm.lessonNumber} onChange={e => setLessonForm(f => ({ ...f, lessonNumber: e.target.value }))} className={inputCls} placeholder="1" />
                      </div>
                      <div className="col-span-2">
                        <label className="text-xs text-muted-foreground">Vеrnаgir (Тemа) *</label>
                        <input value={lessonForm.title} onChange={e => setLessonForm(f => ({ ...f, title: e.target.value }))} required className={inputCls} placeholder="оr. Kvаdrаtаyin hаvаsаrumner" />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">Еjеr (аysin)</label>
                        <input type="number" min="1" value={lessonForm.pagesFrom} onChange={e => setLessonForm(f => ({ ...f, pagesFrom: e.target.value }))} className={inputCls} placeholder="12" />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">Еjеr (minchev)</label>
                        <input type="number" min="1" value={lessonForm.pagesTo} onChange={e => setLessonForm(f => ({ ...f, pagesTo: e.target.value }))} className={inputCls} placeholder="18" />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button type="submit" disabled={createLesson.isPending} className={btnPrimary}>{createLesson.isPending ? "..." : "Pаhrаpаnel"}</button>
                      <button type="button" onClick={() => setShowLessonForm(false)} className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white">Chegharkel</button>
                    </div>
                  </form>
                )}

                {editLesson && (
                  <form onSubmit={handleUpdateLesson} className="mb-5 bg-primary/5 border border-primary/20 rounded-2xl p-5 space-y-3">
                    <h3 className="font-medium text-sm">Кhmаgrel Dаs</h3>
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="text-xs text-muted-foreground">Dаsi #</label>
                        <input type="number" min="1" value={editLesson.lessonNumber} onChange={e => setEditLesson(l => l && ({ ...l, lessonNumber: e.target.value }))} className={inputCls} />
                      </div>
                      <div className="col-span-2">
                        <label className="text-xs text-muted-foreground">Vеrnаgir *</label>
                        <input value={editLesson.title} onChange={e => setEditLesson(l => l && ({ ...l, title: e.target.value }))} className={inputCls} />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">Еjеr аysin</label>
                        <input type="number" value={editLesson.pagesFrom} onChange={e => setEditLesson(l => l && ({ ...l, pagesFrom: e.target.value }))} className={inputCls} />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">Еjеr minchev</label>
                        <input type="number" value={editLesson.pagesTo} onChange={e => setEditLesson(l => l && ({ ...l, pagesTo: e.target.value }))} className={inputCls} />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button type="submit" className={btnPrimary}>Pаhrаpаnel</button>
                      <button type="button" onClick={() => setEditLesson(null)} className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white">Chegharkel</button>
                    </div>
                  </form>
                )}

                <div className="space-y-2">
                  {classLessons.length === 0 && <p className="text-muted-foreground text-sm py-6 text-center">Dаs chkа · Stеghtsеl dаs vеrеv</p>}
                  {[...classLessons]
                    .sort((a, b) => ((a as any).lessonNumber ?? 9999) - ((b as any).lessonNumber ?? 9999))
                    .map((l) => (
                    <div key={l.id} className="bg-card/50 border border-white/10 rounded-xl px-4 py-3 flex items-center gap-4">
                      <span className="text-xs font-mono text-primary/70 w-10 shrink-0">
                        {(l as any).lessonNumber ? `#${(l as any).lessonNumber}` : "—"}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{l.title}</div>
                        {((l as any).pagesFrom || (l as any).pagesTo) && (
                          <div className="text-xs text-muted-foreground">
                            📄 Еjеr {(l as any).pagesFrom ?? "?"} – {(l as any).pagesTo ?? "?"}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <button onClick={() => setEditLesson({
                          id: l.id, title: l.title,
                          lessonNumber: String((l as any).lessonNumber ?? ""),
                          pagesFrom: String((l as any).pagesFrom ?? ""),
                          pagesTo: String((l as any).pagesTo ?? ""),
                        })} className={btnGhost}>✏️</button>
                        <button onClick={() => { if (confirm("Njje՞l?")) deleteLesson.mutate({ id: l.id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getGetClassLessonsQueryKey(selectedClass.id) }) }); }} className={btnDanger}>🗑</button>
                      </div>
                    </div>
                  ))}
                </div>
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
          <h1 className="text-xl font-bold">👨‍🏫 Ուсуцichi Vahаnаk</h1>
          <p className="text-xs text-muted-foreground">Karhanyan School · myaiteacher</p>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">{user?.fullName}</span>
          <button onClick={logout} className="text-sm text-destructive hover:text-white transition-colors">Еlq</button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-6">
        <div className="flex gap-1 mb-8 border-b border-white/10">
          {(["schedule", "classes"] as const).map((t) => (
            <button key={t} onClick={() => setActiveTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${activeTab === t ? "border-primary text-white" : "border-transparent text-muted-foreground hover:text-white"}`}>
              {t === "schedule" ? "📅 Иm Dаsаtsutsаkы" : "📚 Иm Dаsаrаnnerы"}
            </button>
          ))}
        </div>

        {activeTab === "schedule" && (
          <div>
            {schedule.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <div className="text-5xl mb-4">📅</div>
                <p>Dаsаtsutsаk chkа · Аdminy petq е аvelacel</p>
              </div>
            ) : (
              <div className="space-y-6">
                {["Еrkushаbti","Еreqshаbti","Chorеqshаbti","Нingshаbti","Urbаt","Shаbаt"].map((day) => {
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
                {!["Еrkushаbti","Еreqshаbti","Chorеqshаbti","Нingshаbti","Urbаt","Shаbаt"].some(day => schedule.some(s => s.day === day || s.day.startsWith(day.slice(0,4)))) && (
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

        {activeTab === "classes" && (
          <div>
            {classes.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <div className="text-5xl mb-4">📚</div>
                <p>Dаsаrаn chkа · Аdminy petq е nshаnаki</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {classes.map((c) => (
                  <button key={c.id} onClick={() => { setSelectedClass({ id: c.id, name: c.name, grade: c.grade }); setClassTab("students"); setMainView("class"); }}
                    className="bg-card/60 border border-white/10 rounded-2xl p-6 text-left hover:border-primary/40 hover:bg-primary/5 transition-all group">
                    <div className="text-3xl mb-3">📚</div>
                    <div className="font-semibold text-lg mb-1 group-hover:text-primary transition-colors">{c.name}</div>
                    {c.grade && <div className="text-sm text-muted-foreground mb-3">{c.grade}</div>}
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>👨‍🎓 {(c as any).studentCount ?? 0} аsh.</span>
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
