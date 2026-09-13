# iA4tube — retenção e configuração candidatas do piloto

13/09/2026. Implementação e provas locais, sem leitura/alteração remota. Não se trata de uma política de exclusão já autorizada.

## Política efetivamente segura para o piloto curto

`retain_all` é o padrão. Não há cron, timer, rota pública de limpeza ou ativação automática. O limite de reservas é 3 GiB global/empresa, com margem e conferência física já implementadas na admissão. Ao atingir o limite, novos envios/preparos são recusados. Conteúdo existente não é apagado para conseguir prosseguir. Isso é viável para um piloto curto **enquanto houver capacidade**, não assegura um mês de vídeos diários nem armazenamento ilimitado.

| Classe observada | Ação neste candidato | Decisão futura de uso continuado |
|---|---|---|
| Upload incompleto | Manter; cancelamento normal já existente continua sendo a rota que comprova término e remoção das partes | Proposta: oferecer cancelamento de uploads sem atividade após 24 h, nunca durante escrita/lease/resultado incerto; prazo ainda não aprovado nem agendado |
| Original ainda necessário | Manter para rever, editar formato/música e gerar nova revisão | Preservar enquanto existir qualquer referência; eventual descarte do original exige política de edição comunicada/aceita |
| Derivado em preparo | Manter processo/reserva/snapshot enquanto não houver prova de término e referência resolvida | Prazo de tarefa não substitui prova de encerramento nem é prazo de exclusão |
| Conteúdo agendado, pausado, cancelado ou no histórico | Manter referência e arquivo; cancelar publicação não significa excluir mídia | Separar exclusão do agendamento de descarte do arquivo e da possibilidade de rever/reutilizar |
| Resultado incerto | Manter fontes, derivados, recibos e reservas aplicáveis; não repetir postagem | Reconciliação concreta antes de qualquer limpeza; nenhum TTL libera esse caso |
| Arquivo sem referência ativa | Arquivo desconhecido continua preservado; só o marcador exato de um multipart já abortado tem coletor implementado | Proposta: limpar apenas marcadores terminais após 7 dias. Originais/derivados sem uso poderiam ter 30 dias, mas essa segunda política NÃO foi implementada/ativada e afetaria edição/histórico |

Os números 24 h, 7 dias e 30 dias são propostas para escolha do proprietário, não valores de configuração ligados. O piloto curto não depende de aceitar exclusão: pode conservar tudo e parar novas admissões no limite.

## Coletor realmente implementado, escopo deliberadamente estreito

`retention-collector.js` aceita `enabled=false` por padrão e política `retain_all`. O modo opt-in `terminal_upload_tombstones` exige `minimumAgeMs` explícito e uma referência de aprovação. Não oferece opção para apagar mídias prontas, arquivos antigos, pastas de empresa, DATA_DIR, resultados ou recibos de execução.

Para remover **somente `identity.json` e sua pasta vazia** de um upload cancelado, ele comprova:

1. Roles/schema dos stores PostgreSQL reais; banco do proprietário pelo RLS. Capacidade usa pool separado restrito e verifica seu próprio schema.
2. Upload `cancelled`, lease nula, disco `aborted`, `cleanupVerified=true`, nenhuma parte, nenhum outbox, revisão, preparo, execução, origem copiada ou item do calendário/histórico referenciado. Um valor informado pelo cliente não substitui esses registros.
3. Reserva exata de armazenamento em `storage_cancel_requested` ou já `storage_released`, vinculada por empresa/usuário/asset/hash/tamanho. Nenhuma reserva de tarefa/running é tratada como armazenamento descartável.
4. Raiz explícita privada, diretórios/arquivo sem symlink, arquivo regular com uma ligação, identidade/hash/tamanho correspondentes ao registro. Um arquivo extra, lock ou diretório inesperado bloqueia a operação.
5. Sob os mesmos locks da aplicação — `calendar:<company>` e depois `calendar-import:<company>` — grava primeiro uma intenção irrevogável no namespace JSON `retention`. Nada é apagado antes do commit. Uma confirmação perdida não autoriza adivinhar o resultado.
6. Nova referência do calendário e mutação/reativação do asset pelo store normal são recusadas pelo fence persistido. Se a referência venceu o lock primeiro, o coletor não cria o fence nem apaga. Essa proteção também abrange origem de cópia de arte.
7. Remove o único arquivo por `unlink` e a pasta por `rmdir` **não recursivo**; sem chmod ou limpeza geral. Verifica ausência, persiste prova sanitizada, só então libera a reserva exata. Falha/ambiguidade mantém a reserva. Uma nova chamada observa a mesma intenção/prova, sem reativar o asset.

O tombstone JSON permanece no banco para impedir reutilização. A contagem de arquivos de mídia removidos é zero; o coletor não deve ser divulgado como um garbage collector completo de vídeos. Permissões do usuário do serviço e a confiança no próprio host ainda são necessárias: este mecanismo não afirma resistir a um administrador malicioso que substitua arquivos fora dos fluxos do sistema.

Nenhuma limpeza dessa classe foi autorizada em produção. As provas apagam apenas marcadores e pastas criados dentro da fixture sintética efêmera; preservam os demais arquivos sintéticos nos casos de bloqueio até o teardown estritamente delimitado da fixture.

## Configuração exata candidata, sem ligar flags

`createMediaPilotCandidate()` em `pilot-configuration.js` cria uma configuração profundamente congelada, **desabilitada**, sem ler ambiente, conectar banco ou criar processo. `inspectMediaPilotReadiness()` retorna pendências, não uma capacidade de ativação. `enabled:true`, troca da política/gates ou scripts de startup são recusados nessa interface.

- Serviço: `ia4tube-api`, `srv-d8708kd7vvec73ap1p6g`; origem `https://ia4tube-api.onrender.com`.
- Banco esperado: `ia4tube-social-production`. ID do disco **não presumido**; `/var/data` e 10 GB são evidência histórica, precisam ser confrontados com o destino ao preparar remotamente.
- Novas raízes privadas propostas: `/var/data/private/calendar-media/uploads`, `/var/data/private/calendar-media/prepared`, `/var/data/private/calendar-media/music`. Só criar após conferir o volume real e autorização; não mover/apagar raízes anteriores.
- Um par usuário/empresa existente; valores permanecem `null`/lista vazia até resolução protegida no destino, sem usuário novo ou alteração de empresa.
- Workflow Flex separado, mesma região **a confirmar**, slug real no formato `<workflow-slug>/prepareCalendarMedia` **a confirmar**. Disco não compartilhado. A chave dedicada da ligação privada não é segredo Instagram nem credencial de banco.
- Um trabalho global; 64 na fila; quatro na fila por empresa; 120 trabalhos/mês; três horas lógicas/mês; 180 s por tarefa; retries de Workflow `0`; partes de 5 MiB, transferência de 60 s, duas simultâneas.
- Windows tem limite de quatro processos. Linux propõe 64 tarefas incluindo threads, 1 CPU e 512 MiB sob cgroup; são controles diferentes, não a mesma métrica. A aceitação física e capacidade correspondente do Render são verificações separadas.
- Manter `SOCIAL_EXTERNAL_CONNECTION_ENABLED=false` e `SOCIAL_EXTERNAL_PUBLICATION_ENABLED=false` durante preparação/implantação futura. Isso é uma condição, não escrita no Render ou alteração do estado atual feita aqui.
- `retain_all`, nenhuma expiração; nenhuma migration na inicialização.
- Não entregar segredo Instagram, DATABASE_URL, token Render ou comando livre ao conversor. Credenciais operacionais futuras são configuradas por meio protegido e fora de Git/logs/argumentos persistidos do Workflow.
- A trilha definitiva é arquivo Flow do proprietário, com origem/condições verificadas e hash/catalogação. Nenhum catálogo externo ou integração automática Flow. Áudio sintético não fica apto a publicação comercial.

## Schema: sequência pendente, não executada remotamente

As extensões de calendário 0002–0004 são aditivas. O journal de execução, o journal Workflow e o fence de retenção cabem no JSON já limitado a 8 MiB de `import_upload_state`; nenhuma migration adicional foi criada para eles.

| Script candidato | SHA-256 | Papel consumidor |
|---|---|---|
| `0002_import_upload_state.up.sql` | `760098AD254CF7EBA37ADDF51A0B8EE353F5761D5C496C4F4556473848EEC296` | `ia4tube_social_runtime` restrito ao proprietário via RLS |
| `0003_global_media_capacity.up.sql` | `1EB343C3EFDF617A8D470D41F76B84A97D2EBAA09E093EE21559F536087B9BF9` | `ia4tube_media_capacity_runtime`, separado, somente ledger global |
| `0004_transfer_authorization_registry.up.sql` | `6AE1FC92BFB74CB463DD8F805236663FB6614DFD5434437437CA47369ABCA018` | `ia4tube_media_transfer_runtime`, separado, somente registro delimitado |

Procedimento para futura autorização única:

1. Confirmar destino de produção, SHA live, configuração, disco/espaço, região, bancos/papéis e status das três relações. O schema social 0001–0008 e calendário 0001 são pré-requisitos a **verificar**, não a reaplicar. Ausência/deriva de um pré-requisito interrompe a preparação.
2. Conferir bytes/hashes dos três scripts com o candidato revisado. Se uma relação já existir, verificar a estrutura/owner/RLS/policy/privilégios com os `verify()` atuais; não reaplicar nem usar DROP/CREATE por conveniência. Se apenas parte estiver aplicada, executar somente os scripts realmente pendentes na ordem.
3. Provisionar separadamente os dois papéis restritos, com credenciais novas apenas se necessárias e autorizadas. Nenhum papel tenant pode herdá-los; capacity/transfer não herdam acesso aos dados tenant nem owner. As migrations não geram senha/login automaticamente.
4. Aplicar os scripts pendentes individualmente pela sessão de migration autorizada, TLS verificado. Cada script tem sua transação. Não usar a credencial runtime para migrar, não rodar scripts sociais, não inserir seeds de testes.
5. Verificar `createImportUploadPostgresStore.verify()`, `createPostgresGlobalCapacityStore.verify()`, `createPostgresTransferRegistryStore.verify()` e `createCalendarStore.verify()` com os respectivos papéis. Comparar relações novas e políticas esperadas; confirmar calendário/itens originais preservados. Uma verificação que falhou não é compensada por relaxar RLS/TLS.
6. Só depois montar os recursos/factory do candidato e implantar o SHA revisado na autorização futura. Falha de readiness mantém importação/dispatch indisponíveis. Não encadear deploy ao término da migration nem migrar ao iniciar a API.

## Decisão financeira preservada

O candidato mantém teto absoluto adicional de US$5 como condição ainda não satisfeita. Três horas lógicas, tamanho/fila e bloqueio da aplicação **não** são teto da fatura. Nenhuma operação paga foi ativada. A configuração não possui um booleano externo que transforme estimativa em prova financeira. A autorização posterior precisa resolver essa condição expressamente; a análise financeira consolidada fica no relatório da missão.
