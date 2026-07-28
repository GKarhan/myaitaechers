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
  useGetCourseLessonsProgress,
  useCreateTeacherLesson,
  useUpdateTeacherLesson,
  useDeleteTeacherLesson,
  useUpdateLessonStatus,
  useGetTeacherSchedule,
  useGetTeacherProfile,
  useGetStudentDetail,
  useGetLessonNodes,
  useCreateLessonNode,
  useDeleteLessonNode,
  getGetTeacherClassesQueryKey,
  getGetClassStudentsQueryKey,
  getGetClassCoursesQueryKey,
  getGetCourseResourcesQueryKey,
  getGetCourseLessonsQueryKey,
  getGetCourseLessonsProgressQueryKey,
  getGetTeacherScheduleQueryKey,
  getGetTeacherProfileQueryKey,
  getGetStudentDetailQueryKey,
  getGetLessonNodesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type MainView = "dashboard" | "class" | "course" | "student";
type ClassTab = "subjects" | "students";

const RESOURCE_TYPES = [
  { key: "textbook", icon: "📚", label: "ԴԱՍԱԳԻՐՔ" },
  { key: "curriculum", icon: "📄", label: "ԾՐԱԳԻՐ" },
  { key: "thematic_plan", icon: "📑", label: "ԹԵՄԱՏԻԿ ՊԼԱՆ" },
  { key: "other", icon: "📎", label: "ԱՅԼ ՆՅՈՒԹԵՐ" },
] as const;

const MONTHS_HY = [
  "Հունվ.",
  "Փետր.",
  "Մարտ",
  "Ապր.",
  "Մայիս",
  "Հունիս",
  "Հուլ.",
  "Օգոստ.",
  "Սեպտ.",
  "Հոկտ.",
  "Նոյ.",
  "Դեկտ.",
];

async function uploadResource(
  courseId: number,
  form: { type: string; title: string; description: string; file: File | null },
) {
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

// ── Lesson Nodes sub-component ────────────────────────────────────────────────
function LessonNodesPanel({ lessonId }: { lessonId: number }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: "",
    theoryContent: "",
    targetBloomLevel: "1",
    estimatedMinutes: "5",
  });

  const { data: nodes = [], isFetching } = useGetLessonNodes(lessonId, {
    query: {
      enabled: open,
      queryKey: getGetLessonNodesQueryKey(lessonId),
    },
  });

  const createNode = useCreateLessonNode();
  const deleteNode = useDeleteLessonNode();

  const refresh = () =>
    qc.invalidateQueries({ queryKey: getGetLessonNodesQueryKey(lessonId) });

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    createNode.mutate(
      {
        lessonId,
        data: {
          title: form.title.trim(),
          theoryContent: form.theoryContent.trim() || undefined,
          targetBloomLevel: parseInt(form.targetBloomLevel) || 1,
          estimatedMinutes: parseInt(form.estimatedMinutes) || 5,
        },
      },
      {
        onSuccess: () => {
          setForm({ title: "", theoryContent: "", targetBloomLevel: "1", estimatedMinutes: "5" });
          refresh();
        },
      },
    );
  };

  const inputCls =
    "w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50";

  return (
    <div className="border-t border-white/8">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-2 text-xs text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
      >
        <span className="font-medium tracking-wide">
          📋 Ենթաթեմաներ (Node-եր){nodes.length > 0 ? ` · ${nodes.length}` : ""}
        </span>
        <span>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3">
          {/* Node list */}
          {isFetching && nodes.length === 0 ? (
            <p className="text-xs text-muted-foreground">Բեռնվում...</p>
          ) : nodes.length === 0 ? (
            <p className="text-xs text-muted-foreground/60">Node-եր դեռ չկան</p>
          ) : (
            <div className="space-y-1">
              {nodes.map((n) => (
                <div
                  key={n.id}
                  className="flex items-center gap-2 bg-background/40 rounded-lg px-3 py-2"
                >
                  <span className="text-xs font-mono text-primary/60 w-5 shrink-0">{n.sequence}.</span>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium truncate block">{n.title}</span>
                    <span className="text-xs text-muted-foreground/70">
                      {n.targetBloomLevel != null ? `Bloom ${n.targetBloomLevel}` : ""}
                      {n.targetBloomLevel != null && n.estimatedMinutes != null ? " · " : ""}
                      {n.estimatedMinutes != null ? `${n.estimatedMinutes} ր` : ""}
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      if (!confirm(`Ջնջե՞լ «${n.title}»`)) return;
                      deleteNode.mutate(
                        { lessonId, nodeId: n.id },
                        { onSuccess: refresh },
                      );
                    }}
                    className="text-xs text-muted-foreground hover:text-destructive shrink-0 transition-colors"
                  >
                    🗑
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add node form */}
          <form
            onSubmit={handleAdd}
            className="border border-white/10 rounded-xl p-3 space-y-2 bg-background/30"
          >
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Ավելացնել node
            </p>
            <input
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              required
              className={inputCls}
              placeholder="Վերնագիր *"
            />
            <textarea
              value={form.theoryContent}
              onChange={(e) => setForm((f) => ({ ...f, theoryContent: e.target.value }))}
              rows={2}
              className={inputCls + " resize-none"}
              placeholder="Տեսական բովանդակություն (ըստ ցանկության)"
            />
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-xs text-muted-foreground mb-1 block">Bloom մակարդակ (1–6)</label>
                <input
                  type="number"
                  min="1"
                  max="6"
                  value={form.targetBloomLevel}
                  onChange={(e) => setForm((f) => ({ ...f, targetBloomLevel: e.target.value }))}
                  className={inputCls}
                />
              </div>
              <div className="flex-1">
                <label className="text-xs text-muted-foreground mb-1 block">Րոպե</label>
                <input
                  type="number"
                  min="1"
                  value={form.estimatedMinutes}
                  onChange={(e) => setForm((f) => ({ ...f, estimatedMinutes: e.target.value }))}
                  className={inputCls}
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={createNode.isPending}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-xs font-medium disabled:opacity-50 transition-all hover:opacity-90"
            >
              {createNode.isPending ? "..." : "Ավելացնել"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

export default function TeacherDashboard() {
  const { user, logout, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();

  const [mainView, setMainView] = useState<MainView>("dashboard");
  const [activeTab, setActiveTab] = useState<
    "classes" | "schedule" | "profile"
  >("classes");
  const [classTab, setClassTab] = useState<ClassTab>("subjects");

  const [selectedClass, setSelectedClass] = useState<{
    id: number;
    name: string;
    grade: string;
  } | null>(null);
  const [selectedCourse, setSelectedCourse] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [selectedStudentId, setSelectedStudentId] = useState<number | null>(
    null,
  );

  const { data: schedule = [] } = useGetTeacherSchedule({
    query: { queryKey: getGetTeacherScheduleQueryKey() },
  });
  const { data: teacherProfile } = useGetTeacherProfile({
    query: { queryKey: getGetTeacherProfileQueryKey() },
  });
  const { data: classes = [] } = useGetTeacherClasses({
    query: { queryKey: getGetTeacherClassesQueryKey() },
  });

  const { data: students = [] } = useGetClassStudents(selectedClass?.id ?? 0, {
    query: {
      enabled: !!selectedClass,
      queryKey: getGetClassStudentsQueryKey(selectedClass?.id ?? 0),
    },
  });
  const { data: classCourses = [] } = useGetClassCourses(
    selectedClass?.id ?? 0,
    {
      query: {
        enabled: !!selectedClass && mainView === "class",
        queryKey: getGetClassCoursesQueryKey(selectedClass?.id ?? 0),
      },
    },
  );
  const { data: courseResources = [] } = useGetCourseResources(
    selectedCourse?.id ?? 0,
    {
      query: {
        enabled: !!selectedCourse,
        queryKey: getGetCourseResourcesQueryKey(selectedCourse?.id ?? 0),
      },
    },
  );
  const { data: courseLessons = [] } = useGetCourseLessons(
    selectedCourse?.id ?? 0,
    {
      query: {
        enabled: !!selectedCourse,
        queryKey: getGetCourseLessonsQueryKey(selectedCourse?.id ?? 0),
      },
    },
  );
  const { data: lessonsProgress } = useGetCourseLessonsProgress(
    selectedCourse?.id ?? 0,
    {
      query: {
        enabled: !!selectedCourse && mainView === "course",
        queryKey: getGetCourseLessonsProgressQueryKey(selectedCourse?.id ?? 0),
      },
    },
  );
  const { data: studentDetail } = useGetStudentDetail(selectedStudentId ?? 0, {
    query: {
      enabled: !!selectedStudentId,
      queryKey: getGetStudentDetailQueryKey(selectedStudentId ?? 0),
    },
  });

  const addStudent = useAddStudentToClass();
  const removeStudent = useRemoveStudentFromClass();
  const createCourse = useCreateCourse();
  const deleteCourse = useDeleteCourse();
  const deleteResource = useDeleteCourseResource();
  const createLesson = useCreateTeacherLesson();
  const updateLesson = useUpdateTeacherLesson();
  const deleteLesson = useDeleteTeacherLesson();

  const [studentForm, setStudentForm] = useState({
    fullName: "",
    email: "",
    age: "",
  });
  const [showStudentForm, setShowStudentForm] = useState(false);

  const handleAddStudent = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedClass) return;
    addStudent.mutate(
      {
        classId: selectedClass.id,
        data: {
          fullName: studentForm.fullName,
          email: (studentForm as any).email || undefined,
          age: (studentForm as any).age
            ? parseInt((studentForm as any).age)
            : undefined,
        } as any,
      },
      {
        onSuccess: () => {
          setShowStudentForm(false);
          setStudentForm({ fullName: "", email: "", age: "" });
          qc.invalidateQueries({
            queryKey: getGetClassStudentsQueryKey(selectedClass.id),
          });
        },
      },
    );
  };

  const [courseForm, setCourseForm] = useState({ name: "", description: "" });
  const [showCourseForm, setShowCourseForm] = useState(false);

  const handleCreateCourse = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedClass) return;
    createCourse.mutate(
      {
        classId: selectedClass.id,
        data: { name: courseForm.name, description: courseForm.description },
      },
      {
        onSuccess: () => {
          setShowCourseForm(false);
          setCourseForm({ name: "", description: "" });
          qc.invalidateQueries({
            queryKey: getGetClassCoursesQueryKey(selectedClass.id),
          });
        },
      },
    );
  };

  const emptyResForm = {
    type: "textbook",
    title: "",
    description: "",
    file: null as File | null,
  };
  const [resForm, setResForm] = useState(emptyResForm);
  const [showResForm, setShowResForm] = useState<string | null>(null);
  const [resUploading, setResUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleAddResource = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCourse || !resForm.title) return;
    setResUploading(true);
    try {
      await uploadResource(selectedCourse.id, resForm);
      setShowResForm(null);
      setResForm(emptyResForm);
      if (fileRef.current) fileRef.current.value = "";
      qc.invalidateQueries({
        queryKey: getGetCourseResourcesQueryKey(selectedCourse.id),
      });
    } catch {
      /* ignore */
    } finally {
      setResUploading(false);
    }
  };

  const emptyLesson = {
    title: "",
    lessonNumber: "",
    pagesFrom: "",
    pagesTo: "",
    textbookAuthor: "",
    textbookTitle: "",
    chapterTitle: "",
    paragraphNumber: "",
  };
  const [lessonForm, setLessonForm] = useState(emptyLesson);
  const [showLessonForm, setShowLessonForm] = useState(false);
  const [editLesson, setEditLesson] = useState<
    ({ id: number } & typeof emptyLesson) | null
  >(null);
  const [expandedLessonId, setExpandedLessonId] = useState<number | null>(null);
  const updateStatus = useUpdateLessonStatus();

  const handleCreateLesson = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCourse) return;
    createLesson.mutate(
      {
        data: {
          courseId: selectedCourse.id,
          title: lessonForm.title,
          lessonNumber: lessonForm.lessonNumber
            ? parseInt(lessonForm.lessonNumber)
            : undefined,
          pagesFrom: lessonForm.pagesFrom
            ? parseInt(lessonForm.pagesFrom)
            : undefined,
          pagesTo: lessonForm.pagesTo
            ? parseInt(lessonForm.pagesTo)
            : undefined,
          textbookAuthor: lessonForm.textbookAuthor || undefined,
          textbookTitle: lessonForm.textbookTitle || undefined,
          chapterTitle: lessonForm.chapterTitle || undefined,
          paragraphNumber: lessonForm.paragraphNumber || undefined,
        },
      },
      {
        onSuccess: () => {
          setShowLessonForm(false);
          setLessonForm(emptyLesson);
          qc.invalidateQueries({
            queryKey: getGetCourseLessonsQueryKey(selectedCourse.id),
          });
        },
      },
    );
  };

  const handleUpdateLesson = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editLesson) return;
    updateLesson.mutate(
      {
        id: editLesson.id,
        data: {
          title: editLesson.title,
          lessonNumber: editLesson.lessonNumber
            ? parseInt(editLesson.lessonNumber)
            : undefined,
          pagesFrom: editLesson.pagesFrom
            ? parseInt(editLesson.pagesFrom)
            : undefined,
          pagesTo: editLesson.pagesTo
            ? parseInt(editLesson.pagesTo)
            : undefined,
          textbookAuthor: editLesson.textbookAuthor || undefined,
          textbookTitle: editLesson.textbookTitle || undefined,
          chapterTitle: editLesson.chapterTitle || undefined,
          paragraphNumber: editLesson.paragraphNumber || undefined,
        },
      },
      {
        onSuccess: () => {
          setEditLesson(null);
          if (selectedCourse)
            qc.invalidateQueries({
              queryKey: getGetCourseLessonsQueryKey(selectedCourse.id),
            });
        },
      },
    );
  };

  const handleStatusChange = (
    lessonId: number,
    status: "assigned" | "active" | "completed",
  ) => {
    if (!selectedCourse) return;
    updateStatus.mutate(
      { id: lessonId, data: { status } },
      {
        onSuccess: () => {
          qc.invalidateQueries({
            queryKey: getGetCourseLessonsQueryKey(selectedCourse.id),
          });
        },
      },
    );
  };

  if (authLoading)
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  if (user?.role !== "teacher" && user?.role !== "admin") {
    setLocation("/login");
    return null;
  }

  const inputCls =
    "w-full bg-background/50 border border-input rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50";
  const btnPrimary =
    "px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-medium disabled:opacity-50 transition-all hover:opacity-90";
  const btnOutline =
    "px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white hover:border-white/20 transition-colors";
  const btnGhost =
    "px-3 py-1 rounded-lg text-xs text-muted-foreground hover:text-white border border-transparent hover:border-white/10 transition-colors";
  const btnDanger =
    "px-3 py-1 rounded-lg text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors";

  // ── STUDENT DETAIL ────────────────────────────────────────────────────────
  if (mainView === "student" && selectedStudentId) {
    const hw = (studentDetail?.homework ?? []) as Array<{
      id: number;
      title: string;
      task: string;
      status: string;
      score: number | null;
      feedback: string | null;
    }>;
    return (
      <div className="min-h-[100dvh] bg-background text-white">
        <QuickSwitch />
        <header className="border-b border-white/10 px-6 py-4 flex items-center gap-3">
          <button
            onClick={() => setMainView("class")}
            className="text-muted-foreground hover:text-white text-sm transition-colors"
          >
            ← Վերադառնալ
          </button>
          <h1 className="text-lg font-bold">👨‍🎓 {studentDetail?.fullName}</h1>
          {studentDetail?.avgScore != null && (
            <span className="ml-auto px-3 py-1 rounded-full text-sm bg-primary/20 text-primary">
              Միջ. {studentDetail.avgScore}/100
            </span>
          )}
        </header>
        <div className="max-w-4xl mx-auto px-6 py-6">
          <h2 className="font-semibold mb-4">
            Տնային աշխատանքներ ({hw.length})
          </h2>
          {hw.length === 0 && (
            <p className="text-muted-foreground text-sm">Տնային չկա</p>
          )}
          <div className="space-y-3">
            {hw.map((h) => (
              <div
                key={h.id}
                className="bg-card/50 border border-white/10 rounded-xl p-4"
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="font-medium">{h.title}</div>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${h.status === "graded" ? "bg-teal-400/20 text-teal-400" : h.status === "submitted" ? "bg-amber-400/20 text-amber-400" : "bg-white/10 text-muted-foreground"}`}
                  >
                    {h.status === "graded"
                      ? `✓ ${h.score}/100`
                      : h.status === "submitted"
                        ? "Ներկայացված"
                        : "Սպասում"}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{h.task}</p>
                {h.feedback && (
                  <p className="text-sm text-primary mt-2">💬 {h.feedback}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── COURSE PAGE ───────────────────────────────────────────────────────────
  if (mainView === "course" && selectedCourse) {
    const grouped = Object.fromEntries(
      RESOURCE_TYPES.map((t) => [
        t.key,
        courseResources.filter((r) => r.type === t.key),
      ]),
    );

    return (
      <div className="min-h-[100dvh] bg-background text-white">
        <QuickSwitch />
        <header className="border-b border-white/10 px-6 py-4 flex items-center gap-3">
          <button
            onClick={() => setMainView("class")}
            className="text-muted-foreground hover:text-white text-sm transition-colors"
          >
            ← {selectedClass?.name}
          </button>
          <div>
            <h1 className="text-lg font-bold">📖 {selectedCourse.name}</h1>
          </div>
          <span className="ml-auto text-sm text-muted-foreground">
            {user?.fullName}
          </span>
        </header>

        <div className="max-w-4xl mx-auto px-6 py-8 space-y-10">
          {/* ── RESOURCES ── */}
          <section>
            <h2 className="text-base font-semibold mb-5 text-white/90">
              📎 Կցված նյութեր
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {RESOURCE_TYPES.map(({ key, icon, label }) => {
                const docs = grouped[key] ?? [];
                const isOpen = showResForm === key;
                return (
                  <div
                    key={key}
                    className="bg-card/50 border border-white/10 rounded-2xl p-4"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <span className="font-semibold text-xs tracking-wide text-white/80">
                        {icon} {label}
                      </span>
                      <button
                        onClick={() => {
                          setShowResForm(isOpen ? null : key);
                          setResForm({ ...emptyResForm, type: key });
                          if (fileRef.current) fileRef.current.value = "";
                        }}
                        className="text-xs px-2 py-1 rounded-lg bg-primary/20 text-primary hover:bg-primary/30 transition-colors"
                      >
                        {isOpen ? "Փակել" : "+ ԿՑԵԼ ՆՅՈՒԹ"}
                      </button>
                    </div>

                    {isOpen && (
                      <form
                        onSubmit={handleAddResource}
                        className="mb-3 space-y-2 border-t border-white/10 pt-3"
                      >
                        <input
                          value={resForm.title}
                          onChange={(e) =>
                            setResForm((f) => ({ ...f, title: e.target.value }))
                          }
                          required
                          className={inputCls}
                          placeholder="Անվանումը *"
                        />
                        <input
                          value={resForm.description}
                          onChange={(e) =>
                            setResForm((f) => ({
                              ...f,
                              description: e.target.value,
                            }))
                          }
                          className={inputCls}
                          placeholder="Նկարագրություն (ըստ ցանկության)"
                        />
                        <input
                          ref={fileRef}
                          type="file"
                          accept=".pdf,.doc,.docx,.ppt,.pptx,.mp4,.mov"
                          onChange={(e) =>
                            setResForm((f) => ({
                              ...f,
                              file: e.target.files?.[0] ?? null,
                            }))
                          }
                          className="w-full text-xs text-muted-foreground file:mr-2 file:py-1 file:px-2 file:rounded-lg file:border-0 file:bg-primary/20 file:text-primary hover:file:bg-primary/30 cursor-pointer"
                        />
                        <div className="flex gap-2">
                          <button
                            type="submit"
                            disabled={resUploading}
                            className={btnPrimary + " text-xs py-1"}
                          >
                            {resUploading ? "Բեռնվում..." : "Ավելացնել"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setShowResForm(null);
                              if (fileRef.current) fileRef.current.value = "";
                            }}
                            className={btnOutline + " text-xs py-1"}
                          >
                            Չեղարկել
                          </button>
                        </div>
                      </form>
                    )}

                    {docs.length === 0 && !isOpen && (
                      <p className="text-xs text-muted-foreground/60">
                        Կցված նյութ դեռ չկա
                      </p>
                    )}
                    <div className="space-y-1.5">
                      {docs.map((d) => (
                        <div
                          key={d.id}
                          className="flex items-center gap-2 bg-background/40 rounded-lg px-2 py-1.5"
                        >
                          <span className="text-xs flex-1 truncate">
                            {d.title}
                          </span>
                          {d.fileUrl && (
                            <a
                              href={d.fileUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-teal-400 hover:underline shrink-0"
                            >
                              ⬇
                            </a>
                          )}
                          <button
                            onClick={() => {
                              if (!selectedCourse || !confirm("Ջնջե՞լ?"))
                                return;
                              deleteResource.mutate(
                                {
                                  courseId: selectedCourse.id,
                                  resourceId: d.id,
                                },
                                {
                                  onSuccess: () =>
                                    qc.invalidateQueries({
                                      queryKey: getGetCourseResourcesQueryKey(
                                        selectedCourse.id,
                                      ),
                                    }),
                                },
                              );
                            }}
                            className="text-xs text-muted-foreground hover:text-destructive shrink-0"
                          >
                            🗑
                          </button>
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
              <h2 className="text-base font-semibold text-white/90">
                📝 Դասեր ({courseLessons.length})
              </h2>
              <button
                onClick={() => {
                  setShowLessonForm((f) => !f);
                  setEditLesson(null);
                }}
                className={btnPrimary}
              >
                + Ավելացնել դաս
              </button>
            </div>

            {showLessonForm && (
              <form
                onSubmit={handleCreateLesson}
                className="mb-5 bg-card/50 border border-white/10 rounded-2xl p-5 space-y-4"
              >
                <h3 className="font-semibold text-sm text-white/90">Նոր դաս</h3>
                <p className="text-xs uppercase tracking-wide text-muted-foreground font-semibold pt-1">
                  Ա. ԴԱՍԱԳՐՔԻ ՏԵՂԵԿՈՒԹՅՈՒՆՆԵՐ
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Դասագրքի հեղինակ
                    </label>
                    <input
                      value={lessonForm.textbookAuthor}
                      onChange={(e) =>
                        setLessonForm((f) => ({
                          ...f,
                          textbookAuthor: e.target.value,
                        }))
                      }
                      className={inputCls}
                      placeholder="«Ա. Մարտիրոսյան»"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Դասագրքի անվանումը
                    </label>
                    <input
                      value={lessonForm.textbookTitle}
                      onChange={(e) =>
                        setLessonForm((f) => ({
                          ...f,
                          textbookTitle: e.target.value,
                        }))
                      }
                      className={inputCls}
                      placeholder="«Առարկան»"
                    />
                  </div>
                </div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground font-semibold pt-1">
                  Բ. Բովանդակություն
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="sm:col-span-2">
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Թema / Գլուխ
                    </label>
                    <input
                      value={lessonForm.chapterTitle}
                      onChange={(e) =>
                        setLessonForm((f) => ({
                          ...f,
                          chapterTitle: e.target.value,
                        }))
                      }
                      className={inputCls}
                      placeholder="«Դասի թեման»"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Դասի համարը
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={lessonForm.lessonNumber}
                      onChange={(e) =>
                        setLessonForm((f) => ({
                          ...f,
                          lessonNumber: e.target.value,
                        }))
                      }
                      className={inputCls}
                      placeholder="1"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Պարագրաֆ
                    </label>
                    <input
                      value={lessonForm.paragraphNumber}
                      onChange={(e) =>
                        setLessonForm((f) => ({
                          ...f,
                          paragraphNumber: e.target.value,
                        }))
                      }
                      className={inputCls}
                      placeholder="1.1"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Դասի վերնագիրը *
                    </label>
                    <input
                      value={lessonForm.title}
                      onChange={(e) =>
                        setLessonForm((f) => ({ ...f, title: e.target.value }))
                      }
                      required
                      className={inputCls}
                      placeholder="«Դասի վերնագիրը»"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Էջի սկիզբը
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={lessonForm.pagesFrom}
                      onChange={(e) =>
                        setLessonForm((f) => ({
                          ...f,
                          pagesFrom: e.target.value,
                        }))
                      }
                      className={inputCls}
                      placeholder="5"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Էջի վերջը
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={lessonForm.pagesTo}
                      onChange={(e) =>
                        setLessonForm((f) => ({
                          ...f,
                          pagesTo: e.target.value,
                        }))
                      }
                      className={inputCls}
                      placeholder="15"
                    />
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={createLesson.isPending}
                    className={btnPrimary}
                  >
                    {createLesson.isPending ? "..." : "Պահպանել"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowLessonForm(false)}
                    className={btnOutline}
                  >
                    Չեղարկել
                  </button>
                </div>
              </form>
            )}

            {editLesson && (
              <form
                onSubmit={handleUpdateLesson}
                className="mb-5 bg-primary/5 border border-primary/20 rounded-2xl p-5 space-y-4"
              >
                <h3 className="font-semibold text-sm text-white/90">
                  Խմբագրել դասը
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Դասագրքի հեղինակը
                    </label>
                    <input
                      value={editLesson.textbookAuthor}
                      onChange={(e) =>
                        setEditLesson(
                          (l) => l && { ...l, textbookAuthor: e.target.value },
                        )
                      }
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Դասագրքի անվանումը
                    </label>
                    <input
                      value={editLesson.textbookTitle}
                      onChange={(e) =>
                        setEditLesson(
                          (l) => l && { ...l, textbookTitle: e.target.value },
                        )
                      }
                      className={inputCls}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Թema / Գլուխ
                    </label>
                    <input
                      value={editLesson.chapterTitle}
                      onChange={(e) =>
                        setEditLesson(
                          (l) => l && { ...l, chapterTitle: e.target.value },
                        )
                      }
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Դասի համարը
                    </label>
                    <input
                      type="number"
                      value={editLesson.lessonNumber}
                      onChange={(e) =>
                        setEditLesson(
                          (l) => l && { ...l, lessonNumber: e.target.value },
                        )
                      }
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Պարագրաֆ
                    </label>
                    <input
                      value={editLesson.paragraphNumber}
                      onChange={(e) =>
                        setEditLesson(
                          (l) => l && { ...l, paragraphNumber: e.target.value },
                        )
                      }
                      className={inputCls}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Դասի վերնագիրը *
                    </label>
                    <input
                      value={editLesson.title}
                      onChange={(e) =>
                        setEditLesson(
                          (l) => l && { ...l, title: e.target.value },
                        )
                      }
                      required
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Էj' skizb
                    </label>
                    <input
                      type="number"
                      value={editLesson.pagesFrom}
                      onChange={(e) =>
                        setEditLesson(
                          (l) => l && { ...l, pagesFrom: e.target.value },
                        )
                      }
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Էj' verj
                    </label>
                    <input
                      type="number"
                      value={editLesson.pagesTo}
                      onChange={(e) =>
                        setEditLesson(
                          (l) => l && { ...l, pagesTo: e.target.value },
                        )
                      }
                      className={inputCls}
                    />
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={updateLesson.isPending}
                    className={btnPrimary}
                  >
                    {updateLesson.isPending ? "..." : "ՊԱՀՊԱՆԵԼ"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditLesson(null)}
                    className={btnOutline}
                  >
                    ՉԵՂԱՐԿԵԼ
                  </button>
                </div>
              </form>
            )}

            {courseLessons.length === 0 && !showLessonForm && (
              <div className="text-center py-10 text-muted-foreground">
                <div className="text-4xl mb-3">📝</div>
                <p className="text-sm">Դաս չկա · Ստեղծեք առաջին դասը</p>
              </div>
            )}

            {/* Hierarchical: textbook → chapter → lessons */}
            {(() => {
              const statusMeta = (s: string) => {
                if (s === "active")
                  return {
                    label: "Aysorvada das",
                    cls: "bg-primary/20 text-primary border-primary/30",
                    dot: "bg-primary",
                  };
                if (s === "assigned")
                  return {
                    label: "Handznaravats",
                    cls: "bg-amber-400/15 text-amber-400 border-amber-400/30",
                    dot: "bg-amber-400",
                  };
                if (s === "completed")
                  return {
                    label: "Ավարտված",
                    cls: "bg-teal-400/15 text-teal-400 border-teal-400/30",
                    dot: "bg-teal-400",
                  };
                return {
                  label: " Ընթացքի մեջ",
                  cls: "bg-white/5 text-muted-foreground border-white/10",
                  dot: "bg-white/30",
                };
              };
              const sorted = [...courseLessons].sort((a, b) => {
                const ta = ((a as any).textbookTitle ?? "").localeCompare(
                  (b as any).textbookTitle ?? "",
                  "hy",
                );
                if (ta !== 0) return ta;
                const ca = ((a as any).chapterTitle ?? "").localeCompare(
                  (b as any).chapterTitle ?? "",
                  "hy",
                );
                if (ca !== 0) return ca;
                const la =
                  ((a as any).lessonNumber ?? 9999) -
                  ((b as any).lessonNumber ?? 9999);
                if (la !== 0) return la;
                return ((a as any).paragraphNumber ?? "").localeCompare(
                  (b as any).paragraphNumber ?? "",
                );
              });
              const textbookGroups: Map<string, typeof sorted> = new Map();
              for (const l of sorted) {
                const tb = ((l as any).textbookTitle as string | null) ?? "";
                if (!textbookGroups.has(tb)) textbookGroups.set(tb, []);
                textbookGroups.get(tb)!.push(l);
              }
              return (
                <div className="space-y-6">
                  {Array.from(textbookGroups.entries()).map(
                    ([tbTitle, tbLessons]) => {
                      const tbAuthor = (tbLessons[0] as any).textbookAuthor as
                        | string
                        | null;
                      const chapterGroups: Map<string, typeof tbLessons> =
                        new Map();
                      for (const l of tbLessons) {
                        const ch =
                          ((l as any).chapterTitle as string | null) ?? "";
                        if (!chapterGroups.has(ch)) chapterGroups.set(ch, []);
                        chapterGroups.get(ch)!.push(l);
                      }
                      return (
                        <div
                          key={tbTitle}
                          className="bg-card/30 border border-white/10 rounded-2xl overflow-hidden"
                        >
                          <div className="px-5 py-4 border-b border-white/10 bg-card/50">
                            <div className="text-xs uppercase tracking-widest text-muted-foreground font-semibold mb-1">
                              ԴԱՍԱԳԻՐՔ
                            </div>
                            <div className="font-semibold text-base text-white">
                              {tbTitle || "(Dasagriq nshvatc chi)"}
                            </div>
                            {tbAuthor && (
                              <div className="text-xs text-muted-foreground mt-0.5">
                                Հեղինակ' {tbAuthor}
                              </div>
                            )}
                          </div>
                          <div className="divide-y divide-white/5">
                            {Array.from(chapterGroups.entries()).map(
                              ([chTitle, chLessons]) => (
                                <div key={chTitle} className="px-5 py-4">
                                  {chTitle && (
                                    <div className="text-xs font-semibold text-secondary/80 uppercase tracking-wide mb-3">
                                      Թեմա · {chTitle}
                                    </div>
                                  )}
                                  <div className="space-y-2">
                                    {chLessons.map((l) => {
                                      const isCompleted = (l as any).status === "completed";
                                      const isActive    = (l as any).status === "active";
                                      return (
                                        <div
                                          key={l.id}
                                          className={`rounded-xl overflow-hidden border transition-colors ${isActive ? "border-primary/40 bg-primary/5" : "border-white/8 bg-background/40"}`}
                                        >
                                          <div className="px-4 py-3 flex items-start gap-3">
                                            <span className="text-xs font-mono text-primary/70 w-7 shrink-0 mt-0.5 text-center">
                                              {(l as any).lessonNumber ?? "—"}
                                            </span>
                                            <div className="flex-1 min-w-0">
                                              <div className="font-medium text-sm">{l.title}</div>
                                              <div className="flex flex-wrap gap-2 mt-1 items-center">
                                                {(l as any).paragraphNumber && (
                                                  <span className="text-xs text-muted-foreground">
                                                    §{(l as any).paragraphNumber}
                                                  </span>
                                                )}
                                                {((l as any).pagesFrom || (l as any).pagesTo) && (
                                                  <span className="text-xs text-muted-foreground">
                                                    Էջ {(l as any).pagesFrom ?? "?"}–{(l as any).pagesTo ?? "?"}
                                                  </span>
                                                )}
                                              </div>
                                            </div>
                                            <div className="flex flex-wrap gap-1 shrink-0 items-center justify-end">
                                               {(l as any).status === "completed" ? (
                                                 <span className="px-2 py-1 rounded-lg text-xs text-teal-400 border border-teal-400/20 bg-teal-400/10 select-none">
                                                   Ավարտված
                                                 </span>
                                               ) : (l as any).status === "active" ? (
                                                 <span className="px-2 py-1 rounded-lg text-xs text-amber-400 border border-amber-400/20 bg-amber-400/10 select-none">
                                                   Ընթացքի մեջ
                                                 </span>
                                               ) : (
                                                 <button
                                                   onClick={() => handleStatusChange(l.id, "active")}
                                                   disabled={updateStatus.isPending}
                                                   className="px-2 py-1 rounded-lg text-xs bg-primary/15 text-primary hover:bg-primary/25 transition-colors border border-primary/20"
                                                 >
                                                   Նոր դաս
                                                 </button>
                                               )}
                                              <button
                                                onClick={() => {
                                                  setEditLesson({
                                                    id: l.id,
                                                    title: l.title,
                                                    lessonNumber: String((l as any).lessonNumber ?? ""),
                                                    pagesFrom: String((l as any).pagesFrom ?? ""),
                                                    pagesTo: String((l as any).pagesTo ?? ""),
                                                    textbookAuthor: (l as any).textbookAuthor ?? "",
                                                    textbookTitle: (l as any).textbookTitle ?? "",
                                                    chapterTitle: (l as any).chapterTitle ?? "",
                                                    paragraphNumber: (l as any).paragraphNumber ?? "",
                                                  });
                                                  setShowLessonForm(false);
                                                }}
                                                className={btnGhost}
                                              >
                                                ✏️
                                              </button>
                                              <button
                                                onClick={() => {
                                                  if (!selectedCourse || !confirm("Ջնջել " + l.title + "?")) return;
                                                  deleteLesson.mutate(
                                                    { id: l.id },
                                                    {
                                                      onSuccess: () =>
                                                        qc.invalidateQueries({
                                                          queryKey: getGetCourseLessonsQueryKey(selectedCourse.id),
                                                        }),
                                                    },
                                                  );
                                                }}
                                                className={btnDanger}
                                              >
                                                🗑
                                              </button>
                                            </div>
                                          </div>
                                          {/* Ենթաթեմաներ (Node-եր) */}
                                          <LessonNodesPanel lessonId={l.id} />
                                        </div>
                                      );
                                    })}

                                  </div>
                                </div>
                              ),
                            )}
                          </div>
                        </div>
                      );
                    },
                  )}
                </div>
              );
            })()}
          </section>
        </div>
      </div>
    );
  }

  // ── CLASS PAGE ──────────────────────────────────────────────────────────────
  if (mainView === "class" && selectedClass) {
    const rawClassSubjects = Array.from(
      new Set(
        schedule
          .filter((s) => s.classId === selectedClass.id)
          .map((s) => s.subject),
      ),
    ).sort((a, b) => a.localeCompare(b, "hy"));
    const _teacherSubjectSet = new Set(teacherProfile?.subjects ?? []);
    const classSubjects =
      _teacherSubjectSet.size > 0
        ? rawClassSubjects.filter((s) => _teacherSubjectSet.has(s))
        : rawClassSubjects;
    const classScheduleEntries = schedule.filter(
      (s) => s.classId === selectedClass.id,
    );

    return (
      <div className="min-h-[100dvh] bg-background text-white">
        <QuickSwitch />
        <header className="border-b border-white/10 px-6 py-4 flex items-center gap-3">
          <button
            onClick={() => setMainView("dashboard")}
            className="text-muted-foreground hover:text-white text-sm transition-colors"
          >
            ← Վահանակ
          </button>
          <div>
            <h1 className="text-lg font-bold">{selectedClass.name}</h1>
            {selectedClass.grade && (
              <p className="text-xs text-muted-foreground">
                {selectedClass.grade}
              </p>
            )}
          </div>
          <span className="ml-auto text-sm text-muted-foreground">
            {user?.fullName}
          </span>
        </header>

        <div className="max-w-5xl mx-auto px-6 py-6">
          <div className="flex gap-1 mb-6 border-b border-white/10">
            {(["subjects", "students"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setClassTab(t)}
                className={`px-5 py-2.5 text-sm font-semibold tracking-widest whitespace-nowrap border-b-2 -mb-px transition-colors ${
                  classTab === t
                    ? "border-primary text-white"
                    : "border-transparent text-muted-foreground hover:text-white"
                }`}
              >
                {t === "subjects" ? "Առարկաներ" : "Աշակերտներ"}
              </button>
            ))}
          </div>

          {/* ── SUBJECTS TAB ── */}
          {classTab === "subjects" && (
            <div>
              {classSubjects.length === 0 ? (
                <div className="text-center py-16 text-muted-foreground">
                  <div className="text-5xl mb-4">📖</div>
                  <p className="text-sm">
                    Առաջարկներ դեռ չկան: Ադմինի կողմից չի նշանակվել
                  </p>
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {classSubjects.map((subject) => {
                      const entries = classScheduleEntries.filter(
                        (s) => s.subject === subject,
                      );
                      return (
                        <div
                          key={subject}
                          className="bg-card/60 border border-white/10 rounded-2xl p-5 hover:border-white/20 transition-all flex flex-col gap-3"
                        >
                          <div className="text-2xl">📖</div>
                          <div className="font-semibold text-base">
                            {subject}
                          </div>
                          {entries.length > 0 && (
                            <div className="space-y-1.5">
                              {entries.map((e) => (
                                <div
                                  key={e.id}
                                  className="flex items-center gap-2 text-xs"
                                >
                                  <span className="w-2 h-2 rounded-full bg-[#14B8A6] shrink-0" />
                                  <span className="text-muted-foreground">
                                    {e.day}
                                  </span>
                                  <span className="text-[#14B8A6] font-mono ml-auto">
                                    {e.time}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                          <button
                            onClick={() => {
                              const match = classCourses.find(
                                (c) => c.name === subject,
                              );
                              if (match) {
                                setSelectedCourse(match);
                                setMainView("course");
                              } else {
                                createCourse.mutate(
                                  {
                                    classId: selectedClass!.id,
                                    data: { name: subject, description: "" },
                                  },
                                  {
                                    onSuccess: (created) => {
                                      qc.invalidateQueries({
                                        queryKey: getGetClassCoursesQueryKey(
                                          selectedClass!.id,
                                        ),
                                      });
                                      setSelectedCourse(created);
                                      setMainView("course");
                                    },
                                  },
                                );
                              }
                            }}
                            className="mt-auto w-full py-2 rounded-xl bg-primary/20 border border-primary/30 text-primary text-sm font-bold tracking-widest hover:bg-primary/30 transition-colors"
                          >
                            Դիտել
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── STUDENTS TAB ── */}
          {classTab === "students" && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold">
                  Աշակերտներ ({students.length})
                </h2>
                <button
                  onClick={() => setShowStudentForm((f) => !f)}
                  className={btnPrimary}
                >
                  Ավելացնել
                </button>
              </div>
              {showStudentForm && (
                <form
                  onSubmit={handleAddStudent}
                  className="mb-5 bg-card/50 border border-white/10 rounded-2xl p-5 space-y-3"
                >
                  <h3 className="font-medium text-sm">Նոր Աշակերտ</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <label className="text-xs text-muted-foreground">
                        Անուն Ազգանուն
                      </label>
                      <input
                        value={studentForm.fullName}
                        onChange={(e) =>
                          setStudentForm((f) => ({
                            ...f,
                            fullName: e.target.value,
                          }))
                        }
                        required
                        className={inputCls}
                        placeholder="Ashakerty anunny"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">
                        Մեյլ
                      </label>
                      <input
                        type="email"
                        value={(studentForm as any).email}
                        onChange={(e) =>
                          setStudentForm(
                            (f) => ({ ...f, email: e.target.value }) as any,
                          )
                        }
                        className={inputCls}
                        placeholder="example@mail.com"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">
                        Tariq
                      </label>
                      <input
                        type="number"
                        min="5"
                        max="25"
                        value={(studentForm as any).age}
                        onChange={(e) =>
                          setStudentForm(
                            (f) => ({ ...f, age: e.target.value }) as any,
                          )
                        }
                        className={inputCls}
                        placeholder="14"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground/60">
                    Նախնական Գաղտնաբառը "student123" klini
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={addStudent.isPending}
                      className={btnPrimary}
                    >
                      {addStudent.isPending ? "..." : "Pahpanel"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowStudentForm(false)}
                      className={btnOutline}
                    >
                      Չեղարկել
                    </button>
                  </div>
                </form>
              )}
              <div className="space-y-2">
                {students.length === 0 && (
                  <p className="text-muted-foreground text-sm py-6 text-center">
                    Աշակերտ Չկա
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
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          setSelectedStudentId(s.id);
                          setMainView("student");
                        }}
                        className={btnGhost}
                      >
                        Դիտել
                      </button>
                      <button
                        onClick={() => {
                          if (!confirm("Heracel dasaranits?")) return;
                          removeStudent.mutate(
                            { classId: selectedClass.id, studentId: s.id },
                            {
                              onSuccess: () =>
                                qc.invalidateQueries({
                                  queryKey: getGetClassStudentsQueryKey(
                                    selectedClass.id,
                                  ),
                                }),
                            },
                          );
                        }}
                        className={btnDanger}
                      >
                        Հեռացնել
                      </button>
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

  // ── MAIN DASHBOARD ───────────────────────────────────────────────────────
  const SCHOOL_DAYS_HY = [
    "Երկուշաբթի",
    "Երեքշաբթի",
    "Չորեքշաբթի",
    "Հինգշաբթի",
    "Ուրբաթ",
  ];
  const sortedTeacherClasses = [...classes].sort((a, b) =>
    a.name.localeCompare(b.name, "hy"),
  );

  return (
    <div className="min-h-[100dvh] bg-background text-white">
      <QuickSwitch />

      {/* Header */}
      <header className="border-b border-white/10 px-6 py-4 flex items-center justify-between">
        <div>
          <p className="text-xs text-muted-foreground mb-0.5">
            Karhanyan School · myaiteacher
          </p>
          <h1 className="text-xl font-bold">
            Բարի գալուստ, {user?.fullName ?? "…"}
          </h1>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={logout}
            className="text-sm text-destructive hover:text-white transition-colors"
          >
            Ելք
          </button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* Tab bar */}
        <div className="flex gap-1 mb-8 border-b border-white/10 overflow-x-auto">
          {(["classes", "schedule", "profile"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`px-5 py-2.5 text-sm font-semibold tracking-widest whitespace-nowrap border-b-2 -mb-px transition-colors ${
                activeTab === t
                  ? "border-primary text-white"
                  : "border-transparent text-muted-foreground hover:text-white"
              }`}
            >
              {t === "classes"
                ? "Իմ դասարանները"
                : t === "schedule"
                  ? "Իմ Դասացուցակը"
                  : "Անձնական տվյալներ"}
            </button>
          ))}
        </div>

        {/* ── CLASSES TAB ── */}
        {activeTab === "classes" && (
          <div>
            {classes.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <div className="text-5xl mb-4">📚</div>
                <p className="text-sm">Դասարանի ադմինի կողմից նշանակված չի</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {classes.map((c) => (
                  <div
                    key={c.id}
                    className="bg-card/60 border border-white/10 rounded-2xl p-6 flex flex-col gap-4 hover:border-white/20 hover:bg-card/80 transition-all"
                  >
                    <div className="text-4xl">📚</div>
                    <div className="flex-1">
                      <div className="font-bold text-xl mb-1">{c.name}</div>
                      {c.grade && (
                        <div className="text-sm text-muted-foreground mb-2">
                          {c.grade}
                        </div>
                      )}
                      <div className="text-xs text-muted-foreground">
                        👨‍🎓 {(c as any).studentCount ?? 0} Աշակերտ
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        setSelectedClass({
                          id: c.id,
                          name: c.name,
                          grade: c.grade,
                        });
                        setClassTab("subjects");
                        setMainView("class");
                      }}
                      className="w-full py-2.5 rounded-xl bg-primary/20 border border-primary/30 text-primary text-sm font-bold tracking-widest hover:bg-primary/30 transition-colors"
                    >
                      ԴԻՏԵԼ
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── SCHEDULE TAB ── */}
        {activeTab === "schedule" && (
          <div>
            {schedule.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <div className="text-5xl mb-4">📅</div>
                <p className="text-sm">Դասացուցակ չկա</p>
              </div>
            ) : (
              <div className="bg-card/40 border border-white/10 rounded-2xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs border-collapse">
                    <thead>
                      <tr className="bg-white/5 border-b border-white/10">
                        <th className="text-left px-4 py-3 text-muted-foreground font-medium min-w-[130px]">
                          Or
                        </th>
                        {sortedTeacherClasses.map((c) => (
                          <th
                            key={c.id}
                            className="text-left px-3 py-3 text-muted-foreground font-medium min-w-[140px] border-l border-white/5"
                          >
                            {c.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {SCHOOL_DAYS_HY.map((day, di) => (
                        <tr
                          key={day}
                          className={`border-b border-white/5 ${di % 2 === 0 ? "" : "bg-white/[0.02]"}`}
                        >
                          <td className="px-4 py-3 font-medium text-white/80 align-top whitespace-nowrap">
                            {day}
                          </td>
                          {sortedTeacherClasses.map((c) => {
                            const entries = schedule
                              .filter(
                                (s) => s.day === day && s.classId === c.id,
                              )
                              .sort((a, b) =>
                                ((a as any).startTime || a.time).localeCompare(
                                  (b as any).startTime || b.time,
                                ),
                              );
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
                                        className="flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-[#14B8A6]/10 border border-[#14B8A6]/20"
                                      >
                                        <span className="text-white/85 truncate font-medium">
                                          {e.subject}
                                        </span>
                                        <span className="text-[#14B8A6] font-mono text-[10px] shrink-0">
                                          {(e as any).startTime &&
                                          (e as any).endTime
                                            ? `${(e as any).startTime}–${(e as any).endTime}`
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
        )}

        {/* ── PROFILE TAB ── */}
        {activeTab === "profile" && (
          <div className="max-w-xl">
            {!teacherProfile ? (
              <div className="text-center py-16 text-muted-foreground">
                <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                <p className="text-sm">Բարևում է...</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="bg-card/60 border border-white/10 rounded-2xl p-6 space-y-5">
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 rounded-2xl bg-primary/20 border border-primary/30 flex items-center justify-center text-3xl">
                      👨‍🏫
                    </div>
                    <div>
                      <h2 className="text-xl font-bold">
                        {teacherProfile.fullName}
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        @{teacherProfile.username}
                      </p>
                    </div>
                  </div>

                  <div className="divide-y divide-white/5">
                    {[
                      {
                        labelKey: "Դպրոց",
                        value: teacherProfile.school || "—",
                      },
                      {
                        labelKey: "Մեյլ",
                        value: teacherProfile.email ?? "—",
                      },
                    ].map(({ labelKey, value }) => (
                      <div
                        key={labelKey}
                        className="py-3 flex justify-between items-center gap-4"
                      >
                        <span className="text-sm text-muted-foreground">
                          {labelKey}
                        </span>
                        <span className="text-sm font-medium text-right">
                          {value}
                        </span>
                      </div>
                    ))}
                    <div className="py-3">
                      <span className="text-sm text-muted-foreground block mb-2">
                        Առարկաներ
                      </span>
                      {teacherProfile.subjects &&
                      teacherProfile.subjects.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {teacherProfile.subjects.map((s: string) => (
                            <span
                              key={s}
                              className="px-3 py-1 rounded-full bg-primary/20 border border-primary/30 text-primary text-xs font-medium"
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-sm text-white/40">
                          Առարկաներ չկա
                        </span>
                      )}
                    </div>
                    <div className="py-3 flex justify-between items-center gap-4">
                      <span className="text-sm text-muted-foreground">
                        Գրանցվել է
                      </span>
                      <span className="text-sm font-medium">
                        {(() => {
                          const d = new Date(teacherProfile.createdAt);

                          const months = [
                            "հունվարի",
                            "փետրվարի",
                            "մարտի",
                            "ապրիլի",
                            "մայիսի",
                            "հունիսի",
                            "հուլիսի",
                            "օգոստոսի",
                            "սեպտեմբերի",
                            "հոկտեմբերի",
                            "նոյեմբերի",
                            "դեկտեմբերի",
                          ];

                          return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} թ.`;
                        })()}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
