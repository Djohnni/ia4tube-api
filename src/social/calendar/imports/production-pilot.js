"use strict";
const fs=require('node:fs/promises'),syncFs=require('node:fs'),path=require('node:path');
const {validateProductionPilotConfig,fail}=require('./production-pilot-config');
const {loadPrivateMusicCatalog,protectedBytes}=require('./music-catalog');
const {createPostgresPool}=require('../../../persistence/postgres/pool');
const {createImportUploadPostgresStore}=require('./postgres-store');
const {createPostgresGlobalCapacityStore}=require('./postgres-global-capacity-store');
const {createPostgresTransferRegistryStore}=require('./postgres-transfer-registry-store');
const {createGlobalMediaCapacity}=require('./global-capacity');
const {createDiskSpaceGuard}=require('./disk-space-guard');
const {createRenderDiskAdmission}=require('./render-disk-admission');
const {createPreparedDiskAdmission}=require('./prepared-disk-admission');
const {createImportAccessPolicy}=require('./access-policy');
const {createWorkflowOperationalComponents}=require('./workflow-operational-components');
const {createTransferAuthorizationRegistry}=require('./transfer-registry');
const {createRenderDiskTransferService}=require('./transfer-service');
const {createOperationalCalendarImportsRuntimeFactory}=require('./operational-runtime');
const ROOT='/var/data/private/calendar-media', CONFIG=ROOT+'/control/pilot.json';
const PRIVATE_PREFIX='/internal/calendar-media/';
function createPilotAdmissionFence(missionId){
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(missionId))fail('mission_invalid');
  const marker=ROOT+'/control/stop-'+missionId+'.json';let tripped=false;
  return ()=>{
    if(tripped)return false;
    try{
      for(const directory of ['/var','/var/data','/var/data/private',ROOT,ROOT+'/control']){
        const st=syncFs.lstatSync(directory);
        if(!st.isDirectory()||st.isSymbolicLink()||directory.startsWith('/var/data/private')&&
          ((st.mode&0o077)!==0||st.uid!==process.getuid())){tripped=true;return false;}
      }
      // Presence closes even if the marker is malformed or substituted. Never
      // follow it or interpret invalid metadata as permission to keep working.
      try{syncFs.lstatSync(marker);tripped=true;}catch(error){if(error.code!=='ENOENT')tripped=true;}
    }catch{tripped=true;}
    return !tripped;
  };
}
// A bounded timer observes the same durable intentions, never spawns a codec.
function createPilotProgressLoop({tick,finishBy,clock=Date.now,report=()=>{},timers={setTimeout,clearTimeout}}){
  if(typeof tick!=='function'||!Number.isSafeInteger(finishBy))fail('loop_invalid');
  let timer=null,active=null,stopped=false,started=false;
  async function run(){
    if(stopped||clock()>=finishBy){stopped=true;return;}
    try{active=Promise.resolve().then(tick);await active;}
    catch{try{report('calendar_media_progress_attention');}catch{ /* Diagnostics never reopen or break the drain. */ }}
    finally{active=null;if(!stopped&&clock()<finishBy){timer=timers.setTimeout(run,5000);timer.unref?.();}else{stopped=true;}}
  }
  return Object.freeze({start(){if(!started&&!stopped){started=true;timer=timers.setTimeout(run,0);timer.unref?.();}},
    async close(){stopped=true;timers.clearTimeout(timer);if(active)await active.catch(()=>{});},isStopped:()=>stopped});
}
async function privateDirectory(directory,{create=true}={}){
  // Never chmod an existing location or follow a symlink to make it acceptable.
  const parts=directory.split('/').filter(Boolean);let current='';
  for(const part of parts){current+='/'+part;let st;
    try{st=await fs.lstat(current);}catch(error){if(!create||error.code!=='ENOENT'||!(current==='/var/data/private'||current.startsWith('/var/data/private/')))throw error;
      await fs.mkdir(current,{mode:0o700});st=await fs.lstat(current);}
    if(!st.isDirectory()||st.isSymbolicLink()||path.resolve(await fs.realpath(current))!==current)fail('directory_unsafe');
    if(current.startsWith('/var/data/private')&&((st.mode&0o077)||st.uid!==process.getuid()))fail('directory_unsafe');
  }
}
// Shared by startup and the operator's read-only preflight. No pool, worker,
// timer or directory creation is permitted here, even when the pilot is on.
async function loadProductionPilotFiles({env=process.env,clock=Date.now}={}){
  if(process.platform!=='linux')fail('enablement_invalid');
  for(const dir of [ROOT,ROOT+'/control',ROOT+'/uploads',ROOT+'/prepared',ROOT+'/music'])await privateDirectory(dir,{create:false});
  const privateFile=async file=>{const st=await fs.lstat(file);
    if((st.mode&0o077)!==0||st.uid!==process.getuid())fail('configuration_unprotected');};
  await privateFile(CONFIG);
  const config=validateProductionPilotConfig(JSON.parse((await protectedBytes(CONFIG,16384)).toString('utf8')),{env,now:clock()});
  try{
    await privateFile(ROOT+'/music/catalog.json');
    const manifest=JSON.parse((await protectedBytes(ROOT+'/music/catalog.json',262144)).toString('utf8'));
    if(!manifest||!Array.isArray(manifest.tracks))fail('catalog_invalid');
    for(const row of manifest.tracks){
      if(!row||!/^track_[a-f0-9]{24}$/.test(row.id)||row.fileName!==row.id+'.wav')fail('catalog_invalid');
      await privateFile(ROOT+'/music/'+row.fileName);
    }
    const music=await loadPrivateMusicCatalog({rootDirectory:ROOT+'/music',manifest,rights:config.musicRights,ownerCompanyId:config.owner.companyId,
      now:clock(),clock,allowExpiredForReadOnly:clock()>=config.admitUntil});
    return {config,music,admissionFence:createPilotAdmissionFence(config.missionId)};
  }catch(error){config.bridgeKey.fill(0);throw error;}
}
async function createProductionMediaPilot({env=process.env,tenantPool,clock=Date.now,logger}={}){
  if(env.SOCIAL_MEDIA_IMPORTS_ENABLED===undefined||env.SOCIAL_MEDIA_IMPORTS_ENABLED===''||env.SOCIAL_MEDIA_IMPORTS_ENABLED==='false')return null;
  if(env.SOCIAL_MEDIA_IMPORTS_ENABLED!=='true'||process.platform!=='linux')fail('enablement_invalid');
  const {config,music,admissionFence}=await loadProductionPilotFiles({env,clock});
  let capacityPool,transferPool,loop,closed=false,closing=false,closePromise;
  const report=code=>logger?.error?.({component:'calendar_media_pilot',code});
  try{
    const root=ROOT+'/uploads',preparationRoot=ROOT+'/prepared',musicRoot=ROOT+'/music';
    capacityPool=createPostgresPool(config.capacityPoolConfig,{logger});transferPool=createPostgresPool(config.transferPoolConfig,{logger});
    const store=createImportUploadPostgresStore({pool:tenantPool}),ledger=createPostgresGlobalCapacityStore({pool:capacityPool}),registryStore=createPostgresTransferRegistryStore({pool:transferPool});
    await store.verify();await ledger.verify();await registryStore.verify();
    // Expiration closes admission and worker traffic, not the owner's stored
    // previews/history. A restart after the deadline must not break the API.
    const accessPolicy=createImportAccessPolicy({allowedOwners:[{...config.owner,audience:'owner_pilot'}],isEligible:()=>!closed});
    const guard=createDiskSpaceGuard({rootDirectory:root,enabled:true});await guard.sample();
    const capacity=createGlobalMediaCapacity({store:ledger,enabled:true,requireDiskSpaceEvidence:true,diskSpaceGuard:guard,clock});
    const admission=createRenderDiskAdmission({capacity,store,rootDirectory:root,diskSpaceGuard:guard,requireDiskSpaceEvidence:true,
      coordinatorContext:{authenticated:true,role:'calendar_media_capacity_coordinator'},enabled:true});
    const preparedAdmission=createPreparedDiskAdmission({capacity,tenantStore:store,accessPolicy,rootDirectory:root,diskSpaceGuard:guard,enabled:true,clock});
    const components=await createWorkflowOperationalComponents({enabled:true,store,owner:config.owner,capacity,sourceAdmission:admission,preparedAdmission,accessPolicy,diskSpaceGuard:guard,
      privateRoot:root,preparationRoot,musicRoot,publicApiOrigin:env.PUBLIC_API_BASE_URL,catalog:music.catalog,resolveMusicTrack:music.resolveMusicTrack,
      bridgeKey:config.bridgeKey,validationOnly:true,clock,diagnostic:report,canLaunch:()=>!closing&&!closed&&clock()<config.admitUntil&&admissionFence(),
      executionTransport:{kind:'vm',workerId:config.workerId,runtimeRevision:config.runtimeRevision}});
    const registry=createTransferAuthorizationRegistry({store:registryStore,enabled:true,clock});
    const transfer=createRenderDiskTransferService({store,provider:components.provider,registry,accessPolicy,enabled:true,clock});
    const factory=createOperationalCalendarImportsRuntimeFactory({enabled:true,preparation:components.preparation,resultStore:components.resultStore,accessPolicy,
      upload:components.upload,provider:components.provider,uploadStore:store,transfer,catalog:music.catalog,clock,canAdmit:()=>!closing&&!closed&&clock()<config.admitUntil&&admissionFence(),
      async verifyReadiness(){await registry.verify();await ledger.verify();await guard.sample();return true;}});
    loop=createPilotProgressLoop({tick:components.tick,finishBy:config.finishBy,clock,report});
    return Object.freeze({factory,start:loop.start,admitUntil:config.admitUntil,finishBy:config.finishBy,
      async handlePrivateRequest(req,res){if(!String(req.url||'').startsWith(PRIVATE_PREFIX))return false;
        if(closed||clock()>=config.finishBy){res.writeHead(503,{'cache-control':'no-store'});res.end();return true;}
        return components.handlePrivateRequest(req,res);},
      close(){if(closePromise)return closePromise;closing=true;closePromise=(async()=>{
        await loop.close();closed=true;config.bridgeKey.fill(0);
        const results=await Promise.allSettled([capacityPool.end(),transferPool.end()]);
        if(results.some(value=>value.status==='rejected'))fail('cleanup_failed');
      })();return closePromise;}});
  }catch(error){
    await loop?.close();config.bridgeKey.fill(0);
    const cleanup=await Promise.allSettled([capacityPool?.end(),transferPool?.end()]);
    if(cleanup.some(value=>value.status==='rejected'))fail('cleanup_failed');
    throw error;
  }
}
module.exports={createProductionMediaPilot,createPilotProgressLoop,createPilotAdmissionFence,privateDirectory,loadProductionPilotFiles,CONFIG,ROOT,PRIVATE_PREFIX};
