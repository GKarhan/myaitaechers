export type AssessmentView = {
  correct:number; attempted:number; percent:number|null;
  certainty:"NONE"|"LOW"|"MEDIUM"|"HIGH";
  status:string; nextAction:string; confirmation:string;
};
const certaintyLabels={NONE:"Չի հաստատվել",LOW:"Ցածր հավաստիություն",MEDIUM:"Միջին հավաստիություն",HIGH:"Բարձր հավաստիություն"};
const actionLabels:Record<string,string>={ASSESS:"Անկախ ստուգում",RECONFIRM:"Լրացնել հաստատումը",REVIEW:"Կրկնություն",TARGETED_PRACTICE:"Նպատակային վարժանք",LEARN:"Շարունակել սովորել",TEACHER_REVIEW:"Լրացուցիչ աջակցության կարիք"};
export function NodeAssessmentBadge({assessment}:{assessment?:AssessmentView|null}) {
  if(!assessment)return null;
  return <span className="block text-xs text-muted-foreground mt-1">
    {assessment.correct}/{assessment.attempted} ճիշտ · {certaintyLabels[assessment.certainty]}
    <span className="block">{actionLabels[assessment.nextAction]??""}</span>
  </span>;
}
