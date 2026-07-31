# Backup e restauração lógica do PostgreSQL social

Este procedimento é exclusivo do operador. Ele não é importado pelo Web
Service, não usa o `DATABASE_URL` de runtime e não deve ser executado no
Render enquanto o Checkpoint Social 2B não for autorizado.

## Garantias do desenho

- Usa somente ferramentas oficiais PostgreSQL 18, por caminhos absolutos.
- Cada processo `psql`, `pg_dump` ou `pg_restore` possui limite total de
  vinte minutos. Ao excedê-lo, recebe término controlado e depois término
  forçado; `stderr` continua descartado sem ser retido ou exibido. A conexão
  libpq também recebe `PGCONNECT_TIMEOUT=10`, ignorando override ambiental.
  O operador só libera locks depois do evento que confirma o encerramento do
  processo; se o sistema operacional não confirmar o término, permanece
  bloqueado para intervenção, sem abandonar uma ferramenta mutando o banco.
- A senha existe apenas no ambiente do processo filho (`PGPASSWORD`). Ela não
  aparece em argumento, SQL, manifesto, stdout ou relatório.
- Os clientes oficiais mantêm `PGSSLMODE=verify-full` e usam exclusivamente
  as raízes públicas padrão do sistema com `PGSSLROOTCERT=system`. Não existe
  CA customizada, pinning, fingerprint de certificado ou TOFU.
  Para manter o mesmo conjunto público usado pelo Node, o operador materializa
  temporariamente `node:tls.rootCertificates` em um arquivo protegido e o
  fornece aos subprocessos como `SSL_CERT_FILE`. Esse arquivo contém somente
  as raízes padrão, é criado fora do Git e é removido antes de qualquer
  resultado aprovado; um `SSL_CERT_FILE` recebido do ambiente é recusado.
  O endpoint público do Render recusa o SCRAM channel binding do libpq 18;
  por isso, o subprocesso fixa `PGCHANNELBINDING=disable`, sem aceitar
  override ambiental. A confidencialidade e a identidade do servidor
  continuam obrigatoriamente protegidas por TLS `verify-full`, hostname
  exato e trust store padrão. Overrides ambientais de OpenSSL, libpq,
  service file e password file são descartados.
- O diretório de saída deve estar fora do repositório e ter proteção de acesso
  confirmada pelo operador.
- O processo mantém os advisory locks de migration e backup durante toda a
  captura.
- Os advisory locks e as leituras de `pg_catalog` usam uma conexão separada
  do provisionador, dono do banco. Esse processo não executa `SET ROLE` e não
  consulta tabelas da aplicação.
- `psql`, `pg_dump` e `pg_restore` usam exclusivamente o LOGIN permanente de
  migration e são executados de forma sequencial. Assim, o limite permanente
  de duas sessões para migration permanece compatível com backup e restore
  sem que uma única operação consuma mais de uma.
- Os dados das tabelas com `FORCE ROW LEVEL SECURITY` são lidos na mesma
  sessão e na mesma transação `REPEATABLE READ` que cria as policies
  temporárias.
- Cada policy temporária concede somente `SELECT` ao role
  `ia4tube_social_owner`. Todas são removidas antes do `COMMIT`.
- Se o `psql` falhar ou for encerrado, a conexão fecha e a transação inteira é
  revertida. Portanto, uma policy desse fluxo nunca é publicada para outra
  sessão nem permanece no catálogo.
- O `pg_dump` é usado somente para o schema. Não existe `--snapshot`, dump de
  dados em outra conexão, `BYPASSRLS`, `SUPERUSER` ou desligamento de RLS.
- Cada tabela é exportada como SQL lógico gerado pelo próprio PostgreSQL com
  `jsonb_populate_record`. Arquivos vazios ainda recebem um cabeçalho.
- O manifesto registra todos os arquivos, tamanhos, SHA-256, contagens,
  migrations e checksums, além dos digests de roles, policies e constraints.
- O schema arquivado é recusado se contiver qualquer policy temporária.

## Pré-requisitos

1. Instalar localmente os binários portáveis oficiais do PostgreSQL 18:
   `psql`, `pg_dump` e `pg_restore`.
2. Criar uma pasta local fora do Git, acessível somente à conta do operador.
3. Confirmar que o banco de origem é o ambiente esperado usando somente
   hostname, porta, nome do banco, login e fingerprint públicos.
4. Usar duas credenciais separadas: o LOGIN exclusivo de migration para as
   ferramentas oficiais e o provisionador somente para locks e catálogo.
   Nenhuma delas pode permanecer no Web Service.
5. Manter o banco original intacto durante toda a verificação e restauração.

## Variáveis do backup

As seguintes variáveis são obrigatórias no processo local do operador:

- `SOCIAL_BACKUP_APPROVED=BACKUP_SOCIAL_POSTGRES_2B0`
- `SOCIAL_BACKUP_DIRECTORY_PROTECTED=true`
- `SOCIAL_BACKUP_OUTPUT_DIRECTORY`
- `SOCIAL_BACKUP_LABEL`
- `SOCIAL_BACKUP_SOURCE_DATABASE_URL`
- `SOCIAL_BACKUP_SOURCE_EXPECTED_HOST`
- `SOCIAL_BACKUP_SOURCE_EXPECTED_PORT`
- `SOCIAL_BACKUP_SOURCE_EXPECTED_DATABASE`
- `SOCIAL_BACKUP_SOURCE_EXPECTED_LOGIN`
- `SOCIAL_BACKUP_EXPECTED_MIGRATION_LOGIN`
- `SOCIAL_BACKUP_EXPECTED_RUNTIME_LOGIN`
- `SOCIAL_BACKUP_SOURCE_EXPECTED_FINGERPRINT`
- `SOCIAL_BACKUP_OPERATOR_PROVISIONER_DATABASE_URL`
- `SOCIAL_BACKUP_OPERATOR_EXPECTED_HOST`
- `SOCIAL_BACKUP_OPERATOR_EXPECTED_PORT`
- `SOCIAL_BACKUP_OPERATOR_EXPECTED_DATABASE`
- `SOCIAL_BACKUP_OPERATOR_EXPECTED_LOGIN`
- `SOCIAL_BACKUP_OPERATOR_EXPECTED_FINGERPRINT`
- `SOCIAL_BACKUP_EXPECTED_ENVIRONMENT_ID`
- `SOCIAL_BACKUP_EXPECTED_ENVIRONMENT`
- `SOCIAL_BACKUP_BUNDLE_KEY`
- `SOCIAL_BACKUP_PSQL_PATH`
- `SOCIAL_BACKUP_PG_DUMP_PATH`
- `SOCIAL_BACKUP_PG_RESTORE_PATH`

As duas URLs devem apontar ao mesmo host, porta e banco, ter exatamente
`sslmode=verify-full`, usar logins e senhas diferentes e coincidir com os
fingerprints públicos esperados. Não são aceitos parâmetros adicionais.

Com as variáveis presentes no ambiente, o ponto de entrada é:

```text
node scripts/social-db-backup-restore.js backup
```

Não foi acrescentado um script ao `package.json` neste checkpoint para evitar
colisão com as demais alterações em andamento. Depois da consolidação, a
entrada recomendada é
`"db:social:backup": "node scripts/social-db-backup-restore.js backup"`.

## Bundle produzido

O arquivo final `.ia4sb` é um contêiner autenticado e criptografado. A chave
de 32 bytes fica fora do PostgreSQL, Git, Web Service e do próprio bundle. Os
arquivos lógicos em texto claro existem apenas durante a operação local,
recebem permissão restrita e são removidos depois da verificação completa do
roundtrip criptográfico.

O formato v2 usa AES-256-GCM e autentica no AAD o cabeçalho canônico completo,
inclusive o tamanho exato do TAR (`tarBytes`). A restauração faz duas leituras
sequenciais usando o mesmo descritor aberto do contêiner. A primeira
descriptografa somente para um descarte em memória: nenhum byte chega ao
parser TAR nem ao disco antes de a tag GCM ser validada. Antes da segunda
leitura, `statfs` precisa comprovar espaço livre para o TAR autenticado mais
uma margem igual ao maior valor entre 64 MiB e 10% do TAR. Ausência da
capacidade de medição ou espaço insuficiente falha fechado.

Os arquivos fonte do bundle são abertos uma única vez, sem seguir o componente
final quando a plataforma oferece `O_NOFOLLOW`. Identidade, tamanho, datas,
contagem e SHA-256 são conferidos no mesmo descritor e no mesmo fluxo usado
para formar o TAR; o pathname não é reaberto para calcular a evidência. O gate
físico Linux deve confirmar `O_NOFOLLOW` e `fsync` de diretório antes do
primeiro uso com dados reais, pois o Node no Windows não oferece garantias
equivalentes contra todas as corridas com reparse points.

A saída segura do operador inclui `bundleFileFsyncConfirmed`,
`bundleDirectoryFsyncConfirmed`, `bundleRoundTripVerified`, o SHA-256 do
bundle e o digest opaco das evidências. O arquivo sempre passa por `fsync`;
uma falha nesse `fsync` invalida e remove a saída. O valor
`false` em um gate sintético no Windows significa apenas que a plataforma não
confirmou a persistência da entrada do diretório após uma queda abrupta. Ele
não pode ser usado para aprovar backup de dados reais: antes disso, o mesmo
gate deve ser executado no ambiente Linux de operação e retornar `true`.

O bundle contém:

- um arquivo custom `pg_dump` somente de schema;
- um arquivo lógico de dados por tabela utilizada pelo Checkpoint 2A/2B-0;
- um manifesto JSON, gravado por último.

Um conjunto sem manifesto final é incompleto e não pode ser restaurado. Antes
de começar, o processo comprova que nenhum arquivo reservado ao label existe.
Todo plaintext de backup e restauração fica dentro de um workspace `0700`
com nome estrito e marcador canônico `0600`, contendo apenas versão,
finalidade, identificador opaco, PID, UID e data. A recuperação automática
só remove um workspace cujo marcador, identidade, árvore, idade mínima de
24 horas e encerramento do processo dono tenham sido comprovados. Marcador
ausente ou inválido, symlink, processo vivo ou diretório jovem são
preservados e bloqueiam a operação para inspeção manual.

O contêiner é publicado sem sobrescrita por hardlink atômico: um arquivo final
criado por outra execução na corrida permanece intacto. A limpeza usa a
identidade do inode/arquivo efetivamente criado por esta execução e nunca
remove um caminho cuja propriedade não possa ser comprovada. Arquivos
alheios ao label são preservados. Se a limpeza exata não puder ser comprovada,
o processo falha fechado e exige inspeção manual antes de reutilizar o label.

Um bundle real só pode ser transferido depois da validação do SHA-256 e do
roundtrip autenticado. A chave precisa permanecer em escrow separado do
arquivo e do host que guarda a cópia.

## Restauração isolada

O destino precisa ser um banco descartável novo cujo nome contenha
`restore` ou `disposable`. Nomes com `production`, `prod`, `live`, `main`,
`stage` ou `staging` são recusados.

Neste ambiente pago, o único destino autorizado pelo lifecycle para a
restauração é
`ia4tube_social_disposable_restore_20260729`. Ele é distinto do banco
descartável do gate físico e do banco primário. Nome, ambiente, host, porta,
login provisionador, PostgreSQL 18, TLS `verify-full`, fingerprint, marker e
aprovações de criação/remoção ficam vinculados entre si. Nenhum nome livre ou
prefixo semelhante é aceito.

Os três roles canônicos devem existir no cluster, mas os schemas
`ia4tube_social`, `ia4tube_social_admin` e `ia4tube_migrations` precisam estar
ausentes. O banco original nunca é limpo ou sobrescrito.

Antes do restore, o provisionador deve reproduzir a topologia mínima do
banco-fonte: `REVOKE ALL ... FROM PUBLIC`, `GRANT CONNECT` somente aos logins
permanentes de migration e runtime, e `GRANT CREATE` somente ao role
`ia4tube_social_owner`. O login de migration continua sem `CREATE` herdado:
ele só cria o schema depois de `SET ROLE` para o owner canônico. O restore
recusa um alvo em que essa topologia, as memberships ou os limites de conexão
divirjam.

A criação e a remoção usam exclusivamente
`scripts/social-db-disposable-lifecycle.js`, com
`SOCIAL_STAGING_DISPOSABLE_EXPECTED_DATABASE` fixado ao nome acima. Para este
destino, as aprovações são distintas das usadas pelo gate físico:

- criação:
  `CREATE_SOCIAL_POSTGRES_RESTORE_DISPOSABLE:<environment-id>:<fingerprint>`;
- remoção:
  `DROP_SOCIAL_POSTGRES_RESTORE_DISPOSABLE:<environment-id>:<fingerprint>`.

Na criação, antes de qualquer `CREATE DATABASE`, o operador valida no banco
primário os roles canônicos, os dois logins permanentes, memberships, ACLs e
limites de conexão. Depois de criar o banco a partir de `template0` e aplicar
o marker exato, o mesmo lifecycle executa em uma transação apenas a topologia
mínima: remove todos os privilégios de `PUBLIC` no banco, concede `CREATE`
somente ao role owner, concede `CONNECT` diretamente somente aos logins de
migration e runtime e remove `CREATE` de `PUBLIC` no schema `public`. Ele não
executa `roles.sql`, não cria schema, tabela ou mídia. A transação só confirma
depois da leitura exata das ACLs e da prova de que os três schemas da
aplicação continuam ausentes.

Depois do gate comportamental, a remoção exige o marker e fingerprint
específicos desse destino, fecha primeiro o pool do banco descartável,
encerra somente sessões cujo `datname` coincida exatamente, executa
`DROP DATABASE ... WITH (FORCE)` somente para o nome fixo e prova sua
ausência. Uma falha de validação não dispara limpeza automática nem alcança
qualquer outro banco.

Variáveis do operador:

- `SOCIAL_RESTORE_APPROVED=RESTORE_SOCIAL_POSTGRES_2B0_ISOLATED`
- `SOCIAL_RESTORE_WORK_DIRECTORY_PROTECTED=true`
- `SOCIAL_RESTORE_WORK_DIRECTORY`
- `SOCIAL_RESTORE_BUNDLE`
- `SOCIAL_RESTORE_LABEL`
- `SOCIAL_RESTORE_TARGET_DATABASE_URL`
- `SOCIAL_RESTORE_RUNTIME_DATABASE_URL`
- `SOCIAL_RESTORE_TARGET_EXPECTED_HOST`
- `SOCIAL_RESTORE_TARGET_EXPECTED_PORT`
- `SOCIAL_RESTORE_TARGET_EXPECTED_DATABASE`
- `SOCIAL_RESTORE_TARGET_EXPECTED_LOGIN`
- `SOCIAL_RESTORE_EXPECTED_MIGRATION_LOGIN`
- `SOCIAL_RESTORE_EXPECTED_RUNTIME_LOGIN`
- `SOCIAL_RESTORE_TARGET_EXPECTED_FINGERPRINT`
- `SOCIAL_RESTORE_OPERATOR_PROVISIONER_DATABASE_URL`
- `SOCIAL_RESTORE_OPERATOR_EXPECTED_HOST`
- `SOCIAL_RESTORE_OPERATOR_EXPECTED_PORT`
- `SOCIAL_RESTORE_OPERATOR_EXPECTED_DATABASE`
- `SOCIAL_RESTORE_OPERATOR_EXPECTED_LOGIN`
- `SOCIAL_RESTORE_OPERATOR_EXPECTED_FINGERPRINT`
- `SOCIAL_RESTORE_SOURCE_FINGERPRINT`
- `SOCIAL_BACKUP_BUNDLE_KEY`
- `SOCIAL_RESTORE_PSQL_PATH`
- `SOCIAL_RESTORE_PG_RESTORE_PATH`
- `SOCIAL_RESTORE_LEGACY_2A_ROOT`

A restauração de dados também cria e remove policies owner-only dentro de uma
única transação. Depois, o gate compara:

- migrations e checksums;
- contagem de todas as tabelas;
- roles e topologia de memberships;
- policies e `FORCE RLS`;
- constraints, incluindo o FK global de versões de chave;
- hashes de todos os arquivos e do conjunto de evidências.

O comando direto de restore recusa continuar sem três verificadores
comportamentais injetados por um runner confiável:

1. isolamento real A/B usando o LOGIN de runtime do banco descartável;
2. cofre, adulteração e rotação com dados sintéticos;
3. runtime e repositories do commit exato
   `9deb1e04249026a7046d44d6cbf4e2da87b9a0a4`.

O terceiro verificador não pode executar o CLI antigo de migrations. Ele deve
usar somente o runtime/repository 2A contra o schema restaurado e comprovar
operações compatíveis e isoladas. Marcadores append-only guardados como dados
em `vault_key_versions` permanecem invisíveis ao runtime.

Antes de carregar esses módulos, o operador verifica o manifesto imutável da
árvore 2A: commit autorizado, conjunto exato de arquivos sob migrations,
persistência PostgreSQL e runtime social, além do `package.json` e lockfile,
todos vinculados por SHA-256 canônico. Uma alteração de um byte é recusada.
O alvo público dos verificadores (host, porta, banco e TLS `verify-full`) é
transformado no mesmo fingerprint do restore e precisa coincidir exatamente
com o destino restaurado antes da aquisição de locks ou da execução de
qualquer ferramenta.

Os advisory locks de migration e backup são adquiridos antes da recuperação
de workspace, da autenticação do bundle e da extração. Assim, duas operações
do operador não podem disputar a remoção de plaintext temporário. A evidência
gerada depois do restore também fica dentro do mesmo workspace marcado.

## Relatório persistido e reproduzível

Depois de backup, criação do banco descartável, restore e remoção confirmada,
as quatro saídas JSON sanitizadas são consolidadas exclusivamente por:

```text
node scripts/social-db-backup-restore-evidence.js
```

O consolidador exige Linux, não aceita argumentos e não recebe credenciais.
Ele usa somente estes caminhos e o commit público do código:

- `SOCIAL_2B_EVIDENCE_RUN_ID` (UUID v4 novo para a execução completa)
- `SOCIAL_2B_EVIDENCE_BACKUP_FILE`
- `SOCIAL_2B_EVIDENCE_CREATE_FILE`
- `SOCIAL_2B_EVIDENCE_RESTORE_FILE`
- `SOCIAL_2B_EVIDENCE_DROP_FILE`
- `SOCIAL_2B_EVIDENCE_BUNDLE_FILE`
- `SOCIAL_2B_EVIDENCE_REPORT_FILE`
- `SOCIAL_2B_EVIDENCE_COMMIT`
- `SOCIAL_2B_EVIDENCE_EXPECTED_CODE_MANIFEST_SHA256`
- `SOCIAL_2B_EVIDENCE_EXPECTED_CODE_MANIFEST_FILE_COUNT`
- `RENDER_GIT_COMMIT` (fornecido pelo Render e igual ao commit aprovado)

O mesmo `runId` deve formar também os labels de backup e restore e o nome
exato `social-2b-<runId>.ia4sb`. Cada um dos quatro payloads inclui commit,
manifesto SHA-256 do código executado, ambiente, alvo lógico, sequência e
horários. O consolidador exige igualdade desses vínculos e ordem temporal
estrita; evidências antigas ou de execuções diferentes não podem ser
combinadas.

Os payloads precisam ter exatamente os campos allowlisted. O SHA-256 e o
tamanho do bundle são recalculados por descritor estável; os digests do
backup e do conteúdo restaurado precisam coincidir. O relatório só pode ser
aprovado depois de a remoção comprovar identidade, encerramento das sessões,
ausência do banco descartável, limpeza dos workspaces temporários e ausência
de plaintext reservado.

O JSON final e o sidecar `.sha256` são criados em diretório protegido fora do
Git. Cada um é escrito primeiro em `.partial` com modo `0600`, passa por
`fsync`, é publicado sem sobrescrita por hardlink e é seguido por `fsync` do
diretório. O sidecar é publicado por último e funciona como marcador de
conclusão. Relatório sem sidecar válido é incompleto. Nenhum caminho absoluto,
URL de conexão, login, senha, chave do bundle ou conteúdo de tabela entra no
artefato.

Antes de retornar sucesso, o operador reabre sem seguir symlinks e recalcula
o relatório, o sidecar e o bundle, confirma as identidades de arquivo e repete
o `fsync` do diretório. Falha de publicação ou de limpeza remove somente os
inodes criados pela própria execução e nunca adota um arquivo concorrente.

## Gate e rollback do futuro banco pago

Antes de qualquer migration ou backfill real:

1. congelar o commit e o alvo;
2. gerar o bundle;
3. validar todos os hashes;
4. restaurar em banco descartável;
5. executar os três gates comportamentais;
6. registrar contagens e digests;
7. somente então autorizar a migration no banco original.

O rollback objetivo é voltar o Web Service ao commit anterior enquanto o
banco original é preservado. Não existe down migration destrutiva. Se houver
falha de migration, RLS, cofre, memória ou compatibilidade 2A, o novo banco não
é promovido; a recuperação parte de uma nova cópia do backup, nunca da
limpeza do original.
