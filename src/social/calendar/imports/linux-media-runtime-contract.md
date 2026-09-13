# iA4tube — executor Linux candidato e prova sintética

Este adaptador preserva `run`, `observe`, `withExecutionScope`, `terminationProof` e as marcas internas do executor existente. Não muda a implementação Windows e não habilita produção. `supported=false`, `validationOnly=true` e `readyForProduction=false` são deliberados: instalar código não comprova o ambiente Render.

## Configuração de prova

```js
createMediaProcessExecutor({
  workingRoot, ffmpegPath, allowedRoots,
  linuxRuntime: {
    cgroupRoot: "/sys/fs/cgroup/ia4tube-media-synthetic-IDENTIFICADOR",
    launchMode: "sudo", // somente a prova CI efêmera expressamente configurada
    validationOnly: true
  }
});
```

`prepareRuntime()` precisa terminar antes de construir os process-workers. O probe cria e encerra um processo sintético com os mesmos mecanismos obrigatórios; somente então `hardTermination` passa a `true`. Não há fallback para grupo de processos ou para abandonar uma promessa. O fluxo `direct` exige que um lançador nativo privilegiado execute para um coordenador não privilegiado; o coordenador e os codecs nunca executam como uid zero. O `sudo` não é aplicado no Windows nem automaticamente no Render.

Requisitos físicos verificáveis: Linux com cgroup v2; subtree isolada root-owned sem escrita de grupo/outros; controladores cpu/memory/pids já disponíveis e habilitados nessa subtree; `cgroup.kill`, `memory.peak`, `pidfd_open`, namespaces PID/mount/network e `mount_setattr` recursivo. O supervisor precisa das capacidades para estabelecer essas proteções e trocar uid/gid. Ausência de qualquer uma bloqueia a prova; não se altera a hierarquia geral nem se remove proteção.

No executor padrão Ubuntu do GitHub, o coordenador/Node/PostgreSQL continua como o usuário runner. Apenas o supervisor C recebe `sudo -n`, explicitamente no ambiente efêmero. Um passo revisto cria `/sys/fs/cgroup/ia4tube-media-synthetic-<run>-<attempt>` e habilita apenas ali `+cpu +memory +pids`. O host tem de disponibilizar os controladores no pai. A limpeza remove somente subgrupos já vazios e essa subtree sintética; não afeta serviços de terceiros.

## Controles

- Clone do processo em namespaces privados PID/mount/network, bloqueado em pipe antes de qualquer codec. Atribuição ao cgroup ocorre antes da liberação.
- `memory.max=536870912`, `memory.swap.max=0`, `memory.oom.group=1`, `cpu.max="100000 100000"` e `pids.max=64`.
- **Linux conta tarefas, incluindo threads: 64 tarefas não são o limite Windows de quatro processos.** O limite duro Windows continua quatro processos; não se afirma equivalência desses números. O candidato Linux precisa de threads do Node, Sharp e FFmpeg. Não se usa uma amostragem de `/proc` como se fosse limite duro de quatro processos.
- Prazo máximo original de 180 segundos, incluindo preparo/validação/compilação antes do lançamento. Deadline nativo, perda do coordenador via pidfd, saída excessiva e interrupção disparam `cgroup.kill`. Liberação depende de `cgroup.events populated=0`, reap do processo e ausência do supervisor original, não do término da espera.
- O supervisor identifica o coordenador e a si pelo PID, start ticks e boot ID. Reuso de PID não implica mesma execução. Uma resposta perdida consulta a mesma execução; nenhum novo lançamento é produzido para receipt ausente/ambíguo.
- O codec entra com uid/gid do coordenador não-root, grupos suplementares vazios, capacidades zeradas, bounding set removido, `no_new_privs`, core dump desabilitado e rede sem interfaces externas. `/proc` expõe apenas a árvore privada.
- Todo o filesystem fica somente leitura no namespace do codec, exceto a pasta exata de tentativa e, para preparação, `outputRoot/companyId/assetId`, previamente criada/conferida pelo coordenador. A raiz compartilhada, as outras empresas e os outros arquivos de arte não são mounts graváveis. O request é um bind somente leitura próprio. `started.json`/`terminal.json` nativos ficam numa pasta irmã `.supervision`, fora de todas as áreas graváveis. O próprio código, compilador, supervisor e seus hashes permanecem somente leitura para o codec.
- Resultados/failure JSON do codec não são prova nativa. A prova nativa é escrita somente pelo supervisor, após encerramento físico. Arquivos finais continuam passando pelo inspector separado e pelo fluxo de integridade já existente.
- Compilação usa `/usr/bin/cc` resolvido para binário de sistema root-owned não gravável por grupo/outros, sem argumentos fornecidos pelo arquivo. Binário publicado sem bits de escrita, acompanhado de hash do código-fonte e do executável verificado ao reutilizar o cache.
- Saída combinada stdout/stderr é drenada e descartada; acima de 256 KiB encerra a árvore. Nenhum trecho bruto vira erro público ou log.

## Limites da afirmação

O filesystem somente leitura não é um jail de confidencialidade: o codec ainda pode ler arquivos que o uid já teria permissão para ler fora das pastas da tarefa. Portanto o processo deve existir em runtime de mídia separado, sem credenciais PostgreSQL/Instagram ou outros arquivos privados da API. Essa separação é parte do desenho do Workflow; o namespace não é desculpa para copiar todo o ambiente da API. Não se declara sandbox de exploração universal.

SIGKILL do supervisor antes da gravação do receipt mantém resultado desconhecido e reserva retida, mesmo que a morte do PID 1 privado elimine descendentes. Ausência de receipt não é prova nem autorização de relançamento. A interrupção do **coordenador**, coberta pela prova física, é observada pelo supervisor remanescente e produz resultado reconciliável. O desligamento completo da VM continua precisando de observação da execução/retorno pelo adaptador; não se fabrica prova de commit de bytes ausentes.

Métricas Linux são `memory.peak` do cgroup (memória contabilizada, inclusive cache elegível), `cpu.stat usage_usec`, pico **amostrado** de tarefas, eventos de recusa de tarefas e OOM, e bytes de saída descartados. Não são RSS Windows e não estimam a velocidade ou fatura do Render Flex.

## Testes

`calendar-import-media-linux-contract.test.js`: contrato independente da plataforma.

`calendar-import-media-process-linux-physical.test.js`: sem skips; prova real de namespaces, uid, recusa de alteração de request/receipts/código/cgroup, ambiente limpo, resposta perdida, deadline/descendente, morte do coordenador, segunda execução recusada, excesso de saída, memória, tarefas e capacidade ausente.

`calendar-import-media-linux-candidate-limit-physical.test.js`: vídeo sintético real de 60 segundos, 1080×1920 e 92–100 MiB, com upload, inspeção, preparação e inspeção final. Mantém 180 segundos/512 MiB/1 CPU; uma falha deve ser registrada, não corrigida relaxando o teste.

As provas PG, calendário, resultado perdido, espaço/reservas e publicador simulado existentes são reutilizadas somente nas partes pertinentes à mudança de sistema operacional. Nenhuma chamada Instagram real e nenhum gasto Render fazem parte dessa suíte.

## Referências primárias

- https://docs.kernel.org/admin-guide/cgroup-v2.html
- https://man7.org/linux/man-pages/man7/pid_namespaces.7.html
- https://man7.org/linux/man-pages/man2/pidfd_open.2.html

Essas referências definem mecanismos, não comprovam a disponibilidade deles no Render. A modalidade Flex continua dependente da conferência real dessas capacidades antes de qualquer ativação.
