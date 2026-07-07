import { useLogin } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";

export default function QuickSwitch() {
  const { login: setAuthToken } = useAuth();
  const [, setLocation] = useLocation();
  const loginMutation = useLogin();

  const doSwitch = (user: string, pass: string, path: string) => {
    loginMutation.mutate(
      { data: { username: user, password: pass } },
      { onSuccess: (data) => { setAuthToken(data.token); setLocation(path); } }
    );
  };

  return (
    <div className="fixed top-3 right-3 z-[9999] flex gap-1.5 p-2 rounded-2xl bg-black/40 border border-white/10 backdrop-blur-md shadow-xl">
      <span className="self-center text-[10px] text-white/40 mr-1">⚡</span>
      <button type="button" disabled={loginMutation.isPending}
        onClick={() => doSwitch("admin", "admin123", "/admin")}
        className="py-1.5 px-3 rounded-xl text-[11px] font-medium border transition-colors disabled:opacity-50 bg-amber-500/20 border-amber-500/30 text-amber-400 hover:bg-amber-500/30">
        👑 Ադմին
      </button>
      <button type="button" disabled={loginMutation.isPending}
        onClick={() => doSwitch("lkarhanyan", "teacher123", "/teacher")}
        className="py-1.5 px-3 rounded-xl text-[11px] font-medium border transition-colors disabled:opacity-50 bg-teal-500/20 border-teal-500/30 text-teal-400 hover:bg-teal-500/30">
        👨‍🏫 Ուսուցիչ
      </button>
      <button type="button" disabled={loginMutation.isPending}
        onClick={() => doSwitch("ekarhanyan", "student123", "/dashboard")}
        className="py-1.5 px-3 rounded-xl text-[11px] font-medium border transition-colors disabled:opacity-50 bg-indigo-500/20 border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/30">
        👨‍🎓 Էلеն
      </button>
    </div>
  );
}
