"use strict";
// Same live controller session only. A new process always performs cleanup.
// This inbox never grants authorization by itself: only a reviewed correction
// bound to a certain, finished attempt can be admitted by the controller.
const fs=require('node:fs/promises'),path=require('node:path');
const {sha256,canonical,MANIFEST}=require('./vm-proof-manifest');
const {atomicWrite,protectedPath}=require('./vm-proof-local-state');
const {fail}=require('./vm-proof-google-plan');
const HASH=/^[a-f0-9]{64}$/;
function certainInstallFailure(d){return !!d && d.installationPassed===false && d.classification==='substep_failed' &&
  Number.isInteger(d.exitCode)&&d.exitCode>0&&d.exitCode<124&&d.failedStageExitCode===d.exitCode&&
  d.failedStage==='package_install' && !d.signal&&!d.timedOut&&!d.aborted&&!d.spawnFailed&&!d.stdinFailed&&
  !d.collectionError&&!d.remoteCaptureFailed&&!d.protocolInvalid;}
function certainInternalFailure(internal,binding){
  if(internal?.collected!==true||internal.privateRetained!==true||!HASH.test(internal.archiveSha256||''))return false;
  try{
    const s=require('./vm-proof-install-internal').safeInternalSummary(internal.summary,binding);
    return s.terminal===true&&!s.collectionFailure&&s.installerExitCode>0&&s.installerExitCode<124&&s.events.some(e=>e.phase==='error')&&
      s.events.every(e=>e.signal==null&&!['errno_etimedout','errno_enobufs'].includes(e.reason)&&e.exitCode!==124&&e.exitCode!==137);
  }catch{return false;}
}
function validateCorrectionTicket(t,c){
  const keys=['schema','action','missionId','attempt','previousDiagnosticSha256','causeCode','packagePath','packageSha256',
    'packageReviewSha256','testsSha256','reviewSha256','partialStateScriptPath','partialStateScriptSha256','repairScriptPath','repairScriptSha256'];
  if(!t||Object.keys(t).sort().join(',')!==keys.sort().join(',')||t.schema!==1||t.action!=='reviewed_correction'||
      t.missionId!==c.missionId||t.attempt!==c.attempt||t.attempt<2||t.attempt>3||
      t.previousDiagnosticSha256!==sha256(canonical(c.diagnostic))||!/^[a-z][a-z0-9_]{2,95}$/.test(t.causeCode||'')||
      ['packageSha256','packageReviewSha256','testsSha256','reviewSha256','partialStateScriptSha256','repairScriptSha256'].some(k=>!HASH.test(t[k]||''))||
      ['packagePath','partialStateScriptPath','repairScriptPath'].some(k=>!path.isAbsolute(t[k]||'')||/[\r\n]/.test(t[k])))fail('correction_ticket_invalid');
  return t;
}
function ticketReceipt(t){return {attempt:t.attempt,causeCode:t.causeCode,packageSha256:t.packageSha256,
  packageReviewSha256:t.packageReviewSha256,testsSha256:t.testsSha256,reviewSha256:t.reviewSha256,
  partialStateScriptSha256:t.partialStateScriptSha256,repairScriptSha256:t.repairScriptSha256};}
function createResolutionInbox(root){return async c=>{
  const request=path.join(root,`installation-correction-request-${c.attempt}.json`);
  await atomicWrite(request,{schema:1,missionId:c.missionId,attempt:c.attempt,deadlineAt:c.deadlineAt,
    correctionDeadlineAt:c.correctionDeadlineAt,previousDiagnosticSha256:sha256(canonical(c.diagnostic)),diagnostic:c.diagnostic});
  const decision=path.join(root,`installation-correction-decision-${c.attempt}.json`);
  while(!c.signal.aborted&&Date.now()<c.correctionDeadlineAt){
    try{
      await protectedPath(decision);
      const b=await fs.readFile(decision);if(b.length>16384)fail('correction_ticket_too_large');
      const t=JSON.parse(b);
      if(t?.action==='stop'&&Object.keys(t).sort().join(',')==='action,attempt,missionId'&&t.missionId===c.missionId&&t.attempt===c.attempt)return null;
      return validateCorrectionTicket(t,c);
    }catch(e){if(e.code!=='ENOENT')throw e;}
    await new Promise(r=>setTimeout(r,1000));
  }
  return null;
};}
function validateCaseCorrectionTicket(t,c){
 const keys=['schema','action','missionId','priorEvidenceSha256','causeCode','caseIds','candidatePackageSha256','candidateRuntimeRevision',
  'testsSha256','reviewSha256','partialStateScriptPath','partialStateScriptSha256','repairScriptPath','repairScriptSha256','quiescenceSha256'];
 if(!t||Object.keys(t).sort().join(',')!==keys.sort().join(',')||t.schema!==1||t.action!=='reviewed_case_correction'||
   t.missionId!==c.missionId||t.priorEvidenceSha256!==c.priorEvidenceSha256||t.quiescenceSha256!==c.quiescenceSha256||
   t.candidatePackageSha256!==c.candidatePackageSha256||t.candidateRuntimeRevision!==c.candidateRuntimeRevision||
   !/^[a-z][a-z0-9_]{2,95}$/.test(t.causeCode||'')||
   ['testsSha256','reviewSha256','partialStateScriptSha256','repairScriptSha256','quiescenceSha256','candidatePackageSha256','candidateRuntimeRevision','priorEvidenceSha256'].some(k=>!HASH.test(t[k]||''))||
   ['partialStateScriptPath','repairScriptPath'].some(k=>!path.isAbsolute(t[k]||'')||/[\r\n]/.test(t[k]))||
   !Array.isArray(t.caseIds)||!t.caseIds.length||t.caseIds[0]!==MANIFEST.cases[0].id||new Set(t.caseIds).size!==t.caseIds.length||
   canonical(MANIFEST.cases.filter(v=>t.caseIds.includes(v.id)).map(v=>v.id))!==canonical(t.caseIds)||
   c.affectedCaseIds.some(id=>!t.caseIds.includes(id)))fail('case_correction_ticket_invalid');
 return t;
}
function createCaseResolutionInbox(root){return async c=>{
 await atomicWrite(path.join(root,'sequence-correction-request-1.json'),{...c,signal:undefined,schema:1});
 const decision=path.join(root,'sequence-correction-decision-1.json');
 while(!c.signal.aborted&&Date.now()<c.correctionDeadlineAt){
  try{await protectedPath(decision);const b=await fs.readFile(decision);if(b.length>16384)fail('case_correction_ticket_too_large');
   const t=JSON.parse(b);if(t?.action==='stop'&&Object.keys(t).sort().join(',')==='action,missionId'&&t.missionId===c.missionId)return null;
   return validateCaseCorrectionTicket(t,c);
  }catch(e){if(e.code!=='ENOENT')throw e;}
  await new Promise(r=>setTimeout(r,1000));
 }
 return null;
};}
module.exports={certainInstallFailure,certainInternalFailure,validateCorrectionTicket,ticketReceipt,createResolutionInbox,
 validateCaseCorrectionTicket,createCaseResolutionInbox};
