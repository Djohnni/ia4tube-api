"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm");
const { createOperationalPlan, validateOperationalPlan } = require("../scripts/media-pilot/google-plan");
const { runOperationalPilot } = require("../scripts/media-pilot/google-controller");
const { hostProbeScript, startScript, stopScript, collectionScript } = require("../scripts/media-pilot/google-guest");
const { createGoogleProvider } = require("../scripts/validation/vm-proof-google-provider");
const P = require("../scripts/validation/vm-proof-google-plan");
const { makeGoogleBootstrap } = require("../scripts/validation/vm-proof-google-bootstrap");
const clone = v => structuredClone(v), beginning = Date.parse("2026-09-19T17:00:00Z");
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
function makePlan(change = {}) {
  return createOperationalPlan({ imageId: "6257327608773510097", operatorIpv4: "177.125.241.34", packageSha256: "a".repeat(64), packageReviewSha256: "b".repeat(64),
    authorizationSha256: "c".repeat(64), ownerCompanyId: uuid(1), ownerUserId: uuid(2), workerId: uuid(3),
    finance: { computeHourlyUsd: .03350571, diskGiBHourlyUsd: .000054795, ipv4HourlyUsd: .005, egressAllowanceGiB: .5,
      egressUsdPerGiB: .12, otherAllowanceUsd: .02, alreadyIncurredUsd: .02, buildAdditionalUsd: 0, pilotReferenceUsd: 5,
      pricingEvidenceSha256: "d".repeat(64), verifiedAt: beginning }, ...change });
}
function fixture(flags = {}, plan = makePlan()) {
  const p = plan.infrastructure, resources = new Map(), calls = [], guestCalls = []; let state = null, clock = beginning, nextId = 100n, observes = 0;
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
      const r = resources.get(route); if (!r) return {status:404};
      if (flags.noDestroy === kind) return {status:403,json:{}};
      resources.delete(route);
      if (kind === "instances") for (const [k] of resources) if (k.includes("/disks/")) resources.delete(k);
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
    stopWorker:async()=>{guestCalls.push("stop");if(flags.stopFails)throw Error("private");return {stopped:true,nativeTerminationProved:true};},
    collectOperational:async()=>{guestCalls.push("collect");if(flags.collectFails)throw Error("private");return {sanitized:true,sha256:"1".repeat(64),executionsObserved:3};},
    runSequence:async()=>{throw Error("MUST NEVER RUN OLD SYNTHETIC PROOF");}
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
  const execute = options=>runOperationalPilot({plan,approvalSha256:plan.approvalSha256,provider,store,guest,prepareApi,observeApi,now:()=>clock,sleep:async ms=>{clock+=ms;},...options});
  return {execute,resources,calls,guestCalls,getState:()=>clone(state),setState:s=>{state=clone(s);},plan};
}
test("operational plan is owner-bound, priced, no recurrence or old synthetic cases",()=>{
  const p=makePlan();assert.equal(validateOperationalPlan(p),p);assert.equal(p.syntheticCases,0);assert.equal(p.maxInstallInvocations,1);assert.equal(p.maxWorkerStarts,1);
  assert.equal(p.finance.invoiceCapGuaranteed,false);assert.ok(Math.abs(p.finance.estimatedMaximumUsd-.16249092)<1e-12);
  assert.throws(()=>validateOperationalPlan({...p,admissionSeconds:6600}),/window_invalid/);
  assert.throws(()=>validateOperationalPlan({...p,externalPublication:true}),/plan_changed/);
  assert.throws(()=>validateOperationalPlan(p,{now:beginning+86400001}),/pricing_check_stale/);
  assert.throws(()=>makePlan({finance:{...Object.fromEntries(Object.entries(p.finance).filter(([k])=>!["estimatedInfrastructureUsd","estimatedMaximumUsd","invoiceCapGuaranteed"].includes(k))),alreadyIncurredUsd:5}}),/budget_exceeded/);
});
test("single operational install/start, host bound API readiness, collect and complete external destruction",async()=>{
  const f=fixture(),r=await f.execute();assert.equal(r.failure,null);assert.equal(r.destructionConfirmed,true);assert.equal(r.syntheticCases,0);assert.equal(r.invoiceUsd,null);
  assert.equal(f.resources.size,0);assert.deepEqual(f.guestCalls,["preflight","install","probe","prepare_api","start","stop","collect"]);
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
test("no human activity ends at bounded worker window and reserves provider cleanup",async()=>{
  const f=fixture({waitUntilDeadline:true}),r=await f.execute();assert.equal(r.failure,null);assert.equal(r.destructionConfirmed,true);assert.equal(r.workerStopAt,r.startedAt+6600000);assert.ok(f.getState().finishedAt<=r.deadlineAt);
});
for(const kind of ["networks","subnetworks","firewalls","instances"])test("lost "+kind+" insertion reconciles exact name without duplicate POST",async()=>{
  const f=fixture({unknownCreate:kind}),r=await f.execute();assert.equal(r.destructionConfirmed,true);assert.equal(r.failure,null);assert.equal(f.calls.filter(c=>c.method==="POST"&&c.pathname.includes('/'+kind+'?')).length,1);
});
test("lost delete reconciles absence without repeating deletion",async()=>{
  const f=fixture({unknownDelete:"instances"}),r=await f.execute();assert.equal(r.destructionConfirmed,true);assert.equal(f.calls.filter(c=>c.method==="DELETE"&&c.pathname.includes('/instances/')).length,1);
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
});
