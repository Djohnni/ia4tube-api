# Executor de mídia em processo separado — iA4tube

## Fronteira implementada e demonstrada

O executor local usa o Node instalado, Sharp e o FFmpeg já existente. Não instala runtime, não acessa rede, não recebe comandos de usuário e não é um publicador. `readyForProduction` permanece `false`.

`createMediaProcessExecutor({workingRoot, ffmpegPath, allowedRoots, memoryBytes})` oferece somente as operações fechadas `inspect`, `prepare` e `inspect_output`. `media-process-child.js` é o entrypoint fixo. O coordenador projeta IDs, hashes, seleção validada e caminhos absolutos sob raízes privadas configuradas; não encaminha credenciais de banco/Instagram, URLs, `NODE_OPTIONS`, shell, PATH ou ambiente herdado. O filho recebe somente `SystemRoot`, `TEMP`, `TMP` e `UV_THREADPOOL_SIZE=2` no Windows. As admissões autenticadas ficam no coordenador; o filho não recebe conexão de banco.

O supervisor Windows é compilado localmente do fonte `media-process-supervisor.cs` pelo compilador .NET Framework já instalado, sem instalação ou elevação. O executável concluído é publicado por rename no mesmo volume, não por hardlink seguido de exclusão do nome original. Cria o Node suspenso, atribui um Job Object antes de retomar e limita a árvore a 512 MiB de memória comprometida, quatro processos simultâneos e no máximo 180.000 ms. A compilação preparatória não é apresentada como tempo de conversão, mas seu tempo e o da validação são descontados do prazo entregue ao supervisor; a requisição persistida não é alterada para isso. `prepareRuntime()` pode compilar o runtime no startup, antes de aceitar tarefas. O limite de memória é da árvore, não do conjunto API + PostgreSQL + supervisor.

O Job Object não permite breakaway. O prazo é monotônico e aplicado pelo supervisor, independente do event loop do filho. Falta do coordenador, excesso de stdout/stderr ou prazo acionam encerramento de toda a árvore, incluindo descendente detached. O supervisor não emite uma prova enquanto `ActiveProcesses` não for zero. O observador também comprova a saída do próprio supervisor por handle e instante de criação. Um PID reciclado nunca é alvo de encerramento e não é confundido com o supervisor original.

Stdout/stderr são drenados com limite agregado de 256 KiB; conteúdo bruto é descartado. O resultado final da drenagem é conferido também depois da saída do último processo; um burst finito excessivo seguido de exit não vira sucesso. Recibos guardam somente códigos fechados, identidade da execução, comprovação de término e métricas. Não há `Promise.race` que devolva capacidade enquanto um processo permanece vivo.

Isso é uma fronteira de encerramento e recursos de processos, **não um sandbox de filesystem/rede ou de código hostil**. Executáveis, bibliotecas e raízes são configuração confiável do operador. O usuário HTTP não escolhe nenhum deles.

## Interfaces e persistência

- `process-disk-inspection-worker.js`: `createProcessDiskInspectionWorker({provider, workingDirectory, executor, assertExecutionHeld, clock})`; `.inspect(task,{executionId})` e `.observe(task,{executionId})`.
- `process-disk-preparation-worker.js`: `createProcessDiskPreparationWorker({provider, workingDirectory, preparationRoot, resultStore, admission, executor, musicRoot, resolveMusicTrack, allowSyntheticForTests, allowVolatileForTests, clock})`; `.execute(task,{executionId,resultRef})` e `.observe(...)`.
- `createPreparedDiskOutputInspector({processExecutor,ffmpegPath})` mantém a marca e o contrato anteriores, mas decodifica também o derivado final em processo supervisionado. O modo padrão antigo permanece disponível para os testes locais históricos.

Os workers retornam `running`, `succeeded`, `failed` ou `unknown`. `succeeded` do preparo só existe depois de `resultStore.commit`, com derivado realmente decodificado, hash, dono, revisão e fence validados. Término comprovado contém `{proved:true,descendants:0,proofId}` e tempo real inteiro. A inspeção devolve em `result` o contrato anterior completo, sem path da fonte.

O runner durável deve registrar intenção, `executionId`, fence, `resultRef` e reivindicação de lançamento **antes** de chamar o worker, e adquirir a capacidade global real. O executor não substitui esse journal nem uma fila distribuída. Seu limite de concorrência em memória é local à instância; a admissão global é obrigatória na composição operacional.

Recibos são arquivos exclusivos ligados à execução. Digest de objetos é canônico quanto à ordem das chaves JSON, preservando a ordem dos arrays; hashes de bytes não são alterados. A retomada consulta o resultado existente; não refaz a conversão. Um preparo completo pode concluir idempotentemente o commit pendente. Uma saída parcial, recibo ausente/corrompido, lançamento incerto ou encerramento não comprovado permanece `unknown`, sem relançamento nem liberação fictícia. Não se adota lock velho por idade ou PID.

Uma falha **conhecida antes do lançamento** é diferente de recibo ausente: o launcher vivo, que possui a criação exclusiva daquela tentativa, grava `launcher-terminal.json` com `not_started_proved`, estágio fechado e digest da requisição. Isso só ocorre antes de chamar o supervisor (compilador já encerrado/erro de configuração de cache, instância ocupada ou orçamento já esgotado), ou após erro real de CreateProcess sem PID nem evento de spawn. Não se deduz essa prova ao observar simplesmente que não há PID/recibo. A retomada valida binding e ausência de qualquer recibo nativo conflitante; pode encerrar o slot dessa tentativa como falha, sem matar processos nem repetir a conversão. O armazenamento ainda exige limpeza própria.

`termination` prova encerramento de execução, **não remoção de bytes**. A reserva de armazenamento permanece até limpeza separada comprovada. Hard kill pode deixar derivados parciais no `preparationRoot`; não são aceitos como finais nem removidos como se fossem desconhecidamente descartáveis. O worker só remove o snapshot conhecido de sua própria tentativa depois de comprovar término; arquivos extras/links impedem essa limpeza. Originais selados, outras empresas e derivados anteriores não são alvos.

## Prazo da coordenação e caminhos

Cópia selada, autorização, chamadas de banco e commit são awaits cooperativos do coordenador. Não foram transformados em operações de SO termináveis. O slot continua retido enquanto esses awaits não se encerram; incerteza permanece retida. Conversão e decodificação de cada saída usam o prazo restante sob a fronteira nativa. A integração deve executar essa coordenação dentro do executor separado, não dentro da API de 512 MiB.

No Windows, a inspeção usa como cwd o diretório controlado da tentativa do executor, e passa o caminho privado completo do arquivo como argumento. Isso permite arquivos privados maiores que 300 caracteres sem tornar uma pasta longa o cwd de `CreateProcess`. O teste não encurta o caminho privado e não cria cópia extra do derivado para esconder a limitação. Erros de spawn são registrados antes do acesso às pipes, evitando erro assíncrono não tratado.

A inspeção cria um único snapshot adicional da fonte. O preparo mantém o orçamento preexistente de fonte e derivados; as admissões podem reservar conservadoramente mais. Nenhum limite de arquivo, pixels, duração, memória, prazo ou cota foi aumentado para satisfazer testes.

Faixa sintética só entra pelo resolver confiável, como `synthetic:true`, produzindo `commercialReady:false`. `syntheticTests:true` no executor habilita apenas a operação fechada de falhas físicas `test_tree`; não é necessário para decodificar mídia sintética. Não confundir esse recurso de teste com autorização comercial.

## Provas físicas locais e limites pendentes

Os testes permanentes `calendar-import-media-process-executor.test.js` cobrem ambiente sem segredo, recibo perdido/reabertura sem duplicação, prazo com descendente, morte real do coordenador, limite de saída, ausência de recibo, PNG real, source hash/dono rejeitados antes do launch, JPEG final decodificado em outro processo, MP4 original/muted e foto com música sintética real de 15 s. Os testes de integração operacional acrescentam PostgreSQL físico e journal real; não se somam essas provas a contagens históricas de testes em memória.

As execuções intermediárias que falharam em `spawn UNKNOWN` foram preservadas. A correção de publicação do executável foi seguida de oito compilações novas e launches imediatos, sem qualquer retry automático; testes de PE inválido e cache inválido verificam o encerramento conhecido sem launch. Isso não transforma outro futuro erro de plataforma em sucesso nem permite reabrir uma execução incerta.

Medições focais desta máquina Windows x64/Node 24.15/FFmpeg 7.1 (não são orçamento de Render): PNG→JPEG cerca de 111 MB de pico comprometido da árvore e 0,8 CPU-s; vídeo sintético de 3 s cerca de 345–351 MB e 4–5 CPU-s; foto + faixa sintética de 15 s cerca de 403–408 MB e 18–20 CPU-s em execução isolada. O supervisor registra pico agregado comprometido do Job Object, não RSS, e CPU agregada de processos, não duração de parede. O pico observado não substitui teste no limite de 60 s nem garante custo mensal.

Uma prova focal de 3 s detectou perda de 1/30 s com `fps` depois de `scale`; a normalização de tempo agora ocorre antes dos filtros geométricos. O arquivo muted real preserva os 3 s. O limite do publicador não foi flexibilizado: a tolerância privada de validação não equivale à aceitação do provedor.

**Linux/Render: fail-closed.** O factory informa `supported:false` e rejeita launch fora de Windows; os constructors dos workers recusam essa configuração antes de montar um fluxo que possa reservar trabalho. Não se apresenta um grupo POSIX simples como equivalente comprovado de Job Object. Faltam o supervisor Linux com encerramento e evidência de toda a árvore, controles de memória/processos do ambiente e sua execução física no runtime candidato. Nenhuma implantação, SDK remoto ou transporte de bytes da API ao Workflow foi ativado.

Para o candidato de execução separada, a ligação necessária é: dispatcher durável → adaptador de transporte privado de fonte/seleção fechada → entrypoint supervisionado equivalente → recibo completo + arquivos derivados privados → commit/reconciliação existente. O entrypoint e os contratos fechados estão neste módulo; faltam o adaptador Linux e a ligação do transporte/Workflow real. Não é correto declarar piloto Render pronto, nem mover esse filho para a API Starter de 512 MiB, que continuaria compartilhando seu limite de memória.
