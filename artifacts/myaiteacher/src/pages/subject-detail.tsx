import { useEffect } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useAuth } from "@/lib/auth";
import {
  useGetSubjectDetail,
  getGetSubjectDetailQueryKey,
  useGetStudentCourseLessons,
  getGetStudentCourseLessonsQueryKey,
} from "@workspace/api-client-react";

type StudentLesson = {
  id: number;
  courseId: number | null | undefined;
  title: string;
  lessonNumber?: number | null;
  pagesFrom?: number | null;
  pagesTo?: number | null;
  textbookAuthor?: string | null;
  textbookTitle?: string | null;
  chapterTitle?: string | null;
  paragraphNumber?: string | null;
  status: string;
  assignedAt?: string | null;
  completedAt?: string | null;
};

export default function SubjectDetail() {
  const { user, token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { id } = useParams<{ id: string }>();
  const subjectId = parseInt(id || "", 10);

  useEffect(() => {
    if (!authLoading && !token) setLocation("/login");
  }, [token, authLoading, setLocation]);

  const { data: subject, isLoading: subjectLoading } = useGetSubjectDetail(subjectId, {
    query: {
      queryKey: getGetSubjectDetailQueryKey(subjectId),
      enabled: !!token && !isNaN(subjectId),
    },
  });

  // Fetch teacher-created course lessons for this subject
  const subjectName = subject?.name ?? "";
  const { data: teacherLessons = [], isLoading: lessonsLoading } = useGetStudentCourseLessons(
    { subject: subjectName },
    {
      query: {
        queryKey: getGetStudentCourseLessonsQueryKey({ subject: subjectName }),
        enabled: !!token && !!subjectName,
      },
    }
  );

  const getFileIcon = (mimeType: string) => {
    if (!mimeType) return "📄";
    if (mimeType.includes("pdf")) return "📄";
    if (mimeType.includes("word") || mimeType.includes("doc")) return "📝";
    return "📃";
  };

  const formatFileSize = (bytes: number) => {
    if (!bytes) return "0 B";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  };

  if (authLoading || subjectLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user || !subject) return null;

  const completed = subject.completedLessons ?? 0;
  const total = subject.totalLessons ?? 0;
  const pct = subject.progressPercent ?? 0;

  // Active lesson (from teacher) for "Aysorvada dasy" section
  const activeLesson = (teacherLessons as StudentLesson[]).find((l) => l.status === "active");

  // Status display helpers
  const statusLabel = (status: string) => {
    if (status === "active")    return { text: "Aysorvada das",   cls: "text-primary border-primary/30 bg-primary/10" };
    if (status === "assigned")  return { text: "Handznaravats",   cls: "text-amber-400 border-amber-400/30 bg-amber-400/10" };
    if (status === "completed") return { text: "Avartvatc",       cls: "text-teal-400 border-teal-400/30 bg-teal-400/10" };
    return                             { text: "Naxapastgatsvats",cls: "text-muted-foreground border-white/10 bg-white/5" };
  };

  // Hierarchical grouping for the "all lessons" section
  const sortedLessons = [...(teacherLessons as StudentLesson[])].sort((a, b) => {
    const ta = (a.textbookTitle ?? "").localeCompare(b.textbookTitle ?? "", "hy");
    if (ta !== 0) return ta;
    const ca = (a.chapterTitle ?? "").localeCompare(b.chapterTitle ?? "", "hy");
    if (ca !== 0) return ca;
    const la = (a.lessonNumber ?? 9999) - (b.lessonNumber ?? 9999);
    if (la !== 0) return la;
    return (a.paragraphNumber ?? "").localeCompare(b.paragraphNumber ?? "");
  });

  const textbookGroups: Map<string, StudentLesson[]> = new Map();
  for (const l of sortedLessons) {
    const tb = l.textbookTitle ?? "";
    if (!textbookGroups.has(tb)) textbookGroups.set(tb, []);
    textbookGroups.get(tb)!.push(l);
  }

  return (
    <div className="min-h-[100dvh] w-full bg-background text-white pb-20">
      <header className="border-b border-white/10 bg-card/50 backdrop-blur-lg sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <Link href="/dashboard" className="text-muted-foreground hover:text-white transition-colors">
              ← Het
            </Link>
            <div className="font-bold text-xl bg-clip-text text-transparent bg-gradient-to-r from-primary to-secondary">
              myaiteacher
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 pt-10">

        {/* Subject header */}
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-bold">{subject.name}</h1>
            <span className="px-3 py-1 bg-card border border-white/10 rounded-full text-sm text-secondary">
              {subject.grade}
            </span>
          </div>
          {subject.description && (
            <p className="text-muted-foreground">{subject.description}</p>
          )}
        </div>

        {/* Stats bar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-12 p-6 rounded-2xl bg-card/60 border border-white/10 shadow-lg">
          <div className="flex gap-8">
            <div>
              <div className="text-muted-foreground text-sm mb-1">Avartvatc / Yndhanowr</div>
              <div className="text-2xl font-bold text-white">{completed} / {total}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-sm mb-1">Midhin gnahatakanы</div>
              <div className="text-2xl font-bold text-secondary">{subject.averageScore}</div>
            </div>
          </div>
          <div className="flex-1 md:max-w-md">
            <div className="text-muted-foreground text-sm mb-2 flex justify-between">
              <span>Yndhanowr ajandghac</span>
              <span>{pct}%</span>
            </div>
            <div className="h-2 w-full bg-background rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-primary to-secondary rounded-full transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        </div>

        {/* ── AYSORVADA DASY (active lesson) ── */}
        {activeLesson && (
          <div className="mb-12">
            <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              AYSORVADA DASY
            </h2>
            <div className="rounded-2xl border border-primary/40 bg-primary/5 p-6 shadow-lg shadow-primary/10">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-4">
                <div className="space-y-1">
                  {activeLesson.textbookTitle && (
                    <div className="text-xs text-muted-foreground">
                      Dasagriq · {activeLesson.textbookTitle}
                      {activeLesson.textbookAuthor && ` (${activeLesson.textbookAuthor})`}
                    </div>
                  )}
                  {activeLesson.chapterTitle && (
                    <div className="text-xs text-secondary/80">Tema · {activeLesson.chapterTitle}</div>
                  )}
                  <div className="flex items-center gap-2 mt-1">
                    {activeLesson.lessonNumber && (
                      <span className="text-xs font-mono text-primary/70">Das #{activeLesson.lessonNumber}</span>
                    )}
                    {activeLesson.paragraphNumber && (
                      <span className="text-xs text-muted-foreground">§{activeLesson.paragraphNumber}</span>
                    )}
                  </div>
                  <h3 className="text-lg font-bold text-white mt-1">{activeLesson.title}</h3>
                  {(activeLesson.pagesFrom || activeLesson.pagesTo) && (
                    <div className="text-sm text-muted-foreground">
                      Ej' {activeLesson.pagesFrom ?? "?"}–{activeLesson.pagesTo ?? "?"}
                    </div>
                  )}
                </div>
                <span className="shrink-0 self-start px-3 py-1 rounded-full text-xs font-semibold bg-primary/20 text-primary border border-primary/30">
                  Aysorvada das
                </span>
              </div>
              <Link
                href={`/lessons/${activeLesson.id}`}
                className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-2xl bg-gradient-to-r from-primary to-secondary text-white font-bold text-sm hover:opacity-90 transition-opacity shadow-lg shadow-primary/30"
              >
                🚀 SKSNEL SOVOREL AI USUCCHI HET
              </Link>
            </div>
          </div>
        )}

        {/* ── BOLOR DASERY (full teacher lesson list) ── */}
        {!lessonsLoading && sortedLessons.length > 0 && (
          <div className="mb-12">
            <h2 className="text-2xl font-bold mb-5">BOLOR DASERY</h2>
            <div className="space-y-6">
              {Array.from(textbookGroups.entries()).map(([tbTitle, tbLessons]) => {
                const tbAuthor = tbLessons[0]?.textbookAuthor;
                const chapterGroups: Map<string, StudentLesson[]> = new Map();
                for (const l of tbLessons) {
                  const ch = l.chapterTitle ?? "";
                  if (!chapterGroups.has(ch)) chapterGroups.set(ch, []);
                  chapterGroups.get(ch)!.push(l);
                }
                return (
                  <div key={tbTitle} className="bg-card/40 border border-white/10 rounded-2xl overflow-hidden">
                    <div className="px-5 py-4 border-b border-white/10 bg-card/60">
                      <div className="text-xs uppercase tracking-widest text-muted-foreground font-semibold mb-1">DASAGIRK</div>
                      <div className="font-semibold text-base text-white">{tbTitle || "(Dasagriq nshvatc chi)"}</div>
                      {tbAuthor && <div className="text-xs text-muted-foreground mt-0.5">Heleghnak' {tbAuthor}</div>}
                    </div>
                    <div className="divide-y divide-white/5">
                      {Array.from(chapterGroups.entries()).map(([chTitle, chLessons]) => (
                        <div key={chTitle} className="px-5 py-4">
                          {chTitle && (
                            <div className="text-xs font-semibold text-secondary/80 uppercase tracking-wide mb-3">
                              TEMA · {chTitle}
                            </div>
                          )}
                          <div className="space-y-2">
                            {chLessons.map((l) => {
                              const sl = statusLabel(l.status);
                              const isActive = l.status === "active";
                              return (
                                <div
                                  key={l.id}
                                  className={`rounded-xl p-4 border flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-colors ${isActive ? "border-primary/30 bg-primary/5" : "border-white/8 bg-background/40"}`}
                                >
                                  <div className="flex items-start gap-3">
                                    <span className="text-xs font-mono text-primary/60 w-6 shrink-0 mt-0.5">
                                      {l.lessonNumber ?? "—"}
                                    </span>
                                    <div>
                                      <div className="font-medium text-sm">{l.title}</div>
                                      <div className="flex flex-wrap gap-2 mt-1 items-center">
                                        {l.paragraphNumber && (
                                          <span className="text-xs text-muted-foreground">§{l.paragraphNumber}</span>
                                        )}
                                        {(l.pagesFrom || l.pagesTo) && (
                                          <span className="text-xs text-muted-foreground">
                                            Ej' {l.pagesFrom ?? "?"}–{l.pagesTo ?? "?"}
                                          </span>
                                        )}
                                        <span className={`text-xs px-2 py-0.5 rounded-full border ${sl.cls}`}>
                                          {sl.text}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                  <Link
                                    href={`/lessons/${l.id}`}
                                    className="shrink-0 flex items-center justify-center gap-1.5 px-4 py-2 bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity"
                                  >
                                    📖 Sovorel
                                  </Link>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Progress-based lessons (original) */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-bold">Daseri cucak</h2>
          <Link
            href={`/knowledge-tree/${subjectId}`}
            className="px-4 py-2 bg-white/5 border border-white/10 rounded-xl text-sm text-secondary hover:bg-white/10 transition-colors"
          >
            Gitelighi Kartez →
          </Link>
        </div>

        <div className="space-y-3 mb-12">
          {subject.lessons && subject.lessons.length > 0 ? (
            subject.lessons.map((lesson, idx) => {
              const st = lesson.status === "completed"
                ? { text: "Avartvatc", cls: "text-teal-400" }
                : lesson.status === "pending"
                ? { text: "Ynthacqum", cls: "text-amber-400" }
                : { text: "Chsksvats", cls: "text-muted-foreground" };
              return (
                <div
                  key={lesson.id}
                  className="bg-card/60 border border-white/10 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 shrink-0 rounded-full bg-background/60 flex items-center justify-center text-muted-foreground font-medium border border-white/10">
                      {lesson.lessonNumber ?? idx + 1}
                    </div>
                    <div>
                      <h3 className="font-semibold text-base">{lesson.lesson}</h3>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className={`text-xs flex items-center gap-1.5 ${st.cls}`}>
                          <span className="w-1.5 h-1.5 rounded-full bg-current" />
                          {st.text}
                        </span>
                        {lesson.status === "completed" && (lesson as { score?: number }).score !== undefined && (
                          <span className="text-xs text-white/60 border-l border-white/10 pl-3">
                            {(lesson as { score?: number }).score} miavaor
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <Link
                    href={`/lessons/${lesson.id}`}
                    className="shrink-0 flex items-center justify-center gap-1.5 px-5 py-2.5 bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity"
                  >
                    📖 Sovorel
                  </Link>
                </div>
              );
            })
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <div className="text-4xl mb-3">📚</div>
              <p>Dasery chkan · usuchichnы kaveli</p>
            </div>
          )}
        </div>

        {/* Book section */}
        <div className="pt-8 border-t border-white/10">
          <h2 className="text-xl font-bold mb-5">📚 Girqy</h2>
          {(subject as any).book ? (
            <div className="p-5 rounded-2xl bg-card/60 border border-white/10 max-w-xl flex items-start gap-4">
              <div className="text-3xl bg-background/60 p-3 rounded-xl border border-white/10 shrink-0">
                {getFileIcon((subject as any).book.mimeType)}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-base">{(subject as any).book.name}</h3>
                <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
                  <span>{formatFileSize((subject as any).book.fileSize)}</span>
                  <span>·</span>
                  <span>{new Date((subject as any).book.uploadedAt).toLocaleDateString("hy-AM")}</span>
                </div>
                {(subject as any).book.fileUrl && (
                  <a
                    href={(subject as any).book.fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 mt-3 px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold hover:opacity-90 transition-opacity"
                  >
                    Berrnel girqy
                  </a>
                )}
              </div>
            </div>
          ) : (
            <div className="p-6 rounded-2xl bg-card/30 border border-white/10 max-w-xl text-center">
              <div className="text-3xl mb-3 text-muted-foreground">📂</div>
              <p className="text-muted-foreground text-sm">Ajs Arrakayи hamar girq chka</p>
            </div>
          )}
        </div>

      </main>
    </div>
  );
}
