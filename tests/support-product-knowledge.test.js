"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const billingService=require("../src/billing/billing.service");
const server=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
const start=server.indexOf('app.post("/suporte/chat", auth, async (req, res) => {');
const source=server.slice(start,server.indexOf('app.get("/suporte/minhas-mensagens", auth, (req, res) => {',start));
function fixture({human=false,paid=false}={}) {
  let handler,rows=human?[{id:"human",whatsapp:"synthetic",finalizada:false,precisa_humano:true,status:"humano_assumiu",mensagens:[]}]:[];
  const clients={synthetic:{ativo:true}},calls=[],auth=()=>{};
  if(paid)billingService.applyManualPlanPayment(clients.synthetic,require("../src/billing/plans").getPlan("i4_combo_20i_15v_v1"),{paymentId:"synthetic",paidAt:new Date().toISOString()});
  const original=JSON.stringify(clients);
  const sandbox={app:{post:(url,a,fn)=>{assert.equal(url,"/suporte/chat");assert.equal(a,auth);handler=fn;}},auth,
    process:{env:{OPENAI_API_KEY:"synthetic-test-key"}},require:p=>require(path.resolve(__dirname,"..",p)),billingService,structuredClone,
    SUPORTE_ABERTAS_FILE:"synthetic-memory",readJsonArraySafe:()=>structuredClone(rows),writeJsonSafe:(_f,v)=>{rows=structuredClone(v);},
    readClientes:()=>clients,listPedidoBasesByWhatsapp:()=>[],readOrderStatus:()=>"novo",path,fs:{existsSync:()=>false},
    salvarMensagemSuporteAberta:(owner,message,reply,origin)=>{
      let row=rows.find(r=>r.whatsapp===owner&&!r.finalizada);if(!row){row={id:"support",whatsapp:owner,finalizada:false,precisa_humano:false,status:"aberta",mensagens:[]};rows.push(row);}
      row.mensagens.push({autor:"cliente",texto:message},{autor:origin,texto:reply});return structuredClone(row);
    },
    fetch:async(url,opt)=>{calls.push(JSON.parse(opt.body));return {ok:true,json:async()=>({choices:[{message:{content:"Envie uma foto nítida e diga o que quer divulgar. O chat prepara sua publicação."}}]})};}
  };
  vm.runInNewContext(source,sandbox,{timeout:1000});
  return {calls,clients,original,get rows(){return rows;},async send(mensagem){let result,status=200;const res={json:x=>(result=x),status:x=>(status=x,res)};await handler({body:{mensagem},user:{whatsapp:"synthetic"}},res);assert.equal(status,200);return result;}};
}
test("support gives the same product and current-plan answers as the home, without AI or billing writes",async()=>{
  const f=fixture();const intro=await f.send("Quero saber sobre esse app");assert.match(intro.resposta,/cria imagens e vídeos/);
  const plan=await f.send("Qual plano tem 4 vídeos?");assert.match(plan.resposta,/Essencial.*R\$ 99.*4 vídeos/);
  assert.equal(f.calls.length,0);assert.equal(JSON.stringify(f.clients),f.original);assert.equal(plan.modo_humano,false);
  assert.equal(f.rows[0].mensagens.length,4);assert.doesNotMatch(plan.resposta,/39,90|79,90|149,90/);
});
test("existing active human conversation takes priority over every fixed answer",async()=>{
  const f=fixture({human:true}),r=await f.send("Qual plano tem 4 vídeos?");
  assert.equal(r.modo_humano,true);assert.equal(r.resposta,null);assert.equal(f.calls.length,0);
  assert.equal(f.rows[0].status,"humano_assumiu");assert.equal(f.rows[0].mensagens.length,1);
});
test("existing error handoff remains a real persisted human ticket",async()=>{
  const f=fixture(),r=await f.send("Meu pedido deu erro");assert.equal(r.modo_humano,true);
  assert.equal(f.rows[0].precisa_humano,true);assert.equal(f.rows[0].status,"aguardando_suporte");assert.equal(f.calls.length,0);
});
test("support fallback has the shared current knowledge, short reply and same post-answer controls",async()=>{
  const f=fixture(),r=await f.send("Tenho uma loja de roupas e preciso de ideias para divulgar.");
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].model,"gpt-4o-mini");
  const prompt=f.calls[0].messages[1].content;assert.match(prompt,/CONHECIMENTO DO PRODUTO iA4tube/);
  assert.match(prompt,/\"price\":99/);assert.doesNotMatch(prompt,/39,90|79,90|149,90/);
  assert(r.resposta.length<=120);assert.doesNotMatch(r.resposta,/Quer continuar conversando com o robô/);
  assert.equal(r.mostrar_opcoes_pos_ia,true);assert.equal(r.opcoes_pos_ia.length,2);
  assert.equal(JSON.stringify(f.clients),f.original);
});
test("support account facts are read from a clone and contain the current typed quotas",async()=>{
  const f=fixture({paid:true});await f.send("Quanto saldo me resta hoje?");
  const prompt=f.calls[0].messages[1].content;
  assert.match(prompt,/"images":20,"videos":15,"plan":\{"active":true,"name":"Empresarial"/);
  assert.equal(JSON.stringify(f.clients),f.original);
});
