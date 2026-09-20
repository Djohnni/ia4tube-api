"use strict";
// Operator-only SSH stdin tool. No HTTP route, database access, subprocess,
// feature flag mutation or worker launch. Never accepts a filesystem path.
const fs=require('node:fs/promises'), path=require('node:path'), crypto=require('node:crypto');
const {constants}=require('node:fs');
const {ROOT,loadProductionPilotFiles}=require('../../src/social/calendar/imports/production-pilot');
const {validateProductionPilotConfig}=require('../../src/social/calendar/imports/production-pilot-config');
const {validateCanonicalWav,displayName,loadPrivateMusicCatalog}=require('../../src/social/calendar/imports/music-catalog');
const MAX_PACKET=32*1024*1024, MAX_HEADER=64*1024, MAX_CONFIG=16384;
const HASH=/^[a-f0-9]{64}$/, TRACK=/^track_[a-f0-9]{24}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function refuse(code){throw Object.assign(new Error('Private pilot preparation refused.'),{code:'calendar_private_provision_'+code});}
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==keys.slice().sort().join())refuse('packet_invalid');}
function parseJson(bytes){try{return JSON.parse(bytes.toString('utf8'));}catch{refuse('packet_invalid');}}
function canonicalManifest(value){
  exact(value,['schema','tracks']);
  if(value.schema!==1||!Array.isArray(value.tracks)||value.tracks.length<1||value.tracks.length>10)refuse('catalog_invalid');
  const ids=new Set(),hashes=new Set();
  const tracks=value.tracks.map(row=>{
    exact(row,['id','displayName','fileName','sha256','sizeBytes','durationSeconds','sampleRate','channels','codec']);
    if(!TRACK.test(row.id)||ids.has(row.id)||!HASH.test(row.sha256)||hashes.has(row.sha256)||row.fileName!==row.id+'.wav'||
      displayName(row.displayName,null)===null||!Number.isSafeInteger(row.sizeBytes)||row.sizeBytes<2_880_000||row.sizeBytes>2_900_000||
      row.durationSeconds!==15||row.sampleRate!==48000||row.channels!==2||row.codec!=='pcm_s16le')refuse('catalog_invalid');
    ids.add(row.id);hashes.add(row.sha256);
    return {id:row.id,displayName:row.displayName,fileName:row.fileName,sha256:row.sha256,sizeBytes:row.sizeBytes,
      durationSeconds:15,sampleRate:48000,channels:2,codec:'pcm_s16le'};
  });
  return {schema:1,tracks};
}
// Wire format: four-byte unsigned BE header length, UTF-8 JSON header, then
// raw payload. Catalog payload concatenates the WAVs in manifest track order.
// The hash refers to canonicalManifest JSON bytes, not the inventory/ZIP.
function decodePacket(packet){
  if(!Buffer.isBuffer(packet)||packet.length<6||packet.length>MAX_PACKET)refuse('packet_limit');
  const length=packet.readUInt32BE(0);
  if(length<2||length>MAX_HEADER||4+length>packet.length)refuse('packet_invalid');
  const header=parseJson(packet.subarray(4,4+length)),payload=packet.subarray(4+length);
  if(header.operation==='catalog'){
    exact(header,['schema','operation','manifest','manifestSha256']);
    const manifest=canonicalManifest(header.manifest),manifestBytes=Buffer.from(JSON.stringify(manifest));
    if(header.schema!==1||!HASH.test(header.manifestSha256)||hash(manifestBytes)!==header.manifestSha256)refuse('catalog_hash');
    let offset=0;const files=[];
    for(const row of manifest.tracks){
      const bytes=payload.subarray(offset,offset+row.sizeBytes);offset+=row.sizeBytes;
      if(bytes.length!==row.sizeBytes||hash(bytes)!==row.sha256)refuse('audio_hash');
      validateCanonicalWav(bytes);files.push({name:row.fileName,bytes});
    }
    if(offset!==payload.length)refuse('packet_invalid');
    return {operation:'catalog',manifest,manifestBytes,files};
  }
  if(header.operation==='configuration'){
    exact(header,['schema','operation','sizeBytes','sha256']);
    if(header.schema!==1||!Number.isSafeInteger(header.sizeBytes)||header.sizeBytes<2||header.sizeBytes>MAX_CONFIG||
      payload.length!==header.sizeBytes||!HASH.test(header.sha256)||hash(payload)!==header.sha256)refuse('configuration_packet_invalid');
    return {operation:'configuration',bytes:payload,value:parseJson(payload)};
  }
  if(header.operation==='stop'){
    exact(header,['schema','operation','missionId','closureRequestId']);
    if(header.schema!==1||!UUID.test(header.missionId)||!UUID.test(header.closureRequestId)||payload.length!==0)refuse('stop_packet_invalid');
    return {operation:'stop',missionId:header.missionId,closureRequestId:header.closureRequestId};
  }
  if(header.operation==='retire'){
    exact(header,['schema','operation','missionId','retirementRequestId']);
    if(header.schema!==1||!UUID.test(header.missionId)||!UUID.test(header.retirementRequestId)||payload.length!==0)refuse('retire_packet_invalid');
    return {operation:'retire',missionId:header.missionId,retirementRequestId:header.retirementRequestId};
  }
  if(header.operation==='inspect'){
    exact(header,['schema','operation']);
    if(header.schema!==1||payload.length!==0)refuse('inspect_packet_invalid');
    return {operation:'inspect'};
  }
  refuse('operation_invalid');
}
async function readBoundedInput(input){
  let size=0;const chunks=[];
  try{
    for await(const chunk of input){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;
      if(size>MAX_PACKET){bytes.fill(0);refuse('packet_limit');}chunks.push(bytes);}
    return Buffer.concat(chunks,size);
  }finally{for(const chunk of chunks)chunk.fill(0);}
}
function privateMetadata(stat,uid,type){
  if(stat.isSymbolicLink()||stat.uid!==uid||(stat.mode&0o777)!==(type==='directory'?0o700:0o600)||
    (type==='directory'?!stat.isDirectory():!stat.isFile()||stat.nlink!==1))refuse('metadata_unsafe');
}
async function verifyLifecycleLockHeld(){
  const lock=path.join(ROOT,'control','lifecycle.lock'),fd='/proc/self/fd/9',uid=process.getuid?.();
  if(process.platform!=='linux'||!Number.isSafeInteger(uid)||uid<0)refuse('lifecycle_lock_unproved');
  let linked,fileStat,fdStat;
  try{linked=path.resolve(await fs.realpath(fd));fileStat=await fs.lstat(lock);fdStat=await fs.stat(fd);}
  catch{refuse('lifecycle_lock_unproved');}
  privateMetadata(fileStat,uid,'file');privateMetadata(fdStat,uid,'file');
  if(linked!==lock||fileStat.dev!==fdStat.dev||fileStat.ino!==fdStat.ino)refuse('lifecycle_lock_unproved');
}
// Test injection is a library seam only; CLI below uses the fixed production
// path and real Linux identity/fs. No path, uid or permission override in stdin,
// argv or environment can select a different destination or relax protection.
function createProvisioner({root=ROOT,privateBase='/var/data/private',fsApi=fs,identity=process,env=process.env,clock=Date.now}={}){
  if(identity.platform!=='linux'||typeof identity.getuid!=='function')refuse('linux_required');
  if(!path.isAbsolute(root)||path.resolve(root)!==root||!path.isAbsolute(privateBase)||path.resolve(privateBase)!==privateBase||
    privateBase===path.parse(privateBase).root||!root.startsWith(privateBase+path.sep))refuse('root_invalid');
  const uid=identity.getuid();if(!Number.isSafeInteger(uid)||uid<0)refuse('identity_invalid');
  let lifecycleBusy=false;
  const owned=directory=>directory===privateBase||directory.startsWith(privateBase+path.sep);
  async function directories(directory,create){
    const parsed=path.parse(directory),parts=directory.substring(parsed.root.length).split(path.sep).filter(Boolean);
    let current=parsed.root;
    for(const part of parts){current=path.join(current,part);let stat;
      try{stat=await fsApi.lstat(current);}catch(error){
        if(!create||error.code!=='ENOENT'||!owned(current))throw error;
        try{await fsApi.mkdir(current,{mode:0o700});}catch(race){if(race.code!=='EEXIST')throw race;}
        stat=await fsApi.lstat(current);
      }
      if(!stat.isDirectory()||stat.isSymbolicLink()||path.resolve(await fsApi.realpath(current))!==current)refuse('directory_unsafe');
      if(owned(current))privateMetadata(stat,uid,'directory');
    }
  }
  async function readPrivate(file,maximum){
    await directories(path.dirname(file),false);
    const stat=await fsApi.lstat(file);privateMetadata(stat,uid,'file');
    if(stat.size<1||stat.size>maximum||path.resolve(await fsApi.realpath(file))!==file)refuse('file_unsafe');
    const handle=await fsApi.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try{
      const before=await handle.stat();privateMetadata(before,uid,'file');
      if(before.dev!==stat.dev||before.ino!==stat.ino||before.size!==stat.size)refuse('file_changed');
      const bytes=await handle.readFile(),after=await handle.stat();privateMetadata(after,uid,'file');
      if(bytes.length!==stat.size||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||
        before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)refuse('file_changed');
      return bytes;
    }finally{await handle.close();}
  }
  async function sameFile(file,bytes){
    let current;try{current=await readPrivate(file,bytes.length);}catch(error){if(error.code==='ENOENT')return false;throw error;}
    try{if(!current.equals(bytes))refuse('existing_divergent');return true;}finally{current.fill(0);}
  }
  async function syncDirectory(directory){const handle=await fsApi.open(directory,constants.O_RDONLY|(constants.O_DIRECTORY||0)|(constants.O_NOFOLLOW||0));
    try{const stat=await handle.stat();privateMetadata(stat,uid,'directory');await handle.sync();}finally{await handle.close();}}
  async function publishExclusive(file,bytes){
    if(await sameFile(file,bytes))return 'identical';
    const parent=path.dirname(file);await directories(parent,false);
    const temporary=path.join(parent,'.'+path.basename(file)+'.'+crypto.randomBytes(16).toString('hex')+'.pending');
    let handle,temporaryIdentity,installed=false;
    try{
      handle=await fsApi.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW||0),0o600);
      temporaryIdentity=await handle.stat();privateMetadata(temporaryIdentity,uid,'file');
      await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
      // link is create-if-absent: unlike rename it can never replace a file.
      try{await fsApi.link(temporary,file);installed=true;}
      catch(error){if(error.code!=='EEXIST')throw error;if(!await sameFile(file,bytes))refuse('publication_uncertain');}
    }finally{
      await handle?.close();
      if(temporaryIdentity){const current=await fsApi.lstat(temporary);
        if(current.dev!==temporaryIdentity.dev||current.ino!==temporaryIdentity.ino||!current.isFile()||current.isSymbolicLink())refuse('temporary_changed');
        await fsApi.unlink(temporary);}
    }
    await syncDirectory(parent);
    if(!await sameFile(file,bytes))refuse('publication_uncertain');
    return installed?'installed':'identical';
  }
  async function withControlLock(operation){
    // The production CLI is already serialized by the kernel-held, persistent
    // lifecycle.lock. This guard also keeps concurrent library-seam tests and
    // accidental in-process callers fail-closed.
    if(lifecycleBusy)refuse('control_busy');lifecycleBusy=true;
    try{return await operation();}finally{lifecycleBusy=false;}
  }
  function validateStoredConfiguration(bytes){
    // Stored configuration remains structurally validated even when reporting
    // an unexpected live gate. The current gate state is observed separately.
    return validateProductionPilotConfig(parseJson(bytes),{env:{...env,
      SOCIAL_EXTERNAL_CONNECTION_ENABLED:'false',SOCIAL_EXTERNAL_PUBLICATION_ENABLED:'false',META_APP_REVIEW_WINDOW_ENABLED:'false'},now:clock()});
  }
  async function initializeLifecycleLock(){
    if(env.ENVIRONMENT!=='production'||env.RENDER_SERVICE_ID!=='srv-d8708kd7vvec73ap1p6g'||
      env.PUBLIC_API_BASE_URL!=='https://ia4tube-api.onrender.com')refuse('lifecycle_lock_target_invalid');
    const control=path.join(root,'control'),file=path.join(control,'lifecycle.lock');await directories(control,false);
    let handle,installed=false;
    try{
      try{handle=await fsApi.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW||0),0o600);installed=true;}
      catch(error){if(error.code!=='EEXIST')throw error;}
      if(handle){const stat=await handle.stat();privateMetadata(stat,uid,'file');await handle.sync();await handle.close();handle=null;}
      const stat=await fsApi.lstat(file);privateMetadata(stat,uid,'file');
      if(path.resolve(await fsApi.realpath(file))!==file)refuse('lifecycle_lock_unproved');
      await syncDirectory(control);
      return {ok:true,operation:'initialize-lock',lock:installed?'installed':'identical'};
    }finally{await handle?.close();}
  }
  async function checkKnownMusic(manifest,manifestBytes){
    const music=path.join(root,'music'),expected=new Set(['catalog.json',...manifest.tracks.map(row=>row.fileName)]);
    for(const name of await fsApi.readdir(music)){if(!expected.has(name))refuse('unexpected_music_file');}
    const catalogPresent=await sameFile(path.join(music,'catalog.json'),manifestBytes);
    return {music,catalogPresent};
  }
  async function provisionCatalog(decoded){
    for(const name of ['', 'control','uploads','prepared','music'])await directories(path.join(root,name),true);
    const {music,catalogPresent}=await checkKnownMusic(decoded.manifest,decoded.manifestBytes);
    // Preflight every existing target before any file is added. A partial
    // previous catalog can reconcile only when every surviving byte is exact.
    for(const file of decoded.files){const present=await sameFile(path.join(music,file.name),file.bytes);
      if(catalogPresent&&!present)refuse('committed_catalog_incomplete');}
    let installed=0;
    for(const file of decoded.files)if(await publishExclusive(path.join(music,file.name),file.bytes)==='installed')installed++;
    const catalog=await publishExclusive(path.join(music,'catalog.json'),decoded.manifestBytes);
    return {ok:true,operation:'catalog',trackCount:decoded.files.length,filesInstalled:installed,catalog,
      manifestSha256:hash(decoded.manifestBytes),audioBytes:decoded.files.reduce((n,file)=>n+file.bytes.length,0)};
  }
  async function provisionConfiguration(decoded){
    const config=validateProductionPilotConfig(decoded.value,{env,now:clock()});
    try{
      return await withControlLock(async()=>{
        if(clock()>=config.admitUntil)refuse('window_closed');
        for(const name of ['', 'control','uploads','prepared','music'])await directories(path.join(root,name),false);
        await requireNoRetirementPending();
        await requireUnstopped(config.missionId);
        const musicRoot=path.join(root,'music'),manifestBytes=await readPrivate(path.join(musicRoot,'catalog.json'),MAX_HEADER);
        const manifest=canonicalManifest(parseJson(manifestBytes));
        if(!manifestBytes.equals(Buffer.from(JSON.stringify(manifest))))refuse('catalog_not_canonical');
        await checkKnownMusic(manifest,manifestBytes);
        for(const row of manifest.tracks){const bytes=await readPrivate(path.join(musicRoot,row.fileName),row.sizeBytes);
          try{if(bytes.length!==row.sizeBytes||hash(bytes)!==row.sha256)refuse('audio_hash');validateCanonicalWav(bytes);}finally{bytes.fill(0);}}
        await loadPrivateMusicCatalog({rootDirectory:musicRoot,manifest,rights:config.musicRights,
          ownerCompanyId:config.owner.companyId,clock,now:clock()});
        if(clock()>=config.admitUntil)refuse('window_closed');
        await requireNoRetirementPending();
        const configuration=await publishExclusive(path.join(root,'control','pilot.json'),decoded.bytes);
        await requireUnstopped(config.missionId);
        return {ok:true,operation:'configuration',configuration,missionId:config.missionId,trackCount:manifest.tracks.length,
          admitUntil:config.admitUntil,finishBy:config.finishBy};
      });
    }finally{config.bridgeKey.fill(0);}
  }
  async function requireUnstopped(missionId){
    try{await fsApi.lstat(path.join(root,'control','stop-'+missionId+'.json'));}
    catch(error){if(error.code==='ENOENT')return;throw error;}
    refuse('mission_stopped');
  }
  async function requireNoRetirementPending(){
    try{await fsApi.lstat(path.join(root,'control','retirement-pending.json'));}
    catch(error){if(error.code==='ENOENT')return;throw error;}
    refuse('retirement_pending');
  }
  async function provisionStop(decoded){
    if(env.ENVIRONMENT!=='production'||env.RENDER_SERVICE_ID!=='srv-d8708kd7vvec73ap1p6g'||
      env.PUBLIC_API_BASE_URL!=='https://ia4tube-api.onrender.com')refuse('stop_target_invalid');
    await directories(path.join(root,'control'),false);
    let configBytes;
    try{configBytes=await readPrivate(path.join(root,'control','pilot.json'),MAX_CONFIG);}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(configBytes){let existingConfig;try{
      existingConfig=validateStoredConfiguration(configBytes);
      if(existingConfig.missionId!==decoded.missionId){
        if(clock()<existingConfig.finishBy)refuse('stop_mission_mismatch');
        let priorBytes;try{
          priorBytes=await readPrivate(path.join(root,'control','stop-'+existingConfig.missionId+'.json'),MAX_HEADER);
          const prior=parseJson(priorBytes);exact(prior,['schema','missionId','closureRequestId','admissionClosed','launchClosed']);
          if(prior.schema!==1||prior.missionId!==existingConfig.missionId||!UUID.test(prior.closureRequestId)||
            prior.admissionClosed!==true||prior.launchClosed!==true)refuse('stop_mission_mismatch');
        }catch(error){if(error.code==='ENOENT')refuse('stop_mission_mismatch');throw error;}
        finally{priorBytes?.fill(0);}
      }
    }finally{existingConfig?.bridgeKey?.fill(0);configBytes.fill(0);}}
    const marker={schema:1,missionId:decoded.missionId,closureRequestId:decoded.closureRequestId,admissionClosed:true,launchClosed:true};
    const bytes=Buffer.from(JSON.stringify(marker)),file=path.join(root,'control','stop-'+decoded.missionId+'.json');
    const sentinel=await publishExclusive(file,bytes);
    // Closing local admission is still safe if an unexpected external flag was
    // changed; report that fact instead of inventing a "gates closed" receipt.
    const state=name=>env[name]==='false'?false:env[name]==='true'?true:null;
    return {ok:true,operation:'stop',...marker,sentinel,sentinelSha256:hash(bytes),
      connectionEnabled:state('SOCIAL_EXTERNAL_CONNECTION_ENABLED'),publicationEnabled:state('SOCIAL_EXTERNAL_PUBLICATION_ENABLED'),
      metaWindowEnabled:state('META_APP_REVIEW_WINDOW_ENABLED')};
  }
  async function provisionRetirement(decoded){
    const imports=env.SOCIAL_MEDIA_IMPORTS_ENABLED==='true'?true:
      env.SOCIAL_MEDIA_IMPORTS_ENABLED===undefined||env.SOCIAL_MEDIA_IMPORTS_ENABLED===''||env.SOCIAL_MEDIA_IMPORTS_ENABLED==='false'?false:null;
    if(env.ENVIRONMENT!=='production'||env.RENDER_SERVICE_ID!=='srv-d8708kd7vvec73ap1p6g'||
      env.PUBLIC_API_BASE_URL!=='https://ia4tube-api.onrender.com'||env.SOCIAL_EXTERNAL_CONNECTION_ENABLED!=='false'||
      env.SOCIAL_EXTERNAL_PUBLICATION_ENABLED!=='false'||env.META_APP_REVIEW_WINDOW_ENABLED!=='false'||
      imports!==false)refuse('retire_target_invalid');
    const control=path.join(root,'control'),archiveRoot=path.join(control,'archive'),archive=path.join(archiveRoot,decoded.missionId);
    await directories(control,false);
    const activeConfig=path.join(control,'pilot.json'),activeStop=path.join(control,'stop-'+decoded.missionId+'.json');
    const pendingFile=path.join(control,'retirement-pending.json'),configurationEvidenceFile=path.join(archive,'configuration-evidence.json'),stopEvidenceFile=path.join(archive,'stop-evidence.json'),
      preparedFile=path.join(archive,'retirement-prepared.json'),completeFile=path.join(archive,'retirement.json');
    async function optional(file,maximum){try{return await readPrivate(file,maximum);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
    function retirementMarker(bytes,status){
      const value=parseJson(bytes);exact(value,['schema','status','missionId','retirementRequestId','finishBy','configurationSha256','stopSha256']);
      if(value.schema!==1||value.status!==status||value.missionId!==decoded.missionId||
        value.retirementRequestId!==decoded.retirementRequestId||!Number.isSafeInteger(value.finishBy)||value.finishBy<0||
        !HASH.test(value.configurationSha256)||!HASH.test(value.stopSha256))refuse('retire_evidence_invalid');
      return value;
    }
    function retirementReceipt(marker,configurationEvidence,stopEvidence,retirement){return {ok:true,operation:'retire',
      missionId:decoded.missionId,retirementRequestId:decoded.retirementRequestId,configurationEvidence,stopEvidence,retirement,
      configurationSha256:marker.configurationSha256,stopSha256:marker.stopSha256,activeConfigurationRemoved:true,activeStopRemoved:true,
      secretMaterialArchived:false,connectionEnabled:false,publicationEnabled:false,metaWindowEnabled:false,importsEnabled:false};}
    return withControlLock(async()=>{
      await directories(archive,true);
      let completeBytes=await optional(completeFile,MAX_HEADER);
      if(completeBytes){try{
        const complete=retirementMarker(completeBytes,'complete');
        const active=await optional(activeConfig,MAX_CONFIG);
        try{if(active&&hash(active)===complete.configurationSha256)refuse('retire_completion_inconsistent');}
        finally{active?.fill(0);}
        const prepared={...complete,status:'prepared'},pendingBytes=Buffer.from(JSON.stringify(prepared));
        try{
          const pending=await optional(pendingFile,MAX_HEADER);
          if(pending){try{if(!pending.equals(pendingBytes))refuse('retire_evidence_invalid');}finally{pending.fill(0);}
            await fsApi.unlink(pendingFile);await syncDirectory(control);}
        }finally{pendingBytes.fill(0);}
        return retirementReceipt(complete,'identical','identical','identical');
      }finally{completeBytes.fill(0);}}
      let preparedBytes=await optional(preparedFile,MAX_HEADER),configBytes=null,stopBytes=null,config;
      try{
        let prepared,configurationEvidence='identical',stopEvidence='identical';
        if(preparedBytes){prepared=retirementMarker(preparedBytes,'prepared');}
        else{
          configBytes=await readPrivate(activeConfig,MAX_CONFIG);config=validateStoredConfiguration(configBytes);
          if(config.missionId!==decoded.missionId||clock()<config.finishBy)refuse('retire_not_closed');
          stopBytes=await readPrivate(activeStop,MAX_HEADER);const stop=parseJson(stopBytes);
          exact(stop,['schema','missionId','closureRequestId','admissionClosed','launchClosed']);
          if(stop.schema!==1||stop.missionId!==decoded.missionId||!UUID.test(stop.closureRequestId)||
            stop.admissionClosed!==true||stop.launchClosed!==true)refuse('retire_stop_invalid');
          prepared={schema:1,status:'prepared',missionId:decoded.missionId,retirementRequestId:decoded.retirementRequestId,
            finishBy:config.finishBy,configurationSha256:hash(configBytes),stopSha256:hash(stopBytes)};
          const configEvidenceBytes=Buffer.from(JSON.stringify({schema:1,missionId:decoded.missionId,finishBy:config.finishBy,
            configurationSha256:prepared.configurationSha256}));
          const stopEvidenceBytes=Buffer.from(JSON.stringify({schema:1,missionId:decoded.missionId,stopSha256:prepared.stopSha256}));
          const nextPreparedBytes=Buffer.from(JSON.stringify(prepared));
          try{
            configurationEvidence=await publishExclusive(configurationEvidenceFile,configEvidenceBytes);
            stopEvidence=await publishExclusive(stopEvidenceFile,stopEvidenceBytes);
            await publishExclusive(preparedFile,nextPreparedBytes);
          }finally{configEvidenceBytes.fill(0);stopEvidenceBytes.fill(0);nextPreparedBytes.fill(0);}
          await syncDirectory(archive);await syncDirectory(archiveRoot);await syncDirectory(control);
        }
        const evidenceConfig=await readPrivate(configurationEvidenceFile,MAX_HEADER),evidenceStop=await readPrivate(stopEvidenceFile,MAX_HEADER);
        try{
          const ce=parseJson(evidenceConfig),se=parseJson(evidenceStop);
          exact(ce,['schema','missionId','finishBy','configurationSha256']);exact(se,['schema','missionId','stopSha256']);
          if(ce.schema!==1||ce.missionId!==decoded.missionId||ce.finishBy!==prepared.finishBy||ce.configurationSha256!==prepared.configurationSha256||
            se.schema!==1||se.missionId!==decoded.missionId||se.stopSha256!==prepared.stopSha256)refuse('retire_evidence_invalid');
        }finally{evidenceConfig.fill(0);evidenceStop.fill(0);}
        const pendingBytes=Buffer.from(JSON.stringify(prepared));
        try{await publishExclusive(pendingFile,pendingBytes);await syncDirectory(control);}finally{pendingBytes.fill(0);}
        async function removeMatching(file,expected,allowNewMission=false){
          const bytes=await optional(file,MAX_CONFIG);if(!bytes)return;
          let currentConfig;
          try{
            if(hash(bytes)!==expected){
              if(!allowNewMission)refuse('retire_source_changed');
              currentConfig=validateStoredConfiguration(bytes);
              if(currentConfig.missionId===decoded.missionId)refuse('retire_source_changed');
              return;
            }
            const stat=await fsApi.lstat(file);privateMetadata(stat,uid,'file');await fsApi.unlink(file);
          }
          finally{currentConfig?.bridgeKey?.fill(0);bytes.fill(0);}
        }
        // The mission-specific marker is removed first; the singleton barrier
        // remains until every durable, secret-free evidence file is in place.
        await removeMatching(activeStop,prepared.stopSha256);await removeMatching(activeConfig,prepared.configurationSha256,true);
        await syncDirectory(control);
        const complete={...prepared,status:'complete'},nextCompleteBytes=Buffer.from(JSON.stringify(complete));
        let retirement;try{retirement=await publishExclusive(completeFile,nextCompleteBytes);}finally{nextCompleteBytes.fill(0);}
        await syncDirectory(archive);await syncDirectory(archiveRoot);await syncDirectory(control);
        const pending=await readPrivate(pendingFile,MAX_HEADER),expectedPending=Buffer.from(JSON.stringify(prepared));
        try{if(!pending.equals(expectedPending))refuse('retire_evidence_invalid');await fsApi.unlink(pendingFile);}
        finally{pending.fill(0);expectedPending.fill(0);}
        await syncDirectory(control);
        return retirementReceipt(complete,configurationEvidence,stopEvidence,retirement);
      }finally{config?.bridgeKey?.fill(0);preparedBytes?.fill(0);configBytes?.fill(0);stopBytes?.fill(0);}
    });
  }
  async function inspectControl(){
    if(env.ENVIRONMENT!=='production'||env.RENDER_SERVICE_ID!=='srv-d8708kd7vvec73ap1p6g'||
      env.PUBLIC_API_BASE_URL!=='https://ia4tube-api.onrender.com')refuse('inspect_target_invalid');
    const state=name=>env[name]==='false'?false:env[name]==='true'?true:null;
    const imports=env.SOCIAL_MEDIA_IMPORTS_ENABLED==='true'?true:
      env.SOCIAL_MEDIA_IMPORTS_ENABLED===undefined||env.SOCIAL_MEDIA_IMPORTS_ENABLED===''||env.SOCIAL_MEDIA_IMPORTS_ENABLED==='false'?false:null;
    const control=path.join(root,'control'),file=path.join(control,'pilot.json'),pendingFile=path.join(control,'retirement-pending.json');await directories(control,false);
    let bytes,stopBytes,pendingBytes,config,pendingMissionId=null,pendingRetirementRequestId=null,pendingSha256=null;
    try{
      pendingBytes=await readPrivate(pendingFile,MAX_HEADER);const pending=parseJson(pendingBytes);
      exact(pending,['schema','status','missionId','retirementRequestId','finishBy','configurationSha256','stopSha256']);
      if(pending.schema!==1||pending.status!=='prepared'||!UUID.test(pending.missionId)||!UUID.test(pending.retirementRequestId)||
        !Number.isSafeInteger(pending.finishBy)||!HASH.test(pending.configurationSha256)||!HASH.test(pending.stopSha256))refuse('inspect_pending_invalid');
      pendingMissionId=pending.missionId;pendingRetirementRequestId=pending.retirementRequestId;pendingSha256=hash(pendingBytes);
    }catch(error){if(error.code!=='ENOENT')throw error;}
    const pendingPresent=pendingBytes!==undefined;
    try{bytes=await readPrivate(file,MAX_CONFIG);}
    catch(error){if(error.code!=='ENOENT')throw error;const receipt={ok:true,operation:'inspect',activeConfigurationPresent:false,
      missionId:null,finishBy:null,windowExpired:false,stopPresent:false,retirementReady:false,configurationSha256:null,stopSha256:null,
      retirementPending:pendingPresent,pendingMissionId,pendingRetirementRequestId,pendingSha256,
      connectionEnabled:state('SOCIAL_EXTERNAL_CONNECTION_ENABLED'),publicationEnabled:state('SOCIAL_EXTERNAL_PUBLICATION_ENABLED'),
      metaWindowEnabled:state('META_APP_REVIEW_WINDOW_ENABLED'),importsEnabled:imports};pendingBytes?.fill(0);return receipt;}
    try{
      config=validateStoredConfiguration(bytes);
      let stopPresent=false,stopSha256=null;
      try{
        stopBytes=await readPrivate(path.join(control,'stop-'+config.missionId+'.json'),MAX_HEADER);
        const stop=parseJson(stopBytes);exact(stop,['schema','missionId','closureRequestId','admissionClosed','launchClosed']);
        stopPresent=stop.schema===1&&stop.missionId===config.missionId&&UUID.test(stop.closureRequestId)&&
          stop.admissionClosed===true&&stop.launchClosed===true;
        if(!stopPresent)refuse('inspect_stop_invalid');stopSha256=hash(stopBytes);
      }catch(error){if(error.code!=='ENOENT')throw error;}
      const connectionEnabled=state('SOCIAL_EXTERNAL_CONNECTION_ENABLED'),publicationEnabled=state('SOCIAL_EXTERNAL_PUBLICATION_ENABLED'),
        metaWindowEnabled=state('META_APP_REVIEW_WINDOW_ENABLED'),windowExpired=clock()>=config.finishBy;
      return {ok:true,operation:'inspect',activeConfigurationPresent:true,missionId:config.missionId,finishBy:config.finishBy,
        windowExpired,stopPresent,retirementReady:!pendingPresent&&windowExpired&&stopPresent&&connectionEnabled===false&&publicationEnabled===false&&
          metaWindowEnabled===false&&imports===false,configurationSha256:hash(bytes),stopSha256,retirementPending:pendingPresent,
        pendingMissionId,pendingRetirementRequestId,pendingSha256,
        connectionEnabled,publicationEnabled,metaWindowEnabled,importsEnabled:imports};
    }finally{config?.bridgeKey?.fill(0);bytes?.fill(0);stopBytes?.fill(0);pendingBytes?.fill(0);}
  }
  return Object.freeze({initializeLifecycleLock,async provision(packet){const decoded=decodePacket(packet);
    if(decoded.operation==='catalog')return provisionCatalog(decoded);
    if(decoded.operation==='stop')return provisionStop(decoded);
    if(decoded.operation==='retire')return provisionRetirement(decoded);
    if(decoded.operation==='inspect')return inspectControl();
    return provisionConfiguration(decoded);}});
}
async function main(args=process.argv.slice(2),{input=process.stdin,output=process.stdout,env=process.env}={}){
  let packet;
  try{
    if(args.length!==1||!['provision','preflight','initialize-lock'].includes(args[0]))refuse('arguments_invalid');
    let result;
    if(args[0]==='initialize-lock'){result=await createProvisioner({env}).initializeLifecycleLock();}
    else if(args[0]==='preflight'){
      const loaded=await loadProductionPilotFiles({env});
      try{result={ok:true,operation:'preflight',missionId:loaded.config.missionId,trackCount:loaded.music.catalog.size,
        admissionWindowOpen:Date.now()<loaded.config.admitUntil&&loaded.admissionFence(),admitUntil:loaded.config.admitUntil,finishBy:loaded.config.finishBy,
        poolsOpened:0,workersStarted:0,filesChanged:0};}finally{loaded.config.bridgeKey.fill(0);}
    }else{await verifyLifecycleLockHeld();packet=await readBoundedInput(input);result=await createProvisioner({env}).provision(packet);}
    output.write(JSON.stringify(result)+'\n');return 0;
  }catch(error){
    const code=/^(calendar_private_provision_|calendar_media_pilot_|calendar_music_catalog_)[a-z_]+$/.test(error.code||'')?
      error.code:'calendar_private_provision_failed';
    output.write(JSON.stringify({ok:false,code,reconcileBeforeRetry:true})+'\n');return 1;
  }finally{packet?.fill(0);}
}
if(require.main===module)main().then(code=>{process.exitCode=code;});
module.exports={MAX_PACKET,MAX_HEADER,MAX_CONFIG,canonicalManifest,decodePacket,readBoundedInput,privateMetadata,
  verifyLifecycleLockHeld,createProvisioner,main};
