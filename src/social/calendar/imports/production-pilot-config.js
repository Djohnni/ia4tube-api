"use strict";
const {parseDatabaseUrl}=require('../../../persistence/postgres/config');
const {loadSystemPostgresTls}=require('../../../persistence/postgres/tls');
const ORIGIN='https://ia4tube-api.onrender.com', SERVICE='srv-d8708kd7vvec73ap1p6g';
const HOST='dpg-dae4tmf40ujc73dr2dog-a.oregon-postgres.render.com', DB='ia4tube_social_production';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/, HASH=/^[a-f0-9]{64}$/;
function fail(code) {throw Object.assign(new Error('Piloto de mídia indisponível.'),{code:'calendar_media_pilot_'+code});}
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==keys.slice().sort().join())fail('configuration_invalid');}
function restrictedPoolConfig(raw,role,env){
  let url;try{url=parseDatabaseUrl(raw,'media_database');}catch{fail('database_invalid');}
  if(url.hostname!==HOST||url.pathname!=='/'+DB||(url.port&&url.port!=='5432')||url.search||url.hash||
    decodeURIComponent(url.username)!==role||!url.password)fail('database_target_invalid');
  return Object.freeze({connectionString:url.toString(),ssl:loadSystemPostgresTls(env,HOST),max:1,
    connectionTimeoutMillis:5000,idleTimeoutMillis:10000,statement_timeout:10000,query_timeout:12000,
    application_name:'ia4tube_media_'+(role.includes('capacity')?'capacity':'transfer')});
}
function validateProductionPilotConfig(value,{env=process.env,now=Date.now()}={}){
  exact(value,['schema','missionId','owner','workerId','runtimeRevision','bridgeKeyBase64','capacityDatabaseUrl','transferDatabaseUrl',
    'createdAt','admitUntil','finishBy','hostEvidence','musicRights']);
  if(value.schema!==1||!UUID.test(value.missionId)||!UUID.test(value.workerId)||!HASH.test(value.runtimeRevision)||
    env.RENDER_SERVICE_ID!==SERVICE||env.PUBLIC_API_BASE_URL!==ORIGIN||env.ENVIRONMENT!=='production'||
    env.SOCIAL_CALENDAR_ENABLED!=='true'||env.SOCIAL_PERSISTENCE_ENABLED!=='true'||
    env.SOCIAL_EXTERNAL_CONNECTION_ENABLED!=='false'||env.SOCIAL_EXTERNAL_PUBLICATION_ENABLED!=='false'||env.META_APP_REVIEW_WINDOW_ENABLED!=='false')fail('boundary_invalid');
  exact(value.owner,['companyId','userId']);if(!UUID.test(value.owner.companyId)||!UUID.test(value.owner.userId))fail('owner_invalid');
  if(![value.createdAt,value.admitUntil,value.finishBy,now].every(Number.isSafeInteger)||value.createdAt<0||value.createdAt>now||
    value.admitUntil<=value.createdAt||value.finishBy-value.createdAt>7200000||
    value.finishBy-value.admitUntil<600000)fail('window_invalid');
  const h=value.hostEvidence;exact(h,['project','zone','instanceId','bootId','runtimeRevision','receiptSha256','verifiedAt','deletionAction','terminationTime']);
  if(h.project!=='ia4tube-futebol'||h.zone!=='us-central1-a'||!/^[1-9][0-9]{1,24}$/.test(h.instanceId)||!UUID.test(h.bootId)||
    h.runtimeRevision!==value.runtimeRevision||!HASH.test(h.receiptSha256)||!Number.isSafeInteger(h.verifiedAt)||
    h.verifiedAt<value.createdAt||h.verifiedAt>now||h.deletionAction!=='DELETE'||h.terminationTime!==value.finishBy)fail('host_evidence_invalid');
  if(typeof value.bridgeKeyBase64!=='string'||! /^[A-Za-z0-9+/]{43}=$/.test(value.bridgeKeyBase64)||
    Buffer.from(value.bridgeKeyBase64,'base64').length!==32||Buffer.from(value.bridgeKeyBase64,'base64').toString('base64')!==value.bridgeKeyBase64)fail('bridge_key_invalid');
  const capacity=restrictedPoolConfig(value.capacityDatabaseUrl,'ia4tube_media_capacity_runtime',env);
  const transfer=restrictedPoolConfig(value.transferDatabaseUrl,'ia4tube_media_transfer_runtime',env);
  return Object.freeze({schema:1,missionId:value.missionId,owner:Object.freeze({...value.owner}),workerId:value.workerId,runtimeRevision:value.runtimeRevision,
    createdAt:value.createdAt,admitUntil:value.admitUntil,finishBy:value.finishBy,hostEvidence:Object.freeze({...h}),musicRights:Object.freeze({...value.musicRights}),
    bridgeKey:Buffer.from(value.bridgeKeyBase64,'base64'),capacityPoolConfig:capacity,transferPoolConfig:transfer});
}
module.exports={validateProductionPilotConfig,restrictedPoolConfig,fail};
