import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import {
  useGetTeacherClasses,
  useGetClassStudents,
  useAddStudentToClass,
  useRemoveStudentFromClass,
  useGetTeacherLessons,
  useCreateTeacherLesson,
  useGetSubjects,
  getGetTeacherClassesQueryKey,
  getGetClassStudentsQueryKey,
  getGetTeacherLessonsQueryKey,
  getGetSubjectsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export default function TeacherDashboard() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();

  const [tab, setTab] = useState<"classes" | "lessons">("classes");
  const [selectedClassId, setSelectedClassId] = useState<number | null>(null);

  const { data: classes = [] } = useGetTeacherClasses({ query: { queryKey: getGetTeacherClassesQueryKey() } });
  const { data: subjects = [] } = useGetSubjects({ query: { queryKey: getGetSubjectsQueryKey() } });
  const { data: lessons = [] } = useGetTeacherLessons({ query: { queryKey: getGetTeacherLessonsQueryKey() } });

  const { data: students = [] } = useGetClassStudents(
    selectedClassId ?? 0,
    { query: { enabled: !!selectedClassId, queryKey: getGetClassStudentsQueryKey(selectedClassId ?? 0) } }
  );

  const addStudent = useAddStudentToClass();
  const removeStudent = useRemoveStudentFromClass();
  const createLesson = useCreateTeacherLesson();

  const [studentForm, setStudentForm] = useState({ username: "", password: "", fullName: "" });
  const [studentError, setStudentError] = useState("");
  const [showStudentForm, setShowStudentForm] = useState(false);

  const [lessonForm, setLessonForm] = useState({ subjectId: "", title: "", description: "", bloomLevel: "1", content: "" });
  const [lessonError, setLessonError] = useState("");
  const [showLessonForm, setShowLessonForm] = useState(false);

  const handleAddStudent = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedClassId) return;
    setStudentError("");
    addStudent.mutate(
      { classId: selectedClassId, data: { username: studentForm.username, password: studentForm.password, fullName: studentForm.fullName } },
      {
        onSuccess: () => {
          setShowStudentForm(false);
          setStudentForm({ username: "", password: "", fullName: "" });
          qc.invalidateQueries({ queryKey: getGetClassStudentsQueryKey(selectedClassId) });
        },
        onError: () => setStudentError("Սխալ. Փորձեք կրկին"),
      }
    );
  };

  const handleRemoveStudent = (studentId: number) => {
    if (!selectedClassId) return;
    if (!confirm("Հեռացնե՞լ աշակերտին դասարանից:")) return;
    removeStudent.mutate(
      { classId: selectedClassId, studentId },
      { onSuccess: () => qc.invalidateQueries({ queryKey: getGetClassStudentsQueryKey(selectedClassId) }) }
    );
  };

  const handleCreateLesson = (e: React.FormEvent) => {
    e.preventDefault();
    setLessonError("");
    createLesson.mutate(
      {
        data: {
          subjectId: parseInt(lessonForm.subjectId),
          title: lessonForm.title,
          description: lessonForm.description,
          bloomLevel: parseInt(lessonForm.bloomLevel),
          content: lessonForm.content,
        },
      },
      {
        onSuccess: () => {
          setShowLessonForm(false);
          setLessonForm({ subjectId: "", title: "", description: "", bloomLevel: "1", content: "" });
          qc.invalidateQueries({ queryKey: getGetTeacherLessonsQueryKey() });
        },
        onError: () => setLessonError("Սխալ. Փորձեք կրկին"),
      }
    );
  };

  if (user?.role !== "teacher" && user?.role !== "admin") {
    setLocation("/login");
    return null;
  }

  return (
    <div className="min-h-[100dvh] bg-background text-white">
      {/* Header */}
      <header className="border-b border-white/10 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">👨‍🏫 Ուսուցչի վահանակ</h1>
          <p className="text-sm text-muted-foreground">Karhanyan School</p>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">{user?.fullName}</span>
          <button onClick={logout} className="text-sm text-destructive hover:text-white transition-colors">Ելք</button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Tabs */}
        <div className="flex gap-2 mb-8 border-b border-white/10">
          {(["classes", "lessons"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${tab === t ? "border-primary text-white" : "border-transparent text-muted-foreground hover:text-white"}`}
            >
              {t === "classes" ? "📚 Իմ դասարանները" : "📖 Դասեր"}
            </button>
          ))}
        </div>

        {/* Classes Tab */}
        {tab === "classes" && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Class list */}
            <div className="lg:col-span-1">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-4">Դասարաններ</h2>
              <div className="space-y-2">
                {classes.length === 0 && <p className="text-muted-foreground text-sm">Դասարան չկա (Admin-ը կարող է ավելացնել)</p>}
                {classes.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setSelectedClassId(c.id)}
                    className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${selectedClassId === c.id ? "border-primary/50 bg-primary/10 text-white" : "border-white/10 bg-card/40 text-muted-foreground hover:text-white hover:border-white/20"}`}
                  >
                    <div className="font-medium">{c.name}</div>
                    {c.grade && <div className="text-xs">{c.grade} դաս</div>}
                  </button>
                ))}
              </div>
            </div>

            {/* Students in selected class */}
            <div className="lg:col-span-2">
              {!selectedClassId ? (
                <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">Ընտրեք դասարան</div>
              ) : (
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Աշակերտներ</h2>
                    <button
                      onClick={() => setShowStudentForm(!showStudentForm)}
                      className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-secondary to-primary text-white text-xs font-medium"
                    >
                      + Ավելացնել
                    </button>
                  </div>

                  {showStudentForm && (
                    <form onSubmit={handleAddStudent} className="mb-4 bg-card/60 border border-white/10 rounded-xl p-4 space-y-3">
                      {studentError && <p className="text-destructive text-xs">{studentError}</p>}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-muted-foreground mb-1">Անուն Ազգանուն *</label>
                          <input value={studentForm.fullName} onChange={e => setStudentForm(f => ({ ...f, fullName: e.target.value }))} required className="w-full bg-background/50 border border-input rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
                        </div>
                        <div>
                          <label className="block text-xs text-muted-foreground mb-1">Օգտանուն *</label>
                          <input value={studentForm.username} onChange={e => setStudentForm(f => ({ ...f, username: e.target.value }))} required className="w-full bg-background/50 border border-input rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
                        </div>
                        <div className="col-span-2">
                          <label className="block text-xs text-muted-foreground mb-1">Գաղտնաբառ *</label>
                          <input type="password" value={studentForm.password} onChange={e => setStudentForm(f => ({ ...f, password: e.target.value }))} required className="w-full bg-background/50 border border-input rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
                        </div>
                      </div>
                      <div className="flex gap-2 pt-1">
                        <button type="submit" disabled={addStudent.isPending} className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-primary to-secondary text-white text-xs font-medium disabled:opacity-50">
                          {addStudent.isPending ? "Ավելացվում..." : "Ավելացնել"}
                        </button>
                        <button type="button" onClick={() => setShowStudentForm(false)} className="px-3 py-1.5 rounded-lg border border-white/10 text-muted-foreground text-xs hover:text-white">Չեղարկել</button>
                      </div>
                    </form>
                  )}

                  <div className="space-y-2">
                    {students.length === 0 && <p className="text-muted-foreground text-sm">Աշակերտ չկա</p>}
                    {students.map((s) => (
                      <div key={s.id} className="bg-card/60 border border-white/10 rounded-xl px-4 py-3 flex items-center justify-between">
                        <div>
                          <div className="font-medium text-sm text-white">{s.fullName}</div>
                          <div className="text-xs text-muted-foreground">{s.username}</div>
                        </div>
                        <button
                          onClick={() => handleRemoveStudent(s.id)}
                          className="text-xs text-muted-foreground hover:text-destructive transition-colors px-2 py-1 rounded hover:bg-destructive/10"
                        >
                          Հեռացնել
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Lessons Tab */}
        {tab === "lessons" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold">Իմ դասերը</h2>
              <button
                onClick={() => setShowLessonForm(!showLessonForm)}
                className="px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-medium"
              >
                + Ստեղծել դաս
              </button>
            </div>

            {showLessonForm && (
              <form onSubmit={handleCreateLesson} className="mb-6 bg-card/60 border border-white/10 rounded-2xl p-6 space-y-4">
                <h3 className="font-medium text-white">Նոր դաս</h3>
                {lessonError && <p className="text-destructive text-sm">{lessonError}</p>}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">Առարկա *</label>
                    <select value={lessonForm.subjectId} onChange={e => setLessonForm(f => ({ ...f, subjectId: e.target.value }))} required className="w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50">
                      <option value="">Ընտրեք առարկա</option>
                      {subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">Բլումի մակ.</label>
                    <select value={lessonForm.bloomLevel} onChange={e => setLessonForm(f => ({ ...f, bloomLevel: e.target.value }))} className="w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50">
                      <option value="1">1 - Հիշել</option>
                      <option value="2">2 - Հասկանալ</option>
                      <option value="3">3 - Կիրառել</option>
                      <option value="4">4 - Վերլուծել</option>
                      <option value="5">5 - Գնահատել</option>
                      <option value="6">6 - Ստեղծել</option>
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-muted-foreground mb-1">Վերնագիր *</label>
                    <input value={lessonForm.title} onChange={e => setLessonForm(f => ({ ...f, title: e.target.value }))} required className="w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-muted-foreground mb-1">Նկարագրություն</label>
                    <input value={lessonForm.description} onChange={e => setLessonForm(f => ({ ...f, description: e.target.value }))} className="w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-muted-foreground mb-1">Բովանդակություն</label>
                    <textarea value={lessonForm.content} onChange={e => setLessonForm(f => ({ ...f, content: e.target.value }))} rows={4} className="w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none" />
                  </div>
                </div>
                <div className="flex gap-3 pt-2">
                  <button type="submit" disabled={createLesson.isPending} className="px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-medium disabled:opacity-50">
                    {createLesson.isPending ? "Ստեղծվում..." : "Ստեղծել"}
                  </button>
                  <button type="button" onClick={() => setShowLessonForm(false)} className="px-4 py-2 rounded-xl border border-white/10 text-muted-foreground text-sm hover:text-white">Չեղարկել</button>
                </div>
              </form>
            )}

            <div className="space-y-3">
              {lessons.length === 0 && <p className="text-muted-foreground text-sm">Դաս չկա</p>}
              {lessons.map((l) => (
                <div key={l.id} className="bg-card/60 border border-white/10 rounded-xl p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="font-medium text-white">{l.title}</div>
                      {l.description && <div className="text-sm text-muted-foreground mt-1">{l.description}</div>}
                    </div>
                    <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded-full">Բ{l.bloomLevel}</span>
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
