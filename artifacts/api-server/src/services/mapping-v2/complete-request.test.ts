import {openrouter} from '@workspace/integrations-openrouter-ai';
import assert from 'node:assert/strict';
import {fixture} from './contract.test.js';
import {buildCompleteMapRequest} from './complete-request.js';
import {generateCompleteMap} from './generate.js';
import {validateCompleteMap,type SourceBlock} from './contract.js';
import {SourceReferenceValidationError} from './source-references.js';
const {blocks,map}=fixture();const context={subject:'Physics',grade:'7',lessonTitle:'Bodies',teacherGoal:null,outcomes:[{id:1,outcomeText:'Explain a body'}],legacyOutcomes:[]};
const {request}=buildCompleteMapRequest(blocks,context);
assert.equal(request.response_format.type,'json_schema');assert.equal(request.response_format.json_schema.strict,true);assert.equal(request.provider.require_parameters,true);
const schema=request.response_format.json_schema.schema;
const node=schema.properties.topics.items.properties.nodes.items.properties;
const task=schema.properties.exercises.items.properties.sourceBlockIndices;
assert.deepEqual(node.sourceBlockIndices.items.enum,[0]);assert.deepEqual(task.items.enum,blocks.slice(1).map((_,i)=>i+1));
assert.deepEqual(node.outcomeIds.items.enum,[1]);
const input=JSON.parse(request.messages[1].content);assert.deepEqual(input.sourceRoles.theorySourceIndices,[0]);assert.ok(!('outputSchema' in input));
let calls=0;
const result=await generateCompleteMap(blocks,context,{complete:async received=>{calls++;assert.deepEqual(received,request);return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(map)}}]};}});
assert.equal(calls,1);assert.equal(result.map.exercises.length,15);
// A provider ignoring schema constraints is still rejected; diagnostics cover all bad source links.
const bad=structuredClone(map);bad.topics[0].nodes[0].sourceBlockIndices.push(1,2);bad.exercises[0].sourceBlockIndices=[0];
try{validateCompleteMap(bad,blocks,[1]);assert.fail('must reject source-role collisions');}
catch(e){assert.ok(e instanceof SourceReferenceValidationError);assert.equal(e.message,'ACTIVITY_USED_AS_THEORY');assert.equal(e.diagnostics.issues.filter(i=>i.code==='ACTIVITY_USED_AS_THEORY').length,2);assert.ok(e.diagnostics.issues.some(i=>i.code==='DUPLICATE_OR_INVALID_SOURCE_EXERCISE'));assert.ok(!JSON.stringify(e.diagnostics).includes(blocks[0].sourceText));}
await assert.rejects(()=>generateCompleteMap(blocks,context,{complete:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(bad)}}]})}),/ACTIVITY_USED_AS_THEORY/);
const onlyTheory:SourceBlock[]=[blocks[0]];const plain=buildCompleteMapRequest(onlyTheory,{...context,outcomes:[]}).request.response_format.json_schema.schema;
assert.equal(plain.properties.exercises.items.properties.sourceBlockIndices.maxItems,0);assert.equal(plain.properties.topics.items.properties.nodes.items.properties.outcomeIds.maxItems,0);
assert.ok(!JSON.stringify(plain).includes('"enum":[]'));
let contacted=false;await assert.rejects(()=>generateCompleteMap([blocks[1]],context,{complete:async()=>{contacted=true;throw Error('unexpected provider call');}}),/COMPLETE_MAP_NO_THEORY_SOURCE/);assert.equal(contacted,false);
console.log('PASS: strict scoped schema, separate theory/exercise indices, one mocked generation, independent validation, aggregated redacted diagnostics and no paid calls');

// Exercise the real SDK serializer with an in-memory HTTP response, not a provider.
let wireCalls=0;
const client=openrouter.withOptions({fetch:async(_url,init)=>{
 wireCalls++;const body=JSON.parse(String(init?.body));
 assert.equal(body.provider.require_parameters,true);
 assert.equal(body.response_format.type,'json_schema');
 assert.deepEqual(body.response_format.json_schema.schema.properties.topics.items.properties.nodes.items.properties.sourceBlockIndices.items.enum,[0]);
 return new Response(JSON.stringify({id:'mock',object:'chat.completion',created:0,model:'mock',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(map)}}]}),{status:200,headers:{'Content-Type':'application/json'}});
}});
await generateCompleteMap(blocks,context,{complete:request=>client.chat.completions.create(request)});
assert.equal(wireCalls,1);
console.log('PASS: actual SDK HTTP body preserves strict source-role enums and provider routing; mocked transport only');
