import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { 
  useGetProgress, 
  getGetProgressQueryKey, 
  useGetProgressRecommendations, 
  getGetProgressRecommendationsQueryKey 
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Brain, TrendingUp, Target, BookOpen, Star, RefreshCw, AlertCircle, CheckCircle2 } from "lucide-react";

export default function Progress() {
  const { user, token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [filter, setFilter] = useState<"all" | "mastered" | "review" | "not_started">("all");

  useEffect(() => {
    if (!authLoading && !token) {
      setLocation("/login");
    }
  }, [token, authLoading, setLocation]);

  const { data: progress, isLoading: progressLoading } = useGetProgress({
    query: {
      queryKey: getGetProgressQueryKey(),
      enabled: !!token,
    }
  });

  const { data: recommendations, isLoading: recsLoading } = useGetProgressRecommendations({
    query: {
      queryKey: getGetProgressRecommendationsQueryKey(),
      enabled: !!token,
    }
  });

  if (authLoading || (progressLoading && !progress)) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-[#0F172A]">
        <div className="w-8 h-8 border-4 border-[#6366F1] border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!user) return null;

  const filteredSubjects = progress?.subjects?.filter(s => {
    if (filter === "all") return true;
    return s.masteryLevel === filter;
  }) || [];

  return (
    <div className="min-h-[100dvh] w-full bg-[#0F172A] text-white pb-20">
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-lg sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4">
          <Link href="/dashboard" className="inline-flex items-center text-slate-400 hover:text-white mb-4 transition-colors">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Վերադառնալ Dashboard
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/20 rounded-xl">
              <Brain className="w-6 h-6 text-indigo-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white">Առաջընթաց և Գիտելիքի Քարտեզ</h1>
              <p className="text-sm text-slate-400">Ամփոփ տեղեկատվություն ձեր ուսուցման վիճակի մասին</p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 pt-8 space-y-12">
        {/* Stats Row */}
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-6 rounded-2xl bg-slate-800/50 border border-slate-700">
            <div className="flex items-center gap-3 mb-2 text-slate-400">
              <TrendingUp className="w-5 h-5 text-indigo-400" />
              <span className="text-sm font-medium">Ընդհանուր առաջընթաց</span>
            </div>
            <div className="text-3xl font-bold text-white">{progress?.overallPercent || 0}%</div>
          </div>
          <div className="p-6 rounded-2xl bg-slate-800/50 border border-slate-700">
            <div className="flex items-center gap-3 mb-2 text-slate-400">
              <Star className="w-5 h-5 text-amber-400" />
              <span className="text-sm font-medium">Միջին գնահատական</span>
            </div>
            <div className="text-3xl font-bold text-white">{progress?.averageScore || 0}</div>
          </div>
          <div className="p-6 rounded-2xl bg-slate-800/50 border border-slate-700">
            <div className="flex items-center gap-3 mb-2 text-slate-400">
              <Target className="w-5 h-5 text-teal-400" />
              <span className="text-sm font-medium">Յուրացված</span>
            </div>
            <div className="text-3xl font-bold text-white">{progress?.masteryPercent || 0}%</div>
          </div>
          <div className="p-6 rounded-2xl bg-slate-800/50 border border-slate-700">
            <div className="flex items-center gap-3 mb-2 text-slate-400">
              <BookOpen className="w-5 h-5 text-blue-400" />
              <span className="text-sm font-medium">Ավարտված դասեր</span>
            </div>
            <div className="text-3xl font-bold text-white">
              {progress?.completedLessons || 0}
              <span className="text-xl text-slate-500 font-normal">/{progress?.totalLessons || 0}</span>
            </div>
          </div>
        </section>

        {/* AI Recommendations */}
        <section>
          <div className="flex items-center gap-2 mb-6">
            <span className="text-xl">🤖</span>
            <h2 className="text-xl font-bold text-white">AI Առաջարկություններ</h2>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {recsLoading ? (
              <>
                <Skeleton className="h-32 rounded-2xl bg-slate-800/50" />
                <Skeleton className="h-32 rounded-2xl bg-slate-800/50" />
                <Skeleton className="h-32 rounded-2xl bg-slate-800/50" />
              </>
            ) : recommendations?.recommendations?.length ? (
              recommendations.recommendations.map((rec, i) => {
                let border = "border-slate-700";
                let icon = <Brain className="w-5 h-5 text-slate-400" />;
                
                if (rec.type === 'start') { border = "border-teal-500/50"; icon = <span className="text-teal-400">🚀</span>; }
                if (rec.type === 'review') { border = "border-amber-500/50"; icon = <RefreshCw className="w-5 h-5 text-amber-400" />; }
                if (rec.type === 'ready') { border = "border-green-500/50"; icon = <CheckCircle2 className="w-5 h-5 text-green-400" />; }
                if (rec.type === 'improve') { border = "border-indigo-500/50"; icon = <TrendingUp className="w-5 h-5 text-indigo-400" />; }

                return (
                  <div key={i} className={`p-5 rounded-2xl bg-slate-800/30 border ${border} flex items-start gap-4 transition-colors hover:bg-slate-800/50`}>
                    <div className="mt-1">{icon}</div>
                    <div>
                      <div className="text-sm font-semibold text-white mb-1">{rec.subjectName}</div>
                      <div className="text-sm text-slate-300 leading-relaxed">{rec.message}</div>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="col-span-full p-6 text-center text-slate-400 bg-slate-800/30 rounded-2xl border border-slate-700">
                Ներկայումս առաջարկություններ չկան։
              </div>
            )}
          </div>
        </section>

        {/* Knowledge Map */}
        <section>
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
            <h2 className="text-xl font-bold text-white">Գիտելիքի Քարտեզ</h2>
            
            <div className="flex flex-wrap gap-2">
              <button 
                onClick={() => setFilter("all")}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${filter === 'all' ? 'bg-slate-700 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700/50'}`}
              >
                Բոլորը
              </button>
              <button 
                onClick={() => setFilter("mastered")}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${filter === 'mastered' ? 'bg-teal-500/20 text-teal-300 border border-teal-500/30' : 'bg-slate-800 text-slate-400 hover:bg-slate-700/50'}`}
              >
                🟢 Յուրացված
              </button>
              <button 
                onClick={() => setFilter("review")}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${filter === 'review' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'bg-slate-800 text-slate-400 hover:bg-slate-700/50'}`}
              >
                🟡 Ուսումնասիրել
              </button>
              <button 
                onClick={() => setFilter("not_started")}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${filter === 'not_started' ? 'bg-red-500/20 text-red-300 border border-red-500/30' : 'bg-slate-800 text-slate-400 hover:bg-slate-700/50'}`}
              >
                🔴 Չսկսված
              </button>
            </div>
          </div>

          {!filteredSubjects.length ? (
            <div className="p-12 text-center border border-slate-700 border-dashed rounded-3xl bg-slate-800/20 flex flex-col items-center">
              <div className="text-4xl mb-4">🗺️</div>
              <h3 className="text-lg font-medium text-white mb-2">Դեռ ոչ մի դաս չի ավարտվել</h3>
              <p className="text-slate-400">Սկսեք ուսումնասիրել ձեր առարկաները՝ առաջընթաց գրանցելու համար:</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {filteredSubjects.map(subject => {
                let badgeColor = "bg-slate-500/20 text-slate-300 border-slate-500/30";
                let progressColor = "bg-slate-500";
                let icon = "🔴";

                if (subject.masteryLevel === 'mastered') {
                  badgeColor = "bg-teal-500/20 text-teal-300 border-teal-500/30";
                  progressColor = "bg-teal-500";
                  icon = "🟢";
                } else if (subject.masteryLevel === 'review') {
                  badgeColor = "bg-amber-500/20 text-amber-300 border-amber-500/30";
                  progressColor = "bg-amber-400";
                  icon = "🟡";
                } else if (subject.masteryLevel === 'not_started') {
                  badgeColor = "bg-red-500/20 text-red-300 border-red-500/30";
                  progressColor = "bg-red-500";
                  icon = "🔴";
                }

                return (
                  <div key={subject.id} className="p-6 rounded-2xl bg-slate-800/50 border border-slate-700 hover:border-indigo-500/50 transition-colors flex flex-col h-full">
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span>{icon}</span>
                          <h3 className="text-lg font-bold text-white">{subject.name}</h3>
                        </div>
                        <div className="text-sm text-slate-400">{subject.grade}-րդ դասարան</div>
                      </div>
                      <div className={`px-2.5 py-1 text-xs font-semibold rounded-full border ${badgeColor}`}>
                        {subject.progressPercent}%
                      </div>
                    </div>

                    <div className="mb-4 flex-grow">
                      <div className="h-2 w-full bg-slate-900 rounded-full overflow-hidden mb-3">
                        <div 
                          className={`h-full ${progressColor} rounded-full transition-all duration-1000 ease-out`}
                          style={{ width: `${subject.progressPercent}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-400">{subject.completedLessons}/{subject.totalLessons} դաս ավարտված</span>
                        <span className="text-slate-300 font-medium">Միջ. գնահատական: {subject.averageScore}</span>
                      </div>
                    </div>

                    <div className="mt-auto pt-4 border-t border-slate-700/50">
                      <Link href={`/progress/subject/${subject.id}`} className="text-indigo-400 hover:text-indigo-300 text-sm font-medium flex items-center justify-end">
                        Մանրամասն <ArrowLeft className="w-4 h-4 ml-1 rotate-180" />
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}