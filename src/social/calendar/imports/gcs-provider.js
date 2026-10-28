"use strict";
const crypto = require("node:crypto");
const { isDeepStrictEqual: equal } = require("node:util");
const { CalendarImportUploadError } = require("./upload-service");
const { isImportAccessPolicy } = require("./access-policy");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const GENERATION = /^[1-9][0-9]{0,19}$/;
const instances = new WeakSet();
const clone = value => structuredClone(value);
// PostgreSQL jsonb reorders object keys. Ordered primitive tuples preserve the
// manifest proof across a durable round-trip.
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value.map(part=>[part.partNumber,part.sizeBytes,part.sha256,part.generation]))).digest("hex");
function fail(code = "unavailable", status = 503) { throw new CalendarImportUploadError(`import_gcs_${code}`, status); }
function md5(value) { return typeof value === "string" && /^[A-Za-z0-9+/]{22}==$/.test(value) && Buffer.from(value,"base64").toString("base64") === value; }
function validateGcsUploadRecord(row) {
  const value = row?.gcs;
  if (value === undefined) return row;
  if(!value || typeof value!=="object" || Array.isArray(value))fail("state_invalid");
  if (row.uploadMode !== undefined && row.uploadMode !== "single" ||
      row.uploadMode === "single" && (row.kind !== "video" || !Number.isSafeInteger(row.sizeBytes) ||
        row.sizeBytes < 1 || row.sizeBytes > 100 * 1024 * 1024 || row.chunkBytes !== row.sizeBytes)) fail("state_invalid");
  if (row.disk || row.r2 || row.storageProvider !== "gcs" || value.schema !== 1 ||
      !UUID.test(value.uploadId || "") || !UUID.test(value.objectVersion || "") ||
      !["open", "composing", "sealed", "aborting", "aborted"].includes(value.phase) ||
      !value.parts || Array.isArray(value.parts) || Object.keys(value.parts).length > 20) fail("state_invalid");
  for (const [key, part] of Object.entries(value.parts)) {
    const number = Number(key), size = Math.min(row.chunkBytes, row.sizeBytes - (number - 1) * row.chunkBytes);
    if (!Number.isSafeInteger(number) || String(number) !== key || number < 1 || number > Math.ceil(row.sizeBytes / row.chunkBytes) ||
        part.partNumber !== number || part.sizeBytes !== size || !HASH.test(part.sha256 || "") || !md5(part.md5Base64) ||
        !UUID.test(part.authorizationId || "") || !Number.isSafeInteger(part.expiresAt) || part.expiresAt < 1 ||
        part.generation !== undefined && !GENERATION.test(part.generation) ||
        part.cancelGeneration !== undefined && !GENERATION.test(part.cancelGeneration)) fail("state_invalid");
  }
  if (["composing","sealed"].includes(value.phase)) {
    if(!Array.isArray(value.manifest) || value.manifest.length!==Math.ceil(row.sizeBytes/row.chunkBytes) ||
       !HASH.test(value.manifestDigest||"") || digest(value.manifest)!==value.manifestDigest)fail("state_invalid");
    for(let index=0;index<value.manifest.length;index++){
      const part=value.manifest[index],saved=value.parts[String(index+1)];
      if(!saved || part.partNumber!==index+1 || part.sizeBytes!==saved.sizeBytes || part.sha256!==saved.sha256 || part.generation!==saved.generation ||
         Object.keys(part).sort().join()!==["generation","partNumber","sha256","sizeBytes"].sort().join())fail("state_invalid");
    }
  }
  if(value.phase==="sealed" && !GENERATION.test(value.generation||""))fail("state_invalid");
  if(value.phase==="aborted" && (value.cleanupVerified!==true || Object.values(value.parts).some(part=>!part.cancelGeneration)))fail("state_invalid");
  return row;
}
function createGcsPrivateUploadProvider({ store, transport, inspector, accessPolicy, enabled = false, clock = Date.now } = {}) {
  const available = enabled === true && store?.capabilities?.persistence === "durable" && typeof store.update === "function" &&
    require("./gcs-sdk-transport").isGcsSdkTransport(transport) && isImportAccessPolicy(accessPolicy) &&
    inspector?.capabilities?.bounded===true && inspector?.capabilities?.remoteObjectInspection===true &&
    (inspector?.capabilities?.isolated===true || require("./inspection-dispatcher").isLocalDiskInspectionDispatcher(inspector)) &&
    typeof inspector?.startInspection === "function" && typeof inspector?.getInspection === "function";
  function owner(context) { if (!available) fail(); return accessPolicy.resolve(context); }
  async function safe(action) { try { if (!available) fail(); return await action(); } catch(error) {
    if (error instanceof CalendarImportUploadError) throw error;
    fail();
  } }
  async function mutate(args, operation) {
    const identity = owner(args.context);
    return store.update(identity.companyId, state => {
      const matches = Object.values(state.uploads || {}).filter(row => row.objectKey === args.objectKey && row.userId === identity.userId);
      if (matches.length !== 1) fail("not_found",404);
      const row = validateGcsUploadRecord(matches[0]);
      if (row.companyId !== identity.companyId || row.storageProvider !== "gcs" || args.uploadId && row.gcs?.uploadId !== args.uploadId) fail("not_found",404);
      return operation(row);
    });
  }
  const read = args => mutate(args, clone);
  const key = (row, part) => `${row.objectKey}/${part === undefined ? "source" : `parts/${String(part).padStart(2,"0")}`}`;
  function currentGrant(row, args) {
    const grant = row.gcs?.parts?.[String(args.partNumber)];
    if (row.state !== "uploading" || row.gcs?.phase !== "open" || !grant || grant.authorizationId !== args.authorizationId || grant.expiresAt <= clock()) fail("authorization_invalid",404);
    return grant;
  }
  function metadata(row) { return { companyId:row.companyId,userId:row.userId,assetId:row.assetId,uploadId:row.uploadId,
    sha256:row.sha256,objectVersion:row.gcs.objectVersion,manifestDigest:row.gcs.manifestDigest }; }
  function matchSource(row, remote) {
    if (!remote?.exists || remote.sizeBytes !== row.sizeBytes || !GENERATION.test(remote.generation || "") ||
        Object.entries(metadata(row)).some(([name,value]) => remote.metadata?.[name] !== value)) fail("object_conflict",422);
  }
  async function parts(args, row) {
    if (["composing","sealed"].includes(row.gcs.phase)) return clone(row.gcs.manifest);
    if (!["uploading","verifying"].includes(row.state) || row.gcs.phase !== "open") fail("state_conflict",409);
    const observed=[];
    for (const part of Object.values(row.gcs.parts).sort((a,b)=>a.partNumber-b.partNumber)) {
      owner(args.context);
      const remote = await transport.headObject({ objectKey:key(row,part.partNumber), ...(part.generation ? {generation:part.generation}: {}) });
      if (!remote.exists) { if (part.generation) fail("part_missing",422); continue; }
      if (remote.sizeBytes !== part.sizeBytes || remote.md5Base64 !== part.md5Base64 || !GENERATION.test(remote.generation || "") ||
          part.generation && remote.generation !== part.generation) fail("part_conflict",422);
      observed.push({partNumber:part.partNumber,sizeBytes:part.sizeBytes,sha256:part.sha256,generation:remote.generation});
    }
    if(observed.some(part=>row.gcs.parts[String(part.partNumber)].generation!==part.generation))await mutate(args,current=>{
      if(!["uploading","verifying"].includes(current.state)||current.gcs.phase!=="open")fail("state_conflict",409);
      for(const part of observed){const latest=current.gcs.parts[String(part.partNumber)],previous=row.gcs.parts[String(part.partNumber)];
        if(!latest || latest.sha256!==part.sha256 || latest.md5Base64!==previous.md5Base64 || latest.sizeBytes!==part.sizeBytes ||
          latest.generation && latest.generation!==part.generation)fail("part_conflict",422);latest.generation=part.generation;}
    });
    return observed;
  }
  const provider = Object.freeze({
    capabilities:Object.freeze({testOnly:false,privateObjects:available,metadataOnly:true,actualInspection:available,
      idempotentMultipart:available,immutableFinalObjects:available}),
    getCapabilities(){return {provider:"google-cloud-storage",available};},
    async beginMultipart(args){return safe(async()=>{owner(args.context);await transport.verifyBucket();return mutate(args,row=>{
      if (!row.gcs) row.gcs={schema:1,phase:"open",uploadId:crypto.randomUUID(),objectVersion:crypto.randomUUID(),parts:{}};
      if (!["created","uploading"].includes(row.state) || row.gcs.phase !== "open") fail("state_conflict",409);
      return {uploadId:row.gcs.uploadId};
    });});},
    async authorizePart(args){return safe(()=>mutate(args,row=>{
      if (row.state !== "uploading" || row.gcs.phase !== "open" || !HASH.test(args.sha256 || "") || !md5(args.md5Base64) ||
          !Number.isSafeInteger(args.partNumber) || args.partNumber<1 || args.partNumber>Math.ceil(row.sizeBytes/row.chunkBytes) ||
          args.sizeBytes !== Math.min(row.chunkBytes,row.sizeBytes-(args.partNumber-1)*row.chunkBytes)) fail("part_invalid",400);
      const prior=row.gcs.parts[String(args.partNumber)];
      if (prior && (prior.sha256!==args.sha256 || prior.md5Base64!==args.md5Base64 || prior.sizeBytes!==args.sizeBytes)) fail("part_conflict",409);
      const part={partNumber:args.partNumber,sizeBytes:args.sizeBytes,sha256:args.sha256,md5Base64:args.md5Base64,
        authorizationId:crypto.randomUUID(),expiresAt:args.expiresAt,...(prior?.generation?{generation:prior.generation}:{})};
      row.gcs.parts[String(args.partNumber)]=part;
      return {authorizationId:part.authorizationId,expiresAt:part.expiresAt};
    }));},
    async resolveAuthorization(args){return safe(async()=>{
      const row=await read(args),grant=currentGrant(row,args);
      const signed=await transport.signPartWrite({objectKey:key(row,args.partNumber),sizeBytes:grant.sizeBytes,md5Base64:grant.md5Base64,expiresAt:grant.expiresAt,
        singleRequest:row.uploadMode === "single"});
      await mutate(args,current=>currentGrant(current,args));
      return {...signed,transport:"gcs-parts-v1"};
    });},
    async listParts(args){return safe(async()=> (await parts(args,await read(args))).map(({partNumber,sizeBytes,sha256})=>({partNumber,sizeBytes,sha256})));},
    async finalizeMultipart(args){return safe(async()=>{
      let row=await read(args);
      if (!["uploading","verifying"].includes(row.state)) fail("state_conflict",409);
      if (row.gcs.phase === "open") {
        // complete already checked every part. Persist the exact generations before compose.
        row=await mutate(args,current=>{
          const manifest=args.parts.map(part=>{
            const saved=current.gcs.parts[String(part.partNumber)];
            if (!saved?.generation || saved.sha256!==part.sha256 || saved.sizeBytes!==part.sizeBytes) fail("part_conflict",422);
            return {...part,generation:saved.generation};
          });
          if (manifest.length!==Math.ceil(current.sizeBytes/current.chunkBytes)) fail("part_missing",422);
          current.gcs.manifest=manifest;current.gcs.manifestDigest=digest(manifest);current.gcs.phase="composing";
          return clone(current);
        });
      }
      if (!["composing","sealed"].includes(row.gcs.phase) || !equal(row.gcs.manifest.map(({generation,...part})=>part),args.parts)) fail("manifest_conflict",422);
      let remote=await transport.headObject({objectKey:key(row),...(row.gcs.generation?{generation:row.gcs.generation}:{})});
      if (!remote.exists) {
        if (row.gcs.phase === "sealed") fail("object_missing",422);
        owner(args.context);
        await transport.composeObject({objectKey:key(row),sources:row.gcs.manifest.map(part=>({objectKey:key(row,part.partNumber),generation:part.generation})),
          contentType:row.mimeType,metadata:metadata(row)});
        remote=await transport.headObject({objectKey:key(row)});
      }
      matchSource(row,remote);
      return mutate(args,current=>{
        if (!equal(current.gcs.manifest,row.gcs.manifest) || !["composing","sealed"].includes(current.gcs.phase) ||
            current.gcs.generation && current.gcs.generation!==remote.generation) fail("object_conflict",422);
        current.gcs.generation=remote.generation;current.gcs.phase="sealed";
        return {objectVersion:current.gcs.objectVersion};
      });
    });},
    async inspectObject(args){return safe(async()=>{
      const row=await read(args);
      if (row.gcs.phase!=="sealed" || args.objectVersion!==row.gcs.objectVersion) fail("object_conflict",422);
      matchSource(row,await transport.headObject({objectKey:key(row),generation:row.gcs.generation}));
      if (row.gcs.inspectionResult) return clone(row.gcs.inspectionResult);
      const first=await mutate(args,current=>{if(current.gcs.inspectionRequested)return false;current.gcs.inspectionRequested=true;return true;});
      const request={context:args.context,ticketId:row.gcs.objectVersion,objectKey:row.objectKey,objectVersion:row.gcs.objectVersion,
        sizeBytes:row.sizeBytes,sha256:row.sha256,kind:row.kind,deadlineMs:180000};
      const result=first?await inspector.startInspection(request):await inspector.getInspection({context:args.context,ticketId:row.gcs.objectVersion});
      if(result?.ticketId!==row.gcs.objectVersion)fail("inspection_invalid",422);
      if (result?.state==="failed") fail("inspection_failed",422);
      if (result?.state!=="ready" || !result.result) throw new CalendarImportUploadError("import_verification_pending",503);
      const actual=result.result;
      if(actual.complete!==true || actual.sha256!==row.sha256 || actual.sizeBytes!==row.sizeBytes || actual.decoded!==true || actual.signatureVerified!==true)fail("inspection_invalid",422);
      const verified={complete:true,sizeBytes:actual.sizeBytes,sha256:actual.sha256,decoded:true,signatureVerified:true,
        detectedMime:actual.detectedMime,width:actual.width,height:actual.height,...(row.kind==="image"?{frames:actual.frames}:{durationMs:actual.durationMs,hasAudio:actual.hasAudio,colorMode:actual.colorMode})};
      await mutate(args,current=>{if(current.gcs.phase!=="sealed" || current.gcs.generation!==row.gcs.generation)fail("object_conflict",422);current.gcs.inspectionResult=verified;});
      return clone(verified);
    });},
    async streamSealedObject(args){return safe(async()=>{
      const row=await read(args);
      if (!["uploaded","verifying"].includes(row.state) || row.gcs.phase!=="sealed" || args.objectVersion!==row.gcs.objectVersion || typeof args.consume!=="function") fail("object_conflict",422);
      matchSource(row,await transport.headObject({objectKey:key(row),generation:row.gcs.generation}));
      const hash=crypto.createHash("sha256");let bytes=0;
      await transport.streamObject({objectKey:key(row),generation:row.gcs.generation,sizeBytes:row.sizeBytes,signal:args.signal,timeoutMs:args.timeoutMs,
        consume:async chunk=>{owner(args.context);if(chunk.length>65536 || bytes+chunk.length>row.sizeBytes)fail("object_conflict",422);bytes+=chunk.length;hash.update(chunk);await args.consume(chunk);}});
      if(bytes!==row.sizeBytes || hash.digest("hex")!==row.sha256)fail("object_conflict",422);
      await read(args);return {sizeBytes:bytes,sha256:row.sha256};
    });},
    async abortMultipart(args){return safe(async()=>{
      let row=await mutate(args,current=>{
        if(!current.gcs)return clone(current);
        if(!["created","uploading","cancel_pending","cancelled"].includes(current.state) || ["composing","sealed"].includes(current.gcs.phase))fail("state_conflict",409);
        current.gcs.phase="aborting";return clone(current);
      });
      if(!row.gcs)return {aborted:true,objectExists:false};
      // Keep each authorized name occupied by an immutable small tombstone.
      // A PUT that began before cancellation still cannot commit generation0.
      for(const part of Object.values(row.gcs.parts)){
        owner(args.context);
        const remote=await transport.headObject({objectKey:key(row,part.partNumber)});
        const tombstone=remote.exists && remote.sizeBytes===1 && remote.metadata?.cancelledUpload===row.uploadId;
        if(remote.exists && !tombstone && (remote.sizeBytes!==part.sizeBytes || remote.md5Base64!==part.md5Base64 ||
          part.generation && part.generation!==remote.generation))fail("part_conflict",422);
        const sealed=await transport.cancelPart({objectKey:key(row,part.partNumber),uploadId:row.uploadId,
          ...(remote.exists?{expectedGeneration:remote.generation}:{})});
        if(!sealed.exists || sealed.sizeBytes!==1 || sealed.metadata?.cancelledUpload!==row.uploadId || !GENERATION.test(sealed.generation||""))fail("cancellation_pending",503);
        await mutate(args,current=>{if(current.gcs.phase!=="aborting")fail("state_conflict",409);current.gcs.parts[String(part.partNumber)].cancelGeneration=sealed.generation;});
      }
      if((await transport.headObject({objectKey:key(row)})).exists)fail("object_conflict",422);
      await mutate(args,current=>{if(Object.values(current.gcs.parts).some(part=>!part.cancelGeneration))fail("cancellation_pending",503);
        current.gcs.phase="aborted";current.gcs.cleanupVerified=true;});
      return {aborted:true,objectExists:false};
    });}
  });
  if(available)instances.add(provider);return provider;
}
function isGcsPrivateUploadProvider(value){return instances.has(value);}
module.exports={createGcsPrivateUploadProvider,isGcsPrivateUploadProvider,validateGcsUploadRecord};
