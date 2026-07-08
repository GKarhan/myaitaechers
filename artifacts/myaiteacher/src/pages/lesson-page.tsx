import { useEffect, useRef, useState, useCallback } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useAuth } from "@/lib/auth";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetLessonDetail, getGetLessonDetailQueryKey,
  useStartLessonSession,
  useAdvanceLessonPhase,
  useGetChatHistory, getGetChatHistoryQueryKey,
  useSendChatMessage,
} from "@workspace/api-client-react";

const PHASES = [
  { phase: 1, name: "Կrknutyun", label: "Կrknoutyun", icon: "🔄", duration: "5 ր" },
  { phase: 2, name: "Himnakan", label: "Himnakan gaghapanner", icon: "💡", duration: "10 ր" },
  { phase: 3, name: "Erkrordakan", label: "Erkrordakan gaghapanner", icon: "🔍", duration: "8 ր" },
  { phase: 4, name: "Gortsakan", label: "Gortsakan kirarutyun", icon: "⚙️", duration: "10 ր" },
  { phase: 5, name: "Steghts.", label: "Steghtsagorcakan", icon: "✨", duration: "10 ր" },
  { phase: 6, name: "Nakhagits", label: "Mikro nakhagits", icon: "🚀", duration: "12 ր" },
  { phase: 7, name: "Ampofhum", label: "Ampofhum", icon: "📋", duration: "5 ր" },
  { phase: 8, name: "Tnayin", label: "Tnayin ashkhatanq", icon: "📚", duration: "—" },
];

const BLOOM = [
  { level: 1, name: "Հisel", color: "#14B8A6" },
  { level: 2, name: "Haskanal", color: "#6366F1" },
  { level: 3, name: "Kiraril", color: "#8B5CF6" },
  { level: 4, name: "Verlucel", color: "#F59E0B" },
  { level: 5, name: "Gnahatel", color: "#EF4444" },
  { level: 6, name: "Steghcel", color: "#EC4899" },
];

const ARMENIAN_MONTHS = [
  "հunvari", "p'etrvar", "marti", "aprili", "mayisi", "hunisi",
  "hulisi", "oghostosi", "septemberi", "hoktemb.", "noyemb.", "dekemb.",
];

function todayArmenian() {
  const d = new Date();
  return `${d.getDate()} ${ARMENIAN_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Strip LaTeX wrappers and normalise math notation */
function formatMath(text: string): string {
  return text
    .replace(/\\\((.*?)\\\)/gs, "$1")   // \( ... \)  →  content
    .replace(/\\\[(.*?)\\\]/gs, "$1")   // \[ ... \]  →  content
    .replace(/\$\$(.*?)\$\$/gs, "$1")   // $$ ... $$  →  content
    .replace(/\$(.*?)\$/g, "$1")        // $ ... $    →  content
    .trim();
}

interface MCQuestion { options: string[]; answered: boolean }

function parseMultipleChoice(content: string): MCQuestion | null {
  const lines = content.split("\n").map((l) => l.trim());
  const options: string[] = [];
  for (const line of lines) {
    // 1)  2)  3)  ա)  բ)  գ)  1.  2.  3.
    const m = line.match(/^(?:[1-3][).]\s+|[աբգ][).]\s*)(.+)/);
    if (m) options.push(m[1].trim());
  }
  if (options.length >= 2 && options.length <= 4) return { options, answered: false };
  return null;
}

function isCorrectResponse(content: string): boolean | null {
  if (/✓|Ĉisht e|Ճишт|Jechn е|Ĵisht|ճiшт|jechn|Jisht|✅/.test(content)) return true;
  if (/✗|Ոcht|Vocĥ ĉisht|Skhale|Skhal e|❌|Ոĉ ĉisht/.test(content)) return false;
  return null;
}

interface PhaseScore { correct: number; total: number; wrong: string[] }

export default function LessonPage() {
  const { user, token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { id } = useParams<{ id: string }>();
  const lessonId = parseInt(id || "0", 10);
  const queryClient = useQueryClient();

  const [message, setMessage] = useState("");
  const [autoStarted, setAutoStarted] = useState(false);
  const [mcAnsweredIds, setMcAnsweredIds] = useState<Set<number>>(new Set());
  const [phaseScore, setPhaseScore] = useState<PhaseScore>({ correct: 0, total: 0, wrong: [] });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!authLoading && !token) setLocation("/login");
  }, [token, authLoading, setLocation]);

  const lessonKey = getGetLessonDetailQueryKey(lessonId);
  const { data: lesson, isLoading: lessonLoading } = useGetLessonDetail(lessonId, {
    query: { queryKey: lessonKey, enabled: !!token && !!lessonId },
  });

  const chatParams = { lessonId };
  const chatKey = getGetChatHistoryQueryKey(chatParams);
  const { data: rawMessages = [], isLoading: chatLoading } = useGetChatHistory(chatParams, {
    query: { queryKey: chatKey, enabled: !!token && !!lessonId },
  });
  const messages = rawMessages as Array<{ id: number; role: string; content: string; createdAt: string }>;

  const startSession = useStartLessonSession();
  const advancePhase = useAdvanceLessonPhase();
  const sendMessage = useSendChatMessage();

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);
  useEffect(() => { scrollToBottom(); }, [messages, sendMessage.isPending]);

  const session = lesson?.currentSession;
  const currentPhase = (session as { currentPhase?: number } | undefined)?.currentPhase ?? 0;
  const isCompleted = (session as { status?: string } | undefined)?.status === "completed";
  const hasSession = !!session;

  const triggerAI = useCallback((triggerMsg: string) => {
    sendMessage.mutate(
      { data: { message: triggerMsg, lessonId } },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKey }) }
    );
  }, [sendMessage, lessonId, queryClient, chatKey]);

  useEffect(() => {
    if (hasSession && !autoStarted && !chatLoading && messages.length === 0 && !sendMessage.isPending) {
      setAutoStarted(true);
      triggerAI("Sksir — Phase 1 review. Greet in Armenian, then ask ՀАРЦ 1 with 1) 2) 3) options. ONE question only.");
    }
  }, [hasSession, autoStarted, chatLoading, messages.length, sendMessage.isPending, triggerAI]);

  const handleStartLesson = () => {
    startSession.mutate(
      { data: { lessonId } },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: lessonKey }) }
    );
  };

  const handleAdvancePhase = () => {
    advancePhase.mutate(
      { lessonId },
      {
        onSuccess: (data) => {
          queryClient.invalidateQueries({ queryKey: lessonKey });
          const nextPhase = (data as { currentPhase: number }).currentPhase;
          if (nextPhase === 1) {
            setPhaseScore({ correct: 0, total: 0, wrong: [] });
            setMcAnsweredIds(new Set());
          }
          if (nextPhase === 2) {
            triggerAI("Phase 2 start — give the warm greeting opening in Armenian, then begin teaching «" + lesson?.title + "».");
          } else {
            triggerAI(`Phase ${nextPhase} — ${PHASES[nextPhase - 1]?.label ?? ""} — start in Armenian.`);
          }
        },
      }
    );
  };

  const handleChoiceClick = (msgIdx: number, choiceNum: number, choiceText: string) => {
    setMcAnsweredIds((prev) => new Set([...prev, msgIdx]));
    sendMessage.mutate(
      { data: { message: `${choiceNum}) ${choiceText}`, lessonId } },
      {
        onSuccess: (data) => {
          queryClient.invalidateQueries({ queryKey: chatKey });
          const resp = (data as { response?: string }).response ?? "";
          const correct = isCorrectResponse(resp);
          setPhaseScore((s) =>
            correct === true
              ? { ...s, correct: s.correct + 1, total: s.total + 1 }
              : correct === false
              ? { ...s, total: s.total + 1, wrong: [...s.wrong, choiceText] }
              : s
          );
        },
      }
    );
  };

  const handleSend = () => {
    if (!message.trim() || sendMessage.isPending) return;
    const msg = message;
    setMessage("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    sendMessage.mutate(
      { data: { message: msg, lessonId } },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKey }) }
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const adjustHeight = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
  };

  if (authLoading || lessonLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user || !lesson) return null;

  const progressPct = hasSession ? Math.round(((currentPhase - 1) / 8) * 100) : 0;
  const firstName = (user as { fullName?: string }).fullName?.split(" ")[0] ?? "Aŝakert";
  const scorePct = phaseScore.total > 0 ? Math.round((phaseScore.correct / phaseScore.total) * 100) : null;

  /* ═══════════════════════════════════════════════════════
     INTRO SCREEN
  ═══════════════════════════════════════════════════════ */
  if (!hasSession) {
    return (
      <div className="min-h-[100dvh] bg-background text-white flex flex-col">
        {/* Top bar */}
        <header className="shrink-0 border-b border-white/10 bg-card/60 backdrop-blur-lg">
          <div className="max-w-3xl mx-auto px-5 py-4 flex items-center justify-between">
            <Link href={`/subjects/${lesson.subjectId}`} className="flex items-center gap-2 text-muted-foreground hover:text-white transition-colors text-sm">
              ← Հet
            </Link>
            <span className="text-xs text-muted-foreground">{todayArmenian()}</span>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-5 py-10 flex flex-col gap-8">

            {/* Greeting */}
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-2xl shrink-0 shadow-lg shadow-primary/30">👋</div>
              <div>
                <p className="text-muted-foreground text-sm">Barĭ or,</p>
                <h2 className="text-xl font-bold">{firstName}!</h2>
              </div>
            </div>

            {/* Lesson topic card */}
            <div className="rounded-3xl border border-white/10 bg-card/60 backdrop-blur-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-white/10 bg-white/5">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Aysorva dassi theman e</p>
              </div>
              <div className="px-6 py-6 flex items-start gap-4">
                <div className="w-12 h-12 rounded-2xl bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0 text-2xl">📖</div>
                <div>
                  <h1 className="text-2xl font-bold leading-snug">{lesson.title}</h1>
                  <span className="inline-block mt-2 px-3 py-1 rounded-full bg-secondary/20 text-secondary text-xs font-medium border border-secondary/30">
                    {lesson.subjectName}
                  </span>
                </div>
              </div>
              {lesson.description && (
                <p className="px-6 pb-5 text-sm text-muted-foreground leading-relaxed border-t border-white/10 pt-4">{lesson.description}</p>
              )}
            </div>

            {/* Goals */}
            <div className="rounded-3xl border border-white/10 bg-card/60 backdrop-blur-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-white/10 bg-white/5">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">📌 Dasi npataknerĕ</p>
              </div>
              <ul className="px-6 py-5 flex flex-col gap-3">
                {[
                  `Hisel ev chanachel «${lesson.title}»-i himnakan haskatsutiunnerĕ`,
                  `Haskanal orinachaparyounnerĕ ev drants kiraŕman skzbunqnerĕ`,
                  `Kiraŕel nor giteliqnerĕ gortsnaKAN xndirneri luzman jamanak`,
                ].map((g, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="mt-0.5 w-6 h-6 rounded-full bg-primary/20 text-primary text-xs font-bold flex items-center justify-center shrink-0 border border-primary/30">{i + 1}</span>
                    <span className="text-sm text-muted-foreground leading-relaxed">{g}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Outcomes */}
            <div className="rounded-3xl border border-white/10 bg-card/60 backdrop-blur-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-white/10 bg-white/5">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">🎯 Dasi verjna ardyunknerĕ</p>
              </div>
              <ul className="px-6 py-5 flex flex-col gap-3">
                {[
                  `✓ Kkароghanas bacatrel «${lesson.title}»-i himnakan kanonnere`,
                  `✓ Kkataŕes varzhutyunner inkushuŝyn`,
                  `✓ Kkapes usumnasiratsĕ kyankhi iraKAN iravichaknutyunneri het`,
                ].map((o, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="text-secondary mt-0.5">✦</span>
                    <span className="text-sm leading-relaxed">{o}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Bloom preview */}
            <div className="rounded-3xl border border-white/10 bg-card/60 backdrop-blur-sm px-6 py-5">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-4">🧠 Bloom makardakner</p>
              <div className="flex items-center justify-between gap-2">
                {BLOOM.map((b, i) => (
                  <div key={b.level} className="flex flex-col items-center gap-2 flex-1">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-all"
                      style={{ backgroundColor: i < 3 ? b.color : "transparent", borderColor: b.color, color: i < 3 ? "white" : b.color, opacity: i < 3 ? 1 : 0.4 }}>
                      {b.level}
                    </div>
                    <span className="text-[10px] text-muted-foreground text-center hidden sm:block">{b.name}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-3 text-center">
                Aysor das — <span className="text-white font-semibold">1–3</span> makardak
              </p>
            </div>

            {/* 8 phases overview */}
            <div className="rounded-3xl border border-white/10 bg-card/60 backdrop-blur-sm px-6 py-5">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-4">📋 8 fazher</p>
              <div className="grid grid-cols-2 gap-2">
                {PHASES.map((p) => (
                  <div key={p.phase} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{p.icon}</span>
                    <span>{p.phase}. {p.label}</span>
                    <span className="ml-auto text-white/30 shrink-0">{p.duration}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* CTA button */}
            <div className="pb-6">
              <button
                onClick={handleStartLesson}
                disabled={startSession.isPending}
                className="w-full py-5 rounded-3xl bg-gradient-to-r from-primary to-secondary text-white font-bold text-xl shadow-2xl shadow-primary/30 hover:opacity-90 transition-all active:scale-[0.98] disabled:opacity-60"
              >
                {startSession.isPending ? (
                  <span className="flex items-center justify-center gap-3">
                    <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Bernvum e...
                  </span>
                ) : "▶ Sksenk dasĕ"}
              </button>
              <p className="text-center text-xs text-muted-foreground mt-3">
                AI ucucich · 8 fazh · Bazhmaki ĕntrutyun · Hayeren
              </p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  /* ═══════════════════════════════════════════════════════
     LEARNING SCREEN
  ═══════════════════════════════════════════════════════ */
  const lastAiIdx = messages.map((m, i) => ({ m, i })).filter(x => x.m.role === "assistant").at(-1)?.i ?? -1;

  return (
    <div className="flex flex-col h-[100dvh] bg-background text-white overflow-hidden">

      {/* Header */}
      <header className="shrink-0 border-b border-white/10 bg-card/80 backdrop-blur-lg">
        <div className="flex items-center gap-3 px-4 py-3">
          <Link href={`/subjects/${lesson.subjectId}`} className="p-2 -ml-2 text-muted-foreground hover:text-white rounded-full hover:bg-white/5 transition-colors shrink-0">←</Link>

          <div className="flex-1 min-w-0">
            <div className="font-semibold text-sm truncate">{lesson.title}</div>
            <div className="flex items-center gap-2 mt-0.5">
              <div className="h-1.5 flex-1 bg-white/10 rounded-full overflow-hidden max-w-[140px]">
                <div className="h-full bg-gradient-to-r from-primary to-secondary rounded-full transition-all duration-500" style={{ width: `${progressPct}%` }} />
              </div>
              <span className="text-[11px] text-muted-foreground">{progressPct}%</span>
            </div>
          </div>

          {/* Phase 1 score */}
          {currentPhase === 1 && phaseScore.total > 0 && scorePct !== null && (
            <div className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border ${
              scorePct >= 70 ? "bg-green-500/20 text-green-400 border-green-500/30" : "bg-amber-500/20 text-amber-400 border-amber-500/30"
            }`}>
              {phaseScore.correct}/{phaseScore.total} · {scorePct}%
            </div>
          )}

          {!isCompleted && currentPhase < 8 && (
            <button
              onClick={handleAdvancePhase}
              disabled={advancePhase.isPending}
              className="shrink-0 px-3 py-1.5 rounded-xl bg-secondary/20 text-secondary border border-secondary/30 text-xs font-semibold hover:bg-secondary/30 transition-colors disabled:opacity-50"
            >
              Haĵord fazh →
            </button>
          )}
          {isCompleted && (
            <span className="shrink-0 px-3 py-1.5 rounded-xl bg-green-500/20 text-green-400 border border-green-500/30 text-xs font-semibold">✓ Avartvats</span>
          )}
        </div>

        {/* Phase strip */}
        <div className="flex gap-1 px-4 pb-3 overflow-x-auto scrollbar-none">
          {PHASES.map((p) => {
            const isDone = p.phase < currentPhase;
            const isCurrent = p.phase === currentPhase;
            return (
              <div key={p.phase} className={`shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
                isCurrent ? "bg-primary text-white shadow-lg shadow-primary/30"
                : isDone ? "bg-secondary/20 text-secondary"
                : "bg-white/5 text-muted-foreground"
              }`}>
                <span>{p.icon}</span>
                <span className="hidden sm:inline">{p.name}</span>
                <span className="sm:hidden">{p.phase}</span>
                {isDone && <span>✓</span>}
              </div>
            );
          })}
        </div>
      </header>

      {/* Messages */}
      <main className="flex-1 overflow-y-auto p-4">
        <div className="max-w-3xl mx-auto flex flex-col gap-4">

          {/* Phase banner */}
          {currentPhase > 0 && (
            <div className="flex items-center gap-3 py-2 px-4 rounded-2xl bg-primary/10 border border-primary/20">
              <span className="text-lg">{PHASES[currentPhase - 1]?.icon}</span>
              <div className="flex-1">
                <span className="font-semibold text-primary text-sm">Fazh {currentPhase}</span>
                <span className="text-muted-foreground text-sm ml-2">— {PHASES[currentPhase - 1]?.label}</span>
                {currentPhase === 1 && <span className="text-xs text-muted-foreground ml-2">· Ĕntrir 1, 2 kam 3</span>}
              </div>
              {currentPhase === 1 && phaseScore.total > 0 && scorePct !== null && (
                <div className="flex items-center gap-2 shrink-0">
                  <div className="h-2 w-16 bg-white/10 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${scorePct >= 70 ? "bg-green-400" : "bg-amber-400"}`} style={{ width: `${scorePct}%` }} />
                  </div>
                  <span className="text-xs font-bold">{scorePct}%</span>
                </div>
              )}
            </div>
          )}

          {/* Loading state */}
          {messages.length === 0 && !sendMessage.isPending && (
            <div className="self-start rounded-2xl p-4 bg-card border-l-4 border-secondary border-y border-r border-white/10">
              <div className="text-xs font-medium text-secondary mb-1">AI Ucucich</div>
              <div className="text-sm text-muted-foreground animate-pulse">Patarastvoum em...</div>
            </div>
          )}

          {/* Message list */}
          {messages.map((msg, idx) => {
            const isUser = msg.role === "user";
            const isLastAi = !isUser && idx === lastAiIdx;
            const formattedContent = formatMath(msg.content);
            const mc = isLastAi ? parseMultipleChoice(formattedContent) : null;
            const alreadyAnswered = mcAnsweredIds.has(idx);
            const correctness = !isUser ? isCorrectResponse(formattedContent) : null;

            if (isUser) {
              return (
                <div key={idx} className="max-w-[80%] self-end rounded-2xl rounded-br-sm p-4 bg-primary text-white shadow-md">
                  <div className="text-sm leading-relaxed whitespace-pre-wrap">{formattedContent}</div>
                </div>
              );
            }

            return (
              <div key={idx} className="self-start max-w-[92%] sm:max-w-[82%] flex flex-col gap-3">
                <div className={`rounded-2xl rounded-bl-sm p-4 shadow-md border-y border-r border-white/10 ${
                  correctness === true ? "bg-green-500/10 border-l-4 border-l-green-400"
                  : correctness === false ? "bg-red-500/10 border-l-4 border-l-red-400"
                  : "bg-card border-l-4 border-l-secondary"
                }`}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-xs font-semibold text-secondary">AI Ucucich</span>
                    {correctness === true && <span className="text-xs text-green-400 font-medium">✓ Ĉisht</span>}
                    {correctness === false && <span className="text-xs text-red-400 font-medium">✗ Skhal</span>}
                  </div>
                  <div className="text-sm sm:text-base leading-relaxed whitespace-pre-wrap">{formattedContent}</div>
                </div>

                {/* MC buttons — only on last AI message, not yet answered */}
                {mc && !alreadyAnswered && !sendMessage.isPending && (
                  <div className="flex flex-col gap-2 pl-2">
                    {mc.options.map((opt, optIdx) => (
                      <button
                        key={optIdx}
                        onClick={() => handleChoiceClick(idx, optIdx + 1, opt)}
                        className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-white/5 border border-white/15 hover:bg-primary/15 hover:border-primary/40 transition-all text-left group"
                      >
                        <span className="w-7 h-7 rounded-full bg-white/10 border border-white/20 group-hover:bg-primary group-hover:border-primary text-xs font-bold flex items-center justify-center shrink-0 transition-all">
                          {optIdx + 1}
                        </span>
                        <span className="text-sm">{opt}</span>
                      </button>
                    ))}
                  </div>
                )}
                {mc && alreadyAnswered && (
                  <p className="pl-2 text-xs text-muted-foreground italic">Pataskhane chakatvets...</p>
                )}
              </div>
            );
          })}

          {/* AI typing indicator */}
          {sendMessage.isPending && (
            <div className="self-start rounded-2xl p-4 bg-card border-l-4 border-secondary border-y border-r border-white/10 rounded-bl-sm flex items-center gap-3">
              <span className="text-xs font-semibold text-secondary">AI Ucucich</span>
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-secondary rounded-full animate-bounce [animation-delay:-0.3s]" />
                <span className="w-1.5 h-1.5 bg-secondary rounded-full animate-bounce [animation-delay:-0.15s]" />
                <span className="w-1.5 h-1.5 bg-secondary rounded-full animate-bounce" />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </main>

      {/* Wrong answers strip */}
      {currentPhase === 1 && phaseScore.wrong.length > 0 && (
        <div className="shrink-0 px-4 pb-2">
          <div className="max-w-3xl mx-auto px-4 py-2 rounded-2xl bg-red-500/10 border border-red-500/20 text-xs text-red-300">
            <span className="font-semibold">📌 Petq e krknel: </span>
            {phaseScore.wrong.slice(-3).join(" · ")}
          </div>
        </div>
      )}

      {/* Input bar */}
      <footer className="shrink-0 p-4 border-t border-white/10 bg-card/50 backdrop-blur-lg">
        <div className="max-w-3xl mx-auto">
          {sendMessage.isError && (
            <p className="text-red-400 text-xs mb-2">Skhal tĕghi unetsav. Pŏrtsek krknal.</p>
          )}
          <div className="flex items-end gap-2 bg-background border border-white/10 rounded-2xl p-2 focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/30 transition-all">
            <textarea
              ref={textareaRef}
              value={message}
              onChange={adjustHeight}
              onKeyDown={handleKeyDown}
              placeholder={currentPhase === 1 ? "Gris pataskhane (kam ĕntrir verevits)..." : "Gris pataskhane..."}
              rows={1}
              className="flex-1 bg-transparent border-0 focus:ring-0 resize-none max-h-[120px] min-h-[40px] py-2 px-3 text-sm outline-none"
            />
            <button
              onClick={handleSend}
              disabled={!message.trim() || sendMessage.isPending}
              className="shrink-0 p-2 h-10 w-10 flex items-center justify-center rounded-xl bg-gradient-to-br from-primary to-secondary text-white disabled:opacity-40 transition-opacity hover:opacity-90"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 -ml-0.5 mt-0.5">
                <path d="M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z" />
              </svg>
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
