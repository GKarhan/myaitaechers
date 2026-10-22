import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { BalloonQuizGame } from "@/components/BalloonQuizGame";
import { invalidateKnowledgeTreeQueries } from "@/lib/knowledge-tree-cache";

type TakeQuestion = {
  id: number;
  questionText: string;
  options: string[];
  difficultyLevel: string;
  interactionType: string | null;
  sequence: number;
};

type ReviewCard={questionId:number;questionText:string;correctAnswer:string|null;selectedAnswer:string|null;whyWrong:string|null;explanation:string|null};
type TakeData = {
  learningPhase?:"INITIAL"|"PRACTICE"|"FINAL"|"COMPLETE"|null;
  reviewCards?:ReviewCard[];
  assessmentConfig?: { purpose:string; context:string } | null;
  assignmentId: number;
  sessionId: number;
  attemptId: number;
  attemptSequence: number;
  questions: TakeQuestion[];
  finalizedAnswers: Array<Feedback & {
    questionId: number;
    selectedOptionIndex: number;
  }>;
};

type Feedback = {
  deferred?: boolean;
  isCorrect: boolean | null;
  selectedOptionIndex: number;
  correctOptionIndex: number | null;
  selectedAnswer: string | null;
  correctAnswer: string | null;
  feedback: {
    whyCorrect: string | null;
    whyWrong: string | null;
    solutionExplanation: string | null;
  };
};

const BASE = "https://myaitaechers-api.onrender.com";
const OPTION_LABELS = ["Ա", "Բ", "Գ", "Դ", "Ե", "Զ"];

export default function QuizTake() {
  const { id } = useParams<{ id: string }>();
  const { token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const quizId = Number(id);
  const [data, setData] = useState<TakeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [feedback, setFeedback] = useState<Record<number, Feedback>>({});
  const [reviewIndex,setReviewIndex]=useState(0);
  const [practiceMode,setPracticeMode]=useState<"test"|"game"|null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !token) setLocation("/login");
  }, [authLoading, token, setLocation]);

  useEffect(() => {
    if (!token || !Number.isInteger(quizId)) return;
    const controller = new AbortController();
    setLoading(true);
    fetch(`${BASE}/api/quizzes/${quizId}/take`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) {
          if (payload.error === "SESSION_HAS_NO_LEARNING_SCOPE") {
            setLocation(`/quiz/${quizId}/result`);
            return null;
          }
          throw new Error(payload.error ?? "Թեստը չի հաջողվել բացել");
        }
        return payload as TakeData;
      })
      .then((payload) => {
        if (!payload) return;
        setData(payload);
        setCurrentIndex(0);
        let savedMode:string|null=null;
        try{savedMode=localStorage.getItem(`quiz-practice-mode:${payload.attemptId}`);}catch{}
        setPracticeMode(payload.learningPhase==="PRACTICE" && (savedMode==="test"||savedMode==="game")?savedMode:null);
        let savedReview=0;
        try{savedReview=Number(localStorage.getItem(`quiz-review:${payload.attemptId}`)??0);}catch{}
        setReviewIndex(Math.max(0,Math.min(Number.isFinite(savedReview)?savedReview:0,payload.reviewCards?.length??0)));
        setAnswers(Object.fromEntries(
          (payload.finalizedAnswers ?? []).map((answer) => [
            answer.questionId,
            answer.selectedOptionIndex,
          ]),
        ));
        setFeedback(Object.fromEntries(
          (payload.finalizedAnswers ?? []).map((answer) => [
            answer.questionId,
            answer,
          ]),
        ));
      })
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") setError(reason.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [quizId, token, setLocation]);

  const question = data?.questions[currentIndex] ?? null;
  const currentFeedback = question ? feedback[question.id] : null;
  const progress = data ? Math.round(((currentIndex + (currentFeedback ? 1 : 0)) / data.questions.length) * 100) : 0;
  const allCommitted = useMemo(
    () => !!data && data.questions.every((item) => feedback[item.id] != null),
    [data, feedback],
  );
  const primaryExplanation = currentFeedback
    ? currentFeedback.isCorrect
      ? currentFeedback.feedback.whyCorrect
        ?? currentFeedback.feedback.solutionExplanation
      : currentFeedback.feedback.whyWrong
        ?? currentFeedback.feedback.solutionExplanation
        ?? currentFeedback.feedback.whyCorrect
    : null;

  async function commitAnswer(optionIndex: number) {
    if (!token || !data || !question || currentFeedback || checking) return;
    setChecking(true);
    setSubmitError(null);
    try {
      const response = await fetch(
        `${BASE}/api/quizzes/${quizId}/attempts/${data.attemptId}/feedback`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            questionId: question.id,
            selectedOptionIndex: optionIndex,
          }),
        },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Պատասխանը չհաջողվեց ստուգել");
      const finalized = payload as Feedback;
      setAnswers((current) => ({
        ...current,
        [question.id]: finalized.selectedOptionIndex,
      }));
      setFeedback((current) => ({ ...current, [question.id]: finalized }));
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : "Պատասխանը չհաջողվեց ստուգել");
    } finally {
      setChecking(false);
    }
  }

  async function submitAttempt() {
    if (!token || !data || !allCommitted || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await fetch(`${BASE}/api/quizzes/${quizId}/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          attemptId: data.attemptId,
          answers: data.questions.map((item) => ({
            questionId: item.id,
            selectedOptionIndex: answers[item.id],
          })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? payload.error ?? "Փորձը չհաջողվեց գրանցել");
      await invalidateKnowledgeTreeQueries(queryClient);
      setLocation(`/quiz/${quizId}/result`);
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : "Փորձը չհաջողվեց գրանցել");
    } finally {
      setSubmitting(false);
    }
  }

  if (authLoading || loading) {
    return <div className="min-h-[100dvh] grid place-items-center bg-background"><div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  }
  if (error || !data || !question) {
    return (
      <div className="min-h-[100dvh] grid place-items-center bg-background text-white px-6">
        <div className="max-w-md text-center space-y-4">
          <p className="text-muted-foreground">{error ?? "Այս պահին սովորելու հարց չկա։"}</p>
          <Link href={`/quiz/${quizId}/result`} className="inline-flex px-5 py-2.5 rounded-xl bg-primary text-white font-semibold">
            Արդյունքներ
          </Link>
        </div>
      </div>
    );
  }

  const reviewCard=data.reviewCards?.[reviewIndex];
  const phaseLabel=data.learningPhase==="FINAL"?"Ամփոփիչ ստուգում":data.learningPhase==="PRACTICE"?"Սխալների ուսուցում":"Սկզբնական թեստ";
  const steps=data.learningPhase && <div className="text-xs text-muted-foreground mb-4">Սկզբնական թեստ → Սխալների ուսուցում → Ամփոփիչ ստուգում<p className="text-primary font-semibold mt-2">{phaseLabel}</p></div>;
  const isPractice=data.learningPhase==="PRACTICE" && data.assessmentConfig?.purpose==="LEARNING";
  function chooseMode(mode:"test"|"game") {
    setPracticeMode(mode);
    try{localStorage.setItem(`quiz-practice-mode:${data!.attemptId}`,mode);}catch{}
  }
  const modeControls=isPractice && practiceMode && <div className="flex flex-wrap items-center justify-between gap-3 text-xs mb-4">
    <span className="text-primary">{practiceMode==="game"?"Սովորել խաղով":"Սովորել թեստով"}</span>
    <button type="button" disabled={checking} className="text-white/70 underline underline-offset-4 disabled:opacity-50" onClick={()=>setPracticeMode(null)}>Փոխել սովորելու ձևը</button>
  </div>;
  if(isPractice && !practiceMode)return <div className="min-h-[100dvh] bg-background text-white px-5 py-8">
    <div className="max-w-2xl mx-auto space-y-6">
      <Link href={`/quiz/${quizId}/result`} className="text-sm text-muted-foreground">← Պահել և դուրս գալ</Link>
      {steps}
      {modeControls}
      <section className="rounded-3xl border border-white/10 bg-card/60 p-6 sm:p-8 space-y-5">
        <h1 className="text-xl font-bold">Ինչպե՞ս ես ուզում սովորել</h1>
        <p className="text-sm text-muted-foreground">Նախ կդիտես բացատրությունները, հետո կպատասխանես մնացած սխալ հարցերին։</p>
        <div className="grid sm:grid-cols-2 gap-4">
          <button type="button" onClick={()=>chooseMode("test")} className="rounded-2xl border border-indigo-400/30 bg-indigo-400/10 px-5 py-7 text-left hover:bg-indigo-400/20 transition-colors">
            <span className="block text-3xl mb-3" aria-hidden="true">📝</span><span className="font-bold">Սովորել թեստով</span>
            <span className="block text-sm text-white/60 mt-2">Ընտրիր ճիշտ պատասխանը։</span>
          </button>
          <button type="button" onClick={()=>chooseMode("game")} className="rounded-2xl border border-cyan-400/30 bg-cyan-400/10 px-5 py-7 text-left hover:bg-cyan-400/20 transition-colors">
            <span className="block text-3xl mb-3" aria-hidden="true">🎈</span><span className="font-bold">Սովորել խաղով</span>
            <span className="block text-sm text-white/60 mt-2">Սեղմիր ճիշտ պատասխանի փուչիկին։</span>
          </button>
        </div>
      </section>
    </div>
  </div>;
  const isGame=isPractice && practiceMode==="game";
  if(reviewCard)return <div className="min-h-[100dvh] bg-background text-white px-5 py-8">
    <div className="max-w-2xl mx-auto space-y-5">
      <Link href={`/quiz/${quizId}/result`} className="text-sm text-muted-foreground">← Պահել և դուրս գալ</Link>
      {steps}
      {modeControls}
      <section className="rounded-3xl border border-white/10 bg-card/60 p-6 space-y-4">
        <p className="text-xs text-primary">Բացատրություն {reviewIndex+1}/{data.reviewCards!.length}</p>
        <h1 className="text-lg font-semibold">{reviewCard.questionText}</h1>
        {reviewCard.selectedAnswer && <p className="text-sm text-white/70">Քո պատասխանը՝ {reviewCard.selectedAnswer}</p>}
        <p className="text-teal-200">Ճիշտ պատասխանը՝ {reviewCard.correctAnswer}</p>
        {reviewCard.whyWrong && <p className="text-sm text-white/80">{reviewCard.whyWrong}</p>}
        <p className="text-sm leading-relaxed">{reviewCard.explanation??"Այս հարցի համար բացատրություն պահպանված չէ։"}</p>
      </section>
      <button className="w-full rounded-2xl bg-primary px-5 py-4 font-bold" onClick={()=>{
        const next=reviewIndex+1;setReviewIndex(next);
        try{localStorage.setItem(`quiz-review:${data.attemptId}`,String(next));}catch{}
      }}>{reviewIndex+1===data.reviewCards!.length?"Հասկացա, անցնել ստուգմանը":"Հասկացա, անցնել առաջ"}</button>
      <p className="text-xs text-muted-foreground text-center">Բացատրություններից հետո կպատասխանեք մնացած սխալ հարցերին։</p>
    </div>
  </div>;
  return (
    <div className="min-h-[100dvh] bg-background text-white pb-28">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-card/90 backdrop-blur">
        <div className="max-w-2xl mx-auto px-5 py-4 flex items-center justify-between gap-4">
          <button onClick={() => history.back()} className="text-sm text-muted-foreground hover:text-white">← Պահել և դուրս գալ</button>
          <span className="text-xs text-muted-foreground">Փորձ {data.attemptSequence} · {data.learningPhase?`${phaseLabel} · `:""}{currentIndex + 1}/{data.questions.length}</span>
        </div>
        <div className="h-1 bg-white/5"><div className="h-full bg-gradient-to-r from-primary to-secondary transition-all" style={{ width: `${progress}%` }} /></div>
      </header>

      <main className="max-w-2xl mx-auto px-5 py-8">
        {steps}
        {modeControls}
        {data.learningPhase==="PRACTICE" && !!data.reviewCards?.length && <button
          className="mb-4 rounded-xl border border-primary/40 px-4 py-2 text-sm text-primary"
          onClick={()=>{setReviewIndex(0);try{localStorage.setItem(`quiz-review:${data.attemptId}`,"0");}catch{}}}
        >Վերանայել բացատրությունները</button>}
        <section className="rounded-3xl border border-white/10 bg-card/60 p-6">
          {data.assessmentConfig && <p className="text-xs text-muted-foreground mb-2">{data.assessmentConfig.purpose === "CHECK" ? "Գիտելիքի անկախ ստուգում" : "Ուսուցողական"} · {({IN_CLASS:"Միայն դասարանում",AT_HOME:"Միայն տանը",CLASS_THEN_HOME:"Դասարանում սկսել, տանը շարունակել",ANYWHERE:"Ցանկացած վայրում"} as Record<string,string>)[data.assessmentConfig.context]}</p>}
          <p className="text-xs text-primary mb-3">Հարց {currentIndex + 1}</p>
          {isGame ? <BalloonQuizGame key={question.id} question={question.questionText} options={question.options}
            selectedIndex={answers[question.id]} correctIndex={currentFeedback?.correctOptionIndex??null}
            answered={!!currentFeedback} disabled={checking} onChoose={commitAnswer} /> : <>
          <h1 className="text-lg font-semibold leading-relaxed">{question.questionText}</h1>
          <div className="mt-6 space-y-3">
            {question.options.map((option, optionIndex) => {
              const selected = answers[question.id] === optionIndex;
              const correct = currentFeedback?.correctOptionIndex === optionIndex;
              const cls = currentFeedback && !currentFeedback.deferred
                ? correct
                  ? "border-teal-400/60 bg-teal-400/15"
                  : selected
                    ? "border-red-400/60 bg-red-400/15"
                    : "border-white/10 opacity-60"
                : selected ? "border-primary bg-primary/15" : "border-white/10 hover:border-primary/50 hover:bg-primary/10";
              return (
                <button
                  key={optionIndex}
                  disabled={!!currentFeedback || checking}
                  onClick={() => commitAnswer(optionIndex)}
                  className={`w-full text-left rounded-2xl border px-4 py-3.5 transition-all ${cls}`}
                >
                  <span className="font-mono text-xs text-primary mr-3">{OPTION_LABELS[optionIndex] ?? optionIndex + 1}.</span>
                  {option}
                </button>
              );
            })}
          </div>
          </>}

          {currentFeedback?.deferred && <p className="mt-4 text-primary">Պատասխանը պահպանված է։ Արդյունքը՝ թեստի ավարտից հետո։</p>}
          {currentFeedback && !currentFeedback.deferred && (
            <div className={`mt-6 rounded-2xl border p-4 ${currentFeedback.isCorrect ? "border-teal-400/30 bg-teal-400/10" : "border-amber-400/30 bg-amber-400/10"}`}>
              <p className="font-semibold">
                {currentFeedback.isCorrect ? "✅ Ճիշտ է" : "❌ Սխալ է"}
              </p>
              <div className="mt-3 space-y-2 text-sm text-white/80">
                <p>
                  <span className="font-semibold text-white">Քո պատասխանը՝</span>{" "}
                  {currentFeedback.selectedAnswer ?? "Պատասխանը հասանելի չէ"}
                </p>
                <p>
                  <span className="font-semibold text-white">Ճիշտ պատասխանը՝</span>{" "}
                  {currentFeedback.correctAnswer ?? "Պատասխանը հասանելի չէ"}
                </p>
                <p>
                  <span className="font-semibold text-white">Բացատրություն՝</span>{" "}
                  {primaryExplanation ?? "Այս հարցի համար բացատրություն պահպանված չէ։"}
                </p>
                {!currentFeedback.isCorrect
                  && currentFeedback.feedback.whyCorrect
                  && currentFeedback.feedback.whyCorrect !== primaryExplanation && (
                    <p className="text-teal-200">
                      {currentFeedback.feedback.whyCorrect}
                    </p>
                  )}
              </div>
            </div>
          )}
        </section>
      </main>

      {(!isGame || currentFeedback || submitError) && <div className="fixed bottom-0 inset-x-0 border-t border-white/10 bg-card/90 backdrop-blur px-5 py-4">
        <div className="max-w-2xl mx-auto">
          {submitError && <p className="text-sm text-red-400 text-center mb-2">{submitError}</p>}
          {currentFeedback && currentIndex < data.questions.length - 1 && (
            <button onClick={() => setCurrentIndex((index) => index + 1)} className="w-full py-3.5 rounded-2xl bg-primary text-white font-bold">
              Հաջորդ հարցը
            </button>
          )}
          {currentFeedback && currentIndex === data.questions.length - 1 && (
            <button disabled={submitting} onClick={submitAttempt} className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-primary to-secondary text-white font-bold disabled:opacity-50">
              {submitting ? "Գրանցվում է..." : "Ավարտել փորձը"}
            </button>
          )}
          {!currentFeedback && <p className="text-center text-xs text-muted-foreground">{data.learningPhase==="FINAL"?"Ընտրեք պատասխանը։ Արդյունքը՝ ամբողջ թեստի ավարտից հետո։":isGame?"Սեղմիր ճիշտ պատասխանի փուչիկին։":"Ընտրեք պատասխանը՝ անմիջապես ստուգելու համար"}</p>}
        </div>
      </div>}
    </div>
  );
}