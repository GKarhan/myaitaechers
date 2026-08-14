import { useEffect, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { useAuth } from "@/lib/auth";
import { useQuery } from "@tanstack/react-query";
import { useGetKnowledgeTree, getGetKnowledgeTreeQueryKey } from "@workspace/api-client-react";

// ── KT-1.3 types ──────────────────────────────────────────────────────────────
type FilterTab = "all" | "mastered" | "weak" | "in_progress" | "not_started";
type MasteryLevel4 = "mastered" | "weak" | "in_progress" | "not_started";

interface KTMicroNode {
  lessonNodeId: number;
  title: string;
  sequence: number;
  masteryScore: number;
  confidenceScore: number | null;
  masteryLevel: MasteryLevel4;
}

interface KTTopic {
  topicId: number;
  topicTitle: string;
  topicSequence: number;
  nodes: KTMicroNode[];
}

interface KTLesson {
  lessonId: number;
  lessonTitle: string;
  lessonNumber: number | null;
  topics: KTTopic[];
  ungroupedNodes: KTMicroNode[];
}

interface KTData {
  subjectId: number;
  subjectName: string;
  lessons: KTLesson[];
  recommendations: Array<{ type: string; message: string; topicName: string }>;
}

// ── State helpers ─────────────────────────────────────────────────────────────

function masteryConfig(level: MasteryLevel4) {
  switch (level) {
    case "mastered":    return { icon: "✓", label: "Գիտի",                badge: "bg-secondary/10 text-secondary border-secondary/20",   border: "border-l-secondary",  dot: "bg-secondary"  };
    case "weak":        return { icon: "◐", label: "Մասնակի գիտի",        badge: "bg-accent/10 text-accent border-accent/20",             border: "border-l-accent",     dot: "bg-accent"     };
    case "in_progress": return { icon: "!", label: "Չգիտի",               badge: "bg-primary/10 text-primary border-primary/20",          border: "border-l-primary",    dot: "bg-primary"    };
    case "not_started": return { icon: "○", label: "Դեռ չի ուսումնասիրել", badge: "bg-destructive/10 text-destructive border-destructive/20", border: "border-l-destructive", dot: "bg-destructive" };
  }
}

// Filter a lesson: returns the lesson with only matching nodes (or null if empty).
function filterLesson(lesson: KTLesson, filter: FilterTab): KTLesson | null {
  if (filter === "all") return lesson;
  const filteredTopics = lesson.topics
    .map(t => ({ ...t, nodes: t.nodes.filter(n => n.masteryLevel === filter) }))
    .filter(t => t.nodes.length > 0);
  const filteredUngrouped = lesson.ungroupedNodes.filter(n => n.masteryLevel === filter);
  if (filteredTopics.length === 0 && filteredUngrouped.length === 0) return null;
  return { ...lesson, topics: filteredTopics, ungroupedNodes: filteredUngrouped };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function NodeRow({ node }: { node: KTMicroNode }) {
  const cfg = masteryConfig(node.masteryLevel);
  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 rounded-xl bg-card/50 border border-card-border border-l-4 ${cfg.border}`}
    >
      {/* State icon — distinct symbol per state (not just color) */}
      <span
        className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${cfg.dot} bg-opacity-20`}
        style={{ backgroundColor: "transparent" }}
        aria-label={cfg.label}
      >
        <span className={`text-xs font-bold ${
          node.masteryLevel === "mastered"    ? "text-secondary" :
          node.masteryLevel === "weak"        ? "text-accent"    :
          node.masteryLevel === "in_progress" ? "text-primary"   :
                                                "text-destructive"
        }`}>{cfg.icon}</span>
      </span>

      {/* Title */}
      <span className="flex-1 text-sm font-medium text-white">{node.title}</span>

      {/* Score */}
      <span className="text-sm font-semibold text-muted-foreground w-10 text-right">
        {node.masteryScore}%
      </span>

      {/* Badge */}
      <span className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium border ${cfg.badge}`}>
        {cfg.label}
      </span>
    </div>
  );
}

function TopicGroup({
  topic,
  isOpen,
  onToggle,
}: {
  topic: KTTopic;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="mb-2">
      {/* Topic header — collapsible */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-4 py-2.5 rounded-xl hover:bg-white/5 transition-colors text-left group"
      >
        <span className="text-muted-foreground text-xs w-4 shrink-0">
          {isOpen ? "▼" : "▶"}
        </span>
        <span className="text-sm font-semibold text-white/90 flex-1">{topic.topicTitle}</span>
        <span className="text-xs text-muted-foreground">
          {topic.nodes.length} {topic.nodes.length === 1 ? "հանգ." : "հանգ."}
        </span>
        {/* KT-1.4 will add roll-up % */}
        <span className="text-xs text-muted-foreground ml-2">Յուրացում՝ —</span>
      </button>

      {/* Nodes — only mounted when topic is open (scalability T23) */}
      {isOpen && (
        <div className="ml-6 mt-1 flex flex-col gap-1.5">
          {topic.nodes.map((node) => (
            <NodeRow key={node.lessonNodeId} node={node} />
          ))}
        </div>
      )}
    </div>
  );
}

function LessonSection({
  lesson,
  lessonIndex,
  isOpen,
  onToggle,
  expandedTopics,
  onToggleTopic,
}: {
  lesson: KTLesson;
  lessonIndex: number;
  isOpen: boolean;
  onToggle: () => void;
  expandedTopics: Set<string>;
  onToggleTopic: (key: string) => void;
}) {
  const totalNodes =
    lesson.topics.reduce((s, t) => s + t.nodes.length, 0) +
    lesson.ungroupedNodes.length;

  const lessonLabel = lesson.lessonNumber != null
    ? `Դաս ${lesson.lessonNumber}`
    : `Դաս ${lessonIndex + 1}`;

  return (
    <div className="mb-3 rounded-2xl border border-card-border bg-card overflow-hidden">
      {/* Lesson header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-5 py-4 hover:bg-white/5 transition-colors text-left"
      >
        <span className="text-muted-foreground text-sm w-4 shrink-0">
          {isOpen ? "▼" : "▶"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-primary uppercase tracking-wide mb-0.5">
            {lessonLabel}
          </div>
          <div className="text-sm font-semibold text-white truncate">{lesson.lessonTitle}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-xs text-muted-foreground">{totalNodes} հանգ.</div>
          {/* KT-1.4 will add roll-up % */}
          <div className="text-xs text-muted-foreground">Յուրացում՝ —</div>
        </div>
      </button>

      {/* Lesson body — only mounted when expanded (scalability T23) */}
      {isOpen && (
        <div className="border-t border-card-border px-3 py-3">
          {/* Topic groups */}
          {lesson.topics.map((topic) => {
            const topicKey = `topic-${lesson.lessonId}-${topic.topicId}`;
            return (
              <TopicGroup
                key={topic.topicId}
                topic={topic}
                isOpen={expandedTopics.has(topicKey)}
                onToggle={() => onToggleTopic(topicKey)}
              />
            );
          })}

          {/* Ungrouped nodes (topicId = null) */}
          {lesson.ungroupedNodes.length > 0 && (
            <div className="mb-2">
              <button
                onClick={() => onToggleTopic(`ungrouped-${lesson.lessonId}`)}
                className="w-full flex items-center gap-2 px-4 py-2.5 rounded-xl hover:bg-white/5 transition-colors text-left"
              >
                <span className="text-muted-foreground text-xs w-4 shrink-0">
                  {expandedTopics.has(`ungrouped-${lesson.lessonId}`) ? "▼" : "▶"}
                </span>
                <span className="text-sm font-semibold text-white/60 flex-1 italic">
                  Առանց խմբի
                </span>
                <span className="text-xs text-muted-foreground">
                  {lesson.ungroupedNodes.length} հանգ.
                </span>
                <span className="text-xs text-muted-foreground ml-2">Յուրացում՝ —</span>
              </button>
              {expandedTopics.has(`ungrouped-${lesson.lessonId}`) && (
                <div className="ml-6 mt-1 flex flex-col gap-1.5">
                  {lesson.ungroupedNodes.map((node) => (
                    <NodeRow key={node.lessonNodeId} node={node} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Empty state for this lesson */}
          {lesson.topics.length === 0 && lesson.ungroupedNodes.length === 0 && (
            <div className="px-4 py-4 text-sm text-muted-foreground text-center">
              Ոչ մի հանգույց
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function KnowledgeTree() {
  const { user, token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { id } = useParams<{ id: string }>();
  const subjectId = parseInt(id || "", 10);

  // Parse optional ?studentId and ?classId from URL (teacher view)
  const search = useSearch();
  const searchParams = new URLSearchParams(search);
  const studentIdParam = searchParams.get("studentId");
  const studentId = studentIdParam ? parseInt(studentIdParam, 10) : null;
  const isTeacherView = !!studentId && !isNaN(studentId) && user?.role === "teacher";

  // ── Filter state ─────────────────────────────────────────────────────────
  const [activeFilter, setActiveFilter] = useState<FilterTab>("all");

  // ── Expansion state ───────────────────────────────────────────────────────
  // Set of expanded lesson IDs
  const [expandedLessons, setExpandedLessons] = useState<Set<number>>(new Set());
  // Set of expanded topic keys ("topic-{lessonId}-{topicId}" | "ungrouped-{lessonId}")
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(new Set());

  // ── Reset on subject change (KT-1.2 scroll + filter + KT-1.3 expansion) ──
  useEffect(() => {
    setActiveFilter("all");
    setExpandedLessons(new Set());
    setExpandedTopics(new Set());
    document.getElementById("student-main")?.scrollTo(0, 0);
  }, [subjectId]);

  useEffect(() => {
    if (!authLoading && !token) {
      setLocation("/login");
    }
  }, [token, authLoading, setLocation]);

  // ── Data fetching ─────────────────────────────────────────────────────────
  const { data: ownTreeData, isLoading: ownTreeLoading } = useGetKnowledgeTree(subjectId, {
    query: {
      queryKey: getGetKnowledgeTreeQueryKey(subjectId),
      enabled: !!token && !isNaN(subjectId) && !isTeacherView,
      staleTime: 0,
      refetchOnMount: true,
    },
  });

  const { data: teacherTreeData, isLoading: teacherTreeLoading } = useQuery({
    queryKey: ["knowledge-tree-teacher", subjectId, studentId],
    queryFn: async () => {
      const url = `/api/knowledge-tree/${subjectId}?studentId=${studentId}`;
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const resp = await fetch(url, { headers, credentials: "include" });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `HTTP ${resp.status}`);
      }
      return resp.json();
    },
    enabled: !!token && !isNaN(subjectId) && isTeacherView,
    staleTime: 0,
    refetchOnMount: true,
  });

  const rawData    = isTeacherView ? teacherTreeData  : ownTreeData;
  const treeLoading = isTeacherView ? teacherTreeLoading : ownTreeLoading;

  // ── Auto-expand first lesson + all its topics once data arrives ───────────
  useEffect(() => {
    if (!rawData) return;
    const data = rawData as unknown as KTData;
    if (!data.lessons || data.lessons.length === 0) return;

    const first = data.lessons[0];
    // Only set defaults if expansion state is still empty (don't override user interactions)
    setExpandedLessons(prev => {
      if (prev.size > 0) return prev;
      return new Set([first.lessonId]);
    });
    setExpandedTopics(prev => {
      if (prev.size > 0) return prev;
      const keys = new Set<string>();
      for (const t of first.topics) {
        keys.add(`topic-${first.lessonId}-${t.topicId}`);
      }
      if (first.ungroupedNodes.length > 0) {
        keys.add(`ungrouped-${first.lessonId}`);
      }
      return keys;
    });
  }, [rawData]);

  // ── Loading / auth guard ──────────────────────────────────────────────────
  if (authLoading || treeLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user || !rawData) return null;

  const treeData = rawData as unknown as KTData;
  const allLessons: KTLesson[] = treeData.lessons ?? [];

  // ── Apply filter: returns visible lessons with filtered nodes ─────────────
  const visibleLessons: KTLesson[] = allLessons
    .map(l => filterLesson(l, activeFilter))
    .filter((l): l is KTLesson => l !== null);

  // ── Toggle helpers ────────────────────────────────────────────────────────
  function toggleLesson(lessonId: number) {
    setExpandedLessons(prev => {
      const next = new Set(prev);
      if (next.has(lessonId)) next.delete(lessonId);
      else next.add(lessonId);
      return next;
    });
  }

  function toggleTopic(key: string) {
    setExpandedTopics(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-[100dvh] w-full bg-background text-white pb-20">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="border-b border-card-border bg-card/50 backdrop-blur-lg sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center gap-4">
          {isTeacherView ? (
            <button
              onClick={() => setLocation("/teacher")}
              className="text-muted-foreground hover:text-white transition-colors text-sm"
            >
              ← Հետ
            </button>
          ) : (
            <Link href="/kt-subjects" className="text-muted-foreground hover:text-white transition-colors text-sm">
              ← Հետ
            </Link>
          )}
          <div>
            <div className="font-bold text-lg bg-clip-text text-transparent bg-gradient-to-r from-primary to-secondary">
              {treeData.subjectName}
            </div>
            <div className="text-xs text-muted-foreground">Գիտելիքի ծառ</div>
          </div>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-6 pt-6">

        {/* ── Filter tabs ─────────────────────────────────────────────────── */}
        <div className="flex flex-wrap gap-2 mb-6">
          {(
            [
              { key: "all",         label: "Բոլորը",              dot: null },
              { key: "mastered",    label: "Գիտի",                dot: "bg-secondary"   },
              { key: "weak",        label: "Մասնակի գիտի",        dot: "bg-accent"      },
              { key: "in_progress", label: "Չգիտի",               dot: "bg-primary"     },
              { key: "not_started", label: "Դեռ չի ուսումնասիրել", dot: "bg-destructive" },
            ] as const
          ).map(({ key, label, dot }) => (
            <button
              key={key}
              onClick={() => setActiveFilter(key)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border flex items-center gap-1.5 ${
                activeFilter === key
                  ? "bg-white/10 text-white border-white/30"
                  : "bg-card border-card-border text-muted-foreground hover:text-white"
              }`}
            >
              {dot && <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />}
              {label}
            </button>
          ))}
        </div>

        {/* ── Lesson list ─────────────────────────────────────────────────── */}
        {visibleLessons.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground text-sm">
            {activeFilter === "all"
              ? "Ոչ մի հանգույց դեռ"
              : "Ֆիլտրին համապատասխանող հանգույց չկա"}
          </div>
        ) : (
          visibleLessons.map((lesson, idx) => (
            <LessonSection
              key={lesson.lessonId}
              lesson={lesson}
              lessonIndex={idx}
              isOpen={expandedLessons.has(lesson.lessonId)}
              onToggle={() => toggleLesson(lesson.lessonId)}
              expandedTopics={expandedTopics}
              onToggleTopic={toggleTopic}
            />
          ))
        )}

        {/* ── AI recommendations ──────────────────────────────────────────── */}
        {treeData.recommendations && treeData.recommendations.length > 0 && (
          <div className="mt-8">
            <h2 className="text-base font-bold mb-4 text-white/70">AI-ի Առաջարկություններ</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {treeData.recommendations.map((rec, idx) => {
                const borderClass =
                  rec.type === "start"  ? "border-l-primary"   :
                  rec.type === "review" ? "border-l-accent"    :
                                          "border-l-secondary";
                const bgClass =
                  rec.type === "start"  ? "bg-primary/5"   :
                  rec.type === "review" ? "bg-accent/5"    :
                                          "bg-secondary/5";
                const dotClass =
                  rec.type === "start"  ? "bg-primary"   :
                  rec.type === "review" ? "bg-accent"    :
                                          "bg-secondary";
                return (
                  <div
                    key={idx}
                    className={`p-4 rounded-xl border border-card-border border-l-4 ${borderClass} ${bgClass}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`w-2 h-2 rounded-full ${dotClass}`} />
                      <h4 className="font-semibold text-white text-sm">{rec.topicName}</h4>
                    </div>
                    <p className="text-xs text-muted-foreground">{rec.message}</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
