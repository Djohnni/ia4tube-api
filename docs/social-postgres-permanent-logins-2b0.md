# Credenciais permanentes do PostgreSQL social

Este desenho separa a autoridade de provisionamento, migration e runtime.
Nenhuma senha ou URL completa pertence ao Git, ao bundle de backup, aos logs
ou aos relatórios.

## Funções

### Provisionador

- É o dono do banco e possui `CREATEROLE`; no Render também pode possuir
  `CREATEDB` para criar o destino descartável de restauração. Não possui
  `SUPERUSER`, `REPLICATION` ou `BYPASSRLS`.
- Administra os três roles canônicos sem poder assumi-los com `SET ROLE`.
- Só pode existir no processo local e controlado do operador.
- No backup e restore, mantém advisory locks e consulta somente `pg_catalog`.
- Nunca permanece no Web Service.

### Login de migration

- É um LOGIN permanente, diferente do provisionador e do runtime.
- Tem `CONNECTION LIMIT 2`, `NOINHERIT` e somente `CONNECT` direto no banco.
  Duas sessões são o mínimo necessário para provar concorrência e retry dos
  runners protegidos por advisory lock.
- Pode assumir exclusivamente `ia4tube_social_migrator`, que por sua vez pode
  assumir `ia4tube_social_owner`.
- Não possui objetos, `CREATEROLE`, `CREATEDB`, `TRUNCATE`, `BYPASSRLS`,
  `REPLICATION`, `TEMP` ou criação direta em schemas.
- Cada job, worker ou ferramenta usa pool máximo `1`. As ferramentas `psql`,
  `pg_dump` e `pg_restore` continuam sequenciais; a segunda vaga existe
  somente para a concorrência controlada entre dois workers.
- Nunca permanece no Web Service.

### Login de runtime

- É um LOGIN permanente, diferente dos outros dois.
- Tem `CONNECTION LIMIT 9`, `NOINHERIT` e somente `CONNECT` direto no banco.
- Pode assumir exclusivamente `ia4tube_social_runtime`.
- Não pode assumir owner ou migrator, administrar roles, possuir objetos,
  criar schemas, usar `TRUNCATE`, `TEMP`, `BYPASSRLS` ou privilégios de
  cluster.
- É a única credencial PostgreSQL admitida no futuro Web Service de staging.
- O pool começa com máximo 3 e tem teto configurável de 5, preservando margem
  dentro do limite permanente.

## Bootstrap controlado

O utilitário `scripts/social-db-bootstrap-logins.js` recebe somente variáveis
de ambiente:

- `SOCIAL_LOGIN_BOOTSTRAP_APPROVED`
- `SOCIAL_LOGIN_BOOTSTRAP_PROVISIONER_DATABASE_URL`
- `SOCIAL_LOGIN_BOOTSTRAP_EXPECTED_HOST`
- `SOCIAL_LOGIN_BOOTSTRAP_EXPECTED_DATABASE`
- `SOCIAL_LOGIN_BOOTSTRAP_EXPECTED_PROVISIONER_LOGIN`
- `SOCIAL_LOGIN_BOOTSTRAP_EXPECTED_TARGET_FINGERPRINT`
- `SOCIAL_LOGIN_BOOTSTRAP_MIGRATION_LOGIN`
- `SOCIAL_LOGIN_BOOTSTRAP_MIGRATION_PASSWORD`
- `SOCIAL_LOGIN_BOOTSTRAP_RUNTIME_LOGIN`
- `SOCIAL_LOGIN_BOOTSTRAP_RUNTIME_PASSWORD`

As senhas precisam ter de 32 a 256 caracteres, com maiúscula, minúscula,
número e símbolo, sem espaços e sem conter o nome do login. As três
credenciais devem ter logins e senhas diferentes. A URL exige
`sslmode=verify-full` e nenhuma opção adicional.

Antes de qualquer criação, o utilitário valida PostgreSQL 18, dono do banco,
roles `NOLOGIN`, memberships, ACL pública e topologia completa. A criação dos
dois logins, grants e validações ocorre em uma transação protegida por
advisory lock. Reexecução com estado exato é idempotente. A única atualização
admitida em login existente é a transição conhecida do migration
`CONNECTION LIMIT 1` para `2`; qualquer outra divergência falha antes de
mutação.

Depois do commit, cada senha é testada em conexão própria. O resultado
publicado pelo utilitário contém somente estados booleanos.

## Limite do Web Service

Quando a persistência social for habilitada, o Web Service aceita somente:

- `DATABASE_URL` com o login de runtime;
- `SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN`;
- `SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT`;
- configuração pública de pool, TLS e timeouts.

O processo falha antes de iniciar se encontrar URL de migration,
provisionamento, teste, sizing, backup ou restore. Também recusa a chave do
bundle e as senhas de bootstrap, mesmo quando a persistência social está
desativada.

## Operação futura

1. Gerar as duas senhas novas fora do Git e armazená-las em custódia segura.
2. Executar o bootstrap pelo provisionador em uma máquina controlada.
3. Validar ambos os logins e registrar somente o fingerprint público.
4. Remover do ambiente local as variáveis temporárias.
5. Configurar no Web Service somente a URL do runtime e os identificadores
   públicos esperados.
6. Manter a URL de migration em job isolado e efêmero.
7. Usar provisionador e migration somente em operações explicitamente
   autorizadas, nunca no processo HTTP.
