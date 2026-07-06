import { useEffect, useState, useRef } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useAuth } from "@/lib/auth";
import { 
  useGetChatHistory, getGetChatHistoryQueryKey,
  useSendChatMessage
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

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

  useEffect(() => {
    if (!authLoading && !token) {
      setLocation("/login");
    }
  }, [token, authLoading, setLocation]);

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
  }, [chatHistory, sendMessageMutation.isPending]);

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
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetChatHistoryQueryKey(historyParams) });
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

  if (authLoading || historyLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!user) return null;

  const messages: typeof chatHistory = chatHistory || [];

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
          <div ref={messagesEndRef} />
        </div>
      </main>

      {/* Input */}
      <footer className="shrink-0 p-4 border-t border-card-border bg-card/50 backdrop-blur-lg">
        <div className="max-w-4xl mx-auto">
          {sendMessageMutation.isError && (
            <div className="text-destructive text-sm mb-2 px-2">
              Սխալ տեղի ունեցավ։ Խնդրում ենք փորձել կրկին։
            </div>
          )}
          <div className="flex items-end gap-2 bg-background border border-card-border rounded-2xl p-2 focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/50 transition-all">
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
