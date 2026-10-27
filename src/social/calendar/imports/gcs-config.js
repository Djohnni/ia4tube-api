"use strict";
const TRANSPORT="gcs-parts-v1", HEADER="x-ia4tube-media-transport";
function fail(){throw Object.assign(new Error("Armazenamento de vídeo indisponível."),{code:"ready_video_gcs_configuration_invalid",statusCode:503});}
function loadGcsConfig(env=process.env){
  const enabled=env.SOCIAL_READY_VIDEO_GCS_ENABLED;
  if(enabled!==undefined && !["true","false"].includes(enabled))fail();
  const bucket=env.SOCIAL_READY_VIDEO_GCS_BUCKET;
  if(bucket!==undefined && (typeof bucket!=="string" || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)))fail();
  if(enabled==="true" && (!bucket || env.ENVIRONMENT!=="production"))fail();
  return Object.freeze({enabled:enabled==="true",bucket:bucket||null,objectPrefix:"ready-video/",transport:TRANSPORT});
}
function mediaTransport(req){
  const value=req?.headers?.[HEADER];
  if(value===undefined)return null;
  if(value!==TRANSPORT)fail();
  let count=0;for(let i=0;i<(req.rawHeaders?.length||0);i+=2)if(req.rawHeaders[i].toLowerCase()===HEADER)count++;
  if(count>1)fail();return TRANSPORT;
}
function createConfiguredGcsTransport(env=process.env){
  const config=loadGcsConfig(env);if(!config.bucket)return null;
  const filename=env.SOCIAL_READY_VIDEO_GCS_CREDENTIALS_FILE;
  if(typeof filename!=="string" || !filename || !require("node:path").isAbsolute(filename) || /[\0\r\n]/.test(filename))fail();
  return require("./gcs-sdk-transport").createGcsSdkTransport({bucketName:config.bucket,prefix:config.objectPrefix,keyFilename:filename});
}
module.exports={TRANSPORT,HEADER,loadGcsConfig,mediaTransport,createConfiguredGcsTransport};
