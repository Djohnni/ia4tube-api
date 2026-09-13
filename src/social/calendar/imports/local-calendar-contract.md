# Calendário de importação — composição local iA4tube

Esta entrega conecta o pipeline real de arquivo recebido → inspeção → preparação → prévia privada ao **mesmo** `owner_state.jobs` usado pelas artes. A entrada continua `sourceKind: upload`, sem `planningId`, `orderId`, pedido de geração ou crédito. O sincronizador conserva importações; calendário, próxima publicação e projeção da galeria leem o mesmo registro e sua revisão de edição.

## Fronteira local e música

`createLocalCalendarSimulationStore({enabled:true})` cria efetivamente uma store volátil. Uma prova não serializável existe somente durante a transação dessa store. `schedulePreparedImport` admite `testOnly:true` exclusivamente com essa prova e revalida o catálogo sintético para a data escolhida. Clones, booleanos HTTP, store PostgreSQL, objetos de capabilities e uma snapshot fora da transação não recebem essa exceção. Seu comportamento comercial padrão continua recusando música sintética.

`createLocalCalendarImportService` exige essa instância genuína, o controle de acesso e o armazenamento privado preparado real. Não recebe um publicador externo. A simulação de resultados é criada junto à store, sem rede. `readyForProduction:false`, `networkDelivery:false`, `localSimulation:true`; o tick de produção existente **continua ignorando uploads**. A preferência e a confirmação de automação exercidas aqui são somente uma simulação local de consentimento, nunca autorização para Instagram. Não há rota HTTP para configurar resultado simulado ou iniciar tick.

Os testes geram uma onda senoidal WAV local de 15 s; não há música conhecida nem alegação de direitos comerciais. As preparações reais mantêm os limites existentes, o controle global de espaço/execução e o deadline cooperativo (sem alegar terminação dura do processo). Story e Reel equivalentes compartilham o mesmo MP4. O silêncio do player não muda `audioMode`; mudar áudio/formato solicita outra preparação e outra confirmação. Uma preparação nova não altera uma programação já confirmada.

## HTTP autenticado (somente composição local)

Prefixo: `/v1/social/calendar/imports`. Mantêm-se a autenticação JWT real, identidade derivada no servidor, JSON de até 16 KiB, rejeição de campos extras, resposta privada sem cache e erros reduzidos. A composição de testes escuta exclusivamente loopback; nenhum arquivo de montagem em produção foi alterado.

| Operação | Contrato |
|---|---|
| `POST /assets/:assetId/prepare` | Contrato existente: `uploadId,idempotencyKey,expectedMediaRevision,selection`. Nova revisão quando a expectativa corresponde; revisões anteriores conservam seus próprios jobs/fences. |
| `GET /assets/:assetId/schedule-availability` | `{ok:true,availability:{identity,assetId,mediaRevision,previewDigest,ready,connected,authorized,automaticPreference,username,localSimulation,commercialReady,blockedReason}}`. Não cria agendamento. |
| `POST /assets/:assetId/schedule` | `mediaRevision,previewDigest,idempotencyKey,date,time,caption,automatic,confirmed:true`. Data e horário em `America/Sao_Paulo`; exige revisão atual para nova programação. |
| `GET /assets/:assetId/schedules/by-key/:key` | Recuperação somente leitura da confirmação incerta, por proprietário, asset e chave. `404` se ausente. |
| `GET /schedules/:id` | Recibo do mesmo registro, incluindo edições/pausa/cancelamento posteriores. ID de calendário é hex40, não UUID. |
| `GET/HEAD /schedules/:id/preview[/feed\|story\|reel\|thumbnail]` | Metadados ou bytes privados da **revisão agendada**. Mesmas proteções de autenticação, isolamento, hashes reais, Range único limitado, deadline/contrapressão e até 64 KiB por chunk. Sem original, chave de objeto, caminho local ou token na URL. Cancelamento bloqueia novas leituras. |
| `POST /sources/generated/:calendarItemId` | `revision,idempotencyKey`. Apenas um resolver confiável do item já existente fornece bytes; nenhum caminho ou URL arbitrário é aceito. Retorna upload real inspecionado e proveniência. |

Recibo: `{ok:true,schedule:{id,assetId,mediaRevision,previewDigest,idempotencyKey,date,time,caption,revision,phase,automaticEnabled,localSimulation,media,selectedTargets,destination}}`. Repetir exatamente o POST retorna o mesmo registro atualizado; não desfaz uma edição, pausa ou cancelamento. Reutilizar a chave com outro conteúdo é conflito, sem nova preparação/programação. Não há repetição automática de uma mutação incerta.

Fonte gerada: `{ok:true,upload:<registro normal em uploaded>,source:{kind:'generated_art',calendarItemId,revision,sha256,width,height},identity:{companyId,userId}}`. Usa o upload/inspeção e as cotas existentes, sem nova geração. A origem é registrada por código confiável na composição em memória, não por campo do cliente. Uma arte idêntica com outra identidade/revisão não pode reutilizar a mesma chave. A arte anterior, seus bytes e suas demais programações permanecem intactos. Esta proveniência em memória não é uma promessa de durabilidade após reiniciar o simulador.

## Mesmo DTO e mesmas ações

Com a integração local genuína, `calendar.list` e `overlay` incluem identidade autenticada `{companyId,userId}`. Um item importado contém `sourceKind:'upload'`, `selectedTargets`, `localSimulation:true` e `media`. `media` usa o envelope da prévia existente (`assetId,mediaRevision,currentRevision,previewDigest,testOnly,variants,thumbnail`) acrescido de `sourceKind:'upload'|'generated_art'` e `shareToFeed`. Aqui `currentRevision` identifica a revisão agendada, não a revisão atual do editor. URLs HTTPS canônicas apontam a `/schedules/:id/preview/:target` e exigem autenticação em cada acesso.

`imageUrl:null` e `previews:{}` impedem chamar MP4 pelo leitor JPEG legado. `destination` pode ser `feed`, `story`, `reel` ou `multiple`; Reel com `shareToFeed:true` continua uma entrega, nunca uma terceira postagem. A galeria acrescenta os registros importados ausentes da lista de gerações, com a mesma `calendar_key`, `calendar_schedule_id`, revisão, data, legenda e `calendar_media`. Itens de outra identidade não são projetados. Sem a integração local, os DTOs antigos permanecem inalterados.

`POST /v1/social/calendar/items/:id` conserva as ações de legenda, horário, pausa e cancelamento com revisão de edição. Alterar destino de uma importação exige nova preparação/confirmacão; a rota de geração legada não oferece um desvio de autorização. Reativar um item manual não cria consentimento retroativo. Depois do primeiro intent, edições incompatíveis/cancelamento são bloqueados. Cancelar é somente retirar a programação futura: nenhum original, upload, derivado, outra programação ou conexão é excluído.

## Prova e limites

O loop de simulação fica exclusivamente em `tests/helpers/local-calendar-delivery-simulator.js`, reutilizando `destinations.targets/started/record`. Não há tick de importações neste serviço de aplicação nem outro motor a implantar. A ligação MP4 ao publicador de produção continua pendente e bloqueada. A disponibilidade do simulador sempre informa `commercialReady:false`, inclusive para JPEG sem música.

O recibo concluído da fonte gerada é consultado antes de reler a arte anterior: editar/cancelar o original depois de perder a resposta não abandona a cópia já inspecionada. A identidade/revisão da origem e o owner continuam vinculados à chave. Intenções locais de fonte têm limite de 1000 registros, além das cotas existentes de uploads/preparação. Os mapas não são declarados duráveis.

`tests/fixtures/gallery-import-http-contract.json` acrescenta envelopes HTTP reais correlacionados (`capabilities,source,asset,preview,availability,schedule`) para os parsers Android. A disponibilidade explica a restrição de Story em conta não-business antes da confirmação.

`tests/calendar-import-local-schedule.test.js` percorre fotos, foto/arte gerada com trilha sintética, vídeo original e silenciado, hashes dos bytes efetivamente servidos, revisão do áudio/formato, confirmação incerta, visão comum, edição/pausa/cancelamento, isolamento e destinos independentes. O intent por destino é gravado antes da simulação; resultado desconhecido é observado sem repetir envio; destino já confirmado não é reenviado. Preferência/conta desconectada são verificadas antes de começar outro destino. Nenhum teste chama Instagram.

`tests/fixtures/gallery-import-calendar-contract.json` é uma resposta sanitizada de dados exclusivamente sintéticos, capturada do pipeline real de foto + MP4 local + arte anterior. Serve como golden entre servidor e Android, não como comprovação de montagem em produção ou execução física no aparelho. Os testes de integração também verificam o formato da resposta real. Estado volátil, interrupção de processo, catálogo comercial, executor isolado, Render, A55 e teto financeiro absoluto continuam pendentes.
