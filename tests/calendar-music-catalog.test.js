"use strict";
const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs/promises'), os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {loadPrivateMusicCatalog,displayName,validateCanonicalWav}=require('../src/social/calendar/imports/music-catalog');
const {licensedTrack}=require('../src/social/calendar/imports/policy');
const company='00000000-0000-4000-8000-000000000001', id='track_'+ 'a'.repeat(24);
function wav() { const b=Buffer.alloc(2880044); b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(192000,28);b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);
  b.write('data',36);b.writeUInt32LE(2880000,40);return b; }
async function fixture(t) {const root=await fs.mkdtemp(path.join(os.tmpdir(),'ia4tube-music-catalog-'));await fs.chmod(root,0o700);
  const bytes=wav(), sha256=crypto.createHash('sha256').update(bytes).digest('hex');await fs.writeFile(path.join(root,id+'.wav'),bytes,{mode:0o600});
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('ia4tube-music-catalog-'));
    await fs.rm(root,{recursive:true,force:true});});
  return {rootDirectory:root,ownerCompanyId:company,now:1000,clock:()=>1000,
    rights:{companyId:company,instagramCommercialUse:true,endUserSublicensing:false,evidenceId:'synthetic_rights',validFrom:1,validUntil:2000},
    manifest:{schema:1,tracks:[{id,sha256,fileName:id+'.wav',displayName:'Energia Urbana — Pulso',durationSeconds:15,sampleRate:48000,channels:2,codec:'pcm_s16le',sizeBytes:bytes.length}]}};}
test('canonical PCM checks actual bytes, duration, channels, sample format and chunk bounds',()=>{assert.equal(validateCanonicalWav(wav()),true);
  for(const mutate of [b=>b.writeUInt16LE(3,20),b=>b.writeUInt16LE(1,22),b=>b.writeUInt32LE(44100,24),b=>b.writeUInt32LE(99,40),b=>b.writeUInt32LE(99999999,16)]) {
    const bytes=wav();mutate(bytes);assert.throws(()=>validateCanonicalWav(bytes),{code:'calendar_music_catalog_invalid'});}});
test('private catalog is exact, read-only, owner-scoped and never grants customer sublicensing',async t=>{const input=await fixture(t), result=await loadPrivateMusicCatalog(input);
  assert.equal(result.catalog.size,1);assert.equal(result.catalog.get(id).displayName,'Energia Urbana — Pulso');assert.equal(result.catalog.set,undefined);
  const resolved=await result.resolveMusicTrack(id,company);
  assert.equal(resolved.sha256,input.manifest.tracks[0].sha256);assert.equal(resolved.synthetic,false);
  assert.deepEqual(resolved.rights,{commercialPublishing:true,evidenceId:'synthetic_rights'});assert.ok(Object.isFrozen(resolved.rights));
  assert.equal(await result.resolveMusicTrack('missing',company),null);
  assert.equal(await result.resolveMusicTrack(id),null);assert.equal(await result.resolveMusicTrack(id,crypto.randomUUID()),null);
  assert.equal(licensedTrack(result.catalog,id,{companyId:company,now:1000}).testOnly,false);
  assert.throws(()=>licensedTrack(result.catalog,id,{companyId:company,now:1000,audience:'customers'}));
  assert.throws(()=>licensedTrack(result.catalog,id,{companyId:company,now:1000,publishAt:2000}));});
test('missing rights, wrong owner, expiration and customer use do not become approved',async t=>{for(const patch of [null,{instagramCommercialUse:false},{companyId:crypto.randomUUID()},{validUntil:1000},{endUserSublicensing:true}]){
  const input=await fixture(t);input.rights=patch===null?null:{...input.rights,...patch};await assert.rejects(loadPrivateMusicCatalog(input));}});
test('duplicate tracks, traversal, forged audio metadata and changed bytes fail closed',async t=>{for(const change of [v=>v.manifest.tracks.push({...v.manifest.tracks[0]}),v=>v.manifest.tracks[0].fileName='../a.wav',
  v=>v.manifest.tracks[0].channels=1,v=>v.manifest.tracks[0].sha256='0'.repeat(64),v=>v.manifest.tracks[0].displayName='title\u202e']){
  const input=await fixture(t);change(input);await assert.rejects(loadPrivateMusicCatalog(input));}});
test('display labels reject control/bidi characters without changing IDs',()=>{assert.equal(displayName('Café & Conforto','fallback'),'Café & Conforto');
  for(const value of ['',null,' x','x\n','x\u202e','x'.repeat(81)])assert.equal(displayName(value,'fallback'),'fallback');});

test('read-only restart preserves expired metadata without renewing rights or offering audio',async t=>{
  const input=await fixture(t);input.rights.validUntil=1000;input.allowExpiredForReadOnly=true;
  const result=await loadPrivateMusicCatalog(input);
  assert.equal(result.catalog.size,1);assert.equal(result.catalog.get(id).validUntil,1000);
  assert.throws(()=>licensedTrack(result.catalog,id,{companyId:company,now:1000}));
  assert.equal(await result.resolveMusicTrack(id,company),null);
  input.rights.validUntil=999999;assert.equal(await result.resolveMusicTrack(id,company),null);
  assert.equal(result.catalog.get(id).validUntil,1000);
});

test('active rights expire during the same process and foreign owner never receives their proof',async t=>{
  const input=await fixture(t);let time=1000;input.clock=()=>time;
  const result=await loadPrivateMusicCatalog(input);
  input.rights.evidenceId='changed_after_load';input.rights.validUntil=999999;
  const first=await result.resolveMusicTrack(id,company);assert.equal(first.rights.evidenceId,'synthetic_rights');
  assert.equal(await result.resolveMusicTrack(id,crypto.randomUUID()),null);
  time=2000;assert.equal(await result.resolveMusicTrack(id,company),null);
  time=NaN;assert.equal(await result.resolveMusicTrack(id,company),null);
});

test('read-only mode never approves future or contradictory rights',async t=>{
  for(const patch of [{validFrom:1001},{validUntil:1},{validFrom:-1},{instagramCommercialUse:false},{endUserSublicensing:true}]){
    const input=await fixture(t);input.allowExpiredForReadOnly=true;Object.assign(input.rights,patch);
    await assert.rejects(loadPrivateMusicCatalog(input),{code:'calendar_music_catalog_invalid'});
  }
});
