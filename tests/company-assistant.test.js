"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), sharp = require("sharp");
const { createAssistantService, MODEL } = require("../src/company-assistant/service");
const { admissionOrderId } = require("../src/company-edit-calendar/admission-contract");
const billing = require("../src/billing/billing.service"), plans = require("../src/billing/plans");
const uuid = () => crypto.randomUUID(), hash = x => crypto.createHash("sha256").update(x).digest("hex");
const NOW = Date.parse("2099-01-16T12:00:00Z"), OWNER = "159911205989";
const claims = (owner=OWNER) => ({whatsapp:owner,company_id:owner,token_version:2,sub:owner});
async function fixture(t, options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"i4-assistant-")), client={ativo:true};
  if(!options.free)billing.applyManualPlanPayment(client,plans.getPlan("i4_combo_20i_15v_v1"),{paymentId:"test",paidAt:"2099-01-15T12:00:00Z"});
  const png=await sharp({create:{width:100,height:80,channels:3,background:"#ff8800"}}).png().toBuffer();
  const contextCalls=[],submissions=[],providerCalls=[];let output={reply:"Envie uma foto para preparar seu mês.",photoDescriptions:[],items:[]};
  const service=createAssistantService({root,clock:()=>NOW,apiKey:"fake-test-key",dispatchSpacingMs:0,
    readClient:o=>o===OWNER?client:null, profile:{get:()=>({profile:{has_logo:true}}),logo:()=>png},
    observeConnection:async()=>({state:"connected",health:"healthy"}),
    calendar:{availability:async()=>({availability:{canImage:true,canVideo:true}}),createContext:async(c,v)=>{
      contextCalls.push(v);return {ticket:v.requestId+"."+"T".repeat(43)};
    }},
    fetchImpl:async(url,opt)=>{providerCalls.push({url,body:JSON.parse(opt.body)});if(options.providerFailure)throw Error("network");
      return {ok:true,json:async()=>({status:"completed",usage:{input_tokens:1000,output_tokens:200},output:[{content:[{type:"output_text",text:JSON.stringify(output)}]}]})};},
    submitFetch:async(url,opt)=>{const data=JSON.parse(opt.body.get("data"));submissions.push({url,data,key:opt.headers["Idempotency-Key"]});
      if(options.submitFailure)throw Error("network");const id=admissionOrderId(data.appCalendar.ticket),context=data.appCalendar.ticket.split(".")[0].replaceAll("-","");
      return {ok:true,json:async()=>({status:"awaiting_authorization",totalCents:0,orderId:options.badReceipt?uuid():id,admission:{schemaVersion:1,admissionId:uuid(),requestHash:hash("request"),contextHash:hash(data.appCalendar.ticket),mediaKind:data.mediaKind,quantity:1,state:"reserved",reservedAt:NOW,editOrderId:id,planningId:"pm_edit_"+context,pedidoId:"edit_"+context}})};
    }});
  t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true});});
  return {service,root,png,client,contextCalls,submissions,providerCalls,setOutput:o=>{output=o;}};
}
async function draft(f,kind="image") {
  const id=uuid();await f.service.upload(claims(),id,f.png,"foto.png");
  f.setOutput({reply:"Preparei esta publicação. Confira antes de criar.",photoDescriptions:[{photoId:id,description:"Produto fotografado em uma mesa."}],
    items:[{photoId:id,kind,title:"Sua oferta",caption:"Confira nossa oferta!",imageText:"R$ 39,90",segment:"Comércio; visual limpo",date:"2099-01-17",time:"18:05",destination:"both"}]});
  return f.service.message(claims(),{requestId:uuid(),message:"Crie uma oferta por R$ 39,90.",photoIds:[id]});
}
const confirmation = snapshot => ({draftId:snapshot.draft.id,version:snapshot.draft.version,confirmed:true,items:snapshot.draft.items.map(({id,date,time,destination})=>({id,date,time,destination}))});
const tick=()=>new Promise(r=>setImmediate(r));
for(const paid of [true,false])test(`${paid?"paid":"trial"} conversation enforces its own message allowance without changing media credits`,async t=>{
  const f=await fixture(t,{free:!paid}),limit=paid?120:20,before=structuredClone(f.client);
  assert.equal((await f.service.state(claims())).messageLimit,limit);
  await f.service.message(claims(),{requestId:uuid(),message:"Olá",photoIds:[]});
  const file=path.join(f.root,hash("assistant-v1\0"+OWNER),"state.json"),saved=JSON.parse(fs.readFileSync(file,"utf8"));
  const counter=Object.values(saved.counters)[0];counter.messages=limit-1;counter.usd=paid ? .30 : .02;
  fs.writeFileSync(file,JSON.stringify(saved));
  const last=await f.service.message(claims(),{requestId:uuid(),message:"Minha última mensagem permitida",photoIds:[]});
  assert.equal(last.messagesUsed,limit);assert.equal(last.messageLimit,limit);
  await assert.rejects(f.service.message(claims(),{requestId:uuid(),message:"Acima do limite",photoIds:[]}),{code:"assistant_conversation_limit"});
  assert.equal(f.providerCalls.length,2);assert.deepEqual(f.client,before);assert.equal(f.submissions.length,0);
});
test("active account and ownership are enforced before any provider call",async t=>{
  const f=await fixture(t);await assert.rejects(f.service.state(claims("other")),{code:"assistant_session_required"});
  await assert.rejects(f.service.state({...claims(),company_id:"other"}),{code:"assistant_session_required"});assert.equal(f.providerCalls.length,0);
});
test("message retry reuses completed attempt and key never appears in saved state",async t=>{
  const f=await fixture(t),input={requestId:uuid(),message:"Planeje meu mês",photoIds:[]};
  await f.service.message(claims(),input);await f.service.message(claims(),input);
  assert.equal(f.providerCalls.length,1);assert.equal(f.providerCalls[0].body.model,MODEL);assert.equal(f.providerCalls[0].body.store,false);
  await assert.rejects(f.service.message(claims(),{...input,message:"Alterado"}),{code:"assistant_request_conflict"});
  for(const dir of fs.readdirSync(f.root,{withFileTypes:true}).filter(d=>d.isDirectory())){const raw=fs.readFileSync(path.join(f.root,dir.name,"state.json"),"utf8");assert(!raw.includes("fake-test-key"));}
});
test("uncertain OpenAI call is preserved and never called again automatically",async t=>{
  const f=await fixture(t,{providerFailure:true}),input={requestId:uuid(),message:"Olá",photoIds:[]};
  await assert.rejects(f.service.message(claims(),input));await assert.rejects(f.service.message(claims(),input),{code:"assistant_attempt_preserved"});
  assert.equal(f.providerCalls.length,1);assert.equal((await f.service.state(claims())).messagesUsed,1);
});
test("gallery bytes are checked, idempotent, and isolated from other accounts",async t=>{
  const f=await fixture(t),id=uuid();await f.service.upload(claims(),id,f.png,"foto.png");await f.service.upload(claims(),id,f.png,"foto.png");
  assert.equal((await f.service.state(claims())).photos.length,1);assert((f.service.photo(claims(),id)).length>0);
  await assert.rejects(f.service.upload(claims(),uuid(),Buffer.from("not image"),"bad.png"));
  assert.throws(()=>f.service.photo(claims(),"../private"),{code:"assistant_photo_not_found"});
});
test("photo instruction becomes a reviewable draft without creating an order",async t=>{
  const f=await fixture(t),s=await draft(f);assert.equal(s.draft.items[0].imageText,"R$ 39,90");
  assert.equal(f.providerCalls[0].body.input[0].content.filter(c=>c.type==="input_image").length,1);
  assert.equal(f.submissions.length,0);assert.equal(f.contextCalls.length,0);
  const id=s.messages.find(m=>m.role==="assistant").id;assert.deepEqual(f.service.report(claims(),{messageId:id}),{ok:true});
});
test("confirmed image uses unchanged Modo iA4tube receiver and calendar entry once",async t=>{
  const f=await fixture(t),s=await draft(f),body=confirmation(s),first=await f.service.confirm(claims(),body);
  await tick();await f.service.processPending();await tick();
  const repeat=await f.service.confirm(claims(),body);assert.equal(first.campaignId,repeat.campaignId);
  assert.equal(f.submissions.length,1);assert.equal(f.contextCalls.length,1);
  const v=f.submissions[0];assert.equal(v.data.mediaKind,"image");assert.equal(v.data.imageText,"R$ 39,90");
  assert.equal(v.data.imageCaption,"Confira nossa oferta!");assert.equal(v.key,hash(s.draft.items[0].requestId));
  assert.equal((await f.service.state(claims())).campaigns[0].status,"sent");
  await assert.rejects(f.service.confirm(claims(),{...body,items:body.items.map(i=>({...i,time:"19:00"}))}),{code:"assistant_request_conflict"});
});
for(const issue of ["submitFailure","badReceipt"])test(`${issue}: no automatic repeat, original campaign remains for attention`,async t=>{
  const f=await fixture(t,{[issue]:true}),s=await draft(f);await f.service.confirm(claims(),confirmation(s));await tick();await f.service.processPending();await tick();
  assert.equal((await f.service.state(claims())).campaigns[0].status,"needs_attention");await f.service.processPending();assert.equal(f.submissions.length,1);
});
test("each confirmed photo keeps its own text, format and schedule without duplicate dispatch",async t=>{
  const f=await fixture(t),first=uuid(),second=uuid();
  await f.service.upload(claims(),first,f.png,"primeira.png");await f.service.upload(claims(),second,f.png,"segunda.png");
  f.setOutput({reply:"Preparei duas publicações.",photoDescriptions:[],items:[first,second].map(photoId=>({photoId,kind:"image",title:"Oferta",caption:"Legenda original",imageText:"Antes",segment:"Comércio",date:null,time:null,destination:"both"}))});
  const s=await f.service.message(claims(),{requestId:uuid(),message:"Prepare as duas fotos",photoIds:[first,second]});
  const body=confirmation(s);body.items[0]={...body.items[0],date:"2099-01-17",time:"18:11",destination:"feed",kind:"image",imageText:"R$ 29,90"};
  body.items[1]={...body.items[1],date:"2099-01-18",time:"19:22",destination:"story",kind:"video",imageText:"Promoção só hoje"};
  const c=await f.service.confirm(claims(),body);await tick();await f.service.processPending();await tick();
  assert.equal((await f.service.confirm(claims(),body)).campaignId,c.campaignId);
  assert.equal(f.submissions.length,2);assert.deepEqual(f.submissions.map(v=>[v.data.mediaKind,v.data.imageText]),[["image","R$ 29,90"],["video","Promoção só hoje"]]);
  assert.deepEqual(f.contextCalls.map(v=>[v.date,v.time,v.destination]),[["2099-01-17","18:11","feed"],["2099-01-18","19:22","story"]]);
  assert(f.submissions.every(v=>v.data.imageCaption==="Legenda original"));
  await assert.rejects(f.service.confirm(claims(),{...body,items:body.items.map(i=>({...i,imageText:"Alterado depois"}))}),{code:"assistant_request_conflict"});
});
test("unbounded or malformed image information is rejected before calendar admission",async t=>{
  const f=await fixture(t),s=await draft(f);
  for(const imageText of ["x".repeat(301),null,{},"\u0000"]){
    const body=confirmation(s);body.items[0].imageText=imageText;
    await assert.rejects(f.service.confirm(claims(),body),{code:"assistant_input_invalid"});
  }
  assert.equal(f.contextCalls.length,0);assert.equal(f.submissions.length,0);
  const body=confirmation(s);body.items[0].imageText="";await f.service.confirm(claims(),body);await tick();await f.service.processPending();await tick();
  assert.equal(f.submissions[0].data.imageText,undefined);
});
test("expired date is refused before any order or provider generation",async t=>{
  const f=await fixture(t),s=await draft(f),body=confirmation(s);body.items[0].date="2099-01-15";
  await assert.rejects(f.service.confirm(claims(),body),{code:"assistant_schedule_invalid"});assert.equal(f.submissions.length,0);
});
test("video is one video quota and retains the established ten second model",async t=>{
  const f=await fixture(t),s=await draft(f,"video");await f.service.confirm(claims(),confirmation(s));await tick();await f.service.processPending();await tick();
  assert.equal(f.submissions[0].data.mediaKind,"video");assert.equal(f.submissions[0].data.sextou.durationSeconds,10);
  assert.equal(f.submissions[0].data.showcase.videoId,"d0591ca4-1c6a-470a-9f78-57ba4d266b8c");
});
test("changing the conversation invalidates a discarded draft before creation",async t=>{
  const f=await fixture(t),s=await draft(f);f.setOutput({reply:"Certo, vamos mudar o planejamento.",photoDescriptions:[],items:[]});
  await f.service.message(claims(),{requestId:uuid(),message:"Descarte esta proposta.",photoIds:[]});
  await assert.rejects(f.service.confirm(claims(),confirmation(s)),{code:"assistant_draft_changed"});assert.equal(f.submissions.length,0);
});
test("one shared standalone credit cannot fund an image plus a video",async t=>{
  const f=await fixture(t),s=await draft(f),p=s.draft.items[0].photoId;
  f.client.artes_mensais_restantes=0;f.client.videos_mensais_restantes=0;f.client.artes_avulsas_restantes=1;
  const item={photoId:p,kind:"image",title:"Imagem",caption:"Oferta",imageText:null,segment:"Loja",date:null,time:null,destination:"both"};
  f.setOutput({reply:"Duas propostas",photoDescriptions:[],items:[item,{...item,kind:"video"}]});
  await assert.rejects(f.service.message(claims(),{requestId:uuid(),message:"Faça uma imagem e um vídeo",photoIds:[p]}),{code:"assistant_balance_required"});
  assert.equal(f.submissions.length,0);
});
test("six messages per minute are allowed and a burst cannot add a seventh paid call",async t=>{
  const f=await fixture(t);for(let n=0;n<6;n++)await f.service.message(claims(),{requestId:uuid(),message:"Planejar",photoIds:[]});
  await assert.rejects(f.service.message(claims(),{requestId:uuid(),message:"Planejar",photoIds:[]}),{code:"assistant_rate_limit"});assert.equal(f.providerCalls.length,6);
});

test("one photo plus an amount uses concise BRL guidance and prepares scheduling without media generation",async t=>{
  const f=await fixture(t),s=await draft(f),body=f.providerCalls[0].body;
  assert.match(body.instructions,/Nunca pergunte se é em reais/);
  assert.match(body.instructions,/Prepare items imediatamente/);
  assert.equal(body.text.format.schema.properties.reply.maxLength,120);
  assert(s.messages.at(-1).text.length<=90);
  assert.equal(s.draft.items[0].imageText,"R$ 39,90");
  assert.equal(f.submissions.length,0);assert.equal(f.contextCalls.length,0);
});

test("sim preserves the same draft, does not spend another chat call and never creates an order",async t=>{
  const f=await fixture(t),before=await draft(f),input={requestId:uuid(),message:"sim",photoIds:[]};
  const after=await f.service.message(claims(),input),repeat=await f.service.message(claims(),input);
  assert.deepEqual(after.draft,before.draft);assert.deepEqual(repeat.draft,before.draft);
  assert.equal(after.messagesUsed,before.messagesUsed);assert.equal(f.providerCalls.length,1);
  assert.equal(f.submissions.length,0);assert.equal(f.contextCalls.length,0);
});

test("a long provider reply is bounded locally with no second call or draft/caption rewrite",async t=>{
  const f=await fixture(t);
  f.setOutput({reply:"Envie uma foto. "+"Explicação desnecessária. ".repeat(40),photoDescriptions:[],items:[]});
  const s=await f.service.message(claims(),{requestId:uuid(),message:"Como enviar?",photoIds:[]});
  assert(s.messages.at(-1).text.length<=120);assert.equal(f.providerCalls.length,1);assert.equal(s.draft,null);
  assert.equal(f.submissions.length,0);
});

test("assistant receives the real photo-to-video capabilities, rather than asking for an uploaded movie",async t=>{
  const f=await fixture(t);
  f.setOutput({reply:"Consigo fazer. Envie o vídeo do lanche.",photoDescriptions:[],items:[]});
  const s=await f.service.message(claims(),{requestId:uuid(),message:"Transforme minha foto em vídeo",photoIds:[]});
  const payload=JSON.parse(f.providerCalls[0].body.input[0].content[0].text);
  assert.equal(payload.capabilities.videoFromPhoto,true);assert.equal(payload.capabilities.uploadVideo,false);
  assert.equal(payload.capabilities.videoSeconds,10);assert.equal(payload.capabilities.voiceNarration,false);
  assert.equal(payload.capabilities.publishDirectlyFromChat,false);
  assert.match(s.messages.at(-1).text,/a partir de uma foto/);assert.doesNotMatch(s.messages.at(-1).text,/envie.*vídeo/i);
  assert.equal(s.draft,null);assert.equal(f.submissions.length,0);
});

test("a provider's false publication claim cannot become an operational acknowledgement",async t=>{
  const f=await fixture(t);f.setOutput({reply:"Publiquei sua arte!",photoDescriptions:[],items:[]});
  const s=await f.service.message(claims(),{requestId:uuid(),message:"Já foi?",photoIds:[]});
  assert.doesNotMatch(s.messages.at(-1).text,/publiquei/i);assert.equal(s.campaigns.length,0);assert.equal(f.submissions.length,0);
});

test("format chosen at confirmation sends one video through the same receiver, preserving photo and caption",async t=>{
  const f=await fixture(t),s=await draft(f),input=confirmation(s);
  input.items[0].kind="video";f.client.artes_mensais_restantes=0;
  const receipt=await f.service.confirm(claims(),input);await tick();await f.service.processPending();await tick();
  assert.equal(f.submissions.length,1);assert.equal(f.submissions[0].data.mediaKind,"video");
  assert.equal(f.submissions[0].data.showcase.videoId,"d0591ca4-1c6a-470a-9f78-57ba4d266b8c");
  assert.equal(f.submissions[0].data.imageCaption,s.draft.items[0].caption);
  const completed=await f.service.state(claims());assert.equal(completed.campaigns[0].afterMessageId,s.messages.at(-1).id);
  assert.equal(completed.campaigns[0].status,"sent");assert.equal(completed.campaigns[0].sent,1);
  assert.equal((await f.service.confirm(claims(),input)).campaignId,receipt.campaignId);assert.equal(f.submissions.length,1);
  await assert.rejects(f.service.confirm(claims(),{...input,items:input.items.map(i=>({...i,kind:"image"}))}),{code:"assistant_request_conflict"});
});

test("a free image credit cannot be converted into a free video at confirmation",async t=>{
  const f=await fixture(t,{free:true}),s=await draft(f),input=confirmation(s);input.items[0].kind="video";
  await assert.rejects(f.service.confirm(claims(),input),{code:"assistant_balance_required"});
  assert.equal(f.contextCalls.length,0);assert.equal(f.submissions.length,0);
});

test("invalid output kind is refused before calendar or production",async t=>{
  const f=await fixture(t),s=await draft(f),input=confirmation(s);input.items[0].kind="audio";
  await assert.rejects(f.service.confirm(claims(),input),{code:"assistant_draft_changed"});assert.equal(f.contextCalls.length,0);
});

test("last photo refers to the last submitted chat attachment, not an unused upload",async t=>{
  const f=await fixture(t),s=await draft(f),shared=s.draft.items[0].photoId,unused=uuid();
  await f.service.upload(claims(),unused,f.png,"foto-nao-enviada.png");
  f.setOutput({reply:"Vou usar a foto enviada.",photoDescriptions:[],items:[]});
  await f.service.message(claims(),{requestId:uuid(),message:"Use a última foto",photoIds:[]});
  const content=f.providerCalls.at(-1).body.input[0].content,payload=JSON.parse(content[0].text);
  assert.deepEqual(payload.preferredPhotoIds,[shared]);
  assert(payload.recentMessages.some(m=>m.photoIds.includes(shared)));
  assert(!payload.preferredPhotoIds.includes(unused));
  assert.equal(content.filter(c=>c.type==="input_image").length,0);assert.equal(f.submissions.length,0);
});

test("a completed receipt outside the visible history cannot close an unrelated new conversation",async t=>{
  const f=await fixture(t),s=await draft(f);await f.service.confirm(claims(),confirmation(s));await tick();await f.service.processPending();await tick();
  const file=path.join(f.root,hash("assistant-v1\0"+OWNER),"state.json"),raw=JSON.parse(fs.readFileSync(file,"utf8"));
  assert.equal(raw.campaigns[0].status,"sent");
  raw.messages.push(...Array.from({length:40},(_,n)=>({id:uuid(),role:n%2?"assistant":"user",text:"Outro assunto",photoIds:[]})));
  fs.writeFileSync(file,JSON.stringify(raw));
  assert.equal((await f.service.state(claims())).campaigns.length,0);
  assert.equal(JSON.parse(fs.readFileSync(file,"utf8")).campaigns[0].status,"sent");assert.equal(f.submissions.length,1);
});

for (const kind of ["image", "video"]) test(`${kind}: Instagram help preserves the exact draft and its original one-time production confirmation`, async t => {
  const f=await fixture(t),before=await draft(f,kind),client=structuredClone(f.client);
  const input={requestId:uuid(),message:"Como conectar meu Instagram?",photoIds:[]};
  const after=await f.service.message(claims(),input),repeat=await f.service.message(claims(),input);
  assert.match(after.messages.at(-1).text,/ícone do Instagram.*esquerda/);
  assert.deepEqual(after.draft,before.draft);assert.deepEqual(repeat.draft,before.draft);
  assert.equal(after.messagesUsed,before.messagesUsed+1);assert.equal(repeat.messagesUsed,after.messagesUsed);
  assert.equal(f.providerCalls.length,1);assert.equal(f.submissions.length,0);assert.equal(f.contextCalls.length,0);
  assert.deepEqual(f.client,client);
  const body=confirmation(after),receipt=await f.service.confirm(claims(),body);
  await tick();await f.service.processPending();await tick();
  assert.equal((await f.service.confirm(claims(),body)).campaignId,receipt.campaignId);
  assert.equal(f.submissions.length,1);assert.equal(f.submissions[0].data.mediaKind,kind);
  assert.equal(f.submissions[0].data.imageCaption,before.draft.items[0].caption);
  assert.equal(f.submissions[0].data.imageText,before.draft.items[0].imageText);
});

test("known app help works on a fresh conversation without an AI call, media order or media credit change", async t => {
  const f=await fixture(t),client=structuredClone(f.client);
  const after=await f.service.message(claims(),{requestId:uuid(),message:"Como conectar o Instagram?",photoIds:[]});
  assert.equal(after.draft,null);assert.equal(after.messagesUsed,1);assert.equal(f.providerCalls.length,0);
  assert.equal(f.submissions.length,0);assert.equal(f.contextCalls.length,0);assert.deepEqual(f.client,client);
  const saved=JSON.parse(fs.readFileSync(path.join(f.root,hash("assistant-v1\0"+OWNER),"state.json"),"utf8"));
  assert.equal(Object.values(saved.counters)[0].usd,0);assert.equal(Object.values(saved.attempts)[0].usd,0);
});

test("a general app question cannot replace the pending draft even if the model mistakenly proposes new items", async t => {
  const f=await fixture(t),before=await draft(f),item=before.draft.items[0];
  const {id,requestId,...providerItem}=item;
  f.setOutput({reply:"Preparei outra publicação.",photoDescriptions:[],items:[{...providerItem,imageText:"Texto indevido"}]});
  const after=await f.service.message(claims(),{requestId:uuid(),message:"Por que meu app está mostrando esse aviso?",photoIds:[]});
  assert.deepEqual(after.draft,before.draft);assert.match(after.messages.at(-1).text,/qual tela ou mensagem/);
  const payload=JSON.parse(f.providerCalls.at(-1).body.input[0].content[0].text);
  assert.equal(payload.requestMode,"app_help");assert.match(f.providerCalls.at(-1).body.instructions,/GUIA DE AJUDA DO APP/);
  assert.equal(f.submissions.length,0);assert.equal(f.contextCalls.length,0);
});

test("a conversational reply without items preserves photo identity, schedule and captions until an explicit replacement", async t => {
  const f=await fixture(t),before=await draft(f);
  f.setOutput({reply:"Pode explicar o que você quer mudar?",photoDescriptions:[],items:[]});
  const after=await f.service.message(claims(),{requestId:uuid(),message:"Tenho uma dúvida",photoIds:[]});
  assert.deepEqual(after.draft,before.draft);assert.equal(f.submissions.length,0);
  const {id,requestId,...providerItem}=before.draft.items[0];
  f.setOutput({reply:"Preparei a nova versão.",photoDescriptions:[],items:[{...providerItem,imageText:"R$ 49,90"}]});
  const changed=await f.service.message(claims(),{requestId:uuid(),message:"Mude o valor para 49,90",photoIds:[]});
  assert.notEqual(changed.draft.id,before.draft.id);assert.equal(changed.draft.version,before.draft.version+1);
  assert.equal(changed.draft.items[0].imageText,"R$ 49,90");
  await assert.rejects(f.service.confirm(claims(),confirmation(before)),{code:"assistant_draft_changed"});
});

test("asking how to cancel does not discard the proposal or create a calendar order", async t => {
  const f=await fixture(t),before=await draft(f);
  f.setOutput({reply:"Para descartar a preparação, diga: Descarte esta proposta.",photoDescriptions:[],items:[]});
  const after=await f.service.message(claims(),{requestId:uuid(),message:"Como cancelar essa proposta?",photoIds:[]});
  assert.deepEqual(after.draft,before.draft);assert.equal(f.submissions.length,0);assert.equal(f.contextCalls.length,0);
});

test("app help retains the existing message and per-minute limits", async t => {
  const f=await fixture(t);
  for(let n=0;n<6;n++)await f.service.message(claims(),{requestId:uuid(),message:"Como conectar o Instagram?",photoIds:[]});
  await assert.rejects(f.service.message(claims(),{requestId:uuid(),message:"Onde vejo meu login?",photoIds:[]}),{code:"assistant_rate_limit"});
  assert.equal(f.providerCalls.length,0);assert.equal((await f.service.state(claims())).messagesUsed,6);
});

for (const kind of ["image", "video"]) test(`${kind}: discovery, price and plan help preserve the proposal through its original confirmation`, async t => {
  const f=await fixture(t),before=await draft(f,kind),client=structuredClone(f.client);
  for (const [message,expected] of [
    ["Eu vim pelo Instagram e queria saber mais sobre", /cria imagens e vídeos da sua empresa/],
    ["Quero saber sobre esse app", /publica no Instagram nas datas/],
    ["Quanto custa?", /R\$ 69.*R\$ 259/],
    ["Qual plano tem 4 vídeos?", /Essencial.*R\$ 99.*4 vídeos/]
  ]) {
    const after=await f.service.message(claims(),{requestId:uuid(),message,photoIds:[]});
    assert.match(after.messages.at(-1).text,expected);assert.deepEqual(after.draft,before.draft);
  }
  assert.equal(f.providerCalls.length,1);assert.deepEqual(f.client,client);assert.equal(f.submissions.length,0);
  const body=confirmation(before);await f.service.confirm(claims(),body);await tick();await f.service.processPending();await tick();
  await f.service.confirm(claims(),body);assert.equal(f.submissions.length,1);assert.equal(f.submissions[0].data.mediaKind,kind);
});

test("unknown app questions receive the catalog and account facts without changing billing or pending media", async t => {
  const f=await fixture(t),before=await draft(f),client=structuredClone(f.client);
  f.setOutput({reply:"O app prepara divulgações de diferentes ramos com suas fotos e informações.",photoDescriptions:[],items:[]});
  const after=await f.service.message(claims(),{requestId:uuid(),message:"Minha loja é de roupas. Como o app pode ajudar?",photoIds:[]});
  const payload=JSON.parse(f.providerCalls.at(-1).body.input[0].content[0].text);
  assert.deepEqual(payload.currentCatalog.map(p=>p.price),[69,99,139,199,259]);
  assert.equal(payload.plan.active,true);assert.equal(payload.plan.name,"Empresarial");assert.equal(payload.trialImages,0);
  assert.deepEqual(after.draft,before.draft);assert.deepEqual(f.client,client);
  assert.equal(f.submissions.length,0);assert.equal(f.contextCalls.length,0);
});
