"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {createOperationalPlan}=require('../scripts/media-pilot/google-plan');
const {runOperationalPilot}=require('../scripts/media-pilot/google-controller');
const {KINDS,resourceName,resourcePath,description}=require('../scripts/validation/vm-proof-google-plan');
const {canonical,sha256}=require('../scripts/validation/vm-proof-manifest');
const NOW=Date.parse('2026-09-19T17:00:00Z'),uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function plan(){return createOperationalPlan({imageId:'6257327608773510097',operatorIpv4:'177.125.241.34',packageSha256:'a'.repeat(64),
  packageReviewSha256:'b'.repeat(64),authorizationSha256:'c'.repeat(64),ownerCompanyId:uuid(1),ownerUserId:uuid(2),workerId:uuid(3),
  finance:{computeHourlyUsd:.03350571,diskGiBHourlyUsd:.000054795,ipv4HourlyUsd:.005,egressAllowanceGiB:.5,egressUsdPerGiB:.12,
    otherAllowanceUsd:.02,alreadyIncurredUsd:.02,buildAdditionalUsd:0,pilotReferenceUsd:5,pricingEvidenceSha256:'d'.repeat(64),verifiedAt:NOW}});}
function journal(p){return {schema:1,kind:p.kind,missionId:uuid(4),planSha256:p.approvalSha256,startedAt:NOW,deadlineAt:NOW+7200000,
  admitUntil:NOW+p.admissionSeconds*1000,workerStopAt:NOW+6600000,phase:'creating_networks',hostEvidence:null,installation:null,
  workerStart:null,workerStop:null,collection:null,failure:null,apiPreparation:null,apiClosure:null,
  preexisting:Object.fromEntries(KINDS.map(k=>[k,[{id:'42',name:'preexisting'}]])),
  resources:Object.fromEntries(KINDS.map((k,i)=>[k,{intentAt:null,id:null,createdAt:null,createRequestId:uuid(10+i),deleteRequestId:uuid(20+i),
    createOp:null,deleteOp:null,deleteIntentAt:null,absentConfirmedAt:null}]))};}
function blocked(label){return new Proxy({}, {get(_target,key){assert.fail(`${label}.${String(key)} must not be used`);}});}
const noCall=()=>assert.fail('No preparation/observation callback during cleanup');
test('cleanupOnly with no journal refuses inside the exclusive lock before any provider, guest or write',async()=>{
  const p=plan(),calls=[];let locked=false;
  await assert.rejects(runOperationalPilot({plan:p,approvalSha256:p.approvalSha256,cleanupOnly:true,
    store:{exclusive:async action=>{calls.push('exclusive');locked=true;try{return await action();}finally{locked=false;}},
      read:async()=>{assert.equal(locked,true);calls.push('read');return null;},write:()=>assert.fail('No new journal')},
    provider:blocked('provider'),guest:blocked('guest'),prepareApi:noCall,observeApi:noCall,closeApi:noCall,
    now:()=>assert.fail('No inventory timing for a fresh cleanup mission')}),{code:'media_pilot_cleanup_journal_required'});
  assert.deepEqual(calls,['exclusive','read']);assert.equal(locked,false);
});
test('cleanupOnly rejects nonboolean mode before acquiring or reading anything',async()=>{
  const p=plan();await assert.rejects(runOperationalPilot({plan:p,approvalSha256:p.approvalSha256,cleanupOnly:'true',
    store:blocked('store'),provider:blocked('provider'),guest:blocked('guest'),prepareApi:noCall,observeApi:noCall,closeApi:noCall}),
    {code:'media_pilot_cleanup_mode_invalid'});
});
function existingFixture({withVm=false}={}){
  const p=plan();let state=journal(p);const calls=[],resources=new Map();
  for(const kind of withVm?['networks','instances','disks']:['networks']){
    const id=String(100+KINDS.indexOf(kind)),record=state.resources[kind];record.id=id;record.createdAt=NOW;record.intentAt=NOW;
    resources.set(kind,{id,name:resourceName(state.missionId,kind),selfLink:resourcePath(p.infrastructure,state.missionId,kind),
      description:description(p.infrastructure,state.missionId),creationTimestamp:new Date(NOW).toISOString()});
  }
  if(withVm){state.phase='worker_start_intent';state.workerStart={phase:'intent',at:NOW};state.apiPreparation={intentAt:NOW};
    state.apiClosure={requestId:uuid(30),phase:'pending'};state.hostEvidence={runtimeRevision:'e'.repeat(64),bootId:uuid(31)};}
  const provider={
    async get(kind,missionId){assert.equal(missionId,state.missionId);calls.push('get_'+kind);return structuredClone(resources.get(kind)||null);},
    async destroy(kind,s){assert.equal(s.missionId,state.missionId);calls.push('destroy_'+kind);const resource=resources.get(kind);assert(resource);
      resources.delete(kind);if(kind==='instances')resources.delete('disks');return {status:'DONE',targetId:resource.id};},
    async inventory(kind){calls.push('inventory_'+kind);return [{id:'42',name:'preexisting'},...(resources.has(kind)?[structuredClone(resources.get(kind))]:[])];},
    preflight:noCall,create:noCall,pollOperation:noCall};
  const guest={prepareLocalIdentity:noCall,createIdentityPayload:noCall,bindHost:noCall,preflight:noCall,install:noCall,
    probeInstalled:noCall,startWorker:noCall,async stopWorker(){calls.push('stop');return {stopped:true,nativeTerminationProved:true};},
    async collectOperational(){calls.push('collect');return {sanitized:true,sha256:'f'.repeat(64),executionsObserved:0};}};
  const closeApi=async c=>{assert.equal(c.missionId,state.missionId);assert.equal(c.closureRequestId,uuid(30));calls.push('close_api');
    const receipt={schema:1,missionId:c.missionId,closureRequestId:c.closureRequestId,admissionClosed:true,launchClosed:true,
      connectionEnabled:false,publicationEnabled:false,metaWindowEnabled:false,sentinelSha256:'e'.repeat(64)};
    return {...receipt,receiptSha256:sha256(canonical(receipt))};};
  const execute=()=>runOperationalPilot({plan:p,approvalSha256:p.approvalSha256,cleanupOnly:true,provider,guest,
    prepareApi:noCall,observeApi:noCall,closeApi,now:()=>NOW+1000,sleep:noCall,
    store:{exclusive:async action=>action(),read:async()=>structuredClone(state),write:async value=>{calls.push('write');state=structuredClone(value);}}});
  return {execute,calls,resources,state:()=>structuredClone(state)};
}
test('cleanupOnly with an existing owned journal deletes only its resource and verifies previous inventory',async()=>{
  const f=existingFixture(),result=await f.execute();
  assert.equal(result.destructionConfirmed,true);assert.equal(result.billingMayContinue,false);assert.equal(f.resources.size,0);
  assert.equal(result.failure,'media_pilot_resume_cleanup_only');assert.deepEqual(f.calls.filter(c=>c.startsWith('destroy_')),['destroy_networks']);
  assert.equal(Object.values(result.preexistingPreserved).every(Boolean),true);
  assert.equal(f.calls.filter(c=>c.startsWith('inventory_')).length,KINDS.length);
  const before=f.calls.length;await f.execute();assert.equal(f.calls.length,before,'Already destroyed journal does not replay cleanup');
});
test('cleanupOnly retains API closure, worker drain and VM deletion without preparation or launch',async()=>{
  const f=existingFixture({withVm:true}),result=await f.execute();
  assert.equal(result.destructionConfirmed,true);assert.equal(result.apiAdmissionClosed,true);assert.equal(result.apiClosurePending,false);
  assert.equal(result.workerStop.nativeTerminationProved,true);assert.equal(result.collection.sanitized,true);
  assert(f.calls.indexOf('close_api')<f.calls.indexOf('stop'));assert(f.calls.indexOf('stop')<f.calls.indexOf('destroy_instances'));
  assert.deepEqual(f.calls.filter(c=>c.startsWith('destroy_')),['destroy_instances','destroy_networks']);assert.equal(f.resources.size,0);
});
