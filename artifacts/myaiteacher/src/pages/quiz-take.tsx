import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { invalidateKnowledgeTreeQueries } from "@/lib/knowledge-tree-cache";

type TakeQuestion = {
  id: number;
  questionText: string;
  options: string[];
  difficultyLevel: string;
  interactionType: string | null;
  sequence: number;
};

type TakeData = {
  assignmentId: number;
  sessionId: number;
  attemptId: number;
  attemptSequence: number;
  questions: TakeQuestion[];
  finalizedAnswers: Array<Feedback & {
    questionId: number;
    selectedOptionIndex: number;
  }>;
};

type Feedback = {
  isCorrect: boolean;
  selectedOptionIndex: number;
  correctOptionIndex: number;
  selectedAnswer: string | null;
  correctAnswer: string | null;
  feedback: {
    whyCorrect: string | null;
    whyWrong: string | null;
    solutionExplanation: string | null;
  };
};

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const OPTION_LABELS = ["Ա", "Բ", "Գ", "Դ", "Ե", "Զ"];

export default function QuizTake() {
  const { id } = useParams<{ id: string }>();
  const { token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const quizId = Number(id);
  const [data, setData] = useState<TakeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [feedback, setFeedback] = useState<Record<number, Feedback>>({});
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !token) setLocation("/login");
  }, [authLoading, token, setLocation]);

  useEffect(() => {
    if (!token || !Number.isInteger(quizId)) return;
    const controller = new AbortController();
    setLoading(true);
    fetch(`${BASE}/api/quizzes/${quizId}/take`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) {
          if (payload.error === "SESSION_HAS_NO_LEARNING_SCOPE") {
            setLocation(`/quiz/${quizId}/result`);
            return null;
          }
          throw new Error(payload.error ?? "Թեստը չի հաջողվել բացել");
        }
        return payload as TakeData;
      })
      .then((payload) => {
        if (!payload) return;
        setData(payload);
        setAnswers(Object.fromEntries(
          (payload.finalizedAnswers ?? []).map((answer) => [
            answer.questionId,
            answer.selectedOptionIndex,
          ]),
        ));
        setFeedback(Object.fromEntries(
          (payload.finalizedAnswers ?? []).map((answer) => [
            answer.questionId,
            answer,
          ]),
        ));
      })
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") setError(reason.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [quizId, token, setLocation]);

  const question = data?.questions[currentIndex] ?? null;
  const currentFeedback = question ? feedback[question.id] : null;
  const progress = data ? Math.round(((currentIndex + (currentFeedback ? 1 : 0)) / data.questions.length) * 100) : 0;
  const allCommitted = useMemo(
    () => !!data && data.questions.every((item) => feedback[item.id] != null),
    [data, feedback],
  );
  const primaryExplanation = currentFeedback
    ? currentFeedback.isCorrect
      ? currentFeedback.feedback.whyCorrect
        ?? currentFeedback.feedback.solutionExplanation
      : currentFeedback.feedback.whyWrong
        ?? currentFeedback.feedback.solutionExplanation
        ?? currentFeedback.feedback.whyCorrect
    : null;

  async function commitAnswer(optionIndex: number) {
    if (!token || !data || !question || currentFeedback || checking) return;
    setChecking(true);
    setSubmitError(null);
    try {
      const response = await fetch(
        `${BASE}/api/quizzes/${quizId}/attempts/${data.attemptId}/feedback`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            questionId: question.id,
            selectedOptionIndex: optionIndex,
          }),
        },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Պատասխանը չհաջողվեց ստուգել");
      const finalized = payload as Feedback;
      setAnswers((current) => ({
        ...current,
        [question.id]: finalized.selectedOptionIndex,
      }));
      setFeedback((current) => ({ ...current, [question.id]: finalized }));
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : "Պատասխանը չհաջողվեց ստուգել");
    } finally {
      setChecking(false);
    }
  }

  async function submitAttempt() {
    if (!token || !data || !allCommitted || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await fetch(`${BASE}/api/quizzes/${quizId}/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          attemptId: data.attemptId,
          answers: data.questions.map((item) => ({
            questionId: item.id,
            selectedOptionIndex: answers[item.id],
          })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? payload.error ?? "Փորձը չհաջողվեց գրանցել");
      await invalidateKnowledgeTreeQueries(queryClient);
      setLocation(`/quiz/${quizId}/result`);
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : "Փորձը չհաջողվեց գրանցել");
    } finally {
      setSubmitting(false);
    }
  }

  if (authLoading || loading) {
    return <div className="min-h-[100dvh] grid place-items-center bg-background"><div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  }
  if (error || !data || !question) {
    return (
      <div className="min-h-[100dvh] grid place-items-center bg-background text-white px-6">
        <div className="max-w-md text-center space-y-4">
          <p className="text-muted-foreground">{error ?? "Այս պահին սովորելու հարց չկա։"}</p>
          <Link href={`/quiz/${quizId}/result`} className="inline-flex px-5 py-2.5 rounded-xl bg-primary text-white font-semibold">
            Արդյունքներ
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background text-white pb-28">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-card/90 backdrop-blur">
        <div className="max-w-2xl mx-auto px-5 py-4 flex items-center justify-between gap-4">
          <button onClick={() => history.back()} className="text-sm text-muted-foreground hover:text-white">← Պահել և դուրս գալ</button>
          <span className="text-xs text-muted-foreground">Փորձ {data.attemptSequence} · {currentIndex + 1}/{data.questions.length}</span>
        </div>
        <div className="h-1 bg-white/5"><div className="h-full bg-gradient-to-r from-primary to-secondary transition-all" style={{ width: `${progress}%` }} /></div>
      </header>

      <main className="max-w-2xl mx-auto px-5 py-8">
        <section className="rounded-3xl border border-white/10 bg-card/60 p-6">
          <p className="text-xs text-primary mb-3">Հարց {currentIndex + 1}</p>
          <h1 className="text-lg font-semibold leading-relaxed">{question.questionText}</h1>
          <div className="mt-6 space-y-3">
            {question.options.map((option, optionIndex) => {
              const selected = answers[question.id] === optionIndex;
              const correct = currentFeedback?.correctOptionIndex === optionIndex;
              const cls = currentFeedback
                ? correct
                  ? "border-teal-400/60 bg-teal-400/15"
                  : selected
                    ? "border-red-400/60 bg-red-400/15"
                    : "border-white/10 opacity-60"
                : "border-white/10 hover:border-primary/50 hover:bg-primary/10";
              return (
                <button
                  key={optionIndex}
                  disabled={!!currentFeedback || checking}
                  onClick={() => commitAnswer(optionIndex)}
                  className={`w-full text-left rounded-2xl border px-4 py-3.5 transition-all ${cls}`}
                >
                  <span className="font-mono text-xs text-primary mr-3">{OPTION_LABELS[optionIndex] ?? optionIndex + 1}.</span>
                  {option}
                </button>
              );
            })}
          </div>

          {currentFeedback && (
            <div className={`mt-6 rounded-2xl border p-4 ${currentFeedback.isCorrect ? "border-teal-400/30 bg-teal-400/10" : "border-amber-400/30 bg-amber-400/10"}`}>
              <p className="font-semibold">
                {currentFeedback.isCorrect ? "✅ Ճիշտ է" : "❌ Սխալ է"}
              </p>
              <div className="mt-3 space-y-2 text-sm text-white/80">
                <p>
                  <span className="font-semibold text-white">Քո պատասխանը՝</span>{" "}
                  {currentFeedback.selectedAnswer ?? "Պատասխանը հասանելի չէ"}
                </p>
                <p>
                  <span className="font-semibold text-white">Ճիշտ պատասխանը՝</span>{" "}
                  {currentFeedback.correctAnswer ?? "Պատասխանը հասանելի չէ"}
                </p>
                <p>
                  <span className="font-semibold text-white">Բացատրություն՝</span>{" "}
                  {primaryExplanation ?? "Այս հարցի համար բացատրություն պահպանված չէ։"}
                </p>
                {!currentFeedback.isCorrect
                  && currentFeedback.feedback.whyCorrect
                  && currentFeedback.feedback.whyCorrect !== primaryExplanation && (
                    <p className="text-teal-200">
                      {currentFeedback.feedback.whyCorrect}
                    </p>
                  )}
              </div>
            </div>
          )}
        </section>
      </main>

      <div className="fixed bottom-0 inset-x-0 border-t border-white/10 bg-card/90 backdrop-blur px-5 py-4">
        <div className="max-w-2xl mx-auto">
          {submitError && <p className="text-sm text-red-400 text-center mb-2">{submitError}</p>}
          {currentFeedback && currentIndex < data.questions.length - 1 && (
            <button onClick={() => setCurrentIndex((index) => index + 1)} className="w-full py-3.5 rounded-2xl bg-primary text-white font-bold">
              Հաջորդ հարցը
            </button>
          )}
          {currentFeedback && currentIndex === data.questions.length - 1 && (
            <button disabled={submitting} onClick={submitAttempt} className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-primary to-secondary text-white font-bold disabled:opacity-50">
              {submitting ? "Գրանցվում է..." : "Ավարտել փորձը"}
            </button>
          )}
          {!currentFeedback && <p className="text-center text-xs text-muted-foreground">Ընտրեք պատասխանը՝ անմիջապես ստուգելու համար</p>}
        </div>
      </div>
    </div>
  );
}