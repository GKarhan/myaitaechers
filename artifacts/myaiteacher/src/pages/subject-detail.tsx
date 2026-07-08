import { useEffect, useState, useCallback } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useAuth } from "@/lib/auth";
import { useGetSubjectDetail, getGetSubjectDetailQueryKey } from "@workspace/api-client-react";

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

  const [downloading, setDownloading] = useState(false);

  const handleDownloadBook = useCallback(async (fileUrl: string, fileName: string) => {
    if (!token) return;
    setDownloading(true);
    try {
      const response = await fetch(fileUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("Download failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      alert("Ֆayly bĕrnĕl hnaravorutyoun chka");
    } finally {
      setDownloading(false);
    }
  }, [token]);

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

  const statusInfo = (status: string) => {
    if (status === "completed") return { text: "Ավարտված", dot: "bg-teal-400", cls: "text-teal-400" };
    if (status === "pending")   return { text: "Շարունակ", dot: "bg-amber-400", cls: "text-amber-400" };
    return { text: "Չը սկսած",  dot: "bg-white/20",  cls: "text-muted-foreground" };
  };

  const masteryColor = (score: number) => {
    if (score >= 80) return { bg: "bg-green-500/20", text: "text-green-400", border: "border-green-500/30" };
    if (score >= 60) return { bg: "bg-amber-500/20", text: "text-amber-400", border: "border-amber-500/30" };
    return { bg: "bg-red-500/20", text: "text-red-400", border: "border-red-500/30" };
  };

  return (
    <div className="min-h-[100dvh] w-full bg-background text-white pb-20">
      <header className="border-b border-white/10 bg-card/50 backdrop-blur-lg sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <Link href="/dashboard" className="text-muted-foreground hover:text-white transition-colors">
              ← Նհորս
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
              <div className="text-muted-foreground text-sm mb-1">Ավարտված / Ենդհանուր</div>
              <div className="text-2xl font-bold text-white">{completed} / {total}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-sm mb-1">Միջին Յուրածում</div>
              <div className="text-2xl font-bold text-secondary">
                {subject.averageScore ? `${subject.averageScore}%` : "—"}
              </div>
            </div>
          </div>
          <div className="flex-1 md:max-w-md">
            <div className="text-muted-foreground text-sm mb-2 flex justify-between">
              <span>Ենդհանուր արաջընտրած</span>
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

        {/* Lessons list */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-bold">Դասերի ծուծակը</h2>
          <Link
            href={`/knowledge-tree/${subjectId}`}
            className="px-4 py-2 bg-white/5 border border-white/10 rounded-xl text-sm text-secondary hover:bg-white/10 transition-colors"
          >
            Գիտելիքի կարտեզ →
          </Link>
        </div>

        <div className="space-y-3 mb-12">
          {subject.lessons && subject.lessons.length > 0 ? (
            subject.lessons.map((lesson, idx) => {
              const { text: statusText, dot: dotCls, cls: statusCls } = statusInfo(lesson.status);
              const ms = (lesson as { masteryScore?: number | null }).masteryScore;
              const mc = ms !== null && ms !== undefined ? masteryColor(ms) : null;

              return (
                <div
                  key={lesson.id}
                  className="bg-card/60 border border-white/10 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:border-white/20 transition-colors"
                >
                  <div className="flex items-center gap-4 flex-1 min-w-0">
                    {/* Number circle */}
                    <div className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center font-medium border text-sm ${
                      lesson.status === "completed"
                        ? "bg-teal-500/20 border-teal-500/40 text-teal-400"
                        : lesson.status === "pending"
                        ? "bg-amber-500/20 border-amber-500/40 text-amber-400"
                        : "bg-background/60 border-white/10 text-muted-foreground"
                    }`}>
                      {lesson.status === "completed" ? "✓" : lesson.lessonNumber ?? idx + 1}
                    </div>

                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-base truncate">{lesson.lesson}</h3>
                      <div className="flex items-center gap-3 mt-1 flex-wrap">
                        {/* Status dot */}
                        <span className={`text-xs flex items-center gap-1.5 ${statusCls}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${dotCls}`} />
                          {statusText}
                        </span>

                        {/* Mastery score badge */}
                        {mc !== null && ms !== null && ms !== undefined && (
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${mc.bg} ${mc.text} ${mc.border}`}>
                            🎯 {ms}% Յուրածում
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <Link
                    href={`/lessons/${lesson.id}`}
                    className="shrink-0 flex items-center justify-center gap-1.5 px-5 py-2.5 bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity"
                  >
                    {lesson.status === "completed" ? "🔄 Կռկնել" : "📖 Սովորել"}
                  </Link>
                </div>
              );
            })
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <div className="text-4xl mb-3">📚</div>
              <p>Daser chka · Ucucichĕ kaveli</p>
            </div>
          )}
        </div>

        {/* Book section */}
        <div className="pt-8 border-t border-white/10">
          <h2 className="text-xl font-bold mb-5">📚 Դասագիրկը</h2>
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
                  <button
                    onClick={() => handleDownloadBook(
                      (subject as any).book.fileUrl,
                      (subject as any).book.name + ".pdf"
                    )}
                    disabled={downloading}
                    className="inline-flex items-center gap-1.5 mt-3 px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {downloading ? "⏳ Բըրնվում ե..." : "📥 Բըրնել Դասագիրկը"}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="p-6 rounded-2xl bg-card/30 border border-white/10 max-w-xl text-center">
              <div className="text-3xl mb-3 text-muted-foreground">📂</div>
              <p className="text-muted-foreground text-sm">Ays araŕkayĭ hamar dasagirk chka</p>
            </div>
          )}
        </div>

      </main>
    </div>
  );
}
