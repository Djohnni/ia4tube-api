"use strict";
// No inbound converter API. SSH is administrative installation/proof only,
// strictly pinned to this proof's pre-provisioned host key and exact provider IP.
const fs = require("node:fs/promises"), path = require("node:path"), net = require("node:net");
const { spawn } = require("node:child_process");
const { atomicWrite, protectedPath, protectCreatedFile } = require("./vm-proof-local-state");
const { sha256, MANIFEST } = require("./vm-proof-manifest");
const { validateMetrics, validateFailure } = require("./vm-proof-guest");
const { runDiagnosticProcess, validateInstallDiagnostic } = require("./vm-proof-install-diagnostics");
const { installationScript, collectInstallationScript,finalValidationScript } = require("./vm-proof-install-shell");
const {privateArchiveRun,summaryFromArchive,quiescenceScript}=require('./vm-proof-install-internal');
const {certainInstallFailure,certainInternalFailure,validateCorrectionTicket,validateCaseCorrectionTicket}=require('./vm-proof-google-resolution');
function fail(code) { throw Object.assign(new Error("vm_proof_ssh_" + code), { code: "vm_proof_ssh_" + code }); }
function processRun(command, args, { signal, timeoutMs = 20000, maxBytes = 65536, stdin = null, gcloudConfig = null } = {}) {
  if (gcloudConfig !== null && (!path.isAbsolute(gcloudConfig) || /[\r\n]/.test(gcloudConfig))) fail("auth_config_invalid");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ProgramData: process.env.ProgramData, LANG: "C.UTF-8",
        ...(gcloudConfig === null ? {} : { CLOUDSDK_CONFIG:gcloudConfig, CLOUDSDK_CORE_DISABLE_USAGE_REPORTING:"true", CLOUDSDK_CORE_DISABLE_PROMPTS:"1", USERPROFILE:process.env.USERPROFILE, APPDATA:process.env.APPDATA, LOCALAPPDATA:process.env.LOCALAPPDATA }) }, signal });
    let size = 0, output = "", invalid = false;
    const timer = setTimeout(() => { invalid = true; child.kill("SIGKILL"); }, timeoutMs);
    const onOutput = data => { size += data.length; if (size > maxBytes) { invalid = true; child.kill("SIGKILL"); } else output += data.toString("utf8"); };
    child.stdout.on("data", onOutput); child.stderr.on("data", onOutput);
    child.once("error", () => { invalid = true; });
    child.once("close", code => { clearTimeout(timer); if (invalid || code !== 0) { reject(Object.assign(new Error("vm_proof_ssh_command_failed"), { code: "vm_proof_ssh_command_failed" })); return; }
      resolve(output); });
    child.stdin.on("error", () => {}); child.stdin.end(stdin);
  });
}
function publicIPv4(value) {
  if (net.isIP(value) !== 4 || /^(0|10|127)\./.test(value) || /^169\.254\./.test(value) || /^192\.168\./.test(value) || /^172\.(1[6-9]|2\d|3[01])\./.test(value)) fail("public_ip_invalid");
  return value;
}
async function protectNewFile(file) {
  await protectCreatedFile(file);
}
function makeCloudConfig(hostPrivate, hostPublic, adminPublic) {
  if (!/^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END OPENSSH PRIVATE KEY-----\n?$/.test(hostPrivate) ||
      !/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(hostPublic) ||
      !/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(adminPublic)) fail("generated_identity_invalid");
  return "#cloud-config\nssh_deletekeys: true\nssh_pwauth: false\ndisable_root: true\nssh_keys:\n  ed25519_private: |\n" +
    hostPrivate.trimEnd().split("\n").map(s => "    " + s).join("\n") + "\n  ed25519_public: " + JSON.stringify(hostPublic) +
    "\nusers:\n  - name: ia4proof\n    lock_passwd: true\n    shell: /bin/bash\n    sudo: ['ALL=(ALL) NOPASSWD:ALL']\n    ssh_authorized_keys:\n      - " + JSON.stringify(adminPublic) + "\n";
}
async function createSshGuest({ stateRoot, packagePath, plan, run = processRun, diagnosticRun = runDiagnosticProcess, archiveRun=privateArchiveRun, providerKind = "digitalocean" }) {
  if (!["digitalocean", "google"].includes(providerKind)) fail("provider_invalid");
  const files = { host: path.join(stateRoot, "proof-host-ed25519"), admin: path.join(stateRoot, "proof-admin-ed25519"),
    known: path.join(stateRoot, "proof-known-hosts"), identity: path.join(stateRoot, "proof-identity.json") };
  let identity = null, address = null, installationAttempted = false, installationDiagnostic = null;
  let installAttempt=0,preparedAttempt=1,activePackageSha256=plan.packageSha256,activeBundleRoot='/var/tmp/ia4tube-proof-bundle',internalCollectionCount=0;
  let lastInternalCollection=null;
  let physicalInspection=null,physicalCorrectionPrepared=false,physicalGuestTicket=null,revalidationInvoked=false;
  const executable = process.platform === "win32" ? { ssh: "ssh.exe", scp: "scp.exe", keygen: "ssh-keygen.exe" } : { ssh: "/usr/bin/ssh", scp: "/usr/bin/scp", keygen: "/usr/bin/ssh-keygen" };
  const options = () => ["-F", process.platform === "win32" ? "NUL" : "/dev/null", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + files.known,
    "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "ProxyCommand=none",
    "-o", "GlobalKnownHostsFile=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
    "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
    "-o", "LogLevel=ERROR", "-i", files.admin];
  async function remote(command, cfg = {}) {
    if (!address) fail("host_not_bound");
    return run(executable.ssh, [...options(), "ia4proof@" + address, command], cfg);
  }
  async function diagnosticRemote(script, { signal, timeoutMs }) {
    if (!address) fail("host_not_bound");
    // One invocation only. Even a full PASS marker followed by SSH 255 is
    // uncertain transport, never permission to replay the installer.
    const result = await diagnosticRun(executable.ssh, [...options(), "ia4proof@" + address, "sudo -n bash -s"],
      { signal, timeoutMs: Math.max(1, timeoutMs - 5000), maxBytes: 65536, stdin: script });
    if (!validateInstallDiagnostic(result)) fail("installation_diagnostic_invalid");
    return result;
  }
  async function collectInternal({signal,timeoutMs}){
    if(!plan.resolution)return null;
    const attempt=installAttempt||1,root='/var/tmp/ia4tube-proof-diagnostics',sub='internal-attempt-'+attempt;
    // Binary archive is captured directly in process memory and written only to
    // the private ACL directory. Never send its bytes to tool stdout/chat/logs.
    const script=`sudo -n bash -c 'set -euo pipefail; export PATH=/usr/sbin:/usr/bin:/sbin:/bin; cd ${root}; `+
      `[[ -d ${sub} && ! -L ${sub} && $(stat -c %u ${sub}) == 0 && $(stat -c %a ${sub}) == 700 ]]; `+
      `[[ $(du -sb ${sub} | cut -f1) -le 786432 ]]; `+
      `[[ -z $(find ${sub} -mindepth 1 \\( ! -type f -o ! -uid 0 -o -perm /077 -o -links +1 \\) -print -quit) ]]; `+
      `tar --format=ustar --owner=0 --group=0 -cf - -- ${sub}'`;
    const archive=await archiveRun(executable.ssh,[...options(),'ia4proof@'+address,script],{signal,timeoutMs:Math.min(timeoutMs,45000),maxBytes:1048576});
    const archiveFile=path.join(stateRoot,`internal-attempt-${attempt}-collection-${++internalCollectionCount}.tar`);
    // Preserve bounded unknown diagnostics even if safe-schema validation fails.
    await fs.writeFile(archiveFile,archive,{flag:'wx',mode:0o600});await protectNewFile(archiveFile);
    const summary=summaryFromArchive(archive,{missionId:identity.missionId,attempt,packageSha256:activePackageSha256});
    const result={collected:true,privateRetained:true,archiveSha256:sha256(archive),archiveBytes:archive.length,summary};
    await atomicWrite(path.join(stateRoot,`internal-attempt-${attempt}-safe-${internalCollectionCount}.json`),result);
    lastInternalCollection=result;return result;
  }
  async function assertQuiescent({signal}){
    const out=await remote('sudo -n timeout --signal=TERM --kill-after=5s 15s /opt/node-v24.15.0-linux-x64/bin/node -',{signal,timeoutMs:20000,stdin:quiescenceScript()});
    const match=/^VM_INSTALL_QUIESCENCE=([a-f0-9]{64})\s*$/.exec(out);if(!match)fail('correction_processes_not_quiescent');return match[1];
  }
  async function reviewedRepair(ticket,{signal}){
    const scripts={};
    for(const key of ['partialStateScript','repairScript']){
      const file=ticket[key+'Path'];await protectedPath(file);const b=await fs.readFile(file);
      if(b.length>32768||sha256(b)!==ticket[key+'Sha256']||!b.toString('utf8').startsWith('#!/bin/bash\n')||b.includes(0))fail('correction_script_changed');scripts[key]=b.toString('utf8');
    }
    await assertQuiescent({signal});
    const check=await remote('sudo -n timeout --signal=TERM --kill-after=5s 45s bash -s',{signal,timeoutMs:50000,stdin:scripts.partialStateScript});
    const m=/^VM_INSTALL_PARTIAL_STATE=([a-f0-9]{64}):TERMINATED:OWNED_RESIDUALS_ONLY\s*$/.exec(check);if(!m)fail('partial_state_unconfirmed');
    const repair=await remote('sudo -n timeout --signal=TERM --kill-after=5s 60s bash -s',{signal,timeoutMs:65000,
      stdin:'export IA4TUBE_EXPECTED_PARTIAL_STATE_SHA256='+m[1]+'\n'+scripts.repairScript});
    if(!/^VM_INSTALL_REPAIR=PASS\s*$/.test(repair))fail('correction_result_unconfirmed');
    await assertQuiescent({signal});return m[1];
  }
  async function inspectPhysical({signal}){
    const quiescenceSha256=await assertQuiescent({signal});
    await remote('sudo -n timeout --signal=TERM --kill-after=5s 30s bash -s',{signal,timeoutMs:35000,stdin:finalValidationScript()});
    const text=await remote('sudo -n /opt/node-v24.15.0-linux-x64/bin/node -',{signal,timeoutMs:15000,stdin:String.raw`
const fs=require('node:fs'),crypto=require('node:crypto');
const p='/var/lib/ia4tube-media/state/proof-run/evidence.json';
const st=fs.lstatSync(p);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>32768||(st.mode&0o077))process.exit(77);
const r=JSON.parse(fs.readFileSync('/opt/ia4tube-media/installation.json','utf8'));
if(!/^[a-f0-9]{64}$/.test(r.runtimeRevision||''))process.exit(77);
console.log(JSON.stringify({priorEvidenceSha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),candidateRuntimeRevision:r.runtimeRevision}));
`});
    const data=JSON.parse(text);if(Object.keys(data).sort().join(',')!=='candidateRuntimeRevision,priorEvidenceSha256'||Object.values(data).some(v=>!/^[a-f0-9]{64}$/.test(v)))fail('physical_identity_invalid');
    return {priorTerminationConfirmed:true,quiescenceSha256,candidatePackageSha256:activePackageSha256,...data};
  }
  async function validatePhysicalReceipt(out){
    const marker=out.split('\n').find(v=>v.startsWith('VM_PROOF_REVALIDATION='));if(!marker)fail('revalidation_receipt_missing');
    const r=JSON.parse(marker.slice('VM_PROOF_REVALIDATION='.length)),t=physicalGuestTicket,e=r?.evidence;
    const selected=t?MANIFEST.cases.filter(c=>t.caseIds.includes(c.id)):[],attempts=selected.flatMap(c=>c.attempts);
    if(!t||Object.keys(r).sort().join(',')!=='candidatePackageSha256,candidateRuntimeRevision,correctionSha256,evidence,index,priorEvidenceSha256,reviewSha256,schema,ticketSha256'||
      r.schema!==1||r.index!==1||r.ticketSha256!==sha256(JSON.stringify(t))||
      ['candidatePackageSha256','candidateRuntimeRevision','correctionSha256','priorEvidenceSha256','reviewSha256'].some(k=>r[k]!==t[k])||
      !e||Object.keys(e).sort().join(',')!=='allPassed,allTerminated,attemptIds,cases,failure,launches,metrics,schema,syntheticOnly'||
      e.schema!==1||e.syntheticOnly!==true||typeof e.allPassed!=='boolean'||typeof e.allTerminated!=='boolean'||
      !validateFailure(e.failure)||!validateMetrics(e.metrics)||!Array.isArray(e.cases)||e.cases.length>selected.length||!Array.isArray(e.attemptIds)||
      !(e.launches===null?e.attemptIds.length===0&&e.cases.length===0&&!e.allTerminated:Number.isInteger(e.launches)&&e.launches>=0&&e.launches<=attempts.length&&e.attemptIds.length===e.launches)||
      e.attemptIds.some((id,i)=>id!==attempts[i])||e.cases.some((c,i)=>Object.keys(c).sort().join(',')!=='failure,id,nativeLaunches,passed,terminationProved'||
        c.id!==selected[i].id||typeof c.passed!=='boolean'||typeof c.terminationProved!=='boolean'||!validateFailure(c.failure)||
        (c.passed?c.failure!==null:c.failure===null)||!Number.isInteger(c.nativeLaunches)||c.nativeLaunches<0||c.nativeLaunches>selected[i].attempts.length)||
      (e.allPassed&&(!e.allTerminated||e.launches!==attempts.length||e.cases.length!==selected.length||e.cases.some(c=>!c.passed||!c.terminationProved))))fail('revalidation_evidence_invalid');
    await atomicWrite(path.join(stateRoot,'synthetic-revalidation-1.json'),r);return r;
  }
  async function initialize({ missionId }) {
    // No private key is generated when the package changed or permissions are
    // not acceptable. Both checks precede any provider creation request.
    const bytes = await fs.readFile(packagePath); if (bytes.length > 64 * 1024 * 1024 || sha256(bytes) !== plan.packageSha256) fail("package_changed");
    try {
      const prior = JSON.parse(await fs.readFile(files.identity, "utf8"));
      if (prior.missionId !== missionId || prior.planSha256 !== plan.approvalSha256) fail("identity_wrong_mission");
      identity = prior;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      for (const privateFile of [files.host, files.admin]) {
        try { await fs.lstat(privateFile); fail("unowned_key_present"); } catch (e) { if (e.code !== "ENOENT") throw e; }
        await run(executable.keygen, ["-q", "-t", "ed25519", "-N", "", "-C", "ia4tube-ephemeral-proof", "-f", privateFile]);
        await protectNewFile(privateFile); await protectNewFile(privateFile + ".pub");
      }
      const hostPublic = (await fs.readFile(files.host + ".pub", "utf8")).trim(), adminPublic = (await fs.readFile(files.admin + ".pub", "utf8")).trim();
      identity = { missionId, planSha256: plan.approvalSha256, hostPublic, adminPublic };
      await atomicWrite(files.identity, identity); await protectNewFile(files.identity);
    }
    for (const privateFile of [files.host, files.admin]) await protectedPath(privateFile);
    const hostPrivate = await fs.readFile(files.host, "utf8");
    if (providerKind === "google") identity.startupScript = require("./vm-proof-google-bootstrap").makeGoogleBootstrap(hostPrivate.replaceAll("\r\n", "\n"), identity.hostPublic, identity.adminPublic);
    else identity.cloudConfig = makeCloudConfig(hostPrivate.replaceAll("\r\n", "\n"), identity.hostPublic, identity.adminPublic);
  }
  return {
    prepareLocalIdentity: initialize,
    createIdentityPayload() { if (!identity) fail("identity_not_prepared"); return providerKind === "google" ? { startupScript: identity.startupScript } : { cloudConfig: identity.cloudConfig, adminPublicKey: identity.adminPublic }; },
    async bindHost(droplet, { missionId }) {
      if (!identity) await initialize({ missionId });
      const ips = providerKind === "google" ? (droplet.networkInterfaces || []).flatMap(n => (n.accessConfigs || []).map(a=>a.natIP)) : droplet.networks?.v4?.filter(n => n.type === "public").map(n => n.ip_address) || [];
      if (ips.length !== 1) fail("public_ip_ambiguous"); address = publicIPv4(ips[0]);
      await fs.writeFile(files.known, address + " " + identity.hostPublic + "\n", { mode: 0o600, flag: "w" });
      await protectNewFile(files.known);
    },
    async preflight({ signal, timeoutMs }) {
      // Provider 'active' can precede sshd. Only retry this inert admission
      // check, retaining the pinned key; no installer/converter is retried.
      const deadline = Date.now() + timeoutMs;
      while (true) {
        if (signal?.aborted || Date.now() >= deadline) fail("host_not_ready");
        try { await remote(providerKind === "google" ? "sudo -n grep -qx GOOGLE_BOOTSTRAP=PASS /run/ia4tube-google-proof-ready" : "true", { signal, timeoutMs: Math.min(10000, deadline - Date.now()) }); break; }
        catch { if (signal?.aborted || Date.now() >= deadline) fail("host_not_ready"); }
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
      }
      // Wait for cloud-init completion without skipping pinned host verification.
      if (providerKind !== "google") await remote("sudo -n cloud-init status --wait", { signal, timeoutMs });
      const bytes = await fs.readFile(packagePath); if (sha256(bytes) !== plan.packageSha256) fail("package_changed");
      await run(executable.scp, [...options(), "--", packagePath, "ia4proof@" + address + ":/var/tmp/ia4tube-proof-bundle.tar"], { signal, timeoutMs });
      // Archive is produced by our fixed builder and hash-checked both sides.
      // Extraction is unprivileged; installer is not yet invoked.
      await remote("mkdir -m 700 /var/tmp/ia4tube-proof-bundle && cd /var/tmp/ia4tube-proof-bundle && " +
        "printf '%s  %s\\n' '" + plan.packageSha256 + "' /var/tmp/ia4tube-proof-bundle.tar | sha256sum -c - >/dev/null && " +
        "tar --no-same-owner --no-same-permissions -xf /var/tmp/ia4tube-proof-bundle.tar", { signal, timeoutMs });
      const out = await remote("sudo -n bash /var/tmp/ia4tube-proof-bundle/" + MANIFEST.hostPreflight, { signal, timeoutMs });
      if (!/^VM_HOST_PREFLIGHT=PASS$/m.test(out)) fail("preflight_failed");
      return { passed: true, convertersStarted: 0 };
    },
    async install({ signal, timeoutMs,attempt=1 }) {
      if(installationAttempted&&(!plan.resolution||attempt!==preparedAttempt||attempt!==installAttempt+1||attempt>3))fail('installation_repeat_refused');
      if(!installationAttempted&&attempt!==1)fail('installation_repeat_refused');
      installationAttempted = true;
      installAttempt=attempt;
      installationDiagnostic = await diagnosticRemote(installationScript(plan.resolution?{attempt,missionId:identity.missionId,packageSha256:activePackageSha256,bundleRoot:activeBundleRoot}:{}), { signal, timeoutMs });
      try { await atomicWrite(path.join(stateRoot, plan.resolution?`installation-diagnostics-${attempt}.json`:"installation-diagnostics.json"), {
        schema: 1, missionId: identity.missionId, planSha256: plan.approvalSha256, observation: installationDiagnostic
      }); } catch { throw Object.assign(new Error("vm_proof_ssh_installation_persistence_failed"), {
        code: "vm_proof_ssh_installation_persistence_failed", diagnostic: installationDiagnostic }); }
      if (!installationDiagnostic.installationPassed) throw Object.assign(new Error("vm_proof_ssh_installation_" + installationDiagnostic.classification), {
        code: "vm_proof_ssh_installation_" + installationDiagnostic.classification, diagnostic: installationDiagnostic });
      return { passed: true, convertersStarted: 0, diagnostic: installationDiagnostic };
    },
    async prepareCorrection({ticket,previousDiagnostic,signal,timeoutMs}){
      if(!plan.resolution||!certainInstallFailure(previousDiagnostic)||previousDiagnostic!==installationDiagnostic||installAttempt>=3)fail('correction_not_eligible');
      if(!certainInternalFailure(lastInternalCollection,{missionId:identity.missionId,attempt:installAttempt,packageSha256:activePackageSha256}))fail('correction_internal_termination_uncertain');
      validateCorrectionTicket(ticket,{missionId:identity.missionId,attempt:installAttempt+1,diagnostic:previousDiagnostic});
      const scripts={};
      for(const key of ['partialStateScript','repairScript']){
        const file=ticket[key+'Path'];await protectedPath(file);const bytes=await fs.readFile(file);
        if(bytes.length>32768||sha256(bytes)!==ticket[key+'Sha256'])fail('correction_script_changed');
        const text=bytes.toString('utf8');if(!text.startsWith('#!/bin/bash\n')||text.includes('\0'))fail('correction_script_invalid');scripts[key]=text;
      }
      const bytes=await fs.readFile(ticket.packagePath);if(bytes.length>67108864||sha256(bytes)!==ticket.packageSha256)fail('package_changed');
      async function checkQuiescence(){
        const q=await remote('sudo -n timeout --signal=TERM --kill-after=5s 15s /opt/node-v24.15.0-linux-x64/bin/node -',{signal,timeoutMs:20000,stdin:quiescenceScript()});
        if(!/^VM_INSTALL_QUIESCENCE=[a-f0-9]{64}\s*$/.test(q))fail('correction_processes_not_quiescent');
      }
      await checkQuiescence();
      const check=await remote('sudo -n timeout --signal=TERM --kill-after=5s 45s bash -s',{signal,timeoutMs:50000,stdin:scripts.partialStateScript});
      const m=/^VM_INSTALL_PARTIAL_STATE=([a-f0-9]{64}):TERMINATED:OWNED_RESIDUALS_ONLY\s*$/.exec(check);
      if(!m)fail('partial_state_unconfirmed');
      // Both scripts and their test/review evidence are bound in the durable
      // controller ticket before this call. No built-in recursive cleanup.
      const repair=await remote('sudo -n timeout --signal=TERM --kill-after=5s 60s bash -s',{signal,timeoutMs:65000,
        stdin:'export IA4TUBE_EXPECTED_PARTIAL_STATE_SHA256='+m[1]+'\n'+scripts.repairScript});
      if(!/^VM_INSTALL_REPAIR=PASS\s*$/.test(repair))fail('correction_result_unconfirmed');
      await checkQuiescence();
      const nextRoot='/var/tmp/ia4tube-proof-bundle-attempt-'+ticket.attempt;
      const nextArchive=nextRoot+'.tar';
      await run(executable.scp,[...options(),'--',ticket.packagePath,'ia4proof@'+address+':'+nextArchive],{signal,timeoutMs:30000});
      await remote(`mkdir -m 700 ${nextRoot} && cd ${nextRoot} && printf '%s  %s\\n' '${ticket.packageSha256}' ${nextArchive} | sha256sum -c - >/dev/null && tar --no-same-owner --no-same-permissions -xf ${nextArchive}`,{signal,timeoutMs:20000});
      activePackageSha256=ticket.packageSha256;activeBundleRoot=nextRoot;preparedAttempt=ticket.attempt;
      return {previousEnded:true,ownedResidualsOnly:true,convertersStarted:0,partialStateSha256:m[1],packageSha256:activePackageSha256};
    },
    async collectInstallationDiagnostics({ missionId, signal, timeoutMs }) {
      const collectionDeadline=Date.now()+timeoutMs;
      const diagnostic = await diagnosticRemote(collectInstallationScript({attempt:installAttempt||1,resolution:!!plan.resolution}), { signal, timeoutMs:plan.resolution?Math.min(20000,timeoutMs):timeoutMs });
      const collectionSucceeded = diagnostic.exitCode === 0 && !diagnostic.timedOut && !diagnostic.aborted &&
        !diagnostic.spawnFailed && !diagnostic.stdinFailed && !diagnostic.collectionError && !diagnostic.remoteCaptureFailed &&
        diagnostic.signal === null && !diagnostic.protocolInvalid && diagnostic.markers.length > 0;
      // This is an independent observation. It does not rewrite the initial
      // transport result, and does not admit conversions after uncertain install.
      let internal=null;
      if(plan.resolution)try{
        const remaining=collectionDeadline-Date.now()-2000;if(remaining<=0)fail('internal_collection_deadline');
        internal=await collectInternal({signal,timeoutMs:remaining});
      }catch(error){internal={collected:false,error:/^vm_proof_ssh_[a-z_]+$/.test(error.code||'')?error.code:'vm_proof_ssh_internal_collection_failed'};}
      const safe = { schema: 1, missionId, planSha256: plan.approvalSha256, collectionSucceeded,internal,
        initialObservation: installationDiagnostic, collectedObservation: diagnostic };
      try { await atomicWrite(path.join(stateRoot, plan.resolution?`installation-collection-${installAttempt||1}-${internalCollectionCount}.json`:"installation-collection.json"), safe); }
      catch { throw Object.assign(new Error("vm_proof_ssh_installation_collection_persistence_failed"), {
        code:"vm_proof_ssh_installation_collection_persistence_failed",diagnostic }); }
      return { sanitized: true, sha256: sha256(JSON.stringify(safe)), collectionSucceeded, diagnostic,internal };
    },
    async runSequence({ signal, timeoutMs }) {
      const out = await remote("sudo -n -u ia4tube-coordinator /opt/ia4tube-media/runtime/usr/bin/node /opt/ia4tube-media/proof/" + MANIFEST.guestDispatcher + " --run", { signal, timeoutMs });
      const marker = out.split("\n").find(v => v.startsWith("VM_PROOF_SEQUENCE="));
      if (!marker) fail("sequence_receipt_missing");
      return JSON.parse(marker.slice("VM_PROOF_SEQUENCE=".length));
    },
    async inspectPhysicalFailure({signal}){
      if(!plan.resolution||!installationDiagnostic?.installationPassed)fail('physical_correction_not_eligible');
      physicalInspection=await inspectPhysical({signal});return physicalInspection;
    },
    async prepareSequenceCorrection({ticket,affectedCaseIds,signal,notAfterMs}){
      if(!plan.resolution||!physicalInspection||physicalCorrectionPrepared)fail('physical_correction_not_eligible');
      validateCaseCorrectionTicket(ticket,{...physicalInspection,missionId:identity.missionId,affectedCaseIds});
      const before=await inspectPhysical({signal});
      if(before.priorEvidenceSha256!==ticket.priorEvidenceSha256||before.candidateRuntimeRevision!==ticket.candidateRuntimeRevision)fail('physical_candidate_changed');
      const partialStateSha256=await reviewedRepair(ticket,{signal});
      const after=await inspectPhysical({signal});
      if(after.priorEvidenceSha256!==before.priorEvidenceSha256||after.candidateRuntimeRevision!==before.candidateRuntimeRevision)fail('physical_candidate_changed');
      if(!Number.isSafeInteger(notAfterMs)||notAfterMs<=Date.now())fail('physical_correction_deadline');
      const guestTicket={schema:1,kind:'synthetic-case-revalidation',index:1,missionId:identity.missionId,planSha256:plan.approvalSha256,
        priorEvidenceSha256:after.priorEvidenceSha256,reviewSha256:ticket.reviewSha256,correctionSha256:ticket.repairScriptSha256,
        quiescenceSha256:after.quiescenceSha256,candidatePackageSha256:activePackageSha256,candidateRuntimeRevision:after.candidateRuntimeRevision,
        caseIds:ticket.caseIds,notAfterMs,priorTerminationConfirmed:true};
      const encoded=Buffer.from(JSON.stringify(guestTicket)).toString('base64');
      await remote('sudo -n /opt/node-v24.15.0-linux-x64/bin/node -',{signal,timeoutMs:15000,stdin:`
const fs=require('node:fs'),cp=require('node:child_process');
const p='/etc/ia4tube-media/revalidation-1.json';
const gid=Number(cp.execFileSync('/usr/bin/id',['-g','ia4tube-coordinator'],{encoding:'utf8'}));
if(!Number.isInteger(gid)||gid<=0)process.exit(77);
fs.writeFileSync(p,Buffer.from('${encoded}','base64'),{flag:'wx',mode:0o440});fs.chownSync(p,0,gid);fs.chmodSync(p,0o440);
console.log('VM_PHYSICAL_CORRECTION_TICKET=READY');`});
      physicalGuestTicket=guestTicket;physicalCorrectionPrepared=true;
      return {previousEnded:true,ownedResidualsOnly:true,partialStateSha256,quiescenceSha256:after.quiescenceSha256,
        candidatePackageSha256:activePackageSha256,candidateRuntimeRevision:after.candidateRuntimeRevision};
    },
    async runRevalidation({signal,timeoutMs}){
      if(!physicalCorrectionPrepared||revalidationInvoked)fail('physical_correction_not_prepared');revalidationInvoked=true;
      const out=await remote('sudo -n -u ia4tube-coordinator /opt/ia4tube-media/runtime/usr/bin/node /opt/ia4tube-media/proof/'+MANIFEST.guestDispatcher+' --revalidate /etc/ia4tube-media/revalidation-1.json',{signal,timeoutMs});
      return validatePhysicalReceipt(out);
    },
    async collectRevalidation({signal,timeoutMs}){
      if(!physicalCorrectionPrepared||!revalidationInvoked)fail('physical_correction_not_prepared');
      const out=await remote('sudo -n -u ia4tube-coordinator /opt/ia4tube-media/runtime/usr/bin/node /opt/ia4tube-media/proof/'+MANIFEST.guestDispatcher+' --collect-revalidation 1',{signal,timeoutMs});
      return validatePhysicalReceipt(out);
    },
    async collect({ missionId, signal, timeoutMs }) {
      const out = await remote("sudo -n -u ia4tube-coordinator /opt/ia4tube-media/runtime/usr/bin/node /opt/ia4tube-media/proof/" + MANIFEST.guestDispatcher + " --collect", { signal, timeoutMs });
      const marker = out.split("\n").find(v => v.startsWith("VM_PROOF_EVIDENCE="));
      if (!marker) fail("evidence_missing");
      const evidence = JSON.parse(marker.slice("VM_PROOF_EVIDENCE=".length));
      // Closed schema: never export raw stdout/stderr, environment, paths, media
      // or provider payloads. All artifact content is synthetic status evidence.
      if (Object.keys(evidence).some(k => !["schema", "cases", "launches", "attemptIds", "allTerminated", "syntheticOnly", "metrics", "failure"].includes(k)) ||
        evidence.schema !== 1 || evidence.syntheticOnly !== true || !Array.isArray(evidence.cases) || evidence.cases.length > 10 ||
        !validateMetrics(evidence.metrics) || !validateFailure(evidence.failure) || typeof evidence.allTerminated !== "boolean" ||
        !Array.isArray(evidence.attemptIds) || (evidence.launches === null ? evidence.attemptIds.length !== 0 || evidence.allTerminated !== false || evidence.cases.length !== 0 :
          !Number.isSafeInteger(evidence.launches) || evidence.launches < 0 || evidence.launches > MANIFEST.maxLaunches || evidence.attemptIds.length !== evidence.launches) ||
        evidence.attemptIds.some((id, i) => id !== MANIFEST.cases.flatMap(c => c.attempts)[i]) ||
        evidence.cases.some((r, i) => Object.keys(r).sort().join(",") !== "failure,id,nativeLaunches,passed,terminationProved" || r.id !== MANIFEST.cases[i]?.id ||
          !validateFailure(r.failure) || (r.passed ? r.failure !== null : r.failure === null) ||
          typeof r.passed !== "boolean" || typeof r.terminationProved !== "boolean" || !Number.isSafeInteger(r.nativeLaunches) || r.nativeLaunches < 0 || r.nativeLaunches > MANIFEST.cases[i].attempts.length)) fail("evidence_schema_invalid");
      const safe = { ...evidence, missionId, planSha256: plan.approvalSha256 };
      await atomicWrite(path.join(stateRoot, "synthetic-evidence.json"), safe);
      return { sanitized: true, sha256: sha256(JSON.stringify(safe)),evidence };
    }
  };
}
module.exports = { createSshGuest, makeCloudConfig, publicIPv4, processRun };
