import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useRegister } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";

export default function Register() {
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [, setLocation] = useLocation();
  const { login: setAuthToken } = useAuth();

  const registerMutation = useRegister();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    
    if (!fullName || !username || !password) {
      setError("Խնդրում ենք լրացնել բոլոր դաշտերը");
      return;
    }

    if (username.length < 3) {
      setError("Օգտանունը պետք է լինի առնվազն 3 նիշ");
      return;
    }

    if (password.length < 6) {
      setError("Գաղտնաբառը պետք է լինի առնվազն 6 նիշ");
      return;
    }

    registerMutation.mutate(
      { data: { fullName, username, password } },
      {
        onSuccess: (data) => {
          setAuthToken(data.token);
          setLocation("/dashboard");
        },
        onError: () => {
          setError("Գրանցման սխալ: Հնարավոր է օգտանունը արդեն զբաղված է:");
        }
      }
    );
  };

  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background px-4 relative overflow-hidden">
      <div className="absolute top-[10%] right-[-10%] w-[50%] h-[500px] bg-secondary/10 blur-[120px] rounded-full pointer-events-none" />
      
      <div className="w-full max-w-md p-8 rounded-2xl bg-card/60 backdrop-blur-xl border border-card-border z-10 shadow-2xl">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">Գրանցում</h1>
          <p className="text-muted-foreground">Միացիր Karhanyan School-ին</p>
        </div>

        {error && (
          <div className="mb-6 p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Անուն Ազգանուն</label>
            <input 
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full bg-background/50 border border-input rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all"
              placeholder="Օրինակ՝ Արամ Խաչատրյան"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Օգտանուն</label>
            <input 
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-background/50 border border-input rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all"
              placeholder="Ընտրեք օգտանուն"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Գաղտնաբառ</label>
            <input 
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-background/50 border border-input rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all"
              placeholder="Նվազագույնը 6 նիշ"
            />
          </div>

          <button 
            type="submit"
            disabled={registerMutation.isPending}
            className="w-full py-3 rounded-xl font-medium transition-all bg-gradient-to-r from-primary to-secondary text-white shadow-lg hover:shadow-primary/25 disabled:opacity-50"
          >
            {registerMutation.isPending ? "Գրանցվում է..." : "Գրանցվել"}
          </button>
        </form>

        <div className="mt-6 text-center text-sm text-muted-foreground">
          Արդեն ունե՞ք հաշիվ: <Link href="/login" className="text-primary hover:text-white transition-colors">Մուտք</Link>
        </div>
      </div>
    </div>
  );
}