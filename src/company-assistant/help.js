"use strict";
const { knowledgeGuide, normalize, productQuestion, resolveProductReply } = require("./knowledge");

// Navigation guidance only. No authorization, publication, billing or calendar actions.
const HELP_GUIDE = knowledgeGuide() + "GUIA DE AJUDA DO APP iA4tube: além de preparar publicações, ensine a usar os recursos reais do app. " +
  "Dúvidas de uso não são pedidos de criação: responda só à dúvida, com items vazio, preservando a preparação atual. Quando requestMode=app_help, responda apenas à ajuda. Uma pergunta nunca confirma, cancela ou envia uma arte. " +
  "Explique um passo por vez, em uma ou duas frases curtas, até 120 caracteres. Não despeje um tutorial completo. " +
  "Na home há três ícones acima da conversa: Instagram à esquerda; iA4tube/Posts prontos no centro; calendário à direita. " +
  "Para conectar: toque no ícone do Instagram à esquerda, depois Conectar Instagram (ou Reconectar Instagram). A autorização abre no navegador oficial. " +
  "Entre no navegador com a conta Instagram desejada, confira a conta, toque em Permitir na autorização oficial e volte ao app. Confira Conta conectada na tela Instagram. " +
  "Não peça senha nem código no chat. Não diga que fez a conexão pelo cliente. Não existe botão para autorizar pelo aplicativo Instagram neste caminho. " +
  "A conta Instagram precisa ser profissional. Não invente caminhos nos ajustes do Instagram; se a tela for diferente, peça a mensagem ou o que aparece. " +
  "connected=true confirma a conexão nesta consulta. connected=false não prova a causa: pode faltar conexão ou a consulta não ter sido concluída. Nunca invente diagnóstico da Meta. " +
  "Para criar no chat: use o clipe para fotos da galeria ou a câmera para tirar uma foto; diga o que quer. Vídeo suave de 10s somente a partir de foto, com música e sem narração. " +
  "Abaixo de cada foto preparada, escolha preço/informação, imagem ou vídeo, data e hora e Feed/Reel e/ou Story. Toque em Continuar quando estiver certo; se faltar logo, o app solicita. " +
  "Para ver publicações planejadas, toque no calendário à direita. Um pedido recebido ainda não é arte pronta nem publicação confirmada; não invente horários ou prazos. " +
  "Para exemplos, toque no ícone central da iA4tube: Posts prontos. Ali há Vídeos, Imagens e Minhas imagens. " +
  "Em Minhas imagens, Original usa a imagem enviada com a adaptação de formato existente; Modo iA4tube trabalha a arte com a logo e as informações. Cada imagem tem legenda e agendamento próprios. " +
  "No rodapé: Combo mostra os planos; Mais → Meus combos mostra o resumo do saldo; Mais → Pedidos mostra os pedidos. Não invente valores nem conceda créditos. " +
  "Mais → Perfil da empresa permite informar logo, segmento e contatos. Dentro dele, Minha conta mostra Google ou WhatsApp, o login e Copiar login, somente para consulta. " +
  "Para abandonar só a preparação ainda não enviada, o cliente pode pedir Descarte esta proposta. Isso não cancela pedidos enviados à produção. " +
  "Se faltar informação para ajudar, faça uma única pergunta curta sobre a tela ou a mensagem de erro. Em questões fora deste guia, não invente botões ou recursos.";

const normalized = normalize;

function isHelpQuestion(value) {
  return productQuestion(value);
}

function simpleHelpReply(value, facts = {}, context = {}) {
  if (!isHelpQuestion(value)) return null;
  const product = resolveProductReply(value, facts, context);
  if (product) return product.reply;
  const s = normalized(value), instagram = /\b(?:instagram|insta)\b/.test(s);
  if (instagram && /\b(?:navegador|chrome|browser)\b/.test(s))
    return "A autorização é pelo navegador oficial do Instagram. Entre nele com a conta que deseja conectar.";
  if (instagram && /\b(?:permitir|permissao|autorizar|autorizacao)\b/.test(s))
    return "Na tela oficial do Instagram, confira a conta, toque em Permitir e volte ao app.";
  if (instagram && /\b(?:conectado|conectada)\b/.test(s) && !/\b(?:nao|erro|falha)\b/.test(s))
    return facts.connected ? "A conexão foi confirmada. Para conferir a conta, toque no ícone do Instagram."
      : "Abra o ícone do Instagram para conferir a conexão. Se aparecer erro, me diga a mensagem.";
  if (instagram && /\b(?:conectar|conecto|reconectar|reconecto|vincular|vinculo)\b/.test(s)) {
    if (/\b(?:nao|erro|falha)\b/.test(s)) return "Toque no ícone do Instagram e me diga qual mensagem aparece na tela.";
    return "Toque no ícone do Instagram, no alto à esquerda, e depois em Conectar Instagram.";
  }
  if (/\b(?:login|senha)\b/.test(s) && (!instagram && context.topic !== "connection"))
    return /\bsenha\b/.test(s) ? "Não envie sua senha aqui. Para consultar seu login: Mais → Perfil da empresa → Minha conta."
      : "Toque em Mais → Perfil da empresa → Minha conta. Lá você vê e copia seu login.";
  if (/\b(?:saldo|credito|creditos)\b/.test(s) && /\b(?:onde|ver|vejo|consultar|consulto|encontrar)\b/.test(s))
    return "Toque em Mais → Meus combos para ver o resumo do seu saldo de imagens e vídeos.";
  if (/\b(?:plano|planos|combo|combos)\b/.test(s) && /\b(?:onde|ver|vejo|abrir|abro)\b/.test(s))
    return "Toque em Combo, na parte de baixo da tela, para consultar os planos disponíveis.";
  if (/\b(?:calendario|agendad[ao]s?|planejad[ao]s?)\b/.test(s) && /\b(?:onde|ver|vejo|consultar|consulto|abrir|abro|encontrar)\b/.test(s))
    return "Toque no ícone do calendário, acima da conversa à direita, para ver suas publicações planejadas.";
  if (/\b(?:horario|agendar|data)\b/.test(s) && /\b(?:escolher|escolho|selecionar|seleciono|definir|defino)\b/.test(s))
    return "Na preparação, escolha a data e a hora abaixo de cada foto. Depois toque em Continuar.";
  if (/\b(?:pedido|pedidos)\b/.test(s) && /\b(?:onde|ver|vejo|consultar|consulto|encontrar)\b/.test(s))
    return "Toque em Mais → Pedidos para acompanhar suas artes. Pedido recebido ainda está aguardando a produção.";
  if (/\b(?:foto|fotos|imagem|imagens)\b/.test(s) && /\b(?:enviar|envio|anexar|anexo|galeria|clipe|camera)\b/.test(s))
    return "Use o clipe ao lado da caixa de mensagem para a galeria, ou a câmera para tirar uma foto.";
  if (/\b(?:logo|perfil)\b/.test(s) && /\b(?:colocar|coloco|adicionar|adiciono|salvar|salvo|editar|edito|preencher)\b/.test(s))
    return "Toque em Mais → Perfil da empresa para salvar sua logo e as informações do negócio.";
  return null;
}

function discardRequested(value) {
  const s = normalized(value).replace(/[.!]+$/, "");
  return /^(?:pode )?(?:descarte|descartar|cancele|cancelar|apague|apagar|limpe|limpar) (?:(?:esta|essa|a|minha|o|meu|esse|este) )?(?:proposta|rascunho|preparacao)(?: atual)?$/.test(s) ||
    /^nao quero mais (?:esta|essa|a|minha|o|meu|esse|este) (?:proposta|rascunho|preparacao)$/.test(s);
}

module.exports = { HELP_GUIDE, isHelpQuestion, simpleHelpReply, discardRequested };
