"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {MANIFEST,canonical}=require("../scripts/validation/vm-proof-manifest");
const P=require("../scripts/validation/vm-proof-google-plan");
const {createGoogleProvider,googleTransport}=require("../scripts/validation/vm-proof-google-provider");
const {runGoogleProof}=require("../scripts/validation/vm-proof-google-controller");
const {makeGoogleBootstrap}=require("../scripts/validation/vm-proof-google-bootstrap");
const {runDiagnosticProcess, classifyInstallDiagnostic}=require("../scripts/validation/vm-proof-install-diagnostics");
let completeDiagnostic;
const getCompleteDiagnostic=()=>completeDiagnostic??=runDiagnosticProcess(process.execPath,["-e", 'const s=["initialization","dependencies_runtime","version_checks","package_install","final_validation"];let t=1700000000000;for(const stage of s){console.log(`IA4INSTALL ${stage} start ${t++} -`);console.log(`IA4INSTALL ${stage} done ${t++} 0`)}console.log("IA4INSTALL_COMPLETE=PASS")']);
const clone=v=>structuredClone(v),imageId="6257327608773510097";
const plan=P.createGooglePlan({imageId,operatorIpv4:"93.184.216.34"});
const privateFixture="-----BEGIN OPENSSH PRIVATE KEY-----\nYQ==\n-----END OPENSSH PRIVATE KEY-----\n";
const startup=makeGoogleBootstrap(privateFixture,"ssh-ed25519 YQ== synthetic","ssh-ed25519 Yg== synthetic");
function fixture(flags={}){
  let time=Date.parse("2026-09-14T00:00:00Z"),nextId=9007199254740993n,state=null,locked=false,sequenceCount=0,installationCount=0;
  const resources=new Map(),ops=new Map(),calls=[],missed=new Set(),hidden=new Map(),guestCalls=[];
  let installObservation;
  const url=p=>"https://www.googleapis.com/compute/v1/"+p;
  const transport=async request=>{
    const {method,pathname,body}=request;calls.push({method,pathname,body:clone(body)});
    if(request.hostname==="cloudresourcemanager.googleapis.com")return {status:200,json:{permissions:flags.noDeletePermission?body.permissions.filter(p=>p!=="compute.instances.delete"):body.permissions}};
    const [p,query]=pathname.replace("/compute/v1/","").split("?");const parts=p.split("/"),kind=parts.at(-2),name=parts.at(-1);
    if(method==="GET" && p===plan.sourceImage)return {status:200,json:{id:flags.badImage?"1":imageId,selfLink:url(p),status:"READY",architecture:"X86_64"}};
    if(method==="GET" && p.endsWith("machineTypes/e2-medium"))return {status:200,json:{guestCpus:2,memoryMb:4096}};
    if(method==="GET" && p===`projects/${plan.project}`)return {status:200,json:{commonInstanceMetadata:{items:flags.projectScript?[{key:"startup-script",value:"do-not-run"}]:[]}}};
    if(method==="GET" && kind==="operations"){
      const op=clone(ops.get(name));if(!op)return {status:404,json:null};op.status="DONE";
      if((flags.operationError||flags.failedCreateOrphan) && op.operationType==="insert" && op.targetLink.includes("/instances/"))op.error={errors:[{code:"QUOTA_EXCEEDED",message:"synthetic private details"},{code:"secret-synthetic"}]};
      if(flags.operationIdMismatch)op.targetId="77";
      return {status:200,json:op};
    }
    if(method==="GET" && P.KINDS.includes(name))return {status:200,json:{items:flags.preexisting?[{id:"42",name:"preexisting-resource"}]:[]}};
    if(method==="GET"){
      if((hidden.get(p)||0)>0){hidden.set(p,hidden.get(p)-1);return {status:404,json:null};}
      let r=resources.get(p);if(!r)return {status:404,json:null};r=clone(r);
      if(flags.replaceBeforeDelete && kind==="instances" && sequenceCount>0)r.id="18446744073709551614";
      if(flags.diskMismatch && kind==="disks")r.sourceImageId="9";
      if(flags.badFirewall && kind==="firewalls")r.sourceRanges=["0.0.0.0/0"];
      if(flags.badBootstrap && kind==="instances")r.metadata.items.find(v=>v.key==="block-project-ssh-keys").value="FALSE";
      if(flags.badTimer && kind==="instances")r.scheduling.instanceTerminationAction="STOP";
      return {status:200,json:r};
    }
    if(method==="POST"){
      const k=name,rpath=p+"/"+body.name;
      if(k==="instances" && flags.rejectMaintenance)return {status:400,json:{error:{code:400,errors:[{reason:"invalid"}],
        message:"Invalid value for field 'resource.scheduling.onHostMaintenance': 'TERMINATE'. e2 instances do not support onHostMaintenance=TERMINATE unless they are preemptible."}}};
      if(k==="instances" && flags.unknownHttp)return {status:flags.unknownHttp,json:{error:{code:flags.unknownHttp,message:"synthetic confidential details"}}};
      assert.equal(resources.has(rpath),false,"never issue duplicate Create");
      const r={...clone(body),id:String(nextId++),creationTimestamp:new Date(time).toISOString(),selfLink:url(rpath)};
      if(k==="instances"){
        r.machineType=url(`projects/${plan.project}/zones/${plan.zone}/machineTypes/e2-medium`);r.status="RUNNING";
        const d=body.disks[0].initializeParams,dpath=`projects/${plan.project}/zones/${plan.zone}/disks/${d.diskName}`;
        resources.set(dpath,{id:String(nextId++),name:d.diskName,description:d.description,creationTimestamp:new Date(time).toISOString(),selfLink:url(dpath),
          sizeGb:"50",type:url(`projects/${plan.project}/zones/${plan.zone}/diskTypes/pd-standard`),sourceImage:url(plan.sourceImage),sourceImageId:imageId});
        r.disks=[{boot:true,autoDelete:true,source:url(dpath)}];r.networkInterfaces[0].accessConfigs[0].natIP="93.184.216.35";
      }
      resources.set(rpath,r);
      if(flags.failedCreateOrphan && k==="instances")resources.delete(rpath);
      const op={name:"operation-"+String(nextId++),targetId:r.id,targetLink:url(rpath),operationType:"insert",clientOperationId:new URLSearchParams(query).get("requestId"),status:"PENDING"};
      op.selfLink=url(p.slice(0,p.lastIndexOf("/"))+"/operations/"+op.name);ops.set(op.name,op);
      if(flags.lostCreate===k&&!missed.has(k)){missed.add(k);hidden.set(rpath,2);throw new Error("synthetic lost response must not be logged");}
      if(flags.unknownNoResource && k==="instances"){resources.delete(rpath);throw new Error("synthetic unknown response");}
      return {status:200,json:op};
    }
    if(method==="DELETE"){
      guestCalls.push("delete_"+kind);
      const r=resources.get(p);if(!r)return {status:404,json:null};
      if(flags.refuseDelete===kind)return {status:403,json:{message:"synthetic private details never exported"}};
      const op={name:"operation-"+String(nextId++),targetId:r.id,targetLink:url(p),operationType:"delete",clientOperationId:new URLSearchParams(query).get("requestId"),status:"DONE"};
      op.selfLink=url(p.slice(0,p.lastIndexOf("/"+kind+"/"))+"/operations/"+op.name);ops.set(op.name,op);
      if(flags.stopInsteadOfDelete && kind==="instances")r.status="TERMINATED";
      else resources.delete(p);
      if(kind==="instances" && !flags.orphanDisk && !flags.stopInsteadOfDelete)for(const [k]of resources)if(k.includes("/disks/"))resources.delete(k);
      if(flags.lostDelete===kind)throw new Error("synthetic lost deletion reply");
      return {status:200,json:op};
    }
    throw new Error("unexpected request "+method+" "+p);
  };
  const store={exclusive:async f=>{assert.equal(locked,false);locked=true;try{return await f();}finally{locked=false;}},read:async()=>clone(state),
    write:async s=>{assert.equal(locked,true);if(flags.persistAfterVm && s.resources.instances.id && !missed.has("persist")){missed.add("persist");throw new Error("synthetic disk failure");}state=clone(s);}};
  const guest={prepareLocalIdentity:async()=>{},createIdentityPayload:()=>({startupScript:startup}),bindHost:async()=>{},
    preflight:async()=>({passed:!flags.hostFailure,convertersStarted:0}),install:async()=>{
      installationCount++;guestCalls.push("install");installObservation=clone(await getCompleteDiagnostic());
      if(flags.installFailure){
        installObservation.markers=installObservation.markers.slice(0,4);installObservation.markers[3].event="failed";installObservation.markers[3].exitCode=42;
        installObservation.lastCompletedStage="initialization";installObservation.finalMarkerReceived=false;installObservation.exitCode=42;
        installObservation.failedStage="dependencies_runtime";installObservation.failedStageExitCode=42;
        installObservation.classification=classifyInstallDiagnostic(installObservation);installObservation.installationPassed=false;
        throw Object.assign(new Error("synthetic secret must stay private"),{code:"vm_proof_ssh_installation_substep_failed",diagnostic:installObservation});
      }
      if(flags.installUncertain){installObservation.exitCode=255;installObservation.classification=classifyInstallDiagnostic(installObservation);installObservation.installationPassed=false;
        throw Object.assign(new Error("synthetic secret"),{code:"vm_proof_ssh_installation_transport_interrupted_unknown",diagnostic:installObservation});}
      return {passed:true,convertersStarted:0,...(flags.missingInstallEvidence?{}:{diagnostic:installObservation})};},
    runSequence:async()=>{sequenceCount++;if(flags.sequenceThrows)throw new Error("synthetic secret");return {cases:MANIFEST.cases.map(c=>({id:c.id,passed:true,terminationProved:true,nativeLaunches:c.attempts.length})),
      launches:flags.badReceipt?9:8,allTerminated:true,attemptIds:MANIFEST.cases.flatMap(c=>c.attempts)};},
    collectInstallationDiagnostics:async()=>{guestCalls.push("installation_collect");
      if(flags.installCollectorFailure)throw new Error("synthetic private collection error");
      const diagnostic=clone(installObservation??await getCompleteDiagnostic());diagnostic.exitCode=0;
      diagnostic.classification=classifyInstallDiagnostic(diagnostic);diagnostic.installationPassed=diagnostic.classification==="installation_complete";
      if(flags.installCollectorPersistenceFailure)throw Object.assign(new Error("synthetic private disk detail"),{code:"vm_proof_ssh_installation_collection_persistence_failed",diagnostic});
      return {sanitized:true,collectionSucceeded:true,sha256:"c".repeat(64),diagnostic};},
    collect:async()=>{guestCalls.push("executor_collect");if(flags.collectFailure)throw new Error("synthetic");return {sanitized:true,sha256:"b".repeat(64)};}};
  const provider=createGoogleProvider({plan,transport});
  const execute=()=>runGoogleProof({plan,approvalSha256:plan.approvalSha256,store,provider,guest,now:()=>time,sleep:async ms=>{time+=ms;}});
  return {execute,store,provider,calls,resources,guestCalls,getState:()=>clone(state),setState:s=>{state=clone(s);},get sequences(){return sequenceCount;},get installs(){return installationCount;}};
}
test("Google IDs are uint64 strings without numeric precision loss",()=>{
  for(const v of ["9007199254740993","18446744073709551615"])assert.equal(P.googleId(v),v);
  for(const v of [9007199254740992,"0","01","18446744073709551616","-1","1e3",null])assert.throws(()=>P.googleId(v),/id_invalid/);
});
test("offline plan preserves the reviewed package and exact five/eight sequence",()=>{
  assert.equal(plan.packageSha256,P.PACKAGE);assert.deepEqual(plan.cases,MANIFEST.cases);assert.equal(plan.cases.flatMap(c=>c.attempts).length,8);
  assert.throws(()=>P.validateGooglePlan({...plan,diskGiB:51}),/plan_changed/);
  assert.throws(()=>P.validateGooglePlan(P.createGooglePlan(),{executable:true}),/read_bindings_missing/);
  for(const ip of ["0.0.0.0","127.0.0.1","10.1.1.1","192.168.0.1","177.1.1.1/24"])assert.throws(()=>P.createGooglePlan({operatorIpv4:ip}));
});
test("Google bootstrap pins its own keys, is one-shot and never installs or launches media",()=>{
  assert.match(startup,/Google proof bootstrap/);assert.match(startup,/noclobber/);assert.match(startup,/PermitRootLogin no/);
  assert.match(startup,/GOOGLE_BOOTSTRAP=PASS/);assert.doesNotMatch(startup,/apt |ffmpeg|curl |wget |DATABASE_URL|Bearer/);
  assert.throws(()=>makeGoogleBootstrap("not a key","bad","bad"));
});
test("complete async creation, five cases/eight attempts and deletion of VM/disk/network",async()=>{
  const f=fixture(),r=await f.execute();assert.equal(r.phase,"destroyed");assert.equal(r.failure,null);assert.equal(r.launches,8);
  assert.equal(f.sequences,1);assert.equal(f.installs,1);assert.equal(f.resources.size,0);
  assert.equal(f.calls.filter(c=>c.method==="POST"&&/\/instances\?/.test(c.pathname)).length,1);
  assert.equal(r.resources.instances.id,"9007199254740999");assert.ok(r.resources.disks.absentConfirmedAt);
  await f.execute();assert.equal(f.sequences,1,"terminal resume is inert");
});
for(const kind of ["networks","subnetworks","firewalls","instances"])test("lost "+kind+" create response reconciles without second POST",async()=>{
  const f=fixture({lostCreate:kind}),r=await f.execute();assert.equal(r.destructionConfirmed,true);assert.equal(r.failure,null);
  assert.equal(f.calls.filter(c=>c.method==="POST"&&c.pathname.includes("/"+kind+"?")).length,1);
});
for(const flag of ["noDeletePermission","badImage","projectScript"])test(flag+" blocks all creation",async()=>{
  const f=fixture({[flag]:true}),r=await f.execute();assert.ok(r.failure);assert.equal(f.resources.size,0);assert.equal(f.sequences,0);
  assert.equal(f.calls.filter(c=>c.method==="POST"&&/\/compute\//.test(c.pathname)).length,0);
});
for(const flag of ["hostFailure","sequenceThrows","badReceipt","operationError","badFirewall","diskMismatch","persistAfterVm"])test(flag+" fails closed and still cleans up",async()=>{
  const f=fixture({[flag]:true}),r=await f.execute();assert.ok(r.failure,JSON.stringify(r));assert.equal(r.destructionConfirmed,true,JSON.stringify(r));
  assert.equal(f.resources.size,0);assert.ok(f.sequences<=1);assert.equal(JSON.stringify(r).includes("synthetic secret"),false);
});
test("collection failure does not prevent deletion",async()=>{const f=fixture({collectFailure:true}),r=await f.execute();assert.equal(r.destructionConfirmed,true);assert.equal(r.evidenceCollected,false);});

for(const flag of ["installFailure","installUncertain","missingInstallEvidence"])test(flag+" prevents conversions, collects before deletion, never reinstalls",async()=>{
  const f=fixture({[flag]:true}),r=await f.execute();assert.equal(f.installs,1);assert.equal(f.sequences,0);
  assert.equal(r.destructionConfirmed,true);assert.ok(r.failure);assert.equal(r.installation,null);
  assert.ok(f.guestCalls.indexOf("installation_collect")<f.guestCalls.indexOf("delete_instances"));
  assert.equal(f.guestCalls.includes("executor_collect"),false);assert.equal(r.installationCollection.status,"collected");
  assert.equal(JSON.stringify(r).includes("synthetic secret"),false);
  await f.execute();assert.equal(f.installs,1);assert.equal(f.sequences,0);
});
test("independent collector failure preserves initial failed substep and still deletes",async()=>{
  const f=fixture({installFailure:true,installCollectorFailure:true}),r=await f.execute();
  assert.equal(r.installationCollection.status,"failed");assert.equal(r.installationCollection.error,"gcp_proof_installation_collection_failed");
  assert.equal(r.installationDiagnostic.markers.at(-1).stage,"dependencies_runtime");assert.equal(r.installationDiagnostic.markers.at(-1).exitCode,42);
  assert.equal(r.failure,"vm_proof_ssh_installation_substep_failed");assert.equal(r.destructionConfirmed,true);
  assert.equal(f.installs,1);assert.equal(f.sequences,0);assert.equal(JSON.stringify(r).includes("synthetic private"),false);
});
test("collection PASS after uncertain transport does not authorize any converter launch",async()=>{
  const f=fixture({installUncertain:true}),r=await f.execute();assert.equal(r.installationDiagnostic.classification,"transport_interrupted_unknown");
  assert.equal(r.installationCollection.diagnostic.installationPassed,true);assert.equal(r.installation,null);assert.equal(f.sequences,0);
});
test("collector local persistence failure keeps the newly received remote facts",async()=>{
  const f=fixture({installFailure:true,installCollectorPersistenceFailure:true}),r=await f.execute();
  assert.equal(r.installationCollection.error,"vm_proof_ssh_installation_collection_persistence_failed");
  assert.equal(r.installationCollection.diagnostic.failedStage,"dependencies_runtime");
  assert.equal(r.installationCollection.diagnostic.failedStageExitCode,42);
  assert.equal(r.installationDiagnostic.exitCode,42);assert.equal(r.destructionConfirmed,true);
});
test("orphan auto-delete disk is removed separately only after VM absence",async()=>{
  const f=fixture({orphanDisk:true}),r=await f.execute();assert.equal(r.destructionConfirmed,true);assert.equal(f.resources.size,0);
  assert.ok(f.calls.find(c=>c.method==="DELETE"&&c.pathname.includes("/disks/")));
});
test("lost deletion response is observed, never repeated",async()=>{const f=fixture({lostDelete:"instances"}),r=await f.execute();assert.equal(r.destructionConfirmed,true);assert.equal(f.calls.filter(c=>c.method==="DELETE"&&c.pathname.includes("/instances/")).length,1);});
for(const kind of ["instances","disks","networks"])test("unconfirmed "+kind+" deletion remains explicit",async()=>{
  const f=fixture({refuseDelete:kind,orphanDisk:true}),r=await f.execute();assert.equal(r.phase,"cleanup_required");assert.equal(r.destructionConfirmed,false);
});
test("STOP is not deletion",async()=>{const f=fixture({stopInsteadOfDelete:true}),r=await f.execute();assert.equal(r.phase,"cleanup_required");assert.equal(r.billingMayContinue,true);});
test("same-name replacement with another ID cannot be deleted",async()=>{
  const f=fixture({replaceBeforeDelete:true}),r=await f.execute();assert.equal(r.phase,"cleanup_required");assert.equal(f.calls.filter(c=>c.method==="DELETE").length,0);
});
test("preexisting inventory is preserved and never deleted",async()=>{const f=fixture({preexisting:true}),r=await f.execute();assert.equal(r.destructionConfirmed,true);assert.equal(f.calls.some(c=>c.pathname.includes("preexisting-resource")),false);});
test("interrupted journal resumes cleanup only, never repeats installation or sequence",async()=>{
  const f=fixture({replaceBeforeDelete:true});await f.execute();const before=f.calls.filter(c=>c.method==="POST").length;await f.execute();
  assert.equal(f.calls.filter(c=>c.method==="POST").length,before);assert.equal(f.sequences,1);assert.equal(f.installs,1);
});
test("approval mismatch blocks provider calls",async()=>{const f=fixture();await assert.rejects(runGoogleProof({plan,approvalSha256:"x",store:f.store,provider:f.provider,guest:{}}),/specific_paid_confirmation/);assert.equal(f.calls.length,0);});
test("transport refuses arbitrary destinations before obtaining credential",async()=>{
  let reads=0;const transport=googleTransport(async()=>{reads++;return "never-used";});
  await assert.rejects(transport({method:"POST",pathname:"/v1/projects/ia4tube-futebol:testIamPermissions",hostname:"evil.example"}),/route_invalid/);assert.equal(reads,0);
});
module.exports={fixture};

for(const flag of ["badBootstrap","badTimer"])test(flag+" blocks guest work and closes the owned resources",async()=>{
  const f=fixture({[flag]:true}),r=await f.execute();assert.ok(r.failure);assert.equal(f.installs,0);assert.equal(f.sequences,0);assert.equal(r.destructionConfirmed,true);
});
test("failed terminal VM create still cleans up its orphan disk",async()=>{
  const f=fixture({failedCreateOrphan:true}),r=await f.execute();assert.ok(r.failure);assert.equal(r.destructionConfirmed,true);assert.equal(f.resources.size,0);assert.equal(f.sequences,0);
});
test("unknown create and absent VM cannot be treated as confirmed destruction",async()=>{
  const f=fixture({unknownNoResource:true}),r=await f.execute();assert.equal(r.destructionConfirmed,false);assert.equal(r.billingMayContinue,true);assert.equal(f.sequences,0);
  assert.equal(f.calls.filter(c=>c.method==="POST"&&c.pathname.includes("/instances?")).length,1);
});
test("changed operation target ID prevents installation",async()=>{
  const f=fixture({operationIdMismatch:true}),r=await f.execute();assert.ok(r.failure);assert.equal(f.installs,0);assert.equal(f.sequences,0);
});
test("CLI cannot use an ambiguous account or relative SDK paths",async()=>{
  const {gcloudReader}=require("../scripts/validation/vm-proof-google-cli");
  await assert.rejects(gcloudReader({python:"python",script:"gcloud.py",account:"other@example.com"}),/external_authentication_configuration_required/);
});

test("final VM request binds STANDARD MIGRATE, absolute DELETE and all limits",async()=>{
  const f=fixture(),r=await f.execute(),s=f.getState();assert.equal(r.failure,null);
  const req=f.calls.find(c=>c.method==="POST"&&c.pathname.includes("/instances?"));
  assert.deepEqual(req.body.scheduling,{provisioningModel:"STANDARD",automaticRestart:false,onHostMaintenance:"MIGRATE",
    terminationTime:new Date(s.startedAt+7200000).toISOString(),instanceTerminationAction:"DELETE"});
  assert.equal(req.body.machineType,"zones/us-central1-a/machineTypes/e2-medium");
  assert.equal(req.body.disks.length,1);assert.equal(req.body.disks[0].autoDelete,true);
  assert.equal(req.body.disks[0].initializeParams.diskSizeGb,"50");
  assert.equal(req.body.disks[0].initializeParams.sourceImage,plan.sourceImage);
  assert.deepEqual(req.body.serviceAccounts,[]);assert.equal(req.body.deletionProtection,false);
  assert.equal(req.body.name,P.resourceName(s.missionId,"instances"));
  assert.equal(req.body.description,P.description(plan,s.missionId));
  assert.ok(req.pathname.endsWith("requestId="+s.resources.instances.createRequestId));
  assert.deepEqual(f.calls.find(c=>c.method==="POST"&&c.pathname.includes("/firewalls?")).body.sourceRanges,[plan.operatorIpv4+"/32"]);
  assert.equal(s.resources.instances.creationResponse.classification,"accepted");
  assert.equal(s.resources.instances.creationResponse.httpStatus,200);
});
for(const change of [{onHostMaintenance:"TERMINATE"},{terminationAction:"STOP"},{maxExistenceSeconds:7201},{automaticRestart:true},{provisioningModel:"SPOT"}])
test("invalid maintenance/lifetime plan rejected BEFORE any provider request "+JSON.stringify(change),async()=>{
  const f=fixture(),bad={...plan,...change};
  await assert.rejects(runGoogleProof({plan:bad,approvalSha256:bad.approvalSha256,store:f.store,provider:f.provider,guest:{}}),/plan_changed/);
  assert.equal(f.calls.length,0);
});
test("exact synchronous E2 rejection is sanitized and reconciled within controller",async()=>{
  const f=fixture({rejectMaintenance:true,preexisting:true}),r=await f.execute(),s=f.getState();
  assert.equal(r.failure,"gcp_proof_create_definitive_rejection");assert.equal(r.destructionConfirmed,true);
  assert.equal(f.resources.size,0);assert.equal(f.sequences,0);assert.equal(s.resources.instances.id,null);
  assert.equal(s.resources.instances.createOp,null);assert.equal(s.resources.instances.creationResponse.httpStatus,400);
  assert.equal(s.resources.instances.creationResponse.normalizedCode,"E2_STANDARD_MAINTENANCE_INVALID");
  assert.ok(s.resources.disks.absentConfirmedAt);assert.equal(f.calls.filter(c=>c.method==="POST"&&c.pathname.includes("/instances?")).length,1);
  assert.equal(f.calls.some(c=>c.method==="DELETE"&&c.pathname.includes("preexisting-resource")),false);
  assert.ok(Object.values(s.preexistingPreserved).every(v=>v===true));
  assert.equal(JSON.stringify(s).includes("Invalid value for field"),false);
});
for(const status of [400,408,409,429,500,503])test("generic HTTP "+status+" plus absence is NOT definitive rejection",async()=>{
  const f=fixture({unknownHttp:status}),r=await f.execute(),s=f.getState();
  assert.equal(r.destructionConfirmed,false);assert.equal(f.sequences,0);
  assert.equal(s.resources.instances.creationResponse.httpStatus,status);
  assert.equal(s.resources.instances.creationResponse.classification,"unknown");
  assert.equal(JSON.stringify(s).includes("confidential"),false);
  assert.equal(f.calls.filter(c=>c.method==="POST"&&c.pathname.includes("/instances?")).length,1);
});
test("absolute deadline cannot be extended while building the actual POST",()=>{
  const s={missionId:"bfc97853-cdf8-40e1-9cbb-43f49f686f80",startedAt:1000,deadlineAt:7201001};
  assert.throws(()=>P.bodyFor(plan,s,"networks"),/absolute_deadline_invalid/);
});
test("accepted asynchronous failure retains only normalized official error codes",async()=>{
  const f=fixture({operationError:true});await f.execute();const s=f.getState();
  assert.equal(s.resources.instances.createOp.status,"DONE");
  assert.deepEqual(s.resources.instances.createOp.errorCodes,["QUOTA_EXCEEDED","UNCLASSIFIED"]);
  assert.equal(s.resources.instances.creationResponse.httpStatus,200);
  assert.equal(JSON.stringify(s).includes("secret-synthetic"),false);
  assert.equal(JSON.stringify(s).includes("private details"),false);
});
