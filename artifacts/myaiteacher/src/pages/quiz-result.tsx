import { type AssessmentView } from "@/components/NodeAssessmentBadge";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { useAuth } from "@/lib/auth";
import { formatAnswer, STUDENT_RESULTS_FINISH_PATH } from "@/lib/quiz-result-t2";

type QuestionResult = {
  questionId: number;
  questionText: string;
  options: string[];
  correctOptionIndex: number;
  selectedOptionIndex: number;
  isCorrect: boolean;
  sequence: number;
  attemptSequence?: number;
  nodeId: number | null;
  nodeTitle: string | null;
  feedback: {
    whyCorrect: string | null;
    whyWrong: string | null;
    solutionExplanation?: string | null;
  };
};

type AttemptHistory = {
  attemptId: number;
  attemptSequence: number;
  totalCorrect: number;
  totalQuestions: number;
  scorePercent: number | null;
  completedAt?: string | null;
  cumulativeCorrect?: number;
  cumulativeTotal?: number;
  cumulativePercent?: number;
};

type SessionProjection = {
  id: number;
  status: string;
  masteredNodeIds: number[];
  learningNodeIds: number[];
  knowsCount: number;
  practiceNodeIds?: number[];
  supportNodeIds?: number[];
  supportCount?: number;
  learningCount: number;
};

type ProgressTotals = {total:number;correct:number;incorrect:number;unanswered:number;percent:number};
type LearningProgress = {initial:ProgressTotals;current:ProgressTotals;remainingQuestionIds:number[];
  nodes:Array<{nodeId:number;initial:ProgressTotals;current:ProgressTotals;practiceComplete:boolean;lastAttempt:{attemptId:number;attemptSequence:number;total:number;correct:number}|null}>;
  history:Array<{attemptId:number;attemptSequence:number;total:number;correct:number;nodeIds:number[]}>};
type Result = {
  overviewQuestions?:QuestionResult[];
  creationContext?:{classId:number|null;subjectId:number;nodeIds:number[];lessonIds:number[]};
  learningProgress?: LearningProgress;
  assessmentConfig?: {purpose:string;context:string}|null;
  attemptId?: number;
  totalCorrect: number;
  totalQuestions: number;
  scorePercent: number;
  practiceScorePercent?:number;
  practiceTotalCorrect?:number;
  practiceTotalQuestions?:number;
  questions: QuestionResult[];
  nodeBreakdown?: Array<{ nodeId: number; nodeTitle: string; percent: number; masteryLevel: string; assessment?:AssessmentView }>;
  recommendations?: Array<{ nodeId: number; nodeTitle: string; prerequisiteBlocked: boolean }>;
  session?: SessionProjection | null;
  attempts?: AttemptHistory[];
  attemptHistory?: AttemptHistory[];
  initialScorePercent?: number;
};

const BASE = "https://myaitaechers-api.onrender.com";

export default function QuizResult() {
  const { id } = useParams<{ id: string }>();
  const search = useSearch();
  const { token, user } = useAuth();
  const [, setLocation] = useLocation();
  const params = new URLSearchParams(search);
  const studentId = params.get("studentId");
  const historyAttemptId = params.get("attemptId");
  const isTeacherView = !!studentId && user?.role === "teacher";
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTeacherSequence,setSelectedTeacherSequence] = useState<number|null>(null);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    if (!token || !id || !user) return;
    const controller = new AbortController();
    const historyQuery = !isTeacherView && historyAttemptId ? `?attemptId=${historyAttemptId}` : "";
    const url = isTeacherView
      ? `${BASE}/api/quizzes/${id}/results/${studentId}`
      : `${BASE}/api/quizzes/${id}/my-result${historyQuery}`;
    setLoading(true);
    fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Արդյունքը չի գտնվել");
        return payload as Result;
      })
      .then(setResult)
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") setError(reason.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [id, token, user, studentId, historyAttemptId, isTeacherView]);

  const visibleQuestions = useMemo(() => {
    if(!result)return [];
    if(isTeacherView && selectedTeacherSequence!==null)return result.questions.filter(q=>q.attemptSequence===selectedTeacherSequence);
    if(!isTeacherView && historyAttemptId)return result.questions;
    return [...(result.overviewQuestions??result.questions)].sort((a,b)=>a.sequence-b.sequence);
  },[result,isTeacherView,selectedTeacherSequence,historyAttemptId]);

  async function finishSession() {
    if (!token || !id || finishing) return;
    setFinishing(true);
    try {
      const response = await fetch(`${BASE}/api/quizzes/${id}/session/finish`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("finish_failed");
      setLocation(STUDENT_RESULTS_FINISH_PATH);
    } finally {
      setFinishing(false);
    }
  }

  if (loading) return <div className="min-h-screen grid place-items-center bg-background"><div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  if (error || !result) {
    return <div className="min-h-screen grid place-items-center bg-background text-white"><div className="text-center space-y-4"><p>{error ?? "Արդյունքը չի գտնվել"}</p><Link href={STUDENT_RESULTS_FINISH_PATH} className="text-primary">← Հետ</Link></div></div>;
  }

  const backHref = isTeacherView ? "/teacher?section=quizzes" : STUDENT_RESULTS_FINISH_PATH;
  const teacherAttempts = result.attemptHistory ?? [];
  const progress=result.learningProgress;
  const selectedHistory=isTeacherView?progress?.history.find(h=>h.attemptSequence===(selectedTeacherSequence??progress.history.at(-1)?.attemptSequence)):progress?.history.find(h=>h.attemptId===result.attemptId);
  const isOverview=isTeacherView?selectedTeacherSequence===null:!historyAttemptId;
  const selectedCorrect=isOverview&&progress?progress.current.correct:selectedHistory?.correct??result.practiceTotalCorrect??result.totalCorrect;
  const selectedTotal=isOverview&&progress?progress.current.total:selectedHistory?.total??result.practiceTotalQuestions??result.totalQuestions;
  const displayedScore=selectedTotal?Math.round(selectedCorrect/selectedTotal*100):0;
  const completeNodes=progress?.nodes.filter(n=>n.practiceComplete).length??0;
  const partialNodes=progress?.nodes.filter(n=>n.current.correct>0&&!n.practiceComplete).length??0;
  const unknownNodes=progress?.nodes.filter(n=>n.current.correct===0).length??0;
  const scoreColor = displayedScore >= 80 ? "text-teal-400" : displayedScore >= 50 ? "text-amber-400" : "text-red-400";

  return (
    <div className="min-h-screen bg-background text-white">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-background/90 backdrop-blur px-4 py-3">
        <div className="max-w-2xl mx-auto flex items-center">
          <Link href={backHref} className="text-sm text-muted-foreground hover:text-white">← Հետ</Link>
          <h1 className="flex-1 text-center text-sm font-semibold">Արդյունքներ</h1>
          <span className="w-10" />
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-8">
        <section className="rounded-3xl border border-white/10 bg-card/60 p-8 text-center">
          <div className={`text-5xl font-black ${scoreColor}`}>{displayedScore}%</div>
          {result.assessmentConfig && <p className="text-sm text-muted-foreground mb-2">{isOverview?"Ամբողջ թեստի ընթացիկ արդյունքը":"Ընտրված փորձի արդյունքը"}</p>}
          <p className="mt-2 text-white/80">🟢 {selectedCorrect} ճիշտ · 🔴 {selectedTotal-selectedCorrect} սխալ · {selectedTotal} հարց</p>
          {!isOverview && selectedHistory && <p className="mt-2 text-sm">Փորձ {selectedHistory.attemptSequence} · {selectedHistory.attemptSequence>1?"Վարժանք":result.assessmentConfig?.purpose==="CHECK"?"Ստուգում":"Ուսուցողական"}</p>}
          {progress && <p className="text-sm text-muted-foreground mt-2">{(isOverview?progress.nodes.map(n=>n.nodeId):selectedHistory?.nodeIds ?? []).map(id=>result.nodeBreakdown?.find(n=>n.nodeId===id)?.nodeTitle).join(" · ")}</p>}
        </section>

        {isTeacherView && teacherAttempts.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/75">Փորձերի պատմություն</h2>
            <div className="overflow-x-auto rounded-2xl border border-white/10">
              <table className="w-full text-sm text-left">
                <thead className="bg-card/60 text-white/75"><tr>
                  <th className="p-3">Փորձ</th><th className="p-3">Արդյունքներ</th><th className="p-3">Վարժանքի ընդհանուր առաջընթաց</th>
                </tr></thead>
                <tbody>{teacherAttempts.map(attempt => (
                  <tr key={attempt.attemptId} className="border-t border-white/10">
                    <td className="p-3"><button className="text-primary underline" onClick={()=>setSelectedTeacherSequence(attempt.attemptSequence)}>Փորձ {attempt.attemptSequence} · {attempt.attemptSequence>1?"Վարժանք":result.assessmentConfig?.purpose==="LEARNING"?"Ուսուցողական":"Ստուգում"}</button></td>
                    <td className="p-3">{attempt.totalCorrect}/{attempt.totalQuestions} · {attempt.scorePercent}%</td>
                    <td className="p-3 text-teal-300">{attempt.cumulativeCorrect}/{attempt.cumulativeTotal} · {attempt.cumulativePercent}%</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        )}

        {progress && <section className="rounded-3xl border border-primary/20 bg-card/60 p-6 space-y-4">
          <h2 className="font-bold">{isTeacherView?"Սովորողի առաջընթացը այս թեստում":"Իմ առաջընթացը այս թեստում"}</h2>
          <p>Սկզբնական արդյունք՝ 🟢 {progress.initial.correct} ճիշտ · 🔴 {progress.initial.incorrect} սխալ · {progress.initial.percent}%</p>
          <p>Ընթացիկ արդյունք՝ 🟢 {progress.current.correct} ճիշտ · 🔴 {progress.current.incorrect} սխալ · {progress.current.percent}%</p>
          <p className="text-sm text-muted-foreground">Յուրաքանչյուր հարցի վերջին ավարտված պատասխանը՝ ամբողջ թեստի շրջանակում։</p>
          <div className="grid sm:grid-cols-3 gap-3 text-sm">
            <p>Բոլոր հարցերը ճիշտ՝ <b>{completeNodes}</b> հանգույց</p>
            <p>Մի մասը ճիշտ՝ <b>{partialNodes}</b> հանգույց</p>
            <p>Բոլորը սխալ՝ <b>{unknownNodes}</b> հանգույց</p>
          </div>
          <p className="text-sm">Լրացուցիչ աջակցության կարիք՝ {result.nodeBreakdown?.filter(n=>n.assessment?.status==="NEEDS_SUPPORT").length??0}</p>
          {!isTeacherView && result.session?.status==="ACTIVE" && progress.remainingQuestionIds.length>0 && <Link href={`/quiz/${id}/take`} className="block rounded-xl bg-primary px-4 py-3 text-center font-bold">Շարունակել սովորել · {progress.remainingQuestionIds.length} հարց</Link>}
          {progress.remainingQuestionIds.length===0 && <p className="text-teal-300">Բոլոր սխալներն ուղղված են։ Վարժանքն ավարտված է։</p>}
          {!isTeacherView && result.session && <button disabled={finishing} onClick={finishSession} className="rounded-xl border px-4 py-2">{finishing?"Ավարտվում է...":"Ավարտել"}</button>}

        </section>}

        {!isTeacherView && (result.attempts?.length ?? 0) > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/75">Փորձերի պատմություն</h2>
            <div className="grid gap-2">
              {result.attempts!.map((attempt) => (
                <Link
                  key={attempt.attemptId}
                  href={`/quiz/${id}/result?attemptId=${attempt.attemptId}`}
                  className={`rounded-xl border px-4 py-3 flex items-center justify-between ${attempt.attemptId === result.attemptId ? "border-primary/50 bg-primary/10" : "border-white/10 bg-card/30"}`}
                >
                  <span className="text-sm font-medium">Փորձ {attempt.attemptSequence} · {attempt.attemptSequence>1?"Վարժանք":result.assessmentConfig?.purpose==="LEARNING"?"Ուսուցողական":"Ստուգում"} · {attempt.totalQuestions} հարց</span>
                  <span className="text-sm text-muted-foreground">{attempt.totalCorrect}/{attempt.totalQuestions} · {attempt.scorePercent ?? 0}%</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {!isOverview && <button className="text-primary underline" onClick={()=>isTeacherView?setSelectedTeacherSequence(null):setLocation(`/quiz/${id}/result`)}>Դիտել ամբողջ թեստը</button>}
        {isTeacherView && progress?.remainingQuestionIds.length===0 && result.creationContext && <section>
          <Link className="inline-block rounded-xl bg-primary px-5 py-3" href={`/teacher?classId=${result.creationContext.classId??params.get("classId")??""}&subjectId=${result.creationContext.subjectId}&createQuiz=1&lessonIds=${result.creationContext.lessonIds.join(",")}&nodeIds=${result.creationContext.nodeIds.join(",")}`}>Ստեղծել նոր ստուգում</Link>
        </section>}
        {result.nodeBreakdown && result.nodeBreakdown.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/75">Գիտելիքի հանգույցներ</h2>
            {result.nodeBreakdown.map(node=>{
              const item=progress?.nodes.find(n=>n.nodeId===node.nodeId);
              const selected=visibleQuestions.filter(q=>q.nodeId===node.nodeId);
              return <div key={node.nodeId} className="rounded-xl border border-white/10 bg-card/30 p-4 space-y-2">
                <h3 className="font-semibold">{node.nodeTitle}</h3>
                {!isOverview && selected.length>0 && <p>Ընտրված փորձ՝ 🟢 {selected.filter(q=>q.isCorrect).length} ճիշտ · 🔴 {selected.filter(q=>!q.isCorrect).length} սխալ</p>}
                {item && <><p>Սկզբում՝ {item.initial.correct}/{item.initial.total} · {item.initial.percent}%</p><p>Ընթացիկ՝ 🟢 {item.current.correct} ճիշտ · 🔴 {item.current.incorrect} սխալ · {item.current.percent}%</p>
                  <p className={item.practiceComplete?"text-teal-300":"text-amber-300"}>{item.practiceComplete?(node.assessment?.status==="SUCCESS"?"Ամբողջությամբ յուրացված հանգույցներ":"Վարժանքն ավարտված է։"):"Շարունակել սովորել"}</p></>}
                {node.assessment?.status==="NEEDS_SUPPORT" && <p className="text-rose-300">Լրացուցիչ աջակցության կարիք։ Դիտել բացատրությունները և դիմել ուսուցչին։</p>}

              </div>;
            })}
          </section>
        )}

        <section className="space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/75">{isOverview?"Ամբողջ թեստի պատասխանները":"Ընտրված փորձի պատասխանները"} · {visibleQuestions.length} հարց</h2>
          {visibleQuestions.length === 0 && <p className="text-sm text-muted-foreground">Այս դիտման համար հարց չկա։</p>}
          {visibleQuestions.map((question, index) => (
            <article key={question.questionId} className={`rounded-2xl border p-5 ${question.isCorrect ? "border-teal-400/20 bg-teal-400/5" : "border-red-400/20 bg-red-400/5"}`}>
              <p className="text-sm font-semibold leading-relaxed">{index + 1}. {question.questionText}</p>
              {question.nodeTitle && <p className="text-xs text-muted-foreground mt-1">{question.nodeTitle}</p>}
              <div className="mt-4 grid gap-2">
                <p className="text-sm">Ձեր պատասխանը՝ <span className={question.isCorrect ? "text-teal-300" : "text-red-300"}>{formatAnswer(question.options, question.selectedOptionIndex)}</span></p>
                {!question.isCorrect && <p className="text-sm">Ճիշտ պատասխանը՝ <span className="text-teal-300">{formatAnswer(question.options, question.correctOptionIndex)}</span></p>}
                {question.feedback.whyWrong && <p className="text-sm text-white/70">{question.feedback.whyWrong}</p>}
                {question.feedback.whyCorrect && <p className="text-sm text-white/70">{question.feedback.whyCorrect}</p>}
                {question.feedback.solutionExplanation && <div className="mt-2 rounded-xl border border-primary/20 bg-primary/5 p-3"><p className="text-xs font-semibold text-primary">Կարճ լուծում</p><p className="text-sm text-white/70 mt-1 whitespace-pre-wrap">{question.feedback.solutionExplanation}</p></div>}
              </div>
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}