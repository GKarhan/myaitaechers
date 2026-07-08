import { Link, useLocation } from "wouter";
import { useLogin } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";

export default function Home() {
  const { login: setAuthToken } = useAuth();
  const [, setLocation] = useLocation();
  const loginMutation = useLogin();

  const quickLogin = (username: string, password: string) => {
    loginMutation.mutate(
      { data: { username, password } },
      {
        onSuccess: (data) => {
          setAuthToken(data.token);
          const role = data.user?.role;
          if (role === "admin") setLocation("/admin");
          else if (role === "teacher") setLocation("/teacher");
          else setLocation("/dashboard");
        },
      }
    );
  };

  return (
    <div className="min-h-[100dvh] w-full flex flex-col items-center justify-center px-4 bg-background relative overflow-hidden">

      {/* Decorative background effects */}
      <div className="absolute top-0 left-0 w-full h-[500px] bg-gradient-to-b from-primary/10 to-transparent pointer-events-none" />
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[500px] bg-primary/20 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute top-[-10%] right-[-10%] w-[40%] h-[400px] bg-secondary/20 blur-[100px] rounded-full pointer-events-none" />

      <div className="z-10 text-center max-w-2xl w-full">
        <h2 className="text-secondary font-medium tracking-widest mb-6 uppercase text-sm">
          Karhanyan School | myaiteacher
        </h2>

        <h1 className="text-5xl md:text-7xl font-bold text-white mb-6 leading-tight">
          myaiteacher — Քո անձնական AI ուսուցիչը
        </h1>

        <p className="text-xl text-muted-foreground mb-10 max-w-xl mx-auto">
          AI-ն սովորեցնում է յուրաքանչյուր աշակերտի ըստ իր կարողությունների
        </p>

        {/* Primary auth buttons */}
        <div className="flex items-center justify-center gap-4 mb-8">
          <Link
            href="/login"
            className="px-8 py-3 rounded-full font-medium transition-all bg-card border border-card-border hover:bg-muted text-white"
          >
            Մուտք
          </Link>
          <Link
            href="/register"
            className="px-8 py-3 rounded-full font-medium transition-all bg-gradient-to-r from-primary to-secondary text-white shadow-lg hover:shadow-primary/25 hover:scale-105"
          >
            Գրանցում
          </Link>
        </div>

        {/* Demo access */}
        <div className="flex flex-col items-center gap-3">
          <span className="text-xs text-muted-foreground uppercase tracking-widest">Demo Access</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => quickLogin("admin", "admin123")}
              disabled={loginMutation.isPending}
              className="px-4 py-2 rounded-xl text-xs font-medium bg-amber-500/20 border border-amber-500/30 text-amber-400 hover:bg-amber-500/30 transition-colors disabled:opacity-50"
            >
              👑 Ադմին
            </button>
            <button
              onClick={() => quickLogin("teacher1", "teacher123")}
              disabled={loginMutation.isPending}
              className="px-4 py-2 rounded-xl text-xs font-medium bg-teal-500/20 border border-teal-500/30 text-teal-400 hover:bg-teal-500/30 transition-colors disabled:opacity-50"
            >
              👨‍🏫 Ուսուցիչ
            </button>
            <button
              onClick={() => quickLogin("student1", "student123")}
              disabled={loginMutation.isPending}
              className="px-4 py-2 rounded-xl text-xs font-medium bg-indigo-500/20 border border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/30 transition-colors disabled:opacity-50"
            >
              👨‍🎓 Աշակերտ
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
