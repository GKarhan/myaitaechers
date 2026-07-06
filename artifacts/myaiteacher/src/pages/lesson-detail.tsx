import { useEffect } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useAuth } from "@/lib/auth";
import { 
  useGetLessonDetail, getGetLessonDetailQueryKey,
  useStartLessonSession,
  useAdvanceLessonPhase
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

const bloomArmenian = ["Հիշել", "Հասկանալ", "Կիրառել", "Վերլուծել", "Գնահատել", "Ստեղծել"];

export default function LessonDetail() {
  const { user, token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { id } = useParams<{ id: string }>();
  const lessonId = parseInt(id || "0", 10);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!authLoading && !token) {
      setLocation("/login");
    }
  }, [token, authLoading, setLocation]);

  const { data: lesson, isLoading } = useGetLessonDetail(lessonId, {
    query: {
      queryKey: getGetLessonDetailQueryKey(lessonId),
      enabled: !!token && !!lessonId,
    }
  });

  const startSessionMutation = useStartLessonSession();
  const advancePhaseMutation = useAdvanceLessonPhase();

  if (authLoading || isLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!user || !lesson) return null;

  const currentLevel = lesson.bloomLevel || 1;
  const currentSession = lesson.currentSession;
  const currentPhase = currentSession ? currentSession.currentPhase : 0;
  
  const handleStartLesson = () => {
    startSessionMutation.mutate(
      { data: { lessonId } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetLessonDetailQueryKey(lessonId) });
        }
      }
    );
  };

  const handleAdvancePhase = () => {
    advancePhaseMutation.mutate(
      { lessonId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetLessonDetailQueryKey(lessonId) });
        }
      }
    );
  };

  const isCompleted = currentSession?.status === "completed";

  return (
    <div className="min-h-[100dvh] w-full bg-background text-white pb-20">
      <header className="border-b border-card-border bg-card/50 backdrop-blur-lg sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <Link href={`/subjects/${lesson.subjectId}`} className="text-muted-foreground hover:text-white transition-colors">
              ← Հետ
            </Link>
          </div>
          <Link href={`/chat/${lessonId}`} className="px-4 py-2 bg-gradient-to-r from-primary to-secondary text-white rounded-lg font-medium shadow-lg hover:opacity-90 transition-opacity">
            Հարցնել AI-ին
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 pt-10">
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-bold">{lesson.title}</h1>
            <span className="px-3 py-1 bg-card border border-card-border rounded-full text-sm text-secondary">
              {lesson.subjectName}
            </span>
          </div>
          <p className="text-muted-foreground text-lg">{lesson.description}</p>
        </div>

        {/* Bloom's Taxonomy */}
        <div className="mb-12">
          <h2 className="text-xl font-bold mb-6">Բլումի Տաքսոնոմիա</h2>
          <div className="flex items-center justify-between relative">
            <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1 bg-card border border-card-border rounded-full -z-10" />
            {[1, 2, 3, 4, 5, 6].map((level, idx) => {
              const isActive = level <= currentLevel;
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
                  <span className={`text-xs font-medium ${isActive ? 'text-white' : 'text-muted-foreground'}`}>
                    {bloomArmenian[idx]}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Phases */}
        <div className="mb-12">
          <h2 className="text-xl font-bold mb-6">Դասի փուլերը</h2>
          <div className="space-y-6 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-card-border">
            {lesson.phases?.map((phase, idx) => {
              const phaseNum = phase.phase;
              const isPast = currentSession && phaseNum < currentPhase;
              const isCurrent = currentSession && phaseNum === currentPhase && !isCompleted;
              const isUpcoming = !currentSession || phaseNum > currentPhase || (isCompleted && phaseNum > currentPhase);

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
                      <h3 className={`font-semibold text-lg ${isCurrent ? 'text-primary' : isUpcoming ? 'text-muted-foreground' : 'text-white'}`}>
                        {phase.title}
                      </h3>
                      <span className="px-2 py-1 bg-background/50 rounded text-xs text-muted-foreground whitespace-nowrap">
                        {phase.duration} րոպե
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground mb-4">{phase.description}</p>
                    {phase.activities && phase.activities.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {phase.activities.map((act, i) => (
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
        </div>

        {/* Action Button */}
        <div className="flex justify-center pb-10">
          {!currentSession ? (
            <button
              onClick={handleStartLesson}
              disabled={startSessionMutation.isPending}
              className="px-8 py-4 bg-primary text-white rounded-xl font-bold text-lg shadow-lg shadow-primary/25 hover:bg-primary/90 transition-colors"
            >
              Սկսել դասը
            </button>
          ) : !isCompleted ? (
            <button
              onClick={handleAdvancePhase}
              disabled={advancePhaseMutation.isPending}
              className="px-8 py-4 bg-secondary text-white rounded-xl font-bold text-lg shadow-lg shadow-secondary/25 hover:bg-secondary/90 transition-colors"
            >
              Հաջորդ փուլ →
            </button>
          ) : (
            <div className="px-8 py-4 bg-card text-secondary border border-secondary/20 rounded-xl font-bold text-lg flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-secondary"></span>
              Դասը ավարտված է
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
