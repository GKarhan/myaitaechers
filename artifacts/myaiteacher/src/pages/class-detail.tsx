import { useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { useAuth } from "@/lib/auth";
import { useGetAdminClassDetail, getGetAdminClassDetailQueryKey } from "@workspace/api-client-react";

export default function ClassDetail() {
  const { token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { id } = useParams<{ id: string }>();
  const classId = parseInt(id || "", 10);

  useEffect(() => {
    if (!authLoading && !token) setLocation("/login");
  }, [token, authLoading, setLocation]);

  const { data: detail, isLoading } = useGetAdminClassDetail(classId, {
    query: {
      queryKey: getGetAdminClassDetailQueryKey(classId),
      enabled: !!token && !isNaN(classId),
    },
  });

  if (authLoading || isLoading) {
    return (
      <div className="min-h-screen bg-[#0F172A] flex items-center justify-center">
        <div className="text-white/50 text-sm animate-pulse">Բեռնվում է...</div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="min-h-screen bg-[#0F172A] flex items-center justify-center">
        <div className="text-white/50 text-sm">Դասարանը չի գտնվել</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0F172A] text-white">
      {/* ── Header ── */}
      <header className="border-b border-white/10 px-6 py-4 flex items-center gap-4">
        <button
          onClick={() => setLocation("/admin")}
          className="text-sm text-muted-foreground hover:text-white transition-colors flex items-center gap-1.5"
        >
          ← Դասարաններ
        </button>
        <span className="text-white/20">/</span>
        <h1 className="font-semibold text-white">{detail.name}</h1>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8 space-y-8">

        {/* ── Title block ── */}
        <div className="bg-card/50 border border-white/10 rounded-2xl px-6 py-5">
          <p className="text-xs text-muted-foreground uppercase tracking-widest mb-1">Դասարանի մանրամասներ</p>
          <h2 className="text-2xl font-bold text-white">{detail.name}</h2>
          {detail.grade && (
            <p className="text-sm text-muted-foreground mt-1">{detail.grade} կարգ</p>
          )}
        </div>

        {/* ── Teacher section ── */}
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-[#6366F1] mb-3">
            Ուսուցիչներ
          </h3>
          <div className="bg-card/50 border border-white/10 rounded-2xl px-5 py-4 flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-[#6366F1]/20 flex items-center justify-center text-[#6366F1] font-bold text-lg flex-shrink-0">
              {detail.teacher.fullName.charAt(0)}
            </div>
            <div className="min-w-0">
              <div className="font-medium text-white">{detail.teacher.fullName}</div>
              {detail.teacher.email && (
                <div className="text-xs text-muted-foreground mt-0.5">{detail.teacher.email}</div>
              )}
              {detail.teacher.subjects && detail.teacher.subjects.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {detail.teacher.subjects.map((s) => (
                    <span
                      key={s}
                      className="text-xs px-2 py-0.5 rounded-full bg-[#14B8A6]/15 text-[#14B8A6] border border-[#14B8A6]/25"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ── Students section ── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-[#14B8A6]">
              Աշակերտների ցանկ
            </h3>
            <span className="text-xs text-muted-foreground border border-white/10 rounded-full px-2.5 py-0.5">
              {detail.students.length} հատ
            </span>
          </div>

          {detail.students.length === 0 ? (
            <div className="bg-card/50 border border-white/10 rounded-2xl px-5 py-8 text-center text-muted-foreground text-sm">
              Աշակերտներ չկան
            </div>
          ) : (
            <div className="bg-card/50 border border-white/10 rounded-2xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 bg-white/5 text-muted-foreground text-xs uppercase tracking-wide">
                    <th className="text-left px-5 py-3">Անուն, ազգանուն</th>
                    <th className="text-left px-5 py-3">Էլ. հասցե</th>
                    <th className="text-left px-5 py-3">Տարիք</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.students.map((s, i) => (
                    <tr
                      key={s.id}
                      className={`border-b border-white/5 ${i % 2 === 0 ? "" : "bg-white/[0.02]"} hover:bg-white/5 transition-colors`}
                    >
                      <td className="px-5 py-3 font-medium text-white">{s.fullName}</td>
                      <td className="px-5 py-3 text-muted-foreground">{s.email || "—"}</td>
                      <td className="px-5 py-3 text-muted-foreground">{(s as any).age ? `${(s as any).age} տ.` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

      </main>
    </div>
  );
}
