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
  { phase: 1, name: "Կրկնություն", icon: "🔄" },
  { phase: 2, name: "Նոր դաս", icon: "💡" },
  { phase: 3, name: "Խոր ուսումնասիրում", icon: "🔍" },
  { phase: 4, name: "Տնային աշխատանք", icon: "📚" },
];

const BLOOM = [
  { level: 1, name: "Հիշել", color: "#14B8A6" },
  { level: 2, name: "Հասկանալ", color: "#6366F1" },
  { level: 3, name: "Կիրառել", color: "#8B5CF6" },
  { level: 4, name: "Վերլուծել", color: "#F59E0B" },
  { level: 5, name: "Գնահատել", color: "#EF4444" },
  { level: 6, name: "Ստեղծել", color: "#EC4899" },
];

export default function LessonPage() {
  const { user, token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { id } = useParams<{ id: string }>();
  const lessonId = parseInt(id || "0", 10);
  const queryClient = useQueryClient();

  const [message, setMessage] = useState("");
  const [autoStarted, setAutoStarted] = useState(false);
  const [gateMessage, setGateMessage] = useState<string | null>(null);
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

  useEffect(() => { setGateMessage(null); }, [currentPhase]);

  const triggerAI = useCallback((triggerMsg: string) => {
    sendMessage.mutate(
      { data: { message: triggerMsg, lessonId } },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKey }) }
    );
  }, [sendMessage, lessonId, queryClient, chatKey]);

  useEffect(() => {
    if (hasSession && !autoStarted && !chatLoading && messages.length === 0 && !sendMessage.isPending) {
      setAutoStarted(true);
      triggerAI("Սկսել");
    }
  }, [hasSession, autoStarted, chatLoading, messages.length, sendMessage.isPending, triggerAI]);

  const handleStartLesson = () => {
    startSession.mutate(
      { data: { lessonId } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: lessonKey });
        },
      }
    );
  };

  const handleAdvancePhase = () => {
    setGateMessage(null);
    advancePhase.mutate(
      { lessonId },
      {
        onSuccess: (data) => {
          queryClient.invalidateQueries({ queryKey: lessonKey });
          const nextPhase = (data as { currentPhase: number }).currentPhase;
          const pName = PHASES[nextPhase - 1]?.name ?? "";
          triggerAI(`Անցա ${nextPhase}֊րդ փուլ: ${pName}`);
        },
        onError: (err: unknown) => {
          const responseData = (err as { response?: { data?: { error?: string } } })?.response?.data;
          setGateMessage(
            responseData?.error ?? "Հաջորդ փուլին անցնել հնարավոր չեղավ, փորձիր կրկին։"
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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
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

  const progressPct = hasSession ? Math.round(((currentPhase - 1) / 4) * 100) : 0;

  /* ── WELCOME SCREEN ─────────────────────────────────── */
  if (!hasSession) {
    return (
      <div className="min-h-[100dvh] w-full bg-background text-white flex flex-col items-center justify-center px-4">
        <div className="w-full max-w-lg">
          <Link href={`/subjects/${lesson.subjectId}`} className="inline-flex items-center gap-2 text-muted-foreground hover:text-white mb-8 transition-colors text-sm">
            ← Հետ
          </Link>

          <div className="rounded-3xl border border-white/10 bg-card/60 backdrop-blur-xl p-8 shadow-2xl">
            <div className="flex items-center gap-3 mb-6">
              <span className="px-3 py-1 rounded-full bg-primary/20 text-primary text-xs font-semibold border border-primary/30">
                {lesson.subjectName}
              </span>
              <span className="text-muted-foreground text-xs">Դաս #{lessonId}</span>
            </div>

            <h1 className="text-2xl font-bold mb-3 leading-snug">{lesson.title}</h1>
            {lesson.description && (
              <p className="text-muted-foreground text-sm mb-8 leading-relaxed">{lesson.description}</p>
            )}

            <div className="mb-8">
              <p className="text-center text-sm text-muted-foreground mb-4">Դասն ունի <span className="text-white font-semibold">4 փուլ</span></p>
              <div className="grid grid-cols-4 gap-2">
                {PHASES.map((p) => (
                  <div key={p.phase} className="flex flex-col items-center gap-1 p-2 rounded-xl bg-background/50 border border-white/5">
                    <span className="text-lg">{p.icon}</span>
                    <span className="text-[10px] text-muted-foreground text-center leading-tight">{p.name}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="text-center">
              <p className="text-lg font-semibold mb-2">Պատրա՞ստ ես սովորել</p>
              <p className="text-sm text-muted-foreground mb-6">AI ուսուցիչը կառաջնորդի քեզ Սոկրատյան մեթոդով</p>
              <button
                onClick={handleStartLesson}
                disabled={startSession.isPending}
                className="w-full py-4 rounded-2xl bg-gradient-to-r from-primary to-secondary text-white font-bold text-lg shadow-lg shadow-primary/30 hover:opacity-90 transition-opacity disabled:opacity-60"
              >
                {startSession.isPending ? "Բեռնվում է..." : "🚀 Սկսել սովորել"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ── LEARNING SCREEN ────────────────────────────────── */
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
              <div className="h-1.5 flex-1 bg-white/10 rounded-full overflow-hidden max-w-[200px]">
                <div
                  className="h-full bg-gradient-to-r from-primary to-secondary rounded-full transition-all duration-500"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="text-[11px] text-muted-foreground">{progressPct}%</span>
            </div>
          </div>
          {!isCompleted && currentPhase < 4 && (
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

      {/* Mastery gate message — shown when advance-phase was blocked */}
      {gateMessage && (
        <div className="shrink-0 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-2">
          <span className="text-amber-400 text-sm">⚠</span>
          <p className="text-xs text-amber-300 flex-1">{gateMessage}</p>
          <button
            onClick={() => setGateMessage(null)}
            className="text-amber-400/70 hover:text-amber-300 text-xs px-1"
          >
            ✕
          </button>
        </div>
      )}

      {/* Chat Messages */}
      <main className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="max-w-3xl mx-auto flex flex-col gap-4">

          {/* Phase intro banner */}
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
                    className="w-2.5 h-2.5 rounded-full transition-opacity"
                    style={{
                      backgroundColor: b.color,
                      opacity: b.level <= Math.ceil((currentPhase / 4) * 6) ? 1 : 0.2,
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {(messages as Array<{ role: string; content: string }>).length === 0 && !sendMessage.isPending && (
            <div className="self-start max-w-[85%] rounded-2xl p-4 bg-card border-l-4 border-secondary border-y border-r border-white/10 shadow-lg">
              <div className="text-xs font-medium text-secondary mb-1">AI Ուսուցիչ</div>
              <div className="text-sm leading-relaxed text-muted-foreground animate-pulse">
                Պատրաստվում եմ...
              </div>
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
                {!isUser && (
                  <div className="text-xs font-semibold text-secondary mb-1">AI Ուսուցիչ</div>
                )}
                <div className="text-sm sm:text-base leading-relaxed whitespace-pre-wrap">
                  {msg.content}
                </div>
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