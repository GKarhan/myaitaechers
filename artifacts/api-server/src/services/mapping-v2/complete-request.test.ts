import {openrouter} from '@workspace/integrations-openrouter-ai';
import assert from 'node:assert/strict';
import {fixture} from './contract.test.js';
import {buildCompleteMapRequest} from './complete-request.js';
import {generateCompleteMap} from './generate.js';
import {validateCompleteMap,CompleteMapSchemaError,type SourceBlock} from './contract.js';
import {SourceReferenceValidationError} from './source-references.js';
const {blocks,map}=fixture();const providerMap:Record<string,unknown>={...map};delete providerMap.schemaVersion;const context={subject:'Physics',grade:'7',lessonTitle:'Bodies',teacherGoal:null,outcomes:[{id:1,outcomeText:'Explain a body'}],legacyOutcomes:[]};
const {request}=buildCompleteMapRequest(blocks,context);
assert.equal(request.response_format.type,'json_schema');assert.equal(request.response_format.json_schema.strict,true);assert.equal(request.provider.require_parameters,true);
const schema=request.response_format.json_schema.schema;
const node=schema.properties.topics.items.properties.nodes.items.properties;
const task=schema.properties.exercises.items.properties.sourceBlockIndices;
assert.deepEqual(node.sourceBlockIndices.items.enum,[0]);assert.deepEqual(task.items.enum,blocks.slice(1).map((_,i)=>i+1));
assert.deepEqual(node.outcomeIds.items.enum,[1]);
const input=JSON.parse(request.messages[1].content);assert.deepEqual(input.sourceRoles.theorySourceIndices,[0]);assert.ok(!('outputSchema' in input));
let calls=0;
const result=await generateCompleteMap(blocks,context,{complete:async received=>{calls++;assert.deepEqual(received,request);return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(providerMap)}}]};}});
assert.equal(calls,1);assert.equal(result.map.exercises.length,15);assert.equal(result.map.schemaVersion,'P1.2.2');
assert.ok(!('schemaVersion' in schema.properties));assert.ok(!schema.required.includes('schemaVersion'));
const wrongMetadata=await generateCompleteMap(blocks,context,{complete:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({...providerMap,schemaVersion:'wrong-model-metadata'})}}]})});
assert.equal(wrongMetadata.map.schemaVersion,'P1.2.2');
const broken=structuredClone(providerMap) as any;delete broken.essentialQuestion;delete broken.topics[0].nodes[0].teaching.explanation;
try{await generateCompleteMap(blocks,context,{complete:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(broken)}}]})});assert.fail('must reject incomplete pedagogical content');}
catch(e){assert.ok(e instanceof CompleteMapSchemaError);assert.equal(e.diagnostics.schemaIssues.length,2);assert.ok(e.diagnostics.schemaIssues.some(i=>i.path.join('.')==='essentialQuestion'));assert.ok(!JSON.stringify(e.diagnostics).includes(blocks[0].sourceText));}
assert.throws(()=>validateCompleteMap({...map,schemaVersion:'unsupported'},blocks,[1]),/COMPLETE_MAP_SCHEMA_INVALID/);
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
 return new Response(JSON.stringify({id:'mock',object:'chat.completion',created:0,model:'mock',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(providerMap)}}]}),{status:200,headers:{'Content-Type':'application/json'}});
}});
await generateCompleteMap(blocks,context,{complete:request=>client.chat.completions.create(request)});
assert.equal(wireCalls,1);
console.log('PASS: actual SDK HTTP body preserves strict source-role enums and provider routing; mocked transport only');

console.log('PASS: server-owned schemaVersion, omitted/incorrect model metadata handled without changing pedagogy; all shape failures still rejected with redacted paths');

let repairCalls=0;
const duplicate=structuredClone(providerMap) as any;duplicate.exercises[1].sourceBlockIndices=[1];
const repaired=await generateCompleteMap(blocks,context,{complete:async req=>{
 repairCalls++;
 if(repairCalls===2){assert.ok(req.messages.at(-1)!.content.includes('DUPLICATE_OR_INVALID_SOURCE_EXERCISE'));assert.ok(req.messages.at(-1)!.content.includes('validationErrors'));}
 return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(repairCalls===1?duplicate:providerMap)}}]};
}});
assert.equal(repairCalls,2);assert.equal(repaired.generationAttempts,2);assert.equal(repaired.map.exercises.length,15);
let rejectedCalls=0;
await assert.rejects(()=>generateCompleteMap(blocks,context,{complete:async()=>{rejectedCalls++;return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(duplicate)}}]};}}),SourceReferenceValidationError);
assert.equal(rejectedCalls,2,'bounded correction must not loop or persist invalid work');
let outageCalls=0;
await assert.rejects(()=>generateCompleteMap(blocks,context,{complete:async()=>{outageCalls++;throw Error('provider unavailable');}}),/provider unavailable/);
assert.equal(outageCalls,1,'transport failures are not validation retries');
console.log('PASS one bounded corrective request for invalid references; persistent invalid output still rejected; transport errors not retried');

// All path contradictions must reach the single repair call, not only the first node.
const inconsistent=structuredClone(providerMap) as any;
const base=inconsistent.topics[0].nodes[0];
base.targetBloom='remember';
const other=structuredClone(base);other.id='N2';other.targetBloom='understand';
other.cognitivePath.push(structuredClone(other.cognitivePath[0]));
inconsistent.topics[0].nodes.push(other);
let pathCalls=0;
const fixedPath=await generateCompleteMap(blocks,context,{complete:async req=>{
 pathCalls++;
 if(pathCalls===2){
  const content=req.messages.at(-1)!.content;
  assert.ok(content.includes('cognitivePathIssues'));
  assert.ok(content.includes('"nodeId":"N1"'));
  assert.ok(content.includes('"nodeId":"N2"'));
  assert.ok(content.includes('"finalLevelMatchesTarget":false'));
  assert.ok(content.includes('"duplicateLevels":["understand"]'));
  assert.ok(content.includes('do not automatically raise the ceiling'));
 }
 return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(pathCalls===1?inconsistent:providerMap)}}]};
}});
assert.equal(pathCalls,2);assert.equal(fixedPath.generationAttempts,2);
let persistentPaths=0;
await assert.rejects(()=>generateCompleteMap(blocks,context,{complete:async()=>{
 persistentPaths++;return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(inconsistent)}}]};
}}),/INVALID_COGNITIVE_CEILING/);
assert.equal(persistentPaths,2);
console.log('PASS aggregated cognitive path repair: both ceiling and duplicate-level issues supplied; invalid second response still blocked');
