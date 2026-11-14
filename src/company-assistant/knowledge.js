"use strict";
const plans = require("../billing/plans");
const normalize = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const money = value => "R$ " + new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(value);
const currentCatalog = () => plans.listPlans().map(p => ({ id: p.id, name: p.name, price: p.price,
  images: p.imagesPerMonth, videos: p.videosPerMonth }));

function accountPlan(client, active) {
  const p = plans.getPlan(client?.plano_atual || client?.plano || "");
  return { active: active === true, name: p?.name || "", id: p?.id || "",
    renewsAt: typeof client?.plano_renova_em === "string" && Number.isFinite(Date.parse(client.plano_renova_em)) ? client.plano_renova_em : null };
}

function knowledgeGuide() {
  return "CONHECIMENTO DO PRODUTO iA4tube: ajude também quem ainda está conhecendo ou avaliando o app, não só quem já quer criar. " +
    "A iA4tube reduz o trabalho de montar e programar divulgações: cria imagens e vídeos com as fotos, marca e informações da empresa e publica no Instagram nas datas escolhidas, após confirmação e autorização. " +
    "O cliente não precisa editar manualmente nem aparecer no vídeo. Pode divulgar produtos, serviços e o ambiente; não restrinja a alimentação. Não prometa vendas, seguidores, alcance ou prazo exato. " +
    "INTENÇÃO ANTES DO BOTÃO: 'vim pelo Instagram/anúncio' é origem do contato, não um pedido para conectar. 'Quero saber sobre esse app', 'o que vocês fazem' e 'como funciona' pedem apresentação. Explique primeiro o benefício e o funcionamento; não responda só 'abra Posts prontos'. " +
    "'Quanto custa', 'qual plano tem 4 vídeos' e 'qual a diferença' pedem preço/quantidade do catálogo atual, não só o botão Combo. Responda a informação antes de indicar o caminho. Perguntar sobre plano não autoriza compra nem emissão de Pix. " +
    "OFERTA ATUAL (mensal, inclui postagem automática; não venda os preços históricos): " + JSON.stringify(currentCatalog()) + ". " +
    "Uma criação de vídeo usa uma cota de vídeo, não uma imagem adicional. Imagens e vídeos têm cotas separadas nos planos novos. O mesmo pedido em Feed/Reel e Story não vira automaticamente duas criações cobradas. " +
    "Cotas reais e plano informado são fatos da sessão. Não invente o saldo, a data de validade ou um pagamento aprovado. Se não receber esses dados, diga como consultar. Pix gerado não é pagamento confirmado. Recomprar o mesmo plano ativo pode programar o próximo ciclo, não liberar mais cotas na hora. Não ofereça desconto, cupom, reembolso, refação grátis ou crédito sem condição confirmada. " +
    "TESTE: há benefício de imagens para contas elegíveis com Instagram confirmado; pode alcançar três no total no chat, considerando a antiga gratuidade. Não são três extras para todos, não é concedido só por cadastrar e não inclui vídeo grátis. Use trialImages quando fornecido; sem ele, explique a condição sem prometer quantidade. " +
    "FOTOS: clipe ou câmera; até quatro fotos por envio. Foto nítida de celular serve. O chat precisa de foto; não transfira a opção sem foto de alguns modelos da vitrine para o chat. Produto real e logo são referências, não prometa reprodução perfeita. Preço e texto só com informação explícita do cliente. Pode criar legenda e hashtags conforme a foto e o direcionamento. " +
    "VÍDEOS DO CHAT: foto vira vídeo suave de 10 segundos, com música e sem fala. Não recebe vídeo pronto para editar, não faz narração/voz do cliente ou duração diferente. Não ofereça seleção de música famosa do Instagram. Funções do programa Brindes no PC não são automaticamente funções deste chat. " +
    "CAMINHOS: Posts prontos é a vitrine de modelos, não a rede TikTok. Minhas imagens oferece Original, com adaptação de formato, ou Modo iA4tube, que trabalha a arte com a marca. Cada imagem tem legenda e agendamento próprios. O calendário recebe o resultado pelo fluxo existente, não por uma publicação direta do chat. " +
    "AGENDA: cliente escolhe formato, data/hora e destinos de cada foto e confirma. Pode planejar o mês dentro das cotas. Sugestões de horário são pelo ramo, não estatística dos seguidores. Não garanta produção em um minuto nem invente o destino de um pedido atrasado. Depois da confirmação, não precisa manter o chat aberto. " +
    "ESTADOS: preparado=proposta; recebido=entrada na produção; pronto=arquivo concluído; agendado=aguarda horário; publicado=confirmação real do Instagram. Feed/Reel e Story podem concluir separadamente. recentOrders.sent só confirma recebimento pela produção, não que a arte ficou pronta ou foi publicada. Sem dados da publicação, peça a mensagem da tela ou indique a consulta, sem culpar Meta, internet ou saldo por adivinhação. Não peça para reenviar cegamente se há número de pedido. " +
    "CONTA E CONFIANÇA: login do app é diferente de conta Instagram. Entrar por Google e por WhatsApp pode identificar cadastros diferentes. Perfil da empresa contém contatos editáveis; Minha conta mostra a entrada e o login, sem mudar senha. Não peça senha, token, código de segurança ou credencial no chat. Senha do Instagram só na tela oficial. Conta pessoal do Instagram é diferente do login pessoal do app: para publicação automática é necessária conta profissional. " +
    "LIMITES: este atendimento não gerencia anúncios pagos, Direct/comentários dos clientes, bio, publicação no TikTok/Facebook ou remoção de posts publicados. O projeto revisado é Android; não prometa versão oficial iOS ou uso completo no PC sem confirmação. Não invente botão Esqueci minha senha. Recuperação, retenção/exclusão de arquivos, múltiplas empresas por conta, reembolso, refação após produção e posts após vencimento exigem regra confirmada/suporte. " +
    "ESTILO: responda à intenção em uma ou duas frases curtas, até 120 caracteres; sem palestras ou listas enormes. Um passo de ajuda por vez. Não empurre cadastro, conexão ou compra antes de responder ao que foi perguntado. Não termine toda resposta com pergunta comercial. Com preparação pendente, evite perguntas de sim/não que possam ser confundidas com Continuar; peça um detalhe específico quando faltar informação. " +
    "EXEMPLOS: 'Quero saber sobre esse app' → 'A iA4tube cria imagens e vídeos da sua empresa e publica no Instagram nas datas que você escolher.'; " +
    "'Como funciona?' → 'Você envia suas fotos, diz o que quer e escolhe quando publicar. O app prepara as artes e agenda a divulgação.'; " +
    "'Vai aumentar minhas vendas?' → 'Não há garantia de vendas ou seguidores. O app facilita criar e manter suas divulgações organizadas.'; " +
    "'Como conectar?' → explicar o ícone do Instagram; 'minha conta pessoal do Instagram' → explicar conta profissional, nunca Minha conta do login. Uma pergunta não cria, cancela ou publica nada. ";
}

function directCreation(value) {
  const s = normalize(value);
  if (/^(?:como|onde|qual|quais|quanto|quantos|quantas|por que|porque|pq|o que|oq)\b/.test(s)) return false;
  return /\b(?:crie|gere|transforme|prepare|monte|faca|use|coloque|adicione|escreva|poste|publique|anime|refaca)\b/.test(s) ||
    /^(?:voce )?pode(?:ria)? (?:fazer|criar|transformar|gerar|preparar|montar|publicar|postar)\b/.test(s) ||
    /^quero ajuda (?:para|pra|a) (?:preparar|planejar|montar)\b/.test(s);
}

function productQuestion(value) {
  const s = normalize(value);
  if (directCreation(s)) return false;
  return /^(?:como|onde|qual|quais|quanto|quantos|quantas|por que|porque|pq|o que|oq|posso|me (?:ajud[ae]|expliqu[ea]|ensin[ae])|nao (?:sei|consigo|consegui|entendi)|quero (?:saber|entender|conhecer|conectar|reconectar|vincular)|preciso de ajuda)\b/.test(s) ||
    /\?$/.test(s) || /\b(?:vim|cheguei|vi|encontrei)\b.*\b(?:anuncio|instagram|insta)\b/.test(s) ||
    /^(?:conectar|reconectar) (?:o |meu |o meu )?(?:instagram|insta)[.!]*$/.test(s);
}

const planReply = p => `O ${p.name} custa ${money(p.price)}/mês e inclui ${p.images} imagens${p.videos ? ` e ${p.videos} vídeos` : ""}, com postagem automática.`;
function resolveProductReply(value, facts = {}, context = {}) {
  if (!productQuestion(value)) return null;
  const s = normalize(value), instagram = /\b(?:instagram|insta)\b/.test(s);
  const topic = context.topic || "";
  const introduction = /\b(?:vim|cheguei|vi|encontrei)\b.*\b(?:anuncio|instagram|insta)\b/.test(s) &&
    !/\b(?:como|onde|qual|quais|quanto|quantos|quantas|conectar|reconectar|senha|erro|paguei|saldo|plano|planos|combo|combos|gratis|gratuito|gratuita|teste|testar|video|videos|imagens|story|iphone|pessoal)\b/.test(s);
  if (introduction || /^(?:(?:eu )?(?:quero|gostaria de) (?:saber(?: mais)?|conhecer|entender)(?: melhor)?(?: sobre)?|o que (?:e|faz)|oq (?:e|faz)|me (?:explique|explica|fale|fala)(?: sobre)?) (?:esse |este |essa |esta |o |a |seu )?(?:app|aplicativo|ia4tube|voces)[.!?]*$/.test(s))
    return { topic: "product", reply: "A iA4tube cria imagens e vídeos da sua empresa e publica no Instagram nas datas que você escolher." };
  if (/^(?:como (?:isso )?funciona|quero saber mais|me explique melhor|me explica melhor)[.!?]*$/.test(s) && topic !== "connection")
    return { topic: "product", reply: "Você envia suas fotos, diz o que quer e escolhe quando publicar. O app prepara as artes e agenda a divulgação." };
  if (instagram && /\b(?:dois|duas|varios|varias|multiplos|multiplas|[2-9])\b/.test(s) && /\b(?:contas|perfis|empresas)\b/.test(s))
    return { topic: "connection", reply: "Não tenho confirmação de vários perfis na mesma conta. Consulte o suporte antes de vincular outra empresa." };
  if (/\b(?:iphone|ios)\b/.test(s))
    return { topic: "availability", reply: "Há versão Android na Play Store. Não tenho confirmação de uma versão oficial para iPhone." };
  const duration = s.match(/\b(\d+)\s*(segundos?|segs?|s|minutos?)\b/);
  if (/\b(?:video|videos)\b/.test(s) && ((duration && (Number(duration[1]) !== 10 || /minuto/.test(duration[2]))) || /\b(?:narrad[oa]|com narracao|minha voz|sua voz)\b/.test(s)))
    return { topic: "capabilities", reply: "Aqui, o vídeo tem 10s, com música e sem narração. Não há vídeo de outra duração ou voz personalizada neste chat." };
  if (instagram && /\b(?:senha|seguranca|seguro|codigo)\b/.test(s))
    return { topic: "connection", reply: "Não envie sua senha no chat. Você entra somente na tela oficial de autorização do Instagram." };
  if (instagram && /\b(?:conta|perfil)\b.*\b(?:pessoal|privad[oa])\b/.test(s))
    return { topic: "connection", reply: "A publicação automática exige uma conta profissional do Instagram. Isso é diferente do seu login no app." };
  if (/\b(?:esqueci|recuperar|recupero|recuperacao|perdi|redefinir|redefino)\b/.test(s) && /\b(?:senha|acesso|login)\b/.test(s))
    return { topic: "account", reply: "Minha conta mostra seu login, não sua senha. Para recuperar o acesso, use o suporte do app." };
  if (/\b(?:video|videos)\b/.test(s) && /\b(?:imagem|imagens)\b/.test(s) && /\b(?:gasta|consome|desconta)\b/.test(s))
    return { topic: "quotas", reply: "Nesse fluxo, o vídeo usa a cota de vídeo. Não desconta também uma imagem do seu plano." };
  if (/\b(?:acabaram|acabou|sem)\b.*\bvideos?\b/.test(s) && /\bimagens?\b/.test(s))
    return { topic: "quotas", reply: "Se ainda houver saldo de imagens, você pode criar imagens. As quantidades dos formatos são separadas." };
  const pricing = /\b(?:preco|precos|custa|custam|custo|valor|valores|plano|planos|combo|combos|mensalidade|essencial|destaque|profissional|empresarial)\b/.test(s) ||
    /^(?:quanto|quanto e|quanto custa)[.!?]*$/.test(s);
  if (pricing && !/^(?:onde|como (?:ver|vejo|abrir|abro|consultar|consulto))\b/.test(s) && !/\b(?:meu|minha|nao|acabou|vencer|vence|vencimento|venceu|paguei|comprei|pagamento|pix|google|whatsapp|erro|ativou|ativo|ativar|ativacao|liberar|liberado|cobrado|cobranca|cancelar|reembolso|renovar|renovacao|validade|expirou)\b/.test(s)) {
    const catalog = currentCatalog();
    const quantity = s.match(/\b(\d{1,2}|quatro|seis|dez|quinze) videos?\b/);
    const numbers = { quatro: 4, seis: 6, dez: 10, quinze: 15 };
    const count = quantity ? (numbers[quantity[1]] || Number(quantity[1])) : null;
    let selected = count !== null ? catalog.find(p => p.videos === count) : null;
    if (!selected) selected = catalog.find(p => p.name !== "Imagens" && new RegExp(`\\b${normalize(p.name)}\\b`).test(s));
    const amount = s.match(/(?:r\$\s*|de\s+)(69|99|139|199|259)(?:[,.]00)?\b/);
    if (!selected && amount) selected = catalog.find(p => p.price === Number(amount[1]));
    if (!selected && /\b(?:barato|barata|menor|inicial|primeiro|so imagens|somente imagens)\b/.test(s)) selected = catalog[0];
    if (selected) return { topic: "pricing", reply: planReply(selected) };
    if (/\b(?:video|videos)\b/.test(s) && /\b(?:preco|custa|valor|custo)\b/.test(s))
      return { topic: "pricing", reply: planReply(catalog.find(p => p.videos > 0)) };
    return { topic: "pricing", reply: `Os planos vão de ${money(catalog[0].price)} a ${money(catalog.at(-1).price)}/mês. As quantidades variam; em Combo você vê todas as opções.` };
  }
  if (/\b(?:teste|testar|gratis|gratuito|gratuita|brinde)\b/.test(s)) {
    if (/\b(?:video|videos)\b/.test(s)) return { topic: "trial", reply: "O teste identificado nesse fluxo é de imagens. Não há promessa de vídeo grátis." };
    if (Number.isInteger(facts.trialImages) && facts.trialImages > 0)
      return { topic: "trial", reply: `Esta conta tem ${facts.trialImages} imagem(ns) de teste disponíveis. O benefício depende da conexão e elegibilidade.` };
    return { topic: "trial", reply: "Há imagens de teste para contas elegíveis após conectar o Instagram. A quantidade depende do benefício disponível." };
  }
  if (/\b(?:aumentar|aumenta|garante|garantia|mais)\b.*\b(?:vendas|seguidores|alcance)\b/.test(s))
    return { topic: "product", reply: "Não há garantia de vendas ou seguidores. O app facilita criar e manter suas divulgações organizadas." };
  if (/\b(?:anuncio|anuncios|trafego)\b.*\b(?:pago|pagos)\b/.test(s))
    return { topic: "product", reply: "Criar a arte e publicar no perfil não inclui contratar anúncios pagos. Esse chat não gerencia campanhas." };
  if (/\b(?:direct|comentarios)\b/.test(s))
    return { topic: "product", reply: "Esse chat cria e programa publicações. Não oferece atendimento aos seus clientes no Direct ou nos comentários." };
  return null;
}

function shortReply(value) {
  const s = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!s) return "Não consegui responder agora. Diga qual é sua dúvida sobre o app.";
  if (s.length <= 120) return s;
  const sentences = s.match(/[^.!?]+[.!?]+(?:\s|$)/g) || [];
  let result = "";
  for (const part of sentences.slice(0, 2)) { if ((result + part).trim().length > 120) break; result += part; }
  return result.trim() || s.slice(0, 116).replace(/\s+\S*$/, "") + "…";
}

module.exports = { normalize, currentCatalog, accountPlan, knowledgeGuide, directCreation, productQuestion, resolveProductReply, shortReply };
