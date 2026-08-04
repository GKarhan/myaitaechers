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

export default function StudentLessonCard({
  lesson,
  showSubject = true,
}: {
  lesson: StudentLessonCardLesson;
  showSubject?: boolean;
}) {
  const badge = lessonStatusBadge(lesson.mySessionStatus);

  return (
    <div className="rounded-2xl border border-white/10 bg-card/60 p-5 flex flex-col sm:flex-row sm:items-center gap-5 hover:border-white/20 transition-colors">
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
  );
}
