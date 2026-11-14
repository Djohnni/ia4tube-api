"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { HELP_GUIDE, isHelpQuestion, simpleHelpReply, discardRequested } = require("../src/company-assistant/help");

for (const question of ["Como conectar o Instagram?", "como conecto meu insta", "Quero conectar meu Instagram", "Conectar Instagram",
  "Me ensina a conectar o instagram", "ONDE EU CLICO PARA CONECTAR O INSTAGRAM?", "preciso de ajuda pra conectar o insta"]) {
  test(`app guide: ${question}`, () => {
    assert.equal(isHelpQuestion(question), true);
    assert.match(simpleHelpReply(question, {}), /ícone do Instagram.*esquerda.*Conectar Instagram/);
  });
}

for (const [question, expected] of [
  ["Por que o Instagram abre no Chrome?", /navegador oficial/],
  ["Como permitir a autorização do Instagram?", /confira a conta.*Permitir.*volte/],
  ["Não consigo conectar meu Instagram", /qual mensagem aparece/],
  ["Como vejo meu login?", /Mais → Perfil da empresa → Minha conta/],
  ["Qual é minha senha?", /Não envie sua senha/],
  ["Onde vejo meu saldo?", /Mais → Meus combos/],
  ["Onde vejo os planos?", /Combo.*planos/],
  ["Onde abro o calendário?", /calendário.*direita/],
  ["Como escolher data e horário?", /data e a hora abaixo de cada foto/],
  ["Onde vejo meus pedidos?", /Mais → Pedidos/],
  ["Como envio uma foto da galeria?", /clipe.*câmera/],
  ["Como adicionar a logo da empresa?", /Mais → Perfil da empresa/]
]) test(`short factual help: ${question}`, () => {
  const reply = simpleHelpReply(question, {});
  assert.match(reply, expected); assert(reply.length <= 120);
  assert(!/R\$|senha.*envie aqui|já publiquei|já agendei/i.test(reply));
});

test("connection help uses confirmed facts and does not diagnose an unconfirmed query", () => {
  assert.match(simpleHelpReply("Meu Instagram está conectado?", { connected: true }), /conexão foi confirmada/);
  const unknown = simpleHelpReply("Meu Instagram está conectado?", { connected: false });
  assert.match(unknown, /conferir a conexão/); assert.doesNotMatch(unknown, /desconectad|problema da Meta/);
});

test("production requests, quoted image text and monthly planning retain the creation path", () => {
  for (const message of ["Crie uma oferta por R$ 39,90.", "Transforme minha foto em vídeo", "Quero ajuda para preparar o mês do meu Instagram.",
    "Pode fazer um vídeo dessa foto?", "Escreva na imagem: como conectar Instagram?", "Faça uma arte sobre planos e saldo", "Use a última foto"]) {
    assert.equal(isHelpQuestion(message), false, message); assert.equal(simpleHelpReply(message, {}), null, message);
  }
  assert.equal(isHelpQuestion("Por que meu app está mostrando esse aviso?"), true);
  assert.equal(simpleHelpReply("Por que meu app está mostrando esse aviso?", {}), null);
});

test("only an explicit instruction to discard the unsent preparation can clear it", () => {
  for (const message of ["Descarte esta proposta.", "Cancele esse rascunho", "Pode apagar minha preparação", "Não quero mais essa proposta"])
    assert.equal(discardRequested(message), true, message);
  for (const message of ["Como cancelar essa proposta?", "Não cancele meu rascunho", "Meu pedido sumiu?", "Onde está a preparação?",
    "Cancele o pedido já publicado", "Escreva: Descarte esta proposta", "Cancele essa proposta e crie outra"])
    assert.equal(discardRequested(message), false, message);
});

test("the guide covers app help without giving the chat operational powers", () => {
  for (const value of ["Conectar Instagram", "Permitir", "navegador oficial", "Minha conta", "Meus combos", "calendário à direita", "clipe", "câmera", "10s", "sem narração"])
    assert(HELP_GUIDE.includes(value), value);
  assert.match(HELP_GUIDE, /Não peça senha nem código/);
  assert.match(HELP_GUIDE, /requestMode=app_help/);
});
