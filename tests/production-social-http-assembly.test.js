"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const express=require("express");
const {loadInstagramOAuthConfig,INSTAGRAM_OAUTH_REDIRECT_URI}=require("../src/social/oauth/instagram-config");
const {createInstagramProvider}=require("../src/social/oauth/instagram-provider");
const {createInstagramOAuthStateEnvelope}=require("../src/social/oauth/instagram-state-envelope");
const {createProductionSession}=require("../src/social/production-session");
const {createSocialAuthAdapter}=require("../src/social/auth-adapter");
const {databaseTargetFingerprint}=require("../src/persistence/postgres/config");
const {initializeSocialServerRuntime}=require("../src/social/server-runtime");
function environment(){
 const url=new URL(`postgresql://ia4tube_social_runtime:${crypto.randomBytes(24).toString("hex")}@dpg-dae4tmf40ujc73dr2dog-a.oregon-postgres.render.com:5432/ia4tube_social_production`);
 return {ENVIRONMENT:"production",PUBLIC_API_BASE_URL:"https://ia4tube-api.onrender.com",SOCIAL_PERSISTENCE_ENABLED:"true",SOCIAL_INSTAGRAM_ENABLED:"true",REAL_REVIEWER_UI_ENABLED:"true",
 SOCIAL_EXTERNAL_CONNECTION_ENABLED:"false",SOCIAL_EXTERNAL_PUBLICATION_ENABLED:"false",DATABASE_URL:url.href,
 SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:databaseTargetFingerprint(url),SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN:"ia4tube_social_runtime",
 SOCIAL_IDENTITY_DERIVATION_KEY:crypto.randomBytes(32).toString("base64"),SOCIAL_TENANT_NAMESPACE_UUID:crypto.randomUUID(),SOCIAL_IDENTITY_DERIVATION_VERSION:"identity_v1",
 INSTAGRAM_APP_ID:"12345678901234",INSTAGRAM_APP_SECRET:crypto.randomBytes(32).toString("hex"),INSTAGRAM_GRAPH_API_VERSION:"v25.0",
 INSTAGRAM_OAUTH_REDIRECT_URI:"https://ia4tube-api.onrender.com/v1/social/oauth/callback"};
}
test("production provider and authenticated state use official callback, never staging, with no network",()=>{
 const env=environment(),config=loadInstagramOAuthConfig(env),key=crypto.randomBytes(32);
 const state=createInstagramOAuthStateEnvelope({environment:"production",redirectUri:config.redirectUri,keyVersion:"synthetic_v1",derivationKey:key});
 const stage=createInstagramOAuthStateEnvelope({redirectUri:INSTAGRAM_OAUTH_REDIRECT_URI,keyVersion:"synthetic_v1",derivationKey:key});
 try{
 const sealed=state.seal({purpose:"connect",companyId:crypto.randomUUID(),userId:crypto.randomUUID(),sessionJti:crypto.randomUUID(),authorizationHandle:crypto.randomUUID(),returnPathId:"social_connections"});
 assert.equal(state.open(sealed).purpose,"connect");assert.throws(()=>stage.open(sealed));
 const provider=createInstagramProvider({config:{...config,externalConnectionEnabled:true},transport:()=>{throw new Error("Network forbidden");}});
 const url=new URL(provider.buildAuthorizationUrl({state:sealed}));assert.equal(url.searchParams.get("redirect_uri"),config.redirectUri);
 assert.equal(url.origin,"https://www.instagram.com");assert.deepEqual(url.searchParams.get("scope").split(","),["instagram_business_basic","instagram_business_content_publish"]);
 assert.throws(()=>createInstagramProvider({config:{...config,redirectUri:INSTAGRAM_OAUTH_REDIRECT_URI}}));
 }finally{state.destroy();stage.destroy();key.fill(0);}
});
test("actual production HTTP assembly preserves authenticated read-only prerequisites and parser ordering",async t=>{
 const env=environment(),secret=crypto.randomBytes(40).toString("hex"),owner="synthetic-http-owner";
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),"ia4tube-http-assembly-"));
 let closed=0,provisioned=true;
 const auth=createSocialAuthAdapter({namespaceUuid:env.SOCIAL_TENANT_NAMESPACE_UUID,derivationVersion:env.SOCIAL_IDENTITY_DERIVATION_VERSION,key:Buffer.from(env.SOCIAL_IDENTITY_DERIVATION_KEY,"base64")});
 const companies={async findActiveOwner({companyId,userId}){return provisioned?{companyId,userId,role:"owner",identityDerivationVersion:env.SOCIAL_IDENTITY_DERIVATION_VERSION}:null;}};
 const unavailable=async()=>{throw Object.assign(new Error(),{code:"external_capability_disabled"});};
 const service={authorize:unavailable,callback:unavailable,disconnect:unavailable,getAuthorizationStatus:unavailable,getConnection:unavailable,getConnectionHealth:unavailable,
 async getCurrentConnection(){return {ok:true,connection:null};}};
 const reviewer={getPublication:unavailable,listMedia:async()=>({ok:true,media:[]}),listPublications:async()=>({ok:true,publications:[]}),publish:unavailable,reconcile:unavailable};
 const fakeRuntime={enabled:true,auth,companies,instagramOAuth:service,instagramReviewer:reviewer,instagramPublication:null,metaCompliance:null,close:async()=>{closed++;}};
 const modulePath=require.resolve("../src/social/server-runtime");
 const original=require.cache[modulePath].exports;
 require.cache[modulePath].exports={...original,initializeSocialServerRuntime:options=>initializeSocialServerRuntime({...options,createRuntime:async()=>fakeRuntime})};
 const {createProductionSocialIntegration}=require("../src/social/production-integration");
 const integration=createProductionSocialIntegration({env});
 let server;
 t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await integration.close();require.cache[modulePath].exports=original;
 assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith("ia4tube-http-assembly-"));fs.rmSync(directory,{recursive:true,force:true});});
 await integration.initialize({secret,readClients:()=>({[owner]:{ativo:true}}),dataDir:directory});
 const app=express();app.use("/v1/social",integration.middleware);integration.mountWeb(app);app.use(express.json({limit:"50mb"}));
 server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const headers={Authorization:`Bearer ${createProductionSession({secret,readClients:()=>({[owner]:{ativo:true}})}).sign(owner)}`};
 assert.equal((await fetch(`${base}/v1/social/connections/instagram`)).status,401);
 const read=await fetch(`${base}/v1/social/connections/instagram`,{headers});assert.equal(read.status,200);assert.deepEqual(await read.json(),{ok:true,connection:null});
 provisioned=false;const blocked=await fetch(`${base}/v1/social/connections/instagram`,{headers});assert.equal(blocked.status,503);assert.equal((await blocked.json()).code,"tenant_not_provisioned");provisioned=true;
 const page=await fetch(`${base}/reviewer`);assert.equal(page.status,200);assert.match(page.headers.get("content-security-policy"),/default-src 'self'/);assert.match(await page.text(),/Conectar Instagram/);
 const wrongOrigin=await fetch(`${base}/v1/social/reviewer/media`,{headers:{...headers,Origin:"https://foreign.invalid"}});assert.equal(wrongOrigin.status,403);
 const tooLarge=await fetch(`${base}/v1/social/connections/instagram/authorization`,{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({purpose:"x".repeat(17000)})});assert.equal(tooLarge.status,400);
 const gated=await fetch(`${base}/v1/social/connections/instagram/authorization`,{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({purpose:"connect"})});assert.equal(gated.status,503);
 await integration.close();await integration.close();assert.equal(closed,1);
});
