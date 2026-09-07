"use strict";

// Real policy, signed product sessions, encrypted/authenticated OAuth state and
// HTTP routers. Persistence/provider doubles contain synthetic material only;
// this proves authorization flow, not a physical PostgreSQL or Meta operation.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const express = require("express");
const { fixtureContext } = require("./helpers/publication-atomic-memory-pool");
const { requireConnectorContext, createConnectorContext } = require("../src/social/connectors/contract");
const { loadProductionOperationPolicy, PRODUCTION_OPERATION_ALLOWLIST_ENV } = require("../src/social/production-operation-policy");
const { loadInstagramOAuthConfig, INSTAGRAM_OAUTH_SCOPES } = require("../src/social/oauth/instagram-config");
const { APP_REVIEW_LOGIN, canExternalConnection, canExternalPublication } = require("../src/social/app-review-policy");
const { createInstagramProvider } = require("../src/social/oauth/instagram-provider");
const { createInstagramOAuthStateEnvelope } = require("../src/social/oauth/instagram-state-envelope");
const { createInstagramOAuthService } = require("../src/social/oauth/instagram-oauth-service");
const { createInstagramOAuthRouter } = require("../src/social/oauth/instagram-oauth-router");
const { createProductionSession } = require("../src/social/production-session");
const ORIGIN = "https://ia4tube-api.onrender.com";
const OWNER = "synthetic-production-scope-owner";
const OTHER = "synthetic-other-owner";
const denied = error => error?.code === "external_capability_disabled";
const pair = owner => {
  const { context } = fixtureContext(owner);
  return { companyId: context.companyId, userId: context.userId };
};
function environment(owners = [OWNER], overrides = {}) {
  return { ENVIRONMENT:"production", PUBLIC_API_BASE_URL:ORIGIN,
    SOCIAL_INSTAGRAM_ENABLED:"true", SOCIAL_EXTERNAL_CONNECTION_ENABLED:"true",
    SOCIAL_EXTERNAL_PUBLICATION_ENABLED:"true", META_APP_REVIEW_WINDOW_ENABLED:"false",
    SOCIAL_TENANT_NAMESPACE_UUID:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", SOCIAL_IDENTITY_DERIVATION_VERSION:"v1",
    SOCIAL_IDENTITY_DERIVATION_KEY:Buffer.alloc(32,17).toString("base64"),
    [PRODUCTION_OPERATION_ALLOWLIST_ENV]:JSON.stringify(owners.map(pair)),
    INSTAGRAM_APP_ID:"12345678901234", INSTAGRAM_APP_SECRET:crypto.randomBytes(32).toString("hex"),
    INSTAGRAM_GRAPH_API_VERSION:"v25.0", INSTAGRAM_OAUTH_REDIRECT_URI:`${ORIGIN}/v1/social/oauth/callback`, ...overrides };
}
function config(owners = [OWNER], overrides) { return loadInstagramOAuthConfig(environment(owners, overrides)); }

test("production scope is detached, frozen and accepts only canonical exact pairs", () => {
  const selected = pair(OWNER);
  const policy = loadProductionOperationPolicy(environment([OWNER], {
    [PRODUCTION_OPERATION_ALLOWLIST_ENV]:JSON.stringify([{userId:selected.userId.toUpperCase(),companyId:selected.companyId.toUpperCase()}])
  }));
  assert.deepEqual(policy.subjects,[selected]);
  assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.subjects) && Object.isFrozen(policy.subjects[0]));
});

const subject = pair(OWNER);
for (const [name, value] of [
  ["empty string", ""], ["non-string", []], ["null", "null"], ["object", "{}"],
  ["missing user", JSON.stringify([{companyId:subject.companyId}])],
  ["extra field", JSON.stringify([{...subject,role:"owner"}])],
  ["untrusted label", JSON.stringify([{companyId:"Meta App Review",userId:subject.userId}])],
  ["numeric user", JSON.stringify([{...subject,userId:1}])],
  ["zero UUID", JSON.stringify([{...subject,userId:"00000000-0000-0000-0000-000000000000"}])],
  ["duplicate pair", JSON.stringify([subject,subject])],
  ["duplicate normalized pair", JSON.stringify([subject,{companyId:subject.companyId.toUpperCase(),userId:subject.userId.toUpperCase()}])],
  ["duplicate field", `[{"companyId":"${subject.companyId}","userId":"${subject.userId}","userId":"${pair(OTHER).userId}"}]`],
  ["escaped field", `[{"companyId":"${subject.companyId}","user\\u0049d":"${subject.userId}"}]`],
  ["null entry", "[null]"], ["oversized", " ".repeat(8193)],
  ["too many subjects", JSON.stringify(Array.from({length:33},(_,i)=>pair(`synthetic-owner-${i}`)))]
]) test(`production scope rejects ${name} without echoing configuration`, () => {
  assert.throws(() => config([OWNER],{[PRODUCTION_OPERATION_ALLOWLIST_ENV]:value}), error => {
    assert.equal(error.code,"social_production_operation_allowlist_invalid");
    assert.doesNotMatch(error.message,new RegExp(`${subject.companyId}|${subject.userId}|Meta App Review`));
    assert.equal(error.cause,undefined);
    return true;
  });
});

test("an absent/empty scope closes production even when both global gates are open", () => {
  for (const value of [undefined,"[]"]) for (const owner of [OWNER,APP_REVIEW_LOGIN]) {
    const current = config([OWNER],{[PRODUCTION_OPERATION_ALLOWLIST_ENV]:value});
    const {context} = fixtureContext(owner);
    assert.equal(canExternalConnection(current,context),false);
    assert.equal(canExternalPublication(current,context),false);
  }
});

test("owner and fixed reviewer require their own explicit pairs and global gates", () => {
  for (const allowedOwner of [OWNER,APP_REVIEW_LOGIN]) {
    const current = config([allowedOwner]);
    for (const candidate of [OWNER,APP_REVIEW_LOGIN,OTHER]) {
      const {context} = fixtureContext(candidate);
      assert.equal(canExternalConnection(current,context),candidate===allowedOwner);
      assert.equal(canExternalPublication(current,context),candidate===allowedOwner);
    }
    for (const [connection,publication] of [[false,false],[true,false],[true,true]]) {
      const flags=config([allowedOwner],{SOCIAL_EXTERNAL_CONNECTION_ENABLED:String(connection),
        SOCIAL_EXTERNAL_PUBLICATION_ENABLED:String(publication)});
      assert.equal(canExternalConnection(flags,fixtureContext(allowedOwner).context),connection);
      assert.equal(canExternalPublication(flags,fixtureContext(allowedOwner).context),publication);
    }
  }
  assert.throws(()=>config([OWNER],{META_APP_REVIEW_WINDOW_ENABLED:"true"}));
});

test("company/user membership is paired, not a Cartesian product or a client context", () => {
  const left=pair(OWNER),right=pair(OTHER),trusted=fixtureContext(OWNER);
  const crossed=config([],{[PRODUCTION_OPERATION_ALLOWLIST_ENV]:JSON.stringify([
    {companyId:left.companyId,userId:right.userId},{companyId:right.companyId,userId:left.userId}])});
  assert.equal(canExternalConnection(crossed,trusted.context),false);
  assert.equal(canExternalPublication(crossed,trusted.context),false);
  assert.throws(()=>canExternalConnection(config(),{...trusted.context}),e=>e.code==="social_context_invalid");
  const staging=createConnectorContext({principal:trusted.adapter.fromVerifiedJwt(trusted.claims),provider:"instagram",
    environment:"staging",correlationId:crypto.randomUUID(),auditEventId:crypto.randomUUID()});
  assert.equal(canExternalConnection(config(),staging),false);
});

test("production configuration cannot silently become a staging allowlist", () => {
  assert.throws(()=>loadProductionOperationPolicy({ENVIRONMENT:"staging",[PRODUCTION_OPERATION_ALLOWLIST_ENV]:"[]"}),
    e=>e.code==="social_production_operation_allowlist_invalid");
});

function oauthFixture(t,{owners=[OWNER],overrides={},grantedScopes=INSTAGRAM_OAUTH_SCOPES}={}) {
  const current=config(owners,overrides),identity=fixtureContext(OWNER);
  const state=createInstagramOAuthStateEnvelope({environment:"production",redirectUri:current.redirectUri,
    keyVersion:"synthetic_scope_v1",derivationKey:crypto.randomBytes(32)});
  t.after(()=>state.destroy());
  const authorizations=new Map(),connections=new Map(),providerCalls=[],mutations=[];
  const refused=()=>{throw new Error("Unexpected synthetic fixture operation");};
  const actualProvider=createInstagramProvider({config:current,transport:refused});
  const provider={...actualProvider,
    async exchangeCode(_input,context){assert.equal(canExternalConnection(current,context),true);providerCalls.push("exchange");
      return {accessToken:Buffer.from("SYNTHETIC_SHORT_TOKEN"),userId:"17840000000000001",grantedScopes};},
    async exchangeLongLivedToken(_input,context){assert.equal(canExternalConnection(current,context),true);providerCalls.push("extend");
      return {accessToken:Buffer.from("SYNTHETIC_LONG_TOKEN"),expiresAt:new Date(Date.now()+3600000)};},
    async discoverProfessionalAccount(_input,context){assert.equal(canExternalConnection(current,context),true);providerCalls.push("discover");
      return {userId:"17840000000000001",username:"synthetic_account",name:"Synthetic",accountType:"business"};}
  };
  const oauthRepository={scope(context){requireConnectorContext(context,{environment:"production"});return {
    async createAuthorizationWithPendingConnection(input){mutations.push("authorize");
      authorizations.set(input.authorizationHandle,{...input,companyId:context.companyId,userId:context.userId,consumed:false});
      return {...input,status:"pending",revision:1};},
    async consumeAuthorization(input){const saved=authorizations.get(input.authorizationHandle);
      assert.ok(saved);assert.equal(saved.companyId,context.companyId);assert.equal(saved.userId,context.userId);
      assert.equal(saved.state,input.state);assert.equal(saved.sessionJti,input.sessionJti);assert.equal(saved.redirectUri,input.redirectUri);
      if(saved.consumed)throw Object.assign(new Error(),{code:"social_oauth_state_already_consumed"});
      saved.consumed=true;mutations.push("consume");return {connectionId:saved.connectionId,connectionRevision:1};},
    cancelAuthorization:refused,expireAuthorization:refused,getAuthorizationStatus:refused,
    async failAuthorizationConnection(){mutations.push("fail");return {};}
  };}};
  const connectorStore={scope(context){requireConnectorContext(context,{environment:"production"});const scoped={
    async activateConnectionWithCredential(connection,revision,_credential,metadata){
      assert.equal(connection.companyId,context.companyId);assert.equal(revision,1);
      assert.deepEqual([...metadata.grantedScopes].sort(),[...INSTAGRAM_OAUTH_SCOPES].sort());
      const saved={...connection,health:"healthy",createdAt:new Date(),connectedAt:new Date(),updatedAt:new Date(),disconnectedAt:null};
      connections.set(context.companyId,saved);mutations.push("activate");return {connection:saved};},
    disconnectConnectionLocally:refused,async getConnectionDetails(id){const row=connections.get(context.companyId);return row?.id===id?row:null;},
    async getCurrentConnectionDetails(){return connections.get(context.companyId)||null;},
    async runExclusive(operation){return operation(scoped);}
  };return scoped;}};
  const options={config:current,environment:"production",authAdapter:identity.adapter,stateEnvelope:state,provider,
    oauthRepository,connectorStore,credentials:{async withEncryptedConnectionCredential(input,operation){
      assert.ok(Buffer.isBuffer(input.plaintext));mutations.push("credential");return operation({id:input.credentialId});}}};
  const service=createInstagramOAuthService(options);
  function authenticatedState(owner){const f=fixtureContext(owner);return state.seal({purpose:"connect",...pair(owner),
    sessionJti:f.claims.jti,authorizationHandle:crypto.randomUUID(),returnPathId:"social_connections"});}
  return {service,options,state,actualProvider,providerCalls,mutations,authenticatedState,identity,connections};
}

async function serve(t,f) {
  const records={};for(const owner of [OWNER,OTHER,APP_REVIEW_LOGIN])records[owner]={ativo:true};
  records["synthetic-inactive"]={ativo:false};records["synthetic-unfinished"]={ativo:true,cadastro_automatico:true,conta_finalizada:false};
  const session=createProductionSession({secret:crypto.randomBytes(40).toString("hex"),readClients:()=>records});
  const app=express();app.use(express.json());app.use("/v1/social",createInstagramOAuthRouter({
    authenticate:session.authenticate,getService:()=>f.service}));
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return async(method,path,{owner=OWNER,body}={})=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/social${path}`,{
      method,headers:{...(owner?{Authorization:`Bearer ${session.sign(owner)}`}:{ }),
        ...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  };
}

for(const selected of [OWNER,APP_REVIEW_LOGIN]) test(`HTTP current/authorize/callback agree for explicit ${selected===OWNER?"owner":"reviewer"} scope`,async t=>{
  const f=oauthFixture(t,{owners:[selected]}),request=await serve(t,f);
  for(const candidate of [OWNER,OTHER,APP_REVIEW_LOGIN]){
    const read=await request("GET","/connections/instagram",{owner:candidate});
    assert.equal(read.status,200);assert.deepEqual(read.body.operationalAvailability,
      {connectionAllowed:candidate===selected,publicationAllowed:candidate===selected});
    assert.deepEqual(Object.keys(read.body.operationalAvailability).sort(),["connectionAllowed","publicationAllowed"]);
    if(candidate!==selected){
      assert.equal((await request("POST","/connections/instagram/authorization",{owner:candidate,body:{purpose:"connect"}})).body.code,"external_capability_disabled");
      const callback=await request("GET",`/oauth/callback?${new URLSearchParams({state:f.authenticatedState(candidate),code:"synthetic-code"})}`,{owner:null});
      assert.equal(callback.body.code,"external_capability_disabled");
    }
  }
  assert.equal(f.mutations.length,0);assert.equal(f.providerCalls.length,0);
  const started=await request("POST","/connections/instagram/authorization",{owner:selected,body:{purpose:"connect"}});
  assert.equal(started.status,201);const url=new URL(started.body.authorizationUrl);
  assert.equal(url.origin,"https://www.instagram.com");assert.equal(url.searchParams.get("redirect_uri"),`${ORIGIN}/v1/social/oauth/callback`);
  assert.deepEqual(url.searchParams.get("scope").split(","),[...INSTAGRAM_OAUTH_SCOPES]);
  const path=`/oauth/callback?${new URLSearchParams({state:url.searchParams.get("state"),code:"synthetic-code"})}`;
  const callback=await request("GET",path,{owner:null});assert.equal(callback.status,200);
  assert.equal(callback.body.status,"authorization_completed");assert.deepEqual(f.providerCalls,["exchange","extend","discover"]);
  assert.deepEqual(f.mutations,["authorize","consume","credential","activate"]);
  assert.equal((await request("GET","/connections/instagram",{owner:selected})).body.connection.state,"connected");
  assert.notEqual((await request("GET",path,{owner:null})).status,200);
  assert.equal(f.providerCalls.length,3,"callback replay never exchanges the code again");
});

test("signed inactive/unfinalized owners and client authority fields cannot authorize",async t=>{
  const f=oauthFixture(t),request=await serve(t,f);
  for(const owner of [null,"synthetic-inactive","synthetic-unfinished","synthetic-unregistered"]){
    assert.equal((await request("GET","/connections/instagram",{owner})).status,401);
    assert.equal((await request("POST","/connections/instagram/authorization",{owner,body:{purpose:"connect"}})).status,401);
  }
  for(const field of ["companyId","company_id","userId","role","userAgent","productionOperations"]){
    assert.notEqual((await request("POST","/connections/instagram/authorization",{body:{purpose:"connect",[field]:pair(OWNER).companyId}})).status,201);
    assert.notEqual((await request("GET",`/connections/instagram?${field}=owner`)).status,200);
  }
  assert.equal(f.providerCalls.length,0);assert.equal(f.mutations.length,0);
});

test("removing the scope after authorization refuses callback before consume/token exchange",async t=>{
  const f=oauthFixture(t);const started=await f.service.authorize({verifiedClaims:f.identity.claims,purpose:"connect"});
  const closed=createInstagramOAuthService({...f.options,config:config([])});
  const state=new URL(started.authorizationUrl).searchParams.get("state");
  assert.deepEqual((await closed.getCurrentConnection({verifiedClaims:f.identity.claims})).operationalAvailability,
    {connectionAllowed:false,publicationAllowed:false});
  await assert.rejects(closed.callback({state,code:"synthetic-code",error:null}),denied);
  assert.deepEqual(f.mutations,["authorize"]);assert.equal(f.providerCalls.length,0);
});

test("missing provider permission cannot activate a scoped connection",async t=>{
  const f=oauthFixture(t,{grantedScopes:["instagram_business_basic"]});
  const started=await f.service.authorize({verifiedClaims:f.identity.claims,purpose:"connect"});
  await assert.rejects(f.service.callback({state:new URL(started.authorizationUrl).searchParams.get("state"),code:"synthetic-code",error:null}),
    e=>["permission_missing","social_oauth_exchange_failed"].includes(e.code));
  assert.equal(f.connections.size,0);assert.ok(!f.mutations.includes("credential"));
});

test("the production provider rejects absent/forged/unlisted context before any transport",async t=>{
  const f=oauthFixture(t),state=f.authenticatedState(OWNER);
  for(const context of [undefined,{...f.identity.context},fixtureContext(OTHER).context]){
    assert.throws(()=>f.actualProvider.buildAuthorizationUrl({state},context));
    await assert.rejects(f.actualProvider.exchangeCode({code:"synthetic-code"},context));
    await assert.rejects(f.actualProvider.exchangeLongLivedToken({accessToken:Buffer.from("SYNTHETIC_TOKEN")},context));
    await assert.rejects(f.actualProvider.discoverProfessionalAccount({accessToken:Buffer.from("SYNTHETIC_TOKEN"),userId:"17840000000000001"},context));
  }
});
