"use strict";
// One operational adapter around the reviewed installer/SSH identity. Never
// exports runSequence/revalidation; credentials arrive only in SSH stdin.
const path = require("node:path");
const { createSshGuest, processRun } = require("../validation/vm-proof-ssh");
const { protectedPath, atomicWrite } = require("../validation/vm-proof-local-state");
const { sha256 } = require("../validation/vm-proof-manifest");
const { UUID, ipv4 } = require("../validation/vm-proof-google-plan");
const { HASH, fail, validateOperationalPlan } = require("./google-plan");
const WORKER = "ia4tube-media-worker.service";
const ROOT = "/opt/ia4tube-media/coordinator";
function hostProbeScript() {
  return `"use strict";
const fs=require('node:fs/promises');
const {createMediaProcessExecutor}=require('${ROOT}/src/social/calendar/imports/media-process-executor');
const {vmHostProved}=require('${ROOT}/src/social/calendar/imports/vm-coordinator');
(async()=>{
 if(process.platform!=='linux'||process.getuid()===0)throw Error();
 const config=JSON.parse(await fs.readFile('/etc/ia4tube-media/worker.json','utf8'));
 if(config.enabled!==false)throw Error();
 const record=JSON.parse(await fs.readFile('/opt/ia4tube-media/installation.json','utf8'));
 const executor=createMediaProcessExecutor({workingRoot:config.executorRoot,ffmpegPath:config.ffmpegPath,allowedRoots:[config.workRoot],linuxRuntime:config.linuxRuntime});
 await executor.prepareRuntime();if(!vmHostProved(executor))throw Error();
 const bootId=(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
 process.stdout.write(JSON.stringify({controlsProved:true,convertersStarted:0,runtimeRevision:record.runtimeRevision,bootId})+'\\n');
})().catch(()=>{process.stderr.write('MEDIA_PILOT_HOST=UNPROVED\\n');process.exitCode=1;});\n`;
}
function startScript({ missionId, workerId, runtimeRevision, stopAt, keyBase64 }) {
  if (!UUID.test(missionId || "") || !UUID.test(workerId || "") || !HASH.test(runtimeRevision || "") || !Number.isSafeInteger(stopAt) ||
      !/^[A-Za-z0-9+/]{43}=$/.test(keyBase64 || "") || Buffer.from(keyBase64, "base64").length !== 32) fail("worker_binding_invalid");
  // The returned source is private: never log it or store it under outputs.
  const config = JSON.stringify({ missionId, workerId, runtimeRevision, stopAt, keyBase64 });
  return `"use strict";
const fs=require('node:fs'),cp=require('node:child_process');
const input=${config};
const fail=()=>{throw Error('closed');};
const command=(args)=>cp.execFileSync('/usr/bin/systemctl',args,{stdio:['ignore','pipe','pipe'],timeout:15000,maxBuffer:4096});
const read=(name,mode)=>{const st=fs.lstatSync(name);if(!st.isFile()||st.isSymbolicLink()||st.uid!==0||st.nlink!==1||(st.mode&mode))fail();return JSON.parse(fs.readFileSync(name,'utf8'));};
try{
 if(process.platform!=='linux'||process.getuid()!==0)fail();
 const remaining=Math.floor((input.stopAt-Date.now())/1000);if(remaining<300||remaining>6600)fail();
 const configName='/etc/ia4tube-media/worker.json';const current=read(configName,0o027);
 const installed=read('/opt/ia4tube-media/installation.json',0o222);
 if(current.enabled!==false||current.runtimeRevision!==input.runtimeRevision||installed.runtimeRevision!==input.runtimeRevision||
   current.apiOrigin!=='https://ia4tube-api.onrender.com')fail();
 let isActive=false;try{command(['is-active','--quiet','${WORKER}']);isActive=true;}catch{}if(isActive)fail();
 let enabled=false;try{command(['is-enabled','--quiet','${WORKER}']);enabled=true;}catch{}if(enabled)fail();
 if(!/^populated 0$/m.test(fs.readFileSync('/sys/fs/cgroup/ia4tube-media-vm/cgroup.events','utf8')))fail();
 const intent='/var/lib/ia4tube-media/operational-start.json';
 const fd=fs.openSync(intent,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({missionId:input.missionId,workerId:input.workerId,runtimeRevision:input.runtimeRevision,stopAt:input.stopAt}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const gid=Number(cp.execFileSync('/usr/bin/id',['-g','ia4tube-coordinator'],{encoding:'utf8',timeout:5000}).trim());if(!Number.isSafeInteger(gid)||gid<=0)fail();
 const key=Buffer.from(input.keyBase64,'base64');input.keyBase64='';
 const keyFd=fs.openSync('/etc/ia4tube-media/bridge.key','wx',0o440);try{fs.writeFileSync(keyFd,key);fs.fchownSync(keyFd,0,gid);fs.fsyncSync(keyFd);}finally{key.fill(0);fs.closeSync(keyFd);}
 current.enabled=true;current.workerId=input.workerId;
 const cf=fs.openSync(configName,fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW);try{fs.ftruncateSync(cf,0);fs.writeFileSync(cf,JSON.stringify(current));fs.fsyncSync(cf);}finally{fs.closeSync(cf);}
 const drop='/etc/systemd/system/${WORKER}.d';fs.mkdirSync(drop,{mode:0o755});
 fs.writeFileSync(drop+'/pilot.conf','[Service]\\nRuntimeMaxSec='+remaining+'s\\nRestart=no\\n',{flag:'wx',mode:0o444});
 command(['daemon-reload']);command(['start','${WORKER}']);command(['is-active','--quiet','${WORKER}']);
 process.stdout.write(JSON.stringify({active:true,recurring:false,workerId:input.workerId,stopAt:input.stopAt})+'\\n');
}catch{process.stderr.write('MEDIA_PILOT_START=UNCONFIRMED_NO_REPEAT\\n');process.exitCode=1;}
`;
}
function stopScript() {
  return `"use strict";
const fs=require('node:fs'),cp=require('node:child_process');
try{
 if(process.platform!=='linux'||process.getuid()!==0)throw Error();
 cp.execFileSync('/usr/bin/systemctl',['stop','${WORKER}'],{timeout:245000,stdio:['ignore','pipe','pipe'],maxBuffer:4096});
 const state=cp.execFileSync('/usr/bin/systemctl',['show','${WORKER}','--property=ActiveState','--property=MainPID'],{encoding:'utf8',timeout:10000,maxBuffer:4096});
 const stopped=/^ActiveState=(inactive|failed)$/m.test(state)&&/^MainPID=0$/m.test(state);
 const empty=/^populated 0$/m.test(fs.readFileSync('/sys/fs/cgroup/ia4tube-media-vm/cgroup.events','utf8'));
 const log=cp.execFileSync('/usr/bin/journalctl',['-u','${WORKER}','--no-pager','--output=cat','-n','100'],{encoding:'utf8',timeout:10000,maxBuffer:16384});
 const nativeTerminationProved=stopped&&empty&&/^VM_TERMINATION=PROVED$/m.test(log);
 process.stdout.write(JSON.stringify({stopped,nativeTerminationProved})+'\\n');
}catch{process.stderr.write('MEDIA_PILOT_STOP=UNCONFIRMED\\n');process.exitCode=1;}\n`;
}
function collectionScript() {
  return `"use strict";
const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process');
try{
 if(process.platform!=='linux'||process.getuid()!==0)throw Error();
 let offers=0,done=0;
 for(const [folder,kind]of[['offers','offers'],['done','done']]){
  const root='/var/lib/ia4tube-media/state/'+folder;
  if(!fs.existsSync(root))continue;
  const st=fs.lstatSync(root);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077))throw Error();
  const files=fs.readdirSync(root);if(files.length>1000||files.some(f=>!/^[-a-f0-9]{36}\\.json$/.test(f)))throw Error();
  if(kind==='offers')offers=files.length;else done=files.length;
 }
 const unit=cp.execFileSync('/usr/bin/systemctl',['show','${WORKER}','--property=ActiveState','--property=MainPID','--property=CPUUsageNSec','--property=MemoryPeak','--property=ExecMainCode','--property=ExecMainStatus'],{encoding:'utf8',timeout:10000,maxBuffer:4096});
 const field=k=>new RegExp('^'+k+'=(.*)$','m').exec(unit)?.[1];const number=k=>/^\\d{1,16}$/.test(field(k)||'')?Number(field(k)):null;
 const states=['active','inactive','failed','activating','deactivating'];const state=field('ActiveState');if(!states.includes(state))throw Error();
 const data={schema:1,executionsObserved:offers,completedReceipts:done,activeState:state,mainPid:number('MainPID'),cpuNs:number('CPUUsageNSec'),memoryPeakBytes:number('MemoryPeak'),exitCode:number('ExecMainCode'),exitStatus:number('ExecMainStatus')};
 process.stdout.write(JSON.stringify(data)+'\\n');
}catch{process.stderr.write('MEDIA_PILOT_COLLECTION=UNAVAILABLE\\n');process.exitCode=1;}\n`;
}
async function createOperationalGuest({ plan, stateRoot, packagePath, getBridgeKey, run = processRun }) {
  validateOperationalPlan(plan); if (typeof getBridgeKey !== "function") fail("private_bridge_key_required");
  const base = await createSshGuest({ stateRoot, packagePath, plan: plan.infrastructure, providerKind: "google", run });
  const admin = path.join(stateRoot, "proof-admin-ed25519"), known = path.join(stateRoot, "proof-known-hosts");
  let address = null, startIntent = false;
  async function remote(script, { signal, timeoutMs, user = "root" }) {
    if (!address) fail("host_unbound"); await protectedPath(admin); await protectedPath(known);
    const nullFile = process.platform === "win32" ? "NUL" : "/dev/null";
    const args = ["-F", nullFile, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + known,
      "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "ProxyCommand=none",
      "-o", "GlobalKnownHostsFile=" + nullFile, "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=10", "-o", "LogLevel=ERROR", "-i", admin,
      "ia4proof@" + address, "sudo -n " + (user === "coordinator" ? "-u ia4tube-coordinator " : "") + "/opt/ia4tube-media/runtime/usr/bin/node -"];
    return run(process.platform === "win32" ? "ssh.exe" : "/usr/bin/ssh", args, { signal, timeoutMs, maxBytes: 16384, stdin: script });
  }
  return Object.freeze({
    prepareLocalIdentity: base.prepareLocalIdentity, createIdentityPayload: base.createIdentityPayload,
    async bindHost(instance, ctx) { await base.bindHost(instance, ctx); const ips = instance.networkInterfaces.flatMap(n => n.accessConfigs.map(a => a.natIP)); if (ips.length !== 1) fail("host_address_invalid"); address = ipv4(ips[0]); },
    preflight: base.preflight, install: base.install,
    async probeInstalled(options) {
      const output = await remote(hostProbeScript(), { ...options, user: "coordinator" });
      const r = JSON.parse(output);
      if (Object.keys(r).sort().join() !== "bootId,controlsProved,convertersStarted,runtimeRevision" || !UUID.test(r.bootId || "") || !HASH.test(r.runtimeRevision || "") || r.controlsProved !== true || r.convertersStarted !== 0) fail("host_receipt_invalid");
      const receipt = { ...r, receiptSha256: sha256(JSON.stringify(r)) }; await atomicWrite(path.join(stateRoot, "operational-host-receipt.json"), receipt); return receipt;
    },
    async startWorker({ missionId, hostEvidence, stopAt, signal, timeoutMs }) {
      if (startIntent) fail("worker_restart_refused"); startIntent = true;
      const key = await getBridgeKey(); if (!Buffer.isBuffer(key) || key.length !== 32) fail("private_bridge_key_invalid");
      try {
        const r = JSON.parse(await remote(startScript({ missionId, workerId: plan.workerId, runtimeRevision: hostEvidence.runtimeRevision, stopAt, keyBase64: key.toString("base64") }), { signal, timeoutMs }));
        if (Object.keys(r).sort().join() !== "active,recurring,stopAt,workerId") fail("start_receipt_invalid"); return r;
      } finally { key.fill(0); }
    },
    async stopWorker(options) { const r = JSON.parse(await remote(stopScript(), options)); if (Object.keys(r).sort().join() !== "nativeTerminationProved,stopped" || typeof r.stopped !== "boolean" || typeof r.nativeTerminationProved !== "boolean") fail("stop_receipt_invalid"); return r; },
    async collectOperational(options) {
      const r = JSON.parse(await remote(collectionScript(), options));
      if (Object.keys(r).sort().join() !== "activeState,completedReceipts,cpuNs,executionsObserved,exitCode,exitStatus,mainPid,memoryPeakBytes,schema" || r.schema !== 1 ||
          !["active", "inactive", "failed", "activating", "deactivating"].includes(r.activeState) ||
          Object.entries(r).some(([k,v]) => k !== "activeState" && v !== null && (!Number.isSafeInteger(v) || v < 0)) ||
          !Number.isSafeInteger(r.executionsObserved) || !Number.isSafeInteger(r.completedReceipts) || r.completedReceipts > r.executionsObserved) fail("collection_receipt_invalid");
      const receipt = { ...r, sanitized: true, sha256: sha256(JSON.stringify(r)) };
      await atomicWrite(path.join(stateRoot, "operational-collection.json"), receipt); return receipt;
    }
  });
}
module.exports = { createOperationalGuest, hostProbeScript, startScript, stopScript, collectionScript };
