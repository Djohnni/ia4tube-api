"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const {loadRuntimePostgresConfig, databaseTargetFingerprint} = require("../src/persistence/postgres/config");
const source = fs.readFileSync(path.join(__dirname,"../src/social/production-web/reviewer.js"),"utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
async function drain() { for (let i=0;i<12;i++) await tick(); }
function element(tag="div") {
  return {tag,children:[],hidden:false,disabled:false,value:"",textContent:"",files:[],
    addEventListener(name,fn) {this[name]=fn;}, append(...nodes){this.children.push(...nodes);},
    replaceChildren(...nodes){this.children=nodes;if(tag==="select")this.value=nodes[0]?.value||"";},
    removeAttribute(name){delete this[name];}};
}
function harness({owner="owner-a",stored={},history=[]}={}) {
  const elements = new Map();
  const get = id => {if(!elements.has(id))elements.set(id,element(id==="media"?"select":"div"));return elements.get(id);};
  const token = `header.${Buffer.from(JSON.stringify({sub:owner,company_id:owner})).toString("base64url")}.signature`;
  const storage = new Map(Object.entries({"ia4tube.production.session.v2":token,...stored}));
  const calls=[];
  let connection={connectionId:"connection-new",externalId:"account-new",connectionRevision:8,state:"connected",health:"healthy",username:"new",accountType:"Business"};
  let outcome={publicationId:"publication-1",state:"provider_confirming",binding:{connectionId:"connection-old",externalId:"account-old",connectionRevision:2}};
  const context={document:{getElementById:get,createElement:element},
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},
    atob:s=>Buffer.from(s,"base64").toString("binary"),URL,crypto,
    location:{assign(){throw new Error("OAuth must be explicit and absent from these tests");}},
    fetch:async (url,options={})=>{
      calls.push({url,method:options.method||"GET",body:options.body?JSON.parse(options.body):null});
      let result={ok:true};
      if(url.endsWith("connections/instagram"))result.connection=connection;
      else if(url.endsWith("/media"))result.media=[{id:"media-1",caption:"Technical fixture",thumbnailUrl:"/fixture"}];
      else if(url.includes("/publication-intents/"))result.publication=outcome;
      else if(url.endsWith("/reconcile"))result.publication={...outcome,state:"published"};
      else if(url.endsWith("/publications")&&options.method==="POST")result.publication=outcome;
      else if(url.endsWith("/publications"))result.publications=history;
      return {ok:true,status:200,json:async()=>result};
    }};
  vm.runInNewContext(source,context,{filename:"reviewer.js"});
  return {get,calls,storage,setConnection:value=>connection=value,setOutcome:value=>outcome=value};
}
test("web resumes with GET only and never initiates OAuth or publication",async()=>{
  const h=harness();await drain();assert.equal(h.calls.length,3);assert.ok(h.calls.every(x=>x.method==="GET"));
  assert.equal(h.get("product").hidden,false);
});
test("web intent freezes original account and revision even when connection changes",async()=>{
  const h=harness();await drain();h.get("review").onclick();await drain();
  h.setConnection({connectionId:"different",externalId:"different",connectionRevision:99,state:"connected",health:"healthy"});
  h.get("refresh").onclick();await drain();h.get("publish").onclick();await drain();
  const sent=h.calls.find(x=>x.method==="POST");assert.equal(sent.body.expectedExternalId,"account-new");
  assert.equal(sent.body.expectedConnectionRevision,8);assert.equal(h.get("publish").disabled,true);
  const writes=h.calls.filter(x=>x.method==="POST").length;
  h.get("review").onclick();await drain();assert.equal(h.calls.filter(x=>x.method==="POST").length,writes);
  assert.match(h.get("status").textContent,/intenção anterior/);
});
test("history reconciliation survives lost session intent and uses stored binding, not current account",async()=>{
  const original={publicationId:"past-publication",state:"provider_confirming",caption:"Fixture",binding:{connectionId:"original-connection",externalId:"original-account",connectionRevision:3}};
  const h=harness({history:[original]});await drain();
  const button=h.get("history").children[0].children.find(x=>x.tag==="button");assert.ok(button);
  assert.equal(h.calls.filter(x=>x.method==="POST").length,0);
  button.onclick();await drain();
  const sent=h.calls.find(x=>x.method==="POST");assert.equal(sent.url,"/v1/social/reviewer/publications/past-publication/reconcile");
  assert.deepEqual(sent.body,{expectedConnectionId:"original-connection",expectedExternalId:"original-account",expectedConnectionRevision:3});
});
test("legacy publication without trustworthy binding has no reconcile button",async()=>{
  const h=harness({history:[{publicationId:"legacy",state:"provider_confirming",binding:null}]});await drain();
  assert.equal(h.get("history").children[0].children.some(x=>x.tag==="button"),false);
});
test("different company cannot inherit or display another company stored intent",async()=>{
  const otherKey="ia4tube.production.publication.intent.v3.owner-b";
  const h=harness({stored:{[otherKey]:JSON.stringify({intent:{expectedExternalId:"private-other-account"},submitted:true})}});await drain();
  h.get("review").onclick();await drain();assert.equal(h.get("publish").disabled,false);
  assert.ok(h.storage.has(otherKey));assert.ok(h.storage.has("ia4tube.production.publication.intent.v3.owner-a"));
  assert.ok(!h.get("intent").textContent.includes("private-other-account"));
});
test("lost HTTP response uses original UUID lookup; absence never creates another publication",async()=>{
  const intent={clientRequestId:crypto.randomUUID(),expectedExternalId:"original",expectedConnectionId:"original",expectedConnectionRevision:1};
  const h=harness({stored:{"ia4tube.production.publication.intent.v3.owner-a":JSON.stringify({intent,submitted:true,confirmed:false})}});
  h.setOutcome(null);await drain();h.get("reconcile").onclick();await drain();
  assert.ok(h.calls.some(x=>x.url.endsWith(intent.clientRequestId)));assert.ok(h.calls.every(x=>x.method==="GET"));
  h.get("review").onclick();await drain();assert.match(h.get("status").textContent,/intenção anterior/);
});
for(const host of ["dpg-dae4tmf40ujc73dr2dog-a","dpg-dae4tmf40ujc73dr2dog-a.oregon-postgres.render.com"]){
  test(`production runtime pins verified destination without weakening TLS: ${host}`,()=>{
    const url=new URL(`postgresql://ia4tube_social_runtime:${crypto.randomBytes(24).toString("hex")}@${host}:5432/ia4tube_social_production`);
    const env={ENVIRONMENT:"production",SOCIAL_PERSISTENCE_ENABLED:"true",DATABASE_URL:url.href,
      SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN:"ia4tube_social_runtime",SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:databaseTargetFingerprint(url)};
    if (host.includes(".")) assert.equal(loadRuntimePostgresConfig(env).enabled,true);
    else assert.throws(()=>loadRuntimePostgresConfig(env),e=>e.code==="social_database_tls_hostname_invalid");
    for(const change of [{hostname:"staging.example.test"},{pathname:"/staging"},{port:"5433"}]){
      const wrong=new URL(url);Object.assign(wrong,change);
      assert.throws(()=>loadRuntimePostgresConfig({...env,DATABASE_URL:wrong.href,SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:databaseTargetFingerprint(wrong)}),e=>e.code==="social_production_database_target_mismatch");
    }
  });
}
