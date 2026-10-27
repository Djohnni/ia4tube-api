"use strict";

// Production policy, private media storage, signed calendar grants, reviewer
// service and publisher execute unchanged. SQL protocol pools and Meta replies
// are synthetic; this is not a physical database or live publication proof.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fixtureContext, createMemoryPool } = require("./helpers/publication-atomic-memory-pool");
const { createPostgresConnectorStore } = require("../src/persistence/postgres/social-connector-store");
const { createProductionMedia } = require("../src/social/production-media");
const { createCalendarMedia } = require("../src/social/calendar/media");
const { createCalendarGrants } = require("../src/social/calendar/grants");
const { createCalendarService } = require("../src/social/calendar/service");
const { createCalendarPublisher } = require("../src/social/calendar/publisher");
const { createInstagramRealReviewerService } = require("../src/social/reviewer-real/reviewer-real");
const { loadInstagramOAuthConfig } = require("../src/social/oauth/instagram-config");
const { requireConnectorContext } = require("../src/social/connectors/contract");
const { deriveSocialIdentity } = require("../src/social/identity");
const { assertProductionPreparationBoundary } = require("../src/social/production-integration");
const model = require("../src/social/calendar/model");

const ORIGIN = "https://ia4tube-api.onrender.com";
const OWNERS = ["synthetic-unlisted-customer-a","synthetic-unlisted-customer-b"];
// Structural parser fixture, not a JPEG decoder or paid image generation.
const JPEG = Buffer.from([0xff,0xd8,0xff,0xdb,0,3,0,0xff,0xc4,0,3,0,
  0xff,0xc0,0,11,8,4,56,4,56,1,1,0x11,0,0xff,0xda,0,8,1,1,0,0,63,0,1,0xff,0xd9]);
const reply = value => ({status:200,headers:{get:()=>"application/json"},
  arrayBuffer:async()=>Buffer.from(JSON.stringify(value))});

function memoryCalendarStore() {
  const rows=new Map();let tail=Promise.resolve();
  return {rows,async exists(companyId){return rows.has(companyId);},
    async read(companyId,action){return structuredClone(await action(structuredClone(rows.get(companyId))));},
    update(companyId,action){
      const work=tail.then(async()=>{
        const state=structuredClone(rows.get(companyId)||model.freshState());
        const result=await action(state);rows.set(companyId,state);return structuredClone(result);
      });tail=work.catch(()=>{});return work;
    }};
}

async function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"social-customer-access-"));
  let calendar;
  t.after(async()=>{
    await calendar?.close();
    assert.equal(path.dirname(directory),os.tmpdir());
    assert.ok(path.basename(directory).startsWith("social-customer-access-"));
    fs.rmSync(directory,{recursive:true,force:true});
  });
  const env={ENVIRONMENT:"production",PUBLIC_API_BASE_URL:ORIGIN,
    SOCIAL_INSTAGRAM_ENABLED:"true",SOCIAL_EXTERNAL_CONNECTION_ENABLED:"true",SOCIAL_EXTERNAL_PUBLICATION_ENABLED:"true",
    SOCIAL_PRODUCTION_CUSTOMER_ACCESS_ENABLED:"true",SOCIAL_PRODUCTION_OPERATION_ALLOWLIST_JSON:"[]",
    SOCIAL_TENANT_NAMESPACE_UUID:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",SOCIAL_IDENTITY_DERIVATION_VERSION:"v1",
    SOCIAL_IDENTITY_DERIVATION_KEY:Buffer.alloc(32,17).toString("base64"),
    INSTAGRAM_APP_ID:"12345678901234",INSTAGRAM_APP_SECRET:crypto.randomBytes(32).toString("hex"),
    INSTAGRAM_GRAPH_API_VERSION:"v25.0",INSTAGRAM_OAUTH_REDIRECT_URI:`${ORIGIN}/v1/social/oauth/callback`};
  // Mutable outer gates model the worker observing a closed/reopened policy.
  const config={...loadInstagramOAuthConfig(env)};
  const clients=Object.fromEntries(OWNERS.map(owner=>[owner,{ativo:true}]));
  const readClients=()=>clients;
  const reviewerMedia=createProductionMedia({env,dataDir:directory,readClients}).media;
  const customers=[];
  for(const [index,owner] of OWNERS.entries()) {
    const authenticated=fixtureContext(owner),pool=createMemoryPool(authenticated.context);
    Object.assign(pool.state.connection,{id:crypto.randomUUID(),external_account_id:crypto.randomUUID(),
      external_id:`1784000000000000${index+1}`,active_credential_id:crypto.randomUUID()});
    const store=createPostgresConnectorStore({pool,publicationBindingRequired:true});
    const owned=await reviewerMedia.storeOwnedJpeg({context:authenticated.context,owner,bytes:JPEG,
      caption:`Legenda cliente ${index+1}`});
    const binding={connectionId:pool.state.connection.id,externalId:pool.state.connection.external_id,connectionRevision:7};
    customers.push({...authenticated,owner,pool,store,owned,binding,container:`1790000000000000${index+1}`,
      published:`1800000000000000${index+1}`});
  }
  const byCompany=new Map(customers.map(customer=>[customer.context.companyId,customer]));
  const connectorStore={scope(context){
    requireConnectorContext(context,{provider:"instagram",environment:"production"});
    const customer=byCompany.get(context.companyId);assert.ok(customer,"unexpected synthetic tenant");
    return customer.store.scope(context);
  }};
  const media=createCalendarMedia({dataDir:directory,secret:"synthetic-calendar-secret-32-bytes-minimum",
    publicOrigin:ORIGIN,loadSource:async()=>{throw new Error("generated source reached");}});
  const posts=[];
  const transport=async(url,request)=>{
    const customer=customers.find(value=>url.includes(value.binding.externalId)||url.includes(value.container)||url.includes(value.published));
    assert.ok(customer,"provider request must target one of the two distinct synthetic Instagram accounts");
    assert.equal(customer.pool.transactions,0,"provider transport must follow committed reservation");
    if(request.method==="POST") {
      const publication=[...customer.pool.state.publications.values()].find(value=>value.state==="provider_confirming");
      assert.ok(publication,"publication intent must exist before sending");
      const body=new URLSearchParams(request.body);
      if(!url.endsWith("/media_publish")) assert.equal(body.get("caption"),publication.caption);
      posts.push({companyId:customer.context.companyId,url});
      return reply({id:url.endsWith("/media_publish")?customer.published:customer.container});
    }
    if(url.includes(customer.container))return reply({status_code:"FINISHED"});
    return reply({id:customer.published,media_product_type:"FEED",
      permalink:`https://www.instagram.com/p/Synthetic${customers.indexOf(customer)+1}/`,timestamp:"2026-09-05T00:00:00Z"});
  };
  const realPublisher=createCalendarPublisher({config,connectorStore,media,transport,connectorAudit:{async append(){}},
    credentials:{async withDecryptedCredential({companyId,credentialId},action){
      const customer=byCompany.get(companyId);assert.ok(customer);
      assert.equal(credentialId,customer.pool.state.connection.active_credential_id);
      const token=Buffer.from("synthetic-token");try{return await action(token);}finally{token.fill(0);}
    }}});
  let holdDispatch=false,connectionReads=0;
  const publisher={...realPublisher,async connection(context){
    connectionReads++;
    if(holdDispatch&&connectionReads>1)throw new Error("synthetic dispatch hold");
    return realPublisher.connection(context);
  }};
  const store=memoryCalendarStore();
  calendar=createCalendarService({store,source:{list:()=>[]},media,reviewerMedia,
    grants:createCalendarGrants(crypto.randomBytes(32)),auth:customers[0].adapter,
    identity:(company,user)=>deriveSocialIdentity({namespaceUuid:env.SOCIAL_TENANT_NAMESPACE_UUID,
      derivationKey:Buffer.alloc(32,17),derivationVersion:"v1",legacyCompanyId:company,legacyUserId:user}),readClients,publisher});
  const reviewer=createInstagramRealReviewerService({config,authAdapter:customers[0].adapter,connectorStore,
    connectorAudit:{async append(){}},media:reviewerMedia,getCalendar:()=>calendar,
    createPublicationConnector(){throw new Error("direct publication bypassed calendar worker");}});
  const request=(customer,clientRequestId=crypto.randomUUID())=>({verifiedClaims:customer.claims,
    mediaId:customer.owned.mediaId,clientRequestId,expectedConnectionId:customer.binding.connectionId,
    expectedExternalId:customer.binding.externalId,expectedConnectionRevision:customer.binding.connectionRevision});
  return {config,clients,customers,calendar,reviewer,publisher,media,reviewerMedia,store,posts,request,
    holdDispatch(value){holdDispatch=value;},connectionReads:()=>connectionReads};
}

async function eventually(predicate) {
  for(let attempt=0;attempt<200;attempt++) {
    if(await predicate())return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.fail("synthetic calendar worker did not settle");
}

test("two customers outside the allowlist publish only their own bound intents through the calendar worker",async t=>{
  const f=await fixture(t),published=[];
  assert.deepEqual(f.config.productionOperations.subjects,[]);
  for(const customer of f.customers) {
    assert.equal(f.publisher.allowed(customer.context),true);
    const input=f.request(customer),first=await f.reviewer.publish(input);
    published.push({customer,input,id:first.publication.publicationId});
    await eventually(()=>[...customer.pool.state.publications.values()].some(row=>row.state==="published"));
    const record=await customer.store.scope(customer.context).getPublicationDetails(first.publication.publicationId);
    assert.deepEqual(record.binding,customer.binding);
    assert.equal(record.mediaReference,customer.owned.mediaId);
    assert.equal(record.caption.split("\n")[0],customer.owned.caption.split("\n")[0]);
    assert.equal(record.caption,Object.values(f.store.rows.get(customer.context.companyId).jobs)[0].caption);
    assert.equal((await f.reviewer.publish(input)).duplicateSubmissionPrevented,true);
    assert.equal(f.posts.filter(post=>post.companyId===customer.context.companyId).length,2);
  }
  assert.notEqual(published[0].id,published[1].id);
  await f.calendar.tick();assert.equal(f.posts.length,4);
  const [left,right]=published;
  assert.equal(await right.customer.store.scope(right.customer.context).getConnectionDetails(left.customer.binding.connectionId),null);
  assert.equal(await right.customer.store.scope(right.customer.context).getPublicationDetails(left.id),null);
  assert.equal((await f.reviewer.getPublicationIntent({verifiedClaims:right.customer.claims,
    clientRequestId:left.input.clientRequestId})).publication,null);
  await assert.rejects(f.reviewer.getPublication({verifiedClaims:right.customer.claims,publicationId:left.id}),{code:"resource_unavailable"});
  assert.equal(f.posts.length,4);
});

test("customer access does not allow foreign media, connection bindings or publication recovery",async t=>{
  const f=await fixture(t),[left,right]=f.customers;
  for(const input of [
    {...f.request(right),mediaId:left.owned.mediaId},
    {...f.request(right),expectedConnectionId:left.binding.connectionId,expectedExternalId:left.binding.externalId}
  ])await assert.rejects(f.reviewer.publish(input),error=>["resource_unavailable","calendar_connection_required"].includes(error.code));
  assert.equal(await f.reviewerMedia.resolveOwnedJpeg({context:right.context,owner:right.owner,mediaId:left.owned.mediaId}),null);
  assert.equal(await f.reviewerMedia.readOwnedJpeg({context:right.context,owner:left.owner,mediaId:left.owned.mediaId}),null);
  assert.equal(f.posts.length,0);assert.equal(left.pool.state.publications.size,0);assert.equal(right.pool.state.publications.size,0);
  const input=f.request(left),created=await f.reviewer.publish(input);
  await eventually(()=>left.pool.state.publications.get(created.publication.publicationId)?.state==="published");
  await assert.rejects(f.reviewer.reconcile({verifiedClaims:right.claims,publicationId:created.publication.publicationId,
    expectedConnectionId:left.binding.connectionId,expectedExternalId:left.binding.externalId,expectedConnectionRevision:7}),
    {code:"state_transition_invalid"});
  assert.equal(f.posts.length,2);
});

test("customer worker rechecks publication gates and resumes only the same consented intent",async t=>{
  const f=await fixture(t),customer=f.customers[0];
  f.holdDispatch(true);
  const queued=await f.reviewer.publish(f.request(customer));
  await eventually(()=>f.connectionReads()>1);
  f.config.externalPublicationEnabled=false;f.holdDispatch(false);
  await f.calendar.tick();
  assert.equal(f.posts.length,0);
  const job=Object.values(f.store.rows.get(customer.context.companyId).jobs)[0];
  assert.equal(job.phase,"ready");assert.equal(job.intent,undefined);
  assert.equal(model.availability(job,{enabled:true},customer.binding,false,Date.now()),"operations_closed");
  f.config.externalPublicationEnabled=true;
  await f.calendar.tick();
  await eventually(()=>customer.pool.state.publications.get(queued.publication.publicationId)?.state==="published");
  assert.equal(f.posts.length,2);
  assert.equal(customer.pool.state.publications.size,1);
});

test("customer worker refuses changed connection, missing grant and inactive owner",async t=>{
  for(const change of ["binding","grant","inactive"]) {
    const f=await fixture(t),customer=f.customers[0];f.holdDispatch(true);
    await f.reviewer.publish(f.request(customer));
    await eventually(()=>f.connectionReads()>1);
    if(change==="binding")customer.pool.state.connection.revision++;
    if(change==="inactive")f.clients[customer.owner].ativo=false;
    if(change==="grant")await f.store.update(customer.context.companyId,state=>{
      Object.values(state.jobs)[0].authorization.envelope="untrusted-grant";
    });
    f.holdDispatch(false);await f.calendar.tick();
    assert.equal(f.posts.length,0,`${change} must stop the worker before provider I/O`);
  }
});

test("customer flag cannot start an unprepared runtime and strict startup rejects ambiguous values",()=>{
  assert.throws(()=>assertProductionPreparationBoundary({SOCIAL_PRODUCTION_CUSTOMER_ACCESS_ENABLED:"true"}),
    {code:"social_production_preparation_incomplete"});
  for(const value of ["","TRUE"," true ","1",true,null]) {
    assert.throws(()=>assertProductionPreparationBoundary({SOCIAL_PRODUCTION_CUSTOMER_ACCESS_ENABLED:value}),
      {code:"social_production_flag_invalid"});
  }
});
