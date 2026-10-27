"use strict";
// Download grants are response-only. Never persist them in calendar snapshots.
async function withGooglePreview(resultStore,context,preview,resultRef){
  if(context?.mediaTransport!=="gcs-parts-v1" || typeof resultStore?.googleDownload!=="function" || !resultStore.googleStorage)return preview;
  let added=false;
  async function part(value){
    if(!value)return value;
    let grant;
    try{grant=await resultStore.googleDownload({context,assetId:preview.assetId,mediaRevision:preview.mediaRevision,resultRef,target:value.target,sha256:value.sha256});}
    catch{return value;} // Optional Google metadata never breaks the existing list/URL.
    if(!grant)return value;added=true;return {...value,googleDownload:grant};
  }
  const variants=[];for(const value of preview.variants)variants.push(await part(value));
  const thumbnail=await part(preview.thumbnail);
  return added?{...preview,variants,thumbnail,googleStorage:{...resultStore.googleStorage}}:preview;
}
module.exports={withGooglePreview};
