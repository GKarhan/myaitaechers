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
    <div className="min-h-[100dvh] w-full flex flex-col items-center pt-24 px-4 bg-background relative overflow-hidden">
      {/* Quick login buttons top-right */}
      <div className="absolute top-4 right-4 flex items-center gap-2 z-20">
        <span className="text-xs text-muted-foreground mr-1">Արագ մուտք:</span>
        <button onClick={() => quickLogin("admin", "admin123")} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-500/20 border border-amber-500/30 text-amber-400 hover:bg-amber-500/30 transition-colors">
          👑 Ադմին
        </button>
        <button onClick={() => quickLogin("teacher1", "teacher123")} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-teal-500/20 border border-teal-500/30 text-teal-400 hover:bg-teal-500/30 transition-colors">
          👨‍🏫 Ուսուցիչ
        </button>
        <button onClick={() => quickLogin("student1", "student123")} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-500/20 border border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/30 transition-colors">
          👨‍🎓 Աշակերտ
        </button>
      </div>

      {/* Decorative background effects */}
      <div className="absolute top-0 left-0 w-full h-[500px] bg-gradient-to-b from-primary/10 to-transparent pointer-events-none" />
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[500px] bg-primary/20 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute top-[-10%] right-[-10%] w-[40%] h-[400px] bg-secondary/20 blur-[100px] rounded-full pointer-events-none" />

      <div className="z-10 text-center max-w-3xl">
        <h2 className="text-secondary font-medium tracking-wide mb-6 uppercase tracking-widest text-sm">
          Karhanyan School | myaiteacher
        </h2>
        
        <h1 className="text-5xl md:text-7xl font-bold text-white mb-6 leading-tight">
          myaiteacher — Քո անձնական AI ուսուցիչը
        </h1>
        
        <p className="text-xl text-muted-foreground mb-12 max-w-2xl mx-auto">
          AI-ն սովորեցնում է յուրաքանչյուր աշակերտի ըստ իր կարողությունների
        </p>

        <div className="flex items-center justify-center gap-4 mb-20">
          <Link href="/login" className="px-8 py-3 rounded-full font-medium transition-all bg-card border border-card-border hover:bg-muted text-white">
            Մուտք
          </Link>
          <Link href="/register" className="px-8 py-3 rounded-full font-medium transition-all bg-gradient-to-r from-primary to-secondary text-white shadow-lg hover:shadow-primary/25 hover:scale-105">
            Գրանցում
          </Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 text-left">
          <div className="p-6 rounded-2xl bg-card/40 backdrop-blur-md border border-card-border">
            <div className="text-primary text-2xl font-bold mb-2">1</div>
            <h3 className="font-semibold text-white mb-2">Դասեր</h3>
            <p className="text-sm text-muted-foreground">Անհատականացված նյութեր քո մակարդակին համապատասխան</p>
          </div>
          <div className="p-6 rounded-2xl bg-card/40 backdrop-blur-md border border-card-border">
            <div className="text-secondary text-2xl font-bold mb-2">2</div>
            <h3 className="font-semibold text-white mb-2">AI Tutor</h3>
            <p className="text-sm text-muted-foreground">Շուրջօրյա օգնական հարցերիդ պատասխանելու համար</p>
          </div>
          <div className="p-6 rounded-2xl bg-card/40 backdrop-blur-md border border-card-border">
            <div className="text-accent text-2xl font-bold mb-2">3</div>
            <h3 className="font-semibold text-white mb-2">Գիտելիքի ծառ</h3>
            <p className="text-sm text-muted-foreground">Տեսանելի կառուցվածք քո իմացածի և սովորելու ենթակա նյութի</p>
          </div>
          <div className="p-6 rounded-2xl bg-card/40 backdrop-blur-md border border-card-border">
            <div className="text-primary text-2xl font-bold mb-2">4</div>
            <h3 className="font-semibold text-white mb-2">Առաջընթաց</h3>
            <p className="text-sm text-muted-foreground">Հետևիր քո արդյունքներին և դարձիր ավելի լավը</p>
          </div>
        </div>
      </div>
    </div>
  );
}