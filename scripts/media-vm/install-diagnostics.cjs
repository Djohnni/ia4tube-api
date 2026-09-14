"use strict";
// Root-only, bounded installer records. Raw child/exception bytes NEVER leave
// this directory via stdout, summary, report or the normal collector.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), cp = require("node:child_process");
const ROOT = "/var/tmp/ia4tube-proof-diagnostics";
const MAX_RAW = 262144, MAX_FILE = 16384, MAX_EVENTS = 240;
const ENV = { PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" };
const TARGETS=["/opt/ia4tube-media","/var/lib/ia4tube-media","/etc/ia4tube-media","/etc/sudoers.d/ia4tube-media","/etc/systemd/system/ia4tube-media-worker.service","/etc/systemd/system/var-lib-ia4tube\\x2dmedia-work.mount","/etc/systemd/system/ia4tube-media-containment.service","/var/tmp/ia4tube-synthetic-outside-readable.txt","/sys/fs/cgroup/ia4tube-media-vm"];
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
function refused() { throw Object.assign(new Error("internal_diagnostic_refused"), { code: "INTERNAL_DIAGNOSTIC_REFUSED" }); }
function regular(file) { const s=fs.lstatSync(file); if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||(process.platform==="linux"&&(s.uid!==0||(s.mode&0o077))))refused(); return s; }
function safeReason(error, bytes = "") {
  const text = String(bytes);
  if (/fatal error: (?:errno|stdio|stdlib|stdint|unistd|sys\/[a-z_]+|linux\/[a-z_]+)\.h: No such file or directory/.test(text)) return "required_c_header_missing";
  if (/cannot find (?:Scrt1\.o|crti\.o|-lc)|ld:.*cannot find/.test(text)) return "native_link_dependency_missing";
  if (/Permission denied|Operation not permitted/.test(text)) return "permission_or_capability_denied";
  if (/No space left on device/.test(text)) return "filesystem_space_exhausted";
  if (/Read-only file system/.test(text)) return "filesystem_read_only";
  if (/File exists/.test(text)||error&&error.code==="EEXIST") return "existing_target_refused";
  if (error&&["ENOENT","EACCES","EPERM","ENOSPC","EROFS","ETIMEDOUT","ENOBUFS"].includes(error.code)) return "errno_"+error.code.toLowerCase();
  return "detail_retained_privately_not_exportable";
}
function createSession(directory, identity) {
  fs.mkdirSync(directory,{mode:0o700});
  const state={schema:1,identity,createdAtMs:Date.now(),rawBytesRetained:0,events:[],terminal:false,installerExitCode:null};
  fs.writeFileSync(path.join(directory,"summary.json"),JSON.stringify(state),{flag:"wx",mode:0o600});
  fs.writeFileSync(path.join(directory,"partial-state.json"),JSON.stringify({schema:1,identity,scope:"fixed_anchors_only_not_recursive_cleanup_authority",before:snapshot(),after:null}),{flag:"wx",mode:0o600});
  return openSession(directory);
}
function openSession(directory) {
  const ds=fs.lstatSync(directory); if(!ds.isDirectory()||ds.isSymbolicLink()||(process.platform==="linux"&&(ds.uid!==0||(ds.mode&0o077))))refused();
  const file=path.join(directory,"summary.json"); if(regular(file).size>65536)refused();
  let state=JSON.parse(fs.readFileSync(file,"utf8"));
  if(state.schema!==1||!Array.isArray(state.events)||state.events.length>MAX_EVENTS)refused();
  function save(){regular(file);const text=JSON.stringify(state);if(Buffer.byteLength(text)>65536)refused();fs.writeFileSync(file,text,{mode:0o600});}
  function event(value){if(state.events.length>=MAX_EVENTS)refused();state.events.push(value);save();}
  function retain(id,kind,input){
    const original=Buffer.isBuffer(input)?input:Buffer.from(String(input||""));
    const n=Math.min(original.length,MAX_FILE,MAX_RAW-state.rawBytesRetained), kept=original.subarray(0,Math.max(0,n));
    const basename=`${String(state.events.length).padStart(3,"0")}-${id}.${kind}.private`;
    if(kept.length)fs.writeFileSync(path.join(directory,basename),kept,{flag:"wx",mode:0o600});
    state.rawBytesRetained+=kept.length;
    return {bytesObserved:original.length,bytesRetained:kept.length,truncated:kept.length<original.length,sha256:sha(original),privateBasename:kept.length?basename:null};
  }
  function span(id,sourceRef,fn){
    if(state.terminal||!/^[-a-z0-9_]{1,64}$/.test(id)||!/^scripts\/media-vm\/[a-z0-9.-]+(?::[1-9][0-9]{0,4})?#[a-z0-9_-]+$/.test(sourceRef))refused();
    const startedAtMs=Date.now();event({operationId:id,sourceRef,phase:"start",atMs:startedAtMs});
    let result;
    try{result=fn();}
    catch(error){
      if(error.code==="INTERNAL_DIAGNOSTIC_COLLECTION_FAILED")throw error;
      state=JSON.parse(fs.readFileSync(file,"utf8"));
      const streams={stdout:retain(id,"stdout",error.stdout),stderr:retain(id,"stderr",error.stderr),exception:retain(id,"exception",String(error.stack||error.message||"unknown_error"))};
      const status=Number.isInteger(error.status)?error.status:null;
      const signal=typeof error.signal==="string"&&/^SIG[A-Z0-9]{1,12}$/.test(error.signal)?error.signal:null;
      event({operationId:id,sourceRef,phase:"error",atMs:Date.now(),exitCode:status,signal,reason:safeReason(error,error.stderr),streams});
      partial();
      const safe=Object.assign(new Error("installer_internal_operation_failed"),{status:status===null?1:status,signal,code:"INSTALLER_INTERNAL_OPERATION_FAILED"}); throw safe;
    }
    // Command success is durable before the separate partial-state collection.
    // A snapshot/persistence failure cannot turn that command into a failure.
    state=JSON.parse(fs.readFileSync(file,"utf8"));event({operationId:id,sourceRef,phase:"end",atMs:Date.now(),exitCode:0,signal:null});partial();return result;
  }
  function partial(){try{const p=path.join(directory,"partial-state.json");regular(p);const data=JSON.parse(fs.readFileSync(p,"utf8"));data.after=snapshot();fs.writeFileSync(p,JSON.stringify(data),{mode:0o600});}
    catch(error){state.collectionFailure={component:"partial_state",reason:"collection_or_persistence_failed"};try{save();}catch(_){}throw Object.assign(new Error("internal_diagnostic_collection_failed"),{code:"INTERNAL_DIAGNOSTIC_COLLECTION_FAILED",status:79});}}
  return {span,event,state,retain,finish(exitCode){state.terminal=true;state.installerExitCode=exitCode;state.finishedAtMs=Date.now();save();},directory};
}
function snapshot(){
  const anchors=TARGETS.map(name=>{try{const s=fs.lstatSync(name);return {name,present:true,dev:String(s.dev),ino:String(s.ino),uid:s.uid,gid:s.gid,mode:s.mode&0o7777,nlink:s.nlink,type:s.isSymbolicLink()?"symlink":s.isDirectory()?"directory":s.isFile()?"regular":"other"};}catch(e){if(e.code!=="ENOENT")throw e;return {name,present:false};}});
  const accounts=["ia4tube-coordinator","ia4tube-codec"].map(name=>{
    if(process.platform!=="linux")return {name,present:false,observation:"not_linux"};
    const r=cp.spawnSync("/usr/bin/id",["-u",name],{encoding:"utf8",env:ENV,timeout:1000,maxBuffer:1024});
    if(r.error||r.signal)refused();if(r.status===1)return {name,present:false};
    if(r.status!==0||!/^\d{1,10}\n$/.test(r.stdout))refused();return {name,present:true,uid:Number(r.stdout.trim())};
  });return {observedAtMs:Date.now(),anchors,accounts};
}
function productionPath(){
  if(process.platform!=="linux"||process.getuid()!==0||process.version!=="v24.15.0")refused();
  const s=fs.lstatSync(ROOT);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o077))refused();
  const attempt=process.env.IA4TUBE_INSTALL_ATTEMPT||"1";if(!/^[1-3]$/.test(attempt))refused();
  return path.join(ROOT,"internal-attempt-"+attempt);
}
function productionSession(){
  const session=openSession(productionPath()),identity=session.state.identity;
  if(!identity||identity.attempt!==Number(process.env.IA4TUBE_INSTALL_ATTEMPT||1)||identity.mission!==(process.env.IA4TUBE_INSTALL_MISSION_ID||"local-synthetic-unbound")||identity.packageSha256!==(process.env.IA4TUBE_INSTALL_PACKAGE_SHA256||null))refused();
  return session;
}
function execute(id,ref,command,args){
  const env={...ENV};
  for(const key of ["IA4TUBE_INSTALL_ATTEMPT","IA4TUBE_INSTALL_MISSION_ID","IA4TUBE_INSTALL_PACKAGE_SHA256"])if(process.env[key])env[key]=process.env[key];
  return productionSession().span(id,ref,()=>cp.execFileSync(command,args,{stdio:["ignore","pipe","pipe"],env,maxBuffer:1048576,timeout:280000,killSignal:"SIGKILL"}));
}
function main(){
  const [action,...args]=process.argv.slice(2);
  if(action==="init"&&args.length===0){
    const mission=process.env.IA4TUBE_INSTALL_MISSION_ID||"local-synthetic-unbound";
    const packageSha256=process.env.IA4TUBE_INSTALL_PACKAGE_SHA256||null;
    if(!/^[a-zA-Z0-9-]{8,80}$/.test(mission)||packageSha256!==null&&!/^[a-f0-9]{64}$/.test(packageSha256))refused();
    // Direct dedicated-VM installation also has diagnostics, without needing
    // an already-running external wrapper. Never reuse an unsafe parent.
    if(process.platform!=="linux"||process.getuid()!==0)refused();
    try{fs.mkdirSync(ROOT,{mode:0o700});}catch(error){if(error.code!=="EEXIST")throw error;}
    createSession(productionPath(),{mission,packageSha256,attempt:Number(process.env.IA4TUBE_INSTALL_ATTEMPT||1),installerSha256:sha(fs.readFileSync(path.join(__dirname,"install-ubuntu24.sh")))});return;
  }
  if(action==="run"&&args.length>=3){execute(args[0],args[1],args[2],args.slice(3));return;}
  if(action==="finish"&&args.length===1&&/^[0-9]{1,3}$/.test(args[0])){productionSession().finish(Number(args[0]));return;}
  refused();
}
if(require.main===module){try{main();}catch(error){process.stderr.write("VM_INSTALL_INTERNAL=FAILED\n");process.exitCode=Number.isInteger(error.status)&&error.status>0&&error.status<=255?error.status:79;}}
module.exports={ROOT,MAX_RAW,MAX_FILE,MAX_EVENTS,safeReason,createSession,openSession,productionSession,execute};
