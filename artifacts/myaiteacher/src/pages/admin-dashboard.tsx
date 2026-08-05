import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import QuickSwitch from "@/components/QuickSwitch";
import {
  useGetAdminStats,
  useGetAdminTeachers,
  useGetAdminClasses,
  useGetAdminStudents,
  useGetAdminSchedule,
  useGetSubjects,
  useCreateTeacher,
  useDeleteTeacher,
  useUpdateTeacher,
  useCreateClass,
  useDeleteClass,
  useUpdateClass,
  useCreateAdminStudent,
  useDeleteAdminStudent,
  useRemoveStudentFromClassAdmin,
  useAssignStudentToClass,
  useCreateScheduleEntry,
  useDeleteScheduleEntry,
  useUpdateScheduleEntry,
  useCreateAdminSubject,
  useDeleteAdminSubject,
  getGetAdminStatsQueryKey,
  getGetAdminTeachersQueryKey,
  getGetAdminClassesQueryKey,
  getGetAdminStudentsQueryKey,
  getGetAdminScheduleQueryKey,
  getGetSubjectsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";

type Tab =
  | "home"
  | "teachers"
  | "classes"
  | "schedule"
  | "students"
  | "subjects";

const DAYS = [
  "Երկուշաբթի",
  "Երեքշաբթի",
  "Չորեքշաբթի",
  "Հինգշաբթի",
  "Ուրբաթ",
  "Շաբաթ",
];
const TIME_OPTIONS = [
  "08:00",
  "08:30",
  "09:00",
  "09:30",
  "10:00",
  "10:30",
  "11:00",
  "11:30",
  "12:00",
  "12:30",
  "13:00",
  "13:30",
  "14:00",
  "14:30",
  "15:00",
  "15:30",
  "16:00",
  "16:30",
  "17:00",
  "17:30",
];

export default function AdminDashboard() {
  const { user, logout, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("home");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // Close sidebar when clicking outside (mobile)
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (sidebarOpen && sidebarRef.current && !sidebarRef.current.contains(e.target as Node))
        setSidebarOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [sidebarOpen]);

  // ── data ──────────────────────────────────────────────────────────────────
  const { data: stats } = useGetAdminStats({
    query: { queryKey: getGetAdminStatsQueryKey() },
  });
  const { data: teachers = [] } = useGetAdminTeachers({
    query: { queryKey: getGetAdminTeachersQueryKey() },
  });
  const { data: classes = [] } = useGetAdminClasses({
    query: { queryKey: getGetAdminClassesQueryKey() },
  });
  const { data: schedule = [] } = useGetAdminSchedule({
    query: { queryKey: getGetAdminScheduleQueryKey() },
  });
  const { data: subjectsList = [] } = useGetSubjects({
    query: { queryKey: getGetSubjectsQueryKey() },
  });

  // students — filtered by selected class (for the students tab)
  const [selectedClassId, setSelectedClassId] = useState<number | "">("");
  const { data: students = [] } = useGetAdminStudents(
    selectedClassId ? { classId: selectedClassId as number } : {},
    {
      query: {
        queryKey: getGetAdminStudentsQueryKey(
          selectedClassId ? { classId: selectedClassId as number } : {},
        ),
      },
    },
  );
  // all students unfiltered — for assignment dropdown in classes tab
  const { data: allStudents = [] } = useGetAdminStudents(
    {},
    { query: { queryKey: [...getGetAdminStudentsQueryKey({}), "all"] } },
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
  const assignStudent = useAssignStudentToClass();
  const createSchedule = useCreateScheduleEntry();
  const deleteSchedule = useDeleteScheduleEntry();
  const updateSchedule = useUpdateScheduleEntry();
  const createSubject = useCreateAdminSubject();
  const deleteSubject = useDeleteAdminSubject();

  // ── invalidators ──────────────────────────────────────────────────────────
  const inv = (...keys: string[]) => {
    if (keys.includes("stats"))
      qc.invalidateQueries({ queryKey: getGetAdminStatsQueryKey() });
    if (keys.includes("teachers"))
      qc.invalidateQueries({ queryKey: getGetAdminTeachersQueryKey() });
    if (keys.includes("classes"))
      qc.invalidateQueries({ queryKey: getGetAdminClassesQueryKey() });
    if (keys.includes("schedule"))
      qc.invalidateQueries({ queryKey: getGetAdminScheduleQueryKey() });
    if (keys.includes("students"))
      qc.invalidateQueries({
        queryKey: getGetAdminStudentsQueryKey(
          selectedClassId ? { classId: selectedClassId as number } : {},
        ),
      });
    if (keys.includes("subjects"))
      qc.invalidateQueries({ queryKey: getGetSubjectsQueryKey() });
  };

  // ── subjects from schedule ─────────────────────────────────────────────
  const scheduleSubjects = Array.from(
    new Set(schedule.map((s) => s.subject).filter(Boolean)),
  );

  // ── subject registry form ─────────────────────────────────────────────────
  const [subName, setSubName] = useState("");
  const [subError, setSubError] = useState("");

  const handleCreateSubject = (e: React.FormEvent) => {
    e.preventDefault();
    setSubError("");
    if (!subName.trim()) {
      setSubError("Մուտqаgrerq ararkay anuny");
      return;
    }
    createSubject.mutate(
      { data: { name: subName.trim() } },
      {
        onSuccess: () => {
          setSubName("");
          inv("subjects");
        },
        onError: (err: any) =>
          setSubError(err?.response?.data?.error || "Sxal. Pordzek krkin"),
      },
    );
  };

  const handleDeleteSubject = (id: number, name: string) => {
    const linked = teachers.filter((t) => t.subjects?.includes(name)).length;
    const msg =
      linked > 0
        ? "Զgushacum. ays ararkany kapvac e vorosh usucichner het, hamovzve՞l eq vor cankanum eq djnjel:"
        : `Djnjel «${name}»?`;
    if (confirm(msg)) {
      deleteSubject.mutate({ id }, { onSuccess: () => inv("subjects") });
    }
  };

  // ── teacher form ──────────────────────────────────────────────────────────
  const emptyTeacher = { fullName: "", email: "", subjects: [] as string[] };
  const [tForm, setTForm] = useState(emptyTeacher);
  const [tError, setTError] = useState("");
  const [showTForm, setShowTForm] = useState(false);
  const [editTeacher, setEditTeacher] = useState<{
    id: number;
    fullName: string;
    subjects: string[];
    email: string;
  } | null>(null);

  const handleCreateTeacher = (e: React.FormEvent) => {
    e.preventDefault();
    setTError("");
    createTeacher.mutate(
      { data: { ...tForm } },
      {
        onSuccess: () => {
          setShowTForm(false);
          setTForm(emptyTeacher);
          inv("teachers", "stats");
        },
        onError: () => setTError("Սխալ. Փորձեք կրկին"),
      },
    );
  };

  const handleUpdateTeacher = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTeacher) return;
    updateTeacher.mutate(
      {
        id: editTeacher.id,
        data: {
          fullName: editTeacher.fullName,
          subjects: editTeacher.subjects,
          email: editTeacher.email,
        },
      },
      {
        onSuccess: () => {
          setEditTeacher(null);
          inv("teachers");
        },
      },
    );
  };

  // ── class form ────────────────────────────────────────────────────────────
  const emptyClass = { classNum: "7", classLetter: "Ա", teacherId: "", subjectIds: [] as number[] };
  const [cForm, setCForm] = useState(emptyClass);
  const [cError, setCError] = useState("");
  const [showCForm, setShowCForm] = useState(false);
  const [editClass, setEditClass] = useState<{
    id: number;
    name: string;
    classNum: string;
    classLetter: string;
    grade: string;
    teacherId: number;
    subjectIds: number[];
  } | null>(null);

  // Fetch already-assigned subject ids when the edit form is open
  const { data: editClassSubjects } = useQuery<{ subjectIds: number[] }>({
    queryKey: ["admin-class-teacher-subjects", editClass?.id],
    queryFn: async () => {
      const res = await fetch(`/api/admin/classes/${editClass!.id}/teacher-subjects`, { credentials: "include" });
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    enabled: !!editClass,
  });

  // Sync fetched subjectIds into editClass state once the query resolves
  useEffect(() => {
    if (editClassSubjects) {
      setEditClass((c) => c && { ...c, subjectIds: editClassSubjects.subjectIds });
    }
  }, [editClassSubjects]);

  const [assignClassId, setAssignClassId] = useState<number | null>(null);
  const [assignStudentId, setAssignStudentId] = useState<string>("");

  const handleCreateClass = (e: React.FormEvent) => {
    e.preventDefault();
    setCError("");
    if (!cForm.teacherId) {
      setCError("Ընտրեք Ուսուցիչ");
      return;
    }
    createClass.mutate(
      {
        data: {
          name: `${cForm.classNum}${cForm.classLetter ? " " + cForm.classLetter : ""}`,
          grade: cForm.classNum,
          teacherId: parseInt(cForm.teacherId),
          subjectIds: cForm.subjectIds,
        },
      },
      {
        onSuccess: () => {
          setShowCForm(false);
          setCForm(emptyClass);
          inv("classes", "stats");
        },
        onError: () => setCError("Սխալ"),
      },
    );
  };

  const handleUpdateClass = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editClass) return;
    updateClass.mutate(
      {
        id: editClass.id,
        data: {
          name: `${editClass.classNum}${editClass.classLetter ? " " + editClass.classLetter : ""}`,
          grade: editClass.classNum,
          teacherId: editClass.teacherId,
          subjectIds: editClass.subjectIds,
        },
      },
      {
        onSuccess: () => {
          setEditClass(null);
          inv("classes");
        },
      },
    );
  };

  const handleAssignStudent = () => {
    if (!assignClassId || !assignStudentId) return;
    assignStudent.mutate(
      { id: assignClassId, data: { studentId: parseInt(assignStudentId) } },
      {
        onSuccess: () => {
          setAssignClassId(null);
          setAssignStudentId("");
          inv("classes", "students");
        },
      },
    );
  };

  // ── schedule form ─────────────────────────────────────────────────────────
  const emptySched = {
    classId: "",
    day: DAYS[0],
    startTime: "08:00",
    endTime: "09:00",
    subject: "",
  };
  const [sForm, setSForm] = useState(emptySched);
  const [sError, setSError] = useState("");
  const [showSForm, setShowSForm] = useState(false);
  const [editSched, setEditSched] = useState<{
    id: number;
    classId: number;
    day: string;
    startTime: string;
    endTime: string;
    subject: string;
  } | null>(null);
  const [cellAdd, setCellAdd] = useState<{
    day: string;
    classId: number;
  } | null>(null);
  const [cellStartTime, setCellStartTime] = useState("08:00");
  const [cellEndTime, setCellEndTime] = useState("09:00");
  const [cellSubject, setCellSubject] = useState("");
  const [cellGrade, setCellGrade] = useState("");

  const handleCreateSched = (e: React.FormEvent) => {
    e.preventDefault();
    setSError("");
    if (!sForm.classId) {
      setSError("Yntrек dasaran");
      return;
    }
    createSchedule.mutate(
      {
        data: {
          classId: parseInt(sForm.classId),
          day: sForm.day,
          startTime: sForm.startTime,
          endTime: sForm.endTime,
          subject: sForm.subject,
        },
      },
      {
        onSuccess: () => {
          setShowSForm(false);
          setSForm(emptySched);
          inv("schedule");
        },
        onError: () => setSError("Սխալ"),
      },
    );
  };

  const handleUpdateSched = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editSched) return;
    updateSchedule.mutate(
      {
        id: editSched.id,
        data: {
          classId: editSched.classId,
          day: editSched.day,
          startTime: editSched.startTime,
          endTime: editSched.endTime,
          subject: editSched.subject,
        },
      },
      {
        onSuccess: () => {
          setEditSched(null);
          inv("schedule");
        },
      },
    );
  };

  // ── schedule grid helpers ─────────────────────────────────────────────────
  const SCHOOL_DAYS = DAYS.slice(0, 5);
  const GRADE_COLS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
  const sortedClasses = [...classes].sort((a, b) => {
    const ag = parseInt(a.grade) || 0;
    const bg = parseInt(b.grade) || 0;
    if (ag !== bg) return ag - bg;
    return a.name.localeCompare(b.name, "hy");
  });
  const getTeacherForClass = (classId: number) => {
    const cls = classes.find((c) => c.id === classId);
    return teachers.find((t) => t.id === cls?.teacherId);
  };
  const getValidSubjects = (classId: number): string[] =>
    getTeacherForClass(classId)?.subjects ?? [];
  const handleCellAdd = () => {
    if (!cellAdd || !cellSubject) return;
    createSchedule.mutate(
      {
        data: {
          classId: cellAdd.classId,
          day: cellAdd.day,
          startTime: cellStartTime,
          endTime: cellEndTime,
          subject: cellSubject,
        },
      },
      {
        onSuccess: () => {
          setCellAdd(null);
          inv("schedule");
        },
      },
    );
  };

  // ── student form ──────────────────────────────────────────────────────────
  const emptySt = { fullName: "", email: "", age: "" };
  const [stForm, setStForm] = useState(emptySt);
  const [stClassId, setStClassId] = useState<string>("");
  const [stError, setStError] = useState("");
  const [showStForm, setShowStForm] = useState(false);

  const handleCreateStudent = (e: React.FormEvent) => {
    e.preventDefault();
    setStError("");
    const classId = stClassId
      ? parseInt(stClassId)
      : selectedClassId || undefined;
    createStudent.mutate(
      {
        data: {
          fullName: stForm.fullName,
          email: stForm.email || undefined,
          age: stForm.age ? parseInt(stForm.age) : undefined,
          classId,
        },
      },
      {
        onSuccess: () => {
          setShowStForm(false);
          setStForm(emptySt);
          setStClassId("");
          inv("students", "stats");
        },
        onError: () => setStError("Սխալ"),
      },
    );
  };

  // ── guard ─────────────────────────────────────────────────────────────────
  if (authLoading)
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  if (user?.role !== "admin") {
    setLocation("/login");
    return null;
  }

  const subTabs: { key: Tab; label: string }[] = [
    { key: "home", label: "🏠 Գլխավոր" },
    { key: "subjects", label: "📖 Առարկաներ" },
    { key: "teachers", label: "👨‍🏫 Ուսուցիչներ" },
    { key: "students", label: "👨‍🎓 Աշակերտներ" },
    { key: "classes", label: "📚 Դասարաններ" },
    { key: "schedule", label: "📅 Դասացուցակ" },
  ];

  const inputCls =
    "w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50";
  const btnPrimary =
    "px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-medium disabled:opacity-50 transition-all";
  const btnGhost =
    "px-3 py-1 rounded-lg text-xs text-muted-foreground hover:text-white border border-transparent hover:border-white/10 transition-colors";
  const btnDanger =
    "px-3 py-1 rounded-lg text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors";

  return (
    <div className="min-h-[100dvh] bg-background text-white flex">
      <QuickSwitch />

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        ref={sidebarRef}
        className={`fixed top-0 left-0 h-full z-50 w-60 bg-card/95 backdrop-blur-xl border-r border-white/10 flex flex-col transition-transform duration-200 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        } lg:translate-x-0 lg:static lg:z-auto`}
      >
        <div className="px-5 py-5 border-b border-white/10">
          <div className="font-bold text-base bg-clip-text text-transparent bg-gradient-to-r from-primary to-secondary">
            myaiteacher
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 truncate">
            👑 Admin · {user.fullName}
          </div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {subTabs.map((t) => (
            <button
              key={t.key}
              onClick={() => { setTab(t.key); setSidebarOpen(false); }}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm transition-all text-left ${
                tab === t.key
                  ? "bg-primary/20 text-white font-medium"
                  : "text-muted-foreground hover:text-white hover:bg-white/5"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="px-3 py-4 border-t border-white/10">
          <button
            onClick={logout}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm text-muted-foreground hover:text-white hover:bg-white/5 transition-all text-left"
          >
            <span className="text-lg">🚪</span>
            <span>Ելք</span>
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Mobile header with hamburger */}
        <header className="lg:hidden border-b border-white/10 bg-card/50 backdrop-blur-lg sticky top-0 z-30">
          <div className="px-4 py-3.5 flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
              aria-label="Menu"
            >
              <div className="space-y-1.5 w-5">
                <span className="block w-full h-0.5 bg-white rounded" />
                <span className="block w-full h-0.5 bg-white rounded" />
                <span className="block w-full h-0.5 bg-white rounded" />
              </div>
            </button>
            <div className="font-bold text-sm bg-clip-text text-transparent bg-gradient-to-r from-primary to-secondary">
              myaiteacher
            </div>
            <div className="ml-auto text-xs text-muted-foreground truncate max-w-[120px]">
              {user.fullName}
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="max-w-5xl mx-auto px-5 sm:px-8 py-8">

        {/* ── HOME: stats + schedule ── */}
        {tab === "home" && (
          <div className="space-y-8">
            <h2 className="font-semibold text-lg">Գլխավոր</h2>
            {/* Stats cards */}
            <div className="grid grid-cols-4 gap-6">
              {[
                {
                  icon: "📖",
                  label: "Առարկաներ",
                  value: subjectsList.length,
                  color: "text-purple-400",
                  tabKey: "subjects" as Tab,
                },
                {
                  icon: "👨‍🏫",
                  label: "Ուսուցիչներ",
                  value: stats?.teachers ?? 0,
                  color: "text-amber-400",
                  tabKey: "teachers" as Tab,
                },
                {
                  icon: "👨‍🎓",
                  label: "Աշակերտներ",
                  value: stats?.students ?? 0,
                  color: "text-indigo-400",
                  tabKey: "students" as Tab,
                },
                {
                  icon: "📚",
                  label: "Դասարաններ",
                  value: stats?.classes ?? 0,
                  color: "text-teal-400",
                  tabKey: "classes" as Tab,
                },
              ].map((s) => (
                <button
                  key={s.label}
                  onClick={() => setTab(s.tabKey)}
                  className="bg-card/60 border border-white/10 rounded-2xl p-8 text-center hover:border-white/20 hover:bg-card/80 transition-all cursor-pointer group"
                >
                  <div className="text-5xl mb-4">{s.icon}</div>
                  <div className={`text-4xl font-bold mb-2 ${s.color}`}>
                    {s.value}
                  </div>
                  <div className="text-sm text-muted-foreground group-hover:text-white/70 transition-colors">
                    {s.label}
                  </div>
                </button>
              ))}
            </div>

            {/* Schedule preview – compact read-only grid */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold text-lg tracking-widest">
                  ԴԱՍԱՑՈՒՑԱԿ
                </h2>
                <button
                  onClick={() => setTab("schedule")}
                  className="text-xs text-primary hover:text-primary/80 transition-colors"
                >
                  Դիտել ամբողջը →
                </button>
              </div>
              {schedule.length === 0 ? (
                <div className="bg-card/40 border border-white/10 rounded-2xl py-10 text-center text-muted-foreground text-sm">
                  Դասացուցակ չկա ·{" "}
                  <button
                    onClick={() => setTab("schedule")}
                    className="text-primary hover:underline"
                  >
                    Ավելացնել դաս
                  </button>
                </div>
              ) : (
                <div className="bg-card/40 border border-white/10 rounded-2xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-xs border-collapse">
                      <thead>
                        <tr className="bg-white/5 border-b border-white/10">
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium min-w-[110px]">
                            Օր
                          </th>
                          {sortedClasses.map((c) => (
                            <th
                              key={c.id}
                              className="text-left px-3 py-2.5 text-muted-foreground font-medium min-w-[110px] border-l border-white/5"
                            >
                              {c.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {SCHOOL_DAYS.map((day, di) => (
                          <tr
                            key={day}
                            className={`border-b border-white/5 ${di % 2 === 0 ? "" : "bg-white/[0.02]"}`}
                          >
                            <td className="px-4 py-2.5 font-medium text-white/80 align-top whitespace-nowrap">
                              {day}
                            </td>
                            {sortedClasses.map((c) => {
                              const entries = schedule
                                .filter(
                                  (s) => s.day === day && s.classId === c.id,
                                )
                                .sort((a, b) =>
                                  (a.startTime || a.time).localeCompare(
                                    b.startTime || b.time,
                                  ),
                                );
                              const teacher = getTeacherForClass(c.id);
                              return (
                                <td
                                  key={c.id}
                                  className="px-3 py-2 align-top border-l border-white/5"
                                >
                                  {entries.length === 0 ? (
                                    <span className="text-white/15">—</span>
                                  ) : (
                                    <div className="flex flex-col gap-1">
                                      {entries.map((e) => (
                                        <div
                                          key={e.id}
                                          title={`Ուսուցիչ՝ ${e.teacherName ?? teacher?.fullName ?? "—"}`}
                                          className="flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-[#14B8A6]/10 border border-[#14B8A6]/20 cursor-default"
                                        >
                                          <span className="text-white/85 truncate font-medium">
                                            {e.subject}
                                          </span>
                                          <span className="text-[#14B8A6] font-mono text-[10px]">
                                            {e.startTime && e.endTime
                                              ? `${e.startTime}–${e.endTime}`
                                              : e.time}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── TEACHERS ── */}
        {tab === "teachers" && (
          <div>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-semibold text-lg">Ուսուցիչներ</h2>
              <button
                onClick={() => {
                  setShowTForm(!showTForm);
                  setEditTeacher(null);
                }}
                className={btnPrimary}
              >
                + Ավելացնել ուսուցիչ
              </button>
            </div>

            {showTForm && (
              <form
                onSubmit={handleCreateTeacher}
                className="mb-6 bg-card/50 border border-white/10 rounded-2xl p-5 space-y-3"
              >
                <h3 className="font-medium mb-1">Նոր ուսուցիչ</h3>
                {subjectsList.length === 0 && (
                  <p className="text-amber-400 text-xs bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2">
                    Նախ ավելացեք առարկաներ:
                  </p>
                )}
                {tError && <p className="text-destructive text-xs">{tError}</p>}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Անուն, ազգանուն *
                    </label>
                    <input
                      value={tForm.fullName}
                      onChange={(e) =>
                        setTForm((f) => ({ ...f, fullName: e.target.value }))
                      }
                      required
                      placeholder="Անուն, ազգանուն"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Էլ. հասցե
                    </label>
                    <input
                      type="email"
                      value={tForm.email}
                      onChange={(e) =>
                        setTForm((f) => ({ ...f, email: e.target.value }))
                      }
                      className={inputCls}
                      placeholder="teacher@school.am"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Ընտրեք առարկաները
                    </label>
                    {subjectsList.length === 0 ? (
                      <p className="text-xs text-muted-foreground italic">
                        Առարկաներ չկան
                      </p>
                    ) : (
                      <div className="grid grid-cols-2 gap-1.5">
                        {subjectsList.map((s) => (
                          <label
                            key={s.id}
                            className="flex items-center gap-2 text-sm cursor-pointer select-none rounded-lg px-3 py-2 border border-white/10 hover:border-primary/40 transition-colors"
                          >
                            <input
                              type="checkbox"
                              checked={tForm.subjects.includes(s.name)}
                              onChange={(e) =>
                                setTForm((f) => ({
                                  ...f,
                                  subjects: e.target.checked
                                    ? [...f.subjects, s.name]
                                    : f.subjects.filter((x) => x !== s.name),
                                }))
                              }
                              className="accent-indigo-500"
                            />
                            {s.name}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={createTeacher.isPending}
                    className={btnPrimary}
                  >
                    {createTeacher.isPending ? "..." : "Պահպանել"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowTForm(false)}
                    className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white"
                  >
                    Չեղարկել
                  </button>
                </div>
              </form>
            )}

            {/* Edit teacher */}
            {editTeacher && (
              <form
                onSubmit={handleUpdateTeacher}
                className="mb-6 bg-primary/5 border border-primary/20 rounded-2xl p-5 space-y-3"
              >
                <h3 className="font-medium">Խմբագրել ուսուցիչին</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Անուն, ազգանուն
                    </label>
                    <input
                      value={editTeacher.fullName}
                      onChange={(e) =>
                        setEditTeacher(
                          (t) => t && { ...t, fullName: e.target.value },
                        )
                      }
                      placeholder="Անուն, ազգանուն"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Էլ. հասցե
                    </label>
                    <input
                      type="email"
                      value={editTeacher.email}
                      onChange={(e) =>
                        setEditTeacher(
                          (t) => t && { ...t, email: e.target.value },
                        )
                      }
                      className={inputCls}
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Ընտրեք առարկաները
                    </label>
                    {subjectsList.length === 0 ? (
                      <p className="text-xs text-muted-foreground italic">
                        Առարկաներ չկան
                      </p>
                    ) : (
                      <div className="grid grid-cols-2 gap-1.5">
                        {subjectsList.map((s) => (
                          <label
                            key={s.id}
                            className="flex items-center gap-2 text-sm cursor-pointer select-none rounded-lg px-3 py-2 border border-white/10 hover:border-primary/40 transition-colors"
                          >
                            <input
                              type="checkbox"
                              checked={editTeacher.subjects.includes(s.name)}
                              onChange={(e) =>
                                setEditTeacher(
                                  (t) =>
                                    t && {
                                      ...t,
                                      subjects: e.target.checked
                                        ? [...t.subjects, s.name]
                                        : t.subjects.filter(
                                            (x) => x !== s.name,
                                          ),
                                    },
                                )
                              }
                              className="accent-indigo-500"
                            />
                            {s.name}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button type="submit" className={btnPrimary}>
                    ՊԱՀՊԱՆԵԼ
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditTeacher(null)}
                    className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white"
                  >
                    Չեղարկել
                  </button>
                </div>
              </form>
            )}

            {teachers.length === 0 ? (
              <p className="text-muted-foreground text-sm py-8 text-center">
                Ուսուցիչ չկա
              </p>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-white/10">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/5 text-muted-foreground text-xs uppercase tracking-wide">
                      <th className="text-left px-4 py-3">Անուն</th>
                      <th className="text-left px-4 py-3">Էլ. հասցե</th>
                      <th className="text-left px-4 py-3">Առարկաներ</th>
                      <th className="text-right px-4 py-3">Գործողություններ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teachers.map((t, i) => (
                      <tr
                        key={t.id}
                        className={`border-b border-white/5 ${i % 2 === 0 ? "" : "bg-white/[0.02]"} hover:bg-white/5 transition-colors`}
                      >
                        <td className="px-4 py-3 font-medium">{t.fullName}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {t.email || "—"}
                        </td>
                        <td className="px-4 py-3">
                          {t.subjects && t.subjects.length > 0 ? (
                            <span className="text-teal-400">
                              {t.subjects.join(", ")}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex gap-1 justify-end">
                            <button
                              onClick={() => {
                                setShowTForm(false);
                                setEditTeacher({
                                  id: t.id,
                                  fullName: t.fullName,
                                  subjects: t.subjects ?? [],
                                  email: t.email ?? "",
                                });
                              }}
                              className={btnGhost}
                            >
                              ✏️ Խմբագրել
                            </button>
                            <button
                              onClick={() => {
                                if (confirm("Ջնջե՞լ ուսուցիչին?"))
                                  deleteTeacher.mutate(
                                    { id: t.id },
                                    {
                                      onSuccess: () => inv("teachers", "stats"),
                                    },
                                  );
                              }}
                              className={btnDanger}
                            >
                              🗑 Ջնջել
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── CLASSES ── */}
        {tab === "classes" && (
          <div>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-semibold text-lg">Դասարաններ</h2>
              <button
                onClick={() => setShowCForm(!showCForm)}
                className={btnPrimary}
              >
                + Ստեղծել Դասարան
              </button>
            </div>

            {showCForm && (
              <form
                onSubmit={handleCreateClass}
                className="mb-6 bg-card/50 border border-white/10 rounded-2xl p-5 space-y-3"
              >
                <h3 className="font-medium">Նոր Դասարան</h3>
                {cError && <p className="text-destructive text-xs">{cError}</p>}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Դասարանի համար
                    </label>
                    <select
                      value={cForm.classNum}
                      onChange={(e) =>
                        setCForm((f) => ({ ...f, classNum: e.target.value }))
                      }
                      className={inputCls}
                    >
                      {[
                        "1",
                        "2",
                        "3",
                        "4",
                        "5",
                        "6",
                        "7",
                        "8",
                        "9",
                        "10",
                        "11",
                        "12",
                      ].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Կարգ
                    </label>
                    <select
                      value={cForm.classLetter}
                      onChange={(e) =>
                        setCForm((f) => ({ ...f, classLetter: e.target.value }))
                      }
                      className={inputCls}
                    >
                      <option value="">—</option>
                      {["Ա", "Բ", "Գ", "Դ"].map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className="text-xs text-muted-foreground">
                      Ուսուցիչ
                    </label>
                    <select
                      value={cForm.teacherId}
                      onChange={(e) =>
                        setCForm((f) => ({ ...f, teacherId: e.target.value, subjectIds: [] }))
                      }
                      className={inputCls}
                    >
                      <option value="">Ընտրեք ուսուցիչ</option>
                      {teachers.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.fullName}
                          {t.subjects && t.subjects.length > 0
                            ? ` — ${t.subjects.join(", ")}`
                            : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  {cForm.teacherId && (() => {
                    const selectedTeacher = teachers.find((t) => t.id === parseInt(cForm.teacherId));
                    const teacherSubjects = selectedTeacher?.subjects ?? [];
                    return (
                      <div className="col-span-2">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Ինչ առարկա(ներ) կդասավանդի այս դասարանում
                        </label>
                        {teacherSubjects.length === 0 ? (
                          <p className="text-xs text-amber-400">Այս ուսուցիչը որակավորության առարկա նշված չունի</p>
                        ) : (
                          <div className="grid grid-cols-2 gap-1.5">
                            {teacherSubjects.map((subName) => {
                              const subjectItem = subjectsList.find((s) => s.name === subName);
                              if (!subjectItem) return null;
                              return (
                                <label key={subjectItem.id} className="flex items-center gap-2 text-sm cursor-pointer select-none rounded-lg px-3 py-2 border border-white/10 hover:border-primary/40 transition-colors">
                                  <input
                                    type="checkbox"
                                    checked={cForm.subjectIds.includes(subjectItem.id)}
                                    onChange={(e) =>
                                      setCForm((f) => ({
                                        ...f,
                                        subjectIds: e.target.checked
                                          ? [...f.subjectIds, subjectItem.id]
                                          : f.subjectIds.filter((id) => id !== subjectItem.id),
                                      }))
                                    }
                                    className="accent-indigo-500"
                                  />
                                  {subName}
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
                <div className="flex gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={createClass.isPending}
                    className={btnPrimary}
                  >
                    {createClass.isPending ? "..." : "ՍՏЕՂԾԵԼ"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowCForm(false)}
                    className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white"
                  >
                    ՉԵՂԱՐԿԵԼ
                  </button>
                </div>
              </form>
            )}

            {editClass && (
              <form
                onSubmit={handleUpdateClass}
                className="mb-6 bg-primary/5 border border-primary/20 rounded-2xl p-5 space-y-3"
              >
                <h3 className="font-medium">Խմբագրել Դասարան</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Դասարանի համար
                    </label>
                    <select
                      value={editClass.classNum}
                      onChange={(e) =>
                        setEditClass(
                          (c) => c && { ...c, classNum: e.target.value },
                        )
                      }
                      className={inputCls}
                    >
                      {[
                        "1",
                        "2",
                        "3",
                        "4",
                        "5",
                        "6",
                        "7",
                        "8",
                        "9",
                        "10",
                        "11",
                        "12",
                      ].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Կարգ
                    </label>
                    <select
                      value={editClass.classLetter}
                      onChange={(e) =>
                        setEditClass(
                          (c) => c && { ...c, classLetter: e.target.value },
                        )
                      }
                      className={inputCls}
                    >
                      <option value="">—</option>
                      {["Ա", "Բ", "Գ", "Դ"].map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className="text-xs text-muted-foreground">
                      Ուսուցիչ
                    </label>
                    <select
                      value={editClass.teacherId}
                      onChange={(e) =>
                        setEditClass(
                          (c) =>
                            c && { ...c, teacherId: parseInt(e.target.value), subjectIds: [] },
                        )
                      }
                      className={inputCls}
                    >
                      {teachers.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.fullName}
                        </option>
                      ))}
                    </select>
                  </div>
                  {editClass.teacherId && (() => {
                    const selectedTeacher = teachers.find((t) => t.id === editClass.teacherId);
                    const teacherSubjects = selectedTeacher?.subjects ?? [];
                    return (
                      <div className="col-span-2">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Ինչ առարկա(ներ) կդասավանդի այս դասարանում
                        </label>
                        {teacherSubjects.length === 0 ? (
                          <p className="text-xs text-amber-400">Այս ուսուցիչը որակավորության առարկա նշված չունի</p>
                        ) : (
                          <div className="grid grid-cols-2 gap-1.5">
                            {teacherSubjects.map((subName) => {
                              const subjectItem = subjectsList.find((s) => s.name === subName);
                              if (!subjectItem) return null;
                              return (
                                <label key={subjectItem.id} className="flex items-center gap-2 text-sm cursor-pointer select-none rounded-lg px-3 py-2 border border-white/10 hover:border-primary/40 transition-colors">
                                  <input
                                    type="checkbox"
                                    checked={editClass.subjectIds.includes(subjectItem.id)}
                                    onChange={(e) =>
                                      setEditClass((c) => c && {
                                        ...c,
                                        subjectIds: e.target.checked
                                          ? [...c.subjectIds, subjectItem.id]
                                          : c.subjectIds.filter((id) => id !== subjectItem.id),
                                      })
                                    }
                                    className="accent-indigo-500"
                                  />
                                  {subName}
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                </div>
                <div className="flex gap-2">
                  <button type="submit" className={btnPrimary}>
                    ՊԱՀՊԱՆԵԼ
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditClass(null)}
                    className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white"
                  >
                    ՉԵՂԱՐԿԵԼ
                  </button>
                </div>
              </form>
            )}

            {classes.length === 0 ? (
              <p className="text-muted-foreground text-sm py-8 text-center">
                Դասարան չկա
              </p>
            ) : (
              <div className="space-y-3">
                {classes.map((c) => (
                  <div
                    key={c.id}
                    className="bg-card/50 border border-white/10 rounded-2xl overflow-hidden"
                  >
                    {/* ── class row ── */}
                    <div className="flex items-center justify-between px-4 py-3">
                      <div className="flex items-center gap-4 min-w-0">
                        <div>
                          <div className="font-medium">{c.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {c.grade || "—"} · {c.teacherName}
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground/70 border border-white/10 rounded-lg px-2 py-1">
                          <span className="text-teal-400 font-medium">
                            {(c as any).studentCount ?? 0}
                          </span>{" "}
                          աշակերտ
                        </div>
                      </div>
                      <div className="flex gap-1.5 flex-shrink-0">
                        <button
                          onClick={() => {
                            setAssignClassId(
                              assignClassId === c.id ? null : c.id,
                            );
                            setAssignStudentId("");
                          }}
                          className="px-3 py-1.5 rounded-xl bg-teal-500/10 border border-teal-500/30 text-teal-400 text-xs font-semibold hover:bg-teal-500/20 transition-colors"
                        >
                          + ԱՎԵԼԱՑՆԵԼ ԱՇԱԿԵՐՏ
                        </button>
                        <button
                          onClick={() => setLocation(`/admin/classes/${c.id}`)}
                          className="px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 text-xs text-white/80 hover:text-white hover:bg-white/10 transition-colors"
                        >
                          Դիտել
                        </button>
                        <button
                          onClick={() => {
                            const parts = c.name.split(/\s+/);
                            const cn = parts[0] || "";
                            const cl = parts[1] || "";
                            setEditClass({
                              id: c.id,
                              name: c.name,
                              classNum: cn,
                              classLetter: cl,
                              grade: c.grade,
                              teacherId: c.teacherId,
                              subjectIds: [],
                            });
                            setAssignClassId(null);
                          }}
                          className={btnGhost}
                        >
                          ✏️
                        </button>
                        <button
                          onClick={() => {
                            if (confirm("Ջնջե՞լ դասարանը?"))
                              deleteClass.mutate(
                                { id: c.id },
                                { onSuccess: () => inv("classes", "stats") },
                              );
                          }}
                          className={btnDanger}
                        >
                          🗑
                        </button>
                      </div>
                    </div>

                    {/* ── assign student panel ── */}
                    {assignClassId === c.id && (
                      <div className="border-t border-white/10 bg-teal-500/5 px-4 py-4 space-y-3">
                        <p className="text-xs font-semibold text-teal-400 uppercase tracking-wide">
                          Աշակերտների ցանկ
                        </p>
                        <div className="flex gap-2 items-center">
                          <select
                            value={assignStudentId}
                            onChange={(e) => setAssignStudentId(e.target.value)}
                            className={`${inputCls} flex-1`}
                          >
                            <option value="">Ընտրել աշակերտ</option>
                            {allStudents.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.fullName}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={handleAssignStudent}
                            disabled={
                              !assignStudentId || assignStudent.isPending
                            }
                            className={btnPrimary}
                          >
                            {assignStudent.isPending ? "..." : "ՊԱՀՊԱՆԵԼ"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setAssignClassId(null);
                              setAssignStudentId("");
                            }}
                            className="px-3 py-2 rounded-xl border border-white/10 text-xs text-muted-foreground hover:text-white"
                          >
                            ՉԵՂԱՐԿԵԼ
                          </button>
                        </div>
                        {allStudents.length === 0 && (
                          <p className="text-xs text-amber-400">
                            Աշակերտներ չկան: Նախ ստեղծեք աշակերտ:
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── SCHEDULE ── */}
        {tab === "schedule" && (
          <div>
            <div className="mb-5">
              <h2 className="font-semibold text-lg tracking-widest">
                ԴԱՍԱՑՈՒՑԱԿ
              </h2>
            </div>

            {editSched && (
              <form
                onSubmit={handleUpdateSched}
                className="mb-6 bg-primary/5 border border-primary/20 rounded-2xl p-5 space-y-3"
              >
                <h3 className="font-medium">Խմբագրել դաս</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground">Օր</label>
                    <select
                      value={editSched.day}
                      onChange={(e) =>
                        setEditSched((s) => s && { ...s, day: e.target.value })
                      }
                      className={inputCls}
                    >
                      {SCHOOL_DAYS.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Առարկա
                    </label>
                    <select
                      value={editSched.subject}
                      onChange={(e) =>
                        setEditSched(
                          (s) => s && { ...s, subject: e.target.value },
                        )
                      }
                      className={inputCls}
                    >
                      <option value="">—</option>
                      {getValidSubjects(editSched.classId).map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Ժամ սկիզբ
                    </label>
                    <select
                      value={editSched.startTime}
                      onChange={(e) =>
                        setEditSched(
                          (s) => s && { ...s, startTime: e.target.value },
                        )
                      }
                      className={inputCls}
                    >
                      {TIME_OPTIONS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Ժամ ավարտ
                    </label>
                    <select
                      value={editSched.endTime}
                      onChange={(e) =>
                        setEditSched(
                          (s) => s && { ...s, endTime: e.target.value },
                        )
                      }
                      className={inputCls}
                    >
                      {TIME_OPTIONS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button type="submit" className={btnPrimary}>
                    ՊԱՀՊԱՆԵԼ
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditSched(null)}
                    className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white"
                  >
                    ՉԵՂԱՌԿԵԼ
                  </button>
                </div>
              </form>
            )}

            <div className="overflow-x-auto rounded-2xl border border-white/10">
              <table className="min-w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-white/5 border-b border-white/10">
                    <th className="text-left px-4 py-3 text-muted-foreground font-medium text-xs uppercase tracking-wide min-w-[130px] sticky left-0 bg-[#0F172A]/95 backdrop-blur-sm z-10">
                      Օր
                    </th>
                    {GRADE_COLS.map((g) => {
                      const gClasses = classes.filter((c) => c.grade === g);
                      return (
                        <th
                          key={g}
                          className="text-left px-3 py-3 min-w-[160px] border-l border-white/5 font-normal align-top"
                        >
                          <div className="font-semibold text-white/85 text-xs">
                            ՚{g === "1" ? `${g}-ին` : `${g}-րդ`}՚
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {SCHOOL_DAYS.map((day, di) => (
                    <tr
                      key={day}
                      className={`border-b border-white/5 ${di % 2 === 0 ? "bg-white/[0.01]" : ""}`}
                    >
                      <td className="px-4 py-3 font-semibold text-white/70 align-top whitespace-nowrap text-xs uppercase tracking-wide sticky left-0 bg-[#0F172A]/95 backdrop-blur-sm border-r border-white/5 z-10">
                        {day}
                      </td>
                      {GRADE_COLS.map((g) => {
                        const gClasses = classes.filter((c) => c.grade === g);
                        const entries = schedule
                          .filter(
                            (s) =>
                              s.day === day &&
                              gClasses.some((c) => c.id === s.classId),
                          )
                          .sort((a, b) =>
                            (a.startTime || a.time).localeCompare(
                              b.startTime || b.time,
                            ),
                          );
                        const validSubjs = [
                          ...new Set(
                            gClasses.flatMap((c) => getValidSubjects(c.id)),
                          ),
                        ];
                        const isAdding =
                          cellGrade === g && cellAdd?.day === day;
                        return (
                          <td
                            key={g}
                            className="px-2.5 py-2.5 align-top border-l border-white/5 min-w-[160px]"
                          >
                            <div className="flex flex-col gap-1.5">
                              {entries.map((e) => {
                                const timeRange =
                                  e.startTime && e.endTime
                                    ? `${e.startTime}–${e.endTime}`
                                    : e.time;
                                const teacherName =
                                  e.teacherName ??
                                  getTeacherForClass(e.classId)?.fullName ??
                                  "—";
                                return (
                                  <div
                                    key={e.id}
                                    title={`Ուսուցիչ՝ ${teacherName}\nԺամի՝ ${timeRange}`}
                                    className="group relative flex flex-col px-2.5 py-1.5 rounded-xl bg-[#14B8A6]/10 border border-[#14B8A6]/20 hover:border-[#14B8A6]/50 hover:bg-[#14B8A6]/15 transition-all cursor-default"
                                  >
                                    <span className="text-white/90 text-xs font-medium truncate">
                                      {e.subject}
                                    </span>
                                    <span className="text-[#14B8A6] font-mono text-[10px] mt-0.5">
                                      {timeRange}
                                    </span>
                                    <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                      <button
                                        onClick={() =>
                                          setEditSched({
                                            id: e.id,
                                            classId: e.classId,
                                            day: e.day,
                                            startTime: e.startTime || e.time,
                                            endTime: e.endTime || e.time,
                                            subject: e.subject,
                                          })
                                        }
                                        className="text-white/40 hover:text-white text-[10px] px-1 leading-none"
                                      >
                                        ✏
                                      </button>
                                      <button
                                        onClick={() => {
                                          if (confirm("Ջնջել?"))
                                            deleteSchedule.mutate(
                                              { id: e.id },
                                              {
                                                onSuccess: () =>
                                                  inv("schedule"),
                                              },
                                            );
                                        }}
                                        className="text-red-400/50 hover:text-red-400 text-[10px] px-1 leading-none"
                                      >
                                        ×
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}

                              {isAdding ? (
                                <div className="flex flex-col gap-2 p-2.5 rounded-xl bg-[#6366F1]/10 border border-[#6366F1]/25">
                                  {validSubjs.length === 0 ? (
                                    <p className="text-xs text-amber-400 leading-snug">
                                      Ուսուցիչ արարկաններ չհունի
                                    </p>
                                  ) : (
                                    <>
                                      <select
                                        value={cellSubject}
                                        onChange={(e) => {
                                          const subj = e.target.value;
                                          setCellSubject(subj);
                                          const match = gClasses.find((c) =>
                                            getValidSubjects(c.id).includes(
                                              subj,
                                            ),
                                          );
                                          if (match && cellAdd)
                                            setCellAdd({
                                              ...cellAdd,
                                              classId: match.id,
                                            });
                                        }}
                                        className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none"
                                        autoFocus
                                      >
                                        <option value="">Ենթրեկ առարկա</option>
                                        {validSubjs.map((s) => (
                                          <option key={s} value={s}>
                                            {s}
                                          </option>
                                        ))}
                                      </select>
                                      <div className="grid grid-cols-2 gap-1.5">
                                        <div>
                                          <p className="text-[10px] text-muted-foreground mb-0.5 px-0.5">
                                            Ժամը՝ սկիզբ
                                          </p>
                                          <input
                                            type="time"
                                            value={cellStartTime}
                                            onChange={(e) =>
                                              setCellStartTime(e.target.value)
                                            }
                                            className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-white focus:outline-none [color-scheme:dark]"
                                          />
                                        </div>
                                        <div>
                                          <p className="text-[10px] text-muted-foreground mb-0.5 px-0.5">
                                            Ժամը՝ ավարտ
                                          </p>
                                          <input
                                            type="time"
                                            value={cellEndTime}
                                            onChange={(e) =>
                                              setCellEndTime(e.target.value)
                                            }
                                            className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-white focus:outline-none [color-scheme:dark]"
                                          />
                                        </div>
                                      </div>
                                      <div className="flex gap-1.5 mt-0.5">
                                        <button
                                          onClick={handleCellAdd}
                                          disabled={
                                            !cellSubject ||
                                            createSchedule.isPending
                                          }
                                          className="flex-1 text-xs py-1.5 rounded-lg bg-[#6366F1] text-white font-medium disabled:opacity-40 hover:bg-[#5355cf] transition-colors"
                                        >
                                          ՊԱՀՊԱՆԵԼ
                                        </button>
                                        <button
                                          onClick={() => {
                                            setCellAdd(null);
                                            setCellGrade("");
                                          }}
                                          className="flex-1 text-xs py-1.5 rounded-lg border border-white/10 text-muted-foreground hover:text-white transition-colors"
                                        >
                                          ՉԵՂԱՌԿԵԼ
                                        </button>
                                      </div>
                                    </>
                                  )}
                                </div>
                              ) : (
                                <button
                                  onClick={() => {
                                    const firstClass = gClasses[0];
                                    setCellGrade(g);
                                    setCellAdd({
                                      day,
                                      classId: firstClass?.id ?? 0,
                                    });
                                    setCellSubject(validSubjs[0] ?? "");
                                    setCellStartTime("08:00");
                                    setCellEndTime("09:00");
                                  }}
                                  className="w-full text-sm py-1 rounded-xl border border-dashed border-white/15 text-white/30 hover:text-[#14B8A6] hover:border-[#14B8A6]/40 transition-colors"
                                >
                                  +
                                </button>
                              )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "students" && (
          <div>
            <div className="flex flex-wrap items-center gap-4 mb-5">
              <h2 className="font-semibold text-lg">Աշակերտներ</h2>
              <select
                value={selectedClassId}
                onChange={(e) =>
                  setSelectedClassId(
                    e.target.value ? parseInt(e.target.value) : "",
                  )
                }
                className="bg-background/50 border border-input rounded-xl px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                <option value="">Բոլոր Աշակերտներ</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setShowStForm(!showStForm)}
                className={btnPrimary}
              >
                + Ավելացել Աշակերտ
              </button>
            </div>

            {showStForm && (
              <form
                onSubmit={handleCreateStudent}
                className="mb-6 bg-card/50 border border-white/10 rounded-2xl p-5 space-y-3"
              >
                <h3 className="font-semibold tracking-wide uppercase text-sm">
                  ՆՈՐ ԱՇԱԿԵՐՏ
                  {selectedClassId
                    ? ` · ${classes.find((c) => c.id === selectedClassId)?.name}`
                    : ""}
                </h3>
                {stError && (
                  <p className="text-destructive text-xs">{stError}</p>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className="text-xs text-muted-foreground">
                      Անուն, ազգանուն *
                    </label>
                    <input
                      value={stForm.fullName}
                      onChange={(e) =>
                        setStForm((f) => ({ ...f, fullName: e.target.value }))
                      }
                      required
                      className={inputCls}
                      placeholder="Անուն, ազգանուն"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Էլ. հասցե
                    </label>
                    <input
                      type="email"
                      value={stForm.email}
                      onChange={(e) =>
                        setStForm((f) => ({ ...f, email: e.target.value }))
                      }
                      className={inputCls}
                      placeholder="example@mail.com"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Տարիք (ամ.)
                    </label>
                    <input
                      type="number"
                      min="5"
                      max="25"
                      value={stForm.age}
                      onChange={(e) =>
                        setStForm((f) => ({ ...f, age: e.target.value }))
                      }
                      className={inputCls}
                      placeholder="14"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="text-xs text-muted-foreground">
                      Դասարան
                    </label>
                    <select
                      value={stClassId}
                      onChange={(e) => setStClassId(e.target.value)}
                      className={inputCls}
                    >
                      <option value="">Ընտրել դասարանը (կամ. )</option>
                      {classes.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground/60">
                  Օգտանունը ստեղծվում է ավտոմատ՝ «student123» ձևաչափով:
                </p>
                <div className="flex gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={createStudent.isPending}
                    className={btnPrimary}
                  >
                    {createStudent.isPending ? "..." : "ՊԱՀՊԱՆԵԼ"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowStForm(false)}
                    className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white"
                  >
                    ՉԵՂԱՐԿԵԼ
                  </button>
                </div>
              </form>
            )}

            <div className="space-y-2">
              {students.length === 0 && (
                <p className="text-muted-foreground text-sm py-8 text-center">
              Աշակերտ չկա
                </p>
              )}
              {students.map((s) => (
                <div
                  key={s.id}
                  className="bg-card/50 border border-white/10 rounded-xl px-4 py-3 flex items-center justify-between"
                >
                  <div>
                    <div className="font-medium">{s.fullName}</div>
                    <div className="text-xs text-muted-foreground">
                      {(s as any).email || s.username}
                      {(s as any).age ? ` · ${(s as any).age} t.` : ""}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    {selectedClassId && (
                      <button
                        onClick={() =>
                          removeFromClass.mutate(
                            {
                              id: s.id,
                              data: { classId: selectedClassId as number },
                            },
                            { onSuccess: () => inv("students") },
                          )
                        }
                        className={btnGhost}
                      >
                        Հeracnel Dasaranits
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (confirm(`Ջնջել ${s.fullName}?`))
                          deleteStudent.mutate(
                            { id: s.id },
                            { onSuccess: () => inv("students", "stats") },
                          );
                      }}
                      className={btnDanger}
                    >
                      🗑 Ջնջել
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── SUBJECTS ── */}
        {tab === "subjects" && (
          <div>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-semibold text-lg">📖 Առարկաներ</h2>
            </div>

            <form
              onSubmit={handleCreateSubject}
              className="mb-6 bg-card/50 border border-white/10 rounded-2xl p-5 space-y-3"
            >
              <h3 className="font-medium">ԱՎԵԼԱՑՆԵԼ ԱՌԱՐԿԱՆԵՐ</h3>
              {subError && (
                <p className="text-destructive text-xs">{subError}</p>
              )}
              <div className="flex gap-3">
                <input
                  value={subName}
                  onChange={(e) => setSubName(e.target.value)}
                  placeholder="ԱՌԱՐԿԱՆԵՐ ԱՆՈՒՆ"
                  className="flex-1 bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <button
                  type="submit"
                  disabled={createSubject.isPending}
                  className={btnPrimary}
                >
                  {createSubject.isPending ? "..." : "ԱՎԵԼԱՑՆԵԼ"}
                </button>
              </div>
            </form>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-muted-foreground text-left">
                    <th className="pb-3 pr-4 pl-1">#</th>
                    <th className="pb-3 pr-4">ԱՌԱՐԿԱՆԵՐ ԱՆՈՒՆ</th>
                    <th className="pb-3 text-right">ԳՈՐԾՈՂՈՒԹՅՈՒՆՆԵՐ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {subjectsList.length === 0 && (
                    <tr>
                      <td
                        colSpan={3}
                        className="py-8 text-center text-muted-foreground"
                      >
                        Առարկաներ չկա
                      </td>
                    </tr>
                  )}
                  {subjectsList.map((s, idx) => (
                    <tr
                      key={s.id}
                      className="hover:bg-white/2 transition-colors"
                    >
                      <td className="py-3 pr-4 pl-1 text-muted-foreground">
                        {idx + 1}
                      </td>
                      <td className="py-3 pr-4 font-medium">{s.name}</td>
                      <td className="py-3 text-right">
                        <button
                          onClick={() => handleDeleteSubject(s.id, s.name)}
                          className={btnDanger}
                        >
                          🗑 Ջնջել
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
          </div>
        </main>
      </div>
    </div>
  );
}
