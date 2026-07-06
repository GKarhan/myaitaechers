import { useEffect, useState, useRef } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { 
  useGetSubjects, getGetSubjectsQueryKey, 
  useGetBooks, getGetBooksQueryKey, 
  useGenerateLessons 
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export default function Books() {
  const { user, token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!authLoading && !token) {
      setLocation("/login");
    }
  }, [token, authLoading, setLocation]);

  const [selectedSubjectId, setSelectedSubjectId] = useState<string>("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: subjects } = useGetSubjects({
    query: {
      queryKey: getGetSubjectsQueryKey(),
      enabled: !!token,
    }
  });

  const { data: books, isLoading: booksLoading } = useGetBooks({
    query: {
      queryKey: getGetBooksQueryKey(),
      enabled: !!token,
    }
  });

  if (authLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!user) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFile(e.target.files[0]);
      setUploadError(null);
      setUploadSuccess(false);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) return;
    
    if (selectedFile.size > 10 * 1024 * 1024) {
      setUploadError("Ֆայլի չափը գերազանցում է 10MB-ը");
      return;
    }

    setUploading(true);
    setUploadError(null);
    setUploadSuccess(false);

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      if (selectedSubjectId) formData.append("subjectId", String(selectedSubjectId));
      formData.append("name", selectedFile.name);

      const res = await fetch(`${import.meta.env.BASE_URL}api/books/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) {
        throw new Error("Առաջացավ սխալ վերբեռնման ժամանակ");
      }

      setUploadSuccess(true);
      setSelectedFile(null);
      setSelectedSubjectId("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      queryClient.invalidateQueries({ queryKey: getGetBooksQueryKey() });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Անհայտ սխալ");
    } finally {
      setUploading(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B";
    else if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    else return (bytes / 1048576).toFixed(1) + " MB";
  };

  const getFileIcon = (mimeType: string) => {
    if (mimeType?.includes("pdf")) return "📄";
    if (mimeType?.includes("word") || mimeType?.includes("doc")) return "📝";
    return "📃";
  };

  return (
    <div className="min-h-[100dvh] w-full bg-background text-white pb-20">
      <header className="border-b border-card-border bg-card/50 backdrop-blur-lg sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-4">
          <Link href="/dashboard" className="text-muted-foreground hover:text-white transition-colors">
            ← Հետ
          </Link>
          <div className="font-bold text-xl">Իմ գրքերը</div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 pt-10 space-y-8">
        <section className="p-6 rounded-2xl bg-card border border-card-border shadow-lg">
          <h2 className="text-xl font-bold mb-6">Կցել գիրք</h2>
          
          <div className="space-y-4 max-w-xl">
            <div>
              <label className="block text-sm text-muted-foreground mb-2">Առարկա (ընտրովի)</label>
              <select 
                className="w-full bg-background border border-card-border rounded-xl px-4 py-2 text-white focus:outline-none focus:border-primary"
                value={selectedSubjectId}
                onChange={(e) => setSelectedSubjectId(e.target.value)}
              >
                <option value="">Ընտրեք առարկան</option>
                {subjects?.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm text-muted-foreground mb-2">Ֆայլ</label>
              <div 
                className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${selectedFile ? 'border-primary bg-primary/5' : 'border-card-border hover:border-primary/50'}`}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    setSelectedFile(e.dataTransfer.files[0]);
                    setUploadError(null);
                    setUploadSuccess(false);
                  }
                }}
              >
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  className="hidden" 
                  accept=".pdf,.doc,.docx,.txt"
                  onChange={handleFileChange}
                />
                
                {selectedFile ? (
                  <div className="flex flex-col items-center gap-2">
                    <span className="text-4xl">{getFileIcon(selectedFile.type || "")}</span>
                    <span className="font-medium text-white">{selectedFile.name}</span>
                    <span className="text-xs text-muted-foreground">{formatFileSize(selectedFile.size)}</span>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2 cursor-pointer text-muted-foreground">
                    <span className="text-4xl mb-2">📂</span>
                    <span>Ֆայլ քաշեք կամ ընտրեք</span>
                    <span className="text-xs">(PDF, Word, TXT, մինչև 10MB)</span>
                  </div>
                )}
              </div>
            </div>

            {uploadError && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg text-sm">
                {uploadError}
              </div>
            )}

            {uploadSuccess && (
              <div className="p-3 bg-accent/10 border border-accent/20 text-accent rounded-lg text-sm flex items-center gap-2">
                <span>✓</span> Գիրքը հաջողությամբ վերբեռնվեց
              </div>
            )}

            <button
              onClick={handleUpload}
              disabled={!selectedFile || uploading}
              className="px-6 py-2.5 bg-primary text-white rounded-xl font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {uploading && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>}
              Վերբեռնել
            </button>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold mb-6">Գրքերի ցանկ</h2>
          
          {booksLoading ? (
            <div className="flex items-center justify-center p-12">
              <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
            </div>
          ) : !books || books.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground bg-card/30 rounded-2xl border border-card-border border-dashed">
              Գրքեր չեն գտնվել
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {books.map((book: any) => (
                <BookCard key={book.id} book={book} />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function BookCard({ book }: { book: any }) {
  const [genStatus, setGenStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [genCount, setGenCount] = useState(0);
  const [genError, setGenError] = useState("");
  const generateMutation = useGenerateLessons();
  const queryClient = useQueryClient();

  const handleGenerate = () => {
    setGenStatus("loading");
    generateMutation.mutate({ bookId: book.id }, {
      onSuccess: (res: any) => {
        setGenStatus("success");
        setGenCount(res?.lessonsGenerated || res?.count || 0);
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

  return (
    <div className="p-5 rounded-2xl bg-card border border-card-border flex flex-col gap-4">
      <div className="flex items-start gap-4">
        <div className="text-3xl bg-background p-3 rounded-xl border border-card-border">
          {getFileIcon(book.mimeType)}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-lg truncate" title={book.name}>{book.name}</h3>
          <div className="flex flex-wrap items-center gap-3 mt-1 text-sm text-muted-foreground">
            <span>{formatFileSize(book.size)}</span>
            <span>•</span>
            <span>{new Date(book.createdAt).toLocaleDateString("hy-AM")}</span>
            {book.subjectId && (
              <>
                <span>•</span>
                <span className="px-2 py-0.5 bg-primary/10 text-primary rounded-md text-xs border border-primary/20">
                  Առարկա ID: {book.subjectId}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {book.subjectId ? (
        <div className="mt-2 pt-4 border-t border-card-border">
          {genStatus === "idle" && (
            <button
              onClick={handleGenerate}
              className="w-full py-2 bg-accent/10 text-accent border border-accent/20 hover:bg-accent/20 rounded-xl transition-colors font-medium text-sm flex items-center justify-center gap-2"
            >
              ✨ Գեներացնել դասեր
            </button>
          )}
          
          {genStatus === "loading" && (
            <div className="w-full py-2 bg-card rounded-xl border border-card-border flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
              Գեներացվում է...
            </div>
          )}

          {genStatus === "success" && (
            <div className="w-full py-2 bg-accent/10 rounded-xl border border-accent/20 flex items-center justify-center gap-2 text-sm text-accent">
              <span>✓</span> {genCount > 0 ? `${genCount} դաս ստեղծվեց` : "Դասեր ստեղծվեցին"}
            </div>
          )}

          {genStatus === "error" && (
            <div className="w-full py-2 bg-red-500/10 rounded-xl border border-red-500/20 flex flex-col items-center justify-center gap-1 text-sm text-red-400">
              <div>Սխալ առաջացավ</div>
              <div className="text-xs opacity-80">{genError}</div>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-2 pt-4 border-t border-card-border text-center text-xs text-muted-foreground">
          Կցված չէ որևէ առարկայի
        </div>
      )}
    </div>
  );
}
