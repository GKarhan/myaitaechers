/**
 * KT Subject Selection Screen
 *
 * KT-1.2: Entry point from the "Գিтелиqi ծarp" sidebar link.
 *
 * Shows one card per enrolled subject with a 4-state MicroNode count summary.
 * Subjects come from the authoritative enrollment chain:
 *   class_students → courses → subjects
 *
 * Mastery roll-up % is intentionally omitted (deferred to KT-1.4).
 * Clicking a subject navigates to /knowledge-tree/:subjectId.
 */

import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { useQuery } from "@tanstack/react-query";
import StudentLayout from "@/components/StudentLayout";

// KT-1.4A: coverage model
interface SubjectCard {
  subjectId:        number;
  subjectName:      string;
  totalUnits:       number;
  studiedCount:     number;
  notStudiedCount:  number;
  coveragePercent:  number | null;   // null = no curriculum units; 0 = exists but none studied
  masteredCount:    number;
  partialCount:     number;          // "weak" → Մasnaкi гиtи
  doesNotKnowCount: number;          // "in_progress" → Чgитi
  notStartedCount:  number;
}

interface SubjectsResponse {
  subjects: SubjectCard[];
}

export default function KtSubjectSelect() {
  const { user, token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!authLoading && !token) setLocation("/login");
  }, [token, authLoading, setLocation]);

  const { data, isLoading, error } = useQuery<SubjectsResponse>({
    queryKey: ["kt-subjects"],
    queryFn: async () => {
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const resp = await fetch("/api/knowledge-tree/subjects", {
        headers,
        credentials: "include",
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `HTTP ${resp.status}`);
      }
      return resp.json() as Promise<SubjectsResponse>;
    },
    enabled: !!token && !authLoading,
    staleTime: 0,
    refetchOnMount: true,
  });

  if (authLoading || isLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) return null;

  const subjects = data?.subjects ?? [];

  return (
    <StudentLayout>
      <div className="pb-16">
        {/* ── Page header ─────────────────────────────────────────────────── */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-primary to-secondary mb-2">
            🌳 Գիտելիքի ծառ
          </h1>
          <p className="text-muted-foreground text-sm">
            Ընտրեք առարկան՝ ձեր գիտելիքի ծառը դիտելու համար
          </p>
        </div>

        {/* ── Error state ──────────────────────────────────────────────────── */}
        {error && (
          <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/30 text-destructive text-sm mb-6">
            Չհաջողվեց բեռնել առարկաները: {(error as Error).message}
          </div>
        )}

        {/* ── Empty state ──────────────────────────────────────────────────── */}
        {!error && subjects.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="text-6xl mb-4">🌱</div>
            <h2 className="text-xl font-semibold mb-2">Դեռ առարկաներ չկան</h2>
            <p className="text-muted-foreground text-sm max-w-xs">
              Դուք դեռ ոչ մի դասընթացում գրանցված չեք: Հարցրեք ձեր ուսուցչին:
            </p>
          </div>
        )}

        {/* ── Subject cards ────────────────────────────────────────────────── */}
        {subjects.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {subjects.map((s) => (
              <SubjectCardView key={s.subjectId} subject={s} />
            ))}
          </div>
        )}
      </div>
    </StudentLayout>
  );
}

// ── Subject card component ────────────────────────────────────────────────────

function SubjectCardView({ subject: s }: { subject: SubjectCard }) {
  // KT-1.4A: coverage model — studiedCount / totalUnits
  const rows: { label: string; count: number; dotClass: string }[] = [
    { label: "Գիտի",                   count: s.masteredCount,    dotClass: "bg-secondary" },
    { label: "Մասնակի գիտի",           count: s.partialCount,     dotClass: "bg-accent" },
    { label: "Չգիտի",                  count: s.doesNotKnowCount, dotClass: "bg-primary" },
    { label: "Դեռ չի ուսումնասիրել", count: s.notStartedCount,  dotClass: "bg-destructive" },
  ];

  const coverageColour =
    s.coveragePercent === null ? "text-muted-foreground" :
    s.coveragePercent >= 80   ? "text-secondary" :
    s.coveragePercent >= 40   ? "text-accent" :
                                "text-primary";

  return (
    <div className="p-6 rounded-2xl bg-card border border-card-border flex flex-col gap-4">
      {/* Subject name */}
      <div>
        <h2 className="text-xl font-bold text-white">{s.subjectName}</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Գիտելիքի հանգույցներ{" "}
          <span className="text-white font-semibold">{s.totalUnits}</span>
        </p>
      </div>

      {/* KT-1.4A: Coverage summary row */}
      <div className="flex items-center justify-between bg-white/3 rounded-lg px-3 py-2">
        <span className="text-xs text-muted-foreground">Ուսումնասիրված՝</span>
        <div className="text-right">
          {s.totalUnits > 0 ? (
            <>
              <span className="text-xs text-white/70 tabular-nums">{s.studiedCount} · </span>
              <span className={`text-sm font-bold tabular-nums ${coverageColour}`}>
                {s.coveragePercent}%
              </span>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
        </div>
      </div>

      {/* 4-state distribution */}
      <div className="space-y-1.5">
        {rows.map(({ label, count, dotClass }) => (
          <div key={label} className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
              <span>{label}:</span>
            </div>
            <span className="font-semibold text-white tabular-nums">{count}</span>
          </div>
        ))}
      </div>

            {/* CTA */}
      <Link
        href={`/knowledge-tree/${s.subjectId}`}
        className="block w-full text-center py-2.5 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-sm font-semibold shadow-lg shadow-primary/20"
      >
        Բացել գիտելիքի ծառը
      </Link>
    </div>
  );
}
