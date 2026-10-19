import {z} from 'zod/v4';

export const TEXT_SOURCE_SPAN_PROMPT = `P1.2.1 text-source preparation. The server supplies one physical PDF page as numbered lines.
Return ONLY JSON matching the supplied schema. Classify and group the lines; NEVER transcribe, correct, summarize or generate source text.
Each block is an inclusive consecutive range firstLine..lastLine. Cover EVERY supplied line exactly once, in original order, without gaps or overlaps, including headings, page numbers, captions and neighboring sections. The next stage decides lesson scope.
Keep each numbered question/exercise as its own EXERCISE block, including all of its wrapped lines. Practical assignments are ACTIVITY. A continuation at the top of a page remains the same activity type; never merge separate numbered tasks. Preserve section headings separately as NOTE. Theory is NOTE, RULE or DEFINITION. Examples are EXAMPLE, instructions HOMEWORK where explicitly homework, objectives OBJECTIVE, other visible text NOTE/CAPTION as appropriate.
Do not turn a numbered theory subsection heading into an exercise. Do not include theory, captions or headers inside a question's range. Adjacent same-type theory lines may be grouped. If a single line contains more than one logical item, keep that line intact; do not invent character offsets. Line numbers are server IDs, not printed page or exercise numbers.`;

export const spanSchema=z.strictObject({blocks:z.array(z.strictObject({
 blockType:z.enum(['DEFINITION','RULE','EXAMPLE','EXERCISE','OBJECTIVE','WARNING','EXCEPTION','TABLE','IMAGE','CAPTION','NOTE','ACTIVITY','HOMEWORK']),
 firstLine:z.number().int().positive(),lastLine:z.number().int().positive(),
})).min(1)});
export type SourceSpanPlan=z.infer<typeof spanSchema>;
export function sourceLines(text:string){return text.split(/\r?\n/).map((text,index)=>({id:index+1,text}));}
export function materializeSourceSpans(text:string,pageNumber:number,value:unknown){
 if(!Number.isInteger(pageNumber)||pageNumber<1)throw Error('SOURCE_SPAN_PAGE_INVALID');
 const result=spanSchema.safeParse(value);if(!result.success)throw Error('SOURCE_SPAN_SCHEMA_INVALID');
 const lines=sourceLines(text);let next=1;
 const blocks=result.data.blocks.map(span=>{
  if(span.firstLine!==next||span.lastLine<span.firstLine||span.lastLine>lines.length)throw Error('SOURCE_SPAN_COVERAGE_INVALID');
  next=span.lastLine+1;
  return {blockType:span.blockType,sourceText:lines.slice(span.firstLine-1,span.lastLine).map(l=>l.text).join('\n'),sourcePage:pageNumber,sourceParagraph:`lines:${span.firstLine}-${span.lastLine}`,sourceBoundingBox:null};
 });
 if(next!==lines.length+1)throw Error('SOURCE_SPAN_COVERAGE_INVALID');
 // Empty lines still participate in coverage; they carry no instructional text.
 return {blocks:blocks.filter(b=>b.sourceText.trim().length>0)};
}
