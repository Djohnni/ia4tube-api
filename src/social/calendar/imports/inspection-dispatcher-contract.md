# iA4tube — dispatcher durável de inspeção: contrato local

12/09/2026. Implementação e testes locais; nenhuma contratação, endpoint remoto acionado, credencial consultada, mídia real transferida ou recurso de nuvem criado.

## Integração

O dispatcher também aceita Render disk. Nesse caso, a mesma transação cria
upload.disk.inspectionTicket somente para a fonte selada do proprietário,
com inspectionRequested verdadeiro e ticketId igual a disk.objectVersion.
O task inclui providerType igual a render_disk e omite ETag; seu digest inclui
o tipo do provider. O resultado deve devolver esse mesmo tipo, proprietário,
versão e digest. Tickets R2 existentes mantêm seu formato e digest anteriores.
Os dois tipos compartilham o mesmo bucket de inspeção, sem duplicar a quota.

O caminho local usa createLocalDiskInspectionRunnerForTests com store,
worker ou getWorker e enabled verdadeiro. Exige allowLocalForTests e
allowVolatileForTests verdadeiros no dispatcher. O runner é marcado
internamente, executa o worker real e grava seu resultado na fixture volátil.
Copiar capabilities não habilita esse caminho. Tanto runner quanto dispatcher
declaram que a execução local não é isolada; o provider aceita somente esse
dispatcher marcado com infraestrutura volátil explicitamente permitida.
O runner local declara deadlineMode cooperative e hardTermination false;
esperas locais pendentes não liberam slots apenas porque o prazo passou.
readyForProduction permanece falso. Ver o
[contrato do worker em disco](disk-inspection-worker-contract.md).

`createDurableInspectionDispatcher({store,runner,allowedOwners,accessPolicy,enabled:false,clock})` retorna o inspector esperado pelo adapter R2: `startInspection(request)` e `getInspection({context,ticketId})`. Configuração habilitada exige store serializável/durável, runner com execução isolada e prazo real de 180 segundos, dispatch idempotente/lookup autoritativo e uma política de acesso confiável do piloto. `allowedOwners:[par]` permanece compatível; a alternativa é `accessPolicy` marcado internamente, nunca ambos. A política reconfere revogação antes do dispatch. Modo multiempresa permanece fechado até compor o coordenador global real; ver [contrato de acesso](access-policy-contract.md). Adapters voláteis exigem opt-in explícito somente para testes.

Conectar esse objeto em `createR2PrivateUploadProvider({...,inspector})`. A API troca somente metadados. O `runner` real ainda deve ser fornecido pela composição autorizada; este arquivo não implementa serviço externo nem executa mídia no processo da API.

O schema aditivo mantém `upload.r2.inspectionTicket`, acrescentando `dispatch` com digest da solicitação, chave única, token de fencing, mês, orçamento reservado, estado/resultado e lease de consulta. A quota fica em `state.inspectionQuota={schema:1,months:{'YYYY-MM':{starts,reservedComputeMs,chargedComputeMs}}}`. Exporta `validateInspectionDispatchState(state,companyId)` para o store chamar antes/depois de toda transação. Tickets despachados sem a respectiva quota são rejeitados como estado órfão.

## Contrato do runner, sem API inventada

- `dispatch(task)` recebe `schema`, tipo `inspect_import`, proprietário, ticket/upload/asset, dispatchKey/executionDigest, fenceToken, referência privada do objeto e tamanho/digest, mediaKind, startedAt/deadlineAt e maxRuntimeMs.
- `getByKey({companyId,userId,dispatchKey,executionDigest})` é somente reconciliação daquele disparo.
- Ambos retornam dispatchKey/executionDigest e estado not_found/running/succeeded/failed. not_found exige `authoritative:true`; os demais exigem executionId opaco.
- succeeded contém recibo vinculado ao proprietário, ticket/objeto/versão/ETag/digest de execução, tempo de término e duração real, mais `inspection` produzida pelos bytes reais. Não aceitar MIME, ETag multipart ou resultado apresentado pelo cliente como prova.
- O handler do worker deve mapear explicitamente `mediaKind` para `kind` e `maxRuntimeMs` para `deadlineMs` antes de chamar `r2-inspection-worker.execute`; o envelope de execução e a autenticação do runner não são entradas editáveis do aplicativo.

O Render documenta uma API/SDK para iniciar e consultar tarefas; o SDK TypeScript expõe `workflows.startTask` e leitura por taskRunId. Isso não comprova o contrato adicional exigido aqui: chave de despacho única persistente e reconciliação autoritativa por essa chave. Por isso não foi criado um adapter que presumisse um endpoint de idempotência inexistente ou que reenviaria automaticamente POST após timeout. Fontes: [execução de tarefas](https://render.com/docs/workflows-running) e [referência TypeScript](https://render.com/docs/workflows-sdk-typescript).

## Idempotência e falhas

A reserva e a intenção ficam gravadas ANTES do primeiro `dispatch`. Chamadas concorrentes/repetidas não criam outro job. Após perda de resposta, somente getByKey é permitido. Mesmo not_found autoritativo não dispara novamente nesta implementação: permanece reconciliação/atenção. Isso preserva a segurança quando o fornecedor não permite provar que um POST atrasado nunca chegará.

O limite de espera pelo reconhecimento é 10 segundos, separado do prazo de execução de 180 segundos. Encerrar a espera da API não é prova de que o job remoto foi cancelado. O runner tem de impor o prazo de execução; o sistema local não presume esse efeito de um AbortSignal.

Estado desconhecido retém a reserva; ao ultrapassar o prazo, registra atenção e contabiliza conservadoramente o orçamento completo. Uma observação tardia de resultado terminado comprovadamente dentro do prazo ainda pode ser aceita, sem criar outra reserva. Resultado de outra empresa, digest divergente, ausência de inspeção real ou prazo inválido não vira ready.

## Quota conjunta e limites de custo

Alinhamento com `preparation-queue.js`: ambos usam mês UTC e o mesmo único par permitido do piloto. A preparação já limita a 60 reservas por mês, incluindo transferências conservadoras entre meses. A inspeção permite no máximo 60 inícios/reservas mensais. A soma é **no máximo 120 reservas/disparos autorizados por mês**, não 120 novos jobs além dos 60 de preparação.

Cada job tem orçamento máximo de 180 segundos. A soma teórica desses orçamentos é 21.600 segundos, ou 6 horas de execução de worker. Isso não fixa CPU/RAM, preço, arredondamento de cobrança, tráfego, armazenamento, operações de consulta, recursos preexistentes ou atrasos entre meses. Não é promessa de custo em dólares nem garantia da fatura.

**Nenhuma quota do aplicativo constitui hard cap de US$5 no fornecedor.** Sem comprovação de teto real exigido pelo proprietário, não provisionar R2, Render Workflows ou outro serviço. Alertas de consumo não substituem bloqueio de cobrança. A implementação permanece local e bloqueada por padrão.

## Provas locais

Testes focais cobrem ausência de infraestrutura/owner, referência selada e propriedade, concorrência/idempotência, quota antes do dispatch, rejeição da 61ª inspeção, preservação do bucket de preparação, timeout/resposta perdida, ausência de redispatch, recibos inválidos, observação tardia, troca de mês, lease/cooldown de leitura e estado órfão. A fixture de preparação verifica preservação do namespace; não é uma execução real de 60 preparações nem prova de capacidade em nuvem.

Nenhuma API real do Render foi chamada. Nenhum runner de produção, orçamento financeiro garantido, conta de serviço ou publicação foi habilitado por esta entrega.
