"use strict";
const {spawn}=require('node:child_process');
const HASH=/^[a-f0-9]{64}$/;
const REASONS=new Set(['required_c_header_missing','native_link_dependency_missing','permission_or_capability_denied',
 'filesystem_space_exhausted','filesystem_read_only','existing_target_refused','detail_retained_privately_not_exportable',
 ...['enoent','eacces','eperm','enospc','erofs','etimedout','enobufs'].map(v=>'errno_'+v)]);
function bad(){throw Object.assign(new Error('vm_proof_ssh_internal_diagnostic_invalid'),{code:'vm_proof_ssh_internal_diagnostic_invalid'});}
function safeInternalSummary(s,{missionId,attempt,packageSha256}){
 if(!s||s.schema!==1||s.identity?.mission!==missionId||s.identity.attempt!==attempt||s.identity.packageSha256!==packageSha256||
   !HASH.test(s.identity.installerSha256||'')||!Number.isSafeInteger(s.createdAtMs)||typeof s.terminal!=='boolean'||
   !Number.isSafeInteger(s.rawBytesRetained)||s.rawBytesRetained<0||s.rawBytesRetained>262144||!Array.isArray(s.events)||s.events.length>240||
   !(s.installerExitCode===null||Number.isInteger(s.installerExitCode)&&s.installerExitCode>=0&&s.installerExitCode<=255)||
   (s.terminal&&!Number.isSafeInteger(s.finishedAtMs)))bad();
 const events=s.events.map(e=>{
   if(!/^[-a-z0-9_]{1,64}$/.test(e.operationId||'')||!/^scripts\/media-vm\/[a-z0-9.-]+(?::[1-9][0-9]{0,4})?#[a-z0-9_-]+$/.test(e.sourceRef||'')||
      !['start','end','error'].includes(e.phase)||!Number.isSafeInteger(e.atMs))bad();
   const out={operationId:e.operationId,sourceRef:e.sourceRef,phase:e.phase,atMs:e.atMs};
   if(e.phase!=='start'){
     if(!(e.exitCode===null||Number.isInteger(e.exitCode)&&e.exitCode>=0&&e.exitCode<=255)||
        !(e.signal===null||/^SIG[A-Z0-9]{1,12}$/.test(e.signal||'')))bad();
     out.exitCode=e.exitCode;out.signal=e.signal;
   }
   if(e.phase==='error'){
     if(!REASONS.has(e.reason)||!e.streams||Object.keys(e.streams).sort().join(',')!=='exception,stderr,stdout')bad();
     out.reason=e.reason;out.streams={};
     for(const k of ['stdout','stderr','exception']){
       const v=e.streams[k];if(!v||!Number.isSafeInteger(v.bytesObserved)||v.bytesObserved<0||!Number.isSafeInteger(v.bytesRetained)||
         v.bytesRetained<0||v.bytesRetained>16384||v.bytesRetained>v.bytesObserved||typeof v.truncated!=='boolean'||!HASH.test(v.sha256||'')||
         !(v.privateBasename===undefined||v.privateBasename===null||/^[0-9]{3}-[-a-z0-9_]{1,64}\.(stdout|stderr|exception)\.private$/.test(v.privateBasename||'')))bad();
       out.streams[k]={bytesObserved:v.bytesObserved,bytesRetained:v.bytesRetained,truncated:v.truncated,sha256:v.sha256};
     }
   }
   return out;
 });
 if(s.collectionFailure!==undefined&&(s.collectionFailure?.component!=='partial_state'||s.collectionFailure?.reason!=='collection_or_persistence_failed'||Object.keys(s.collectionFailure).sort().join(',')!=='component,reason'))bad();
 return {schema:1,identity:{mission:missionId,attempt,packageSha256,installerSha256:s.identity.installerSha256},createdAtMs:s.createdAtMs,
  rawBytesRetained:s.rawBytesRetained,events,terminal:s.terminal,installerExitCode:s.installerExitCode,
  ...(s.collectionFailure?{collectionFailure:s.collectionFailure}:{}),
  ...(s.terminal?{finishedAtMs:s.finishedAtMs}:{})};
}
function summaryFromArchive(buf,binding){
 if(!Buffer.isBuffer(buf)||buf.length>1048576||buf.length%512!==0)bad();
 const root='internal-attempt-'+binding.attempt+'/';let found=null,count=0,total=0;const names=new Set();
 for(let offset=0;offset+512<=buf.length;){
   const h=buf.subarray(offset,offset+512);if(h.every(v=>v===0))break;
   let checksum=0;for(let i=0;i<512;i++)checksum+=(i>=148&&i<156)?32:h[i];
   const oct=(start,len)=>{const s=h.toString('ascii',start,start+len).replace(/\0.*$/,'').trim();if(!/^[0-7]+$/.test(s))bad();return parseInt(s,8);};
   if(oct(148,8)!==checksum||oct(108,8)!==0||oct(116,8)!==0)bad();
   const name=h.toString('utf8',0,100).replace(/\0.*$/,''),prefix=h.toString('utf8',345,500).replace(/\0.*$/,'');
   const size=oct(124,12),type=String.fromCharCode(h[156]||48),mode=oct(100,8);
   if(prefix||++count>725||names.has(name)||!name.startsWith(root)||size>65536||offset+512+size>buf.length)bad();names.add(name);
   if(type==='5'){if(name!==root||size!==0||(mode&0o077))bad();}
   else if(type==='0'){
     if((mode&0o077)||!(name===root+'summary.json'||name===root+'partial-state.json'||new RegExp('^'+root+'[0-9]{3}-[-a-z0-9_]{1,64}\\.(stdout|stderr|exception)\\.private$').test(name)))bad();
     total+=size;if(total>393216)bad();
     if(name===root+'summary.json')found=JSON.parse(buf.subarray(offset+512,offset+512+size));
   }else bad();
   offset+=512+Math.ceil(size/512)*512;
 }
 if(!found)bad();return safeInternalSummary(found,binding);
}
function privateArchiveRun(command,args,{signal,timeoutMs,maxBytes=1048576}={}){
 return new Promise((resolve,reject)=>{
  let child,size=0,failed=false;const chunks=[];
  const done=(code)=>{clearTimeout(timer);if(failed||code!==0){reject(Object.assign(new Error('vm_proof_ssh_internal_collection_transport_failed'),{code:'vm_proof_ssh_internal_collection_transport_failed'}));return;}resolve(Buffer.concat(chunks));};
  try{child=spawn(command,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],signal,
    env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,ProgramData:process.env.ProgramData,LANG:'C'}});}catch{bad();}
  const timer=setTimeout(()=>{failed=true;child.kill('SIGKILL');},timeoutMs);
  child.stdout.on('data',b=>{size+=b.length;if(size>maxBytes){failed=true;child.kill('SIGKILL');}else chunks.push(b);});
  child.stderr.on('data',()=>{});child.on('error',()=>{failed=true;});child.once('close',done);
 });
}
function quiescenceScript(){return String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
if(process.getuid()!==0)process.exit(77);
const excluded=new Set();let pid=process.pid;
for(let i=0;i<64&&pid>0;i++){
 if(excluded.has(pid))process.exit(77);excluded.add(pid);
 const status=fs.readFileSync('/proc/'+pid+'/status','utf8');pid=Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]||0);
}
const suspects=[];
for(const name of fs.readdirSync('/proc'))if(/^\d+$/.test(name)&&!excluded.has(Number(name))){
 try{
  const args=fs.readFileSync('/proc/'+name+'/cmdline').toString('utf8').split('\0').filter(Boolean);
  const command=path.basename(args[0]||'');
  if(args.some(a=>/ia4tube-proof|\/opt\/ia4tube-media|\/var\/lib\/ia4tube-media|\/sys\/fs\/cgroup\/ia4tube-media/.test(a))||
    /^(?:gcc|cc|cc1|ld|as|npm|apt-get|dpkg|mkfs\.ext4|ffmpeg|ffprobe)$/.test(command))suspects.push(Number(name));
 }catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')process.exit(77);}
}
if(suspects.length)process.exit(78);
console.log('VM_INSTALL_QUIESCENCE='+crypto.createHash('sha256').update('no_installer_or_related_processes_observed').digest('hex'));
`;}
module.exports={safeInternalSummary,summaryFromArchive,privateArchiveRun,quiescenceScript};
