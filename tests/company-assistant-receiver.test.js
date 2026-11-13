"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto"),{pathToFileURL}=require("node:url"),sharp=require("sharp");
const {createAssistantService}=require("../src/company-assistant/service"),billing=require("../src/billing/billing.service"),plans=require("../src/billing/plans");
const source=process.env.IA4TUBE_RECEIVER_TEST_SOURCE;
test("assistant image and video cross the actual unchanged receiver with one reservation each",{skip:!source},async t=>{
  const {createServer}=await import(pathToFileURL(path.join(source,"app.js")).href),objects=new Map(),reservations=new Map();
  const hash=s=>crypto.createHash("sha256").update(s).digest("hex");
  const store={async get(k){if(!objects.has(k))throw Object.assign(Error(),{code:404});return objects.get(k);},
    async put(k,v){if(objects.has(k))throw Object.assign(Error(),{code:412});objects.set(k,Buffer.from(v));}};
  const server=createServer({store,recipientWhatsApp:"554791049079",publicBaseUrl:"https://orders.test",appOnlyEdit:true,editAdmission:async req=>{
    if(reservations.has(req.editOrderId))return reservations.get(req.editOrderId);
    const context=req.ticket.split(".")[0].replaceAll("-","");
    const receipt={schemaVersion:1,admissionId:crypto.randomUUID(),editOrderId:req.editOrderId,requestHash:req.requestHash,
      contextHash:hash(req.ticket),mediaKind:req.mediaKind,quantity:1,state:"reserved",reservedAt:Date.now(),planningId:"pm_edit_"+context,pedidoId:"edit_"+context};
    reservations.set(req.editOrderId,receipt);return receipt;
  }});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"i4-receiver-contract-")),owner="159911205989",client={ativo:true};
  billing.applyManualPlanPayment(client,plans.getPlan("i4_combo_10i_4v_v1"),{paymentId:"synthetic",paidAt:new Date().toISOString()});
  const png=await sharp({create:{width:100,height:100,channels:3,background:"#ff8800"}}).png().toBuffer(),photoId=crypto.randomUUID();
  const date=new Date(Date.now()+864e5).toISOString().slice(0,10);
  const out={reply:"Confira estas duas publicações.",photoDescriptions:[],items:["image","video"].map(kind=>({photoId,kind,title:"Oferta",caption:"Oferta original.",imageText:"R$ 39,90",segment:"Comércio",date,time:"18:05",destination:"both"}))};
  const service=createAssistantService({root,apiKey:"synthetic",dispatchSpacingMs:0,readClient:()=>client,
    profile:{get:()=>({profile:{has_logo:true}}),logo:()=>png},observeConnection:async()=>({state:"connected",health:"healthy"}),
    calendar:{availability:async()=>({availability:{canImage:true}}),assistantTrialRemaining:async()=>0,
      createContext:async(c,v)=>({ticket:v.requestId+"."+"T".repeat(43)})},
    fetchImpl:async()=>({ok:true,json:async()=>({status:"completed",usage:{input_tokens:500,output_tokens:300},output:[{content:[{type:"output_text",text:JSON.stringify(out)}]}]})}),
    submitFetch:async(url,options)=>fetch("http://127.0.0.1:"+server.address().port+"/orders",options)});
  t.after(()=>{service.close();fs.rmSync(root,{force:true,recursive:true});});
  const claims={whatsapp:owner,sub:owner,company_id:owner,token_version:2};await service.upload(claims,photoId,png,"foto.png");
  const snapshot=await service.message(claims,{requestId:crypto.randomUUID(),message:"Faça estas duas publicações.",photoIds:[photoId]});
  const input={draftId:snapshot.draft.id,version:snapshot.draft.version,confirmed:true,items:snapshot.draft.items.map(({id,date,time,destination})=>({id,date,time,destination}))};
  const sent=await service.confirm(claims,input);
  let state;for(let n=0;n<100;n++){state=await service.state(claims);if(state.campaigns[0]?.status!=="queued")break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(state.campaigns[0].status,"sent");assert.equal(state.campaigns[0].sent,2);assert.equal(reservations.size,2);
  const manifests=[...objects.entries()].filter(([k])=>k.endsWith("/manifest.json")).map(([,v])=>JSON.parse(v));
  assert.equal(manifests.length,2);assert.deepEqual(manifests.map(m=>m.mediaKind).sort(),["image","video"]);
  for(const m of manifests){assert.equal(m.imageText,"R$ 39,90");assert.equal(m.imageCaption,"Oferta original.");assert.equal(m.photos.length,1);assert(m.appCalendar.ticket);}
  assert.equal((await service.confirm(claims,input)).campaignId,sent.campaignId);assert.equal(reservations.size,2);
});
