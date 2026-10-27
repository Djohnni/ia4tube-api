"use strict";
// Real PostgreSQL and actual process workers; only Google HTTP is intercepted
// by the separately scoped SDK fixture in this test process.
const crypto=require("node:crypto"),assert=require("node:assert/strict");
const base="../../src/social/calendar/imports/";
const hash=(bytes,kind="sha256",encoding="hex")=>crypto.createHash(kind).update(bytes).digest(encoding);
async function configureGooglePipeline(t,f,{gcsCloud,newGcsEnabled=true}={}){
  const reopen=f.reopen,legacyUploadBytes=f.uploadBytes;
  async function mount(){
    const disk=f.provider,diskStore=f.preparedStore,transport=gcsCloud.createTransport();
    let inspectionWorker,preparationWorker;
    const inspectionRunner=require(base+"operational-inspection-runner").createOperationalInspectionRunner({store:f.store,owner:f.context,capacity:f.capacity,
      accessPolicy:f.accessPolicy,diskSpaceGuard:f.guard,getWorker:()=>inspectionWorker,enabled:true,clock:f.clock});
    const inspector=require(base+"inspection-dispatcher").createDurableInspectionDispatcher({store:f.store,runner:inspectionRunner,accessPolicy:f.accessPolicy,enabled:true,clock:f.clock});
    const gcsProvider=require(base+"gcs-provider").createGcsPrivateUploadProvider({store:f.store,transport,inspector,accessPolicy:f.accessPolicy,enabled:true,clock:f.clock});
    const provider=require(base+"storage-provider-router").createUploadStorageRouter({store:f.store,disk,gcs:gcsProvider,accessPolicy:f.accessPolicy,newGcsEnabled});
    const gcsStore=require(base+"gcs-prepared-store").createGcsPreparedResultStore({tenantStore:f.store,diskStore,transport,accessPolicy:f.accessPolicy,clock:f.clock});
    const preparedStore=require(base+"prepared-disk-store").createRoutedPreparedResultStore({diskStore,gcsStore,tenantStore:f.store});
    const upload=require(base+"upload-service").createCalendarImportUploadService({store:f.store,provider,enabled:true,clock:f.clock});
    inspectionWorker=require(base+"process-disk-inspection-worker").createProcessDiskInspectionWorker({provider:{streamSealedObject(args){f.counters.inspectionSourceReads++;return provider.streamSealedObject(args);}},
      workingDirectory:f.inspectionWorkingRoot,executor:f.executor,clock:f.clock,assertExecutionHeld:value=>inspectionRunner.assertExecutionHeld(value)});
    const preparationRunner=require(base+"operational-preparation-runner").createOperationalPreparationRunner({store:f.store,owner:f.context,capacity:f.capacity,
      admission:f.preparedAdmission,accessPolicy:f.accessPolicy,getWorker:()=>preparationWorker,enabled:true,clock:f.clock});
    preparationWorker=require(base+"process-disk-preparation-worker").createProcessDiskPreparationWorker({provider:{streamSealedObject(args){f.counters.preparationSourceReads++;return provider.streamSealedObject(args);}},
      workingDirectory:f.preparationWorkingRoot,preparationRoot:f.preparationRoot,resultStore:preparedStore,admission:f.preparedAdmission,executor:f.executor,clock:f.clock});
    const preparation=require(base+"preparation-queue").createPreparationQueue({store:f.store,dispatcher:preparationRunner,resultStore:preparedStore,accessPolicy:f.accessPolicy,enabled:true,clock:f.clock});
    Object.assign(f,{provider,diskProvider:disk,gcsProvider,gcsTransport:transport,gcsProfile:{transport:"gcs-parts-v1",bucket:transport.bucketName,objectPrefix:transport.prefix},
      upload,preparedStore,gcsStore,inspectionRunner,inspector,inspectorWorker:inspectionWorker,preparationRunner,preparationWorker,preparation});
  }
  await mount();
  f.reopen=async settings=>{await reopen(settings);await mount();};
  f.setNewGoogleEnabled=value=>{newGcsEnabled=value;};
  f.uploadBytes=async(bytes,kind,mimeType,settings={})=>{
    if(settings.transport==="render")return legacyUploadBytes(bytes,kind,mimeType,settings);
    const context={...f.context,mediaTransport:"gcs-parts-v1"};
    const started=await f.upload.start(context,{idempotencyKey:settings.idempotencyKey||crypto.randomUUID(),kind,mimeType,sizeBytes:bytes.length,sha256:hash(bytes)});
    for(let offset=0,partNumber=1;offset<bytes.length;offset+=5242880,partNumber++){
      const part=bytes.subarray(offset,Math.min(offset+5242880,bytes.length));
      const authorized=await f.upload.authorizePart(context,{uploadId:started.uploadId,partNumber,sha256:hash(part),md5Base64:hash(part,"md5","base64")});
      const grant=await f.upload.resolvePart(context,{uploadId:started.uploadId,partNumber,authorizationId:authorized.authorizationId});
      assert.equal(grant.transport,"gcs-parts-v1");await gcsCloud.putSigned(grant,part);
      if(settings.afterPart)await settings.afterPart({started,partNumber});
    }
    const completed=await f.upload.complete(context,{uploadId:started.uploadId});
    assert.equal(completed.state,"uploaded");return completed;
  };
}
module.exports={configureGooglePipeline};
