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
  { phase: 1, name: "Կրկնություն", icon: "🔄", duration: "5 ր" },
  { phase: 2, name: "Հիմնական գաղափարներ", icon: "💡", duration: "10 ր" },
  { phase: 3, name: "Երկրորդական", icon: "🔍", duration: "8 ր" },
  { phase: 4, name: "Կիրառություն", icon: "⚙️", duration: "10 ր" },
  { phase: 5, name: "Ստեղծագործ", icon: "✨", duration: "10 ր" },
  { phase: 6, name: "Նախագիծ", icon: "🚀", duration: "12 ր" },
  { phase: 7, name: "Ամփոփում", icon: "📋", duration: "5 ր" },
  { phase: 8, name: "Տնային", icon: "📚", duration: "—" },
];

const BLOOM = [
  { level: 1, name: "Հիշել", color: "#14B8A6" },
  { level: 2, name: "Հասկանալ", color: "#6366F1" },
  { level: 3, name: "Կիրառել", color: "#8B5CF6" },
  { level: 4, name: "Վերլուծել", color: "#F59E0B" },
  { level: 5, name: "Գնահատել", color: "#EF4444" },
  { level: 6, name: "Ստեղծել", color: "#EC4899" },
];

function todayArmenian() {
  const d = new Date();
  const months = ["հունվար", "փետրվար", "մարտ", "ապրիլ", "մայիս", "հունիս",
    "հուլիս", "օգոստոս", "սեպտեմբեր", "հոկտեմբեր", "նոյեմբեր", "դեկտեմբեր"];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

export default function LessonPage() {
  const { user, token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { id } = useParams<{ id: string }>();
  const lessonId = parseInt(id || "0", 10);
  const queryClient = useQueryClient();

  const [message, setMessage] = useState("");
  const [autoStarted, setAutoStarted] = useState(false);
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
  const { data: messages = [], isLoading: chatLoading } = useGetChatHistory(chatParams, {
    query: { queryKey: chatKey, enabled: !!token && !!lessonId },
  });

  const startSession = useStartLessonSession();
  const advancePhase = useAdvanceLessonPhase();
  const sendMessage = useSendChatMessage();

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);
  useEffect(() => { scrollToBottom(); }, [messages, sendMessage.isPending]);

  const session = lesson?.currentSession;
  const currentPhase = session?.currentPhase ?? 0;
  const isCompleted = session?.status === "completed";
  const hasSession = !!session;

  const triggerAI = useCallback((triggerMsg: string) => {
    sendMessage.mutate(
      { data: { message: triggerMsg, lessonId } },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKey }) }
    );
  }, [sendMessage, lessonId, queryClient, chatKey]);

  useEffect(() => {
    if (hasSession && !autoStarted && !chatLoading && (messages as unknown[]).length === 0 && !sendMessage.isPending) {
      setAutoStarted(true);
      triggerAI("Դасĭ սksel — ողjunir ĵerm ĵeri arajaatanutyunov, heto sksir Fazh 1 krknutyun");
    }
  }, [hasSession, autoStarted, chatLoading, messages, sendMessage.isPending, triggerAI]);

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
          const pName = PHASES[nextPhase - 1]?.name ?? "";
          triggerAI(`Անցա ${nextPhase}֊րդ փուլ: ${pName}`);
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
  const firstName = (user as { fullName?: string }).fullName?.split(" ")[0] ?? "Աշակերտ";

  /* ── INTRO SCREEN (no active session) ──────────────────── */
  if (!hasSession) {
    const goals = [
      `Հիշել և ճանաչել «${lesson.title}»-ի հիմնական հասկացությունները`,
      `Հասկանալ օրինաչափությունները և դրանց կիրառման սկզբունքները`,
      `Կիրառել նոր գիտելիքները գործնական խնդիրների լուծման ժամանակ`,
    ];
    const outcomes = [
      `✓ Կկարողանաս բացատրել «${lesson.title}»-ի հիմնական կանոնները`,
      `✓ Կկատարես համապատասխան վարժություններ ինքնուրույն`,
      `✓ Կկապես ուսումնասիրած նյութը կյանքի իրական իրավիճակների հետ`,
    ];

    return (
      <div className="min-h-[100dvh] bg-background text-white flex flex-col">
        {/* Top bar */}
        <header className="shrink-0 border-b border-white/10 bg-card/60 backdrop-blur-lg">
          <div className="max-w-3xl mx-auto px-5 py-4 flex items-center justify-between">
            <Link
              href={`/subjects/${lesson.subjectId}`}
              className="flex items-center gap-2 text-muted-foreground hover:text-white transition-colors text-sm"
            >
              ← Հետ
            </Link>
            <span className="text-xs text-muted-foreground">{todayArmenian()}</span>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-5 py-10 flex flex-col gap-8">

            {/* Greeting */}
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-2xl shrink-0 shadow-lg shadow-primary/30">
                👋
              </div>
              <div>
                <p className="text-muted-foreground text-sm">Բարի օր,</p>
                <h2 className="text-xl font-bold">{firstName}!</h2>
              </div>
            </div>

            {/* Today's lesson topic */}
            <div className="rounded-3xl border border-white/10 bg-card/60 backdrop-blur-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-white/10 bg-white/5">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                  Այսօրվա դասի թեման
                </p>
              </div>
              <div className="px-6 py-6">
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-2xl bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0">
                    <span className="text-2xl">📖</span>
                  </div>
                  <div>
                    <h1 className="text-2xl font-bold leading-snug">{lesson.title}</h1>
                    <span className="inline-block mt-2 px-3 py-1 rounded-full bg-secondary/20 text-secondary text-xs font-medium border border-secondary/30">
                      {lesson.subjectName}
                    </span>
                  </div>
                </div>
                {lesson.description && (
                  <p className="mt-4 text-sm text-muted-foreground leading-relaxed border-t border-white/10 pt-4">
                    {lesson.description}
                  </p>
                )}
              </div>
            </div>

            {/* Lesson goals */}
            <div className="rounded-3xl border border-white/10 bg-card/60 backdrop-blur-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-white/10 bg-white/5">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                  📌 Դասի նպատակները
                </p>
              </div>
              <ul className="px-6 py-5 flex flex-col gap-3">
                {goals.map((g, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="mt-0.5 w-6 h-6 rounded-full bg-primary/20 text-primary text-xs font-bold flex items-center justify-center shrink-0 border border-primary/30">
                      {i + 1}
                    </span>
                    <span className="text-sm text-muted-foreground leading-relaxed">{g}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Expected outcomes */}
            <div className="rounded-3xl border border-white/10 bg-card/60 backdrop-blur-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-white/10 bg-white/5">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                  🎯 Դասի վերջնարդյունքները
                </p>
              </div>
              <ul className="px-6 py-5 flex flex-col gap-3">
                {outcomes.map((o, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="text-secondary mt-0.5">✦</span>
                    <span className="text-sm leading-relaxed">{o}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Bloom levels preview */}
            <div className="rounded-3xl border border-white/10 bg-card/60 backdrop-blur-sm px-6 py-5">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-4">
                🧠 Գիտելիքի մակարդակները (Բլում)
              </p>
              <div className="flex items-center justify-between gap-2">
                {BLOOM.map((b, i) => (
                  <div key={b.level} className="flex flex-col items-center gap-2 flex-1">
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white border-2 transition-all"
                      style={{
                        backgroundColor: i < 3 ? b.color : "transparent",
                        borderColor: b.color,
                        color: i < 3 ? "white" : b.color,
                        opacity: i < 3 ? 1 : 0.4,
                      }}
                    >
                      {b.level}
                    </div>
                    <span className="text-[10px] text-muted-foreground text-center leading-tight hidden sm:block">
                      {b.name}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-3 text-center">
                Այս դասում կհասնենք <span className="text-white font-semibold">1–3</span> մակարդակի
              </p>
            </div>

            {/* Start button */}
            <div className="pb-6">
              <button
                onClick={handleStartLesson}
                disabled={startSession.isPending}
                className="w-full py-5 rounded-3xl bg-gradient-to-r from-primary to-secondary text-white font-bold text-xl shadow-2xl shadow-primary/30 hover:opacity-90 transition-all active:scale-[0.98] disabled:opacity-60"
              >
                {startSession.isPending ? (
                  <span className="flex items-center justify-center gap-3">
                    <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Բեռնվում է...
                  </span>
                ) : (
                  "▶ Սկսենք դասը"
                )}
              </button>
              <p className="text-center text-xs text-muted-foreground mt-3">
                AI ուսուցիչը կառաջնորդի քեզ 8 փուլով · Սոկրատյան մեթոդ · Հայերեն
              </p>
            </div>

          </div>
        </main>
      </div>
    );
  }

  /* ── LEARNING SCREEN (session active) ──────────────────── */
  return (
    <div className="flex flex-col h-[100dvh] bg-background text-white overflow-hidden">

      {/* Header */}
      <header className="shrink-0 border-b border-white/10 bg-card/80 backdrop-blur-lg">
        <div className="flex items-center gap-3 px-4 py-3">
          <Link href={`/subjects/${lesson.subjectId}`} className="p-2 -ml-2 text-muted-foreground hover:text-white rounded-full hover:bg-white/5 transition-colors">
            ←
          </Link>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-sm truncate">{lesson.title}</div>
            <div className="flex items-center gap-2 mt-0.5">
              <div className="h-1.5 flex-1 bg-white/10 rounded-full overflow-hidden max-w-[180px]">
                <div
                  className="h-full bg-gradient-to-r from-primary to-secondary rounded-full transition-all duration-500"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="text-[11px] text-muted-foreground">{progressPct}%</span>
            </div>
          </div>
          {!isCompleted && currentPhase < 8 && (
            <button
              onClick={handleAdvancePhase}
              disabled={advancePhase.isPending}
              className="shrink-0 px-3 py-1.5 rounded-xl bg-secondary/20 text-secondary border border-secondary/30 text-xs font-semibold hover:bg-secondary/30 transition-colors disabled:opacity-50"
            >
              Հաջ. փուլ →
            </button>
          )}
          {isCompleted && (
            <span className="shrink-0 px-3 py-1.5 rounded-xl bg-green-500/20 text-green-400 border border-green-500/30 text-xs font-semibold">
              ✓ Ավարտված
            </span>
          )}
        </div>

        {/* Phase strip */}
        <div className="flex gap-1 px-4 pb-3 overflow-x-auto scrollbar-none">
          {PHASES.map((p) => {
            const isDone = p.phase < currentPhase;
            const isCurrent = p.phase === currentPhase;
            return (
              <div
                key={p.phase}
                className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  isCurrent
                    ? "bg-primary text-white shadow-lg shadow-primary/30"
                    : isDone
                    ? "bg-secondary/20 text-secondary"
                    : "bg-white/5 text-muted-foreground"
                }`}
              >
                <span>{p.icon}</span>
                <span className="hidden sm:inline">{p.name}</span>
                <span className="sm:hidden">{p.phase}</span>
                {isDone && <span className="text-[10px]">✓</span>}
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
            <div className="flex items-center gap-3 py-2 px-4 rounded-2xl bg-primary/10 border border-primary/20 text-sm">
              <span className="text-lg">{PHASES[currentPhase - 1]?.icon}</span>
              <div>
                <span className="font-semibold text-primary">Փուլ {currentPhase}</span>
                <span className="text-muted-foreground ml-2">— {PHASES[currentPhase - 1]?.name}</span>
              </div>
              <div className="ml-auto flex gap-1">
                {BLOOM.map((b) => (
                  <div
                    key={b.level}
                    title={b.name}
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: b.color, opacity: b.level <= Math.ceil(currentPhase * 0.75) ? 1 : 0.2 }}
                  />
                ))}
              </div>
            </div>
          )}

          {(messages as unknown[]).length === 0 && !sendMessage.isPending && (
            <div className="self-start max-w-[85%] rounded-2xl p-4 bg-card border-l-4 border-secondary border-y border-r border-white/10 shadow-lg">
              <div className="text-xs font-medium text-secondary mb-1">AI Ուսուցիչ</div>
              <div className="text-sm text-muted-foreground animate-pulse">Պատրաստվում եմ...</div>
            </div>
          )}

          {(messages as Array<{ role: string; content: string }>).map((msg, idx) => {
            const isUser = msg.role === "user";
            return (
              <div
                key={idx}
                className={`max-w-[85%] sm:max-w-[78%] rounded-2xl p-4 shadow-md ${
                  isUser
                    ? "self-end bg-primary text-white rounded-br-sm"
                    : "self-start bg-card border-l-4 border-secondary border-y border-r border-white/10 rounded-bl-sm"
                }`}
              >
                {!isUser && <div className="text-xs font-semibold text-secondary mb-1">AI Ուսուցիչ</div>}
                <div className="text-sm sm:text-base leading-relaxed whitespace-pre-wrap">{msg.content}</div>
              </div>
            );
          })}

          {sendMessage.isPending && (
            <div className="self-start max-w-[85%] rounded-2xl p-4 bg-card border-l-4 border-secondary border-y border-r border-white/10 shadow-lg rounded-bl-sm flex items-center gap-2">
              <div className="text-xs font-semibold text-secondary mr-1">AI Ուսուցիչ</div>
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

      {/* Input */}
      <footer className="shrink-0 p-4 border-t border-white/10 bg-card/50 backdrop-blur-lg">
        <div className="max-w-3xl mx-auto">
          {sendMessage.isError && (
            <p className="text-red-400 text-xs mb-2 px-1">Սխալ տեղի ունեցավ։ Փորձեք կրկին։</p>
          )}
          <div className="flex items-end gap-2 bg-background border border-white/10 rounded-2xl p-2 focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/30 transition-all">
            <textarea
              ref={textareaRef}
              value={message}
              onChange={adjustHeight}
              onKeyDown={handleKeyDown}
              placeholder="Գրեք ձեր պատասխանը..."
              rows={1}
              className="flex-1 bg-transparent border-0 focus:ring-0 resize-none max-h-[120px] min-h-[40px] py-2 px-3 text-sm outline-none"
            />
            <button
              onClick={handleSend}
              disabled={!message.trim() || sendMessage.isPending}
              className="shrink-0 p-2 h-10 w-10 flex items-center justify-center rounded-xl bg-gradient-to-br from-primary to-secondary text-white disabled:opacity-40 disabled:cursor-not-allowed transition-opacity hover:opacity-90"
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
