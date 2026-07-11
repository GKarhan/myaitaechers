import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useLogin } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [, setLocation] = useLocation();
  const { login: setAuthToken } = useAuth();

  const loginMutation = useLogin();

  const doLogin = (user: string, pass: string) => {
    setError("");
    loginMutation.mutate(
      { data: { username: user, password: pass } },
      {
        onSuccess: (data) => {
          setAuthToken(data.token);
          const role = data.user?.role;
          if (role === "admin") setLocation("/admin");
          else if (role === "teacher") setLocation("/teacher");
          else setLocation("/dashboard");
        },
        onError: () => {
          setError("Սխալ օգտանուն կամ գաղտնաբառ");
        }
      }
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) {
      setError("Խնդրում ենք լրացնել բոլոր դաշտերը");
      return;
    }
    doLogin(username, password);
  };

  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background px-4 relative overflow-hidden">
      <div className="absolute top-[10%] left-[-10%] w-[50%] h-[500px] bg-primary/10 blur-[120px] rounded-full pointer-events-none" />

      <div className="w-full max-w-md z-10">
        {/* Quick login */}
        <div className="mb-4 p-4 rounded-2xl bg-card/40 border border-white/10 backdrop-blur-sm">
          <p className="text-xs text-muted-foreground mb-3 text-center">⚡ Արագ մուտք</p>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => doLogin("admin", "admin123")}
              disabled={loginMutation.isPending}
              className="py-2 px-3 rounded-xl text-xs font-medium bg-amber-500/20 border border-amber-500/30 text-amber-400 hover:bg-amber-500/30 transition-colors disabled:opacity-50"
            >
              ADADMIN
            </button>
            <button
              type="button"
              onClick={() => doLogin("teacher1", "teacher123")}
              disabled={loginMutation.isPending}
              className="py-2 px-3 rounded-xl text-xs font-medium bg-teal-500/20 border border-teal-500/30 text-teal-400 hover:bg-teal-500/30 transition-colors disabled:opacity-50"
            >
              UDUDCHIЧ
            </button>
            <button
              type="button"
              onClick={() => doLogin("student1", "student123")}
              disabled={loginMutation.isPending}
              className="py-2 px-3 rounded-xl text-xs font-medium bg-indigo-500/20 border border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/30 transition-colors disabled:opacity-50"
            >
              ASHAKERT
            </button>
          </div>
        </div>

        <div className="p-8 rounded-2xl bg-card/60 backdrop-blur-xl border border-card-border shadow-2xl">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">Մուտք</h1>
            <p className="text-muted-foreground">Բարի գալուստ Karhanyan School</p>
          </div>

          {error && (
            <div className="mb-6 p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Օգտանուն</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-background/50 border border-input rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all"
                placeholder="Մուտքագրեք Ձեր օգտանունը"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Գաղտնաբառ</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-background/50 border border-input rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all"
                placeholder="Մուտքագրեք Ձեր գաղտնաբառը"
              />
            </div>

            <button
              type="submit"
              disabled={loginMutation.isPending}
              className="w-full py-3 rounded-xl font-medium transition-all bg-gradient-to-r from-primary to-secondary text-white shadow-lg hover:shadow-primary/25 disabled:opacity-50"
            >
              {loginMutation.isPending ? "Մուտքագրվում է..." : "Մուտք"}
            </button>
          </form>

          <div className="mt-6 text-center text-sm text-muted-foreground">
            Դեռ գրանցված չե՞ք: <Link href="/register" className="text-secondary hover:text-white transition-colors">Գրանցում</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
