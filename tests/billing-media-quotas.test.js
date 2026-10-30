"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const plans = require("../src/billing/plans");
const billing = require("../src/billing/billing.service");
const NOW = new Date("2099-01-16T12:00:00.000Z");
const expected = [
  ["i4_imagens_10_v1", "Imagens", 69, 10, 0],
  ["i4_combo_10i_4v_v1", "Essencial", 99, 10, 4],
  ["i4_combo_15i_6v_v1", "Destaque", 139, 15, 6],
  ["i4_combo_20i_10v_v1", "Profissional", 199, 20, 10],
  ["i4_combo_20i_15v_v1", "Empresarial", 259, 20, 15]
];
function paid(id = expected[1][0], paymentId = "fixture-payment", at = "2099-01-15T12:00:00.000Z", client = {}) {
  billing.applyManualPlanPayment(client, plans.getPlan(id), { paymentId, paidAt: at });
  return client;
}
const status = client => billing.getMediaQuotaStatus(client, NOW);

test("only the five approved typed combos are offered; historical IDs still resolve unchanged", () => {
  assert.deepEqual(plans.listPlans().map(p => [p.id, p.name, p.price, p.imagesPerMonth, p.videosPerMonth]), expected);
  for (const p of plans.listPlans()) { assert.equal(p.quotaVersion, 1); assert.equal(p.artsPerMonth, p.imagesPerMonth); }
  for (const [id, price, quantity] of [["i4_essencial",39.9,8],["i4_profissional",79.9,20],["i4_empresarial",149.9,40]]) {
    const p = plans.getPlan(id); assert.equal(p.price, price); assert.equal(p.artsPerMonth, quantity);
    assert.equal(p.quotaVersion, undefined); assert.equal(plans.listPlans().some(row => row.id === id), false);
    assert.equal(plans.getPurchasablePlan(id),null);
  }
  assert.equal(plans.getSingleArtPurchase().id, "arte_avulsa_599");
  assert.equal(plans.getSingleArtPurchase().amount, 5.99);
  for(const id of ["__proto__","constructor","missing"]) {
    assert.equal(plans.getPlan(id),null);assert.equal(plans.getPurchasablePlan(id),null);
  }
});

for (const [id, , , images, videos] of expected) test(`grant ${id} creates only canonical image and video pools`, () => {
  const client = paid(id), q = status(client);
  assert.equal(client.plano_cotas_versao, 1);
  assert.deepEqual(q.monthly, { image: {total:images,used:0,remaining:images}, video:{total:videos,used:0,remaining:videos} });
  assert.equal(Object.keys(client).some(key => key.startsWith("imagens_mensais_")), false);
  assert.match(q.grantRef.grantId, /^[a-f0-9]{64}$/);
  assert.equal(q.grantRef.grantId, client.plano_cotas_concessao_id);
  assert.equal(JSON.stringify(q.grantRef).includes("fixture-payment"), false);
});

test("one video consumes one video unit and no intermediate image unit", () => {
  const client = paid(), q = status(client), ref = q.grantRef;
  billing.consumeMonthlyMediaQuota(client,"video",1,ref,NOW);
  assert.deepEqual(status(client).monthly, {image:q.monthly.image,video:{total:4,used:1,remaining:3}});
  billing.consumeMonthlyMediaQuota(client,"image",1,ref,NOW);
  assert.deepEqual(status(client).monthly, {image:{total:10,used:1,remaining:9},video:{total:4,used:1,remaining:3}});
});

test("exhaustion is independent and the image-only combo grants no monthly video", () => {
  const client = paid(), ref = status(client).grantRef;
  billing.consumeMonthlyMediaQuota(client,"video",4,ref,NOW);
  assert.throws(() => billing.consumeMonthlyMediaQuota(client,"video",1,ref,NOW), {code:"billing_required"});
  assert.equal(status(client).monthly.image.remaining, 10);
  billing.consumeMonthlyMediaQuota(client,"image",10,ref,NOW);
  assert.throws(() => billing.consumeMonthlyMediaQuota(client,"image",1,ref,NOW), {code:"billing_required"});
  const only = paid(expected[0][0]);
  assert.throws(() => billing.consumeMonthlyMediaQuota(only,"video",1,status(only).grantRef,NOW), {code:"billing_required"});
  assert.equal(status(only).monthly.image.remaining, 10);
});

test("refund returns only to the original media pool and cannot create excess credit", () => {
  const client = paid(), ref = status(client).grantRef;
  billing.consumeMonthlyMediaQuota(client,"video",1,ref,NOW);
  billing.refundMonthlyMediaQuota(client,"video",1,ref,NOW);
  assert.equal(status(client).monthly.video.remaining, 4); assert.equal(status(client).monthly.image.remaining, 10);
  assert.throws(() => billing.refundMonthlyMediaQuota(client,"video",1,ref,NOW), {code:"billing_media_quota_invalid_refund"});
});

test("same-calendar-month plan changes cannot receive the previous grant's refund", () => {
  const client = paid(), old = status(client).grantRef;
  billing.consumeMonthlyMediaQuota(client,"video",1,old,NOW);
  paid(expected[2][0], "new-payment", "2099-01-16T10:00:00Z", client);
  assert.equal(client.plano_ciclo,"2099-01"); assert.notDeepEqual(status(client).grantRef,old);
  const before = structuredClone(client);
  assert.throws(() => billing.refundMonthlyMediaQuota(client,"video",1,old,NOW), {code:"billing_media_quota_grant_changed"});
  assert.deepEqual(client,before);
});

test("reader is pure including scheduled rollover and activation expires both pools", () => {
  const client = paid(); billing.consumeMonthlyMediaQuota(client,"video",2,status(client).grantRef,NOW);
  paid(expected[1][0], "next-payment", "2099-01-17T12:00:00Z", client);
  const before = structuredClone(client), due = new Date("2099-02-15T12:00:00Z");
  const projected = billing.getMediaQuotaStatus(client,due);
  assert.deepEqual(client,before); assert.deepEqual(projected.monthly.video,{total:4,used:0,remaining:4});
  billing.refreshManualPlanCycle(client,due); assert.deepEqual(billing.getMediaQuotaStatus(client,due),projected);
  const expired = billing.getMediaQuotaStatus(client,new Date("2099-03-16T12:00:00Z"));
  assert.equal(expired.active,false); assert.equal(expired.monthly.image.remaining,0); assert.equal(expired.monthly.video.remaining,0);
});

test("a grant without a payment has a persistent identity including its scheduled cycle", () => {
  const client = paid(expected[1][0], null);
  const first = status(client).grantRef; assert.deepEqual(status(client).grantRef,first);
  assert.match(first.grantId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  paid(expected[1][0], null, "2099-01-17T12:00:00Z", client);
  const before = structuredClone(client), due = new Date("2099-02-15T12:00:00Z");
  const one = billing.getMediaQuotaStatus(client,due), two = billing.getMediaQuotaStatus(client,due);
  assert.deepEqual(one.grantRef,two.grantRef); assert.deepEqual(client,before);
  billing.refreshManualPlanCycle(client,due); assert.deepEqual(billing.getMediaQuotaStatus(client,due).grantRef,one.grantRef);
});

test("pre-existing purchased extras are preserved and are not duplicated by typed grants", () => {
  const client = paid(expected[0][0],"payment-extra",undefined,{artes_avulsas_restantes:2,artes_avulsas_usadas:1,
    artes_avulsas_total_compradas:3,artes_avulsas_compras:[{purchase_id:"old",status:"approved"}],saldo_extra:12});
  assert.equal(client.artes_avulsas_restantes,2); assert.equal(client.artes_avulsas_total_compradas,3);
  assert.equal(client.saldo_extra,12); assert.equal(billing.hasAvailableStandaloneArt(client),true);
  assert.equal(status(client).monthly.video.remaining,0);
});

test("historical plan activation and shared consumption keep their original regime", () => {
  const client = paid("i4_essencial"), before = structuredClone(client), q = status(client);
  assert.equal(q.policyVersion,0); assert.equal(q.grantRef,null); assert.deepEqual(q.monthly.image,q.monthly.video);
  assert.deepEqual(client,before);
  const charge = billing.resolveCompanyArtCharge(client,{custoPedido:5.99,now:NOW});
  billing.applyResolvedCompanyArtCharge(client,charge,{custoPedido:5.99,mesAtual:"2099-01",pedidoId:"old-order"});
  assert.equal(client.artes_mensais_restantes,7); assert.equal(client.artes_mensais_usadas,1);
  assert.equal(client.plano_cotas_versao,undefined); assert.equal(client.videos_mensais_restantes,undefined);
});

test("an old pending product still activates shared rights after a typed plan", () => {
  const client = paid(); paid("i4_empresarial","old-pix","2099-01-16T10:00:00Z",client);
  assert.equal(client.artes_mensais_total,40); assert.equal(status(client).policyVersion,0);
  assert.equal(client.videos_mensais_total,undefined); assert.equal(client.plano_cotas_concessao_id,undefined);
});

test("new-product payment replay after a persisted grant cannot reset stock or add a cycle",()=>{
  const client=paid(); const ref=status(client).grantRef;
  billing.consumeMonthlyMediaQuota(client,"video",1,ref,NOW);
  const reboot=JSON.parse(JSON.stringify(client)), before=structuredClone(reboot);
  const result=billing.applyManualPlanPayment(reboot,plans.getPlan(expected[1][0]),{
    paymentId:"fixture-payment",paidAt:"2099-01-15T12:00:00Z"});
  assert.equal(result.status,"activated_from_payment_date");assert.equal(result.duplicate,true);
  assert.deepEqual(reboot,before);assert.equal(reboot.videos_mensais_restantes,3);
  assert.equal(reboot.plano_proximo_ciclo_pago,undefined);
  assert.deepEqual(Object.keys(reboot.plano_cotas_pagamentos).length,1);
  assert.equal(JSON.stringify(reboot.plano_cotas_pagamentos).includes("fixture-payment"),false);
});

test("new-product scheduled-cycle replay preserves its saved grant identity and current stock",()=>{
  const client=paid();billing.consumeMonthlyMediaQuota(client,"image",2,status(client).grantRef,NOW);
  paid(expected[1][0],"next-payment","2099-01-17T12:00:00Z",client);
  const reboot=JSON.parse(JSON.stringify(client)), before=structuredClone(reboot);
  const result=billing.applyManualPlanPayment(reboot,plans.getPlan(expected[1][0]),{
    paymentId:"next-payment",paidAt:"2099-01-17T12:00:00Z"});
  assert.equal(result.duplicate,true);assert.equal(result.status,"scheduled_next_cycle");assert.deepEqual(reboot,before);
  assert.equal(reboot.artes_mensais_restantes,8);
});

test("a typed payment receipt cannot be reused for a different plan or overwritten by malformed history",()=>{
  const client=paid(), before=structuredClone(client);
  assert.throws(()=>billing.applyManualPlanPayment(client,plans.getPlan(expected[2][0]),{
    paymentId:"fixture-payment",paidAt:"2099-01-15T12:00:00Z"}),{code:"billing_media_quota_payment_conflict"});
  assert.deepEqual(client,before);
  const bad={plano_cotas_pagamentos:[]};
  assert.throws(()=>paid(expected[1][0],"p","2099-01-15T12:00:00Z",bad),{code:"billing_media_quota_invalid"});
  assert.deepEqual(bad,{plano_cotas_pagamentos:[]});
  const corrupt=paid();const key=Object.keys(corrupt.plano_cotas_pagamentos)[0];corrupt.plano_cotas_pagamentos[key]=null;
  const snapshot=structuredClone(corrupt);
  assert.throws(()=>paid(expected[1][0],"fixture-payment","2099-01-15T12:00:00Z",corrupt),
    {code:"billing_media_quota_payment_conflict"});assert.deepEqual(corrupt,snapshot);
});

test("historical payment flow keeps its original return and creates no typed receipt ledger",()=>{
  const client=paid("i4_essencial");
  const result=billing.applyManualPlanPayment(client,plans.getPlan("i4_essencial"),{
    paymentId:"fixture-payment",paidAt:"2099-01-15T12:00:00Z"});
  assert.equal(result.status,"scheduled_next_cycle");assert.equal(result.duplicate,undefined);
  assert.equal(client.plano_cotas_pagamentos,undefined);
});

test("billing DTO exposes independent monthly quotas without a second persisted image counter", () => {
  const client = paid(), value = billing.getBillingStatus(client,NOW);
  assert.equal(value.quotaVersion,1); assert.deepEqual(value.imageQuota,{total:10,used:0,remaining:10});
  assert.deepEqual(value.videoQuota,{total:4,used:0,remaining:4}); assert.equal(value.combos.length,5);
});

test("malformed typed state, kind, quantity and stale references fail without debit", () => {
  for (const quantity of [0,-1,.5,NaN,Number.MAX_SAFE_INTEGER+1]) {
    const client = paid(), before = structuredClone(client);
    assert.throws(() => billing.consumeMonthlyMediaQuota(client,"video",quantity,status(client).grantRef,NOW),
      {code:"billing_media_quota_invalid_quantity"}); assert.deepEqual(client,before);
  }
  const client = paid(); assert.throws(() => billing.consumeMonthlyMediaQuota(client,"audio",1,status(client).grantRef,NOW),
    {code:"billing_media_quota_invalid_kind"});
  assert.throws(() => billing.consumeMonthlyMediaQuota(client,"video",1,null,NOW), {code:"billing_media_quota_grant_changed"});
  const bad = paid(); delete bad.videos_mensais_total; assert.throws(() => status(bad),{code:"billing_media_quota_invalid"});
  const unknown = paid(); unknown.plano_cotas_versao=2; assert.throws(() => status(unknown),{code:"billing_media_quota_invalid"});
  assert.throws(() => billing.consumeMonthlyMediaQuota(paid("i4_essencial"),"video",1,null,NOW),{code:"billing_media_quota_not_typed"});
});

// Run only the real handler function in an inert VM; never import server.js.
function legacyFixture(concurrentImages, failDebit = false, legacyOwner = false) {
  const owner="synthetic-owner", original=paid(legacyOwner?"i4_essencial":expected[1][0]); let clients = {[owner]:original};
  let writes=0, orderWrites=[], response;
  const source=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
  const start=source.indexOf("function criarPedidoHandler(categoria) {");
  const end=source.indexOf("// ===== CRIAR PEDIDO =====",start+1);
  const context={billingService:failDebit ? {...billing,applyResolvedCompanyArtCharge(){
    throw Object.assign(new Error("fixture quota expired"),{code:"billing_required",statusCode:402});
  }} : billing,Date,console:{warn(){},info(){},error(){}},
    readClientes:()=>structuredClone(clients),writeClientes:value=>{clients=structuredClone(value);writes++;},
    nowYYYYMM:()=>"2099-01",getCustoPedido:()=>5.99,EMPRESA_ARTE_AVULSA_VALOR:5.99,
    getFreeArtIpLockStatus:()=>({blocked:false}),releaseFreeArtClaimLocks(){},cleanupUploadedFiles(){},removeOldPedidos(){},
    orderService:{normalizeOrderBody:()=>({}),hasRequiredOrderFields:()=>true,hasCompanyLogoReference:()=>true,
      normalizeCompanyVisualStyleForUploads:()=>({converted:false}),
      async createOrderDraft(){
        if(legacyOwner) {
          const other=paid(); billing.consumeMonthlyMediaQuota(other,"video",1,status(other).grantRef,NOW);
          clients["another-owner"]=other;
          return {id:"synthetic-order",base:"inert",pedido:{}};
        }
        const current=clients[owner], ref=status(current).grantRef;
        billing.consumeMonthlyMediaQuota(current,"image",concurrentImages,ref,NOW);
        billing.consumeMonthlyMediaQuota(current,"video",1,ref,NOW);
        clients["another-owner"]={preserve:true};
        return {id:"synthetic-order",base:"inert",pedido:{}};
      },orderStorage:{writeOrder(_base,order){orderWrites.push(structuredClone(order));}}},
    PEDIDOS_DIR:"inert"};
  vm.runInNewContext(source.slice(start,end),context,{timeout:1000});
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){response=body;return body;}};
  return {run:()=>context.criarPedidoHandler("arte_empresa")({user:{whatsapp:owner},body:{},files:{}},res),
    get client(){return clients[owner];},get all(){return clients;},get writes(){return writes;},get orders(){return orderWrites;},res,
    get response(){return response;}};
}

test("legacy image rereads after draft await and preserves concurrent typed reservations and other owners",async()=>{
  const f=legacyFixture(1); await f.run();
  assert.equal(f.res.statusCode,200); assert.equal(f.client.artes_mensais_restantes,8);
  assert.equal(f.client.artes_mensais_usadas,2); assert.equal(f.client.videos_mensais_restantes,3);
  assert.deepEqual(f.all["another-owner"],{preserve:true}); assert.equal(f.writes,1);
});

test("a concurrent last-image reservation cannot be overwritten by legacy image checkout",async()=>{
  const f=legacyFixture(10); await f.run();
  assert.equal(f.res.statusCode,402); assert.equal(f.response.code,"billing_required"); assert.equal(f.writes,0);
  assert.equal(f.client.artes_mensais_restantes,0); assert.equal(f.client.videos_mensais_restantes,3);
  assert.equal(f.orders.at(-1).pagamento_pendente,true);
});

test("a typed debit failure preserves the draft as unpaid and never writes a stale client",async()=>{
  const f=legacyFixture(1,true); await f.run();
  assert.equal(f.res.statusCode,402);assert.equal(f.writes,0);
  assert.equal(f.client.artes_mensais_restantes,9);assert.equal(f.client.videos_mensais_restantes,3);
  assert.equal(f.orders.at(-1).pagamento_pendente,true);
});

test("a historical owner's image checkout cannot erase another owner's typed reservation",async()=>{
  const f=legacyFixture(0,false,true); await f.run();
  assert.equal(f.res.statusCode,200);assert.equal(f.client.artes_mensais_restantes,7);
  assert.equal(f.client.plano_cotas_versao,undefined);
  assert.equal(f.all["another-owner"].videos_mensais_restantes,3);
  assert.equal(f.all["another-owner"].artes_mensais_restantes,10);
});

function pixFixture(id) {
  const source=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
  const start=source.indexOf('app.post("/billing/planos/:planId/pix"');
  const end=source.indexOf('app.post("/comprar-creditos"',start);
  let handler, calls=[], body;
  const context={billingPlans:plans,Date,auth:()=>{},app:{post(_route,_auth,callback){handler=callback;}},
    async createMercadoPagoPixPayment(value){calls.push(value);return {data:{id:"fake-payment"},pixCopiaCola:"fixture",qrCodeBase64:"",ticketUrl:""};}};
  vm.runInNewContext(source.slice(start,end),context,{timeout:1000});
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(value){body=value;return value;}};
  return {run:()=>handler({user:{whatsapp:"synthetic"},params:{planId:id},body:{price:.01,imagesPerMonth:99999}},res),
    calls,res,get body(){return body;}};
}

test("new Pix cannot purchase a legacy ID and never contacts the payment provider",async()=>{
  for(const id of ["i4_essencial","i4_profissional","i4_empresarial"]) {
    const f=pixFixture(id); await f.run(); assert.equal(f.res.statusCode,400);
    assert.equal(f.body.code,"plan_updated"); assert.match(f.body.error,/Este combo foi atualizado.*Atualize o app/);
    assert.equal(f.calls.length,0);
    assert.ok(plans.getPlan(id),"the old invoice/cycle resolver remains available");
  }
});

test("new Pix gets its price and media grant only from the approved server catalog",async()=>{
  for(const [id,,price,images,videos] of expected) {
    const f=pixFixture(id); await f.run(); assert.equal(f.res.statusCode,200);assert.equal(f.calls.length,1);
    assert.equal(f.calls[0].amount,price);assert.equal(f.calls[0].metadata.images_per_month,images);
    assert.equal(f.calls[0].metadata.videos_per_month,videos);assert.equal(f.body.quotaVersion,1);
    assert.equal(f.body.imagesPerMonth,images);assert.equal(f.body.videosPerMonth,videos);
  }
});

test("the checkout fixture followed by reboot replay never issues another payment POST",async()=>{
  const f=pixFixture(expected[1][0]);await f.run();assert.equal(f.calls.length,1);
  const client=paid(expected[1][0],"fake-payment"), before=structuredClone(client);
  const reboot=JSON.parse(JSON.stringify(client));
  const result=billing.applyManualPlanPayment(reboot,plans.getPlan(expected[1][0]),{
    paymentId:"fake-payment",paidAt:"2099-01-15T12:00:00Z"});
  assert.equal(result.duplicate,true);assert.deepEqual(reboot,before);assert.equal(f.calls.length,1);
});
