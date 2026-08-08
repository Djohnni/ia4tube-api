# Social 3A-0P-H: harness físico local

Este checkpoint controla uma execução local, explícita e descartável do PostgreSQL 18.4. Importar, testar ou executar `--preflight-only` não baixa pacotes, não inicia PostgreSQL e não acessa rede, Render, staging ou produção; somente a entrada física com a aprovação exata alcança a inicialização local.

## Causa delimitada do timeout anterior

O PostgreSQL 18.4 chegou a registrar prontidão em `127.0.0.1:64995`, sem `FATAL`, `ERROR` ou `PANIC`. O comando controlador permaneceu, porém, dentro de uma execução única com limite total de dez minutos e expirou antes de produzir evidência do bootstrap das roles, da custódia DPAPI ou do início dos gates. Além disso, o ambiente do subprocesso do CLI de migrations não continha a autorização local de loopback. Isso caracteriza falha de orquestração do harness, não falha comprovada do produto nem do PostgreSQL.

O novo controlador usa fases e limites independentes. Um timeout identifica a fase exata e solicita o encerramento da árvore de processos. O `cleanup` ocorre quando a operação anterior assentou; caso ela permaneça ativa após o encerramento, a remoção é bloqueada de forma fail-closed. Não existe repetição automática.

## Evidência local de firewall: `loopback_nonmutation_v1`

O caminho anterior de snapshot abrangente foi encerrado com a classificação `firewall_snapshot_instrumentation_unreliable`. Ele não é preservado no caminho executável e não deve ser recriado. Para este gate descartável, o contrato passa a ser `FIREWALL_EVIDENCE_MODE=loopback_nonmutation_v1`.

O contrato vale exclusivamente para o checkpoint Social 3A-0P em Windows, sob usuário não elevado, cluster temporário e listener exato em `127.0.0.1`. Ele não autoriza staging, produção, Render, serviço permanente, listener externo nem configuração TLS do produto.

Antes de iniciar o PostgreSQL, o preflight:

- verifica, contra um catálogo explícito e fail-closed, que os fontes locais alcançáveis pelo run não contêm comandos conhecidos de mutação de firewall, elevação/UAC, tarefa agendada, serviço ou usuário local; essa verificação não é apresentada como prova universal contra código arbitrariamente ofuscado;
- confirma usuário resolvido, processo não elevado e integridade não administrativa sem registrar usuário ou SID;
- consulta uma única vez e em lote `Get-NetFirewallProfile`, `Get-NetFirewallSetting` e `Get-NetFirewallRule`, sempre com `-PolicyStore ActiveStore`;
- não consulta filtros associados, não usa `Show-NetFirewallRule` e não executa pipeline de cmdlet por regra;
- canonicaliza e calcula SHA-256 separado para perfis, configurações globais e metadados básicos das regras, além de um hash agregado.
- exige no mínimo 7 GiB livres antes de qualquer extração ou inicialização do PostgreSQL;
- enumera os sockets TCP e TCPv6 da porta reservada pela ferramenta nativa somente leitura, sem depender de texto de estado localizado e sem filtrar previamente PID ou endereço.

Depois do cleanup, a mesma leitura leve é repetida. A divergência de qualquer componente reprova o gate e registra somente o nome canônico do componente divergente; o harness nunca tenta corrigir a política do firewall.

A limitação é obrigatória e explícita: `fullFirewallFilterSnapshotProved=false`. A evidência detecta mudanças nos três componentes observados, mas não cobre filtros de endereço, porta, interface ou tipo de interface e não representa igualdade byte a byte da política. A ausência de exposição é provada por vínculo de loopback, com `externalExposurePreventedByLoopbackBinding=true`, e não por abertura ou modificação de regra de firewall.

## Fases e limites padrão

```text
preflight (30 s)
  -> validate-package (2 min)
  -> extract-package (15 min)
  -> initialize-cluster (15 min)
  -> start-cluster (2 min)
  -> wait-for-readiness (2 min; sondagem interna até 90 s)
  -> bootstrap-roles (2 min)
  -> establish-dpapi-custody (1 min)
  -> run-migration-gate (20 min)
  -> run-rls-gate (15 min)
  -> run-concurrency-gate (15 min)
  -> run-vault-gate (15 min)
  -> run-backup-restore-gate (30 min)
  -> collect-sanitized-evidence (1 min)
  -> cleanup (10 min)
```

Cada fase registra início, término, duração, status e código sanitizado. Operações longas emitem heartbeat sem URL, senha, token, state cru, chave ou ciphertext.

## Entrada confiável e adapters

O controlador em `scripts/social-3a0p-local-physical-harness.js` é injetável para que os testes usem adapters sintéticos e nenhuma operação externa. A execução exige simultaneamente:

- aprovação exata `RUN_SOCIAL_3A0P_LOCAL_POSTGRES_18_4`;
- descritor de pacote local com versão `18.4`, caminho absoluto e SHA-256 esperado;
- alvo exato `127.0.0.1` em porta não privilegiada;
- todos os adapters das fases, das probes de readiness e do encerramento da árvore de processos.

A entrada física definitiva deste checkpoint é `scripts/social-3a0p-local-windows-entry.js`. Ela aceita somente quatro pares nome/valor: aprovação, caminho absoluto local do pacote, SHA-256 e porta. A única flag adicional aceita é `--preflight-only`, que executa exclusivamente preflight e cleanup na mesma entrada, sem ledger persistente, extração, `initdb`, startup, migration ou conexão PostgreSQL. Esse modo confirma a remoção da raiz e a ausência de um ledger incremental antes de retornar e publica somente evidência sanitizada no stdout. Não aceita injeção de adapter, dependência, executável, argumento adicional ou ambiente. O pacote é validado antes da criação da raiz, copiado com exclusividade para uma raiz pertencente ao run e validado novamente pelo mesmo SHA-256.

Antes da extração, `validate-package` lê diretamente o EOCD, o diretório central e os cabeçalhos locais do ZIP, sem extrair dados e sem transportar nomes por uma saída limitada de subprocesso. O inventário cruza quantidade, offsets, tamanhos, método, flags, data descriptors, sistema criador, atributos externos e modo Unix. Cada nome é validado contra caminho absoluto, traversal, ADS, nomes reservados do Windows, colisão canônica, componentes terminados em ponto/espaço e caracteres de controle. Somente arquivo regular e diretório com marcador coerente com o extrator são normalizados; metadados DOS/FAT sem modo Unix podem ser aceitos como `ambiguous_but_resolvable` apenas quando a barra final resolve o tipo sem conflito. Links simbólicos, hardlinks, reparse points, volume labels, devices, sockets, FIFOs, tipo desconhecido, ZIP64, multidisk, criptografia e inconsistências de tamanho ou offset são recusados antes de qualquer escrita.

A extração definitiva não usa `tar -xf`. Um helper PowerShell local abre o ZIP uma única vez com compartilhamento somente de leitura, impedindo escrita ou substituição concorrente durante toda a operação. Nesse mesmo `FileStream`, ele calcula o SHA-256 aprovado, enumera e valida todas as entradas e só depois extrai exatamente esses bytes com `CreateNew`. Os caminhos do pacote precisam ser ASCII canônico; o inventário é limitado a 100.000 entradas, 2 GiB por entrada e 4 GiB descomprimidos no total, com recusa adicional de razão de compressão superior a 1.000:1 para entradas maiores que 64 MiB. A cópia conta os bytes efetivamente produzidos, aplica novamente os limites durante a escrita, exige igualdade com o tamanho inventariado e elimina o arquivo parcial em qualquer divergência. Cada diretório é novamente verificado contra reparse points. A inspeção da árvore após a extração permanece como defesa adicional.

O helper é o arquivo fixo e versionado do próprio checkpoint, invocado por caminho absoluto, `shell=false`, sem interpolação e sem argumentos secretos. Como a política local bloqueia scripts `.ps1`, somente esse subprocesso recebe `-ExecutionPolicy Bypass`; nenhuma política persistente do Windows é alterada.

Os executáveis `powershell.exe`, `tar.exe`, `taskkill.exe` e `cmd.exe` são resolvidos por `\\?\GLOBALROOT\SystemRoot`, não por `SystemRoot`, `WINDIR`, `PATH` ou `ComSpec` fornecidos pelo chamador. O ambiente Windows propagado é reconstruído a partir dessa origem do kernel. Adapters de download, instalação ou rede são recusados; o harness não baixa nada.

## Ambiente permitido a subprocessos e loopback

O ambiente do subprocesso é construído por allowlist; o ambiente completo do processo pai não é copiado. Para os subprocessos do gate físico, somente os nomes necessários a cada comando e um conjunto mínimo do sistema podem ser propagados.

Allowlist mínima do sistema: `ComSpec`, `PATH`, `PATHEXT`, `SystemDrive`, `SystemRoot`, `TEMP`, `TMP` e `WINDIR`.

Allowlist do CLI de migrations: `NODE_ENV`, `SOCIAL_MIGRATIONS_DATABASE_URL`, `SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT`, `SOCIAL_MIGRATIONS_EXPECTED_LOGIN`, `SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN`, `SOCIAL_DATABASE_OWNER_ROLE`, `SOCIAL_DATABASE_MIGRATOR_ROLE`, `SOCIAL_MIGRATION_ENVIRONMENT`, `SOCIAL_MIGRATION_APPROVED`, `SOCIAL_MIGRATION_PRODUCTION_APPROVAL`, `SOCIAL_MIGRATION_EXPECTED_ENVIRONMENT_ID`, `SOCIAL_MIGRATION_TARGET_FINGERPRINT` e `SOCIAL_DATABASE_ALLOW_INSECURE_LOCALHOST`.

O probe de startup recebe somente sua configuração sintética explícita: porta e diretório descartáveis, URLs públicas `.invalid`, gates sociais e FCM bloqueados, material sintético de sessão/cofre/identidade e as variáveis estritamente necessárias ao PostgreSQL local. Credenciais de pagamento, OpenAI, runners e Google permanecem vazias.

`SOCIAL_DATABASE_ALLOW_INSECURE_LOCALHOST=true` é acrescentada ao subprocesso do CLI de migrations e ao probe de startup somente quando `configuration.mode === "loopback"`. O valor não é propagado para modo externo. O host continua restrito a loopback e nenhuma exceção genérica de TLS ou rede foi introduzida no produto.

Para `psql`, `pg_dump` e `pg_restore`, a fábrica exige aprovação e marcador do run, alvo `127.0.0.1`, porta reservada, banco e login allowlisted e argumentos exatos por executável. Argumentos capazes de sobrescrever host, porta, usuário ou banco são recusados antes do spawn. O plano original precisa provar `verify-full`; somente depois desse vínculo o wrapper local converte o transporte do processo descartável para `PGSSLMODE=disable`, compatível com o servidor local configurado com `ssl=off`. O plano offline exato `pg_restore --list <bundle-owned>` não recebe variáveis `PG*`.

## Readiness

O log “pronto” não aprova o servidor. A ordem obrigatória é:

1. processo PostgreSQL ativo;
2. exatamente um listener em `127.0.0.1` e na porta reservada;
3. `pg_isready` aprovado;
4. conexão administrativa sintética aprovada;
5. `SELECT 1` retornando `1`;
6. versão do servidor exatamente `18.4`;
7. `SHOW listen_addresses` retornando exatamente `127.0.0.1`.

Processo encerrado, listener externo, listener adicional, porta adicional, versão diferente ou qualquer prova ausente falha fechado. O adapter enumera por `netstat.exe` a união de todos os sockets TCP/TCPv6 da porta reservada e todos os sockets pertencentes ao PID comprovado do postmaster, sem filtrar previamente endereço e sem depender das palavras localizadas de estado. Uma linha é classificada como listener pelo endpoint remoto nulo do protocolo. O validador central exige exatamente uma linha relevante, pertencente ao postmaster comprovado, em `127.0.0.1:<porta>`.

O adapter de readiness fornece o PID e também vincula a identidade imutável do postmaster ao caminho exato de `postgres.exe` dentro da raiz owned e à data de criação do processo. A identidade é verificada novamente antes de readiness, parada ou terminação forçada. Reutilização do mesmo PID por outro processo nunca autoriza `taskkill`; nesse caso o cleanup falha fechado e preserva a raiz para diagnóstico.

Os probes continuam independentes para vida do processo, listeners, `pg_isready` e abertura da sessão administrativa. A sessão expõe separadamente `SELECT 1`, versão e fechamento; assim a última operação bloqueada fica identificável. Um início ambíguo reconcilia `postmaster.pid`, prova a identidade, tenta `pg_ctl stop` e só confirma compensação quando processo e listener desapareceram.

## Roles e custódia DPAPI

O bootstrap físico é idempotente e cria somente provisionador, migration e runtime sintéticos, com autenticação `SCRAM-SHA-256`. Runtime não pode ter `SUPERUSER`, `BYPASSRLS`, `CREATEDB`, `CREATEROLE` nem privilégios de migration; migration não pode ter privilégios de provisionamento. Como os logins são globais ao cluster e `CONNECT` é específico por banco, cada banco descartável concede apenas o `CONNECT` necessário e repete a auditoria definitiva duas vezes.

A custódia DPAPI tem fase própria. Material sintético é protegido, o round-trip é comparado apenas em memória e todos os buffers e a custódia temporária são eliminados em `finally`. Evidência contém somente booleanos.

## Rollback forward-only

Não existe nem será inventada uma migration `down` para a 0004.

- **Rollback transacional:** começar em 0001–0003, aplicar uma variante controlada de 0004 que falha dentro da transação, comprovar rollback integral e comparar com o perfil canônico 0001–0003.
- **Rollback operacional:** gerar bundle fechado do perfil 0001–0003, aplicar 0004 na origem, restaurar o bundle em outro banco descartável, validar schema/RLS/FORCE RLS/índices/constraints e remover esse banco.
- **Reaplicação:** aplicar 0004 no ambiente apropriado, validar checksum e perfil 0001–0004 e comprovar que objetos não sociais não mudaram.

## Backup e restauração no Windows

O runner reutiliza o mecanismo definitivo para os perfis 0001–0003 e 0001–0004. Ele produz tamanho, SHA-256, ledger, inventários de tabelas e RLS; restaura em banco descartável separado; executa os verificadores definitivos de isolamento runtime, cofre e compatibilidade 2A; valida o perfil restaurado; recusa manifesto adulterado e perfil cruzado pelos códigos canônicos esperados; fecha todas as sessões verificadoras; e somente então remove integralmente o destino criado pelo próprio run.

No Windows, o fsync do arquivo precisa ser comprovado fisicamente. Fsync definitivo do diretório e proteção forte equivalente a `O_NOFOLLOW` não são declarados aprovados: continuam pendentes no checkpoint Linux. O harness não simula essas garantias.

## Cleanup e evidências

### Contrato H2 incremental e fail-closed

O H2 acrescenta um ledger sanitizado que nasce antes do `preflight` da execução física completa. Cada fase grava, em ordem, início, término, duração, status, código canônico, métricas e resíduos. Uma falha de persistência bloqueia a próxima operação física; o cleanup real continua sendo tentado. Falhas anteriores a `collect-sanitized-evidence` permanecem registradas. A evidência incremental nunca equivale a uma aprovação física. O modo `--preflight-only` deliberadamente não cria esse ledger: ele retorna sua prova sanitizada em memória/stdout e exige zero raiz ou ledger residual.

O encerramento de cada fase é persistido somente pelo resultado autoritativo do controlador, depois da resolução de timeout, abort e encerramento da árvore de processos. Assim, uma operação que assenta depois do abort pode contribuir apenas com métricas parciais sanitizadas; ela não pode sobrescrever `preflight_timeout`, `cleanup_timeout` ou outro código final com um resultado interno tardio.

O ledger exige a identidade exata do commit do harness e do commit-base do produto. Ele fica em um diretório irmão da raiz descartável, com herança NTFS bloqueada e regras explícitas para o usuário atual, SYSTEM e Administradores. Componentes reparse são recusados, cada revisão é criada com exclusividade, recebe flush e ACL protegida e é promovida atomicamente. A primeira promoção usa rename no mesmo diretório. Revisões existentes usam `File.Replace` do Windows com um caminho de backup explícito, não vazio, exclusivo do run e no mesmo diretório e volume. O backup da revisão anterior permanece protegido até a releitura e a validação de estrutura, tamanho, ACL e SHA-256 do novo ledger; somente então a transação é finalizada e o backup é removido. Qualquer falha posterior à preparação e anterior à finalização aciona rollback atômico, preserva temporariamente o candidato rejeitado, restaura e revalida a revisão anterior e só depois remove o candidato. Estado ambíguo ou falha de rollback preserva os artefatos de recuperação e encerra fail-closed. O artefato canônico de sucesso também fica dentro dessa raiz protegida. Os auxiliares que persistem o término das fases usam como diretório de trabalho e TEMP/TMP o pai controlado estável, nunca a raiz descartável que o próprio cleanup remove; assim a revisão final do cleanup continua gravável sem reabrir nem enfraquecer a raiz apagada.

A divergência de orquestração do H2.1 era uma segunda auditoria multipath depois de `replaceFileAtomic()`, embora o adapter já tivesse concluído a auditoria nativa e a validação do target e do backup antes de retornar. Essa repetição foi removida sem alterar `File.Replace`, o adapter nativo ou a política de ACL. O teste de conformidade preserva a ordem replace, auditoria, validação, rollback, nova auditoria e cleanup. A prova física isolada do ledger foi aprovada uma única vez com revisões 1, 2 e 3 monotônicas, rollback real restaurando tamanho e SHA-256 anteriores, três regras ACL explícitas, zero herança, zero `Deny`, zero temporários/backups residuais e remoção integral da raiz descartável. Essa aprovação cobre somente a persistência NTFS do ledger; não executa nem aprova o gate PostgreSQL.

As evidências de backup não são agregadas. Os perfis `0001-0003` e `0001-0004` conservam separadamente tamanho, SHA-256, número de tabelas, políticas RLS e aprovação da restauração isolada.

Todos os pools criados pelo harness e pelos planos físicos são instrumentados com limite observado de três conexões por pool. O ledger registra máximo configurado, pico total, pico ativo, pico ocioso, pico em espera e aquisições. PIDs, categorias de roles sintéticas e `application_name` são registrados na aquisição do pool e comparados de forma independente com todos os `client backend` do cluster. Role inesperada, `idle in transaction`, PID órfão, sessão sem identidade owned e processo residual falham fechado.

O gate exige pelo menos 7 GiB livres e registra espaço livre inicial, mínimo, antes/depois da extração, depois da remoção da cópia owned do pacote e ao final. `initdb` exige data checksums e o resultado é confirmado por `SHOW data_checksums`. A raiz temporária recebe auditoria sanitizada de proprietário, herança e regras NTFS. O firewall não é inventariado integralmente: somente contagens e SHA-256 dos perfis, configurações globais e metadados básicos das regras entram na evidência. O cleanup repete a prova global de zero processo PostgreSQL, zero serviço PostgreSQL instalado (inclusive parado e também identificado pelo executável associado) e zero listener na porta reservada, além de comparar os hashes leves antes/depois.

A entrada confiável aceita exclusivamente o build oficial futuro `postgresql-18.4-2-windows-x64-binaries.zip` e continua exigindo que o operador forneça o SHA-256 real de 64 hexadecimais; nenhum hash não comprovado está hardcoded. A origem passada por `--package-path` é externa e nunca é removida; somente a cópia criada dentro da raiz owned pode ser apagada. A origem externa é reaberta e revalidada pelo mesmo SHA-256 antes da promoção da evidência canônica. O contrato injetável também cobre separadamente um ZIP criado pelo próprio run: nesse caso ele precisa estar dentro da raiz owned e sua remoção precisa ser comprovada. Provas de preservação externa e de remoção owned não são intercambiáveis.

O código não baixa PostgreSQL nem antecipa resultado físico. A extração e o startup só são alcançados pela execução completa com a aprovação exata; o modo `--preflight-only` é estruturalmente incapaz de alcançá-los.

`cleanup` roda em sucesso, falha, exceção e timeout depois que a operação anterior assentou. Se uma operação continuar sem assentar mesmo após aborto e encerramento confirmado da árvore, a remoção é bloqueada de forma fail-closed para não apagar recursos ainda em uso; o relatório registra essa exceção em vez de alegar resíduos zero. O cleanup só pode operar na raiz temporária pertencente ao run atual, não segue junctions/reparse points, encerra descendentes comprovadamente pertencentes ao run e remove cluster, bancos descartáveis, roles sintéticas aplicáveis, custódias, helpers e pacote extraído. Falha de criação de banco é reconciliada por identidade; banco preexistente ou sem prova nunca é adotado. Custódia DPAPI parcial é eliminada. Firewall, serviços Windows, Git e evidências sanitizadas ficam intactos.

A coleta grava primeiro somente um artefato `pending_cleanup`, marcado explicitamente com `physicalExecution=false`. O arquivo canônico de evidência ainda não existe nessa fase. O cleanup apenas confirma encerramento de processos, fechamento de pools, eliminação de materiais, remoção da raiz pertencente ao run e preservação do pending não aprovador.

Somente depois que o orquestrador fecha e valida o relatório das quinze fases com `cleanup` aprovado, um finalizador síncrono e não temporizado constrói o documento canônico com esse relatório fechado. Ele grava e relê o arquivo de preparação, valida o SHA-256, remove o pending, promove por rename atômico e relê o caminho final. Também comprova que pending e finalizing desapareceram. Falha anterior à coleta ou falha/timeout do cleanup nunca chama o finalizador e não cria evidência física aprovada.

O relatório final admite apenas fase, status, duração, códigos, contagens, tamanhos, hashes, métricas, gates canônicos e inventário de limpeza. Segredos, URLs completas, credenciais, SQL sensível e dados reais são recusados.

## Gate físico autorizado

O fluxo autorizado primeiro executa a própria entrada com `--preflight-only`. Somente se modo, hashes leves, pacote, espaço, PostgreSQL zero, porta livre e resíduos zero forem comprovados, a mesma entrada é executada uma única vez sem essa flag. Qualquer mudança de build, pacote ou SHA-256 continua exigindo decisão explícita; o harness não adota automaticamente um valor diferente.

```powershell
node scripts\social-3a0p-local-windows-entry.js --approval RUN_SOCIAL_3A0P_LOCAL_POSTGRES_18_4 --package-path "<PACOTE_POSTGRESQL_18_4_ABSOLUTO>" --expected-sha256 02e239529ed7833d169f98d915d3feffe0813264b08b3ae353e78e8b9c97e1a6 --port 64995 --preflight-only

node scripts\social-3a0p-local-windows-entry.js --approval RUN_SOCIAL_3A0P_LOCAL_POSTGRES_18_4 --package-path "<PACOTE_POSTGRESQL_18_4_ABSOLUTO>" --expected-sha256 02e239529ed7833d169f98d915d3feffe0813264b08b3ae353e78e8b9c97e1a6 --port 64995
```

A execução física deverá completar as quinze fases: migration, RLS, concorrência/OAuth sintético/idempotência, cofre e backup/restauração Windows. As duas provas de durabilidade exclusivas de Linux — fsync do diretório do bundle e proteção forte equivalente a `O_NOFOLLOW` — permanecerão para checkpoint separado.

Antes da execução autorizada descrita nesta seção, somente a persistência NTFS do ledger possuía prova física isolada. O resultado real das quinze fases deve vir exclusivamente da evidência canônica produzida pelo run; este documento não antecipa aprovação.
