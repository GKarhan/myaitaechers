export type LearningScope = {version:1;mode:"LESSON"|"NODES";nodeIds:number[]};
/** A selected set is ordered by the approved curriculum, never client order. */
export function createLearningScope(requested:unknown, approvedIds:readonly number[]):LearningScope {
  if(!approvedIds.length)throw new Error("NO_APPROVED_NODES");
  if(requested == null)return {version:1,mode:"LESSON",nodeIds:[...approvedIds]};
  if(!Array.isArray(requested)||!requested.length||requested.some(id=>!Number.isSafeInteger(id)||id<=0||!approvedIds.includes(id)))
    throw new Error("INVALID_LEARNING_SCOPE");
  return {version:1,mode:"NODES",nodeIds:approvedIds.filter(id=>requested.includes(id))};
}
