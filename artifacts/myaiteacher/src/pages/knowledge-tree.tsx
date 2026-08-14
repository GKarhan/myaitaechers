import { useEffect, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { useAuth } from "@/lib/auth";
import { useQuery } from "@tanstack/react-query";
import { useGetKnowledgeTree, getGetKnowledgeTreeQueryKey } from "@workspace/api-client-react";

// 4 visible blocks: mastered=Գիտի | weak=Մասնակի գիտի | in_progress=Չգիտի | not_started=Դեռ չի ուսումնասիրել
// needs_review folds into mastered in the UI (5-state API → 4-state display)
type FilterTab = "all" | "mastered" | "weak" | "in_progress" | "not_started";

export default function KnowledgeTree() {
  const { user, token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { id } = useParams<{ id: string }>();
  const subjectId = parseInt(id || "", 10);

  // Parse optional ?studentId and ?classId from URL
  const search = useSearch();
  const searchParams = new URLSearchParams(search);
  const studentIdParam = searchParams.get("studentId");
  const studentId = studentIdParam ? parseInt(studentIdParam, 10) : null;

  // Teacher-view mode: teacher is viewing a specific student's tree
  const isTeacherView = !!studentId && !isNaN(studentId) && user?.role === "teacher";

  const [activeFilter, setActiveFilter] = useState<FilterTab>("all");

  // Reset filter to "all" when the subject changes so SPA navigation
  // between subjects never inherits a stale mastery filter.
  useEffect(() => {
    setActiveFilter("all");
  }, [subjectId]);

  useEffect(() => {
    if (!authLoading && !token) {
      setLocation("/login");
    }
  }, [token, authLoading, setLocation]);

  // ── Student viewing their own tree: use the generated hook ────────────────
  const { data: ownTreeData, isLoading: ownTreeLoading } = useGetKnowledgeTree(subjectId, {
    query: {
      queryKey: getGetKnowledgeTreeQueryKey(subjectId),
      enabled: !!token && !isNaN(subjectId) && !isTeacherView,
      staleTime: 0,        // always refetch on mount — ensures fresh state after any quiz
      refetchOnMount: true,
    },
  });

  // ── Teacher viewing a student's tree: direct fetch with ?studentId= param ─
  // The generated hook does not support extra query params, so we use a plain
  // useQuery here.  The web app uses session cookies for auth; the token is
  // also passed as a Bearer header to match the API server's requireAuth flow.
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

  const treeData  = isTeacherView ? teacherTreeData  : ownTreeData;
  const treeLoading = isTeacherView ? teacherTreeLoading : ownTreeLoading;

  if (authLoading || treeLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!user || !treeData) return null;

  const rawTopics = (treeData.topics as any[]) ?? [];

  // needs_review is a 5th server state that folds into "mastered" for the 4-block display.
  // Normalize before filtering so the "Գիտի" tab correctly shows needs_review nodes.
  const normalizedTopics = rawTopics.map((t: any) => ({
    ...t,
    masteryLevel: t.masteryLevel === "needs_review" ? "mastered" : t.masteryLevel,
  }));

  const filteredTopics = normalizedTopics.filter((topic: any) => {
    if (activeFilter === "all") return true;
    return topic.masteryLevel === activeFilter;
  });

  return (
    <div className="min-h-[100dvh] w-full bg-background text-white pb-20">
      <header className="border-b border-card-border bg-card/50 backdrop-blur-lg sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-4">
          {/* Back navigation:
              - Teacher-view: setLocation("/teacher") — stable even after direct
                page load or refresh (window.history.back() silently fails then).
              - Student-view: hardcoded link to /subjects/:id as before.     */}
          {isTeacherView ? (
            <button
              onClick={() => setLocation("/teacher")}
              className="text-muted-foreground hover:text-white transition-colors"
            >
              ← Հետ
            </button>
          ) : (
            <Link href="/kt-subjects" className="text-muted-foreground hover:text-white transition-colors">
              ← Հետ
            </Link>
          )}
          <div className="font-bold text-xl bg-clip-text text-transparent bg-gradient-to-r from-primary to-secondary">
            {treeData.subjectName} — Գիտելիքի ծառ
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 pt-10">

        {/* ── Filter tabs ────────────────────────────────────────────────── */}
        <div className="flex flex-wrap gap-2 mb-8 border-b border-card-border pb-6">
          <button
            onClick={() => setActiveFilter("all")}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors border ${activeFilter === "all" ? "bg-white text-background border-white" : "bg-card border-card-border text-muted-foreground hover:text-white"}`}
          >
            Բոլորը
          </button>
          <button
            onClick={() => setActiveFilter("mastered")}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors border flex items-center gap-2 ${activeFilter === "mastered" ? "bg-secondary/20 text-secondary border-secondary/50" : "bg-card border-card-border text-muted-foreground hover:text-white"}`}
          >
            <span className="w-2 h-2 rounded-full bg-secondary"></span>
            Գիտի
          </button>
          <button
            onClick={() => setActiveFilter("weak")}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors border flex items-center gap-2 ${activeFilter === "weak" ? "bg-accent/20 text-accent border-accent/50" : "bg-card border-card-border text-muted-foreground hover:text-white"}`}
          >
            <span className="w-2 h-2 rounded-full bg-accent"></span>
            Մասնակի գիտի
          </button>
          <button
            onClick={() => setActiveFilter("in_progress")}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors border flex items-center gap-2 ${activeFilter === "in_progress" ? "bg-primary/20 text-primary border-primary/50" : "bg-card border-card-border text-muted-foreground hover:text-white"}`}
          >
            <span className="w-2 h-2 rounded-full bg-primary"></span>
            Չգիտի
          </button>
          <button
            onClick={() => setActiveFilter("not_started")}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors border flex items-center gap-2 ${activeFilter === "not_started" ? "bg-destructive/20 text-destructive border-destructive/50" : "bg-card border-card-border text-muted-foreground hover:text-white"}`}
          >
            <span className="w-2 h-2 rounded-full bg-destructive"></span>
            Դեռ չի ուսումնասիրել
          </button>
        </div>

        {/* ── Topic cards ────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {filteredTopics.map((topic: any, idx: number) => {
            const isMastered   = topic.masteryLevel === "mastered";
            const isWeak       = topic.masteryLevel === "weak";
            const isInProgress = topic.masteryLevel === "in_progress";
            const isNotStarted = !isMastered && !isWeak && !isInProgress;

            let borderColorClass = "";
            let badgeText        = "";
            let badgeColorClass  = "";
            let dotColorClass    = "";

            if (isMastered) {
              // Includes needs_review (folded into mastered — no 5th block)
              borderColorClass = "border-l-secondary";
              badgeText        = "Գիտի";
              badgeColorClass  = "bg-secondary/10 text-secondary border-secondary/20";
              dotColorClass    = "bg-secondary";
            } else if (isWeak) {
              borderColorClass = "border-l-accent";
              badgeText        = "Մասնակի գիտի";
              badgeColorClass  = "bg-accent/10 text-accent border-accent/20";
              dotColorClass    = "bg-accent";
            } else if (isInProgress) {
              borderColorClass = "border-l-primary";
              badgeText        = "Չգիտի";
              badgeColorClass  = "bg-primary/10 text-primary border-primary/20";
              dotColorClass    = "bg-primary";
            } else {
              // not_started = no quiz evidence yet → «Դեռ չի ուսումնասիրել»
              borderColorClass = "border-l-destructive";
              badgeText        = "Դեռ չի ուսումնասիրել";
              badgeColorClass  = "bg-destructive/10 text-destructive border-destructive/20";
              dotColorClass    = "bg-destructive";
            }

            return (
              <div
                key={topic.lessonNodeId ?? topic.id ?? idx}
                className={`p-6 rounded-2xl bg-card border border-card-border border-l-4 ${borderColorClass} flex flex-col h-full`}
              >
                <div className="flex justify-between items-start mb-4">
                  <h3 className="font-semibold text-lg leading-tight flex-1 pr-4">{topic.topicName}</h3>
                  <div className="font-bold text-xl">{topic.score}%</div>
                </div>

                <div className={`self-start px-2.5 py-1 rounded-md text-xs font-medium border flex items-center gap-1.5 mb-6 ${badgeColorClass}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${dotColorClass}`}></span>
                  {badgeText}
                </div>

                <div className="mt-auto flex gap-3">
                  {isMastered && (
                    <button className="flex-1 py-2 bg-card border border-card-border hover:bg-secondary/10 hover:border-secondary/30 hover:text-secondary rounded-lg transition-colors text-sm font-medium">
                      Կրկնել
                    </button>
                  )}
                  {isWeak && (
                    <>
                      <button className="flex-1 py-2 bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 rounded-lg transition-colors text-sm font-medium">
                        Սովորել
                      </button>
                      <button className="flex-1 py-2 bg-card border border-card-border hover:bg-accent/10 hover:border-accent/30 hover:text-accent rounded-lg transition-colors text-sm font-medium">
                        Կրկնել
                      </button>
                    </>
                  )}
                  {isInProgress && (
                    <button className="flex-1 py-2 bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 rounded-lg transition-colors text-sm font-medium">
                      Շարունակել
                    </button>
                  )}
                  {isNotStarted && (
                    <button className="flex-1 py-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg transition-colors text-sm font-medium shadow-lg shadow-primary/20">
                      Սովորել
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── AI recommendations ─────────────────────────────────────────── */}
        {treeData.recommendations && treeData.recommendations.length > 0 && (
          <div>
            <h2 className="text-2xl font-bold mb-6">AI-ի Առաջարկություններ</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {(treeData.recommendations as any[]).map((rec, idx) => {
                let borderClass = "";
                let bgClass     = "";
                let dotClass    = "";

                if (rec.type === "start") {
                  borderClass = "border-l-primary";
                  bgClass     = "bg-primary/5";
                  dotClass    = "bg-primary";
                } else if (rec.type === "review") {
                  borderClass = "border-l-accent";
                  bgClass     = "bg-accent/5";
                  dotClass    = "bg-accent";
                } else if (rec.type === "repeat") {
                  borderClass = "border-l-secondary";
                  bgClass     = "bg-secondary/5";
                  dotClass    = "bg-secondary";
                }

                return (
                  <div key={idx} className={`p-5 rounded-xl border border-card-border border-l-4 ${borderClass} ${bgClass}`}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`w-2 h-2 rounded-full ${dotClass}`}></span>
                      <h4 className="font-semibold text-white">{rec.topicName}</h4>
                    </div>
                    <p className="text-sm text-muted-foreground">{rec.message}</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

      </main>
    </div>
  );
}
