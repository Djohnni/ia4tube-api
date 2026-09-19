"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {MAX_PACKET,MAX_HEADER,canonicalManifest,decodePacket,readBoundedInput,privateMetadata,createProvisioner,main}=
  require('../scripts/media-api/private-pilot-provision.cjs');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function wav(){const bytes=Buffer.alloc(2880044);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);
  bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(2880000,40);return bytes;}
function packet(header,payload){const json=Buffer.from(JSON.stringify(header)),size=Buffer.alloc(4);size.writeUInt32BE(json.length);return Buffer.concat([size,json,payload]);}
function catalog(){const bytes=wav(),id='track_'+'a'.repeat(24),manifest=canonicalManifest({schema:1,tracks:[
  {id,displayName:'Synthetic music',fileName:id+'.wav',sha256:sha(bytes),sizeBytes:bytes.length,durationSeconds:15,sampleRate:48000,channels:2,codec:'pcm_s16le'}]});
  const header={schema:1,operation:'catalog',manifest,manifestSha256:sha(Buffer.from(JSON.stringify(manifest)))};
  return {bytes,manifest,header,packet:packet(header,bytes)};}
const env=()=>({ENVIRONMENT:'production',RENDER_SERVICE_ID:'srv-d8708kd7vvec73ap1p6g',PUBLIC_API_BASE_URL:'https://ia4tube-api.onrender.com',
  SOCIAL_CALENDAR_ENABLED:'true',SOCIAL_PERSISTENCE_ENABLED:'true',SOCIAL_MEDIA_IMPORTS_ENABLED:'false',
  SOCIAL_EXTERNAL_CONNECTION_ENABLED:'false',SOCIAL_EXTERNAL_PUBLICATION_ENABLED:'false',META_APP_REVIEW_WINDOW_ENABLED:'false'});
function configuration(){const value={schema:1,missionId:'11111111-1111-4111-8111-111111111111',workerId:'22222222-2222-4222-8222-222222222222',
  owner:{companyId:'33333333-3333-4333-8333-333333333333',userId:'44444444-4444-4444-8444-444444444444'},
  runtimeRevision:'a'.repeat(64),bridgeKeyBase64:Buffer.alloc(32,42).toString('base64'),
  capacityDatabaseUrl:'postgresql://ia4tube_media_capacity_runtime:synthetic-private-sentinel@dpg-dae4tmf40ujc73dr2dog-a.oregon-postgres.render.com/ia4tube_social_production',
  transferDatabaseUrl:'postgresql://ia4tube_media_transfer_runtime:synthetic-private-sentinel@dpg-dae4tmf40ujc73dr2dog-a.oregon-postgres.render.com/ia4tube_social_production',
  createdAt:1000000,admitUntil:7000000,finishBy:8000000,
  hostEvidence:{project:'ia4tube-futebol',zone:'us-central1-a',instanceId:'123456789',bootId:'55555555-5555-4555-8555-555555555555',
    runtimeRevision:'a'.repeat(64),receiptSha256:'b'.repeat(64),verifiedAt:1500000,deletionAction:'DELETE',terminationTime:8000000},
  musicRights:{companyId:'33333333-3333-4333-8333-333333333333',instagramCommercialUse:true,endUserSublicensing:false,
    evidenceId:'synthetic_only',validFrom:1,validUntil:9000000}};
  return value;}
function configPacket(value=configuration()){const bytes=Buffer.from(JSON.stringify(value));
  return packet({schema:1,operation:'configuration',sizeBytes:bytes.length,sha256:sha(bytes)},bytes);}
function stopPacket(missionId=configuration().missionId,closureRequestId='66666666-6666-4666-8666-666666666666'){
  return packet({schema:1,operation:'stop',missionId,closureRequestId},Buffer.alloc(0));}
async function fixture(t,options={}){
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'ia4tube-private-provision-')),privateBase=path.join(temporary,'private'),root=path.join(privateBase,'calendar-media');
  const operations=[],overrides=new Map();let failed=false;
  // Real local files, hashes, exclusive creation, hardlinks and reconciliation.
  // Windows cannot prove Linux uid/mode/fsync: only those metadata/capabilities
  // are injected here. Production CLI exposes no such seam or path override.
  const metadata=(stat,file)=>Object.assign(stat,{uid:1000,mode:stat.isDirectory()?0o40700:0o100600,...overrides.get(file)});
  const fsApi={...fs,
    async lstat(file){return metadata(await fs.lstat(file),file);},
    async open(file,...args){
      const stat=await fs.lstat(file).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
      if(stat?.isDirectory())return {async stat(){return metadata(await fs.stat(file),file);},async sync(){operations.push('sync:'+file);},async close(){}};
      const handle=await fs.open(file,...args);
      return {stat:async()=>metadata(await handle.stat(),file),readFile:(...a)=>handle.readFile(...a),writeFile:(...a)=>handle.writeFile(...a),sync:()=>handle.sync(),close:()=>handle.close()};
    },
    async link(from,to){operations.push('link:'+to);if(options.failCatalogOnce&&to.endsWith('catalog.json')&&!failed){failed=true;throw Object.assign(Error('synthetic-private-detail'),{code:'EIO'});}return fs.link(from,to);}
  };
  t.after(async()=>{assert.equal(path.dirname(temporary),path.resolve(os.tmpdir()));assert.ok(path.basename(temporary).startsWith('ia4tube-private-provision-'));
    await fs.rm(temporary,{recursive:true,force:true});});
  let at=2000000;
  return {root,temporary,privateBase,operations,overrides,fsApi,setTime(value){at=value;},
    provisioner:createProvisioner({root,privateBase,fsApi,identity:{platform:'linux',getuid:()=>1000},env:options.env||env(),clock:()=>at})};
}
test('binary catalog verifies its exact manifest, PCM bytes, length and hash before filesystem actions',()=>{
  const value=catalog(),decoded=decodePacket(value.packet);
  assert.equal(decoded.operation,'catalog');assert.equal(decoded.files.length,1);assert.deepEqual(decoded.files[0].bytes,value.bytes);
  for(const mutate of [h=>h.unexpected=true,h=>h.manifest.tracks[0].fileName='../secret',h=>h.manifest.tracks[0].channels=1,
    h=>h.manifestSha256='0'.repeat(64),h=>h.manifest.tracks.push({...h.manifest.tracks[0]})]){
    const next=catalog();mutate(next.header);assert.throws(()=>decodePacket(packet(next.header,next.bytes)));}
  assert.throws(()=>decodePacket(value.packet.subarray(0,-1)),{code:'calendar_private_provision_audio_hash'});
  assert.throws(()=>decodePacket(Buffer.concat([value.packet,Buffer.from('extra')])),{code:'calendar_private_provision_packet_invalid'});
  const forged=catalog();forged.bytes.writeUInt16LE(1,22);forged.header.manifest.tracks[0].sha256=sha(forged.bytes);
  forged.header.manifestSha256=sha(Buffer.from(JSON.stringify(forged.header.manifest)));
  assert.throws(()=>decodePacket(packet(forged.header,forged.bytes)),{code:'calendar_music_catalog_invalid'});
});
test('stdin rejects oversized headers, total payload, arbitrary operations, and config fields',async()=>{
  const huge=Buffer.alloc(6);huge.writeUInt32BE(MAX_HEADER+1);assert.throws(()=>decodePacket(huge));
  assert.throws(()=>decodePacket(Buffer.alloc(MAX_PACKET+1)),{code:'calendar_private_provision_packet_limit'});
  assert.throws(()=>decodePacket(packet({schema:1,operation:'delete'},Buffer.alloc(0))),{code:'calendar_private_provision_operation_invalid'});
  const config=configPacket();assert.equal(decodePacket(config).value.missionId,configuration().missionId);
  config[config.length-1]^=1;assert.throws(()=>decodePacket(config),{code:'calendar_private_provision_configuration_packet_invalid'});
  const chunks=[Buffer.alloc(MAX_PACKET),Buffer.from('private-sentinel')];
  await assert.rejects(readBoundedInput(Readable.from(chunks)),{code:'calendar_private_provision_packet_limit'});
  assert.ok(chunks[0].every(byte=>byte===0));
});
test('private metadata must be owner-only and owned by the runtime, without link substitution',()=>{
  const base={uid:1000,mode:0o100600,nlink:1,isSymbolicLink:()=>false,isFile:()=>true,isDirectory:()=>false};
  privateMetadata(base,1000,'file');
  for(const patch of [{uid:0},{mode:0o100644},{mode:0o100666},{nlink:2},{isSymbolicLink:()=>true},{isFile:()=>false}])
    assert.throws(()=>privateMetadata({...base,...patch},1000,'file'),{code:'calendar_private_provision_metadata_unsafe'});
  assert.throws(()=>createProvisioner({identity:{platform:'win32',getuid:()=>1000}}),{code:'calendar_private_provision_linux_required'});
});
test('catalog installs via exclusive files with catalog last, and exact repetition changes no file',async t=>{
  const f=await fixture(t),value=catalog(),first=await f.provisioner.provision(value.packet);
  assert.equal(first.filesInstalled,1);assert.equal(first.catalog,'installed');
  const links=f.operations.filter(operation=>operation.startsWith('link:'));
  assert.ok(links[0].endsWith(value.manifest.tracks[0].fileName));assert.ok(links[1].endsWith('catalog.json'));
  const file=path.join(f.root,'music',value.manifest.tracks[0].fileName),before=await fs.stat(file);
  const again=await f.provisioner.provision(value.packet),after=await fs.stat(file);
  assert.equal(again.filesInstalled,0);assert.equal(again.catalog,'identical');assert.equal(before.ino,after.ino);assert.equal(before.mtimeMs,after.mtimeMs);
  assert.equal(f.operations.filter(operation=>operation.startsWith('link:')).length,2);
  assert.deepEqual((await fs.readdir(path.join(f.root,'music'))).sort(),['catalog.json',value.manifest.tracks[0].fileName].sort());
});
test('failed marker publication leaves only exact audio and permits explicit idempotent reconciliation',async t=>{
  const f=await fixture(t,{failCatalogOnce:true}),value=catalog();
  await assert.rejects(f.provisioner.provision(value.packet),{code:'EIO'});
  assert.deepEqual(await fs.readdir(path.join(f.root,'music')),[value.manifest.tracks[0].fileName]);
  assert.equal(f.operations.filter(operation=>operation.endsWith('catalog.json')&&operation.startsWith('link:')).length,1);
  const reconciled=await f.provisioner.provision(value.packet);assert.equal(reconciled.filesInstalled,0);assert.equal(reconciled.catalog,'installed');
});
test('existing divergent audio is never overwritten and committed catalog is never silently repaired',async t=>{
  const f=await fixture(t),value=catalog();await f.provisioner.provision(value.packet);
  const file=path.join(f.root,'music',value.manifest.tracks[0].fileName),changed=Buffer.from(value.bytes);changed[changed.length-1]=1;
  await fs.writeFile(file,changed);
  await assert.rejects(f.provisioner.provision(value.packet),{code:'calendar_private_provision_existing_divergent'});
  assert.equal(sha(await fs.readFile(file)),sha(changed));
  await fs.unlink(file);
  await assert.rejects(f.provisioner.provision(value.packet),{code:'calendar_private_provision_committed_catalog_incomplete'});
  assert.equal(f.operations.filter(operation=>operation.startsWith('link:')).length,2);
});
test('existing unexpected files, hardlinks and unsafe private-directory ownership fail closed',async t=>{
  const f=await fixture(t),value=catalog();await f.provisioner.provision(value.packet);
  const music=path.join(f.root,'music'),file=path.join(music,value.manifest.tracks[0].fileName);
  await fs.writeFile(path.join(music,'unknown'),'synthetic');
  await assert.rejects(f.provisioner.provision(value.packet),{code:'calendar_private_provision_unexpected_music_file'});await fs.unlink(path.join(music,'unknown'));
  await fs.link(file,path.join(f.temporary,'alias'));
  await assert.rejects(f.provisioner.provision(value.packet),{code:'calendar_private_provision_metadata_unsafe'});await fs.unlink(path.join(f.temporary,'alias'));
  f.overrides.set(f.privateBase,{uid:999});
  await assert.rejects(f.provisioner.provision(value.packet),{code:'calendar_private_provision_metadata_unsafe'});
  assert.equal(f.operations.filter(operation=>operation.startsWith('link:')).length,2);
});
test('symlink or junction ancestors cannot redirect private provisioning',async t=>{
  const f=await fixture(t),target=path.join(f.temporary,'elsewhere');await fs.mkdir(target);
  await fs.symlink(target,f.privateBase,process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.provisioner.provision(catalog().packet),{code:'calendar_private_provision_directory_unsafe'});
  assert.deepEqual(await fs.readdir(target),[]);
});
test('configuration uses existing catalog, validates real contracts and rights, then refuses replacement',async t=>{
  const f=await fixture(t),value=catalog(),bytes=configPacket();await f.provisioner.provision(value.packet);
  const result=await f.provisioner.provision(bytes);assert.equal(result.configuration,'installed');assert.equal(result.trackCount,1);
  assert.equal(JSON.stringify(result).includes('sentinel'),false);assert.equal(JSON.stringify(result).includes('bridgeKey'),false);
  const same=await f.provisioner.provision(bytes);assert.equal(same.configuration,'identical');
  const changed=configuration();changed.bridgeKeyBase64=Buffer.alloc(32,99).toString('base64');
  await assert.rejects(f.provisioner.provision(configPacket(changed)),{code:'calendar_private_provision_existing_divergent'});
  const stored=JSON.parse(await fs.readFile(path.join(f.root,'control','pilot.json'),'utf8'));assert.equal(stored.bridgeKeyBase64,configuration().bridgeKeyBase64);
  assert.equal(f.operations.filter(operation=>operation.startsWith('link:')&&operation.endsWith('pilot.json')).length,1);
});
test('config cannot activate an expired window, another owner license, open gate or forged host binding',async t=>{
  for(const mutate of [value=>value.musicRights.companyId=value.workerId,value=>value.musicRights.endUserSublicensing=true,
    value=>value.hostEvidence.runtimeRevision='c'.repeat(64),value=>value.musicRights.validUntil=1500000]){
    const f=await fixture(t),value=configuration();await f.provisioner.provision(catalog().packet);mutate(value);
    await assert.rejects(f.provisioner.provision(configPacket(value)));
    assert.deepEqual(await fs.readdir(path.join(f.root,'control')),[]);
  }
  const f=await fixture(t);await f.provisioner.provision(catalog().packet);f.setTime(configuration().admitUntil);
  await assert.rejects(f.provisioner.provision(configPacket()),{code:'calendar_private_provision_window_closed'});
  const open=await fixture(t,{env:{...env(),SOCIAL_EXTERNAL_PUBLICATION_ENABLED:'true'}});await open.provisioner.provision(catalog().packet);
  await assert.rejects(open.provisioner.provision(configPacket()),{code:'calendar_media_pilot_boundary_invalid'});
});
test('CLI has no arbitrary-path or execution options and emits only a sanitized failure',async()=>{
  let output='',read=false;const input={async *[Symbol.asyncIterator](){read=true;yield Buffer.from('private-sentinel');}};
  const code=await main(['provision','/tmp/escape'],{input,output:{write:text=>{output+=text;}}});
  assert.equal(code,1);assert.equal(read,false);assert.equal(output.includes('sentinel'),false);assert.equal(output.includes('/tmp'),false);
  assert.deepEqual(JSON.parse(output),{ok:false,code:'calendar_private_provision_arguments_invalid',reconcileBeforeRetry:true});
});

test('stop is exclusive, mission-bound, byte-idempotent and cannot replace another closure identity',async t=>{
  const f=await fixture(t),catalogBytes=catalog().packet;await f.provisioner.provision(catalogBytes);await f.provisioner.provision(configPacket());
  const first=await f.provisioner.provision(stopPacket());
  assert.equal(first.sentinel,'installed');assert.equal(first.admissionClosed,true);assert.equal(first.launchClosed,true);
  assert.equal(first.connectionEnabled,false);assert.equal(first.publicationEnabled,false);assert.equal(first.metaWindowEnabled,false);
  const repeated=await f.provisioner.provision(stopPacket());assert.equal(repeated.sentinel,'identical');assert.equal(repeated.sentinelSha256,first.sentinelSha256);
  await assert.rejects(f.provisioner.provision(stopPacket(configuration().missionId,'77777777-7777-4777-8777-777777777777')),
    {code:'calendar_private_provision_existing_divergent'});
  await assert.rejects(f.provisioner.provision(stopPacket('77777777-7777-4777-8777-777777777777')),
    {code:'calendar_private_provision_stop_mission_mismatch'});
  assert.equal(f.operations.filter(value=>value.startsWith('link:')&&value.includes('stop-')).length,1);
  assert.equal(JSON.stringify(first).includes('sentinel-private'),false);
  // Neither source audio nor the installed configuration was removed.
  assert.equal((await fs.readdir(path.join(f.root,'music'))).length,2);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root,'control','pilot.json'),'utf8')),configuration());
});

test('a stop before configuration blocks later activation and concurrent duplicate stops reconcile without replacement',async t=>{
  const f=await fixture(t);await f.provisioner.provision(catalog().packet);
  const attempts=await Promise.allSettled([f.provisioner.provision(stopPacket()),f.provisioner.provision(stopPacket())]);
  assert.ok(attempts.some(value=>value.status==='fulfilled'));
  // A reader that sees the temporary second hardlink can fail closed; no retry
  // occurs inside the operation. This explicit later lookup reconciles it.
  const reconciled=await f.provisioner.provision(stopPacket());assert.equal(reconciled.sentinel,'identical');
  await assert.rejects(f.provisioner.provision(configPacket()),{code:'calendar_private_provision_mission_stopped'});
  assert.equal((await fs.readdir(path.join(f.root,'control'))).filter(name=>name==='pilot.json').length,0);
  assert.equal((await fs.readdir(path.join(f.root,'control'))).filter(name=>name.endsWith('.pending')).length,0);
});

test('stop does not invent closed external gates and refuses a foreign service',async t=>{
  const changed=await fixture(t,{env:{...env(),SOCIAL_EXTERNAL_PUBLICATION_ENABLED:'true',META_APP_REVIEW_WINDOW_ENABLED:undefined}});
  await changed.provisioner.provision(catalog().packet);const receipt=await changed.provisioner.provision(stopPacket());
  assert.equal(receipt.admissionClosed,true);assert.equal(receipt.publicationEnabled,true);assert.equal(receipt.metaWindowEnabled,null);
  const foreign=await fixture(t,{env:{...env(),RENDER_SERVICE_ID:'wrong-service'}});await foreign.provisioner.provision(catalog().packet);
  await assert.rejects(foreign.provisioner.provision(stopPacket()),{code:'calendar_private_provision_stop_target_invalid'});
  assert.deepEqual(await fs.readdir(path.join(foreign.root,'control')),[]);
});
