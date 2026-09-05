"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { fixtureContext, createMemoryPool } = require("./helpers/publication-atomic-memory-pool");
const { createPostgresConnectorStore } = require("../src/persistence/postgres/social-connector-store");
const { createSocialConnectorService } = require("../src/social/connectors/service");
const { createConnectorRegistry } = require("../src/social/connectors/registry");
const { createInstagramPublicationConnector } = require("../src/social/publication/instagram-publication-connector");
const { createPublicationIntent } = require("../src/social/publication/connection-binding");
const { createInstagramRealReviewerService, createInstagramRealReviewerRouter } = require("../src/social/reviewer-real/reviewer-real");
const { withTransaction } = require("../src/persistence/postgres/pool");
const { lockSocialConnection } = require("../src/persistence/postgres/social-publication-guard");

const MEDIA = `reviewer-jpeg:${"a".repeat(64)}`;
const CONTAINER = "17900000000000001";
const PUBLISHED = "18000000000000001";
const PUBLIC_ORIGIN = "https://ia4tube-api.onrender.com";
function json(value) { return {status:200, headers:{get:()=>"application/json"}, arrayBuffer:async()=>Buffer.from(JSON.stringify(value))}; }
function deferred() { let resolve; const promise = new Promise(r => { resolve=r; }); return {promise,resolve}; }

function fixture(customTransport) {
  const authenticated = fixtureContext();
  const { context } = authenticated;
  const pool = createMemoryPool(context);
  const store = createPostgresConnectorStore({pool, publicationBindingRequired:true});
  const scope = store.scope(context);
  const binding = {connectionId:pool.state.connection.id, externalId:pool.state.connection.external_id,connectionRevision:7};
  const posts = [];
  const reads = [];
  const owned = {companyId:context.companyId,mediaId:MEDIA,mimeType:"image/jpeg",publicUrl:`${PUBLIC_ORIGIN}/synthetic-jpeg`,caption:"Legenda sintética"};
  owned.metadataDigest=crypto.createHash("sha256").update("synthetic immutable JPEG and metadata").digest("hex");
  const media = {async resolveOwnedJpeg(ctx,id) {
    if (ctx.companyId !== context.companyId || id !== MEDIA) return null;
    return {...owned};
  }};
  const config = {provider:"instagram",environment:"production",publicationBindingRequired:true,
    publicOrigin:PUBLIC_ORIGIN,graphApiVersion:"v25.0",externalConnectionEnabled:true,externalPublicationEnabled:true};
  const transport = async (url, request) => {
    assert.equal(pool.transactions,0,"provider I/O must not hold a database transaction");
    assert.equal(request.redirect,"error");
    if (request.method === "POST") {
      const pub = [...pool.state.publications.values()].find(v=>v.state==="provider_confirming");
      assert.ok(pub, "a durable uncertain reservation exists before every POST");
      const expected = url.endsWith("/media_publish") ? `igc:submitted:${CONTAINER}` : `igo:${pub.id.replace(/-/g,"")}`;
      assert.equal(pub.reconciliation_reference,expected);
      posts.push({url,reference:expected});
    } else reads.push(url);
    if (customTransport) return customTransport({url,request,pool,posts,reads});
    if (request.method === "POST") return json({id:url.endsWith("/media_publish") ? PUBLISHED : CONTAINER});
    if (url.includes(CONTAINER)) return json({status_code:"FINISHED"});
    if (url.includes(PUBLISHED)) return json({id:PUBLISHED,permalink:"https://www.instagram.com/p/Synthetic123/",timestamp:"2026-09-05T00:00:00Z"});
    return json({data:[]});
  };
  const connector = createInstagramPublicationConnector({config,store,media,transport,pollIntervalMs:0,pollAttempts:1,
    credentials:{async withDecryptedCredential({companyId,credentialId}, operation) {
      assert.equal(companyId,context.companyId); assert.equal(credentialId,pool.state.connection.active_credential_id);
      const ephemeral = Buffer.from("SYNTHETIC_NOT_A_REAL_ACCESS_TOKEN");
      try { return await operation(ephemeral); } finally { ephemeral.fill(0); }
    }}, authorizeContext:()=>true,authorizeConnection:()=>true,authorizePublicationRequest:()=>true,
    authorizePublication:()=>true,authorizePublishedCandidate:()=>true});
  const registry = createConnectorRegistry({environment:"production",gates:{externalConnectionEnabled:true,
    externalPublicationEnabled:true,enabledProviders:["instagram"],companyAllowlist:[context.companyId]}});
  registry.register(connector);registry.seal();
  const service = createSocialConnectorService({registry,store,media,audit:{async append(){}},publicationBindingRequired:true});
  function input(overrides = {}) {
    const params = {companyId:context.companyId,clientRequestId:"ffffffff-ffff-4fff-8fff-ffffffffffff",mediaId:MEDIA,
      mediaMetadataDigest:owned.metadataDigest,
      caption:owned.caption,binding,...overrides};
    const intent = createPublicationIntent(params);
    return {operationId:intent.operationId,publicationId:intent.publicationId,connectionId:params.binding.connectionId,
      clientRequestId:params.clientRequestId,binding:params.binding,image:{mediaId:MEDIA,mimeType:"image/jpeg",metadataDigest:owned.metadataDigest},caption:params.caption};
  }
  async function reconcile(id, extra = {}) {
    const publication = await scope.getPublicationDetails(id);
    return service.getPublicationStatus(context,{operationId:crypto.randomUUID(),publicationId:id,
      providerReference:publication.reconciliationReference,binding,...extra});
  }
  return {...authenticated,pool,store,scope,service,connector,binding,input,posts,reads,reconcile,config,owned};
}

test("real store/service/provider flow commits account binding and each claim before I/O", async()=>{
  const f=fixture();const input=f.input();
  const result=await f.service.publishImage(f.context,input);
  assert.equal(result.state,"published");assert.equal(f.posts.length,2);
  const saved=await f.scope.getPublicationDetails(input.publicationId);
  assert.deepEqual(saved.binding,f.binding);
  assert.equal(saved.attempts[0].state,"published");
  const replay=await f.service.publishImage(f.context,input);
  assert.equal(replay.state,"published");assert.equal(f.posts.length,2);
  const next=f.input({clientRequestId:crypto.randomUUID()});
  assert.notEqual(next.publicationId,input.publicationId);
  assert.equal((await f.service.publishImage(f.context,next)).state,"published");
  assert.equal(f.posts.length,4);
});

for (const change of [{externalId:"17840000000000002"},{connectionRevision:8},{connectionId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}]) {
  test(`stale review refuses ${Object.keys(change)[0]} atomically before provider I/O`,async()=>{
    const f=fixture();const input=f.input({binding:{...f.binding,...change}});
    await assert.rejects(f.service.publishImage(f.context,input),e=>["publication_binding_conflict","credential_unavailable"].includes(e.code));
    assert.equal(f.posts.length,0);assert.equal(f.pool.state.publications.size,0);assert.equal(f.pool.state.operations.size,0);
  });
}

test("two simultaneous requests for one intent have one publication winner",async()=>{
  const entered=deferred(), resume=deferred();
  const f=fixture(async({url,request})=>{
    if(request.method==="POST"&&!url.endsWith("/media_publish")){entered.resolve();await resume.promise;return json({id:CONTAINER});}
    if(request.method==="POST")return json({id:PUBLISHED});
    if(url.includes(CONTAINER))return json({status_code:"FINISHED"});
    return json({id:PUBLISHED,permalink:"https://www.instagram.com/p/Synthetic123/",timestamp:"2026-09-05T00:00:00Z"});
  });
  const input=f.input();const first=f.service.publishImage(f.context,input);await entered.promise;
  await assert.rejects(f.service.publishImage(f.context,input),e=>e.code==="provider_result_unknown");
  resume.resolve();assert.equal((await first).state,"published");assert.equal(f.posts.length,2);
});

test("ambiguous container POST is durably uncertain and age/history/replay never resends",async()=>{
  const f=fixture(async({request})=>{if(request.method==="POST")throw new Error("synthetic lost response");return json({data:[]});});
  const input=f.input();assert.equal((await f.service.publishImage(f.context,input)).state,"provider_confirming");
  f.pool.state.publications.get(input.publicationId).updated_at=new Date("2000-01-01T00:00:00Z");
  const before=f.pool.statements.length;
  await f.scope.listPublicationDetails();await f.scope.getPublicationDetails(input.publicationId);
  assert.ok(f.pool.statements.slice(before).every(q=>!q.startsWith("UPDATE")&&!q.startsWith("INSERT")&&!q.startsWith("DELETE")));
  await f.service.publishImage(f.context,input);await f.reconcile(input.publicationId);
  assert.equal(f.posts.length,1);assert.match((await f.scope.getPublicationDetails(input.publicationId)).reconciliationReference,/^igo:/);
});

test("lost publish response is reconciled by provider evidence, never by repeating POST",async()=>{
  let observedCaption;
  const f=fixture(async({url,request,pool})=>{
    if(request.method==="POST"&&url.endsWith("/media_publish"))throw new Error("synthetic publish response lost");
    if(request.method==="POST")return json({id:CONTAINER});
    if(url.includes(CONTAINER))return json({status_code:"FINISHED"});
    observedCaption=[...pool.state.publications.values()][0].caption;
    return json({data:[{id:PUBLISHED,caption:observedCaption,permalink:"https://www.instagram.com/p/Synthetic123/",timestamp:"2026-09-05T00:00:00Z"}]});
  });
  const input=f.input();await f.service.publishImage(f.context,input);
  assert.equal((await f.scope.getPublicationDetails(input.publicationId)).reconciliationReference,`igc:submitted:${CONTAINER}`);
  assert.equal((await f.reconcile(input.publicationId)).state,"published");
  assert.equal(observedCaption,input.caption);assert.equal(f.posts.length,2);
});

test("missing scope is rejected during the reservation transaction, not after sending",async()=>{
  const f=fixture();f.pool.state.connection.granted_scopes=["instagram_business_basic"];
  await assert.rejects(f.service.publishImage(f.context,f.input()),e=>e.code==="permission_missing");
  assert.equal(f.posts.length,0);assert.equal(f.pool.state.publications.size,0);
});

test("changed owned metadata after review cannot acquire an intent or create container",async()=>{
  const f=fixture();const input=f.input();f.owned.metadataDigest="b".repeat(64);
  await assert.rejects(f.service.publishImage(f.context,input),e=>e.code==="publication_intent_conflict");
  assert.equal(f.posts.length,0);assert.equal(f.pool.state.publications.size,0);
});

test("armed continuation consumed once by independent concurrent reconciliation requests",async()=>{
  const entered=deferred(),resume=deferred();let status="IN_PROGRESS";
  const f=fixture(async({url,request})=>{
    if(request.method==="POST"&&url.endsWith("/media_publish")){entered.resolve();await resume.promise;return json({id:PUBLISHED});}
    if(request.method==="POST")return json({id:CONTAINER});
    if(url.includes(CONTAINER))return json({status_code:status});
    return json({id:PUBLISHED,permalink:"https://www.instagram.com/p/Synthetic123/",timestamp:"2026-09-05T00:00:00Z"});
  });
  const input=f.input();await f.service.publishImage(f.context,input);status="FINISHED";
  await f.reconcile(input.publicationId);
  assert.equal((await f.scope.getPublicationDetails(input.publicationId)).reconciliationReference,`igc:armed:${CONTAINER}`);
  const first=f.reconcile(input.publicationId);await entered.promise;
  const before=f.posts.length;
  // A second explicit reconcile can perform GET only; it cannot re-arm or POST.
  await f.reconcile(input.publicationId).catch(e=>assert.ok(["provider_result_unknown","resource_unavailable"].includes(e.code)));
  assert.equal(f.posts.length,before);
  resume.resolve();assert.equal((await first).state,"published");assert.equal(f.posts.length,2);
});

test("ordinary connection writers cannot switch a pending target; compliance stops the next stage",async()=>{
  const entered=deferred(),resume=deferred();
  const f=fixture(async({url,request})=>{
    if(request.method==="POST"){entered.resolve();await resume.promise;return json({id:CONTAINER});}
    return json({status_code:"FINISHED"});
  });
  const input=f.input();const pending=f.service.publishImage(f.context,input);await entered.promise;
  await assert.rejects(f.scope.disconnectConnectionLocally(f.binding.connectionId),e=>e.code==="state_transition_invalid");
  await withTransaction(f.pool,async client=>{
    await lockSocialConnection(client,f.context.companyId,"instagram");
    f.pool.state.connection.status="revoked";f.pool.state.connection.revision+=1;
    f.pool.state.connection.active_credential_id=null;
  },{companyId:f.context.companyId,role:"ia4tube_social_runtime"});
  resume.resolve();await assert.rejects(pending,e=>e.code==="credential_unavailable");
  assert.equal(f.posts.length,1);
  assert.equal((await f.scope.getPublicationDetails(input.publicationId)).state,"provider_confirming");
});

test("persisted binding cannot be replaced by another current account, unknown legacy or altered hash",async()=>{
  const f=fixture(async({request})=>{if(request.method==="POST")throw new Error("synthetic");return json({data:[]});});
  const input=f.input();await f.service.publishImage(f.context,input);
  f.pool.state.connection.external_id="17840000000000002";
  await assert.rejects(f.reconcile(input.publicationId),e=>e.code==="publication_binding_conflict");
  f.pool.state.connection.external_id=f.binding.externalId;
  const row=f.pool.state.publications.get(input.publicationId);row.request_hash="0".repeat(64);
  await assert.rejects(f.reconcile(input.publicationId),e=>e.code==="publication_intent_conflict");
  Object.assign(f.pool.state.publications.get(input.publicationId),{
    bound_external_account_id:null,expected_connection_revision:null,bound_external_id:null});
  await assert.rejects(f.reconcile(input.publicationId),e=>e.code==="publication_binding_invalid");
  assert.equal(f.posts.length,1);
});

test("cross-company media and publication IDs do not reach provider or disclose persisted record",async()=>{
  const f=fixture();const input=f.input();await f.service.publishImage(f.context,input);
  const other=fixtureContext("different-synthetic-owner").context;
  assert.equal(await f.store.scope(other).getPublicationDetails(input.publicationId),null);
  await assert.rejects(f.service.publishImage(other,input),e=>e.code==="resource_unavailable");
  assert.equal(f.posts.length,2);
});

test("HTTP-facing service binds original review and rejects same intent with changed content",async()=>{
  const f=fixture(async({request})=>{if(request.method==="POST")throw new Error("synthetic");return json({data:[]});});
  const reviewer=createInstagramRealReviewerService({config:f.config,authAdapter:f.adapter,connectorStore:f.store,
    connectorAudit:{async append(){}},createPublicationConnector:()=>f.connector,
    media:{async listOwnedJpegs(){return[];},async resolveOwnedJpeg(){return {...f.owned};}}});
  const body={verifiedClaims:f.claims,mediaId:MEDIA,clientRequestId:crypto.randomUUID(),
    expectedConnectionId:f.binding.connectionId,expectedExternalId:f.binding.externalId,expectedConnectionRevision:7};
  await assert.rejects(reviewer.publish({verifiedClaims:f.claims,mediaId:MEDIA,clientRequestId:crypto.randomUUID()}),e=>e.code==="publication_binding_invalid");
  const first=await reviewer.publish(body);assert.deepEqual(first.publication.binding,f.binding);
  const beforeLookup=f.pool.statements.length;
  const recovered=await reviewer.getPublicationIntent({verifiedClaims:f.claims,clientRequestId:body.clientRequestId});
  assert.equal(recovered.publication.publicationId,first.publication.publicationId);
  assert.equal((await reviewer.getPublicationIntent({verifiedClaims:f.claims,clientRequestId:crypto.randomUUID()})).publication,null);
  assert.ok(f.pool.statements.slice(beforeLookup).every(q=>!q.startsWith("UPDATE")&&!q.startsWith("INSERT")&&!q.startsWith("DELETE")));
  const repeated=await reviewer.publish(body);assert.equal(repeated.duplicateSubmissionPrevented,true);
  f.owned.caption="Outra legenda";
  await assert.rejects(reviewer.publish(body),e=>e.code==="publication_intent_conflict");
  assert.equal(f.posts.length,1);
});

test("router forwards only the exact three binding fields and exposes read-only UUID recovery",async()=>{
  const records=[];const routes=new Map();
  const router={get(path,...handlers){routes.set(`GET ${path}`,handlers.at(-1));},post(path,...handlers){routes.set(`POST ${path}`,handlers.at(-1));}};
  const publication={state:"provider_confirming",publicationId:crypto.randomUUID()};
  const service={async listMedia(){},async listPublications(){},async getPublication(){},
    async publish(input){records.push(input);return {publication};},
    async reconcile(input){records.push(input);return {publication};},
    async getPublicationIntent(input){records.push(input);return {ok:true,publication:null};}};
  createInstagramRealReviewerRouter({router,authenticate(){},getService:()=>service});
  const claims=fixtureContext().claims;
  const binding={expectedConnectionId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",expectedExternalId:"17840000000000001",expectedConnectionRevision:7};
  async function invoke(key,body,params={}){
    const response={status(code){this.code=code;return this;},json(value){this.body=value;return this;}};
    await routes.get(key)({body,params,query:{},user:claims},response);return response;
  }
  const requestId=crypto.randomUUID();
  assert.equal((await invoke("POST /publications",{mediaId:MEDIA,clientRequestId:requestId,...binding})).code,202);
  assert.deepEqual(records[0],{verifiedClaims:claims,mediaId:MEDIA,clientRequestId:requestId,...binding});
  assert.equal((await invoke("POST /publications/:publicationId/reconcile",binding,{publicationId:publication.publicationId})).code,202);
  assert.deepEqual(records[1],{verifiedClaims:claims,publicationId:publication.publicationId,...binding});
  assert.equal((await invoke("GET /publication-intents/:clientRequestId",undefined,{clientRequestId:requestId})).code,200);
  assert.deepEqual(records[2],{verifiedClaims:claims,clientRequestId:requestId});
  const before=records.length;
  assert.equal((await invoke("POST /publications",{mediaId:MEDIA,clientRequestId:requestId,expectedConnectionId:binding.expectedConnectionId})).code,400);
  assert.equal((await invoke("POST /publications",{mediaId:MEDIA,clientRequestId:requestId,...binding,company_id:"another"})).code,400);
  assert.equal(records.length,before);
});
