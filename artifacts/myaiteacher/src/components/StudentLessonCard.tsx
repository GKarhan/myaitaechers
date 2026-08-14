import { Link } from "wouter";
import { lessonStatusBadge } from "@/lib/student-nav";

export type StudentLessonCardLesson = {
  id: number;
  title: string;
  subject?: string;
  teacherName?: string;
  chapterTitle?: string | null;
  paragraphNumber?: string | null;
  pagesFrom?: number | null;
  pagesTo?: number | null;
  lessonNumber?: number | null;
  mySessionStatus?: string | null;
  status?: string;
};

export type LinkedQuiz = {
  id: number;
  title: string;
  quizType: string | null;
  isReleased: boolean;
};

const quizTypeLabel = (t: string | null) =>
  t === "lesson" ? "Դասի թեստ" : t === "summary" ? "Ամփոփիչ" : null;

export default function StudentLessonCard({
  lesson,
  showSubject = true,
  quizzes = [],
}: {
  lesson: StudentLessonCardLesson;
  showSubject?: boolean;
  quizzes?: LinkedQuiz[];
}) {
  const badge = lessonStatusBadge(lesson.mySessionStatus);

  return (
    <div className="rounded-2xl border border-white/10 bg-card/60 p-5 flex flex-col gap-4 hover:border-white/20 transition-colors">
      {/* ── Top row: metadata + start button ── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-5">
        <div className="flex-1 min-w-0 space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            {showSubject && lesson.subject && (
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/15">
                {lesson.subject}
              </span>
            )}
            <span className={`text-xs px-2.5 py-0.5 rounded-full border ${badge.cls}`}>
              {badge.text}
            </span>
          </div>
          <h3 className="font-semibold text-base leading-snug">{lesson.title}</h3>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
            {lesson.teacherName && <span>👨‍🏫 {lesson.teacherName}</span>}
            {lesson.chapterTitle && <span>📂 {lesson.chapterTitle}</span>}
            {lesson.paragraphNumber && <span>§{lesson.paragraphNumber}</span>}
            {(lesson.pagesFrom || lesson.pagesTo) && (
              <span>Էջ {lesson.pagesFrom ?? "?"}–{lesson.pagesTo ?? "?"}</span>
            )}
          </div>
        </div>
        <Link
          href={`/lessons/${lesson.id}`}
          className="flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-gradient-to-r from-primary to-secondary text-white font-bold text-sm hover:opacity-90 active:scale-[0.98] transition-all shadow-lg shadow-primary/20 whitespace-nowrap shrink-0"
        >
          ▶ ՍԿՍԵԼ ԴԱՍԸ
        </Link>
      </div>

      {/* ── Linked tests block ── */}
      {quizzes.length > 0 && (
        <div className="border-t border-white/8 pt-3">
          <p className="text-xs font-semibold text-muted-foreground mb-2">
            📝 Թեստեր ({quizzes.length})
          </p>
          <div className="flex flex-col gap-2">
            {quizzes.map((q) => (
              <div
                key={q.id}
                className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 bg-white/4 border border-white/6"
              >
                <div className="min-w-0">
                  <span className="text-sm text-white/90 truncate block">{q.title}</span>
                  {quizTypeLabel(q.quizType) && (
                    <span className="text-xs text-muted-foreground/70">
                      {quizTypeLabel(q.quizType)}
                    </span>
                  )}
                </div>
                {q.isReleased ? (
                  <Link
                    href={`/quiz/${q.id}/take`}
                    className="px-3 py-1.5 bg-secondary/90 hover:bg-secondary text-white text-xs font-bold rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    ▶ Սկսել թեստը
                  </Link>
                ) : (
                  <span className="text-xs text-muted-foreground/60 italic whitespace-nowrap shrink-0">
                    Դեռ հասանելի չէ
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
