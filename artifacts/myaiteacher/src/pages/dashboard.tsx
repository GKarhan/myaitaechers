import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { useGetDashboard, getGetDashboardQueryKey, useGetBooks, getGetBooksQueryKey, useGetHomework, getGetHomeworkQueryKey, useGetProgress, getGetProgressQueryKey } from "@workspace/api-client-react";

export default function Dashboard() {
  const { user, token, logout, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!authLoading && !token) {
      setLocation("/login");
    }
  }, [token, authLoading, setLocation]);

  const { data: dashboard, isLoading: dashboardLoading } = useGetDashboard({
    query: {
      queryKey: getGetDashboardQueryKey(),
      enabled: !!token,
    }
  });

  const { data: progressData } = useGetProgress({
    query: {
      queryKey: getGetProgressQueryKey(),
      enabled: !!token,
    }
  });

  const { data: booksData } = useGetBooks({
    query: {
      queryKey: getGetBooksQueryKey(),
      enabled: !!token,
    }
  });

  const { data: homeworkData } = useGetHomework({
    query: {
      queryKey: getGetHomeworkQueryKey(),
      enabled: !!token,
    }
  });

  const pendingHomework = homeworkData?.filter(h => h.status === 'pending').length || 0;
  const gradedHomework = homeworkData?.filter(h => h.status === 'graded').length || 0;
  const notSubmittedHomework = homeworkData?.filter(h => h.status === 'not_submitted').length || 0;

  if (authLoading || dashboardLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!user || !dashboard) return null;

  return (
    <div className="min-h-[100dvh] w-full bg-background text-white pb-20">
      <header className="border-b border-card-border bg-card/50 backdrop-blur-lg sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="font-bold text-xl bg-clip-text text-transparent bg-gradient-to-r from-primary to-secondary">
            myaiteacher
          </div>
          <div className="flex items-center gap-6">
            <Link href="/chat/0" className="px-4 py-2 bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 rounded-lg text-sm font-medium transition-colors">
              AI Ուսուցիչ
            </Link>
            <button 
              onClick={logout}
              className="text-sm text-muted-foreground hover:text-white transition-colors"
            >
              Ելք
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 pt-10">
        <div className="mb-10">
          <h1 className="text-3xl font-bold mb-2">Բարի գալուստ, {user.fullName}</h1>
          <p className="text-muted-foreground">Ահա քո ուսումնական առաջընթացը այս պահին</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-12">
          <div className="p-6 rounded-2xl bg-card border border-card-border shadow-lg shadow-black/50">
            <div className="text-muted-foreground text-sm mb-2">Ավարտված դասեր</div>
            <div className="text-3xl font-bold text-white">{dashboard.stats.completedLessons}</div>
          </div>
          <div className="p-6 rounded-2xl bg-card border border-card-border shadow-lg shadow-black/50">
            <div className="text-muted-foreground text-sm mb-2">Միջին գնահատական</div>
            <div className="text-3xl font-bold text-secondary">{dashboard.stats.averageScore}</div>
          </div>
          <div className="p-6 rounded-2xl bg-card border border-card-border shadow-lg shadow-black/50">
            <div className="text-muted-foreground text-sm mb-2">Անավարտ տնայիններ</div>
            <div className="text-3xl font-bold text-accent">{dashboard.stats.pendingHomework}</div>
          </div>
          <div className="p-6 rounded-2xl bg-gradient-to-br from-primary/20 to-secondary/20 border border-primary/30 shadow-lg shadow-primary/10">
            <div className="text-muted-foreground text-sm mb-2">Ընդհանուր առաջընթաց</div>
            <div className="flex items-end gap-2 mb-3">
              <div className="text-3xl font-bold text-white">{dashboard.stats.overallProgress}%</div>
            </div>
            <div className="h-2 w-full bg-background rounded-full overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-primary to-secondary rounded-full"
                style={{ width: `${dashboard.stats.overallProgress}%` }}
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Subjects Progress */}
          <div className="lg:col-span-2">
            <h2 className="text-xl font-bold mb-6">Առարկաներ</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {dashboard.subjects.map(subject => (
                <Link key={subject.id} href={`/subjects/${subject.id}`} className="block">
                  <div className="p-5 rounded-2xl bg-card border border-card-border hover:border-primary/50 transition-colors cursor-pointer h-full">
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="font-semibold text-lg">{subject.subject}</h3>
                      <span className="text-sm font-medium text-secondary">{subject.averageScore} միավոր</span>
                    </div>
                    <div className="mb-2 flex justify-between text-xs text-muted-foreground">
                      <span>{subject.completedLessons} / {subject.totalLessons} դաս</span>
                      <span>{subject.progressPercent}%</span>
                    </div>
                    <div className="h-1.5 w-full bg-background rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-primary rounded-full"
                        style={{ width: `${subject.progressPercent}%` }}
                      />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>

          {/* Sidebar Area */}
          <div className="space-y-8">
            {/* Progress Summary Card */}
            <div>
              <h2 className="text-xl font-bold mb-6">Առաջընթաց</h2>
              <div className="p-6 rounded-2xl bg-card border border-card-border shadow-lg shadow-black/50">
                <div className="text-4xl mb-4">📈</div>
                <div className="text-lg font-semibold mb-3">Գիտելիքի Քարտեզ</div>
                <div className="space-y-4 mb-4">
                  {progressData?.subjects?.slice(0, 3).map(sub => (
                    <div key={sub.id} className="space-y-1">
                      <div className="flex justify-between text-xs font-medium">
                        <span className="text-slate-300 truncate pr-2">{sub.name}</span>
                        <span className="text-secondary">{sub.progressPercent}%</span>
                      </div>
                      <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                        <div 
                          className={`h-full rounded-full ${
                            sub.masteryLevel === 'mastered' ? 'bg-teal-500' :
                            sub.masteryLevel === 'review' ? 'bg-amber-400' : 'bg-red-500'
                          }`}
                          style={{ width: `${sub.progressPercent}%` }}
                        />
                      </div>
                    </div>
                  ))}
                  {(!progressData?.subjects || progressData.subjects.length === 0) && (
                    <div className="text-sm text-muted-foreground">Տվյալներ չկան</div>
                  )}
                </div>
                <Link href="/progress" className="text-primary text-sm font-medium flex items-center hover:underline">
                  Ամբողջական քարտեզ →
                </Link>
              </div>
            </div>

            {/* Homework card */}
            <div>
              <h2 className="text-xl font-bold mb-6">Տնային աշխատանք</h2>
              <div className="p-6 rounded-2xl bg-card border border-card-border shadow-lg shadow-black/50">
                <div className="text-4xl mb-4">📝</div>
                <div className="text-lg font-semibold mb-3">Իմ առաջադրանքները</div>
                <div className="flex flex-col gap-2 text-sm font-medium mb-4">
                  <div className="flex items-center justify-between text-accent">
                    <span>Չներկայացված</span>
                    <span>{notSubmittedHomework}</span>
                  </div>
                  <div className="flex items-center justify-between text-amber-500">
                    <span>Սպասում է</span>
                    <span>{pendingHomework}</span>
                  </div>
                  <div className="flex items-center justify-between text-secondary">
                    <span>Գնահատված</span>
                    <span>{gradedHomework}</span>
                  </div>
                </div>
                <Link href="/homework" className="text-primary text-sm font-medium flex items-center hover:underline">
                  Բոլոր տնայինները →
                </Link>
              </div>
            </div>

            {/* Books card */}
            <div>
              <h2 className="text-xl font-bold mb-6">Իմ գրքերը</h2>
              <div className="p-6 rounded-2xl bg-card border border-card-border flex flex-col justify-between h-[calc(100%-3rem)] min-h-[160px]">
                <div>
                  <div className="text-4xl mb-4">📚</div>
                  <div className="text-lg font-semibold mb-1">Գրքեր և նյութեր</div>
                  <div className="text-muted-foreground text-sm">
                    {booksData?.length ? `${booksData.length} գիրք` : "Գրքեր չկան"}
                  </div>
                </div>
                <Link href="/books" className="mt-4 text-primary text-sm font-medium flex items-center hover:underline">
                  Կառավարել →
                </Link>
              </div>
            </div>

            {/* Recent Activity */}
            <div>
              <h2 className="text-xl font-bold mb-6">Վերջին ակտիվություն</h2>
              <div className="space-y-4">
                {dashboard.recentActivity.map(activity => (
                  <div key={activity.id} className="p-4 rounded-xl bg-card/50 border border-card-border flex items-start gap-4">
                    <div className={`w-2 h-2 mt-2 rounded-full ${activity.status === 'completed' ? 'bg-secondary' : 'bg-accent'}`} />
                    <div>
                      <div className="text-xs text-primary mb-1">{activity.subject}</div>
                      <div className="font-medium text-sm text-white mb-1">{activity.lesson}</div>
                      <div className="text-xs text-muted-foreground flex justify-between items-center">
                        <span>{activity.status === 'completed' ? 'Ավարտված' : 'Ընթացքի մեջ'}</span>
                        {activity.score > 0 && <span className="text-secondary font-medium">{activity.score} միավոր</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}