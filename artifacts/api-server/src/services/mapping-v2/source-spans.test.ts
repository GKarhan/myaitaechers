import assert from 'node:assert/strict';
import {materializeSourceSpans,sourceLines} from './source-spans.js';
import {bindTextBlocksToPhysicalPages} from '../../lib/lesson-source-set.js';
const text=['Theory split at a hy-','phen remains unchanged.','',...Array.from({length:13},(_,i)=>`${i+1}. Question ${i+1}?`),'1. Practical assignment','2. Research the history and'].join('\n');
const plan={blocks:[{blockType:'NOTE',firstLine:1,lastLine:3},...Array.from({length:13},(_,i)=>({blockType:'EXERCISE',firstLine:i+4,lastLine:i+4})),{blockType:'ACTIVITY',firstLine:17,lastLine:17},{blockType:'ACTIVITY',firstLine:18,lastLine:18}]};
const result=materializeSourceSpans(text,9,plan);
assert.equal(result.blocks.map(b=>b.sourceText).join('\n'),text);
assert.equal(result.blocks.filter(b=>b.blockType==='EXERCISE').length,13);
assert.equal(result.blocks.filter(b=>b.blockType==='ACTIVITY').length,2);
assert.equal(bindTextBlocksToPhysicalPages([{pageNumber:9,text}],result.blocks).audit.quarantinedBlockCount,0);
const continued=materializeSourceSpans('describe the important contributions.\nSection 2\nNeighboring theory',10,{blocks:[{blockType:'ACTIVITY',firstLine:1,lastLine:1},{blockType:'NOTE',firstLine:2,lastLine:2},{blockType:'NOTE',firstLine:3,lastLine:3}]});
assert.equal(continued.blocks[0].sourcePage,10);assert.equal(continued.blocks[1].blockType,'NOTE');
assert.equal(sourceLines('A\r\nB')[1].text,'B');
for(const mutate of [
 (p:any)=>p.blocks.splice(1,1),
 (p:any)=>p.blocks[1].firstLine=3,
 (p:any)=>p.blocks[0].lastLine=1000,
 (p:any)=>p.blocks.pop(),
 (p:any)=>p.blocks.reverse(),
 (p:any)=>p.blocks[1].firstLine=1.5,
]){const invalid=structuredClone(plan);mutate(invalid);assert.throws(()=>materializeSourceSpans(text,9,invalid),/SOURCE_SPAN_/);}
assert.throws(()=>materializeSourceSpans(text,9,{blocks:[{blockType:'EXERCISE',firstLine:1,lastLine:18,sourceText:'invented'}]}),/./);
console.log('PASS: exact server-owned text, 13 questions + 2 practicals, continuation, physical pages, missing/duplicate/reordered/out-of-range span rejection');
