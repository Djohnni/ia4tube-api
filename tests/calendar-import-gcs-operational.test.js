"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const fs=require("node:fs/promises"),path=require("node:path");
const {createOperationalCalendarPipelineFixture,PREFIX,hash}=require("./helpers/operational-calendar-pipeline-fixture");
const {configureGooglePipeline}=require("./helpers/gcs-operational-pipeline");
const {createOfflineGcsFixture}=require("./helpers/gcs-offline-storage-fixture");
const NEGOTIATED={"X-IA4Tube-Media-Transport":"gcs-parts-v1"};
test("Google objects through real tenant PostgreSQL, actual process preparation, HTTP previews and calendar Meta bridge",{timeout:300000},async t=>{
  let f;const cloud=createOfflineGcsFixture({clock:()=>f?.clock()||Date.now()});t.after(()=>cloud.close());
  f=await createOperationalCalendarPipelineFixture(t,{configurePrivatePipeline:(t,pipeline,options)=>configureGooglePipeline(t,pipeline,{...options,gcsCloud:cloud})});
  let ready,committed,sourceBytes;
  const context=()=>({...f.context,mediaTransport:"gcs-parts-v1"});
  async function start(bytes,declaredHash=hash(bytes)){
    return f.upload.start(context(),{idempotencyKey:crypto.randomUUID(),kind:"video",mimeType:"video/mp4",sizeBytes:bytes.length,sha256:declaredHash});
  }
  async function authorize(upload,bytes,partNumber=1){
    const part=bytes.subarray((partNumber-1)*5242880,Math.min(partNumber*5242880,bytes.length));
    const auth=await f.upload.authorizePart(context(),{uploadId:upload.uploadId,partNumber,sha256:hash(part),md5Base64:crypto.createHash("md5").update(part).digest("base64")});
    const grant=await f.current().imports.upload.resolvePart(context(),{uploadId:upload.uploadId,partNumber,authorizationId:auth.authorizationId});
    assert.equal(grant.transport,"gcs-parts-v1");assert.equal(Object.keys(grant.headers).some(key=>key.toLowerCase()==="authorization"),false);
    return {part,grant};
  }
  await t.test("legacy JPEG still prepares on disk, while negotiated capabilities advertise a separate Google profile",async()=>{
    const cap=await f.request(`${PREFIX}/capabilities`,{headers:NEGOTIATED});assert.equal(cap.status,200);
    assert.equal((await cap.json()).upload.gcs.bucket,cloud.bucketName);
    const legacy=await f.preparePhoto({upload:{transport:"render"}});assert.equal(legacy.status.state,"ready");
    const state=await f.store.read(f.context.companyId,state=>state);assert.equal(Object.values(state.uploads).find(row=>row.assetId===legacy.assetId).storageProvider,"render_disk");
  });
  await t.test("Google upload, inspection and preparation archive immutable verified results",async()=>{
    ready=await f.prepareVideo({selection:{kind:"video",targets:["reel","story"],audioMode:"original"}});
    assert.equal(ready.status.state,"ready");
    const state=await f.store.read(f.context.companyId,state=>state),upload=Object.values(state.uploads).find(row=>row.assetId===ready.assetId),job=state.preparation.jobs[state.preparation.assets[ready.assetId].revisions[String(ready.mediaRevision)]];
    assert.equal(upload.storageProvider,"gcs");assert.equal(upload.gcs.phase,"sealed");assert.equal(upload.state,"uploaded");
    sourceBytes=Buffer.from(cloud.objects.get(upload.objectKey+"/source").bytes);
    assert.equal(state.gcsPrepared[job.result.resultRef].phase,"ready");
    assert.equal(JSON.stringify(state).includes("X-Goog-Signature"),false);
    const metadataResponse=await f.request(`${PREFIX}/assets/${ready.assetId}/revisions/${ready.mediaRevision}/preview`,{headers:NEGOTIATED});
    assert.equal(metadataResponse.status,200);const metadata=(await metadataResponse.json()).preview;
    assert.equal(metadata.googleStorage.bucket,cloud.bucketName);
    const reel=metadata.variants.find(v=>v.target==="reel");assert.equal(typeof reel.googleDownload.generation,"string");
    assert.equal(new URL(reel.googleDownload.url).searchParams.get("generation"),reel.googleDownload.generation);
    const preview=await f.request(new URL(reel.url).pathname);assert.equal(preview.status,200);
    assert.equal(hash(Buffer.from(await preview.arrayBuffer())),reel.sha256);
    const stranger=await f.request(`${PREFIX}/assets/${ready.assetId}/revisions/${ready.mediaRevision}/preview`,{headers:{...NEGOTIATED,Authorization:`Bearer ${f.otherToken}`}});
    assert.notEqual(stranger.status,200);
  });
  await t.test("Android metadata negotiation issues exact Google PUTs while status and resume remain authenticated",async()=>{
    const post=async(route,body)=>{const response=await f.request(route,{method:"POST",headers:{...NEGOTIATED,"Content-Type":"application/json"},body:JSON.stringify(body)});
      const json=await response.json();assert.equal(response.status,200,JSON.stringify(json));return json;};
    const started=(await post(`${PREFIX}/uploads`,{idempotencyKey:crypto.randomUUID(),kind:"video",mimeType:"video/mp4",sizeBytes:sourceBytes.length,sha256:hash(sourceBytes)})).upload;
    const part=(await post(`${PREFIX}/uploads/${started.uploadId}/parts/1/authorize`,{sha256:hash(sourceBytes),md5Base64:crypto.createHash("md5").update(sourceBytes).digest("base64")})).part;
    const grant=(await post(`${PREFIX}/uploads/${started.uploadId}/parts/1/resolve`,{authorizationId:part.authorizationId})).grant;
    assert.equal(grant.transport,"gcs-parts-v1");assert.equal(new URL(grant.url).hostname,"storage.googleapis.com");
    await cloud.putSigned(grant,sourceBytes);
    assert.equal((await post(`${PREFIX}/uploads/${started.uploadId}/resume`,{})).upload.completedParts.length,1);
    const denied=await f.request(`${PREFIX}/uploads/${started.uploadId}`,{headers:{Authorization:`Bearer ${f.otherToken}`}});
    assert.equal(denied.status,503,"The existing runtime disables import metadata for an ineligible owner");
    assert.equal(JSON.stringify(await denied.json()).includes(started.uploadId),false);
    assert.equal((await post(`${PREFIX}/uploads/${started.uploadId}/complete`,{})).upload.state,"uploaded");
  });
  await t.test("new clients send a whole video above 5 MiB in one PUT, then prepare the same file with audio",async()=>{
    const capabilities=await (await f.request(`${PREFIX}/capabilities`,{headers:NEGOTIATED})).json();
    assert.equal(capabilities.upload.gcs.singleRequestVideo,true);
    assert.equal(capabilities.upload.chunkBytes,5242880,"Legacy clients still see their original geometry");
    // A valid MP4 free box makes the fixture exceed one legacy part without
    // changing the decoded video or its original audio.
    const free=Buffer.alloc(6*1024*1024);free.writeUInt32BE(free.length);free.write("free",4,"ascii");
    const bytes=Buffer.concat([sourceBytes,free]),idempotencyKey=crypto.randomUUID();
    const body={idempotencyKey,kind:"video",mimeType:"video/mp4",sizeBytes:bytes.length,sha256:hash(bytes),uploadMode:"single"};
    const post=async(route,input)=>{
      const response=await f.request(route,{method:"POST",headers:{...NEGOTIATED,"Content-Type":"application/json"},body:JSON.stringify(input)});
      const json=await response.json();assert.equal(response.status,200,JSON.stringify(json));return json;
    };
    const started=(await post(`${PREFIX}/uploads`,body)).upload;
    assert.equal(started.uploadMode,"single");assert.equal(started.partCount,1);assert.equal(started.chunkBytes,bytes.length);
    assert.equal((await post(`${PREFIX}/uploads`,body)).upload.uploadId,started.uploadId,"Start replay keeps its exact identity");
    const withoutMode={...body};delete withoutMode.uploadMode;
    const conflicting=await f.request(`${PREFIX}/uploads`,{method:"POST",headers:{...NEGOTIATED,"Content-Type":"application/json"},body:JSON.stringify(withoutMode)});
    assert.equal(conflicting.status,409,"A legacy start cannot adopt a differently shaped transfer");
    const authorization=(await post(`${PREFIX}/uploads/${started.uploadId}/parts/1/authorize`,{
      sha256:hash(bytes),md5Base64:crypto.createHash("md5").update(bytes).digest("base64")})).part;
    const grant=(await post(`${PREFIX}/uploads/${started.uploadId}/parts/1/resolve`,{authorizationId:authorization.authorizationId})).grant;
    assert.equal(grant.sizeBytes,bytes.length);assert.equal(grant.headers["content-length"],String(bytes.length));
    const before=cloud.calls.filter(call=>call.operation==="signed_put").length;
    cloud.failNext("signed_put",{afterCommit:true});await assert.rejects(cloud.putSigned(grant,bytes));
    const resumed=(await post(`${PREFIX}/uploads/${started.uploadId}/resume`,{})).upload;
    assert.equal(resumed.uploadMode,"single");
    assert.deepEqual(resumed.completedParts,[{partNumber:1,sizeBytes:bytes.length,sha256:hash(bytes)}]);
    assert.equal(cloud.calls.filter(call=>call.operation==="signed_put").length,before+1,"Lost ACK is reconciled without resending bytes");
    await assert.rejects(f.upload.authorizePart(context(),{uploadId:started.uploadId,partNumber:2,sha256:hash(bytes),md5Base64:crypto.createHash("md5").update(bytes).digest("base64")}),{code:"import_part_invalid"});
    const completed=(await post(`${PREFIX}/uploads/${started.uploadId}/complete`,{})).upload;
    assert.equal(completed.state,"uploaded");assert.equal(completed.uploadMode,"single");assert.equal(completed.verification.sha256,hash(bytes));
    const prepared=await f.enqueuePrepared(completed,{kind:"video",targets:["reel"],audioMode:"original"});
    assert.equal(prepared.status.state,"ready");
    const state=await f.snapshot(),stored=state.uploads[started.uploadId];
    assert.equal(Object.keys(stored.gcs.parts).length,1);assert.equal(stored.gcs.manifest.length,1);
    assert.equal(stored.verified.hasAudio,true);
    assert.equal(hash(cloud.objects.get(stored.objectKey+"/source").bytes),hash(bytes));
    const preview=await f.request(`${PREFIX}/assets/${prepared.assetId}/revisions/${prepared.mediaRevision}/preview`,{headers:NEGOTIATED});
    assert.equal(preview.status,200);assert.ok((await preview.json()).preview.variants.some(v=>v.target==="reel"));
    assert.equal(cloud.calls.filter(call=>call.operation==="signed_put").length,before+1,"Preparation does not ask the phone to upload again");
    const {validateGcsUploadRecord}=require("../src/social/calendar/imports/gcs-provider");
    assert.throws(()=>validateGcsUploadRecord({...structuredClone(stored),chunkBytes:5242880}),/state_invalid/);
  });
  await t.test("full-file mode is rejected for images, unnegotiated disk uploads, and oversized inputs",async()=>{
    const base={idempotencyKey:crypto.randomUUID(),kind:"video",mimeType:"video/mp4",sizeBytes:22*1024*1024,sha256:hash(sourceBytes),uploadMode:"single"};
    await assert.rejects(f.upload.start(f.context,base),{code:"import_single_upload_unavailable"});
    await assert.rejects(f.upload.start(context(),{...base,kind:"image",mimeType:"image/png",sizeBytes:1024}),{code:"import_request_invalid"});
    await assert.rejects(f.upload.start(context(),{...base,sizeBytes:100*1024*1024+1}),{code:"import_request_invalid"});
    const legacy=await f.upload.start(context(),{...base,uploadMode:undefined});
    assert.equal(legacy.chunkBytes,5242880);assert.equal(legacy.partCount,5);assert.equal(legacy.uploadMode,undefined);
    await f.upload.cancel(context(),{uploadId:legacy.uploadId});
  });
  await t.test("full-file cancellation fences its single late PUT without changing existing objects",async()=>{
    const bytes=Buffer.alloc(6*1024*1024,29);
    const started=await f.upload.start(context(),{idempotencyKey:crypto.randomUUID(),kind:"video",mimeType:"video/mp4",sizeBytes:bytes.length,sha256:hash(bytes),uploadMode:"single"});
    const auth=await f.upload.authorizePart(context(),{uploadId:started.uploadId,partNumber:1,sha256:hash(bytes),md5Base64:crypto.createHash("md5").update(bytes).digest("base64")});
    const grant=await f.upload.resolvePart(context(),{uploadId:started.uploadId,partNumber:1,authorizationId:auth.authorizationId});
    assert.equal((await f.upload.cancel(context(),{uploadId:started.uploadId})).state,"cancelled");
    await assert.rejects(cloud.putSigned(grant,bytes),error=>error.code===412);
    const stored=(await f.snapshot()).uploads[started.uploadId];
    assert.equal(stored.gcs.phase,"aborted");assert.ok(stored.gcs.parts["1"].cancelGeneration);
    assert.equal(cloud.objects.has(stored.objectKey+"/source"),false);
  });
  await t.test("unacknowledged prepared generation requires a real byte SHA before adoption",async()=>{
    const state=await f.snapshot(),job=state.preparation.jobs[state.preparation.assets[ready.assetId].revisions[String(ready.mediaRevision)]],execution=state.preparationExecutions.records[job.dispatchKey];
    const commit=JSON.parse(await fs.readFile(path.join(f.preparationWorkingRoot,execution.executionId,"commit.json"),"utf8"));
    const saved=structuredClone(state.gcsPrepared[job.result.resultRef]),key=saved.objects.reel.objectKey,original=cloud.objects.get(key);
    const clearProof=()=>f.store.update(f.context.companyId,state=>{const row=state.gcsPrepared[saved.resultRef];row.phase="uploading";for(const item of Object.values(row.objects))if(item.objectKey===key)item.generation=null;});
    await clearProof();const reads=cloud.calls.filter(v=>v.operation==="stream").length;
    await f.gcsStore.commit(commit);assert.ok(cloud.calls.filter(v=>v.operation==="stream").length>reads);
    assert.equal((await f.snapshot()).gcsPrepared[saved.resultRef].phase,"ready");
    await clearProof();const wrong=Buffer.from(original.bytes);wrong[0]^=1;
    cloud.seed({objectKey:key,bytes:wrong,contentType:original.contentType,metadata:original.metadata});
    try{
      await assert.rejects(f.gcsStore.commit(commit),{code:"prepared_gcs_object_changed",statusCode:422});
      const pending=(await f.snapshot()).gcsPrepared[saved.resultRef];assert.equal(pending.phase,"uploading");assert.equal(pending.objects.reel.generation,null);
    }finally{cloud.objects.set(key,original);await f.store.update(f.context.companyId,state=>{state.gcsPrepared[saved.resultRef]=saved;});}
  });
  await t.test("lost part and compose ACKs recover the same immutable source after PostgreSQL restart",async()=>{
    const uploaded=await start(sourceBytes),{part,grant}=await authorize(uploaded,sourceBytes);
    cloud.failNext("signed_put",{afterCommit:true});await assert.rejects(cloud.putSigned(grant,part));
    const resumed=await f.upload.resume(context(),{uploadId:uploaded.uploadId});assert.deepEqual(resumed.completedParts,[{partNumber:1,sizeBytes:part.length,sha256:hash(part)}]);
    await assert.rejects(f.upload.resume(f.otherContext,{uploadId:uploaded.uploadId}));
    const before=cloud.calls.filter(x=>x.operation==="compose").length;
    cloud.failNext("compose",{afterCommit:true});await assert.rejects(f.upload.complete(context(),{uploadId:uploaded.uploadId}),{code:"import_verification_pending"});
    await f.reopen({restartDatabase:true});
    assert.equal((await f.upload.complete(context(),{uploadId:uploaded.uploadId})).state,"uploaded");
    assert.equal(cloud.calls.filter(x=>x.operation==="compose").length,before+1);
    const persisted=await f.store.read(f.context.companyId,state=>state.uploads[uploaded.uploadId]);assert.equal(persisted.gcs.phase,"sealed");
    assert.equal(persisted.gcs.inspectionTicket.dispatch.state,"ready");
  });
  await t.test("part checksums and full source SHA fail closed before a prepared result exists",async()=>{
    const uploaded=await start(sourceBytes,"a".repeat(64)),{part,grant}=await authorize(uploaded,sourceBytes);
    const wrong=Buffer.from(part);wrong[0]^=1;await assert.rejects(cloud.putSigned(grant,wrong));
    await cloud.putSigned(grant,part);
    await assert.rejects(f.upload.complete(context(),{uploadId:uploaded.uploadId}),error=>error.statusCode===422);
    const state=await f.store.read(f.context.companyId,state=>state);assert.equal(state.uploads[uploaded.uploadId].state,"rejected");
    assert.equal(state.prepareOutbox[uploaded.assetId+":1"],undefined);
  });
  await t.test("cancellation fences a late PUT and retains no final source or foreign modification",async()=>{
    const bytes=Buffer.alloc(5242880+17,23),uploaded=await start(bytes),one=await authorize(uploaded,bytes),two=await authorize(uploaded,bytes,2);
    await cloud.putSigned(one.grant,one.part);
    let entered,release;const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
    cloud.hooks.before=async event=>{if(event.operation==="signed_put"){entered();await gate;}};
    const late=cloud.putSigned(two.grant,two.part);await waiting;
    const cancelled=await f.upload.cancel(context(),{uploadId:uploaded.uploadId});assert.equal(cancelled.state,"cancelled");
    cloud.hooks.before=null;release();await assert.rejects(late,error=>error.code===412);
    const row=await f.store.read(f.context.companyId,state=>state.uploads[uploaded.uploadId]);assert.equal(row.gcs.phase,"aborted");
    for(const part of Object.values(row.gcs.parts)){assert.ok(part.cancelGeneration);assert.equal(cloud.objects.get(row.objectKey+"/parts/"+String(part.partNumber).padStart(2,"0")).metadata.cancelledUpload,row.uploadId);}
    assert.equal(cloud.objects.has(row.objectKey+"/source"),false);
    assert.equal((await f.upload.cancel(context(),{uploadId:uploaded.uploadId})).state,"cancelled");
  });
  await t.test("uncertain tombstone remains cancel_pending and reconciles after restart",async()=>{
    const bytes=Buffer.from("cancel"),uploaded=await start(bytes);await authorize(uploaded,bytes);
    cloud.hooks.after=async event=>{if(event.operation==="write"){cloud.hooks.after=null;cloud.failNext("head");throw Object.assign(Error("synthetic lost ACK"),{code:503});}};
    await assert.rejects(f.upload.cancel(context(),{uploadId:uploaded.uploadId}),{code:"import_cancellation_pending"});
    assert.equal((await f.upload.status(context(),{uploadId:uploaded.uploadId})).state,"cancel_pending");
    await f.reopen({restartDatabase:true});assert.equal((await f.upload.cancel(context(),{uploadId:uploaded.uploadId})).state,"cancelled");
  });
  await t.test("calendar response carries Google grants only in memory; publication still uses guarded Meta bridge",async()=>{
    const {assetId,...body}=f.inputFor(ready),scheduled=await f.post(`${PREFIX}/assets/${assetId}/schedule`,body);assert.equal(scheduled.status,200);committed=(await scheduled.json()).schedule;
    const listed=await f.request("/v1/social/calendar",{headers:NEGOTIATED});assert.equal(listed.status,200);
    const item=(await listed.json()).items.find(value=>value.id===committed.id);assert.ok(item);assert.equal(item.media.googleStorage.bucket,cloud.bucketName);
    const reel=item.media.variants.find(v=>v.target==="reel");assert.ok(reel.url.includes("/schedules/"));assert.ok(reel.googleDownload);
    assert.equal(JSON.stringify(await f.current().calendarStore.read(f.context.companyId,state=>state)).includes("X-Goog-Signature"),false);
    f.advance(Math.max(0,require("../src/social/calendar/model").dateTime(committed.date,committed.time)-f.clock()));
    for(let i=0;i<committed.selectedTargets.length;i++){await f.current().calendar.tick();f.advance(60001);}
    const published=await f.current().calendarStore.read(f.context.companyId,state=>state.jobs[committed.id]);
    assert.equal(published.phase,"published");assert.ok(f.providerCalls.length>0);
    for(const target of committed.selectedTargets){assert.equal(published.deliveries[target].phase,"published");assert.equal(published.deliveries[target].publication.published,true);}
    assert.equal(f.providerCalls.some(call=>JSON.stringify(call).includes("X-Goog-Signature")),false);
  });
  await t.test("persisted Google and legacy media survive new-admission rollback and disabled processing runtime",async()=>{
    f.setNewGoogleEnabled(false);await f.reopen();
    const cap=await f.request(`${PREFIX}/capabilities`,{headers:NEGOTIATED});assert.equal((await cap.json()).upload.gcs.bucket,cloud.bucketName);
    const fresh=await f.upload.start({...f.context,mediaTransport:"gcs-parts-v1"},{idempotencyKey:crypto.randomUUID(),kind:"video",mimeType:"video/mp4",sizeBytes:3,sha256:hash(Buffer.from("new"))});
    assert.equal((await f.store.read(f.context.companyId,state=>state)).uploads[fresh.uploadId].storageProvider,"render_disk");
    await f.reopen({importsDisabled:true});
    const historical=await f.request(`${PREFIX}/schedules/${committed.id}/preview`,{headers:NEGOTIATED});assert.equal(historical.status,200);
    const metadata=(await historical.json()).preview;assert.equal(metadata.googleStorage.bucket,cloud.bucketName);
    const reel=metadata.variants.find(v=>v.target==="reel"),bytes=await f.request(new URL(reel.url).pathname);assert.equal(bytes.status,200);
    assert.equal(hash(Buffer.from(await bytes.arrayBuffer())),reel.sha256);
  });
});
