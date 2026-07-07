import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import QuickSwitch from "@/components/QuickSwitch";
import {
  useGetAdminStats,
  useGetAdminTeachers,
  useGetAdminClasses,
  useGetAdminStudents,
  useGetAdminSchedule,
  useCreateTeacher,
  useDeleteTeacher,
  useUpdateTeacher,
  useCreateClass,
  useDeleteClass,
  useUpdateClass,
  useCreateAdminStudent,
  useDeleteAdminStudent,
  useRemoveStudentFromClassAdmin,
  useCreateScheduleEntry,
  useDeleteScheduleEntry,
  useUpdateScheduleEntry,
  getGetAdminStatsQueryKey,
  getGetAdminTeachersQueryKey,
  getGetAdminClassesQueryKey,
  getGetAdminStudentsQueryKey,
  getGetAdminScheduleQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type Tab = "stats" | "teachers" | "classes" | "schedule" | "students";

const DAYS = ["Երկուշաբթի", "Երեքշաբթի", "Չորեքշաբթի", "Հինգշաբթի", "Ուրբաթ", "Շաբաթ"];
const TIMES = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"];

export default function AdminDashboard() {
  const { user, logout, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("stats");

  // ── data ──────────────────────────────────────────────────────────────────
  const { data: stats } = useGetAdminStats({ query: { queryKey: getGetAdminStatsQueryKey() } });
  const { data: teachers = [] } = useGetAdminTeachers({ query: { queryKey: getGetAdminTeachersQueryKey() } });
  const { data: classes = [] } = useGetAdminClasses({ query: { queryKey: getGetAdminClassesQueryKey() } });
  const { data: schedule = [] } = useGetAdminSchedule({ query: { queryKey: getGetAdminScheduleQueryKey() } });

  // students — filtered by selected class
  const [selectedClassId, setSelectedClassId] = useState<number | "">("");
  const { data: students = [] } = useGetAdminStudents(
    selectedClassId ? { classId: selectedClassId as number } : {},
    { query: { queryKey: getGetAdminStudentsQueryKey(selectedClassId ? { classId: selectedClassId as number } : {}) } }
  );

  // ── mutations ─────────────────────────────────────────────────────────────
  const createTeacher = useCreateTeacher();
  const deleteTeacher = useDeleteTeacher();
  const updateTeacher = useUpdateTeacher();
  const createClass = useCreateClass();
  const deleteClass = useDeleteClass();
  const updateClass = useUpdateClass();
  const createStudent = useCreateAdminStudent();
  const deleteStudent = useDeleteAdminStudent();
  const removeFromClass = useRemoveStudentFromClassAdmin();
  const createSchedule = useCreateScheduleEntry();
  const deleteSchedule = useDeleteScheduleEntry();
  const updateSchedule = useUpdateScheduleEntry();

  // ── invalidators ──────────────────────────────────────────────────────────
  const inv = (...keys: string[]) => {
    if (keys.includes("stats")) qc.invalidateQueries({ queryKey: getGetAdminStatsQueryKey() });
    if (keys.includes("teachers")) qc.invalidateQueries({ queryKey: getGetAdminTeachersQueryKey() });
    if (keys.includes("classes")) qc.invalidateQueries({ queryKey: getGetAdminClassesQueryKey() });
    if (keys.includes("schedule")) qc.invalidateQueries({ queryKey: getGetAdminScheduleQueryKey() });
    if (keys.includes("students")) qc.invalidateQueries({ queryKey: getGetAdminStudentsQueryKey(selectedClassId ? { classId: selectedClassId as number } : {}) });
  };

  // ── teacher form ──────────────────────────────────────────────────────────
  const emptyTeacher = { username: "", password: "", fullName: "", subject: "", school: "" };
  const [tForm, setTForm] = useState(emptyTeacher);
  const [tError, setTError] = useState("");
  const [showTForm, setShowTForm] = useState(false);
  const [editTeacher, setEditTeacher] = useState<{ id: number; fullName: string; subject: string; school: string } | null>(null);

  const handleCreateTeacher = (e: React.FormEvent) => {
    e.preventDefault(); setTError("");
    createTeacher.mutate({ data: { ...tForm } }, {
      onSuccess: () => { setShowTForm(false); setTForm(emptyTeacher); inv("teachers", "stats"); },
      onError: () => setTError("Սխալ. Փորձեք կրկին"),
    });
  };

  const handleUpdateTeacher = (e: React.FormEvent) => {
    e.preventDefault(); if (!editTeacher) return;
    updateTeacher.mutate({ id: editTeacher.id, data: { fullName: editTeacher.fullName, subject: editTeacher.subject, school: editTeacher.school } }, {
      onSuccess: () => { setEditTeacher(null); inv("teachers"); },
    });
  };

  // ── class form ────────────────────────────────────────────────────────────
  const emptyClass = { name: "", grade: "", teacherId: "" };
  const [cForm, setCForm] = useState(emptyClass);
  const [cError, setCError] = useState("");
  const [showCForm, setShowCForm] = useState(false);
  const [editClass, setEditClass] = useState<{ id: number; name: string; grade: string; teacherId: number } | null>(null);

  const handleCreateClass = (e: React.FormEvent) => {
    e.preventDefault(); setCError("");
    if (!cForm.teacherId) { setCError("Ընտրեք ուսուցիչ"); return; }
    createClass.mutate({ data: { name: cForm.name, grade: cForm.grade, teacherId: parseInt(cForm.teacherId) } }, {
      onSuccess: () => { setShowCForm(false); setCForm(emptyClass); inv("classes", "stats"); },
      onError: () => setCError("Սխալ"),
    });
  };

  const handleUpdateClass = (e: React.FormEvent) => {
    e.preventDefault(); if (!editClass) return;
    updateClass.mutate({ id: editClass.id, data: { name: editClass.name, grade: editClass.grade, teacherId: editClass.teacherId } }, {
      onSuccess: () => { setEditClass(null); inv("classes"); },
    });
  };

  // ── schedule form ─────────────────────────────────────────────────────────
  const emptySched = { classId: "", day: DAYS[0], time: TIMES[0], subject: "" };
  const [sForm, setSForm] = useState(emptySched);
  const [sError, setSError] = useState("");
  const [showSForm, setShowSForm] = useState(false);
  const [editSched, setEditSched] = useState<{ id: number; classId: number; day: string; time: string; subject: string } | null>(null);

  const handleCreateSched = (e: React.FormEvent) => {
    e.preventDefault(); setSError("");
    if (!sForm.classId) { setSError("Ընտրեք դասարան"); return; }
    createSchedule.mutate({ data: { classId: parseInt(sForm.classId), day: sForm.day, time: sForm.time, subject: sForm.subject } }, {
      onSuccess: () => { setShowSForm(false); setSForm(emptySched); inv("schedule"); },
      onError: () => setSError("Սխալ"),
    });
  };

  const handleUpdateSched = (e: React.FormEvent) => {
    e.preventDefault(); if (!editSched) return;
    updateSchedule.mutate({ id: editSched.id, data: { classId: editSched.classId, day: editSched.day, time: editSched.time, subject: editSched.subject } }, {
      onSuccess: () => { setEditSched(null); inv("schedule"); },
    });
  };

  // ── student form ──────────────────────────────────────────────────────────
  const emptySt = { username: "", password: "", fullName: "" };
  const [stForm, setStForm] = useState(emptySt);
  const [stError, setStError] = useState("");
  const [showStForm, setShowStForm] = useState(false);

  const handleCreateStudent = (e: React.FormEvent) => {
    e.preventDefault(); setStError("");
    createStudent.mutate({ data: { ...stForm, classId: selectedClassId || undefined } }, {
      onSuccess: () => { setShowStForm(false); setStForm(emptySt); inv("students", "stats"); },
      onError: () => setStError("Սխալ"),
    });
  };

  // ── guard ─────────────────────────────────────────────────────────────────
  if (authLoading) return <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background"><div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  if (user?.role !== "admin") { setLocation("/login"); return null; }

  const tabs: { key: Tab; label: string }[] = [
    { key: "stats", label: "📊 Վիճակագրություն" },
    { key: "teachers", label: "👨‍🏫 Ուսուցիչներ" },
    { key: "classes", label: "📚 Դասարաններ" },
    { key: "schedule", label: "📅 Դասացուցակ" },
    { key: "students", label: "👨‍🎓 Աշակերտներ" },
  ];

  const inputCls = "w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50";
  const btnPrimary = "px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-medium disabled:opacity-50 transition-all";
  const btnGhost = "px-3 py-1 rounded-lg text-xs text-muted-foreground hover:text-white border border-transparent hover:border-white/10 transition-colors";
  const btnDanger = "px-3 py-1 rounded-lg text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors";

  return (
    <div className="min-h-[100dvh] bg-background text-white">
      <QuickSwitch />
      {/* Header */}
      <header className="border-b border-white/10 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">👑 Admin Dashboard</h1>
          <p className="text-xs text-muted-foreground">Karhanyan School · myaiteacher</p>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">{user.fullName}</span>
          <button onClick={logout} className="text-sm text-destructive hover:text-white transition-colors">Ելք</button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* Tabs */}
        <div className="flex gap-1 mb-8 border-b border-white/10 overflow-x-auto">
          {tabs.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${tab === t.key ? "border-primary text-white" : "border-transparent text-muted-foreground hover:text-white"}`}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── STATS ── */}
        {tab === "stats" && (
          <div className="grid grid-cols-3 gap-6">
            {[
              { icon: "👨‍🏫", label: "Ուսուցիչներ", value: stats?.teachers ?? 0, color: "text-amber-400" },
              { icon: "📚", label: "Դասարաններ", value: stats?.classes ?? 0, color: "text-teal-400" },
              { icon: "👨‍🎓", label: "Աշակերտներ", value: stats?.students ?? 0, color: "text-indigo-400" },
            ].map((s) => (
              <div key={s.label} className="bg-card/60 border border-white/10 rounded-2xl p-8 text-center">
                <div className="text-5xl mb-4">{s.icon}</div>
                <div className={`text-4xl font-bold mb-2 ${s.color}`}>{s.value}</div>
                <div className="text-sm text-muted-foreground">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── TEACHERS ── */}
        {tab === "teachers" && (
          <div>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-semibold text-lg">Ուսուցիչներ</h2>
              <button onClick={() => setShowTForm(!showTForm)} className={btnPrimary}>+ Ավելացնել ուսուցիչ</button>
            </div>

            {showTForm && (
              <form onSubmit={handleCreateTeacher} className="mb-6 bg-card/50 border border-white/10 rounded-2xl p-5 space-y-3">
                <h3 className="font-medium mb-1">Նոր ուսուցիչ</h3>
                {tError && <p className="text-destructive text-xs">{tError}</p>}
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="text-xs text-muted-foreground">Անուն Ազգանուն *</label><input value={tForm.fullName} onChange={e => setTForm(f => ({ ...f, fullName: e.target.value }))} required className={inputCls} /></div>
                  <div><label className="text-xs text-muted-foreground">Օգտանուն *</label><input value={tForm.username} onChange={e => setTForm(f => ({ ...f, username: e.target.value }))} required className={inputCls} /></div>
                  <div><label className="text-xs text-muted-foreground">Գաղտնաբառ *</label><input type="password" value={tForm.password} onChange={e => setTForm(f => ({ ...f, password: e.target.value }))} required className={inputCls} /></div>
                  <div><label className="text-xs text-muted-foreground">Առարկա</label><input value={tForm.subject} onChange={e => setTForm(f => ({ ...f, subject: e.target.value }))} className={inputCls} /></div>
                  <div className="col-span-2"><label className="text-xs text-muted-foreground">Դպրոց</label><input value={tForm.school} onChange={e => setTForm(f => ({ ...f, school: e.target.value }))} className={inputCls} /></div>
                </div>
                <div className="flex gap-2 pt-1">
                  <button type="submit" disabled={createTeacher.isPending} className={btnPrimary}>{createTeacher.isPending ? "..." : "Պահպանել"}</button>
                  <button type="button" onClick={() => setShowTForm(false)} className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white">Չեղարկել</button>
                </div>
              </form>
            )}

            {/* Edit teacher modal */}
            {editTeacher && (
              <form onSubmit={handleUpdateTeacher} className="mb-6 bg-primary/5 border border-primary/20 rounded-2xl p-5 space-y-3">
                <h3 className="font-medium">Խմբագրել ուսուցչին</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="text-xs text-muted-foreground">Անուն Ազգանուն</label><input value={editTeacher.fullName} onChange={e => setEditTeacher(t => t && ({ ...t, fullName: e.target.value }))} className={inputCls} /></div>
                  <div><label className="text-xs text-muted-foreground">Առարկա</label><input value={editTeacher.subject} onChange={e => setEditTeacher(t => t && ({ ...t, subject: e.target.value }))} className={inputCls} /></div>
                  <div className="col-span-2"><label className="text-xs text-muted-foreground">Դպրոց</label><input value={editTeacher.school} onChange={e => setEditTeacher(t => t && ({ ...t, school: e.target.value }))} className={inputCls} /></div>
                </div>
                <div className="flex gap-2"><button type="submit" className={btnPrimary}>Պահպանել</button><button type="button" onClick={() => setEditTeacher(null)} className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white">Չեղարկել</button></div>
              </form>
            )}

            <div className="space-y-2">
              {teachers.length === 0 && <p className="text-muted-foreground text-sm py-8 text-center">Ուսուցիչ չկա</p>}
              {teachers.map((t) => (
                <div key={t.id} className="bg-card/50 border border-white/10 rounded-xl px-4 py-3 flex items-center justify-between">
                  <div>
                    <div className="font-medium">{t.fullName}</div>
                    <div className="text-xs text-muted-foreground">{t.username} {t.subject && `· ${t.subject}`} {t.school && `· ${t.school}`}</div>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => setEditTeacher({ id: t.id, fullName: t.fullName, subject: t.subject, school: t.school })} className={btnGhost}>✏️ Խմբագրել</button>
                    <button onClick={() => { if (confirm("Ջնջե՞լ ուսուցչին?")) deleteTeacher.mutate({ id: t.id }, { onSuccess: () => inv("teachers", "stats") }); }} className={btnDanger}>🗑 Ջնջել</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── CLASSES ── */}
        {tab === "classes" && (
          <div>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-semibold text-lg">Դասարաններ</h2>
              <button onClick={() => setShowCForm(!showCForm)} className={btnPrimary}>+ Ստեղծել դասարան</button>
            </div>

            {showCForm && (
              <form onSubmit={handleCreateClass} className="mb-6 bg-card/50 border border-white/10 rounded-2xl p-5 space-y-3">
                <h3 className="font-medium">Նոր դասարան</h3>
                {cError && <p className="text-destructive text-xs">{cError}</p>}
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="text-xs text-muted-foreground">Անուն * (օր. 7-1)</label><input value={cForm.name} onChange={e => setCForm(f => ({ ...f, name: e.target.value }))} required className={inputCls} placeholder="7-1" /></div>
                  <div><label className="text-xs text-muted-foreground">Կարգ (օր. 7-րդ)</label><input value={cForm.grade} onChange={e => setCForm(f => ({ ...f, grade: e.target.value }))} className={inputCls} placeholder="7" /></div>
                  <div className="col-span-2">
                    <label className="text-xs text-muted-foreground">Ուսուցիչ *</label>
                    <select value={cForm.teacherId} onChange={e => setCForm(f => ({ ...f, teacherId: e.target.value }))} className={inputCls}>
                      <option value="">Ընտրեք ուսուցիչ</option>
                      {teachers.map(t => <option key={t.id} value={t.id}>{t.fullName} {t.subject && `(${t.subject})`}</option>)}
                    </select>
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <button type="submit" disabled={createClass.isPending} className={btnPrimary}>{createClass.isPending ? "..." : "Պահպանել"}</button>
                  <button type="button" onClick={() => setShowCForm(false)} className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white">Չեղարկել</button>
                </div>
              </form>
            )}

            {editClass && (
              <form onSubmit={handleUpdateClass} className="mb-6 bg-primary/5 border border-primary/20 rounded-2xl p-5 space-y-3">
                <h3 className="font-medium">Խմբագրել դասարան</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="text-xs text-muted-foreground">Անուն</label><input value={editClass.name} onChange={e => setEditClass(c => c && ({ ...c, name: e.target.value }))} className={inputCls} /></div>
                  <div><label className="text-xs text-muted-foreground">Կարգ</label><input value={editClass.grade} onChange={e => setEditClass(c => c && ({ ...c, grade: e.target.value }))} className={inputCls} /></div>
                  <div className="col-span-2">
                    <label className="text-xs text-muted-foreground">Ուսուցիչ</label>
                    <select value={editClass.teacherId} onChange={e => setEditClass(c => c && ({ ...c, teacherId: parseInt(e.target.value) }))} className={inputCls}>
                      {teachers.map(t => <option key={t.id} value={t.id}>{t.fullName}</option>)}
                    </select>
                  </div>
                </div>
                <div className="flex gap-2"><button type="submit" className={btnPrimary}>Պահպանել</button><button type="button" onClick={() => setEditClass(null)} className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white">Չեղարկել</button></div>
              </form>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-muted-foreground text-left">
                    <th className="pb-3 pr-4">Անուն</th>
                    <th className="pb-3 pr-4">Կարգ</th>
                    <th className="pb-3 pr-4">Ուսուցիչ</th>
                    <th className="pb-3 pr-4">Աշակերտներ</th>
                    <th className="pb-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {classes.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-muted-foreground">Դասարան չկա</td></tr>}
                  {classes.map((c) => (
                    <tr key={c.id} className="hover:bg-white/2 transition-colors">
                      <td className="py-3 pr-4 font-medium">{c.name}</td>
                      <td className="py-3 pr-4 text-muted-foreground">{c.grade || "—"}</td>
                      <td className="py-3 pr-4 text-muted-foreground">{c.teacherName}</td>
                      <td className="py-3 pr-4 text-muted-foreground">{(c as any).studentCount ?? 0}</td>
                      <td className="py-3">
                        <div className="flex gap-1">
                          <button onClick={() => setEditClass({ id: c.id, name: c.name, grade: c.grade, teacherId: c.teacherId })} className={btnGhost}>✏️</button>
                          <button onClick={() => { if (confirm("Ջնջե՞լ դասարանը?")) deleteClass.mutate({ id: c.id }, { onSuccess: () => inv("classes", "stats") }); }} className={btnDanger}>🗑</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── SCHEDULE ── */}
        {tab === "schedule" && (
          <div>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-semibold text-lg">Դասացուցակ</h2>
              <button onClick={() => setShowSForm(!showSForm)} className={btnPrimary}>+ Ավելացնել դաս</button>
            </div>

            {showSForm && (
              <form onSubmit={handleCreateSched} className="mb-6 bg-card/50 border border-white/10 rounded-2xl p-5 space-y-3">
                <h3 className="font-medium">Նոր դաս</h3>
                {sError && <p className="text-destructive text-xs">{sError}</p>}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground">Օր *</label>
                    <select value={sForm.day} onChange={e => setSForm(f => ({ ...f, day: e.target.value }))} className={inputCls}>
                      {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Ժամ *</label>
                    <select value={sForm.time} onChange={e => setSForm(f => ({ ...f, time: e.target.value }))} className={inputCls}>
                      {TIMES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Առարկա *</label>
                    <input value={sForm.subject} onChange={e => setSForm(f => ({ ...f, subject: e.target.value }))} required className={inputCls} />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Դասարան *</label>
                    <select value={sForm.classId} onChange={e => setSForm(f => ({ ...f, classId: e.target.value }))} className={inputCls}>
                      <option value="">Ընտրեք դասարան</option>
                      {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <button type="submit" disabled={createSchedule.isPending} className={btnPrimary}>{createSchedule.isPending ? "..." : "Պահպանել"}</button>
                  <button type="button" onClick={() => setShowSForm(false)} className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white">Չեղարկել</button>
                </div>
              </form>
            )}

            {editSched && (
              <form onSubmit={handleUpdateSched} className="mb-6 bg-primary/5 border border-primary/20 rounded-2xl p-5 space-y-3">
                <h3 className="font-medium">Խմբագրել դաս</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="text-xs text-muted-foreground">Օր</label><select value={editSched.day} onChange={e => setEditSched(s => s && ({ ...s, day: e.target.value }))} className={inputCls}>{DAYS.map(d => <option key={d} value={d}>{d}</option>)}</select></div>
                  <div><label className="text-xs text-muted-foreground">Ժամ</label><select value={editSched.time} onChange={e => setEditSched(s => s && ({ ...s, time: e.target.value }))} className={inputCls}>{TIMES.map(t => <option key={t} value={t}>{t}</option>)}</select></div>
                  <div><label className="text-xs text-muted-foreground">Առարկա</label><input value={editSched.subject} onChange={e => setEditSched(s => s && ({ ...s, subject: e.target.value }))} className={inputCls} /></div>
                  <div><label className="text-xs text-muted-foreground">Դասարան</label><select value={editSched.classId} onChange={e => setEditSched(s => s && ({ ...s, classId: parseInt(e.target.value) }))} className={inputCls}>{classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
                </div>
                <div className="flex gap-2"><button type="submit" className={btnPrimary}>Պահպանել</button><button type="button" onClick={() => setEditSched(null)} className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white">Չեղարկել</button></div>
              </form>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-muted-foreground text-left">
                    <th className="pb-3 pr-4">Օր</th>
                    <th className="pb-3 pr-4">Ժամ</th>
                    <th className="pb-3 pr-4">Առարկա</th>
                    <th className="pb-3 pr-4">Դասարան</th>
                    <th className="pb-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {schedule.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-muted-foreground">Դասացուցակ դատարկ է</td></tr>}
                  {schedule.map((s) => (
                    <tr key={s.id} className="hover:bg-white/2">
                      <td className="py-3 pr-4 font-medium">{s.day}</td>
                      <td className="py-3 pr-4 text-teal-400 font-mono">{s.time}</td>
                      <td className="py-3 pr-4">{s.subject}</td>
                      <td className="py-3 pr-4 text-muted-foreground">{s.className}</td>
                      <td className="py-3">
                        <div className="flex gap-1">
                          <button onClick={() => setEditSched({ id: s.id, classId: s.classId, day: s.day, time: s.time, subject: s.subject })} className={btnGhost}>✏️</button>
                          <button onClick={() => { if (confirm("Ջնջե՞լ?")) deleteSchedule.mutate({ id: s.id }, { onSuccess: () => inv("schedule") }); }} className={btnDanger}>🗑</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── STUDENTS ── */}
        {tab === "students" && (
          <div>
            <div className="flex flex-wrap items-center gap-4 mb-5">
              <h2 className="font-semibold text-lg">Աշակերտներ</h2>
              <select value={selectedClassId} onChange={e => setSelectedClassId(e.target.value ? parseInt(e.target.value) : "")}
                className="bg-background/50 border border-input rounded-xl px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary/50">
                <option value="">Բոլոր աշակերտները</option>
                {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button onClick={() => setShowStForm(!showStForm)} className={btnPrimary}>+ Ավելացնել աշակերտ</button>
            </div>

            {showStForm && (
              <form onSubmit={handleCreateStudent} className="mb-6 bg-card/50 border border-white/10 rounded-2xl p-5 space-y-3">
                <h3 className="font-medium">Նոր աշակերտ {selectedClassId ? `(${classes.find(c => c.id === selectedClassId)?.name})` : ""}</h3>
                {stError && <p className="text-destructive text-xs">{stError}</p>}
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="text-xs text-muted-foreground">Անուն Ազգանուն *</label><input value={stForm.fullName} onChange={e => setStForm(f => ({ ...f, fullName: e.target.value }))} required className={inputCls} /></div>
                  <div><label className="text-xs text-muted-foreground">Օգտանուն *</label><input value={stForm.username} onChange={e => setStForm(f => ({ ...f, username: e.target.value }))} required className={inputCls} /></div>
                  <div className="col-span-2"><label className="text-xs text-muted-foreground">Գաղտնաբառ *</label><input type="password" value={stForm.password} onChange={e => setStForm(f => ({ ...f, password: e.target.value }))} required className={inputCls} /></div>
                </div>
                <div className="flex gap-2 pt-1">
                  <button type="submit" disabled={createStudent.isPending} className={btnPrimary}>{createStudent.isPending ? "..." : "Պահպանել"}</button>
                  <button type="button" onClick={() => setShowStForm(false)} className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white">Չեղարկել</button>
                </div>
              </form>
            )}

            <div className="space-y-2">
              {students.length === 0 && <p className="text-muted-foreground text-sm py-8 text-center">Աշակերտ չկա</p>}
              {students.map((s) => (
                <div key={s.id} className="bg-card/50 border border-white/10 rounded-xl px-4 py-3 flex items-center justify-between">
                  <div>
                    <div className="font-medium">{s.fullName}</div>
                    <div className="text-xs text-muted-foreground">{s.username}</div>
                  </div>
                  <div className="flex gap-1">
                    {selectedClassId && (
                      <button onClick={() => removeFromClass.mutate({ id: s.id, data: { classId: selectedClassId as number } }, { onSuccess: () => inv("students") })} className={btnGhost}>
                        Հեռացնել դասարանից
                      </button>
                    )}
                    <button onClick={() => { if (confirm(`Ջնջե՞լ ${s.fullName}?`)) deleteStudent.mutate({ id: s.id }, { onSuccess: () => inv("students", "stats") }); }} className={btnDanger}>🗑 Ջնջել</button>
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
