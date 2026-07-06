import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { useGetDashboard, getGetDashboardQueryKey } from "@workspace/api-client-react";

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
          <button 
            onClick={logout}
            className="text-sm text-muted-foreground hover:text-white transition-colors"
          >
            Ելք
          </button>
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
      </main>
    </div>
  );
}