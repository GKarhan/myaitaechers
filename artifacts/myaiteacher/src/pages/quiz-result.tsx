import { useState, useEffect } from "react";
import { Link, useParams } from "wouter";
import { useAuth } from "@/lib/auth";

type QuestionResult = {
  questionId: number;
  questionText: string;
  options: string[];
  correctOptionIndex: number;
  selectedOptionIndex: number;
  isCorrect: boolean;
  sequence: number;
};

type MyResult = {
  totalCorrect: number;
  totalQuestions: number;
  scorePercent: number;
  questions: QuestionResult[];
};

export default function QuizResult() {
  const { id } = useParams<{ id: string }>();
  const { token, user } = useAuth();

  // Parse query params — studentId triggers teacher view; classId+subjectId for back nav
  const { studentId, classId: backClassId, subjectId: backSubjectId } = (() => {
    const qs = typeof window !== "undefined" ? window.location.search : "";
    const sid  = qs.match(/[?&]studentId=(\d+)/);
    const cid  = qs.match(/[?&]classId=(\d+)/);
    const spid = qs.match(/[?&]subjectId=(\d+)/);
    return {
      studentId:  sid  ? parseInt(sid[1],  10) : null,
      classId:    cid  ? cid[1]  : null,
      subjectId:  spid ? spid[1] : null,
    };
  })();

  const isTeacherView = studentId !== null && user?.role === "TEACHER";

  const backHref = isTeacherView
    ? (backClassId && backSubjectId ? `/teacher?classId=${backClassId}&subjectId=${backSubjectId}` : "/teacher")
    : "/dashboard";
  const backLabel = "\u2190 \u0540\u0565\u057f";  // ← Հet

  const [result, setResult] = useState<MyResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!token || !id) return;
    // Wait for user profile to fully load (auth.tsx maps loading-state undefined → null,
    // so guard against both null and undefined to avoid fetching with wrong isTeacherView)
    if (!user) return;
    setLoading(true);
    setResult(null);
    setError(null);

    const url = isTeacherView
      ? `/api/quizzes/${id}/results/${studentId}`
      : `/api/quizzes/${id}/my-result`;

    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (!r.ok) throw new Error("result_not_found");
        return r.json();
      })
      .then((data: MyResult) => setResult(data))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token, id, studentId, user?.role]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !result) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="text-5xl">📋</div>
        <p className="text-muted-foreground text-sm">Ավարտված արդյունքներ չկա</p>
        <Link href={backHref} className="text-primary hover:underline text-sm">{backLabel}</Link>
      </div>
    );
  }

  const scoreColor =
    result.scorePercent >= 80
      ? "text-teal-400"
      : result.scorePercent >= 50
      ? "text-amber-400"
      : "text-red-400";

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b border-white/10 bg-background/90 backdrop-blur-sm px-4 py-3 flex items-center gap-4">
        <Link
          href={backHref}
          className="text-sm text-muted-foreground hover:text-white transition-colors"
        >
          {backLabel}
        </Link>
        <div className="flex-1 min-w-0 text-center">
          <h1 className="text-sm font-semibold truncate">Արդյունքներ</h1>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-8 space-y-8">
        {/* Score summary */}
        <div className="rounded-2xl border border-white/10 bg-card/60 p-8 text-center">
          <div className={`text-5xl font-black mb-2 ${scoreColor}`}>
            {result.scorePercent}%
          </div>
          <div className="text-lg font-semibold mb-1">
            {result.totalCorrect}/{result.totalQuestions} ճիշտ
          </div>
          <div
            className={`inline-block mt-3 text-xs px-3 py-1 rounded-full border ${
              result.scorePercent >= 80
                ? "border-teal-400/30 bg-teal-400/10 text-teal-400"
                : result.scorePercent >= 50
                ? "border-amber-400/30 bg-amber-400/10 text-amber-400"
                : "border-red-400/30 bg-red-400/10 text-red-400"
            }`}
          >
            {result.scorePercent >= 80 ? "✅ " : result.scorePercent >= 50 ? "🟡 " : "❌ "}
            {result.scorePercent}%
          </div>
        </div>

        {/* Per-question breakdown */}
        <div className="space-y-4">
          {result.questions.map((q) => (
            <div
              key={q.questionId}
              className={`rounded-2xl border p-5 ${
                q.isCorrect
                  ? "border-teal-400/20 bg-teal-400/5"
                  : "border-red-400/20 bg-red-400/5"
              }`}
            >
              <div className="flex items-start gap-3 mb-4">
                <span className="shrink-0 text-sm">{q.isCorrect ? "✅" : "❌"}</span>
                <p className="text-sm font-medium leading-snug">{q.questionText}</p>
              </div>
              <div className="space-y-2 pl-7">
                {q.options.map((opt, i) => {
                  const isSelected = i === q.selectedOptionIndex;
                  const isCorrect  = i === q.correctOptionIndex;
                  return (
                    <div
                      key={i}
                      className={`text-sm px-3 py-2 rounded-xl border transition-colors ${
                        isSelected && isCorrect
                          ? "border-teal-400/40 bg-teal-400/15 text-teal-300 font-medium"
                          : isSelected && !isCorrect
                          ? "border-red-400/40 bg-red-400/15 text-red-300 font-medium"
                          : isCorrect && !isSelected
                          ? "border-teal-400/30 bg-teal-400/8 text-teal-400/80"
                          : "border-white/8 text-muted-foreground"
                      }`}
                    >
                      <span className="mr-2 opacity-60">{String.fromCharCode(65 + i)}.</span>
                      {opt}
                      {isCorrect && !isSelected && (
                        <span className="ml-2 text-teal-400 font-bold">✓</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
