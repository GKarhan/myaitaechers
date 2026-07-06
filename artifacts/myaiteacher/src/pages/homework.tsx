import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetHomework,
  getGetHomeworkQueryKey,
  useGetHomeworkById,
  getGetHomeworkByIdQueryKey,
  useSubmitHomework,
  useGradeHomework,
  useAiGradeSuggest,
  HomeworkItem,
} from "@workspace/api-client-react";

type FilterTab = "all" | "not_submitted" | "pending" | "graded";

export default function HomeworkPage() {
  const { token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [filter, setFilter] = useState<FilterTab>("all");
  const [selectedHomeworkId, setSelectedHomeworkId] = useState<number | null>(null);
  const [isSubmitModalOpen, setIsSubmitModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [isGradeModalOpen, setIsGradeModalOpen] = useState(false);

  // Form states
  const [answerText, setAnswerText] = useState("");
  const [gradeScore, setGradeScore] = useState<number | "">("");
  const [gradeFeedback, setGradeFeedback] = useState("");

  useEffect(() => {
    if (!authLoading && !token) {
      setLocation("/login");
    }
  }, [token, authLoading, setLocation]);

  const { data: homeworks, isLoading: homeworksLoading } = useGetHomework({
    query: {
      queryKey: getGetHomeworkQueryKey(),
      enabled: !!token,
    },
  });

  const { data: detailData, isLoading: detailLoading } = useGetHomeworkById(
    selectedHomeworkId || 0,
    {
      query: {
        queryKey: getGetHomeworkByIdQueryKey(selectedHomeworkId || 0),
        enabled: !!selectedHomeworkId && (isDetailModalOpen || isSubmitModalOpen || isGradeModalOpen),
      },
    }
  );

  const submitMutation = useSubmitHomework();
  const gradeMutation = useGradeHomework();
  const aiGradeMutation = useAiGradeSuggest();

  const filteredHomeworks = homeworks?.filter((hw) => {
    if (filter === "all") return true;
    return hw.status === filter;
  });

  const handleOpenSubmit = (id: number) => {
    setSelectedHomeworkId(id);
    setAnswerText("");
    setIsSubmitModalOpen(true);
  };

  const handleOpenDetail = (id: number) => {
    setSelectedHomeworkId(id);
    setIsDetailModalOpen(true);
  };

  const handleOpenGrade = (id: number) => {
    setSelectedHomeworkId(id);
    setGradeScore("");
    setGradeFeedback("");
    setIsGradeModalOpen(true);
  };

  const closeModals = () => {
    setIsSubmitModalOpen(false);
    setIsDetailModalOpen(false);
    setIsGradeModalOpen(false);
    setTimeout(() => setSelectedHomeworkId(null), 200);
  };

  const onSubmit = () => {
    if (!selectedHomeworkId || !answerText.trim()) return;
    submitMutation.mutate(
      { homeworkId: selectedHomeworkId, data: { answer: answerText } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetHomeworkQueryKey() });
          toast({
            title: "Հաջողություն",
            description: "Տնային աշխատանքը հաջողությամբ ներկայացվել է։",
            variant: "default",
          });
          closeModals();
        },
        onError: () => {
          toast({
            title: "Սխալ",
            description: "Չհաջողվեց ներկայացնել տնային աշխատանքը։",
            variant: "destructive",
          });
        },
      }
    );
  };

  const onAiSuggest = () => {
    if (!selectedHomeworkId) return;
    aiGradeMutation.mutate(
      { homeworkId: selectedHomeworkId },
      {
        onSuccess: (data) => {
          setGradeScore(data.score);
          setGradeFeedback(data.feedback);
        },
        onError: () => {
          toast({
            title: "Սխալ",
            description: "AI գնահատումը ձախողվեց։",
            variant: "destructive",
          });
        },
      }
    );
  };

  const onGrade = () => {
    if (!selectedHomeworkId || gradeScore === "") return;
    gradeMutation.mutate(
      { homeworkId: selectedHomeworkId, data: { score: Number(gradeScore), feedback: gradeFeedback } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetHomeworkQueryKey() });
          toast({
            title: "Հաջողություն",
            description: "Գնահատականը հաջողությամբ պահպանվել է։",
            variant: "default",
          });
          closeModals();
        },
        onError: () => {
          toast({
            title: "Սխալ",
            description: "Չհաջողվեց պահպանել գնահատականը։",
            variant: "destructive",
          });
        },
      }
    );
  };

  if (authLoading) return <div className="min-h-screen bg-background" />;

  return (
    <div className="min-h-[100dvh] w-full bg-background text-white pb-20">
      <header className="border-b border-card-border bg-card/50 backdrop-blur-lg sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center gap-4">
          <Link href="/dashboard" className="p-2 -ml-2 rounded-full hover:bg-white/10 transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </Link>
          <h1 className="font-bold text-xl">Տնային աշխատանք</h1>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 pt-8">
        <div className="flex flex-wrap gap-2 mb-8">
          {[
            { id: "all", label: "Բոլորը" },
            { id: "not_submitted", label: "Չներկայացված 🔴" },
            { id: "pending", label: "Սպասում է 🟡" },
            { id: "graded", label: "Գնահատված 🟢" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setFilter(tab.id as FilterTab)}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                filter === tab.id
                  ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20"
                  : "bg-card border border-card-border text-muted-foreground hover:text-white"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {homeworksLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-40 rounded-2xl bg-card border border-card-border animate-pulse" />
            ))}
          </div>
        ) : filteredHomeworks?.length === 0 ? (
          <div className="py-20 text-center flex flex-col items-center">
            <div className="text-6xl mb-4">📋</div>
            <h2 className="text-xl font-bold mb-2">Տնային աշխատանքներ չկան</h2>
            <p className="text-muted-foreground">Այս բաժնում դեռ առաջադրանքներ չկան։</p>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredHomeworks?.map((hw) => (
              <div key={hw.id} className="p-6 rounded-2xl bg-card border border-card-border hover:border-white/10 transition-colors shadow-lg shadow-black/20 flex flex-col sm:flex-row gap-6">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-3">
                    <StatusBadge status={hw.status} />
                    <LevelBadge level={hw.level} />
                  </div>
                  <h3 className="text-lg font-bold mb-1">{hw.title}</h3>
                  <div className="text-sm text-primary mb-3">{hw.subjectName} <span className="text-muted-foreground mx-1">→</span> {hw.lessonTitle}</div>
                  <p className="text-muted-foreground text-sm line-clamp-2 mb-4">{hw.task}</p>
                  <div className="text-xs text-muted-foreground">
                    Ամսաթիվ: {new Date(hw.createdAt).toLocaleDateString('hy-AM')}
                  </div>
                </div>
                
                <div className="flex flex-col justify-end items-end gap-3 sm:w-48 shrink-0">
                  {hw.status === 'graded' && hw.score !== null && (
                    <div className="text-2xl font-bold text-secondary">{hw.score}/100</div>
                  )}
                  {hw.status === 'not_submitted' ? (
                    <button
                      onClick={() => handleOpenSubmit(hw.id)}
                      className="w-full px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg text-sm font-bold transition-colors"
                    >
                      Ներկայացնել
                    </button>
                  ) : (
                    <div className="w-full flex gap-2">
                      <button
                        onClick={() => handleOpenDetail(hw.id)}
                        className="flex-1 px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg text-sm font-bold transition-colors"
                      >
                        Դիտել
                      </button>
                      {/* Teacher action simulation button (normally protected by role) */}
                      {hw.status === 'pending' && (
                        <button
                          onClick={() => handleOpenGrade(hw.id)}
                          className="flex-1 px-4 py-2 bg-secondary/20 text-secondary hover:bg-secondary/30 rounded-lg text-sm font-bold transition-colors"
                        >
                          Գնահատել
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Modals Overlay */}
      {(isSubmitModalOpen || isDetailModalOpen || isGradeModalOpen) && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-[#1E293B] border border-white/10 rounded-2xl shadow-2xl p-6 relative">
            <button onClick={closeModals} className="absolute top-6 right-6 p-2 rounded-full hover:bg-white/10">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>

            {detailLoading ? (
              <div className="flex justify-center p-12"><div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" /></div>
            ) : detailData ? (
              <>
                <div className="mb-6 pr-8">
                  <div className="flex items-center gap-3 mb-4">
                    <StatusBadge status={detailData.status} />
                    <LevelBadge level={detailData.level} />
                  </div>
                  <h2 className="text-2xl font-bold mb-2">{detailData.title}</h2>
                  <div className="text-primary text-sm">{detailData.subjectName} <span className="text-muted-foreground mx-1">→</span> {detailData.lessonTitle}</div>
                </div>

                <div className="mb-6 p-4 rounded-xl bg-black/20 border border-white/5">
                  <div className="text-sm font-semibold mb-2 text-muted-foreground">Հանձնարարություն</div>
                  <div className="whitespace-pre-wrap text-sm">{detailData.task}</div>
                </div>

                {/* Submit Modal */}
                {isSubmitModalOpen && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-semibold mb-2">Քո պատասխանը</label>
                      <textarea
                        value={answerText}
                        onChange={(e) => setAnswerText(e.target.value)}
                        className="w-full min-h-[150px] p-4 rounded-xl bg-black/40 border border-white/10 focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-all resize-y text-sm"
                        placeholder="Գրիր քո պատասխանը այստեղ..."
                      />
                    </div>
                    <div className="flex justify-end gap-3 pt-4">
                      <button onClick={closeModals} className="px-5 py-2 rounded-lg font-medium hover:bg-white/10 transition-colors">Չեղարկել</button>
                      <button 
                        onClick={onSubmit} 
                        disabled={!answerText.trim() || submitMutation.isPending}
                        className="px-5 py-2 bg-primary hover:bg-primary/90 disabled:opacity-50 text-white rounded-lg font-bold transition-colors flex items-center gap-2"
                      >
                        {submitMutation.isPending ? "Ներկայացվում է..." : "Ներկայացնել"}
                      </button>
                    </div>
                  </div>
                )}

                {/* Detail Modal */}
                {isDetailModalOpen && (
                  <div className="space-y-6">
                    <div className="p-4 rounded-xl bg-black/20 border border-white/5">
                      <div className="text-sm font-semibold mb-2 text-muted-foreground">Քո պատասխանը</div>
                      <div className="whitespace-pre-wrap text-sm">{detailData.answer || <span className="italic opacity-50">Պատասխան չկա</span>}</div>
                    </div>

                    {detailData.status === 'pending' && (
                      <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-500/90 text-sm flex items-center gap-3">
                        <span className="text-xl">🟡</span>
                        Սպասում է ուսուցչի գնահատմանը
                      </div>
                    )}

                    {detailData.status === 'graded' && (
                      <div className="p-6 rounded-xl bg-secondary/10 border border-secondary/20">
                        <div className="flex justify-between items-start mb-4">
                          <div className="text-sm font-semibold text-secondary">Գնահատական և մեկնաբանություն</div>
                          <div className="text-3xl font-black text-white bg-secondary px-4 py-1 rounded-lg shadow-lg shadow-secondary/20">{detailData.score}<span className="text-lg opacity-70">/100</span></div>
                        </div>
                        <div className="whitespace-pre-wrap text-sm">{detailData.feedback || <span className="italic opacity-50">Մեկնաբանություն չկա</span>}</div>
                      </div>
                    )}
                  </div>
                )}

                {/* Grade Modal (Teacher) */}
                {isGradeModalOpen && (
                  <div className="space-y-4">
                    <div className="p-4 rounded-xl bg-black/20 border border-white/5 mb-6">
                      <div className="text-sm font-semibold mb-2 text-muted-foreground">Աշակերտի պատասխանը</div>
                      <div className="whitespace-pre-wrap text-sm">{detailData.answer}</div>
                    </div>
                    
                    <div className="flex gap-4">
                      <div className="w-1/3">
                        <label className="block text-sm font-semibold mb-2">Գնահատական (0-100)</label>
                        <input
                          type="number"
                          min="0" max="100"
                          value={gradeScore}
                          onChange={(e) => setGradeScore(e.target.value ? Number(e.target.value) : "")}
                          className="w-full p-3 rounded-xl bg-black/40 border border-white/10 focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-all text-xl font-bold"
                        />
                      </div>
                      <div className="w-2/3 flex items-end pb-1">
                        <button 
                          onClick={onAiSuggest}
                          disabled={aiGradeMutation.isPending}
                          className="w-full px-4 py-3 bg-indigo-500/20 text-indigo-400 hover:bg-indigo-500/30 border border-indigo-500/30 rounded-xl font-bold transition-colors flex items-center justify-center gap-2"
                        >
                          {aiGradeMutation.isPending ? "Մշակվում է..." : "AI Առաջարկ 🤖"}
                        </button>
                      </div>
                    </div>
                    
                    <div>
                      <label className="block text-sm font-semibold mb-2">Մեկնաբանություն</label>
                      <textarea
                        value={gradeFeedback}
                        onChange={(e) => setGradeFeedback(e.target.value)}
                        className="w-full min-h-[100px] p-4 rounded-xl bg-black/40 border border-white/10 focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-all resize-y text-sm"
                        placeholder="Գրիր արձագանք աշակերտի համար..."
                      />
                    </div>
                    
                    <div className="flex justify-end gap-3 pt-4 border-t border-white/10">
                      <button onClick={closeModals} className="px-5 py-2 rounded-lg font-medium hover:bg-white/10 transition-colors">Չեղարկել</button>
                      <button 
                        onClick={onGrade} 
                        disabled={gradeScore === "" || gradeMutation.isPending}
                        className="px-5 py-2 bg-secondary hover:bg-secondary/90 disabled:opacity-50 text-white rounded-lg font-bold transition-colors"
                      >
                        {gradeMutation.isPending ? "Պահպանվում է..." : "Գնահատել"}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'not_submitted') return <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-accent/10 text-accent text-xs font-medium border border-accent/20">🔴 Չի ներկայացվել</span>;
  if (status === 'pending') return <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-500/10 text-amber-500 text-xs font-medium border border-amber-500/20">🟡 Սպասում է</span>;
  if (status === 'graded') return <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-secondary/10 text-secondary text-xs font-medium border border-secondary/20">🟢 Գնահատված</span>;
  return null;
}

function LevelBadge({ level }: { level: string }) {
  if (level === 'weak') return <span className="inline-flex items-center px-2 py-1 rounded-md bg-secondary/10 text-secondary text-xs font-bold uppercase tracking-wider">Թույլ</span>;
  if (level === 'medium') return <span className="inline-flex items-center px-2 py-1 rounded-md bg-amber-500/10 text-amber-500 text-xs font-bold uppercase tracking-wider">Միջին</span>;
  if (level === 'strong') return <span className="inline-flex items-center px-2 py-1 rounded-md bg-primary/20 text-primary text-xs font-bold uppercase tracking-wider">Ուժեղ</span>;
  return null;
}