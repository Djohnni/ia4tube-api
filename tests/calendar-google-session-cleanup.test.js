"use strict";
// The real session source composes the REAL operational controller. Only its
// filesystem/auth/provider/guest constructor boundaries are local fakes. No
// Google, SSH, package, credential file or cloud resource is accessed here.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {createOperationalPlan}=require('../scripts/media-pilot/google-plan');
const {runOperationalPilot}=require('../scripts/media-pilot/google-controller');
const {KINDS,resourceName,resourcePath,description}=require('../scripts/validation/vm-proof-google-plan');
const {canonical,sha256}=require('../scripts/validation/vm-proof-manifest');
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function plan(){return createOperationalPlan({imageId:'6257327608773510097',operatorIpv4:'177.125.241.34',packageSha256:'a'.repeat(64),
  packageReviewSha256:'b'.repeat(64),authorizationSha256:'c'.repeat(64),ownerCompanyId:uuid(1),ownerUserId:uuid(2),workerId:uuid(3),
  finance:{computeHourlyUsd:.03350571,diskGiBHourlyUsd:.000054795,ipv4HourlyUsd:.005,egressAllowanceGiB:.5,egressUsdPerGiB:.12,
    otherAllowanceUsd:.02,alreadyIncurredUsd:.02,buildAdditionalUsd:0,pilotReferenceUsd:5,pricingEvidenceSha256:'d'.repeat(64),verifiedAt:Date.now()}});}
function savedVm(p){const start=Date.now();return {schema:1,kind:p.kind,missionId:uuid(4),planSha256:p.approvalSha256,
  startedAt:start,deadlineAt:start+7200000,admitUntil:start+p.admissionSeconds*1000,workerStopAt:start+6600000,
  phase:'worker_start_intent',hostEvidence:{runtimeRevision:'e'.repeat(64),bootId:uuid(5)},installation:'passed',
  workerStart:{phase:'intent',at:start},workerStop:null,collection:null,failure:null,
  apiPreparation:{intentAt:start},apiClosure:{requestId:uuid(6),phase:'pending'},
  preexisting:Object.fromEntries(KINDS.map(k=>[k,[{id:'42',name:'preexisting'}]])),
  resources:Object.fromEntries(KINDS.map((k,i)=>[k,{intentAt:k==='instances'?start:null,id:k==='instances'?'100':null,createdAt:k==='instances'?start:null,
    createRequestId:uuid(10+i),deleteRequestId:uuid(20+i),createOp:null,deleteOp:null,deleteIntentAt:null,absentConfirmedAt:null}]))};}
function harness(p,state=null){
  let saved=state,resource=state?{id:'100',name:resourceName(state.missionId,'instances'),
    selfLink:resourcePath(p.infrastructure,state.missionId,'instances'),description:description(p.infrastructure,state.missionId),
    creationTimestamp:new Date(state.startedAt).toISOString()}:null;
  const calls=[],captures=[];let locked=false;
  const forbidden=name=>()=>{calls.push(name);assert.fail('Forbidden dependency '+name);};
  const store={root:'synthetic-private-root',exclusive:async action=>{calls.push('exclusive');locked=true;try{return await action();}finally{locked=false;}},
    read:async()=>{assert.equal(locked,true);calls.push('read');return structuredClone(saved);},
    write:async value=>{assert.equal(locked,true);calls.push('write');saved=structuredClone(value);}};
  const liveProvider=Object.freeze({create:forbidden('provider-create'),preflight:forbidden('provider-preflight'),
    async get(kind,missionId){calls.push('get-'+kind);assert.equal(missionId,state.missionId);return kind==='instances'?structuredClone(resource):null;},
    async destroy(kind){calls.push('destroy-'+kind);assert.equal(kind,'instances');assert(resource);resource=null;return {status:'DONE',targetId:'100'};},
    async inventory(kind){calls.push('inventory-'+kind);return [{id:'42',name:'preexisting'}];},pollOperation:forbidden('poll')});
  const mocks={
    'node:fs/promises':{lstat:forbidden('package-stat'),readFile:forbidden('package-read')},
    '../validation/vm-proof-local-state':{createLocalStore:async root=>{calls.push('store-construct');assert.equal(root,'synthetic-private-root');return store;}},
    '../validation/vm-proof-google-cli':{gcloudReader:async()=>{calls.push('auth-construct');return forbidden('auth-token-not-needed-by-fake-provider');}},
    '../validation/vm-proof-google-provider':{createGoogleProvider:options=>{calls.push('provider-construct');assert.equal(options.plan,p.infrastructure);return liveProvider;}},
    './google-guest':{createOperationalGuest:forbidden('guest-construct')},
    './google-controller':{runOperationalPilot:options=>{captures.push(options);return runOperationalPilot(options);}}
  };
  const file=path.resolve(__dirname,'../scripts/media-pilot/google-session.js'),localRequire=createRequire(file);
  const context=vm.createContext({require:name=>Object.hasOwn(mocks,name)?mocks[name]:localRequire(name),module:{exports:{}},Buffer,Date});
  new vm.Script(fs.readFileSync(file,'utf8'),{filename:file}).runInContext(context);
  const closeApi=async c=>{calls.push('close-api');assert.equal(c.missionId,state.missionId);assert.equal(c.closureRequestId,uuid(6));
    const receipt={schema:1,missionId:c.missionId,closureRequestId:c.closureRequestId,admissionClosed:true,launchClosed:true,
      connectionEnabled:false,publicationEnabled:false,metaWindowEnabled:false,sentinelSha256:'f'.repeat(64)};
    return {...receipt,receiptSha256:sha256(canonical(receipt))};};
  return {calls,captures,closeApi,forbidden,create:options=>context.module.exports.createOperationalSession({plan:p,stateRoot:'synthetic-private-root',google:{},closeApi,...options}),
    state:()=>saved,hasResource:()=>Boolean(resource)};
}
test('cleanup session requires neither package nor bridge nor guest; actual controller refuses a missing journal',async()=>{
  const p=plan(),f=harness(p),session=await f.create({cleanupOnly:true,
    getBridgeKey:f.forbidden('bridge-read'),prepareApi:f.forbidden('prepare'),observeApi:f.forbidden('observe')});
  await assert.rejects(session.execute({approvalSha256:p.approvalSha256,signal:AbortSignal.abort()}),{code:'media_pilot_cleanup_journal_required'});
  assert.equal(f.captures.length,1);const assembled=f.captures[0];assert.equal(assembled.cleanupOnly,true);assert.equal(assembled.signal,null);
  await assert.rejects(assembled.provider.create(),{code:'media_pilot_cleanup_only_operation_refused'});
  await assert.rejects(assembled.provider.preflight(),{code:'media_pilot_cleanup_only_operation_refused'});
  await assert.rejects(assembled.prepareApi(),{code:'media_pilot_cleanup_only_operation_refused'});
  assert.deepEqual(f.calls,['store-construct','auth-construct','provider-construct','exclusive','read']);
  assert.equal(f.state(),null);
});
test('cleanup session executes real saved-VM teardown without package, bridge, installation or native-stop claims',async()=>{
  const p=plan(),f=harness(p,savedVm(p));
  // An unusable package path and absent preparation/bridge callbacks are valid
  // for recovery: they must never become prerequisites for provider deletion.
  const session=await f.create({cleanupOnly:true,packagePath:'not-an-absolute-package'});
  const result=await session.execute({approvalSha256:p.approvalSha256,signal:AbortSignal.abort()});
  assert.equal(result.destructionConfirmed,true);assert.equal(result.billingMayContinue,false);assert.equal(result.apiAdmissionClosed,true);
  assert.equal(result.workerStop.nativeTerminationProved,false);assert.equal(result.collection.sanitized,false);assert.equal(f.hasResource(),false);
  assert(f.calls.indexOf('close-api')<f.calls.indexOf('destroy-instances'));
  assert.deepEqual(f.calls.filter(c=>c.startsWith('destroy-')),['destroy-instances']);
  assert.equal(Object.values(result.preexistingPreserved).every(Boolean),true);
  for(const name of ['package-stat','package-read','guest-construct','bridge-read','provider-create','provider-preflight','prepare','observe'])assert.equal(f.calls.includes(name),false,name);
});
test('ordinary execution still requires the package and normal callbacks before authentication or state setup',async()=>{
  const p=plan(),f=harness(p);
  await assert.rejects(f.create(),{code:'media_pilot_session_configuration_invalid'});assert.deepEqual(f.calls,[]);
  await assert.rejects(f.create({packagePath:path.resolve('synthetic-missing.tar'),getBridgeKey:f.forbidden('bridge-read'),
    prepareApi:f.forbidden('prepare'),observeApi:f.forbidden('observe')}));
  assert.deepEqual(f.calls,['package-stat']);
});
test('cleanup composition validates boolean mode and its closure callback before dependency construction',async()=>{
  const p=plan(),f=harness(p);
  await assert.rejects(f.create({cleanupOnly:'true'}),{code:'media_pilot_session_configuration_invalid'});
  await assert.rejects(f.create({cleanupOnly:true,closeApi:undefined}),{code:'media_pilot_session_configuration_invalid'});
  assert.deepEqual(f.calls,[]);
});
