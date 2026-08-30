# Gate 5A — decisões jurídicas exigidas do proprietário

Status em 30/08/2026: **PENDENTE**. Este arquivo não é aconselhamento jurídico e não aprova os três rascunhos públicos.

Princípio: nenhum implementador deve preencher por inferência razão social, CNPJ, endereço, encarregado, e-mail, base legal, prazo, garantia, jurisdição ou política comercial. Cada decisão abaixo exige resposta expressa do proprietário e, quando aplicável, revisão jurídica, de segurança e operacional.

## 1. Identidade e contato

| ID | Decisão necessária | Estado atual | Evidência/aprovação exigida |
|---|---|---|---|
| LEG-01 | Identidade jurídica responsável pelo tratamento e pelo serviço | Não definida | Nome jurídico confirmado pelo proprietário e documentação mantida fora do repositório público |
| LEG-02 | Nome comercial a exibir | “IA4Tube” é usado no produto; relação com a identidade jurídica ainda não aprovada | Confirmação expressa do proprietário |
| LEG-03 | CNPJ ou outro registro a publicar, se aplicável | Não informado | Decisão jurídica; não inserir por suposição |
| LEG-04 | Endereço e território da entidade responsável | Não informados | Decisão jurídica |
| LEG-05 | Canal oficial para privacidade, suporte e exclusão | Não aprovado | Endereço ou fluxo real, monitorado e testado |
| LEG-06 | Encarregado/DPO e respectivos dados públicos, se aplicável | Não definido | Avaliação jurídica e aceite da pessoa responsável |
| LEG-07 | Data de vigência, versão e processo de notificação de mudanças | Não definidos | Aprovação do texto final e processo operacional |

## 2. Dados, finalidades e bases

| ID | Decisão necessária | Material técnico já comprovado | Ponto ainda aberto |
|---|---|---|---|
| LEG-08 | Categorias finais de dados | Identificadores internos; metadados da conta profissional; escopos; metadados OAuth; credencial criptografada; mídia/legenda e referências; estados e auditoria | Confirmar se outras superfícies do produto entram na mesma política |
| LEG-09 | Finalidades finais | Conectar conta, descobrir perfil, publicar conteúdo autorizado, consultar/reconciliar resultado, impedir duplicidade, proteger e auditar | Aprovar redação e separar finalidades essenciais/opcionais |
| LEG-10 | Base jurídica por finalidade e território | Nenhuma base jurídica foi escolhida pelo código | Definição jurídica explícita; não confundir OAuth com base legal geral |
| LEG-11 | Escolhas, consentimentos e revogações do usuário | O produto possui autorização OAuth e controle de conexão | Definir avisos, consentimentos adicionais e registro de preferências |
| LEG-12 | Dados sensíveis, dados de menores e restrições de uso | Não há decisão jurídica publicada | Definir elegibilidade, proibições e tratamento de incidentes |
| LEG-13 | Uso secundário, análise, publicidade e treinamento | Não autorizado por estes rascunhos | Aprovar ou proibir expressamente cada uso |

## 3. Fornecedores, compartilhamentos e transferências

| ID | Decisão necessária | Estado atual |
|---|---|---|
| LEG-14 | Lista de fornecedores/suboperadores e função de cada um | Não aprovada para publicação |
| LEG-15 | Categorias e volumes de dados enviados a cada fornecedor | Inventário jurídico pendente |
| LEG-16 | Contratos e obrigações de exclusão/segurança dos fornecedores | Verificação pendente |
| LEG-17 | Transferências internacionais, mecanismos e avisos | Avaliação jurídica pendente |
| LEG-18 | Compartilhamento com Meta/Instagram | Finalidade técnica conhecida; redação e enquadramento jurídico pendentes |
| LEG-19 | Processo de atualização pública da lista de fornecedores | Não definido |

## 4. Retenção, backups, logs e auditoria

| ID | Decisão necessária | Categorias que precisam de regra própria |
|---|---|---|
| LEG-20 | Prazo/critério de retenção de conexão e conta externa | Conexões, identificadores, username, tipo, status e escopos |
| LEG-21 | Prazo/critério de retenção de credenciais e metadados OAuth | Credencial criptografada, transações, digests e concessões temporárias |
| LEG-22 | Prazo/critério de retenção de publicação | Referência de mídia, legenda, estados, referência do provedor e tentativas |
| LEG-23 | Prazo/critério de retenção de idempotência | Hashes, estado e códigos de resultado |
| LEG-24 | Prazo/critério de retenção de logs e auditoria | Eventos, correlação, resultado, ator e horários |
| LEG-25 | Política de backup | Cobertura, ciclos, restauração, expurgo e efeito de uma exclusão |
| LEG-26 | Retenção obrigatória e legal hold | Fundamento, escopo, autoridade e prova documental |
| LEG-27 | Anonimização ou agregação posterior | Critérios técnicos e teste de não reidentificação |

Nenhum prazo deve ser publicado antes de estas decisões estarem aprovadas e implementadas de forma verificável.

## 5. Desconexão e exclusão

| ID | Decisão necessária | Questão objetiva |
|---|---|---|
| LEG-28 | Escopo da desconexão | Confirmar credencial, novas publicações, itens atrasados e reconexão |
| LEG-29 | Escopo da exclusão dos dados da conexão | Definir tabelas/objetos elegíveis e dependências |
| LEG-30 | Artes, legendas, pedidos e planejamento | Preservar, excluir ou oferecer escolha? Por quanto tempo e por quê? |
| LEG-31 | Histórico comercial/publicações confirmadas | Preservar, anonimizar ou excluir? Com qual fundamento aprovado? |
| LEG-32 | Auditoria e prova após exclusão | Quais campos mínimos permanecem e por quanto tempo? |
| LEG-33 | Backups após exclusão | Quando deixam de conter dados eliminados e como impedir restauração operacional indevida? |
| LEG-34 | Verificação de identidade/autoridade | Como confirmar o solicitante sem coletar segredo do Instagram? |
| LEG-35 | Canal e acompanhamento | Interface, código opaco, status e confirmação final |
| LEG-36 | Prazo e prioridade | Prazo operacional e jurídico, sem promessa antes de capacidade comprovada |
| LEG-37 | Recusa ou retenção parcial | Motivos permitidos, explicação ao usuário e contestação |
| LEG-38 | Solicitação encaminhada pela Meta | Escolher instruções públicas, callback assinado ou ambos; manter contratos coerentes |

## 6. Termos de Uso

O proprietário e a revisão jurídica precisam decidir:

- partes, capacidade, elegibilidade e forma de aceite;
- autoridade do usuário sobre a empresa e a conta profissional;
- direitos sobre imagens, legendas, marcas e conteúdo gerado;
- licença estritamente necessária para processar/publicar conteúdo;
- conteúdo proibido, denúncias, remoção e reincidência;
- diferenças entre preparação, publicação manual, aprovação prévia e futura automação;
- efeitos de edição, pausa, cancelamento, retry, desconexão e falhas do provedor;
- planos, cobrança, renovação, cancelamento e reembolso, se aplicáveis;
- suporte, manutenção, suspensão, encerramento e exportação;
- garantias, limitações, indenização, força maior e serviço de terceiro;
- legislação, foro ou mecanismo de resolução, sem inventar jurisdição;
- alterações dos termos e comunicação aos usuários.

## 7. Aprovações e critério de saída

Os textos só podem perder o rótulo de rascunho quando houver, no mínimo:

- [ ] respostas aprovadas para LEG-01 a LEG-38;
- [ ] inventário técnico confrontado com banco, logs, backups e fornecedores;
- [ ] fluxo real de contato e exclusão testado;
- [ ] revisão jurídica nominalmente registrada fora das páginas públicas;
- [ ] aprovação do proprietário;
- [ ] revisão de segurança e operações;
- [ ] URLs finais verificadas sem login, sem bloqueio a crawlers e sem redirecionamento indevido;
- [ ] versão e data de vigência definidas;
- [ ] decisão separada para usar os textos no Meta App Review.

Até lá: `LEGAL_CONTENT_FINAL_APPROVED=NAO` e `MARCO_20_CONCLUIDO=NAO`.
