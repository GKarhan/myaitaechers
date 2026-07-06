import { useEffect } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useAuth } from "@/lib/auth";
import { 
  useGetSubjectProgress, 
  getGetSubjectProgressQueryKey 
} from "@workspace/api-client-react";
import { ArrowLeft, Play, RotateCcw, CheckCircle2, Circle, Loader2, BookOpen } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export default function SubjectProgress() {
  const { user, token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [, params] = useRoute("/progress/subject/:id");
  const subjectId = params?.id ? parseInt(params.id, 10) : null;

  useEffect(() => {
    if (!authLoading && !token) {
      setLocation("/login");
    }
  }, [token, authLoading, setLocation]);

  const { data: subjectData, isLoading: subjectLoading } = useGetSubjectProgress(subjectId!, {
    query: {
      queryKey: getGetSubjectProgressQueryKey(subjectId!),
      enabled: !!token && !!subjectId,
    }
  });

  if (authLoading || (subjectLoading && !subjectData)) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-[#0F172A]">
        <div className="w-8 h-8 border-4 border-[#6366F1] border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!user || !subjectId) return null;

  if (!subjectData) {
    return (
      <div className="min-h-[100dvh] w-full flex flex-col items-center justify-center bg-[#0F172A] text-white px-6">
        <div className="text-5xl mb-4">🗺️</div>
        <h2 className="text-xl font-bold mb-2">Տվյալները չգտնվեցին</h2>
        <Link href="/progress" className="text-indigo-400 hover:text-indigo-300">Վերադառնալ առաջընթաց</Link>
      </div>
    );
  }

  // Circular progress math
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (subjectData.progressPercent / 100) * circumference;

  let badgeColor = "bg-slate-500/20 text-slate-300 border-slate-500/30";
  let circleColor = "text-slate-500";
  
  if (subjectData.masteryLevel === 'mastered') {
    badgeColor = "bg-teal-500/20 text-teal-300 border-teal-500/30";
    circleColor = "text-teal-500";
  } else if (subjectData.masteryLevel === 'review') {
    badgeColor = "bg-amber-500/20 text-amber-300 border-amber-500/30";
    circleColor = "text-amber-500";
  } else if (subjectData.masteryLevel === 'not_started') {
    badgeColor = "bg-red-500/20 text-red-300 border-red-500/30";
    circleColor = "text-red-500";
  }

  return (
    <div className="min-h-[100dvh] w-full bg-[#0F172A] text-white pb-20">
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-lg sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <Link href="/progress" className="inline-flex items-center text-slate-400 hover:text-white mb-6 transition-colors">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Վերադառնալ
          </Link>

          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <h1 className="text-3xl font-bold text-white">{subjectData.name}</h1>
                <span className={`px-2.5 py-1 text-xs font-semibold rounded-full border ${badgeColor}`}>
                  {subjectData.grade}-րդ դասարան
                </span>
              </div>
              <p className="text-slate-400 max-w-lg">{subjectData.description}</p>
            </div>

            <div className="flex items-center gap-6 bg-slate-800/40 p-4 rounded-2xl border border-slate-700/50">
              <div className="relative w-24 h-24 flex items-center justify-center">
                <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
                  <circle
                    className="text-slate-800 stroke-current"
                    strokeWidth="8"
                    cx="50"
                    cy="50"
                    r={radius}
                    fill="transparent"
                  />
                  <circle
                    className={`${circleColor} stroke-current transition-all duration-1000 ease-out`}
                    strokeWidth="8"
                    strokeLinecap="round"
                    cx="50"
                    cy="50"
                    r={radius}
                    fill="transparent"
                    style={{ strokeDasharray: circumference, strokeDashoffset }}
                  />
                </svg>
                <div className="absolute flex flex-col items-center justify-center text-center">
                  <span className="text-2xl font-bold">{subjectData.progressPercent}%</span>
                </div>
              </div>
              
              <div className="space-y-2">
                <div className="flex flex-col">
                  <span className="text-xs text-slate-400 uppercase tracking-wider">Դասեր</span>
                  <span className="text-lg font-semibold">{subjectData.completedLessons} <span className="text-slate-500 text-sm">/ {subjectData.totalLessons}</span></span>
                </div>
                <div className="flex flex-col">
                  <span className="text-xs text-slate-400 uppercase tracking-wider">Միջին</span>
                  <span className="text-lg font-semibold">{subjectData.averageScore}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 pt-10 space-y-12">
        {/* Topics Section */}
        {subjectData.topics && subjectData.topics.length > 0 && (
          <section>
            <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-indigo-400" />
              Թեմաների քարտեզ
            </h2>
            <div className="flex flex-wrap gap-2">
              {subjectData.topics.map(topic => {
                let tBadge = "bg-slate-800 text-slate-400 border-slate-700";
                if (topic.masteryLevel === 'mastered') tBadge = "bg-teal-500/10 text-teal-400 border-teal-500/30";
                if (topic.masteryLevel === 'review') tBadge = "bg-amber-500/10 text-amber-400 border-amber-500/30";
                if (topic.masteryLevel === 'not_started') tBadge = "bg-slate-800 text-slate-400 border-slate-700";

                return (
                  <div key={topic.id} className={`px-3 py-1.5 rounded-lg border text-sm font-medium ${tBadge}`}>
                    {topic.topicName} {topic.score > 0 && <span className="opacity-70 ml-1">({topic.score})</span>}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Lessons List */}
        <section>
          <h2 className="text-xl font-bold mb-6">Դասերի ցանկ</h2>
          <div className="space-y-4">
            {subjectData.lessons?.map(lesson => {
              let Icon = Circle;
              let iconColor = "text-slate-600";
              let btnText = "Սկսել";
              let btnClass = "bg-indigo-600 hover:bg-indigo-700 text-white";
              
              if (lesson.status === 'completed') {
                Icon = CheckCircle2;
                iconColor = "text-teal-500";
                btnText = "Կրկնել";
                btnClass = "bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700";
              } else if (lesson.status === 'active') {
                Icon = Loader2;
                iconColor = "text-indigo-400 animate-spin";
                btnText = "Շարունակել";
                btnClass = "bg-indigo-500 hover:bg-indigo-600 text-white";
              }

              return (
                <div key={lesson.id} className="p-5 rounded-2xl bg-slate-800/40 border border-slate-700/60 hover:bg-slate-800/60 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-start gap-4">
                    <div className="mt-1">
                      <Icon className={`w-6 h-6 ${iconColor}`} />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-white mb-1">{lesson.title}</h3>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-slate-400">
                        {lesson.bloomLevel && <span>Մակարդակ: {lesson.bloomLevel}</span>}
                        {lesson.currentPhase > 0 && <span>Փուլ: {lesson.currentPhase}/8</span>}
                        {lesson.score !== null && <span className="text-amber-400">Արդյունք: {lesson.score}/100</span>}
                        {lesson.hasHomework && (
                          <span className="flex items-center gap-1">
                            Տնային: 
                            {lesson.homeworkStatus === 'graded' || lesson.homeworkStatus === 'completed' ? '✅ Ավարտված' : 
                             lesson.homeworkStatus === 'pending' ? '🟡 Սպասում է' : '🔴 Չսկսված'}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  
                  <Link 
                    href={`/lesson/${lesson.id}`}
                    className={`shrink-0 inline-flex items-center justify-center px-6 py-2.5 rounded-xl font-medium transition-colors ${btnClass}`}
                  >
                    {lesson.status === 'completed' ? <RotateCcw className="w-4 h-4 mr-2" /> : <Play className="w-4 h-4 mr-2" fill="currentColor" />}
                    {btnText}
                  </Link>
                </div>
              );
            })}
            
            {(!subjectData.lessons || subjectData.lessons.length === 0) && (
              <div className="text-center p-8 border border-slate-700 border-dashed rounded-2xl text-slate-400">
                Այս առարկայի համար դասեր չեն գտնվել
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}