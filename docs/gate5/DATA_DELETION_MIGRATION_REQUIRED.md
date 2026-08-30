# Gate 5A — migration necessária para exclusão/desautorização real

Status em 30/08/2026:

```text
MIGRATION_REQUIRED=SIM
MIGRATION_CREATED=SIM
MIGRATION_APPLIED=NAO
REAL_COMPLIANCE_REPOSITORY_IMPLEMENTED=SIM
REAL_DATA_DELETION_ENABLED=NAO
REAL_SUBFRONT_STOPPED=SIM
SYNTHETIC_TOKEN_PHYSICAL_DELETION_TEST=PENDENTE_PROVA_LINUX_ONE_SHOT
```

Este documento registra o desenho e a implementação autorizada da migration `0006_social_compliance_persistence`. A aplicação no staging continua separada e só pode ocorrer pela rota transacional dedicada, depois da prova PostgreSQL descartável e dos gates do candidato. Nada aqui autoriza excluir dados reais ou configurar callbacks no Meta Dashboard.

## 1. Bloqueios comprovados no schema atual

1. Não existe ledger PostgreSQL durável para pedidos Meta de `deauthorization` e `data_deletion`, replay, confirmação e consulta de status.
2. `ia4tube_social.social_idempotency_operations` não pode receber esses pedidos sem mudança de schema: a constraint `social_idempotency_operations_capability_allowed` aceita somente `beginAuthorization`, `discoverAccount`, `publishImage`, `getPublicationStatus` e `disconnect`.
3. Não existe mapeamento durável e inequivocamente validado entre o `user_id` do `signed_request` e `company_id`/`user_id`/`connection_id` internos.
4. O callback precisa descobrir o tenant a partir de um payload Meta autenticado antes de poder configurar o escopo RLS. O runtime atual não possui uma superfície estreita para essa resolução pré-tenant.
5. `ia4tube_social_runtime` possui apenas `SELECT, INSERT` e atualizações de colunas específicas em `social_encrypted_credentials`; não possui `DELETE` nessa tabela.
6. As FKs atuais usam `ON DELETE RESTRICT`. Excluir a credencial é possível com privilégio e escopo corretos, mas excluir toda a conexão e seu histórico exige uma política e uma ordem transacional próprias.
7. A prova em memória é deliberadamente sintética. Ela demonstra validação HMAC-SHA256, idempotência, isolamento lógico e zeragem/remoção de um `Buffer`; não demonstra durabilidade PostgreSQL, expurgo de backups nem apagamento físico de páginas de banco.

## 2. Decisão de arquitetura exigida antes da migration

Não ampliar silenciosamente `social_idempotency_operations`. O ledger de compliance tem requisitos diferentes de uma operação de conector: resolução pré-tenant, confirmação pública opaca, status durável e retenção própria.

A recomendação técnica a ser aprovada é criar duas tabelas tenant-scoped e duas funções mínimas de resolução, sem conceder leitura global das tabelas ao runtime:

1. `ia4tube_social.social_meta_subject_mappings`;
2. `ia4tube_social.social_compliance_requests`;
3. função de resolução por `(provider, subject_digest)`;
4. função de resolução de status por `confirmation_code_digest`.

As funções de resolução são o ponto de maior risco. A migration só pode avançar depois de um teste físico provar que elas funcionam com `FORCE ROW LEVEL SECURITY`, não concedem enumeração, não aceitam `company_id` do cliente, não usam SQL dinâmico e não exigem `BYPASSRLS` para o runtime.

## 3. Tabela proposta: `social_meta_subject_mappings`

Campos mínimos propostos, sujeitos à revisão:

| Campo | Tipo | Regra/objetivo |
|---|---|---|
| `company_id` | `UUID NOT NULL` | FK para `companies(id)` com `ON DELETE RESTRICT` |
| `provider` | `TEXT NOT NULL` | Inicialmente `instagram`; mesma validação de provider do núcleo |
| `subject_digest` | `CHAR(64) NOT NULL` | HMAC-SHA256 versionado do identificador Meta; não guardar o `user_id` bruto neste ledger |
| `digest_version` | `TEXT NOT NULL` | Identifica chave/algoritmo para rotação controlada |
| `user_id` | `UUID NOT NULL` | FK tenant-scoped para `users(company_id,id)` |
| `connection_id` | `UUID NOT NULL` | FK para `social_connections(company_id,id,provider)` |
| `status` | `TEXT NOT NULL` | Allowlist mínima `active`, `revoked` |
| `created_at` | `TIMESTAMPTZ NOT NULL` | `DEFAULT CURRENT_TIMESTAMP` |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | Ordem temporal validada |
| `revision` | `BIGINT NOT NULL` | Positiva, para compare-and-set/rotação |

Chaves e índices mínimos:

- PK ou UNIQUE tenant: `(company_id, provider, subject_digest)`;
- UNIQUE global: `(provider, subject_digest)` para recusar mapeamento ambíguo entre empresas;
- índice de conexão: `(company_id, connection_id, provider, status)`;
- constraints de formato para `subject_digest`, `digest_version`, `provider`, `status`, `revision` e `updated_at >= created_at`.

O HMAC precisa de chave/pepper fora do Git e do banco de produto. Um SHA-256 simples do identificador numérico é enumerável e não atende ao desenho proposto.

## 4. Tabela proposta: `social_compliance_requests`

Campos mínimos propostos, sujeitos à revisão:

| Campo | Tipo | Regra/objetivo |
|---|---|---|
| `company_id` | `UUID NOT NULL` | FK tenant |
| `id` | `UUID NOT NULL` | Identificador interno; PK com `company_id` |
| `provider` | `TEXT NOT NULL` | `instagram` no contrato atual |
| `kind` | `TEXT NOT NULL` | Allowlist exata `deauthorization`, `data_deletion` |
| `event_key` | `CHAR(64) NOT NULL` | Derivado do tipo + digest do pedido validado; base do replay idempotente |
| `subject_digest` | `CHAR(64) NOT NULL` | Referência ao mapeamento, sem `user_id` Meta bruto |
| `user_id` | `UUID NOT NULL` | Ator interno resolvido; nunca aceito do request HTTP |
| `connection_id` | `UUID NOT NULL` | Limita a exclusão à conexão resolvida |
| `confirmation_code` | `TEXT NOT NULL` | Código opaco de 32–128 caracteres; nunca registrar em logs/auditoria |
| `confirmation_code_digest` | `CHAR(64) NOT NULL` | Lookup/status sem busca textual livre; definir se o código claro será cifrado em revisão de segurança |
| `status` | `TEXT NOT NULL` | Allowlist inicial `processing`, `completed`, `failed` |
| `details_code` | `TEXT` | Código redigido e allowlisted; sem material do pedido |
| `token_materials_deleted` | `INTEGER NOT NULL DEFAULT 0` | Não negativo; evidência operacional, não garantia de expurgo de backup |
| `requested_at` | `TIMESTAMPTZ NOT NULL` | Horário aceito pelo servidor |
| `completed_at` | `TIMESTAMPTZ` | Obrigatório apenas em estado terminal |
| `created_at` | `TIMESTAMPTZ NOT NULL` | `DEFAULT CURRENT_TIMESTAMP` |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | Ordem temporal validada |
| `revision` | `BIGINT NOT NULL` | Positiva para CAS |

Chaves e índices mínimos:

- PK `(company_id, id)`;
- UNIQUE global `(provider, event_key)` para replay idempotente do mesmo pedido;
- UNIQUE global `confirmation_code` e `confirmation_code_digest` para impedir colisões antes da exclusão;
- FK `(company_id, provider, subject_digest)` para o mapeamento aprovado;
- FK `(company_id, connection_id, provider)` para `social_connections`;
- FK `(company_id, user_id)` para `users`;
- índice operacional `(company_id, status, requested_at, id)`;
- índice de conexão `(company_id, connection_id, requested_at DESC)`;
- constraints de consistência entre `status`, `completed_at`, `details_code` e contador.

Decisão técnica do Gate 5A: guardar o `confirmation_code` opaco de 192 bits na tabela protegida por RLS para devolver o mesmo código em replay e guardar também seu digest com separação de domínio para a resolução pública estreita. O código não entra em logs nem na auditoria. Criptografia adicional e retenção final continuam como decisão de segurança/jurídica posterior; armazenar somente o hash não atenderia ao replay exigido.

## 5. RLS e resolução pré-tenant

As duas tabelas devem receber:

- `ENABLE ROW LEVEL SECURITY`;
- `FORCE ROW LEVEL SECURITY`;
- policy `USING` e `WITH CHECK` baseada no mesmo contexto de empresa já usado pelo núcleo;
- `REVOKE ALL ... FROM PUBLIC`;
- inclusão no inventário `TENANT_TABLES`, `TENANT_POLICIES` e `TENANT_SCOPE_COLUMNS`;
- testes A/B, sem escopo e de reset de conexão.

O callback não pode receber `company_id` livre. A sequência segura proposta é:

1. validar `signed_request` e assinatura antes de qualquer lookup;
2. derivar `subject_digest` no servidor;
3. chamar uma função estreita de resolução que devolva no máximo `company_id`, `user_id` e `connection_id` para uma correspondência única;
4. abrir transação, definir imediatamente o escopo RLS retornado e reler/validar o mapeamento dentro da transação;
5. adquirir lock transacional pelo `event_key`;
6. inserir ou reler o ledger e decidir replay antes de apagar;
7. executar exclusão e auditoria no mesmo commit;
8. limpar/resetar o escopo antes de liberar a conexão.

As funções de resolução devem ter assinatura fixa, `search_path` fixo, validação estrita de formato, nenhuma SQL dinâmica, nenhum retorno de dado pessoal e `EXECUTE` concedido apenas à role necessária. O runtime não deve receber `SELECT` global nem atributo `BYPASSRLS`. O modelo exato de ownership/`SECURITY DEFINER` precisa de prova física porque `FORCE RLS` pode alterar o comportamento esperado do owner.

## 6. Privilégio `DELETE` mínimo

A migration precisa, no mínimo:

- conceder `DELETE` em `ia4tube_social.social_encrypted_credentials` à role que executará compliance, mantendo a policy tenant-scoped;
- atualizar `RUNTIME_TABLE_GRANTS.social_encrypted_credentials` para incluir `DELETE`, se a mesma runtime role for mantida;
- não conceder `DELETE` global sem RLS nem `DELETE` sobre outras tabelas nesta subfrente;
- exigir predicate por `company_id`, `connection_id` e `provider`. O tipo canônico gravado pelo OAuth ativo é `instagram_user_access_token`; o lookup mantém compatibilidade com o legado `access_token`. Se o adapter usar allowlist, ela deve conter exatamente ambos (`credential_type IN ('instagram_user_access_token','access_token')`) e recusar tipo inesperado antes de declarar conclusão;
- incluir credenciais ligadas diretamente à conexão e qualquer credencial transitória ligada a uma `social_oauth_transactions.connection_id` da mesma empresa/conexão/provedor;
- remover as linhas correspondentes mesmo quando já tenham `revoked_at`, pois revogação impede uso mas mantém o ciphertext. Alternativamente, inventariar todos os tipos vinculados e apagar todas as credenciais da conexão, com teste explícito de que nenhum material utilizável ou revogado permaneceu;
- usar `DELETE ... RETURNING` dentro da transação para contabilizar linhas;
- provar que uma conexão da empresa A não apaga qualquer credencial da empresa B;
- provar replay sem segunda exclusão e colisão de confirmação antes de apagar.

Excluir uma linha PostgreSQL não garante sobrescrita imediata de página, WAL, réplica ou backup. A política jurídica deve chamar isso de exclusão lógica/física da linha ativa somente depois de definir expurgo de backups, WAL e réplicas; não prometer “apagamento seguro” com base apenas em `DELETE`.

## 7. Impacto obrigatório nos contratos do repositório

A migration e o adapter exigem mudanças coordenadas em:

- manifesto e checksums de migrations;
- `runtime-validation.js` e seu espelho em `migrations.js`;
- inventários de backup/restore e validação de schema;
- grants de tabela/coluna e testes de menor privilégio;
- repositório PostgreSQL de compliance com transação única;
- criação/rotação do mapeamento durante OAuth, sem expor identificador externo;
- montagem das rotas somente quando o repositório durável estiver disponível;
- testes de signed request, replay após restart, colisão, A/B, status, rollback e logs redigidos;
- testes físicos em PostgreSQL descartável, incluindo RLS, funções pré-tenant e `DELETE`;
- runbook de backup/restore e política aprovada de retenção.

## 8. Escopo de exclusão deliberadamente não resolvido

Esta migration mínima deve apagar o material de credencial elegível da conexão, incluindo o tipo canônico `instagram_user_access_token` e o legado `access_token`, esteja ativo ou já revogado, e registrar o pedido. Ela não deve, sem decisão jurídica e migration adicional, apagar silenciosamente:

- `social_connections`;
- conta externa e destino;
- publicações, tentativas e idempotência;
- auditoria;
- artes, legendas, pedidos, planejamento ou histórico comercial;
- backups, WAL ou réplicas.

As FKs `ON DELETE RESTRICT` tornam esse limite explícito. O escopo completo depende das decisões LEG-20 a LEG-38 em `LEGAL_OWNER_DECISIONS_REQUIRED.md`.

## 9. Critérios para destravar a subfrente real

- [ ] schema e estratégia de resolução pré-tenant revisados independentemente;
- [ ] política do código de confirmação definida;
- [ ] migration criada em branch própria e revisada, sem aplicação automática;
- [ ] grants mínimos e RLS validados fisicamente;
- [ ] repositório durável passa restart/replay/rollback;
- [ ] exclusão A/B prova zero impacto cruzado;
- [ ] backup/restore e retenção aprovados;
- [ ] textos públicos atualizados sem prometer mais que o comprovado;
- [ ] autorização expressa antes de aplicar no staging;
- [ ] autorização separada antes de configurar o Meta Dashboard ou usar dados reais.

Até todos os itens: `REAL_DATA_DELETION_BLOCKED_BY_MIGRATION=SIM`.
