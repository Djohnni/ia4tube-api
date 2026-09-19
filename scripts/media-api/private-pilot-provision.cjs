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
// Test injection is a library seam only; CLI below uses the fixed production
// path and real Linux identity/fs. No path, uid or permission override in stdin,
// argv or environment can select a different destination or relax protection.
function createProvisioner({root=ROOT,privateBase='/var/data/private',fsApi=fs,identity=process,env=process.env,clock=Date.now}={}){
  if(identity.platform!=='linux'||typeof identity.getuid!=='function')refuse('linux_required');
  if(!path.isAbsolute(root)||path.resolve(root)!==root||!path.isAbsolute(privateBase)||path.resolve(privateBase)!==privateBase||
    privateBase===path.parse(privateBase).root||!root.startsWith(privateBase+path.sep))refuse('root_invalid');
  const uid=identity.getuid();if(!Number.isSafeInteger(uid)||uid<0)refuse('identity_invalid');
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
      if(clock()>=config.admitUntil)refuse('window_closed');
      for(const name of ['', 'control','uploads','prepared','music'])await directories(path.join(root,name),false);
      const musicRoot=path.join(root,'music'),manifestBytes=await readPrivate(path.join(musicRoot,'catalog.json'),MAX_HEADER);
      const manifest=canonicalManifest(parseJson(manifestBytes));
      if(!manifestBytes.equals(Buffer.from(JSON.stringify(manifest))))refuse('catalog_not_canonical');
      await checkKnownMusic(manifest,manifestBytes);
      for(const row of manifest.tracks){const bytes=await readPrivate(path.join(musicRoot,row.fileName),row.sizeBytes);
        try{if(bytes.length!==row.sizeBytes||hash(bytes)!==row.sha256)refuse('audio_hash');validateCanonicalWav(bytes);}finally{bytes.fill(0);}}
      await loadPrivateMusicCatalog({rootDirectory:musicRoot,manifest,rights:config.musicRights,
        ownerCompanyId:config.owner.companyId,clock,now:clock()});
      if(clock()>=config.admitUntil)refuse('window_closed');
      const configuration=await publishExclusive(path.join(root,'control','pilot.json'),decoded.bytes);
      return {ok:true,operation:'configuration',configuration,missionId:config.missionId,trackCount:manifest.tracks.length,
        admitUntil:config.admitUntil,finishBy:config.finishBy};
    }finally{config.bridgeKey.fill(0);}
  }
  return Object.freeze({async provision(packet){const decoded=decodePacket(packet);
    return decoded.operation==='catalog'?provisionCatalog(decoded):provisionConfiguration(decoded);}});
}
async function main(args=process.argv.slice(2),{input=process.stdin,output=process.stdout,env=process.env}={}){
  let packet;
  try{
    if(args.length!==1||!['provision','preflight'].includes(args[0]))refuse('arguments_invalid');
    let result;
    if(args[0]==='preflight'){
      const loaded=await loadProductionPilotFiles({env});
      try{result={ok:true,operation:'preflight',missionId:loaded.config.missionId,trackCount:loaded.music.catalog.size,
        admissionWindowOpen:Date.now()<loaded.config.admitUntil,admitUntil:loaded.config.admitUntil,finishBy:loaded.config.finishBy,
        poolsOpened:0,workersStarted:0,filesChanged:0};}finally{loaded.config.bridgeKey.fill(0);}
    }else{packet=await readBoundedInput(input);result=await createProvisioner({env}).provision(packet);}
    output.write(JSON.stringify(result)+'\n');return 0;
  }catch(error){
    const code=/^(calendar_private_provision_|calendar_media_pilot_|calendar_music_catalog_)[a-z_]+$/.test(error.code||'')?
      error.code:'calendar_private_provision_failed';
    output.write(JSON.stringify({ok:false,code,reconcileBeforeRetry:true})+'\n');return 1;
  }finally{packet?.fill(0);}
}
if(require.main===module)main().then(code=>{process.exitCode=code;});
module.exports={MAX_PACKET,MAX_HEADER,MAX_CONFIG,canonicalManifest,decodePacket,readBoundedInput,privateMetadata,createProvisioner,main};
