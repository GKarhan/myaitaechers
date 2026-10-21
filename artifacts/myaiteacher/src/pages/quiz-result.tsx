import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { useAuth } from "@/lib/auth";
import { formatAnswer, STUDENT_RESULTS_FINISH_PATH } from "@/lib/quiz-result-t2";

type QuestionResult = {
  questionId: number;
  questionText: string;
  options: string[];
  correctOptionIndex: number;
  selectedOptionIndex: number;
  isCorrect: boolean;
  sequence: number;
  nodeId: number | null;
  nodeTitle: string | null;
  feedback: {
    whyCorrect: string | null;
    whyWrong: string | null;
    solutionExplanation?: string | null;
  };
};

type AttemptHistory = {
  attemptId: number;
  attemptSequence: number;
  totalCorrect: number;
  totalQuestions: number;
  scorePercent: number | null;
  completedAt: string | null;
};

type SessionProjection = {
  id: number;
  status: string;
  masteredNodeIds: number[];
  learningNodeIds: number[];
  knowsCount: number;
  learningCount: number;
};

type Result = {
  attemptId?: number;
  totalCorrect: number;
  totalQuestions: number;
  scorePercent: number;
  questions: QuestionResult[];
  nodeBreakdown?: Array<{ nodeId: number; nodeTitle: string; percent: number; masteryLevel: string }>;
  recommendations?: Array<{ nodeId: number; nodeTitle: string; prerequisiteBlocked: boolean }>;
  session?: SessionProjection | null;
  attempts?: AttemptHistory[];
};

const BASE = "https://myaitaechers-api.onrender.com";

export default function QuizResult() {
  const { id } = useParams<{ id: string }>();
  const search = useSearch();
  const { token, user } = useAuth();
  const [, setLocation] = useLocation();
  const params = new URLSearchParams(search);
  const studentId = params.get("studentId");
  const historyAttemptId = params.get("attemptId");
  const isTeacherView = !!studentId && user?.role === "teacher";
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showKnowsOnly, setShowKnowsOnly] = useState(false);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    if (!token || !id || !user) return;
    const controller = new AbortController();
    const historyQuery = !isTeacherView && historyAttemptId ? `?attemptId=${historyAttemptId}` : "";
    const url = isTeacherView
      ? `${BASE}/api/quizzes/${id}/results/${studentId}`
      : `${BASE}/api/quizzes/${id}/my-result${historyQuery}`;
    setLoading(true);
    fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Արդյունքը չի գտնվել");
        return payload as Result;
      })
      .then(setResult)
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") setError(reason.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [id, token, user, studentId, historyAttemptId, isTeacherView]);

  const visibleQuestions = useMemo(() => {
    if (!result) return [];
    if (!showKnowsOnly || !result.session) return result.questions;
    const mastered = new Set(result.session.masteredNodeIds);
    return result.questions.filter((question) => question.nodeId != null && mastered.has(question.nodeId));
  }, [result, showKnowsOnly]);

  async function finishSession() {
    if (!token || !id || finishing) return;
    setFinishing(true);
    try {
      const response = await fetch(`${BASE}/api/quizzes/${id}/session/finish`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("finish_failed");
      setLocation(STUDENT_RESULTS_FINISH_PATH);
    } finally {
      setFinishing(false);
    }
  }

  if (loading) return <div className="min-h-screen grid place-items-center bg-background"><div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  if (error || !result) {
    return <div className="min-h-screen grid place-items-center bg-background text-white"><div className="text-center space-y-4"><p>{error ?? "Արդյունքը չի գտնվել"}</p><Link href={STUDENT_RESULTS_FINISH_PATH} className="text-primary">← Հետ</Link></div></div>;
  }

  const backHref = isTeacherView ? "/teacher?section=quizzes" : STUDENT_RESULTS_FINISH_PATH;
  const scoreColor = result.scorePercent >= 80 ? "text-teal-400" : result.scorePercent >= 50 ? "text-amber-400" : "text-red-400";

  return (
    <div className="min-h-screen bg-background text-white">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-background/90 backdrop-blur px-4 py-3">
        <div className="max-w-2xl mx-auto flex items-center">
          <Link href={backHref} className="text-sm text-muted-foreground hover:text-white">← Հետ</Link>
          <h1 className="flex-1 text-center text-sm font-semibold">Արդյունքներ</h1>
          <span className="w-10" />
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-8">
        <section className="rounded-3xl border border-white/10 bg-card/60 p-8 text-center">
          <div className={`text-5xl font-black ${scoreColor}`}>{result.scorePercent}%</div>
          <p className="mt-2 text-white/80">{result.totalCorrect}/{result.totalQuestions} ճիշտ պատասխան</p>
        </section>

        {!isTeacherView && result.session && (
          <section className="rounded-3xl border border-primary/20 bg-card/60 p-6 space-y-5">
            <div>
              <h2 className="font-bold">Իմ ընթացիկ պատկերը</h2>
              <p className="text-sm text-muted-foreground mt-1">Այս պատկերը հաշվարկվում է ձեր բոլոր գրանցված փորձերից։</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-teal-400/25 bg-teal-400/10 p-4">
                <p className="text-sm text-teal-300">Գիտի</p>
                <p className="text-2xl font-black mt-1">{result.session.knowsCount}</p>
              </div>
              <div className="rounded-2xl border border-amber-400/25 bg-amber-400/10 p-4">
                <p className="text-sm text-amber-300">Սովորելու</p>
                <p className="text-2xl font-black mt-1">{result.session.learningCount}</p>
              </div>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              {result.session.knowsCount > 0 && (
                <button onClick={() => setShowKnowsOnly((value) => !value)} className="rounded-xl border border-teal-400/30 px-4 py-3 text-sm font-semibold text-teal-300">
                  {showKnowsOnly ? "Ցույց տալ բոլոր հարցերը" : "Դիտել «Գիտի»-ի հարցերը"}
                </button>
              )}
              {result.session.learningCount > 0 && result.session.status === "ACTIVE" && (
                <Link href={`/quiz/${id}/take`} className="rounded-xl bg-gradient-to-r from-primary to-secondary px-4 py-3 text-center text-sm font-bold">
                  Շարունակել սովորել
                </Link>
              )}
            </div>
            <button disabled={finishing} onClick={finishSession} className="w-full rounded-xl border border-white/10 px-4 py-3 text-sm text-muted-foreground hover:text-white disabled:opacity-50">
              {finishing ? "Ավարտվում է..." : "Ավարտել"}
            </button>
          </section>
        )}

        {!isTeacherView && (result.attempts?.length ?? 0) > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/75">Փորձերի պատմություն</h2>
            <div className="grid gap-2">
              {result.attempts!.map((attempt) => (
                <Link
                  key={attempt.attemptId}
                  href={`/quiz/${id}/result?attemptId=${attempt.attemptId}`}
                  className={`rounded-xl border px-4 py-3 flex items-center justify-between ${attempt.attemptId === result.attemptId ? "border-primary/50 bg-primary/10" : "border-white/10 bg-card/30"}`}
                >
                  <span className="text-sm font-medium">Փորձ {attempt.attemptSequence}</span>
                  <span className="text-sm text-muted-foreground">{attempt.totalCorrect}/{attempt.totalQuestions} · {attempt.scorePercent ?? 0}%</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {isTeacherView && result.nodeBreakdown && result.nodeBreakdown.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/75">Գիտելիքի հանգույցներ</h2>
            {result.nodeBreakdown.map((node) => <div key={node.nodeId} className="rounded-xl border border-white/10 bg-card/30 px-4 py-3 flex justify-between"><span>{node.nodeTitle}</span><span>{node.percent}%</span></div>)}
          </section>
        )}

        <section className="space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/75">Պատասխանների դիտում</h2>
          {visibleQuestions.length === 0 && <p className="text-sm text-muted-foreground">Այս դիտման համար հարց չկա։</p>}
          {visibleQuestions.map((question, index) => (
            <article key={question.questionId} className={`rounded-2xl border p-5 ${question.isCorrect ? "border-teal-400/20 bg-teal-400/5" : "border-red-400/20 bg-red-400/5"}`}>
              <p className="text-sm font-semibold leading-relaxed">{index + 1}. {question.questionText}</p>
              {question.nodeTitle && <p className="text-xs text-muted-foreground mt-1">{question.nodeTitle}</p>}
              <div className="mt-4 grid gap-2">
                <p className="text-sm">Ձեր պատասխանը՝ <span className={question.isCorrect ? "text-teal-300" : "text-red-300"}>{formatAnswer(question.options, question.selectedOptionIndex)}</span></p>
                {!question.isCorrect && <p className="text-sm">Ճիշտ պատասխանը՝ <span className="text-teal-300">{formatAnswer(question.options, question.correctOptionIndex)}</span></p>}
                {question.feedback.whyWrong && <p className="text-sm text-white/70">{question.feedback.whyWrong}</p>}
                {question.feedback.whyCorrect && <p className="text-sm text-white/70">{question.feedback.whyCorrect}</p>}
                {question.feedback.solutionExplanation && <div className="mt-2 rounded-xl border border-primary/20 bg-primary/5 p-3"><p className="text-xs font-semibold text-primary">Կարճ լուծում</p><p className="text-sm text-white/70 mt-1 whitespace-pre-wrap">{question.feedback.solutionExplanation}</p></div>}
              </div>
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}