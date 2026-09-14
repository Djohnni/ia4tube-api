"use strict";
// Fixed synthetic sequence only. This file contains no provider API/credential.
const fs = require("node:fs/promises"), path = require("node:path"), { spawn } = require("node:child_process");
const { MANIFEST, sha256, canonical } = require("./vm-proof-manifest");
const STATE = "/var/lib/ia4tube-media/state/proof-run";
const ROOT = "/opt/ia4tube-media/proof";
function fail(code) { throw new Error("vm_proof_guest_" + code); }
const FAILURE_STAGES = new Set(["platform", "installation-record", "coordinator-identity", "launcher-identity", "executor-configuration",
  "runtime-probe", "capabilities", "scratch-quota", "case-body", "guest-parser", "guest-launch"]);
const FAILURE_CODES = new Set(["assertion_failed", "missing_path", "permission_denied", "already_exists", "unexpected_error", "subprocess_failed",
  "media_process_linux_installed_path_invalid", "media_process_linux_installed_record_invalid", "media_process_linux_installed_launcher_invalid",
  "media_process_linux_installed_path_symlink", "media_process_linux_installed_path_owner", "media_process_linux_installed_path_writable",
  "media_process_linux_installed_path_type", "media_process_linux_installed_path_hardlink", "media_process_linux_installed_file_writable",
  "media_process_linux_capabilities_unavailable", "media_process_installed_configuration_invalid", "media_process_linux_configuration_invalid",
  "media_process_path_invalid", "vm_proof_guest_case_receipt_invalid", "vm_proof_guest_total_receipt_invalid",
  "vm_proof_guest_total_receipt_missing", "vm_proof_guest_duplicate_metrics", "vm_proof_guest_metrics_invalid"]);
for (const stage of ["host_identity", "installed_accounts", "installed_caller", "installed_ancestry", "installed_paths", "volume_mount", "volume_backing",
  "pidfd", "jail_prepare", "cgroup", "clone", "assignment", "release", "child_namespace", "child_privileges", "child_probe", "child_stdio", "child_exec", "child_failed", "cleanup"])
  FAILURE_CODES.add("media_process_linux_probe_" + stage);
function validateFailure(value) {
  return value === null || value && Object.keys(value).sort().join(",") === "code,stage" && FAILURE_STAGES.has(value.stage) && FAILURE_CODES.has(value.code);
}
function closedFailure(error, stage = "case-body") {
  const mapping = { ERR_ASSERTION: "assertion_failed", ENOENT: "missing_path", EACCES: "permission_denied", EPERM: "permission_denied", EEXIST: "already_exists" };
  const value = mapping[error?.code] || (FAILURE_CODES.has(error?.code) ? error.code : FAILURE_CODES.has(error?.message) ? error.message : "unexpected_error");
  return { stage: FAILURE_STAGES.has(stage) ? stage : "case-body", code: value };
}
function validateMetrics(metrics) {
  return metrics === null || metrics && Object.keys(metrics).sort().join(",") === "decodedSeconds,peakTasks,peakTreeMemoryBytes,preparationCpuMs,preparationElapsedMs,sequenceElapsedMs,sourceBytes" &&
    Object.values(metrics).every(n => Number.isFinite(n) && n >= 0 && n <= 10 ** 13);
}
function selectedCases(caseIds = MANIFEST.cases.map(c=>c.id)) {
  if(!Array.isArray(caseIds)||!caseIds.length||caseIds[0]!==MANIFEST.cases[0].id||caseIds.length>MANIFEST.cases.length)fail("case_selection_invalid");
  const selected=MANIFEST.cases.filter(c=>caseIds.includes(c.id));
  if(canonical(selected.map(c=>c.id))!==canonical(caseIds))fail("case_selection_invalid");return selected;
}
function parseEvidence(output, code, sequenceElapsedMs = null, caseIds = MANIFEST.cases.map(c=>c.id)) {
  const expectedCases=selectedCases(caseIds), expectedAttempts=expectedCases.flatMap(c=>c.attempts);
  const cases = [], totals = []; let metrics = null;
  for (const line of output.split(/\r?\n/)) {
    // Read only the synthetic pipeline's closed numeric measurements. Never
    // retain raw diagnostics, execution paths/IDs, source bytes or environment.
    const diagnostic = line.match(/^\s*# (\{.*\})$/);
    if (diagnostic) {
      let row; try { row = JSON.parse(diagnostic[1]); } catch { continue; }
      if (row.case === "installed-pipeline") {
        if (metrics !== null) fail("duplicate_metrics");
        metrics = { sequenceElapsedMs, sourceBytes: row.source?.size, decodedSeconds: row.decoded?.seconds,
          preparationElapsedMs: row.prepared?.elapsedMs, preparationCpuMs: row.prepared?.metrics?.cpuMs,
          peakTreeMemoryBytes: row.prepared?.metrics?.peakTreeMemoryBytes, peakTasks: row.prepared?.metrics?.peakTasks };
        if (!validateMetrics(metrics)) fail("metrics_invalid");
      }
    }
    const match = line.match(/^\s*(?:# )?VM_INSTALLED_(CASE|TOTAL)=(\{.*\})$/);
    if (!match) continue;
    const row = JSON.parse(match[2]);
    if (match[1] === "CASE") {
      const expected = expectedCases[cases.length];
      if (!expected || Object.keys(row).sort().join(",") !== "failure,id,nativeLaunches,passed,terminationProved" || row.id !== expected.id ||
        typeof row.passed !== "boolean" || typeof row.terminationProved !== "boolean" ||
        !validateFailure(row.failure) || (row.passed ? row.failure !== null : row.failure === null) ||
        !Number.isSafeInteger(row.nativeLaunches) || row.nativeLaunches < 0 || row.nativeLaunches > expected.attempts.length) fail("case_receipt_invalid");
      cases.push(row);
    } else {
      if (Object.keys(row).sort().join(",") !== "allTerminated,attemptIds,launches" || typeof row.allTerminated !== "boolean" ||
        !Number.isSafeInteger(row.launches) || row.launches < 0 || row.launches > expectedAttempts.length ||
        !Array.isArray(row.attemptIds) || row.attemptIds.length !== row.launches ||
        row.attemptIds.some((id, i) => id !== expectedAttempts[i])) fail("total_receipt_invalid");
      totals.push(row);
    }
  }
  if (totals.length !== 1 || totals[0].launches !== cases.reduce((n, c) => n + c.nativeLaunches, 0)) fail("total_receipt_missing");
  const allPassed = code === 0 && (!caseIds.includes("source-limit") || metrics !== null) && cases.length === expectedCases.length && cases.every((c, i) => c.passed && c.terminationProved && c.nativeLaunches === expectedCases[i].attempts.length);
  return { schema: 1, cases, launches: totals[0].launches, attemptIds: totals[0].attemptIds, allTerminated: totals[0].allTerminated,
    syntheticOnly: true, metrics, failure: cases.find(c => !c.passed)?.failure || null, allPassed };
}
async function writeExclusive(file, value) {
  const out = await fs.open(file, "wx", 0o600);
  try { await out.writeFile(canonical(value)); await out.sync(); } finally { await out.close(); }
  const dir = await fs.open(path.dirname(file), "r"); try { await dir.sync(); } finally { await dir.close(); }
}
async function launchSequence({ timeoutMs = MANIFEST.sequenceSeconds * 1000, caseIds = null } = {}) {
  if(caseIds!==null)selectedCases(caseIds);
  const began = performance.now();
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", MANIFEST.testFile], {
      cwd: ROOT, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/opt/ia4tube-media/runtime/usr/bin:/usr/bin:/bin", LANG: "C.UTF-8",
        CALENDAR_VM_INSTALLED_TEST: "1", CALENDAR_MEDIA_LINUX_PHYSICAL: "1", CALENDAR_MEDIA_LINUX_CGROUP_ROOT: "/sys/fs/cgroup/ia4tube-media-vm",
        CALENDAR_MEDIA_LINUX_LAUNCH_MODE: "installed", FFMPEG_TEST_BINARY: "/usr/bin/ffmpeg",
        ...(caseIds===null?{}:{CALENDAR_VM_REVALIDATION_CASE_IDS:JSON.stringify(caseIds)}) } });
    let bytes = 0, output = "", failed = false;
    const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, timeoutMs);
    const append = b => { bytes += b.length; if (bytes > 512 * 1024) { failed = true; child.kill("SIGKILL"); } else output += b.toString("utf8"); };
    child.stdout.on("data", append); child.stderr.on("data", append); child.on("error", () => { failed = true; });
    child.once("close", code => { clearTimeout(timer); resolve({ code: failed ? 1 : code, output, elapsedMs: Math.round(performance.now() - began) }); });
  });
}
async function run() {
  if (process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() === 0) fail("nonroot_linux_required");
  const real = await fs.realpath(__dirname); if (real !== ROOT + "/scripts/validation") fail("installed_proof_required");
  const dir = await fs.lstat(STATE); if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077)) fail("private_state_required");
  await writeExclusive(path.join(STATE, "intent.json"), { schema: 1, manifestSha256: sha256(canonical(MANIFEST)),
    startedAt: Date.now(), caseIds: MANIFEST.cases.map(c => c.id), attemptIds: MANIFEST.cases.flatMap(c => c.attempts), retries: 0 });
  let evidence;
  try { const result = await launchSequence(); evidence = parseEvidence(result.output, result.code, result.elapsedMs); }
  catch (error) { evidence = { schema: 1, cases: [], launches: null, attemptIds: [], allTerminated: false, syntheticOnly: true,
    metrics: null, failure: closedFailure(error, "guest-parser"), allPassed: false }; }
  await writeExclusive(path.join(STATE, "evidence.json"), evidence);
  return evidence;
}
async function collect() {
  const st = await fs.lstat(path.join(STATE, "evidence.json")); if (!st.isFile() || st.isSymbolicLink() || st.size > 32768) fail("evidence_file_invalid");
  const { allPassed, ...evidence } = JSON.parse(await fs.readFile(path.join(STATE, "evidence.json"), "utf8"));
  return evidence;
}
const REVALIDATION_TICKET_KEYS="candidatePackageSha256,candidateRuntimeRevision,caseIds,correctionSha256,index,kind,missionId,notAfterMs,planSha256,priorEvidenceSha256,priorTerminationConfirmed,quiescenceSha256,reviewSha256,schema";
function validateRevalidationTicket(ticket,{now=Date.now(),index=ticket?.index,usedAdditionalLaunches=0,priorEvidence=null,runtimeRevision=null}={}) {
  if(!ticket||Object.keys(ticket).sort().join(",")!==REVALIDATION_TICKET_KEYS||ticket.schema!==1||ticket.kind!=="synthetic-case-revalidation"||
    !Number.isSafeInteger(ticket.index)||ticket.index!==index||ticket.index<1||ticket.index>8||!/^[-a-zA-Z0-9]{8,80}$/.test(ticket.missionId)||
    ticket.priorTerminationConfirmed!==true||!Number.isSafeInteger(ticket.notAfterMs)||ticket.notAfterMs<=now||ticket.notAfterMs-now>7200000||
    !Number.isSafeInteger(usedAdditionalLaunches)||usedAdditionalLaunches<0||usedAdditionalLaunches>8)fail("revalidation_ticket_invalid");
  for(const key of ["candidatePackageSha256","candidateRuntimeRevision","correctionSha256","planSha256","priorEvidenceSha256","quiescenceSha256","reviewSha256"])if(!/^[a-f0-9]{64}$/.test(ticket[key]))fail("revalidation_ticket_invalid");
  const selected=selectedCases(ticket.caseIds),launches=selected.reduce((n,c)=>n+c.attempts.length,0);
  if(usedAdditionalLaunches+launches>8)fail("revalidation_budget_exceeded");
  if(runtimeRevision!==null&&runtimeRevision!==ticket.candidateRuntimeRevision)fail("revalidation_runtime_changed");
  if(priorEvidence!==null){
    if(priorEvidence.allPassed!==false||!validateFailure(priorEvidence.failure)||priorEvidence.failure===null||!Array.isArray(priorEvidence.cases))fail("revalidation_prior_failure_required");
    const failedIds=priorEvidence.cases.filter(c=>!c.passed).map(c=>c.id);if(!failedIds.length||failedIds.some(id=>!ticket.caseIds.includes(id)))fail("revalidation_failed_case_required");
  }
  return {selected,launches};
}
function validateRunEvidence(value){
  if(!value||Object.keys(value).sort().join(",")!=="allPassed,allTerminated,attemptIds,cases,failure,launches,metrics,schema,syntheticOnly"||value.schema!==1||value.syntheticOnly!==true||
    typeof value.allPassed!=="boolean"||typeof value.allTerminated!=="boolean"||!validateMetrics(value.metrics)||!validateFailure(value.failure)||
    !Array.isArray(value.cases)||value.cases.length>5||!Array.isArray(value.attemptIds)||value.attemptIds.length>8)return false;
  let previous=-1;const attempts=[];
  for(const c of value.cases){const index=MANIFEST.cases.findIndex(x=>x.id===c?.id),expected=MANIFEST.cases[index];
    if(!c||Object.keys(c).sort().join(",")!=="failure,id,nativeLaunches,passed,terminationProved"||index<=previous||typeof c.passed!=="boolean"||typeof c.terminationProved!=="boolean"||
      !validateFailure(c.failure)||(c.passed?c.failure!==null:c.failure===null)||!Number.isSafeInteger(c.nativeLaunches)||c.nativeLaunches<0||c.nativeLaunches>expected.attempts.length)return false;
    previous=index;attempts.push(...expected.attempts.slice(0,c.nativeLaunches));
  }
  if(canonical(value.attemptIds)!==canonical(attempts))return false;
  if(value.launches===null)return !value.allPassed&&!value.allTerminated&&value.cases.length===0&&value.attemptIds.length===0;
  if(!Number.isSafeInteger(value.launches)||value.launches!==attempts.length)return false;
  if(value.allPassed&&(!value.allTerminated||value.failure!==null||value.cases.length===0||value.cases.some(c=>!c.passed||!c.terminationProved||c.nativeLaunches!==MANIFEST.cases.find(x=>x.id===c.id).attempts.length)))return false;
  if(value.allPassed&&value.cases.some(c=>c.id==="source-limit")&&value.metrics===null)return false;
  return true;
}
function validateRevalidationEvidence(value){
  if(!value||Object.keys(value).sort().join(",")!=="candidatePackageSha256,candidateRuntimeRevision,correctionSha256,evidence,index,priorEvidenceSha256,reviewSha256,schema,ticketSha256"||value.schema!==1||!Number.isSafeInteger(value.index)||value.index<1||value.index>8)return false;
  for(const key of ["candidatePackageSha256","candidateRuntimeRevision","correctionSha256","priorEvidenceSha256","reviewSha256","ticketSha256"])if(!/^[a-f0-9]{64}$/.test(value[key]))return false;
  return validateRunEvidence(value.evidence);
}
async function readProtectedJson(file,{rootOwned=false,publicReadOnly=false,maxBytes=32768}={}){
  const constants=require("node:fs").constants,handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const st=await handle.stat();if(!st.isFile()||st.nlink!==1||st.size>maxBytes||(rootOwned?(st.uid!==0||(st.mode&(publicReadOnly?0o222:0o027))!==0):(st.uid!==process.getuid()||(st.mode&0o077)!==0)))fail("revalidation_file_invalid");
    const bytes=await handle.readFile(),after=await handle.stat();if(bytes.length>maxBytes||after.size!==st.size||after.mtimeMs!==st.mtimeMs)fail("revalidation_file_changed");
    return {value:JSON.parse(bytes.toString("utf8")),sha256:sha256(bytes)};
  }finally{await handle.close();}
}
async function revalidate(ticketFile){
  if(process.platform!=="linux"||typeof process.getuid!=="function"||process.getuid()===0)fail("nonroot_linux_required");
  if(await fs.realpath(__dirname)!==ROOT+"/scripts/validation")fail("installed_proof_required");
  const match=/^\/etc\/ia4tube-media\/revalidation-([1-8])\.json$/.exec(ticketFile);if(!match)fail("revalidation_ticket_path_invalid");
  const ticketDir=await fs.lstat("/etc/ia4tube-media");if(!ticketDir.isDirectory()||ticketDir.isSymbolicLink()||ticketDir.uid!==0||(ticketDir.mode&0o022))fail("revalidation_ticket_directory_invalid");
  const index=Number(match[1]),ticketRead=await readProtectedJson(ticketFile,{rootOwned:true}),ticket=ticketRead.value;
  const dir=await fs.lstat(STATE);if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid()||(dir.mode&0o077))fail("private_state_required");
  let used=0;
  for(let i=1;i<index;i++){
    const old=await readProtectedJson(path.join(STATE,`revalidation-${i}.intent.json`));
    if(old.value.schema!==1||old.value.index!==i||old.value.missionId!==ticket.missionId||!Number.isSafeInteger(old.value.plannedLaunches)||old.value.plannedLaunches<1||old.value.plannedLaunches>8)fail("revalidation_prior_intent_invalid");
    const oldTicket=await readProtectedJson(`/etc/ia4tube-media/revalidation-${i}.json`,{rootOwned:true});
    if(!Number.isSafeInteger(old.value.startedAt)||old.value.startedAt>Date.now()||oldTicket.value.missionId!==ticket.missionId||oldTicket.sha256!==old.value.ticketSha256||canonical(old.value.caseIds)!==canonical(oldTicket.value.caseIds))fail("revalidation_prior_ticket_changed");
    const oldAdmission=validateRevalidationTicket(oldTicket.value,{now:old.value.startedAt,index:i,usedAdditionalLaunches:used});
    if(oldAdmission.launches!==old.value.plannedLaunches||canonical(old.value.attemptIds)!==canonical(oldAdmission.selected.flatMap(c=>c.attempts)))fail("revalidation_prior_launches_changed");
    const oldEvidence=await readProtectedJson(path.join(STATE,`revalidation-${i}.evidence.json`));if(!validateRevalidationEvidence(oldEvidence.value)||oldEvidence.value.ticketSha256!==oldTicket.sha256)fail("revalidation_prior_evidence_invalid");
    used+=old.value.plannedLaunches;
  }
  const prior=await readProtectedJson(path.join(STATE,index===1?"evidence.json":`revalidation-${index-1}.evidence.json`));
  if(index===1?!validateRunEvidence(prior.value):!validateRevalidationEvidence(prior.value))fail("revalidation_prior_evidence_invalid");
  const priorEvidence=index===1?prior.value:prior.value.evidence;
  if(prior.sha256!==ticket.priorEvidenceSha256)fail("revalidation_prior_receipt_changed");
  const installed=await readProtectedJson("/opt/ia4tube-media/installation.json",{rootOwned:true,publicReadOnly:true});
  const admission=validateRevalidationTicket(ticket,{index,usedAdditionalLaunches:used,priorEvidence,runtimeRevision:installed.value.runtimeRevision});
  await writeExclusive(path.join(STATE,`revalidation-${index}.intent.json`),{schema:1,index,missionId:ticket.missionId,startedAt:Date.now(),ticketSha256:ticketRead.sha256,
    priorEvidenceSha256:prior.sha256,plannedLaunches:admission.launches,caseIds:ticket.caseIds,attemptIds:admission.selected.flatMap(c=>c.attempts),candidateRuntimeRevision:ticket.candidateRuntimeRevision});
  let evidence;
  try{const result=await launchSequence({timeoutMs:Math.min(MANIFEST.sequenceSeconds*1000,ticket.notAfterMs-Date.now()),caseIds:ticket.caseIds});evidence=parseEvidence(result.output,result.code,result.elapsedMs,ticket.caseIds);}
  catch(error){evidence={schema:1,cases:[],launches:null,attemptIds:[],allTerminated:false,syntheticOnly:true,metrics:null,failure:closedFailure(error,"guest-parser"),allPassed:false};}
  const result={schema:1,index,ticketSha256:ticketRead.sha256,priorEvidenceSha256:prior.sha256,reviewSha256:ticket.reviewSha256,correctionSha256:ticket.correctionSha256,
    candidatePackageSha256:ticket.candidatePackageSha256,candidateRuntimeRevision:ticket.candidateRuntimeRevision,evidence};
  await writeExclusive(path.join(STATE,`revalidation-${index}.evidence.json`),result);return result;
}
async function collectRevalidation(index){
  if(!/^[1-8]$/.test(String(index)))fail("revalidation_index_invalid");
  const value=(await readProtectedJson(path.join(STATE,`revalidation-${index}.evidence.json`))).value;
  if(!validateRevalidationEvidence(value)||value.index!==Number(index))fail("revalidation_evidence_invalid");return value;
}
if (require.main === module) {
  const action = process.argv.slice(2);
  if(action.length===2&&action[0]==="--revalidate")revalidate(action[1]).then(e=>{process.stdout.write("VM_PROOF_REVALIDATION="+JSON.stringify(e)+"\n");if(!e.evidence.allPassed||!e.evidence.allTerminated)process.exitCode=1;}).catch(()=>{process.stderr.write("VM_PROOF_GUEST=CLOSED_FAILURE_NO_REPEAT\n");process.exitCode=1;});
  else if(action.length===2&&action[0]==="--collect-revalidation")collectRevalidation(action[1]).then(e=>process.stdout.write("VM_PROOF_REVALIDATION="+JSON.stringify(e)+"\n")).catch(()=>{process.stderr.write("VM_PROOF_GUEST=CLOSED_FAILURE_NO_REPEAT\n");process.exitCode=1;});
  else if (action.length !== 1 || !["--run", "--collect"].includes(action[0])) { process.stderr.write("VM_PROOF_GUEST=INVALID_ACTION\n"); process.exitCode = 1; }
  else (action[0] === "--run" ? run() : collect()).then(e => {
    process.stdout.write((action[0] === "--run" ? "VM_PROOF_SEQUENCE=" : "VM_PROOF_EVIDENCE=") + JSON.stringify(e) + "\n");
    if (action[0] === "--run" && (!e.allPassed || !e.allTerminated)) process.exitCode = 1;
  }).catch(() => { process.stderr.write("VM_PROOF_GUEST=CLOSED_FAILURE_NO_REPEAT\n"); process.exitCode = 1; });
}
module.exports = { parseEvidence, launchSequence, validateMetrics, closedFailure, validateFailure,selectedCases,validateRevalidationTicket,validateRunEvidence,validateRevalidationEvidence };
