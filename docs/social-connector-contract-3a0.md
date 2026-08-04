# Social 3A-0: contrato mínimo de conectores

## Escopo

Este checkpoint define o limite interno que um adaptador social deverá cumprir. Ele não registra nenhum conector externo no runtime, não implementa OAuth e não faz rede.

As cinco capacidades do contrato são, exatamente:

1. `beginAuthorization(context, input)`;
2. `discoverAccount(context, authorizationResult)`;
3. `publishImage(context, publication)`;
4. `getPublicationStatus(context, providerReference)`;
5. `disconnect(context, connection)`.

`instagram` é apenas o identificador reservado do primeiro provedor. Não há adaptador Instagram, token, App ID, App Secret, callback ou chamada à Meta neste checkpoint.

## Autoridade e multitenancy

O contexto é criado somente a partir do principal produzido pelo adaptador de JWT verificado. Esse principal e o contexto recebem marcas internas não serializáveis. Um objeto JSON comum não pode substituí-los.

O contexto congelado contém `companyId`, `userId`, `provider`, `environment`, `correlationId` e `auditEventId`. Os inputs das cinco operações recusam campos de autoridade como `companyId`, `userId`, `provider` e `environment`.

O serviço usa uma porta de armazenamento já escopada pelo contexto e revalida empresa e provedor em cada recurso retornado. A porta de mídia também precisa confirmar que a imagem JPEG pertence à mesma empresa antes de qualquer chamada ao conector. O adapter PostgreSQL futuro deverá continuar usando `SET LOCAL ROLE`, `ia4tube.company_id` e as políticas `FORCE RLS` existentes.

## Registry e gates

O registry aceita somente registro explícito de um objeto conector, recusa duplicidade, provedor desconhecido e capacidade não declarada, captura as funções no momento do registro e é selado antes do uso. Não existe carregamento dinâmico por nome ou caminho.

Conectores não sintéticos precisam declarar `external: true`. Toda capacidade externa fica bloqueada por padrão e exige, simultaneamente:

- gate de conexão ou publicação;
- gate do provedor;
- allowlist da empresa.

Nenhum desses gates está ligado ao runtime ou habilitado nesta etapa.

O fake fica exclusivamente em `tests/helpers`, declara `testOnly: true`, `synthetic: true` e `external: false`, e só funciona com contexto `test`. Staging e produção recusam seu registro.

## Estados do domínio

Conexão:

- `disconnected`;
- `authorization_pending`;
- `connected`;
- `reconnect_required`;
- `disconnecting`;
- `failed`.

Publicação:

- `ready`;
- `publishing`;
- `provider_confirming`;
- `published`;
- `failed_temporary`;
- `failed_permanent`.

As transições são matrizes explícitas. Estados terminais não regridem. Uma resposta atrasada não transforma `published` em pendente. Apenas `published` pode e deve conter `confirmedProviderReference`; `reconciliationReference` é separado e nunca confirma publicação.

## Idempotência, conta única e auditoria

A porta de armazenamento reserva a chave idempotente atomicamente antes de invocar o conector. A mesma chave e o mesmo digest retornam o resultado anterior; payload diferente é recusado. Uma reserva ainda em andamento impede uma segunda invocação.

A reserva de conexão por empresa/provedor também é executada em região exclusiva da porta. Assim, o contrato recusa uma segunda conta Instagram Business/Creator ativa sem substituir a primeira, inclusive em tentativas concorrentes no fake.

A porta de auditoria recebe somente IDs internos, ação, resultado e código normalizado. A tabela existente `social_audit_events` será usada pelo adapter persistente posterior; nenhuma tabela paralela foi criada.

## Erros

Os códigos normalizados do provedor são:

- `provider_not_supported`;
- `capability_not_supported`;
- `authorization_cancelled`;
- `authorization_expired`;
- `invalid_account_type`;
- `permission_missing`;
- `credential_unavailable`;
- `provider_temporary_failure`;
- `provider_permanent_failure`;
- `provider_result_unknown`;
- `disconnect_failed`.

Os códigos internos adicionais são estáveis e não carregam resposta bruta. O formato público contém somente `code`, `retryable` e `correlationId`. Erro inesperado vira `provider_result_unknown`; mensagem, stack, `cause`, URL, token, código OAuth, cabeçalho de autorização e ciphertext nunca são copiados para resposta, log ou auditoria.

## Reuso da fundação existente

Não foram criadas entidades paralelas. O adapter persistente futuro deverá estender:

- `social_connections` para o ciclo da conexão;
- `social_external_accounts` para a conta Business/Creator descoberta;
- `social_oauth_transactions` para autorização e `state`;
- `social_encrypted_credentials` e o cofre AES-256-GCM existente para credenciais;
- `social_audit_events` para auditoria.

O cofre, RLS, identidade derivada, reautenticação, TLS e pool PostgreSQL não foram alterados.

## Limite sem migration

O 3A-0 é deliberadamente um contrato de domínio com portas e fake sintético. Ele não está ligado ao runtime nem persiste dados no PostgreSQL.

O schema atual não possui tabela de publicações/idempotência, não garante por índice uma única conta ativa por empresa/provedor e usa estados persistidos diferentes (`pending`, `active`, `expired`, `revoked`, `disconnected`, `error`). `disconnecting` também não tem representação persistente.

Antes de OAuth ou publicação real será obrigatório aprovar um checkpoint de persistência que defina:

- tabela/ledger durável de publicações e idempotência;
- garantia concorrente de uma conta Instagram ativa por empresa;
- mapeamento ou evolução dos estados persistidos;
- adapters do repository para contas, OAuth, lifecycle e auditoria.

Nenhuma migration foi criada agora. A cadeia de dependência do Archiver citada na pendência anterior também não é alterada neste checkpoint e deve permanecer em uma correção independente antes de produção, conforme o resultado da auditoria de dependências da base.
