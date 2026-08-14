import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useAuth } from "@/lib/auth";
import { 
  useGetLessonDetail, getGetLessonDetailQueryKey,
  useStartLessonSession,
  useAdvanceLessonPhase
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

const bloomArmenian = ["Հիշել", "Հասկանալ", "Կիրառել", "Վerlutsnel", "Gnahatsel", "Steghzel"];

// ── Student package types ─────────────────────────────────────────────────────
interface PkgTopic { id: number; sequence: number; title: string; }
interface PkgNode  {
  id: number; topicId: number | null; sequence: number; title: string;
  learningObjective: string | null; theoryContent: string | null;
  childFriendlyExplanation: string | null;
}
interface PkgQuiz  { id: number; title: string; quizType: string | null; isReleased: boolean; }
interface StudentPackage {
  lesson: { id: number; title: string; description: string | null; status: string; subjectName: string; };
  topics: PkgTopic[];
  nodes:  PkgNode[];
  exercises: { id: number; effectiveExerciseText: string; relatedNodeId: number | null; }[];
  dependencies: { fromNodeId: number; toNodeId: number; dependencyType: string; }[];
  quizzes: PkgQuiz[];
}

const quizTypeLabel = (t: string | null) => {
  if (t === "lesson")  return "Դasи թestе";
  if (t === "summary") return "Ampopiч թeste";
  return "Թeste";
};

export default function LessonDetail() {
  const { user, token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { id } = useParams<{ id: string }>();
  const lessonId = parseInt(id || "0", 10);
  const queryClient = useQueryClient();

  const [pkg, setPkg] = useState<StudentPackage | null>(null);
  const [pkgError, setPkgError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !token) setLocation("/login");
  }, [token, authLoading, setLocation]);

  const { data: lesson, isLoading } = useGetLessonDetail(lessonId, {
    query: { queryKey: getGetLessonDetailQueryKey(lessonId), enabled: !!token && !!lessonId },
  });

  // ── Fetch student package (topics, nodes, quizzes) ──────────────────────────
  useEffect(() => {
    if (!token || !lessonId) return;
    let cancelled = false;
    fetch(`/api/lessons/${lessonId}/student-package`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.ok ? r.json() : r.json().then((e: any) => Promise.reject(e.error ?? "Error")))
      .then((data: StudentPackage) => { if (!cancelled) setPkg(data); })
      .catch((err) => { if (!cancelled) setPkgError(String(err)); });
    return () => { cancelled = true; };
  }, [token, lessonId]);

  const startSessionMutation = useStartLessonSession();
  const advancePhaseMutation = useAdvanceLessonPhase();

  if (authLoading || isLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user || !lesson) return null;

  const currentSession = lesson.currentSession;
  const currentPhase   = currentSession ? currentSession.currentPhase : 0;
  const isCompleted    = currentSession?.status === "completed";

  const handleStartLesson = () => {
    startSessionMutation.mutate(
      { data: { lessonId } },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetLessonDetailQueryKey(lessonId) }) }
    );
  };

  const handleAdvancePhase = () => {
    advancePhaseMutation.mutate(
      { lessonId },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetLessonDetailQueryKey(lessonId) }) }
    );
  };

  return (
    <div className="min-h-[100dvh] w-full bg-background text-white pb-20">
      <header className="border-b border-card-border bg-card/50 backdrop-blur-lg sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex justify-between items-center">
          <Link href={`/subjects/${lesson.subjectId}`} className="text-muted-foreground hover:text-white transition-colors">
            ← Հetт
          </Link>
          <Link href={`/chat/${lessonId}`} className="px-4 py-2 bg-gradient-to-r from-primary to-secondary text-white rounded-lg font-medium shadow-lg hover:opacity-90 transition-opacity">
            Harcnel AI-in
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 pt-10 space-y-12">

        {/* ── Title ─────────────────────────────────────────────────────────── */}
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-bold">{lesson.title}</h1>
            <span className="px-3 py-1 bg-card border border-card-border rounded-full text-sm text-secondary">
              {lesson.subjectName}
            </span>
          </div>
          {lesson.description && (
            <p className="text-muted-foreground text-lg">{lesson.description}</p>
          )}
        </div>

        {/* ── Topics + MicroNodes ────────────────────────────────────────────── */}
        {pkg && pkg.topics.length > 0 && (
          <section>
            <h2 className="text-xl font-bold mb-4">🗂️ Tema-ner ev MicroNode-ner</h2>
            <div className="space-y-4">
              {pkg.topics.map((topic) => {
                const topicNodes = pkg.nodes
                  .filter((n) => n.topicId === topic.id)
                  .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
                return (
                  <div key={topic.id} className="bg-card border border-card-border rounded-xl overflow-hidden">
                    <div className="px-4 py-3 border-b border-card-border bg-white/3">
                      <span className="text-xs text-muted-foreground font-mono mr-2">{topic.sequence}.</span>
                      <span className="font-semibold text-white">{topic.title}</span>
                      <span className="ml-2 text-xs text-muted-foreground">({topicNodes.length} g/h)</span>
                    </div>
                    {topicNodes.length > 0 && (
                      <div className="divide-y divide-white/5">
                        {topicNodes.map((node) => (
                          <div key={node.id} className="px-4 py-3">
                            <div className="flex items-start gap-2">
                              <span className="text-xs text-muted-foreground/60 font-mono mt-0.5 shrink-0">{node.sequence}.</span>
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-white">{node.title}</p>
                                {node.learningObjective && (
                                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                                    🎯 {node.learningObjective}
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ── Linked Tests ──────────────────────────────────────────────────── */}
        {pkg && pkg.quizzes.length > 0 && (
          <section>
            <h2 className="text-xl font-bold mb-4">
              📝 Թestere ({pkg.quizzes.length})
            </h2>
            <div className="space-y-3">
              {pkg.quizzes.map((q) => (
                <div key={q.id} className="bg-card border border-card-border rounded-xl px-4 py-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div>
                      <p className="text-sm font-medium text-white truncate">{q.title}</p>
                      <span className="text-xs text-muted-foreground/70">{quizTypeLabel(q.quizType)}</span>
                    </div>
                  </div>
                  <div className="shrink-0">
                    {q.isReleased ? (
                      <Link
                        href={`/quiz/${q.id}/take`}
                        className="px-4 py-1.5 bg-primary/90 hover:bg-primary text-white text-xs font-semibold rounded-lg transition-colors"
                      >
                        ▶ Sksel
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground/60 italic px-2">
                        Derd hasaneli chе
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {pkgError && (
          <div className="text-xs text-destructive/70 px-3 py-2 border border-destructive/20 rounded-lg bg-destructive/5">
            Dasakan package-y bernal che · {pkgError}
          </div>
        )}

        {/* ── Bloom's Taxonomy ──────────────────────────────────────────────── */}
        <section>
          <h2 className="text-xl font-bold mb-6">Blumin Taksonomia</h2>
          <div className="flex items-center justify-between relative">
            <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1 bg-card border border-card-border rounded-full -z-10" />
            {[1, 2, 3, 4, 5, 6].map((level, idx) => {
              const isActive = level <= (lesson.bloomLevel || 1);
              let colorClass = "bg-card border-card-border text-muted-foreground";
              if (isActive) {
                if (level === 1) colorClass = "bg-secondary border-secondary text-white";
                else if (level <= 3) colorClass = "bg-primary border-primary text-white";
                else if (level === 4) colorClass = "bg-accent border-accent text-accent-foreground";
                else colorClass = "bg-red-500 border-red-500 text-white";
              }
              return (
                <div key={level} className="flex flex-col items-center gap-2">
                  <div className={`w-8 h-8 rounded-full border-2 flex items-center justify-center font-bold text-sm transition-colors ${colorClass}`}>
                    {level}
                  </div>
                  <span className={`text-xs font-medium ${isActive ? "text-white" : "text-muted-foreground"}`}>
                    {bloomArmenian[idx]}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        {/* ── Phases ────────────────────────────────────────────────────────── */}
        {(lesson as any).phases?.length > 0 && (
          <section>
            <h2 className="text-xl font-bold mb-6">Dasi phulery</h2>
            <div className="space-y-6 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-card-border">
              {(lesson as any).phases.map((phase: any, idx: number) => {
                const phaseNum = phase.phase;
                const isPast    = currentSession && phaseNum < currentPhase;
                const isCurrent = currentSession && phaseNum === currentPhase && !isCompleted;
                return (
                  <div key={idx} className="relative flex items-start justify-between md:justify-normal md:odd:flex-row-reverse group">
                    <div className={`flex items-center justify-center w-10 h-10 rounded-full border-4 shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 z-10 ${
                      isCurrent ? "bg-primary border-background text-white shadow-[0_0_0_4px_rgba(99,102,241,0.2)]" :
                      isPast || isCompleted ? "bg-secondary border-background text-white" :
                      "bg-card border-background text-muted-foreground"
                    }`}>
                      {isPast || isCompleted ? "✓" : phaseNum}
                    </div>
                    <div className="w-[calc(100%-4rem)] md:w-[calc(50%-3rem)] p-5 rounded-2xl bg-card border border-card-border shadow-lg">
                      <div className="flex justify-between items-start mb-2 gap-2">
                        <h3 className={`font-semibold text-lg ${isCurrent ? "text-primary" : !currentSession ? "text-muted-foreground" : "text-white"}`}>
                          {phase.title}
                        </h3>
                        <span className="px-2 py-1 bg-background/50 rounded text-xs text-muted-foreground whitespace-nowrap">
                          {phase.duration} rope
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mb-4">{phase.description}</p>
                      {phase.activities?.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {phase.activities.map((act: string, i: number) => (
                            <span key={i} className="px-2 py-1 bg-background rounded-md text-xs text-muted-foreground border border-card-border">
                              {act}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ── Action Button ─────────────────────────────────────────────────── */}
        <div className="flex justify-center pb-10">
          {!currentSession ? (
            <button
              onClick={handleStartLesson}
              disabled={startSessionMutation.isPending}
              className="px-8 py-4 bg-primary text-white rounded-xl font-bold text-lg shadow-lg shadow-primary/25 hover:bg-primary/90 transition-colors"
            >
              Sksеl dasy
            </button>
          ) : !isCompleted ? (
            <button
              onClick={handleAdvancePhase}
              disabled={advancePhaseMutation.isPending}
              className="px-8 py-4 bg-secondary text-white rounded-xl font-bold text-lg shadow-lg shadow-secondary/25 hover:bg-secondary/90 transition-colors"
            >
              Hajord phul →
            </button>
          ) : (
            <div className="px-8 py-4 bg-card text-secondary border border-secondary/20 rounded-xl font-bold text-lg flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-secondary" />
              Dasy avartvatsi e
            </div>
          )}
        </div>

      </main>
    </div>
  );
}
