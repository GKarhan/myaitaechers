import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";

interface QuizQuestion {
  id: number;
  nodeId: number | null;
  questionText: string;
  options: string[];
  correctOptionIndex: number;
  difficultyLevel: string;
  sequence: number;
}

interface QuizDetail {
  id: number;
  title: string;
  subjectId: number;
  classId: number | null;
  questionCount: number;
  difficultyMode: string;
  status: string;
  questions: QuizQuestion[];
}

interface TeacherClass {
  id: number;
  name: string;
  grade: string;
}

const DIFFICULTY_LABEL: Record<string, string> = {
  LOW: "Հեշտ",
  MEDIUM: "Միջին",
  HIGH: "Բարդ",
};

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

export default function QuizReview() {
  const { id } = useParams<{ id: string }>();
  const { token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const quizId = parseInt(id || "", 10);

  const [quiz, setQuiz]           = useState<QuizDetail | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);

  // Edit state
  const [editingId, setEditingId]           = useState<number | null>(null);
  const [editText, setEditText]             = useState("");
  const [editOptions, setEditOptions]       = useState<string[]>([]);
  const [editCorrect, setEditCorrect]       = useState(0);
  const [editDifficulty, setEditDifficulty] = useState("MEDIUM");
  const [saving, setSaving]                 = useState(false);

  // Assign state
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [classes, setClasses]                 = useState<TeacherClass[]>([]);
  const [selectedClassId, setSelectedClassId] = useState<number | null>(null);
  const [assigning, setAssigning]             = useState(false);
  const [assignError, setAssignError]         = useState<string | null>(null);
  const [assignedSuccess, setAssignedSuccess] = useState(false);

  useEffect(() => {
    if (!authLoading && !token) setLocation("/login");
  }, [token, authLoading, setLocation]);

  // Load quiz
  useEffect(() => {
    if (!token || isNaN(quizId)) return;
    setLoading(true);
    fetch(`${BASE}/api/quizzes/${quizId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setQuiz(data);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token, quizId]);

  // Load classes when assign modal opens
  useEffect(() => {
    if (!showAssignModal || !token) return;
    fetch(`${BASE}/api/teacher/classes`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setClasses(data);
      })
      .catch(() => {});
  }, [showAssignModal, token]);

  function startEdit(q: QuizQuestion) {
    setEditingId(q.id);
    setEditText(q.questionText);
    setEditOptions([...q.options]);
    setEditCorrect(q.correctOptionIndex);
    setEditDifficulty(q.difficultyLevel);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit(questionId: number) {
    if (!token) return;
    setSaving(true);
    try {
      const resp = await fetch(`${BASE}/api/quizzes/${quizId}/questions/${questionId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          questionText:       editText,
          options:            editOptions,
          correctOptionIndex: editCorrect,
          difficultyLevel:    editDifficulty,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error ?? "Save failed");
      // Update local state
      setQuiz((prev) =>
        prev
          ? {
              ...prev,
              questions: prev.questions.map((q) =>
                q.id === questionId ? { ...q, ...data } : q
              ),
            }
          : prev
      );
      setEditingId(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Պահպանումը ձախողվեց");
    } finally {
      setSaving(false);
    }
  }

  async function handleAssign() {
    if (!token || !selectedClassId) return;
    setAssigning(true);
    setAssignError(null);
    try {
      const resp = await fetch(`${BASE}/api/quizzes/${quizId}/assign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ classId: selectedClassId }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error ?? "Assignment failed");
      setAssignedSuccess(true);
      setQuiz((prev) => prev ? { ...prev, status: "ASSIGNED", classId: selectedClassId } : prev);
      setTimeout(() => setShowAssignModal(false), 1500);
    } catch (e) {
      setAssignError(e instanceof Error ? e.message : "Ուղարկումը ձախողվեց");
    } finally {
      setAssigning(false);
    }
  }

  if (authLoading || loading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !quiz) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background text-white">
        <div className="text-center">
          <div className="text-4xl mb-3">⚠️</div>
          <p className="text-muted-foreground">{error ?? "Թեստը չի գտնվել"}</p>
          <button
            onClick={() => history.back()}
            className="mt-4 px-4 py-2 rounded-xl border border-white/10 text-sm hover:bg-white/5"
          >
            ← Հետ
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background text-white pb-24">
      {/* Header */}
      <header className="border-b border-white/10 bg-card/50 backdrop-blur-lg sticky top-0 z-30">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <button
              onClick={() => history.back()}
              className="text-muted-foreground hover:text-white transition-colors shrink-0"
            >
              ← Հետ
            </button>
            <div className="font-bold text-lg truncate">{quiz.title}</div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className={`text-xs px-2.5 py-1 rounded-full border ${
              quiz.status === "ASSIGNED"
                ? "text-teal-400 border-teal-400/30 bg-teal-400/10"
                : "text-primary border-primary/30 bg-primary/10"
            }`}>
              {quiz.status === "ASSIGNED" ? "Ուղարկված" : "Ստեղծված"}
            </span>
            {quiz.status !== "CLOSED" && (
              <button
                onClick={() => setShowAssignModal(true)}
                className="px-4 py-2 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold hover:opacity-90 transition-opacity"
              >
                📤 Ուղարկել դասարանին
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 pt-8 space-y-4">
        {/* Meta */}
        <div className="flex flex-wrap gap-3 text-sm text-muted-foreground mb-2">
          <span>{quiz.questions.length} հարց</span>
          <span>·</span>
          <span>Դժվարություն՝ {quiz.difficultyMode}</span>
        </div>

        {/* Questions */}
        {quiz.questions.map((q, idx) => (
          <div
            key={q.id}
            className="bg-card/60 border border-white/10 rounded-2xl p-5"
          >
            {editingId === q.id ? (
              /* ── Edit mode ── */
              <div className="space-y-4">
                <label className="block text-xs text-muted-foreground mb-1">Հարց</label>
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  rows={3}
                  className="w-full bg-background/60 border border-white/15 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-primary/60 resize-none"
                />
                <div className="space-y-2">
                  <label className="block text-xs text-muted-foreground">Տարբերակներ (ընտրեք ճիշտը)</label>
                  {editOptions.map((opt, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <input
                        type="radio"
                        name={`correct-${q.id}`}
                        checked={editCorrect === i}
                        onChange={() => setEditCorrect(i)}
                        className="accent-primary shrink-0"
                      />
                      <input
                        value={opt}
                        onChange={(e) => {
                          const next = [...editOptions];
                          next[i] = e.target.value;
                          setEditOptions(next);
                        }}
                        className="flex-1 bg-background/60 border border-white/15 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/60"
                      />
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-4">
                  <label className="text-xs text-muted-foreground">Դժվարություն</label>
                  <select
                    value={editDifficulty}
                    onChange={(e) => setEditDifficulty(e.target.value)}
                    className="bg-background/60 border border-white/15 rounded-xl px-3 py-2 text-sm text-white focus:outline-none"
                  >
                    <option value="LOW">Հեշտ</option>
                    <option value="MEDIUM">Միջին</option>
                    <option value="HIGH">Բարդ</option>
                  </select>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => saveEdit(q.id)}
                    disabled={saving}
                    className="px-4 py-2 rounded-xl bg-primary/80 hover:bg-primary text-white text-sm font-semibold transition-colors disabled:opacity-50"
                  >
                    {saving ? "Պահպանվում է..." : "Պահպանել"}
                  </button>
                  <button
                    onClick={cancelEdit}
                    className="px-4 py-2 rounded-xl border border-white/10 text-sm hover:bg-white/5 transition-colors"
                  >
                    Չեղարկել
                  </button>
                </div>
              </div>
            ) : (
              /* ── View mode ── */
              <div>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex items-start gap-3">
                    <span className="text-xs font-mono text-primary/60 w-6 shrink-0 mt-0.5">
                      {idx + 1}.
                    </span>
                    <p className="text-sm font-medium text-white">{q.questionText}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${
                      q.difficultyLevel === "HIGH"
                        ? "text-red-400 border-red-400/30 bg-red-400/10"
                        : q.difficultyLevel === "MEDIUM"
                        ? "text-amber-400 border-amber-400/30 bg-amber-400/10"
                        : "text-teal-400 border-teal-400/30 bg-teal-400/10"
                    }`}>
                      {DIFFICULTY_LABEL[q.difficultyLevel] ?? q.difficultyLevel}
                    </span>
                    <button
                      onClick={() => startEdit(q)}
                      className="text-xs text-muted-foreground hover:text-white px-2 py-1 rounded-lg border border-white/10 hover:bg-white/5 transition-colors"
                    >
                      ✏️ Խմբագրել
                    </button>
                  </div>
                </div>
                <div className="ml-9 space-y-1.5">
                  {q.options.map((opt, i) => (
                    <div
                      key={i}
                      className={`text-sm px-3 py-2 rounded-xl border ${
                        i === q.correctOptionIndex
                          ? "border-teal-400/40 bg-teal-400/10 text-teal-300"
                          : "border-white/8 bg-background/30 text-muted-foreground"
                      }`}
                    >
                      <span className="font-mono text-xs opacity-60 mr-2">
                        {["Ա", "Բ", "Գ", "Դ"][i]}.
                      </span>
                      {opt}
                      {i === q.correctOptionIndex && (
                        <span className="ml-2 text-xs opacity-70">✓</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </main>

      {/* Assign Modal */}
      {showAssignModal && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowAssignModal(false); }}
        >
          <div className="bg-card border border-white/15 rounded-2xl w-full max-w-md p-6 shadow-2xl">
            <h2 className="text-xl font-bold mb-1">Ուղարկել դասարանին</h2>
            <p className="text-sm text-muted-foreground mb-6">
              Ընտրեք դասարանը — բոլոր աշակերտներին կուղարկվում է մեկ թեստի հանձնարարություն:
            </p>

            {assignedSuccess ? (
              <div className="text-center py-6">
                <div className="text-4xl mb-3">✅</div>
                <p className="text-teal-400 font-semibold">Թեստն ուղարկված է!</p>
              </div>
            ) : (
              <>
                <label className="block text-sm text-muted-foreground mb-2">
                  Ընտրեք դասարան *
                </label>
                {classes.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4">
                    Դասարաններ չեն գտնվում...
                  </p>
                ) : (
                  <div className="space-y-2 mb-6">
                    {classes.map((cls) => (
                      <label
                        key={cls.id}
                        className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                          selectedClassId === cls.id
                            ? "border-primary/60 bg-primary/10"
                            : "border-white/10 hover:border-white/20 hover:bg-white/5"
                        }`}
                      >
                        <input
                          type="radio"
                          name="classSelect"
                          checked={selectedClassId === cls.id}
                          onChange={() => setSelectedClassId(cls.id)}
                          className="accent-primary"
                        />
                        <span className="font-medium text-sm">{cls.name}</span>
                        {cls.grade && (
                          <span className="text-xs text-muted-foreground ml-auto">
                            {cls.grade} կարգ
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                )}

                {assignError && (
                  <p className="text-sm text-red-400 mb-4">{assignError}</p>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={handleAssign}
                    disabled={assigning || !selectedClassId}
                    className="flex-1 py-3 rounded-xl bg-gradient-to-r from-primary to-secondary text-white font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-40"
                  >
                    {assigning ? "Ուղարկվում է..." : "📤 Ուղարկել"}
                  </button>
                  <button
                    onClick={() => setShowAssignModal(false)}
                    className="px-5 py-3 rounded-xl border border-white/10 text-sm hover:bg-white/5 transition-colors"
                  >
                    Չեղարկել
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
