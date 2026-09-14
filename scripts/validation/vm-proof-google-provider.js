"use strict";
const https = require("node:https");
const { fail, googleId, scope, resourcePath, relativeLink, bodyFor, validateGooglePlan, UUID } = require("./vm-proof-google-plan");
// Keep only bounded, allowlisted codes. Never persist the response body/message,
// which may contain request metadata. A generic HTTP error is NOT absence proof.
function responseStatus(r) {
  const e=r?.json?.error;
  const codes=new Set(["INVALID_ARGUMENT","UNAUTHENTICATED","PERMISSION_DENIED","NOT_FOUND","ALREADY_EXISTS","RESOURCE_EXHAUSTED","INTERNAL","UNAVAILABLE"]);
  const httpStatus=Number.isInteger(r?.status)&&r.status>=100&&r.status<=599?r.status:null;
  const apiCode=Number.isInteger(e?.code)&&e.code>=100&&e.code<=599?e.code:null;
  const normalizedCode=codes.has(e?.status)?e.status:"UNCLASSIFIED";
  const maintenance=e?.message === "Invalid value for field 'resource.scheduling.onHostMaintenance': 'TERMINATE'. e2 instances do not support onHostMaintenance=TERMINATE unless they are preemptible." ||
    e?.message === "e2 instances do not support onHostMaintenance=TERMINATE unless they are preemptible.";
  const definitive=httpStatus===400&&apiCode===400&&maintenance&&
    (!e.status||e.status==="INVALID_ARGUMENT")&&Array.isArray(e.errors)&&e.errors.length===1&&e.errors[0].reason==="invalid";
  return {httpStatus,apiCode,normalizedCode:definitive?"E2_STANDARD_MAINTENANCE_INVALID":normalizedCode,
    classification:definitive?"definitive_rejection":"unknown"};
}
// No metadata-server credentials, browser cookies, ambient service account or
// redirects. Authentication is explicitly supplied by the external operator.
function googleTransport(getAccessToken) {
  if (typeof getAccessToken !== "function") fail("external_authentication_required");
  return async ({ method, pathname, body, signal, hostname = "compute.googleapis.com" }) => {
    const compute = hostname === "compute.googleapis.com" && /^\/compute\/v1\/projects\/[a-z0-9-]+(?:\/|$)/.test(pathname);
    const iam = hostname === "cloudresourcemanager.googleapis.com" && method === "POST" && /^\/v1\/projects\/[a-z0-9-]+:testIamPermissions$/.test(pathname);
    if (!["GET","POST","DELETE"].includes(method) || !(compute || iam) || /[\r\n#]/.test(pathname)) fail("route_invalid");
    const token = await getAccessToken();
    if (typeof token !== "string" || !/^[A-Za-z0-9._~-]{20,8192}$/.test(token)) fail("external_authentication_required");
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    if (data?.length > 65536) fail("request_too_large");
    return new Promise((resolve,reject)=>{
      const closed=()=>reject(Object.assign(new Error("gcp_proof_request_failed"),{code:"gcp_proof_request_failed"}));
      const req=https.request({ hostname, path:pathname, method, rejectUnauthorized:true,
        minVersion:"TLSv1.2", timeout:20000, signal, headers:{ Authorization:"Bearer "+token, Accept:"application/json", "Content-Type":"application/json", ...(data?{"Content-Length":data.length}:{}) } }, res=>{
        if(res.statusCode>=300 && res.statusCode<400){res.destroy();closed();return;}
        let size=0;const chunks=[];
        res.on("data",c=>{size+=c.length;if(size>2097152){res.destroy();closed();}else chunks.push(c);});
        res.on("error",closed);res.on("end",()=>{try{resolve({status:res.statusCode,json:size?JSON.parse(Buffer.concat(chunks).toString("utf8")):null});}catch{closed();}});
      });req.on("error",closed);req.on("timeout",()=>req.destroy());req.end(data);
    });
  };
}
function createGoogleProvider({ plan, getAccessToken, transport = googleTransport(getAccessToken) }) {
  validateGooglePlan(plan);
  async function readPath(p,signal){const r=await transport({method:"GET",pathname:"/compute/v1/"+p,signal});if(r.status===404)return null;if(r.status!==200)fail("read_failed");return r.json;}
  async function get(kind,missionId,{signal}={}){return readPath(resourcePath(plan,missionId,kind),signal);}
  async function inventory(kind,{signal}={}){
    const rows=[];let pageToken="";
    for(let page=0;page<50;page++){
      const r=await readPath(scope(plan,kind)+"/"+kind+"?maxResults=200"+(pageToken?"&pageToken="+encodeURIComponent(pageToken):""),signal);
      if(!r || (r.items!==undefined&&!Array.isArray(r.items)) || (r.items||[]).length>200)fail("inventory_invalid");
      rows.push(...(r.items||[]).map(v=>({id:googleId(v.id),name:v.name})));
      if(!r.nextPageToken)return rows;
      if(typeof r.nextPageToken!=="string"||r.nextPageToken.length>4096)fail("pagination_invalid");pageToken=r.nextPageToken;
    }fail("inventory_limit");
  }
  function operationRef(op,kind,missionId,action,requestId) {
    if(!op || !/^[a-zA-Z0-9_-]{1,200}$/.test(op.name||"") || op.operationType!==action ||
      relativeLink(op.targetLink)!==resourcePath(plan,missionId,kind) ||
      (op.clientOperationId && op.clientOperationId!==requestId) || !["PENDING","RUNNING","DONE"].includes(op.status)) fail("operation_binding_mismatch");
    const id=op.targetId===undefined?null:googleId(op.targetId);
    const opScope=scope(plan,kind);
    if(op.selfLink && relativeLink(op.selfLink)!==opScope+"/operations/"+op.name)fail("operation_scope_mismatch");
    const known=new Set(["INVALID_FIELD_VALUE","INVALID_USAGE","RESOURCE_NOT_FOUND","RESOURCE_ALREADY_EXISTS","QUOTA_EXCEEDED",
      "ZONE_RESOURCE_POOL_EXHAUSTED","ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS","PERMISSIONS_ERROR","INTERNAL_ERROR","RESOURCE_IN_USE_BY_ANOTHER_RESOURCE"]);
    const errorCodes=Array.isArray(op.error?.errors)?op.error.errors.slice(0,16).map(e=>known.has(e.code)?e.code:"UNCLASSIFIED"):[];
    return {name:op.name,targetId:id,status:op.status,failed:!!op.error,errorCodes,requestId,action,kind};
  }
  return {
    get,inventory,operationRef,
    async preflight({signal}={}){
      const required = ["compute.instances.create","compute.instances.delete","compute.instances.get","compute.instances.setMetadata","compute.instances.setTags",
        "compute.disks.create","compute.disks.delete","compute.disks.get","compute.disks.use","compute.networks.create","compute.networks.delete","compute.networks.get",
        "compute.networks.updatePolicy","compute.subnetworks.create","compute.subnetworks.delete","compute.subnetworks.get","compute.subnetworks.use","compute.subnetworks.useExternalIp",
        "compute.firewalls.create","compute.firewalls.delete","compute.firewalls.get","compute.zoneOperations.get","compute.regionOperations.get","compute.globalOperations.get"];
      const permissions = await transport({ method:"POST",hostname:"cloudresourcemanager.googleapis.com",pathname:`/v1/projects/${plan.project}:testIamPermissions`,body:{permissions:required},signal });
      if(permissions.status!==200 || !Array.isArray(permissions.json?.permissions) || required.some(p=>!permissions.json.permissions.includes(p)))fail("external_control_permissions_missing");
      const image=await readPath(plan.sourceImage,signal),machine=await readPath(`projects/${plan.project}/zones/${plan.zone}/machineTypes/e2-medium`,signal);
      if(!image || googleId(image.id)!==plan.sourceImageId || relativeLink(image.selfLink)!==plan.sourceImage || image.status!=="READY" || image.architecture!=="X86_64" || image.deprecated?.state)fail("image_not_verified");
      if(machine?.guestCpus!==2 || machine.memoryMb!==4096)fail("machine_not_verified");
      // Project metadata can also run scripts/OS Login; fail closed instead of
      // disabling preexisting policy or inheriting a project-level bootstrap.
      const project=await readPath(`projects/${plan.project}`,signal);
      const metadata=project?.commonInstanceMetadata?.items||[];
      if(metadata.some(x=>/^(startup-script|startup-script-url|shutdown-script|shutdown-script-url|enable-oslogin|enable-oslogin-2fa|user-data)$/.test(x.key) && x.value && x.value.toUpperCase()!=="FALSE"))fail("project_metadata_requires_review");
      return {verified:true};
    },
    async create(kind,state,startupScript,{signal}={}){
      const requestId=state.resources[kind].createRequestId;if(!UUID.test(requestId))fail("request_id_invalid");
      const r=await transport({method:"POST",pathname:"/compute/v1/"+scope(plan,kind)+"/"+kind+"?requestId="+requestId,
        body:bodyFor(plan,state,kind,startupScript),signal});
      if(![200,201].includes(r.status)){
        const response=responseStatus(r);
        throw Object.assign(new Error("gcp_proof_create_"+response.classification),
          {code:"gcp_proof_create_"+response.classification,response:{...response,requestId,resource:resourcePath(plan,state.missionId,kind)}});
      }
      return {...operationRef(r.json,kind,state.missionId,"insert",requestId),httpStatus:r.status,classification:"accepted"};
    },
    async pollOperation(ref,missionId,{signal}={}){
      const raw=await readPath(scope(plan,ref.kind)+"/operations/"+ref.name,signal);
      if(!raw)fail("operation_missing");const next=operationRef(raw,ref.kind,missionId,ref.action,ref.requestId);
      if(ref.targetId!==null && next.targetId!==ref.targetId)fail("operation_id_changed");return next;
    },
    async destroy(kind,state,{signal}={}){
      const record=state.resources[kind];googleId(record.id);
      const r=await transport({method:"DELETE",pathname:"/compute/v1/"+resourcePath(plan,state.missionId,kind)+"?requestId="+record.deleteRequestId,signal});
      if(r.status===404)return null;
      if(r.status!==200)fail("delete_response_unknown");const op=operationRef(r.json,kind,state.missionId,"delete",record.deleteRequestId);
      if(op.targetId!==record.id)fail("delete_target_mismatch");return op;
    }
  };
}
module.exports={googleTransport,createGoogleProvider,responseStatus};
