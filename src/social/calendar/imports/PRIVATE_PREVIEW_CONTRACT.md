# iA4tube — preparação e prévia privada candidatas

Implementação local de 13/09/2026. Não está montada na API publicada. O fato de existir um arquivo recebido, um manifesto de resultado ou um vídeo reproduzível não cria agendamento, consentimento nem publicação.

## Composição comprovável localmente

1. Upload e selamento existentes: bytes e hash vinculados à empresa/usuário.
2. Inspeção real do disco: snapshot privado, assinatura, Sharp ou FFmpeg, ticket/fence e reserva global próprios.
3. Seleção explícita na fila de preparo. O aplicativo registra sua intenção antes da requisição, usando a mesma chave para resposta incerta.
4. `prepared-disk-admission` reserva pico conservador de armazenamento: duas fontes temporárias, duas reservas de derivados e metadados. A origem já recebida continua contabilizada separadamente. Espaço retido não desaparece porque um prazo passou.
5. O worker realmente obtém a vaga correspondente antes de copiar/preparar; a aquisição por job esperado não captura a posição justa de outra empresa. Fonte é lida em blocos, novamente conferida e preparada pelo código existente.
6. `prepared-disk-store` exige a intenção imutável antes das cópias, decodifica saídas sob a vaga ainda ativa, registra certificado e hashes e instala um único resultado por dispatch. A fila só aceita o resultado após conferir manifesto, proprietário, revisão, origem, plano e bytes.
7. A prévia serve apenas derivados privados da revisão atual. Exige sessão vigente para cada solicitação, revalida a empresa e a elegibilidade, confere arquivo/hash e permite leitura parcial de MP4.

`local-preparation-runner` é um harness de teste em memória. Retoma uma resposta perdida na mesma execução, mas não declara persistência após morte do processo nem equivalência com um executor Render. Os runners locais são reconhecidos por marca interna e opt-in explícito apenas com store volátil de teste; copiar um objeto com capabilities não habilita esse caminho.

Os módulos declaram `readyForProduction=false`, `osSandbox=false` quando aplicável e prazo **cooperativo**, sem terminação forçada. FFmpeg recebe o prazo restante; os blocos e fases também o verificam. Uma operação de disco/banco que não retorna não pode ser interrompida com garantia por este harness. Sua vaga permanece retida até confirmação de término real. Não usar uma corrida de promises para fingir que o processo parou. O executor isolado com limite externo continua sendo condição operacional pendente.

## Rotas candidatas, somente leitura

Montagem futura de `createPrivateImportPreviewRouter` em `/v1/social/calendar/imports`, antes do 404 final do router de metadados. Não foi feita em `server.js` ou na produção.

`GET /assets/:assetId/revisions/:mediaRevision/preview` retorna `{ok:true,preview}` com:

- assetId, mediaRevision, currentRevision, previewDigest e testOnly;
- variants: target, kind, mimeType, sha256, sourceSha256, width, height, sizeBytes, durationMs, audioMode, hasAudio, url;
- thumbnail: null ou descriptor JPEG com target `thumbnail`.

`GET|HEAD .../preview/:target` aceita feed, story, reel ou thumbnail. O endereço canônico é HTTPS na origem oficial `https://ia4tube-api.onrender.com`. Não inclui JWT, assinatura, chave de disco ou resultRef. O cliente deve autenticar a requisição atual; conhecer o link não autoriza a leitura. A rota não serve o original enviado.

- Só GET/HEAD; caminho exato, sem query, body, codificação ou cabeçalhos ambíguos.
- `Range` único, incluindo sufixo e intervalo aberto; múltiplos intervalos recusados. Limite de arquivo/resposta: 100 MiB; imagem até 8 MiB; chunks até 64 KiB.
- `private, no-store`, nosniff, sem ETag/304 autorizado por cache. Configuração futura do host deve preservar essas propriedades.
- Duas operações concorrentes por instância/processo, incluindo resolução do proprietário; prazo HTTP de até 60 segundos. Não é limitação distribuída nem teto financeiro.
- Mudança da revisão atual invalida o link usado pelo editor sem apagar o resultado histórico. A integração local do calendário agora usa `/schedules/:id/preview/:target`, vinculada à revisão imutável do agendamento. Ela exige sessão/proprietário e recusa o item cancelado; não reabre o editor nem escolhe um derivado mais recente silenciosamente.
- Revogação observada impede novos chunks; bytes já recebidos antes dela não são recuperáveis remotamente.
- Certificado de decode é produzido no commit. Leituras conferem os hashes/identidade reais, sem executar FFmpeg a cada abertura.

## Android — continuação local de prévia, áudio e agendamento

Cliente e coordenador validam origem/caminho, sessão, revisão, fonte, variantes, áudio e fingerprint. Não há polling contínuo, aceite automático da prévia ou novo POST ao simplesmente reabrir uma intenção ainda incerta. Material sintético não vira READY comercial.

Download privado, integração Media3, escolha de áudio/formato, confirmação das variantes e agendamento foram ligados às entradas “Adicionar foto ou vídeo” do calendário e da galeria. Arte já gerada pode entrar pelo comando “Usar com música”, sem novo pedido ou crédito de geração. Trocar o tratamento exige nova revisão/preparação e confirmação. A prévia usa o hash e os bytes correspondentes; volume local não altera o áudio final. O player é liberado ao sair do item visível ou da sessão, sem pré-carregar todos os vídeos.

Intenções privadas são persistidas antes dos POSTs. Respostas incertas de preparo/agendamento são consultadas antes de repetir; a origem gerada conserva sua chave para recuperar a mesma cópia. Calendário, galeria e próxima publicação projetam o mesmo registro. Editar data/legenda, pausar ou cancelar não cria outro calendário; envio já iniciado bloqueia alterações incompatíveis.

Essas ligações são candidatas locais. O serviço de agendamento exige a store volátil genuína da simulação. O provedor de entrega simulado fica exclusivamente em `tests/helpers/local-calendar-delivery-simulator.js`, reutilizando a máquina de destinos existente. Não é outro publicador para implantar. O worker de produção ainda ignora imports/MP4; sua adaptação operacional continua pendente. Não houve novo AAB, instalação, montagem das rotas em produção ou validação física do áudio no aparelho.

## Não liberar por inferência

Comercialidade da trilha (`plan.testOnly`) não equivale à prontidão operacional do executor/store. Uma foto real de teste pode ter `testOnly=false` no plano enquanto toda a composição continua exclusivamente local. Para ativar: executor com fronteira real de processo, infraestrutura/custo aprovados, durabilidade/retenção/recuperação verificadas, música real com direitos aplicáveis, UI e calendário integrados e testes no A55. Nenhuma dessas autorizações decorre deste contrato.
