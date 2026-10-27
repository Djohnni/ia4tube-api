"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const {createRequire}=require("node:module");
test("complete ready-video composition keeps legacy progress moving after a Google cancellation fails",async()=>{
  const filename=path.resolve(__dirname,"../src/social/calendar/imports/ready-video-runtime.js"),realRequire=createRequire(filename),calls=[],reported=[];
  const owner={companyId:"11111111-1111-4111-8111-111111111111",userId:"22222222-2222-4222-8222-222222222222",audience:"customers"};
  const state={uploads:{cloud:{...owner,uploadId:"cloud-cancel",storageProvider:"gcs",state:"cancel_pending"},legacy:{...owner,uploadId:"legacy-verify",state:"verifying"}},
    preparation:{jobs:{legacy:{...owner,assetId:"legacy-asset",mediaRevision:1,state:"processing"}}}};
  const store={verify:async()=>true,update:async(companyId,operation)=>{assert.equal(companyId,owner.companyId);return operation(state);}};
  const runner=kind=>({capabilities:{},resumePending:async()=>calls.push(kind+"-resume"),drain:async()=>{},dispatch(){},getByKey(){},assertExecutionHeld(){}});
  const modules={
    "node:fs/promises":{stat:async()=>({dev:1,mode:0o700,uid:0}),mkdir:async()=>{}},
    "./ready-video-config":{loadReadyVideoConfig:()=>({enabled:true,subjects:["synthetic"],publicOrigin:"https://ia4tube-api.onrender.com"}),resolveReadyVideoOwners:async()=>[owner]},
    "./gcs-config":{loadGcsConfig:()=>({enabled:true}),createConfiguredGcsTransport(){throw Object.assign(Error(),{code:"gcs_unavailable"});}},
    "./postgres-store":{createImportUploadPostgresStore:()=>store},
    "./postgres-global-capacity-store":{createPostgresGlobalCapacityStore:()=>({verify:async()=>true})},
    "./postgres-transfer-registry-store":{createPostgresTransferRegistryStore:()=>({verify:async()=>true})},
    "./global-capacity":{createGlobalMediaCapacity:()=>({summary:async()=>({paused:false})})},
    "./disk-space-guard":{createDiskSpaceGuard:()=>({sample:async()=>({})})},
    "./render-disk-admission":{createRenderDiskAdmission:()=>({})},"./prepared-disk-admission":{createPreparedDiskAdmission:()=>({})},
    "./ready-video-process-executor":{createReadyVideoProcessExecutor:()=>({prepareRuntime:async()=>{},capabilities:{hardTermination:true}})},
    "./operational-inspection-runner":{createOperationalInspectionRunner:()=>runner("inspection"),isOperationalInspectionRunner:()=>true},
    "./operational-preparation-runner":{createOperationalPreparationRunner:()=>runner("preparation"),isOperationalPreparationRunner:()=>true},
    "./process-disk-inspection-worker":{createProcessDiskInspectionWorker:()=>({})},"./process-disk-preparation-worker":{createProcessDiskPreparationWorker:()=>({})},
    "./inspection-dispatcher":{createDurableInspectionDispatcher:()=>({})},"./render-disk-provider":{createRenderDiskPrivateUploadProvider:()=>({})},
    "./storage-provider-router":{createUploadStorageRouter:()=>({})},
    "./upload-service":{createCalendarImportUploadService:()=>({cancel:async()=>{calls.push("cancel");throw Object.assign(Error(),{code:"import_gcs_unavailable"});},complete:async()=>calls.push("complete")})},
    "./prepared-disk-store":{createPreparedDiskResultStore:()=>({}),createRoutedPreparedResultStore:()=>({})},
    "./prepared-disk-output-inspector":{createPreparedDiskOutputInspector:()=>({})},
    "./preparation-queue":{createPreparationQueue:()=>({reconcile:async()=>calls.push("reconcile"),dispatchNext:async()=>calls.push("dispatch")})},
    "./transfer-registry":{createTransferAuthorizationRegistry:()=>({verify:async()=>true})},
    "./transfer-service":{createRenderDiskTransferService:()=>({}),createSingleProcessTransferLimiter:()=>({})},
    "./operational-runtime":{createOperationalCalendarImportsRuntimeFactory:options=>{options.onSubmissionsReady({progress:async()=>calls.push("submission")});return async()=>({});}},
    "./media-process-executor":{safePath:async()=>{}},
  };
  const module={exports:{}};vm.runInNewContext(fs.readFileSync(filename,"utf8"),{module,exports:module.exports,require:name=>modules[name]||realRequire(name),process,setTimeout,clearTimeout,console},{filename});
  const runtime=await module.exports.createReadyVideoRuntime({env:{SOCIAL_READY_VIDEO_GCS_ENABLED:"true"},tenantPool:{},capacityPool:{},transferPool:{},
    rootDirectory:path.resolve(__dirname,"synthetic-never-created"),logger:{error:value=>reported.push(value)}});
  await runtime.tick();await runtime.close();
  assert.deepEqual(calls,["submission","cancel","complete","reconcile","inspection-resume","preparation-resume","dispatch","submission"]);
  assert.equal(state.uploads.cloud.state,"cancel_pending");assert.equal(reported.length,1);
  assert.deepEqual(Object.keys(reported[0]).sort(),["code","component"]);
  assert.equal(fs.existsSync(path.resolve(__dirname,"synthetic-never-created")),false);
});
