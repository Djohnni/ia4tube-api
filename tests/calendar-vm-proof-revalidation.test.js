"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),{createRequire}=require("node:module");
const {selectedCases,validateRevalidationTicket,parseEvidence,validateRunEvidence,validateRevalidationEvidence}=require("../scripts/validation/vm-proof-guest");
const {MANIFEST}=require("../scripts/validation/vm-proof-manifest");
const now=1900000000000, hash="a".repeat(64);
const prior={allPassed:false,failure:{stage:"runtime-probe",code:"assertion_failed"},cases:[{id:"installed-preflight",passed:false}]};
function ticket(extra={}){return {schema:1,kind:"synthetic-case-revalidation",index:1,missionId:"synthetic-revalidation-mission",planSha256:hash,priorEvidenceSha256:hash,
  reviewSha256:hash,correctionSha256:hash,quiescenceSha256:hash,candidatePackageSha256:hash,candidateRuntimeRevision:hash,caseIds:["installed-preflight"],notAfterMs:now+600000,priorTerminationConfirmed:true,...extra};}
test("revalidation requires preflight and fixed manifest order without duplicate/unknown cases",()=>{
  assert.deepEqual(selectedCases(["installed-preflight","source-limit"]).map(c=>c.id),["installed-preflight","source-limit"]);
  for(const ids of [[],["source-limit"],["installed-preflight","installed-preflight"],["installed-preflight","source-limit","aggregate-space"],["installed-preflight","arbitrary"]])assert.throws(()=>selectedCases(ids),/case_selection_invalid/);
});
test("reviewed root ticket binds correction, prior receipt, runtime and independent termination",()=>{
  assert.equal(validateRevalidationTicket(ticket(),{now,priorEvidence:prior,runtimeRevision:hash}).launches,1);
  for(const change of [{priorTerminationConfirmed:false},{reviewSha256:null},{correctionSha256:""},{quiescenceSha256:"private_text"},{priorEvidenceSha256:""},{schema:2},{extra:"private_value"}])assert.throws(()=>validateRevalidationTicket(ticket(change),{now,priorEvidence:prior}),/ticket_invalid/);
  assert.throws(()=>validateRevalidationTicket(ticket(),{now,runtimeRevision:"b".repeat(64)}),/runtime_changed/);
});
test("successful or unknown earlier execution does not authorize another attempt",()=>{
  assert.throws(()=>validateRevalidationTicket(ticket(),{now,priorEvidence:{...prior,allPassed:true}}),/prior_failure_required/);
  assert.throws(()=>validateRevalidationTicket(ticket(),{now,priorEvidence:{...prior,failure:null}}),/prior_failure_required/);
  assert.throws(()=>validateRevalidationTicket(ticket(),{now,priorEvidence:{...prior,cases:[]}}),/failed_case_required/);
  assert.throws(()=>validateRevalidationTicket(ticket(),{now,priorEvidence:{...prior,cases:[{id:"aggregate-space",passed:false}]}}),/failed_case_required/);
});
test("additional budget includes preflight and every fixed native launch, not just case count",()=>{
  const t=ticket({caseIds:["installed-preflight","source-limit"]});assert.equal(validateRevalidationTicket(t,{now,usedAdditionalLaunches:3}).launches,5);
  assert.throws(()=>validateRevalidationTicket(t,{now,usedAdditionalLaunches:4}),/budget_exceeded/);
  assert.equal(validateRevalidationTicket(ticket({caseIds:MANIFEST.cases.map(c=>c.id)}),{now}).launches,8);
  for(const used of [-1,8.5,9])assert.throws(()=>validateRevalidationTicket(ticket(),{now,usedAdditionalLaunches:used}),/ticket_invalid/);
});
test("expired or overly extended tickets and mismatched attempt indexes fail closed",()=>{
  for(const change of [{notAfterMs:now},{notAfterMs:now+7200001},{index:0},{index:9}])assert.throws(()=>validateRevalidationTicket(ticket(change),{now}),/ticket_invalid/);
  assert.throws(()=>validateRevalidationTicket(ticket(),{now,index:2}),/ticket_invalid/);
});
function lines(ids,includeMetrics=false){const cases=selectedCases(ids);return [
  ...(includeMetrics?["# "+JSON.stringify({case:"installed-pipeline",source:{size:104857600},decoded:{seconds:60},prepared:{elapsedMs:45000,metrics:{cpuMs:42000,peakTreeMemoryBytes:300000000,peakTasks:20}}})]:[]),
  ...cases.map(c=>"# VM_INSTALLED_CASE="+JSON.stringify({id:c.id,passed:true,terminationProved:true,nativeLaunches:c.attempts.length,failure:null})),
  "# VM_INSTALLED_TOTAL="+JSON.stringify({launches:cases.reduce((n,c)=>n+c.attempts.length,0),allTerminated:true,attemptIds:cases.flatMap(c=>c.attempts)})].join("\n");}
test("selected non-pipeline receipts pass only their declared cases without invented video metrics",()=>{
  const ids=["installed-preflight","aggregate-space"],r=parseEvidence(lines(ids),0,100,ids);assert.equal(r.allPassed,true);assert.equal(r.launches,2);assert.equal(r.metrics,null);assert.equal(r.cases.length,2);
  assert.throws(()=>parseEvidence(lines(ids),0,100),/receipt/);
});
test("selected pipeline still requires measured decode/preparation and exact five native launches",()=>{
  const ids=["installed-preflight","source-limit"],r=parseEvidence(lines(ids,true),0,100,ids);assert.equal(r.allPassed,true);assert.equal(r.launches,5);assert.equal(r.metrics.sourceBytes,104857600);
  assert.equal(parseEvidence(lines(ids),0,100,ids).allPassed,false);assert.throws(()=>parseEvidence(lines(ids,true).replace('"launches":5','"launches":6'),0,100,ids),/receipt/);
});
test("original full suite retains five cases, eight launches and mandatory metrics",()=>{
  const ids=MANIFEST.cases.map(c=>c.id);assert.equal(parseEvidence(lines(ids,true),0,100).launches,8);assert.equal(parseEvidence(lines(ids,true),0,100).allPassed,true);assert.equal(parseEvidence(lines(ids),0,100).allPassed,false);
});
test("physical harness selection only skips registrations and does not execute native actions",()=>{
  const file=path.resolve(__dirname,"calendar-import-media-process-installed-linux.test.js"),source=fs.readFileSync(file,"utf8"),realRequire=createRequire(file),registrations=[];
  vm.runInNewContext(source,{require:name=>name==="node:test"?((name,options,action)=>registrations.push({name,options,action})):realRequire(name),process:{env:{CALENDAR_VM_REVALIDATION_CASE_IDS:JSON.stringify(["installed-preflight","source-limit"])}}});
  assert.equal(registrations.length,5);assert.deepEqual(registrations.map(r=>r.options.skip),[false,true,true,true,false]);assert.equal(registrations.every(r=>typeof r.action==="function"),true);
  assert.match(source,/else assert\.equal\(attempts, 8\)/);assert.match(source,/assert\.ok\(\+\+attempts <= 8/);
});
test("independent revalidation collection rejects extra fields and arbitrary private data",()=>{
  const evidence=parseEvidence(lines(["installed-preflight"]),0,100,["installed-preflight"]),value={schema:1,index:1,ticketSha256:hash,priorEvidenceSha256:hash,reviewSha256:hash,correctionSha256:hash,candidatePackageSha256:hash,candidateRuntimeRevision:hash,evidence};
  assert.equal(validateRunEvidence(evidence),true);assert.equal(validateRevalidationEvidence(value),true);
  assert.equal(validateRevalidationEvidence({...value,private:"not_exportable"}),false);assert.equal(validateRevalidationEvidence({...value,evidence:{...evidence,raw:"private"}}),false);
  assert.equal(validateRunEvidence({...evidence,cases:[{...evidence.cases[0],failure:{stage:"unknown",code:"private"}}]}),false);
});
