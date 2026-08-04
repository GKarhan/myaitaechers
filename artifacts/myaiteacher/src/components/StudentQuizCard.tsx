import { Link } from "wouter";

export type StudentQuizCardQuiz = {
  quizId: number;
  title: string;
  status: string;
  assignedAt: string;
  dueAt?: string | null;
  totalCorrect?: number | null;
  totalQuestions?: number | null;
  scorePercent?: number | null;
};

const QUIZ_STATUS_LABEL: Record<string, string> = {
  ASSIGNED:    "Ուղարկված",
  IN_PROGRESS: "Ուղարկված",
  COMPLETED:   "✅",
};

const QUIZ_STATUS_CLS: Record<string, string> = {
  ASSIGNED:    "bg-primary/15 text-primary border-primary/15",
  IN_PROGRESS: "bg-amber-400/15 text-amber-400 border-amber-400/20",
  COMPLETED:   "bg-teal-400/15 text-teal-400 border-teal-400/20",
};

export default function StudentQuizCard({ quiz }: { quiz: StudentQuizCardQuiz }) {
  const isCompleted = quiz.status === "COMPLETED";
  const dateStr = new Date(quiz.assignedAt).toLocaleDateString("hy-AM", {
    day: "numeric", month: "long",
  });

  if (isCompleted) {
    return (
      <div className="rounded-2xl border border-teal-400/20 bg-teal-400/5 p-5 flex flex-col sm:flex-row sm:items-center gap-4 hover:border-teal-400/30 transition-colors">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-sm">{quiz.title}</h3>
          {quiz.totalCorrect != null && (
            <p className="text-xs text-teal-400/80 mt-0.5">
              {quiz.totalCorrect}/{quiz.totalQuestions} ({quiz.scorePercent}%)
            </p>
          )}
        </div>
        <Link
          href={`/quiz/${quiz.quizId}/result`}
          className="text-xs px-4 py-2 rounded-xl bg-teal-400/15 text-teal-400 border border-teal-400/20 font-semibold hover:bg-teal-400/25 transition-all whitespace-nowrap shrink-0"
        >
          Տesennel ardzunk placeholder
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-card/60 p-5 flex flex-col sm:flex-row sm:items-center gap-5 hover:border-white/20 transition-colors">
      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-xs px-2.5 py-0.5 rounded-full border ${QUIZ_STATUS_CLS[quiz.status] ?? QUIZ_STATUS_CLS.ASSIGNED}`}>
            {QUIZ_STATUS_LABEL[quiz.status] ?? quiz.status}
          </span>
          {quiz.dueAt && (
            <span className="text-xs text-muted-foreground">
              Deadline: {new Date(quiz.dueAt).toLocaleDateString("hy-AM")}
            </span>
          )}
        </div>
        <h3 className="font-semibold text-base leading-snug">{quiz.title}</h3>
        <div className="text-xs text-muted-foreground">{dateStr}</div>
      </div>
      <Link
        href={`/quiz/${quiz.quizId}/take`}
        className="flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-gradient-to-r from-primary to-secondary text-white font-bold text-sm hover:opacity-90 active:scale-[0.98] transition-all shadow-lg shadow-primary/20 whitespace-nowrap shrink-0"
      >
        ▶ ՍԿՍԵԼ ԹԵՍՏԵՐ
      </Link>
    </div>
  );
}
