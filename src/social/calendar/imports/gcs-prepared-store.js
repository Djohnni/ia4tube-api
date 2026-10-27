"use strict";
const {isDeepStrictEqual:equal}=require("node:util");
const crypto=require("node:crypto");
const {isImportAccessPolicy}=require("./access-policy");
const {MEDIA_READ_TIMEOUT_MS}=require("./media-read-timeout");
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/,GENERATION=/^[1-9][0-9]{0,19}$/;
const BINDING=["companyId","userId","assetId","mediaRevision","resultRef","dispatchKey","executionDigest"];
const stores=new WeakSet();
const clone=value=>structuredClone(value);
function fail(code="unavailable",statusCode=503){throw Object.assign(new Error(`prepared_gcs_${code}`),{code:`prepared_gcs_${code}`,statusCode});}
function query(value,resultRef=value?.resultRef){
  const out=Object.fromEntries(BINDING.map(key=>[key,key==="resultRef"?resultRef:value?.[key]]));
  if(!["companyId","userId","assetId","resultRef"].every(key=>UUID.test(out[key]||"")) || !HASH.test(out.dispatchKey||"") ||
    !HASH.test(out.executionDigest||"") || !Number.isSafeInteger(out.mediaRevision) || out.mediaRevision<1)fail("binding_invalid",400);
  return out;
}
function validateGcsPreparedState(state,companyId){
  if(state.gcsPrepared===undefined)return;
  if(!state.gcsPrepared || Array.isArray(state.gcsPrepared) || Object.keys(state.gcsPrepared).length>1000)fail("state_invalid");
  for(const [id,row] of Object.entries(state.gcsPrepared)){
    const binding=query(row),job=state.preparation?.jobs?.[state.preparation?.assets?.[row.assetId]?.revisions?.[String(row.mediaRevision)]];
    const targets=Object.keys(row.actual?.prepared?.variants||{}).concat(row.actual?.prepared?.thumbnail?["thumbnail"]:[]).sort();
    if(row.schema!==1 || id!==row.resultRef || row.companyId!==companyId || !["uploading","ready"].includes(row.phase) || !equal(query(row.actual),binding) ||
       row.actual.complete!==true || row.actual.immutable!==true || row.actual.actualInspection!==true || !targets.length ||
       !job || job.userId!==row.userId || job.dispatchKey!==row.dispatchKey || job.executionDigest!==row.executionDigest ||
       state.uploads?.[job.uploadId]?.storageProvider!=="gcs" || !row.objects || Array.isArray(row.objects) || Object.keys(row.objects).length>4 ||
       !equal(Object.keys(row.objects).sort(),targets))fail("state_invalid");
    for(const [target,item] of Object.entries(row.objects)){
      const part=target==="thumbnail"?row.actual.prepared.thumbnail:row.actual.prepared.variants[target];
      const ref=target==="thumbnail"?row.actual.thumbnailObject:row.actual.objects[target];
      if(!["feed","story","reel","thumbnail"].includes(target) || !part || !ref || item.objectKey!==`${ref.objectKey}/result.${part.mimeType==="video/mp4"?"mp4":"jpg"}` ||
         !HASH.test(part.sha256||"") || item.sha256!==part.sha256 || item.sizeBytes!==part.size || item.objectVersion!==ref.objectVersion ||
         item.generation!==null && !GENERATION.test(item.generation||"") || row.phase==="ready" && !item.generation)fail("state_invalid");
    }
  }
}
function createGcsPreparedResultStore({tenantStore,diskStore,transport,accessPolicy,clock=Date.now,readOnly=false}={}){
  if(tenantStore?.capabilities?.persistence!=="durable" || typeof tenantStore.read!=="function" ||
     !require("./gcs-sdk-transport").isGcsSdkTransport(transport) || !isImportAccessPolicy(accessPolicy) ||
     !readOnly && (!require("./prepared-disk-store").isPreparedDiskResultStore(diskStore) || typeof diskStore.openCommittedObject!=="function"))fail("configuration_invalid");
  const profile=Object.freeze({bucket:transport.bucketName,objectPrefix:transport.prefix});
  function authorize(context){return accessPolicy.resolve(context);}
  async function read(binding,{ready=false}={}){
    const q=query(binding);authorize({...q,authenticated:true});
    return tenantStore.read(q.companyId,state=>{
      validateGcsPreparedState(state,q.companyId);
      const row=state.gcsPrepared?.[q.resultRef],job=state.preparation?.jobs?.[state.preparation?.assets?.[q.assetId]?.revisions?.[String(q.mediaRevision)]];
      if(!row || !equal(query(row),q) || !job || job.userId!==q.userId || ready && (row.phase!=="ready" || job.state!=="ready" || job.result?.resultRef!==q.resultRef))fail("not_found",404);
      if(state.retention?.records?.[q.assetId])fail("retired",404);
      return clone(row);
    });
  }
  function metadata(row,item){return {companyId:row.companyId,userId:row.userId,assetId:row.assetId,resultRef:row.resultRef,sha256:item.sha256,objectVersion:item.objectVersion};}
  function verify(row,item,remote){
    if(!remote?.exists || remote.sizeBytes!==item.sizeBytes || !GENERATION.test(remote.generation||"") ||
       item.generation && item.generation!==remote.generation || Object.entries(metadata(row,item)).some(([k,v])=>remote.metadata?.[k]!==v))fail("object_changed",422);
    return remote;
  }
  async function checked(row,target){
    const item=row.objects[target];if(!item?.generation)fail("not_found",404);
    const remote=verify(row,item,await transport.headObject({objectKey:item.objectKey,generation:item.generation}));
    return {item,remote,part:target==="thumbnail"?row.actual.prepared.thumbnail:row.actual.prepared.variants[target]};
  }
  function remaining(task){const value=Math.min(MEDIA_READ_TIMEOUT_MS,task.deadlineAt-clock());if(!Number.isSafeInteger(value)||value<1)fail("deadline_exceeded",408);return value;}
  async function proveExistingBytes(row,item,remote,task){
    verify(row,item,remote);const digest=crypto.createHash("sha256");let size=0;
    await transport.streamObject({objectKey:item.objectKey,generation:remote.generation,sizeBytes:item.sizeBytes,timeoutMs:remaining(task),
      consume:async bytes=>{authorize({...row,authenticated:true});size+=bytes.length;digest.update(bytes);}});
    if(size!==item.sizeBytes || digest.digest("hex")!==item.sha256)fail("object_changed",422);
  }
  async function preview(args,{inspect=true}={}){
    const owner=authorize(args.context);
    if(!["feed","story","reel","thumbnail"].includes(args.target) || !UUID.test(args.assetId||"") || !HASH.test(args.sha256||""))fail("request_invalid",400);
    const q=await tenantStore.read(owner.companyId,state=>{
      const asset=state.preparation?.assets?.[args.assetId],job=state.preparation?.jobs?.[asset?.revisions?.[String(args.mediaRevision)]];
      if(!asset || asset.userId!==owner.userId || !job || job.userId!==owner.userId || job.state!=="ready" || job.result?.resultRef!==args.resultRef)fail("not_found",404);
      return query(job,args.resultRef);
    });
    const row=await read(q,{ready:true}),value=inspect?await checked(row,args.target):{
      item:row.objects[args.target],part:args.target==="thumbnail"?row.actual.prepared.thumbnail:row.actual.prepared.variants[args.target]};
    if(!value.item?.generation || !value.part)fail("not_found",404);
    if(value.item.sha256!==args.sha256)fail("object_changed",409);
    authorize(args.context);return {row,...value};
  }
  const api={capabilities:Object.freeze({available:true,testOnly:false,actualInspection:true,immutableObjects:true,ownerScopedPreview:true}),googleStorage:profile,
    async inspectPreview(args){
      const {part}=await preview(args);
      return {assetId:args.assetId,mediaRevision:args.mediaRevision,resultRef:args.resultRef,target:args.target,
        sha256:part.sha256,mimeType:part.mimeType,sizeBytes:part.size,width:part.width,height:part.height,
        durationSeconds:part.durationSeconds??null,hasAudio:part.hasAudio,audioMode:part.audioMode,maxRangeBytes:100*1024**2};
    },
    async streamPreview(args){
      if(typeof args.consume!=="function" || args.signal?.aborted)fail("stream_aborted",499);
      const {row,item,part}=await preview(args),timeoutMs=args.timeoutMs??MEDIA_READ_TIMEOUT_MS;
      if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>MEDIA_READ_TIMEOUT_MS)fail("request_invalid",400);
      const start=args.range?.start??0,end=args.range?.end??(item.sizeBytes-1);let count=0;
      await transport.streamObject({objectKey:item.objectKey,generation:item.generation,sizeBytes:item.sizeBytes,range:{start,end},signal:args.signal,timeoutMs,
        consume:async bytes=>{authorize(args.context);if(bytes.length>65536 || count+bytes.length>end-start+1)fail("object_changed",422);
          count+=bytes.length;await args.consume(bytes);}});
      await read(query(row),{ready:true});
      if(count!==end-start+1)fail("object_changed",422);
      return {sha256:part.sha256,mimeType:part.mimeType,sizeBytes:item.sizeBytes,transferredBytes:count,start,end};
    },
    async googleDownload(args){
      // Generation and digest were durably verified at commit. Signing performs
      // fresh owner/state checks, but does not make cloud HEAD calls while a
      // calendar list is being assembled. The receiver validates actual bytes.
      const {item,part}=await preview(args,{inspect:false}),expiresAt=clock()+120000;
      const signed=await transport.signObjectRead({objectKey:item.objectKey,generation:item.generation,sizeBytes:item.sizeBytes,contentType:part.mimeType,expiresAt});
      authorize(args.context);return {url:signed.url,expiresAt:signed.expiresAt,generation:item.generation};
    }};
  if(!readOnly){
    api.commit=async input=>{
      const q=query(input.task,input.resultRef);authorize({...q,authenticated:true});
      const actual=await diskStore.commit(input);
      let row=await tenantStore.update(q.companyId,state=>{
        state.gcsPrepared??={};
        if(state.gcsPrepared[q.resultRef]){if(!equal(state.gcsPrepared[q.resultRef].actual,actual))fail("commit_conflict",409);return clone(state.gcsPrepared[q.resultRef]);}
        const objects={};
        for(const [target,part]of Object.entries({...actual.prepared.variants,...(actual.prepared.thumbnail?{thumbnail:actual.prepared.thumbnail}:{})})){
          const ref=target==="thumbnail"?actual.thumbnailObject:actual.objects[target];
          objects[target]={objectKey:`${ref.objectKey}/result.${part.mimeType==="video/mp4"?"mp4":"jpg"}`,objectVersion:ref.objectVersion,
            sha256:part.sha256,sizeBytes:part.size,generation:null};
        }
        const created={...q,schema:1,phase:"uploading",actual:clone(actual),objects};state.gcsPrepared[q.resultRef]=created;return clone(created);
      });
      for(const [target,item]of Object.entries(row.objects)){
        authorize({...q,authenticated:true});
        remaining(input.task);let remote=await transport.headObject({objectKey:item.objectKey,...(item.generation?{generation:item.generation}:{})});
        // A lost ACK or a crash after a rejected checksum can leave a generation
        // without a committed proof. Metadata alone cannot establish its bytes.
        if(remote.exists && !item.generation)await proveExistingBytes(row,item,remote,input.task);
        if(!remote.exists){
          if(item.generation)fail("object_changed",422);
          const opened=await diskStore.openCommittedObject({...q,target});
          try{await transport.uploadObject({objectKey:item.objectKey,bodyStream:opened.bodyStream,sizeBytes:item.sizeBytes,contentType:opened.part.mimeType,
            metadata:metadata(row,item),timeoutMs:remaining(input.task)});}
          finally{opened.bodyStream.destroy();}
          remote=await transport.headObject({objectKey:item.objectKey});
        }
        verify(row,item,remote);
        await tenantStore.update(q.companyId,state=>{
          const current=state.gcsPrepared[q.resultRef];if(!current || !equal(current.actual,actual) ||
             current.objects[target].generation && current.objects[target].generation!==remote.generation)fail("commit_conflict",409);
          current.objects[target].generation=remote.generation;
        });
      }
      await tenantStore.update(q.companyId,state=>{const current=state.gcsPrepared[q.resultRef];
        if(Object.values(current.objects).some(item=>!item.generation))fail("commit_incomplete");current.phase="ready";});
      return clone(actual);
    };
    api.inspectCommitted=async input=>{
      const row=await read(query(input));if(row.phase!=="ready")fail("commit_incomplete");
      for(const target of Object.keys(row.objects))await checked(row,target);
      return clone(row.actual);
    };
  }
  Object.freeze(api);if(!readOnly)stores.add(api);return api;
}
function createGcsPreparedResultReader(options){return createGcsPreparedResultStore({...options,readOnly:true});}
function isGcsPreparedResultStore(value){return stores.has(value);}
module.exports={createGcsPreparedResultStore,createGcsPreparedResultReader,isGcsPreparedResultStore,validateGcsPreparedState};
