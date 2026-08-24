import { useState, useRef, useEffect, Fragment, useCallback, useMemo, type ReactNode } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { getGoalOutcomeDraftState } from "@/lib/goal-outcome-draft-state";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import QuickSwitch from "@/components/QuickSwitch";
import ManualMappingEditor from "@/components/ManualMappingEditor";
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
  useApproveAllLessonExercises,
  useMapLessonWithAI,
  useCreateLessonTopic,
  useDeleteLessonTopic,
  useReorderLessonTopics,
  useReorderLessonNodes,
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
  status:   string;   // 'none' | 'pending' | 'running' | 'completed' | 'coverage_failed' | 'failed'
  progress: string | null;
  error:    string | null;
  result?:  {
    coverageValid?: boolean;
    readyMicroNodes?: number;
    reviewRequiredMicroNodes?: number;
    unmappedReviewBlocks?: number;
    ready?: number;
    reviewRequired?: number;
    blocked?: number;
    needsReview?: number;
    blockedC1?: number;
    blockedC2?: number;
    summary?: Array<{
      nodeId: number;
      title: string;
      status: string;
      skipReason?: string;
      blockCode?: string;
    }>;
  } | null;
  currentState?: {
    total: number;
    complete: number;
    missing: number;
    retryAllowed: boolean;
  };
}

// ── Lesson Map Button sub-component ──────────────────────────────────────────
// Polls GET /lessons/:id/map-status (lesson-centric) so progress survives
// navigation-away + return without needing to store a jobId in React state.

type ExerciseInteractionType = "multiple_choice" | "true_false" | "constructed_response";

interface ExerciseAnswerFieldsProps {
  interactionType: ExerciseInteractionType | null;
  correctAnswer: string;
  inputClassName: string;
  onChange: (interactionType: ExerciseInteractionType | null, correctAnswer: string) => void;
}

function ExerciseAnswerFields({
  interactionType,
  correctAnswer,
  inputClassName,
  onChange,
}: ExerciseAnswerFieldsProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <label className="space-y-1">
        <span className="text-[10px] text-muted-foreground/60">Փոխազդեցության տեսակ</span>
        <select
          className={inputClassName + " cursor-pointer"}
          value={interactionType ?? ""}
          onChange={(e) => {
            const next = e.target.value as ExerciseInteractionType | "";
            onChange(next || null, "");
          }}
        >
          <option value="">Չնշված</option>
          <option value="multiple_choice">Բազմակի ընտրություն</option>
          <option value="true_false">Ճիշտ / սխալ</option>
          <option value="constructed_response">Բաց պատասխան</option>
        </select>
      </label>
      <label className="space-y-1">
        <span className="text-[10px] text-muted-foreground/60">Ճիշտ պատասխան</span>
        {interactionType === "true_false" ? (
          <select
            className={inputClassName + " cursor-pointer"}
            value={correctAnswer}
            onChange={(e) => onChange(interactionType, e.target.value)}
          >
            <option value="">Ընտրեք</option>
            <option value="TRUE">Ճիշտ</option>
            <option value="FALSE">Սխալ</option>
          </select>
        ) : (
          <input
            className={inputClassName}
            value={interactionType === "constructed_response" ? "" : correctAnswer}
            disabled={interactionType === null || interactionType === "constructed_response"}
            onChange={(e) => onChange(interactionType, e.target.value)}
            placeholder={
              interactionType === "multiple_choice"
                ? "A / B / C / D կամ Ա / Բ / Գ / Դ"
                : interactionType === "constructed_response"
                  ? "Բաց պատասխանի համար չի կիրառվում"
                  : "Նախ ընտրեք տեսակը"
            }
          />
        )}
      </label>
    </div>
  );
}

function emptyExerciseCreateForm() {
  return {
    exerciseTextVerbatim: "",
    successCriteria: "",
    interactionType: null as ExerciseInteractionType | null,
    correctAnswer: "",
    difficultyLevel: "MEDIUM",
    assignment: "CLASS",
  };
}

function getLessonPageRangeInputError(pagesFrom: string, pagesTo: string): string | null {
  const from = pagesFrom.trim();
  const to = pagesTo.trim();
  if (!from && !to) return null;
  const fromNumber = Number(from);
  const toNumber = Number(to);
  if (
    !Number.isInteger(fromNumber)
    || !Number.isInteger(toNumber)
    || fromNumber < 1
    || toNumber < 1
    || fromNumber > toNumber
  ) {
    return "Էջերի միջակայքը սխալ է։ Նշեք դրական ամբողջ թվեր, և սկզբի էջը չպետք է մեծ լինի ավարտի էջից։";
  }
  return null;
}

function LessonMapButton({ lessonId, courseId, isMapped }: { lessonId: number; courseId: number; isMapped: boolean }) {
  const qc = useQueryClient();
  const { token } = useAuth();
  const [mapError,    setMapError]    = useState<string | null>(null);
  const [mapSummary,  setMapSummary]  = useState<string | null>(null);
  const [postPending, setPostPending] = useState(false);
  const mapLesson = useMapLessonWithAI();

  // ── Manual visual editor state ────────────────────────────────────────────
  const [manualOpen, setManualOpen] = useState(false);

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
      const reviewCount = mapStatus.result?.reviewRequiredMicroNodes ?? 0;
      const readyCount = mapStatus.result?.readyMicroNodes ?? 0;
      const sourceBlockReviewCount = mapStatus.result?.unmappedReviewBlocks ?? 0;
      setMapSummary(
        reviewCount > 0 || sourceBlockReviewCount > 0
          ? `Քարտեզագրումը ստեղծվել է։ ${readyCount} հանգույց պատրաստ է, ${reviewCount} հանգույց և ${sourceBlockReviewCount} աղբյուրային բլոկ խորհուրդ է տրվում վերանայել։`
          : null,
      );
    } else if (mapStatus.status === 'coverage_failed') {
      // P3.1: mapping ran to completion but source coverage validation failed.
      // Nodes/exercises were persisted; refresh data so the teacher can inspect them.
      setPostPending(false);
      qc.invalidateQueries({ queryKey: getGetLessonNodesQueryKey(lessonId) });
      qc.invalidateQueries({ queryKey: getGetCourseLessonsQueryKey(courseId) });
      qc.invalidateQueries({ queryKey: ['lesson-topics', lessonId] });
      qc.invalidateQueries({ queryKey: getGetLessonExercisesQueryKey(lessonId) });
      setMapError('⚠️ Քարտեզագրումն ավարտվեց, բայց source coverage-ը թերի է — կան չծածկված blocks։ Ստուգիր Mapping Report-ը։');
    } else if (mapStatus.status === 'failed') {
      setPostPending(false);
      setMapSummary(null);
      setMapError(mapStatus.error ?? 'Qartezagrume djaxolvets, pkhorel krnkin');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapStatus?.status]);

  const handleMap = () => {
    setMapError(null);
    setMapSummary(null);
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
    ?? (mapStatus?.status === 'running'  ? 'Քարտեզագրում է...'
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
        onClick={() => setManualOpen(true)}
        disabled={isActive}
        className="px-2 py-1 rounded-lg text-xs text-muted-foreground hover:text-white border border-transparent hover:border-white/10 transition-colors disabled:opacity-50 flex items-center gap-1"
        title="Ձեռքով քարտեզագրում"
      >
        ✍️ Ձեռքով
      </button>

      {(isActive || mapError || mapSummary) && (
        <div className="basis-full min-w-0 order-last pt-1">
          {isActive && (
            <div className="min-w-0 text-[10px] text-primary/70 animate-pulse break-words" title={statusLabel}>
              {statusLabel || 'Քարտեզագրում է...'}
            </div>
          )}
          {mapError && (
            <div className="min-w-0 text-xs text-destructive whitespace-normal break-words leading-relaxed">
              {mapError}
            </div>
          )}
          {mapSummary && (
            <div className="min-w-0 text-xs text-amber-300 whitespace-normal break-words leading-relaxed">
              {mapSummary}
            </div>
          )}
        </div>
      )}

      <ManualMappingEditor
        lessonId={lessonId}
        open={manualOpen}
        onOpenChange={setManualOpen}
        onSaved={() => {
          void Promise.all([
            qc.invalidateQueries({ queryKey: getGetLessonNodesQueryKey(lessonId) }),
            qc.invalidateQueries({ queryKey: getGetCourseLessonsQueryKey(courseId) }),
            qc.invalidateQueries({ queryKey: ["lesson-topics", lessonId] }),
            qc.invalidateQueries({ queryKey: getGetLessonExercisesQueryKey(lessonId) }),
          ]);
        }}
      />
    </>
  );
}

// ── Generate Teaching Content Button sub-component ────────────────────────────
// Polls GET /lessons/:id/generate-status (lesson-centric) with per-batch
// progress labels ("Processing 3/9 MicroNodes...") read from the job record.
function GenerateTeachingContentButton({
  lessonId,
  hasNodes,
  completedCount,
  totalCount,
  hasTeachingContentForAllNodes,
  onInspectNode,
}: {
  lessonId: number;
  hasNodes: boolean;
  /** Persisted current-state count; normal generation fills only the missing nodes. */
  completedCount: number;
  totalCount: number;
  /** True when every MicroNode has all persisted Teaching Content fields. */
  hasTeachingContentForAllNodes: boolean;
  /** Opens the existing MicroNode Cognitive Path review surface for a blocked item. */
  onInspectNode: (nodeId: number) => void;
}) {
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
  const teachingContentResult = genStatus?.status === 'completed' ? genStatus.result : null;
  const teachingContentBlocks = teachingContentResult?.summary?.filter(
    (row) => row.status === 'blocked_c1' || row.status === 'blocked_c2',
  ) ?? [];

  if (!hasNodes) return null;
  if (hasTeachingContentForAllNodes) {
    return (
      <span className="text-[10px] text-white/55">
        ✓ {completedCount}/{totalCount} ստեղծված
      </span>
    );
  }
  const missingCount = Math.max(0, totalCount - completedCount);

  return (
    <>
      <button
        onClick={handleGenerate}
        disabled={isActive}
        title="Ստեղծել միայն բացակայող ուսուցման բովանդակությունը"
        className="px-2 py-1 rounded-lg text-xs text-muted-foreground hover:text-white border border-transparent hover:border-white/10 transition-colors disabled:opacity-50 flex items-center gap-1"
      >
        {isActive ? (
          <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
        ) : genDone ? '⚠ Վերանայել' : completedCount > 0 ? `✨ Լրացնել բացակայող ${missingCount}-ը` : '✨ Ստեղծել'}
      </button>
      {isActive && (
        <span className="text-[10px] text-indigo-400/70 animate-pulse max-w-[200px] truncate" title={progressLabel}>
          {progressLabel || 'Arabatk է...'}
        </span>
      )}
      {genError && <span className="text-xs text-destructive whitespace-nowrap">{genError}</span>}
      {teachingContentResult && (
        <div className="max-w-[300px] rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-[9px] leading-relaxed text-white/65">
          <span className="font-medium text-white/80">
            ✓ Պատրաստ է՝ {teachingContentResult.ready ?? 0} · ⚠ Վերանայել՝ {teachingContentResult.reviewRequired ?? teachingContentResult.needsReview ?? 0} · ⛔ Չի կարող շարունակվել՝ {teachingContentResult.blocked ?? ((teachingContentResult.blockedC1 ?? 0) + (teachingContentResult.blockedC2 ?? 0))}
          </span>
          {(teachingContentResult.blockedC1 ?? 0) + (teachingContentResult.blockedC2 ?? 0) > 0 && (
            <span className="ml-1 text-amber-300">
              · բացիր հանգույցը՝ պատճառը տեսնելու համար
            </span>
          )}
          {teachingContentBlocks.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {teachingContentBlocks.map((row) => (
                <button
                  key={`${row.nodeId}-${row.status}`}
                  onClick={() => onInspectNode(row.nodeId)}
                  title={row.skipReason}
                  className="rounded border border-amber-400/20 bg-amber-400/10 px-1.5 py-0.5 text-left text-amber-200 hover:brightness-125"
                >
                  {row.title} · ⛔ Չի կարող շարունակվել
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ── NodeViewModal — read-only complete MicroNode information ──────────────────
// 👁 Դиtел: shows all stored node data + Phase 2 enrichment + linked exercises.
// Zero DB writes. No editable inputs. No Save button.
function NodeViewModal({
  node,
  exercises,
  onClose,
  onEdit,
}: {
  node: Record<string, unknown>;
  exercises: Array<Record<string, unknown>>;
  onClose: () => void;
  onEdit?: () => void;
}) {
  const nodeExercises = exercises.filter((e) => e.relatedNodeId === node.id);

  const renderText = (label: string, value: unknown, italic?: boolean): ReactNode => {
    if (!value || (typeof value === "string" && !value.trim())) return null;
    return (
      <div className="space-y-0.5">
        <p className="text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-wider">{label}</p>
        <p className={`text-xs text-white/85 leading-relaxed whitespace-pre-line${italic ? " italic" : ""}`}>{String(value)}</p>
      </div>
    );
  };

  const renderList = (label: string, value: unknown): ReactNode => {
    let items: string[] = [];
    if (Array.isArray(value)) items = value.map(String).filter(Boolean);
    else if (typeof value === "string" && value.trim()) items = value.split("\n").filter(Boolean);
    if (items.length === 0) return null;
    return (
      <div className="space-y-0.5">
        <p className="text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-wider">{label}</p>
        <ul className="space-y-0.5">
          {items.map((item, i) => (
            <li key={i} className="text-xs text-white/80 leading-relaxed pl-2 border-l border-white/10">
              {item}
            </li>
          ))}
        </ul>
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-2 sm:p-4"
      style={{ background: "rgba(0,0,0,0.7)" }}
      onClick={onClose}
    >
      <div
        className="bg-[#0f1117] border border-white/12 rounded-2xl w-full max-w-xl max-h-[85vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-4 pt-4 pb-2 border-b border-white/8 shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-mono text-primary/60">{String(node.sequence ?? "?")}.</span>
              <span className="text-sm font-semibold text-white leading-snug">{String(node.title ?? "")}</span>
            </div>
            {node.targetBloomLevel != null && (
              <span className="text-[10px] text-primary/40 mt-0.5 inline-block">Bloom {String(node.targetBloomLevel)}</span>
            )}
          </div>
          <div className="ml-3 flex shrink-0 items-center gap-2">
            {onEdit && (
              <button
                onClick={onEdit}
                className="rounded border border-indigo-400/25 bg-indigo-400/10 px-2 py-1 text-[10px] text-indigo-200 hover:bg-indigo-400/20"
              >Խմբագրել</button>
            )}
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-white transition-colors text-lg leading-none"
              title="Փակել"
            >✕</button>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="overflow-y-auto flex-1 px-4 py-3 space-y-4">
          {/* CORE */}
          <section className="space-y-3">
            <p className="text-[9px] font-bold text-primary/50 uppercase tracking-widest">Հիմնական</p>
            {renderText("Ուuումնական նպատակ (LO)", node.learningObjective, true)}
            {renderText("Տեսական բովնադակություն", node.theoryContent)}
            {renderText("Բնօրինակ տեքստ", node.verbatimTheoryAnchor)}
            {node.sourcePage != null ? (
              <div className="space-y-0.5">
                <p className="text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-wider">Աղբյուր էջ</p>
                <p className="text-xs text-white/70">Էջ {String(node.sourcePage)}</p>
              </div>
            ) : null}
          </section>

          {/* PHASE 2 */}
          {!!(node.childFriendlyExplanation || node.basicExamples || node.commonMisconception || node.nonExamples || node.realLifeExamples) && (
            <section className="space-y-3 border-t border-white/6 pt-3">
              <p className="text-[9px] font-bold text-indigo-400/60 uppercase tracking-widest">🧠 Phase 2 — Ուսումնական բովանդակություն</p>
              {renderText("Պարզ բացատրություն", node.childFriendlyExplanation)}
              {renderList("Հիմնական օրինակներ", node.basicExamples)}
              {renderText("Տարածված սխալ պատկերացումներ", node.commonMisconception)}
              {renderList("Հակաօրինակներ", node.nonExamples)}
              {renderList("Օրինակներ իրական կյանքից", node.realLifeExamples)}
            </section>
          )}
          {!node.childFriendlyExplanation && (
            <section className="border border-indigo-500/15 rounded-lg bg-indigo-500/5 px-3 py-2">
              <p className="text-[10px] text-indigo-400/70">Ուսուցման բովանդակությունը դեռ չկա։ Այն կարող եք ստեղծել դասի Քայլ 2 գործողությամբ կամ լրացնել «Խմբագրել»-ից։</p>
            </section>
          )}

          {/* EXERCISES */}
          {nodeExercises.length > 0 && (
            <section className="space-y-2 border-t border-white/6 pt-3">
              <p className="text-[9px] font-bold text-muted-foreground/50 uppercase tracking-widest">Վարժություններ ({nodeExercises.length})</p>
              {nodeExercises.map((ex, i) => {
                const displayText = (ex.exerciseTextEdited as string | undefined)?.trim()
                  ? ex.exerciseTextEdited as string
                  : ex.exerciseTextVerbatim as string ?? "";
                return (
                  <div key={String(ex.id ?? i)} className="bg-white/4 border border-white/8 rounded-lg px-2.5 py-2 space-y-1">
                    <p className="text-xs text-white/85 leading-relaxed">{displayText}</p>
                    <div className="flex items-center gap-2 flex-wrap">
                      {ex.sourceType === "textbook"
                        ? <span className="text-[9px] text-blue-400/60">📖 Դասագրքից</span>
                        : <span className="text-[9px] text-purple-400/60">✍️ Ձեռքով</span>}
                      {ex.sourcePage != null && <span className="text-[9px] text-white/30">Էջ {String(ex.sourcePage)}</span>}
                      {ex.status === "approved"
                        ? <span className="text-[9px] text-emerald-400/60">✅</span>
                        : <span className="text-[9px] text-amber-400/50">🟡 Սևագիր</span>}
                      {ex.assignment != null ? (
                        <span className={`text-[9px] font-medium ${ex.assignment === "HOMEWORK" ? "text-amber-400/60" : "text-teal-400/60"}`}>
                          {ex.assignment === "Տnаyin" ? "🏠" : "📋"}
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </section>
          )}
        </div>

        {/* Footer — read-only close only */}
        <div className="px-4 py-3 border-t border-white/8 shrink-0">
          <button
            onClick={onClose}
            className="w-full py-1.5 rounded-lg bg-white/8 hover:bg-white/12 text-xs text-muted-foreground hover:text-white transition-colors"
          >
           Փակել
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Lesson Nodes sub-component ────────────────────────────────────────────────
// ── Sortable topic wrapper for drag-and-drop ─────────────────────────────────
function SortableTopicItem({
  id, children,
}: { id: number; children: (dragHandleProps: Record<string, unknown>) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: "relative",
    // Required by @dnd-kit PointerSensor: without this the browser claims the
    // pointer for scrolling the overflow-y:auto ancestor before DnD-kit's 8px
    // activation distance is reached, so onDragStart never fires.
    touchAction: "none",
  };
  return (
    <div ref={setNodeRef} style={style}>
      {children({ ...attributes, ...listeners })}
    </div>
  );
}

function LessonNodesPanel({
  lessonId,
  courseId,
  coreProblem = null,
  coreIdea = null,
  textbookAuthor = null,
  textbookTitle = null,
  chapterTitle = null,
  lessonDescription = null,
  authoringStatus = "draft",
  lessonClassId = null,
  lessonSubjectId = null,
  requiredSessionMinutes = null,
  onOpenResults,
}: {
  lessonId: number;
  courseId: number;
  coreProblem?: string | null;
  coreIdea?: string | null;
  textbookAuthor?: string | null;
  textbookTitle?: string | null;
  chapterTitle?: string | null;
  lessonDescription?: string | null;
  /** P1.7: lesson-level authoring status — "draft" | "approved" | "needs_review" */
  authoringStatus?: string;
  /** P1.12: class the lesson belongs to (for quiz release) */
  lessonClassId?: number | null;
  /** P1.12: subject for quiz review navigation */
  lessonSubjectId?: number | null;
  /** R4A.4: teacher-configurable required session time (minutes) */
  requiredSessionMinutes?: number | null;
  /** Open the inline results panel for a quiz (quiz ID → parent handler) */
  onOpenResults?: (quizId: number) => void;
}) {
  const qc = useQueryClient();
  const [, setLocation] = useLocation(); // P1.12: navigate to quiz review
  const [open, setOpen] = useState(false);
  const [deleteAllOpen, setDeleteAllOpen]       = useState(false);
  const [deleteAllPending, setDeleteAllPending] = useState(false);

  // Lesson description edit state
  const [descEditing, setDescEditing] = useState(false);
  const [descValue, setDescValue] = useState(lessonDescription ?? "");
  const descUpdateMutation = useUpdateTeacherLesson();

  // R4A.4: Required session time edit state
  const [rsmEditing, setRsmEditing] = useState(false);
  const [rsmValue, setRsmValue] = useState(requiredSessionMinutes != null ? String(requiredSessionMinutes) : "");
  const [rsmSaving, setRsmSaving] = useState(false);
  const [rsmError, setRsmError] = useState<string | null>(null);

  // Node edit/add state
  const [editingNodeId, setEditingNodeId] = useState<number | null>(null);
  const [editNodeForm, setEditNodeForm] = useState<{
    title: string; learningObjective: string; theoryContent: string; verbatimTheoryAnchor: string;
    commonMisconception: string; targetBloomLevel: string; estimatedMinutes: string;
    childFriendlyExplanation: string; basicExamples: string; nonExamples: string; realLifeExamples: string;
    topicId: number | null;
  } | null>(null);
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [addNodeForm, setAddNodeForm] = useState({ title: "", theoryContent: "", targetBloomLevel: "1", topicId: null as number | null, learningObjective: "" });

  // Topic add / delete state
  const [addTopicOpen, setAddTopicOpen] = useState(false);
  const [addTopicTitle, setAddTopicTitle] = useState("");
  const [deleteTopicId, setDeleteTopicId] = useState<number | null>(null);
  const [deleteTopicOpen, setDeleteTopicOpen] = useState(false);
  const [reorderSaving, setReorderSaving] = useState(false);

  // Exercise edit/add state
  const [editingExerciseId, setEditingExerciseId] = useState<number | null>(null);
  const [editExForm, setEditExForm] = useState<{
    // P1.6B: teacher edits go here; display initialized from exerciseTextEdited ?? exerciseTextVerbatim
    exerciseTextEdited: string;
    successCriteria: string;
    interactionType: ExerciseInteractionType | null;
    correctAnswer: string;
    difficultyLevel: string; assignment: string; relatedNodeId: number | null;
  } | null>(null);
  const [addExForNodeId, setAddExForNodeId] = useState<number | null>(null);
  const [addExForm, setAddExForm] = useState(emptyExerciseCreateForm);
  // Quick-move state: which exercise is showing the "→ Տեղափ." node selector
  const [movingExerciseId, setMovingExerciseId] = useState<number | null>(null);
  // Add-to-Additional state: inline form for adding a manual exercise with relatedNodeId=null
  const [addExToAdditional, setAddExToAdditional] = useState(false);
  const [addAdditionalForm, setAddAdditionalForm] = useState(emptyExerciseCreateForm);

  // POST-P1.12: Read-only node view (👁 Դител)
  const [viewingNodeData, setViewingNodeData] = useState<{
    node: Record<string, unknown>;
    exercises: Array<Record<string, unknown>>;
  } | null>(null);

  // ── Phase 2A R3: Cognitive Path ────────────────────────────────────────────
  type CogTask = { id: number; cognitiveLevelId: number; lessonExerciseId: number | null; taskProvenance: string; exercise: { exerciseId: string; exerciseTextVerbatim: string; exerciseTextEdited: string | null } | null };
  type CogLevel = { id: number; cognitiveLevel: string; sequence: number; isApplicable: boolean; isTargetCeiling: boolean; provenance: string; performanceObjective: string | null; successCriterion: string | null; minimumIndependentEvidence: number; preferredInteractionTypes: string[]; tasks: CogTask[] };
  type CogPathData = { nodeId: number; cogPathStatus: string | null; levels: CogLevel[] };
  type BulkCogPathEntry = { nodeId: number; title: string; detail?: string };
  type BulkCogPathSummary = {
    generated: BulkCogPathEntry[];
    existing: BulkCogPathEntry[];
    inProgress: BulkCogPathEntry[];
    c1Review: BulkCogPathEntry[];
    targetReview: BulkCogPathEntry[];
    validationFailed: BulkCogPathEntry[];
    failed: BulkCogPathEntry[];
  };

  const [cogPathOpen,       setCogPathOpen]       = useState<Record<number, boolean>>({});
  const [cogPathData,       setCogPathData]       = useState<Record<number, CogPathData | null>>({});
  const [cogPathLoading,    setCogPathLoading]    = useState<Record<number, boolean>>({});
  const [cogPathGenerating, setCogPathGenerating] = useState<Record<number, boolean>>({});
  const [cogPathError,      setCogPathError]      = useState<Record<number, string>>({});
  const [cogLevelEditId,    setCogLevelEditId]    = useState<number | null>(null);
  const [cogLevelEditForm,  setCogLevelEditForm]  = useState<{ performanceObjective: string; successCriterion: string; minimumIndependentEvidence: number; preferredInteractionTypes: string[] } | null>(null);
  const [cogLevelSaving,    setCogLevelSaving]    = useState(false);
  const [cogPathConfirming, setCogPathConfirming] = useState<Record<number, boolean>>({});
  const [addLevelOpen,      setAddLevelOpen]      = useState<Record<number, boolean>>({});
  const [addLevelForm,      setAddLevelForm]      = useState<Record<number, { cognitiveLevel: string; performanceObjective: string; successCriterion: string }>>({});
  const [addLevelSaving,    setAddLevelSaving]    = useState<Record<number, boolean>>({});
  const [bulkCogPathRunning, setBulkCogPathRunning] = useState(false);
  const [bulkCogPathProgress, setBulkCogPathProgress] = useState<{ current: number; total: number; title: string } | null>(null);
  const [bulkCogPathSummary, setBulkCogPathSummary] = useState<BulkCogPathSummary | null>(null);

  const COG_LEVEL_LABELS: Record<string, string> = { remember: 'Հիշել', understand: 'Հասկանալ', apply: 'Կիրառել', analyze: 'Վերլուծել', evaluate: 'Գնահատել', create: 'Ստեղծել' };
  // Canonical Bloom 2001 order for display sorting (no manual reorder).
  const CANONICAL_COG_ORDER = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];
  // Armenian teacher-facing labels for interaction types.
  const INTERACTION_LABELS: Record<string, string> = {
    multiple_choice:      'Բազմակի ընտրություն',
    multi_select:         'Բազմակի ընտրություն (մի քանի ճիշտ պատասխան)',
    true_false:           'Ճիշտ / Սխալ',
    matching:             'Համապատասխանեցում',
    classification:       'Դասակարգում',
    ordering:             'Հերթականության դասավորում',
    numeric_answer:       'Թվային պատասխան',
    short_answer:         'Կարճ պատասխան',
    constructed_response: 'Ընդարձակ պատասխան',
    problem_solving:      'Խնդրի լուծում',
  };
  const ALL_INTERACTION_TYPES = ['multiple_choice','multi_select','true_false','matching','classification','ordering','numeric_answer','short_answer','constructed_response','problem_solving'];

  const loadCogPath = async (nodeId: number) => {
    setCogPathLoading((l) => ({ ...l, [nodeId]: true }));
    setCogPathError((e) => { const n = { ...e }; delete n[nodeId]; return n; });
    try {
      const r = await fetch(`/api/lessons/${lessonId}/nodes/${nodeId}/cognitive-path`, { headers: { Authorization: `Bearer ${authToken ?? ""}` } });
      const data: CogPathData = await r.json();
      setCogPathData((d) => ({ ...d, [nodeId]: data }));
    } catch { setCogPathError((e) => ({ ...e, [nodeId]: "Կаpу sхаl" })); }
    finally { setCogPathLoading((l) => { const n = { ...l }; delete n[nodeId]; return n; }); }
  };

  const toggleCogPath = (nodeId: number) => {
    const opening = !cogPathOpen[nodeId];
    setCogPathOpen((o) => ({ ...o, [nodeId]: opening }));
    if (opening && cogPathData[nodeId] === undefined) loadCogPath(nodeId);
  };

  const startEditCogLevel = (level: CogLevel) => {
    setCogLevelEditId(level.id);
    setCogLevelEditForm({ performanceObjective: level.performanceObjective ?? '', successCriterion: level.successCriterion ?? '', minimumIndependentEvidence: level.minimumIndependentEvidence, preferredInteractionTypes: [...level.preferredInteractionTypes] });
  };

  const saveCogLevel = async (levelId: number, nodeId: number) => {
    if (!cogLevelEditForm || cogLevelSaving) return;
    setCogLevelSaving(true);
    try {
      const r = await fetch(`/api/lessons/${lessonId}/nodes/${nodeId}/cognitive-levels/${levelId}/update`, {
        method: 'POST', headers: { Authorization: `Bearer ${authToken ?? ""}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cogLevelEditForm),
      });
      if (r.ok) { setCogLevelEditId(null); setCogLevelEditForm(null); await loadCogPath(nodeId); }
      else { const d = await r.json() as { error?: string }; setCogPathError((e) => ({ ...e, [nodeId]: d.error ?? 'Save failed' })); }
    } finally { setCogLevelSaving(false); }
  };

  const setCogCeiling = async (levelId: number, nodeId: number) => {
    await fetch(`/api/lessons/${lessonId}/nodes/${nodeId}/cognitive-levels/${levelId}/update`, {
      method: 'POST', headers: { Authorization: `Bearer ${authToken ?? ""}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isTargetCeiling: true }),
    });
    await loadCogPath(nodeId);
  };

  const deleteCogLevel = async (levelId: number, nodeId: number, levelKey: string) => {
    if (!confirm(`Hetаrzhkel «${COG_LEVEL_LABELS[levelKey] ?? levelKey}» macardaky?`)) return;
    await fetch(`/api/lessons/${lessonId}/nodes/${nodeId}/cognitive-levels/${levelId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken ?? ""}` } });
    await loadCogPath(nodeId);
  };

  const linkExercise = async (cognitiveLevelId: number, lessonExerciseId: number, nodeId: number) => {
    const r = await fetch(`/api/lessons/${lessonId}/nodes/${nodeId}/cognitive-tasks`, {
      method: 'POST', headers: { Authorization: `Bearer ${authToken ?? ""}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cognitiveLevelId, lessonExerciseId }),
    });
    if (r.ok) await loadCogPath(nodeId);
  };

  const unlinkTask = async (taskId: number, nodeId: number) => {
    await fetch(`/api/lessons/${lessonId}/nodes/${nodeId}/cognitive-tasks/${taskId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken ?? ""}` } });
    await loadCogPath(nodeId);
  };

  // Phase 2A R3: confirm cognitive path
  const confirmCogPath = async (nodeId: number) => {
    if (cogPathConfirming[nodeId]) return;
    setCogPathConfirming((c) => ({ ...c, [nodeId]: true }));
    setCogPathError((e) => { const n = { ...e }; delete n[nodeId]; return n; });
    try {
      const r = await fetch(`/api/lessons/${lessonId}/nodes/${nodeId}/confirm-cognitive-path`, {
        method: 'POST', headers: { Authorization: `Bearer ${authToken ?? ""}`, 'Content-Type': 'application/json' },
      });
      const data = await r.json() as { cogPathStatus?: string; error?: string; message?: string };
      if (r.ok) {
        setCogPathData((d) => {
          const prev = d[nodeId];
          return { ...d, [nodeId]: prev ? { ...prev, cogPathStatus: 'confirmed' } : { nodeId, cogPathStatus: 'confirmed', levels: [] } };
        });
        refreshNodes(); // update the node list so lesson-level readiness reflects confirmation
      } else {
        setCogPathError((e) => ({ ...e, [nodeId]: data.message ?? data.error ?? 'Hastatumn xalech ar' }));
      }
    } catch { setCogPathError((e) => ({ ...e, [nodeId]: 'Kapi sxal' })); }
    finally { setCogPathConfirming((c) => { const n = { ...c }; delete n[nodeId]; return n; }); }
  };

  // Phase 2A R3: add a single cognitive level (teacher-authored)
  const addCogLevel = async (nodeId: number) => {
    const form = addLevelForm[nodeId];
    if (!form?.cognitiveLevel) return;
    setAddLevelSaving((s) => ({ ...s, [nodeId]: true }));
    try {
      const r = await fetch(`/api/lessons/${lessonId}/nodes/${nodeId}/cognitive-levels`, {
        method: 'POST', headers: { Authorization: `Bearer ${authToken ?? ""}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cognitiveLevel: form.cognitiveLevel, performanceObjective: form.performanceObjective || null, successCriterion: form.successCriterion || null }),
      });
      if (r.ok) {
        setAddLevelOpen((a) => ({ ...a, [nodeId]: false }));
        setAddLevelForm((f) => { const n = { ...f }; delete n[nodeId]; return n; });
        await loadCogPath(nodeId);
      } else {
        const d = await r.json() as { error?: string };
        setCogPathError((e) => ({ ...e, [nodeId]: d.error ?? 'Avel xalech ar' }));
      }
    } finally { setAddLevelSaving((s) => { const n = { ...s }; delete n[nodeId]; return n; }); }
  };

  // Phase 2A R3: reorder cognitive levels (up/down swap)
  const reorderCogLevel = async (nodeId: number, levelId: number, direction: 'up' | 'down', levels: CogLevel[]) => {
    const idx = levels.findIndex((l) => l.id === levelId);
    if (idx < 0) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= levels.length) return;
    const newLevels = [...levels];
    [newLevels[idx], newLevels[swapIdx]] = [newLevels[swapIdx], newLevels[idx]];
    await fetch(`/api/lessons/${lessonId}/nodes/${nodeId}/cognitive-levels/reorder`, {
      method: 'POST', headers: { Authorization: `Bearer ${authToken ?? ""}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedLevelIds: newLevels.map((l) => l.id) }),
    });
    await loadCogPath(nodeId);
  };

  const { token: authToken } = useAuth();

  // Phase 1.9: linked tests section — type now includes live completion stats
  // returned by the extended GET /api/lessons/:id/quizzes endpoint.
  const [linkedTests, setLinkedTests] = useState<Array<{
    id: number; title: string; status: string; quizType: string | null; questionCount: number;
    classId: number | null;
    totalAssigned: number; completedCount: number; averageScorePercent: number | null;
  }>>([]);
  const [linkedTestsLoading, setLinkedTestsLoading] = useState(false);
  const [linkedTestsOpen, setLinkedTestsOpen] = useState(false);

  useEffect(() => {
    if (!authToken) return;
    let cancelled = false;
    setLinkedTestsLoading(true);
    fetch(`/api/lessons/${lessonId}/quizzes`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then((r) => r.json())
      .then((data) => { if (!cancelled && Array.isArray(data)) setLinkedTests(data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLinkedTestsLoading(false); });
    return () => { cancelled = true; };
  }, [lessonId, authToken]);

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
  const approveAllEx = useApproveAllLessonExercises();
  const createTopicMutation = useCreateLessonTopic();
  const deleteTopicMutation = useDeleteLessonTopic();
  const reorderTopicsMutation = useReorderLessonTopics();
  const reorderNodesMutation = useReorderLessonNodes();

  const refreshNodes = () => qc.invalidateQueries({ queryKey: getGetLessonNodesQueryKey(lessonId) });
  const refreshEx = () => qc.invalidateQueries({ queryKey: getGetLessonExercisesQueryKey(lessonId) });
  const refreshTopics = () => qc.invalidateQueries({ queryKey: ["lesson-topics", lessonId] });

  // DnD sensors for topic reordering
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  // Build grouped view: nodes sorted by sequence, grouped by topicId
  const sortedNodes = useMemo(() => [...nodes].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)), [nodes]);
  const lessonIsApproved = authoringStatus === "approved";
  const hasCompleteTeachingContent = (node: (typeof nodes)[number]) => {
    const content = node as any;
    return typeof content.childFriendlyExplanation === "string" && content.childFriendlyExplanation.trim().length > 0
      && typeof content.commonMisconception === "string" && content.commonMisconception.trim().length > 0
      && Array.isArray(content.basicExamples) && content.basicExamples.length > 0
      && Array.isArray(content.nonExamples) && content.nonExamples.length > 0;
  };
  const hasGeneratedTeachingContent = hasCompleteTeachingContent;
  const cognitivePathsCreated = nodes.filter((node) =>
    ["needs_review", "confirmed"].includes((node as any).cogPathStatus),
  ).length;
  const cognitivePathsConfirmed = nodes.filter((node) =>
    (node as any).cogPathStatus === "confirmed",
  ).length;
  const teachingContentGenerated = nodes.filter(hasGeneratedTeachingContent).length;
  const teachingContentComplete = nodes.filter(hasCompleteTeachingContent).length;
  const allCognitivePathsCreated = nodes.length > 0 && cognitivePathsCreated === nodes.length;
  const allCognitivePathsConfirmed = nodes.length > 0 && cognitivePathsConfirmed === nodes.length;
  const allTeachingContentGenerated = nodes.length > 0 && teachingContentGenerated === nodes.length;
  const allTeachingContentComplete = nodes.length > 0 && teachingContentComplete === nodes.length;
  const cognitivePathsAwaitingReview = cognitivePathsCreated - cognitivePathsConfirmed;
  const cognitivePathsMissing = nodes.length - cognitivePathsCreated;
  const sourceExercises = exercises.filter((exercise) => (exercise as any).sourceType === "textbook");
  const sourceExercisesApproved = sourceExercises.every((exercise) => (exercise as any).status === "approved");
  const nodesApproved = nodes.every((node) => (node as any).status === "approved");

  const generateAllCogPaths = async () => {
    if (bulkCogPathRunning || sortedNodes.length === 0) return;

    const summary: BulkCogPathSummary = {
      generated: [],
      existing: [],
      inProgress: [],
      c1Review: [],
      targetReview: [],
      validationFailed: [],
      failed: [],
    };

    setBulkCogPathRunning(true);
    setBulkCogPathSummary(null);
    setBulkCogPathProgress({
      current: 0,
      total: sortedNodes.length,
      title: "Ճանաչողական ուղիների ստեղծում...",
    });

    try {
      const response = await fetch(`/api/lessons/${lessonId}/generate-cognitive-paths`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken ?? ""}`, "Content-Type": "application/json" },
        body: JSON.stringify({ force: false }),
      });
      const data = await response.json().catch(() => ({})) as {
        error?: string;
        result?: {
          stateLedger?: Array<{
            nodeId: number;
            title: string;
            state: string;
            reasonCode?: string;
          }>;
        };
      };
      const ledger = data.result?.stateLedger ?? [];
      for (const entry of ledger) {
        const detail = entry.reasonCode;
        if (entry.state === "GENERATED_NEEDS_REVIEW") {
          summary.generated.push({ nodeId: entry.nodeId, title: entry.title });
        } else if (["SKIPPED_CONFIRMED", "SKIPPED_TEACHER_AUTHORED", "SKIPPED_EXISTING"].includes(entry.state)) {
          summary.existing.push({
            nodeId: entry.nodeId,
            title: entry.title,
            detail: entry.state === "SKIPPED_CONFIRMED"
              ? "Հաստատված ուղին պահպանվել է"
              : "Գոյություն ունեցող ուղին պահպանվել է",
          });
        } else if (entry.state === "BLOCKED_C1_REVIEW") {
          summary.c1Review.push({ nodeId: entry.nodeId, title: entry.title, detail });
          setCogPathError((current) => ({
            ...current,
            [entry.nodeId]: detail ?? "C1 վերանայում է պահանջվում",
          }));
        } else if (entry.state === "BLOCKED_TARGET_REVIEW") {
          summary.targetReview.push({ nodeId: entry.nodeId, title: entry.title, detail });
          setCogPathError((current) => ({
            ...current,
            [entry.nodeId]: detail ?? "Թիրախային ճանաչողական պահանջը վերանայում է պահանջում",
          }));
        } else if (["PARSE_FAILURE", "VALIDATION_FAILURE"].includes(entry.state)) {
          summary.validationFailed.push({ nodeId: entry.nodeId, title: entry.title, detail });
          setCogPathError((current) => ({
            ...current,
            [entry.nodeId]: detail ?? "Ճանաչողական ուղին չի անցել վավերացումը",
          }));
        } else if (entry.state === "IN_PROGRESS") {
          summary.inProgress.push({
            nodeId: entry.nodeId,
            title: entry.title,
            detail: detail ?? "Ստեղծումն արդեն ընթացքի մեջ է",
          });
        } else {
          summary.failed.push({
            nodeId: entry.nodeId,
            title: entry.title,
            detail: detail ?? (entry.state === "IN_PROGRESS"
              ? "Ստեղծումն արդեն ընթացքի մեջ է"
              : "Ստեղծումը չի ավարտվել"),
          });
          setCogPathError((current) => ({
            ...current,
            [entry.nodeId]: detail ?? "Ճանաչողական ուղու ստեղծումը չի ավարտվել",
          }));
        }
      }

      if (!response.ok && ledger.length === 0) {
        summary.failed.push({
          nodeId: 0,
          title: "Ճանաչողական ուղիներ",
          detail: data.error ?? `Սխալ (${response.status})`,
        });
      }
      setBulkCogPathSummary(summary);
      await Promise.all(summary.generated.map((entry) => loadCogPath(entry.nodeId)));
      await refreshNodes();
    } catch {
      summary.failed.push({
        nodeId: 0,
        title: "Ճանաչողական ուղիներ",
        detail: "Կապի սխալ",
      });
      setBulkCogPathSummary(summary);
    } finally {
      setBulkCogPathRunning(false);
      setBulkCogPathProgress(null);
    }
  };

  const openCogPathFromBulkResult = (nodeId: number) => {
    setCogPathOpen((current) => ({ ...current, [nodeId]: true }));
    requestAnimationFrame(() => {
      document.getElementById(`lesson-node-${nodeId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const handleCreateTopic = () => {
    if (!addTopicTitle.trim()) return;
    createTopicMutation.mutate(
      { lessonId, data: { title: addTopicTitle.trim() } },
      { onSuccess: () => { setAddTopicOpen(false); setAddTopicTitle(""); refreshTopics(); } }
    );
  };

  const handleDeleteTopic = () => {
    if (!deleteTopicId) return;
    deleteTopicMutation.mutate(
      { lessonId, topicId: deleteTopicId },
      { onSuccess: () => { setDeleteTopicOpen(false); setDeleteTopicId(null); refreshTopics(); refreshNodes(); } }
    );
  };

  const handleTopicDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = topics.findIndex((t) => t.id === active.id);
    const newIndex = topics.findIndex((t) => t.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(topics, oldIndex, newIndex);

    // Optimistic update: immediately reflect the new order (and correct sequence numbers)
    // in the query cache so DnD-kit keeps the topic in its dropped position without snapping back.
    const prevTopics = qc.getQueryData(["lesson-topics", lessonId]);
    const optimisticTopics = reordered.map((t, i) => ({ ...t, sequence: i + 1 }));
    qc.setQueryData(["lesson-topics", lessonId], optimisticTopics);

    setReorderSaving(true);
    reorderTopicsMutation.mutate(
      { lessonId, data: { orderedTopicIds: reordered.map((t) => t.id) } },
      {
        onSettled: () => setReorderSaving(false),
        onSuccess: () => refreshTopics(), // confirm with server-normalised sequences
        onError: (err: unknown) => {
          // Roll back the optimistic update so the UI returns to the pre-drag state.
          qc.setQueryData(["lesson-topics", lessonId], prevTopics);
          console.error("Topic reorder failed:", err);
          const msg = (err as { message?: string })?.message ?? "Unknown error";
          alert(`Թեմաների վերադասավորումը ձախողվեց: ${msg}`);
        },
      }
    );
  };

  // Move a node up or down within the lesson (preserving overall order, swapping with adjacent).
  // Uses an optimistic cache update so the UI reorders immediately on click, before the API
  // round-trip completes.  On error the cache is rolled back and an alert is shown.
  const moveNode = (nodeId: number, dir: "up" | "down") => {
    const idx = sortedNodes.findIndex((n) => n.id === nodeId);
    if (idx === -1) return;
    const swapIdx = dir === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sortedNodes.length) return;

    const nodeA = sortedNodes[idx];
    const nodeB = sortedNodes[swapIdx];

    // Optimistic update: swap the two nodes' sequence values in the query cache so that
    // `sortedNodes` (sorted by sequence) immediately reflects the new order.
    const prevData = qc.getQueryData(getGetLessonNodesQueryKey(lessonId));
    qc.setQueryData(getGetLessonNodesQueryKey(lessonId), (old: unknown) => {
      if (!Array.isArray(old)) return old;
      return (old as Array<Record<string, unknown>>).map((n) => {
        if (n.id === nodeA.id) return { ...n, sequence: nodeB.sequence };
        if (n.id === nodeB.id) return { ...n, sequence: nodeA.sequence };
        return n;
      });
    });

    const newOrder = sortedNodes.map((n) => n.id);
    [newOrder[idx], newOrder[swapIdx]] = [newOrder[swapIdx], newOrder[idx]];
    reorderNodesMutation.mutate(
      { lessonId, data: { orderedNodeIds: newOrder } },
      {
        onSuccess: () => refreshNodes(), // confirm with server-normalised sequences
        onError: (err: unknown) => {
          // Roll back the optimistic update so the UI returns to the pre-click state.
          qc.setQueryData(getGetLessonNodesQueryKey(lessonId), prevData);
          console.error("Node reorder failed:", err);
          const msg = (err as { message?: string })?.message ?? "Unknown error";
          alert(`Հանգույցի վերադասավորումը ձախողվեց: ${msg}`);
        },
      }
    );
  };

  const startEditNode = (n: (typeof nodes)[0]) => {
    setEditingNodeId(n.id);
    setEditNodeForm({
      title: n.title,
      learningObjective: (n as any).learningObjective ?? "",
      theoryContent: n.theoryContent ?? "",
      verbatimTheoryAnchor: (n as any).verbatimTheoryAnchor ?? "",
      commonMisconception: (n as any).commonMisconception ?? "",
      targetBloomLevel: String(n.targetBloomLevel ?? 1),
      estimatedMinutes: String(n.estimatedMinutes ?? 5),
      childFriendlyExplanation: (n as any).childFriendlyExplanation ?? "",
      basicExamples: ((n as any).basicExamples as string[] ?? []).join("\n"),
      nonExamples: ((n as any).nonExamples as string[] ?? []).join("\n"),
      realLifeExamples: ((n as any).realLifeExamples as string[] ?? []).join("\n"),
      topicId: (n as any).topicId ?? null,
    });
  };

  const saveNode = (nodeId: number) => {
    if (!editNodeForm) return;
    updateNode.mutate(
      {
        lessonId, nodeId,
        data: {
          title: editNodeForm.title,
          learningObjective: editNodeForm.learningObjective,
          theoryContent: editNodeForm.theoryContent,
          verbatimTheoryAnchor: editNodeForm.verbatimTheoryAnchor,
          commonMisconception: editNodeForm.commonMisconception,
          targetBloomLevel: parseInt(editNodeForm.targetBloomLevel) || 1,
          estimatedMinutes: parseInt(editNodeForm.estimatedMinutes) || 5,
          childFriendlyExplanation: editNodeForm.childFriendlyExplanation,
          basicExamples: editNodeForm.basicExamples.split("\n").map(s => s.trim()).filter(Boolean),
          nonExamples: editNodeForm.nonExamples.split("\n").map(s => s.trim()).filter(Boolean),
          realLifeExamples: editNodeForm.realLifeExamples.split("\n").map(s => s.trim()).filter(Boolean),
          topicId: editNodeForm.topicId,
        },
      },
      { onSuccess: () => { setEditingNodeId(null); setEditNodeForm(null); refreshNodes(); } }
    );
  };

  const startEditEx = (ex: (typeof exercises)[0]) => {
    setEditingExerciseId(ex.id);
    // P1.6B: pre-populate with exerciseTextEdited if present, else show verbatim as starting point
    setEditExForm({
      exerciseTextEdited: (ex as any).exerciseTextEdited ?? ex.exerciseTextVerbatim,
      successCriteria: ex.successCriteria ?? "",
      interactionType: ex.interactionType ?? null,
      correctAnswer: ex.correctAnswer ?? "",
      difficultyLevel: ex.difficultyLevel ?? "MEDIUM",
      assignment: ex.assignment ?? "CLASS",
      relatedNodeId: ex.relatedNodeId ?? null,
    });
  };

  const saveEx = (exId: number) => {
    if (!editExForm) return;
    // P1.6B: always send exerciseTextEdited — backend routes to correct field by sourceType
    updateEx.mutate(
      { lessonId, exerciseId: exId, data: {
        exerciseTextEdited: editExForm.exerciseTextEdited,
        successCriteria: editExForm.successCriteria,
        interactionType: editExForm.interactionType,
        correctAnswer: editExForm.interactionType === "constructed_response"
          ? null
          : editExForm.correctAnswer.trim() || null,
        difficultyLevel: editExForm.difficultyLevel,
        assignment: editExForm.assignment,
        relatedNodeId: editExForm.relatedNodeId,
      }},
      { onSuccess: () => { setEditingExerciseId(null); setEditExForm(null); refreshEx(); } }
    );
  };

  // P1.6B: reset teacher edit — sets exerciseTextEdited=null → effective text reverts to verbatim
  const resetExEdit = (exId: number) => {
    updateEx.mutate(
      { lessonId, exerciseId: exId, data: { exerciseTextEdited: null } },
      { onSuccess: () => refreshEx() }
    );
  };

  // P1.6B: resolve effective exercise text for display (mirrors backend helper)
  const effectiveText = (ex: (typeof exercises)[0]) => {
    const edited = (ex as any).exerciseTextEdited as string | null | undefined;
    return edited?.trim() ? edited.trim() : ex.exerciseTextVerbatim;
  };

  // Quick-move: update only relatedNodeId without opening the full edit form.
  // Source metadata (sourcePage, sourceText, sourceBlockIndex, sourceType) is
  // NOT sent, so the backend leaves it untouched.
  const quickMoveExercise = (exId: number, newNodeId: number | null) => {
    updateEx.mutate(
      { lessonId, exerciseId: exId, data: { relatedNodeId: newNodeId } },
      {
        onSuccess: () => { setMovingExerciseId(null); refreshEx(); },
        onError: () => { setMovingExerciseId(null); },
      }
    );
  };

  const isBusy = nodesFetching || exFetching;
  const { token } = useAuth();

  // ── Delete entire mapping ─────────────────────────────────────────────────
  const handleDeleteAllMapping = useCallback(async () => {
    setDeleteAllPending(true);
    try {
      const r = await fetch(`/api/lessons/${lessonId}/mapping`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
      if (!r.ok) {
        const data = await r.json().catch(() => null);
        console.error("Delete mapping failed:", data?.error ?? r.status);
        return;
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: getGetLessonNodesQueryKey(lessonId) }),
        qc.invalidateQueries({ queryKey: getGetLessonExercisesQueryKey(lessonId) }),
        qc.invalidateQueries({ queryKey: ["lesson-topics", lessonId] }),
        qc.invalidateQueries({ queryKey: getGetCourseLessonsQueryKey(courseId) }),
      ]);
    } finally {
      setDeleteAllPending(false);
      setDeleteAllOpen(false);
    }
  }, [lessonId, courseId, token, qc]);

  // P6.3: Topic inline title edit state
  const [editingTopicId, setEditingTopicId]       = useState<number | null>(null);
  const [editingTopicTitle, setEditingTopicTitle] = useState("");
  const [topicSaving, setTopicSaving]             = useState(false);

  const startEditTopic = (t: { id: number; title: string }, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingTopicId(t.id);
    setEditingTopicTitle(t.title);
  };
  const cancelEditTopic = (e: React.MouseEvent) => { e.stopPropagation(); setEditingTopicId(null); };
  const saveTopic = async (topicId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!editingTopicTitle.trim()) return;
    setTopicSaving(true);
    try {
      const r = await fetch(`/api/lessons/${lessonId}/topics/${topicId}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token ?? ""}` },
        body: JSON.stringify({ title: editingTopicTitle.trim() }),
      });
      if (r.ok) { setEditingTopicId(null); qc.invalidateQueries({ queryKey: ["lesson-topics", lessonId] }); }
    } finally { setTopicSaving(false); }
  };

  // ── P1.5: Learning Objective validation helpers ──────────────────────────────
  // These are pure deterministic functions — no AI, no async, no DB.
  // They are computed from persisted node data on every render so warnings
  // survive refresh automatically.

  /** True when the Learning Objective is non-null and non-blank. */
  const isLOValid = (lo: string | null | undefined): boolean =>
    typeof lo === "string" && lo.trim().length > 0;

  const _P15_ARM_VERB_SUFFIXES = ["ел", "ал", "ум", "ир", "и", "а"];
  const _P15_EN_VERBS = [
    "define","identify","classify","compare","explain","apply","calculate",
    "solve","construct","analyze","describe","recognize","use","find",
    "determine","interpret","demonstrate","evaluate","name","list","distinguish",
  ];
  // U+0587 = Armenian ECH YIWN ligature (canonical Eastern Armenian "and")
  const _P15_CONNECTORS = ["\u0587", "եւ", "ու", "կամ", " and ", " or "];

  function _p15HasVerb(text: string): boolean {
    const lower = text.toLowerCase();
    if (_P15_EN_VERBS.some((v) => {
      const idx = lower.indexOf(v);
      if (idx === -1) return false;
      const b = idx > 0 ? lower[idx - 1] : " ";
      const a = idx + v.length < lower.length ? lower[idx + v.length] : " ";
      return /\W/.test(b) && /\W/.test(a);
    })) return true;
    return text.split(/[\s,;:!?()\[\]{}"'»«]+/).filter(Boolean)
      .some((w) => _P15_ARM_VERB_SUFFIXES.some((s) => w.endsWith(s) && w.length > s.length + 1));
  }

  /**
   * Returns the connector string if the LO appears to contain two independent
   * verb clauses joined by a compound connector; null otherwise.
   * Mirrors the backend detectCompoundLO heuristic exactly.
   */
  function detectCompoundLOWarning(lo: string | null | undefined): string | null {
    if (!lo || lo.trim().length < 10) return null;
    for (const connector of _P15_CONNECTORS) {
      const pos = lo.toLowerCase().indexOf(connector.toLowerCase());
      if (pos === -1) continue;
      const left  = lo.slice(0, pos).trim();
      const right = lo.slice(pos + connector.length).trim();
      if (left.length < 8 || right.length < 8) continue;
      if (_p15HasVerb(left) && _p15HasVerb(right)) return connector.trim();
    }
    return null;
  }

  /**
   * Returns true when the LO is suspiciously long/broad.
   * Mirrors the backend detectMegaNode heuristic exactly.
   */
  function detectMegaNodeWarning(lo: string | null | undefined): boolean {
    if (!lo) return false;
    const trimmed = lo.trim();
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    return wordCount > 35 || trimmed.length > 200;
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // P6.5: Individual node approval via existing updateNode hook
  const approveNode = (nodeId: number) => {
    setNodeApproveErrors((prev) => { const n = { ...prev }; delete n[nodeId]; return n; });
    updateNode.mutate(
      { lessonId, nodeId, data: { status: "approved" } },
      {
        onSuccess: () => refreshNodes(),
        onError: (err: unknown) => {
          const msg =
            (err as { message?: string })?.message ??
            "Հautateln chheçav: ownumnamatanumahy npataky bacakayum e";
          setNodeApproveErrors((prev) => ({ ...prev, [nodeId]: msg }));
        },
      }
    );
  };

  // P1.5: per-node approval error messages
  const [nodeApproveErrors, setNodeApproveErrors] = useState<Record<number, string>>({});

  // P6.6: Approve-all convenience action
  const [approvingAll, setApprovingAll] = useState(false);
  const approveAll = async () => {
    setApprovingAll(true);
    try {
      await fetch(`/api/lessons/${lessonId}/nodes/approve-all`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
      refreshNodes();
    } finally { setApprovingAll(false); }
  };

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

  // Node card renderer — used for both topic-grouped and standalone nodes
  const renderNodeCard = (
    n: (typeof nodes)[0],
    nodeExercises: (typeof exercises),
    isEditingNode: boolean,
    accent: string | undefined,
    nIdxInGroup: number,
    groupLength: number,
    _globalIdx: number,
  ) => {
    const canMoveUp = nIdxInGroup > 0;
    const canMoveDown = nIdxInGroup < groupLength - 1;
    const nodeStatus = (n as any).status as string | null;
    const sourceNeedsReview = ['PARTIAL', 'INSUFFICIENT', 'UNREADABLE'].includes((n as any).sourceSupport);
    const cogPathNeedsReview = (n as any).cogPathStatus === 'needs_review';
    const cogPathGroundingNeedsReview = (n as any).cognitivePathGroundingStatus === 'REVIEW_REQUIRED';
    const readinessNotes = [
      sourceNeedsReview ? 'Աղբյուրի վերանայում է պահանջվում' : null,
      cogPathGroundingNeedsReview
        ? 'Ճանաչողական ուղու հիմնավորումը պետք է վերանայվի'
        : cogPathNeedsReview
          ? 'Ճանաչողական ուղին պետք է հաստատվի'
          : null,
    ].filter((note): note is string => !!note);
    return (
      <div
        key={n.id}
        id={`lesson-node-${n.id}`}
        className="bg-background/40 border border-white/8 rounded-xl overflow-hidden"
        style={accent ? { marginLeft: "8px", borderLeft: `2px solid ${accent}35` } : {}}
      >
        {/* Node header row */}
        <div className="flex items-start gap-2 px-3 py-2">
          {/* ▲▼ reorder buttons */}
          <div className="flex flex-col gap-0.5 shrink-0 pt-0.5">
            <button
              onClick={(e) => { e.stopPropagation(); moveNode(n.id, "up"); }}
              disabled={!canMoveUp || reorderNodesMutation.isPending}
              title="Տեղափoxел ↑"
              className="text-[11px] text-white/50 hover:text-primary disabled:text-white/15 disabled:cursor-not-allowed transition-colors leading-none"
            >▲</button>
            <button
              onClick={(e) => { e.stopPropagation(); moveNode(n.id, "down"); }}
              disabled={!canMoveDown || reorderNodesMutation.isPending}
              title="Տեղափoxел ↓"
              className="text-[11px] text-white/50 hover:text-primary disabled:text-white/15 disabled:cursor-not-allowed transition-colors leading-none"
            >▼</button>
          </div>
          <span className="text-xs font-mono text-primary/60 w-5 shrink-0 pt-0.5">{n.sequence}.</span>
          <div className="flex-1 min-w-0">
            {isEditingNode && editNodeForm ? (
              <div className="space-y-1.5">
                <p className="text-[9px] text-white/40 mb-0.5">📝 Vanagir</p>
                <input
                  className={fieldCls}
                  placeholder="Վաղanaken (title)"
                  value={editNodeForm.title}
                  onChange={(e) => setEditNodeForm((f) => f && { ...f, title: e.target.value })}
                />
                <p className="text-[9px] text-white/40 mb-0.5 mt-1.5">🎯 Ուսումնական նպատակ</p>
                <textarea
                  className={fieldCls + " resize-none"}
                  rows={2}
                  placeholder="Ulmnatanumah hdrakhum — ush stanum e (learningObjective)"
                  value={editNodeForm.learningObjective}
                  onChange={(e) => setEditNodeForm((f) => f && { ...f, learningObjective: e.target.value })}
                />
                {/* Topic assignment */}
                <p className="text-[9px] text-white/40 mb-0.5 mt-1.5">📌 Thema</p>
                <select
                  className={fieldCls + " cursor-pointer"}
                  value={editNodeForm.topicId === null ? "null" : String(editNodeForm.topicId)}
                  onChange={(e) => setEditNodeForm((f) => f && { ...f, topicId: e.target.value === "null" ? null : parseInt(e.target.value) })}
                >
                  <option value="null">📌 Չկցված գիտելիքի որևէ խմբի (no topic)</option>
                  {topics.map((t) => (
                    <option key={t.id} value={String(t.id)}>{t.sequence}. {t.title}</option>
                  ))}
                </select>
                <p className="text-[9px] text-white/40 mb-0.5 mt-1.5">📖 Teorakam bovandakutjun</p>
                <textarea
                  className={fieldCls + " resize-none"}
                  rows={3}
                  placeholder="Թeoritakan bovandakutюn (theoryContent)"
                  value={editNodeForm.theoryContent}
                  onChange={(e) => setEditNodeForm((f) => f && { ...f, theoryContent: e.target.value })}
                />
                <p className="text-[9px] text-white/40 mb-0.5 mt-1.5">📄 Dasagnirkay mecberoutyun</p>
                <p className="text-[9px] text-white/25 mb-0.5">Dasagnirkay verbatim bov.</p>
                <textarea
                  className={fieldCls + " resize-none"}
                  rows={2}
                  placeholder="Դасагрqyan mecберуtюн (verbatimTheoryAnchor)"
                  value={editNodeForm.verbatimTheoryAnchor}
                  onChange={(e) => setEditNodeForm((f) => f && { ...f, verbatimTheoryAnchor: e.target.value })}
                />
                <p className="text-[9px] text-white/40 mb-0.5 mt-1.5">⚠️ Taragvats skhalt patkeratsuum</p>
                <textarea
                  className={fieldCls + " resize-none"}
                  rows={2}
                  placeholder="Տարածված սխալ պատկերացում (commonMisconception)"
                  value={editNodeForm.commonMisconception}
                  onChange={(e) => setEditNodeForm((f) => f && { ...f, commonMisconception: e.target.value })}
                />
                <p className="text-[9px] text-white/40 mb-0.5 mt-1.5">📝 Sovoroghi hasken manali bacatarutyun</p>
                <textarea
                  className={fieldCls + " resize-none"}
                  rows={3}
                  placeholder="Սովորողին հասկանալի բացատրություն (childFriendlyExplanation)"
                  value={editNodeForm.childFriendlyExplanation}
                  onChange={(e) => setEditNodeForm((f) => f && { ...f, childFriendlyExplanation: e.target.value })}
                />
                <p className="text-[9px] text-white/40 mb-0.5 mt-1.5">💡 Himunakakan orinakmak</p>
                <textarea
                  className={fieldCls + " resize-none"}
                  rows={3}
                  placeholder="Հիմնական օրինակներ — մեկ տող, մեկ օրինակ (basicExamples)"
                  value={editNodeForm.basicExamples}
                  onChange={(e) => setEditNodeForm((f) => f && { ...f, basicExamples: e.target.value })}
                />
                <p className="text-[9px] text-white/40 mb-0.5 mt-1.5">🧩 Haka orinakmak</p>
                <textarea
                  className={fieldCls + " resize-none"}
                  rows={2}
                  placeholder="Հակաօրինակներ — մեկ տող, մեկ օրինակ (nonExamples)"
                  value={editNodeForm.nonExamples}
                  onChange={(e) => setEditNodeForm((f) => f && { ...f, nonExamples: e.target.value })}
                />
                <p className="text-[9px] text-white/40 mb-0.5 mt-1.5">🌍 Irakan kyankits orinakmak</p>
                <textarea
                  className={fieldCls + " resize-none"}
                  rows={2}
                  placeholder="Իրական կյանքից օրինակներ — մեկ տող, մեկ օրինակ (realLifeExamples)"
                  value={editNodeForm.realLifeExamples}
                  onChange={(e) => setEditNodeForm((f) => f && { ...f, realLifeExamples: e.target.value })}
                />
                {/* Numeric fields — labeled (audit Part 3) */}
                <div className="grid grid-cols-2 gap-2 mt-1.5">
                  <div>
                    <p className="text-[9px] text-white/40 mb-0.5">🎯 Bloom macardak (1–6)</p>
                    <p className="text-[9px] text-white/25 mb-0.5">1=Hishel · 6=Steghcel</p>
                    <input
                      className={fieldCls}
                      placeholder="1–6"
                      type="number" min={1} max={6}
                      value={editNodeForm.targetBloomLevel}
                      onChange={(e) => setEditNodeForm((f) => f && { ...f, targetBloomLevel: e.target.value })}
                    />
                  </div>
                  <div>
                    <p className="text-[9px] text-white/40 mb-0.5">⏱ Gnahatvats roghe (րոպե)</p>
                    <input
                      className={fieldCls}
                      placeholder="րոպե"
                      type="number" min={1}
                      value={editNodeForm.estimatedMinutes}
                      onChange={(e) => setEditNodeForm((f) => f && { ...f, estimatedMinutes: e.target.value })}
                    />
                  </div>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => saveNode(n.id)}
                    disabled={updateNode.isPending}
                    className={btnSm + " bg-primary text-black disabled:opacity-40"}
                  >{updateNode.isPending ? "..." : "Պահպանել"}</button>
                  <button
                    onClick={() => { setEditingNodeId(null); setEditNodeForm(null); }}
                    className={btnSm + " bg-white/10 text-muted-foreground"}
                  >Չեղարկել</button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-semibold text-white">{n.title}</span>
                  {nodeStatus === 'needs_review' && (
                    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/25 shrink-0">⚠ Վերանայել</span>
                  )}
                  {(nodeStatus === 'draft' || !nodeStatus) && (
                    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-white/8 text-white/40 border border-white/10 shrink-0">📝 Սևագիր</span>
                  )}
                </div>
                {readinessNotes.length > 0 && (
                  <p
                    title={(n as any).sourceAlignmentReason ?? undefined}
                    className="mt-0.5 text-[9px] font-medium leading-relaxed text-amber-300/80"
                  >
                    ⚠️ {readinessNotes.join(' · ')}
                  </p>
                )}
                {(n as any).learningObjective && (
                  <p className="text-[10px] text-primary/70 mt-0.5 leading-relaxed italic">🎯 {(n as any).learningObjective}</p>
                )}
                {/* P1.5: Deterministic LO validation messages — recomputed from persisted data */}
                {!isLOValid((n as any).learningObjective) && (
                  <p className="text-[9px] font-semibold text-red-400 mt-0.5 leading-relaxed">
                    🔴 Սkhalt․ Ուսումնական նպատակը բացակայում է
                  </p>
                )}
                {isLOValid((n as any).learningObjective) &&
                  detectCompoundLOWarning((n as any).learningObjective) !== null && (
                  <p className="text-[9px] font-medium text-amber-400/80 mt-0.5 leading-relaxed">
                    🟠 Զգուշացում․ Ուսումնական նպատակը կարող է ընդգրկել մեկից ավել նպատակներ
                  </p>
                )}
                {isLOValid((n as any).learningObjective) &&
                  detectMegaNodeWarning((n as any).learningObjective) && (
                  <p className="text-[9px] font-medium text-amber-400/80 mt-0.5 leading-relaxed">
                    🟠 Զգուշացում․ Գիտելիքի հանգույցը կարող է չափազանց ծավալուն լինել
                  </p>
                )}
                {n.theoryContent && (
                  <p className="text-xs text-muted-foreground/80 mt-0.5 line-clamp-2 leading-relaxed">{n.theoryContent}</p>
                )}
                <div className="flex items-center gap-2 flex-wrap mt-0.5">
                  {n.targetBloomLevel != null && (
                    <span className="text-[10px] text-primary/50">Bloom {n.targetBloomLevel}</span>
                  )}
                  {(n as any).sourcePage != null && (
                    <span className="text-[10px] text-white/30">Էջ {(n as any).sourcePage}</span>
                  )}
                </div>
              </>
            )}
          </div>
          {!isEditingNode && (
            <div className="flex flex-col items-end gap-0.5 shrink-0 pt-0.5">
              {(n as any).status !== 'approved' && (
                <button
                  onClick={() => approveNode(n.id)}
                  disabled={updateNode.isPending || !isLOValid((n as any).learningObjective)}
                  title={
                    !isLOValid((n as any).learningObjective)
                      ? "Հաստատել հնարավոր չէ․ ուսուցման նպատակը բացակայում է"
                      : "Հաստատել"
                  }
                  className="text-xs text-emerald-500/60 hover:text-emerald-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >✅</button>
              )}
              {nodeApproveErrors[n.id] && (
                <span className="text-[8px] text-red-400 leading-tight text-right max-w-[80px]">
                  {nodeApproveErrors[n.id]}
                </span>
              )}
              {/* 👁 Read-only view */}
              <button
                onClick={() => setViewingNodeData({ node: n as unknown as Record<string, unknown>, exercises: exercises as unknown as Array<Record<string, unknown>> })}
                title="Դitel — ամovornakan deghekatvats tveyal"
              className="text-xs text-muted-foreground hover:text-primary/80 transition-colors"
              >👁</button>
              {/* ✏️ Edit */}
              <button
                onClick={() => startEditNode(n)}
                title="Xmbagrel"
                className="text-xs text-muted-foreground hover:text-white transition-colors"
              >✏️</button>
              <button
                onClick={() => {
                  if (!confirm(`Ջnjel «${n.title}»`)) return;
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
                  {(ex as any).learnerContentSafe === false && (
                    <div className="mb-1.5 rounded border border-red-400/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-200">
                      Այս վարժությունը չի ցուցադրվի սովորողին, մինչև հեռացվեն պատասխանը կամ գնահատման չափանիշները սովորողի տեքստից։
                    </div>
                  )}
                  {isEditingEx && editExForm ? (
                    <div className="space-y-1.5">
                      {/* P1.6B: show read-only original when editing an adapted textbook exercise */}
                      {(ex as any).sourceType === 'textbook' && (ex as any).exerciseTextEdited && (
                        <div className="bg-black/30 border border-amber-500/20 rounded px-2 py-1.5">
                          <p className="text-[9px] text-amber-400/60 mb-0.5">📖 Դասագրքից բնօրինակ</p>
                          <p className="text-[10px] text-white/40 leading-relaxed">{ex.exerciseTextVerbatim}</p>
                        </div>
                      )}
                      <textarea className={fieldCls + " resize-none"} rows={3}
                        value={editExForm.exerciseTextEdited}
                        onChange={(e) => setEditExForm((f) => f && { ...f, exerciseTextEdited: e.target.value })}
                        placeholder="Սովորողին ցուցադրվող առաջադրանքը՝ առանց պատասխանի կամ գնահատման չափանիշների"
                      />
                      {updateEx.isError && (
                        <p className="text-[10px] text-red-300">{updateEx.error.message}</p>
                      )}
                      <input className={fieldCls} placeholder="Հաջողության չափանիշ / գնահատման ուղեցույց" value={editExForm.successCriteria} onChange={(e) => setEditExForm((f) => f && { ...f, successCriteria: e.target.value })} />
                      <ExerciseAnswerFields
                        interactionType={editExForm.interactionType}
                        correctAnswer={editExForm.correctAnswer}
                        inputClassName={fieldCls}
                        onChange={(interactionType, correctAnswer) =>
                          setEditExForm((f) => f && { ...f, interactionType, correctAnswer })
                        }
                      />
                      <div className="flex gap-2">
                        <select className={fieldCls + " cursor-pointer"} value={editExForm.difficultyLevel} onChange={(e) => setEditExForm((f) => f && { ...f, difficultyLevel: e.target.value })}>
                          <option value="LOW">LOW</option><option value="MEDIUM">MEDIUM</option><option value="HIGH">HIGH</option>
                        </select>
                        <select className={fieldCls + " cursor-pointer"} value={editExForm.assignment} onChange={(e) => setEditExForm((f) => f && { ...f, assignment: e.target.value })}>
                          <option value="CLASS">CLASS</option><option value="HOMEWORK">HOMEWORK</option>
                        </select>
                      </div>
                      <select className={fieldCls + " cursor-pointer"} value={editExForm.relatedNodeId === null ? "null" : String(editExForm.relatedNodeId)} onChange={(e) => setEditExForm((f) => f && { ...f, relatedNodeId: e.target.value === "null" ? null : parseInt(e.target.value) })}>
                        <option value="null">📦 Չկցված / Լրացուցիչ վարժություն</option>
                        {nodes.map((nd) => <option key={nd.id} value={String(nd.id)}>{nd.sequence}. {nd.title}</option>)}
                      </select>
                      <div className="flex gap-1">
                        <button onClick={() => saveEx(ex.id)} disabled={updateEx.isPending} className={btnSm + " bg-primary text-black disabled:opacity-40"}>{updateEx.isPending ? "..." : "Պահպանել"}</button>
                        <button onClick={() => { setEditingExerciseId(null); setEditExForm(null); }} className={btnSm + " bg-white/10 text-muted-foreground"}>Չեղարկել</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-white/90 leading-relaxed">{effectiveText(ex)}</p>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          {/* P1.6B — source origin badge + reset button */}
                          {(ex as any).sourceType === 'textbook'
                            ? <span className="text-[9px] text-blue-400/50">📖 Դասագրքից </span>
                            : <span className="text-[9px] text-purple-400/50">✍️ Ձեռքով</span>
                          }
                          {(ex as any).exerciseTextEdited && (
                            <button
                              onClick={() => resetExEdit(ex.id)}
                              disabled={updateEx.isPending}
                              title="Verakangnel bnaginakin"
                              className="text-[9px] text-amber-400/50 hover:text-amber-300 transition-colors disabled:opacity-40"
                            >↩ Վերականգնել</button>
                          )}
                          {ex.difficultyLevel && <span className="text-[10px] text-muted-foreground/60">{ex.difficultyLevel}</span>}
                          {ex.assignment && (
                            <span className={`text-[10px] font-medium ${ex.assignment === "HOMEWORK" ? "text-amber-400/70" : "text-teal-400/70"}`}>
                              {ex.assignment === "HOMEWORK" ? "🏠 Tnyin" : "📋 Դասարանում"}
                            </span>
                          )}
                          {ex.sourcePage && <span className="text-[10px] text-muted-foreground/40"> Էջ {ex.sourcePage}</span>}
                          {ex.status !== "approved" && (
                            <span className="text-[10px] text-amber-400/60">⚠ Վերանայել</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {/* Quick-move: shows a node selector without opening the full edit form */}
                        {movingExerciseId === ex.id ? (
                          <select
                            autoFocus
                            className="text-[10px] bg-black/40 border border-white/20 rounded px-1 py-0.5 text-white cursor-pointer max-w-[140px]"
                            onChange={(e) => {
                              const v = e.target.value;
                              if (!v) return;
                              quickMoveExercise(ex.id, v === "null" ? null : parseInt(v, 10));
                            }}
                            onBlur={() => setMovingExerciseId(null)}
                          >
                            <option value="">→ Տեղափ...</option>
                            <option value="null">📦 Լրացուցիչ</option>
                            {nodes.map((nd) => (
                              <option key={nd.id} value={String(nd.id)}>
                                {nd.sequence}. {nd.title.substring(0, 28)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <button
                            onClick={() => setMovingExerciseId(ex.id)}
                            className="text-[11px] text-white/30 hover:text-primary/80 transition-colors shrink-0"
                            title="Տեղափոխել →"
                          >→</button>
                        )}
                        <button onClick={() => startEditEx(ex)} className="text-xs text-muted-foreground hover:text-white transition-colors">✏️</button>
                        <button onClick={() => { if (!confirm("Ջնջել վարժությունը?")) return; deleteEx.mutate({ lessonId, exerciseId: ex.id }, { onSuccess: refreshEx }); }} className="text-xs text-muted-foreground hover:text-destructive transition-colors">🗑️</button>
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
              <textarea className={fieldCls + " resize-none"} rows={2} placeholder="Վարժության բնագիր *" value={addExForm.exerciseTextVerbatim} onChange={(e) => setAddExForm((f) => ({ ...f, exerciseTextVerbatim: e.target.value }))} />
              <input className={fieldCls} placeholder="Հաջողության չափանիշ / գնահատման ուղեցույց" value={addExForm.successCriteria} onChange={(e) => setAddExForm((f) => ({ ...f, successCriteria: e.target.value }))} />
              <ExerciseAnswerFields
                interactionType={addExForm.interactionType}
                correctAnswer={addExForm.correctAnswer}
                inputClassName={fieldCls}
                onChange={(interactionType, correctAnswer) =>
                  setAddExForm((f) => ({ ...f, interactionType, correctAnswer }))
                }
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
                <button disabled={createEx.isPending || !addExForm.exerciseTextVerbatim.trim()} onClick={() => { createEx.mutate({ lessonId, data: { ...addExForm, correctAnswer: addExForm.correctAnswer.trim() || null, relatedNodeId: n.id, difficultyLevel: addExForm.difficultyLevel as "LOW"|"MEDIUM"|"HIGH", assignment: addExForm.assignment as "CLASS"|"HOMEWORK" } }, { onSuccess: () => { setAddExForNodeId(null); setAddExForm(emptyExerciseCreateForm()); refreshEx(); } }); }} className={btnSm + " bg-primary text-black disabled:opacity-40"}>{createEx.isPending ? "..." : "+ Ավելացնել"}</button>
                <button onClick={() => setAddExForNodeId(null)} className={btnSm + " bg-white/10 text-muted-foreground"}>Չեղարկել</button>
              </div>
            </div>
          ) : (
            <button onClick={() => { setAddExForNodeId(n.id); setAddExForm(emptyExerciseCreateForm()); }} className="text-[11px] text-muted-foreground/50 hover:text-primary/70 transition-colors py-0.5">+ Ավելացնել վարժություն</button>
          )}
        </div>

        {/* ── 🧠 Ճanachogakan ughi (Cognitive Path) — Phase 2A R3 ───────────── */}
        <div className="border-t border-indigo-500/15">
          {/* Toggle header */}
          <button
            onClick={() => toggleCogPath(n.id)}
            className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] text-indigo-400/70 hover:text-indigo-300 hover:bg-indigo-500/5 transition-colors"
          >
            <span className="font-medium flex items-center gap-1.5">
              🧠 <span>Ճանաչողական ուղի</span>
              {cogPathData[n.id]?.levels.length ? (
                <span className="text-[10px] text-indigo-400/50">
                  ({[...cogPathData[n.id]!.levels].sort((a, b) => CANONICAL_COG_ORDER.indexOf(a.cognitiveLevel) - CANONICAL_COG_ORDER.indexOf(b.cognitiveLevel)).map((l) => COG_LEVEL_LABELS[l.cognitiveLevel] ?? l.cognitiveLevel).join(' → ')})
                </span>
              ) : null}
              {cogPathData[n.id]?.cogPathStatus === 'needs_review' && (
                <span className="text-[9px] bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded">⏳ Gashmvum e</span>
              )}
            </span>
            <span className="text-[10px]">{cogPathOpen[n.id] ? '▲' : '▼'}</span>
          </button>

          {cogPathOpen[n.id] && (
            <div className="px-3 pb-3 space-y-2">
              {/* Loading spinner */}
              {cogPathLoading[n.id] && (
                <div className="flex justify-center py-2">
                  <span className="inline-block w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
                </div>
              )}

              {/* Error */}
              {cogPathError[n.id] && (
                <p className="text-[10px] text-red-400 bg-red-500/10 rounded px-2 py-1">{cogPathError[n.id]}</p>
              )}

              {/* Levels list — sorted by canonical Bloom order, not DB sequence */}
              {[...(cogPathData[n.id]?.levels ?? [])].sort((a, b) => CANONICAL_COG_ORDER.indexOf(a.cognitiveLevel) - CANONICAL_COG_ORDER.indexOf(b.cognitiveLevel)).map((level) => {
                const isEditing = cogLevelEditId === level.id;
                const linkedCount = level.tasks.length;
                const mie = level.minimumIndependentEvidence;
                const gap = Math.max(0, mie - linkedCount);
                return (
                  <div key={level.id} className={
                    "rounded-lg border p-2 space-y-1.5 " +
                    (level.isTargetCeiling ? "border-indigo-400/40 bg-indigo-500/8" : "border-white/8 bg-black/20")
                  }>
                    {/* Level header */}
                    <div className="flex items-center justify-between gap-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-semibold text-indigo-300">
                          {COG_LEVEL_LABELS[level.cognitiveLevel] ?? level.cognitiveLevel}
                        </span>
                        {level.isTargetCeiling && <span className="text-[9px] bg-indigo-500/30 text-indigo-200 px-1 rounded">🎯 Թիրախային</span>}
                        <span className="text-[9px] text-white/25">
                          {level.provenance === 'teacher_authored' ? '✏️ Ուսուցչի կողմից հաստատված' : level.provenance === 'ai_generated' ? '🤖 AI' : '📖 Achbyur'}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        {/* ↑/↓ removed (Part 4): cognitive levels have canonical Bloom order; manual reorder is unsafe */}
                        {!level.isTargetCeiling && (
                          <button onClick={() => setCogCeiling(level.id, n.id)} title="Սահմանիր թիրախային մակարդակ" className="text-[10px] text-white/30 hover:text-indigo-400 transition-colors">🎯</button>
                        )}
                        <button onClick={() => isEditing ? (setCogLevelEditId(null), setCogLevelEditForm(null)) : startEditCogLevel(level)} className="text-[10px] text-white/30 hover:text-white transition-colors">{isEditing ? '✕' : '✏️'}</button>
                        <button onClick={() => deleteCogLevel(level.id, n.id, level.cognitiveLevel)} className="text-[10px] text-white/20 hover:text-destructive transition-colors">🗑</button>
                      </div>
                    </div>

                    {isEditing && cogLevelEditForm ? (
                      <div className="space-y-1.5">
                        <div>
                          <p className="text-[9px] text-indigo-300/60 mb-0.5">Կատարողական նպատակ (Կատարողական նպատակ)</p>
                          <textarea className={fieldCls + " resize-none text-[10px]"} rows={2}
                            value={cogLevelEditForm.performanceObjective}
                            onChange={(e) => setCogLevelEditForm((f) => f && { ...f, performanceObjective: e.target.value })}
                            placeholder="Sovoroghy kare... (Armenian)"
                          />
                        </div>
                        <div>
                          <p className="text-[9px] text-indigo-300/60 mb-0.5">հաջողության չաջանիշ</p>
                          <textarea className={fieldCls + " resize-none text-[10px]"} rows={2}
                            value={cogLevelEditForm.successCriterion}
                            onChange={(e) => setCogLevelEditForm((f) => f && { ...f, successCriterion: e.target.value })}
                            placeholder="Inch e hashvum ancelfeli apacuyc... (Armenian)"
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-[9px] text-white/50">Պահանջվող անկախ ապացույցներ</label>
                          <input type="number" min={1} max={10} className={fieldCls + " w-16 text-[10px]"}
                            value={cogLevelEditForm.minimumIndependentEvidence}
                            onChange={(e) => setCogLevelEditForm((f) => f && { ...f, minimumIndependentEvidence: Math.max(1, parseInt(e.target.value) || 1) })}
                          />
                        </div>
                        <div>
                          <p className="text-[9px] text-white/50 mb-1">Նախընտրելի պատասխանի օրինակներ</p>
                          <div className="flex flex-wrap gap-1">
                            {ALL_INTERACTION_TYPES.map((it) => {
                              const checked = cogLevelEditForm.preferredInteractionTypes.includes(it);
                              return (
                                <button key={it} onClick={() => setCogLevelEditForm((f) => f && { ...f, preferredInteractionTypes: checked ? f.preferredInteractionTypes.filter((x) => x !== it) : [...f.preferredInteractionTypes, it] })}
                                  className={"text-[9px] px-1.5 py-0.5 rounded transition-colors " + (checked ? "bg-indigo-500/40 text-indigo-200" : "bg-white/8 text-white/40 hover:bg-white/15")}>
                                  {INTERACTION_LABELS[it] ?? it.replace(/_/g, ' ')}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        <div className="flex gap-1">
                          <button onClick={() => saveCogLevel(level.id, n.id)} disabled={cogLevelSaving} className={btnSm + " bg-indigo-600 text-white text-[10px] disabled:opacity-40"}>{cogLevelSaving ? '...' : 'Պահպանել'}</button>
                          <button onClick={() => { setCogLevelEditId(null); setCogLevelEditForm(null); }} className={btnSm + " bg-white/10 text-muted-foreground text-[10px]"}>Չեղարկել</button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {level.performanceObjective && (
                          <div>
                            <p className="text-[9px] text-indigo-300/60">Կատարողական նպատակ</p>
                            <p className="text-[10px] text-white/70 leading-relaxed">{level.performanceObjective}</p>
                          </div>
                        )}
                        {level.successCriterion && (
                          <div>
                            <p className="text-[9px] text-indigo-300/60">Հաջողության չափանիշ</p>
                            <p className="text-[10px] text-white/70 leading-relaxed">{level.successCriterion}</p>
                          </div>
                        )}
                        {/* Evidence gap */}
                        <div className="flex items-center gap-2 pt-0.5">
                          <span className="text-[9px] text-white/40">
                            📊 Պահանջվում է: {mie} · Կապված է: {linkedCount}
                            {gap > 0 ? <span className="text-amber-400/80"> · Պակասում է: {gap}</span> : <span className="text-emerald-400/80"> · ✓</span>}
                          </span>
                        </div>
                        {/* Preferred interaction types */}
                        {level.preferredInteractionTypes.length > 0 && (
                          <div className="flex flex-wrap gap-1 pt-0.5">
                            {level.preferredInteractionTypes.map((it) => (
                              <span key={it} className="text-[9px] bg-white/8 text-white/40 px-1.5 py-0.5 rounded">{INTERACTION_LABELS[it] ?? it.replace(/_/g, ' ')}</span>
                            ))}
                          </div>
                        )}
                        {/* Linked exercises */}
                        {level.tasks.length > 0 && (
                          <div className="space-y-0.5 pt-0.5">
                            <p className="text-[9px] text-white/30">Կցված վարժություներ</p>
                            {level.tasks.map((task) => (
                              <div key={task.id} className="flex items-start gap-1 group">
                                <span className="text-[9px] text-white/50 leading-relaxed flex-1">
                                  📎 {task.exercise?.exerciseTextEdited ?? task.exercise?.exerciseTextVerbatim ?? `[${task.exercise?.exerciseId ?? 'ID'}]`}
                                </span>
                                <button onClick={() => unlinkTask(task.id, n.id)} className="text-[9px] text-white/20 hover:text-destructive opacity-0 group-hover:opacity-100 transition-all shrink-0">✕</button>
                              </div>
                            ))}
                          </div>
                        )}
                        {/* Link exercise to this level */}
                        {nodeExercises.length > 0 && (
                          <select
                            className={fieldCls + " text-[9px] cursor-pointer mt-1"}
                            defaultValue=""
                            onChange={(e) => { if (e.target.value) { linkExercise(level.id, parseInt(e.target.value), n.id); e.target.value = ''; } }}
                          >
                            <option value="">+ Կցել վարժություն...</option>
                            {nodeExercises
                              .filter((ex) => !level.tasks.some((t) => t.lessonExerciseId === ex.id))
                              .map((ex) => (
                                <option key={ex.id} value={String(ex.id)}>
                                  [{(ex as any).exerciseId}] {((ex as any).exerciseTextVerbatim as string).substring(0, 50)}...
                                </option>
                              ))}
                          </select>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Add cognitive level */}
              {!cogPathLoading[n.id] && (
                !addLevelOpen[n.id] ? (
                  <button
                    onClick={() => { setAddLevelOpen((a) => ({ ...a, [n.id]: true })); setAddLevelForm((f) => ({ ...f, [n.id]: { cognitiveLevel: '', performanceObjective: '', successCriterion: '' } })); }}
                    className="text-[10px] text-indigo-400/40 hover:text-indigo-300 transition-colors py-0.5"
                  >+ Ավելացնել ճանաչողական մակարդակ</button>
                ) : (
                  <div className="rounded-lg border border-indigo-400/20 bg-indigo-500/5 p-2 space-y-1.5">
                    <p className="text-[10px] text-indigo-300/70 font-medium">Նոր ճանաչողական մակարդակ</p>
                    <select
                      className={fieldCls + " text-[10px]"}
                      value={addLevelForm[n.id]?.cognitiveLevel ?? ''}
                      onChange={(e) => setAddLevelForm((f) => ({ ...f, [n.id]: { ...(f[n.id] ?? { cognitiveLevel: '', performanceObjective: '', successCriterion: '' }), cognitiveLevel: e.target.value } }))}
                    >
                      <option value="">-- Ուսումնական մակարդակ --</option>
                      {CANONICAL_COG_ORDER
                        .filter((key) => !(cogPathData[n.id]?.levels ?? []).some((l) => l.cognitiveLevel === key))
                        .map((key) => (
                          <option key={key} value={key}>{COG_LEVEL_LABELS[key] ?? key}</option>
                        ))}
                    </select>
                    <textarea
                      className={fieldCls + " resize-none text-[10px]"}
                      rows={2}
                      placeholder="Կատարողական նպատակ (Armenian)..."
                      value={addLevelForm[n.id]?.performanceObjective ?? ''}
                      onChange={(e) => setAddLevelForm((f) => ({ ...f, [n.id]: { ...(f[n.id] ?? { cognitiveLevel: '', performanceObjective: '', successCriterion: '' }), performanceObjective: e.target.value } }))}
                    />
                    <textarea
                      className={fieldCls + " resize-none text-[10px]"}
                      rows={2}
                      placeholder="Հաջողության չափանիշ (Armenian)..."
                      value={addLevelForm[n.id]?.successCriterion ?? ''}
                      onChange={(e) => setAddLevelForm((f) => ({ ...f, [n.id]: { ...(f[n.id] ?? { cognitiveLevel: '', performanceObjective: '', successCriterion: '' }), successCriterion: e.target.value } }))}
                    />
                    <div className="flex gap-1">
                      <button onClick={() => addCogLevel(n.id)} disabled={!addLevelForm[n.id]?.cognitiveLevel || !!addLevelSaving[n.id]} className={btnSm + " bg-indigo-600 text-white text-[10px] disabled:opacity-40"}>{addLevelSaving[n.id] ? '...' : 'Ավելացնել'}</button>
                      <button onClick={() => { setAddLevelOpen((a) => ({ ...a, [n.id]: false })); setAddLevelForm((f) => { const nf = { ...f }; delete nf[n.id]; return nf; }); }} className={btnSm + " bg-white/10 text-muted-foreground text-[10px]"}>Չեղարկել</button>
                    </div>
                  </div>
                )
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="border-t border-white/8">
      {/* ── Panel header row ──────────────────────────────────────────────── */}
      <div className="flex items-center">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex-1 flex items-center justify-between px-4 py-2 text-xs text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
        >
          <span className="font-medium tracking-wide">
            {(nodes.length > 0 || exercises.length > 0)
              ? `🗺️ Մանրամասն քարտեզագրում · Թեմաներ / MicroNode-եր / աղբյուր / ուղի / վարժություններ (${nodes.length} · ${exercises.length})`
              : "🗺️ Մանրամասն քարտեզագրում · Թեմաներ / MicroNode-եր / աղբյուր / ուղի / վարժություններ"}
          </span>
          <span>{open ? "▲" : "▼"}</span>
        </button>

        {/* ── Ջնջել ամբողջ քարտեզագրումը — only when nodes exist ──────────── */}
        {nodes.length > 0 && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); setDeleteAllOpen(true); }}
              disabled={deleteAllPending}
              title="Ջնջել ամբողջ քարտեզագրումը"
              className="px-3 py-2 text-xs text-muted-foreground/50 hover:text-destructive transition-colors disabled:opacity-40 shrink-0"
            >
              {deleteAllPending ? (
                <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
              ) : "🗑️"}
            </button>

            <AlertDialog open={deleteAllOpen} onOpenChange={setDeleteAllOpen}>
              <AlertDialogContent className="bg-[#0f1117] border border-white/10 text-white">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-sm font-semibold text-white">
                    Ջնջե՞լ ամբողջ քարտեզագրումը
                  </AlertDialogTitle>
                  <AlertDialogDescription className="text-xs text-muted-foreground leading-relaxed space-y-2">
                    <span className="block">
                      Ամբողջ ընթացիկ քարտեզագրումը կջնջվի։
                      Node-ները, MicroNode-ները, Source Block-ները, վարժությունները և դրանց կապերը կհեռացվեն։
                    </span>
                    <span className="block">
                      Lesson-ը և նրա հիմնական տվյալները չեն ջնջվի։
                    </span>
                    <span className="block font-semibold text-destructive/80">
                      Այս գործողությունը հնարավոր չէ հետարկել։
                    </span>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel
                    className="bg-white/5 border-white/10 text-white hover:bg-white/10 hover:text-white text-xs"
                    disabled={deleteAllPending}
                  >
                    Չեղարկել
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={(e) => { e.preventDefault(); handleDeleteAllMapping(); }}
                    disabled={deleteAllPending}
                    className="bg-destructive text-white hover:bg-destructive/90 text-xs"
                  >
                    {deleteAllPending ? "Ջnjvum e..." : "Ջնջել ամբողջ քարտեզագրումը"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}

      </div>

      {open && (
        <div className="px-4 pb-4 space-y-3">
          <div className="rounded-lg border border-white/8 bg-white/[0.025] px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">Քարտեզագրման կառուցվածք</p>
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              Թեմա → MicroNode → աղբյուրային կոնտեքստ → ճանաչողական ուղի → կցված վարժություններ։ Չկցված վարժությունները պահպանվում են առանձին՝ առանց կրկնօրինակելու։
            </p>
          </div>
          {nodes.length > 0 && (
            <section className="rounded-xl border border-primary/20 bg-primary/[0.045] px-3 py-3 space-y-2.5">
              <p className="text-[11px] font-semibold text-white">Դասի քարտեզագրման քայլեր</p>
              <div className="grid grid-cols-1 items-stretch gap-2 md:grid-cols-3">
                <div className="min-w-0 rounded-lg border border-indigo-400/20 bg-black/15 p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-400/15 text-[10px] font-semibold text-indigo-200">1</span>
                    <p className="text-[10px] font-semibold text-white">Ճանաչողական ուղիներ</p>
                  </div>
                  <div className="mt-2 min-h-8">
                    {allCognitivePathsCreated ? (
                      <span className={"inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] font-medium " + (
                        allCognitivePathsConfirmed
                          ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
                          : "border-amber-400/25 bg-amber-400/10 text-amber-200"
                      )}>
                        {allCognitivePathsConfirmed ? `✓ ${cognitivePathsCreated}/${nodes.length} ստեղծված` : "⚠ Վերանայում է պետք"}
                      </span>
                    ) : (
                      <button
                        onClick={generateAllCogPaths}
                        disabled={bulkCogPathRunning}
                        className="flex items-center gap-1.5 rounded-lg border border-indigo-400/35 bg-indigo-500/20 px-2.5 py-1.5 text-[10px] font-medium text-indigo-100 transition-colors hover:border-indigo-300/60 hover:bg-indigo-500/30 disabled:opacity-50"
                      >
                        {bulkCogPathRunning ? (
                          <span className="inline-block h-3 w-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        ) : cognitivePathsCreated > 0 ? `✨ Լրացնել բացակայող ${cognitivePathsMissing}-ը` : "✨ Ստեղծել"}
                      </button>
                    )}
                  </div>
                  {cognitivePathsCreated > 0 && (
                    <p className={"mt-1 text-[9px] " + (
                      allCognitivePathsConfirmed ? "text-emerald-300/70" : "text-amber-200/75"
                    )}>
                      {cognitivePathsCreated} / {nodes.length} ստեղծված
                      {cognitivePathsMissing > 0 && ` · ${cognitivePathsMissing}-ը դեռ չի ստեղծվել`}
                      {cognitivePathsAwaitingReview > 0 && ` · ⚠ ${cognitivePathsAwaitingReview}-ը պահանջում է վերանայում`}
                    </p>
                  )}
                </div>

                <div className="min-w-0 rounded-lg border border-indigo-400/20 bg-black/15 p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-400/15 text-[10px] font-semibold text-indigo-200">2</span>
                    <p className="text-[10px] font-semibold text-white">Ուսուցման բովանդակություն · անկախ</p>
                  </div>
                  <div className="mt-2 flex min-h-8 min-w-0 flex-col items-start gap-1">
                    <GenerateTeachingContentButton
                      lessonId={lessonId}
                      hasNodes={nodes.length > 0}
                      completedCount={teachingContentComplete}
                      totalCount={nodes.length}
                      hasTeachingContentForAllNodes={allTeachingContentComplete}
                      onInspectNode={openCogPathFromBulkResult}
                    />
                  </div>
                  {teachingContentComplete > 0 && (
                    <p className={"mt-1 text-[9px] " + (
                       allTeachingContentComplete ? "text-white/55" : "text-amber-200/75"
                    )}>
                      {teachingContentComplete} / {nodes.length} պատրաստ է
                      {!allTeachingContentComplete && ` · ⚠ ${nodes.length - teachingContentComplete}-ը պատրաստ չէ`}
                    </p>
                  )}
                </div>

                <div className="min-w-0 rounded-lg border border-emerald-400/20 bg-black/15 p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-400/15 text-[10px] font-semibold text-emerald-200">3</span>
                    <p className="text-[10px] font-semibold text-white">Հանձնարարում</p>
                  </div>
                  <div className="mt-2 min-h-8">
                    <LessonAssignmentAction
                      lessonId={lessonId}
                      courseId={courseId}
                      authoringStatus={authoringStatus}
                    />
                  </div>
                </div>
              </div>
              {bulkCogPathRunning && bulkCogPathProgress && (
                <p className="text-[10px] text-indigo-200/80">
                  Ստեղծվում է {bulkCogPathProgress.current}/{bulkCogPathProgress.total} · {bulkCogPathProgress.title}
                </p>
              )}
              {bulkCogPathSummary && (
                <div className="rounded-lg border border-white/8 bg-black/15 px-2.5 py-2 space-y-1.5">
                  <p className="text-[10px] font-medium text-white/75">Ճանաչողական ուղիների ամփոփում</p>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { key: "generated", label: "Ստեղծված", entries: bulkCogPathSummary.generated, className: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300" },
                      { key: "existing", label: "Արդեն կար", entries: bulkCogPathSummary.existing, className: "border-sky-400/20 bg-sky-400/10 text-sky-200" },
                      { key: "inProgress", label: "Ընթացքի մեջ", entries: bulkCogPathSummary.inProgress, className: "border-violet-400/20 bg-violet-400/10 text-violet-200" },
                      { key: "c1Review", label: "C1 վերանայում", entries: bulkCogPathSummary.c1Review, className: "border-amber-400/20 bg-amber-400/10 text-amber-200" },
                      { key: "targetReview", label: "Թիրախի վերանայում", entries: bulkCogPathSummary.targetReview, className: "border-amber-400/20 bg-amber-400/10 text-amber-200" },
                      { key: "validationFailed", label: "Վավերացում", entries: bulkCogPathSummary.validationFailed, className: "border-amber-400/20 bg-amber-400/10 text-amber-200" },
                      { key: "failed", label: "Սխալ", entries: bulkCogPathSummary.failed, className: "border-red-400/20 bg-red-400/10 text-red-200" },
                    ].filter((item) => item.entries.length > 0).map((item) => (
                      <span
                        key={item.key}
                        title={item.entries.map((entry) => entry.detail ? `${entry.title}: ${entry.detail}` : entry.title).join("\n")}
                        className={"rounded-full border px-2 py-0.5 text-[9px] font-medium cursor-help " + item.className}
                      >
                        {item.label}: {item.entries.length}
                      </span>
                    ))}
                  </div>
                  {[
                    ...bulkCogPathSummary.c1Review.map((entry) => ({ entry, label: "C1 վերանայում", className: "border-amber-400/25 bg-amber-400/10 text-amber-200" })),
                    ...bulkCogPathSummary.targetReview.map((entry) => ({ entry, label: "Թիրախի վերանայում", className: "border-amber-400/25 bg-amber-400/10 text-amber-200" })),
                    ...bulkCogPathSummary.validationFailed.map((entry) => ({ entry, label: "Վավերացում", className: "border-amber-400/25 bg-amber-400/10 text-amber-200" })),
                    ...bulkCogPathSummary.failed.map((entry) => ({ entry, label: "Սխալ", className: "border-red-400/25 bg-red-400/10 text-red-200" })),
                  ].length > 0 && (
                    <div className="border-t border-white/8 pt-1.5">
                      <p className="mb-1 text-[9px] text-white/55">Ուշադրություն պահանջող հանգույցներ՝</p>
                      <div className="flex flex-wrap gap-1">
                        {[
                          ...bulkCogPathSummary.c1Review.map((entry) => ({ entry, label: "C1 վերանայում", className: "border-amber-400/25 bg-amber-400/10 text-amber-200" })),
                          ...bulkCogPathSummary.targetReview.map((entry) => ({ entry, label: "Թիրախի վերանայում", className: "border-amber-400/25 bg-amber-400/10 text-amber-200" })),
                          ...bulkCogPathSummary.validationFailed.map((entry) => ({ entry, label: "Վավերացում", className: "border-amber-400/25 bg-amber-400/10 text-amber-200" })),
                          ...bulkCogPathSummary.failed.map((entry) => ({ entry, label: "Սխալ", className: "border-red-400/25 bg-red-400/10 text-red-200" })),
                        ].map(({ entry, label, className }) => (
                          <button
                            key={`${label}-${entry.nodeId}`}
                            onClick={() => openCogPathFromBulkResult(entry.nodeId)}
                            title={entry.detail}
                            className={"rounded border px-1.5 py-0.5 text-left text-[9px] font-medium hover:brightness-125 " + className}
                          >
                            {entry.title} · {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
          {/* ── R4A.4: Required session time ────────────────────────────────── */}
          <div className="bg-white/4 border border-white/8 rounded-lg px-3 py-2 space-y-1">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider">⏱ Պարտադիր ուսուցման ժամանակ</p>
              {!rsmEditing && (
                <button
                  onClick={() => { setRsmValue(requiredSessionMinutes != null ? String(requiredSessionMinutes) : ""); setRsmEditing(true); setRsmError(null); }}
                  className="text-xs text-muted-foreground hover:text-white transition-colors"
                  title="Xmbagrел"
                >✏️</button>
              )}
            </div>
            {rsmEditing ? (
              <div className="space-y-1.5">
                <p className="text-[10px] text-muted-foreground/60">Սահմանել դասի տևողությունը րոպեներով.</p>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number" min="1" step="1" placeholder="25"
                    className="w-20 bg-black/30 border border-white/10 rounded-md px-2 py-1 text-xs text-white placeholder-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/50"
                    value={rsmValue}
                    onChange={(e) => { setRsmValue(e.target.value); setRsmError(null); }}
                  />
                  <span className="text-xs text-muted-foreground/60">րոպե</span>
                </div>
                {rsmError && <p className="text-[10px] text-destructive">{rsmError}</p>}
                <div className="flex gap-1">
                  <button
                    disabled={rsmSaving}
                    onClick={async () => {
                      const parsed = parseInt(rsmValue, 10);
                      if (!rsmValue.trim() && rsmValue !== "0") {
                        // Allow clearing
                        setRsmSaving(true);
                        try {
                          const r = await fetch(`/api/teacher/lessons/${lessonId}`, {
                            method: "PUT",
                            headers: { Authorization: `Bearer ${authToken ?? ""}`, "Content-Type": "application/json" },
                            body: JSON.stringify({ requiredSessionMinutes: null }),
                          });
                          if (!r.ok) { const d = await r.json(); setRsmError(d.error ?? "Sxal"); return; }
                          setRsmEditing(false);
                          qc.invalidateQueries({ queryKey: ["teacher-courses"] });
                        } finally { setRsmSaving(false); }
                        return;
                      }
                      if (!Number.isInteger(parsed) || parsed < 1) {
                        setRsmError("Datxel drakan amshakeluyts rope"); return;
                      }
                      setRsmSaving(true);
                      try {
                        const r = await fetch(`/api/teacher/lessons/${lessonId}`, {
                          method: "PUT",
                          headers: { Authorization: `Bearer ${authToken ?? ""}`, "Content-Type": "application/json" },
                          body: JSON.stringify({ requiredSessionMinutes: parsed }),
                        });
                        if (!r.ok) { const d = await r.json(); setRsmError(d.error ?? "Sxal"); return; }
                        setRsmEditing(false);
                        qc.invalidateQueries({ queryKey: ["teacher-courses"] });
                      } finally { setRsmSaving(false); }
                    }}
                    className="px-2 py-1 text-[11px] rounded bg-primary text-black font-medium disabled:opacity-40"
                  >{rsmSaving ? "..." : "Հաստատել"}</button>
                  <button
                    onClick={() => { setRsmEditing(false); setRsmError(null); }}
                    className="px-2 py-1 text-[11px] rounded bg-white/10 text-muted-foreground"
                  >Չեղարկել</button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-white/70">
                {requiredSessionMinutes != null
                  ? `${requiredSessionMinutes} րոպե`
                  : <span className="text-muted-foreground/40 italic">Սահմանված չէ</span>}
              </p>
            )}
          </div>

          {/* ── Lesson Overview / General Theory (Step 5) ───────────────────── */}
          {/* Block is hidden when content is empty and not in edit mode (display-only, no DB change). */}
          {(descEditing || (lessonDescription ?? descValue)?.trim()) && (
          <div className="bg-white/4 border border-white/8 rounded-lg px-3 py-2 space-y-1">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider">📖 Տեսական մաս</p>
              {!descEditing && (
                <button
                  onClick={() => { setDescValue(lessonDescription ?? ""); setDescEditing(true); }}
                  className="text-xs text-muted-foreground hover:text-white transition-colors"
                  title="Խmbagreл"
                >✏️</button>
              )}
            </div>
            {descEditing ? (
              <div className="space-y-1.5">
                <textarea
                  className="w-full bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white placeholder-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/50 resize-none"
                  rows={4}
                  placeholder="Ведите общее описание урока..."
                  value={descValue}
                  onChange={(e) => setDescValue(e.target.value)}
                />
                <div className="flex gap-1">
                  <button
                    disabled={descUpdateMutation.isPending}
                    onClick={() => {
                      descUpdateMutation.mutate(
                        { id: lessonId, data: { description: descValue } },
                        { onSuccess: () => setDescEditing(false) }
                      );
                    }}
                    className="px-2 py-1 text-[11px] rounded bg-primary text-black font-medium disabled:opacity-40"
                  >{descUpdateMutation.isPending ? "..." : "Հաստատել"}</button>
                  <button
                    onClick={() => setDescEditing(false)}
                    className="px-2 py-1 text-[11px] rounded bg-white/10 text-muted-foreground"
                  >Չեղարկել</button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-white/70 leading-relaxed whitespace-pre-wrap">
                {(lessonDescription ?? descValue)?.trim() || <span className="text-muted-foreground/40 italic">Տեքստ առկա չէ</span>}
              </p>
            )}
          </div>
          )}

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
          ) : (
            <div className="space-y-2">
              {nodes.length === 0 && (
                <p className="text-xs text-muted-foreground/60">
                  Node-եր դեռ չկան · օգտագործիր 🗺️ կոճակը
                </p>
              )}
              {/* ── Topic list with drag-to-reorder ── */}
              {reorderSaving && (
                <p className="text-[10px] text-primary/60 text-center">Պահպանվում է...</p>
              )}
              <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleTopicDragEnd}>
                <SortableContext items={topics.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                  {topics.map((topic, tIdx) => {
                    const accent = TOPIC_ACCENTS[tIdx % TOPIC_ACCENTS.length];
                    const topicNodes = sortedNodes.filter((n) => (n as any).topicId === topic.id);
                    const isCollapsed = collapsedTopics.has(topic.id);
                    return (
                      <SortableTopicItem key={topic.id} id={topic.id}>
                        {(dragHandleProps) => (
                          <div className="rounded-lg overflow-hidden" style={{ borderLeft: `3px solid ${accent}` }}>
                            {/* Topic header */}
                            <div
                              className="w-full flex items-center gap-1 px-2 py-1.5"
                              style={{ background: `${accent}18` }}
                            >
                              {/* Drag handle — kept visually distinct from the ▼ expand chevron */}
                              <span
                                {...dragHandleProps}
                                className="text-sm text-white/50 hover:text-white/90 cursor-grab active:cursor-grabbing shrink-0 select-none px-1 leading-none"
                                title="Drag to reorder topic"
                              >⠿</span>

                              {editingTopicId === topic.id ? (
                                <>
                                  <input
                                    className="flex-1 bg-black/40 border border-white/15 rounded px-2 py-0.5 text-xs text-white focus:outline-none focus:border-primary/50"
                                    value={editingTopicTitle}
                                    onChange={(e) => setEditingTopicTitle(e.target.value)}
                                    onClick={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => { if (e.key === "Enter") saveTopic(topic.id, e as any); if (e.key === "Escape") cancelEditTopic(e as any); }}
                                    autoFocus
                                  />
                                  <button onClick={(e) => saveTopic(topic.id, e)} disabled={topicSaving} className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary hover:bg-primary/30 shrink-0 disabled:opacity-40">{topicSaving ? "…" : "✅"}</button>
                                  <button onClick={cancelEditTopic} className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-muted-foreground hover:text-white shrink-0">✕</button>
                                </>
                              ) : (
                                <>
                                  <button
                                    onClick={() => toggleTopic(topic.id)}
                                    className="flex-1 flex items-center gap-2 hover:brightness-105 transition-all"
                                  >
                                    <span className="text-[10px] font-mono text-white/40 w-5 shrink-0">{topic.sequence}.</span>
                                    <span className="text-xs font-bold text-white flex-1 text-left leading-snug">{topic.title}</span>
                                    <span className="text-[10px] text-white/40 shrink-0">{topicNodes.length} ՄՆ</span>
                                    <span className="text-[10px] text-white/30 ml-1">{isCollapsed ? "▶" : "▼"}</span>
                                  </button>
                                  <button
                                    onClick={(e) => startEditTopic(topic, e)}
                                    title="Խmbagreл թema"
                                    className="text-[10px] text-white/30 hover:text-white/70 transition-colors shrink-0 px-1"
                                  >✏️</button>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setDeleteTopicId(topic.id); setDeleteTopicOpen(true); }}
                                    title="Ջnjel thema"
                                    className="text-[10px] text-white/20 hover:text-destructive/70 transition-colors shrink-0 px-1"
                                  >🗑️</button>
                                </>
                              )}
                            </div>

                            {/* Nodes belonging to this topic */}
                            {!isCollapsed && topicNodes.map((n, nIdxInTopic) => {
                              const nodeExercises = exercises.filter((e) => e.relatedNodeId === n.id);
                              const isEditingNode = editingNodeId === n.id;
                              const globalIdx = sortedNodes.findIndex((x) => x.id === n.id);
                              return renderNodeCard(n, nodeExercises, isEditingNode, accent, nIdxInTopic, topicNodes.length, globalIdx);
                            })}
                          </div>
                        )}
                      </SortableTopicItem>
                    );
                  })}
                </SortableContext>
              </DndContext>

              {/* Չկցված գիտելիքի որևէ խմբի */}
              {sortedNodes.filter((n) => (n as any).topicId == null).map((n, nIdxInGroup, arr) => {
                const nodeExercises = exercises.filter((e) => e.relatedNodeId === n.id);
                const isEditingNode = editingNodeId === n.id;
                const globalIdx = sortedNodes.findIndex((x) => x.id === n.id);
                return renderNodeCard(n, nodeExercises, isEditingNode, undefined, nIdxInGroup, arr.length, globalIdx);
              })}
            </div>
          )}

          {/* ── Delete Topic confirm ────────────────────────────────────────── */}
          <AlertDialog open={deleteTopicOpen} onOpenChange={setDeleteTopicOpen}>
            <AlertDialogContent className="bg-[#0f1117] border border-white/10 text-white">
              <AlertDialogHeader>
                <AlertDialogTitle className="text-sm font-semibold text-white">Ջնջե՞լ թեման</AlertDialogTitle>
                <AlertDialogDescription className="text-xs text-muted-foreground leading-relaxed">
                  Թեման կջնջվի։ Դրան պատկանող MicroNode-ները կդառնան ինքնուրույն (standalone)։ Վարժությունները չեն կորի։
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="bg-white/5 border-white/10 text-white hover:bg-white/10 hover:text-white text-xs" disabled={deleteTopicMutation.isPending}>Չեղարկել</AlertDialogCancel>
                <AlertDialogAction onClick={(e) => { e.preventDefault(); handleDeleteTopic(); }} disabled={deleteTopicMutation.isPending} className="bg-destructive text-white hover:bg-destructive/90 text-xs">
                  {deleteTopicMutation.isPending ? "Ջnjvum e..." : "Ջնջել"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* HACK: renderNodeCard is defined below and referenced above — hoisted via closure */}
          {null /* placeholder: renderNodeCard is a local fn defined after this block */}

          {/* ── Step 3 — Additional Exercises (relatedNodeId === null) is rendered below separately */}
          {(() => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const _ = null; // renderNodeCard must be defined before JSX runs — define it here
            return null;
          })()}

          {/* ── HELPER: renderNodeCard (defined as closure — must appear BEFORE JSX uses it) ── */}
          {/* We hoist the function definition before the main return using an IIFE trick.
              React doesn't allow hooks inside functions defined in JSX, but renderNodeCard
              uses only non-hook state and callbacks so this is safe. */}
          {/* NOTE: The actual function is defined below, BEFORE this return statement, as a named nested function. */}

          {/* ── Step 3b — Additional Exercises ─────────────────────────────── */}
          {(() => {
            const additionalExercises = exercises.filter((e) => e.relatedNodeId === null);
            return (
              <div className="bg-white/3 border border-white/8 rounded-xl px-3 py-2 space-y-2">
                <p className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">
                  📦 Լրացուցիչ վարժություններ ({additionalExercises.length})
                </p>
                {additionalExercises.length === 0 ? (
                  <p className="text-xs text-muted-foreground/40 italic">Չկցված վարժություններ չկան</p>
                ) : (
                  <div className="space-y-2">
                    {additionalExercises.map((ex) => {
                      const isEditingEx = editingExerciseId === ex.id;
                      return (
                        <div key={ex.id} className="bg-black/20 rounded-lg px-2 py-1.5">
                          {(ex as any).learnerContentSafe === false && (
                            <div className="mb-1.5 rounded border border-red-400/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-200">
                              Այս վարժությունը չի ցուցադրվի սովորողին, մինչև հեռացվեն պատասխանը կամ գնահատման չափանիշները սովորողի տեքստից։
                            </div>
                          )}
                          {isEditingEx && editExForm ? (
                            <div className="space-y-1.5">
                              {/* P1.6B: show read-only original when editing an adapted textbook exercise */}
                              {(ex as any).sourceType === 'textbook' && (ex as any).exerciseTextEdited && (
                                <div className="bg-black/30 border border-amber-500/20 rounded px-2 py-1.5">
                                  <p className="text-[9px] text-amber-400/60 mb-0.5">📖 Դասագրքից բնօրինակ</p>
                                  <p className="text-[10px] text-white/40 leading-relaxed">{ex.exerciseTextVerbatim}</p>
                                </div>
                              )}
                              <textarea
                                className="w-full bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white placeholder-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/50 resize-none"
                                rows={3}
                                value={editExForm.exerciseTextEdited}
                                onChange={(e) => setEditExForm((f) => f && { ...f, exerciseTextEdited: e.target.value })}
                                placeholder="Սովորողին ցուցադրվող առաջադրանքը՝ առանց պատասխանի կամ գնահատման չափանիշների"
                              />
                              {updateEx.isError && (
                                <p className="text-[10px] text-red-300">{updateEx.error.message}</p>
                              )}
                              <input
                                className="w-full bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white placeholder-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/50"
                                placeholder="Հաջողության չափանիշ / գնահատման ուղեցույց"
                                value={editExForm.successCriteria}
                                onChange={(e) => setEditExForm((f) => f && { ...f, successCriteria: e.target.value })}
                              />
                              <ExerciseAnswerFields
                                interactionType={editExForm.interactionType}
                                correctAnswer={editExForm.correctAnswer}
                                inputClassName="w-full bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white placeholder-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
                                onChange={(interactionType, correctAnswer) =>
                                  setEditExForm((f) => f && { ...f, interactionType, correctAnswer })
                                }
                              />
                              {/* Step 4 — Move to node from additional */}
                              <select
                                className="w-full bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer"
                                value={editExForm.relatedNodeId === null ? "null" : String(editExForm.relatedNodeId)}
                                onChange={(e) => setEditExForm((f) => f && { ...f, relatedNodeId: e.target.value === "null" ? null : parseInt(e.target.value) })}
                              >
                                <option value="null">📦 Չկցված / Լրացուցիչ վարժություն</option>
                                {nodes.map((nd) => (
                                  <option key={nd.id} value={String(nd.id)}>
                                    {nd.sequence}. {nd.title}
                                  </option>
                                ))}
                              </select>
                              <div className="flex gap-1">
                                <button onClick={() => saveEx(ex.id)} disabled={updateEx.isPending} className="px-2 py-1 text-[11px] rounded bg-primary text-black font-medium disabled:opacity-40">{updateEx.isPending ? "..." : "Հաստատել"}</button>
                                <button onClick={() => { setEditingExerciseId(null); setEditExForm(null); }} className="px-2 py-1 text-[11px] rounded bg-white/10 text-muted-foreground">Չեղարկել</button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-start gap-2">
                              <div className="flex-1 min-w-0">
                                <p className="text-xs text-white/90 leading-relaxed">{effectiveText(ex)}</p>
                                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                  {/* P1.6B — source origin badge + reset button */}
                                  {(ex as any).sourceType === 'textbook'
                                    ? <span className="text-[9px] text-blue-400/50">📖 Դասագրքից </span>
                                    : <span className="text-[9px] text-purple-400/50">✍️ ՁԵռքով</span>
                                  }
                                  {(ex as any).exerciseTextEdited && (
                                    <button
                                      onClick={() => resetExEdit(ex.id)}
                                      disabled={updateEx.isPending}
                                      title="Verakangnel bnaginakin"
                                      className="text-[9px] text-amber-400/50 hover:text-amber-300 transition-colors disabled:opacity-40"
                                    >↩ Verakangnel</button>
                                  )}
                                  {ex.difficultyLevel && (
                                    <span className="text-[10px] text-muted-foreground/60">{ex.difficultyLevel}</span>
                                  )}
                                  {ex.assignment && (
                                    <span className={`text-[10px] font-medium ${ex.assignment === "HOMEWORK" ? "text-amber-400/70" : "text-teal-400/70"}`}>
                                      {ex.assignment === "HOMEWORK" ? "🏠 Տնային աշխատանք" : "📋 Դասարանում"}
                                    </span>
                                  )}
                                  {ex.sourcePage && (
                                    <span className="text-[10px] text-muted-foreground/40"> Էջ {ex.sourcePage}</span>
                                  )}
                                  {ex.status !== "approved" && (
                                    <span className="text-[10px] text-amber-400/60">⚠ Վերանայել</span>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                {/* Quick-move selector for Additional block exercises */}
                                {movingExerciseId === ex.id ? (
                                  <select
                                    autoFocus
                                    className="text-[10px] bg-black/40 border border-white/20 rounded px-1 py-0.5 text-white cursor-pointer max-w-[140px]"
                                    onChange={(e) => {
                                      const v = e.target.value;
                                      if (!v) return;
                                      quickMoveExercise(ex.id, v === "null" ? null : parseInt(v, 10));
                                    }}
                                    onBlur={() => setMovingExerciseId(null)}
                                  >
                                    <option value="">→ Տեղափ...</option>
                                    <option value="null">📦 Լրացուցիչ</option>
                                    {nodes.map((nd) => (
                                      <option key={nd.id} value={String(nd.id)}>
                                        {nd.sequence}. {nd.title.substring(0, 28)}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <button
                                    onClick={() => setMovingExerciseId(ex.id)}
                                    className="text-[11px] text-white/30 hover:text-primary/80 transition-colors shrink-0"
                                    title="Տեղափոխել →"
                                  >→</button>
                                )}
                                <button onClick={() => startEditEx(ex)} className="text-xs text-muted-foreground hover:text-white transition-colors" title="Ред.">✏️</button>
                                <button
                                  onClick={() => {
                                    if (!confirm("Ջնջել վարժությունը?")) return;
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

                {/* Add manual exercise directly to Additional Exercises (relatedNodeId = null) */}
                <div className="border-t border-white/6 pt-1.5">
                  {addExToAdditional ? (
                    <div className="space-y-1.5">
                      <textarea
                        className="w-full bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white placeholder-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/50 resize-none"
                        rows={2}
                        placeholder="Վարժության բնագիր *"
                        value={addAdditionalForm.exerciseTextVerbatim}
                        onChange={(e) => setAddAdditionalForm((f) => ({ ...f, exerciseTextVerbatim: e.target.value }))}
                        autoFocus
                      />
                      <input
                        className="w-full bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white placeholder-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/50"
                        placeholder="Հաջողության չափանիշ / գնահատման ուղեցույց"
                        value={addAdditionalForm.successCriteria}
                        onChange={(e) => setAddAdditionalForm((f) => ({ ...f, successCriteria: e.target.value }))}
                      />
                      <ExerciseAnswerFields
                        interactionType={addAdditionalForm.interactionType}
                        correctAnswer={addAdditionalForm.correctAnswer}
                        inputClassName="w-full bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white placeholder-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
                        onChange={(interactionType, correctAnswer) =>
                          setAddAdditionalForm((f) => ({ ...f, interactionType, correctAnswer }))
                        }
                      />
                      <div className="flex gap-2">
                        <select
                          className="bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer"
                          value={addAdditionalForm.difficultyLevel}
                          onChange={(e) => setAddAdditionalForm((f) => ({ ...f, difficultyLevel: e.target.value }))}
                        >
                          <option value="LOW">LOW</option><option value="MEDIUM">MEDIUM</option><option value="HIGH">HIGH</option>
                        </select>
                        <select
                          className="bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer"
                          value={addAdditionalForm.assignment}
                          onChange={(e) => setAddAdditionalForm((f) => ({ ...f, assignment: e.target.value }))}
                        >
                          <option value="CLASS">CLASS</option><option value="HOMEWORK">HOMEWORK</option>
                        </select>
                      </div>
                      <div className="flex gap-1">
                        <button
                          disabled={createEx.isPending || !addAdditionalForm.exerciseTextVerbatim.trim()}
                          onClick={() => {
                            createEx.mutate(
                              {
                                lessonId,
                                data: {
                                  ...addAdditionalForm,
                                  correctAnswer: addAdditionalForm.correctAnswer.trim() || null,
                                  relatedNodeId: null,
                                  difficultyLevel: addAdditionalForm.difficultyLevel as "LOW" | "MEDIUM" | "HIGH",
                                  assignment: addAdditionalForm.assignment as "CLASS" | "HOMEWORK",
                                },
                              },
                              {
                                onSuccess: () => {
                                  setAddExToAdditional(false);
                                  setAddAdditionalForm(emptyExerciseCreateForm());
                                  refreshEx();
                                },
                              }
                            );
                          }}
                          className="px-2 py-1 text-[11px] rounded bg-primary text-black font-medium disabled:opacity-40"
                        >{createEx.isPending ? "..." : "+ Ավելացնել"}</button>
                        <button
                          onClick={() => {
                            setAddExToAdditional(false);
                            setAddAdditionalForm(emptyExerciseCreateForm());
                          }}
                          className="px-2 py-1 text-[11px] rounded bg-white/10 text-muted-foreground"
                        >Չեղարկել</button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setAddExToAdditional(true)}
                      className="text-[11px] text-muted-foreground/50 hover:text-primary/70 transition-colors py-0.5"
                    >+ Ավելացնել վարժություն</button>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Add topic button/form */}
          <div className="pt-1">
            {addTopicOpen ? (
              <div className="bg-background/30 border border-white/10 rounded-xl px-3 py-2 space-y-2">
                <p className="text-xs font-semibold text-muted-foreground">Նոր թեմա</p>
                <input
                  className={fieldCls}
                  placeholder="Թեմայի անվանում *"
                  value={addTopicTitle}
                  onChange={(e) => setAddTopicTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreateTopic(); if (e.key === "Escape") setAddTopicOpen(false); }}
                  autoFocus
                />
                <div className="flex gap-1">
                  <button disabled={createTopicMutation.isPending || !addTopicTitle.trim()} onClick={handleCreateTopic} className={btnSm + " bg-primary text-black disabled:opacity-40"}>{createTopicMutation.isPending ? "..." : "Ավելացնել"}</button>
                  <button onClick={() => { setAddTopicOpen(false); setAddTopicTitle(""); }} className={btnSm + " bg-white/10 text-muted-foreground"}>Չեղարկել</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setAddTopicOpen(true)} className="w-full text-xs text-muted-foreground/50 hover:text-amber-400/70 border border-dashed border-white/8 hover:border-amber-400/30 rounded-xl py-1.5 transition-colors">
                + Ավելացնել թեմա
              </button>
            )}
          </div>


          {/* Add node button/form */}
          <div className="pt-1">
            {addNodeOpen ? (
              <div className="bg-background/30 border border-white/10 rounded-xl px-3 py-2 space-y-2">
                <p className="text-xs font-semibold text-muted-foreground">Նոր գիտելիքի հանգույց</p>
                <input
                  className={fieldCls}
                  placeholder="Վերնագիր *"
                  value={addNodeForm.title}
                  onChange={(e) => setAddNodeForm((f) => ({ ...f, title: e.target.value }))}
                />
                <textarea
                  className={fieldCls + " resize-none"}
                  rows={2}
                  placeholder="Ուսումնական նպատակ (learningObjective)"
                  value={addNodeForm.learningObjective}
                  onChange={(e) => setAddNodeForm((f) => ({ ...f, learningObjective: e.target.value }))}
                />
                <textarea
                  className={fieldCls + " resize-none"}
                  rows={2}
                  placeholder="Տեսական մաս"
                  value={addNodeForm.theoryContent}
                  onChange={(e) => setAddNodeForm((f) => ({ ...f, theoryContent: e.target.value }))}
                />
                <select
                  className={fieldCls + " cursor-pointer"}
                  value={addNodeForm.topicId === null ? "null" : String(addNodeForm.topicId)}
                  onChange={(e) => setAddNodeForm((f) => ({ ...f, topicId: e.target.value === "null" ? null : parseInt(e.target.value) }))}
                >
                  <option value="null">📌 Չկցված գիտելիքի որևէ խմբի (no topic)</option>
                  {topics.map((t) => (
                    <option key={t.id} value={String(t.id)}>{t.sequence}. {t.title}</option>
                  ))}
                </select>
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
                        {
                          lessonId,
                          data: {
                            title: addNodeForm.title.trim(),
                            learningObjective: addNodeForm.learningObjective || undefined,
                            theoryContent: addNodeForm.theoryContent || undefined,
                            targetBloomLevel: parseInt(addNodeForm.targetBloomLevel) || 1,
                            topicId: addNodeForm.topicId ?? undefined,
                          },
                        },
                        { onSuccess: () => { setAddNodeOpen(false); setAddNodeForm({ title: "", theoryContent: "", targetBloomLevel: "1", topicId: null, learningObjective: "" }); refreshNodes(); } }
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
              >+ Ավելացնել գիտելիքի հանգույց</button>
            )}
          </div>
        </div>
      )}

      {/* P1.9: Linked tests section — always visible, collapsible */}
      <div className="border-t border-white/8">
        <button
          onClick={() => setLinkedTestsOpen((o) => !o)}
          className="w-full flex items-center justify-between px-4 py-2 text-xs text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
        >
          <span className="font-medium tracking-wide">
            {linkedTestsLoading
              ? "📝 Թեստեր..."
              : `📝 Թեստեր${linkedTests.length > 0 ? ` (${linkedTests.length})` : ""}`}
          </span>
          <span>{linkedTestsOpen ? "▲" : "▼"}</span>
        </button>

        {linkedTestsOpen && (
          <div className="px-4 pb-3 space-y-1.5">
            {linkedTestsLoading ? (
              <p className="text-xs text-muted-foreground/50 py-1">Բеռнвum е...</p>
            ) : linkedTests.length === 0 ? (
              <p className="text-xs text-muted-foreground/40 py-1">Թեստեր չկան</p>
            ) : (
              linkedTests.map((q) => {
                const effectiveClassId = q.classId ?? lessonClassId;
                const isAssigned = q.status === "ASSIGNED";
                const hasResults = q.completedCount > 0;
                const allDone    = isAssigned && q.totalAssigned > 0 && q.completedCount >= q.totalAssigned;
                return (
                  <div
                    key={q.id}
                    className="flex items-start gap-2 bg-white/3 border border-white/8 rounded-lg px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-white/80 truncate font-medium">{q.title}</p>
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        <span className="text-[9px] text-muted-foreground/60 uppercase tracking-wide">
                          {q.quizType === "lesson" ? "Դասի թեստ" : q.quizType === "summary" ? "Ամփոփ թест" : "—"}
                        </span>
                        <span className="text-muted-foreground/30 text-[9px]">·</span>
                        <span className="text-[9px] text-muted-foreground/60">{q.questionCount} հարց.</span>
                      </div>
                      {/* Live completion status — same data as global Tests section */}
                      {isAssigned && q.totalAssigned > 0 ? (
                        <p className="text-[10px] mt-1 text-muted-foreground leading-tight">
                          {allDone
                            ? <span className="text-emerald-400 font-medium">Ավարտված</span>
                            : <span className="text-blue-400">Ուղարկված</span>
                          }
                          {" · "}{q.completedCount}/{q.totalAssigned} ավարտել են
                          {hasResults && q.averageScorePercent !== null && (
                            <> · Միջին՝ <span className="text-white/80">{q.averageScorePercent}%</span></>
                          )}
                        </p>
                      ) : isAssigned ? (
                        <p className="text-[10px] mt-1 text-blue-400">Ուղարկված · 0/? ավարտել են</p>
                      ) : null}
                    </div>
                    <div className="flex flex-col gap-1 shrink-0">
                      {/* Release button — only when not yet assigned */}
                      {!isAssigned && effectiveClassId !== null && (
                        <button
                          onClick={async () => {
                            const tok = authToken ?? localStorage.getItem("myaiteacher_token") ?? "";
                            const r = await fetch(`/api/quizzes/${q.id}/assign`, {
                              method: "POST",
                              headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
                              body: JSON.stringify({ classId: effectiveClassId }),
                            });
                            if (r.ok) {
                              setLinkedTests((prev) => prev.map((x) =>
                                x.id === q.id ? { ...x, status: "ASSIGNED" } : x
                              ));
                            }
                          }}
                          className="text-[10px] px-2 py-1 rounded bg-amber-400/15 text-amber-400 hover:bg-amber-400/25 transition-colors border border-amber-400/20 whitespace-nowrap"
                        >
                          Ուղարկել
                        </button>
                      )}
                      {/* View button — always shown */}
                      <button
                        onClick={() => setLocation(`/quiz/${q.id}/review?classId=${effectiveClassId ?? ""}&subjectId=${lessonSubjectId ?? ""}`)}
                        className="text-[10px] px-2 py-1 rounded bg-primary/15 text-primary hover:bg-primary/25 transition-colors border border-primary/20 whitespace-nowrap"
                      >
                        Դիտել
                      </button>
                      {/* Results button — shown when ≥1 student completed; opens same panel as global Tests section */}
                      {hasResults && onOpenResults && (
                        <button
                          onClick={() => onOpenResults(q.id)}
                          className="text-[10px] px-2 py-1 rounded bg-teal-500/15 text-teal-400 hover:bg-teal-500/25 transition-colors border border-teal-500/20 whitespace-nowrap"
                        >
                          Արդյունքներ
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    {/* 👁 POST-P1.12: Read-only node view modal — fixed-position overlay, rendered inside root */}
    {viewingNodeData && (
      <NodeViewModal
        node={viewingNodeData.node}
        exercises={viewingNodeData.exercises}
        onClose={() => setViewingNodeData(null)}
        onEdit={() => {
          const currentNode = nodes.find((node) => node.id === viewingNodeData.node.id);
          if (!currentNode) return;
          setViewingNodeData(null);
          startEditNode(currentNode);
        }}
      />
    )}
    </div>
  );
}
type AssignmentReviewIssue = {
  messageArm?: string;
  message?: string;
};

function LessonAssignmentAction({
  lessonId,
  courseId,
  authoringStatus,
}: {
  lessonId: number;
  courseId: number;
  authoringStatus: string;
}) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [reviewIssues, setReviewIssues] = useState<AssignmentReviewIssue[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshLessons = async () => {
    await queryClient.invalidateQueries({ queryKey: getGetCourseLessonsQueryKey(courseId) });
  };

  const activateLesson = async () => {
    const response = await fetch(`/api/teacher/lessons/${lessonId}/status`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token ?? ""}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    const data = await response.json().catch(() => ({})) as { message?: string; error?: string };
    if (!response.ok) throw new Error(data.message ?? data.error ?? "Դասը չհաջողվեց հանձնարարել։");
    await refreshLessons();
  };

  const runAssignmentPreflight = async (confirmReviewIssues = false) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      if (authoringStatus === "approved") {
        await activateLesson();
        return;
      }
      const response = await fetch(`/api/lessons/${lessonId}/final-approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token ?? ""}`, "Content-Type": "application/json" },
        body: JSON.stringify(confirmReviewIssues ? { confirmReviewIssues: true } : {}),
      });
      const data = await response.json().catch(() => ({})) as {
        approved?: boolean;
        confirmationRequired?: boolean;
        reviewIssues?: AssignmentReviewIssue[];
        overrideable?: AssignmentReviewIssue[];
        warnings?: AssignmentReviewIssue[];
        errors?: AssignmentReviewIssue[];
      };
      if (data.approved) {
        setReviewIssues(null);
        await activateLesson();
        return;
      }
      if (response.status === 409 && data.confirmationRequired) {
        setReviewIssues(data.reviewIssues ?? [...(data.overrideable ?? []), ...(data.warnings ?? [])]);
        return;
      }
      const issues = data.errors ?? [];
      setError(
        issues.map((issue) => issue.messageArm ?? issue.message).filter(Boolean).join(" ")
        || "Դասը դեռ պատրաստ չէ հանձնարարելու համար։",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Կապի սխալ։ Կրկին փորձեք։");
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <div className="flex flex-col items-end gap-1">
        <button
          onClick={() => { void runAssignmentPreflight(); }}
          disabled={pending}
          className="px-2 py-1 rounded-lg text-xs bg-primary/15 text-primary hover:bg-primary/25 transition-colors border border-primary/20 disabled:opacity-50"
        >
          {pending ? "Ստուգվում է..." : "Հանձնարարել սովորողին"}
        </button>
        {error && <p className="max-w-56 text-right text-[10px] leading-snug text-destructive">{error}</p>}
      </div>
      <AlertDialog
        open={reviewIssues !== null}
        onOpenChange={(open) => { if (!open && !pending) setReviewIssues(null); }}
      >
        <AlertDialogContent className="border-amber-400/20 bg-[#0f1117] text-white">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base text-amber-200">
              Դասում կան վերանայման ենթակա կետեր
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm leading-relaxed text-white/70">
              Կարող եք վերադառնալ և վերանայել, կամ մեկ անգամ հաստատել ու հանձնարարել դասը։
              Հաստատելու դեպքում նշումները կպահպանվեն որպես ձեր տեղեկացված որոշում։
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
            {(reviewIssues ?? []).slice(0, 6).map((issue, index) => (
              <p key={index} className="rounded border border-amber-400/15 bg-amber-400/[0.06] px-2 py-1.5 text-[11px] leading-relaxed text-amber-100">
                {issue.messageArm ?? issue.message ?? "Վերանայում է պահանջվում։"}
              </p>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={pending}
              onClick={() => setReviewIssues(null)}
              className="border-white/15 bg-white/5 text-white hover:bg-white/10"
            >
              Վերադառնալ և վերանայել
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                void runAssignmentPreflight(true);
              }}
              className="bg-amber-500 text-black hover:bg-amber-400"
            >
              {pending ? "Հանձնարարում է..." : "Հաստատել և հանձնարարել"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function LessonGoalOutcomesPanel({
  lessonId,
  lessonGoal,
  lessonOutcomes,
}: {
  lessonId: number;
  lessonGoal: string;
  lessonOutcomes: string[];
}) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [goalDraft, setGoalDraft] = useState(lessonGoal ?? "");
  const [outcomeDrafts, setOutcomeDrafts] = useState<Array<{ id: number | null; outcomeText: string }>>([]);
  const [draftVersion, setDraftVersion] = useState<string | null>(null);
  const [editingGoal, setEditingGoal] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  type ReviewState = {
    lessonGoal: string;
    status: "legacy" | "draft" | "proposed" | "confirmed" | "needs_review";
    requiresConfirmation: boolean;
    confirmedAt: string | null;
    proposal: { lessonGoal: string; outcomes: string[]; generatedAt?: string } | null;
    outcomes: string[];
    outcomeRecords?: Array<{ id: number; outcomeText: string }>;
    draftVersion?: string;
    hasUsableCurrentDraft: boolean;
    currentOutcomeCount: number;
    compatibility: string;
  };
  const reviewQuery = useQuery({
    queryKey: ["goal-outcome-review", lessonId],
    enabled: open && !!token,
    queryFn: async () => {
      const response = await fetch(`/api/lessons/${lessonId}/goal-outcome-review`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("Չհաջողվեց բեռնել նպատակի վերանայումը։");
      return response.json() as Promise<ReviewState>;
    },
  });
  const review = reviewQuery.data;
  const draftState = getGoalOutcomeDraftState({
    lessonGoal: review?.lessonGoal,
    outcomes: review?.outcomes,
    hasProposal: Boolean(review?.proposal),
  });
  const persistedOutcomes = draftState.outcomes;
  const { hasSavedGoal, hasSavedOutcomes, hasSavedDraft, hasPartialSavedDraft } = draftState;
  const startEditing = () => {
    const outcomeRecords = review?.outcomeRecords ?? [];
    if (outcomeRecords.length !== persistedOutcomes.length || !review?.draftVersion) {
      setError("Վերջնարդյունքների վերջին ցանկը դեռ չի բեռնվել։ Խնդրում ենք փակել և նորից բացել բաժինը։");
      return;
    }
    setError(null);
    setGoalDraft(review?.lessonGoal ?? "");
    setOutcomeDrafts(outcomeRecords.map((outcome) => ({
      id: outcome.id,
      outcomeText: outcome.outcomeText,
    })));
    setDraftVersion(review.draftVersion);
    setEditingGoal(true);
  };
  const request = async (path: string, body?: Record<string, unknown>) => {
    const response = await fetch(`/api/lessons/${lessonId}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token ?? ""}`, "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = await response.json().catch(() => ({})) as { error?: string; message?: string };
    if (!response.ok) throw new Error(data.message ?? data.error ?? "Գործողությունը չհաջողվեց։");
    return data;
  };
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await Promise.all([
        reviewQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["canonical-lesson-outcomes", lessonId] }),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Գործողությունը չհաջողվեց։");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-t border-white/8">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-2 text-xs text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
      >
        <span className="font-medium tracking-wide">🎯 Նպատակ և վերջնարդյունքներ</span>
        <span>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Պահպանված նպատակն ու վերջնարդյունքները դասի ընթացիկ աշխատանքային սևագիրն են։ Դրանք կարող եք խմբագրել կամ հեռացնել։
          </p>
          {error && <div className="rounded border border-red-400/30 bg-red-400/10 p-2 text-[11px] text-red-200">{error}</div>}
          {reviewQuery.isLoading && <p className="text-xs text-muted-foreground">Բեռնվում է…</p>}
          {review && (
            <>
              {hasPartialSavedDraft && (
                <div className="rounded border border-amber-400/25 bg-amber-400/10 px-2.5 py-2 text-[11px] text-amber-100">
                  ⚠️ Նպատակը պահպանված է, բայց վերջնարդյունքները բացակայում են։ Ավելացրեք դրանք ստորև, կամ ջնջեք սևագիրն ու ստեղծեք նորը։
                </div>
              )}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-secondary/70 font-medium">Դասի նպատակ</span>
                  {!editingGoal && (hasSavedGoal || hasSavedOutcomes) && (
                    <div className="flex items-center gap-2">
                      <button onClick={startEditing} className="text-[10px] text-muted-foreground hover:text-white">✏️ Խմբագրել</button>
                      <button disabled={busy} onClick={() => setDeleteOpen(true)} className="text-[10px] text-red-200 hover:text-red-100 disabled:opacity-50">🗑️ Ջնջել</button>
                    </div>
                  )}
                </div>
                {editingGoal ? (
                  <div className="space-y-1.5">
                    <textarea
                      rows={2}
                      value={goalDraft}
                      onChange={(event) => setGoalDraft(event.target.value)}
                      placeholder="Ուսուցչի նպատակային սևագիր (ընտրովի)"
                      className="w-full rounded border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-white"
                    />
                    <div className="space-y-1.5 rounded border border-white/8 bg-black/10 p-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-secondary/70 font-medium">Վերջնարդյունքներ</span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setOutcomeDrafts((outcomes) => [...outcomes, { id: null, outcomeText: "" }])}
                          className="text-[10px] text-primary hover:text-primary/80 disabled:opacity-50"
                        >＋ Ավելացնել</button>
                      </div>
                      {outcomeDrafts.length === 0 && (
                        <p className="text-[10px] italic text-amber-100/80">Վերջնարդյունք դեռ չկա։ Ավելացրեք առնվազն մեկը կամ չեղարկեք խմբագրումը։</p>
                      )}
                      {outcomeDrafts.map((outcome, index) => (
                        <div key={outcome.id ?? `new-${index}`} className="flex items-start gap-1.5">
                          <span className="pt-1.5 text-[10px] text-muted-foreground">{index + 1}.</span>
                          <textarea
                            rows={2}
                            value={outcome.outcomeText}
                            onChange={(event) => setOutcomeDrafts((outcomes) => outcomes.map((current, currentIndex) => (
                              currentIndex === index ? { ...current, outcomeText: event.target.value } : current
                            )))}
                            placeholder="Վերջնարդյունք"
                            className="min-w-0 flex-1 rounded border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-white"
                          />
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setOutcomeDrafts((outcomes) => outcomes.filter((_, currentIndex) => currentIndex !== index))}
                            className="mt-1 rounded px-1.5 py-1 text-[10px] text-red-200 hover:bg-red-400/10 hover:text-red-100 disabled:opacity-50"
                            aria-label={`Հեռացնել ${index + 1}-րդ վերջնարդյունքը`}
                          >Հեռացնել</button>
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-1">
                      <button
                        disabled={busy}
                        onClick={() => void run(async () => {
                          if (outcomeDrafts.some((outcome) => !outcome.outcomeText.trim())) {
                            throw new Error("Լրացրեք կամ հեռացրեք դատարկ վերջնարդյունքները։");
                          }
                          if (!draftVersion) {
                            throw new Error("Վերջնարդյունքների վերջին ցանկը դեռ չի բեռնվել։ Խնդրում ենք կրկին բացել բաժինը։");
                          }
                          await request("/goal-outcome-review/draft", {
                            lessonGoal: goalDraft,
                            draftVersion,
                            outcomes: outcomeDrafts.map((outcome) => ({
                              id: outcome.id,
                              outcomeText: outcome.outcomeText,
                            })),
                          });
                          setEditingGoal(false);
                          setOutcomeDrafts([]);
                          setDraftVersion(null);
                        })}
                        className="rounded bg-primary/20 px-2 py-1 text-[10px] text-primary disabled:opacity-50"
                      >Պահպանել</button>
                      <button onClick={() => { setEditingGoal(false); setOutcomeDrafts([]); setDraftVersion(null); setGoalDraft(review.lessonGoal); }} className="rounded bg-white/5 px-2 py-1 text-[10px] text-muted-foreground">Չեղարկել</button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-white">{review.lessonGoal || <span className="italic text-muted-foreground">Նպատակ դեռ չկա</span>}</p>
                )}
              </div>

              {!editingGoal && hasSavedOutcomes && (
                <div>
                  <div className="text-[11px] text-secondary/70 font-medium mb-0.5">Պահպանված վերջնարդյունքներ</div>
                  <ul className="list-disc list-inside space-y-0.5">
                    {persistedOutcomes.map((outcome, index) => <li key={`${outcome}-${index}`} className="text-xs text-white">{outcome}</li>)}
                  </ul>
                </div>
              )}

              {draftState.canCreateOrPropose && (
                <div className="flex flex-wrap gap-1.5">
                  <button
                    disabled={busy}
                    onClick={() => void run(() => request("/goal-outcome-review/proposal"))}
                    className="rounded border border-blue-400/30 bg-blue-400/10 px-2 py-1 text-[10px] text-blue-100 hover:bg-blue-400/20 disabled:opacity-50"
                  >✨ Աղբյուրից առաջարկել</button>
                  {draftState.canImportProposal && (
                    <button
                      disabled={busy}
                      onClick={() => void run(() => request("/goal-outcome-review/apply-proposal"))}
                      className="rounded border border-primary/30 bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20 disabled:opacity-50"
                    >Ներմուծել որպես draft</button>
                  )}
                </div>
              )}
              {review.proposal && draftState.canCreateOrPropose && (
                <div className="rounded border border-blue-400/20 bg-blue-400/[0.05] p-2 space-y-1.5">
                  <p className="text-[10px] font-medium text-blue-200">Աղբյուրային AI առաջարկ — դեռ draft է</p>
                  <p className="text-[11px] text-white/90">{review.proposal.lessonGoal}</p>
                  <ul className="list-disc list-inside text-[11px] text-white/75">
                    {review.proposal.outcomes.map((outcome, index) => <li key={index}>{outcome}</li>)}
                  </ul>
                </div>
              )}
            </>
          )}
          {lessonOutcomes.length > 0 && !review && (
            <div>
              <div className="text-[11px] text-secondary/70 font-medium mb-0.5">Նախկին վերջնարդյունքներ</div>
              <ul className="list-disc list-inside space-y-0.5">
                {lessonOutcomes.map((outcome, index) => <li key={index} className="text-xs text-white">{outcome}</li>)}
              </ul>
            </div>
          )}
          {review?.confirmedAt && <p className="text-[10px] text-emerald-300/70">Վերջին հաստատումը՝ {new Date(review.confirmedAt).toLocaleString()}</p>}
        </div>
      )}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent className="bg-[#0f1117] border border-white/10 text-white">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Ջնջե՞լ նպատակն ու վերջնարդյունքները</AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-muted-foreground leading-relaxed">
              Դասի պահպանված նպատակն ու վերջնարդյունքները կհեռացվեն։ Դրանից հետո կարող եք նորից ստեղծել կամ լրացնել դրանք։
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-white/5 border-white/10 text-white hover:bg-white/10 hover:text-white text-xs">Չեղարկել</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void run(async () => {
                  await request("/goal-outcome-review/delete");
                  setGoalDraft("");
                  setEditingGoal(false);
                  setOutcomeDrafts([]);
                  setDraftVersion(null);
                  setDeleteOpen(false);
                });
              }}
              className="bg-destructive text-white hover:bg-destructive/90 text-xs"
            >Ջնջել</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type MappingAuditReport = {
  generatedAt?: string;
  counts?: {
    providerBlocksExtracted?: number;
    verifiedSourceBlocks?: number;
    quarantinedSourceBlocks?: number;
    pass1BlocksExtracted?: number;
    pass2InputBlocks?: number;
    topicsCreated?: number;
    microNodesCreated?: number;
    exercisesCreated?: number;
  };
  quality?: {
    instructionalCoverage?: {
      valid: boolean;
      readableInstructionalBlocks: number;
      microNodeOwnedInstructionalBlocks: number;
      unresolvedInstructionalIndices: number[];
      dispositionCounts: Record<string, number>;
    };
    outcomeAlignmentAudit?: {
      confirmedOutcomes: number;
      persistedAlignments: number;
      requiredAlignments: number;
      supportingAlignments: number;
      requiresTeacherReview: boolean;
      reviewedAt?: string | null;
    };
    sourceAudit?: {
      sourceSet?: {
        resourceId: number;
        pagesFrom: number;
        pagesTo: number;
        pages: Array<{ pageNumber: number; characterCount: number }>;
        titleMatch: {
          valid: boolean;
          matchedTokenCount: number;
          requiredTokenCount: number;
          tableOfContentsPageCount: number;
        };
      };
      sourceScope?: {
        valid: boolean;
        checkedBlockCount: number;
        invalidBlockIndices: number[];
        invalidPageCount: number;
        unverifiableTextCount: number;
      };
      physicalPageProvenance?: {
        providerBlockCount?: number;
        verifiedBlockCount?: number;
        quarantinedBlockCount?: number;
        pass2InputBlockCount?: number;
      };
    };
    granularityConsolidation?: {
      beforeMicroNodeCount: number;
      afterMicroNodeCount: number;
      mergedMicroNodeCount: number;
    };
    exerciseProvenance?: {
      total: number;
      textbookSourced: number;
      unverified: number;
    };
    teachingContentReview?: {
      draftCandidates: number;
      approvedCandidates: number;
      candidatesWithoutReview: number;
    };
    pedagogicalReview?: {
      required: boolean;
      atomicityFindings?: Array<{ nodeId: number | null; reasonCode: string }>;
      reviewUnavailable?: { reasonCode: string; reason: string } | null;
      duplicatePairs?: Array<{
        nodeIds: number[];
        reasonCode: string;
        disposition?: "REVIEW_REQUIRED";
        reviewRejected?: boolean;
      }>;
    };
    sourceAlignment?: {
      valid: boolean;
      sufficientCount: number;
      partialCount: number;
      insufficientCount: number;
      unreadableCount: number;
      nodes: Array<{
        nodeId: number;
        status: string;
        reasonCode: string;
        reviewStatus?: "RESOLVED_BY_TEACHER";
      }>;
    };
  };
};

function MappingAuditPanel({ lessonId }: { lessonId: number }) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmingReview, setConfirmingReview] = useState(false);
  const auditQuery = useQuery({
    queryKey: ["lesson-mapping-audit", lessonId],
    enabled: open && !!token,
    queryFn: async () => {
      const response = await fetch(`/api/lessons/${lessonId}/mapping-report`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("Չհաջողվեց բեռնել աղբյուրային աուդիտը։");
      return response.json() as Promise<MappingAuditReport>;
    },
  });
  const report = auditQuery.data;
  const coverage = report?.quality?.instructionalCoverage;
  const alignment = report?.quality?.outcomeAlignmentAudit;
  const sourceSet = report?.quality?.sourceAudit?.sourceSet;
  const sourceScope = report?.quality?.sourceAudit?.sourceScope;
  const sourceVerification = report?.quality?.sourceAudit?.physicalPageProvenance;
  const consolidation = report?.quality?.granularityConsolidation;
  const exerciseProvenance = report?.quality?.exerciseProvenance;
  const teachingContentReview = report?.quality?.teachingContentReview;
  const pedagogicalReview = report?.quality?.pedagogicalReview;
  const sourceAlignment = report?.quality?.sourceAlignment;
  const unresolvedSourceAlignmentCount = sourceAlignment?.nodes.filter(
    (node) => node.status !== "SUFFICIENT" && node.reviewStatus !== "RESOLVED_BY_TEACHER",
  ).length ?? 0;
  const confirmOutcomeReview = async () => {
    setConfirmingReview(true);
    try {
      const response = await fetch(`/api/lessons/${lessonId}/outcome-alignment-review/confirm`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (!response.ok) throw new Error("Չհաջողվեց հաստատել վերջնարդյունքների կապերի վերանայումը։");
      await queryClient.invalidateQueries({ queryKey: ["lesson-mapping-audit", lessonId] });
    } finally {
      setConfirmingReview(false);
    }
  };
  return (
    <div className="border-t border-white/8">
      <button
        onClick={() => setOpen((value) => !value)}
        className="w-full flex items-center justify-between px-4 py-2 text-xs text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
      >
        <span className="font-medium tracking-wide">🔎 Աղբյուրի և քարտեզի աուդիտ</span>
        <span>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-2">
          {auditQuery.isLoading && <p className="text-xs text-muted-foreground">Բեռնվում է…</p>}
          {auditQuery.isError && <p className="text-xs text-destructive">Չհաջողվեց բեռնել աուդիտը։</p>}
          {report && !coverage && (
            <p className="text-[11px] text-muted-foreground">Այս դասի համար դեռ նոր աղբյուրային աուդիտ չկա։</p>
          )}
          {coverage && (
            <>
              <div className={`rounded border p-2 text-[11px] ${
                coverage.valid
                  ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-100"
                  : "border-red-400/30 bg-red-400/10 text-red-100"
              }`}>
                {coverage.valid
                  ? "✅ Բոլոր ընթեռնելի ուսումնական հատվածները ունեն MicroNode պատասխանատու։"
                  : `⛔ ${coverage.unresolvedInstructionalIndices.length} ուսումնական հատված դեռ պատասխանատու չունի։`}
              </div>
              <div className="flex flex-wrap gap-1.5 text-[10px]">
                <span className="rounded bg-white/5 px-2 py-1">Աղբյուրային բլոկներ՝ {sourceVerification?.providerBlockCount ?? report.counts?.providerBlocksExtracted ?? report.counts?.pass1BlocksExtracted ?? "—"}</span>
                {sourceVerification && (
                  <>
                    <span className="rounded bg-emerald-400/10 px-2 py-1 text-emerald-100">Հաստատված՝ {sourceVerification.verifiedBlockCount ?? "—"}</span>
                    <span className="rounded bg-amber-400/10 px-2 py-1 text-amber-100">Մեկուսացված՝ {sourceVerification.quarantinedBlockCount ?? "—"}</span>
                    <span className="rounded bg-white/5 px-2 py-1">Pass 2 մուտք՝ {sourceVerification.pass2InputBlockCount ?? "—"}</span>
                  </>
                )}
                <span className="rounded bg-white/5 px-2 py-1">Ուսումնական՝ {coverage.readableInstructionalBlocks}</span>
                <span className="rounded bg-white/5 px-2 py-1">MicroNode-ով՝ {coverage.microNodeOwnedInstructionalBlocks}</span>
                <span className="rounded bg-white/5 px-2 py-1">Կառուցվածքային/տեսողական՝ {(coverage.dispositionCounts.LEGITIMATE_NON_INSTRUCTIONAL ?? 0) + (coverage.dispositionCounts.UNREADABLE ?? 0)}</span>
              </div>
              {sourceSet && sourceScope && (
                <div className={`rounded border p-2 text-[10px] ${
                  sourceSet.titleMatch.valid && sourceScope.valid
                    ? "border-emerald-400/20 bg-emerald-400/5 text-emerald-100"
                    : "border-amber-400/30 bg-amber-400/10 text-amber-100"
                }`}>
                  <div className="font-medium">
                    Աղբյուրի շրջանակ՝ ռեսուրս #{sourceSet.resourceId} · PDF էջեր {sourceSet.pagesFrom}–{sourceSet.pagesTo}
                    {sourceSet.titleMatch.valid && sourceScope.valid ? " · հաստատված" : " · վերանայում է պահանջվում"}
                  </div>
                  <div className="mt-1 opacity-85">
                    Ստուգված բլոկներ՝ {sourceScope.checkedBlockCount} · Չհաստատված՝ {sourceScope.invalidBlockIndices.length} ·
                    Բովանդակության էջեր՝ {sourceSet.titleMatch.tableOfContentsPageCount}
                  </div>
                </div>
              )}
              {consolidation && (
                <div className="rounded border border-violet-400/20 bg-violet-400/[0.05] p-2 text-[10px] text-violet-100">
                  MicroNode մանրացում՝ {consolidation.beforeMicroNodeCount} → {consolidation.afterMicroNodeCount}
                  {consolidation.mergedMicroNodeCount > 0
                    ? ` · ${consolidation.mergedMicroNodeCount} հիմնավորված միավորում`
                    : " · ավտոմատ միավորում չի պահանջվել"}
                </div>
              )}
              {exerciseProvenance && (
                <div className={`rounded border p-2 text-[10px] ${
                  exerciseProvenance.unverified === 0
                    ? "border-emerald-400/20 bg-emerald-400/5 text-emerald-100"
                    : "border-amber-400/30 bg-amber-400/10 text-amber-100"
                }`}>
                  Վարժությունների աղբյուր՝ {exerciseProvenance.textbookSourced}/{exerciseProvenance.total} դասագրքից
                  {exerciseProvenance.unverified > 0
                    ? ` · ${exerciseProvenance.unverified} պահանջում է ստուգում`
                    : " · բոլորն ունեն հաստատված աղբյուր"}
                </div>
              )}
              {teachingContentReview && (
                <div className="rounded border border-amber-400/25 bg-amber-400/[0.06] p-2 text-[10px] text-amber-100">
                  Ուսուցման փաթեթի վերանայում՝ {teachingContentReview.draftCandidates} սևագիր թեկնածու
                  {teachingContentReview.approvedCandidates > 0
                    ? ` · ${teachingContentReview.approvedCandidates} ուսուցչի կողմից հաստատված`
                    : " · գեներացումը ինքնուրույն հաստատում չէ"}
                  {teachingContentReview.candidatesWithoutReview > 0
                    ? ` · ${teachingContentReview.candidatesWithoutReview} այլ կարգավիճակով`
                    : ""}
                </div>
              )}
              {pedagogicalReview?.required && (
                <div className="rounded border border-amber-400/35 bg-amber-400/[0.10] p-2 text-[10px] text-amber-50">
                  <div className="font-medium">
                    ⚠ Քարտեզագրումը պահպանվել է, սակայն որոշ MicroNode-ներ պահանջում են ուսուցչի վերանայում։
                  </div>
                  <div className="mt-1 opacity-85">
                    {pedagogicalReview.duplicatePairs?.length
                      ? `Կրկնվող/մասնատված թեկնածու զույգեր՝ ${pedagogicalReview.duplicatePairs.length}։ `
                      : ""}
                    {pedagogicalReview.atomicityFindings?.length
                      ? `Մանրացման դիտարկումներ՝ ${pedagogicalReview.atomicityFindings.length}։ `
                      : ""}
                    {pedagogicalReview.reviewUnavailable
                      ? "Սեմանտիկ ստուգումը չի ավարտվել, ուստի քարտեզը պահպանվել է վերանայման կարգավիճակով։"
                      : "Ազդված MicroNode-ները նշված են needs_review կարգավիճակով։"}
                  </div>
                </div>
              )}
              {sourceAlignment && (
                <div className={`rounded border p-2 text-[10px] ${
                  unresolvedSourceAlignmentCount === 0
                    ? "border-emerald-400/20 bg-emerald-400/[0.05] text-emerald-100"
                    : "border-amber-400/30 bg-amber-400/[0.08] text-amber-100"
                }`}>
                  Աղբյուրային հիմնավորում՝ {sourceAlignment.sufficientCount} բավարար
                  {unresolvedSourceAlignmentCount > 0
                    ? ` · ${unresolvedSourceAlignmentCount} վերանայում է պահանջում`
                    : " · բոլոր MicroNode-ները հաստատված կամ ուսուցչի կողմից վերանայված են"}
                  {(sourceAlignment.partialCount + sourceAlignment.insufficientCount + sourceAlignment.unreadableCount) > 0 && (
                    <div className="mt-1 opacity-85">
                      Մասնակի՝ {sourceAlignment.partialCount} · Անբավարար՝ {sourceAlignment.insufficientCount} · Անընթեռնելի՝ {sourceAlignment.unreadableCount}
                    </div>
                  )}
                </div>
              )}
              {alignment && (
                <div className="rounded border border-blue-400/20 bg-blue-400/[0.05] p-2 text-[10px] text-blue-100">
                  Վերջնարդյունքների կապեր՝ {alignment.persistedAlignments} ({alignment.requiredAlignments} REQUIRED, {alignment.supportingAlignments} SUPPORTING) ·
                  {alignment.requiresTeacherReview
                    ? " ուսուցչի վերանայում է պահանջվում"
                    : ` վերանայված${alignment.reviewedAt ? `՝ ${new Date(alignment.reviewedAt).toLocaleString()}` : ""}`}
                  {alignment.requiresTeacherReview && (
                    <button
                      disabled={confirmingReview}
                      onClick={() => void confirmOutcomeReview()}
                      className="ml-2 rounded border border-blue-300/30 bg-blue-300/10 px-1.5 py-0.5 text-[10px] text-blue-50 hover:bg-blue-300/20 disabled:opacity-50"
                    >
                      {confirmingReview ? "Հաստատվում է…" : "Վերանայեցի կապերը"}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

type CanonicalOutcomeAlignment = {
  id: number;
  lessonNodeId: number;
  role: "REQUIRED" | "SUPPORTING";
  requiredCognitiveDepth: string;
  node: {
    id: number;
    title: string;
    sequence: number;
    status: string;
    cogPathStatus: string | null;
    capacity: { depth: string; source: string; isConfirmed: boolean } | null;
  } | null;
  warnings: string[];
  isDepthWithinCapacity: boolean;
};

type CanonicalOutcomeBundle = {
  legacyOutcomes: string[];
  canonicalEnabled: boolean;
  outcomes: Array<{
    id: number;
    outcomeText: string;
    sequence: number;
    status: string;
    provenance: string;
    alignments: CanonicalOutcomeAlignment[];
  }>;
  nodes: Array<{
    id: number;
    title: string;
    sequence: number;
    status: string;
    cogPathStatus: string | null;
    capacity: { depth: string; source: string; isConfirmed: boolean } | null;
    alignmentCount: number;
  }>;
};

const COGNITIVE_DEPTH_LABELS: Record<string, string> = {
  remember: "Հիշել",
  understand: "Հասկանալ",
  apply: "Կիրառել",
  analyze: "Վերլուծել",
  evaluate: "Գնահատել",
  create: "Ստեղծել",
};
const COGNITIVE_DEPTHS = ["remember", "understand", "apply", "analyze", "evaluate", "create"];

/**
 * A deliberately narrow C1 authoring panel. It is kept separate from legacy
 * lessonOutcomes display so teachers can review and migrate old lessons without
 * changing student delivery or silently inferring outcome-to-node relations.
 */
function CanonicalOutcomesPanel({ lessonId }: { lessonId: number }) {
  const { token } = useAuth();
  const [open, setOpen] = useState(false);
  const [newOutcome, setNewOutcome] = useState("");
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<{ errors: Array<{ code: string; message: string }>; warnings: Array<{ code: string; message: string }>; canonicalEnabled: boolean } | null>(null);
  const [attachNode, setAttachNode] = useState<Record<number, string>>({});
  const [attachRole, setAttachRole] = useState<Record<number, "REQUIRED" | "SUPPORTING">>({});
  const [attachDepth, setAttachDepth] = useState<Record<number, string>>({});
  const [pendingDelete, setPendingDelete] = useState<{ id: number; text: string; approvedNodeCount: number } | null>(null);

  const outcomeQuery = useQuery({
    queryKey: ["canonical-lesson-outcomes", lessonId],
    enabled: open && !!token,
    queryFn: async () => {
      const response = await fetch(`/api/lessons/${lessonId}/outcomes`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("Չհաջողվեց բեռնել վերջնարդյունքները։");
      return response.json() as Promise<CanonicalOutcomeBundle>;
    },
  });
  const refresh = () => outcomeQuery.refetch();

  const request = async (path: string, body?: Record<string, unknown>) => {
    const response = await fetch(`/api/lessons/${lessonId}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token ?? ""}`, "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const requestError = new Error(
        typeof data.message === "string" ? data.message
          : typeof data.error === "string" ? data.error
          : "Գործողությունը չհաջողվեց։",
      );
      Object.assign(requestError, { status: response.status, payload: data });
      throw requestError;
    }
    return data;
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Գործողությունը չհաջողվեց։");
    } finally {
      setBusy(false);
    }
  };

  const bundle = outcomeQuery.data;
  const moveOutcome = (outcomeId: number, direction: -1 | 1) => {
    if (!bundle) return;
    const currentIndex = bundle.outcomes.findIndex((outcome) => outcome.id === outcomeId);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= bundle.outcomes.length) return;
    const ordered = bundle.outcomes.map((outcome) => outcome.id);
    [ordered[currentIndex], ordered[nextIndex]] = [ordered[nextIndex], ordered[currentIndex]];
    void run(async () => { await request("/outcomes/reorder", { orderedOutcomeIds: ordered }); });
  };

  return (
    <div className="border-t border-white/8">
      <button
        onClick={() => setOpen((value) => !value)}
        className="w-full flex items-center justify-between px-4 py-2 text-xs text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
      >
        <span className="font-medium tracking-wide">↳ Կանոնական վերջնարդյունքներ և MicroNode կապեր</span>
        <span>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Վերջնարդյունքները կարող եք ավելացնել, խմբագրել կամ հեռացնել։ MicroNode կապերը կստեղծվեն և կստուգվեն մանրամասն քարտեզագրումից հետո։
          </p>
          {error && <div className="rounded border border-red-400/30 bg-red-400/10 p-2 text-[11px] text-red-200">{error}</div>}
          {outcomeQuery.isLoading && <div className="text-xs text-muted-foreground">Բեռնվում է…</div>}
          {bundle && (
            <>
              {!bundle.canonicalEnabled && bundle.legacyOutcomes.length > 0 && (
                <div className="rounded border border-amber-400/25 bg-amber-400/10 p-2.5 text-[11px] text-amber-100 space-y-2">
                  <p>Գտնվել են {bundle.legacyOutcomes.length} հին JSON վերջնարդյունքներ։ Դրանք դեռ կանոնական կապեր չունեն։</p>
                  <button
                    disabled={busy}
                    onClick={() => void run(async () => { await request("/outcomes/backfill-legacy"); })}
                    className="rounded bg-amber-400/20 px-2 py-1 font-medium text-amber-100 hover:bg-amber-400/30 disabled:opacity-50"
                  >
                    Տեղափոխել որպես draft
                  </button>
                </div>
              )}

              <div className="flex gap-2">
                <input
                  value={newOutcome}
                  onChange={(event) => setNewOutcome(event.target.value)}
                  placeholder="Նոր չափելի վերջնարդյունք…"
                  className="min-w-0 flex-1 rounded border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white placeholder:text-muted-foreground"
                />
                <button
                  disabled={busy || !newOutcome.trim()}
                  onClick={() => void run(async () => {
                    await request("/outcomes", { outcomeText: newOutcome.trim() });
                    setNewOutcome("");
                  })}
                  className="rounded bg-primary/20 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/30 disabled:opacity-50"
                >
                  Ավելացնել
                </button>
              </div>

              <div className="space-y-2">
                {bundle.outcomes.length === 0 && (
                  <div className="rounded border border-dashed border-white/15 p-3 text-center text-xs text-muted-foreground">
                    Կանոնական վերջնարդյունք դեռ չկա։
                  </div>
                )}
                {bundle.outcomes.map((outcome, index) => {
                  const selectedNodeId = attachNode[outcome.id] ?? "";
                  const selectedRole = attachRole[outcome.id] ?? "REQUIRED";
                  const selectedDepth = attachDepth[outcome.id] ?? "understand";
                  return (
                    <div key={outcome.id} className="rounded border border-white/10 bg-white/[0.025] p-2.5 space-y-2">
                      <div className="flex items-start gap-2">
                        <div className="pt-0.5 flex flex-col gap-0.5">
                          <button disabled={busy || index === 0} onClick={() => moveOutcome(outcome.id, -1)} className="text-[10px] text-muted-foreground hover:text-white disabled:opacity-30">▲</button>
                          <button disabled={busy || index === bundle.outcomes.length - 1} onClick={() => moveOutcome(outcome.id, 1)} className="text-[10px] text-muted-foreground hover:text-white disabled:opacity-30">▼</button>
                        </div>
                        <div className="min-w-0 flex-1">
                          {editing?.id === outcome.id ? (
                            <input
                              autoFocus
                              value={editing.text}
                              onChange={(event) => setEditing({ id: outcome.id, text: event.target.value })}
                              className="w-full rounded border border-white/15 bg-black/20 px-2 py-1 text-xs text-white"
                            />
                          ) : (
                            <p className="text-xs leading-relaxed text-white">{outcome.outcomeText}</p>
                          )}
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
                            <span className="rounded border border-white/10 bg-black/20 px-1 py-0.5 text-secondary">
                              {outcome.status === "approved"
                                ? "Պահպանված"
                                : outcome.status === "reviewed"
                                  ? "Վերանայված"
                                  : "Սևագիր"}
                            </span>
                            <span className="text-muted-foreground">{outcome.provenance === "legacy_backfill" ? "հին տվյալից" : "ուսուցչի"}</span>
                          </div>
                        </div>
                        <div className="flex gap-1">
                          {editing?.id === outcome.id ? (
                            <button
                              disabled={busy || !editing.text.trim()}
                              onClick={() => void run(async () => {
                                await request(`/outcomes/${outcome.id}/update`, { outcomeText: editing.text.trim() });
                                setEditing(null);
                              })}
                              className="rounded bg-teal-400/15 px-1.5 py-1 text-[10px] text-teal-200 disabled:opacity-50"
                            >Պահ.</button>
                          ) : (
                            <button onClick={() => setEditing({ id: outcome.id, text: outcome.outcomeText })} className="rounded bg-white/5 px-1.5 py-1 text-[10px] text-muted-foreground hover:text-white">✎</button>
                          )}
                          <button
                            disabled={busy}
                            onClick={() => void run(async () => {
                              try {
                                await request(`/outcomes/${outcome.id}/delete`);
                              } catch (err) {
                                const requestError = err as Error & { status?: number; payload?: { approvedNodeCount?: number } };
                                if (requestError.status === 409) {
                                  setPendingDelete({ id: outcome.id, text: outcome.outcomeText, approvedNodeCount: requestError.payload?.approvedNodeCount ?? 0 });
                                  return;
                                }
                                throw err;
                              }
                            })}
                            className="rounded bg-red-400/10 px-1.5 py-1 text-[10px] text-red-200 hover:bg-red-400/20 disabled:opacity-50"
                          >🗑</button>
                        </div>
                      </div>

                      <div className="space-y-1 pl-5">
                        {outcome.alignments.map((alignment) => (
                          <div key={alignment.id} className="flex items-center justify-between gap-2 rounded bg-black/15 px-2 py-1 text-[10px]">
                            <div className="min-w-0">
                              <span className={alignment.role === "REQUIRED" ? "text-amber-200" : "text-teal-200"}>{alignment.role}</span>
                              <span className="mx-1 text-muted-foreground">·</span>
                              <span className="text-white">{alignment.node?.title ?? "Ջնջված MicroNode"}</span>
                              <span className="ml-1 text-muted-foreground">→ {COGNITIVE_DEPTH_LABELS[alignment.requiredCognitiveDepth] ?? alignment.requiredCognitiveDepth}</span>
                              {alignment.warnings.length > 0 && <span className="ml-1 text-amber-300">⚠</span>}
                            </div>
                            <button
                              disabled={busy}
                              onClick={() => void run(async () => {
                                await request(`/outcomes/${outcome.id}/alignments/${alignment.id}/delete`);
                              })}
                              className="text-red-200 hover:text-red-100 disabled:opacity-50"
                            >Հեռացնել</button>
                          </div>
                        ))}
                        {outcome.alignments.some((alignment) => alignment.warnings.length > 0) && (
                          <p className="text-[10px] text-amber-200">⚠ REQUIRED կապերի համար նախ հաստատեք MicroNode-ի ճանաչողական ուղին։</p>
                        )}
                      </div>

                      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-1 pl-5">
                        <select
                          value={selectedNodeId}
                          onChange={(event) => setAttachNode((state) => ({ ...state, [outcome.id]: event.target.value }))}
                          className="min-w-0 rounded border border-white/10 bg-black/20 px-1.5 py-1 text-[10px] text-white"
                        >
                          <option value="">MicroNode կապել…</option>
                          {bundle.nodes.map((node) => (
                            <option key={node.id} value={node.id}>
                              #{node.sequence} {node.title} {node.capacity ? `(${COGNITIVE_DEPTH_LABELS[node.capacity.depth]})` : ""}
                            </option>
                          ))}
                        </select>
                        <select value={selectedRole} onChange={(event) => setAttachRole((state) => ({ ...state, [outcome.id]: event.target.value as "REQUIRED" | "SUPPORTING" }))} className="rounded border border-white/10 bg-black/20 px-1 py-1 text-[10px] text-white">
                          <option value="REQUIRED">REQUIRED</option>
                          <option value="SUPPORTING">SUPPORTING</option>
                        </select>
                        <select value={selectedDepth} onChange={(event) => setAttachDepth((state) => ({ ...state, [outcome.id]: event.target.value }))} className="rounded border border-white/10 bg-black/20 px-1 py-1 text-[10px] text-white">
                          {COGNITIVE_DEPTHS.map((depth) => <option key={depth} value={depth}>{COGNITIVE_DEPTH_LABELS[depth]}</option>)}
                        </select>
                        <button
                          disabled={busy || !selectedNodeId}
                          onClick={() => void run(async () => {
                            await request(`/outcomes/${outcome.id}/alignments`, {
                              lessonNodeId: Number(selectedNodeId),
                              role: selectedRole,
                              requiredCognitiveDepth: selectedDepth,
                            });
                          })}
                          className="rounded bg-primary/15 px-1.5 py-1 text-[10px] text-primary hover:bg-primary/25 disabled:opacity-50"
                        >Կապել</button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {bundle.canonicalEnabled && (
                <div className="flex items-center gap-2">
                  <button
                    disabled={busy}
                    onClick={() => void run(async () => {
                      const result = await (async () => {
                        const response = await fetch(`/api/lessons/${lessonId}/outcomes/readiness`, { headers: { Authorization: `Bearer ${token ?? ""}` } });
                        if (!response.ok) throw new Error("Չհաջողվեց ստուգել պատրաստվածությունը։");
                        return response.json() as Promise<typeof readiness>;
                      })();
                      setReadiness(result);
                    })}
                    className="rounded border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-50"
                  >Ստուգել C1 պատրաստվածությունը</button>
                  {readiness && <span className={readiness.errors.length === 0 ? "text-[11px] text-teal-300" : "text-[11px] text-amber-200"}>
                    {readiness.errors.length === 0 ? "Պատրաստ է" : `${readiness.errors.length} խնդիր`}
                  </span>}
                </div>
              )}
              {readiness && (readiness.errors.length > 0 || readiness.warnings.length > 0) && (
                <ul className="space-y-1 rounded border border-amber-400/20 bg-amber-400/5 p-2 text-[10px] text-amber-100">
                  {[...readiness.errors, ...readiness.warnings].map((issue, index) => <li key={`${issue.code}-${index}`}>• {issue.message}</li>)}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      <AlertDialog open={!!pendingDelete} onOpenChange={(value) => { if (!value) setPendingDelete(null); }}>
        <AlertDialogContent className="bg-[#0f1117] border border-white/10 text-white">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Ջնջե՞լ վերջնարդյունքը</AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-muted-foreground">
              «{pendingDelete?.text}» վերջնարդյունքի հետ կջնջվեն նաև {pendingDelete?.approvedNodeCount ?? 0} հաստատված MicroNode-ի կապերը։
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-white/5 border-white/10 text-white hover:bg-white/10 hover:text-white text-xs">Չեղարկել</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                const candidate = pendingDelete;
                if (!candidate) return;
                void run(async () => {
                  await request(`/outcomes/${candidate.id}/delete`, { confirmApprovedRelationRemoval: true });
                  setPendingDelete(null);
                });
              }}
              className="bg-destructive text-white hover:bg-destructive/90 text-xs"
            >Ջնջել կապերով</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ValidationApprovalSummaryPanel({ lessonId }: { lessonId: number }) {
  const { token } = useAuth();
  const [open, setOpen] = useState(false);
  const readinessQuery = useQuery({
    queryKey: ["mapping-validation-summary", lessonId],
    enabled: open && !!token,
    queryFn: async () => {
      const response = await fetch(`/api/lessons/${lessonId}/outcomes/readiness`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("Չհաջողվեց բեռնել վավերացման ամփոփումը։");
      return response.json() as Promise<{
        canonicalEnabled: boolean;
        errors: Array<{ code: string; message: string }>;
        warnings: Array<{ code: string; message: string }>;
        info?: Array<{ code: string; message: string }>;
        summary: { outcomes: number; approvedNodes: number; alignedNodes: number };
      }>;
    },
  });
  const report = readinessQuery.data;
  return (
    <div className="border-t border-white/8">
      <button
        onClick={() => setOpen((value) => !value)}
        className="w-full flex items-center justify-between px-4 py-2 text-xs text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
      >
        <span className="font-medium tracking-wide">✅ Վավերացում և վերջնական հաստատում</span>
        <span>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-2">
          <p className="text-[11px] text-muted-foreground">Սա ընթերցման ամփոփում է․ վերջնական հաստատման գործողությունը գտնվում է քարտեզագրման վերնագրի մոտ։</p>
          {readinessQuery.isLoading && <p className="text-xs text-muted-foreground">Բեռնվում է…</p>}
          {readinessQuery.isError && <p className="text-xs text-destructive">Չհաջողվեց բեռնել վավերացման տվյալները։</p>}
          {report && (
            <>
              <div className="flex flex-wrap gap-2 text-[10px]">
                <span className="rounded bg-white/5 px-2 py-1 text-white/75">Վերջնարդյունք՝ {report.summary.outcomes}</span>
                <span className="rounded bg-white/5 px-2 py-1 text-white/75">Կցված MicroNode՝ {report.summary.alignedNodes}</span>
                <span className="rounded bg-white/5 px-2 py-1 text-white/75">Հաստատված MicroNode՝ {report.summary.approvedNodes}</span>
              </div>
              {report.errors.length === 0 && (
                <p className="text-[11px] text-emerald-300">Այս շերտում արգելափակող խնդիր չկա։</p>
              )}
              {report.errors.map((issue, index) => (
                <p key={`${issue.code}-${index}`} className="rounded border border-red-400/20 bg-red-400/5 px-2 py-1 text-[10px] text-red-200">⛔ {issue.message}</p>
              ))}
              {report.warnings.map((issue, index) => (
                <p key={`${issue.code}-${index}`} className="rounded border border-amber-400/20 bg-amber-400/5 px-2 py-1 text-[10px] text-amber-100">⚠️ {issue.message}</p>
              ))}
              {(report.info ?? []).map((issue, index) => (
                <p key={`${issue.code}-${index}`} className="rounded border border-blue-400/15 bg-blue-400/[0.04] px-2 py-1 text-[10px] text-blue-100">ℹ️ {issue.message}</p>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

type TeachingPackageItem = {
  id: number;
  itemType: string;
  content: string;
  cognitiveLevel: string | null;
  status: string;
  provenance: string;
  isPrimary: boolean;
  sequence: number;
  resource: { id: number; title: string; fileUrl: string | null } | null;
};

type TeachingPackageBundle = {
  knowledgeBoundaries: string[];
  nodes: Array<{
    id: number;
    sequence: number;
    title: string;
    learningObjective: string | null;
    status: string;
    knowledgeBoundaries: string[];
    items: TeachingPackageItem[];
  }>;
};

const TEACHING_PACKAGE_TYPES = [
  "MAIN_EXPLANATION", "KEY_FACT", "RULE_OR_FORMULA", "EXAMPLE", "COUNTEREXAMPLE",
  "MISCONCEPTION", "ALTERNATIVE_EXPLANATION", "GUIDING_QUESTION", "HINT", "RESOURCE",
];
const TEACHING_PACKAGE_TYPE_LABELS: Record<string, string> = {
  MAIN_EXPLANATION: "Հիմնական բացատրություն",
  KEY_FACT: "Հիմնական փաստ",
  RULE_OR_FORMULA: "Կանոն / բանաձև",
  EXAMPLE: "Օրինակ",
  COUNTEREXAMPLE: "Հակաօրինակ",
  MISCONCEPTION: "Տարածված թյուրըմբռնում",
  ALTERNATIVE_EXPLANATION: "Այլ բացատրություն",
  GUIDING_QUESTION: "Ուղղորդող հարց",
  HINT: "Հուշում",
  RESOURCE: "Աջակցող նյութ",
};
const TEACHING_PACKAGE_PROVENANCE_LABELS: Record<string, string> = {
  source_material: "աղբյուրից",
  teacher_created: "ուսուցչի",
  ai_generated: "AI draft",
  ai_generated_teacher_approved: "AI, ուսուցիչը հաստատել է",
};

/**
 * Package 1B authoring panel. It reads and writes the normalized Teaching
 * Package only; current student/AI Teacher delivery stays untouched.
 */
function TeachingPackagePanel({ lessonId }: { lessonId: number }) {
  const { token } = useAuth();
  const [open, setOpen] = useState(false);
  const [openNodes, setOpenNodes] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingForNode, setAddingForNode] = useState<number | null>(null);
  const [newItem, setNewItem] = useState({ itemType: "MAIN_EXPLANATION", content: "", cognitiveLevel: "" });
  const [editing, setEditing] = useState<{ nodeId: number; itemId: number; content: string } | null>(null);

  const teachingPackageQuery = useQuery({
    queryKey: ["micro-node-teaching-package", lessonId],
    enabled: open && !!token,
    queryFn: async () => {
      const response = await fetch(`/api/lessons/${lessonId}/teaching-package`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("Չհաջողվեց բեռնել ուսուցման փաթեթը։");
      return response.json() as Promise<TeachingPackageBundle>;
    },
  });
  const refresh = () => teachingPackageQuery.refetch();

  const request = async (path: string, body?: Record<string, unknown>) => {
    const response = await fetch(`/api/lessons/${lessonId}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token ?? ""}`, "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
        typeof data.message === "string" ? data.message
          : typeof data.error === "string" ? data.error
          : "Գործողությունը չհաջողվեց։",
      );
    }
    return data;
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Գործողությունը չհաջողվեց։");
    } finally {
      setBusy(false);
    }
  };

  const bundle = teachingPackageQuery.data;
  const moveItem = (nodeId: number, item: TeachingPackageItem, direction: -1 | 1) => {
    const node = bundle?.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const sameType = node.items.filter((candidate) => candidate.itemType === item.itemType);
    const index = sameType.findIndex((candidate) => candidate.id === item.id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= sameType.length) return;
    const orderedItemIds = sameType.map((candidate) => candidate.id);
    [orderedItemIds[index], orderedItemIds[nextIndex]] = [orderedItemIds[nextIndex], orderedItemIds[index]];
    void run(async () => {
      await request(`/nodes/${nodeId}/teaching-package/reorder`, { itemType: item.itemType, orderedItemIds });
    });
  };

  return (
    <div className="border-t border-white/8">
      <button
        onClick={() => setOpen((value) => !value)}
        className="w-full flex items-center justify-between px-4 py-2 text-xs text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
      >
        <span className="font-medium tracking-wide">C1․ MicroNode ուսուցման փաթեթ</span>
        <span>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Այստեղ պահվում է վերաօգտագործելի ուսուցման նյութը։ Այն դեռ չի փոխում AI ուսուցչի կամ սովորողի ընթացիկ հոսքը։
          </p>
          {error && <div className="rounded border border-red-400/30 bg-red-400/10 p-2 text-[11px] text-red-200">{error}</div>}
          {teachingPackageQuery.isLoading && <div className="text-xs text-muted-foreground">Բեռնվում է…</div>}
          {bundle && (
            <>
              {bundle.nodes.some((node) => node.items.length === 0) && (
                <div className="flex items-center justify-between gap-2 rounded border border-amber-400/20 bg-amber-400/5 p-2 text-[11px] text-amber-100">
                  <span>Գոյություն ունեցող քարտեզագրված նյութը կարող եք տեղափոխել միայն որպես վերանայվող draft տարրեր։</span>
                  <button
                    disabled={busy}
                    onClick={() => void run(async () => { await request("/teaching-package/backfill-existing"); })}
                    className="shrink-0 rounded bg-amber-400/15 px-2 py-1 font-medium hover:bg-amber-400/25 disabled:opacity-50"
                  >Ստեղծել draft-եր</button>
                </div>
              )}
              {bundle.nodes.length === 0 && (
                <div className="rounded border border-dashed border-white/15 p-3 text-center text-xs text-muted-foreground">
                  Նախ ստեղծեք MicroNode-ներ։
                </div>
              )}
              {bundle.nodes.map((node) => {
                const nodeIsOpen = !!openNodes[node.id];
                return (
                  <div key={node.id} className="rounded border border-white/10 bg-white/[0.025]">
                    <button
                      onClick={() => setOpenNodes((state) => ({ ...state, [node.id]: !state[node.id] }))}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
                    >
                      <span className="min-w-0 text-xs text-white"><span className="mr-1.5 text-muted-foreground">#{node.sequence}</span>{node.title}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{node.items.length} նյութ · {nodeIsOpen ? "▲" : "▼"}</span>
                    </button>
                    {nodeIsOpen && (
                      <div className="space-y-3 border-t border-white/8 p-3">
                        <div className="rounded bg-black/15 p-2 text-[10px] leading-relaxed text-muted-foreground">
                          <p><span className="text-white/80">Նպատակ՝ </span>{node.learningObjective || "նշված չէ"}</p>
                          <p className="mt-1"><span className="text-white/80">Գիտելիքի սահման՝ </span>{node.knowledgeBoundaries.length > 0 ? node.knowledgeBoundaries.join(" · ") : "դասի համար նշված սահման չկա"}</p>
                        </div>
                        <div className="space-y-2">
                          {TEACHING_PACKAGE_TYPES.map((itemType) => {
                            const items = node.items.filter((item) => item.itemType === itemType);
                            if (items.length === 0) return null;
                            return (
                              <div key={itemType} className="space-y-1">
                                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{TEACHING_PACKAGE_TYPE_LABELS[itemType]}</p>
                                {items.map((item, index) => (
                                  <div key={item.id} className="rounded border border-white/8 bg-black/15 p-2">
                                    <div className="flex items-start gap-2">
                                      <div className="pt-0.5 flex flex-col">
                                        <button disabled={busy || index === 0} onClick={() => moveItem(node.id, item, -1)} className="text-[10px] text-muted-foreground hover:text-white disabled:opacity-30">▲</button>
                                        <button disabled={busy || index === items.length - 1} onClick={() => moveItem(node.id, item, 1)} className="text-[10px] text-muted-foreground hover:text-white disabled:opacity-30">▼</button>
                                      </div>
                                      <div className="min-w-0 flex-1">
                                        {editing?.itemId === item.id ? (
                                          <textarea
                                            autoFocus
                                            value={editing.content}
                                            onChange={(event) => setEditing({ nodeId: node.id, itemId: item.id, content: event.target.value })}
                                            className="min-h-16 w-full rounded border border-white/15 bg-black/20 px-2 py-1 text-xs text-white"
                                          />
                                        ) : <p className="whitespace-pre-wrap text-xs leading-relaxed text-white">{item.content}</p>}
                                        <div className="mt-1.5 flex flex-wrap gap-1 text-[10px]">
                                          <span className={item.status === "approved" ? "text-teal-300" : "text-amber-200"}>{item.status}</span>
                                          <span className="text-muted-foreground">· {TEACHING_PACKAGE_PROVENANCE_LABELS[item.provenance] ?? item.provenance}</span>
                                          {item.cognitiveLevel && <span className="text-muted-foreground">· {COGNITIVE_DEPTH_LABELS[item.cognitiveLevel] ?? item.cognitiveLevel}</span>}
                                          {item.isPrimary && <span className="text-primary">· առաջնային</span>}
                                        </div>
                                      </div>
                                      <div className="flex shrink-0 gap-1">
                                        {editing?.itemId === item.id ? (
                                          <button disabled={busy || !editing.content.trim()} onClick={() => void run(async () => {
                                            await request(`/nodes/${node.id}/teaching-package/${item.id}/update`, { content: editing.content.trim() });
                                            setEditing(null);
                                          })} className="rounded bg-teal-400/15 px-1.5 py-1 text-[10px] text-teal-200 disabled:opacity-50">Պահ.</button>
                                        ) : (
                                          <button disabled={busy} onClick={() => setEditing({ nodeId: node.id, itemId: item.id, content: item.content })} className="rounded bg-white/5 px-1.5 py-1 text-[10px] text-muted-foreground hover:text-white">Խմբ.</button>
                                        )}
                                        <button disabled={busy} onClick={() => {
                                          if (confirm("Ջնջե՞լ այս ուսուցման նյութը։")) void run(async () => {
                                            await request(`/nodes/${node.id}/teaching-package/${item.id}/delete`);
                                          });
                                        }} className="rounded bg-red-400/10 px-1.5 py-1 text-[10px] text-red-200 hover:bg-red-400/20 disabled:opacity-50">Ջնջ.</button>
                                      </div>
                                    </div>
                                    <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-5">
                                      {item.status !== "approved" ? (
                                        <>
                                          <select
                                            disabled={busy}
                                            value={item.status}
                                            onChange={(event) => void run(async () => {
                                              await request(`/nodes/${node.id}/teaching-package/${item.id}/update`, { status: event.target.value });
                                            })}
                                            className="rounded border border-white/10 bg-black/20 px-1 py-0.5 text-[10px] text-white"
                                          >
                                            <option value="draft">draft</option>
                                            <option value="reviewed">reviewed</option>
                                          </select>
                                          <button disabled={busy} onClick={() => void run(async () => {
                                            await request(`/nodes/${node.id}/teaching-package/${item.id}/approve`, {
                                              makePrimary: item.itemType === "MAIN_EXPLANATION" ? item.isPrimary : false,
                                            });
                                          })} className="rounded bg-teal-400/15 px-1.5 py-0.5 text-[10px] text-teal-200 hover:bg-teal-400/25 disabled:opacity-50">Հաստատել</button>
                                        </>
                                      ) : (
                                        <button disabled={busy} onClick={() => void run(async () => {
                                          await request(`/nodes/${node.id}/teaching-package/${item.id}/update`, { status: "draft" });
                                        })} className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-white disabled:opacity-50">Վերադարձնել draft</button>
                                      )}
                                      {item.itemType === "MAIN_EXPLANATION" && !item.isPrimary && (
                                        <button disabled={busy} onClick={() => void run(async () => {
                                          const path = item.status === "approved"
                                            ? `/nodes/${node.id}/teaching-package/${item.id}/update`
                                            : `/nodes/${node.id}/teaching-package/${item.id}/approve`;
                                          await request(path, item.status === "approved" ? { isPrimary: true } : { makePrimary: true });
                                        })} className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/25 disabled:opacity-50">Դարձնել առաջնային</button>
                                      )}
                                      <select
                                        disabled={busy}
                                        value={item.cognitiveLevel ?? ""}
                                        onChange={(event) => void run(async () => {
                                          await request(`/nodes/${node.id}/teaching-package/${item.id}/update`, { cognitiveLevel: event.target.value || null });
                                        })}
                                        className="rounded border border-white/10 bg-black/20 px-1 py-0.5 text-[10px] text-white"
                                      >
                                        <option value="">MicroNode-ի համար</option>
                                        {COGNITIVE_DEPTHS.map((depth) => <option key={depth} value={depth}>{COGNITIVE_DEPTH_LABELS[depth]}</option>)}
                                      </select>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            );
                          })}
                        </div>
                        {addingForNode === node.id ? (
                          <div className="space-y-2 rounded border border-primary/20 bg-primary/[0.04] p-2">
                            <div className="grid grid-cols-2 gap-1.5">
                              <select value={newItem.itemType} onChange={(event) => setNewItem((state) => ({ ...state, itemType: event.target.value }))} className="rounded border border-white/10 bg-black/20 px-1.5 py-1 text-[10px] text-white">
                                {TEACHING_PACKAGE_TYPES.map((itemType) => <option key={itemType} value={itemType}>{TEACHING_PACKAGE_TYPE_LABELS[itemType]}</option>)}
                              </select>
                              <select value={newItem.cognitiveLevel} onChange={(event) => setNewItem((state) => ({ ...state, cognitiveLevel: event.target.value }))} className="rounded border border-white/10 bg-black/20 px-1.5 py-1 text-[10px] text-white">
                                <option value="">MicroNode-ի համար</option>
                                {COGNITIVE_DEPTHS.map((depth) => <option key={depth} value={depth}>{COGNITIVE_DEPTH_LABELS[depth]}</option>)}
                              </select>
                            </div>
                            <textarea value={newItem.content} onChange={(event) => setNewItem((state) => ({ ...state, content: event.target.value }))} placeholder="Նոր ուսուցման նյութ…" className="min-h-16 w-full rounded border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-white placeholder:text-muted-foreground" />
                            <div className="flex gap-1.5">
                              <button disabled={busy || !newItem.content.trim()} onClick={() => void run(async () => {
                                await request(`/nodes/${node.id}/teaching-package`, {
                                  itemType: newItem.itemType,
                                  content: newItem.content.trim(),
                                  cognitiveLevel: newItem.cognitiveLevel || null,
                                });
                                setAddingForNode(null);
                                setNewItem({ itemType: "MAIN_EXPLANATION", content: "", cognitiveLevel: "" });
                              })} className="rounded bg-primary/20 px-2 py-1 text-[10px] text-primary hover:bg-primary/30 disabled:opacity-50">Ավելացնել draft</button>
                              <button disabled={busy} onClick={() => setAddingForNode(null)} className="rounded bg-white/5 px-2 py-1 text-[10px] text-muted-foreground hover:text-white">Չեղարկել</button>
                            </div>
                          </div>
                        ) : (
                          <button disabled={busy} onClick={() => { setAddingForNode(node.id); setNewItem({ itemType: "MAIN_EXPLANATION", content: "", cognitiveLevel: "" }); }} className="rounded border border-primary/25 bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20 disabled:opacity-50">Նյութ ավելացնել</button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
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
  const [quizType,      setQuizType]        = useState<"lesson"|"summary">("lesson");
  // ── Node drill-down (single-lesson mode) ──────────────────────────────────
  const [quizNodeIds,      setQuizNodeIds]      = useState<number[]>([]);
  const [quizLessonNodes,  setQuizLessonNodes]  = useState<{id:number;title:string;sequence:number}[]>([]);
  const [quizNodesLoading, setQuizNodesLoading] = useState(false);
  const [quizLeafCount,    setQuizLeafCount]    = useState(0);

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
  const [resultsActiveTab, setResultsActiveTab]         = useState<"students" | "analysis">("students");
  const [analysisLoading, setAnalysisLoading]           = useState(false);
  const [analysisData,    setAnalysisData]              = useState<{
    quizId: number;
    participantCount: number;
    commonErrors: {
      questionId: number; questionText: string;
      nodeId: number | null; nodeTitle: string | null;
      wrongOptionIndex: number; wrongOptionText: string;
      wrongCount: number; wrongPercent: number;
      correctOptionIndex: number; correctOptionText: string;
      misconception: string | null;
    }[];
    teacherRecommendations: {
      classLevel: { nodeId: number; nodeTitle: string; commonErrorPercent: number }[];
      individual: {
        studentId: number; studentName: string;
        weakNodes: {
          nodeId: number; nodeTitle: string;
          masteryLevel: string; masteryScore: number | null;
          nextAction: { action: string; masteryScore: number | null; intensity?: string };
        }[];
      }[];
    };
  } | null>(null);

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
    if (resultsQuizId === null) { setResultsData(null); setAnalysisData(null); setResultsActiveTab("students"); return; }
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

  useEffect(() => {
    if (resultsQuizId === null) { setAnalysisData(null); return; }
    const tok = localStorage.getItem("myaiteacher_token") ?? "";
    setAnalysisLoading(true);
    fetch(`/api/quizzes/${resultsQuizId}/analysis`, {
      headers: { Authorization: `Bearer ${tok}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setAnalysisData(data))
      .catch(() => setAnalysisData(null))
      .finally(() => setAnalysisLoading(false));
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
    // Type-specific frontend validation
    if (quizType === "lesson" && quizLessonIds.length !== 1) return;
    if (quizType === "summary" && quizLessonIds.length < 2) return;
    if (quizLessonIds.length === 0) return;
    setQuizCreating(true);
    setQuizError(null);
    const tok = localStorage.getItem("myaiteacher_token") ?? "";
    // Lesson Test + specific nodes selected → send only those nodeIds
    // Lesson Test + no nodes selected → send lessonIds (backend resolves all nodes)
    // Summary Test → send lessonIds only (no node-level drill-down)
    const isSingleLesson = quizType === "lesson" && quizLessonIds.length === 1;
    const sendNodeIds = isSingleLesson && quizNodeIds.length > 0 ? quizNodeIds : undefined;
    try {
      const resp = await fetch(`/api/quizzes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
        body: JSON.stringify({
          subjectId:      selectedCourse?.subjectId ?? undefined,
          classId:        selectedClass?.id ?? undefined,
          sourceBookId:   quizBookId ?? undefined,
          quizType,
          lessonIds:      sendNodeIds ? undefined : quizLessonIds,
          nodeIds:        sendNodeIds,
          questionCount:  quizCount,
          difficultyMode: quizMode,
          title:          quizTitle.trim() || undefined,
        }),
      });
      // Guard: if the server returned HTML instead of JSON (e.g. a proxy error
      // or an unhandled server crash), surface a clear Armenian error message
      // rather than the cryptic "Unexpected token '<'" parse failure.
      const contentType = resp.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        throw new Error("Թեստի ստեղծման հարցումը վերադարձրել է անսպասելի պատասխան։ Կրկին փորձեք։");
      }
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
    if (quizType === "lesson") {
      // Lesson Test: single selection — clicking already-selected deselects; clicking other replaces
      setQuizLessonIds((prev) => prev.includes(lid) ? [] : [lid]);
    } else {
      setQuizLessonIds((prev) => prev.includes(lid) ? prev.filter((x) => x !== lid) : [...prev, lid]);
    }
  }

  function handleQuizTypeSwitch(newType: "lesson" | "summary") {
    setQuizType(newType);
    if (newType === "lesson") {
      // Keep only the first lesson (if any were selected), clear node selection
      setQuizLessonIds((prev) => prev.length > 0 ? [prev[0]] : []);
      setQuizNodeIds([]);
    } else {
      // Summary: clear node selection but keep all selected lessons
      setQuizNodeIds([]);
    }
  }

  // ── Fetch lesson nodes when single lesson is selected ─────────────────────
  useEffect(() => {
    const tok = localStorage.getItem("myaiteacher_token") ?? "";
    if (quizLessonIds.length === 1) {
      const lessonId = quizLessonIds[0];
      setQuizNodesLoading(true);
      setQuizNodeIds([]);
      fetch(`/api/lessons/${lessonId}/nodes`, { headers: { Authorization: `Bearer ${tok}` } })
        .then((r) => r.ok ? r.json() : [])
        .then((data: {id:number;title:string;sequence:number}[]) => {
          setQuizLessonNodes(data);
          setQuizLeafCount(data.length);
        })
        .catch(() => {})
        .finally(() => setQuizNodesLoading(false));
    } else if (quizLessonIds.length > 1) {
      setQuizLessonNodes([]);
      setQuizNodeIds([]);
      Promise.all(
        quizLessonIds.map((lid) =>
          fetch(`/api/lessons/${lid}/nodes`, { headers: { Authorization: `Bearer ${tok}` } })
            .then((r) => r.ok ? r.json() : [])
            .catch(() => [])
        )
      ).then((results) => {
        const total = results.reduce((s, nodes) => s + (Array.isArray(nodes) ? nodes.length : 0), 0);
        setQuizLeafCount(total);
      });
    } else {
      setQuizLessonNodes([]);
      setQuizNodeIds([]);
      setQuizLeafCount(0);
    }
  }, [quizLessonIds]);

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

  const handleCreateLesson = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCourse) return;
    setLessonError(null);
    const pageRangeError = getLessonPageRangeInputError(lessonForm.pagesFrom, lessonForm.pagesTo);
    if (pageRangeError) {
      setLessonError(pageRangeError);
      return;
    }
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
    setLessonError(null);
    const pageRangeError = getLessonPageRangeInputError(editLesson.pagesFrom, editLesson.pagesTo);
    if (pageRangeError) {
      setLessonError(pageRangeError);
      return;
    }
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
        onError: (err: unknown) => {
          const d = (err as { response?: { data?: { error?: string } } })?.response?.data;
          setLessonError(d?.error ?? "Դասի փոփոխությունը չհաջողվեց");
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
                        const SL: Record<string,string> = { draft: "Սևagir", assigned: "Հandznararvats", active: "Ակտիվ", completed: "Ավարտել" };
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
                    onClick={() => {
                      setQuizModalOpen(true);
                      setQuizError(null);
                      setQuizType("lesson");
                      setQuizLessonIds([]);
                      setQuizTitle("");
                      setQuizNodeIds([]);
                      setQuizLessonNodes([]);
                      setQuizLeafCount(0);
                    }}
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
                              Ուղարկել
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
                          Դասագիրքը դեռ վերբեռնված չէ subject-ի էջում
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
                      <div className="sm:col-span-2">
                        <p className="text-xs font-medium text-foreground">
                          PDF-ի ֆիզիկական էջեր
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Նշեք PDF-ում տեսանելի այն էջերի համարները, որոնք համակարգը պետք է կարդա այս դասի համար։
                        </p>
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
                    {lessonError && (
                      <p className="text-xs text-red-400">{lessonError}</p>
                    )}
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
                          <option value="">— Հաստատել —</option>
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
                      <div className="sm:col-span-2">
                        <p className="text-xs font-medium text-foreground">
                          PDF-ի ֆիզիկական էջեր
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Նշեք PDF-ում տեսանելի այն էջերի համարները, որոնք համակարգը պետք է կարդա այս դասի համար։
                        </p>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Էջի սկիզբը
                        </label>
                        <input
                          type="number"
                          min="1"
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
                          Էջի վերջը
                        </label>
                        <input
                          type="number"
                          min="1"
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
                        const isCompleted  = (l as any).status === "completed";
                        const isActive     = (l as any).status === "active";
                        const isMapped     = Boolean((l as any).coreIdea) || ((l as any).nodeCount ?? 0) > 0;
                        // P3.5: null = never auto-mapped (no coverage data), true = passed, false = coverage failed
                        const coverageValid: boolean | null = (l as any).coverageValid ?? null;
                        // P4.13: null = never auto-mapped, 0 = clean, >0 = granularity findings
                        const granularityIssues: number | null = (l as any).granularityIssues ?? null;
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
                              <div className="px-4 py-3 flex flex-wrap items-start gap-x-3 gap-y-2">
                                <span className="text-xs font-mono text-primary/70 w-7 shrink-0 mt-0.5 text-center">
                                  {(l as any).lessonNumber ?? "—"}
                                </span>
                                <div className="flex-[1_1_18rem] min-w-[12rem] max-w-full">
                                  <div className="font-medium text-sm">{l.title}</div>
                                  <div className="flex flex-wrap gap-x-2 gap-y-1 mt-1 items-center">
                                    {(l as any).paragraphNumber && (
                                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                                        §{(l as any).paragraphNumber}
                                      </span>
                                    )}
                                    {(l as any).paragraphNumber &&
                                      ((l as any).pagesFrom || (l as any).pagesTo) && (
                                      <span className="text-xs text-muted-foreground/40"> · </span>
                                    )}
                                    {((l as any).pagesFrom || (l as any).pagesTo) && (
                                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                                        Էջ {(l as any).pagesFrom ?? "?"}–{(l as any).pagesTo ?? "?"}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="flex min-w-0 max-w-full flex-[1_1_24rem] basis-full sm:basis-auto flex-wrap gap-1 items-center justify-end">
                                  {/* P3.5: coverage badge — shown when auto-mapped but structural coverage validation failed */}
                                  {isMapped && coverageValid === false && (
                                    <span
                                      title="Source coverage validation failed — some blocks were not accounted for. Re-map or inspect the Mapping Report."
                                      className="px-2 py-1 rounded-lg text-xs text-orange-400 border border-orange-400/20 bg-orange-400/10 select-none cursor-help"
                                    >
                                      ⚠️ Coverage
                                    </span>
                                  )}
                                  {/* P4.13: granularity badge — shown when semantic review found MEGA_NODE / OVER_SPLIT / EXERCISE_MISMATCH issues */}
                                  {isMapped && granularityIssues !== null && granularityIssues > 0 && (
                                    <span
                                      title={`Granularity review found ${granularityIssues} issue${granularityIssues !== 1 ? "s" : ""} (MEGA_NODE / OVER_SPLIT / EXERCISE_MISMATCH). Inspect the Mapping Report for details.`}
                                      className="px-2 py-1 rounded-lg text-xs text-yellow-400 border border-yellow-400/20 bg-yellow-400/10 select-none cursor-help"
                                    >
                                      ⚠️ Տրոհման մակարդակ: {granularityIssues}
                                    </span>
                                  )}
                                  {isCompleted ? (
                                    <span className="px-2 py-1 rounded-lg text-xs text-teal-400 border border-teal-400/20 bg-teal-400/10 select-none">
                                      Ավարտված
                                    </span>
                                  ) : isActive ? (
                                    <span className="px-2 py-1 rounded-lg text-xs text-amber-400 border border-amber-400/20 bg-amber-400/10 select-none">
                                      Ընթացքի մեջ
                                    </span>
                                  ) : isMapped ? (
                                    <LessonAssignmentAction
                                      lessonId={l.id}
                                      courseId={selectedCourse!.id}
                                      authoringStatus={(l as any).status ?? "draft"}
                                    />
                                  ) : isMapped ? (
                                    /* Mapped but not yet approved - show disabled */
                                    <span
                                      title="Նախ վердնական հastатum արарек"
                                      className="px-2 py-1 rounded-lg text-xs text-muted-foreground/40 border border-white/5 select-none cursor-help"
                                    >
                                      Հանձնարարել սովորողին
                                    </span>
                                  ) : (
                                    <span
                                      title="Նախ քարտևզագրիր"
                                      className="px-2 py-1 rounded-lg text-xs text-muted-foreground/40 border border-white/5 select-none cursor-default"
                                    >
                                      Հանձնարարել սովորողին
                                    </span>
                                  )}
                                  <LessonMapButton lessonId={l.id} courseId={selectedCourse!.id} isMapped={isMapped} />
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
                              <LessonGoalOutcomesPanel
                                lessonId={l.id}
                                lessonGoal={(l as any).lessonGoal ?? ""}
                                lessonOutcomes={
                                  Array.isArray((l as any).lessonOutcomes)
                                    ? (l as any).lessonOutcomes
                                    : []
                                }
                              />
                              <MappingAuditPanel lessonId={l.id} />
                              <CanonicalOutcomesPanel lessonId={l.id} />
                              <LessonNodesPanel
                                lessonId={l.id}
                                courseId={selectedCourse!.id}
                                coreProblem={(l as any).coreProblem ?? null}
                                coreIdea={(l as any).coreIdea ?? null}
                                textbookAuthor={(l as any).textbookAuthor ?? null}
                                textbookTitle={(l as any).textbookTitle ?? null}
                                chapterTitle={(l as any).chapterTitle ?? null}
                                lessonDescription={(l as any).description ?? null}
                                authoringStatus={(l as any).status ?? "draft"}
                                lessonClassId={(l as any).classId ?? null}
                                lessonSubjectId={selectedCourse?.subjectId ?? null}
                                requiredSessionMinutes={(l as any).requiredSessionMinutes ?? null}
                                onOpenResults={(quizId) => { setResultsFrom("allQuizzes"); setResultsQuizId(quizId); }}
                              />
                              <TeachingPackagePanel lessonId={l.id} />
                              <ValidationApprovalSummaryPanel lessonId={l.id} />
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
            {/* Header + tabs */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <h2 className="text-base font-semibold">Արդյունքներ</h2>
              <button onClick={() => setResultsQuizId(null)} className={btnGhost}>✕</button>
            </div>
            <div className="flex border-b border-white/10">
              <button
                onClick={() => setResultsActiveTab("students")}
                className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
                  resultsActiveTab === "students"
                    ? "text-white border-b-2 border-primary"
                    : "text-muted-foreground hover:text-white"
                }`}
              >
                Աշակերտներ
              </button>
              <button
                onClick={() => setResultsActiveTab("analysis")}
                className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
                  resultsActiveTab === "analysis"
                    ? "text-white border-b-2 border-primary"
                    : "text-muted-foreground hover:text-white"
                }`}
              >
                Առաջարկություններ ուսուցչին
              </button>
            </div>

            {/* ── Students tab ── */}
            {resultsActiveTab === "students" && (
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
                            Деrrчи аварtел
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Class analysis tab ── */}
            {resultsActiveTab === "analysis" && (
              <div className="p-6 overflow-y-auto max-h-[60vh] space-y-6">
                {analysisLoading ? (
                  <div className="flex justify-center py-8">
                    <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : !analysisData ? (
                  <p className="text-sm text-muted-foreground text-center py-8">—</p>
                ) : (
                  <>
                    {/* Common errors */}
                    {analysisData.commonErrors.length > 0 && (
                      <div className="space-y-3">
                        <h3 className="text-xs font-semibold text-white/70 uppercase tracking-wide">
                          [COMMON_ERROR] · {analysisData.participantCount} Маснаkitсоch
                        </h3>
                        {analysisData.commonErrors.map((ce) => (
                          <div key={ce.questionId} className="rounded-xl border border-red-400/20 bg-red-400/5 p-4">
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <p className="text-sm font-medium leading-snug flex-1">{ce.questionText}</p>
                              <span className="text-xs font-bold text-red-400 shrink-0">{ce.wrongPercent}%</span>
                            </div>
                            {ce.nodeTitle && (
                              <p className="text-xs text-muted-foreground/60 mb-2">📌 {ce.nodeTitle}</p>
                            )}
                            <div className="text-xs space-y-1">
                              <div className="flex gap-2 items-center">
                                <span className="text-red-400">❌</span>
                                <span className="text-red-300/80">{ce.wrongOptionText}</span>
                                <span className="text-muted-foreground/50 ml-auto">{ce.wrongCount} Ашаk.</span>
                              </div>
                              <div className="flex gap-2 items-center">
                                <span className="text-teal-400">✓</span>
                                <span className="text-teal-300/80">{ce.correctOptionText}</span>
                              </div>
                              {ce.misconception && (
                                <p className="mt-2 text-muted-foreground/70 italic border-l border-white/10 pl-2">
                                  {ce.misconception}
                                </p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Class-level node summary */}
                    {analysisData.teacherRecommendations.classLevel.length > 0 && (
                      <div className="space-y-2">
                        <h3 className="text-xs font-semibold text-white/70 uppercase tracking-wide">
                          Դասարանի խնդիրներ
                        </h3>
                        {analysisData.teacherRecommendations.classLevel.map((cl) => (
                          <div key={cl.nodeId} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-white/8 bg-card/20">
                            <div className="flex-1 min-w-0 text-sm truncate">{cl.nodeTitle}</div>
                            <span className="text-xs font-semibold text-amber-400 shrink-0">
                              {cl.commonErrorPercent}% [COMMON_ERROR]
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* No issues */}
                    {analysisData.commonErrors.length === 0 &&
                      analysisData.teacherRecommendations.classLevel.length === 0 && (
                        <p className="text-sm text-teal-400/80 text-center py-4">
                          ✅ Դասարանի կողմից ountеррен ченka
                        </p>
                      )
                    }

                    {/* Per-student weak nodes */}
                    {analysisData.teacherRecommendations.individual.length > 0 && (
                      <div className="space-y-3">
                        <h3 className="text-xs font-semibold text-white/70 uppercase tracking-wide">
                          [INDIVIDUAL_ERROR]
                        </h3>
                        {analysisData.teacherRecommendations.individual.map((s) => (
                          <div key={s.studentId} className="rounded-xl border border-white/8 bg-card/20 p-3">
                            <div className="text-sm font-medium mb-2">{s.studentName}</div>
                            <div className="space-y-1.5 pl-2">
                              {s.weakNodes.map((n) => (
                                <div key={n.nodeId} className="flex items-center gap-2 text-xs">
                                  <span className={`px-1.5 py-0.5 rounded border text-xs ${
                                    n.masteryLevel === "in_progress"
                                      ? "border-red-400/40 text-red-400"
                                      : n.masteryLevel === "not_started"
                                      ? "border-white/20 text-muted-foreground"
                                      : "border-amber-400/40 text-amber-400"
                                  }`}>
                                    {n.masteryLevel === "mastered" ? "Гиtи"
                                      : n.masteryLevel === "weak" ? "Маснакi"
                                      : n.masteryLevel === "in_progress" ? "Чγаtи"
                                      : "Деrrчи"}
                                  </span>
                                  <span className="truncate text-muted-foreground">{n.nodeTitle}</span>
                                  <span className="ml-auto shrink-0 text-muted-foreground/50">
                                    → {n.nextAction.action === "LEARN_FULL" ? "[LEARN_FULL]"
                                        : n.nextAction.action === "LEARN_TARGETED" ? "[LEARN_TARGETED]"
                                        : n.nextAction.action === "STUDY_FIRST" ? "[STUDY_FIRST]"
                                        : "[REVIEW]"}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
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
              AI-ն կստեղծի հարցեր ընտրված դասի բովանդակությունից
            </p>

            {/* Test type selector */}
            <div className="mb-5">
              <label className="block text-sm text-muted-foreground mb-2">Տեսակ</label>
              <div className="grid grid-cols-2 gap-2">
                {([
                  ["lesson",  "Դասի թեստ"],
                  ["summary", "Ամփոփիչ թեստ"],
                ] as const).map(([val, label]) => (
                  <label
                    key={val}
                    className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border cursor-pointer transition-colors ${
                      quizType === val
                        ? "border-primary/60 bg-primary/10 text-white"
                        : "border-white/8 text-muted-foreground hover:border-white/20 hover:bg-white/5"
                    }`}
                  >
                    <input
                      type="radio"
                      name="quizType"
                      value={val}
                      checked={quizType === val}
                      onChange={() => handleQuizTypeSwitch(val)}
                      className="accent-primary shrink-0"
                    />
                    <span className="text-sm font-medium">{label}</span>
                  </label>
                ))}
              </div>
            </div>

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
                {quizType === "lesson" ? "Ընտրել դասը *" : "Ընտրել դասերը *"}
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

            {/* Node drill-down — Lesson Test only */}
            {quizType === "lesson" && quizLessonIds.length === 1 && (
              <div className="mb-4">
                <label className="block text-sm text-muted-foreground mb-1.5">
                  Ընտրել գիտելիքի հանգույցները
                </label>
                {quizNodesLoading ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-xs py-2">
                    <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    Բեռնվում է...
                  </div>
                ) : quizLessonNodes.length === 0 ? (
                  <p className="text-xs text-muted-foreground/50 italic py-1">—</p>
                ) : (
                  <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                    {/* "Whole lesson" option */}
                    <label className={`flex items-center gap-3 px-3 py-2 rounded-xl border cursor-pointer transition-colors ${
                      quizNodeIds.length === 0
                        ? "border-primary/60 bg-primary/10"
                        : "border-white/8 hover:border-white/20 hover:bg-white/5"
                    }`}>
                      <input
                        type="checkbox"
                        checked={quizNodeIds.length === 0}
                        onChange={() => setQuizNodeIds([])}
                        className="accent-primary shrink-0"
                      />
                      <span className="text-sm text-white font-medium">Ամբողջ դասը</span>
                      <span className="text-xs text-muted-foreground ml-auto">{quizLessonNodes.length}</span>
                    </label>
                    {quizLessonNodes.map((n) => (
                      <label
                        key={n.id}
                        className={`flex items-center gap-3 px-3 py-2 rounded-xl border cursor-pointer transition-colors ${
                          quizNodeIds.includes(n.id)
                            ? "border-teal-500/60 bg-teal-500/10"
                            : "border-white/8 hover:border-white/20 hover:bg-white/5"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={quizNodeIds.includes(n.id)}
                          onChange={() =>
                            setQuizNodeIds((prev) =>
                              prev.includes(n.id)
                                ? prev.filter((x) => x !== n.id)
                                : [...prev, n.id]
                            )
                          }
                          className="accent-primary shrink-0"
                        />
                        <span className="text-sm text-white/90 truncate">{n.title}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Summary Test: validation hint (< 2 lessons) or whole-lesson note (≥ 2) */}
            {quizType === "summary" && quizLessonIds.length === 1 && (
              <p className="text-xs text-amber-400/80 mb-4 px-1">
                ⚠ Ամփոփիչ թեստի համար ընտրեք առնվազն 2 դաս
              </p>
            )}
            {quizType === "summary" && quizLessonIds.length >= 2 && (
              <p className="text-xs text-muted-foreground/60 mb-4 px-1">
                Ամփոփիչ թեստի դեպքում ընտրվում են ամբողջ դասերը
              </p>
            )}

            {/* Question count + suggestion */}
            <div className="mb-4">
              <label className="block text-sm text-muted-foreground mb-1.5">
                Հարցերի քանակ
              </label>
              <div className="flex items-center gap-3 flex-wrap">
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={quizCount}
                  onChange={(e) => setQuizCount(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-32 bg-background/60 border border-white/15 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-primary/60"
                />
                {quizLeafCount > 0 && (() => {
                  const effectiveLeaf = quizType === "lesson" && quizNodeIds.length > 0
                    ? quizNodeIds.length
                    : quizLeafCount;
                  const minQEff  = effectiveLeaf;
                  const idealQEff = effectiveLeaf * 3;
                  return (
                    <span className="text-xs text-muted-foreground/80">
                      Առաջարկվող հարցերի քանակ: {minQEff}–{idealQEff}
                    </span>
                  );
                })()}
              </div>
              {/* Below-minimum warning */}
              {quizLeafCount > 0 && (() => {
                const effectiveLeaf = quizType === "lesson" && quizNodeIds.length > 0
                  ? quizNodeIds.length
                  : quizLeafCount;
                return quizCount < effectiveLeaf ? (
                  <p className="text-xs text-amber-400/80 mt-1.5 flex items-center gap-1">
                    ⚠ Հարցերի քանակը ցածր է նվազագույն սահմանից
                  </p>
                ) : null;
              })()}
              {/* Leaf count info */}
              {quizLeafCount > 0 && (
                <p className="text-xs text-muted-foreground/50 mt-1">
                  {quizType === "lesson" && quizNodeIds.length > 0 ? quizNodeIds.length : quizLeafCount} գիտելիքի հանգույց
                </p>
              )}
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
                disabled={
                  quizCreating ||
                  (quizType === "lesson" && quizLessonIds.length !== 1) ||
                  (quizType === "summary" && quizLessonIds.length < 2)
                }
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
