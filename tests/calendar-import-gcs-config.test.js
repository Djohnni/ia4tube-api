"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),path=require("node:path");
const {loadGcsConfig,createConfiguredGcsTransport,mediaTransport}=require("../src/social/calendar/imports/gcs-config");
const {validateGcsUploadRecord}=require("../src/social/calendar/imports/gcs-provider");
const {withGooglePreview}=require("../src/social/calendar/imports/google-preview");
const invalid=error=>error.code==="ready_video_gcs_configuration_invalid";
test("Google admission is opt-in and its exclusive credentials never fall back to global ADC",()=>{
  assert.equal(loadGcsConfig({}).enabled,false);assert.equal(createConfiguredGcsTransport({}),null);
  const env={ENVIRONMENT:"production",SOCIAL_READY_VIDEO_GCS_BUCKET:"synthetic-private-bucket",SOCIAL_READY_VIDEO_GCS_ENABLED:"true"};
  for(const flag of ["", "1", true])assert.throws(()=>loadGcsConfig({...env,SOCIAL_READY_VIDEO_GCS_ENABLED:flag}),invalid);
  assert.throws(()=>loadGcsConfig({...env,ENVIRONMENT:"staging"}),invalid);
  for(const value of [undefined,"","relative.json","bad\nfile"])
    assert.throws(()=>createConfiguredGcsTransport({...env,SOCIAL_READY_VIDEO_GCS_CREDENTIALS_FILE:value,GOOGLE_APPLICATION_CREDENTIALS:path.resolve("unrelated-firebase.json")}),invalid);
  const reader=createConfiguredGcsTransport({...env,SOCIAL_READY_VIDEO_GCS_ENABLED:"false",SOCIAL_READY_VIDEO_GCS_CREDENTIALS_FILE:path.resolve("synthetic-not-opened.json")});
  assert.equal(reader.bucketName,env.SOCIAL_READY_VIDEO_GCS_BUCKET);reader.close();
});
test("Google negotiation rejects unknown or duplicate headers without changing the legacy default",()=>{
  assert.equal(mediaTransport({headers:{}}),null);
  assert.equal(mediaTransport({headers:{"x-ia4tube-media-transport":"gcs-parts-v1"}}),"gcs-parts-v1");
  assert.throws(()=>mediaTransport({headers:{"x-ia4tube-media-transport":"other"}}),invalid);
  assert.throws(()=>mediaTransport({headers:{"x-ia4tube-media-transport":"gcs-parts-v1"},rawHeaders:["X-IA4Tube-Media-Transport","gcs-parts-v1","x-ia4tube-media-transport","gcs-parts-v1"]}),invalid);
});
function row(){
  const part={partNumber:1,sizeBytes:3,sha256:"a".repeat(64),md5Base64:crypto.createHash("md5").update("abc").digest("base64"),authorizationId:crypto.randomUUID(),expiresAt:Date.now()+120000,generation:"123"};
  const manifest=[{partNumber:1,sizeBytes:3,sha256:part.sha256,generation:part.generation}];
  return {storageProvider:"gcs",chunkBytes:5242880,sizeBytes:3,gcs:{schema:1,phase:"composing",uploadId:crypto.randomUUID(),objectVersion:crypto.randomUUID(),parts:{1:part},manifest,
    manifestDigest:crypto.createHash("sha256").update(JSON.stringify(manifest.map(p=>[p.partNumber,p.sizeBytes,p.sha256,p.generation]))).digest("hex")}};
}
test("persisted compose intent pins complete ordered generations and rejects forged mixed-provider or cancellation states",()=>{
  const valid=row();assert.equal(validateGcsUploadRecord(valid),valid);
  for(const mutate of [x=>{x.disk={};},x=>{x.gcs.manifest[0].generation="456";},x=>{x.gcs.manifest=[];},
    x=>{x.gcs.phase="sealed";},x=>{x.gcs.phase="aborted";x.gcs.cleanupVerified=true;},x=>{x.gcs=null;}]){
    const changed=structuredClone(valid);mutate(changed);assert.throws(()=>validateGcsUploadRecord(changed),/state_invalid/);
  }
});
test("optional Google previews preserve Render URLs and do not persist or surface a failed signing operation",async()=>{
  const preview={assetId:crypto.randomUUID(),mediaRevision:1,variants:[{target:"reel",url:"https://ia4tube-api.onrender.com/private",sha256:"a".repeat(64)}],thumbnail:null};
  const before=structuredClone(preview),context={mediaTransport:"gcs-parts-v1"};
  const store={googleStorage:{bucket:"synthetic-private-bucket",objectPrefix:"ready-video/"},googleDownload:async()=>({url:"https://storage.googleapis.com/synthetic-private-bucket/ready-video/object?generation=123",expiresAt:Date.now()+120000,generation:"123"})};
  const value=await withGooglePreview(store,context,preview,crypto.randomUUID());
  assert.equal(value.variants[0].url,preview.variants[0].url);assert.equal(value.variants[0].googleDownload.generation,"123");assert.deepEqual(preview,before);
  assert.equal(await withGooglePreview(store,{},preview,crypto.randomUUID()),preview);
  assert.equal(await withGooglePreview({...store,googleDownload:async()=>{throw Error("synthetic secret not forwarded");}},context,preview,crypto.randomUUID()),preview);
});
