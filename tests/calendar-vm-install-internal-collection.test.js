"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {safeInternalSummary,summaryFromArchive,privateArchiveRun,quiescenceScript}=require('../scripts/validation/vm-proof-install-internal');
const {certainInternalFailure}=require('../scripts/validation/vm-proof-google-resolution');
const {installationScript,collectInstallationScript}=require('../scripts/validation/vm-proof-install-shell');
const binding={missionId:'693d65b9-aa17-4208-ab00-ac5890630a05',attempt:1,packageSha256:'a'.repeat(64)};
function sample(){const stream={bytesObserved:10,bytesRetained:10,truncated:false,sha256:'b'.repeat(64),privateBasename:'001-native_compile.stderr.private'};
 return {schema:1,identity:{mission:binding.missionId,attempt:1,packageSha256:binding.packageSha256,installerSha256:'c'.repeat(64)},
 createdAtMs:1700000000000,rawBytesRetained:30,terminal:true,installerExitCode:1,finishedAtMs:1700000000001,
 events:[{operationId:'native_compile',sourceRef:'scripts/media-vm/package-install.cjs#native_compile',phase:'error',atMs:1700000000001,
 exitCode:1,signal:null,reason:'required_c_header_missing',streams:{stdout:{...stream},stderr:{...stream},exception:{...stream}}}]};}
function tar(entries){const chunks=[];for(const [name,contents,type='0']of entries){const body=Buffer.from(contents),h=Buffer.alloc(512);
 h.write(name,0,100,'utf8');const oct=(v,n)=>v.toString(8).padStart(n-1,'0')+'\0';
 h.write(oct(type==='5'?0o700:0o600,8),100);h.write(oct(0,8),108);h.write(oct(0,8),116);h.write(oct(body.length,12),124);h.write(oct(0,12),136);
 h.fill(32,148,156);h.write(type,156);h.write('ustar\0',257);h.write('00',263);const sum=h.reduce((a,b)=>a+b,0);h.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
 chunks.push(h,body,Buffer.alloc((512-body.length%512)%512));}chunks.push(Buffer.alloc(1024));return Buffer.concat(chunks);}
test('safe internal summary is idempotent and admits certain terminal command failure',()=>{
 const safe=safeInternalSummary(sample(),binding);assert.deepEqual(safeInternalSummary(safe,binding),safe);
 assert.equal(JSON.stringify(safe).includes('privateBasename'),false);
 assert.equal(certainInternalFailure({collected:true,privateRetained:true,archiveSha256:'d'.repeat(64),summary:safe},binding),true);
});
test('private archive accepts summary, bounded raw detail and partial-state without exposing raw values',()=>{
 const secret='synthetic-private-value-not-for-safe-summary';
 const archive=tar([['internal-attempt-1/',Buffer.alloc(0),'5'],['internal-attempt-1/summary.json',JSON.stringify(sample())],
 ['internal-attempt-1/partial-state.json',JSON.stringify({private:secret})],['internal-attempt-1/001-native_compile.stderr.private',secret]]);
 const safe=summaryFromArchive(archive,binding);assert.equal(safe.events[0].reason,'required_c_header_missing');assert.equal(JSON.stringify(safe).includes(secret),false);
});
for(const name of ['../escape','internal-attempt-1/unexpected','internal-attempt-2/summary.json'])test('archive rejects unowned entry '+name,()=>{
 assert.throws(()=>summaryFromArchive(tar([[name,'{}']]),binding),/internal_diagnostic_invalid/);
});
test('archive rejects links, oversized fields and corrupt checksum',()=>{
 assert.throws(()=>summaryFromArchive(tar([['internal-attempt-1/summary.json','', '2']]),binding));
 const b=tar([['internal-attempt-1/summary.json',JSON.stringify(sample())]]);b[10]^=1;assert.throws(()=>summaryFromArchive(b,binding));
 assert.throws(()=>summaryFromArchive(Buffer.alloc(1049088),binding));
});
test('wrong mission/package and raw sensitive reason are rejected by safe collector',()=>{
 for(const change of [s=>s.identity.mission='another-mission',s=>s.identity.packageSha256='f'.repeat(64),s=>s.events[0].reason='synthetic-private-value']){
  const s=sample();change(s);assert.throws(()=>safeInternalSummary(s,binding));
 }
});
test('internal signals, timeout, missing termination and diagnostic failure never permit retries',()=>{
 for(const change of [s=>s.events[0].signal='SIGKILL',s=>s.events[0].reason='errno_etimedout',s=>s.events[0].reason='errno_enobufs',
  s=>s.terminal=false,s=>s.collectionFailure={component:'partial_state',reason:'collection_or_persistence_failed'}]){
  const s=sample();change(s);assert.equal(certainInternalFailure({collected:true,privateRetained:true,archiveSha256:'d'.repeat(64),summary:s},binding),false);
 }
});
test('private binary capture preserves bytes without emitting them',async()=>{
 const result=await privateArchiveRun(process.execPath,['-e','process.stdout.write(Buffer.from([0,255,3,0,4]));process.stderr.write("private synthetic ignored")'],{timeoutMs:3000});
 assert.deepEqual(result,Buffer.from([0,255,3,0,4]));
 await assert.rejects(privateArchiveRun(process.execPath,['-e','process.stdout.write(Buffer.alloc(2048))'],{timeoutMs:3000,maxBytes:1024}),/transport_failed/);
});
test('resolution instrumentation preserves every attempt and binds package/mission without runtime reinstall',()=>{
 const first=installationScript({...binding,missionId:binding.missionId});assert.match(first,/outer-attempt-1/);assert.match(first,/IA4TUBE_INSTALL_PACKAGE_SHA256=aaaa/);
 const second=installationScript({...binding,attempt:2,bundleRoot:'/var/tmp/ia4tube-proof-bundle-attempt-2'});
 assert.match(second,/outer-attempt-2/);assert.doesNotMatch(second,/run_stage dependencies_runtime.*bootstrap-ubuntu24/);
 assert.match(second,/--ignore-scripts/);assert.match(collectInstallationScript({attempt:2,resolution:true}),/outer-attempt-2/);
 new (require('node:vm').Script)(quiescenceScript());
});
