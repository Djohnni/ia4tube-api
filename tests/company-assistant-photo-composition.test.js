"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {explicitPhotoIntent,compositionContext}=require('../src/company-assistant/photo-composition');
for(const message of ['Quero juntar essas imagens e fazer o combo','Junte as imagens e faça a publicação para o Instagram com preços',
 'Reúna essas fotos numa arte só','Combine estas imagens','Una as fotos','Agrupe os produtos numa arte','Uma publicação com todos os produtos',
 'Coloque essas fotos na mesma arte','Quero uma arte com as três fotos','Não quero separado, junte essas imagens',
 'Monte um combo com essas imagens','Faça uma única arte com todas essas fotos','Quero as imagens juntas','Uma arte para todas as fotos',
 'Junte a foto da batata na imagem do lanche'])
 test('explicit composition: '+message,()=>assert.equal(explicitPhotoIntent(message),'combine'));
for(const message of ['Faça publicação para o Instagram com preços','Faça artes dos combos','Quero divulgar os três produtos','Cada foto é um combo',
 'Combine as cores das fotos com a logo','Junte os preços de todas as imagens na legenda','Combine o fundo das fotos com minha marca'])
 test('no implied composition: '+message,()=>assert.notEqual(explicitPhotoIntent(message),'combine'));
for(const message of ['Não junte as imagens','Sem juntar essas fotos','Não quero que você junte essas fotos','Faça uma arte para cada foto',
 'Junte essas fotos, mas agora faça imagens separadas','Uma arte por foto'])
 test('separate or negated: '+message,()=>assert.equal(explicitPhotoIntent(message),'separate'));
test('group edits retain sources, new attachments reset intent, explicit separation wins',()=>{
 const ids=['a','b','c'],draft={items:[{photoId:'a',photoIds:ids}]};
 assert.deepEqual(compositionContext('Faça mais verde',[],ids,draft),{mode:'combine',photoIds:ids});
 assert.deepEqual(compositionContext('Faça a divulgação',['d','e'],['d','e'],draft),{mode:'separate',photoIds:['d','e']});
 assert.equal(compositionContext('Não junte as imagens',[],ids,draft).mode,'separate');
 assert.equal(compositionContext('Junte essas imagens',['a'],['a'],null).mode,'separate');
 assert.equal(compositionContext('Faça uma publicação',ids,ids,null).mode,'separate');
});

const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const {createAssistantService}=require('../src/company-assistant/service');
const billing=require('../src/billing/billing.service'),plans=require('../src/billing/plans');
const {admissionOrderId}=require('../src/company-edit-calendar/admission-contract');
const uuid=()=>crypto.randomUUID(),hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const OWNER='159911205989',claims={whatsapp:OWNER,company_id:OWNER,token_version:2,sub:OWNER},NOW=Date.parse('2099-01-16T12:00:00Z');
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'i4-composition-')),client={ativo:true};
 billing.applyManualPlanPayment(client,plans.getPlan('i4_combo_20i_15v_v1'),{paymentId:'test',paidAt:'2099-01-15T12:00:00Z'});
 const png=await sharp({create:{width:100,height:80,channels:3,background:'#ffaa00'}}).png().toBuffer();
 const contextCalls=[],submissions=[],calls=[];let output;
 const service=createAssistantService({root,clock:()=>NOW,apiKey:'fake-test',dispatchSpacingMs:0,readClient:()=>client,
  profile:{get:()=>({profile:{has_logo:true}}),logo:()=>png},observeConnection:async()=>({state:'connected',health:'healthy'}),
  calendar:{availability:async()=>({availability:{canImage:true,canVideo:true}}),createContext:async(c,v)=>{contextCalls.push(v);return {ticket:v.requestId+'.'+'T'.repeat(43)};}},
  fetchImpl:async(url,opt)=>{calls.push(JSON.parse(opt.body));return {ok:true,json:async()=>({status:'completed',usage:{input_tokens:1000,output_tokens:200},output:[{content:[{type:'output_text',text:JSON.stringify(output)}]}]})};},
  submitFetch:async(url,opt)=>{const data=JSON.parse(opt.body.get('data')),photos=opt.body.getAll('photos');submissions.push({data,photos,key:opt.headers['Idempotency-Key']});
   const id=admissionOrderId(data.appCalendar.ticket),context=data.appCalendar.ticket.split('.')[0].replaceAll('-','');
   return {ok:true,json:async()=>({status:'awaiting_authorization',totalCents:0,orderId:id,admission:{schemaVersion:1,admissionId:uuid(),requestHash:hash('request'),
    contextHash:hash(data.appCalendar.ticket),mediaKind:data.mediaKind,quantity:1,state:'reserved',reservedAt:NOW,editOrderId:id,planningId:'pm_edit_'+context,pedidoId:'edit_'+context}})};}});
 t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true});});
 const ids=[uuid(),uuid(),uuid()];for(const id of ids)await service.upload(claims,id,png,'foto.png');
 const item=photoIds=>({photoId:photoIds[0],photoIds,kind:'image',title:'Oferta',caption:'Conheça os produtos.',imageText:'R$ 39,90',segment:'Alimentação',
  visualInstructions:'Arte completa com os produtos informados, a logo e os preços autorizados.',date:'2099-01-17',time:'18:05',destination:'both'});
 return {service,client,root,ids,item,submissions,contextCalls,calls,setItems:items=>{output={reply:'Preparei sua publicação.',photoDescriptions:ids.map((photoId,n)=>({photoId,description:'Produto '+n})),items};}};
}
const confirm=s=>({draftId:s.draft.id,version:s.draft.version,confirmed:true,items:s.draft.items.map(({id,date,time,destination})=>({id,date,time,destination}))});
const tick=()=>new Promise(r=>setImmediate(r));
test('explicit group survives old-app confirmation, one calendar context, multipart, restart-safe retry and next-order isolation',async t=>{
 const f=await fixture(t),before=structuredClone(f.client);f.setItems([f.item(f.ids)]);
 const input={requestId:uuid(),message:'Junte essas imagens e faça uma arte do combo',photoIds:f.ids};
 const s=await f.service.message(claims,input);assert.equal(s.draft.items.length,1);assert.deepEqual(s.draft.items[0].photoIds,f.ids);
 assert.deepEqual((await f.service.message(claims,input)).draft,s.draft);assert.equal(f.calls.length,1);
 const context=JSON.parse(f.calls[0].input[0].content[0].text);assert.equal(context.photoComposition.mode,'combine');
 const confirmation=confirm(s),receipt=await f.service.confirm(claims,confirmation);await tick();await f.service.processPending();await tick();
 assert.equal(f.submissions.length,1);assert.equal(f.contextCalls.length,1);assert.equal(f.submissions[0].photos.length,3);
 assert.deepEqual(f.submissions[0].data.imageComposition,{version:1,mode:'combine',photoCount:3});
 assert.equal((await f.service.confirm(claims,confirmation)).campaignId,receipt.campaignId);assert.equal(f.submissions.length,1);
 // Accounting remains downstream, one output/item; source count never touches this ledger.
 assert.deepEqual(f.client,before);
 f.setItems([]);await f.service.message(claims,{requestId:uuid(),message:'Quero outra publicação',photoIds:[]});
 const next=JSON.parse(f.calls.at(-1).input[0].content[0].text);assert.deepEqual(next.preferredPhotoIds,[]);assert.deepEqual(next.photos,[]);
});
for(const message of ['Faça publicações com esses produtos e preços','Não junte essas imagens'])test('three separate orders by default: '+message,async t=>{
 const f=await fixture(t);f.setItems(f.ids.map(id=>f.item([id])));
 const s=await f.service.message(claims,{requestId:uuid(),message,photoIds:f.ids});assert.equal(s.draft.items.length,3);
 assert(s.draft.items.every(item=>!item.photoIds));assert(!s.messages.at(-1).text.includes('?'));
 await f.service.confirm(claims,confirm(s));await tick();await f.service.processPending();await tick();
 assert.equal(f.submissions.length,3);assert(f.submissions.every(row=>row.photos.length===1&&!row.data.imageComposition));
});
test('model cannot combine without customer permission, omit sources, duplicate or include foreign IDs',async t=>{
 for(const ids of ['all','missing','duplicate','foreign']){
  const f=await fixture(t);let proposed=ids==='all'?f.ids:ids==='missing'?[f.ids[0]]:ids==='duplicate'?[f.ids[0],f.ids[0],f.ids[2]]:[f.ids[0],f.ids[1],uuid()];
  f.setItems([f.item(proposed)]);
  await assert.rejects(f.service.message(claims,{requestId:uuid(),message:ids==='all'?'Faça as publicações':'Junte essas imagens',photoIds:f.ids}),{code:'assistant_draft_invalid'});
  assert.equal(f.submissions.length,0);assert.equal(f.contextCalls.length,0);
 }
});
