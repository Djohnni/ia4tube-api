"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const knowledge = require("../src/company-assistant/knowledge"), { simpleHelpReply, isHelpQuestion, HELP_GUIDE } = require("../src/company-assistant/help");
const cases = [
  ["Eu vim pelo Instagram e queria saber mais sobre", /cria imagens e vídeos.*empresa.*Instagram/],
  ["quero saber sobre esse app", /cria imagens e vídeos/],
  ["O que é a iA4tube?", /cria imagens e vídeos/],
  ["Como funciona?", /envia suas fotos.*escolhe quando/],
  ["Quanto custa?", /R\$ 69.*R\$ 259/],
  ["Vi o anúncio no Instagram, quanto custa?", /R\$ 69.*R\$ 259/],
  ["Qual plano tem 4 vídeos?", /Essencial.*R\$ 99.*10 imagens e 4 vídeos/],
  ["Qual plano tem quatro vídeos e 10 imagens?", /Essencial.*R\$ 99/],
  ["O que vem no plano de 139?", /Destaque.*15 imagens e 6 vídeos/],
  ["Qual plano Profissional?", /R\$ 199.*20 imagens e 10 vídeos/],
  ["Quanto custa o Empresarial?", /R\$ 259.*20 imagens e 15 vídeos/],
  ["Qual o plano mais barato?", /R\$ 69.*10 imagens/],
  ["O vídeo gasta crédito de imagem também?", /cota de vídeo.*Não desconta.*imagem/],
  ["Posso usar minha conta pessoal do Instagram?", /conta profissional do Instagram/],
  ["Posso conectar dois perfis do Instagram na mesma conta?", /Não tenho confirmação.*suporte/],
  ["Quero saber se vocês fazem um vídeo de 30 segundos narrado com a minha voz.", /10s.*sem narração.*Não há vídeo de outra duração/],
  ["Tenho iPhone. Posso instalar o app nele?", /Android.*Não tenho confirmação/],
  ["O app consegue ver minha senha do Instagram?", /Não envie sua senha.*tela oficial/],
  ["Esqueci minha senha, como recupero?", /não sua senha.*suporte/],
  ["Vai aumentar minhas vendas?", /Não há garantia.*vendas/],
  ["Posso testar antes de pagar?", /elegíveis.*Instagram/],
  ["Tem vídeo grátis?", /imagens.*Não há promessa de vídeo grátis/]
];
for (const [question, expected] of cases) test(`customer question: ${question}`, () => {
  assert.equal(isHelpQuestion(question), true);
  const reply = simpleHelpReply(question, {}); assert.match(reply, expected); assert(reply.length <= 120);
});
test("navigation and creation remain distinct from product discovery", () => {
  assert.match(simpleHelpReply("Onde vejo os planos?", {}), /Toque em Combo/);
  assert.match(simpleHelpReply("Vim pelo Instagram mas não consigo conectar", {}), /qual mensagem aparece/);
  for (const q of ["Quero saber se o app faz vídeos?", "Quero saber se o app publica Story?"])
    assert.doesNotMatch(simpleHelpReply(q, {}) || "", /cria imagens e vídeos da sua empresa/);
  for (const q of ["Escreva: qual plano tem 4 vídeos?", "Faça uma imagem explicando o app", "Pode fazer um vídeo dessa foto?", "Quero ajuda para preparar o mês do meu Instagram."])
    assert.equal(isHelpQuestion(q), false);
  assert.equal(simpleHelpReply("Meu plano acabou, as publicações agendadas param?", {}), null);
  for (const q of ["Minha conta pelo Google não mostra o plano que comprei pelo WhatsApp. O que faço?", "Paguei o plano. Como ativar?", "Quantos créditos de imagem e vídeo tenho no meu plano?"])
    assert.equal(knowledge.resolveProductReply(q), null);
  assert.equal(isHelpQuestion("Como faço para que ele crie uma publicação?"), true);
});
test("knowledge uses current product definitions, no obsolete prices and no credential projection", () => {
  const catalog = knowledge.currentCatalog(); assert.deepEqual(catalog.map(p=>p.price), [69,99,139,199,259]);
  const guide = knowledge.knowledgeGuide(); assert.match(guide, /três no total/);
  assert.match(guide, /não (?:é )?um pedido para conectar/);assert.match(guide, /120 caracteres/);
  assert.doesNotMatch(guide, /39,90|79,90|149,90/);
  const client = { plano_atual: "i4_combo_10i_4v_v1", plano_renova_em: "2099-02-01T00:00:00Z", senha: "private", email: "private", saldo_extra: 100 };
  const projection = knowledge.accountPlan(client, true);
  assert.deepEqual(Object.keys(projection).sort(), ["active","id","name","renewsAt"]);
  assert.equal(projection.name, "Essencial");assert(!JSON.stringify(projection).includes("private"));
  assert.match(HELP_GUIDE, /Direct\/comentários/);
});
