# Provisionamento futuro do PostgreSQL social

Este é o runbook de decisão do Checkpoint Social 2B. Ele não autoriza
contratação, alteração no Render, deploy, migration real ou leitura dos dados
legados. Cada mudança externa abaixo exige uma autorização específica.

## Gate zero

Antes de qualquer novo deploy:

1. congelar branch, commit, serviço e banco de destino;
2. rotacionar de forma controlada o deploy hook exposto;
3. inventariar e atualizar seus consumidores sem revelar a URL;
4. comprovar que o hook antigo foi revogado;
5. registrar saúde, rollback e somente estados booleanos.

Enquanto esse gate estiver pendente, nenhum deploy do Checkpoint 2B deve ser
iniciado.

## Aprovação de custo

O Render não oferece PostgreSQL de exatamente 512 MB. A referência observada
em 29/07/2026 foi:

- `Basic-256mb`: US$ 6,00/mês, abaixo do alvo;
- `Basic-1gb`: US$ 19,00/mês, primeiro plano acima de 512 MB;
- armazenamento inicial de 1 GB: US$ 0,30/mês;
- máximo inicial esperado: **US$ 19,30/mês**, antes de impostos e eventual
  tráfego cobrado.

Preço, região, versão PostgreSQL e cobrança proporcional devem ser
reconfirmados na última tela do dashboard. Qualquer valor maior, plano
diferente, cartão ou alteração de outro recurso interrompe o procedimento.

## Recursos e identidades

Criar somente depois da aprovação:

- um PostgreSQL 18 pago, exclusivo do módulo social e na mesma região do
  staging;
- 1 GB de armazenamento inicial;
- provisionador dono do banco, mantido somente pelo operador;
- LOGIN permanente de migration com `CONNECTION LIMIT 2`;
- LOGIN permanente de runtime com `CONNECTION LIMIT 9`;
- os roles canônicos `NOLOGIN` já definidos pelas migrations.

O provisionador pode ter `CREATEDB` quando isso for necessário para criar
destinos descartáveis de restauração, mas não pode ter `SUPERUSER`,
`REPLICATION` ou `BYPASSRLS`. Migration e runtime não podem ter ownership,
`CREATEDB`, `CREATEROLE`, `BYPASSRLS`, `TRUNCATE` ou privilégios cruzados.

## Ordem de provisionamento

1. Confirmar PostgreSQL 18, região, plano, armazenamento e custo.
2. Gerar senhas independentes para migration e runtime fora do Git e dos
   logs; manter provisionador, migration e runtime em custódias separadas.
3. Revogar ACLs públicas do banco e do schema `public`.
4. Executar uma vez o bootstrap controlado dos logins pelo provisionador.
5. Reexecutar o bootstrap para provar idempotência e autenticar separadamente
   migration e runtime.
6. Registrar apenas host, porta, banco, nomes dos logins e fingerprints
   públicos esperados.
7. Executar as migrations em job local/efêmero contendo somente a credencial
   de migration. O processo HTTP não executa migrations.
8. Executar o gate físico completo: checksums, rollback provocado,
   concorrência, retomada, RLS A/B, cofre e ausência de privilégios
   temporários.
9. Gerar backup lógico criptografado, validar seu roundtrip e restaurá-lo em
   banco novo e descartável.
10. Aprovar os verificadores do runtime atual e do commit antigo 2A contra o
    banco restaurado.
11. Somente depois desses gates, preparar o Web Service com a credencial de
    runtime.

## Chaves fora do PostgreSQL

Gerar e custodiar separadamente:

- `SOCIAL_IDENTITY_DERIVATION_KEY`;
- `SOCIAL_VAULT_KEYS_JSON`;
- a chave ativa referenciada por `SOCIAL_VAULT_ACTIVE_KEY_VERSION`;
- `SOCIAL_BACKUP_BUNDLE_KEY`, somente no processo local de backup;
- `JWT_SECRET` e `ORDER_MEDIA_SIGNING_SECRET`, que devem continuar diferentes
  das chaves sociais.

Também registrar os valores públicos:

- `SOCIAL_TENANT_NAMESPACE_UUID`;
- `SOCIAL_IDENTITY_DERIVATION_VERSION`;
- `SOCIAL_VAULT_EXPECTED_KEYRING_FINGERPRINT`;
- `SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT`;
- `SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN`.

Uma nova versão do cofre deve ser registrada antes de qualquer processo
selecioná-la. O keyring antigo+novo é pré-carregado com a chave antiga ainda
ativa; depois de drenar processos antigos, as escritas são pausadas durante a
ativação e o backfill. A chave anterior só pode ser aposentada após contagem
global zero e nova janela de observação.

## Variáveis do Web Service

Quando houver autorização para o primeiro gate de staging, o Web Service pode
receber somente:

- `SOCIAL_PERSISTENCE_ENABLED=true`;
- `DATABASE_URL` com o LOGIN de runtime;
- `SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN`;
- `SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT`;
- `SOCIAL_DATABASE_POOL_MAX=3`;
- TLS/CA e timeouts públicos quando necessários;
- configuração de identidade e keyring social;
- `SOCIAL_VAULT_EXPECTED_KEYRING_FINGERPRINT`.

O Web Service deve recusar URLs de provisionamento, migration, teste,
sizing, backup ou restore, além de senhas de bootstrap e da chave do bundle.
A URL de migration permanece exclusivamente no job efêmero.

## Primeiro deploy controlado

1. Preservar o commit Live e registrar saúde, memória, logs e rollback.
2. Manter todas as funções sociais externas desativadas.
3. Aplicar migrations pelo job efêmero e encerrar o job.
4. Iniciar uma única instância com pool máximo 3.
5. Validar inicialização, papel runtime, schema, fingerprint e keyring.
6. Executar somente cadastros e conexões sociais sintéticas, sem OAuth.
7. Provar isolamento A/B e nenhuma alteração nos JSONs legados.
8. Monitorar conexões, memória, CPU, aquisição do pool, timeouts e locks.
9. Interromper e voltar ao commit anterior se qualquer gate falhar.

Nenhum dos 119 registros legados é lido, descriptografado ou migrado nessa
ativação. Um backfill real exigirá inventário, mapeamento, backup/restauração
aprovados e autorização próprios.

## Rollback

- O rollback de código volta ao commit 2A anterior; o banco permanece
  preservado.
- Não existe down migration destrutiva.
- Falha antes da promoção mantém o banco novo isolado e sem tráfego.
- Falha de dados restaura o bundle em **outro banco novo**, executa os gates e
  só então permite trocar o destino. O banco original nunca é limpo,
  sobrescrito ou restaurado no lugar.
- Divergência de RLS, checksum, chave, fingerprint, memória, privilégio ou
  compatibilidade bloqueia a promoção.

## Critério de saída do Checkpoint 2B

O Checkpoint 2B só fica apto ao OAuth quando:

- custo e recurso forem aprovados;
- deploy hook exposto estiver rotacionado;
- logins permanentes e segregação estiverem comprovados;
- migrations e gate físico passarem;
- backup externo criptografado e restauração isolada passarem;
- runtime operar somente com seu LOGIN;
- staging permanecer estável dentro dos limites;
- produção, Firebase, FCM, Android e dados legados permanecerem intactos.
