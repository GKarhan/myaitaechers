import assert from 'node:assert/strict';
import {materializeSourceSpans,sourceLines,SourceSpanPlanError} from './source-spans.js';
import {bindTextBlocksToPhysicalPages} from '../../lib/lesson-source-set.js';
const text=['Theory split at a hy-','phen remains unchanged.','',...Array.from({length:13},(_,i)=>`${i+1}. Question ${i+1}?`),'1. Practical assignment','2. Research the history and'].join('\n');
const plan={firstBlockType:'NOTE',blocks:[...Array.from({length:13},(_,i)=>({blockType:'EXERCISE',firstLine:i+4})),{blockType:'ACTIVITY',firstLine:17},{blockType:'ACTIVITY',firstLine:18}]};
const result=materializeSourceSpans(text,9,plan);
assert.equal(result.blocks.map(b=>b.sourceText).join('\n'),text);
assert.equal(result.blocks.filter(b=>b.blockType==='EXERCISE').length,13);
assert.equal(result.blocks.filter(b=>b.blockType==='ACTIVITY').length,2);
assert.equal(bindTextBlocksToPhysicalPages([{pageNumber:9,text}],result.blocks).audit.quarantinedBlockCount,0);
const continued=materializeSourceSpans('describe the important contributions.\nSection 2\nNeighboring theory',10,{firstBlockType:'ACTIVITY',blocks:[{blockType:'NOTE',firstLine:2},{blockType:'NOTE',firstLine:3}]});
assert.equal(continued.blocks[0].sourcePage,10);assert.equal(continued.blocks[1].blockType,'NOTE');
assert.equal(sourceLines('A\r\nB')[1].text,'B');
// Response order cannot reorder source text; physical line IDs are authoritative.
const shuffled=structuredClone(plan);shuffled.blocks.reverse();assert.deepEqual(materializeSourceSpans(text,9,shuffled),result);
// A provider no longer has to enumerate blank or wrapped lines or compute ends.
const wrapped='Definition\n\n\n1. Question that wraps\nonto another line\n\n2. Another task\nlast continuation';
const covered=materializeSourceSpans(wrapped,6,{firstBlockType:'DEFINITION',blocks:[{blockType:'EXERCISE',firstLine:4},{blockType:'ACTIVITY',firstLine:7}]});
assert.equal(covered.blocks.map(b=>b.sourceText).join('\n'),wrapped);
assert.equal(covered.blocks[1].sourceText,'1. Question that wraps\nonto another line\n');
assert.equal(covered.blocks[2].sourceText,'2. Another task\nlast continuation');
for(const mutate of [
 (p:any)=>delete p.firstBlockType,
 (p:any)=>p.blocks[1].firstLine=p.blocks[0].firstLine,
 (p:any)=>p.blocks[1].firstLine=1000,
 (p:any)=>p.blocks[1].firstLine=1.5,
 (p:any)=>p.blocks[1].firstLine=0,
]){const invalid=structuredClone(plan);mutate(invalid);assert.throws(()=>materializeSourceSpans(text,9,invalid),/SOURCE_SPAN_/);}
assert.throws(()=>materializeSourceSpans(text,9,{firstBlockType:'NOTE',blocks:[{blockType:'EXERCISE',firstLine:2,lastLine:18,sourceText:'invented'}]}),/SOURCE_SPAN_SCHEMA_INVALID/);
try{materializeSourceSpans('Private source\nnot for logs',10,{firstBlockType:'NOTE',blocks:[{blockType:'NOTE',firstLine:3}]});assert.fail('must reject invalid ID');}
catch(e){assert.ok(e instanceof SourceSpanPlanError);assert.deepEqual(e.diagnostics,{physicalPage:10,lineCount:2,starts:[1,3],reason:'START_OUT_OF_RANGE'});assert.ok(!JSON.stringify(e).includes('Private source'));}
console.log('PASS: server-computed ends, blank/wrapped/tail line coverage, response-order independence, 13 questions + 2 practicals, continuation, invalid starts and safe numeric diagnostics');

// Every subset of possible transitions partitions the entire source by construction.
const exhaustive=Array.from({length:8},(_,i)=>`line ${i+1}`).join('\n');
for(let mask=0;mask<128;mask++){
 const transitions=Array.from({length:7},(_,i)=>i+2).filter((_,i)=>mask&(1<<i)).map(firstLine=>({firstLine,blockType:'NOTE'}));
 const output=materializeSourceSpans(exhaustive,6,{firstBlockType:'NOTE',blocks:transitions});
 assert.equal(output.blocks.map(b=>b.sourceText).join('\n'),exhaustive);
}
console.log('PASS: all 128 source partitions preserve every character including first/last lines');


const mergedQuestions=Array.from({length:9},(_,i)=>String(i+1)+'. Question '+(i+1)+'?').join('\n');
const recovered=materializeSourceSpans(mergedQuestions,9,{firstBlockType:'EXERCISE',blocks:[]});
assert.equal(recovered.blocks.length,9);
assert.equal(recovered.blocks.map(b=>b.sourceText).join('\n'),mergedQuestions);
assert.equal(recovered.blocks[8].sourceParagraph,'lines:9-9');
const options='10. Match these phenomena\n1. Arrow moves\n2. Light reflects\n3. Compass turns\n4. Water warms';
assert.equal(materializeSourceSpans(options,9,{firstBlockType:'EXERCISE',blocks:[]}).blocks.length,1);
const lastThree='11. What is matter?\n12. Name types of matter\n13. What is physics for?';
assert.equal(materializeSourceSpans(lastThree,9,{firstBlockType:'EXERCISE',blocks:[]}).blocks.length,3);
console.log('PASS: merged question recovery, original line offsets, and matching-options preservation');
