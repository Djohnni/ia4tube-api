"use strict";
const crypto=require("node:crypto");
const {MANIFEST,sha256}=require("./vm-proof-manifest");
const {bounded}=require("./vm-proof-controller");
const {validateInstallDiagnostic}=require("./vm-proof-install-diagnostics");
const {KINDS,UUID,googleId,fail,resourceName,resourcePath,validateGooglePlan,bindResource}=require("./vm-proof-google-plan");
function definitiveRejection(plan,s,k){
  const r=s.resources[k],e=r.creationResponse;
  return !r.createOp && e?.classification==="definitive_rejection" && e.httpStatus===400 && e.apiCode===400 &&
    e.normalizedCode==="E2_STANDARD_MAINTENANCE_INVALID" && e.requestId===r.createRequestId && e.resource===resourcePath(plan,s.missionId,k);
}
function validateState(s,plan){
  if(!s || s.schema!==1 || s.provider!=="google" || !UUID.test(s.missionId) || s.planSha256!==plan.approvalSha256 ||
    !Number.isSafeInteger(s.startedAt) || s.deadlineAt!==s.startedAt+7200000 || !s.resources || !s.preexisting ||
    !Array.isArray(s.cases) || s.cases.length>5)fail("journal_invalid");
  for(const kind of KINDS){
    const r=s.resources[kind];
    if(!r || !Array.isArray(s.preexisting[kind]) || s.preexisting[kind].length>10000 ||
      s.preexisting[kind].some(v=>{googleId(v.id);return typeof v.name!=="string";}) ||
      (r.intentAt!==null && (!Number.isSafeInteger(r.intentAt)||r.intentAt<s.startedAt||r.intentAt>s.deadlineAt)) ||
      !UUID.test(r.createRequestId) || !UUID.test(r.deleteRequestId))fail("journal_resource_invalid");
    if(r.id!==null){googleId(r.id);if(r.intentAt===null || !Number.isFinite(r.createdAt) || s.preexisting[kind].some(v=>v.id===r.id))fail("journal_resource_binding_invalid");}
  }
  if(s.cases.some((v,i)=>v.id!==MANIFEST.cases[i].id || !["intent","passed","unknown","failed"].includes(v.phase)))fail("journal_cases_invalid");
  if(s.installationDiagnostic!=null&&!validateInstallDiagnostic(s.installationDiagnostic))fail("journal_installation_diagnostic_invalid");
  if(s.installationCollection?.diagnostic!=null&&!validateInstallDiagnostic(s.installationCollection.diagnostic))fail("journal_installation_collection_invalid");
  return s;
}
function summary(s){return {missionId:s.missionId,provider:"google",phase:s.phase,deadlineAt:s.deadlineAt,
  resources:Object.fromEntries(KINDS.map(k=>[k,{id:s.resources[k].id,createdAt:s.resources[k].createdAt,absentConfirmedAt:s.resources[k].absentConfirmedAt}])),
  hostPreflight:s.hostPreflight,installation:s.installation,installationDiagnostic:s.installationDiagnostic??null,
  installationCollection:s.installationCollection??null,collectionFailure:s.collectionFailure??null,cases:s.cases,
  launches:s.cases.length===5 && s.cases.every(c=>c.phase==="passed")?8:null,
  allTerminated:s.allTerminated===true,evidenceCollected:s.collection?.sanitized===true,
  destructionConfirmed:s.phase==="destroyed",billingMayContinue:s.resources.instances.intentAt!==null && s.phase!=="destroyed",
  failure:s.failure,journalPersistenceFailed:s.journalPersistenceFailed===true,realMedia:false,apiChanged:false};}
async function runGoogleProof({plan,approvalSha256,store,provider,guest,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
  validateGooglePlan(plan,{executable:true});
  if(approvalSha256!==plan.approvalSha256)fail("specific_paid_confirmation_required");
  return store.exclusive(async()=>{
    let s=await store.read(),fresh=!s;
    const call=fn=>bounded(fn,20000);
    if(!s){
      const preexisting={};
      for(const k of KINDS)preexisting[k]=await call(signal=>provider.inventory(k,{signal}));
      const missionId=crypto.randomUUID(),startedAt=now();
      s={schema:1,provider:"google",missionId,planSha256:plan.approvalSha256,startedAt,deadlineAt:startedAt+7200000,
        preexisting,resources:Object.fromEntries(KINDS.map(k=>[k,{intentAt:null,id:null,createdAt:null,createRequestId:crypto.randomUUID(),
          deleteRequestId:crypto.randomUUID(),createOp:null,deleteOp:null,deleteIntentAt:null,absentConfirmedAt:null}])),
        phase:"prepared",hostPreflight:null,installation:null,installationDiagnostic:null,installationCollection:null,
        cases:[],collection:null,collectionFailure:null,failure:null,allTerminated:false};
      validateState(s,plan);await store.write(s);
    }else validateState(s,plan);
    const save=async()=>{validateState(s,plan);await store.write(s);};
    const safeSave=async()=>{try{await save();}catch{s.journalPersistenceFailed=true;}};
    if(s.phase==="destroyed")return summary(s);
    async function bind(k,r,{strict=false}={}){const v=bindResource(plan,s,k,r,{strict});Object.assign(s.resources[k],v);await save();return r;}
    async function waitOperation(ref,until,onDone=async()=>{}){
      let op=ref;
      while(op.status!=="DONE"){
        if(now()>=until)fail("operation_deadline");
        await sleep(Math.min(1000,until-now()));op=await call(signal=>provider.pollOperation(op,s.missionId,{signal}));
        if(ref.targetId && op.targetId!==ref.targetId)fail("operation_id_changed");
      }
      await onDone(op);
      if(op.failed)fail("operation_failed");return op;
    }
    async function reconcile(k,until,{strict=false}={}){
      while(true){
        const r=await call(signal=>provider.get(k,s.missionId,{signal}));
        if(r)return bind(k,r,{strict});
        if(now()>=until)fail("creation_unresolved_no_repeat");
        await sleep(Math.min(1000,until-now()));
      }
    }
    async function create(k,startupScript){
      const record=s.resources[k];if(record.intentAt!==null)fail("duplicate_creation_blocked");
      if(s.preexisting[k].some(v=>v.name===resourceName(s.missionId,k)))fail("name_preexisted");
      record.intentAt=now();s.phase="create_"+k;
      // Boot disk is part of this single VM insertion, not a second paid POST.
      if(k==="instances"){s.resources.disks.intentAt=record.intentAt;record.bootstrapSha256=sha256(startupScript);}
      await save();
      let op;
      try{op=await call(signal=>provider.create(k,s,startupScript,{signal}));record.createOp=op;
        record.creationResponse={classification:"accepted",httpStatus:op.httpStatus??null,requestId:record.createRequestId,resource:resourcePath(plan,s.missionId,k)};await save();}
      catch(error){
        if(error?.code?.includes("binding") || error?.code?.includes("scope"))throw error;
        if(error?.response)record.creationResponse=error.response;
        if(definitiveRejection(plan,s,k)){await save();throw error;}
        record.responseUnknown=true;await save();
      }
      if(op)record.createOp=await waitOperation(op,s.deadlineAt-1200000,async done=>{record.createOp=done;await save();});
      const r=await reconcile(k,Math.min(now()+120000,s.deadlineAt-1200000),{strict:true});
      if(record.createOp?.targetId && record.createOp.targetId!==record.id)fail("create_target_mismatch");
      if(k==="instances")await reconcile("disks",Math.min(now()+120000,s.deadlineAt-1200000),{strict:true});
      return r;
    }
    function budget(seconds){if(now()+seconds*1000>s.deadlineAt-1200000)fail("insufficient_time_for_work");}
    try{
      // An existing session is cleanup-only, even if it stopped before Create.
      // Restarting cannot replay an installer, converter, or uncertain POST.
      if(!fresh)fail("resume_cleanup_only");
      const ready=await call(signal=>provider.preflight({signal}));if(ready?.verified!==true)fail("external_preflight_failed");
      await guest.prepareLocalIdentity({missionId:s.missionId,plan});
      for(const k of ["networks","subnetworks","firewalls"]){budget(3600);await create(k);}
      budget(MANIFEST.hostPreflightSeconds+MANIFEST.installSeconds+MANIFEST.sequenceSeconds);
      await create("instances",guest.createIdentityPayload().startupScript);
      let instance;
      while(true){budget(MANIFEST.hostPreflightSeconds);instance=await reconcile("instances",now(),{strict:true});if(instance.status==="RUNNING")break;await sleep(1000);}
      await guest.bindHost(instance,{missionId:s.missionId,plan});
      for(const [phase,field,seconds,method] of [["preflight","hostPreflight",180,"preflight"],["installation","installation",2400,"install"]]){
        budget(seconds);s.phase=phase+"_intent";await save();
        const r=await bounded(signal=>guest[method]({plan,signal,timeoutMs:seconds*1000}),seconds*1000);
        if(method==="install"){
          if(!validateInstallDiagnostic(r?.diagnostic)||r.diagnostic.installationPassed!==true)fail("installation_evidence_unconfirmed");
          s.installationDiagnostic=r.diagnostic;
        }
        if(r?.passed!==true||r.convertersStarted!==0)fail(phase+"_failed");s[field]="passed";await save();
      }
      budget(900);s.phase="sequence_intent";s.cases=MANIFEST.cases.map(c=>({id:c.id,phase:"intent"}));await save();
      const r=await bounded(signal=>guest.runSequence({plan,signal,timeoutMs:900000}),900000);
      const attempts=MANIFEST.cases.flatMap(c=>c.attempts);
      if(r?.launches!==8||r.allTerminated!==true||!Array.isArray(r.attemptIds)||r.attemptIds.join(",")!==attempts.join(",")||r.cases?.length!==5 ||
        r.cases.some((c,i)=>c.id!==MANIFEST.cases[i].id||c.passed!==true||c.terminationProved!==true||c.nativeLaunches!==MANIFEST.cases[i].attempts.length))fail("sequence_receipt_invalid");
      s.cases=MANIFEST.cases.map(c=>({id:c.id,phase:"passed"}));s.allTerminated=true;s.phase="proof_complete";await save();
    }catch(error){s.failure=/^(gcp|vm)_proof_[a-z_]+$/.test(error?.code||"")?error.code:"gcp_proof_operation_failed";
      if(validateInstallDiagnostic(error?.diagnostic))s.installationDiagnostic=error.diagnostic;
      for(const c of s.cases)if(c.phase==="intent")c.phase="unknown";await safeSave();
    }finally{
      if(s.resources.instances.id!==null){
        // One bounded collector, independent of the package/runtime, always
        // before deletion. Preserve the installation failure and local markers
        // even if SSH or this collector is unavailable. Never consume cleanup's
        // reserved ten minutes or re-run an uncertain installation.
        let ms=Math.min(60000,s.deadlineAt-now()-600000);
        if(ms>0)try{
          const r=await bounded(signal=>guest.collectInstallationDiagnostics({missionId:s.missionId,plan,signal,timeoutMs:ms}),ms);
          if(r?.sanitized!==true||!/^[a-f0-9]{64}$/.test(r.sha256||"")||!validateInstallDiagnostic(r.diagnostic)||typeof r.collectionSucceeded!=="boolean")fail("installation_collection_schema_invalid");
          const d=r.diagnostic, collected=d.exitCode===0&&!d.timedOut&&!d.aborted&&!d.spawnFailed&&!d.stdinFailed&&!d.collectionError&&!d.remoteCaptureFailed&&d.signal===null&&!d.protocolInvalid&&d.markers.length>0;
          if(r.collectionSucceeded!==collected)fail("installation_collection_schema_invalid");
          s.installationCollection={status:collected?"collected":"failed",sanitized:true,sha256:r.sha256,diagnostic:d};
        }catch(error){s.installationCollection={status:"failed",error:/^(gcp|vm)_proof_[a-z_]+$/.test(error?.code||"")?error.code:"gcp_proof_installation_collection_failed",
          ...(validateInstallDiagnostic(error?.diagnostic)?{diagnostic:error.diagnostic}:{})};}
        else s.installationCollection={status:"skipped_cleanup_deadline"};
        await safeSave();
        ms=Math.min(540000,s.deadlineAt-now()-600000);
        if(s.installation==="passed"&&ms>0)try{
          const r=await bounded(signal=>guest.collect({missionId:s.missionId,plan,signal,timeoutMs:ms}),ms);
          if(r?.sanitized!==true||!/^[a-f0-9]{64}$/.test(r.sha256||""))fail("proof_collection_schema_invalid");
          s.collection={sanitized:true,sha256:r.sha256};
        }catch(error){s.collectionFailure=/^(gcp|vm)_proof_[a-z_]+$/.test(error?.code||"")?error.code:"gcp_proof_collection_failed";}
      }
      s.phase="cleanup";await safeSave();let uncertain=false;
      for(const k of ["instances","disks","firewalls","subnetworks","networks"]){
        const record=s.resources[k];if(record.intentAt===null)continue;
        // Do not remove the disk/network of a VM whose absence is unconfirmed.
        if(k!=="instances"&&s.resources.instances.intentAt!==null&&s.resources.instances.absentConfirmedAt===null){uncertain=true;continue;}
        try{
          let r=await call(signal=>provider.get(k,s.missionId,{signal}));
          if(r){Object.assign(record,bindResource(plan,s,k,r));await safeSave();}
          else if(record.id===null && !(record.createOp?.status==="DONE" && record.createOp.failed) && !definitiveRejection(plan,s,k)){
            // A missing name after a lost creation response is not final proof
            // of absence; no new Create, and report possible future visibility.
            if(k==="disks" && s.resources.instances.absentConfirmedAt!==null && (s.resources.instances.id!==null || s.resources.instances.createOp?.status==="DONE" || definitiveRejection(plan,s,"instances"))){record.absentConfirmedAt=now();await safeSave();continue;}
            uncertain=true;continue;
          }
          if(r && record.deleteIntentAt===null){
            record.deleteIntentAt=now();await safeSave();
            // A fresh GET + exact identity check immediately precedes DELETE.
            r=await call(signal=>provider.get(k,s.missionId,{signal}));
            if(r){bindResource(plan,s,k,r);try{record.deleteOp=await call(signal=>provider.destroy(k,s,{signal}));}catch(error){
              if(error?.code==="gcp_proof_delete_target_mismatch")throw error;
              record.deleteResponseUnknown=true;
            }await safeSave();}
          }
          const until=Math.max(now(),Math.min(s.deadlineAt,now()+600000));
          if(record.deleteOp)record.deleteOp=await waitOperation(record.deleteOp,until);
          while(true){
            r=await call(signal=>provider.get(k,s.missionId,{signal}));
            if(!r){record.absentConfirmedAt=now();await safeSave();break;}
            bindResource(plan,s,k,r);if(now()>=until)fail("destruction_unconfirmed");await sleep(Math.min(1000,until-now()));
          }
        }catch{record.cleanupUnconfirmed=true;uncertain=true;await safeSave();}
      }
      // Read-only final reconciliation preserves preexisting name/ID pairs and
      // independently checks that no mission-owned name remains in inventory.
      s.preexistingPreserved={};
      for(const k of KINDS)try{
        const rows=await call(signal=>provider.inventory(k,{signal}));
        s.preexistingPreserved[k]=s.preexisting[k].every(old=>rows.some(v=>v.id===old.id&&v.name===old.name));
        if(rows.some(v=>v.name===resourceName(s.missionId,k)))uncertain=true;
      }catch{s.preexistingPreserved[k]=null;uncertain=true;}
      s.phase=uncertain?"cleanup_required":"destroyed";s.finishedAt=now();await safeSave();
    }
    return summary(s);
  });
}
module.exports={runGoogleProof,validateState,summary};
