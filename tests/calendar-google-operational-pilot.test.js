"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm");
const { createOperationalPlan, validateOperationalPlan } = require("../scripts/media-pilot/google-plan");
const { runOperationalPilot, activationWaitBudget, apiPreparationDiagnostic, transientObservationFailure } = require("../scripts/media-pilot/google-controller");
const { hostProbeScript, startScript, stopScript, collectionScript } = require("../scripts/media-pilot/google-guest");
const { createGoogleProvider } = require("../scripts/validation/vm-proof-google-provider");
const P = require("../scripts/validation/vm-proof-google-plan");
const { makeGoogleBootstrap } = require("../scripts/validation/vm-proof-google-bootstrap");
const {canonical,sha256}=require('../scripts/validation/vm-proof-manifest');
const clone = v => structuredClone(v), beginning = Date.parse("2026-09-19T17:00:00Z");
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
function makePlan(change = {}) {
  return createOperationalPlan({ imageId: "6257327608773510097", operatorIpv4: "177.125.241.34", packageSha256: "a".repeat(64), packageReviewSha256: "b".repeat(64),
    authorizationSha256: "c".repeat(64), ownerCompanyId: uuid(1), ownerUserId: uuid(2), workerId: uuid(3),
    maxExistenceSeconds: 14400, admissionSeconds: 12000,
    finance: { computeHourlyUsd: .03350571, diskGiBHourlyUsd: .000054795, ipv4HourlyUsd: .005, egressAllowanceGiB: .5,
      egressUsdPerGiB: .12, otherAllowanceUsd: .02, alreadyIncurredUsd: null, alreadyIncurredObservedAt: null,
      historicalPlanningReserveUsd: .5, historicalReserveIsObservedExpense: false, buildAdditionalUsd: 0, pilotReferenceUsd: 5,
      pricingEvidenceSha256: "d".repeat(64), verifiedAt: beginning }, ...change });
}
function fixture(flags = {}, plan = makePlan()) {
  const p = plan.infrastructure, resources = new Map(), calls = [], guestCalls = [], timeline=[], closeRequests=[],deleteAttempts=new Map(); let state = null, clock = beginning, nextId = 100n, observes = 0;
  const startup = makeGoogleBootstrap("-----BEGIN OPENSSH PRIVATE KEY-----\nYQ==\n-----END OPENSSH PRIVATE KEY-----\n", "ssh-ed25519 YQ== synthetic", "ssh-ed25519 Yg== synthetic");
  const link = s => "https://www.googleapis.com/compute/v1/" + s;
  const transport = async req => {
    calls.push(clone(req)); const {method, body} = req, [route, query] = req.pathname.replace("/compute/v1/", "").split("?");
    const chunks = route.split("/"), name = chunks.at(-1), kind = chunks.at(-2);
    if (req.hostname === "cloudresourcemanager.googleapis.com") return {status:200,json:{permissions:flags.noDelete?body.permissions.filter(p=>p!=="compute.instances.delete"):body.permissions}};
    if (method === "GET" && route === p.sourceImage) return {status:200,json:{id:p.sourceImageId,selfLink:link(route),status:"READY",architecture:"X86_64"}};
    if (method === "GET" && route.endsWith("machineTypes/e2-medium")) return {status:200,json:{guestCpus:2,memoryMb:4096}};
    if (method === "GET" && route === `projects/${p.project}`) return {status:200,json:{commonInstanceMetadata:{items:[]}}};
    if (method === "GET" && P.KINDS.includes(name)) return {status:200,json:{items:[{id:"42",name:"preexisting"},...[...resources.entries()].filter(([r])=>r.startsWith(route+"/")).map(([,v])=>v)]}};
    if (method === "GET") {
      const r = clone(resources.get(route) || null);
      if (r && flags.replaceId && kind === "instances" && guestCalls.includes("start")) r.id = "99999";
      return {status:r?200:404,json:r};
    }
    if (method === "POST") {
      assert.equal(resources.has(route+"/"+body.name),false);
      const r = {...clone(body),id:String(nextId++),selfLink:link(route+"/"+body.name),creationTimestamp:new Date(clock).toISOString()};
      if (name === "instances") {
        r.status = "RUNNING"; r.machineType = link(`projects/${p.project}/zones/${p.zone}/machineTypes/e2-medium`);
        const disk = body.disks[0].initializeParams, diskPath = `projects/${p.project}/zones/${p.zone}/disks/${disk.diskName}`;
        resources.set(diskPath,{id:String(nextId++),name:disk.diskName,description:disk.description,creationTimestamp:r.creationTimestamp,selfLink:link(diskPath),sizeGb:"50",
          type:link(`projects/${p.project}/zones/${p.zone}/diskTypes/pd-standard`),sourceImage:link(p.sourceImage),sourceImageId:p.sourceImageId});
        r.disks = [{boot:true,autoDelete:true,source:link(diskPath)}];r.networkInterfaces[0].accessConfigs[0].natIP="93.184.216.35";
        if (flags.badTimer) r.scheduling.instanceTerminationAction = "STOP";
      }
      resources.set(route+"/"+r.name,r);
      if (flags.unknownCreate === name) throw Error("private details must not be persisted");
      return {status:200,json:{name:"operation-"+String(nextId++),targetId:r.id,targetLink:r.selfLink,operationType:"insert",clientOperationId:new URLSearchParams(query).get("requestId"),status:"DONE"}};
    }
    if (method === "DELETE") {
      timeline.push('delete_'+kind);
      const r = resources.get(route); if (!r) return {status:404};
      if (flags.noDestroy === kind) return {status:403,json:{}};
      const attempt=(deleteAttempts.get(kind)||0)+1;deleteAttempts.set(kind,attempt);
      if(flags.unknownDeleteBeforeOnce===kind&&attempt===1)throw Error('private request lost before provider acceptance');
      resources.delete(route);
      if (kind === "instances") for (const [k] of resources) if (k.includes("/disks/")) resources.delete(k);
      if (flags.cleanupOverrun && kind === "instances") clock = beginning + 14400001;
      if (flags.unknownDelete === kind) throw Error("private response loss");
      return {status:200,json:{name:"operation-"+String(nextId++),targetId:r.id,targetLink:r.selfLink,operationType:"delete",clientOperationId:new URLSearchParams(query).get("requestId"),status:"DONE"}};
    }
    throw Error("unexpected request");
  };
  const provider = createGoogleProvider({plan:p,transport});
  const store = {exclusive:async fn=>fn(),read:async()=>clone(state),write:async s=>{state=clone(s);}};
  const guest = {
    prepareLocalIdentity:async()=>{},createIdentityPayload:()=>({startupScript:startup}),bindHost:async()=>{},
    preflight:async()=>{guestCalls.push("preflight");return {passed:!flags.badHost,convertersStarted:0};},
    install:async()=>{guestCalls.push("install");if(flags.installFails)throw Error("private installation details");return {passed:true,convertersStarted:0,diagnostic:{installationPassed:true}};},
    probeInstalled:async()=>{guestCalls.push("probe");return {controlsProved:!flags.badNative,convertersStarted:0,bootId:uuid(4),runtimeRevision:"e".repeat(64),receiptSha256:"f".repeat(64)};},
    startWorker:async c=>{guestCalls.push("start");if(flags.startUnknown)throw Error("private key may not be logged");return {active:true,recurring:false,workerId:plan.workerId,stopAt:c.stopAt};},
    stopWorker:async()=>{guestCalls.push("stop");timeline.push('stop');if(flags.stopFails)throw Error("private");return {stopped:true,nativeTerminationProved:true};},
    collectOperational:async()=>{guestCalls.push("collect");if(flags.collectFails)throw Error("private");return {sanitized:true,sha256:"1".repeat(64),executionsObserved:3};},
    runSequence:async()=>{throw Error("MUST NEVER RUN OLD SYNTHETIC PROOF");}
  };
  const closeApi=async c=>{
    guestCalls.push('close_api');timeline.push('close_api');closeRequests.push({missionId:c.missionId,closureRequestId:c.closureRequestId});
    if(flags.closeThrows)throw Error('private SSH details must not be retained');
    const content={schema:1,missionId:flags.closeWrongMission?uuid(99):c.missionId,closureRequestId:flags.closeWrongRequest?uuid(98):c.closureRequestId,
      admissionClosed:!flags.closeAdmissionFalse,launchClosed:!flags.closeLaunchFalse,connectionEnabled:flags.closeExternalGate===true,publicationEnabled:false,metaWindowEnabled:false,sentinelSha256:'7'.repeat(64)};
    return {...content,receiptSha256:flags.closeBadHash?'8'.repeat(64):sha256(canonical(content))};
  };
  const prepareApi = async c => {
    guestCalls.push("prepare_api");
    if (flags.prepareThrows) throw Error("private DB credentials must not be logged");
    if (flags.expireDuringPreparation) clock = c.admitUntil;
    return {ready:!flags.apiUnavailable,ownerCompanyId:flags.wrongTenant?uuid(90):plan.ownerCompanyId,ownerUserId:plan.ownerUserId,workerId:plan.workerId,
      runtimeRevision:c.hostEvidence.runtimeRevision,connectionEnabled:false,publicationEnabled:flags.openGate===true,metaWindowEnabled:false,
      admitUntil:c.admitUntil,finishBy:c.finishBy,receiptSha256:"2".repeat(64)};
  };
  const observeApi = async()=>{observes++;return {finished:flags.waitUntilDeadline?false:observes>1,gatesClosed:!flags.observationOpen,receiptSha256:"3".repeat(64)};};
  const execute = (options={})=>{const {guestOverride={},...rest}=options;return runOperationalPilot({plan,approvalSha256:plan.approvalSha256,provider,store,
    guest:{...guest,...guestOverride},prepareApi,observeApi,closeApi,now:()=>clock,sleep:async ms=>{clock+=ms;},...rest});};
  return {execute,resources,calls,guestCalls,timeline,closeRequests,getState:()=>clone(state),setState:s=>{state=clone(s);},setTime:t=>{clock=t;},flags,plan};
}
test("operational plan is owner-bound, priced, no recurrence or old synthetic cases",()=>{
  const p=makePlan();assert.equal(validateOperationalPlan(p),p);assert.equal(p.syntheticCases,0);assert.equal(p.maxInstallInvocations,1);assert.equal(p.maxWorkerStarts,1);
  assert.equal(p.schema,2);assert.equal(p.maxExistenceSeconds,14400);assert.equal(p.admissionSeconds,12000);
  assert.equal(p.cleanupReserveSeconds,1200);assert.equal(p.drainReserveSeconds,1200);
  assert.equal(p.finance.invoiceCapGuaranteed,false);assert.ok(Math.abs(p.finance.estimatedMaximumUsd-.24498184)<1e-12);
  assert.equal(p.finance.alreadyIncurredUsd,null);assert.equal(p.finance.priorBudgetBasisUsd,.5);
  assert.equal(p.finance.priorBudgetBasisKind,'planning_reserve');
  assert.ok(Math.abs(p.finance.estimatedPlanningTotalUsd-.74498184)<1e-12);
  assert.equal(p.infrastructure.finance.durationHours,4);assert.equal(p.infrastructure.finance.estimatedInfrastructureUsd,.16498184);
  assert.equal(p.infrastructure.resolution.cleanupReserveSeconds,1200);assert.equal(p.infrastructure.resolution.maxInstallInvocations,1);
  assert.throws(()=>P.createGooglePlan({imageId:"6257327608773510097",operatorIpv4:"177.125.241.34",maxExistenceSeconds:14400}),/extended_requires_resolution_binding/);
  assert.throws(()=>validateOperationalPlan({...p,admissionSeconds:12001}),/window_invalid/);
  assert.throws(()=>validateOperationalPlan({...p,externalPublication:true}),/plan_changed/);
  assert.throws(()=>validateOperationalPlan(p,{now:beginning+86400001}),/pricing_check_stale/);
  const inputFinance=Object.fromEntries(Object.entries(p.finance).filter(([k])=>!["estimatedInfrastructureUsd","estimatedMaximumUsd","priorBudgetBasisUsd","priorBudgetBasisKind","estimatedPlanningTotalUsd","invoiceCapGuaranteed"].includes(k)));
  assert.throws(()=>makePlan({finance:{...inputFinance,alreadyIncurredUsd:5,alreadyIncurredObservedAt:beginning}}),/budget_exceeded/);
});
test("measured spend and historical reserve remain distinct and use only the larger budget basis",()=>{
  const base=makePlan(),input=Object.fromEntries(Object.entries(base.finance).filter(([k])=>!["estimatedInfrastructureUsd","estimatedMaximumUsd","priorBudgetBasisUsd","priorBudgetBasisKind","estimatedPlanningTotalUsd","invoiceCapGuaranteed"].includes(k)));
  const low=makePlan({finance:{...input,alreadyIncurredUsd:.03,alreadyIncurredObservedAt:beginning}});
  assert.equal(low.finance.priorBudgetBasisUsd,.5);assert.equal(low.finance.priorBudgetBasisKind,'planning_reserve');
  const high=makePlan({finance:{...input,alreadyIncurredUsd:.6,alreadyIncurredObservedAt:beginning}});
  assert.equal(high.finance.priorBudgetBasisUsd,.6);assert.equal(high.finance.priorBudgetBasisKind,'measured_spend');
  assert.throws(()=>makePlan({finance:{...input,alreadyIncurredUsd:0,alreadyIncurredObservedAt:null}}),/finance_invalid/);
});

test("schema-2 two-hour mission executes and cleans up without expanding duration or reserves",async()=>{
  const input=Object.fromEntries(Object.entries(makePlan().finance).filter(([k])=>!["estimatedInfrastructureUsd",
    "estimatedMaximumUsd","priorBudgetBasisUsd","priorBudgetBasisKind","estimatedPlanningTotalUsd","invoiceCapGuaranteed"].includes(k)));
  const p=makePlan({schema:2,maxExistenceSeconds:7200,admissionSeconds:5400,
    finance:{...input,alreadyIncurredUsd:.2,alreadyIncurredObservedAt:beginning,historicalPlanningReserveUsd:0}});
  const f=fixture({},p),r=await f.execute();
  assert.equal(r.failure,null);assert.equal(r.destructionConfirmed,true);assert.equal(f.resources.size,0);
  assert.equal(r.deadlineAt-r.startedAt,7200000);assert.equal(r.admitUntil-r.startedAt,5400000);
  assert.equal(r.workerStopAt-r.startedAt,6600000);assert.equal(p.drainReserveSeconds,600);
  assert.equal(p.finance.estimatedInfrastructureUsd,.08249092);
  assert.equal(p.finance.priorBudgetBasisKind,'measured_spend');assert.equal(p.finance.priorBudgetBasisUsd,.2);
  assert.throws(()=>validateOperationalPlan(p,{now:beginning-1}),/pricing_check_stale/);
  const newerSpend=makePlan({schema:2,maxExistenceSeconds:7200,admissionSeconds:5400,
    finance:{...input,alreadyIncurredUsd:.2,alreadyIncurredObservedAt:beginning+1000,historicalPlanningReserveUsd:0}});
  assert.throws(()=>validateOperationalPlan(newerSpend,{now:beginning}),/finance_invalid/);
  assert.equal(validateOperationalPlan(newerSpend,{now:beginning+1000}),newerSpend);
});

test("historical two-hour schema-1 plans stay readable but cannot launch resources",async()=>{
  const input=Object.fromEntries(Object.entries(makePlan().finance).filter(([k])=>!["estimatedInfrastructureUsd",
    "estimatedMaximumUsd","priorBudgetBasisUsd","priorBudgetBasisKind","estimatedPlanningTotalUsd","invoiceCapGuaranteed",
    "alreadyIncurredObservedAt","historicalPlanningReserveUsd","historicalReserveIsObservedExpense"].includes(k)));
  const p=makePlan({schema:1,maxExistenceSeconds:7200,admissionSeconds:5400,finance:{...input,alreadyIncurredUsd:.2}});
  assert.equal(validateOperationalPlan(p),p);
  const f=fixture({},p);
  await assert.rejects(f.execute(),{code:'media_pilot_legacy_plan_new_launch_refused'});
  assert.equal(f.calls.length,0);assert.equal(f.resources.size,0);assert.equal(f.getState(),null);
});
test("mission conservative four-hour costs remain inside the single five-dollar pilot reference",()=>{
  const real=makePlan({finance:{computeHourlyUsd:.03350571,diskGiBHourlyUsd:.000054795,ipv4HourlyUsd:.005,
    egressAllowanceGiB:5,egressUsdPerGiB:.19,otherAllowanceUsd:2,alreadyIncurredUsd:null,alreadyIncurredObservedAt:null,
    historicalPlanningReserveUsd:.5,historicalReserveIsObservedExpense:false,buildAdditionalUsd:0,pilotReferenceUsd:5,
    pricingEvidenceSha256:"d".repeat(64),verifiedAt:beginning}});
  assert.ok(Math.abs(real.finance.estimatedInfrastructureUsd-.16498184)<1e-12);
  assert.ok(Math.abs(real.finance.estimatedMaximumUsd-3.11498184)<1e-12);
  assert.ok(Math.abs(real.finance.estimatedPlanningTotalUsd-3.61498184)<1e-12);
  assert.throws(()=>makePlan({finance:{computeHourlyUsd:.03350571,diskGiBHourlyUsd:.000054795,ipv4HourlyUsd:.005,
    egressAllowanceGiB:5,egressUsdPerGiB:.19,otherAllowanceUsd:2,alreadyIncurredUsd:1.9,alreadyIncurredObservedAt:beginning,
    historicalPlanningReserveUsd:.5,historicalReserveIsObservedExpense:false,buildAdditionalUsd:0,pilotReferenceUsd:5,
    pricingEvidenceSha256:"d".repeat(64),verifiedAt:beginning}}),/budget_exceeded/);
});
test("activation readiness owns the remaining admission window, not a fixed ten-minute timeout",()=>{
  const state={admitUntil:beginning+12000000};
  assert.equal(activationWaitBudget(state,beginning),12000000);
  assert.equal(activationWaitBudget(state,beginning+660000),11340000);
  assert.throws(()=>activationWaitBudget(state,state.admitUntil),{code:'media_pilot_activation_deadline'});
});
test("API readiness failure persists only a bounded sanitized terminal diagnostic",async()=>{
  const f=fixture(),privateError=Object.assign(Error("password=must-never-enter-the-journal"),{
    code:"media_api_control_http_unavailable",sourceCode:"media_owner_response_refused",statusCode:401,
    transportCode:"ECONNRESET",activationState:"human_confirmed",credential:"secret"});
  const r=await f.execute({prepareApi:async()=>{throw privateError;}}),diagnostic=f.getState().apiPreparation.diagnostic;
  assert.deepEqual(diagnostic,{phase:"prepare_api",code:"media_api_control_http_unavailable",
    sourceCode:"media_owner_response_refused",statusCode:401,transportCode:"ECONNRESET",
    activationState:"human_confirmed",observedAt:beginning});
  assert.equal(r.failure,"media_pilot_operation_failed");assert.equal(r.destructionConfirmed,true);
  assert.doesNotMatch(JSON.stringify(f.getState()),/password|must-never|credential|secret/);
  assert.deepEqual(apiPreparationDiagnostic({code:"unexpected",sourceCode:"private",statusCode:999,
    transportCode:"bad",activationState:"unknown",message:"secret"},beginning),{
    phase:"prepare_api",code:"media_pilot_unclassified_failure",sourceCode:null,statusCode:null,
    transportCode:null,activationState:null,observedAt:beginning});
  assert.deepEqual(apiPreparationDiagnostic({code:"media_api_control_password_abc",sourceCode:"media_owner_token_xyz",
    statusCode:418,transportCode:"ECREDENTIAL_SECRET",activationState:"human_confirmed_secret"},beginning),{
    phase:"prepare_api",code:"media_pilot_unclassified_failure",sourceCode:null,statusCode:null,
    transportCode:null,activationState:null,observedAt:beginning});
});
test("operational owner accepts derived UUIDv5 while worker stays random UUIDv4",()=>{
  const ownerCompanyId='00000000-0000-5000-8000-000000000001',ownerUserId='00000000-0000-5000-8000-000000000002';
  const p=makePlan({ownerCompanyId,ownerUserId});
  assert.equal(validateOperationalPlan(p),p);assert.equal(p.ownerCompanyId,ownerCompanyId);assert.equal(p.ownerUserId,ownerUserId);
  assert.throws(()=>makePlan({workerId:ownerCompanyId}),/plan_binding_invalid/);
  assert.throws(()=>makePlan({ownerCompanyId:'00000000-0000-5000-0000-000000000001'}),/plan_binding_invalid/);
});
test("single operational install/start, host bound API readiness, collect and complete external destruction",async()=>{
  const f=fixture(),r=await f.execute();assert.equal(r.failure,null);assert.equal(r.destructionConfirmed,true);assert.equal(r.syntheticCases,0);assert.equal(r.invoiceUsd,null);
  assert.equal(r.newWindowEstimateUsd,f.plan.finance.estimatedMaximumUsd);assert.equal(r.priorBudgetBasisUsd,.5);
  assert.equal(r.priorBudgetBasisKind,'planning_reserve');assert.equal(r.planningTotalUsd,f.plan.finance.estimatedPlanningTotalUsd);
  assert.equal(f.resources.size,0);assert.deepEqual(f.guestCalls,["preflight","install","probe","prepare_api","start","close_api","stop","collect"]);
  assert.equal(r.apiAdmissionClosed,true);assert.equal(r.apiClosurePending,false);
  assert.equal(f.getState().apiPreparation.waitUntil,r.admitUntil);
  assert.ok(Object.values(r.preexistingPreserved).every(Boolean));assert.equal(r.hostEvidence.terminationTime,r.deadlineAt);
  await f.execute();assert.equal(f.guestCalls.filter(x=>x==="start").length,1);
});
test("controller host evidence and window are accepted by the exact production API contract",async()=>{
  const {validateProductionPilotConfig}=require('../src/social/calendar/imports/production-pilot-config');
  const f=fixture(),result=await f.execute(),s=f.getState(),p=f.plan;
  const env={ENVIRONMENT:'production',RENDER_SERVICE_ID:'srv-d8708kd7vvec73ap1p6g',PUBLIC_API_BASE_URL:'https://ia4tube-api.onrender.com',
    SOCIAL_PERSISTENCE_ENABLED:'true',SOCIAL_CALENDAR_ENABLED:'true',SOCIAL_EXTERNAL_CONNECTION_ENABLED:'false',SOCIAL_EXTERNAL_PUBLICATION_ENABLED:'false',META_APP_REVIEW_WINDOW_ENABLED:'false'};
  const config={schema:1,missionId:s.missionId,owner:{companyId:p.ownerCompanyId,userId:p.ownerUserId},workerId:p.workerId,runtimeRevision:result.hostEvidence.runtimeRevision,
    bridgeKeyBase64:Buffer.alloc(32,8).toString('base64'),
    capacityDatabaseUrl:'postgresql://ia4tube_media_capacity_runtime:synthetic-only@dpg-dae4tmf40ujc73dr2dog-a.oregon-postgres.render.com/ia4tube_social_production',
    transferDatabaseUrl:'postgresql://ia4tube_media_transfer_runtime:synthetic-only@dpg-dae4tmf40ujc73dr2dog-a.oregon-postgres.render.com/ia4tube_social_production',
    createdAt:s.startedAt,admitUntil:s.admitUntil,finishBy:s.deadlineAt,hostEvidence:result.hostEvidence,
    musicRights:{companyId:p.ownerCompanyId,instagramCommercialUse:true,endUserSublicensing:false,evidenceId:'synthetic-owner-rights',validFrom:s.startedAt,validUntil:s.deadlineAt}};
  const checked=validateProductionPilotConfig(config,{env,now:s.startedAt});assert.equal(checked.hostEvidence.deletionAction,'DELETE');checked.bridgeKey.fill(0);
});
for(const flag of ["badHost","installFails","badNative","apiUnavailable","wrongTenant","openGate","prepareThrows","expireDuringPreparation","badTimer"])
  test(flag+" fails closed before worker start and destroys only owned resources",async()=>{
    const f=fixture({[flag]:true}),r=await f.execute();assert.notEqual(r.failure,null);assert.equal(r.destructionConfirmed,true);assert.equal(f.guestCalls.includes("start"),false);assert.equal(f.resources.size,0);
    assert.doesNotMatch(JSON.stringify(r),/private DB|private installation/);
  });
test("lost start response cannot replay and still stops/collects/deletes",async()=>{
  const f=fixture({startUnknown:true}),r=await f.execute();assert.equal(r.destructionConfirmed,true);assert.equal(f.guestCalls.filter(x=>x==="start").length,1);assert.ok(f.guestCalls.includes("stop"));await f.execute();assert.equal(f.guestCalls.filter(x=>x==="start").length,1);
});
test("API observation detects gates opened and exits instead of admitting external work",async()=>{
  const f=fixture({observationOpen:true}),r=await f.execute();assert.equal(r.failure,"media_pilot_pilot_observation_invalid");assert.equal(r.destructionConfirmed,true);
});
test("transient read-only observation timeout is retried without replaying worker start or provider writes",async()=>{
  const f=fixture();let observations=0;
  const r=await f.execute({observeApi:async()=>{
    observations++;
    if(observations===1)throw Object.assign(Error("synthetic timeout"),{code:"media_api_control_http_unavailable",sourceCode:"media_owner_timeout"});
    return {finished:true,gatesClosed:true,receiptSha256:"3".repeat(64)};
  }});
  assert.equal(r.failure,null);assert.equal(r.destructionConfirmed,true);assert.equal(observations,2);
  assert.equal(f.guestCalls.filter(value=>value==="start").length,1);
  assert.equal(f.calls.filter(call=>call.method==="POST"&&call.pathname.includes("/instances?")).length,1);
});
test("transient observation retry never extends the worker or cleanup deadlines",async()=>{
  const f=fixture();let observations=0;
  const r=await f.execute({observeApi:async context=>{
    observations++;f.setTime(context.stopAt);
    throw Object.assign(Error("synthetic timeout at boundary"),{code:"media_api_control_http_unavailable",sourceCode:"media_owner_timeout"});
  }});
  assert.equal(observations,1);assert.equal(r.failure,"media_pilot_observation_unavailable");
  assert.equal(r.destructionConfirmed,true);assert.equal(r.billingMayContinue,false);
  assert.ok(f.getState().finishedAt<=r.deadlineAt);assert.equal(f.guestCalls.filter(value=>value==="start").length,1);
});
test("persistent transient observation outage fails closed after a bounded retry count",async()=>{
  const f=fixture();let observations=0;
  const r=await f.execute({observeApi:async()=>{
    observations++;throw Object.assign(Error("synthetic persistent timeout"),
      {code:"media_api_control_http_unavailable",sourceCode:"media_owner_timeout"});
  }});
  assert.equal(observations,3);assert.equal(r.failure,"media_pilot_observation_unavailable");
  assert.equal(r.destructionConfirmed,true);assert.equal(r.billingMayContinue,false);
  assert.equal(f.guestCalls.filter(value=>value==="start").length,1);
});
test("only enumerated observation availability failures are retryable",()=>{
  for(const error of [
    {code:"media_api_control_http_unavailable",statusCode:503},
    {code:"media_api_control_http_unavailable",sourceCode:"media_owner_timeout"},
    {code:"media_api_control_http_unavailable",sourceCode:"media_owner_response_unconfirmed"},
    {code:"media_api_control_http_unavailable",sourceCode:"media_owner_transport_failed",transportCode:"ECONNRESET"},
    {code:"media_api_control_deadline"},{code:"vm_proof_operation_timeout"}
  ])assert.equal(transientObservationFailure(error),true);
  for(const error of [
    {code:"media_api_control_http_unavailable",statusCode:401,sourceCode:"media_owner_response_refused"},
    {code:"media_api_control_http_unavailable",sourceCode:"media_owner_login_unconfirmed"},
    {code:"media_api_control_http_unavailable",sourceCode:"media_owner_response_unconfirmed",transportCode:"CERT_HAS_EXPIRED"},
    {code:"media_api_control_http_unavailable",sourceCode:"media_owner_transport_failed",transportCode:"CERT_HAS_EXPIRED"},
    {code:"media_api_control_pilot_receipt_invalid"}
  ])assert.equal(transientObservationFailure(error),false);
});
for(const error of [
  {code:"media_api_control_http_unavailable",statusCode:401,sourceCode:"media_owner_response_refused"},
  {code:"media_api_control_pilot_receipt_invalid"}
])test("fatal auth or schema observation error is not retried",async()=>{
  const f=fixture();let observations=0;
  const r=await f.execute({observeApi:async()=>{observations++;throw Object.assign(Error("synthetic fatal"),error);}});
  assert.equal(r.failure,"media_pilot_operation_failed");assert.equal(r.destructionConfirmed,true);assert.equal(observations,1);
  assert.equal(f.guestCalls.filter(value=>value==="start").length,1);
});
test("no human activity ends at bounded worker window and reserves provider cleanup",async()=>{
  const f=fixture({waitUntilDeadline:true}),r=await f.execute();assert.equal(r.failure,null);assert.equal(r.destructionConfirmed,true);
  assert.equal(r.admitUntil,r.startedAt+12000000);assert.equal(r.workerStopAt,r.startedAt+13200000);
  assert.equal(r.deadlineAt,r.startedAt+14400000);assert.ok(f.getState().finishedAt<=r.deadlineAt);
});
test("cleanup continues after the absolute deadline but records the overrun instead of claiming on-time completion",async()=>{
  const f=fixture({cleanupOverrun:true}),r=await f.execute();assert.equal(r.destructionConfirmed,true);assert.equal(r.billingMayContinue,false);
  assert.equal(r.completedWithinDeadline,false);assert.equal(r.deadlineOverrunMs,1);
  assert.equal(r.failure,'media_pilot_cleanup_deadline_overrun');assert.equal(f.resources.size,0);
});
for(const kind of ["networks","subnetworks","firewalls","instances"])test("lost "+kind+" insertion reconciles exact name without duplicate POST",async()=>{
  const f=fixture({unknownCreate:kind}),r=await f.execute();assert.equal(r.destructionConfirmed,true);assert.equal(r.failure,null);assert.equal(f.calls.filter(c=>c.method==="POST"&&c.pathname.includes('/'+kind+'?')).length,1);
});
test("lost delete reconciles absence without repeating deletion",async()=>{
  const f=fixture({unknownDelete:"instances"}),r=await f.execute();assert.equal(r.destructionConfirmed,true);assert.equal(f.calls.filter(c=>c.method==="DELETE"&&c.pathname.includes('/instances/')).length,1);
});
test("lost delete before provider acceptance is retried only on cleanup re-entry with the same idempotency key",async()=>{
  const f=fixture({unknownDeleteBeforeOnce:"instances"}),first=await f.execute();
  assert.equal(first.destructionConfirmed,false);assert.equal(first.billingMayContinue,true);
  const before=f.calls.filter(c=>c.method==='DELETE'&&c.pathname.includes('/instances/'));assert.equal(before.length,1);
  const second=await f.execute(),after=f.calls.filter(c=>c.method==='DELETE'&&c.pathname.includes('/instances/'));
  assert.equal(second.destructionConfirmed,true);assert.equal(second.billingMayContinue,false);assert.equal(after.length,2);
  assert.equal(new URL('https://example.invalid'+before[0].pathname).searchParams.get('requestId'),
    new URL('https://example.invalid'+after[1].pathname).searchParams.get('requestId'));
  assert.equal(f.guestCalls.filter(value=>value==='install').length,1);assert.equal(f.guestCalls.filter(value=>value==='start').length,1);
});
test("failed stop or collection still prioritizes external destroy without false native claim",async()=>{
  const f=fixture({stopFails:true,collectFails:true}),r=await f.execute();assert.equal(r.destructionConfirmed,true);assert.equal(r.workerStop.nativeTerminationProved,false);assert.equal(r.collection.sanitized,false);
});
test("changed VM identity is never deleted and is reported as cleanup required",async()=>{
  const f=fixture({replaceId:true}),r=await f.execute();assert.equal(r.destructionConfirmed,false);assert.equal(r.billingMayContinue,true);assert.equal(f.calls.filter(c=>c.method==="DELETE").length,0);
});
test("missing destroy permission fails before resource creation",async()=>{
  const f=fixture({noDelete:true}),r=await f.execute();assert.equal(r.destructionConfirmed,true);assert.equal(f.calls.filter(c=>c.method==="POST"&&c.pathname.startsWith('/compute')).length,0);
});
test("resume is cleanup-only even after saved worker start intent",async()=>{
  const f=fixture({noDestroy:"instances"});const first=await f.execute();assert.equal(first.destructionConfirmed,false);
  const calls=f.guestCalls.length;await f.execute();assert.equal(f.guestCalls.slice(calls).includes("install"),false);assert.equal(f.guestCalls.slice(calls).includes("start"),false);
});
test("generated remote programs parse and have no launch of synthetic test suite",()=>{
  const scripts=[hostProbeScript(),startScript({missionId:uuid(5),workerId:uuid(3),runtimeRevision:"e".repeat(64),stopAt:beginning+6600000,keyBase64:Buffer.alloc(32,7).toString("base64")}),stopScript(),collectionScript()];
  for(const s of scripts){assert.doesNotThrow(()=>new vm.Script(s));assert.doesNotMatch(s,/--test|runSequence|vm-proof-guest|DATABASE_URL|gcloud/);}
  assert.match(scripts[1],/RuntimeMaxSec/);assert.match(scripts[1],/Restart=no/);assert.match(scripts[1],/'wx'/);
  assert.doesNotMatch(scripts[1],/systemctl.*enable/);
  const extended=startScript({missionId:uuid(5),workerId:uuid(3),runtimeRevision:"e".repeat(64),stopAt:beginning+13200000,
    keyBase64:Buffer.alloc(32,7).toString("base64"),maximumRuntimeSeconds:13200});
  assert.doesNotThrow(()=>new vm.Script(extended));assert.match(extended,/maximumRuntimeSeconds/);
});
test('API closure callback is mandatory before any provider access',async()=>{
  const f=fixture();await assert.rejects(f.execute({closeApi:undefined}),/api_control_required/);assert.equal(f.calls.length,0);
});
test('closure fences admissions and launches before worker stop and provider cleanup',async()=>{
  const f=fixture(),r=await f.execute();assert.equal(r.apiClosure.phase,'confirmed');
  assert.ok(f.timeline.indexOf('close_api')<f.timeline.indexOf('stop'));
  assert.ok(f.timeline.indexOf('close_api')<f.timeline.indexOf('delete_instances'));
  assert.equal(f.closeRequests.length,1);await f.execute();assert.equal(f.closeRequests.length,1);
});
for(const flag of ['prepareThrows','apiUnavailable','wrongTenant','openGate','startUnknown'])test('uncertain or failed '+flag+' still invokes same mission closure',async()=>{
  const f=fixture({[flag]:true}),r=await f.execute();assert.equal(f.closeRequests.length,1);assert.equal(r.apiAdmissionClosed,true);assert.equal(r.destructionConfirmed,true);
});
for(const flag of ['closeThrows','closeWrongMission','closeWrongRequest','closeAdmissionFalse','closeLaunchFalse','closeExternalGate','closeBadHash'])
  test('invalid or failed '+flag+' reports pending closure but never blocks VM destruction',async()=>{
    const f=fixture({[flag]:true}),r=await f.execute();assert.equal(r.apiAdmissionClosed,false);assert.equal(r.apiClosurePending,true);
    assert.equal(r.apiClosure.failure,'media_pilot_api_closure_unconfirmed');assert.equal(r.destructionConfirmed,true);assert.equal(f.resources.size,0);
    assert.doesNotMatch(JSON.stringify(r),/private SSH details/);
  });
test('cleanup-only resume reconciles the same closure after all resources are destroyed, without worker replay',async()=>{
  const f=fixture({closeThrows:true}),a=await f.execute();assert.equal(a.destructionConfirmed,true);assert.equal(a.apiClosurePending,true);
  f.flags.closeThrows=false;f.setTime(a.deadlineAt+1000);const count=f.guestCalls.length,b=await f.execute();
  assert.equal(b.apiAdmissionClosed,true);assert.equal(b.apiClosurePending,false);assert.equal(b.destructionConfirmed,true);
  assert.deepEqual(f.closeRequests[0],f.closeRequests[1]);assert.deepEqual(f.guestCalls.slice(count),['close_api']);
  assert.equal(f.calls.filter(c=>c.method==='POST'&&c.pathname.includes('/instances?')).length,1);
});
test('host rejection before any API preparation does not pretend an API fence was necessary',async()=>{
  const f=fixture({badHost:true}),r=await f.execute();assert.equal(f.closeRequests.length,0);assert.equal(r.apiAdmissionClosed,null);assert.equal(r.apiClosurePending,false);
});
test('aborted foreground operation does not pass its aborted signal to API closure',async()=>{
  const f=fixture(),abort=new AbortController();let cleanupSignal;
  const r=await f.execute({signal:abort.signal,observeApi:async()=>{abort.abort();return {finished:false,gatesClosed:true,receiptSha256:'3'.repeat(64)};},closeApi:async c=>{
    cleanupSignal=c.signal;assert.equal(c.signal.aborted,false);
    const receipt={schema:1,missionId:c.missionId,closureRequestId:c.closureRequestId,admissionClosed:true,launchClosed:true,connectionEnabled:false,publicationEnabled:false,metaWindowEnabled:false,sentinelSha256:'7'.repeat(64)};
    return {...receipt,receiptSha256:sha256(canonical(receipt))};
  }});
  assert.ok(cleanupSignal);assert.equal(r.apiAdmissionClosed,true);assert.equal(r.destructionConfirmed,true);
});
test('operator abort interrupts an unresponsive activation wait immediately and still closes and destroys',async()=>{
  const f=fixture(),controller=new AbortController();let entered;
  const waiting=new Promise(resolve=>{entered=resolve;});
  const run=f.execute({signal:controller.signal,prepareApi:async()=>{entered();return new Promise(()=>{});}});
  await waiting;controller.abort();const result=await run;
  assert.equal(result.failure,'media_pilot_operator_interrupted');
  assert.equal(result.apiAdmissionClosed,true);assert.equal(result.destructionConfirmed,true);
  assert.equal(f.closeRequests.length,1);assert.equal(f.resources.size,0);
  assert.equal(f.guestCalls.includes('start'),false);
});
for(const phase of ['preflight','install','probeInstalled'])test('operator abort interrupts unresponsive '+phase+' and cleanup uses an independent signal',async()=>{
  const f=fixture(),controller=new AbortController();let entered,cleanupSignal;
  const waiting=new Promise(resolve=>{entered=resolve;});
  const originalExecute=f.execute;
  const guestOverride={[phase]:async c=>{entered(c.signal);return new Promise(()=>{});}};
  const run=originalExecute({signal:controller.signal,guestOverride,closeApi:async c=>{
    cleanupSignal=c.signal;const receipt={schema:1,missionId:c.missionId,closureRequestId:c.closureRequestId,
      admissionClosed:true,launchClosed:true,connectionEnabled:false,publicationEnabled:false,metaWindowEnabled:false,sentinelSha256:'7'.repeat(64)};
    return {...receipt,receiptSha256:sha256(canonical(receipt))};
  }});
  const foregroundSignal=await waiting;controller.abort();const result=await run;
  assert.equal(foregroundSignal.aborted,true);assert.equal(result.failure,'media_pilot_operator_interrupted');
  assert.ok(cleanupSignal===undefined||cleanupSignal.aborted===false);assert.equal(result.destructionConfirmed,true);
});
test('expired external cleanup deadline skips API wait explicitly, deletes, then allows closure-only reconciliation',async()=>{
  const f=fixture();const r=await f.execute({observeApi:async c=>{f.setTime(c.destroyBy);return {finished:true,gatesClosed:true,receiptSha256:'3'.repeat(64)};}});
  assert.equal(r.apiClosure.phase,'skipped_cleanup_priority');assert.equal(r.apiClosurePending,true);assert.equal(r.destructionConfirmed,true);
  assert.equal(f.closeRequests.length,0);const resumed=await f.execute();assert.equal(resumed.apiAdmissionClosed,true);assert.equal(f.closeRequests.length,1);
});
