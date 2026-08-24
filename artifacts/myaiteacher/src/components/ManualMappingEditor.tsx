import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth";

type Topic = {
  id: number;
  lessonId: number;
  sequence: number;
  title: string;
  description: string | null;
};

type Node = {
  id: number;
  lessonId: number;
  topicId: number | null;
  sequence: number;
  title: string;
  learningObjective: string | null;
  theoryContent: string | null;
  targetBloomLevel: number | null;
  estimatedMinutes: number | null;
  verbatimTheoryAnchor: string | null;
  commonMisconception: string | null;
  childFriendlyExplanation: string | null;
  basicExamples: string[];
  nonExamples: string[];
  realLifeExamples: string[];
  status: string;
  sourcePage: number | null;
  sourceSupport?: string | null;
  cogPathStatus?: string | null;
};

type Exercise = {
  id: number;
  lessonId: number;
  exerciseId: string;
  sequence: number;
  sourcePage: string | null;
  exerciseTextVerbatim: string;
  exerciseTextEdited: string | null;
  effectiveExerciseText?: string;
  exercisePurpose: string | null;
  relatedNodeId: number | null;
  successCriteria: string | null;
  interactionType: string | null;
  correctAnswer: string | null;
  difficultyLevel: string | null;
  assignment: string | null;
  sourceType: string | null;
  status: string | null;
  learnerContentSafe?: boolean;
};

type CognitiveTask = {
  id: number;
  cognitiveLevelId: number;
  lessonExerciseId: number | null;
  taskProvenance: string;
  exercise: {
    exerciseId: string;
    exerciseTextVerbatim: string;
    exerciseTextEdited: string | null;
  } | null;
};

type CognitiveLevel = {
  id: number;
  cognitiveLevel: string;
  sequence: number;
  isApplicable: boolean;
  isTargetCeiling: boolean;
  provenance: string;
  performanceObjective: string | null;
  successCriterion: string | null;
  minimumIndependentEvidence: number;
  preferredInteractionTypes: string[];
  tasks: CognitiveTask[];
};

type CognitivePath = {
  nodeId: number;
  cogPathStatus: string | null;
  groundingStatus?: string;
  levels: CognitiveLevel[];
};

type TeachingPackageItem = {
  id: number;
  itemType: string;
  content: string;
  cognitiveLevel: string | null;
  status: string;
  provenance: string;
  isPrimary: boolean;
  sequence: number;
};

type TeachingPackageBundle = {
  nodes: Array<{
    id: number;
    items: TeachingPackageItem[];
  }>;
};

type NodeForm = {
  title: string;
  learningObjective: string;
  theoryContent: string;
  sourcePage: string;
  verbatimTheoryAnchor: string;
  commonMisconception: string;
  childFriendlyExplanation: string;
  basicExamples: string;
  nonExamples: string;
  realLifeExamples: string;
  targetBloomLevel: string;
  estimatedMinutes: string;
  topicId: number | null;
};

type ExerciseForm = {
  exerciseText: string;
  sourcePage: string;
  exercisePurpose: string;
  successCriteria: string;
  interactionType: string;
  correctAnswer: string;
  difficultyLevel: string;
  assignment: string;
  relatedNodeId: number | null;
};

type CognitiveForm = {
  cognitiveLevel: string;
  performanceObjective: string;
  successCriterion: string;
  minimumIndependentEvidence: string;
  preferredInteractionTypes: string[];
};

type TeachingForm = {
  itemType: string;
  content: string;
  cognitiveLevel: string;
};

const COGNITIVE_LEVELS = ["remember", "understand", "apply", "analyze", "evaluate", "create"];
const COGNITIVE_LABELS: Record<string, string> = {
  remember: "Հիշել",
  understand: "Հասկանալ",
  apply: "Կիրառել",
  analyze: "Վերլուծել",
  evaluate: "Գնահատել",
  create: "Ստեղծել",
};
const INTERACTION_TYPES = [
  "multiple_choice",
  "multi_select",
  "true_false",
  "matching",
  "classification",
  "ordering",
  "numeric_answer",
  "short_answer",
  "constructed_response",
  "problem_solving",
];
const INTERACTION_LABELS: Record<string, string> = {
  multiple_choice: "Բազմակի ընտրություն",
  multi_select: "Մի քանի ճիշտ պատասխան",
  true_false: "Ճիշտ / սխալ",
  matching: "Համապատասխանեցում",
  classification: "Դասակարգում",
  ordering: "Հերթականության դասավորում",
  numeric_answer: "Թվային պատասխան",
  short_answer: "Կարճ պատասխան",
  constructed_response: "Ընդարձակ պատասխան",
  problem_solving: "Խնդրի լուծում",
};
const TEACHING_TYPES = [
  "MAIN_EXPLANATION",
  "KEY_FACT",
  "RULE_OR_FORMULA",
  "EXAMPLE",
  "COUNTEREXAMPLE",
  "MISCONCEPTION",
  "ALTERNATIVE_EXPLANATION",
  "GUIDING_QUESTION",
  "HINT",
  "RESOURCE",
];
const TEACHING_LABELS: Record<string, string> = {
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

const emptyNodeForm = (topicId: number | null = null): NodeForm => ({
  title: "",
  learningObjective: "",
  theoryContent: "",
  sourcePage: "",
  verbatimTheoryAnchor: "",
  commonMisconception: "",
  childFriendlyExplanation: "",
  basicExamples: "",
  nonExamples: "",
  realLifeExamples: "",
  targetBloomLevel: "1",
  estimatedMinutes: "5",
  topicId,
});

const emptyExerciseForm = (relatedNodeId: number | null = null): ExerciseForm => ({
  exerciseText: "",
  sourcePage: "",
  exercisePurpose: "INDEPENDENT_PRACTICE",
  successCriteria: "",
  interactionType: "",
  correctAnswer: "",
  difficultyLevel: "MEDIUM",
  assignment: "CLASS",
  relatedNodeId,
});

const emptyCognitiveForm = (): CognitiveForm => ({
  cognitiveLevel: "",
  performanceObjective: "",
  successCriterion: "",
  minimumIndependentEvidence: "3",
  preferredInteractionTypes: [],
});

const emptyTeachingForm = (): TeachingForm => ({
  itemType: "MAIN_EXPLANATION",
  content: "",
  cognitiveLevel: "",
});

function splitLines(value: string) {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function fieldClassName(extra = "") {
  return `w-full rounded-lg border border-white/10 bg-black/25 px-2.5 py-2 text-xs text-white placeholder:text-white/25 focus:border-primary/60 focus:outline-none ${extra}`;
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[10px] font-medium uppercase tracking-wide text-white/45">{children}</span>;
}

function WarningList({ node, exercises, path, packageItems }: {
  node: Node;
  exercises: Exercise[];
  path?: CognitivePath;
  packageItems: TeachingPackageItem[];
}) {
  const warnings = [
    !node.learningObjective?.trim() ? "Այս MicroNode-ը չունի ուսումնական նպատակ։" : null,
    !node.sourcePage ? "Աղբյուրային էջը նշված չէ։" : null,
    !path?.levels.length ? "Այս MicroNode-ը չունի ճանաչողական ուղի։" : null,
    !packageItems.some((item) => item.itemType === "MAIN_EXPLANATION" && item.content.trim())
      ? "Ուսուցման բովանդակությունը լրացված չէ։"
      : null,
    exercises.length === 0 ? "Վարժություն կցված չէ։" : null,
  ].filter((warning): warning is string => Boolean(warning));

  if (warnings.length === 0) return null;
  return (
    <div className="mt-3 space-y-1 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-200">
      {warnings.map((warning) => <p key={warning}>⚠️ {warning}</p>)}
    </div>
  );
}

export default function ManualMappingEditor({
  lessonId,
  open,
  onOpenChange,
  onSaved,
}: {
  lessonId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  const { token } = useAuth();
  const [topics, setTopics] = useState<Topic[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [paths, setPaths] = useState<Record<number, CognitivePath>>({});
  const [packageItems, setPackageItems] = useState<Record<number, TeachingPackageItem[]>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [openTopics, setOpenTopics] = useState<Record<number, boolean>>({});
  const [openNodes, setOpenNodes] = useState<Record<number, boolean>>({});
  const [editingTopicId, setEditingTopicId] = useState<number | null>(null);
  const [topicTitle, setTopicTitle] = useState("");
  const [newTopicTitle, setNewTopicTitle] = useState("");
  const [nodeFormId, setNodeFormId] = useState<number | "new" | null>(null);
  const [nodeForm, setNodeForm] = useState<NodeForm>(emptyNodeForm());
  const [exerciseFormId, setExerciseFormId] = useState<number | "new" | null>(null);
  const [exerciseForm, setExerciseForm] = useState<ExerciseForm>(emptyExerciseForm());
  const [cognitiveFormId, setCognitiveFormId] = useState<number | null>(null);
  const [newCognitiveNodeId, setNewCognitiveNodeId] = useState<number | null>(null);
  const [cognitiveForm, setCognitiveForm] = useState<CognitiveForm>(emptyCognitiveForm());
  const [teachingFormId, setTeachingFormId] = useState<number | null>(null);
  const [newTeachingNodeId, setNewTeachingNodeId] = useState<number | null>(null);
  const [teachingForm, setTeachingForm] = useState<TeachingForm>(emptyTeachingForm());

  const authHeaders = useCallback(() => ({ Authorization: `Bearer ${token ?? ""}` }), [token]);

  const request = useCallback(async <T,>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> => {
    const response = await fetch(`/api/lessons/${lessonId}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...(init.headers ?? {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        typeof data?.message === "string"
          ? data.message
          : typeof data?.error === "string" ? data.error : "Գործողությունը չհաջողվեց։",
      );
    }
    return data as T;
  }, [authHeaders, lessonId]);

  const loadAll = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const [topicData, nodeData, exerciseData, packageData] = await Promise.all([
        request<Topic[]>("/topics"),
        request<Node[]>("/nodes"),
        request<Exercise[]>("/exercises"),
        request<TeachingPackageBundle>("/teaching-package"),
      ]);
      const nextPaths: Record<number, CognitivePath> = {};
      await Promise.all(nodeData.map(async (node) => {
        try {
          nextPaths[node.id] = await request<CognitivePath>(`/nodes/${node.id}/cognitive-path`);
        } catch {
          nextPaths[node.id] = { nodeId: node.id, cogPathStatus: null, levels: [] };
        }
      }));
      setTopics([...topicData].sort((a, b) => a.sequence - b.sequence));
      setNodes([...nodeData].sort((a, b) => a.sequence - b.sequence));
      setExercises([...exerciseData].sort((a, b) => a.sequence - b.sequence));
      setPaths(nextPaths);
      setPackageItems(Object.fromEntries(packageData.nodes.map((node) => [node.id, node.items])));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Չհաջողվեց բեռնել քարտեզը։");
    } finally {
      setLoading(false);
    }
  }, [request, token]);

  useEffect(() => {
    if (!open) return;
    setSavedMessage(null);
    void loadAll();
  }, [open, loadAll]);

  const mutate = useCallback(async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setSavedMessage(null);
    try {
      await action();
      await loadAll();
      onSaved?.();
      setSavedMessage("Փոփոխությունը պահպանվել է։");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Գործողությունը չհաջողվեց։");
    } finally {
      setBusy(null);
    }
  }, [loadAll, onSaved]);

  const topicNodes = useMemo(() => {
    const grouped = new Map<number | null, Node[]>();
    for (const node of nodes) {
      const list = grouped.get(node.topicId) ?? [];
      list.push(node);
      grouped.set(node.topicId, list);
    }
    return grouped;
  }, [nodes]);

  const startNodeEdit = (node: Node) => {
    setNodeFormId(node.id);
    setNodeForm({
      title: node.title,
      learningObjective: node.learningObjective ?? "",
      theoryContent: node.theoryContent ?? "",
      sourcePage: node.sourcePage == null ? "" : String(node.sourcePage),
      verbatimTheoryAnchor: node.verbatimTheoryAnchor ?? "",
      commonMisconception: node.commonMisconception ?? "",
      childFriendlyExplanation: node.childFriendlyExplanation ?? "",
      basicExamples: node.basicExamples.join("\n"),
      nonExamples: node.nonExamples.join("\n"),
      realLifeExamples: node.realLifeExamples.join("\n"),
      targetBloomLevel: String(node.targetBloomLevel ?? 1),
      estimatedMinutes: String(node.estimatedMinutes ?? 5),
      topicId: node.topicId,
    });
  };

  const saveNode = () => {
    if (!nodeForm.title.trim()) return;
    const body = {
      title: nodeForm.title.trim(),
      learningObjective: nodeForm.learningObjective,
      theoryContent: nodeForm.theoryContent,
      sourcePage: nodeForm.sourcePage.trim() ? Number(nodeForm.sourcePage) : null,
      verbatimTheoryAnchor: nodeForm.verbatimTheoryAnchor,
      commonMisconception: nodeForm.commonMisconception,
      childFriendlyExplanation: nodeForm.childFriendlyExplanation,
      basicExamples: splitLines(nodeForm.basicExamples),
      nonExamples: splitLines(nodeForm.nonExamples),
      realLifeExamples: splitLines(nodeForm.realLifeExamples),
      targetBloomLevel: Math.min(6, Math.max(1, Number(nodeForm.targetBloomLevel) || 1)),
      estimatedMinutes: Math.max(1, Number(nodeForm.estimatedMinutes) || 5),
      topicId: nodeForm.topicId,
    };
    void mutate("node", async () => {
      if (nodeFormId === "new") {
        await request<Node>("/nodes", { method: "POST", body: JSON.stringify(body) });
      } else if (typeof nodeFormId === "number") {
        await request<Node>(`/nodes/${nodeFormId}/update`, { method: "POST", body: JSON.stringify(body) });
      }
      setNodeFormId(null);
    });
  };

  const saveExercise = () => {
    if (!exerciseForm.exerciseText.trim()) return;
    const body = {
      exerciseTextVerbatim: exerciseForm.exerciseText.trim(),
      exerciseTextEdited: exerciseForm.exerciseText.trim(),
      sourcePage: exerciseForm.sourcePage.trim() || undefined,
      exercisePurpose: exerciseForm.exercisePurpose || undefined,
      successCriteria: exerciseForm.successCriteria,
      interactionType: exerciseForm.interactionType || null,
      correctAnswer: exerciseForm.interactionType === "constructed_response" ? null : exerciseForm.correctAnswer.trim() || null,
      difficultyLevel: exerciseForm.difficultyLevel,
      assignment: exerciseForm.assignment,
      relatedNodeId: exerciseForm.relatedNodeId,
    };
    void mutate("exercise", async () => {
      if (exerciseFormId === "new") {
        await request<Exercise>("/exercises", { method: "POST", body: JSON.stringify(body) });
      } else if (typeof exerciseFormId === "number") {
        const existing = exercises.find((exercise) => exercise.id === exerciseFormId);
        await request<Exercise>(`/exercises/${exerciseFormId}/update`, {
          method: "POST",
          body: JSON.stringify(existing?.sourceType === "textbook"
            ? {
                exerciseTextEdited: exerciseForm.exerciseText,
                successCriteria: exerciseForm.successCriteria,
                interactionType: exerciseForm.interactionType || null,
                correctAnswer: body.correctAnswer,
                difficultyLevel: exerciseForm.difficultyLevel,
                assignment: exerciseForm.assignment,
                exercisePurpose: exerciseForm.exercisePurpose,
                relatedNodeId: exerciseForm.relatedNodeId,
              }
            : body),
        });
      }
      setExerciseFormId(null);
    });
  };

  const addCognitiveLevel = (nodeId: number) => {
    if (!cognitiveForm.cognitiveLevel) return;
    void mutate("cognitive", async () => {
      await request<CognitiveLevel>(`/nodes/${nodeId}/cognitive-levels`, {
        method: "POST",
        body: JSON.stringify({
          cognitiveLevel: cognitiveForm.cognitiveLevel,
          performanceObjective: cognitiveForm.performanceObjective || null,
          successCriterion: cognitiveForm.successCriterion || null,
          minimumIndependentEvidence: Math.max(1, Number(cognitiveForm.minimumIndependentEvidence) || 1),
          preferredInteractionTypes: cognitiveForm.preferredInteractionTypes,
        }),
      });
      setNewCognitiveNodeId(null);
    });
  };

  const updateCognitiveLevel = (nodeId: number, levelId: number) => {
    void mutate("cognitive", async () => {
      await request(`/nodes/${nodeId}/cognitive-levels/${levelId}/update`, {
        method: "POST",
        body: JSON.stringify({
          performanceObjective: cognitiveForm.performanceObjective || null,
          successCriterion: cognitiveForm.successCriterion || null,
          minimumIndependentEvidence: Math.max(1, Number(cognitiveForm.minimumIndependentEvidence) || 1),
          preferredInteractionTypes: cognitiveForm.preferredInteractionTypes,
        }),
      });
      setCognitiveFormId(null);
    });
  };

  const saveTeachingItem = (nodeId: number, itemId?: number) => {
    if (!teachingForm.content.trim()) return;
    void mutate("content", async () => {
      if (itemId) {
        await request(`/nodes/${nodeId}/teaching-package/${itemId}/update`, {
          method: "POST",
          body: JSON.stringify({
            content: teachingForm.content,
            cognitiveLevel: teachingForm.cognitiveLevel || null,
          }),
        });
      } else {
        await request(`/nodes/${nodeId}/teaching-package`, {
          method: "POST",
          body: JSON.stringify({
            itemType: teachingForm.itemType,
            content: teachingForm.content,
            cognitiveLevel: teachingForm.cognitiveLevel || null,
          }),
        });
      }
      setNewTeachingNodeId(null);
    });
  };

  const moveTopic = (topic: Topic, direction: -1 | 1) => {
    const index = topics.findIndex((item) => item.id === topic.id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= topics.length) return;
    const reordered = [...topics];
    [reordered[index], reordered[nextIndex]] = [reordered[nextIndex], reordered[index]];
    void mutate("reorder", async () => {
      await request("/topics/reorder", { method: "POST", body: JSON.stringify({ orderedTopicIds: reordered.map((item) => item.id) }) });
    });
  };

  const moveNode = (node: Node, direction: -1 | 1) => {
    const index = nodes.findIndex((item) => item.id === node.id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= nodes.length) return;
    const reordered = [...nodes];
    [reordered[index], reordered[nextIndex]] = [reordered[nextIndex], reordered[index]];
    void mutate("reorder", async () => {
      await request("/nodes/reorder", { method: "POST", body: JSON.stringify({ orderedNodeIds: reordered.map((item) => item.id) }) });
    });
  };

  const renderNode = (node: Node) => {
    const nodeExercises = exercises.filter((exercise) => exercise.relatedNodeId === node.id);
    const path = paths[node.id];
    const items = packageItems[node.id] ?? [];
    const isOpen = openNodes[node.id] ?? false;
    const isEditing = nodeFormId === node.id;
    const canMoveUp = nodes.findIndex((item) => item.id === node.id) > 0;
    const canMoveDown = nodes.findIndex((item) => item.id === node.id) < nodes.length - 1;
    return (
      <div key={node.id} className="rounded-xl border border-white/10 bg-black/15">
        <div className="flex items-start gap-2 px-3 py-3">
          <div className="flex shrink-0 flex-col gap-0.5 pt-1">
            <button onClick={() => moveNode(node, -1)} disabled={!canMoveUp || !!busy} className="text-xs text-white/35 hover:text-primary disabled:opacity-20">▲</button>
            <button onClick={() => moveNode(node, 1)} disabled={!canMoveDown || !!busy} className="text-xs text-white/35 hover:text-primary disabled:opacity-20">▼</button>
          </div>
          <button onClick={() => setOpenNodes((state) => ({ ...state, [node.id]: !isOpen }))} className="min-w-0 flex-1 text-left">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-mono text-primary/70">{node.sequence}.</span>
              <span className="text-sm font-semibold text-white">{node.title || "Անվերնագիր MicroNode"}</span>
              <span className={`rounded-full px-1.5 py-0.5 text-[9px] ${node.status === "approved" ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-200"}`}>{node.status}</span>
              <span className="text-[10px] text-white/35">{isOpen ? "▲" : "▼"}</span>
            </div>
            <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-white/50">{node.learningObjective || "Ուսումնական նպատակ նշված չէ"}</p>
          </button>
          <div className="flex shrink-0 gap-1">
            <button onClick={() => startNodeEdit(node)} className="rounded bg-white/5 px-2 py-1 text-xs text-white/55 hover:text-white">Խմբ.</button>
            <button onClick={() => {
              if (confirm(`Ջնջե՞լ «${node.title}» MicroNode-ը։`)) {
                void mutate("node", async () => { await request(`/nodes/${node.id}/delete`, { method: "POST" }); });
              }
            }} className="rounded bg-red-400/5 px-2 py-1 text-xs text-red-200/65 hover:text-red-200">Ջնջ.</button>
          </div>
        </div>

        {isOpen && (
          <div className="space-y-4 border-t border-white/8 p-3">
            {isEditing ? (
              <NodeFormView form={nodeForm} topics={topics} onChange={setNodeForm} onSave={saveNode} onCancel={() => setNodeFormId(null)} busy={busy === "node"} />
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="space-y-2">
                  <FieldValue label="Տեսական / աղբյուրային տեքստ" value={node.theoryContent} multiline />
                  <FieldValue label="Դասագրքի էջ" value={node.sourcePage == null ? null : String(node.sourcePage)} />
                  <FieldValue label="Բնօրինակ աղբյուրային հենակետ" value={node.verbatimTheoryAnchor} multiline />
                  {node.sourceSupport && node.sourceSupport !== "SUFFICIENT" && <p className="text-[10px] text-amber-200">⚠️ Աղբյուրի աջակցությունը՝ {node.sourceSupport}</p>}
                </div>
                <div className="space-y-2">
                  <FieldValue label="Ուսուցման նպատակ" value={node.learningObjective} multiline />
                  <FieldValue label="Bloom մակարդակ / րոպե" value={`${node.targetBloomLevel ?? "—"} / ${node.estimatedMinutes ?? "—"}`} />
                  <WarningList node={node} exercises={nodeExercises} path={path} packageItems={items} />
                </div>
              </div>
            )}

            <ExerciseSection
              node={node}
              nodes={nodes}
              exercises={nodeExercises}
              exerciseFormId={exerciseFormId}
              exerciseForm={exerciseForm}
              busy={busy}
              onStartEdit={(exercise) => {
                setExerciseFormId(exercise.id);
                setExerciseForm({
                  exerciseText: exercise.sourceType === "textbook" ? (exercise.exerciseTextEdited ?? exercise.exerciseTextVerbatim) : exercise.exerciseTextVerbatim,
                  sourcePage: exercise.sourcePage ?? "",
                  exercisePurpose: exercise.exercisePurpose ?? "INDEPENDENT_PRACTICE",
                  successCriteria: exercise.successCriteria ?? "",
                  interactionType: exercise.interactionType ?? "",
                  correctAnswer: exercise.correctAnswer ?? "",
                  difficultyLevel: exercise.difficultyLevel ?? "MEDIUM",
                  assignment: exercise.assignment ?? "CLASS",
                  relatedNodeId: exercise.relatedNodeId,
                });
              }}
              onStartNew={() => { setExerciseFormId("new"); setExerciseForm(emptyExerciseForm(node.id)); }}
              onChange={setExerciseForm}
              onSave={saveExercise}
              onCancel={() => setExerciseFormId(null)}
              onDelete={(exerciseId) => {
                if (confirm("Ջնջե՞լ վարժությունը։")) void mutate("exercise", async () => { await request(`/exercises/${exerciseId}/delete`, { method: "POST" }); });
              }}
            />

            <CognitiveSection
              node={node}
              path={path}
              exercises={nodeExercises}
              editId={cognitiveFormId}
              newForNodeId={newCognitiveNodeId}
              form={cognitiveForm}
              busy={busy}
              onAdd={() => { setCognitiveFormId(null); setNewCognitiveNodeId(node.id); setCognitiveForm(emptyCognitiveForm()); }}
              onEdit={(level) => {
                setCognitiveFormId(level.id);
                setCognitiveForm({
                  cognitiveLevel: level.cognitiveLevel,
                  performanceObjective: level.performanceObjective ?? "",
                  successCriterion: level.successCriterion ?? "",
                  minimumIndependentEvidence: String(level.minimumIndependentEvidence),
                  preferredInteractionTypes: [...level.preferredInteractionTypes],
                });
                setNewCognitiveNodeId(null);
              }}
              onChange={setCognitiveForm}
              onSave={(levelId) => levelId ? updateCognitiveLevel(node.id, levelId) : addCognitiveLevel(node.id)}
              onCancel={() => { setCognitiveFormId(null); setNewCognitiveNodeId(null); }}
              onDelete={(levelId) => {
                if (confirm("Ջնջե՞լ ճանաչողական մակարդակը։")) void mutate("cognitive", async () => { await request(`/nodes/${node.id}/cognitive-levels/${levelId}`, { method: "DELETE" }); });
              }}
              onCeiling={(levelId) => void mutate("cognitive", async () => {
                await request(`/nodes/${node.id}/cognitive-levels/${levelId}/update`, { method: "POST", body: JSON.stringify({ isTargetCeiling: true }) });
              })}
              onLink={(levelId, exerciseId) => void mutate("cognitive", async () => {
                await request(`/nodes/${node.id}/cognitive-tasks`, { method: "POST", body: JSON.stringify({ cognitiveLevelId: levelId, lessonExerciseId: exerciseId }) });
              })}
              onUnlink={(taskId) => void mutate("cognitive", async () => { await request(`/nodes/${node.id}/cognitive-tasks/${taskId}`, { method: "DELETE" }); })}
            />

            <TeachingSection
              nodeId={node.id}
              items={items}
              editId={teachingFormId}
              newForNodeId={newTeachingNodeId}
              form={teachingForm}
              busy={busy}
              onAdd={() => { setTeachingFormId(null); setNewTeachingNodeId(node.id); setTeachingForm(emptyTeachingForm()); }}
              onEdit={(item) => {
                setTeachingFormId(item.id);
                setTeachingForm({ itemType: item.itemType, content: item.content, cognitiveLevel: item.cognitiveLevel ?? "" });
                setNewTeachingNodeId(null);
              }}
              onChange={setTeachingForm}
              onSave={(itemId) => saveTeachingItem(node.id, itemId)}
              onCancel={() => { setTeachingFormId(null); setNewTeachingNodeId(null); }}
              onDelete={(itemId) => {
                if (confirm("Ջնջե՞լ ուսուցման բովանդակությունը։")) void mutate("content", async () => { await request(`/nodes/${node.id}/teaching-package/${itemId}/delete`, { method: "POST" }); });
              }}
            />
          </div>
        )}
      </div>
    );
  };

  const standaloneNodes = topicNodes.get(null) ?? [];

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value); }}>
      <DialogContent className="flex h-[92vh] w-[96vw] max-w-[1500px] flex-col overflow-hidden border-white/10 bg-[#0d1017] p-0 text-white">
        <DialogHeader className="shrink-0 border-b border-white/10 px-6 py-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <DialogTitle className="text-lg font-semibold">✍️ Ձեռքով քարտեզագրում</DialogTitle>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-white/50">
                Կառուցեք դասի քարտեզը ձեռքով։ Տվյալները պահպանվում են նույն կառուցվածքում, որն օգտագործում է ավտոմատ քարտեզագրումը։
              </p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => void loadAll()} disabled={!!busy || loading} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-white/60 hover:text-white disabled:opacity-40">↻ Թարմացնել</button>
              <button onClick={() => { setSavedMessage("Բոլոր պահպանված փոփոխությունները ստուգված են։"); void loadAll(); }} disabled={!!busy} className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-black hover:bg-primary/90 disabled:opacity-40">Պահպանել սևագիր</button>
              <button onClick={() => onOpenChange(false)} disabled={!!busy} className="rounded-lg border border-white/10 px-4 py-2 text-xs text-white/70 hover:text-white disabled:opacity-40">Փակել</button>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {error && <div className="mb-4 rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-xs text-red-200">{error}</div>}
          {savedMessage && <div className="mb-4 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.07] px-3 py-2 text-xs text-emerald-200">{savedMessage}</div>}
          {loading ? (
            <div className="flex min-h-48 items-center justify-center text-sm text-white/45">Քարտեզը բեռնվում է…</div>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-white">Դասի կառուցվածքը</p>
                  <p className="mt-1 text-[11px] text-white/40">{topics.length} թեմա · {nodes.length} MicroNode · {exercises.length} վարժություն</p>
                </div>
                <div className="flex gap-2">
                  <input value={newTopicTitle} onChange={(event) => setNewTopicTitle(event.target.value)} placeholder="Նոր թեմայի անվանում" className={fieldClassName("w-56")} />
                  <button disabled={!newTopicTitle.trim() || !!busy} onClick={() => void mutate("topic", async () => {
                    await request<Topic>("/topics", { method: "POST", body: JSON.stringify({ title: newTopicTitle.trim() }) });
                    setNewTopicTitle("");
                  })} className="rounded-lg bg-amber-400/15 px-3 py-2 text-xs font-medium text-amber-100 hover:bg-amber-400/25 disabled:opacity-40">+ Ավելացնել թեմա</button>
                </div>
              </div>

              {topics.map((topic) => {
                const topicOpen = openTopics[topic.id] ?? true;
                const topicNodeList = topicNodes.get(topic.id) ?? [];
                return (
                  <section key={topic.id} className="rounded-2xl border border-amber-300/15 bg-amber-300/[0.025]">
                    <div className="flex items-center gap-2 border-b border-amber-300/10 px-4 py-3">
                      <button onClick={() => setOpenTopics((state) => ({ ...state, [topic.id]: !topicOpen }))} className="min-w-0 flex-1 text-left">
                        <span className="text-[10px] font-mono text-amber-200/55">{topic.sequence}.</span>
                        <span className="ml-2 text-sm font-semibold text-white">{topic.title}</span>
                        <span className="ml-2 text-[10px] text-white/35">{topicNodeList.length} հանգույց · {topicOpen ? "▲" : "▼"}</span>
                      </button>
                      <button onClick={() => moveTopic(topic, -1)} disabled={topic.sequence <= 1 || !!busy} className="text-xs text-white/40 hover:text-amber-200 disabled:opacity-20">▲</button>
                      <button onClick={() => moveTopic(topic, 1)} disabled={topic.sequence >= topics.length || !!busy} className="text-xs text-white/40 hover:text-amber-200 disabled:opacity-20">▼</button>
                      {editingTopicId === topic.id ? (
                        <>
                          <input value={topicTitle} onChange={(event) => setTopicTitle(event.target.value)} className={fieldClassName("w-44")} />
                          <button onClick={() => void mutate("topic", async () => {
                            await request(`/topics/${topic.id}/update`, { method: "POST", body: JSON.stringify({ title: topicTitle }) });
                            setEditingTopicId(null);
                          })} disabled={!topicTitle.trim() || !!busy} className="rounded bg-primary/20 px-2 py-1 text-xs text-primary disabled:opacity-40">Պահ.</button>
                        </>
                      ) : (
                        <button onClick={() => { setEditingTopicId(topic.id); setTopicTitle(topic.title); }} className="rounded bg-white/5 px-2 py-1 text-xs text-white/55 hover:text-white">Խմբ.</button>
                      )}
                      <button onClick={() => {
                        if (confirm(`Ջնջե՞լ «${topic.title}» թեման։ Հանգույցները կդառնան ինքնուրույն։`)) {
                          void mutate("topic", async () => { await request(`/topics/${topic.id}/delete`, { method: "POST" }); });
                        }
                      }} className="rounded bg-red-400/5 px-2 py-1 text-xs text-red-200/65 hover:text-red-200">Ջնջ.</button>
                    </div>
                    {topicOpen && (
                      <div className="space-y-3 p-3">
                        {topicNodeList.map(renderNode)}
                        <button onClick={() => { setNodeFormId("new"); setNodeForm(emptyNodeForm(topic.id)); }} className="w-full rounded-xl border border-dashed border-primary/25 py-2.5 text-xs text-primary/80 hover:bg-primary/5">+ Ավելացնել գիտելիքի հանգույց</button>
                      </div>
                    )}
                  </section>
                );
              })}

              <section className="rounded-2xl border border-white/10 bg-white/[0.02]">
                <div className="border-b border-white/8 px-4 py-3">
                  <p className="text-sm font-semibold text-white">Չկցված MicroNode-եր</p>
                  <p className="mt-1 text-[11px] text-white/40">Կարող եք խմբագրել և թեմա ընտրել MicroNode-ի ձևում։</p>
                </div>
                <div className="space-y-3 p-3">
                  {standaloneNodes.map(renderNode)}
                  <button onClick={() => { setNodeFormId("new"); setNodeForm(emptyNodeForm(null)); }} className="w-full rounded-xl border border-dashed border-primary/25 py-2.5 text-xs text-primary/80 hover:bg-primary/5">+ Ավելացնել գիտելիքի հանգույց</button>
                </div>
              </section>

              {nodeFormId === "new" && (
                <section className="rounded-2xl border border-primary/25 bg-primary/[0.04] p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-sm font-semibold text-primary">Նոր MicroNode</p>
                    <button onClick={() => setNodeFormId(null)} className="text-xs text-white/45 hover:text-white">Չեղարկել</button>
                  </div>
                  <NodeFormView form={nodeForm} topics={topics} onChange={setNodeForm} onSave={saveNode} onCancel={() => setNodeFormId(null)} busy={busy === "node"} />
                </section>
              )}

              <AdditionalExercises
                exercises={exercises.filter((exercise) => exercise.relatedNodeId === null)}
                nodes={nodes}
                exerciseFormId={exerciseFormId}
                exerciseForm={exerciseForm}
                busy={busy}
                onStartEdit={(exercise) => {
                  setExerciseFormId(exercise.id);
                  setExerciseForm({
                    exerciseText: exercise.sourceType === "textbook" ? (exercise.exerciseTextEdited ?? exercise.exerciseTextVerbatim) : exercise.exerciseTextVerbatim,
                    sourcePage: exercise.sourcePage ?? "",
                    exercisePurpose: exercise.exercisePurpose ?? "INDEPENDENT_PRACTICE",
                    successCriteria: exercise.successCriteria ?? "",
                    interactionType: exercise.interactionType ?? "",
                    correctAnswer: exercise.correctAnswer ?? "",
                    difficultyLevel: exercise.difficultyLevel ?? "MEDIUM",
                    assignment: exercise.assignment ?? "CLASS",
                    relatedNodeId: null,
                  });
                }}
                onStartNew={() => { setExerciseFormId("new"); setExerciseForm(emptyExerciseForm(null)); }}
                onChange={setExerciseForm}
                onSave={saveExercise}
                onCancel={() => setExerciseFormId(null)}
                onDelete={(exerciseId) => {
                  if (confirm("Ջնջե՞լ վարժությունը։")) void mutate("exercise", async () => { await request(`/exercises/${exerciseId}/delete`, { method: "POST" }); });
                }}
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FieldValue({ label, value, multiline = false }: { label: string; value: string | null; multiline?: boolean }) {
  return (
    <div>
      <Label>{label}</Label>
      <p className={`mt-1 whitespace-pre-wrap text-xs leading-relaxed ${value?.trim() ? "text-white/75" : "text-white/25 italic"} ${multiline ? "min-h-8" : ""}`}>
        {value?.trim() || "Լրացված չէ"}
      </p>
    </div>
  );
}

function NodeFormView({ form, topics, onChange, onSave, onCancel, busy }: {
  form: NodeForm;
  topics: Topic[];
  onChange: (form: NodeForm) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const update = <K extends keyof NodeForm>(key: K, value: NodeForm[K]) => onChange({ ...form, [key]: value });
  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-2">
        <label className="space-y-1"><Label>Վերնագիր *</Label><input value={form.title} onChange={(event) => update("title", event.target.value)} className={fieldClassName()} /></label>
        <label className="space-y-1"><Label>Թեմա</Label><select value={form.topicId == null ? "null" : String(form.topicId)} onChange={(event) => update("topicId", event.target.value === "null" ? null : Number(event.target.value))} className={fieldClassName("cursor-pointer")}>
          <option value="null">Չկցված</option>
          {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.sequence}. {topic.title}</option>)}
        </select></label>
        <label className="space-y-1 lg:col-span-2"><Label>Ուսումնական նպատակ</Label><textarea rows={3} value={form.learningObjective} onChange={(event) => update("learningObjective", event.target.value)} className={fieldClassName("resize-y")} /></label>
        <label className="space-y-1 lg:col-span-2"><Label>Աղբյուր / տեսություն / կոնտեքստ</Label><textarea rows={5} value={form.theoryContent} onChange={(event) => update("theoryContent", event.target.value)} className={fieldClassName("resize-y")} /></label>
        <label className="space-y-1"><Label>Աղբյուրի էջ</Label><input type="number" min={1} value={form.sourcePage} onChange={(event) => update("sourcePage", event.target.value)} className={fieldClassName()} /></label>
        <label className="space-y-1"><Label>Bloom մակարդակ</Label><select value={form.targetBloomLevel} onChange={(event) => update("targetBloomLevel", event.target.value)} className={fieldClassName("cursor-pointer")}>{[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>{level} · {COGNITIVE_LABELS[COGNITIVE_LEVELS[level - 1]]}</option>)}</select></label>
        <label className="space-y-1"><Label>Դասագրքի բառացի հենակետ</Label><textarea rows={3} value={form.verbatimTheoryAnchor} onChange={(event) => update("verbatimTheoryAnchor", event.target.value)} className={fieldClassName("resize-y")} /></label>
        <label className="space-y-1"><Label>Տևողություն, րոպե</Label><input type="number" min={1} value={form.estimatedMinutes} onChange={(event) => update("estimatedMinutes", event.target.value)} className={fieldClassName()} /></label>
        <label className="space-y-1"><Label>Սովորողին հասկանալի բացատրություն</Label><textarea rows={3} value={form.childFriendlyExplanation} onChange={(event) => update("childFriendlyExplanation", event.target.value)} className={fieldClassName("resize-y")} /></label>
        <label className="space-y-1"><Label>Տարածված սխալ պատկերացում</Label><textarea rows={3} value={form.commonMisconception} onChange={(event) => update("commonMisconception", event.target.value)} className={fieldClassName("resize-y")} /></label>
        <label className="space-y-1"><Label>Հիմնական օրինակներ · մեկ տող՝ մեկ օրինակ</Label><textarea rows={3} value={form.basicExamples} onChange={(event) => update("basicExamples", event.target.value)} className={fieldClassName("resize-y")} /></label>
        <label className="space-y-1"><Label>Հակաօրինակներ · մեկ տող՝ մեկ օրինակ</Label><textarea rows={3} value={form.nonExamples} onChange={(event) => update("nonExamples", event.target.value)} className={fieldClassName("resize-y")} /></label>
        <label className="space-y-1"><Label>Իրական կյանքից օրինակներ</Label><textarea rows={3} value={form.realLifeExamples} onChange={(event) => update("realLifeExamples", event.target.value)} className={fieldClassName("resize-y")} /></label>
      </div>
      <div className="flex gap-2">
        <button onClick={onSave} disabled={busy || !form.title.trim()} className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-black disabled:opacity-40">{busy ? "Պահպանվում է…" : "Պահպանել MicroNode"}</button>
        <button onClick={onCancel} disabled={busy} className="rounded-lg bg-white/8 px-3 py-2 text-xs text-white/65 hover:text-white disabled:opacity-40">Չեղարկել</button>
      </div>
    </div>
  );
}

function ExerciseSection({ node, nodes, exercises, exerciseFormId, exerciseForm, busy, onStartEdit, onStartNew, onChange, onSave, onCancel, onDelete }: {
  node: Node;
  nodes: Node[];
  exercises: Exercise[];
  exerciseFormId: number | "new" | null;
  exerciseForm: ExerciseForm;
  busy: string | null;
  onStartEdit: (exercise: Exercise) => void;
  onStartNew: () => void;
  onChange: (form: ExerciseForm) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: (id: number) => void;
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.02] p-3">
      <div className="mb-2 flex items-center justify-between"><p className="text-xs font-semibold text-white/75">Վարժություններ ({exercises.length})</p><button onClick={onStartNew} className="text-[11px] text-primary hover:text-primary/80">+ Ավելացնել վարժություն</button></div>
      <div className="space-y-2">
        {exercises.map((exercise) => (
          <ExerciseRow key={exercise.id} exercise={exercise} nodes={nodes} editing={exerciseFormId === exercise.id} form={exerciseForm} busy={busy === "exercise"} onEdit={() => onStartEdit(exercise)} onChange={onChange} onSave={onSave} onCancel={onCancel} onDelete={() => onDelete(exercise.id)} />
        ))}
        {exercises.length === 0 && <p className="text-[11px] text-white/30">Այս MicroNode-ին վարժություն կցված չէ։</p>}
        {exerciseFormId === "new" && <ExerciseFormView nodes={nodes} form={exerciseForm} onChange={onChange} onSave={onSave} onCancel={onCancel} busy={busy === "exercise"} />}
      </div>
    </div>
  );
}

function AdditionalExercises({ exercises, nodes, ...props }: Omit<React.ComponentProps<typeof ExerciseSection>, "node">) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <div className="mb-3 flex items-center justify-between"><div><p className="text-sm font-semibold text-white">📦 Լրացուցիչ / չկցված վարժություններ</p><p className="mt-1 text-[11px] text-white/40">Վարժությունները պահպանվում են նույն canonical lesson exercise կառուցվածքում։</p></div><button onClick={props.onStartNew} className="rounded-lg bg-primary/15 px-3 py-2 text-xs text-primary hover:bg-primary/25">+ Ավելացնել</button></div>
      <div className="space-y-2">
        {exercises.map((exercise) => <ExerciseRow key={exercise.id} exercise={exercise} nodes={nodes} editing={props.exerciseFormId === exercise.id} form={props.exerciseForm} busy={props.busy === "exercise"} onEdit={() => props.onStartEdit(exercise)} onChange={props.onChange} onSave={props.onSave} onCancel={props.onCancel} onDelete={() => props.onDelete(exercise.id)} />)}
        {exercises.length === 0 && props.exerciseFormId !== "new" && <p className="text-xs text-white/30">Չկցված վարժություններ չկան։</p>}
        {props.exerciseFormId === "new" && <ExerciseFormView nodes={nodes} form={props.exerciseForm} onChange={props.onChange} onSave={props.onSave} onCancel={props.onCancel} busy={props.busy === "exercise"} />}
      </div>
    </section>
  );
}

function ExerciseRow({ exercise, nodes, editing, form, busy, onEdit, onChange, onSave, onCancel, onDelete }: {
  exercise: Exercise;
  nodes: Node[];
  editing: boolean;
  form: ExerciseForm;
  busy: boolean;
  onEdit: () => void;
  onChange: (form: ExerciseForm) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-lg border border-white/8 bg-black/15 p-2.5">
      {editing ? <ExerciseFormView nodes={nodes} form={form} textbook={exercise.sourceType === "textbook"} onChange={onChange} onSave={onSave} onCancel={onCancel} busy={busy} /> : (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1"><p className="whitespace-pre-wrap text-xs leading-relaxed text-white/85">{exercise.effectiveExerciseText || exercise.exerciseTextEdited || exercise.exerciseTextVerbatim}</p><div className="mt-1 flex flex-wrap gap-2 text-[10px] text-white/35"><span>{exercise.sourceType === "textbook" ? "📖 Դասագրքից" : "✍️ Ձեռքով"}</span>{exercise.sourcePage && <span>Էջ {exercise.sourcePage}</span>}{exercise.assignment && <span>{exercise.assignment === "HOMEWORK" ? "Տնային" : "Դասարանում"}</span>}{exercise.difficultyLevel && <span>{exercise.difficultyLevel}</span>}{exercise.status !== "approved" && <span className="text-amber-200">⚠ Վերանայել</span>}</div></div>
          <div className="flex shrink-0 gap-1"><button onClick={onEdit} className="rounded bg-white/5 px-2 py-1 text-[11px] text-white/55 hover:text-white">Խմբ.</button><button onClick={onDelete} className="rounded bg-red-400/5 px-2 py-1 text-[11px] text-red-200/65 hover:text-red-200">Ջնջ.</button></div>
        </div>
      )}
    </div>
  );
}

function ExerciseFormView({ nodes, form, textbook = false, onChange, onSave, onCancel, busy }: {
  nodes: Node[];
  form: ExerciseForm;
  textbook?: boolean;
  onChange: (form: ExerciseForm) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const update = <K extends keyof ExerciseForm>(key: K, value: ExerciseForm[K]) => onChange({ ...form, [key]: value });
  return (
    <div className="space-y-2">
      <label className="space-y-1"><Label>{textbook ? "Սովորողին ցուցադրվող տեքստ" : "Վարժության տեքստ *"}</Label><textarea rows={4} value={form.exerciseText} onChange={(event) => update("exerciseText", event.target.value)} className={fieldClassName("resize-y")} /></label>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="space-y-1"><Label>Էջ</Label><input value={form.sourcePage} disabled={textbook} onChange={(event) => update("sourcePage", event.target.value)} className={fieldClassName("disabled:opacity-35")} /></label>
        <label className="space-y-1"><Label>Տեսակ</Label><select value={form.interactionType} onChange={(event) => update("interactionType", event.target.value)} className={fieldClassName("cursor-pointer")}>{["", ...INTERACTION_TYPES].map((type) => <option key={type} value={type}>{type ? INTERACTION_LABELS[type] : "Չնշված"}</option>)}</select></label>
        <label className="space-y-1"><Label>Դժվարություն</Label><select value={form.difficultyLevel} onChange={(event) => update("difficultyLevel", event.target.value)} className={fieldClassName("cursor-pointer")}><option value="LOW">Հեշտ</option><option value="MEDIUM">Միջին</option><option value="HIGH">Բարդ</option></select></label>
        <label className="space-y-1"><Label>Դասակարգում</Label><select value={form.assignment} onChange={(event) => update("assignment", event.target.value)} className={fieldClassName("cursor-pointer")}><option value="CLASS">Դասարանում</option><option value="HOMEWORK">Տնային աշխատանք</option></select></label>
      </div>
      <label className="space-y-1"><Label>Հաջողության չափանիշ</Label><input value={form.successCriteria} onChange={(event) => update("successCriteria", event.target.value)} className={fieldClassName()} /></label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1"><Label>Նպատակ</Label><input value={form.exercisePurpose} onChange={(event) => update("exercisePurpose", event.target.value)} className={fieldClassName()} /></label>
        <label className="space-y-1"><Label>Ճիշտ պատասխան</Label><input value={form.correctAnswer} disabled={!form.interactionType || form.interactionType === "constructed_response"} onChange={(event) => update("correctAnswer", event.target.value)} className={fieldClassName("disabled:opacity-35")} /></label>
      </div>
      <label className="space-y-1"><Label>Կցված MicroNode</Label><select value={form.relatedNodeId == null ? "null" : String(form.relatedNodeId)} onChange={(event) => update("relatedNodeId", event.target.value === "null" ? null : Number(event.target.value))} className={fieldClassName("cursor-pointer")}><option value="null">📦 Չկցված / լրացուցիչ</option>{nodes.map((node) => <option key={node.id} value={node.id}>{node.sequence}. {node.title}</option>)}</select></label>
      <div className="flex gap-2"><button onClick={onSave} disabled={busy || !form.exerciseText.trim()} className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-black disabled:opacity-40">{busy ? "Պահպանվում է…" : "Պահպանել"}</button><button onClick={onCancel} disabled={busy} className="rounded-lg bg-white/8 px-3 py-2 text-xs text-white/65 hover:text-white disabled:opacity-40">Չեղարկել</button></div>
    </div>
  );
}

function CognitiveSection({ node, path, exercises, editId, newForNodeId, form, busy, onAdd, onEdit, onChange, onSave, onCancel, onDelete, onCeiling, onLink, onUnlink }: {
  node: Node;
  path?: CognitivePath;
  exercises: Exercise[];
  editId: number | null;
  newForNodeId: number | null;
  form: CognitiveForm;
  busy: string | null;
  onAdd: () => void;
  onEdit: (level: CognitiveLevel) => void;
  onChange: (form: CognitiveForm) => void;
  onSave: (levelId?: number) => void;
  onCancel: () => void;
  onDelete: (levelId: number) => void;
  onCeiling: (levelId: number) => void;
  onLink: (levelId: number, exerciseId: number) => void;
  onUnlink: (taskId: number) => void;
}) {
  const levels = [...(path?.levels ?? [])].sort((a, b) => COGNITIVE_LEVELS.indexOf(a.cognitiveLevel) - COGNITIVE_LEVELS.indexOf(b.cognitiveLevel));
  const update = <K extends keyof CognitiveForm>(key: K, value: CognitiveForm[K]) => onChange({ ...form, [key]: value });
  return (
    <section className="rounded-xl border border-indigo-400/15 bg-indigo-400/[0.03] p-3">
      <div className="mb-2 flex items-center justify-between"><div><p className="text-xs font-semibold text-indigo-200">🧠 Ճանաչողական ուղի</p><p className="mt-1 text-[10px] text-white/35">{path?.cogPathStatus === "confirmed" ? "Հաստատված" : levels.length ? "Սևագիր / վերանայման ենթակա" : "Չկա"}</p></div><button onClick={onAdd} disabled={!!busy} className="text-[11px] text-indigo-200 hover:text-white disabled:opacity-40">+ Ավելացնել ձեռքով</button></div>
      <div className="space-y-2">
        {levels.map((level) => (
          <div key={level.id} className="rounded-lg border border-white/8 bg-black/15 p-2.5">
            {editId === level.id ? (
              <CognitiveFormView form={form} update={update} onSave={() => onSave(level.id)} onCancel={onCancel} busy={busy === "cognitive"} cognitiveLevelEditable={false} />
            ) : (
              <>
                <div className="flex items-center justify-between gap-2"><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold text-indigo-200">{COGNITIVE_LABELS[level.cognitiveLevel] ?? level.cognitiveLevel}</span>{level.isTargetCeiling && <span className="rounded bg-indigo-300/15 px-1.5 py-0.5 text-[9px] text-indigo-100">🎯 Թիրախ</span>}<span className="text-[10px] text-white/35">{level.provenance === "teacher_authored" ? "Ուսուցչի կողմից" : "AI / աղբյուր"}</span></div><div className="flex gap-1"><button onClick={() => onEdit(level)} className="rounded bg-white/5 px-2 py-1 text-[10px] text-white/55 hover:text-white">Խմբ.</button>{!level.isTargetCeiling && <button onClick={() => onCeiling(level.id)} disabled={!!busy} className="rounded bg-indigo-300/10 px-2 py-1 text-[10px] text-indigo-100 disabled:opacity-40">Թիրախ</button>}<button onClick={() => onDelete(level.id)} disabled={!!busy} className="rounded bg-red-400/5 px-2 py-1 text-[10px] text-red-200/65 disabled:opacity-40">Ջնջ.</button></div></div>
                {level.performanceObjective && <p className="mt-2 text-[11px] leading-relaxed text-white/70"><span className="text-white/35">Կատարողական նպատակ՝ </span>{level.performanceObjective}</p>}
                {level.successCriterion && <p className="mt-1 text-[11px] leading-relaxed text-white/70"><span className="text-white/35">Չափանիշ՝ </span>{level.successCriterion}</p>}
                <p className="mt-1 text-[10px] text-white/35">Պահանջվող անկախ ապացույցներ՝ {level.minimumIndependentEvidence}</p>
                {level.tasks.length > 0 && <div className="mt-2 space-y-1">{level.tasks.map((task) => <div key={task.id} className="flex items-start gap-2 text-[10px] text-white/55"><span className="flex-1">📎 {task.exercise?.exerciseTextEdited || task.exercise?.exerciseTextVerbatim || task.exercise?.exerciseId}</span><button onClick={() => onUnlink(task.id)} disabled={!!busy} className="text-red-200/60 hover:text-red-200">✕</button></div>)}</div>}
                {exercises.length > 0 && <select defaultValue="" onChange={(event) => { if (event.target.value) onLink(level.id, Number(event.target.value)); event.target.value = ""; }} disabled={!!busy} className={fieldClassName("mt-2 cursor-pointer text-[10px]")}><option value="">+ Կցել հաստատված CLASS վարժություն</option>{exercises.filter((exercise) => exercise.status === "approved" && exercise.assignment === "CLASS" && !level.tasks.some((task) => task.lessonExerciseId === exercise.id)).map((exercise) => <option key={exercise.id} value={exercise.id}>{exercise.exerciseId} · {(exercise.effectiveExerciseText || exercise.exerciseTextVerbatim).slice(0, 60)}</option>)}</select>}
              </>
            )}
          </div>
        ))}
        {newForNodeId === node.id && <CognitiveFormView form={form} update={update} onSave={() => onSave()} onCancel={onCancel} busy={busy === "cognitive"} cognitiveLevelEditable />}
        {levels.length === 0 && newForNodeId !== node.id && <p className="text-[11px] text-white/35">Ճանաչողական ուղի դեռ չկա։</p>}
      </div>
    </section>
  );
}

function CognitiveFormView({ form, update, onSave, onCancel, busy, cognitiveLevelEditable }: {
  form: CognitiveForm;
  update: <K extends keyof CognitiveForm>(key: K, value: CognitiveForm[K]) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  cognitiveLevelEditable: boolean;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-indigo-300/15 bg-indigo-300/[0.03] p-2.5">
      <div className="grid gap-2 sm:grid-cols-2"><label className="space-y-1"><Label>Կոգնիտիվ մակարդակ</Label><select value={form.cognitiveLevel} disabled={!cognitiveLevelEditable} onChange={(event) => update("cognitiveLevel", event.target.value)} className={fieldClassName(cognitiveLevelEditable ? "cursor-pointer" : "cursor-not-allowed opacity-65")}>{COGNITIVE_LEVELS.map((level) => <option key={level} value={level}>{COGNITIVE_LABELS[level]}</option>)}</select></label><label className="space-y-1"><Label>Անկախ ապացույցներ</Label><input type="number" min={1} max={10} value={form.minimumIndependentEvidence} onChange={(event) => update("minimumIndependentEvidence", event.target.value)} className={fieldClassName()} /></label></div>
      <label className="space-y-1"><Label>Կատարողական նպատակ</Label><textarea rows={2} value={form.performanceObjective} onChange={(event) => update("performanceObjective", event.target.value)} className={fieldClassName("resize-y")} /></label>
      <label className="space-y-1"><Label>Հաջողության չափանիշ</Label><textarea rows={2} value={form.successCriterion} onChange={(event) => update("successCriterion", event.target.value)} className={fieldClassName("resize-y")} /></label>
      <div><Label>Նախընտրելի փոխազդեցություններ</Label><div className="mt-1 flex flex-wrap gap-1">{INTERACTION_TYPES.map((type) => <button type="button" key={type} onClick={() => update("preferredInteractionTypes", form.preferredInteractionTypes.includes(type) ? form.preferredInteractionTypes.filter((item) => item !== type) : [...form.preferredInteractionTypes, type])} className={`rounded px-2 py-1 text-[10px] ${form.preferredInteractionTypes.includes(type) ? "bg-indigo-400/25 text-indigo-100" : "bg-white/5 text-white/40"}`}>{INTERACTION_LABELS[type]}</button>)}</div></div>
      <div className="flex gap-2"><button onClick={onSave} disabled={busy || !form.cognitiveLevel} className="rounded-lg bg-indigo-500/70 px-3 py-2 text-xs text-white disabled:opacity-40">{busy ? "Պահպանվում է…" : "Պահպանել"}</button><button onClick={onCancel} className="rounded-lg bg-white/8 px-3 py-2 text-xs text-white/65 hover:text-white">Չեղարկել</button></div>
    </div>
  );
}

function TeachingSection({ nodeId, items, editId, newForNodeId, form, busy, onAdd, onEdit, onChange, onSave, onCancel, onDelete }: {
  nodeId: number;
  items: TeachingPackageItem[];
  editId: number | null;
  newForNodeId: number | null;
  form: TeachingForm;
  busy: string | null;
  onAdd: () => void;
  onEdit: (item: TeachingPackageItem) => void;
  onChange: (form: TeachingForm) => void;
  onSave: (itemId?: number) => void;
  onCancel: () => void;
  onDelete: (itemId: number) => void;
}) {
  const update = <K extends keyof TeachingForm>(key: K, value: TeachingForm[K]) => onChange({ ...form, [key]: value });
  return (
    <section className="rounded-xl border border-teal-400/15 bg-teal-400/[0.03] p-3">
      <div className="mb-2 flex items-center justify-between"><div><p className="text-xs font-semibold text-teal-100">📚 Ուսուցման բովանդակություն</p><p className="mt-1 text-[10px] text-white/35">{items.length} պահպանված նյութ</p></div><button onClick={onAdd} disabled={!!busy} className="text-[11px] text-teal-100 hover:text-white disabled:opacity-40">+ Ավելացնել ձեռքով</button></div>
      <div className="space-y-2">
        {items.map((item) => <div key={item.id} className="rounded-lg border border-white/8 bg-black/15 p-2.5">{editId === item.id ? <TeachingFormView form={form} update={update} onSave={() => onSave(item.id)} onCancel={onCancel} busy={busy === "content"} /> : <div className="flex items-start gap-2"><div className="min-w-0 flex-1"><p className="text-[10px] text-teal-100/70">{TEACHING_LABELS[item.itemType] ?? item.itemType} · {item.status}</p><p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-white/80">{item.content}</p></div><div className="flex shrink-0 gap-1"><button onClick={() => onEdit(item)} className="rounded bg-white/5 px-2 py-1 text-[10px] text-white/55 hover:text-white">Խմբ.</button><button onClick={() => onDelete(item.id)} disabled={!!busy} className="rounded bg-red-400/5 px-2 py-1 text-[10px] text-red-200/65">Ջնջ.</button></div></div>}</div>)}
        {newForNodeId === nodeId && <TeachingFormView form={form} update={update} onSave={() => onSave()} onCancel={onCancel} busy={busy === "content"} />}
        {items.length === 0 && newForNodeId !== nodeId && <p className="text-[11px] text-white/35">Ուսուցման բովանդակություն դեռ չկա։</p>}
      </div>
    </section>
  );
}

function TeachingFormView({ form, update, onSave, onCancel, busy }: {
  form: TeachingForm;
  update: <K extends keyof TeachingForm>(key: K, value: TeachingForm[K]) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-teal-300/15 bg-teal-300/[0.03] p-2.5">
      <div className="grid gap-2 sm:grid-cols-2"><label className="space-y-1"><Label>Բովանդակության տեսակ</Label><select value={form.itemType} onChange={(event) => update("itemType", event.target.value)} className={fieldClassName("cursor-pointer")}>{TEACHING_TYPES.map((type) => <option key={type} value={type}>{TEACHING_LABELS[type]}</option>)}</select></label><label className="space-y-1"><Label>Կոգնիտիվ մակարդակ</Label><select value={form.cognitiveLevel} onChange={(event) => update("cognitiveLevel", event.target.value)} className={fieldClassName("cursor-pointer")}><option value="">MicroNode-ի համար</option>{COGNITIVE_LEVELS.map((level) => <option key={level} value={level}>{COGNITIVE_LABELS[level]}</option>)}</select></label></div>
      <label className="space-y-1"><Label>Բովանդակություն</Label><textarea rows={5} value={form.content} onChange={(event) => update("content", event.target.value)} className={fieldClassName("resize-y")} /></label>
      <div className="flex gap-2"><button onClick={onSave} disabled={busy || !form.content.trim()} className="rounded-lg bg-teal-400/70 px-3 py-2 text-xs font-semibold text-black disabled:opacity-40">{busy ? "Պահպանվում է…" : "Պահպանել"}</button><button onClick={onCancel} className="rounded-lg bg-white/8 px-3 py-2 text-xs text-white/65 hover:text-white">Չեղարկել</button></div>
    </div>
  );
}