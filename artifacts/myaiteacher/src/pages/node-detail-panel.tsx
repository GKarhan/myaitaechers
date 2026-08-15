/**
 * KT-1.5 — MicroNode Detail Panel (Evidence Transparency)
 *
 * Read-only. Loaded lazily on first click; 0 DB writes on open/close.
 * Opened by lessonNodeId (canonical curriculum identity).
 */

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";

// ── Types ─────────────────────────────────────────────────────────────────────

interface NodeDetailSubject { id: number; name: string }
interface NodeDetailLesson  { id: number; title: string }
interface NodeDetailTopic   { id: number; title: string }

interface NodeDetailLearnerState {
  masteryScore:    number;
  confidenceScore: number | null;
  masteryLevel:    "mastered" | "weak" | "in_progress" | "not_started";
}

interface NodeDetailEvidenceItem {
  id:         number;
  eventType:  string;
  wasCorrect: boolean | null;
  source:     "quiz" | "lesson";
  quizId?:    number;
  quizTitle?: string | null;
  createdAt:  string;
}

interface NodeDetailEvidenceSummary {
  total:      number;
  fromQuiz:   number;
  fromLesson: number;
}

export interface NodeDetail {
  lessonNodeId:      number;
  title:             string;
  learningObjective: string | null;
  targetBloomLevel:  number | null;
  sourcePage:        number | null;

  subject: NodeDetailSubject;
  lesson:  NodeDetailLesson;
  topic:   NodeDetailTopic | null;

  learnerState:    NodeDetailLearnerState;
  nextReviewAt:    string | null;

  evidenceSummary: NodeDetailEvidenceSummary;
  recentEvidence:  NodeDetailEvidenceItem[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type MasteryLevel4 = "mastered" | "weak" | "in_progress" | "not_started";

function masteryConfig(level: MasteryLevel4) {
  switch (level) {
    case "mastered":    return { label: "Գիտի",                 colour: "text-secondary",   bg: "bg-secondary/10 border-secondary/20"   };
    case "weak":        return { label: "Մասնակի գիտի",         colour: "text-accent",      bg: "bg-accent/10 border-accent/20"         };
    case "in_progress": return { label: "Չգիտի",               colour: "text-primary",     bg: "bg-primary/10 border-primary/20"       };
    case "not_started": return { label: "Դեռ չի ուսումնասիրել", colour: "text-destructive", bg: "bg-destructive/10 border-destructive/20" };
  }
}

function armenianMasteryLabel(level: MasteryLevel4): string {
  switch (level) {
    case "mastered":    return "Գիտի";
    case "weak":        return "Մասնակի գիտի";
    case "in_progress": return "Չգիտի";
    case "not_started": return "Դեռ չի ուսումնասիրել";
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("hy-AM", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });
}

// ── Panel component ───────────────────────────────────────────────────────────

interface NodeDetailPanelProps {
  lessonNodeId: number | null;
  onClose: () => void;
}

export function NodeDetailPanel({ lessonNodeId, onClose }: NodeDetailPanelProps) {
  const { token } = useAuth();
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape key closes the panel
  useEffect(() => {
    if (!lessonNodeId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [lessonNodeId, onClose]);

  // Focus the close button when panel opens (a11y)
  useEffect(() => {
    if (lessonNodeId) closeRef.current?.focus();
  }, [lessonNodeId]);

  const { data, isLoading, error } = useQuery<NodeDetail>({
    queryKey: ["node-detail", lessonNodeId],
    queryFn: async ({ signal }) => {
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const resp = await fetch(`/api/knowledge-tree/nodes/${lessonNodeId}`, {
        signal, headers, credentials: "include",
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${resp.status}`);
      }
      return resp.json() as Promise<NodeDetail>;
    },
    enabled: !!token && !!lessonNodeId,
    staleTime: 60_000,
  });

  // Hidden when nothing selected
  const visible = !!lessonNodeId;

  return (
    <>
      {/* Backdrop (mobile) */}
      {visible && (
        <div
          className="fixed inset-0 bg-black/40 z-40 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Panel — slide in from right */}
      <aside
        className={`
          fixed top-0 right-0 h-full z-50
          w-full max-w-sm lg:max-w-md
          bg-card border-l border-card-border
          flex flex-col
          transform transition-transform duration-300 ease-in-out
          ${visible ? "translate-x-0" : "translate-x-full"}
        `}
        aria-label="Гітеліки hanguyts manatramb"
        role="complementary"
      >
        {/* ── Panel header ──────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-card-border shrink-0">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Гітеліки hanguyts
          </span>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Кnкel"
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/10 text-muted-foreground hover:text-white transition-colors"
          >
            ✕
          </button>
        </div>

        {/* ── Scrollable body ───────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

          {/* Loading */}
          {isLoading && (
            <div className="flex items-center justify-center py-16">
              <div className="w-7 h-7 border-4 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="ml-3 text-sm text-muted-foreground">Bернвум é…</span>
            </div>
          )}

          {/* Error */}
          {error && !isLoading && (
            <div className="py-10 text-center text-sm text-destructive">
              Տeghekutyan bern banol hnaravar cher: {(error as Error).message}
            </div>
          )}

          {/* Content */}
          {data && !isLoading && <PanelContent data={data} />}
        </div>
      </aside>
    </>
  );
}

// ── Panel body ────────────────────────────────────────────────────────────────

function PanelContent({ data }: { data: NodeDetail }) {
  const mCfg = masteryConfig(data.learnerState.masteryLevel);

  return (
    <>
      {/* ── Node title + hierarchy ─────────────────────────────────────── */}
      <section>
        <h2 className="text-base font-bold text-white leading-snug mb-2">
          {data.title}
        </h2>

        {/* Hierarchy breadcrumb */}
        <div className="text-xs text-muted-foreground space-y-0.5">
          <div>{data.subject.name}</div>
          <div className="pl-2">→ <span className="text-white/60">{data.lesson.title}</span></div>
          {data.topic && (
            <div className="pl-4">→ <span className="text-white/60">{data.topic.title}</span></div>
          )}
        </div>

        {/* Optional metadata pills */}
        <div className="flex flex-wrap gap-1.5 mt-2">
          {data.targetBloomLevel && (
            <span className="px-2 py-0.5 rounded text-xs bg-white/5 text-muted-foreground border border-card-border">
              Bloom {data.targetBloomLevel}
            </span>
          )}
          {data.sourcePage && (
            <span className="px-2 py-0.5 rounded text-xs bg-white/5 text-muted-foreground border border-card-border">
              Ejh {data.sourcePage}
            </span>
          )}
        </div>
      </section>

      {/* ── Learning objective ─────────────────────────────────────────── */}
      {data.learningObjective && (
        <section className="rounded-xl border border-card-border bg-card/50 px-4 py-3">
          <div className="text-xs font-semibold text-primary mb-1.5">🎯 Ousumnman npatok</div>
          <p className="text-sm text-white/80 leading-relaxed">{data.learningObjective}</p>
        </section>
      )}

      {/* ── Learner state ──────────────────────────────────────────────── */}
      <section className="rounded-xl border border-card-border bg-card/50 px-4 py-3 space-y-3">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          Yoоuratsneri vichak
        </div>

        {/* State badge */}
        <div className="flex items-center gap-3">
          <span className={`px-3 py-1 rounded-full text-xs font-semibold border ${mCfg.bg} ${mCfg.colour}`}>
            {armenianMasteryLabel(data.learnerState.masteryLevel)}
          </span>
        </div>

        {/* Mastery score */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Youratsoom</span>
          <span className="text-sm font-bold text-white">{data.learnerState.masteryScore}%</span>
        </div>

        {/* Confidence */}
        {data.learnerState.confidenceScore !== null && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-muted-foreground">Gnahatkman vstahelioutyoun</span>
              <span className="text-sm font-semibold text-white">{data.learnerState.confidenceScore}%</span>
            </div>
            <div className="w-full bg-white/10 rounded-full h-1.5">
              <div
                className="h-1.5 rounded-full bg-gradient-to-r from-primary to-secondary transition-all"
                style={{ width: `${data.learnerState.confidenceScore}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
              «츁ouys é talis, te yorkan bavarar apatsuyts ouni hamakargy ays gnahatkman hamar»
            </p>
          </div>
        )}

        {/* Next review */}
        {data.nextReviewAt && (
          <div className="flex items-center justify-between pt-1 border-t border-card-border">
            <span className="text-xs text-muted-foreground">Hajord krknoutyoun</span>
            <span className="text-xs font-medium text-accent">{formatDate(data.nextReviewAt)}</span>
          </div>
        )}
      </section>

      {/* ── Evidence summary ───────────────────────────────────────────── */}
      <section className="rounded-xl border border-card-border bg-card/50 px-4 py-3">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Apatsouytcner
        </div>

        {data.evidenceSummary.total === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            «Ays hangouyts'i hamar derrr gnahatkman apatsuyts chka»
          </p>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Entameny</span>
              <span className="text-sm font-bold text-white">{data.evidenceSummary.total}</span>
            </div>
            {data.evidenceSummary.fromQuiz > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Testeric'</span>
                <span className="text-xs font-semibold text-white">{data.evidenceSummary.fromQuiz}</span>
              </div>
            )}
            {data.evidenceSummary.fromLesson > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Dasi yntatsqoum</span>
                <span className="text-xs font-semibold text-white">{data.evidenceSummary.fromLesson}</span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── Recent evidence ────────────────────────────────────────────── */}
      {data.recentEvidence.length > 0 && (
        <section>
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            Verjin apatsouytcner
          </div>
          <div className="space-y-2">
            {data.recentEvidence.map((ev) => (
              <EvidenceRow key={ev.id} ev={ev} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function EvidenceRow({ ev }: { ev: NodeDetailEvidenceItem }) {
  const isQuiz    = ev.source === "quiz";
  const correct   = ev.wasCorrect === true;
  const incorrect = ev.wasCorrect === false;

  return (
    <div className="rounded-lg border border-card-border bg-card/30 px-3 py-2.5">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs text-muted-foreground">{formatDate(ev.createdAt)}</span>
        <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
          isQuiz ? "bg-primary/10 text-primary" : "bg-accent/10 text-accent"
        }`}>
          {isQuiz ? "Test" : "Das"}
        </span>
        {ev.wasCorrect !== null && (
          <span className={`text-xs font-semibold ${correct ? "text-secondary" : "text-destructive"}`}>
            {correct ? "✓ Chisht" : "✗ Skhalkh"}
          </span>
        )}
      </div>

      {/* Quiz source label */}
      {isQuiz && ev.quizTitle && (
        <p className="text-xs text-muted-foreground">
          Agbyour՝ «{ev.quizTitle}»
        </p>
      )}
    </div>
  );
}
