# Checkpoint Social 3A-0P — gates físicos Linux isolados

## Limite e proveniência

Esta sexta rota Linux isolada parte exclusivamente do commit
`931d1986e1cc5864c4d28997a995a27aaa593fd6`. A branch predecessora
`social/checkpoint-3a0p-linux-backup-transport-20260808` e todas as branches
anteriores permanecem preservadas, sem novo push ou edição.

O workflow existe somente para a branch
`social/checkpoint-3a0p-linux-profile-aware-restore-20260808`. O produto
permanece idêntico a `fcfc92419021dae5f77baad731c634b10c275c5b`: `src/`,
todo `db/` (inclusive `roles.sql`), `server.js`, `package.json` e `package-lock.json` não são
alterados. PostgreSQL, SCRAM, roles, rede Docker e credenciais também não são
alterados por esta correção.

## Sexto disparo Linux isolado autorizado

O único gatilho autorizado é o primeiro e único `push` de criação da nova
branch, sem exclusão ou force, cujo commit tenha a mensagem integral:

```text
[run-social-3a0p-linux-gate] validate restored schema by profile
```

O job exige `run_attempt == 1`, `created == true`, `deleted == false`,
`forced == false`, `before` igual a 40 zeros e pai exato
`931d1986e1cc5864c4d28997a995a27aaa593fd6`, além de diff nominal e
estritamente allowlisted. Não há `workflow_dispatch`, pull request, agenda,
matriz ou retry automático. A regra operacional é: zero re-run, zero segundo
push, zero PR, zero merge e zero deploy depois desta execução única.

A allowlist do commit contém exatamente estes sete caminhos, sem curinga,
prefixo ou diretório inteiro:

- `.github/workflows/social-3a0p-linux-physical-gates.yml`;
- `docs/social-3a0p-linux-physical-gates.md`;
- `scripts/social-3a0p-linux-gate.js`;
- `scripts/social-3a0p-local-windows-physical-plans.js`;
- `tests/social-3a0p-linux-gate.test.js`;
- `tests/social-3a0p-local-windows-physical-plans.test.js`;
- `tests/social-3a0p-linux-workflow.test.js`.

Qualquer outro caminho, inclusive outro workflow, `src/`, `db/`, migrations,
roles, servidor ou dependências, encerra o job antes do gate.

## Falha predecessora e prova focal do schema profile

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

Os gates são sequenciais e param na primeira falha:

1. **Migrations e rollback** — 0001–0003, snapshot, 0004, checksum,
   constraints/índices/RLS/FORCE RLS, falha transacional controlada, restauração
   0003 e reaplicação 0004, sem migration down.
2. **RLS e roles** — A/B em ambos os sentidos, leitura e escrita, contexto
   ausente/adulterado, reutilização de conexão e atributos da role runtime.
3. **Concorrência, OAuth e idempotência** — reserva concorrente de conexão,
   consumo único/replay/expiração/cross-company de state sintético e corrida de
   publicação com um único registro.
4. **Cofre** — AES-256-GCM, AAD de empresa/provedor/conexão/finalidade,
   adulterações, rotação e bloqueio da retirada de chave ainda usada.
5. **Backup e restauração** — perfis 0003 e 0004, bundles individuais,
   SHA-256, manifesto, `fsync` do arquivo e diretório, restauração isolada,
   schema/dados/RLS/cofre, perfil cruzado e manifesto adulterado recusados.

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
- `social-3a0p-linux-physical-gates-evidence.sha256`.

A serialização é canônica. Somente fases, booleans, contagens, durações, hashes,
versões e códigos normalizados são permitidos. URL de conexão, senha, state,
token, SQL com valores, dump bruto, ambiente e log bruto são recusados. O marker
`.sanitized-approved` só é criado depois da varredura e não é enviado no
artifact.

O artifact tem retenção de sete dias.

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
