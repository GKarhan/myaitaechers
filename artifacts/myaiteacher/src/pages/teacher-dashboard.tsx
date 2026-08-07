import { useState, useRef, useEffect, Fragment, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  useDeleteLessonNode,
  useCreateLessonNode,
  useUpdateLessonNode,
  useGetLessonExercises,
  useCreateLessonExercise,
  useUpdateLessonExercise,
  useDeleteLessonExercise,
  useMapLessonWithAI,
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
  getGetLessonExercisesQueryKey,
  useGetSubjects,
  getGetSubjectsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";

type MainView = "dashboard" | "class" | "course" | "student";
type ClassTab = "subjects" | "students";
type TeacherSection = "home" | "classes" | "quizzes" | "schedule" | "library" | "profile";

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
  form: { type: string; title: string; description: string; author?: string; file: File | null },
) {
  const fd = new FormData();
  fd.append("type", form.type);
  fd.append("title", form.title);
  fd.append("description", form.description);
  if (form.author) fd.append("author", form.author);
  if (form.file) fd.append("file", form.file);
  const token = localStorage.getItem("myaiteacher_token") ?? "";
  const res = await fetch(`/api/teacher/courses/${courseId}/resources`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!res.ok) {
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error ?? "Upload failed");
    }
    // Non-JSON (e.g. raw HTML from Multer before route handler) — extract a clean message
    const text = await res.text();
    if (text.includes("File too large") || res.status === 413) {
      throw new Error("File too large — maximum allowed size is 100 MB.");
    }
    throw new Error(`Upload failed (${res.status})`);
  }
  return res.json();
}

// ── Shared type for lesson-centric job status poll ────────────────────────────
interface LessonJobStatus {
  jobId:    number | null;
  status:   string;   // 'none' | 'pending' | 'running' | 'completed' | 'failed'
  progress: string | null;
  error:    string | null;
}

// ── Lesson Map Button sub-component ──────────────────────────────────────────
// Polls GET /lessons/:id/map-status (lesson-centric) so progress survives
// navigation-away + return without needing to store a jobId in React state.

interface ManualMapReviewItem {
  nodeId:    number | null;
  nodeTitle: string;
  reason:    string;
}

function LessonMapButton({ lessonId, courseId, isMapped }: { lessonId: number; courseId: number; isMapped: boolean }) {
  const qc = useQueryClient();
  const { token } = useAuth();
  const [mapError,    setMapError]    = useState<string | null>(null);
  const [postPending, setPostPending] = useState(false);
  const mapLesson = useMapLessonWithAI();

  // ── Manual-map dialog state ───────────────────────────────────────────────
  const [manualOpen,       setManualOpen]       = useState(false);
  const [manualText,       setManualText]       = useState("");
  const [manualPending,    setManualPending]    = useState(false);
  const [manualError,      setManualError]      = useState<string | null>(null);
  const [manualReview,     setManualReview]     = useState<ManualMapReviewItem[]>([]);

  const handleManualMap = useCallback(async () => {
    if (!manualText.trim() || manualPending) return;
    setManualPending(true);
    setManualError(null);
    try {
      const r = await fetch(`/api/lessons/${lessonId}/manual-map`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token ?? ""}`,
        },
        body: JSON.stringify({ rawText: manualText }),
      });
      const data = await r.json();
      if (!r.ok) {
        setManualError(data?.error ?? "AI-ի պատասխանը թերի կամ սխալ ձևաչափով է։ Փորձիր կրկին կամ ուղարկիր ավելի քիչ էջ։");
        return;
      }
      // Success: invalidate the same caches as auto-map, close modal
      await Promise.all([
        qc.invalidateQueries({ queryKey: getGetLessonNodesQueryKey(lessonId) }),
        qc.invalidateQueries({ queryKey: getGetCourseLessonsQueryKey(courseId) }),
        qc.invalidateQueries({ queryKey: ['lesson-topics', lessonId] }),
        qc.invalidateQueries({ queryKey: getGetLessonExercisesQueryKey(lessonId) }),
      ]);
      const items: ManualMapReviewItem[] = data?.quality?.reviewItems ?? [];
      setManualReview(items);
      if (items.length === 0) {
        setManualOpen(false);
        setManualText("");
      }
      // If there are review items, keep dialog open so teacher sees them,
      // then they close it manually.
    } catch {
      setManualError("AI-ի պատասխանը թերի կամ սխալ ձևաչափով է։ Փորձիր կրկին կամ ուղարկիր ավելի քիչ էջ։");
    } finally {
      setManualPending(false);
    }
  }, [manualText, manualPending, lessonId, courseId, token, qc]);

  const { data: mapStatus } = useQuery<LessonJobStatus>({
    queryKey: ['lesson-map-status', lessonId],
    queryFn: async () => {
      const r = await fetch(`/api/lessons/${lessonId}/map-status`, {
        headers: { Authorization: `Bearer ${token ?? ''}` },
      });
      if (!r.ok) return { jobId: null, status: 'none', progress: null, error: null };
      return r.json();
    },
    enabled: !!token,
    staleTime: 0,
    refetchInterval: (query) => {
      const s = (query.state.data as LessonJobStatus | undefined)?.status;
      return (s === 'pending' || s === 'running') ? 3000 : false;
    },
  });

  const prevMapStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!mapStatus || mapStatus.status === prevMapStatus.current) return;
    prevMapStatus.current = mapStatus.status;
    if (mapStatus.status === 'completed') {
      setPostPending(false);
      qc.invalidateQueries({ queryKey: getGetLessonNodesQueryKey(lessonId) });
      qc.invalidateQueries({ queryKey: getGetCourseLessonsQueryKey(courseId) });
      qc.invalidateQueries({ queryKey: ['lesson-topics', lessonId] });
      qc.invalidateQueries({ queryKey: getGetLessonExercisesQueryKey(lessonId) });
    } else if (mapStatus.status === 'failed') {
      setPostPending(false);
      setMapError(mapStatus.error ?? 'Qartezagrume djaxolvets, pkhorel krnkin');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapStatus?.status]);

  const handleMap = () => {
    setMapError(null);
    setPostPending(true);
    mapLesson.mutate(
      { lessonId },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: ['lesson-map-status', lessonId] });
        },
        onError: (err: unknown) => {
          setPostPending(false);
          const responseData = (err as { response?: { data?: { error?: string } } })?.response?.data;
          setMapError(responseData?.error ?? 'Qartezagrume djaxolvets, pkhorel krnkin');
        },
      },
    );
  };

  const isActive = postPending || mapLesson.isPending
    || mapStatus?.status === 'pending' || mapStatus?.status === 'running';

  const statusLabel = mapStatus?.progress
    ?? (mapStatus?.status === 'running'  ? 'Քartezeagrvm է...'
      : mapStatus?.status === 'pending' ? 'Spasuma...' : '');

  return (
    <>
      {/* ── Ավtomatie mapping button ─────────────────────────────────── */}
      <button
        onClick={handleMap}
        disabled={isActive}
        className="px-2 py-1 rounded-lg text-xs text-muted-foreground hover:text-white border border-transparent hover:border-white/10 transition-colors disabled:opacity-50 flex items-center gap-1"
      >
        {isActive ? (
          <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
        ) : (
          '🗺️ Ավտոմատ'
        )}
      </button>

      {/* ── Ձεqrqwy քartezeagrvm button ──────────────────────────────── */}
      <button
        onClick={() => { setManualOpen(true); setManualError(null); setManualReview([]); }}
        disabled={isActive}
        className="px-2 py-1 rounded-lg text-xs text-muted-foreground hover:text-white border border-transparent hover:border-white/10 transition-colors disabled:opacity-50 flex items-center gap-1"
        title="Ձեռքով քարտեզագրում — ChatGPT / Gemini"
      >
        ✍️ Ձեռքով
      </button>

      {isActive && (
        <span className="text-[10px] text-primary/70 animate-pulse max-w-[200px] truncate" title={statusLabel}>
          {statusLabel || 'Քartezeagrvm է...'}
        </span>
      )}
      {mapError && (
        <span className="text-xs text-destructive whitespace-nowrap">{mapError}</span>
      )}

      {/* ── Manual-map Dialog ─────────────────────────────────────────── */}
      <Dialog open={manualOpen} onOpenChange={(o) => { if (!manualPending) { setManualOpen(o); if (!o) { setManualReview([]); } } }}>
        <DialogContent className="max-w-2xl bg-[#0f1117] border border-white/10 text-white">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold text-white">
              ✍️ Ձեռքով քարտեզագրում — ChatGPT / Gemini
            </DialogTitle>
          </DialogHeader>

          {/* Review items from a previous successful submit */}
          {manualReview.length > 0 && (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2 space-y-1">
              <p className="text-xs font-semibold text-amber-400">⚠️ Ուshaderoutyan kariq unenatsox keter.</p>
              {manualReview.map((ri, i) => (
                <p key={i} className="text-xs text-amber-300/80">• {ri.nodeTitle}</p>
              ))}
              <button
                onClick={() => { setManualOpen(false); setManualReview([]); }}
                className="mt-1 text-xs text-amber-400 underline hover:text-amber-300"
              >
                Կnqel
              </button>
            </div>
          )}

          {manualError && (
            <p className="text-xs text-destructive bg-destructive/10 rounded px-3 py-2">{manualError}</p>
          )}

          <textarea
            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder-muted-foreground/50 focus:outline-none focus:border-primary/50 resize-none"
            rows={15}
            placeholder="Փaktsru AI-i (ChatGPT/Gemini)-ի ամboljy պatashkhany aystegh"
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            disabled={manualPending}
          />

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => { setManualOpen(false); setManualReview([]); }}
              disabled={manualPending}
              className="px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-white border border-white/10 hover:border-white/20 transition-colors disabled:opacity-40"
            >
              Չեղարկել
            </button>
            <button
              onClick={handleManualMap}
              disabled={manualPending || !manualText.trim()}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-primary text-black hover:bg-primary/90 transition-colors disabled:opacity-40 flex items-center gap-1.5"
            >
              {manualPending && (
                <span className="inline-block w-3 h-3 border-2 border-black border-t-transparent rounded-full animate-spin" />
              )}
              Վերլուծել
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Generate Teaching Content Button sub-component ────────────────────────────
// Polls GET /lessons/:id/generate-status (lesson-centric) with per-batch
// progress labels ("Processing 3/9 MicroNodes...") read from the job record.
function GenerateTeachingContentButton({ lessonId, hasNodes }: { lessonId: number; hasNodes: boolean }) {
  const qc = useQueryClient();
  const { token } = useAuth();
  const [genError,    setGenError]    = useState<string | null>(null);
  const [genDone,     setGenDone]     = useState(false);
  const [postPending, setPostPending] = useState(false);

  const { data: genStatus } = useQuery<LessonJobStatus>({
    queryKey: ['lesson-generate-status', lessonId],
    queryFn: async () => {
      const r = await fetch(`/api/lessons/${lessonId}/generate-status`, {
        headers: { Authorization: `Bearer ${token ?? ''}` },
      });
      if (!r.ok) return { jobId: null, status: 'none', progress: null, error: null };
      return r.json();
    },
    enabled: !!token && hasNodes,
    staleTime: 0,
    refetchInterval: (query) => {
      const s = (query.state.data as LessonJobStatus | undefined)?.status;
      return (s === 'pending' || s === 'running') ? 3000 : false;
    },
  });

  const prevGenStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!genStatus || genStatus.status === prevGenStatus.current) return;
    prevGenStatus.current = genStatus.status;
    if (genStatus.status === 'completed') {
      setPostPending(false);
      setGenDone(true);
      qc.invalidateQueries({ queryKey: getGetLessonNodesQueryKey(lessonId) });
      setTimeout(() => setGenDone(false), 5000);
    } else if (genStatus.status === 'failed') {
      setPostPending(false);
      setGenError(genStatus.error ?? 'Babandakutyune djaxolvets');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genStatus?.status]);

  const handleGenerate = async () => {
    setGenError(null);
    setGenDone(false);
    setPostPending(true);
    try {
      const r = await fetch(`/api/lessons/${lessonId}/generate-teaching-content`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token ?? ''}` },
      });
      const data = await r.json();
      if (!r.ok) { setPostPending(false); setGenError(data.error ?? 'Xndiru chexavets'); return; }
      qc.invalidateQueries({ queryKey: ['lesson-generate-status', lessonId] });
    } catch {
      setPostPending(false);
      setGenError('Xmbagumutyun sxal');
    }
  };

  const isActive = postPending || genStatus?.status === 'pending' || genStatus?.status === 'running';
  const progressLabel = genStatus?.progress
    ?? (genStatus?.status === 'running'  ? 'Arabatk...'
      : genStatus?.status === 'pending' ? 'Spasuma...' : '');

  if (!hasNodes) return null;

  return (
    <>
      <button
        onClick={handleGenerate}
        disabled={isActive}
        className="px-2 py-1 rounded-lg text-xs text-muted-foreground hover:text-white border border-transparent hover:border-white/10 transition-colors disabled:opacity-50 flex items-center gap-1"
      >
        {isActive ? (
          <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
        ) : genDone ? '✅ Arvest' : '🧠 Arvest parelatstnel'}
      </button>
      {isActive && (
        <span className="text-[10px] text-indigo-400/70 animate-pulse max-w-[200px] truncate" title={progressLabel}>
          {progressLabel || 'Arabatk է...'}
        </span>
      )}
      {genError && <span className="text-xs text-destructive whitespace-nowrap">{genError}</span>}
    </>
  );
}

// ── Lesson Nodes sub-component ────────────────────────────────────────────────
function LessonNodesPanel({
  lessonId,
  coreProblem = null,
  coreIdea = null,
  textbookAuthor = null,
  textbookTitle = null,
  chapterTitle = null,
}: {
  lessonId: number;
  coreProblem?: string | null;
  coreIdea?: string | null;
  textbookAuthor?: string | null;
  textbookTitle?: string | null;
  chapterTitle?: string | null;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  // Node edit/add state
  const [editingNodeId, setEditingNodeId] = useState<number | null>(null);
  const [editNodeForm, setEditNodeForm] = useState<{
    title: string; theoryContent: string; verbatimTheoryAnchor: string;
    commonMisconception: string; targetBloomLevel: string; estimatedMinutes: string;
  } | null>(null);
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [addNodeForm, setAddNodeForm] = useState({ title: "", theoryContent: "", targetBloomLevel: "1" });

  // Exercise edit/add state
  const [editingExerciseId, setEditingExerciseId] = useState<number | null>(null);
  const [editExForm, setEditExForm] = useState<{
    exerciseTextVerbatim: string; successCriteria: string;
    difficultyLevel: string; assignment: string;
  } | null>(null);
  const [addExForNodeId, setAddExForNodeId] = useState<number | null>(null);
  const [addExForm, setAddExForm] = useState({
    exerciseTextVerbatim: "", successCriteria: "", difficultyLevel: "MEDIUM", assignment: "CLASS",
  });

  const { data: nodes = [], isFetching: nodesFetching } = useGetLessonNodes(lessonId, {
    query: { enabled: open, queryKey: getGetLessonNodesQueryKey(lessonId) },
  });
  const { data: exercises = [], isFetching: exFetching } = useGetLessonExercises(lessonId, {
    query: { enabled: open, queryKey: getGetLessonExercisesQueryKey(lessonId) },
  });

  const deleteNode = useDeleteLessonNode();
  const createNode = useCreateLessonNode();
  const updateNode = useUpdateLessonNode();
  const createEx = useCreateLessonExercise();
  const updateEx = useUpdateLessonExercise();
  const deleteEx = useDeleteLessonExercise();

  const refreshNodes = () => qc.invalidateQueries({ queryKey: getGetLessonNodesQueryKey(lessonId) });
  const refreshEx = () => qc.invalidateQueries({ queryKey: getGetLessonExercisesQueryKey(lessonId) });

  const startEditNode = (n: (typeof nodes)[0]) => {
    setEditingNodeId(n.id);
    setEditNodeForm({
      title: n.title,
      theoryContent: n.theoryContent ?? "",
      verbatimTheoryAnchor: (n as any).verbatimTheoryAnchor ?? "",
      commonMisconception: (n as any).commonMisconception ?? "",
      targetBloomLevel: String(n.targetBloomLevel ?? 1),
      estimatedMinutes: String(n.estimatedMinutes ?? 5),
    });
  };

  const saveNode = (nodeId: number) => {
    if (!editNodeForm) return;
    updateNode.mutate(
      {
        lessonId, nodeId,
        data: {
          title: editNodeForm.title,
          theoryContent: editNodeForm.theoryContent,
          verbatimTheoryAnchor: editNodeForm.verbatimTheoryAnchor,
          commonMisconception: editNodeForm.commonMisconception,
          targetBloomLevel: parseInt(editNodeForm.targetBloomLevel) || 1,
          estimatedMinutes: parseInt(editNodeForm.estimatedMinutes) || 5,
        },
      },
      { onSuccess: () => { setEditingNodeId(null); setEditNodeForm(null); refreshNodes(); } }
    );
  };

  const startEditEx = (ex: (typeof exercises)[0]) => {
    setEditingExerciseId(ex.id);
    setEditExForm({
      exerciseTextVerbatim: ex.exerciseTextVerbatim,
      successCriteria: ex.successCriteria ?? "",
      difficultyLevel: ex.difficultyLevel ?? "MEDIUM",
      assignment: ex.assignment ?? "CLASS",
    });
  };

  const saveEx = (exId: number) => {
    if (!editExForm) return;
    updateEx.mutate(
      { lessonId, exerciseId: exId, data: { ...editExForm } },
      { onSuccess: () => { setEditingExerciseId(null); setEditExForm(null); refreshEx(); } }
    );
  };

  const isBusy = nodesFetching || exFetching;
  const { token } = useAuth();
  const [collapsedTopics, setCollapsedTopics] = useState<Set<number>>(new Set());
  const toggleTopic = (id: number) => setCollapsedTopics((prev) => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });
  const TOPIC_ACCENTS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316'];
  const { data: topics = [] } = useQuery<{ id: number; sequence: number; title: string }[]>({
    queryKey: ['lesson-topics', lessonId],
    queryFn: async () => {
      const r = await fetch(`/api/lessons/${lessonId}/topics`, {
        headers: { Authorization: `Bearer ${token ?? ''}` },
      });
      return r.ok ? r.json() : [];
    },
    enabled: open && !!token,
  });
  const fieldCls = "w-full bg-black/30 border border-white/10 rounded-lg px-2 py-1 text-xs text-white placeholder-muted-foreground/50 focus:outline-none focus:border-primary/50";
  const btnSm = "px-2 py-0.5 rounded text-xs font-medium transition-colors";

  return (
    <div className="border-t border-white/8">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-2 text-xs text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
      >
        <span className="font-medium tracking-wide">
          {(nodes.length > 0 || exercises.length > 0)
            ? `🗺️ Քարտեզագրված դաս (${nodes.length} լուկ · ${exercises.length} վարժ.)`
            : "🗺️ Քարտեզագրված դաս"}
        </span>
        <span>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3">
          {/* Textbook metadata */}
          {(textbookTitle || textbookAuthor || chapterTitle) && (
            <div className="bg-white/4 border border-white/8 rounded-lg px-3 py-2 space-y-0.5">
              {textbookTitle && (
                <p className="text-xs text-muted-foreground">
                  <span className="text-white/50">📚</span>{" "}
                  <span className="font-medium text-white/80">{textbookTitle}</span>
                  {textbookAuthor && <span className="text-muted-foreground/60"> · {textbookAuthor}</span>}
                </p>
              )}
              {chapterTitle && (
                <p className="text-xs text-muted-foreground/70">📖 {chapterTitle}</p>
              )}
            </div>
          )}

          {/* Core problem / idea */}
          {coreProblem && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-0.5">🎯 Հիմնահարց</p>
              <p className="text-xs text-white leading-relaxed">{coreProblem}</p>
            </div>
          )}
          {coreIdea && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-0.5">💡 Գլխավոր գաղափար</p>
              <p className="text-xs text-white leading-relaxed">{coreIdea}</p>
            </div>
          )}

          {isBusy && nodes.length === 0 ? (
            <p className="text-xs text-muted-foreground">Բեռնվում...</p>
          ) : nodes.length === 0 ? (
            <p className="text-xs text-muted-foreground/60">
              Node-եր դեռ չկան · օգտագործիր 🗺️ կոճակը
            </p>
          ) : (
            <div className="space-y-2">
              {nodes.map((n, nodeIdx) => {
                const nodeExercises = exercises.filter((e) => e.relatedNodeId === n.id);
                const isEditingNode = editingNodeId === n.id;
                const nTopicId = (n as any).topicId as number | null ?? null;
                const prevTopicId = nodeIdx > 0 ? ((nodes[nodeIdx - 1] as any).topicId as number | null ?? null) : ("start" as const);
                const isTopicStart = nTopicId !== prevTopicId;
                const topic = nTopicId != null ? topics.find((t) => t.id === nTopicId) : undefined;
                const tIdx = topic ? topics.indexOf(topic) : -1;
                const accent = tIdx >= 0 ? TOPIC_ACCENTS[tIdx % TOPIC_ACCENTS.length] : undefined;
                const isHidden = nTopicId != null && collapsedTopics.has(nTopicId);
                return (
                  <Fragment key={n.id}>
                    {isTopicStart && topic && (
                      <button
                        onClick={() => toggleTopic(topic.id)}
                        className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg hover:brightness-105 transition-all mt-1"
                        style={{ background: `${accent}18`, borderLeft: `3px solid ${accent}` }}
                      >
                        <span className="text-[10px] font-mono text-white/40 w-5 shrink-0">{topic.sequence}.</span>
                        <span className="text-xs font-bold text-white flex-1 text-left leading-snug">{topic.title}</span>
                        <span className="text-[10px] text-white/40 shrink-0">{nodes.filter((x) => (x as any).topicId === topic!.id).length} ՄՆ</span>
                        <span className="text-[10px] text-white/30 ml-1">{collapsedTopics.has(topic.id) ? "▶" : "▼"}</span>
                      </button>
                    )}
                  {!isHidden && (
                  <div className="bg-background/40 border border-white/8 rounded-xl overflow-hidden"
                    style={accent ? { marginLeft: "8px", borderLeft: `2px solid ${accent}35` } : {}}
                  >
                    {/* Node header row */}
                    <div className="flex items-start gap-2 px-3 py-2">
                      <span className="text-xs font-mono text-primary/60 w-5 shrink-0 pt-0.5">{n.sequence}.</span>
                      <div className="flex-1 min-w-0">
                        {isEditingNode && editNodeForm ? (
                          <div className="space-y-1.5">
                            <input
                              className={fieldCls}
                              placeholder="Վաղանակ"
                              value={editNodeForm.title}
                              onChange={(e) => setEditNodeForm((f) => f && { ...f, title: e.target.value })}
                            />
                            <textarea
                              className={fieldCls + " resize-none"}
                              rows={3}
                              placeholder="Թեորիական բովանդակություն"
                              value={editNodeForm.theoryContent}
                              onChange={(e) => setEditNodeForm((f) => f && { ...f, theoryContent: e.target.value })}
                            />
                            <textarea
                              className={fieldCls + " resize-none"}
                              rows={2}
                              placeholder="Դասագրքային մեջբերություն (առառ կap)"
                              value={editNodeForm.verbatimTheoryAnchor}
                              onChange={(e) => setEditNodeForm((f) => f && { ...f, verbatimTheoryAnchor: e.target.value })}
                            />
                            <textarea
                              className={fieldCls + " resize-none"}
                              rows={2}
                              placeholder="Տարածված սխալ"
                              value={editNodeForm.commonMisconception}
                              onChange={(e) => setEditNodeForm((f) => f && { ...f, commonMisconception: e.target.value })}
                            />
                            <div className="flex gap-2">
                              <input
                                className={fieldCls}
                                placeholder="Bloom 1-6"
                                type="number" min={1} max={6}
                                value={editNodeForm.targetBloomLevel}
                                onChange={(e) => setEditNodeForm((f) => f && { ...f, targetBloomLevel: e.target.value })}
                              />
                              <input
                                className={fieldCls}
                                placeholder="Ժամ (րոփ)"
                                type="number" min={1}
                                value={editNodeForm.estimatedMinutes}
                                onChange={(e) => setEditNodeForm((f) => f && { ...f, estimatedMinutes: e.target.value })}
                              />
                            </div>
                            <div className="flex gap-1">
                              <button
                                onClick={() => saveNode(n.id)}
                                disabled={updateNode.isPending}
                                className={btnSm + " bg-primary text-black disabled:opacity-40"}
                              >{updateNode.isPending ? "..." : "Ընthel"}</button>
                              <button
                                onClick={() => { setEditingNodeId(null); setEditNodeForm(null); }}
                                className={btnSm + " bg-white/10 text-muted-foreground"}
                              >Անcel</button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-xs font-semibold text-white">{n.title}</span>
                              {(n as any).status === 'needs_review' && (
                                <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/25 shrink-0">
                                  ⚠ Վεranajogh
                                </span>
                              )}
                              {(n as any).contentSourceType === 'manual' && (
                                <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-400 border border-violet-500/25 shrink-0">
                                  ✍ Ձεqrqwy
                                </span>
                              )}
                            </div>
                            {n.theoryContent && (
                              <p className="text-xs text-muted-foreground/80 mt-0.5 line-clamp-2 leading-relaxed">{n.theoryContent}</p>
                            )}
                            {n.targetBloomLevel != null && (
                              <span className="text-[10px] text-primary/50">Bloom {n.targetBloomLevel}</span>
                            )}
                          </>
                        )}
                      </div>
                      {!isEditingNode && (
                        <div className="flex gap-1 shrink-0 pt-0.5">
                          <button
                            onClick={() => startEditNode(n)}
                            title="Խmbagrel"
                            className="text-xs text-muted-foreground hover:text-white transition-colors"
                          >✏️</button>
                          <button
                            onClick={() => {
                              if (!confirm(`Ջنجel «${n.title}»`)) return;
                              deleteNode.mutate({ lessonId, nodeId: n.id }, { onSuccess: () => { refreshNodes(); refreshEx(); } });
                            }}
                            className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                          >🗑️</button>
                        </div>
                      )}
                    </div>

                    {/* Exercises under this node */}
                    {nodeExercises.length > 0 && (
                      <div className="border-t border-white/6 px-3 py-2 space-y-2">
                        <p className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">Վարժություններ</p>
                        {nodeExercises.map((ex) => {
                          const isEditingEx = editingExerciseId === ex.id;
                          return (
                            <div key={ex.id} className="bg-black/20 rounded-lg px-2 py-1.5">
                              {isEditingEx && editExForm ? (
                                <div className="space-y-1.5">
                                  <textarea
                                    className={fieldCls + " resize-none"}
                                    rows={3}
                                    value={editExForm.exerciseTextVerbatim}
                                    onChange={(e) => setEditExForm((f) => f && { ...f, exerciseTextVerbatim: e.target.value })}
                                  />
                                  <input
                                    className={fieldCls}
                                    placeholder="Հaghoghutyyan banalich"
                                    value={editExForm.successCriteria}
                                    onChange={(e) => setEditExForm((f) => f && { ...f, successCriteria: e.target.value })}
                                  />
                                  <div className="flex gap-2">
                                    <select
                                      className={fieldCls + " cursor-pointer"}
                                      value={editExForm.difficultyLevel}
                                      onChange={(e) => setEditExForm((f) => f && { ...f, difficultyLevel: e.target.value })}
                                    >
                                      <option value="LOW">LOW</option>
                                      <option value="MEDIUM">MEDIUM</option>
                                      <option value="HIGH">HIGH</option>
                                    </select>
                                    <select
                                      className={fieldCls + " cursor-pointer"}
                                      value={editExForm.assignment}
                                      onChange={(e) => setEditExForm((f) => f && { ...f, assignment: e.target.value })}
                                    >
                                      <option value="CLASS">CLASS</option>
                                      <option value="HOMEWORK">HOMEWORK</option>
                                    </select>
                                  </div>
                                  <div className="flex gap-1">
                                    <button onClick={() => saveEx(ex.id)} disabled={updateEx.isPending} className={btnSm + " bg-primary text-black disabled:opacity-40"}>{updateEx.isPending ? "..." : "Enty"}</button>
                                    <button onClick={() => { setEditingExerciseId(null); setEditExForm(null); }} className={btnSm + " bg-white/10 text-muted-foreground"}>Չեղարկել</button>
                                  </div>
                                </div>
                              ) : (
                                <div className="flex items-start gap-2">
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs text-white/90 leading-relaxed">{ex.exerciseTextVerbatim}</p>
                                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                      {ex.difficultyLevel && (
                                        <span className="text-[10px] text-muted-foreground/60">{ex.difficultyLevel}</span>
                                      )}
                                      {ex.assignment && (
                                        <span className={`text-[10px] font-medium ${ex.assignment === "HOMEWORK" ? "text-amber-400/70" : "text-teal-400/70"}`}>
                                          {ex.assignment === "HOMEWORK" ? "🏠 Տնային" : "📋 Դասարանում"}
                                        </span>
                                      )}
                                      {ex.sourcePage && (
                                        <span className="text-[10px] text-muted-foreground/40"> Էջ {ex.sourcePage}</span>
                                      )}
                                    </div>
                                  </div>
                                  <div className="flex gap-1 shrink-0">
                                    <button onClick={() => startEditEx(ex)} className="text-xs text-muted-foreground hover:text-white transition-colors">✏️</button>
                                    <button
                                      onClick={() => {
                                        if (!confirm("Jnjel varjutyune?")) return;
                                        deleteEx.mutate({ lessonId, exerciseId: ex.id }, { onSuccess: refreshEx });
                                      }}
                                      className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                                    >🗑️</button>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Add exercise to this node */}
                    <div className="border-t border-white/6 px-3 py-1.5">
                      {addExForNodeId === n.id ? (
                        <div className="space-y-1.5 py-1">
                          <textarea
                            className={fieldCls + " resize-none"}
                            rows={2}
                            placeholder="Varjutyutyan bnagir *"
                            value={addExForm.exerciseTextVerbatim}
                            onChange={(e) => setAddExForm((f) => ({ ...f, exerciseTextVerbatim: e.target.value }))}
                          />
                          <div className="flex gap-2">
                            <select className={fieldCls + " cursor-pointer"} value={addExForm.difficultyLevel} onChange={(e) => setAddExForm((f) => ({ ...f, difficultyLevel: e.target.value }))}>
                              <option value="LOW">LOW</option><option value="MEDIUM">MEDIUM</option><option value="HIGH">HIGH</option>
                            </select>
                            <select className={fieldCls + " cursor-pointer"} value={addExForm.assignment} onChange={(e) => setAddExForm((f) => ({ ...f, assignment: e.target.value }))}>
                              <option value="CLASS">CLASS</option><option value="HOMEWORK">HOMEWORK</option>
                            </select>
                          </div>
                          <div className="flex gap-1">
                            <button
                              disabled={createEx.isPending || !addExForm.exerciseTextVerbatim.trim()}
                              onClick={() => {
                                createEx.mutate(
                                  { lessonId, data: { ...addExForm, relatedNodeId: n.id, difficultyLevel: addExForm.difficultyLevel as "LOW"|"MEDIUM"|"HIGH", assignment: addExForm.assignment as "CLASS"|"HOMEWORK" } },
                                  { onSuccess: () => { setAddExForNodeId(null); setAddExForm({ exerciseTextVerbatim: "", successCriteria: "", difficultyLevel: "MEDIUM", assignment: "CLASS" }); refreshEx(); } }
                                );
                              }}
                              className={btnSm + " bg-primary text-black disabled:opacity-40"}
                            >{createEx.isPending ? "..." : "+ Ավելացնել"}</button>
                            <button onClick={() => setAddExForNodeId(null)} className={btnSm + " bg-white/10 text-muted-foreground"}>Չեղարկել</button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setAddExForNodeId(n.id); setAddExForm({ exerciseTextVerbatim: "", successCriteria: "", difficultyLevel: "MEDIUM", assignment: "CLASS" }); }}
                          className="text-[11px] text-muted-foreground/50 hover:text-primary/70 transition-colors py-0.5"
                        >+ Ավելացնել վարժություն</button>
                      )}
                    </div>
                  </div>
                  )}
                  </Fragment>
                );
              })}
            </div>
          )}

          {/* Add node button/form */}
          <div className="pt-1">
            {addNodeOpen ? (
              <div className="bg-background/30 border border-white/10 rounded-xl px-3 py-2 space-y-2">
                <p className="text-xs font-semibold text-muted-foreground">Նոր հանգույց</p>
                <input
                  className={fieldCls}
                  placeholder="Վերնագիր *"
                  value={addNodeForm.title}
                  onChange={(e) => setAddNodeForm((f) => ({ ...f, title: e.target.value }))}
                />
                <textarea
                  className={fieldCls + " resize-none"}
                  rows={2}
                  placeholder="Տեսական Բովանդակություն"
                  value={addNodeForm.theoryContent}
                  onChange={(e) => setAddNodeForm((f) => ({ ...f, theoryContent: e.target.value }))}
                />
                <input
                  className={fieldCls}
                  placeholder="Bloom 1-6"
                  type="number" min={1} max={6}
                  value={addNodeForm.targetBloomLevel}
                  onChange={(e) => setAddNodeForm((f) => ({ ...f, targetBloomLevel: e.target.value }))}
                />
                <div className="flex gap-1">
                  <button
                    disabled={createNode.isPending || !addNodeForm.title.trim()}
                    onClick={() => {
                      createNode.mutate(
                        { lessonId, data: { title: addNodeForm.title.trim(), theoryContent: addNodeForm.theoryContent || undefined, targetBloomLevel: parseInt(addNodeForm.targetBloomLevel) || 1 } },
                        { onSuccess: () => { setAddNodeOpen(false); setAddNodeForm({ title: "", theoryContent: "", targetBloomLevel: "1" }); refreshNodes(); } }
                      );
                    }}
                    className={btnSm + " bg-primary text-black disabled:opacity-40"}
                  >{createNode.isPending ? "..." : "Ավելացնել"}</button>
                  <button onClick={() => setAddNodeOpen(false)} className={btnSm + " bg-white/10 text-muted-foreground"}>Չեղարկել</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddNodeOpen(true)}
                className="w-full text-xs text-muted-foreground/50 hover:text-primary/70 border border-dashed border-white/10 hover:border-primary/30 rounded-xl py-2 transition-colors"
              >+ Ավելացնել հանգույց</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
function LessonGoalOutcomesPanel({
  lessonGoal,
  lessonOutcomes,
}: {
  lessonGoal: string;
  lessonOutcomes: string[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-white/8">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-2 text-xs text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
      >
        <span className="font-medium tracking-wide">🎯 Նպատակ/Վերջնարդյունք</span>
        <span>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-2">
          <div>
            <div className="text-[11px] text-secondary/70 font-medium mb-0.5">Նպատակ</div>
            <p className="text-xs text-white">{lessonGoal}</p>
          </div>
          {lessonOutcomes.length > 0 && (
            <div>
              <div className="text-[11px] text-secondary/70 font-medium mb-0.5">Վերջնարդյունքներ</div>
              <ul className="list-disc list-inside space-y-0.5">
                {lessonOutcomes.map((o, i) => (
                  <li key={i} className="text-xs text-white">
                    {o}
                  </li>
                ))}
              </ul>
            </div>
          )}
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
  const [section, setSection] = useState<TeacherSection>("classes");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [classTab, setClassTab] = useState<ClassTab>("subjects");

  const [selectedClass, setSelectedClass] = useState<{
    id: number;
    name: string;
    grade: string;
  } | null>(null);
  const [selectedCourse, setSelectedCourse] = useState<{
    id: number;
    name: string;
    subjectId?: number | null;
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
  const { data: classCourses = [], isLoading: classCoursesLoading } = useGetClassCourses(
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

  const { data: subjectsList = [] } = useGetSubjects({
    query: { queryKey: getGetSubjectsQueryKey() },
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

  const [courseForm, setCourseForm] = useState({ name: "", description: "", subjectId: null as number | null });
  const [showCourseForm, setShowCourseForm] = useState(false);

  // ── Quiz creation state ──────────────────────────────────────────────────
  const [quizModalOpen, setQuizModalOpen]   = useState(false);
  const [quizTitle,     setQuizTitle]       = useState("");
  const [quizLessonIds, setQuizLessonIds]   = useState<number[]>([]);
  const [quizBookId,    setQuizBookId]      = useState<number | null>(null);
  const [quizCount,     setQuizCount]       = useState(10);
  const [quizMode,      setQuizMode]        = useState<"SIMPLE"|"MEDIUM"|"HARD"|"MIXED">("MIXED");
  const [quizBooks,     setQuizBooks]       = useState<{id:number;name:string}[]>([]);
  const [quizCreating,  setQuizCreating]    = useState(false);
  const [quizError,     setQuizError]       = useState<string|null>(null);

  // ── Quiz list (course view) ─────────────────────────────────────────────────
  const [courseQuizzes, setCourseQuizzes] = useState<{
    id: number; title: string; status: string;
    questionCount: number; classId: number | null; createdAt: string;
    sequenceNumber: number;
    completedCount: number; totalAssigned: number;
    averageScorePercent: number | null;
  }[]>([]);
  const [courseQuizzesLoading, setCourseQuizzesLoading] = useState(false);
  const [quizRefetchTick, setQuizRefetchTick]           = useState(0);
  const [resultsQuizId,   setResultsQuizId]             = useState<number | null>(null);
  const [resultsFrom,     setResultsFrom]               = useState<"subject" | "allQuizzes">("subject");
  const [resultsData,     setResultsData]               = useState<{
    assignmentId: number; studentId: number; studentName: string;
    status: string; totalCorrect: number | null; totalQuestions: number | null;
    scorePercent: number | null; completedAt: string | null;
  }[] | null>(null);
  const [resultsLoading,  setResultsLoading]            = useState(false);

  // ── Cross-section fetch state ────────────────────────────────────────────
  const [allQuizzes, setAllQuizzes] = useState<{
    id: number; title: string; status: string; questionCount: number;
    classId: number | null; subjectId: number | null; className: string | null;
    createdAt: string; sequenceNumber: number;
    completedCount: number; totalAssigned: number; averageScorePercent: number | null;
  }[]>([]);
  const [allQuizzesLoading, setAllQuizzesLoading] = useState(false);
  const [assignedLessons, setAssignedLessons] = useState<{
    id: number; title: string; status: string;
    courseId: number; courseName: string | null;
    classId: number | null; className: string | null;
    subjectId: number | null; createdAt: string; assignedAt: string | null;
  }[]>([]);
  const [assignedLessonsLoading, setAssignedLessonsLoading] = useState(false);
  const [books, setBooks] = useState<{
    id: number; name: string; subjectId: number | null; fileSize: number; mimeType: string; uploadedAt: string;
  }[]>([]);
  const [booksLoading, setBooksLoading] = useState(false);
  // URL-based course-view restoration after back-nav from quiz-review/result
  const [restoreClassId,   setRestoreClassId]   = useState<number | null>(null);
  const [restoreSubjectId, setRestoreSubjectId] = useState<number | null>(null);
  const [treePickerStudentId, setTreePickerStudentId] = useState<number | null>(null);

  useEffect(() => {
    if (mainView !== "course" || !selectedCourse?.subjectId) {
      setCourseQuizzes([]); return;
    }
    let cancelled = false;
    setCourseQuizzesLoading(true);
    const tok = localStorage.getItem("myaiteacher_token") ?? "";
    fetch(`/api/quizzes?subjectId=${selectedCourse.subjectId}`, {
      headers: { Authorization: `Bearer ${tok}` },
    })
      .then((r) => r.json())
      .then((data) => { if (!cancelled && Array.isArray(data)) setCourseQuizzes(data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setCourseQuizzesLoading(false); });
    return () => { cancelled = true; };
  }, [mainView, selectedCourse?.subjectId, quizRefetchTick]);

  useEffect(() => {
    if (!quizModalOpen) return;
    const tok = localStorage.getItem("myaiteacher_token") ?? "";
    fetch(`/api/books`, { headers: { Authorization: `Bearer ${tok}` } })
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setQuizBooks(data.filter((b: { subjectId?: number }) =>
            b.subjectId === selectedCourse?.subjectId || !b.subjectId
          ));
        }
      })
      .catch(() => {});
  }, [quizModalOpen, selectedCourse?.subjectId]);
  useEffect(() => {
    if (resultsQuizId === null) { setResultsData(null); return; }
    const tok = localStorage.getItem("myaiteacher_token") ?? "";
    setResultsLoading(true);
    fetch(`/api/quizzes/${resultsQuizId}/results`, {
      headers: { Authorization: `Bearer ${tok}` },
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setResultsData(data))
      .catch(() => setResultsData([]))
      .finally(() => setResultsLoading(false));
  }, [resultsQuizId]);

  // Restore course view or sidebar section from URL params (e.g. after back-nav from quiz-review/result)
  useEffect(() => {
    const qs  = window.location.search;
    const c   = qs.match(/classId=(\d+)/);
    const s   = qs.match(/subjectId=(\d+)/);
    const sec = qs.match(/[?&]section=([a-zA-Z]+)/);
    if (sec && sec[1] === "quizzes") {
      setSection("quizzes");
      window.history.replaceState({}, "", window.location.pathname);
    } else if (c && s) {
      setRestoreClassId(parseInt(c[1], 10));
      setRestoreSubjectId(parseInt(s[1], 10));
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (!restoreClassId || (classes as any[]).length === 0) return;
    const cls = (classes as any[]).find((c: any) => c.id === restoreClassId);
    if (cls) {
      setSelectedClass({ id: cls.id, name: cls.name, grade: cls.grade });
      setMainView("class");
      setClassTab("subjects");
    }
  }, [classes, restoreClassId]);

  useEffect(() => {
    if (!restoreSubjectId || classCourses.length === 0) return;
    const course = classCourses.find((c) => c.subjectId === restoreSubjectId);
    if (course) {
      setSelectedCourse(course);
      setMainView("course");
      setRestoreClassId(null);
      setRestoreSubjectId(null);
    }
  }, [classCourses, restoreSubjectId]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (sidebarOpen && sidebarRef.current && !sidebarRef.current.contains(e.target as Node))
        setSidebarOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [sidebarOpen]);

  useEffect(() => {
    if (section !== "quizzes" && section !== "home") return;
    let cancelled = false;
    setAllQuizzesLoading(true);
    const tok = localStorage.getItem("myaiteacher_token") ?? "";
    fetch("/api/quizzes/all", { headers: { Authorization: `Bearer ${tok}` } })
      .then((r) => r.json())
      .then((data) => { if (!cancelled && Array.isArray(data)) setAllQuizzes(data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setAllQuizzesLoading(false); });
    return () => { cancelled = true; };
  }, [section]);

  useEffect(() => {
    if (section !== "home") return;
    let cancelled = false;
    setAssignedLessonsLoading(true);
    const tok = localStorage.getItem("myaiteacher_token") ?? "";
    fetch("/api/teacher/lessons", { headers: { Authorization: `Bearer ${tok}` } })
      .then((r) => r.json())
      .then((data) => { if (!cancelled && Array.isArray(data)) setAssignedLessons(data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setAssignedLessonsLoading(false); });
    return () => { cancelled = true; };
  }, [section]);

  useEffect(() => {
    if (section !== "library") return;
    let cancelled = false;
    setBooksLoading(true);
    const tok = localStorage.getItem("myaiteacher_token") ?? "";
    fetch("/api/books", { headers: { Authorization: `Bearer ${tok}` } })
      .then((r) => r.json())
      .then((data) => { if (!cancelled && Array.isArray(data)) setBooks(data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setBooksLoading(false); });
    return () => { cancelled = true; };
  }, [section]);

  async function handleCreateQuiz() {
    if (quizLessonIds.length === 0) return;
    setQuizCreating(true);
    setQuizError(null);
    const tok = localStorage.getItem("myaiteacher_token") ?? "";
    try {
      const resp = await fetch(`/api/quizzes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
        body: JSON.stringify({
          subjectId:      selectedCourse?.subjectId ?? undefined,
          classId:        selectedClass?.id ?? undefined,
          sourceBookId:   quizBookId ?? undefined,
          lessonIds:      quizLessonIds,
          questionCount:  quizCount,
          difficultyMode: quizMode,
          title:          quizTitle.trim() || undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error ?? "Ձախողվեց");
      setQuizModalOpen(false);
      setQuizRefetchTick((t) => t + 1);
      setLocation(`/quiz/${data.id}/review?classId=${selectedClass?.id ?? ""}&subjectId=${selectedCourse?.subjectId ?? ""}`);
    } catch (e) {
      setQuizError(e instanceof Error ? e.message : "Թեստը ստեղծել չհաջողվեց");
    } finally {
      setQuizCreating(false);
    }
  }

  function toggleLesson(lid: number) {
    setQuizLessonIds((prev) =>
      prev.includes(lid) ? prev.filter((x) => x !== lid) : [...prev, lid]
    );
  }

  const handleCreateCourse = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedClass) return;
    if (!courseForm.subjectId) { setCourseError("Subject is required"); return; }
    setCourseError(null);
    createCourse.mutate(
      {
        classId: selectedClass.id,
        data: { name: courseForm.name, description: courseForm.description, subjectId: courseForm.subjectId },
      },
      {
        onSuccess: () => {
          setShowCourseForm(false);
          setCourseForm({ name: "", description: "", subjectId: null });
          qc.invalidateQueries({
            queryKey: getGetClassCoursesQueryKey(selectedClass.id),
          });
        },
        onError: (err: unknown) => {
          const d = (err as { response?: { data?: { error?: string } } })?.response?.data;
          setCourseError(d?.error ?? "Course creation failed");
        },
      },
    );
  };

  const emptyResForm = {
    type: "textbook",
    title: "",
    description: "",
    author: "",
    file: null as File | null,
  };
  const [resForm, setResForm] = useState(emptyResForm);
  const [showResForm, setShowResForm] = useState<string | null>(null);
  const [resUploading, setResUploading] = useState(false);
  const [resError, setResError] = useState<string | null>(null);
  const [lessonError, setLessonError] = useState<string | null>(null);
  const [courseError, setCourseError] = useState<string | null>(null);
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
    } catch (err: unknown) {
      setResError(err instanceof Error ? err.message : "Resource upload failed");
    } finally {
      setResUploading(false);
    }
  };

  const emptyLesson = {
    title: "",
    lessonNumber: "",
    pagesFrom: "",
    pagesTo: "",
    paragraphNumber: "",
    chapterTitle: "",
    textbookResourceId: "",
    lessonGoal: "",
    lessonOutcomes: "",
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
    setLessonError(null);
    createLesson.mutate(
      {
        data: {
          courseId: selectedCourse.id,
          ...(selectedCourse.subjectId != null && { subjectId: selectedCourse.subjectId }),
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
          paragraphNumber: lessonForm.paragraphNumber || undefined,
          chapterTitle: lessonForm.chapterTitle || undefined,
          textbookResourceId: lessonForm.textbookResourceId
            ? parseInt(lessonForm.textbookResourceId)
            : undefined,
          lessonGoal: lessonForm.lessonGoal.trim() || undefined,
          ...(lessonForm.lessonOutcomes.split("\n").map((s) => s.trim()).filter(Boolean).length > 0 && {
            lessonOutcomes: lessonForm.lessonOutcomes.split("\n").map((s) => s.trim()).filter(Boolean),
          }),
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
        onError: (err: unknown) => {
          const d = (err as { response?: { data?: { error?: string } } })?.response?.data;
          setLessonError(d?.error ?? "Lesson creation failed");
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
          paragraphNumber: editLesson.paragraphNumber || undefined,
          chapterTitle: editLesson.chapterTitle || undefined,
          textbookResourceId: editLesson.textbookResourceId
            ? parseInt(editLesson.textbookResourceId)
            : null,
          lessonGoal: editLesson.lessonGoal.trim() || undefined,
          ...(editLesson.lessonOutcomes.split("\n").map((s) => s.trim()).filter(Boolean).length > 0 && {
            lessonOutcomes: editLesson.lessonOutcomes.split("\n").map((s) => s.trim()).filter(Boolean),
          }),
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


  // ── MAIN DASHBOARD ───────────────────────────────────────────────────────────────────────
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

  const classData = selectedClass ? classes.find((c) => c.id === selectedClass.id) : null;
  const classSubjects: string[] = (classData as any)?.assignedSubjects ?? [];
  const classScheduleEntries = selectedClass ? schedule.filter((s) => s.classId === selectedClass.id) : [];

  const grouped = Object.fromEntries(
    RESOURCE_TYPES.map((t) => [
      t.key,
      courseResources.filter((r) => r.type === t.key),
    ]),
  );

  const TEACHER_NAV: { key: TeacherSection; emoji: string; label: string }[] = [
    { key: "home",     emoji: "🏠",    label: "Գլխավոր" },
    { key: "classes",  emoji: "🏫",  label: "Իմ դասարանները" },
    { key: "quizzes",  emoji: "📝",  label: "Իմ թեստերը" },
    { key: "schedule", emoji: "📅",     label: "Դասացուցակ" },
    { key: "library",  emoji: "📖",    label: "Գրադարան" },
    { key: "profile",  emoji: "👤",  label: "Իմ պրոֆիլը" },
  ];

  const NavBtn = ({ item }: { item: (typeof TEACHER_NAV)[0] }) => (
    <button
      onClick={() => { setSection(item.key); setMainView("dashboard"); setSidebarOpen(false); }}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all text-left ${
        section === item.key
          ? "bg-primary/20 text-primary border border-primary/20"
          : "text-muted-foreground hover:text-white hover:bg-white/5"
      }`}
    >
      <span className="text-lg leading-none shrink-0">{item.emoji}</span>
      <span>{item.label}</span>
    </button>
  );

  return (
    <div className="min-h-[100dvh] bg-background text-white flex">
      <QuickSwitch />

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
          <div className="text-xs text-muted-foreground mt-0.5 truncate">{user?.fullName}</div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {TEACHER_NAV.map((item) => (
            <NavBtn key={item.key} item={item} />
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
              {user?.fullName}
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="max-w-5xl mx-auto px-5 sm:px-8 py-8">

            {section === "home" && (
              <div className="space-y-8">
                <h1 className="text-xl font-bold">Գլխավոր</h1>

                {/* Հանձնարարված դասերը */}
                <section>
                  <h2 className="text-base font-semibold text-white/90 mb-4">📋 Հանձնարարված դասերը</h2>
                  {assignedLessonsLoading ? (
                    <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
                      <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    </div>
                  ) : assignedLessons.length === 0 ? (
                    <p className="text-sm text-muted-foreground/60 py-3">Դաս չկա</p>
                  ) : (
                    <div className="space-y-2">
                      {assignedLessons.map((ls) => {
                        const SL: Record<string,string> = { draft: "Սևagir", assigned: "Հandznararvats", active: "Ակտիվ", completed: "Avartvel" };
                        const SC: Record<string,string> = { draft: "text-muted-foreground border-white/10 bg-white/5", assigned: "text-amber-400 border-amber-400/30 bg-amber-400/10", active: "text-teal-400 border-teal-400/30 bg-teal-400/10", completed: "text-green-400 border-green-400/30 bg-green-400/10" };
                        return (
                          <div key={ls.id} className="bg-card/40 border border-white/10 rounded-xl px-4 py-3 flex items-center gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-sm truncate">{ls.title}</div>
                              <div className="text-xs text-muted-foreground mt-0.5">{ls.courseName ?? "—"}{ls.className ? ` · ${ls.className}` : ""}</div>
                            </div>
                            <span className={`text-xs px-2 py-0.5 rounded-full border ${SC[ls.status] ?? "text-muted-foreground border-white/10 bg-white/5"}`}>
                              {SL[ls.status] ?? ls.status}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                {/* Հանձնարարված թեստերը */}
                <section>
                  <h2 className="text-base font-semibold text-white/90 mb-4">📝 Հանձնարարված թեստերը</h2>
                  {allQuizzesLoading ? (
                    <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
                      <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    </div>
                  ) : allQuizzes.filter((q) => q.status !== "DRAFT").length === 0 ? (
                    <p className="text-sm text-muted-foreground/60 py-3">Ուղարկված թեստ չկա</p>
                  ) : (
                    <div className="space-y-2">
                      {allQuizzes.filter((q) => q.status !== "DRAFT").slice(0, 10).map((qz) => {
                        const SL: Record<string, string> = { GENERATED: "Պատրաստ", ASSIGNED: "Ուղարկված", CLOSED: "Փակված" };
                        const SC: Record<string, string> = { GENERATED: "text-amber-400 border-amber-400/30 bg-amber-400/10", ASSIGNED: "text-teal-400 border-teal-400/30 bg-teal-400/10", CLOSED: "text-red-400/70 border-red-400/20 bg-red-400/5" };
                        return (
                          <div key={qz.id} className="bg-card/40 border border-white/10 rounded-xl px-4 py-3 flex items-center gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-sm truncate">{qz.title}</div>
                              {qz.className && <div className="text-xs text-muted-foreground mt-0.5">{qz.className}</div>}
                            </div>
                            <span className={`text-xs px-2 py-0.5 rounded-full border ${SC[qz.status] ?? "text-muted-foreground border-white/10 bg-white/5"}`}>
                              {SL[qz.status] ?? qz.status}
                            </span>
                            {qz.totalAssigned > 0 && (
                              <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                                {qz.completedCount}/{qz.totalAssigned}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                {/* դասացուցակ */}
                <section>
                  <h2 className="text-base font-semibold text-white/90 mb-4">📅 Դասացուցակ</h2>
                  {schedule.length === 0 ? (
                    <p className="text-sm text-muted-foreground/60 py-3">Դասացուցակ դեր սահմանված չէ</p>
                  ) : (
                    <div className="bg-card/40 border border-white/10 rounded-2xl overflow-hidden">
                      <div className="overflow-x-auto">
                        <table className="min-w-full text-xs border-collapse">
                          <thead>
                            <tr className="bg-white/5 border-b border-white/10">
                              <th className="text-left px-4 py-3 text-muted-foreground font-medium min-w-[130px]">Or</th>
                              {sortedTeacherClasses.map((c) => (
                                <th key={c.id} className="text-left px-3 py-3 text-muted-foreground font-medium min-w-[140px] border-l border-white/5">{c.name}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {SCHOOL_DAYS_HY.map((day, di) => (
                              <tr key={day} className={`border-b border-white/5 ${di % 2 === 0 ? "" : "bg-white/[0.02]"}`}>
                                <td className="px-4 py-3 font-medium text-white/80 align-top whitespace-nowrap">{day}</td>
                                {sortedTeacherClasses.map((c) => {
                                  const entries = schedule
                                    .filter((s) => s.day === day && s.classId === c.id)
                                    .sort((a, b) => ((a as any).startTime || a.time).localeCompare((b as any).startTime || b.time));
                                  return (
                                    <td key={c.id} className="px-3 py-2 align-top border-l border-white/5">
                                      {entries.length === 0 ? <span className="text-white/15">—</span> : (
                                        <div className="flex flex-col gap-1">
                                          {entries.map((e) => (
                                            <div key={e.id} className="flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-[#14B8A6]/10 border border-[#14B8A6]/20">
                                              <span className="text-white/85 truncate font-medium">{e.subject}</span>
                                              <span className="text-[#14B8A6] font-mono text-[10px] shrink-0">
                                                {(e as any).startTime && (e as any).endTime
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
                </section>
              </div>
            )}

            {/* Իմ դասարանները */}
            {section === "classes" && mainView === "dashboard" && (

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
                      Դիտել
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
            )}

            {section === "classes" && mainView === "class" && selectedClass && (
                <div className="space-y-8">
                  {/* Back breadcrumb */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setMainView("dashboard")}
                      className="text-muted-foreground hover:text-white text-sm transition-colors"
                    >
                      ← Իմ դասարանները
                    </button>
                    <span className="text-muted-foreground/40">/</span>
                    <span className="font-medium text-white">{selectedClass.name}</span>
                  </div>

          {/* Ակնադրություն */}
          <div className="bg-card/60 border border-white/10 rounded-2xl p-5 flex flex-wrap items-center gap-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-primary/20 border border-primary/30 flex items-center justify-center text-2xl">🏫</div>
              <div>
                <div className="font-bold text-lg">{selectedClass.name}</div>
                {selectedClass.grade && <div className="text-xs text-muted-foreground">{selectedClass.grade}</div>}
              </div>
            </div>
            <div className="ml-auto flex items-center gap-6">
              <div className="text-center">
                <div className="text-2xl font-bold">{students.length}</div>
                <div className="text-xs text-muted-foreground">Աշակերտ</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold">{classSubjects.length}</div>
                <div className="text-xs text-muted-foreground">Առարկա</div>
              </div>
            </div>
          </div>

          {/* Առարկաներ */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-base">📖 Առարկաներ</h2>
            </div>
            {courseError && <p className="text-sm text-red-400 mb-3">{courseError}</p>}
            {classSubjects.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <div className="text-5xl mb-4">📖</div>
                <p className="text-sm">Առարկաներ դեր չկան։ Ադմինի կողմից չի նշանակվել</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {classSubjects.map((subject) => {
                  const entries = classScheduleEntries.filter((s) => s.subject === subject);
                  return (
                    <div key={subject} className="bg-card/60 border border-white/10 rounded-2xl p-5 hover:border-white/20 transition-all flex flex-col gap-3">
                      <div className="text-2xl">📖</div>
                      <div className="font-semibold text-base">{subject}</div>
                      {entries.length > 0 && (
                        <div className="space-y-1.5">
                          {entries.map((e) => (
                            <div key={e.id} className="flex items-center gap-2 text-xs">
                              <span className="w-2 h-2 rounded-full bg-[#14B8A6] shrink-0" />
                              <span className="text-muted-foreground">{e.day}</span>
                              <span className="text-[#14B8A6] font-mono ml-auto">{e.time}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <button
                        onClick={() => {
                          const subjectItem = subjectsList.find((s) => s.name === subject);
                          if (!subjectItem) { setCourseError("Subject not found — please refresh"); return; }
                          const match = classCourses.find((c) => c.subjectId === subjectItem.id);
                          if (match) {
                            setCourseError(null); setSelectedCourse(match); setMainView("course");
                          } else if (!classCoursesLoading) {
                            setCourseError(null);
                            createCourse.mutate(
                              { classId: selectedClass!.id, data: { name: subject, description: "", subjectId: subjectItem.id } },
                              {
                                onSuccess: (created) => {
                                  qc.invalidateQueries({ queryKey: getGetClassCoursesQueryKey(selectedClass!.id) });
                                  setSelectedCourse(created); setMainView("course");
                                },
                                onError: (err: unknown) => {
                                  const d = (err as { response?: { data?: { error?: string } } })?.response?.data;
                                  setCourseError(d?.error ?? "Course creation failed");
                                },
                              }
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
            )}
          </section>

          {/* Ուսանողներ */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-base">👨‍🎓 Ուսանողներ ({students.length})</h2>
            </div>
            <div className="space-y-2">
              {students.length === 0 && (
                <p className="text-muted-foreground text-sm py-6 text-center">Աշակերտ Չկա</p>
              )}
              {students.map((s) => (
                <div key={s.id} className="bg-card/50 border border-white/10 rounded-xl px-4 py-3 flex items-center justify-between">
                  <div>
                    <div className="font-medium">{s.fullName}</div>
                    <div className="text-xs text-muted-foreground">{(s as any).email || s.username}</div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => { setSelectedStudentId(s.id); setMainView("student"); }} className={btnGhost}>Դիտել</button>
                    <button
                      onClick={() => setTreePickerStudentId(s.id)}
                      className={btnGhost}
                      title="Բացել գիտելիքի ծառը"
                    >
                      🌳 Գիտելիքի ծառ
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* դասացուցակ */}
          <section>
            <h2 className="font-semibold text-base mb-4">📅 Դասացուցակ</h2>
            {classScheduleEntries.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground">
                <div className="text-5xl mb-3">📅</div>
                <p className="text-sm">Դասացուցակ դեր սահմանված չէ</p>
              </div>
            ) : (
              <div className="bg-card/40 border border-white/10 rounded-2xl overflow-hidden">
                <div className="divide-y divide-white/5">
                  {classScheduleEntries
                    .slice()
                    .sort((a, b) => {
                      const DAY_ORDER = ["Երկ", "Երեք", "Չոր", "Հինգ", "Ուր"];
                      const di = (d: string) => { const i = DAY_ORDER.findIndex((x) => d.startsWith(x)); return i < 0 ? 99 : i; };
                      const dd = di(a.day) - di(b.day);
                      if (dd !== 0) return dd;
                      return ((a as any).startTime || a.time).localeCompare((b as any).startTime || b.time);
                    })
                    .map((e) => (
                      <div key={e.id} className="px-5 py-3 flex items-center gap-4">
                        <span className="text-sm text-muted-foreground w-36 shrink-0">{e.day}</span>
                        <span className="font-medium text-sm flex-1">{e.subject}</span>
                        <span className="text-[#14B8A6] font-mono text-xs shrink-0">
                          {(e as any).startTime && (e as any).endTime
                            ? `${(e as any).startTime}–${(e as any).endTime}`
                            : e.time}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </section>

                </div>
            )}

            {/* ── Course view — rendered inside sidebar layout ── */}
            {section === "classes" && mainView === "course" && selectedCourse && (
              <div className="space-y-10">
                {/* Breadcrumb */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setMainView("class")}
                    className="text-muted-foreground hover:text-white text-sm transition-colors"
                  >
                    ← {selectedClass?.name}
                  </button>
                  <span className="text-muted-foreground/40">/</span>
                  <span className="font-bold text-white">📖 {selectedCourse.name}</span>
                </div>
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
                              setShowResForm(isOpen ? null : key); setResError(null);
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
                            {resForm.type === "textbook" && (
                              <input
                                value={resForm.author}
                                onChange={(e) =>
                                  setResForm((f) => ({ ...f, author: e.target.value }))
                                }
                                className={inputCls}
                                placeholder="Հեղինակ (ըստ ցանկության)"
                              />
                            )}
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
                            {resError && (
                              <p className="text-xs text-red-400">{resError}</p>
                            )}
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
                                {(d as { author?: string | null }).author && (
                                  <span className="text-muted-foreground ml-1">{"— "}{(d as { author?: string | null }).author}</span>
                                )}
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

              {/* ── QUIZ LIST ── */}
              <section>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-base font-semibold text-white/90">
                    📝 Թեստեր ({courseQuizzes.length})
                  </h2>
                  <button
                    onClick={() => { setQuizModalOpen(true); setQuizError(null); setQuizLessonIds([]); setQuizTitle(""); }}
                    className={btnPrimary}
                  >
                    ✶ Ստեղծել թեստ
                  </button>
                </div>
                {courseQuizzesLoading ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm py-3">
                    <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : courseQuizzes.length === 0 ? (
                  <p className="text-xs text-muted-foreground/50 py-2">—</p>
                ) : (
                  <div className="space-y-2">
                    {courseQuizzes.map((qz) => {
                      const STATUS_LABEL: Record<string, string> = {
                        DRAFT:     "Ստեղծված",
                        GENERATED: "Պատրաստ",
                        ASSIGNED:  "Ուղարկված",
                        CLOSED:    "Փակված",
                      };
                      const STATUS_CLS: Record<string, string> = {
                        DRAFT:     "text-muted-foreground border-white/10 bg-white/5",
                        GENERATED: "text-amber-400 border-amber-400/30 bg-amber-400/10",
                        ASSIGNED:  "text-teal-400 border-teal-400/30 bg-teal-400/10",
                        CLOSED:    "text-red-400/70 border-red-400/20 bg-red-400/5",
                      };
                      return (
                        <div
                          key={qz.id}
                          className="flex items-center gap-3 bg-card/40 border border-white/10 rounded-xl px-4 py-3 hover:border-white/20 transition-colors"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="shrink-0 text-xs font-mono px-1.5 py-0.5 rounded bg-white/8 border border-white/12 text-white/50">
                                #{qz.sequenceNumber}
                              </span>
                              <span className="font-medium text-sm truncate">{qz.title}</span>
                            </div>
                            <div className="text-xs text-muted-foreground mt-0.5">{qz.questionCount} հարց</div>
                          </div>
                          {(qz.status === "ASSIGNED" || qz.classId === null) && (
                            <span className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_CLS[qz.status] ?? STATUS_CLS.DRAFT}`}>
                              {STATUS_LABEL[qz.status] ?? qz.status}
                            </span>
                          )}
                          {qz.totalAssigned > 0 && (
                            <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                              {qz.completedCount}/{qz.totalAssigned} ավարտել են{qz.completedCount > 0 && qz.averageScorePercent !== null && (<> · Միջին՝ {qz.averageScorePercent}%</>)}
                            </span>
                          )}
                          {qz.status !== "ASSIGNED" && qz.classId !== null && (
                            <button
                              onClick={async () => {
                                const tok = localStorage.getItem("myaiteacher_token") ?? "";
                                const r = await fetch(`/api/quizzes/${qz.id}/assign`, {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
                                  body: JSON.stringify({ classId: qz.classId }),
                                });
                                if (r.ok) {
                                  setCourseQuizzes((prev) =>
                                    prev.map((q) => q.id === qz.id ? { ...q, status: "ASSIGNED" } : q)
                                  );
                                }
                              }}
                              className="text-xs px-3 py-1.5 rounded-lg bg-amber-400/15 text-amber-400 hover:bg-amber-400/25 transition-colors border border-amber-400/20 whitespace-nowrap shrink-0"
                            >
                              Ողարկել
                            </button>
                          )}
                          <button
                            onClick={() => setLocation(`/quiz/${qz.id}/review?classId=${selectedClass?.id ?? ""}&subjectId=${selectedCourse?.subjectId ?? ""}`)}
                            className="text-xs px-3 py-1.5 rounded-lg bg-primary/15 text-primary hover:bg-primary/25 transition-colors border border-primary/20 whitespace-nowrap shrink-0"
                          >
                            Դիտել
                          </button>
                          {qz.completedCount > 0 && (
                            <button
                              onClick={() => { setResultsFrom("subject"); setResultsQuizId(qz.id); }}
                              className="text-xs px-3 py-1.5 rounded-lg bg-teal-400/15 text-teal-400 hover:bg-teal-400/25 transition-colors border border-teal-400/20 whitespace-nowrap shrink-0"
                            >
                              Արդյունքներ
                            </button>
                          )}
                          <button
                            onClick={async () => {
                              if (!confirm("ծնդլել թեստը?")) return;
                              const tok = localStorage.getItem("myaiteacher_token") ?? "";
                              const r = await fetch(`/api/quizzes/${qz.id}`, {
                                method: "DELETE",
                                headers: { Authorization: `Bearer ${tok}` },
                              });
                              if (r.ok || r.status === 204) {
                                setCourseQuizzes((prev) => prev.filter((q) => q.id !== qz.id));
                              }
                            }}
                            className={btnDanger}
                          >
                            🗑
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
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
                    {lessonError && (
                      <p className="text-xs text-red-400">{lessonError}</p>
                    )}
                    <p className="text-xs uppercase tracking-wide text-muted-foreground font-semibold pt-1">
                      Ա. ԴԱՍԱԳԻՐՔ
                    </p>
                    <div>
                      <select
                        value={lessonForm.textbookResourceId}
                        onChange={(e) =>
                          setLessonForm((f) => ({
                            ...f,
                            textbookResourceId: e.target.value,
                          }))
                        }
                        className={inputCls}
                      >
                        <option value="">— ընտրել —</option>
                        {courseResources
                          .filter((r) => r.type === "textbook")
                          .map((r) => (
                            <option key={r.id} value={String(r.id)}>
                              {r.title}
                            </option>
                          ))}
                      </select>
                      {courseResources.filter((r) => r.type === "textbook").length === 0 && (
                        <p className="text-xs text-muted-foreground/50 mt-1">
                          Դasagrk dere verbernvac ce subject-i ejum
                        </p>
                      )}
                    </div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground font-semibold pt-1">
                      Բ. Բովանդակություն
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="sm:col-span-2">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Թեմա (ըստ ցանկության)
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
                    <p className="text-xs uppercase tracking-wide text-muted-foreground font-semibold pt-1">
                      Գ. ԴԱՍԻ ՆՊԱՏԱԿ ԵՎ ՎԵՐՋՆԱՐԴՅՈՒՆՔՆԵՐ (ըստ ցանկության)
                    </p>
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Դասի նպատակի սևագիր (AI-ն կկատարելագործի սա քարտեզագրելիս)
                        </label>
                        <textarea
                          value={lessonForm.lessonGoal}
                          onChange={(e) =>
                            setLessonForm((f) => ({ ...f, lessonGoal: e.target.value }))
                          }
                          className={`${inputCls} min-h-[72px] resize-y`}
                          placeholder=""
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Վերջնարդյունքների սևագիր (մեկական տողում)
                        </label>
                        <textarea
                          value={lessonForm.lessonOutcomes}
                          onChange={(e) =>
                            setLessonForm((f) => ({ ...f, lessonOutcomes: e.target.value }))
                          }
                          className={`${inputCls} min-h-[72px] resize-y`}
                          placeholder=""
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
                      <div className="sm:col-span-2">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Դasagrkci faylr
                        </label>
                        <select
                          value={editLesson.textbookResourceId}
                          onChange={(e) =>
                            setEditLesson(
                              (l) => l && { ...l, textbookResourceId: e.target.value },
                            )
                          }
                          className={inputCls}
                        >
                          <option value="">— ընтrel —</option>
                          {courseResources
                            .filter((r) => r.type === "textbook")
                            .map((r) => (
                              <option key={r.id} value={String(r.id)}>
                                {r.title}
                              </option>
                            ))}
                        </select>
                        {courseResources.filter((r) => r.type === "textbook").length === 0 && (
                          <p className="text-xs text-muted-foreground/50 mt-1">
                            դասագիրք դևռ վևրբևռնված չև subject-ի ևիգում
                          </p>
                        )}
                      </div>
                      <div className="sm:col-span-2">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Թեմա (ըստ ցանկության)
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
                          Էջի սկիզբը
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
                          Էջի վևրիը
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
                    <p className="text-xs uppercase tracking-wide text-muted-foreground font-semibold pt-1">
                      Գ. ԴԱՍԻ ՆՊԱՏԱԿ ԵՎ ՎԵՐՋՆԱՐԴՅՈՒՆՔՆԵՐ (ըստ ցանկության)
                    </p>
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Դասի նպատակի սևագիր (AI-ն կկատարելագործի սա քարտեզագրելիս)
                        </label>
                        <textarea
                          value={editLesson.lessonGoal}
                          onChange={(e) =>
                            setEditLesson((l) => l && ({ ...l, lessonGoal: e.target.value }))
                          }
                          className={`${inputCls} min-h-[72px] resize-y`}
                          placeholder=""
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Վերջնարդյունքների սևագիր (մեկական տողում)
                        </label>
                        <textarea
                          value={editLesson.lessonOutcomes}
                          onChange={(e) =>
                            setEditLesson((l) => l && ({ ...l, lessonOutcomes: e.target.value }))
                          }
                          className={`${inputCls} min-h-[72px] resize-y`}
                          placeholder=""
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
                  // Sort globally by lessonNumber — single source of truth for render order
                  const sorted = [...courseLessons].sort((a, b) => {
                    const la =
                      ((a as any).lessonNumber ?? 9999) -
                      ((b as any).lessonNumber ?? 9999);
                    if (la !== 0) return la;
                    return ((a as any).paragraphNumber ?? "").localeCompare(
                      (b as any).paragraphNumber ?? ""
                    );
                  });

                  // Single top-to-bottom pass — no group buckets, rendering order
                  // is driven entirely by the sorted list.
                  type PassItem = {
                    tbHeader: { tbTitle: string | null; tbAuthor: string | null } | null;
                    topicHeader: string | null;
                    lesson: (typeof sorted)[0];
                    isFirstLesson: boolean;
                  };
                  let _currentTbKey: string | null = null;
                  let _currentTopic: string | null = null;
                  const passItems: PassItem[] = [];
                  for (const l of sorted) {
                    const resId = (l as any).textbookResourceId;
                    const tbKey =
                      resId != null
                        ? String(resId)
                        : ((l as any).textbookTitle as string | null) ?? "";
                    const resource =
                      resId != null
                        ? courseResources.find((r) => r.id === resId) ?? null
                        : null;
                    const tbTitle =
                      resource?.title ?? ((l as any).textbookTitle as string | null) ?? null;
                    const tbAuthor = (resource as any)?.author ?? null;
                    const ct = ((l as any).chapterTitle as string | null) ?? "";

                    let tbHeader: PassItem["tbHeader"] = null;
                    if (tbKey !== _currentTbKey) {
                      tbHeader = { tbTitle, tbAuthor };
                      _currentTbKey = tbKey;
                      _currentTopic = null; // reset topic on textbook change
                    }

                    let topicHeader: string | null = null;
                    if (ct && ct !== _currentTopic) {
                      topicHeader = ct;
                      _currentTopic = ct;
                    }

                    passItems.push({
                      tbHeader,
                      topicHeader,
                      lesson: l,
                      isFirstLesson: passItems.length === 0,
                    });
                  }

                  return (
                    <div className="space-y-2">
                      {passItems.map(({ tbHeader, topicHeader, lesson: l, isFirstLesson }, _idx) => {
                        const isCompleted = (l as any).status === "completed";
                        const isActive    = (l as any).status === "active";
                        const isMapped    = Boolean((l as any).coreIdea);
                        return (
                          <div key={l.id}>
                            {tbHeader && (
                              <div className={`${!isFirstLesson ? "mt-6 " : ""}mb-3 px-1 pb-2 border-b border-white/10`}>
                                <div className="text-xs uppercase tracking-widest text-muted-foreground font-semibold mb-0.5">
                                  ԴԱՍԱԳԻՐՔ
                                </div>
                                <div className="font-semibold text-base text-white">
                                  {tbHeader.tbTitle || "(դասագիրք նշված չի)"}
                                </div>
                                {tbHeader.tbAuthor && (
                                  <div className="text-xs text-muted-foreground mt-0.5">
                                    Հեղինակ · {tbHeader.tbAuthor}
                                  </div>
                                )}
                              </div>
                            )}
                            {topicHeader && (
                              <div className="text-xs font-semibold text-secondary/80 uppercase tracking-wide mb-2 mt-3 first:mt-0 px-1">
                                Թեմա · {topicHeader}
                              </div>
                            )}
                            <div
                              className={`rounded-xl overflow-hidden border transition-colors ${
                                isActive
                                  ? "border-primary/40 bg-primary/5"
                                  : "border-white/8 bg-background/40"
                              }`}
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
                                    {(l as any).paragraphNumber &&
                                      ((l as any).pagesFrom || (l as any).pagesTo) && (
                                      <span className="text-xs text-muted-foreground/40"> · </span>
                                    )}
                                    {((l as any).pagesFrom || (l as any).pagesTo) && (
                                      <span className="text-xs text-muted-foreground">
                                        Էջ {(l as any).pagesFrom ?? "?"}–{(l as any).pagesTo ?? "?"}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="flex flex-wrap gap-1 shrink-0 items-center justify-end">
                                  {isCompleted ? (
                                    <span className="px-2 py-1 rounded-lg text-xs text-teal-400 border border-teal-400/20 bg-teal-400/10 select-none">
                                      Ավարտված
                                    </span>
                                  ) : isActive ? (
                                    <span className="px-2 py-1 rounded-lg text-xs text-amber-400 border border-amber-400/20 bg-amber-400/10 select-none">
                                      Ընթացքի մեջ
                                    </span>
                                  ) : isMapped ? (
                                    <button
                                      onClick={() => handleStatusChange(l.id, "active")}
                                      disabled={updateStatus.isPending}
                                      className="px-2 py-1 rounded-lg text-xs bg-primary/15 text-primary hover:bg-primary/25 transition-colors border border-primary/20"
                                    >
                                      Հանձնարարել սովորողին
                                    </button>
                                  ) : (
                                    <span
                                      title="Նախ քարտևզագրիր"
                                      className="px-2 py-1 rounded-lg text-xs text-muted-foreground/40 border border-white/5 select-none cursor-default"
                                    >
                                      Հանձնարարել սովորողին
                                    </span>
                                  )}
                                  <LessonMapButton lessonId={l.id} courseId={selectedCourse!.id} isMapped={isMapped} />
                                  <GenerateTeachingContentButton lessonId={l.id} hasNodes={isMapped} />
                                  <button
                                    onClick={() => {
                                      setEditLesson({
                                        id: l.id,
                                        title: l.title,
                                        lessonNumber: String((l as any).lessonNumber ?? ""),
                                        pagesFrom: String((l as any).pagesFrom ?? ""),
                                        pagesTo: String((l as any).pagesTo ?? ""),
                                        chapterTitle: (l as any).chapterTitle ?? "",
                                        paragraphNumber: (l as any).paragraphNumber ?? "",
                                        textbookResourceId: String((l as any).textbookResourceId ?? ""),
                                        lessonGoal: (l as any).lessonGoal ?? "",
                                        lessonOutcomes: Array.isArray((l as any).lessonOutcomes)
                                          ? (l as any).lessonOutcomes.join("\n")
                                          : "",
                                      });
                                      setShowLessonForm(false);
                                    }}
                                    className={btnGhost}
                                  >
                                    ✏️
                                  </button>
                                  <button
                                    onClick={() => {
                                      if (!selectedCourse || !confirm("Ծնջել " + l.title + "?")) return;
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
                              {(l as any).lessonGoal && (
                                <LessonGoalOutcomesPanel
                                  lessonGoal={(l as any).lessonGoal}
                                  lessonOutcomes={
                                    Array.isArray((l as any).lessonOutcomes)
                                      ? (l as any).lessonOutcomes
                                      : []
                                  }
                                />
                              )}
                              <LessonNodesPanel
                                lessonId={l.id}
                                coreProblem={(l as any).coreProblem ?? null}
                                coreIdea={(l as any).coreIdea ?? null}
                                textbookAuthor={(l as any).textbookAuthor ?? null}
                                textbookTitle={(l as any).textbookTitle ?? null}
                                chapterTitle={(l as any).chapterTitle ?? null}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </section>
              </div>
            )}

            {section === "quizzes" && (
              <div>
                <h1 className="text-xl font-bold mb-6">Իմ թեստերը</h1>
                {allQuizzesLoading ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm py-6">
                    <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : allQuizzes.length === 0 ? (
                  <div className="text-center py-16 text-muted-foreground">
                    <div className="text-5xl mb-4">📝</div>
                    <p className="text-sm">Ռեստ չկա։ Ստեխզել թեստ դասերի եխում</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {allQuizzes.map((qz) => {
                      const STATUS_LABEL: Record<string, string> = { DRAFT: "Ստեխխված", GENERATED: "Պատրաստ", ASSIGNED: "Ուղարկված", CLOSED: "Փակված" };
                      const STATUS_CLS: Record<string, string> = { DRAFT: "text-muted-foreground border-white/10 bg-white/5", GENERATED: "text-amber-400 border-amber-400/30 bg-amber-400/10", ASSIGNED: "text-teal-400 border-teal-400/30 bg-teal-400/10", CLOSED: "text-red-400/70 border-red-400/20 bg-red-400/5" };
                      return (
                        <div key={qz.id} className="flex items-center gap-3 bg-card/40 border border-white/10 rounded-xl px-4 py-3 hover:border-white/20 transition-colors">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="shrink-0 text-xs font-mono px-1.5 py-0.5 rounded bg-white/8 border border-white/12 text-white/50">#{qz.sequenceNumber}</span>
                              <span className="font-medium text-sm truncate">{qz.title}</span>
                            </div>
                            <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                              <span>{qz.questionCount} հարծ</span>
                              {qz.className && <><span className="text-white/20">·</span><span>{qz.className}</span></>}
                            </div>
                          </div>
                          <span className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_CLS[qz.status] ?? STATUS_CLS.DRAFT}`}>
                            {STATUS_LABEL[qz.status] ?? qz.status}
                          </span>
                          {qz.totalAssigned > 0 && (
                            <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                              {qz.completedCount}/{qz.totalAssigned} ավարտել են{qz.completedCount > 0 && qz.averageScorePercent !== null && (<> · Միին։ {qz.averageScorePercent}%</>)}
                            </span>
                          )}
                          {qz.status !== "ASSIGNED" && qz.classId !== null && (
                            <button
                              onClick={async () => {
                                const tok = localStorage.getItem("myaiteacher_token") ?? "";
                                const r = await fetch(`/api/quizzes/${qz.id}/assign`, {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
                                  body: JSON.stringify({ classId: qz.classId }),
                                });
                                if (r.ok) setAllQuizzes((prev) => prev.map((q) => q.id === qz.id ? { ...q, status: "ASSIGNED" } : q));
                              }}
                              className="text-xs px-3 py-1.5 rounded-lg bg-amber-400/15 text-amber-400 hover:bg-amber-400/25 transition-colors border border-amber-400/20 whitespace-nowrap shrink-0"
                            >
                              Ողարկել
                            </button>
                          )}
                          <button
                            onClick={() => setLocation(`/quiz/${qz.id}/review?classId=${qz.classId ?? ""}&subjectId=${qz.subjectId ?? ""}`)}
                            className="text-xs px-3 py-1.5 rounded-lg bg-primary/15 text-primary hover:bg-primary/25 transition-colors border border-primary/20 whitespace-nowrap shrink-0"
                          >
                            Դիտել
                          </button>
                          {qz.completedCount > 0 && (
                            <button
                              onClick={() => { setResultsFrom("allQuizzes"); setResultsQuizId(qz.id); }}
                              className="text-xs px-3 py-1.5 rounded-lg bg-teal-400/15 text-teal-400 hover:bg-teal-400/25 transition-colors border border-teal-400/20 whitespace-nowrap shrink-0"
                            >
                              Արդյունքներ
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

              </div>
            )}

            {/* Դասացուցակ */}
            {section === "schedule" && (

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

            {section === "library" && (
              <div>
                <h1 className="text-xl font-bold mb-6">Գրադարան</h1>
                {booksLoading ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm py-6">
                    <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : books.length === 0 ? (
                  <div className="text-center py-16 text-muted-foreground">
                    <div className="text-5xl mb-4">📖</div>
                    <p className="text-sm">Գրադարանը դերկը չկա։ կցեկեկ գրքեր դասերի եխում</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {books.map((b) => (
                      <div key={b.id} className="flex items-center gap-3 bg-card/40 border border-white/10 rounded-xl px-4 py-3 hover:border-white/20 transition-colors">
                        <div className="text-2xl shrink-0">
                          {b.mimeType?.includes("pdf") ? "📄" : b.mimeType?.includes("word") || b.mimeType?.includes("docx") ? "📝" : "📎"}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm truncate">{b.name}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {(b.fileSize / (1024 * 1024)).toFixed(1)} MB
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                          {(() => {
                            const d = new Date(b.uploadedAt);
                            return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
                          })()}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Իմ պրոֆիլը */}
            {section === "profile" && (

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
        </main>

      {/* ── Knowledge Tree Subject Picker ── */}
      {treePickerStudentId !== null && (
        <div
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setTreePickerStudentId(null)}
        >
          <div
            className="bg-card border border-white/15 rounded-2xl w-full max-w-xs p-6 shadow-2xl space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-bold text-base mb-1">Ընտրեք առարկա</h3>
            {classSubjects.length === 0 ? (
              <p className="text-muted-foreground text-sm py-4 text-center">Առարկաներ չկան</p>
            ) : (
              classSubjects.map((subjectName) => {
                const subjectItem = subjectsList.find((s) => s.name === subjectName);
                if (!subjectItem) return null;
                return (
                  <button
                    key={subjectItem.id}
                    onClick={() => {
                      setLocation(
                        `/knowledge-tree/${subjectItem.id}?studentId=${treePickerStudentId}&classId=${selectedClass?.id ?? ""}`
                      );
                      setTreePickerStudentId(null);
                    }}
                    className="w-full py-2.5 px-4 bg-card/60 border border-white/10 hover:border-primary/40 hover:bg-primary/10 rounded-xl text-sm font-medium text-left transition-colors"
                  >
                    📖 {subjectName}
                  </button>
                );
              })
            )}
            <button
              onClick={() => setTreePickerStudentId(null)}
              className="w-full py-2 text-sm text-muted-foreground hover:text-white transition-colors"
            >
              Չեղարկել
            </button>
          </div>
        </div>
      )}

      {/* ── Results Modal ── */}
      {resultsQuizId !== null && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-background border border-white/10 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <h2 className="text-base font-semibold">Արդյունքներ</h2>
              <button onClick={() => setResultsQuizId(null)} className={btnGhost}>✕</button>
            </div>
            <div className="p-6 overflow-y-auto max-h-[60vh]">
              {resultsLoading ? (
                <div className="flex justify-center py-8">
                  <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                </div>
              ) : !resultsData || resultsData.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">—</p>
              ) : (
                <div className="space-y-2">
                  {resultsData.map((row) => (
                    <div key={row.assignmentId} className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-card/40 border border-white/8">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{row.studentName}</div>
                      </div>
                      {row.status === "COMPLETED" ? (
                        <>
                          <span className="text-xs font-semibold text-teal-400 whitespace-nowrap">
                            {row.totalCorrect}/{row.totalQuestions} ({row.scorePercent}%)
                          </span>
                          <button
                            onClick={() => {
                              const quizEntry = resultsFrom === "allQuizzes" ? allQuizzes.find((q) => q.id === resultsQuizId) : null;
                              const cId = resultsFrom === "allQuizzes" ? (quizEntry?.classId ?? "") : (selectedClass?.id ?? "");
                              const sId = resultsFrom === "allQuizzes" ? (quizEntry?.subjectId ?? "") : (selectedCourse?.subjectId ?? "");
                              setResultsQuizId(null);
                              setLocation(`/quiz/${resultsQuizId}/result?studentId=${row.studentId}&classId=${cId}&subjectId=${sId}&from=${resultsFrom}`);
                            }}
                            className="text-xs px-2.5 py-1 rounded-lg bg-primary/15 text-primary hover:bg-primary/25 transition-colors border border-primary/20 whitespace-nowrap shrink-0"
                          >
                            Դիտել
                          </button>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground/60 whitespace-nowrap">
                          դեռ չի ավարտել
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Create Quiz Modal ── */}
      {quizModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setQuizModalOpen(false); }}
        >
          <div className="bg-card border border-white/15 rounded-2xl w-full max-w-lg p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-1">Ստեղծել թեստ</h2>
            <p className="text-sm text-muted-foreground mb-6">
              AI-ն կստեղծի հարցեր ընտրված դասերի node-երից
            </p>

            {/* Title */}
            <div className="mb-4">
              <label className="block text-sm text-muted-foreground mb-1.5">
                Թեստի անվանումը (կամընտիր)
              </label>
              <input
                value={quizTitle}
                onChange={(e) => setQuizTitle(e.target.value)}
                placeholder={`Թեստ — ${selectedCourse?.name ?? ""}`}
                className="w-full bg-background/60 border border-white/15 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-primary/60"
              />
            </div>

            {/* Book select */}
            {quizBooks.length > 0 && (
              <div className="mb-4">
                <label className="block text-sm text-muted-foreground mb-1.5">
                  Դասագիրք (կամընտիր)
                </label>
                <select
                  value={quizBookId ?? ""}
                  onChange={(e) => setQuizBookId(e.target.value ? parseInt(e.target.value) : null)}
                  className="w-full bg-background/60 border border-white/15 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-primary/60"
                >
                  <option value="">— Չընտրել —</option>
                  {quizBooks.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Lesson multi-select */}
            <div className="mb-4">
              <label className="block text-sm text-muted-foreground mb-1.5">
                Դասեր (նշել մինչև 1) *
              </label>
              {courseLessons.length === 0 ? (
                <p className="text-sm text-muted-foreground/60 italic">
                  Դասացուցակում դասեր չկա
                </p>
              ) : (
                <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                  {(courseLessons as any[]).map((l) => (
                    <label
                      key={l.id}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border cursor-pointer transition-colors ${
                        quizLessonIds.includes(l.id)
                          ? "border-primary/60 bg-primary/10"
                          : "border-white/8 hover:border-white/20 hover:bg-white/5"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={quizLessonIds.includes(l.id)}
                        onChange={() => toggleLesson(l.id)}
                        className="accent-primary shrink-0"
                      />
                      <span className="text-sm text-white truncate">{l.title}</span>
                      {l.pagesFrom && (
                        <span className="text-xs text-muted-foreground shrink-0 ml-auto">
                          {l.pagesFrom}–{l.pagesTo}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Question count */}
            <div className="mb-4">
              <label className="block text-sm text-muted-foreground mb-1.5">
                Հարցերի քանակը (1–50)
              </label>
              <input
                type="number"
                min={1}
                max={50}
                value={quizCount}
                onChange={(e) => setQuizCount(Math.min(50, Math.max(1, parseInt(e.target.value) || 10)))}
                className="w-32 bg-background/60 border border-white/15 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-primary/60"
              />
            </div>

            {/* Difficulty mode */}
            <div className="mb-6">
              <label className="block text-sm text-muted-foreground mb-2">
                Դժվարության մակարդակ
              </label>
              <div className="grid grid-cols-2 gap-2">
                {([["SIMPLE","Պարզ"],["MEDIUM","Միջին"],["HARD","Բարդ"],["MIXED","Խառը"]] as const).map(([val, label]) => (
                  <label
                    key={val}
                    className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border cursor-pointer transition-colors ${
                      quizMode === val
                        ? "border-primary/60 bg-primary/10 text-white"
                        : "border-white/8 text-muted-foreground hover:border-white/20 hover:bg-white/5"
                    }`}
                  >
                    <input
                      type="radio"
                      name="quizMode"
                      value={val}
                      checked={quizMode === val}
                      onChange={() => setQuizMode(val)}
                      className="accent-primary shrink-0"
                    />
                    <span className="text-sm font-medium">{label}</span>
                  </label>
                ))}
              </div>
            </div>

            {quizError && (
              <p className="text-sm text-red-400 mb-4 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-3">
                {quizError}
              </p>
            )}

            <div className="flex gap-3">
              <button
                onClick={handleCreateQuiz}
                disabled={quizCreating || quizLessonIds.length === 0}
                className="flex-1 py-3 rounded-xl bg-gradient-to-r from-primary to-secondary text-white font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center justify-center gap-2"
              >
                {quizCreating ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    AI-ն ստեղծում է...
                  </>
                ) : (
                  "✦ Ստեղծել թեստ"
                )}
              </button>
              <button
                onClick={() => setQuizModalOpen(false)}
                disabled={quizCreating}
                className="px-5 py-3 rounded-xl border border-white/10 text-sm hover:bg-white/5 transition-colors disabled:opacity-40"
              >
                Չեղարկել
              </button>
            </div>
          </div>
        </div>
      )}


      </div>
    </div>
  );
}
