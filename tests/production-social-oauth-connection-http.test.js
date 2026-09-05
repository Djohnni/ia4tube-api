"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const express = require("express");
const { fixtureContext, createMemoryPool } = require("./helpers/publication-atomic-memory-pool");
const { createPostgresConnectorStore } = require("../src/persistence/postgres/social-connector-store");
const { createInstagramOAuthService } = require("../src/social/oauth/instagram-oauth-service");
const { createInstagramOAuthRouter } = require("../src/social/oauth/instagram-oauth-router");
const { createProductionSession } = require("../src/social/production-session");
const { loadInstagramOAuthConfig } = require("../src/social/oauth/instagram-config");

function fixture() {
  const identity = fixtureContext();
  const pool = createMemoryPool(identity.context);
  const store = createPostgresConnectorStore({pool,publicationBindingRequired:true});
  const refused = () => { throw new Error("Unexpected external operation in local GET fixture"); };
  const config = loadInstagramOAuthConfig({ ENVIRONMENT:"production", PUBLIC_API_BASE_URL:"https://ia4tube-api.onrender.com",
    SOCIAL_INSTAGRAM_ENABLED:"true", SOCIAL_EXTERNAL_CONNECTION_ENABLED:"true", SOCIAL_EXTERNAL_PUBLICATION_ENABLED:"false",
    INSTAGRAM_APP_ID:"12345678901234",INSTAGRAM_APP_SECRET:crypto.randomBytes(32).toString("hex"),
    INSTAGRAM_GRAPH_API_VERSION:"v25.0",INSTAGRAM_OAUTH_REDIRECT_URI:"https://ia4tube-api.onrender.com/v1/social/oauth/callback" });
  const options = {config,environment:"production",authAdapter:identity.adapter,
    stateEnvelope:{seal:refused,open:refused,openForCallback:refused},
    provider:{buildAuthorizationUrl:refused,exchangeCode:refused,exchangeLongLivedToken:refused,discoverProfessionalAccount:refused},
    oauthRepository:{scope:refused},credentials:{withEncryptedConnectionCredential:refused},
    connectorStore:{scope(context){const scoped=store.scope(context);return {...scoped,
      // No DELETE or real disconnect occurs. This controlled persistence double
      // models only the returned disconnected row; service + HTTP are real.
      async disconnectConnectionLocally(id){
        assert.equal(id,pool.state.connection.id);
        Object.assign(pool.state.connection,{status:"disconnected",external_account_status:"revoked",
          active_credential_id:null,revision:8,disconnected_at:new Date("2026-09-05T00:00:00Z")});
        return scoped.getConnectionDetails(id);
      }};}}};
  const service=createInstagramOAuthService(options);
  return {...identity,pool,service,options};
}

async function serve(t, f, service = f.service) {
  const app=express();app.use(express.json());
  const session=createProductionSession({secret:crypto.randomBytes(40).toString("hex"),
    readClients:()=>({[f.claims.whatsapp]:{ativo:true}})});
  const token=session.sign(f.claims.whatsapp);
  app.use("/v1/social",createInstagramOAuthRouter({authenticate:session.authenticate,getService:()=>service}));
  const server=http.createServer(app);
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const port=server.address().port;
  assert.ok(Number.isInteger(port)&&port>0);
  async function request(method,path,{authenticated=true}={}) {
    return new Promise((resolve,reject)=>{
      const req=http.request({host:"127.0.0.1",port,path:`/v1/social${path}`,method,
        headers:authenticated?{authorization:`Bearer ${token}`}:{},timeout:2000},res=>{
        let text="";res.setEncoding("utf8");res.on("data",chunk=>{text+=chunk;});
        res.on("end",()=>{try{resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(text)});}catch(error){reject(error);}});
      });req.on("timeout",()=>req.destroy(new Error("Local HTTP fixture timeout")));req.on("error",reject);req.end();
    });
  }
  return request;
}

test("real production session + OAuth service + GET router returns stable account and revision",async t=>{
  const f=fixture(),request=await serve(t,f);
  const result=await request("GET","/connections/instagram");
  assert.equal(result.status,200);assert.equal(result.body.ok,true);
  assert.equal(result.body.connection.externalId,f.pool.state.connection.external_id);
  assert.equal(result.body.connection.connectionRevision,7);
  assert.equal(result.body.connection.username,"@synthetic_account");
  assert.equal(result.headers["cache-control"],"no-store");
  assert.ok(!JSON.stringify(result.body).includes("activeCredentialId"));
  assert.equal((await request("GET","/connections/instagram",{authenticated:false})).status,401);
  assert.equal((await request("GET","/connections/instagram?company_id=other")).status,400);
});

test("real GET by ID and disconnect normalizer retain revision, null all account fields together",async t=>{
  const f=fixture(),request=await serve(t,f),path=`/connections/instagram/${f.pool.state.connection.id}`;
  const found=await request("GET",path);assert.equal(found.status,200);assert.equal(found.body.connection.connectionRevision,7);
  const disconnected=await request("DELETE",path);
  assert.equal(disconnected.status,200);assert.equal(disconnected.body.connection.state,"disconnected");
  assert.equal(disconnected.body.connection.connectionRevision,8);
  for(const key of ["username","accountType","externalId"])assert.equal(disconnected.body.connection[key],null);
  assert.equal((await request("GET",path)).status,200);
});

test("optional GET current still returns null for no connection",async t=>{
  const f=fixture();f.pool.state.connection.company_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const request=await serve(t,f);const result=await request("GET","/connections/instagram");
  assert.equal(result.status,200);assert.deepEqual(result.body,{ok:true,connection:null});
});

for(const [name,patch] of [
  ["missing revision",{connectionRevision:undefined}],["null revision",{connectionRevision:null}],
  ["string revision",{connectionRevision:"7"}],["unsafe revision",{connectionRevision:Number.MAX_SAFE_INTEGER+1}],
  ["zero revision",{connectionRevision:0}],["fraction revision",{connectionRevision:1.2}],
  ["numeric external ID",{externalId:17840000000000001}],["missing external ID",{externalId:undefined}],
  ["external ID account mismatch",{externalId:null}],["short external ID",{externalId:"1234"}],
  ["extra field",{unexpected:"forbidden"}]
])test(`real HTTP normalizer refuses ${name}`,async t=>{
  const f=fixture();const real=await f.service.getCurrentConnection({verifiedClaims:f.claims});
  const service={...f.service,async getCurrentConnection(){return {...real,connection:{...real.connection,...patch}};}};
  const request=await serve(t,f,service);const result=await request("GET","/connections/instagram");
  assert.equal(result.status,503);assert.deepEqual(result.body,{ok:false,code:"social_connection_response_invalid"});
});

test("normalizer output is detached and frozen at the real route response boundary",async()=>{
  const f=fixture();const route=createInstagramOAuthRouter({authenticate(_req,_res,next){next();},getService:()=>f.service});
  const handler=route.stack.find(layer=>layer.route?.path==="/connections/instagram").route.stack.at(-1).handle;
  const res={status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await handler({user:f.claims,query:{},params:{}},res);
  assert.equal(res.code,200);assert.ok(Object.isFrozen(res.body));assert.ok(Object.isFrozen(res.body.connection));
});

test("production service refuses staging callback or mixed environments before use",()=>{
  const f=fixture();
  assert.throws(()=>createInstagramOAuthService({...f.options,config:{...f.options.config,
    redirectUri:"https://ia4tube-api-staging-checkpoint-a.onrender.com/v1/social/oauth/callback"}}),
  e=>e.code==="social_instagram_configuration_invalid");
  assert.throws(()=>createInstagramOAuthService({...f.options,environment:"staging"}),e=>e.code==="social_instagram_configuration_invalid");
});
