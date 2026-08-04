import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";

interface TakeQuestion {
  id: number;
  questionText: string;
  options: string[];
  difficultyLevel: string;
  sequence: number;
}

interface QuizTakeData {
  assignmentId: number;
  assignmentStatus: string;
  questions: TakeQuestion[];
}

interface SubmitResult {
  totalCorrect: number;
  totalQuestions: number;
  scorePercent: number;
}

const DIFFICULTY_LABEL: Record<string, string> = {
  LOW:    "Հեշտ",
  MEDIUM: "Միջին",
  HIGH:   "Բարդ",
};

const OPTS = ["Ա", "Բ", "Գ", "Դ"];

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

export default function QuizTake() {
  const { id } = useParams<{ id: string }>();
  const { token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const quizId = parseInt(id || "", 10);

  const [data,    setData]    = useState<QuizTakeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  // answers: questionId → selectedOptionIndex
  const [answers, setAnswers] = useState<Record<number, number>>({}); 
  const [submitting, setSubmitting] = useState(false);
  const [result,     setResult]     = useState<SubmitResult | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !token) setLocation("/login");
  }, [token, authLoading, setLocation]);

  useEffect(() => {
    if (!token || isNaN(quizId)) return;
    setLoading(true);
    fetch(`${BASE}/api/quizzes/${quizId}/take`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setData(d);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token, quizId]);

  async function handleSubmit() {
    if (!token || !data) return;
    const unanswered = data.questions.filter((q) => answers[q.id] === undefined);
    if (unanswered.length > 0) {
      setSubmitError(`${unanswered.length} հartsʼ ditek chi`);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const resp = await fetch(`${BASE}/api/quizzes/${quizId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          answers: data.questions.map((q) => ({
            questionId:          q.id,
            selectedOptionIndex: answers[q.id] ?? 0,
          })),
        }),
      });
      const res = await resp.json();
      if (!resp.ok) throw new Error(res.error ?? "Ձakholvec");
      setResult(res);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Ձakholvec");
    } finally {
      setSubmitting(false);
    }
  }

  if (authLoading || loading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background text-white">
        <div className="text-center">
          <div className="text-4xl mb-3">⚠️</div>
          <p className="text-muted-foreground">{error ?? "Թեստը չի գտնվել"}</p>
          <button
            onClick={() => history.back()}
            className="mt-4 px-4 py-2 rounded-xl border border-white/10 text-sm hover:bg-white/5"
          >
            ← Հետ
          </button>
        </div>
      </div>
    );
  }

  /* ── Result screen ── */
  if (result) {
    const pct = result.scorePercent;
    const color = pct >= 80 ? "text-teal-400" : pct >= 50 ? "text-amber-400" : "text-red-400";
    const emoji = pct >= 80 ? "🎉" : pct >= 50 ? "👍" : "📚";
    return (
      <div className="min-h-[100dvh] bg-background text-white flex flex-col items-center justify-center px-6 py-16 text-center">
        <div className="text-7xl mb-6">{emoji}</div>
        <div className={`text-6xl font-extrabold mb-2 ${color}`}>{pct}%</div>
        <div className="text-muted-foreground text-lg mb-8">
          {result.totalCorrect} / {result.totalQuestions}
        </div>
        <button
          onClick={() => setLocation(`/quiz/${id}/result`)}
          className="px-8 py-3.5 rounded-2xl bg-gradient-to-r from-primary to-secondary text-white font-bold hover:opacity-90 transition-opacity"
        >
          Դիտել մանրամասները
        </button>
      </div>
    );
  }

  const answered  = Object.keys(answers).length;
  const total     = data.questions.length;
  const allAnswered = answered === total;

  return (
    <div className="min-h-[100dvh] bg-background text-white pb-32">
      {/* Header */}
      <header className="border-b border-white/10 bg-card/50 backdrop-blur-lg sticky top-0 z-30">
        <div className="max-w-2xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <button
            onClick={() => history.back()}
            className="text-muted-foreground hover:text-white transition-colors"
          >
            ← Հետ
          </button>
          <div className="text-sm text-muted-foreground">
            {answered} / {total}
          </div>
        </div>
        {/* Progress bar */}
        <div className="h-1 bg-white/5">
          <div
            className="h-full bg-gradient-to-r from-primary to-secondary transition-all duration-300"
            style={{ width: `${total > 0 ? Math.round((answered / total) * 100) : 0}%` }}
          />
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 pt-8 space-y-6">
        {data.questions.map((q, idx) => (
          <div
            key={q.id}
            className={`bg-card/60 border rounded-2xl p-5 transition-colors ${
              answers[q.id] !== undefined
                ? "border-primary/30"
                : "border-white/10"
            }`}
          >
            {/* Question header */}
            <div className="flex items-start gap-3 mb-4">
              <span className="text-xs font-mono text-primary/60 w-6 shrink-0 mt-0.5">
                {idx + 1}.
              </span>
              <div className="flex-1">
                <p className="text-sm font-medium text-white leading-relaxed">{q.questionText}</p>
                <span className={`inline-block mt-1.5 text-xs px-1.5 py-0.5 rounded border ${
                  q.difficultyLevel === "HIGH"
                    ? "text-red-400 border-red-400/30 bg-red-400/10"
                    : q.difficultyLevel === "MEDIUM"
                    ? "text-amber-400 border-amber-400/30 bg-amber-400/10"
                    : "text-teal-400 border-teal-400/30 bg-teal-400/10"
                }`}>
                  {DIFFICULTY_LABEL[q.difficultyLevel] ?? q.difficultyLevel}
                </span>
              </div>
            </div>

            {/* Options */}
            <div className="ml-9 space-y-2">
              {q.options.map((opt, i) => (
                <button
                  key={i}
                  onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: i }))}
                  className={`w-full text-left text-sm px-3 py-2.5 rounded-xl border transition-all ${
                    answers[q.id] === i
                      ? "border-primary/60 bg-primary/15 text-white"
                      : "border-white/10 bg-background/30 text-muted-foreground hover:border-white/25 hover:text-white"
                  }`}
                >
                  <span className="font-mono text-xs opacity-60 mr-2">{OPTS[i]}.</span>
                  {opt}
                </button>
              ))}
            </div>
          </div>
        ))}
      </main>

      {/* Sticky submit bar */}
      <div className="fixed bottom-0 inset-x-0 bg-card/80 backdrop-blur-lg border-t border-white/10 px-6 py-4">
        <div className="max-w-2xl mx-auto space-y-2">
          {submitError && (
            <p className="text-sm text-red-400 text-center">{submitError}</p>
          )}
          <button
            onClick={handleSubmit}
            disabled={submitting || !allAnswered}
            className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-primary to-secondary text-white font-bold text-base hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-40 shadow-xl shadow-primary/25"
          >
            {submitting ? "Ուղարկվում է..." : "📤 Ուղարկել"}
          </button>
        </div>
      </div>
    </div>
  );
}
