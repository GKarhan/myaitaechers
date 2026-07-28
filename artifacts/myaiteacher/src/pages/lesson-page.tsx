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
  { phase: 1, name: "Կrknoutyun", icon: "🔄" },
  { phase: 2, name: "Nor das", icon: "💡" },
  { phase: 3, name: "Khor ousumnasirum", icon: "🔍" },
  { phase: 4, name: "Tnayin", icon: "📚" },
];

const BLOOM = [
  { level: 1, name: "Հիշել", color: "#14B8A6" },
  { level: 2, name: "Հասկանալ", color: "#6366F1" },
  { level: 3, name: "Կիրառել", color: "#8B5CF6" },
  { level: 4, name: "Վերлուծел", color: "#F59E0B" },
  { level: 5, name: "Гнahatel", color: "#EF4444" },
  { level: 6, name: "Steghtsagortsel", color: "#EC4899" },
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
      triggerAI("Սկсел");
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
          triggerAI(`Анцa ${nextPhase}-рд фул: ${pName}`);
        },
        onError: (err: unknown) => {
          const responseData = (err as { response?: { data?: { error?: string } } })?.response?.data;
          setGateMessage(
            responseData?.error ?? "Hajорд фулин анцнел hнарававор чегав, форджир кркин:"
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
            ← Հetk
          </Link>

          <div className="rounded-3xl border border-white/10 bg-card/60 backdrop-blur-xl p-8 shadow-2xl">
            <div className="flex items-center gap-3 mb-6">
              <span className="px-3 py-1 rounded-full bg-primary/20 text-primary text-xs font-semibold border border-primary/30">
                {BLOOM[(lesson.bloomLevel ?? 1) - 1]?.name ?? "Hishel"}
              </span>
            </div>

            <h1 className="text-2xl font-bold mb-3 leading-tight">{lesson.title}</h1>
            {lesson.description && (
              <p className="text-muted-foreground text-sm mb-6 leading-relaxed">{lesson.description}</p>
            )}

            <div className="flex flex-col gap-4 mt-6">
              <div className="grid grid-cols-4 gap-2">
                {PHASES.map((p) => (
                  <div key={p.phase} className="flex flex-col items-center gap-1 p-2 rounded-xl bg-white/5 border border-white/10">
                    <span className="text-lg">{p.icon}</span>
                    <span className="text-[10px] text-muted-foreground text-center leading-tight">{p.name}</span>
                  </div>
                ))}
              </div>
              <button
                onClick={handleStartLesson}
                disabled={startSession.isPending}
                className="w-full py-3 px-6 rounded-xl bg-primary text-white font-semibold text-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {startSession.isPending ? "Бернвум..." : "Skysel dassy"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ── CHAT SCREEN ─────────────────────────────────────── */
  return (
    <div className="min-h-[100dvh] w-full bg-background text-white flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10 bg-card/60 backdrop-blur-xl sticky top-0 z-10">
        <Link href={`/subjects/${lesson.subjectId}`} className="text-muted-foreground hover:text-white transition-colors">
          ←
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold truncate">{lesson.title}</h1>
          <div className="flex items-center gap-1.5 mt-0.5 overflow-x-auto">
            {PHASES.map((p) => (
              <span
                key={p.phase}
                className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap transition-colors ${
                  currentPhase === p.phase
                    ? "bg-primary/30 text-primary font-medium"
                    : currentPhase > p.phase
                    ? "bg-emerald-500/20 text-emerald-400"
                    : "text-muted-foreground"
                }`}
              >
                {p.icon} {p.name}
              </span>
            ))}
          </div>
        </div>
        {isCompleted && (
          <span className="text-xs px-2 py-1 rounded-full bg-emerald-500/20 text-emerald-400 font-medium shrink-0">
            ✅
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div className="h-0.5 bg-white/10">
        <div className="h-full bg-primary transition-all duration-500" style={{ width: `${progressPct}%` }} />
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {chatLoading ? (
          <div className="flex justify-center pt-8">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : null}

        {messages.map((m) => (
          <div key={m.id} className={`flex items-start gap-3 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm flex-shrink-0 ${
              m.role === "user" ? "bg-indigo-500/20 text-indigo-400" : "bg-primary/20 text-primary"
            }`}>
              {m.role === "user" ? "👤" : "🤖"}
            </div>
            <div className={`rounded-2xl px-4 py-3 max-w-[80%] text-sm leading-relaxed whitespace-pre-wrap ${
              m.role === "user"
                ? "bg-indigo-500/20 border border-indigo-500/20 rounded-tr-sm"
                : "bg-card/60 border border-white/10 rounded-tl-sm"
            }`}>
              {m.content}
            </div>
          </div>
        ))}

        {sendMessage.isPending && (
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary text-sm flex-shrink-0">
              🤖
            </div>
            <div className="bg-card/60 border border-white/10 rounded-2xl rounded-tl-sm px-4 py-3">
              <div className="flex gap-1 items-center h-5">
                <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:-0.3s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:-0.15s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Gate message */}
      {gateMessage && (
        <div className="mx-4 mb-2 px-4 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 text-sm">
          {gateMessage}
        </div>
      )}

      {/* Phase advance */}
      {hasSession && !isCompleted && (
        <div className="px-4 pb-2">
          <button
            onClick={handleAdvancePhase}
            disabled={advancePhase.isPending}
            className="w-full py-2 px-4 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-muted-foreground hover:text-white text-xs font-medium transition-colors disabled:opacity-50"
          >
            {advancePhase.isPending
              ? "Ancnum..."
              : `Hajord ful → ${PHASES[currentPhase]?.name ?? "Avart"}`}
          </button>
        </div>
      )}

      {/* Input */}
      {!isCompleted && (
        <div className="px-4 pb-4 pt-2 border-t border-white/10 bg-card/30 backdrop-blur-xl">
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={message}
              onChange={adjustHeight}
              onKeyDown={handleKeyDown}
              placeholder="Grir pataskhandt..."
              rows={1}
              className="flex-1 resize-none rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors min-h-[44px] max-h-[120px]"
            />
            <button
              onClick={handleSend}
              disabled={!message.trim() || sendMessage.isPending}
              className="h-11 w-11 flex items-center justify-center rounded-xl bg-primary text-white hover:bg-primary/90 transition-colors disabled:opacity-40 flex-shrink-0 text-lg"
            >
              ↑
            </button>
          </div>
        </div>
      )}

      {isCompleted && (
        <div className="px-4 pb-6 text-center">
          <div className="inline-flex flex-col items-center gap-3 px-6 py-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/20">
            <span className="text-3xl">🎓</span>
            <p className="text-emerald-400 font-semibold text-sm">Dasn avartval e!</p>
            <Link
              href={`/subjects/${lesson.subjectId}`}
              className="text-xs text-muted-foreground hover:text-white transition-colors"
            >
              ← Veradardnal arrakain
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
