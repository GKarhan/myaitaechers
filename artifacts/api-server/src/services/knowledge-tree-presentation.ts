// Read-only presentation of learning progress. Independent mastery is preserved.
type NodeProgress = {
  knowledgeState: "MASTERED" | "PARTIAL" | "NOT_KNOWN" | "NOT_STUDIED";
  knowledgeStateLabel?: string;
  masteryScore?: number;
  practiceProgress?: {current:{correct:number;incorrect:number;total:number;percent:number};practiceComplete:boolean};
};
export function learningView(node: NodeProgress) {
  const practice=node.practiceProgress;
  if(practice && practice.current.total>0 && node.knowledgeState!=="MASTERED") return {
    state:practice.practiceComplete?"PRACTICE_COMPLETE":practice.current.correct>0?"PARTIAL":"NOT_KNOWN",
    label:practice.practiceComplete?"Ուսուցողական աշխատանքն ավարտված է":practice.current.correct>0?"Մասնակի գիտի":"Չգիտի",
    percent:practice.current.percent,
    correct:practice.current.correct,incorrect:practice.current.incorrect,
  };
  return {state:node.knowledgeState,label:node.knowledgeStateLabel,
    percent:node.knowledgeState==="NOT_STUDIED"?null:node.masteryScore??0,
    correct:practice?.current.correct??null,incorrect:practice?.current.incorrect??null};
}
export function learningSummary(nodes:NodeProgress[]) {
  const states=nodes.map(n=>learningView(n).state);
  return {completed:states.filter(s=>s==="PRACTICE_COMPLETE").length,
    mastered:states.filter(s=>s==="MASTERED").length,
    partial:states.filter(s=>s==="PARTIAL").length,
    unknown:states.filter(s=>s==="NOT_KNOWN").length,
    notStarted:states.filter(s=>s==="NOT_STUDIED").length};
}
