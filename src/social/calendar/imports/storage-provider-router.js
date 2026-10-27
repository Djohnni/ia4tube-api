"use strict";
const {isGcsPrivateUploadProvider}=require("./gcs-provider");
const {isImportAccessPolicy}=require("./access-policy");
const {TRANSPORT}=require("./gcs-config");
function fail(){throw Object.assign(new Error("Importação indisponível."),{code:"import_storage_route_invalid",statusCode:503});}
function createUploadStorageRouter({store,disk,gcs,accessPolicy,newGcsEnabled=false}={}){
  if(store?.capabilities?.persistence!=="durable" || typeof store.update!=="function" ||
      disk?.getCapabilities?.().available!==true || gcs!==null && !isGcsPrivateUploadProvider(gcs) || !isImportAccessPolicy(accessPolicy))fail();
  async function selected(args){
    const owner=accessPolicy.resolve(args.context);
    const type=await store.update(owner.companyId,state=>{
      const rows=Object.values(state.uploads||{}).filter(row=>row.objectKey===args.objectKey && row.userId===owner.userId);
      if(rows.length!==1 || rows[0].companyId!==owner.companyId)fail();
      return rows[0].storageProvider||"render_disk";
    });
    accessPolicy.resolve(args.context);
    if(type==="gcs"){if(!gcs)fail();return gcs;}
    if(type!=="render_disk")fail();return disk;
  }
  const api={capabilities:disk.capabilities,getCapabilities:()=>({available:true,provider:"private-storage-router"}),
    storageForNewUpload(context){accessPolicy.resolve(context);if(newGcsEnabled && context.mediaTransport===TRANSPORT){if(!gcs)fail();return "gcs";}return "render_disk";},
    authorizationLifetimeMsFor(row){return row.storageProvider==="gcs"?120000:600000;}};
  for(const name of ["beginMultipart","authorizePart","resolveAuthorization","listParts","finalizeMultipart","inspectObject","streamSealedObject","abortMultipart"])
    api[name]=async args=>(await selected(args))[name](args);
  api.acceptPart=async args=>{const provider=await selected(args);if(provider!==disk)fail();return disk.acceptPart(args);};
  return Object.freeze(api);
}
module.exports={createUploadStorageRouter};
