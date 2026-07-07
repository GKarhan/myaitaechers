import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import {
  useGetAdminStats,
  useGetAdminTeachers,
  useGetAdminClasses,
  useCreateTeacher,
  useDeleteTeacher,
  useCreateClass,
  useDeleteClass,
  getGetAdminStatsQueryKey,
  getGetAdminTeachersQueryKey,
  getGetAdminClassesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export default function AdminDashboard() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();

  const [tab, setTab] = useState<"teachers" | "classes" | "stats">("stats");

  // Stats
  const { data: stats } = useGetAdminStats({ query: { queryKey: getGetAdminStatsQueryKey() } });

  // Teachers
  const { data: teachers = [] } = useGetAdminTeachers({ query: { queryKey: getGetAdminTeachersQueryKey() } });
  const createTeacher = useCreateTeacher();
  const deleteTeacher = useDeleteTeacher();

  const [teacherForm, setTeacherForm] = useState({ username: "", password: "", fullName: "", subject: "", school: "" });
  const [teacherError, setTeacherError] = useState("");
  const [showTeacherForm, setShowTeacherForm] = useState(false);

  // Classes
  const { data: classes = [] } = useGetAdminClasses({ query: { queryKey: getGetAdminClassesQueryKey() } });
  const createClass = useCreateClass();
  const deleteClass = useDeleteClass();

  const [classForm, setClassForm] = useState({ name: "", grade: "", teacherId: "" });
  const [classError, setClassError] = useState("");
  const [showClassForm, setShowClassForm] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetAdminStatsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetAdminTeachersQueryKey() });
    qc.invalidateQueries({ queryKey: getGetAdminClassesQueryKey() });
  };

  const handleCreateTeacher = (e: React.FormEvent) => {
    e.preventDefault();
    setTeacherError("");
    createTeacher.mutate(
      { data: { username: teacherForm.username, password: teacherForm.password, fullName: teacherForm.fullName, subject: teacherForm.subject, school: teacherForm.school } },
      {
        onSuccess: () => { setShowTeacherForm(false); setTeacherForm({ username: "", password: "", fullName: "", subject: "", school: "" }); invalidate(); },
        onError: () => setTeacherError("Սխալ. Փորձեք կրկին"),
      }
    );
  };

  const handleDeleteTeacher = (id: number) => {
    if (!confirm("Ջնջե՞լ ուսուցիչը:")) return;
    deleteTeacher.mutate({ id }, { onSuccess: invalidate });
  };

  const handleCreateClass = (e: React.FormEvent) => {
    e.preventDefault();
    setClassError("");
    if (!classForm.teacherId) { setClassError("Ընտրեք ուսուցիչ"); return; }
    createClass.mutate(
      { data: { name: classForm.name, grade: classForm.grade, teacherId: parseInt(classForm.teacherId) } },
      {
        onSuccess: () => { setShowClassForm(false); setClassForm({ name: "", grade: "", teacherId: "" }); invalidate(); },
        onError: () => setClassError("Սխալ. Փորձեք կրկին"),
      }
    );
  };

  const handleDeleteClass = (id: number) => {
    if (!confirm("Ջնջե՞լ դասարանը:")) return;
    deleteClass.mutate({ id }, { onSuccess: invalidate });
  };

  if (user?.role !== "admin") {
    setLocation("/login");
    return null;
  }

  return (
    <div className="min-h-[100dvh] bg-background text-white">
      {/* Header */}
      <header className="border-b border-white/10 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">👑 Admin Dashboard</h1>
          <p className="text-sm text-muted-foreground">Karhanyan School</p>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">{user.fullName}</span>
          <button onClick={logout} className="text-sm text-destructive hover:text-white transition-colors">Ելք</button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Tabs */}
        <div className="flex gap-2 mb-8 border-b border-white/10">
          {(["stats", "teachers", "classes"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${tab === t ? "border-primary text-white" : "border-transparent text-muted-foreground hover:text-white"}`}
            >
              {t === "stats" ? "📊 Վիճակագրություն" : t === "teachers" ? "📋 Ուսուցիչներ" : "📚 Դասարաններ"}
            </button>
          ))}
        </div>

        {/* Stats Tab */}
        {tab === "stats" && (
          <div className="grid grid-cols-3 gap-6">
            {[
              { label: "Ուսուցիչներ", value: stats?.teachers ?? 0, icon: "👨‍🏫" },
              { label: "Դասարաններ", value: stats?.classes ?? 0, icon: "📚" },
              { label: "Աշակերտներ", value: stats?.students ?? 0, icon: "👨‍🎓" },
            ].map((s) => (
              <div key={s.label} className="bg-card/60 border border-white/10 rounded-2xl p-6 text-center">
                <div className="text-4xl mb-3">{s.icon}</div>
                <div className="text-3xl font-bold text-white mb-1">{s.value}</div>
                <div className="text-sm text-muted-foreground">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Teachers Tab */}
        {tab === "teachers" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold">Ուսուցիչների ցանկ</h2>
              <button
                onClick={() => setShowTeacherForm(!showTeacherForm)}
                className="px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-medium"
              >
                + Ավելացնել ուսուցիչ
              </button>
            </div>

            {showTeacherForm && (
              <form onSubmit={handleCreateTeacher} className="mb-6 bg-card/60 border border-white/10 rounded-2xl p-6 space-y-4">
                <h3 className="font-medium text-white mb-4">Նոր ուսուցիչ</h3>
                {teacherError && <p className="text-destructive text-sm">{teacherError}</p>}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">Անուն Ազգանուն *</label>
                    <input value={teacherForm.fullName} onChange={e => setTeacherForm(f => ({ ...f, fullName: e.target.value }))} required className="w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  </div>
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">Օգտանուն *</label>
                    <input value={teacherForm.username} onChange={e => setTeacherForm(f => ({ ...f, username: e.target.value }))} required className="w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  </div>
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">Գաղտնաբառ *</label>
                    <input type="password" value={teacherForm.password} onChange={e => setTeacherForm(f => ({ ...f, password: e.target.value }))} required className="w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  </div>
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">Առարկա</label>
                    <input value={teacherForm.subject} onChange={e => setTeacherForm(f => ({ ...f, subject: e.target.value }))} className="w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-muted-foreground mb-1">Դպրոց</label>
                    <input value={teacherForm.school} onChange={e => setTeacherForm(f => ({ ...f, school: e.target.value }))} className="w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  </div>
                </div>
                <div className="flex gap-3 pt-2">
                  <button type="submit" disabled={createTeacher.isPending} className="px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-medium disabled:opacity-50">
                    {createTeacher.isPending ? "Ավելացվում..." : "Ավելացնել"}
                  </button>
                  <button type="button" onClick={() => setShowTeacherForm(false)} className="px-4 py-2 rounded-xl border border-white/10 text-muted-foreground text-sm hover:text-white transition-colors">Չեղարկել</button>
                </div>
              </form>
            )}

            <div className="space-y-3">
              {teachers.length === 0 && <p className="text-muted-foreground text-sm">Ուսուցիչ չկա</p>}
              {teachers.map((t) => (
                <div key={t.id} className="bg-card/60 border border-white/10 rounded-xl p-4 flex items-center justify-between">
                  <div>
                    <div className="font-medium text-white">{t.fullName}</div>
                    <div className="text-sm text-muted-foreground">{t.username} · {t.subject || "—"} · {t.school || "—"}</div>
                  </div>
                  <button
                    onClick={() => handleDeleteTeacher(t.id)}
                    className="text-sm text-muted-foreground hover:text-destructive transition-colors px-3 py-1 rounded-lg hover:bg-destructive/10"
                  >
                    🗑 Ջնջել
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Classes Tab */}
        {tab === "classes" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold">Դասարանների ցանկ</h2>
              <button
                onClick={() => setShowClassForm(!showClassForm)}
                className="px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-medium"
              >
                + Ստեղծել դասարան
              </button>
            </div>

            {showClassForm && (
              <form onSubmit={handleCreateClass} className="mb-6 bg-card/60 border border-white/10 rounded-2xl p-6 space-y-4">
                <h3 className="font-medium text-white mb-4">Նոր դասարան</h3>
                {classError && <p className="text-destructive text-sm">{classError}</p>}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">Անուն *</label>
                    <input value={classForm.name} onChange={e => setClassForm(f => ({ ...f, name: e.target.value }))} required className="w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" placeholder="օր․ 10Ա" />
                  </div>
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">Դասարան</label>
                    <input value={classForm.grade} onChange={e => setClassForm(f => ({ ...f, grade: e.target.value }))} className="w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" placeholder="10" />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-muted-foreground mb-1">Ուսուցիչ *</label>
                    <select value={classForm.teacherId} onChange={e => setClassForm(f => ({ ...f, teacherId: e.target.value }))} className="w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50">
                      <option value="">Ընտրեք ուսուցիչ</option>
                      {teachers.map(t => <option key={t.id} value={t.id}>{t.fullName} ({t.subject})</option>)}
                    </select>
                  </div>
                </div>
                <div className="flex gap-3 pt-2">
                  <button type="submit" disabled={createClass.isPending} className="px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-medium disabled:opacity-50">
                    {createClass.isPending ? "Ստեղծվում..." : "Ստեղծել"}
                  </button>
                  <button type="button" onClick={() => setShowClassForm(false)} className="px-4 py-2 rounded-xl border border-white/10 text-muted-foreground text-sm hover:text-white transition-colors">Չեղարկել</button>
                </div>
              </form>
            )}

            <div className="space-y-3">
              {classes.length === 0 && <p className="text-muted-foreground text-sm">Դասարան չկա</p>}
              {classes.map((c) => (
                <div key={c.id} className="bg-card/60 border border-white/10 rounded-xl p-4 flex items-center justify-between">
                  <div>
                    <div className="font-medium text-white">{c.name} {c.grade && `(${c.grade})`}</div>
                    <div className="text-sm text-muted-foreground">Ուսուցիչ: {c.teacherName ?? "—"}</div>
                  </div>
                  <button
                    onClick={() => handleDeleteClass(c.id)}
                    className="text-sm text-muted-foreground hover:text-destructive transition-colors px-3 py-1 rounded-lg hover:bg-destructive/10"
                  >
                    🗑 Ջնջել
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
