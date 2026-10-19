import assert from 'node:assert/strict';
process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL='https://openrouter.ai/api/v1';
process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY='sk-or-diagnostic-not-a-real-key';
const {openrouter,checkOpenRouterAuthentication}=await import('../client.js');
const secret='sk-or-diagnostic-not-a-real-key';
for(const status of [200,401]){
 let calls=0;
 const transport: typeof fetch=async(input,init)=>{
  calls++;
  assert.equal(String(input),'https://openrouter.ai/api/v1/key');
  assert.equal(init?.method,'GET');
  assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+secret);
  return new Response(JSON.stringify(status===200?{data:{label:secret}}:{error:{message:secret,code:401}}),{status,headers:{'content-type':'application/json'}});
 };
 const result=await checkOpenRouterAuthentication(openrouter,transport);
 assert.equal(result.status,status);assert.equal(result.authorizationHeaderPresent,true);assert.equal(calls,1);
 assert.equal(JSON.stringify(result).includes(secret),false);
 assert.equal(result.canonicalBaseURL,true);
}
console.log('PASS: SDK GET /key, bearer header, 200/401 classification, no retries, no credential/body exposure');
