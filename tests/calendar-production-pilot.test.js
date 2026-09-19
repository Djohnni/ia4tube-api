"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {validateProductionPilotConfig}=require('../src/social/calendar/imports/production-pilot-config');
const {createProductionMediaPilot,createPilotProgressLoop}=require('../src/social/calendar/imports/production-pilot');
const integration=require('../src/social/production-integration');
const now=2_000_000;
const env=()=>({ENVIRONMENT:'production',RENDER_SERVICE_ID:'srv-d8708kd7vvec73ap1p6g',PUBLIC_API_BASE_URL:'https://ia4tube-api.onrender.com',
  SOCIAL_PERSISTENCE_ENABLED:'true',SOCIAL_INSTAGRAM_ENABLED:'true',SOCIAL_CALENDAR_ENABLED:'true',SOCIAL_MEDIA_IMPORTS_ENABLED:'true',
  SOCIAL_EXTERNAL_CONNECTION_ENABLED:'false',SOCIAL_EXTERNAL_PUBLICATION_ENABLED:'false',META_APP_REVIEW_WINDOW_ENABLED:'false'});
function input(){return {schema:1,missionId:'11111111-1111-4111-8111-111111111111',workerId:'22222222-2222-4222-8222-222222222222',
  owner:{companyId:'33333333-3333-4333-8333-333333333333',userId:'44444444-4444-4444-8444-444444444444'},
  runtimeRevision:'a'.repeat(64),bridgeKeyBase64:Buffer.alloc(32,42).toString('base64'),
  capacityDatabaseUrl:'postgresql://ia4tube_media_capacity_runtime:synthetic-only@dpg-dae4tmf40ujc73dr2dog-a.oregon-postgres.render.com/ia4tube_social_production',
  transferDatabaseUrl:'postgresql://ia4tube_media_transfer_runtime:synthetic-only@dpg-dae4tmf40ujc73dr2dog-a.oregon-postgres.render.com/ia4tube_social_production',
  createdAt:1_000_000,admitUntil:7_000_000,finishBy:8_000_000,
  hostEvidence:{project:'ia4tube-futebol',zone:'us-central1-a',instanceId:'123456789',bootId:'55555555-5555-4555-8555-555555555555',
    runtimeRevision:'a'.repeat(64),receiptSha256:'b'.repeat(64),verifiedAt:1_500_000,deletionAction:'DELETE',terminationTime:8_000_000},
  musicRights:{companyId:'33333333-3333-4333-8333-333333333333',instagramCommercialUse:true,endUserSublicensing:false,
    evidenceId:'synthetic_rights_test',validFrom:1,validUntil:9_000_000}};}
function valid(value=input(),environment=env(),time=now){return validateProductionPilotConfig(value,{env:environment,now:time});}
test('pilot is disabled without IO by default and cannot open Instagram gates',async()=>{
  assert.equal(await createProductionMediaPilot({env:{}}),null);
  assert.equal(await createProductionMediaPilot({env:{SOCIAL_MEDIA_IMPORTS_ENABLED:''}}),null);
  assert.equal(await createProductionMediaPilot({env:{SOCIAL_MEDIA_IMPORTS_ENABLED:'false'}}),null);
  for(const key of ['SOCIAL_EXTERNAL_CONNECTION_ENABLED','SOCIAL_EXTERNAL_PUBLICATION_ENABLED']){
    const e=env();e[key]='true';assert.throws(()=>valid(input(),e),{code:'calendar_media_pilot_boundary_invalid'});
    assert.throws(()=>integration.assertProductionPreparationBoundary(e),{code:integration.PREPARATION_INCOMPLETE});
  }
});
test('pilot binds the exact owner, worker, host receipt, bounded window and least-privilege TLS pools',()=>{
  const source=input(), result=valid(source);
  assert.deepEqual(result.owner,source.owner);assert.ok(Object.isFrozen(result.owner));assert.ok(Object.isFrozen(result.hostEvidence));
  source.musicRights.instagramCommercialUse=false;assert.equal(result.musicRights.instagramCommercialUse,true);
  for(const p of [result.capacityPoolConfig,result.transferPoolConfig]){
    assert.equal(p.max,1);assert.equal(p.ssl.rejectUnauthorized,true);assert.equal(p.ssl.minVersion,'TLSv1.2');
    assert.equal(p.ssl.servername,'dpg-dae4tmf40ujc73dr2dog-a.oregon-postgres.render.com');assert.equal(typeof p.ssl.checkServerIdentity,'function');
  }
  assert.equal(result.bridgeKey.length,32);result.bridgeKey.fill(0);
});
for(const [name,mutate] of [
  ['extra field',v=>v.unexpected=true],['wrong owner',v=>v.owner.userId='invalid'],['extra owner property',v=>v.owner.admin=true],
  ['longer than two hours',v=>{v.finishBy=9_000_000;v.hostEvidence.terminationTime=v.finishBy;}],
  ['no drain margin',v=>v.admitUntil=7_900_000],['future start',v=>v.createdAt=now+1],['negative start',v=>v.createdAt=-1],
  ['invalid key',v=>v.bridgeKeyBase64='secret-sentinel'],['foreign project',v=>v.hostEvidence.project='foreign'],
  ['different runtime',v=>v.hostEvidence.runtimeRevision='c'.repeat(64)],['missing automatic deletion',v=>v.hostEvidence.deletionAction='STOP'],
  ['mismatched deadline',v=>v.hostEvidence.terminationTime++],['future receipt',v=>v.hostEvidence.verifiedAt=now+1],
  ['privileged database role',v=>v.capacityDatabaseUrl=v.capacityDatabaseUrl.replace('ia4tube_media_capacity_runtime','postgres')],
  ['staging database',v=>v.transferDatabaseUrl=v.transferDatabaseUrl.replace('ia4tube_social_production','ia4tube_social_staging')],
  ['URI TLS override',v=>v.transferDatabaseUrl+='?sslmode=no-verify'],
  ['another database host',v=>v.transferDatabaseUrl=v.transferDatabaseUrl.replace('.oregon-postgres.render.com','.attacker.invalid')]
])test('pilot rejects '+name,()=>{const v=input();mutate(v);assert.throws(()=>valid(v),error=>{
  assert.ok(error.code.startsWith('calendar_media_pilot_'));assert.equal(error.message.includes('sentinel'),false);return true;});});
test('expired pilot config does not break restart; admission and progress remain time-bounded separately',()=>{
  const result=valid(input(),env(),8_000_001);assert.ok(result.finishBy<8_000_001);result.bridgeKey.fill(0);
});
test('database custom trust and verification overrides remain refused',()=>{
  for(const patch of [{NODE_TLS_REJECT_UNAUTHORIZED:'0'},{NODE_EXTRA_CA_CERTS:'sentinel'}])assert.throws(()=>valid(input(),{...env(),...patch}));
});
function fakeTimers(){let next=0;const pending=new Map();return {pending,
  setTimeout(fn,ms){const id=++next;pending.set(id,{fn,ms});return id;},clearTimeout(id){pending.delete(id);},
  async fire(){const [id,record]=pending.entries().next().value;pending.delete(id);await record.fn();}};}
test('progress loop is single-flight, repeated start is harmless, and close drains without launching again',async()=>{
  const timers=fakeTimers();let executions=0,release;const held=new Promise(resolve=>{release=resolve;});
  const loop=createPilotProgressLoop({tick:async()=>{executions++;await held;},finishBy:100,clock:()=>1,timers});
  loop.start();loop.start();assert.equal(timers.pending.size,1);
  const active=timers.fire();await Promise.resolve();assert.equal(executions,1);assert.equal(timers.pending.size,0);
  let closed=false;const close=loop.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);
  release();await Promise.all([active,close]);assert.equal(closed,true);assert.equal(loop.isStopped(),true);
  loop.start();assert.equal(timers.pending.size,0);assert.equal(executions,1);
});
test('progress loop never runs at/after deadline and an exception is not a retry of a codec',async()=>{
  const timers=fakeTimers();let time=1,executions=0,reports=0;
  const loop=createPilotProgressLoop({tick:async()=>{executions++;throw new Error('private details');},finishBy:100,clock:()=>time,timers,
    report:code=>{assert.equal(code,'calendar_media_progress_attention');reports++;}});
  loop.start();await timers.fire();assert.equal(executions,1);assert.equal(reports,1);assert.equal(timers.pending.size,1);
  time=100;await timers.fire();assert.equal(executions,1);assert.equal(loop.isStopped(),true);assert.equal(timers.pending.size,0);
  const expired=createPilotProgressLoop({tick:()=>assert.fail('expired launch'),finishBy:100,clock:()=>101,timers});
  expired.start();await timers.fire();assert.equal(expired.isStopped(),true);
});
test('closed private mount consumes no body and cannot expose transfer details',async()=>{
  const state=integration.createProductionSocialIntegration({env:{}});
  const response={setHeader(){},status(code){this.statusCode=code;return this;},json(value){this.value=value;return this;}};
  await state.privateMediaMiddleware({url:'/internal/calendar-media/vm/poll',get body(){assert.fail('body read');}},response,()=>assert.fail('next'));
  assert.equal(response.statusCode,503);assert.deepEqual(response.value,{ok:false,code:'calendar_media_private_unavailable'});
  let next=false;await state.privateMediaMiddleware({url:'/me'},response,()=>{next=true;});assert.equal(next,true);
});
test('pilot cleanup failure still drains existing resources in order without exposing details',async()=>{
  const observed=[];
  await assert.rejects(integration.closeProductionResources([
    async()=>{observed.push('pilot');throw Error('private-sentinel');},
    async()=>{observed.push('tenant');},
    ()=>{observed.push('visual');throw Error('second-private-sentinel');},
    async()=>{observed.push('runtime');}
  ]),error=>{
    assert.equal(error.code,'social_startup_cleanup_failed');
    assert.equal(error.message.includes('sentinel'),false);return true;
  });
  assert.deepEqual(observed,['pilot','tenant','visual','runtime']);
});
test('resource cleanup waits for the pilot drain before closing dependent runtime',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;}),observed=[];
  const closing=integration.closeProductionResources([
    async()=>{observed.push('pilot-start');await held;observed.push('pilot-drained');},
    async()=>{observed.push('runtime');}
  ]);
  await Promise.resolve();assert.deepEqual(observed,['pilot-start']);
  release();await closing;assert.deepEqual(observed,['pilot-start','pilot-drained','runtime']);
});

const {fixture:compositionFixture}=require('./helpers/production-pilot-composition-fixture');
test('composition wiring stays owner-only and refuses new work after admission cutoff while retaining reads',async()=>{
  let time=now;const f=compositionFixture({input:input(),env:env(),clock:()=>time}),pilot=await f.create();
  assert.equal(f.events.includes('tick'),false);assert.equal(f.timers.size,0);
  assert.equal(f.factoryOptions.canAdmit(),true);assert.equal(f.componentOptions.canLaunch(),true);
  assert.equal(f.musicOptions.allowExpiredForReadOnly,false);
  assert.equal(f.componentOptions.validationOnly,true);assert.equal(f.componentOptions.executionTransport.kind,'vm');
  assert.equal(f.componentOptions.executionTransport.workerId,input().workerId);
  const owner={authenticated:true,...input().owner};
  assert.equal(f.componentOptions.accessPolicy.resolve(owner).audience,'owner_pilot');
  assert.throws(()=>f.componentOptions.accessPolicy.resolve({...owner,userId:input().workerId}));
  time=input().admitUntil;
  assert.equal(f.factoryOptions.canAdmit(),false);assert.equal(f.componentOptions.canLaunch(),false);
  assert.equal(f.componentOptions.accessPolicy.resolve(owner).companyId,owner.companyId);
  assert.equal(await f.factoryOptions.verifyReadiness(),true);
  assert.equal(await pilot.handlePrivateRequest({url:'/internal/calendar-media/vm/done'},{}),true);
  time=input().finishBy;const res={writeHead(code){this.statusCode=code;},end(){this.ended=true;}};
  assert.equal(await pilot.handlePrivateRequest({url:'/internal/calendar-media/vm/poll'},res),true);
  assert.equal(res.statusCode,503);assert.equal(res.ended,true);
  await pilot.close();await pilot.close();assert.equal(f.events.filter(v=>v.endsWith('-pool-end')).length,2);
  assert.ok(f.config.bridgeKey.every(value=>value===0));
});

test('expired composition can restart to serve existing private previews but never ticks or admits',async()=>{
  const f=compositionFixture({input:input(),env:env(),clock:()=>input().finishBy+1}),pilot=await f.create();
  assert.equal(f.musicOptions.allowExpiredForReadOnly,true);
  assert.equal(f.factoryOptions.canAdmit(),false);assert.equal(f.componentOptions.canLaunch(),false);
  assert.equal(await f.factoryOptions.verifyReadiness(),true);
  assert.equal(f.componentOptions.accessPolicy.resolve({authenticated:true,...input().owner}).audience,'owner_pilot');
  pilot.start();await f.fire();assert.equal(f.events.includes('tick'),false);assert.equal(f.timers.size,0);
  await pilot.close();
});

for(const failAt of ['transfer-pool-create','capacity-verify','components-create','factory-create'])
  test('composition startup failure cleans every pool already created: '+failAt,async()=>{
    const f=compositionFixture({input:input(),env:env(),clock:()=>now,failAt});
    await assert.rejects(f.create(),{code:'synthetic_startup_failure'});
    const created=f.events.filter(value=>value.endsWith('-pool-create')).length-(failAt.endsWith('-pool-create')?1:0);
    assert.equal(f.events.filter(value=>value.endsWith('-pool-end')).length,created);
    assert.ok(f.config.bridgeKey.every(value=>value===0));assert.equal(f.timers.size,0);
  });

test('composition close fences admission immediately, drains active tick and attempts both pool closures',async()=>{
  let release;const heldTick=new Promise(resolve=>{release=resolve;});
  const f=compositionFixture({input:input(),env:env(),clock:()=>now,heldTick,endFailure:'capacity'}),pilot=await f.create();
  pilot.start();const tick=f.fire();await Promise.resolve();assert.equal(f.events.includes('tick'),true);
  const closing=pilot.close();assert.equal(f.factoryOptions.canAdmit(),false);assert.equal(f.componentOptions.canLaunch(),false);
  assert.equal(f.events.some(value=>value.endsWith('-pool-end')),false);
  const rejected=assert.rejects(closing,error=>error.code==='calendar_media_pilot_cleanup_failed'&&!error.message.includes('private'));
  release();await Promise.all([tick,rejected]);
  assert.deepEqual(f.events.filter(value=>value.endsWith('-pool-end')),['capacity-pool-end','transfer-pool-end']);
  assert.ok(f.config.bridgeKey.every(value=>value===0));assert.equal(f.timers.size,0);
});

for(const [name,options,code] of [
  ['world-readable secret',{configMode:0o644},'calendar_media_pilot_configuration_unprotected'],
  ['shared private directory',{directoryMode:0o755},'calendar_media_pilot_directory_unsafe']
])test('composition refuses '+name+' before reading secrets or creating pools',async()=>{
  const f=compositionFixture({input:input(),env:env(),clock:()=>now,...options});
  await assert.rejects(f.create(),{code});assert.equal(f.pools.length,0);assert.equal(f.config,undefined);
  assert.equal(f.events.some(value=>value.startsWith('read:')),false);
});

test('operator preflight uses the startup file loader with the feature disabled and no work or pools',async()=>{
  const f=compositionFixture({input:input(),env:{...env(),SOCIAL_MEDIA_IMPORTS_ENABLED:'false'},clock:()=>now});
  const result=await f.preflight();
  assert.equal(result.config.missionId,input().missionId);assert.equal(f.pools.length,0);assert.equal(f.timers.size,0);
  assert.equal(f.events.includes('components-create'),false);assert.equal(f.events.includes('tick'),false);
  assert.deepEqual(f.events.filter(value=>value.startsWith('read:')),[
    'read:/var/data/private/calendar-media/control/pilot.json','read:/var/data/private/calendar-media/music/catalog.json']);
  result.config.bridgeKey.fill(0);
});

test('read-only startup loader erases the decoded bridge key on catalog failure',async()=>{
  const f=compositionFixture({input:input(),env:env(),clock:()=>now,failAt:'music-load'});
  await assert.rejects(f.preflight(),{code:'synthetic_startup_failure'});
  assert.ok(f.config.bridgeKey.every(value=>value===0));assert.equal(f.pools.length,0);assert.equal(f.timers.size,0);
});

test('the shared loader also refuses a world-readable catalog and erases its decoded key',async()=>{
  const f=compositionFixture({input:input(),env:env(),clock:()=>now,catalogMode:0o644});
  await assert.rejects(f.preflight(),{code:'calendar_media_pilot_configuration_unprotected'});
  assert.ok(f.config.bridgeKey.every(value=>value===0));assert.equal(f.pools.length,0);
  assert.equal(f.events.includes('read:/var/data/private/calendar-media/music/catalog.json'),false);
});

for(const state of ['present','symlink','error'])test('mission stop '+state+' immediately fences admission/launch but preserves reads and drain',async()=>{
  let release;const heldTick=new Promise(resolve=>{release=resolve;});
  const f=compositionFixture({input:input(),env:env(),clock:()=>now,heldTick}),pilot=await f.create();
  assert.equal(f.factoryOptions.canAdmit(),true);pilot.start();const active=f.fire();await Promise.resolve();
  f.stop(state);
  assert.equal(f.factoryOptions.canAdmit(),false);assert.equal(f.componentOptions.canLaunch(),false);
  assert.equal(f.componentOptions.accessPolicy.resolve({authenticated:true,...input().owner}).audience,'owner_pilot');
  assert.equal(await pilot.handlePrivateRequest({url:'/internal/calendar-media/vm/done'},{}),true);
  f.stop('absent');assert.equal(f.factoryOptions.canAdmit(),false,'A fence observed by this process is irreversible');
  const close=pilot.close();release();await Promise.all([close,active]);
  assert.equal(f.events.filter(value=>value==='tick').length,1);
});

test('a stop fence survives restart while an unrelated mission file does not close this mission',async()=>{
  const active=compositionFixture({input:input(),env:env(),clock:()=>now});active.stop('foreign');
  const running=await active.create();assert.equal(active.factoryOptions.canAdmit(),true);await running.close();
  const closed=compositionFixture({input:input(),env:env(),clock:()=>now});closed.stop();
  const restarted=await closed.create();assert.equal(closed.factoryOptions.canAdmit(),false);assert.equal(closed.componentOptions.canLaunch(),false);
  assert.equal(await closed.factoryOptions.verifyReadiness(),true);await restarted.close();
});

test('unsafe stop parent metadata fails closed and neither window expiry nor later removal reopens admission',async()=>{
  let at=now;const f=compositionFixture({input:input(),env:env(),clock:()=>at}),pilot=await f.create();
  f.unsafeGuardDirectory();assert.equal(f.factoryOptions.canAdmit(),false);assert.equal(f.componentOptions.canLaunch(),false);
  at=input().admitUntil;assert.equal(f.factoryOptions.canAdmit(),false);await pilot.close();
});
