# Checkpoint Social 3A-0P — gates físicos Linux isolados

## Limite e proveniência

Esta décima terceira rota Linux isolada tem como pai imediato o commit local de
manutenção `8eb4c4d71c6593f9c3e448be6ac52b1b0e8ba931`, com a mensagem exata
`[test] serialize process-lifecycle security tests`. O pai exato da manutenção é
`9b98de25a42a21f7ebd229bf5581a78bfed80b2e`; portanto, a cadeia fechada é
`HEAD da feature` → `8eb4c4d71c6593f9c3e448be6ac52b1b0e8ba931` →
`9b98de25a42a21f7ebd229bf5581a78bfed80b2e`. A branch predecessora
`social/checkpoint-3a0p-linux-runtime-attributes-oid-20260809` e todas as
branches anteriores permanecem preservadas, sem edição ou novo push.

O workflow existe somente para a branch
`social/checkpoint-3a0p-linux-gate3-failure-provenance-20260809`. O produto
permanece idêntico a `fcfc92419021dae5f77baad731c634b10c275c5b`: `src/`, todo
`db/` (inclusive `roles.sql`), migrations, `server.js`, `package.json` e
`package-lock.json` não são alterados. Esta rota não acrescenta grants, não
altera políticas RLS e não modifica PostgreSQL, SCRAM, roles, backup, restore,
rede Docker ou credenciais.

## Décimo terceiro disparo Linux isolado autorizado

O único gatilho autorizado é o primeiro e único `push` de criação da nova
branch, sem exclusão ou force, cujo commit tenha a mensagem integral:

```text
[run-social-3a0p-linux-gate] classify Gate 3 failure provenance
```

O job exige `run_attempt == 1`, `created == true`, `deleted == false`,
`forced == false`, `before` igual a 40 zeros, pai exato
`8eb4c4d71c6593f9c3e448be6ac52b1b0e8ba931` e avô exato
`9b98de25a42a21f7ebd229bf5581a78bfed80b2e`, além de diffs nominais e
estritamente allowlisted. Também exige a mensagem exata da manutenção e estes
quatro caminhos como seu inventário fechado:

- `scripts/run-node-tests.js`;
- `scripts/social-3a0p-local-scope.js`;
- `tests/node-test-runner-safety.test.js`;
- `tests/social-3a0p-local-scope.test.js`.

Não há `workflow_dispatch`, pull request, agenda, matriz ou retry automático. A
regra operacional é: exatamente um push de criação, no máximo um run automático,
zero re-run, zero segundo push, zero PR, zero merge e zero deploy.

A allowlist do diff da feature contra o commit de manutenção contém exatamente
estes nove caminhos efetivamente alterados, sem curinga, prefixo ou diretório
inteiro:

- `.github/workflows/social-3a0p-linux-physical-gates.yml`;
- `docs/social-3a0p-linux-physical-gates.md`;
- `scripts/social-3a0p-linux-gate.js`;
- `scripts/social-3a0p-local-connector-physical-gates.js`;
- `scripts/social-3a0p-linux-physical-gates.js`;
- `tests/social-3a0p-linux-gate.test.js`;
- `tests/social-3a0p-local-connector-physical-gates.test.js`;
- `tests/social-3a0p-linux-physical-gates.test.js`;
- `tests/social-3a0p-linux-workflow.test.js`.

Qualquer outro caminho, inclusive outro workflow, `src/`, `db/`, migrations,
roles, servidor ou dependências, encerra o job antes do gate.

O comando canônico `npm test` usa `scripts/run-node-tests.js`. A primeira etapa
executa, em série e com `--test-concurrency=1`, exatamente estes seis testes de
ciclo de vida de processo, que permanecem byte-idênticos:

- `tests/body-parser-security.test.js`;
- `tests/checkpoint-a-security.test.js`;
- `tests/fcm-token-encryption.test.js`;
- `tests/social-2b0-config-security.test.js`;
- `tests/social-foundation-integration.test.js`;
- `tests/zip-downloads.test.js`.

Somente se essa etapa passar, o runner executa uma vez os demais testes
automatizados na etapa concorrente já existente. Cada teste descoberto pertence
a exatamente uma etapa; `tests/social-postgres-real.test.js` continua reservado
ao gate físico dedicado. Não há retry, repetição, shell ou timeout acrescentado
pelo runner.

## Falha física do Gate 3 que autoriza somente diagnóstico

O run físico `31318701548` (artifact `9039524578`, SHA-256 da evidência
`9a6317903e36ec6511045356711f1c9be0a2746192b87ac1addce3bda81cb1f4`,
digest do artifact
`sha256:db3432dd4987a4eaed07466c5efcbdff44c7a4d4b954bfa726b51b9b046e4511`)
aprovou integralmente o Gate 1, o contrato OID/textual de 16 campos e o Gate 2.
O Gate 3 `concurrency_oauth_idempotency` iniciou e falhou em 47 ms com
`linux_gate_unclassified_failure`, sem publicar resultado ou subetapa. Gates 4
e 5 não foram executados. O cleanup foi aprovado, com todos os resíduos em
zero.

Essa evidência não distingue a metade `base` da `supplemental`. O Gate 3 antigo
só publicava o merge depois de ambas concluírem, e o classificador global
reduzia SQLSTATE numérico, códigos Node maiúsculos e erros sem código ao mesmo
valor genérico. Portanto, a causa física do run `31318701548` não é
comprovável: não se infere PostgreSQL, constraint, timeout, rede, produto ou
instrumentação. O call graph contém apenas criptografia local e PostgreSQL;
não há subprocesso nem chamada a provedor externo dentro do Gate 3.

O patch desta rota é exclusivamente diagnóstico. Um tracker compartilhado,
first-write-wins e sem leitura de mensagem/stack marca estas fronteiras sem
alterar chamadas, argumentos, SQL, transações, concorrência, `Promise.all`,
`Promise.allSettled`, resultados ou erros:

| ID | Operação base | Classe |
|---|---|---|
| B1 | contexto e store | `internal_setup` |
| B2 | gravação inicial da conexão | `postgres_transaction` |
| B3 | repository e material OAuth | `internal_setup` |
| B4 | criação da autorização | `postgres_transaction` |
| B5 | consumo da autorização | `postgres_transaction` |
| B6 | corrida de idempotência | `postgres_concurrent_transactions` |
| B7 | validação da corrida | `internal_validation` |
| B8 | conclusão idempotente | `postgres_transaction` |
| B9 | replay idempotente | `postgres_transaction` |
| B10 | digests e resultado final | `internal_validation` |

| ID | Operação suplementar | Classe |
|---|---|---|
| S1 | criação dos tenants | `internal_setup` |
| S2–S3 | seed administrativo A e B | `postgres_transaction` |
| S4 | store do connector | `internal_setup` |
| S5 | corrida de reserva | `postgres_concurrent_transactions` |
| S6 | validação e vencedor | `internal_validation` |
| S7 | inventário bloqueante | `postgres_inventory` |
| S8 | repositories e material OAuth | `internal_setup` |
| S9 | criação OAuth | `postgres_transaction` |
| S10 | corrida de consumo | `postgres_concurrent_transactions` |
| S11 | validação do consumo | `internal_validation` |
| S12 | replay e isolamento cross-tenant | `postgres_concurrent_transactions` |
| S13 | material da autorização expirada | `internal_setup` |
| S14–S16 | criação, expiração e consumo | `postgres_transaction` |
| S17 | inventário de plaintext | `postgres_inventory` |
| S18–S20 | disconnect e conexões A/B | `postgres_transaction` |
| S21 | material da publicação | `internal_setup` |
| S22 | corrida de publicação | `postgres_concurrent_transactions` |
| S23 | validação da corrida | `internal_validation` |
| S24–S27 | conclusão, replay, conflito e cross-tenant | `postgres_transaction` |
| S28 | inventário persistido final | `postgres_inventory` |
| S29 | asserções e resultado | `internal_validation` |
| S30 | zeragem das identity keys | `memory_cleanup` |

Em falha, `gate3FailureProvenance` contém exatamente `operation`, `substep`,
`operationClass`, `causalCode`, `lastCompletedSubstep`,
`externalProcessStarted=false`, `exitCode=null` e `signal=null`. Códigos seguros
são preservados; SQLSTATE de cinco caracteres e a allowlist fechada de códigos
Node recebem prefixo `gate3_error_code_`; `TypeError`, ausência e formato não
suportado recebem códigos fixos. Para `postgres_rollback_failed`, somente
`cause.code` pode ser consultado. Nenhum texto de erro é serializado.

Um supervisor externo ao Gate 3 executa o processo do gate uma única vez com
streams herdados, nunca armazenados, e produz o sidecar separado
`gateProcessStatus` com `exitCode`, signal fechado, `timedOut`,
`stdoutStored=false` e `stderrStored=false`. Timeout explícito ocorre antes do
limite do job para permitir sidecar e cleanup. Se a nova execução ainda não
produzir uma subetapa fechada, não haverá ampliação automática: o run para e a
recomendação será dividir o Gate 3 em fases Linux nativas independentes.

## Primeira falha física do run predecessor

O run físico `31311258155` (artifact `9037446208`, SHA-256 do JSON
`df70fad1b4f35c16eb744cc7d5f46af67c90e55ea57021f833d5ee2e8cbd3292`,
digest do artifact
`sha256:368af46c28ff1ac01cc219d897e865dd6b2dc37dbf973573721546598cdd8fe5`)
aprovou durabilidade, PostgreSQL, bootstrap, Gate 1, migrations, o inventário
social por OID e a reprodução antiga do insert em `users`. O inventário
comprovou `USAGE=false` tanto na sessão direta quanto sob `MIGRATOR_ROLE`, duas
relações exatas por OID, privilégios runtime esperados, RLS, FORCE RLS, policy,
reset e ACL idêntica.

O Gate 2 avançou por seed administrativo, leituras próprias e cruzadas,
contexto ausente/adulterado, escritas próprias em `social_audit_events`,
recusas A→B e B→A, zero linha cruzada e reutilização sem vazamento. Ele parou
somente na subetapa final `rls_runtime_role_attributes`, com o código sanitizado
`postgres_insufficient_privilege`. Gates 3 a 5 não foram executados. Cleanup
removeu todos os recursos e registrou zero resíduo; não houve segundo push,
retry, re-run, PR, merge ou deploy.

A causa estática desta rota é a resolução textual de
`ia4tube_migrations.schema_migrations` em `has_table_privilege` pela pool
autenticada como migration. O login possui membership `INHERIT FALSE` e não
herda automaticamente o `USAGE` da migrator no schema de migrations. A menor
consulta textual deve, portanto, reproduzir `42501` antes de produzir qualquer
boolean de privilégio runtime.

A correção permanece somente no harness. O inventário final localizará em
`pg_catalog` o schema de migrations, seu ledger e as roles fechadas, exigirá
OIDs positivos e, entre as quatro roles, distintos, e usará apenas overloads
por OID de
`has_schema_privilege`, `has_table_privilege` e `pg_has_role`. Login e role
runtime serão verificados separadamente para atributos, memberships,
`USAGE`/`CREATE` e cada privilégio do ledger, inclusive `MAINTAIN`. Não haverá
`regclass` textual, `to_regclass`, SQL dinâmico, fallback após `42501`, grant,
alteração de ACL, role, policy, migration ou produto.

## Run predecessor do inventário social preservado

O run `31308539550` (artifact `9036694430`, SHA-256
`0bf0bf72f0d40f2e0d73a87daaf3c42b002bddd2e07ac566a7dfb93cedd7aff4`)
comprovou a recusa textual no schema social e que a migrator também possui
`USAGE=false`. A rota seguinte alinhou essa ausência intencional e aprovou o
inventário social integralmente por OID, sem alterar qualquer privilégio.

## Run predecessor anterior preservado

O run físico `31297947479` (artifact `9033565654`, SHA-256 do JSON
`d24a6a52a59e564319015599d665c2a586c8264b1bafeb8aa050fa614f804b4d`)
aprovou durabilidade, PostgreSQL, bootstrap, credenciais, Gate 1 e migrations.
Ele parou na fase `rls_runtime_write_contract_reproduction`, subetapa fechada
`rls_privilege_inventory`, com o código sanitizado
`postgres_insufficient_privilege`. O Gate 2 corrigido e os Gates 3 a 5 não
foram executados. O artifact foi aprovado, o cleanup removeu contêiner, rede,
volume, credenciais e raiz temporária, e os contadores de resíduos ficaram em
zero. A rota seguinte comprovou que a resolução textual sem contexto de role
era recusada e que a migrator não possui `USAGE` no schema.

## Run anterior preservado

O run físico `31292070642` (artifact `9031715895`, SHA-256 do JSON
`54d2630c505f521cfa57554f6df70d47c1f896a72f0e1924493a1433af9d2c9c`)
aprovou integralmente o Gate 1. Foram concluídos migrations, rollback,
`pg_dump`, `pg_restore`, `restore_vault`, `verify2ACompatibility`, restauração e
validação do profile 0003, reaplicação e validação do profile 0004; o campo
`schemaProfileDiagnostics` permaneceu `null`.

O mesmo run parou no Gate 2, fase `rls_roles`, com o código sanitizado
`linux_gate_unclassified_failure`. Os Gates 3 a 5 não foram executados. Cleanup
foi aprovado, com zero resíduos e sem segundo push, retry, re-run, PR, merge ou
deploy. Essa evidência não identifica publicamente SQLSTATE, consulta,
argumentos ou mensagem bruta e, isoladamente, não comprova a hipótese causal
que esta rota deverá testar.

## Contrato físico do inventário OID ainda pendente

Não existe declaração antecipada de aprovação física nesta rota. Depois do
Gate 1, a subfase fechada `rls_privilege_inventory_context_reproduction`
deverá demonstrar, nesta ordem:

1. na sessão direta da pool de migration, `session_user` e `current_user`
   correspondem à mesma categoria de login migration não privilegiado;
2. o login não é superuser, não possui `BYPASSRLS` ou `CREATEROLE`, pode
   assumir `MIGRATOR_ROLE`, mas não a herda automaticamente;
3. `has_schema_privilege(current_user, 'ia4tube_social', 'USAGE')` retorna
   `false` antes de `SET ROLE`;
4. a menor consulta textual equivalente do inventário recusa com `42501`, sem
   mutação, persistência ou inutilização da pool;
5. dentro de `withTransaction(state.pools.migration, callback,
   { role: MIGRATOR_ROLE })`, `session_user` permanece login migration,
   `current_user` passa a migrator e `USAGE` permanece `false` como prova
   positiva de menor privilégio;
6. o inventário localiza pelo catálogo exatamente uma relação por OID para
   `users` e uma para `social_audit_events`, sem `regclass` textual ou
   `to_regclass`, exige `INSERT=false` na primeira, `INSERT=true` na segunda e
   valida RLS, FORCE RLS e a policy vinculada a `company_id`;
7. depois da transação, outra conexão comprova reset de role e ACLs idênticas.

Zero ou mais de uma relação por alvo reprova. O inventário recebe apenas o
client transacional autorizado e não aceita pool genérico. As provas “antes” e
“depois” usam o mesmo caminho sob `MIGRATOR_ROLE` e devem produzir inventários
idênticos. Nenhuma consulta de inventário escreve dados ou DDL.

O resultado sanitizado dessa fase possui exatamente 22 campos: os 17 campos
anteriores com `migratorSchemaUsage=false`, mais
`inventorySessionUserMigration=true`, `inventoryCurrentUserMigrator=true`,
`oidInventoryUsed=true`, `textualRelationResolutionUsed=false` e
`relationCount=2`. Nenhum nome de login, OID numérico, SQL ou identificador de
relação é publicado no artifact.

Somente depois dessa reprodução exata, `gates.rls({ state })` e a subfase
`rls_runtime_write_contract_reproduction` deverão demonstrar:

1. a role runtime não possui `INSERT` em `ia4tube_social.users`;
2. a tentativa antiga de insert próprio em `users`, sob contexto A, é recusada
   com SQLSTATE interno `42501`;
3. nenhuma linha de usuário é persistida, a transação termina, a pool continua
   utilizável e nenhum privilégio é alterado;
4. a recusa ocorre antes das antigas etapas `ownWriteB`, escritas cruzadas,
   reset de conexão e atributos da role;
5. o sanitizador antigo classificaria o SQLSTATE numérico como
   `linux_gate_unclassified_failure`, somente em diagnóstico interno controlado;
6. a role runtime possui `INSERT` em
   `ia4tube_social.social_audit_events` e a tabela possui política RLS aplicável
   a `company_id`.

Somente se todos esses fatos coincidirem exatamente com o contrato esperado, o
mesmo processo executará o Gate 2 corrigido. A escrita positiva usará eventos
sintéticos mínimos em `social_audit_events`: A/A e B/B deverão funcionar; A/B e
B/A deverão ser recusados com `42501`; nenhum evento cruzado poderá persistir.
O insert em `users` permanecerá como prova negativa explícita, nunca como grant
ou escrita positiva. Gates 3, 4 e 5 somente serão chamados depois da aprovação
do Gate 2 corrigido.

Qualquer regressão do Gate 1 ou divergência na reprodução encerra o run antes do
Gate 2 corrigido. Falha posterior preserva a primeira subetapa e causa
sanitizadas, impede gates seguintes, executa cleanup e encerra sem correção,
segundo push, retry ou re-run.

## Evidência semântica e procedência do Gate 2

O resultado da reprodução de contexto é fechado em 22 campos:
`directSessionIdentityVerified=true`, `directLoginSuperuser=false`,
`directLoginBypassRls=false`, `directLoginCreateRole=false`,
`directLoginCanSetMigratorRole=true`, `directLoginInheritsMigratorRole=false`,
`directSchemaUsage=false`, `directNameResolutionRefused=true`,
`directTransactionPersisted=false`, `directPoolUsableAfterRefusal=true`,
`migratorSessionIdentityPreserved=true`, `migratorRoleActivated=true`,
`migratorSchemaUsage=false`, `migratorInventorySucceeded=true`,
`roleResetAfterTransaction=true`, `privilegesUnchanged=true` e
`aclUnchanged=true`, além de `inventorySessionUserMigration=true`,
`inventoryCurrentUserMigrator=true`, `oidInventoryUsed=true`,
`textualRelationResolutionUsed=false` e `relationCount=2`. Qualquer chave,
tipo ou valor divergente reprova antes da reprodução antiga.

## Contrato físico dos atributos runtime ainda pendente

Depois das provas anteriores, a fase fechada
`rls_runtime_attributes_text_resolution_reproduction` deverá executar uma
única vez, nesta ordem:

1. confirmar sessão direta na categoria migration, sem herança automática da
   migrator e sem `USAGE` no schema `ia4tube_migrations`;
2. executar somente a menor consulta negativa com o nome textual
   `ia4tube_migrations.schema_migrations`, exigir `42501`, zero mutação, zero
   transação persistida e pool utilizável;
3. localizar exclusivamente em `pg_catalog` um schema de migrations, uma
   relação ledger com relkind permitido e quatro roles distintas: login
   runtime, role runtime, migrator e owner;
4. usar somente os OIDs encontrados nos overloads de
   `has_schema_privilege`, `has_table_privilege` e `pg_has_role`;
5. verificar separadamente login e role runtime: atributos não privilegiados,
   ausência de membership migrator/owner, ausência de `USAGE` e `CREATE` no
   schema e ausência individual de `SELECT`, `INSERT`, `UPDATE`, `DELETE`,
   `TRUNCATE`, `REFERENCES`, `TRIGGER` e `MAINTAIN` no ledger;
6. confirmar ACL idêntica depois da prova.

O caminho corrigido não contém `regclass` textual, `to_regclass`, nome
schema-qualified em `has_table_privilege`, SQL dinâmico, entrada externa ou
fallback após `42501`. Qualquer schema, relação, relkind, role, OID, atributo,
membership ou privilégio divergente interrompe antes do Gate 2.

O resultado público dessa fase possui exatamente 16 booleans:
`runtimeLoginAttributesSafe=true`, `runtimeRoleAttributesSafe=true`,
`runtimeLoginMigratorMember=false`, `runtimeRoleMigratorMember=false`,
`runtimeLoginOwnerMember=false`, `runtimeRoleOwnerMember=false`,
`runtimeLoginMigrationSchemaUsage=false`,
`runtimeRoleMigrationSchemaUsage=false`,
`runtimeLoginMigrationSchemaCreate=false`,
`runtimeRoleMigrationSchemaCreate=false`,
`runtimeLoginMigrationTablePrivileges=false`,
`runtimeRoleMigrationTablePrivileges=false`,
`migrationSchemaLocatedByOid=true`, `migrationLedgerLocatedByOid=true`,
`textualResolutionUsed=false` e `aclUnchanged=true`. O artifact não recebe
OID, SQL, nome de login, argumento, mensagem PostgreSQL, stack ou output bruto.

O resultado sanitizado do Gate 2 usa campos separados para leitura e escrita:

- `baseRlsGatePassed`;
- `tenantSeedsCreatedByAdministrativeRole`;
- `runtimeCoreUserInsertPrivilege=false`;
- `runtimeCoreUserInsertRefused=true`;
- `runtimeCoreUserInsertPersisted=false`;
- `companyAOwnRead=true`;
- `companyBOwnRead=true`;
- `companyAToBReadRefused=true`;
- `companyBToAReadRefused=true`;
- `companyAOwnSocialWrite=true`;
- `companyBOwnSocialWrite=true`;
- `companyAToBWriteRefused=true`;
- `companyBToAWriteRefused=true`;
- `crossTenantRowsPersisted=false`;
- `missingContextZeroRows=true`;
- `tamperedContextRefused=true`;
- `connectionScopeReset=true`;
- `runtimeSuperuser=false`;
- `runtimeBypassRls=false`;
- `runtimeCreateDb=false`;
- `runtimeCreateRole=false`;
- `runtimeMigrationPrivileges=false`.

Esses valores são expectativas do contrato; somente o artifact do run poderá
convertê-los em prova física. A procedência admite somente as subetapas fechadas
`rls_base_gate`, `rls_inventory_direct_session_identity`,
`rls_inventory_direct_schema_access`,
`rls_inventory_direct_name_resolution_refusal`,
`rls_inventory_migrator_role_activation`,
`rls_inventory_migrator_privilege_read`, `rls_inventory_role_reset`,
`rls_seed_tenants`, `rls_privilege_inventory`,
`rls_core_user_insert_reproduction`, `rls_core_user_insert_refusal`,
`rls_bidirectional_read`, `rls_missing_context`, `rls_tampered_context`,
`rls_own_social_write`, `rls_cross_tenant_write`,
`rls_connection_scope_reset` e `rls_runtime_role_attributes`. O mapeamento
interno fechado é `42501` → `postgres_insufficient_privilege` e `22P02` →
`postgres_invalid_text_representation`; uma recusa esperada aprova a prova, mas
nenhum SQLSTATE bruto é publicado.

SQL, argumentos, UUIDs, nome de banco, IP, hostname, senha, URL, stack, mensagem
PostgreSQL, stdout, stderr, tokens e chaves são proibidos na evidência. Não há
conexão externa, dado real, token, OAuth real ou publicação nesta rota.

## Falha física histórica e reprodução focal do cofre

O run físico anterior `31290136520` (artifact `9031104643`, SHA-256 da
evidência
`65611a2184b40b552f2327255fda5ec49cef243a9a0135a82d5338dd6623d988`)
encerrou na fase `migrations`, na operação `rollback_restore_0003`, subetapa
exata `restore_vault` e fronteira `internal_callback`. O código causal público
permaneceu `backup_restore_internal_callback_failed`, o código superior
permaneceu `backup_external_tool_failed` e nenhum processo externo foi iniciado
nessa subetapa. Um `pg_dump` e o `pg_restore` anterior já haviam sido concluídos;
isso não atribui a falha a essas ferramentas. O cleanup foi aprovado com zero
resíduo, sem segundo push, retry ou re-run.

A reprodução focal local, sem Docker, GitHub Actions ou rede externa,
comprovou a incompatibilidade antes de qualquer correção. O profile
`social-schema-0003` contém somente as migrations 0001, 0002 e 0003. A tabela
`ia4tube_social.social_oauth_transactions` já contém `consumed_at`,
`cancelled_at` e `expires_at`, mas `failed_at` e `failure_code` surgem somente
na migration `0004_social_connector_persistence`. O método atual
`findEncryptedCredential` consulta `oauth.failed_at`; contra o catálogo 0003,
a primeira leitura normal recusou com SQLSTATE interno `42703`. O método
equivalente da implementação 2A fixada não consulta essa coluna, e o repositório
atual permaneceu compatível com o catálogo 0004.

A mesma prova confirmou a ordem causal: registro das chaves v1 e v2 e
armazenamento das duas credenciais não dependem das colunas 0004. A recusa
ocorreu na primeira chamada de `withDecryptedCredential`, antes de
`vault.decrypt`, testes de adulteração, rotação, retirada de chave ou
`verify2ACompatibility`. O tracker existente classificou essa causa como
`rollback_restore_0003` → `restore_vault`, sem processo externo, e preservou o
código público genérico já aprovado. Somente o teste focal converte `42703` em
`postgres_undefined_column`; SQL, mensagem do PostgreSQL, argumentos, caminhos,
endereços e credenciais não entram na evidência pública.

A correção permanece exclusivamente no harness e seleciona a factory antes da
criação do repositório, a partir do `expectedProfileId` canônico proveniente de
`SCHEMA_PROFILES`:

- no profile 0003, são construídos o repositório atual e o repositório 2A
  validado; um facade novo, fechado e congelado preserva todos os métodos atuais
  e substitui exclusivamente `findEncryptedCredential` pelo método legado;
- no profile 0004, o repositório primário é integralmente o atual, sem facade,
  fallback ou método legado nesse repositório;
- profile desconhecido é recusado antes da criação dos repositórios; erro SQL,
  ambiente e conteúdo observado do banco não participam da seleção.

O probe separado `verify2ACompatibility` continua usando suas dependências 2A
fixadas para provar compatibilidade histórica. Ele não transforma o repositório
primário do profile 0004 em legado. A implementação 2A continua carregada apenas
pelo commit `9deb1e04249026a7046d44d6cbf4e2da87b9a0a4`, manifesto fechado e hashes
aprovados para os 21 arquivos do escopo da árvore-fonte. O materializador não
cria outro arquivo-fonte; acrescenta somente o link local de dependências fora
desse escopo, sem download durante o run. A reprodução
local autoriza a correção, mas não aprova fisicamente `restore_vault`, o restore
0003 integral, o reapply 0004, a validação 0004 ou qualquer Gate; isso depende
do único run Linux autorizado.

## Falha predecessora da instrumentação preservada

O run predecessor `31282878969` (artifact `9028948591`, SHA-256 da evidência
`12d26dc06ece482eb4a84249056484014aa9ff02517343b91b6ac00d96f1a2c7`)
encerrou na fase `migrations` com o código sanitizado genérico
`backup_external_tool_failed`. A evidência comprovou que ao menos um `pg_dump`
e um `pg_restore` validados foram iniciados e concluídos, mas não preservou
executável, subetapa, argumentos, origem interna da exceção, stdout ou stderr
brutos. Por isso, ela não permite identificar qual operação posterior falhou
nem afirmar que a origem foi necessariamente um processo externo.

A rota predecessora alterou exclusivamente o harness para preservar a procedência
sanitizada da primeira falha dentro do backup/restore. O esquema fechado contém
somente `operation`, `substep`, `boundary`, `causalCode`,
`externalTransportProcessStarted` e `substepExact`. Uma subetapa é declarada
exata somente quando diretamente observável (`substepExact=true`). O código
causal é normalizado e nenhum desses campos registra SQL, argumentos completos,
caminhos, bancos, credenciais, stdout ou stderr brutos.

`pre_execution_validation` identifica uma subetapa externa conhecida cuja
tentativa foi recusada antes do evento `spawn` do child de transporte no host;
nesse caso, `externalTransportProcessStarted=false`. `external_process` exige
que esse evento tenha sido observado e registra
`externalTransportProcessStarted=true`. Isso comprova somente que o child do
transporte Docker foi iniciado no host: não comprova que `pg_dump`, `pg_restore`
ou `psql` iniciou dentro do contêiner, nem atribui necessariamente a causa da
falha ao processo interno. `internal_callback` identifica um callback interno
diretamente observado, também sem processo de transporte iniciado.

`internal_interval` delimita apenas o intervalo entre duas fronteiras
observáveis; por isso registra `substepExact=false` e não infere a origem interna
exata. `instrumentation` registra `substep=unknown`,
`externalTransportProcessStarted=null` e `substepExact=false`. A seleção
profile-aware comprovada permanece intacta: 0003 usa o verifier 2A fixado e
validado; 0004 usa o verifier atual; o profile vem somente de
`SCHEMA_PROFILES`; não há fallback 0004 para 0003.

Produto, migrations, roles, `pg_dump`, `pg_restore`, `psql` e seus contratos
funcionais permanecem byte-idênticos. A instrumentação não corrige por
inferência a falha física ainda desconhecida. Na primeira falha, preserva a
primeira causa sanitizada sem permitir que o cleanup a sobrescreva, executa o
cleanup e para sem repetir nem corrigir. Se a primeira procedência terminar em
`internal_interval` ou `instrumentation`, a origem exata continua não
comprovada. Nesse caso não será adicionado outro wrapper ou camada diagnóstica:
o próximo passo recomendado será dividir o Gate 1 em etapas Linux nativas
menores e independentes, sujeito a nova decisão.

Não foram comprovados pelo run predecessor: restore integral do perfil 0003,
validação exata do 0003 restaurado, reapply 0004 ou validação exata do 0004.
O Gate 1 foi reprovado e os Gates 2 a 5 não foram executados. Cleanup terminou
aprovado, com zero resíduos; não houve segundo push, retry, re-run, PR, merge ou
deploy. OAuth real, Meta, Instagram, Render, staging e produção permaneceram
intocados.

## Prova focal do schema profile preservada

O run predecessor `31271208390` (artifact `9025655493`, SHA-256 da evidência
`4afe3e810d06f57b9b3af78627f5ab9c650073e80142a48a6de215b58585b7a3`)
encerrou na fase `migrations` com o código sanitizado
`postgres_relation_owner_mismatch`, depois de `pg_dump` e `pg_restore` terem
sido iniciados e concluídos. As provas de durabilidade, `O_NOFOLLOW`, rede
interna, zero exposição, bootstrap, credenciais, identidade TLS lógica,
transporte físico descartável e cleanup permaneceram aprovadas e não são
alteradas nesta rota.

A reprodução focal sem PostgreSQL, Docker ou rede comprovou que um perfil 0003
perfeito contém 12 tabelas sociais e a view `runtime_schema_contract`, total de
13 relações. O verificador atual espera 15 tabelas sociais e a mesma view,
total de 16. Os contadores do fixture original são:

- `observedRelationCount=13`;
- `expectedRelationCount=16`;
- `missingRelationCount=3`;
- `unexpectedRelationCount=0`;
- `kindMismatchCount=0`;
- `ownerMismatchCount=0`.

As três relações ausentes são exatamente
`social_idempotency_operations`, `social_publications` e
`social_publication_attempts`. Todas as relações observadas têm owner
`ia4tube_social_owner` e relkind correto. A condição atual agrupa divergência
de contagem, ausência, relação inesperada, relkind e owner sob o mesmo código;
portanto, esse código não demonstrava corrupção de ownership. Acrescentar
somente as três relações 0004 elimina essa classificação específica.

A correção permanece exclusivamente no harness e seleciona o verificador a
partir de `expectedProfile.id` obtido dos `SCHEMA_PROFILES` definitivos:

- `social-schema-0003` usa o `verifyRuntimeSchema` da implementação 2A;
- `social-schema-0004` usa o `verifyRuntimeSchema` atual;
- qualquer outro profile ID é recusado antes da abertura do verifier.

A implementação 2A é carregada somente por `loadLegacy2ADependencies`, com
commit fixado `9deb1e04249026a7046d44d6cbf4e2da87b9a0a4`, manifesto, árvore e hashes
validados antes e depois da carga. O run não baixa código nem consulta branch
remota. Ambiente, conteúdo observado do banco e falha anterior não podem
selecionar o profile; não existe fallback automático entre verificadores.

O Gate 1 aplica o verificador 0003 ao banco restaurado, mantém isolamento,
repository, vault e compatibilidade 2A, reaplica 0004 e então exige o
verificador atual. O Gate 5 vincula separadamente os restores 0003 e 0004 aos
respectivos verificadores. A injeção usa a dependência controlada
`verifyRuntimeSchema` do verifier existente; o produto permanece byte-idêntico.
Não há `ALTER OWNER`, `REASSIGN OWNED`, compensação posterior de ownership,
mudança em `pg_dump` ou `pg_restore`, nem seleção baseada no banco restaurado.

Se `postgres_relation_owner_mismatch` reaparecer, a evidência preservará apenas
os seis contadores sanitizados acima, parará na primeira falha e não haverá
segundo push ou re-run. Até o único run encerrar e sua evidência ser conferida,
o checkpoint permanece bloqueado.

## Bridge exclusiva de backup/restauração preservada

O run predecessor `31266308555` (artifact `9024249819`, SHA-256 da evidência
`1729427d82fefa1ff2e68ef258cf7bb92ef826b08b8d1f6fbf95e947ef7365ba`)
encerrou na fase `migrations` com o código sanitizado
`social_database_tls_hostname_invalid`. Durabilidade, `O_NOFOLLOW`, isolamento
Docker, bootstrap, credenciais, migrations principais e o perfil descartável
0003 já haviam sido alcançados. A primeira falha ocorreu em
`backup.loadBackupConfig(...)`, antes da criação do plano, do início de
`pg_dump`, da abertura de subprocesso ou da produção do bundle.

A causa comprovada foi a divergência entre identidade lógica e transporte
físico. O plano antigo entregava `127.0.0.1` com `sslmode=verify-full` ao
carregador TLS definitivo. O produto corretamente recusa IP como `servername`
TLS e exige hostname DNS; a conversão física para o namespace do contêiner só
ocorreria no executor, que ainda não havia sido alcançado. Esta correção não
altera nem relaxa essa política do produto.

O contrato exclusivo do harness é
`POSTGRES_BACKUP_CONNECTIVITY_MODE=logical_dns_to_internal_container_v1`. A
identidade lógica é fixa e imutável:

- host `backup.local.ia4tube.invalid`;
- porta `5432`;
- `sslmode=verify-full`;
- raiz TLS `system`;
- aplicação `ia4tube-social-backup-restore`;
- banco descartável, login sintético, perfil, run marker e contêiner exatos.

O binding local fechado registra `logicalHost`, `logicalPort`,
`physicalMode=internal_container_loopback`, `physicalHost=127.0.0.1`,
`physicalPort=5432`, banco, login migration ou provisioner autorizado,
`runMarker` e o digest/referência da identidade do contêiner já validado. Esses
campos são derivados pelo gate dentro de closures imutáveis; nenhum deles pode
ser substituído pelo ambiente ou pelo chamador.

Esse hostname reservado é usado somente nas URLs entregues a
`loadBackupConfig`/`loadRestoreConfig`, no host esperado, nos fingerprints e
nos planos definitivos. Ele não vem de ambiente, argumento ou outra entrada
externa, não é resolvido e nunca recebe uma conexão. IP, `localhost`, outro
domínio `.invalid`, hostname de staging ou produção e qualquer divergência de
porta, banco, login, run, TLS, executável ou argumento falham antes do processo
filho.

Somente depois de validar integralmente o plano, o executor Linux converte o
transporte imediatamente antes de `docker exec` no mesmo contêiner PostgreSQL
pertencente ao run:

- `PGHOST=backup.local.ia4tube.invalid` torna-se `PGHOST=127.0.0.1`;
- `PGPORT=5432` é preservado;
- `PGSSLMODE=verify-full` torna-se `PGSSLMODE=disable`;
- `PGSSLROOTCERT` e `SSL_CERT_FILE` são removidos;
- banco, login, senha sintética e `PGAPPNAME` são preservados.

A mesma ponte estreita cobre `pg_dump`, `psql` e `pg_restore` dos caminhos de
backup e restauração. O produto continua executando
`loadBackupConfig`, `loadRestoreConfig`, `runLogicalBackup`,
`runLogicalRestore`, perfis, manifesto, catálogo, bundle criptografado,
integridade e comportamento de restauração; somente o transporte do processo
filho é adaptado pelo harness. Não há DNS real, certificado local, CA local,
trust store local, listener no host, porta publicada ou segundo sistema de
backup.

A evidência deve separar os dois contratos com estes valores exatos:

- `logicalIdentityTlsContractValidated=true`;
- `physicalDisposableTransportValidated=true`;
- `productionTlsPhysicallyTestedInThisGate=false`;
- `productionTlsPreviouslyProvedBySocial2B=true`;
- `localTlsDisabledOnlyInsideOwnedContainer=true`.

Portanto, este gate valida que o contrato lógico definitivo continua exigindo
`verify-full`, mas não declara que o TLS de produção foi exercitado fisicamente
no cluster descartável. Essa prova permanece nos checkpoints Social 2B de
staging/TLS. Até o novo run terminar e sua evidência ser conferida, nenhum
gate desta nova branch é declarado aprovado.

## Bridge exclusiva do verificador de credenciais preservada

O run histórico `31261593977` (artifact `9022940755`, SHA-256
`552d72db1176f1bb53dd412ac213ec20a5d98d98b205191ab7d54384e05a5bcd`)
encerrou na fase `migrations` com o código sanitizado
`login_bootstrap_credential_verification_failed`. A cadeia focal é:

1. `verifyProvisionedLoginCredentials` chama `verifyOneLoginCredential`;
2. `loginPoolConfig` produz a configuração com `connectionString`;
3. o verificador instancia a `PoolClass` recebida;
4. no Gate 1, essa classe era o `PhysicalPlanPool` geral;
5. `createPrivatePlanPoolOptionsAdapter` recusava a `connectionString` antes de
   abrir socket;
6. o produto convertia a causa interna
   `linux_gate_plan_pool_logical_transport_invalid` no código sanitizado acima.

A correção mantém o adapter geral recusando toda `connectionString`. Somente o
database manager físico injeta uma PoolClass/factory exclusiva em
`verifyProvisionedLoginCredentials`. Essa bridge faz parse estrito da URI
criada pelo próprio login bootstrap e aceita apenas protocolo PostgreSQL, host
lógico `127.0.0.1`, porta `5432`, banco descartável exato, login e senha
sintéticos correspondentes, `application_name`, limites e timeouts aprovados,
sem fragmento, query extra ou TLS.

Depois da validação, a bridge remove `connectionString` e entrega ao
`InstrumentedPool` somente opções explícitas: o IPv4 privado já aprovado pelo
inspect Docker, porta `5432`, banco, usuário e senha exatos e `ssl=false`. O IP
físico não pode ser fornecido pelo chamador. URI, IP, senha, configuração
completa e mensagem bruta do driver não são registrados. Host, porta, banco,
login, senha, protocolo, TLS, query, fragmento ou origem divergentes falham
antes de qualquer conexão física.

O run `31266308555` alcançou e aprovou migration login, runtime login e
`SET LOCAL ROLE` usando essa bridge. A correção atual não altera o verificador
nem amplia o adapter geral.

## Supply chain fechada

- Runner: `ubuntu-24.04`.
- Permissões: somente `contents: read`.
- Node: linha 24, compatível com `>=20 <25`.
- Instalação: `npm ci --ignore-scripts --no-audit --no-fund`.
- `actions/checkout`: `3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1).
- `actions/setup-node`: `820762786026740c76f36085b0efc47a31fe5020` (v7.0.0).
- `actions/upload-artifact`: `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` (v7.0.1).
- PostgreSQL oficial:
  `docker.io/library/postgres:18.4-bookworm@sha256:7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568`.

O digest é o manifesto de plataforma `linux/amd64`, não o índice
multi-arquitetura. O job revalida `Os`, `Architecture`, `RepoDigests` e a versão
SQL antes de executar migrations.

## Isolamento do contêiner

O contrato é registrado como
`POSTGRES_CONNECTIVITY_MODE=internal_bridge_direct_v1` e usa uma rede Docker bridge criada com
`--internal`, volume de propriedade do run e diretório físico sob
`$RUNNER_TEMP`. O contêiner não usa `--publish`, `-p`, host network, proxy ou
qualquer binding de porta no host. Tanto `NetworkSettings.Ports` quanto
`HostConfig.PortBindings` devem comprovar ausência de publicação.

O ID completo retornado por `docker run --detach` é capturado e vinculado ao
nome, label, estado e rede esperados. A inspeção estruturada confirma um único
IPv4 privado canônico do contêiner na rede interna. O processo host conecta
diretamente a esse endereço privado na porta interna `5432` e executa a prova
SQL antes dos cinco gates. O endereço e a subnet ficam somente em memória e
nunca entram em stdout, logs, artifact ou relatório sanitizado.

O comando `ss -H -ltn` permanece obrigatório como prova negativa: não pode
existir listener PostgreSQL no host, seja em loopback, wildcard, IPv4 externo ou
IPv6. Qualquer publicação, proxy, listener host ou conexão do processo host via
`127.0.0.1` reprova o gate. O loopback permanece restrito ao namespace do
contêiner para readiness e ferramentas. O sucesso exige simultaneamente a
ausência comprovada no host e a conexão direta aprovada ao IPv4 privado do
contêiner.

O run `31242598936` comprovou a incompatibilidade operacional que motivou esta
modalidade: a rede `--internal`, o contêiner e o readiness interno estavam
aprovados, mas a inspeção estruturada encontrou `NetworkSettings.Ports`
presente, sem a entrada `5432/tcp`, e zero bindings publicados apesar da antiga
solicitação `--publish 127.0.0.1::5432`. A correção remove a publicação por
completo; não volta a diagnosticar `docker port` e não cria proxy alternativo.

O cluster exige PostgreSQL 18.4, `C`, UTF8, SCRAM-SHA-256 e data checksums. A
senha administrativa é sintética, nasce durante o job e fica somente em memória
e em arquivo temporário `0600`, passado via `POSTGRES_PASSWORD_FILE`. Senhas de
roles nunca aparecem em argumentos, logs ou evidência.

## Prova Linux de durabilidade

Antes do banco, um helper Python pequeno usa descritores de diretório mantidos,
`dir_fd`, `O_EXCL`, `O_NOFOLLOW` e validação de dispositivo/inode. A prova faz:

1. criação exclusiva, escrita integral e `fsync` do arquivo;
2. fechamento, rename atômico e `fsync` do diretório-pai;
3. reabertura e SHA-256 idêntico;
4. arquivo regular aceito;
5. symlink final recusado;
6. troca por symlink antes da abertura recusada;
7. symlink intermediário recusado sem travessia;
8. cleanup completo e zero resíduos.

Falha de `fsync` de diretório, ausência de `O_NOFOLLOW` ou identidade alterada
reprova o gate. Nenhuma garantia é inferida apenas por teste simulado.

## Ordem física dos gates

O workflow chama o gate físico exatamente uma vez. Dentro desse processo, a
ordem obrigatória e fail-closed é:

1. validar o contrato imutável do commit, branch, tentativa e allowlist;
2. instalar dependências somente pelo lockfile, sem lifecycle scripts;
3. executar a prova de durabilidade Linux e `O_NOFOLLOW`;
4. iniciar e validar o PostgreSQL 18.4 descartável, sem porta publicada;
5. concluir bootstrap e credenciais sintéticas;
6. executar o **Gate 1 — migrations e rollback**, incluindo 0001–0003,
   snapshot, 0004, checksum, constraints/índices/RLS/FORCE RLS, falha
   transacional controlada, restauração 0003 e reaplicação 0004, sem migration
   down;
7. executar a reprodução física fechada do contexto direto e o inventário
   exclusivamente por OID sob `MIGRATOR_ROLE`, mantendo `USAGE=false`; qualquer
   divergência encerra antes da reprodução antiga e dos gates posteriores;
8. executar `gates.rls({ state })` e a reprodução física fechada do contrato
   antigo do Gate 2;
9. reproduzir a resolução textual recusada no ledger de migrations e executar
   o inventário final dos atributos e privilégios de login e role runtime
   exclusivamente por OID;
10. somente se as três provas coincidirem integralmente, executar o
   **Gate 2 — RLS e
   roles corrigido**, com leituras A/B, recusa do insert runtime em `users`,
   escritas próprias e cruzadas em `social_audit_events`, contexto
   ausente/adulterado, reutilização de conexão e atributos da role runtime;
11. somente depois do Gate 2, executar o **Gate 3 — concorrência, OAuth sintético
   e idempotência**, incluindo reserva concorrente, consumo
   único/replay/expiração/cross-company de state sintético e corrida de
   publicação com um único registro;
12. somente depois do Gate 3, executar o **Gate 4 — cofre**, com AES-256-GCM,
    AAD de empresa/provedor/conexão/finalidade, adulterações, rotação e bloqueio
    da retirada de chave ainda usada;
13. somente depois do Gate 4, executar o **Gate 5 — backup e restauração**, com
    perfis 0003 e 0004, bundles individuais, SHA-256, manifesto, `fsync` do
    arquivo e diretório, restauração isolada, schema/dados/RLS/cofre e recusas
    de perfil cruzado e manifesto adulterado;
14. produzir métricas e executar a varredura sanitizada de segredos;
15. executar cleanup integral;
16. aprovar e enviar um único artifact sanitizado.

Cada etapa posterior depende do sucesso da anterior. As três provas e o
Gate 2 corrigido não são runs nem tentativas separados: são fases ordenadas da
única invocação autorizada. Nenhuma dessas expectativas representa aprovação
física antes da conclusão e conferência do artifact.

O `fsync` definitivo do diretório do bundle é exigido e contado nos dois
bundles do Gate 5. O bundle transitório usado internamente pelo rollback do
Gate 1 não é contado nessa evidência; a prova de durabilidade anterior aos
gates comprova separadamente a primitiva do filesystem.

Os planos físicos, migrations, stores, cofre e operadores de backup do produto
são reutilizados. O código Linux acrescenta somente adaptação Docker, provas
físicas faltantes, métricas e evidência; não existe uma segunda implementação do
produto. Leituras do ledger feitas pelos planos assumem explicitamente a role
canônica de migration. O operador de backup continua autenticado como
provisionador para identidade, locks e lifecycle, mas delega somente a leitura
do ledger a uma sessão curta da role migrator; nenhuma role recebe `INHERIT` ou
grant adicional.

Os planos compartilhados constroem a configuração de restore antes de o
backup existir. A adaptação Linux valida esse caminho mediante arquivo regular
exclusivo, vazio e imediatamente removido dentro da raiz própria; o backup real
continua sendo criado com exclusividade e sua integridade é validada pelo
operador original. Bancos descartáveis de restore têm somente o footprint de
bootstrap removido sob concessão temporária e auditada da role owner, revertida
antes da restauração. O perfil 0003 recebe uma fixture sintética e a mesma
identidade e contagens específicas são comprovadas depois do restore.

## Evidência e primeira falha

Um único artifact contém:

- `social-3a0p-linux-physical-gates-evidence.json`;
- `social-3a0p-linux-physical-gates-evidence.sha256`;
- `social-3a0p-linux-gate-process-status.json`;
- `social-3a0p-linux-gate-process-status.sha256`.

A serialização é canônica. Somente fases, booleans, contagens, durações, hashes,
versões e códigos normalizados são permitidos. URL de conexão, senha, state,
token, SQL com valores, dump bruto, ambiente e log bruto são recusados. O marker
`.sanitized-approved` só é criado depois da varredura e não é enviado no
artifact.

Os dois JSONs têm sidecars SHA-256 independentes. O status do processo contém
somente código de saída, signal fechado, timeout e os dois flags negativos de
armazenamento de streams. O artifact tem retenção de sete dias.

Na primeira falha, gates posteriores não são chamados. O erro primário é
preservado, o finalizador remove somente container, volume, rede e caminhos do
run e o workflow termina sem retry. O passo `always()` repete apenas o cleanup
idempotente, nunca o gate.

## Status antes do disparo

Enquanto o único workflow não tiver terminado e a evidência não tiver sido
verificada, o checkpoint permanece:

```text
SOCIAL 3A-0P — GATE LINUX BLOQUEADO
```

OAuth real, Meta, Instagram, Render, staging, produção, Android, Firebase e FCM
permanecem fora deste checkpoint.
