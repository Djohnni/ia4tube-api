# Social 3A-0P-H: harness físico local

Este checkpoint prepara o controlador para uma execução futura e descartável do PostgreSQL 18.4. Ele não baixa pacotes, não inicia o PostgreSQL e não acessa rede, Render, staging ou produção.

## Causa delimitada do timeout anterior

O PostgreSQL 18.4 chegou a registrar prontidão em `127.0.0.1:64995`, sem `FATAL`, `ERROR` ou `PANIC`. O comando controlador permaneceu, porém, dentro de uma execução única com limite total de dez minutos e expirou antes de produzir evidência do bootstrap das roles, da custódia DPAPI ou do início dos gates. Além disso, o ambiente do subprocesso do CLI de migrations não continha a autorização local de loopback. Isso caracteriza falha de orquestração do harness, não falha comprovada do produto nem do PostgreSQL.

O novo controlador usa fases e limites independentes. Um timeout identifica a fase exata, solicita o encerramento da árvore de processos e sempre passa por `cleanup`; não existe repetição automática.

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

A entrada física definitiva deste checkpoint é `scripts/social-3a0p-local-windows-entry.js`. Ela aceita somente quatro campos: aprovação, caminho absoluto local do pacote, SHA-256 e porta. Não aceita injeção de adapter, dependência, executável, argumento adicional ou ambiente. O pacote é validado antes da criação da raiz, copiado com exclusividade para uma raiz pertencente ao run e validado novamente pelo mesmo SHA-256.

Antes da extração, o inventário simples e o inventário detalhado do `bsdtar` precisam ter a mesma quantidade de entradas. Cada nome é validado contra caminho absoluto, traversal, ADS, nomes reservados do Windows, componentes terminados em ponto/espaço e caracteres de controle; cada tipo precisa ser diretório ou arquivo regular. Links simbólicos, hardlinks, devices, sockets, FIFOs e tipos desconhecidos são recusados antes de qualquer escrita.

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
6. versão do servidor exatamente `18.4`.

Processo encerrado, listener externo, listener adicional, porta adicional, versão diferente ou qualquer prova ausente falha fechado. O adapter devolve todos os listeners pertencentes ao PID; nenhum listener é filtrado antes do validador central.

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

O H2 acrescenta um ledger sanitizado que nasce antes do `preflight`. Cada fase grava, em ordem, início, término, duração, status, código canônico, métricas e resíduos. Uma falha de persistência bloqueia a próxima operação física; o cleanup real continua sendo tentado. Falhas anteriores a `collect-sanitized-evidence` permanecem registradas. A evidência incremental nunca equivale a uma aprovação física.

O encerramento de cada fase é persistido somente pelo resultado autoritativo do controlador, depois da resolução de timeout, abort e encerramento da árvore de processos. Assim, uma operação que assenta depois do abort pode contribuir apenas com métricas parciais sanitizadas; ela não pode sobrescrever `preflight_timeout`, `cleanup_timeout` ou outro código final com um resultado interno tardio.

O ledger exige a identidade exata do commit do harness e do commit-base do produto. Ele fica em um diretório irmão da raiz descartável, com herança NTFS bloqueada e regras explícitas para o usuário atual, SYSTEM e Administradores. Componentes reparse são recusados, cada revisão é criada com exclusividade, recebe flush e ACL protegida e é promovida atomicamente. A primeira promoção usa rename no mesmo diretório. Revisões existentes usam `File.Replace` do Windows com um caminho de backup explícito, não vazio, exclusivo do run e no mesmo diretório e volume. O backup da revisão anterior permanece protegido até a releitura e a validação de estrutura, tamanho, ACL e SHA-256 do novo ledger; somente então a transação é finalizada e o backup é removido. Qualquer falha posterior à preparação e anterior à finalização aciona rollback atômico, preserva temporariamente o candidato rejeitado, restaura e revalida a revisão anterior e só depois remove o candidato. Estado ambíguo ou falha de rollback preserva os artefatos de recuperação e encerra fail-closed. O artefato canônico de sucesso também fica dentro dessa raiz protegida.

A divergência de orquestração do H2.1 era uma segunda auditoria multipath depois de `replaceFileAtomic()`, embora o adapter já tivesse concluído a auditoria nativa e a validação do target e do backup antes de retornar. Essa repetição foi removida sem alterar `File.Replace`, o adapter nativo ou a política de ACL. O teste de conformidade preserva a ordem replace, auditoria, validação, rollback, nova auditoria e cleanup. A prova física isolada do ledger foi aprovada uma única vez com revisões 1, 2 e 3 monotônicas, rollback real restaurando tamanho e SHA-256 anteriores, três regras ACL explícitas, zero herança, zero `Deny`, zero temporários/backups residuais e remoção integral da raiz descartável. Essa aprovação cobre somente a persistência NTFS do ledger; não executa nem aprova o gate PostgreSQL.

As evidências de backup não são agregadas. Os perfis `0001-0003` e `0001-0004` conservam separadamente tamanho, SHA-256, número de tabelas, políticas RLS e aprovação da restauração isolada.

Todos os pools criados pelo harness e pelos planos físicos são instrumentados com limite observado de três conexões por pool. O ledger registra máximo configurado, pico total, pico ativo, pico ocioso, pico em espera e aquisições. PIDs, categorias de roles sintéticas e `application_name` são registrados na aquisição do pool e comparados de forma independente com todos os `client backend` do cluster. Role inesperada, `idle in transaction`, PID órfão, sessão sem identidade owned e processo residual falham fechado.

O gate registra espaço livre inicial, mínimo, antes/depois da extração, depois da remoção da cópia owned do pacote e ao final. `initdb` exige data checksums e o resultado é confirmado por `SHOW data_checksums`. A raiz temporária recebe auditoria sanitizada de proprietário, herança e regras NTFS. O firewall é serializado de forma sanitizada incluindo perfis, regras, endereços, portas, protocolo, programa, pacote e serviço; somente contagens e SHA-256 anterior/posterior entram na evidência. O cleanup repete a prova global de zero processo PostgreSQL, zero serviço PostgreSQL ativo e zero listener na porta reservada.

A entrada confiável aceita exclusivamente o build oficial futuro `postgresql-18.4-2-windows-x64-binaries.zip` e continua exigindo que o operador forneça o SHA-256 real de 64 hexadecimais; nenhum hash não comprovado está hardcoded. A origem passada por `--package-path` é externa e nunca é removida; somente a cópia criada dentro da raiz owned pode ser apagada. A origem externa é reaberta e revalidada pelo mesmo SHA-256 antes da promoção da evidência canônica. O contrato injetável também cobre separadamente um ZIP criado pelo próprio run: nesse caso ele precisa estar dentro da raiz owned e sua remoção precisa ser comprovada. Provas de preservação externa e de remoção owned não são intercambiáveis.

Este checkpoint implementa apenas contrato e testes. Ele não baixa, extrai ou inicia PostgreSQL e não antecipa resultado do gate físico.

`cleanup` roda em sucesso, falha, exceção e timeout. Ele só pode operar na raiz temporária pertencente ao run atual, não segue junctions/reparse points, encerra descendentes comprovadamente pertencentes ao run e remove cluster, bancos descartáveis, roles sintéticas aplicáveis, custódias, helpers e pacote extraído. Falha de criação de banco é reconciliada por identidade; banco preexistente ou sem prova nunca é adotado. Custódia DPAPI parcial é eliminada. Firewall, serviços Windows, Git e evidências sanitizadas ficam intactos.

A coleta grava primeiro somente um artefato `pending_cleanup`, marcado explicitamente com `physicalExecution=false`. O arquivo canônico de evidência ainda não existe nessa fase. O cleanup apenas confirma encerramento de processos, fechamento de pools, eliminação de materiais, remoção da raiz pertencente ao run e preservação do pending não aprovador.

Somente depois que o orquestrador fecha e valida o relatório das quinze fases com `cleanup` aprovado, um finalizador síncrono e não temporizado constrói o documento canônico com esse relatório fechado. Ele grava e relê o arquivo de preparação, valida o SHA-256, remove o pending, promove por rename atômico e relê o caminho final. Também comprova que pending e finalizing desapareceram. Falha anterior à coleta ou falha/timeout do cleanup nunca chama o finalizador e não cria evidência física aprovada.

O relatório final admite apenas fase, status, duração, códigos, contagens, tamanhos, hashes, métricas, gates canônicos e inventário de limpeza. Segredos, URLs completas, credenciais, SQL sensível e dados reais são recusados.

## Próximo gate físico

Somente após nova autorização: fornecer o pacote oficial `postgresql-18.4-2-windows-x64-binaries.zip` já baixado e seu SHA-256 e executar a entrada confiável abaixo em uma porta comprovadamente livre. O comando não deve ser executado enquanto caminho e hash reais ainda não tiverem sido conferidos:

Antes dessa autorização, a página oficial de origem, o nome exato do build, o tamanho e o SHA-256 deverão ser reconfirmados. Qualquer mudança de build ou pacote exige nova decisão explícita; o harness não adota automaticamente um nome ou hash diferente.

```powershell
node scripts\social-3a0p-local-windows-entry.js --approval RUN_SOCIAL_3A0P_LOCAL_POSTGRES_18_4 --package-path "<CAMINHO_ABSOLUTO_LOCAL_DO_postgresql-18.4-2-windows-x64-binaries.zip>" --expected-sha256 <SHA256_REAL_DE_64_HEXADECIMAIS> --port 64995
```

A execução física deverá completar as quinze fases: migration, RLS, concorrência/OAuth sintético/idempotência, cofre e backup/restauração Windows. As duas provas de durabilidade exclusivas de Linux — fsync do diretório do bundle e proteção forte equivalente a `O_NOFOLLOW` — permanecerão para checkpoint separado.

Até este commit, somente a persistência NTFS do ledger possui prova física isolada. O gate PostgreSQL continua não executado: `postgresAccessed=false` e `networkAccessed=false`. Nenhum resultado das quinze fases PostgreSQL é antecipado.
