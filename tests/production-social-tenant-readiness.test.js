"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { fixtureContext } = require("./helpers/publication-atomic-memory-pool");
const { createCompanyScopedRepository } = require("../src/persistence/postgres/company-scoped-repository");
const { createProductionTenantReadiness } = require("../src/social/production-tenant-readiness");

function setup(rowMode = "valid") {
  const identity = fixtureContext();
  const statements=[];let scope;
  const pool={async connect(){return {release(){},async query(sql,params=[]){
    statements.push(sql);
    if(sql.includes("set_config('ia4tube.company_id'")){scope=params[0];return {rows:[]};}
    if(!sql.startsWith("SELECT company.id"))return {rows:[]};
    assert.deepEqual(params,[identity.context.companyId,identity.context.userId,"v1"]);
    assert.equal(scope,params[0]);
    assert.match(sql,/company\.status='active' AND app_user\.status='active'/);
    assert.match(sql,/membership\.status='active' AND membership\.role='owner'/);
    if(rowMode==="error")throw new Error("SYNTHETIC_PRIVATE_DRIVER_DETAIL");
    if(rowMode==="missing")return {rows:[]};
    return {rows:[{company_id:rowMode==="foreign"?"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb":params[0],
      user_id:params[1],identity_derivation_version:"v1",role:"owner",auth_version:"1"}]};
  }}}};
  const companies=createCompanyScopedRepository({pool,identityDerivationVersion:"v1"});
  return {...identity,statements,guard:createProductionTenantReadiness({authAdapter:identity.adapter,companies})};
}

test("readiness derives official owner identity and checks three active records in one read-only snapshot",async()=>{
  const f=setup();const principal=await f.guard.assertReady(f.claims);
  assert.equal(principal.companyId,f.context.companyId);assert.equal(principal.userId,f.context.userId);
  assert.equal(f.statements.filter(q=>q.startsWith("SELECT company.id")).length,1);
  assert.equal(f.statements[0],"BEGIN");assert.equal(f.statements.at(-1),"COMMIT");
  assert.ok(f.statements.every(q=>!/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|GRANT|REVOKE|TRUNCATE)\b/.test(q)));
  assert.ok(f.statements.every(q=>!q.includes("password_hash")&&!q.includes("login_key_digest")));
});
test("missing tenant is unavailable, never auto-inserted or repaired",async()=>{
  const f=setup("missing");await assert.rejects(f.guard.assertReady(f.claims),e=>e.code==="tenant_not_provisioned");
  assert.ok(f.statements.every(q=>!q.includes("INSERT")));
});
for(const kind of ["foreign","error"])test(`readiness ${kind} result fails with sanitized fixed code`,async()=>{
  const f=setup(kind);await assert.rejects(f.guard.assertReady(f.claims),e=>
    e.code==="social_tenant_readiness_unavailable"&&!e.message.includes("SYNTHETIC_PRIVATE_DRIVER_DETAIL"));
});
for(const patch of [{company_id:"another"},{sub:"another"},{token_version:1},{iss:"another"},{aud:"another"}]){
  test(`claim mismatch ${Object.keys(patch)[0]} is rejected before database read`,async()=>{
    const f=setup();await assert.rejects(f.guard.assertReady({...f.claims,...patch}),e=>e.code==="social_session_login_required");
    assert.equal(f.statements.length,0);
  });
}
test("middleware emits only a clear safe unavailable code for unprovisioned owner",async()=>{
  const f=setup("missing");const headers={};let continued=false;
  const res={setHeader(k,v){headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await f.guard.middleware({user:f.claims},res,()=>{continued=true;});
  assert.equal(continued,false);assert.equal(res.code,503);assert.deepEqual(res.body,{ok:false,code:"tenant_not_provisioned"});
  assert.equal(headers["Cache-Control"],"private, no-store");
});
test("an unbranded principal from an alternate adapter cannot invent a tenant",async()=>{
  let read=false;
  const guard=createProductionTenantReadiness({authAdapter:{fromVerifiedJwt(){return {companyId:"forged"};}},
    companies:{async findActiveOwner(){read=true;}}});
  await assert.rejects(guard.assertReady({}),e=>e.code==="social_session_login_required");assert.equal(read,false);
});
