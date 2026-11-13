"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {prepareCourtesy,runStartupCourtesy}=require("../src/maintenance/one-time-plan-courtesy");
const billing=require("../src/billing/billing.service"),plans=require("../src/billing/plans");
const NOW=new Date("2099-01-16T12:00:00Z"),request={target:"159911205999",operationId:"courtesy_synthetic_20990116",planId:"i4_combo_20i_15v_v1",expiresAt:"2099-01-17T12:00:00Z"};
function fixture(){const account={ativo:true,passwordHash:"private-preserved",instagram:"kept",saldo_extra:17};
  billing.applyManualPlanPayment(account,plans.getPlan(request.planId),{paidAt:"2099-01-15T12:00:00Z"});account.artes_mensais_usadas=17;account.artes_mensais_restantes=3;account.videos_mensais_usados=15;account.videos_mensais_restantes=0;
  return {[request.target]:account,other:{ativo:true,balance:99}};}
test("authorized replacement refills only the intended account and preserves unrelated data",()=>{
  const before=fixture(),original=structuredClone(before),result=prepareCourtesy(before,request,NOW),target=result.document[request.target];
  assert.deepEqual(before,original);assert.deepEqual(result.document.other,before.other);
  assert.equal(target.artes_mensais_restantes,20);assert.equal(target.videos_mensais_restantes,15);
  assert.equal(target.passwordHash,before[request.target].passwordHash);assert.equal(target.instagram,"kept");assert.equal(target.saldo_extra,17);
  assert.equal(target.ultimo_pagamento_plano_em,before[request.target].ultimo_pagamento_plano_em);
  assert.notEqual(target.plano_cotas_concessao_id,before[request.target].plano_cotas_concessao_id);
  assert.equal(target.plano_renova_em,"2099-02-16T12:00:00.000Z");assert.equal(result.summary.paymentCreated,false);
});
test("replay after credits were spent never grants them again, including after expiry",()=>{
  const first=prepareCourtesy(fixture(),request,NOW).document;first[request.target].artes_mensais_restantes=19;first[request.target].artes_mensais_usadas=1;
  const replay=prepareCourtesy(first,request,new Date("2099-02-20T00:00:00Z"));assert.equal(replay.changed,false);assert.deepEqual(replay.document,first);
});
test("missing account, changed plan, expiration and a paid renewal prevent any mutation",()=>{
  for(const change of [d=>delete d[request.target],d=>d[request.target].plano_atual="different",d=>d[request.target].plano_proximo_ciclo_pago=true]){
    const doc=fixture();change(doc);const before=structuredClone(doc);assert.throws(()=>prepareCourtesy(doc,request,NOW));assert.deepEqual(doc,before);
  }
  assert.throws(()=>prepareCourtesy(fixture(),request,new Date(request.expiresAt)),{code:"courtesy_request_expired"});
});
test("private backup precedes one atomic write and disabled maintenance performs no reads",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"courtesy-test-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let doc=fixture(),writes=0;const original=structuredClone(doc);const options={requestJson:JSON.stringify(request),dataDir:root,now:NOW,readClients:()=>structuredClone(doc),writeClients:next=>{
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,"private/admin-courtesies",request.operationId+".before.json"))),original[request.target]);doc=next;writes++;
  }};
  assert.equal(runStartupCourtesy({...options,requestJson:"",readClients:()=>{throw Error("must not read");}}),null);
  assert.equal(runStartupCourtesy(options).status,"applied");assert.equal(runStartupCourtesy(options).status,"already_applied");assert.equal(writes,1);
});
