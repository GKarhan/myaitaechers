import { useState, useEffect } from "react";
import { Link, useParams } from "wouter";
import { useAuth } from "@/lib/auth";

// ── Types ─────────────────────────────────────────────────────────────────────

type PersonalizedAction = "REVIEW" | "LEARN_TARGETED" | "Լիարժեք սովորել" | "STUDY_FIRST";
type MasteryLevel = "mastered" | "weak" | "in_progress" | "not_started";

interface PersonalizedNextAction {
  state: "mastered" | "partial" | "in_progress" | "not_started";
  action: PersonalizedAction;
  masteryScore: number | null;
  intensity?: "light" | "deep";
}

interface QuestionFeedback {
  whyCorrect: string | null;  // Priority 2: childFriendlyExplanation; Priority 1 pending schema
  whyWrong:   string | null;  // Priority 3: commonMisconception; only shown when isCorrect=false
}

interface QuestionResult {
  questionId: number;
  questionText: string;
  options: string[];
  correctOptionIndex: number;
  selectedOptionIndex: number;
  isCorrect: boolean;
  sequence: number;
  nodeId: number | null;
  nodeTitle: string | null;
  feedback: QuestionFeedback;
  errorState: "correct" | "wrong";
}

interface NodeBreakdown {
  nodeId: number;
  nodeTitle: string;
  total: number;
  correct: number;
  incorrect: number;
  percent: number;
  masteryLevel: MasteryLevel;
  masteryScore: number | null;
  confidenceScore: number | null;
  nextAction: PersonalizedNextAction;
}

interface Recommendation {
  priority: number;
  nodeId: number;
  nodeTitle: string;
  masteryLevel: MasteryLevel;
  masteryScore: number | null;
  nextAction: PersonalizedNextAction;
}

interface MyResult {
  totalCorrect: number;
  totalQuestions: number;
  scorePercent: number;
  questions: QuestionResult[];
  nodeBreakdown?: NodeBreakdown[];
  recommendations?: Recommendation[];
}

// ── Display helpers ───────────────────────────────────────────────────────────

const MASTERY_LABEL: Record<MasteryLevel, string> = {
  mastered:    "Գիտի",
  weak:        "Մասնակի գիտի",
  in_progress: "Չգիտի",
  not_started: "Դեռ չի ուսումնասիրել",
};

const ACTION_LABEL: Record<PersonalizedAction, string> = {
  REVIEW:         "Կրկնել",
  LEARN_TARGETED: "Թիրախային ուսուցում",
  LEARN_FULL:     "Ամբողջական ուսուցում",
  STUDY_FIRST:    "Սկսել ուսումնասիրել",
};

const MASTERY_BADGE: Record<MasteryLevel, string> = {
  mastered:    "border-teal-400/40 bg-teal-400/10 text-teal-400",
  weak:        "border-amber-400/40 bg-amber-400/10 text-amber-400",
  in_progress: "border-red-400/40 bg-red-400/10 text-red-400",
  not_started: "border-white/20 bg-white/5 text-muted-foreground",
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function QuizResult() {
  const { id } = useParams<{ id: string }>();
  const { token, user } = useAuth();

  // Parse query params
  const { studentId, classId: backClassId, subjectId: backSubjectId, backFrom } = (() => {
    const qs = typeof window !== "undefined" ? window.location.search : "";
    const sid  = qs.match(/[?&]studentId=(\d+)/);
    const cid  = qs.match(/[?&]classId=(\d+)/);
    const spid = qs.match(/[?&]subjectId=(\d+)/);
    const frm  = qs.match(/[?&]from=([a-zA-Z]+)/);
    return {
      studentId:  sid  ? parseInt(sid[1],  10) : null,
      classId:    cid  ? cid[1]  : null,
      subjectId:  spid ? spid[1] : null,
      backFrom:   frm  ? frm[1]  : null,
    };
  })();

  const isTeacherView = studentId !== null && user?.role === "teacher";

  const backHref = isTeacherView
    ? (backFrom === "allQuizzes"
        ? "/teacher?section=quizzes"
        : (backClassId && backSubjectId ? `/teacher?classId=${backClassId}&subjectId=${backSubjectId}` : "/teacher"))
    : "/dashboard";
  const backLabel = "\u2190 \u0540\u0565\u057f"; // ← Հet

  const [result, setResult] = useState<MyResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!token || !id || !user) return;
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
        <p className="text-muted-foreground text-sm">Ավարտված արդյունքներ չկան</p>
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

  const hasNodeData =
    result.nodeBreakdown && result.nodeBreakdown.length > 0;
  const hasRecommendations =
    result.recommendations && result.recommendations.length > 0;

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

        {/* ── Score summary ── */}
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

        {/* ── Personalized recommendations ── */}
        {hasRecommendations && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-white/80 uppercase tracking-wide">
              Աշակերտի առաջարկություններ
            </h2>
            <div className="space-y-2">
              {result.recommendations!.map((rec, i) => (
                <div
                  key={rec.nodeId}
                  className="flex items-start gap-3 px-4 py-3 rounded-xl border border-white/8 bg-card/30"
                >
                  <span className="text-xs font-mono text-primary/50 w-4 shrink-0 mt-0.5">
                    {i + 1}.
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{rec.nodeTitle}</div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full border ${MASTERY_BADGE[rec.masteryLevel]}`}
                      >
                        {MASTERY_LABEL[rec.masteryLevel]}
                      </span>
                      <span className="text-xs text-muted-foreground/70">
                        → {ACTION_LABEL[rec.nextAction.action]}
                        {rec.nextAction.intensity === "light"
                          ? " (թիրախային)"
                          : rec.nextAction.intensity === "deep"
                          ? " (խորածվատ)"
                          : ""}
                      </span>
                    </div>
                  </div>
                  {rec.masteryScore != null && (
                    <span className="text-xs font-semibold text-muted-foreground shrink-0">
                      {rec.masteryScore}%
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Node / topic breakdown ── */}
        {hasNodeData && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-white/80 uppercase tracking-wide">
              Թեմաների ամփոփում
            </h2>
            <div className="space-y-2">
              {result.nodeBreakdown!.map((node) => (
                <div
                  key={node.nodeId}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl border border-white/8 bg-card/30"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{node.nodeTitle}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {node.correct}/{node.total} ճիշտ · {node.percent}%
                    </div>
                  </div>
                  <span
                    className={`text-xs px-2.5 py-1 rounded-full border shrink-0 ${MASTERY_BADGE[node.masteryLevel]}`}
                  >
                    {MASTERY_LABEL[node.masteryLevel]}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Per-question breakdown ── */}
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-white/80 uppercase tracking-wide">
            Հարցերի արդյունքներ
          </h2>
          {result.questions.map((q) => (
            <div
              key={q.questionId}
              className={`rounded-2xl border p-5 ${
                q.isCorrect
                  ? "border-teal-400/20 bg-teal-400/5"
                  : "border-red-400/20 bg-red-400/5"
              }`}
            >
              {/* Question header */}
              <div className="flex items-start gap-3 mb-4">
                <span className="shrink-0 text-sm">{q.isCorrect ? "✅" : "❌"}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium leading-snug">{q.questionText}</p>
                  {q.nodeTitle && (
                    <p className="text-xs text-muted-foreground/60 mt-1 truncate">
                      📌 {q.nodeTitle}
                    </p>
                  )}
                </div>
              </div>

              {/* Answer options */}
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

              {/* ── Feedback block (PART 4.1 spec §6) ────────────────────────
                  Source priority:
                    P1: quiz_questions.explanation (pending schema — null today)
                    P2: lesson_nodes.childFriendlyExplanation → whyCorrect
                    P3: lesson_nodes.commonMisconception      → whyWrong
                  No fabrication: both null → nothing shown (Case C).

                  CORRECT case (Case A):
                    • Student's answer text
                    • 💡 Ինչոէ ճիշտ + whyCorrect (if non-null)

                  WRONG case (Case B):
                    • Student's wrong answer text
                    • Ինչու է սխալ + whyWrong (if non-null)
                    • Correct answer text (factual — always shown when block visible)
                    • 💡 Ինչու է ճիշտ + whyCorrect (if non-null)
                  ──────────────────────────────────────────────────────── */}
              {(q.feedback.whyCorrect || (!q.isCorrect && q.feedback.whyWrong)) && (
                <div className="mt-4 pl-7 space-y-3">

                  {/* ① Student's answer — shown in both correct and wrong cases */}
                  <div className={`text-xs ${q.isCorrect ? "text-teal-400/80" : "text-red-400/80"}`}>
                    <span className="font-semibold">Քո պատասխանը: </span>
                    <span className="text-foreground/75">
                      {String.fromCharCode(65 + q.selectedOptionIndex)}. {(q.options as string[])[q.selectedOptionIndex]}
                    </span>
                  </div>

                  {/* ② Why wrong — only when isCorrect=false and whyWrong non-null */}
                  {!q.isCorrect && q.feedback.whyWrong && (
                    <div className="text-xs rounded-xl px-3 py-2.5 border border-red-400/20 bg-red-400/5 text-red-300/80 leading-relaxed">
                      <span className="font-semibold text-red-400/70 block mb-1">Ինչու է սխալ</span>
                      {q.feedback.whyWrong}
                    </div>
                  )}

                  {/* ③ Correct answer text — only in wrong case (factual, not fabricated) */}
                  {!q.isCorrect && (
                    <div className="text-xs text-teal-400/80">
                      <span className="font-semibold">✅ Ճիշտ պատասխանը: </span>
                      <span className="text-foreground/75">
                        {String.fromCharCode(65 + q.correctOptionIndex)}. {(q.options as string[])[q.correctOptionIndex]}
                      </span>
                    </div>
                  )}

                  {/* ④ Why correct — shown for both correct and wrong cases */}
                  {q.feedback.whyCorrect && (
                    <div className="text-xs rounded-xl px-3 py-2.5 border border-teal-400/20 bg-teal-400/5 text-teal-300/80 leading-relaxed">
                      <span className="font-semibold text-teal-400/70 block mb-1">💡 Ինչու է ճիշտ</span>
                      {q.feedback.whyCorrect}
                    </div>
                  )}

                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
