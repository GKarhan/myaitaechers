import { useEffect, useState, useRef } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useAuth } from "@/lib/auth";
import { 
  useGetChatHistory, getGetChatHistoryQueryKey,
  useSendChatMessage
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateKnowledgeTreeQueries } from "@/lib/knowledge-tree-cache";

// ── Phase 2B Part 13: Progressive Help UI ─────────────────────────────────────
// Help levels:
//   1 = 💡 Ուղղորդիչ հուշում    (light directional hint)
//   2 = Ավելի շատ ուղղություն   (moderate guidance)
//   3 = Կայելաin ajakcutyun      (step-by-step guided)
//   4 = Տեսնել բացատրությունը   (answer reveal — requires separate confirm)
//
// Rules enforced here (mirroring backend):
//   • Help button only appears while a lesson is active (lessonId set).
//   • Cannot request help while a message is pending.
//   • Level 4 requires an explicit second tap on the confirm button.
//   • Help never produces a regular chat bubble — it appears as a distinct
//     amber/help card to keep it visually separate from AI Teacher replies.
//   • Reset on new lesson or page refresh (server holds true state).

const HELP_LEVELS = [
  null,
  "Ռուբն հուշում",
  "Ավելի շատ ուգնություն",
  "Կայլական աջկակցություն",
];

const HELP_BUTTON_LABELS: Record<number, string> = {
  0: "💡 Հուշում",
  1: "Ավելի շատ հուշում",
  2: "Քայլ առ քայլ աջակցություն",
  3: "Բացատրություն",
};

export default function Chat() {
  const { user, token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { id } = useParams<{ id: string }>();
  const lessonIdParam = parseInt(id || "0", 10);
  const lessonId = lessonIdParam > 0 ? lessonIdParam : undefined;
  
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const helpRequestInFlightRef = useRef(false);

  // ── Help state ─────────────────────────────────────────────────────────────
  // hasActiveTask: true when server session is in MICRO_CHECK or EXERCISE stage.
  // Hydrated on mount from /api/chat/session-state and updated on every chat response.
  const [hasActiveTask, setHasActiveTask]     = useState(false);
  const [helpLevel, setHelpLevel]             = useState(0); // matches server activeHelpCount
  const [helpLoading, setHelpLoading]         = useState(false);
  const [helpError, setHelpError]             = useState<string | null>(null);
  const [showRevealConfirm, setShowRevealConfirm] = useState(false);
  const [helpCards, setHelpCards]             = useState<{ level: number; content: string }[]>([]);

  useEffect(() => {
    if (!authLoading && !token) {
      setLocation("/login");
    }
  }, [token, authLoading, setLocation]);

  // ── Hydrate active-task state on mount / lessonId change ──────────────────
  // POST /chat responses update hasActiveTask in real time, but on a hard refresh
  // the server session still holds the true state — recover it here.
  useEffect(() => {
    if (!lessonId || !token) return;
    fetch(`/api/chat/session-state?lessonId=${lessonId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { hasActiveTask?: boolean; activeHelpCount?: number } | null) => {
        if (!data) return;
        if (data.hasActiveTask !== undefined) setHasActiveTask(data.hasActiveTask);
        if (data.activeHelpCount !== undefined) setHelpLevel(data.activeHelpCount);
      })
      .catch(() => {}); // non-critical — button hidden until next message
  }, [lessonId, token]);

  const historyParams = lessonId ? { lessonId } : undefined;
  const { data: chatHistory, isLoading: historyLoading } = useGetChatHistory(historyParams, {
    query: {
      queryKey: getGetChatHistoryQueryKey(historyParams),
      enabled: !!token,
    }
  });

  const sendMessageMutation = useSendChatMessage();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [chatHistory, sendMessageMutation.isPending, helpCards]);

  const handleSend = () => {
    if (!message.trim() || sendMessageMutation.isPending) return;

    const currentMsg = message;
    setMessage("");
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    sendMessageMutation.mutate(
      { data: { message: currentMsg, lessonId } },
      {
        onSuccess: (responseData) => {
          queryClient.invalidateQueries({ queryKey: getGetChatHistoryQueryKey(historyParams) });
          void invalidateKnowledgeTreeQueries(queryClient);
          // Update hasActiveTask from server response (Phase 2B)
          const d = responseData as { hasActiveTask?: boolean; activeHelpCount?: number } | undefined;
          if (d?.hasActiveTask !== undefined) {
            setHasActiveTask(d.hasActiveTask);
            if (!d.hasActiveTask) {
              // Task ended (e.g. node VERIFIED) — clear help state for next task
              setHelpLevel(0);
              setHelpCards([]);
              setHelpError(null);
            }
          }
        }
      }
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const adjustTextareaHeight = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 100)}px`;
  };

  // ── Phase 2B: Request help ─────────────────────────────────────────────────
  const requestHelp = async (revealAnswer = false) => {
    if (!lessonId || helpLoading || helpRequestInFlightRef.current || sendMessageMutation.isPending) return;
    if (showRevealConfirm && !revealAnswer) return;

    setHelpLoading(true);
    helpRequestInFlightRef.current = true;
    setHelpError(null);
    setShowRevealConfirm(false);

    try {
      const resp = await fetch(`/api/chat/help`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token ?? ""}`,
        },
        body: JSON.stringify({ lessonId, revealAnswer }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        if (data?.error === "NO_ACTIVE_TASK") {
          setHelpError(data.message ?? "No active task");
        } else if (data?.error === "REVEAL_REQUIRES_CONFIRMATION") {
          setShowRevealConfirm(true);
          setHelpLoading(false);
          return;
        } else {
          setHelpError(data?.message ?? "Help request failed");
        }
        setHelpLoading(false);
        return;
      }

      const newLevel: number = data.helpLevel ?? helpLevel + 1;
      setHelpLevel(newLevel);
      setHelpCards((prev) => [...prev, { level: newLevel, content: data.hintContent ?? "" }]);
    } catch {
      setHelpError("Help request failed — please try again");
    } finally {
      helpRequestInFlightRef.current = false;
      setHelpLoading(false);
    }
  };

  if (authLoading || historyLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!user) return null;

  const messages: typeof chatHistory = chatHistory || [];
  // Show help button if lesson is active and we haven't hit level 3 with reveal done
  // Show help button only when there is an active assessable task (MICRO_CHECK or EXERCISE).
  // NOT on explanations, feedback, or when no lesson is active.
  const showHelpButton = !!lessonId && hasActiveTask && helpLevel < 4;
  const helpButtonLabel = HELP_BUTTON_LABELS[helpLevel] ?? HELP_BUTTON_LABELS[3];

  return (
    <div className="flex flex-col h-[100dvh] bg-background text-white">
      {/* Header */}
      <header className="shrink-0 border-b border-card-border bg-card/80 backdrop-blur-lg sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-4">
          <Link href={lessonId ? `/lesson/${lessonId}` : `/dashboard`} className="p-2 -ml-2 text-muted-foreground hover:text-white rounded-full hover:bg-white/5 transition-colors">
            ←
          </Link>
          <div className="flex flex-col">
            <div className="font-bold flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-secondary animate-pulse" />
              AI Ուսուցիչ
            </div>
            {lessonId && (
              <div className="text-xs text-muted-foreground truncate max-w-[200px] sm:max-w-sm">
                Դաս #{lessonId}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Messages */}
      <main className="flex-1 overflow-y-auto p-4 space-y-6">
        <div className="max-w-4xl mx-auto space-y-6 flex flex-col">
          {messages.length === 0 ? (
            <div className="self-start max-w-[85%] sm:max-w-[75%] rounded-2xl p-4 bg-card border-l-4 border-secondary border-y border-r border-card-border shadow-lg">
              <div className="text-xs font-medium text-secondary mb-1">AI Ուսուցիչ</div>
              <div className="text-sm sm:text-base leading-relaxed whitespace-pre-wrap">
                Բարև, {user.fullName}! Ես AI ուսուցիչն եմ։ Ի՞նչ հարց ունես։
              </div>
            </div>
          ) : (
            messages.map((msg, idx) => {
              const isUser = msg.role === 'user';
              return (
                <div 
                  key={idx} 
                  className={`max-w-[85%] sm:max-w-[75%] rounded-2xl p-4 shadow-lg ${
                    isUser 
                      ? 'self-end bg-primary text-white rounded-br-sm' 
                      : 'self-start bg-card border-l-4 border-secondary border-y border-r border-card-border rounded-bl-sm'
                  }`}
                >
                  {!isUser && <div className="text-xs font-medium text-secondary mb-1">AI Ուսուցիչ</div>}
                  <div className="text-sm sm:text-base leading-relaxed whitespace-pre-wrap">
                    {msg.content}
                  </div>
                </div>
              );
            })
          )}

          {/* ── Help cards (Phase 2B) ─────────────────────────────────────── */}
          {helpCards.map((card, idx) => (
            <div
              key={`help-${idx}`}
              className="self-start max-w-[85%] sm:max-w-[75%] rounded-2xl p-4 shadow-lg bg-amber-950/40 border-l-4 border-amber-400 border-y border-r border-amber-700/40"
            >
              <div className="text-xs font-medium text-amber-400 mb-1">
                💡 Հուշ (Մ. {card.level})
              </div>
              <div className="text-sm sm:text-base leading-relaxed whitespace-pre-wrap text-amber-100">
                {card.content}
              </div>
            </div>
          ))}

          {sendMessageMutation.isPending && (
            <div className="self-start max-w-[85%] sm:max-w-[75%] rounded-2xl p-4 bg-card border-l-4 border-secondary border-y border-r border-card-border shadow-lg rounded-bl-sm flex items-center gap-2">
              <div className="text-xs font-medium text-secondary mr-2">AI Ուսուցիչ</div>
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce"></span>
              </div>
            </div>
          )}

          {helpLoading && (
            <div className="self-start max-w-[85%] sm:max-w-[75%] rounded-2xl p-4 bg-amber-950/40 border-l-4 border-amber-400 border-y border-r border-amber-700/40 flex items-center gap-2">
              <div className="text-xs font-medium text-amber-400 mr-2">💡 Հուշ</div>
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-bounce"></span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </main>

      {/* Input */}
      <footer className="shrink-0 p-4 border-t border-card-border bg-card/50 backdrop-blur-lg">
        <div className="max-w-4xl mx-auto space-y-2">
          {sendMessageMutation.isError && (
            <div className="text-destructive text-sm px-2">
              Սխալ տեղի ունեցավ։ Խնդրում ենք փորձել կրկին։
            </div>
          )}
          {helpError && (
            <div className="text-amber-400 text-sm px-2">{helpError}</div>
          )}

          {/* Phase 2B: reveal confirmation bar */}
          {showRevealConfirm && (
            <div className="flex items-center gap-2 px-2 py-2 bg-amber-950/40 border border-amber-700/40 rounded-xl text-sm text-amber-200">
              <span className="flex-1">Ցո՞ւյց տալ ճիշտ բացատրությունը։ Սա ոչ-անկախ ապացույց կլինի։</span>
              <button
                onClick={() => requestHelp(true)}
                className="shrink-0 px-3 py-1 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium transition-colors"
              >
                Այո, ցույց տուր
              </button>
              <button
                onClick={() => setShowRevealConfirm(false)}
                className="shrink-0 px-3 py-1 rounded-lg bg-card border border-card-border text-muted-foreground text-xs transition-colors"
              >
                Չեղարկել
              </button>
            </div>
          )}

          <div className="flex items-end gap-2 bg-background border border-card-border rounded-2xl p-2 focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/50 transition-all">
            {/* Phase 2B: progressive help button */}
            {showHelpButton && (
              <button
                onClick={() => requestHelp(false)}
                disabled={helpLoading || sendMessageMutation.isPending}
                title={`Հուշ ${helpLevel + 1}`}
                className="shrink-0 px-2 h-10 flex items-center justify-center rounded-xl text-amber-400 border border-amber-700/40 bg-amber-950/30 hover:bg-amber-900/40 disabled:opacity-40 disabled:cursor-not-allowed transition-all text-xs font-medium whitespace-nowrap"
              >
                {helpButtonLabel}
              </button>
            )}

            <textarea
              ref={textareaRef}
              value={message}
              onChange={adjustTextareaHeight}
              onKeyDown={handleKeyDown}
              placeholder="Հարց տվեք ուսուցչին..."
              className="flex-1 bg-transparent border-0 focus:ring-0 resize-none max-h-[100px] min-h-[40px] py-2 px-3 text-sm sm:text-base outline-none"
              rows={1}
            />
            <button
              onClick={handleSend}
              disabled={!message.trim() || sendMessageMutation.isPending}
              className="shrink-0 p-2 h-10 w-10 flex items-center justify-center rounded-xl bg-gradient-to-br from-primary to-secondary text-white disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
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
