"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {isDeepStrictEqual}=require("node:util");
const billing=require("../billing/billing.service"),plans=require("../billing/plans");
const FIELDS=["plano","plano_atual","plano_status","plano_nome","plano_preco","plano_artes_mes","plano_ciclo",
  "plano_ciclo_inicio_em","plano_renova_em","plano_whatsapp_direto","artes_mensais_total","artes_mensais_usadas",
  "artes_mensais_restantes","plano_cotas_versao","plano_cotas_concessao_id","videos_mensais_total","videos_mensais_usados","videos_mensais_restantes"];
function fail(code){throw Object.assign(Error(code),{code});}
function prepareCourtesy(document,request,now=new Date()){
  if(!request||Object.keys(request).sort().join(",")!=="expiresAt,operationId,planId,target"||
    !/^\d{11,16}$/.test(request.target)||!/^courtesy_[a-z0-9_]{8,100}$/.test(request.operationId)||
    request.planId!=="i4_combo_20i_15v_v1")fail("courtesy_request_invalid");
  const current=document?.[request.target];if(!current||current.ativo!==true)fail("courtesy_account_missing");
  const marker=current[request.operationId];
  if(marker){
    if(marker.operationId!==request.operationId||marker.planId!==request.planId||marker.chargedAmount!==0)fail("courtesy_receipt_conflict");
    return {changed:false,document,summary:{status:"already_applied",target:request.target,operationId:request.operationId}};
  }
  const expires=new Date(request.expiresAt);
  if(!Number.isFinite(now.getTime())||!Number.isFinite(expires.getTime())||now>=expires||expires-now>864e5)fail("courtesy_request_expired");
  if(current.plano_proximo_ciclo_pago===true)fail("courtesy_paid_renewal_pending");
  const plan=plans.getPlan(request.planId);
  if(!plan||plan.price!==259||plan.imagesPerMonth!==20||plan.videosPerMonth!==15)fail("courtesy_catalog_changed");
  if(current.plano_atual&&current.plano_atual!==plan.id)fail("courtesy_existing_plan_conflict");
  const fresh={ativo:true};billing.applyManualPlanPayment(fresh,plan,{paidAt:now.toISOString()});
  fresh.plano_cotas_concessao_id=request.operationId;
  const next=structuredClone(document),target=next[request.target];
  for(const key of FIELDS)target[key]=fresh[key];
  const summary={status:"applied",target:request.target,operationId:request.operationId,planId:plan.id,
    images:20,videos:15,chargedAmount:0,paymentCreated:false,startsAt:fresh.plano_ciclo_inicio_em,renewsAt:fresh.plano_renova_em};
  target[request.operationId]={...summary};
  for(const key of Object.keys(document))if(key!==request.target&&!isDeepStrictEqual(next[key],document[key]))fail("courtesy_other_account_changed");
  const allowed=new Set([...FIELDS,request.operationId]);
  for(const key of new Set([...Object.keys(current),...Object.keys(target)]))if(!allowed.has(key)&&!isDeepStrictEqual(current[key],target[key]))fail("courtesy_unrelated_field_changed");
  return {changed:true,document:next,summary,before:structuredClone(current)};
}
/** Opt-in, synchronous before listening; no endpoint, payment or background retry. */
function runStartupCourtesy({requestJson,dataDir,readClients,writeClients,now=new Date()}){
  if(!requestJson)return null;
  if(requestJson.length>1024)fail("courtesy_request_invalid");
  const request=JSON.parse(requestJson),before=readClients(),prepared=prepareCourtesy(before,request,now);
  if(!prepared.changed)return prepared.summary;
  const dir=path.join(dataDir,"private","admin-courtesies");fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const backup=path.join(dir,request.operationId+".before.json"),bytes=Buffer.from(JSON.stringify(prepared.before,null,2)+"\n");
  if(fs.existsSync(backup)){
    const stat=fs.lstatSync(backup);if(!stat.isFile()||stat.isSymbolicLink()||!fs.readFileSync(backup).equals(bytes))fail("courtesy_backup_conflict");
  }else {const fd=fs.openSync(backup,"wx",0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  if(!isDeepStrictEqual(readClients(),before))fail("courtesy_concurrent_change");
  writeClients(prepared.document);
  if(!isDeepStrictEqual(readClients(),prepared.document))fail("courtesy_write_unconfirmed");
  return {...prepared.summary,backupSaved:true};
}
module.exports={prepareCourtesy,runStartupCourtesy};
