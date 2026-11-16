"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const {PENDING_NOTICE,isNewArtCommand,clearUnsentPreparation}=require('../src/company-assistant/pending-preparation');
const {createAssistantService}=require('../src/company-assistant/service'),billing=require('../src/billing/billing.service'),plans=require('../src/billing/plans');
const {admissionOrderId}=require('../src/company-edit-calendar/admission-contract');
const uuid=()=>crypto.randomUUID(),hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const OWNER='159911205989',claims={whatsapp:OWNER,company_id:OWNER,token_version:2,sub:OWNER},NOW=Date.parse('2099-01-16T12:00:00Z');
const tick=()=>new Promise(r=>setImmediate(r));
const confirmation=s=>({draftId:s.draft.id,version:s.draft.version,confirmed:true,items:s.draft.items.map(({id,date,time,destination})=>({id,date,time,destination}))});
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'i4-pending-')),client={ativo:true},calls=[],contexts=[],submissions=[];
 billing.applyManualPlanPayment(client,plans.getPlan('i4_combo_20i_15v_v1'),{paymentId:'test',paidAt:'2099-01-15T12:00:00Z'});
 const png=await sharp({create:{width:100,height:100,channels:3,background:'orange'}}).png().toBuffer();let output;
 const profile={has_logo:true,nome:'Empresa permanente',ramo:'Hamburgueria',descricao:'Perfil preservado'};
 const service=createAssistantService({root,clock:()=>NOW,apiKey:'fake-only',readClient:()=>client,dispatchSpacingMs:0,
  profile:{get:()=>({profile}),logo:()=>png},observeConnection:async()=>({state:'connected',health:'healthy'}),
  calendar:{availability:async()=>({availability:{canImage:true,canVideo:true}}),createContext:async(c,v)=>{contexts.push(v);return {ticket:v.requestId+'.'+'T'.repeat(43)};}},
  fetchImpl:async(url,opt)=>{calls.push(JSON.parse(opt.body));return {ok:true,json:async()=>({status:'completed',usage:{input_tokens:100,output_tokens:100},output:[{content:[{type:'output_text',text:JSON.stringify(output)}]}]})};},
  submitFetch:async(url,opt)=>{const data=JSON.parse(opt.body.get('data'));submissions.push(data);const id=admissionOrderId(data.appCalendar.ticket),context=data.appCalendar.ticket.split('.')[0].replaceAll('-','');
   return {ok:true,json:async()=>({status:'awaiting_authorization',totalCents:0,orderId:id,admission:{schemaVersion:1,admissionId:uuid(),requestHash:hash('request'),contextHash:hash(data.appCalendar.ticket),mediaKind:data.mediaKind,quantity:1,state:'reserved',reservedAt:NOW,editOrderId:id,planningId:'pm_edit_'+context,pedidoId:'edit_'+context}})};}});
 t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true});});
 const ids=[uuid(),uuid(),uuid()];for(const id of ids)await service.upload(claims,id,png,'foto.png');
 const item=(id,kind='image')=>({photoId:id,photoIds:[id],kind,title:'Produto anterior',caption:'Oferta anterior',imageText:'R$ 39,32',segment:'Hamburgueria',visualInstructions:'Fundo verde, logo direita.',date:'2099-01-17',time:'18:05',destination:'both'});
 const setItems=items=>output={reply:'Preparei sua publicação.',photoDescriptions:items.map(i=>({photoId:i.photoId,description:'Produto sobre mesa.'})),items};
 const stateFile=path.join(root,hash('assistant-v1\0'+OWNER),'state.json');
 return {root,client,profile,png,ids,item,setItems,service,calls,contexts,submissions,stateFile};
}
async function prepare(f,kind='image',count=2){const items=f.ids.slice(0,count).map(id=>f.item(id,kind));f.setItems(items);return f.service.message(claims,{requestId:uuid(),message:'Faça a promoção de 39,32',photoIds:f.ids.slice(0,count)});}

test('notice survives current display rules and fits the fixed chat reply allowance',()=>{
 assert(PENDING_NOTICE.length<=120);assert.equal(PENDING_NOTICE.replace(/Toque em Continuar[^\n]*/gi,'Confira as opções abaixo de cada foto.'),PENDING_NOTICE);
 for(const s of ['Nova arte',' nova   ARTE! ','NOVA ARTE.'])assert(isNewArtCommand(s));
 for(const s of ['Não quero nova arte','Como fazer nova arte?','Escreva Nova arte na imagem','Nova arte por 49','Quero outra arte'])assert(!isNewArtCommand(s));
});
for(const kind of ['image','video'])test(`${kind}: any pending-stage message only shows the notice; choices/credits/counters and confirmation remain intact`,async t=>{
 const f=await fixture(t),before=await prepare(f,kind),client=structuredClone(f.client),originalBytes=f.service.photo(claims,f.ids[0]);
 for(const message of ['Mude o valor para 49','Como conectar meu Instagram?','Quero outra arte','sim','Não cancele','Escreva Nova arte']){
  const input={requestId:uuid(),message,photoIds:[]},after=await f.service.message(claims,input),repeat=await f.service.message(claims,input);
  assert.equal(after.messages.at(-1).text,PENDING_NOTICE);assert.deepEqual(after.draft,before.draft);assert.deepEqual(repeat.draft,before.draft);
  assert.equal(after.messagesUsed,before.messagesUsed);assert.equal(f.calls.length,1);assert.deepEqual(f.client,client);
 }
 assert.equal(f.contexts.length,0);assert.equal(f.submissions.length,0);assert.deepEqual(f.service.photo(claims,f.ids[0]),originalBytes);
 await f.service.confirm(claims,confirmation(before));await tick();await f.service.processPending();await tick();
 assert.equal(f.submissions.length,2);assert.equal(f.contexts.length,2);
 assert(f.submissions.every(row=>row.imageText==='R$ 39,32'&&row.imageCaption==='Oferta anterior'));
});
test('Nova arte closes all unsent proposals, preserves files/company/account state, and blocks stale confirmation',async t=>{
 const f=await fixture(t),before=await prepare(f),client=structuredClone(f.client),profile=structuredClone(f.profile),bytes=f.service.photo(claims,f.ids[0]);
 const cleared=await f.service.message(claims,{requestId:uuid(),message:'Nova arte',photoIds:[]});
 assert.equal(cleared.draft,null);assert.equal(cleared.hasLogo,true);assert.deepEqual(f.client,client);assert.deepEqual(f.profile,profile);
 assert.deepEqual(f.service.photo(claims,f.ids[0]),bytes);assert.equal(f.calls.length,1);assert.equal(cleared.messagesUsed,before.messagesUsed);
 assert.equal(f.contexts.length,0);assert.equal(f.submissions.length,0);
 const saved=JSON.parse(fs.readFileSync(f.stateFile));assert.equal(saved.closedDrafts.at(-1).draft.id,before.draft.id);
 assert.deepEqual(saved.creativeContext.photoIds,[]);assert.deepEqual(saved.creativeContext.lastPhotoIds,[]);
 await assert.rejects(f.service.confirm(claims,confirmation(before)),{code:'assistant_draft_changed'});
});
test('a retry of an old Nova arte command cannot erase a later preparation',async t=>{
 const f=await fixture(t);await prepare(f);const command={requestId:uuid(),message:'Nova arte',photoIds:[]};await f.service.message(claims,command);
 f.setItems([{...f.item(f.ids[2]),imageText:'R$ 44,00',title:'Atual',caption:'Atual'}]);
 const next=await f.service.message(claims,{requestId:uuid(),message:'Promoção por 44',photoIds:[f.ids[2]]});
 const context=JSON.parse(f.calls.at(-1).input[0].content[0].text);assert.deepEqual(context.currentDraft,[]);assert.deepEqual(context.preferredPhotoIds,[f.ids[2]]);
 assert.deepEqual(context.profile,f.profile);assert(!JSON.stringify(context).includes('39,32'));
 assert.equal((await f.service.message(claims,command)).draft.id,next.draft.id);assert.equal(f.calls.length,2);
});
test('confirmed orders remain untouched while only the subsequent unsent draft is cleared',async t=>{
 const f=await fixture(t),sent=await prepare(f,'image',1),body=confirmation(sent);await f.service.confirm(claims,body);await tick();await f.service.processPending();await tick();
 const original=JSON.parse(fs.readFileSync(f.stateFile)).campaigns;
 f.setItems([f.item(f.ids[2])]);await f.service.message(claims,{requestId:uuid(),message:'Outra promoção por 39,32',photoIds:[f.ids[2]]});
 await f.service.message(claims,{requestId:uuid(),message:'Nova arte',photoIds:[]});
 assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile)).campaigns,original);assert.equal(f.submissions.length,1);assert.equal(f.contexts.length,1);
 await f.service.confirm(claims,body);assert.equal(f.submissions.length,1);
});
test('new attachments during a pending preparation never enter its existing production inputs',async t=>{
 const f=await fixture(t),before=await prepare(f,'image',1);
 const after=await f.service.message(claims,{requestId:uuid(),message:'Outra foto',photoIds:[f.ids[2]]});
 assert.deepEqual(after.draft,before.draft);assert.equal(after.messages.at(-1).text,PENDING_NOTICE);assert.equal(f.calls.length,1);
 assert.deepEqual(after.messages.at(-2).photoIds,[f.ids[2]]);assert(f.service.photo(claims,f.ids[2]).length>0);
 await f.service.confirm(claims,confirmation(before));await tick();await f.service.processPending();await tick();assert.equal(f.submissions.length,1);
});
test('Nova arte with freshly attached photos resets context and retains only those fresh sources for the next message',async t=>{
 const f=await fixture(t);await prepare(f);
 const reset=await f.service.message(claims,{requestId:uuid(),message:'Nova arte',photoIds:[f.ids[2]]});assert.equal(reset.draft,null);assert.equal(f.calls.length,1);
 f.setItems([{...f.item(f.ids[2]),title:'Novo',imageText:'R$ 44,00'}]);
 await f.service.message(claims,{requestId:uuid(),message:'Divulgue por 44',photoIds:[]});
 const context=JSON.parse(f.calls.at(-1).input[0].content[0].text);assert.deepEqual(context.preferredPhotoIds,[f.ids[2]]);assert.deepEqual(context.currentDraft,[]);
 assert(!JSON.stringify(context).includes('39,32'));assert.equal(context.profile.nome,'Empresa permanente');
});
test('commands and notices work after the conversation budget is exhausted without resetting that allowance',async t=>{
 const f=await fixture(t);await prepare(f);const saved=JSON.parse(fs.readFileSync(f.stateFile));
 for(const counter of Object.values(saved.counters)){counter.messages=120;counter.usd=1;}fs.writeFileSync(f.stateFile,JSON.stringify(saved));
 const notice=await f.service.message(claims,{requestId:uuid(),message:'Olá',photoIds:[]});assert.equal(notice.messages.at(-1).text,PENDING_NOTICE);
 const reset=await f.service.message(claims,{requestId:uuid(),message:'Nova arte',photoIds:[]});assert.equal(reset.draft,null);assert.equal(reset.messagesUsed,120);
 assert.equal(f.calls.length,1);assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).counters[Object.keys(saved.counters)[0]].usd,1);
});
test('foreign attachment IDs are refused before any preparation is cleared',async t=>{
 const f=await fixture(t),before=await prepare(f);
 await assert.rejects(f.service.message(claims,{requestId:uuid(),message:'Nova arte',photoIds:[uuid()]}),{code:'assistant_photo_not_found'});
 assert.deepEqual((await f.service.state(claims)).draft,before.draft);assert.equal(f.calls.length,1);
});
test('the recovery archive is bounded and never edits confirmed campaign records',()=>{
 const campaigns=[{id:'received',status:'queued'}],s={messages:[],photos:[],campaigns};
 for(let n=0;n<9;n++){s.draft={id:'draft-'+n,items:[{}]};clearUnsentPreparation(s,'request-'+n,NOW+n);}
 assert.equal(s.closedDrafts.length,5);assert.equal(s.closedDrafts.at(-1).draft.id,'draft-8');assert.deepEqual(s.campaigns,campaigns);
});
