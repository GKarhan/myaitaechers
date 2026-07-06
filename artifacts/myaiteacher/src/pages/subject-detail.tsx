import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useAuth } from "@/lib/auth";
import { useGetSubjectDetail, getGetSubjectDetailQueryKey, useStartLesson, useGetBooks, getGetBooksQueryKey, useGenerateLessons } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export default function SubjectDetail() {
  const { user, token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { id } = useParams<{ id: string }>();
  const subjectId = parseInt(id || "", 10);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!authLoading && !token) {
      setLocation("/login");
    }
  }, [token, authLoading, setLocation]);

  const { data: subject, isLoading: subjectLoading } = useGetSubjectDetail(subjectId, {
    query: {
      queryKey: getGetSubjectDetailQueryKey(subjectId),
      enabled: !!token && !isNaN(subjectId),
    }
  });

  const { data: booksData } = useGetBooks({
    query: {
      queryKey: getGetBooksQueryKey(),
      enabled: !!token && !isNaN(subjectId),
    }
  });

  const startLessonMutation = useStartLesson();
  
  const subjectBook = booksData?.find((b: any) => b.subjectId === subjectId);
  const [genStatus, setGenStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [genCount, setGenCount] = useState(0);
  const [genError, setGenError] = useState("");
  const generateLessonsMutation = useGenerateLessons();

  const handleGenerateLessons = () => {
    if (!subjectBook) return;
    setGenStatus("loading");
    generateLessonsMutation.mutate({ bookId: subjectBook.id }, {
      onSuccess: (res: any) => {
        setGenStatus("success");
        setGenCount(res?.lessonsGenerated || res?.count || 0);
        queryClient.invalidateQueries({ queryKey: getGetSubjectDetailQueryKey(subjectId) });
      },
      onError: (err: any) => {
        setGenStatus("error");
        setGenError(err.message || "Սխալ գեներացիայի ընթացքում");
      }
    });
  };

  const getFileIcon = (mimeType: string) => {
    if (!mimeType) return "📄";
    if (mimeType.includes("pdf")) return "📄";
    if (mimeType.includes("word") || mimeType.includes("doc")) return "📝";
    return "📃";
  };

  const formatFileSize = (bytes: number) => {
    if (!bytes) return "0 B";
    if (bytes < 1024) return bytes + " B";
    else if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    else return (bytes / 1048576).toFixed(1) + " MB";
  };

  if (authLoading || subjectLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!user || !subject) return null;

  const handleStartLesson = (lesson: string) => {
    startLessonMutation.mutate(
      { subjectId, data: { lesson, status: "pending" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetSubjectDetailQueryKey(subjectId) });
        }
      }
    );
  };

  return (
    <div className="min-h-[100dvh] w-full bg-background text-white pb-20">
      <header className="border-b border-card-border bg-card/50 backdrop-blur-lg sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <Link href="/dashboard" className="text-muted-foreground hover:text-white transition-colors">
              ← Հետ
            </Link>
            <div className="font-bold text-xl bg-clip-text text-transparent bg-gradient-to-r from-primary to-secondary">
              myaiteacher
            </div>
          </div>
          <Link href="/chat/0" className="px-4 py-2 bg-gradient-to-r from-primary to-secondary text-white rounded-lg text-sm font-medium shadow-lg hover:opacity-90 transition-opacity">
            AI Ուսուցիչ
          </Link>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 pt-10">
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-bold">{subject.name}</h1>
            <span className="px-3 py-1 bg-card border border-card-border rounded-full text-sm text-secondary">
              {subject.grade}
            </span>
          </div>
          <p className="text-muted-foreground">{subject.description}</p>
        </div>

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-12 p-6 rounded-2xl bg-card border border-card-border shadow-lg shadow-black/50">
          <div className="flex gap-8">
            <div>
              <div className="text-muted-foreground text-sm mb-1">Ավարտված / Ընդհանուր</div>
              <div className="text-2xl font-bold text-white">{subject.completedLessons} / {subject.totalLessons}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-sm mb-1">Միջին գնահատական</div>
              <div className="text-2xl font-bold text-secondary">{subject.averageScore}</div>
            </div>
          </div>
          <div className="flex-1 md:max-w-md">
            <div className="text-muted-foreground text-sm mb-2 flex justify-between">
              <span>Ընդհանուր առաջընթաց</span>
              <span>{subject.progressPercent}%</span>
            </div>
            <div className="h-2 w-full bg-background rounded-full overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-primary to-secondary rounded-full"
                style={{ width: `${subject.progressPercent}%` }}
              />
            </div>
          </div>
        </div>

        <div className="flex justify-between items-end mb-6 border-b border-card-border pb-4">
          <h2 className="text-2xl font-bold">Դասերի ցուցակ</h2>
          <Link 
            href={`/knowledge-tree/${subjectId}`}
            className="px-5 py-2.5 bg-secondary/10 text-secondary border border-secondary/20 hover:bg-secondary/20 rounded-xl transition-colors font-medium flex items-center gap-2"
          >
            Գիտելիքի ծառ →
          </Link>
        </div>

        <div className="space-y-4">
          {subject.lessons?.map((lesson, idx) => (
            <div key={idx} className="p-5 rounded-2xl bg-card border border-card-border flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 shrink-0 rounded-full bg-background flex items-center justify-center text-muted-foreground font-medium border border-card-border">
                  {idx + 1}
                </div>
                <div>
                  <h3 className="font-semibold text-lg">{lesson.lesson}</h3>
                  <div className="flex items-center gap-3 mt-1 text-sm">
                    {lesson.status === 'completed' && (
                      <span className="text-secondary flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-secondary"></span>
                        Ավարտված
                      </span>
                    )}
                    {lesson.status === 'pending' && (
                      <span className="text-accent flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-accent"></span>
                        Ընթացքի մեջ
                      </span>
                    )}
                    {lesson.status === 'not_started' && (
                      <span className="text-muted-foreground flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-muted-foreground"></span>
                        Սկսված չէ
                      </span>
                    )}
                    
                    {lesson.status === 'completed' && lesson.score !== undefined && (
                      <span className="text-white border-l border-card-border pl-3">
                        {lesson.score} միավոր
                      </span>
                    )}
                  </div>
                </div>
              </div>
              
              <button
                onClick={() => handleStartLesson(lesson.lesson)}
                disabled={startLessonMutation.isPending}
                className="px-5 py-2.5 bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 rounded-xl transition-colors font-medium"
              >
                Սկսել դասը
              </button>
            </div>
          ))}
        </div>

        <div className="mt-12 pt-10 border-t border-card-border">
          <h2 className="text-2xl font-bold mb-6">📚 Կցված գիրք</h2>
          
          {subjectBook ? (
            <div className="p-6 rounded-2xl bg-card border border-card-border shadow-lg max-w-2xl">
              <div className="flex items-start gap-4 mb-6">
                <div className="text-3xl bg-background p-3 rounded-xl border border-card-border">
                  {getFileIcon(subjectBook.mimeType)}
                </div>
                <div>
                  <h3 className="font-semibold text-lg">{subjectBook.name}</h3>
                  <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
                    <span>{formatFileSize(subjectBook.fileSize)}</span>
                    <span>•</span>
                    <span>{new Date(subjectBook.uploadedAt).toLocaleDateString("hy-AM")}</span>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4">
                {genStatus === "idle" && (
                  <button
                    onClick={handleGenerateLessons}
                    className="px-5 py-2 bg-accent/10 text-accent border border-accent/20 hover:bg-accent/20 rounded-xl transition-colors font-medium flex items-center gap-2"
                  >
                    ✨ Գեներացնել դասեր
                  </button>
                )}
                
                {genStatus === "loading" && (
                  <div className="px-5 py-2 bg-card rounded-xl border border-card-border flex items-center gap-2 text-muted-foreground font-medium">
                    <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
                    Գեներացվում է...
                  </div>
                )}

                {genStatus === "success" && (
                  <div className="px-5 py-2 bg-accent/10 rounded-xl border border-accent/20 flex items-center gap-2 text-accent font-medium">
                    <span>✓</span> {genCount > 0 ? `${genCount} դաս ստեղծվեց` : "Դասեր ստեղծվեցին"}
                  </div>
                )}

                {genStatus === "error" && (
                  <div className="px-5 py-2 bg-red-500/10 rounded-xl border border-red-500/20 flex items-center gap-2 text-red-400 font-medium text-sm">
                    Սխալ առաջացավ. {genError}
                  </div>
                )}

                <Link 
                  href="/books"
                  className="px-5 py-2 bg-background border border-card-border hover:bg-card/50 rounded-xl transition-colors text-white font-medium"
                >
                  Փոխել գիրքը
                </Link>
              </div>
            </div>
          ) : (
            <div className="p-8 rounded-2xl bg-card border border-card-border shadow-lg max-w-2xl text-center border-dashed">
              <div className="text-4xl mb-4 text-muted-foreground">📂</div>
              <h3 className="font-semibold text-lg mb-2">Այս առարկայի համար գիրք չկա</h3>
              <p className="text-muted-foreground text-sm mb-6 max-w-md mx-auto">
                Վերբեռնեք գիրք այս առարկայի համար՝ դասեր և առաջադրանքներ ավտոմատ գեներացնելու համար։
              </p>
              <Link 
                href="/books"
                className="inline-flex px-6 py-2.5 bg-primary text-white hover:opacity-90 rounded-xl transition-opacity font-medium"
              >
                Կցել գիրք
              </Link>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
