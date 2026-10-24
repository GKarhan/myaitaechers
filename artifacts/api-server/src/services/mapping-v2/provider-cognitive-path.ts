import {z} from 'zod/v4';
import {bloomLevels,cognitivePathLevelSchema,CompleteMapSchemaError} from './contract.js';

// A level has one slot. There is no separate provider ceiling to contradict it.
export const providerCognitivePathSchema=z.strictObject(Object.fromEntries(
 bloomLevels.map(level=>[level,cognitivePathLevelSchema.omit({level:true}).strict().nullable()]),
));

export function decodeProviderCognitivePaths(value:Record<string,unknown>):Record<string,unknown>{
 if(!Array.isArray(value.topics))return value; // canonical schema reports malformed structure
 return {...value,topics:value.topics.map((topic,topicIndex)=>{
  if(!topic||typeof topic!=='object'||!Array.isArray(topic.nodes))return topic;
  return {...topic,nodes:topic.nodes.map((node:Record<string,unknown>,index:number)=>{
   if(!node||typeof node!=='object')return node;
   // Historical canonical packages remain subject to the original validator.
   // Never merge, sort, truncate or relabel an invalid legacy array.
   if(Array.isArray(node.cognitivePath))return node;
   const parsed=providerCognitivePathSchema.safeParse(node.cognitivePath);
   if(!parsed.success)throw new CompleteMapSchemaError(parsed.error.issues.map(issue=>({
    ...issue,path:['topics',topicIndex,'nodes',index,'cognitivePath',...issue.path],
   })));
   if('targetBloom' in node)throw new CompleteMapSchemaError([{path:['topics',topicIndex,'nodes',index,'targetBloom'],code:'unrecognized_keys'}]);
   const cognitivePath=bloomLevels.flatMap(level=>{
    const payload=parsed.data[level];return payload===null?[]:[{...payload,level}];
   });
   return {...node,cognitivePath,targetBloom:cognitivePath.at(-1)?.level};
  })};
 })};
}
