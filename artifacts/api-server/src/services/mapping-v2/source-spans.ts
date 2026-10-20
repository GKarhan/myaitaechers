import {z} from 'zod/v4';

export const TEXT_SOURCE_SPAN_PROMPT = `P1.2.1 text-source preparation. The server supplies one physical PDF page as numbered lines.
An optional precedingPageTail is reference-only context for recognizing a continued task. Return block starts ONLY for the current page lines; never emit starts or text from that context.
Return ONLY JSON matching the supplied schema. Classify and group the lines; NEVER transcribe, correct, summarize or generate source text.
The first block always starts at server line 1: return its type in firstBlockType. In blocks return ONLY subsequent block starts, each with firstLine (at least 2) and blockType. Use a distinct actual supplied line ID for every subsequent start. If the page contains just one block, blocks is empty. Do NOT return lastLine or calculate block ends. The server computes each block end as the next start minus one, and the final block ends at the final page line. Thus every line, including blank lines, headings, page numbers, captions and neighboring sections, is retained exactly once. The next stage decides lesson scope.
Keep each numbered question/exercise as its own EXERCISE block, including all of its wrapped lines. Practical assignments are ACTIVITY. A continuation at the top of a page remains the same activity type; never merge separate numbered tasks. Preserve section headings separately as NOTE. Theory is NOTE, RULE or DEFINITION. Examples are EXAMPLE, instructions HOMEWORK where explicitly homework, objectives OBJECTIVE, other visible text NOTE/CAPTION as appropriate.
Do not turn a numbered theory subsection heading into an exercise. Include a question's associated table, answer cells, matching options and illustrations' visible labels inside that EXERCISE range. Exclude unrelated theory, running captions or page headers from it. Adjacent same-type theory lines may be grouped. If a single line contains more than one logical item, keep that line intact; do not invent character offsets. Line numbers are server IDs, not printed page or exercise numbers.`;

const blockTypeSchema=z.enum(['DEFINITION','RULE','EXAMPLE','EXERCISE','OBJECTIVE','WARNING','EXCEPTION','TABLE','IMAGE','CAPTION','NOTE','ACTIVITY','HOMEWORK']);
export const spanSchema=z.strictObject({firstBlockType:blockTypeSchema,blocks:z.array(z.strictObject({
 blockType:blockTypeSchema,firstLine:z.number().int().min(2),
}))});
export type SourceSpanPlan=z.infer<typeof spanSchema>;
export function sourceLines(text:string){return text.split(/\r?\n/).map((text,index)=>({id:index+1,text}));}
export class SourceSpanPlanError extends Error {
 readonly diagnostics:{physicalPage:number;lineCount:number;starts:number[];reason:string};
 constructor(physicalPage:number,lineCount:number,starts:number[],reason:string){
  super('SOURCE_SPAN_BOUNDARIES_INVALID');this.name='SourceSpanPlanError';
  this.diagnostics={physicalPage,lineCount,starts,reason};
 }
}
export function materializeSourceSpans(text:string,pageNumber:number,value:unknown){
 if(!Number.isInteger(pageNumber)||pageNumber<1)throw Error('SOURCE_SPAN_PAGE_INVALID');
 const result=spanSchema.safeParse(value);if(!result.success)throw Error('SOURCE_SPAN_SCHEMA_INVALID');
 const lines=sourceLines(text);
 // Explicit source IDs determine reading order, regardless of response order.
 const spans=[{firstLine:1,blockType:result.data.firstBlockType},...result.data.blocks].sort((a,b)=>a.firstLine-b.firstLine);
 const starts=spans.map(s=>s.firstLine);
 const fail=(reason:string):never=>{throw new SourceSpanPlanError(pageNumber,lines.length,starts,reason);};
 if(new Set(starts).size!==starts.length)fail('DUPLICATE_START');
 if(starts.some(start=>start>lines.length))fail('START_OUT_OF_RANGE');
 const blocks=spans.map((span,index)=>{
  const lastLine=index+1<spans.length?spans[index+1].firstLine-1:lines.length;
  return {blockType:span.blockType,sourceText:lines.slice(span.firstLine-1,lastLine).map(l=>l.text).join('\n'),sourcePage:pageNumber,sourceParagraph:`lines:${span.firstLine}-${lastLine}`,sourceBoundingBox:null};
 });
 // Recover only an unambiguous sequence of consecutive numbered questions.
 // Options inside one question restart at 1, so they are not split.
 const separated=blocks.flatMap(block=>{
  if(block.blockType!=='EXERCISE')return [block];
  const range=/^lines:(\d+)-(\d+)$/.exec(block.sourceParagraph??'');
  if(!range)return [block];
  const rows=block.sourceText.split('\n');
  const getNumber=(row:string)=>/^\s*(\d{1,3})[.)։]\s*/.exec(row)?.[1];
  const initial=getNumber(rows[0]);
  if(initial===undefined)return [block];
  const boundaries=[0];let last=Number(initial);
  for(let i=1;i<rows.length;i++){
   const value=getNumber(rows[i]);
   if(value!==undefined&&Number(value)===last+1){boundaries.push(i);last++;}
  }
  if(boundaries.length<2)return [block];
  return boundaries.map((from,i)=>{
   const to=boundaries[i+1]??rows.length;
   return {...block,sourceText:rows.slice(from,to).join('\n'),
    sourceParagraph:'lines:'+(Number(range[1])+from)+'-'+(Number(range[1])+to-1)};
  });
 });
 // A question's immediately following table is part of the same source exercise.
 // Only join verified adjacent lines on the same PDF page and when the question
 // explicitly references a table. Never absorb a standalone or unrelated table.
 const attached:typeof separated=[];
 for(const block of separated){
  const previous=attached.at(-1);
  const previousRange=/^lines:(\d+)-(\d+)$/.exec(previous?.sourceParagraph??'');
  const currentRange=/^lines:(\d+)-(\d+)$/.exec(block.sourceParagraph??'');
  if(block.blockType==='TABLE'&&previous?.blockType==='EXERCISE'&&
     previous.sourcePage===block.sourcePage&&previousRange&&currentRange&&
     Number(previousRange[2])+1===Number(currentRange[1])&&
     /աղյուսակ|table/i.test(previous.sourceText)){
   previous.sourceText+='\n'+block.sourceText;
   previous.sourceParagraph='lines:'+previousRange[1]+'-'+currentRange[2];
  }else attached.push(block);
 }
 // Empty lines are included in the partition; blank-only blocks need no map owner.
 return {blocks:attached.filter(b=>b.sourceText.trim().length>0)};
}
