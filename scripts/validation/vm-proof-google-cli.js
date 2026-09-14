"use strict";
const fs=require("node:fs/promises"),path=require("node:path");
const {argumentsOf}=require("./vm-proof-cli");
const {sha256,canonical}=require("./vm-proof-manifest");
const {createGooglePlan,validateGooglePlan,fail}=require("./vm-proof-google-plan");
const CONFIRM="CREATE_ONE_GOOGLE_SYNTHETIC_VM_AND_OWN_NETWORK_MAX_2_HOURS_THEN_DELETE_OWN_RESOURCES";
// Preserve the authorized exact account binding without publishing its literal
// address. This digest is an identity check, not a password or credential.
const ACCOUNT_BINDING_SHA256="8bc39c4607651224e1f1f8e0867d2a4da575c664052d8a219c924e0499758ea4";
async function gcloudReader({python,script,account,config,run}){
  if(!path.isAbsolute(python||"")||!path.isAbsolute(script||"")||typeof account!=="string"||sha256(account)!==ACCOUNT_BINDING_SHA256)fail("external_authentication_configuration_required");
  for(const file of [python,script]){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())fail("sdk_path_invalid");}
  const configRoot=await require("./vm-proof-local-state").externalRoot(config);
  const exec=run||require("./vm-proof-ssh").processRun;
  // Login/consent is never initiated by the controller. gcloud refreshes an
  // already authorized account; its token stays only in this process memory.
  return async()=>{
    const output=await exec(python,[script,"auth","print-access-token","--account="+account,"--project=ia4tube-futebol","--quiet"],{timeoutMs:15000,maxBytes:16384,gcloudConfig:configRoot});
    const token=output.trim();if(!/^[A-Za-z0-9._~-]{20,8192}$/.test(token))fail("external_authentication_required");return token;
  };
}
async function main(argv){
  const a=argumentsOf(argv),mode=a["--mode"],allowed=["--mode","--package","--plan","--image-id","--operator-ipv4","--approval-sha256","--external-state-dir","--gcloud-python","--gcloud-script","--gcloud-config","--account","--confirm","--resolution-authorization-sha256","--package-review-sha256"];
  if(Object.keys(a).some(k=>!allowed.includes(k))||!["prepare","preflight","execute"].includes(mode)||!a["--package"]||!a["--plan"])fail("arguments_invalid");
  const packagePath=path.resolve(a["--package"]),bytes=await fs.readFile(packagePath);
  if(mode==="prepare"){
    const resolution=a['--resolution-authorization-sha256']||a['--package-review-sha256']?{
      packageSha256:sha256(bytes),authorizationSha256:a['--resolution-authorization-sha256'],packageReviewSha256:a['--package-review-sha256']}:null;
    if(resolution===null&&sha256(bytes)!==createGooglePlan().packageSha256)fail('package_changed');
    const plan=createGooglePlan({imageId:a["--image-id"]||null,operatorIpv4:a["--operator-ipv4"]||null,resolution});
    await fs.writeFile(path.resolve(a["--plan"]),canonical(plan)+"\n",{flag:"wx",mode:0o600});
    return {mode,paidExecution:false,approvalSha256:plan.approvalSha256,packageSha256:plan.packageSha256,
      bindingsComplete:plan.sourceImageId!==null&&plan.operatorIpv4!==null,externalAccessVerified:false};
  }
  const planData=await fs.readFile(path.resolve(a["--plan"]));if(planData.length>32768)fail("plan_too_large");
  const plan=validateGooglePlan(JSON.parse(planData),{executable:mode==="execute"});
  if(bytes.length>67108864||sha256(bytes)!==plan.packageSha256)fail('package_changed');
  if(mode==="execute"&&(a["--confirm"]!==CONFIRM||a["--approval-sha256"]!==plan.approvalSha256||!a["--external-state-dir"]))fail("specific_paid_confirmation_required");
  const getAccessToken=await gcloudReader({python:a["--gcloud-python"],script:a["--gcloud-script"],account:a["--account"],config:a["--gcloud-config"]});
  const provider=require("./vm-proof-google-provider").createGoogleProvider({plan,getAccessToken});
  if(mode==="preflight"){
    const result=await provider.preflight();const counts={};
    for(const kind of require("./vm-proof-google-plan").KINDS)counts[kind]=(await provider.inventory(kind)).length;
    return {mode,paidExecution:false,externalControlVerified:result.verified,counts};
  }
  const store=await require("./vm-proof-local-state").createLocalStore(a["--external-state-dir"]);
  const guest=await require("./vm-proof-ssh").createSshGuest({stateRoot:store.root,packagePath,plan,providerKind:"google"});
  return require("./vm-proof-google-controller").runGoogleProof({plan,approvalSha256:a["--approval-sha256"],store,provider,guest,
    onInstallFailure:plan.resolution?require('./vm-proof-google-resolution').createResolutionInbox(store.root):null,
    onSequenceFailure:plan.resolution?require('./vm-proof-google-resolution').createCaseResolutionInbox(store.root):null});
}
if(require.main===module)main(process.argv.slice(2)).then(r=>{
  process.stdout.write("GOOGLE_PROOF_CONTROL="+JSON.stringify(r)+"\n");
  if(r.mode!=="prepare"&&r.mode!=="preflight"&&(!r.destructionConfirmed||r.failure))process.exitCode=1;
}).catch(e=>{process.stderr.write("GOOGLE_PROOF_ERROR="+(/^gcp_proof_[a-z_]+$/.test(e.code||"")?e.code:"gcp_proof_closed_failure")+"\n");process.exitCode=1;});
module.exports={main,gcloudReader,CONFIRM};
